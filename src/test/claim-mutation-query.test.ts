/**
 * Behavioural contract for the native read-only mutation query: a real private journal, real Git
 * stores over loopback TCP for blob, tree and commit-chain, a connection-counting stalled endpoint for
 * deterministic "no network contact" checks and the narrow journal IO seam. A `resolved` result only says
 * the single-mutation resolver ran on a fresh read; nothing here is dispatch, retry, logical completion or a right.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	claimJournalIO,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import {
	type ClaimMutationQueryOptions,
	type ClaimMutationQueryResult,
	queryClaimMutation,
} from "../claims/query/index.ts";
import {
	type ClaimChange,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import { GitFixtureServer, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 20_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout for queries that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
/** Margin for any stray asynchronous accept before a zero count is read; the zero itself is the proof. */
const SETTLE_MS = 200;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TICKET = "BACK-1";
const TICKET_REF = `refs/claims/${TICKET}`;
const DESCRIPTOR_REF = "refs/claim-meta/format";
/** Distinctive values that no diagnostic may echo. */
const BINDING = `tb1-${"5e".repeat(32)}`;
const OTHER_BINDING = `tb1-${"7a".repeat(32)}`;
const HOLDER = "agent-sentinel-holder";
const CLAIMED: JsonObject = { state: "claimed", holder: HOLDER };
const RENEWED: JsonObject = { state: "claimed", holder: HOLDER, renewed: true };

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => byCodeUnits(left, right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("fixture values must be JSON encodable");
	return encoded;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference receipt of the resolver contract: exactly the schema and both digests of the record. */
function changeOf(record: ClaimIntentRecord, payload: JsonObject): ClaimChange {
	const receipt = { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
	return { operationId: record.intent.operationId, receipt, payload };
}

function otherFormat(format: ClaimStorageFormat): ClaimStorageFormat {
	return format === "blob" ? "tree" : "blob";
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

/**
 * A failure result carries exactly `kind` and a string `reason` that echoes none of the given input values
 * or sentinels. Only counts are compared, so a failing run prints no raw values either.
 */
function expectFailure(
	label: string,
	result: ClaimMutationQueryResult,
	kind: ClaimMutationQueryResult["kind"],
	values: string[],
): void {
	const reason = (result as { reason?: unknown }).reason;
	const text = typeof reason === "string" ? reason : "";
	const echoed = [BINDING, OTHER_BINDING, HOLDER, ...values].filter((value) => value && text.includes(value)).length;
	expect({
		label,
		kind: result.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof reason,
		echoed,
	}).toEqual({ label, kind, keys: ["kind", "reason"], reasonType: "string", echoed: 0 });
}

function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Type, mode, inode, size, mtime and content digest of `root` and everything below it. */
async function snapshot(root: string) {
	const entries: { path: string; kind: string; mode: number; ino: number; size: number; mtimeMs: number }[] = [];
	const digests: Record<string, string> = {};
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		const kind = kindOf(info);
		const mode = info.mode & 0o7777;
		entries.push({ path: relative, kind, mode, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
		if (kind === "file") digests[relative] = sha256Hex(await readFile(path));
		if (kind === "dir") {
			for (const name of (await readdir(path)).sort(byCodeUnits)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return { entries, digests };
}

/** Journal IO that fails the first-level `lstat` of `<operationId>.json` with EIO; everything else is real. */
function failingRecordLstat(operationId: string): typeof claimJournalIO {
	const lstatRecord = async (...args: Parameters<typeof claimJournalIO.lstat>) => {
		if (String(args[0]).endsWith(`/${operationId}.json`)) {
			throw Object.assign(new Error("injected record lstat failure"), { code: "EIO" });
		}
		return claimJournalIO.lstat(...args);
	};
	return { ...claimJournalIO, lstat: lstatRecord as unknown as typeof claimJournalIO.lstat };
}

/** Journal IO that fails the `lstat` of the journal directory itself with EIO; everything else is real. */
function failingDirectoryLstat(directory: string): typeof claimJournalIO {
	const lstatDirectory = async (...args: Parameters<typeof claimJournalIO.lstat>) => {
		if (String(args[0]) === directory) {
			throw Object.assign(new Error("injected journal directory lstat failure"), { code: "EIO" });
		}
		return claimJournalIO.lstat(...args);
	};
	return { ...claimJournalIO, lstat: lstatDirectory as unknown as typeof claimJournalIO.lstat };
}

/** One server repository, a query client repository, an independent client and a private journal directory. */
class QueryCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The repository every query uses; objects appear here only through the query's own reads. */
	readonly primary: string;
	readonly journalDirectory: string;
	private readonly cleanups: (() => Promise<void>)[] = [];

	private constructor(format: ClaimStorageFormat, root: string, url: string, serverRepo: string, primary: string) {
		this.format = format;
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.primary = primary;
		this.journalDirectory = join(root, "journal");
	}

	/** `descriptor`: initialize with the case format, with `other` format through another client, or not at all. */
	static async create(
		format: ClaimStorageFormat,
		caseName: string,
		descriptor: "same" | "other" | "none" = "same",
	): Promise<QueryCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-query-"));
		try {
			const { name, repo } = await server().initRepository(root, `query-${format}-${caseName}`);
			const primary = await QueryCase.initClient(join(root, "client-query"));
			const queryCase = new QueryCase(format, root, server().url(name), repo, primary);
			await mkdir(queryCase.journalDirectory);
			await chmod(queryCase.journalDirectory, 0o700);
			if (descriptor === "same") expectKind(await initializeClaimStorage(queryCase.storage(primary)), "created");
			if (descriptor === "other") {
				const initializer = await queryCase.client("initializer");
				const options = { ...queryCase.storage(initializer), format: otherFormat(format) };
				expectKind(await initializeClaimStorage(options), "created");
			}
			return queryCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An independent client repository; objects it writes are not in the query repository. */
	async client(label: string): Promise<string> {
		return QueryCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, changes: Partial<ClaimStorageOptions> = {}): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT, ...changes };
	}

	query(operationId: string, storage = this.storage(), changes: Partial<ClaimMutationQueryOptions> = {}) {
		return queryClaimMutation({ journalDirectory: this.journalDirectory, operationId, storage, ...changes });
	}

	async store(repository: string, format = this.format): Promise<ClaimStore> {
		return expectKind(await openClaimStore({ ...this.storage(repository), format }), "open").store;
	}

	intent(operationId: string, expectedRoot: string | null, changes: Partial<ClaimOperationIntent> = {}) {
		const intent: ClaimOperationIntent = {
			operationId,
			remote: this.url,
			format: this.format,
			epoch: 1,
			ticket: TICKET,
			expectedRoot,
			targetBinding: BINDING,
			action: "claim",
			parameters: { holder: HOLDER, ttlSeconds: 300 },
			resolved: { leaseEnd: "2026-09-25T00:05:00Z" },
			...changes,
		};
		return intent;
	}

	/** Persists the intent in the private journal and returns the record loaded back from disk. */
	async persist(intent: ClaimOperationIntent): Promise<ClaimIntentRecord> {
		const journal = expectKind(await openClaimIntentJournal({ directory: this.journalDirectory }), "open").journal;
		expectKind(await journal.prepare(intent), "prepared");
		const record = expectKind(await journal.load(intent.operationId), "loaded").record;
		expect(record).toEqual(recordOf(intent));
		return record;
	}

	/** Writes raw bytes as a blob directly in the server repository and points `ref` at it. */
	async setServerBlob(ref: string, text: string): Promise<string> {
		const oid = (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	async hasObject(repository: string, oid: string): Promise<boolean> {
		return (await server().git(repository, ["cat-file", "-e", oid], undefined, false)).rc === 0;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	/** Diagnostic values a failure reason must never echo for `operationId` under `storage`. */
	secrets(operationId: string, storage: ClaimStorageOptions): string[] {
		return [this.journalDirectory, this.root, storage.remote, operationId];
	}

	async dispose(): Promise<void> {
		for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		await chmod(this.journalDirectory, 0o700).catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: QueryCase) => Promise<void>,
	descriptor: "same" | "other" | "none" = "same",
): Promise<void> {
	const fixture = await QueryCase.create(format, caseName, descriptor);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("claim mutation query before the network", () => {
	test(
		"ends journal, identifier and scope failures before any connection, which a matching query does make",
		async () => {
			await withCase("blob", "before-network", async (fixture) => {
				const stall = await fixture.stallProxy();
				const stalled = `git://127.0.0.1:${stall.port}/stalled.git`;
				const storage = fixture.storage(fixture.primary, { remote: stalled, timeoutMs: STALL_TIMEOUT });
				const record = await fixture.persist(fixture.intent("op-stalled", null, { remote: stalled }));
				const op = record.intent.operationId;
				const secrets = fixture.secrets(op, storage);
				const journalBefore = await snapshot(fixture.journalDirectory);

				// No record for the ID: absent is a local fact, not a remote verdict.
				const absent = await fixture.query("op-never-prepared", storage);
				expect(absent).toEqual({ kind: "record-absent" });

				const missing = join(fixture.root, "missing-journal");
				const missingResult = await fixture.query(op, storage, { journalDirectory: missing });
				expectFailure("missing journal", missingResult, "invalid", [...secrets, missing]);
				expect(await exists(missing)).toBe(false);
				const relative = await fixture.query(op, storage, { journalDirectory: "journal" });
				expectFailure("relative journal", relative, "invalid", secrets);
				expectFailure("invalid operation ID", await fixture.query("a/b", storage), "invalid", secrets);

				await chmod(fixture.journalDirectory, 0o755);
				expectFailure("unsafe journal", await fixture.query(op, storage), "invalid", secrets);
				await chmod(fixture.journalDirectory, 0o700);

				const failing = await fixture.query(op, storage, { journalIO: failingRecordLstat(op) });
				expectFailure("record IO failure", failing, "unavailable", secrets);
				const directoryIO = failingDirectoryLstat(fixture.journalDirectory);
				const directoryFailure = await fixture.query(op, storage, { journalIO: directoryIO });
				expectFailure("journal directory IO failure", directoryFailure, "unavailable", secrets);
				const zeroTimeout = await fixture.query(op, { ...storage, timeoutMs: 0 });
				expectFailure("zero timeout", zeroTimeout, "invalid", secrets);

				const scopes: Record<string, ClaimStorageOptions> = {
					"other repository": { ...storage, remote: `git://127.0.0.1:${stall.port}/other.git` },
					"host alias": { ...storage, remote: `git://localhost:${stall.port}/stalled.git` },
					"trailing slash": { ...storage, remote: `${stalled}/` },
					"other format": { ...storage, format: "tree" },
				};
				for (const [label, scope] of Object.entries(scopes)) {
					expectFailure(label, await fixture.query(op, scope), "invalid", [...secrets, scope.remote]);
				}

				// A separate journal holds the corrupt record, so the main journal's directory stays untouched.
				const corruptJournal = join(fixture.root, "journal-corrupt");
				await mkdir(corruptJournal);
				await chmod(corruptJournal, 0o700);
				const corruptPath = join(corruptJournal, `${op}.json`);
				await writeFile(corruptPath, "{not a record}\n", { mode: 0o600 });
				await chmod(corruptPath, 0o600);
				const corruptBefore = await snapshot(corruptJournal);
				const corrupt = await fixture.query(op, storage, { journalDirectory: corruptJournal });
				expectFailure("corrupt record", corrupt, "record-corrupt", [...secrets, corruptJournal]);
				expect(await snapshot(corruptJournal)).toEqual(corruptBefore);

				await Bun.sleep(SETTLE_MS);
				expect({ connectionsBeforeControl: stall.acceptedConnections }).toEqual({ connectionsBeforeControl: 0 });
				expect(await snapshot(fixture.journalDirectory)).toEqual(journalBefore);

				// Positive control: the same valid record and matching scope does reach the listener.
				expectFailure("stalled endpoint", await fixture.query(op, storage), "unknown", secrets);
				expect({ connectionsSeen: stall.acceptedConnections > 0 }).toEqual({ connectionsSeen: true });
				expect(await snapshot(fixture.journalDirectory)).toEqual(journalBefore);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"captures caller options and journal IO before the first await, so later mutation redirects nothing",
		async () => {
			await withCase("blob", "captured-options", async (fixture) => {
				const record = await fixture.persist(fixture.intent("op-captured", null));
				const stall = await fixture.stallProxy();
				const other = await fixture.client("other");
				const otherJournal = join(fixture.root, "journal-other");
				await mkdir(otherJournal);
				await chmod(otherJournal, 0o700);

				const storage = fixture.storage();
				const io: typeof claimJournalIO = { ...claimJournalIO };
				const options: ClaimMutationQueryOptions = {
					journalDirectory: fixture.journalDirectory,
					operationId: record.intent.operationId,
					storage,
					journalIO: io,
				};
				const pending = queryClaimMutation(options);
				storage.remote = `git://127.0.0.1:${stall.port}/redirected.git`;
				storage.format = "tree";
				storage.repository = other;
				storage.timeoutMs = 1;
				io.lstat = failingRecordLstat(record.intent.operationId).lstat;
				options.operationId = "op-never-prepared";
				options.journalDirectory = otherJournal;
				options.storage = { ...storage };

				expect(await pending).toEqual({ kind: "resolved", resolution: { kind: "open", observedRoot: null } });
				await Bun.sleep(SETTLE_MS);
				expect(stall.acceptedConnections).toBe(0);
				expect(await readdir(otherJournal)).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim mutation query over real Git (${format})`, () => {
		test(
			"queries the original record freshly and read-only: open, then displaced, then stored",
			async () => {
				await withCase(format, "freshness", async (fixture) => {
					const ours = await fixture.store(fixture.primary);
					const theirs = await fixture.store(await fixture.client("competitor"));
					await fixture.persist(fixture.intent("op-mine", null));
					const competitor = await fixture.persist(fixture.intent("op-theirs", null, { targetBinding: OTHER_BINDING }));
					const refsInitial = await fixture.serverRefs();
					const journalInitial = await snapshot(fixture.journalDirectory);

					// Unsent intent: open, and the query neither sends it nor initializes anything.
					expect(await fixture.query("op-mine")).toEqual({
						kind: "resolved",
						resolution: { kind: "open", observedRoot: null },
					});
					expect(await fixture.serverRefs()).toEqual(refsInitial);

					// A real competing mutation in between: the next query reads freshly, no cached verdict.
					const won = expectKind(
						await theirs.write(expectKind(await theirs.read(TICKET), "absent"), changeOf(competitor, CLAIMED)),
						"applied",
					);
					expect(await fixture.query("op-mine")).toEqual({
						kind: "resolved",
						resolution: { kind: "not-stored", observedRoot: won.root },
					});
					expect(await fixture.query("op-theirs")).toEqual({
						kind: "resolved",
						resolution: { kind: "stored", observedRoot: won.root },
					});
					expect(await snapshot(fixture.journalDirectory)).toEqual(journalInitial);

					// An own applied mutation is stored; repeated queries agree and change no authoritative data.
					const next = await fixture.persist(fixture.intent("op-next", won.root));
					const present = expectKind(await ours.read(TICKET), "present");
					const applied = expectKind(await ours.write(present, changeOf(next, RENEWED)), "applied");
					const refsAfterWrites = await fixture.serverRefs();
					const journalAfterPersist = await snapshot(fixture.journalDirectory);
					const first = await fixture.query("op-next");
					expect(first).toEqual({ kind: "resolved", resolution: { kind: "stored", observedRoot: applied.root } });
					expect(await fixture.query("op-next")).toEqual(first);
					expect(await fixture.query("op-mine")).toEqual({
						kind: "resolved",
						resolution: { kind: "not-stored", observedRoot: applied.root },
					});
					expect(Object.keys(first).sort(byCodeUnits)).toEqual(["kind", "resolution"]);
					expect(await fixture.serverRefs()).toEqual(refsAfterWrites);
					expect(await snapshot(fixture.journalDirectory)).toEqual(journalAfterPersist);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports missing, foreign-format, unsupported and corrupt descriptors without initialization or ticket read",
			async () => {
				// Missing descriptor, with a raw ticket ref the query repository has never fetched.
				await withCase(
					format,
					"descriptor-missing",
					async (fixture) => {
						const root = await fixture.setServerBlob(TICKET_REF, `missing descriptor ticket ${format}\n`);
						const record = await fixture.persist(fixture.intent("op-missing-descriptor", null));
						const refsBefore = await fixture.serverRefs();
						const result = await fixture.query(record.intent.operationId);
						const secrets = fixture.secrets(record.intent.operationId, fixture.storage());
						expectFailure("missing descriptor", result, "unknown-history", secrets);
						expect(await fixture.serverRefs()).toEqual(refsBefore);
						expect(refsBefore[DESCRIPTOR_REF]).toBeUndefined();
						expect(await fixture.hasObject(fixture.primary, root)).toBe(false);
					},
					"none",
				);

				// Descriptor of the other format, with a ticket written in that format by an independent client.
				await withCase(
					format,
					"foreign-format",
					async (fixture) => {
						const writer = await fixture.store(await fixture.client("writer"), otherFormat(format));
						const foreign = expectKind(
							await writer.write(expectKind(await writer.read(TICKET), "absent"), {
								operationId: "op-foreign",
								receipt: { schema: 1, intentDigest: sha256Hex("foreign"), parameterDigest: sha256Hex("p") },
								payload: CLAIMED,
							}),
							"applied",
						);
						const record = await fixture.persist(fixture.intent("op-foreign-format", null));
						const refsBefore = await fixture.serverRefs();
						const result = await fixture.query(record.intent.operationId);
						const secrets = fixture.secrets(record.intent.operationId, fixture.storage());
						expectFailure("foreign format", result, "unknown-history", secrets);
						expect(await fixture.serverRefs()).toEqual(refsBefore);
						expect(await fixture.hasObject(fixture.primary, foreign.root)).toBe(false);
					},
					"other",
				);

				// Unsupported descriptor schema and a corrupt descriptor blob.
				const descriptors = [
					{ label: "schema 2", text: `{"epoch":1,"format":"${format}","schema":2}\n`, kind: "unsupported" },
					{ label: "corrupt", text: "not a descriptor\n", kind: "unknown" },
				] as const;
				for (const { label, text, kind } of descriptors) {
					await withCase(
						format,
						`descriptor-${label.replace(" ", "-")}`,
						async (fixture) => {
							const descriptor = await fixture.setServerBlob(DESCRIPTOR_REF, text);
							const record = await fixture.persist(fixture.intent(`op-descriptor-${kind}`, null));
							const refsBefore = await fixture.serverRefs();
							const result = await fixture.query(record.intent.operationId);
							expectFailure(label, result, kind, fixture.secrets(record.intent.operationId, fixture.storage()));
							expect(await fixture.serverRefs()).toEqual(refsBefore);
							expect(refsBefore[DESCRIPTOR_REF]).toBe(descriptor);
						},
						"none",
					);
				}
			},
			TEST_TIMEOUT,
		);

		test(
			"treats an opened epoch that differs from the intent as unknown history before any ticket read",
			async () => {
				await withCase(format, "epoch", async (fixture) => {
					const writer = await fixture.store(await fixture.client("writer"));
					const intruder = await fixture.persist(fixture.intent("op-intruder", null, { targetBinding: OTHER_BINDING }));
					const written = expectKind(
						await writer.write(expectKind(await writer.read(TICKET), "absent"), changeOf(intruder, CLAIMED)),
						"applied",
					);
					const epochTwo = await fixture.persist(fixture.intent("op-epoch-two", null, { epoch: 2 }));
					const control = await fixture.persist(fixture.intent("op-epoch-one", null));
					const refsBefore = await fixture.serverRefs();
					expect(await fixture.hasObject(fixture.primary, written.root)).toBe(false);

					const differing = await fixture.query(epochTwo.intent.operationId);
					const epochSecrets = fixture.secrets(epochTwo.intent.operationId, fixture.storage());
					expectFailure("opened epoch 1, intent epoch 2", differing, "unknown-history", epochSecrets);
					expect(await fixture.hasObject(fixture.primary, written.root)).toBe(false);

					const wrongFormat = fixture.storage(fixture.primary, { format: otherFormat(format) });
					const scoped = await fixture.query(control.intent.operationId, wrongFormat);
					const controlSecrets = fixture.secrets(control.intent.operationId, wrongFormat);
					expectFailure("rejected scope", scoped, "invalid", controlSecrets);
					expect(await fixture.hasObject(fixture.primary, written.root)).toBe(false);

					// Positive control: the matching epoch and scope read the ticket, which fetches its root object.
					expect(await fixture.query(control.intent.operationId)).toEqual({
						kind: "resolved",
						resolution: { kind: "not-stored", observedRoot: written.root },
					});
					expect(await fixture.hasObject(fixture.primary, written.root)).toBe(true);
					expect(await fixture.serverRefs()).toEqual(refsBefore);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports an unreachable endpoint as unknown, never as a negative verdict",
			async () => {
				await withCase(format, "unreachable", async (fixture) => {
					const refused = `git://127.0.0.1:${await unusedLoopbackPort()}/refused.git`;
					const record = await fixture.persist(fixture.intent("op-refused", null, { remote: refused }));
					const storage = fixture.storage(fixture.primary, { remote: refused });
					const result = await fixture.query(record.intent.operationId, storage);
					expectFailure("refused endpoint", result, "unknown", fixture.secrets(record.intent.operationId, storage));
				});
			},
			TEST_TIMEOUT,
		);
	});
}
