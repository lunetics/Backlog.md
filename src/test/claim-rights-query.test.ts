/**
 * Behavioural contract for the read-only rights query: a real private claim
 * context, real Git stores over loopback TCP for blob, tree and commit-chain, the StallProxy connection counter
 * for deterministic "no network contact" checks and the narrow context IO seam. The query projects one fresh
 * observation for the loaded context binding; it is no complete "may I work?" admission and proves no clock
 * accuracy, endpoint authentication, absence of outstanding own operations or external-effect fencing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ClaimContext, claimContextIO, createClaimContext } from "../claims/context/index.ts";
import { type ClaimRightEvaluation, type QueryClaimRightOptions, queryClaimRight } from "../claims/rights/index.ts";
import {
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
const LONG_TEST_TIMEOUT = 40_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout for queries that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
/** Margin for any stray asynchronous accept before a zero count is read; the zero itself is the proof. */
const SETTLE_MS = 200;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TICKET = "BACK-1";
const TICKET_REF = `refs/claims/${TICKET}`;
const DESCRIPTOR_REF = "refs/claim-meta/format";
/** Distinctive owner name that no diagnostic may echo. */
const OWNER = "agent-sentinel-owner";

const MINUTE = 60_000;
const MAX = Number.MAX_SAFE_INTEGER;
const T = 1_800_000_000_000;
const EPS = 2_000;
const GRACE = 10 * MINUTE;
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type ContextHandle = { context: ClaimContext; directory: string };
type CountingClock = { clock: () => number; calls: () => number };

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

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function otherFormat(format: ClaimStorageFormat): ClaimStorageFormat {
	return format === "blob" ? "tree" : "blob";
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

function leaseTiming(leaseEnd = L, hardEnd: number | null = null): JsonObject {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

function hardTiming(hardEnd = H): JsonObject {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

function activeState(binding: string, timing: JsonObject = leaseTiming(), changes: JsonObject = {}): JsonObject {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 3,
		bindingGeneration: 1,
		owner: OWNER,
		binding,
		timing,
		...changes,
	};
}

function tombstone(claimGeneration: number): JsonObject {
	return { claimState: 1, status: "free", claimGeneration };
}

function evaluated(
	ownership: Evaluated["ownership"],
	workRight: WorkRight,
	reclaim: Reclaim,
	observedRoot: string | null,
	claimGeneration: number | null,
): Evaluated {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot,
		claimGeneration,
		ownership,
		workRight,
		reclaim,
	};
}

function live(renewalDue: boolean | null): WorkRight {
	return { kind: "live", renewalDue };
}

function noRight(cause: Extract<WorkRight, { kind: "none" }>["cause"]): WorkRight {
	return { kind: "none", cause };
}

function notYet(boundary: number): Reclaim {
	return { kind: "not-yet", boundary };
}

const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

/** A clock that counts its calls; `read` is a fixed time or a function that may inspect state or throw. */
function countingClock(read: number | (() => number)): CountingClock {
	const state = { count: 0 };
	return {
		clock: () => {
			state.count += 1;
			return typeof read === "number" ? read : read();
		},
		calls: () => state.count,
	};
}

/**
 * A failure carries exactly `kind` and a nonempty string `reason` that echoes none of the given values.
 * Only counts are compared, so a failing run prints no raw values either.
 */
function expectFailure(
	label: string,
	result: ClaimRightEvaluation,
	kind: ClaimRightEvaluation["kind"],
	values: string[],
): void {
	const reason = (result as { reason?: unknown }).reason;
	const text = typeof reason === "string" ? reason : "";
	const echoed = [OWNER, ...values].filter((value) => value !== "" && text.includes(value)).length;
	expect({
		label,
		kind: result.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof reason,
		reasonEmpty: text.length === 0,
		echoed,
	}).toEqual({ label, kind, keys: ["kind", "reason"], reasonType: "string", reasonEmpty: false, echoed: 0 });
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

/** Context IO that fails the `lstat` of exactly `target` with EIO; everything else is real. */
function failingContextLstat(target: string): typeof claimContextIO {
	const lstatTarget = async (...args: Parameters<typeof claimContextIO.lstat>) => {
		if (String(args[0]) === target) {
			throw Object.assign(new Error("injected context lstat failure"), { code: "EIO" });
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatTarget as unknown as typeof claimContextIO.lstat };
}

/** One server repository, a query client repository, an independent writer and a private context parent. */
class RightsCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The repository every query uses; ticket objects appear here only through the query's own reads. */
	readonly primary: string;
	/** Private 0700 parent of all contexts of this case. */
	readonly parent: string;
	private readonly cleanups: (() => Promise<void>)[] = [];
	private writerStore: ClaimStore | undefined;
	private operations = 0;

	private constructor(format: ClaimStorageFormat, root: string, url: string, serverRepo: string, primary: string) {
		this.format = format;
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.primary = primary;
		this.parent = join(root, "contexts");
	}

	/** `descriptor`: initialize with the case format, with the `other` format through another client, or not at all. */
	static async create(
		format: ClaimStorageFormat,
		caseName: string,
		descriptor: "same" | "other" | "none" = "same",
	): Promise<RightsCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-rights-"));
		try {
			const { name, repo } = await server().initRepository(root, `rights-${format}-${caseName}`);
			const primary = await RightsCase.initClient(join(root, "client-query"));
			const rightsCase = new RightsCase(format, root, server().url(name), repo, primary);
			await mkdir(rightsCase.parent);
			await chmod(rightsCase.parent, 0o700);
			if (descriptor === "same") expectKind(await initializeClaimStorage(rightsCase.storage(primary)), "created");
			if (descriptor === "other") {
				const initializer = await rightsCase.client("initializer");
				const options = { ...rightsCase.storage(initializer), format: otherFormat(format) };
				expectKind(await initializeClaimStorage(options), "created");
			}
			return rightsCase;
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
		return RightsCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, changes: Partial<ClaimStorageOptions> = {}): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT, ...changes };
	}

	async store(repository: string, format = this.format): Promise<ClaimStore> {
		return expectKind(await openClaimStore({ ...this.storage(repository), format }), "open").store;
	}

	/** Creates a context through the API below the private parent, optionally recovering from `recoverFrom`. */
	async context(recoverFrom?: string): Promise<ContextHandle> {
		const created = await createClaimContext(
			recoverFrom === undefined ? { parent: this.parent } : { parent: this.parent, recoverFrom },
		);
		const context = expectKind(created, "created").context;
		return { context, directory: dirname(context.journalDirectory) };
	}

	/** Reads the private secret directly; only tests may do this, and only to prove it is never echoed. */
	async secretOf(handle: ContextHandle): Promise<string> {
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = (record as { secret?: unknown }).secret;
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		return secret;
	}

	/** Values a result or diagnostic concerning `handle` must never contain. */
	async sensitive(handle: ContextHandle): Promise<string[]> {
		return [await this.secretOf(handle), handle.context.binding, handle.directory, this.parent, this.root, this.url];
	}

	/** Writes the next claim state through the independent writer client and returns the applied root. */
	async writeState(payload: JsonObject): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		const base = await this.writerStore.read(TICKET);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		this.operations += 1;
		const operationId = `op-${this.operations}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return expectKind(await this.writerStore.write(base, { operationId, receipt, payload }), "applied").root;
	}

	query(
		contextDirectory: string,
		clock: CountingClock,
		changes: Partial<QueryClaimRightOptions> = {},
	): Promise<ClaimRightEvaluation> {
		return queryClaimRight({
			storage: this.storage(),
			ticket: TICKET,
			contextDirectory,
			clockSkewMs: EPS,
			clock: clock.clock,
			...changes,
		});
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

	/** Synchronous object check for use inside a clock callback. */
	hasObjectNow(repository: string, oid: string): boolean {
		const result = Bun.spawnSync(["git", "-C", repository, "cat-file", "-e", oid], {
			env: server().env,
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	async dispose(): Promise<void> {
		for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: RightsCase) => Promise<void>,
	descriptor: "same" | "other" | "none" = "same",
): Promise<void> {
	const fixture = await RightsCase.create(format, caseName, descriptor);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("claim right query before the network", () => {
	test(
		"ends option, context and IO failures before any connection or clock call, which a valid query does reach",
		async () => {
			await withCase("blob", "before-network", async (fixture) => {
				const stall = await fixture.stallProxy();
				const stalled = `git://127.0.0.1:${stall.port}/stalled.git`;
				const storage = fixture.storage(fixture.primary, { remote: stalled, timeoutMs: STALL_TIMEOUT });
				const karl = await fixture.context();
				const broken = await fixture.context();
				await chmod(join(broken.directory, "context.json"), 0o644);
				const missing = join(fixture.parent, "00000000-0000-4000-8000-000000000000");
				const sensitive = [...(await fixture.sensitive(karl)), ...(await fixture.sensitive(broken)), stalled, missing];
				const entriesBefore = (await readdir(fixture.parent)).sort(byCodeUnits);
				const clock = countingClock(T);

				const cases: [string, Partial<QueryClaimRightOptions>, ClaimRightEvaluation["kind"]][] = [
					["relative context directory", { contextDirectory: basename(karl.directory) }, "invalid"],
					["missing context directory", { contextDirectory: missing }, "invalid"],
					["non-string context directory", { contextDirectory: 42 as unknown as string }, "invalid"],
					["non-canonical ticket", { ticket: "back-1" }, "invalid"],
					["negative epsilon", { clockSkewMs: -1 }, "invalid"],
					["fractional epsilon", { clockSkewMs: 0.5 }, "invalid"],
					["expected generation zero", { expectedClaimGeneration: 0 }, "invalid"],
					["clock that is not a function", { clock: 42 as unknown as () => number }, "invalid"],
					[
						"context IO entry that is not a function",
						{ contextIO: { ...claimContextIO, open: 42 as unknown as typeof claimContextIO.open } },
						"invalid",
					],
					["zero storage timeout", { storage: { ...storage, timeoutMs: 0 } }, "invalid"],
					[
						"unknown storage format",
						{ storage: { ...storage, format: "zip" as unknown as ClaimStorageFormat } },
						"invalid",
					],
					["remote name instead of an endpoint", { storage: { ...storage, remote: "origin" } }, "invalid"],
					["corrupt context", { contextDirectory: broken.directory }, "corrupt"],
					[
						"context IO failure",
						{ contextIO: failingContextLstat(join(karl.directory, "context.json")) },
						"unavailable",
					],
				];
				for (const [label, changes, kind] of cases) {
					expectFailure(label, await fixture.query(karl.directory, clock, { storage, ...changes }), kind, sensitive);
				}

				await Bun.sleep(SETTLE_MS);
				expect({ connections: stall.acceptedConnections, clockCalls: clock.calls() }).toEqual({
					connections: 0,
					clockCalls: 0,
				});
				expect((await readdir(fixture.parent)).sort(byCodeUnits)).toEqual(entriesBefore);
				expect(await exists(missing)).toBe(false);

				// Positive control: the same valid options reach the listener; the failed read never calls the clock.
				const stalledResult = await fixture.query(karl.directory, clock, { storage });
				expectFailure("stalled endpoint", stalledResult, "unknown", sensitive);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"captures options, clock and context IO before the first await, so later mutation redirects nothing",
		async () => {
			await withCase("blob", "captured-options", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const root = await fixture.writeState(activeState(karl.context.binding));
				const stall = await fixture.stallProxy();
				const other = await fixture.client("other");
				const storage = fixture.storage();
				const io: typeof claimContextIO = { ...claimContextIO };
				const original = countingClock(T);
				const replacement = countingClock(H);
				const ticketReads = { count: 0 };
				const options: QueryClaimRightOptions = {
					storage,
					ticket: TICKET,
					contextDirectory: karl.directory,
					contextIO: io,
					clockSkewMs: EPS,
					clock: original.clock,
				};
				// A primitive option behind a getter is read once, before the first await.
				Object.defineProperty(options, "ticket", {
					enumerable: true,
					configurable: true,
					get: () => {
						ticketReads.count += 1;
						return TICKET;
					},
				});

				const pending = queryClaimRight(options);
				storage.remote = `git://127.0.0.1:${stall.port}/redirected.git`;
				storage.format = "tree";
				storage.repository = other;
				storage.timeoutMs = 1;
				io.lstat = failingContextLstat(join(karl.directory, "context.json")).lstat;
				options.contextDirectory = franz.directory;
				options.clockSkewMs = -1;
				options.clock = replacement.clock;
				options.expectedClaimGeneration = 99;
				options.storage = { ...storage };

				expect(await pending).toStrictEqual(evaluated("held", live(false), notYet(R), root, 3));
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					originalClockCalls: original.calls(),
					replacementClockCalls: replacement.calls(),
					ticketReads: ticketReads.count,
				}).toEqual({ connections: 0, originalClockCalls: 1, replacementClockCalls: 0, ticketReads: 1 });
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim right query over real Git (${format})`, () => {
		test(
			"projects every fresh observation for the loaded context binding only, never the recovery binding",
			async () => {
				await withCase(format, "projection", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const resumed = await fixture.context(karl.directory);
					expect(resumed.context.recovery).toEqual({ binding: karl.context.binding });
					const sensitive = [
						...(await fixture.sensitive(karl)),
						...(await fixture.sensitive(franz)),
						...(await fixture.sensitive(resumed)),
						OWNER,
					];
					const contextsBefore = await snapshot(fixture.parent);
					const results: ClaimRightEvaluation[] = [];
					const ask = async (
						handle: ContextHandle,
						now = T,
						changes: Partial<QueryClaimRightOptions> = {},
					): Promise<ClaimRightEvaluation> => {
						const clock = countingClock(now);
						const result = await fixture.query(handle.directory, clock, changes);
						expect({ clockCalls: clock.calls() }).toEqual({ clockCalls: 1 });
						results.push(result);
						return result;
					};

					// No claim ref yet: absent, never free, and the query itself writes nothing.
					const refsInitial = await fixture.serverRefs();
					expect(await ask(karl)).toStrictEqual(evaluated("absent", noRight("absent"), NOT_APPLICABLE, null, null));
					expect(await fixture.serverRefs()).toEqual(refsInitial);

					// Karl holds a pure lease: live for his binding past the lease end, foreign for everyone else.
					const held = await fixture.writeState(activeState(karl.context.binding));
					expect(await ask(karl)).toStrictEqual(evaluated("held", live(false), notYet(R), held, 3));
					expect(await ask(karl, L + 2 * MINUTE)).toStrictEqual(evaluated("held", live(true), notYet(R), held, 3));
					expect(await ask(franz)).toStrictEqual(evaluated("foreign", noRight("not-holder"), notYet(R), held, 3));
					expect(await ask(resumed)).toStrictEqual(evaluated("foreign", noRight("not-holder"), notYet(R), held, 3));
					expect(await ask(karl, T, { expectedClaimGeneration: 2 })).toStrictEqual(
						evaluated("held", noRight("generation-changed"), notYet(R), held, 3),
					);

					// Resume onto the fresh binding: the resumed context holds, the recovered one no longer does.
					const resumedRoot = await fixture.writeState(
						activeState(resumed.context.binding, leaseTiming(), { bindingGeneration: 2 }),
					);
					expect(await ask(resumed)).toStrictEqual(evaluated("held", live(false), notYet(R), resumedRoot, 3));
					expect(await ask(karl)).toStrictEqual(evaluated("foreign", noRight("not-holder"), notYet(R), resumedRoot, 3));

					// Transfer to Franz: every query reads freshly, no cached projection.
					const transferred = await fixture.writeState(
						activeState(franz.context.binding, leaseTiming(), { claimGeneration: 4 }),
					);
					expect(await ask(franz)).toStrictEqual(evaluated("held", live(false), notYet(R), transferred, 4));
					expect(await ask(resumed)).toStrictEqual(
						evaluated("foreign", noRight("not-holder"), notYet(R), transferred, 4),
					);

					// Release to a tombstone: free for everyone, never a right.
					const freed = await fixture.writeState(tombstone(4));
					for (const handle of [franz, karl]) {
						expect(await ask(handle)).toStrictEqual(evaluated("free", noRight("free"), NOT_APPLICABLE, freed, 4));
					}

					// A new hard-mode claim: the explicit clock decides at H.
					const hardRoot = await fixture.writeState(
						activeState(franz.context.binding, hardTiming(), { claimGeneration: 5 }),
					);
					expect(await ask(franz, H - 1 - EPS)).toStrictEqual(
						evaluated("held", live(null), notYet(H + GRACE), hardRoot, 5),
					);
					expect(await ask(franz, H - EPS)).toStrictEqual(
						evaluated("held", noRight("hard-expired"), notYet(H + GRACE), hardRoot, 5),
					);

					const refsFinal = await fixture.serverRefs();
					expect(await ask(karl)).toStrictEqual(
						evaluated("foreign", noRight("not-holder"), notYet(H + GRACE), hardRoot, 5),
					);
					expect(await fixture.serverRefs()).toEqual(refsFinal);
					expect(await snapshot(fixture.parent)).toEqual(contextsBefore);
					const serialized = JSON.stringify(results);
					expect({ echoed: sensitive.filter((value) => serialized.includes(value)).length }).toEqual({ echoed: 0 });
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"reads before the clock: the observed root object is already local when the clock runs",
			async () => {
				await withCase(format, "clock-after-read", async (fixture) => {
					const karl = await fixture.context();
					const root = await fixture.writeState(activeState(karl.context.binding));
					expect(await fixture.hasObject(fixture.primary, root)).toBe(false);
					const presentAtClock: boolean[] = [];
					const clock = countingClock(() => {
						presentAtClock.push(fixture.hasObjectNow(fixture.primary, root));
						return T;
					});
					expect(await fixture.query(karl.directory, clock)).toStrictEqual(
						evaluated("held", live(false), notYet(R), root, 3),
					);
					expect({ clockCalls: clock.calls(), presentAtClock }).toEqual({ clockCalls: 1, presentAtClock: [true] });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"maps a broken clock to invalid after a successful read and decodes the payload after the clock",
			async () => {
				await withCase(format, "clock-and-payload", async (fixture) => {
					const karl = await fixture.context();
					const sensitive = await fixture.sensitive(karl);
					const root = await fixture.writeState(activeState(karl.context.binding));
					const clocks: [string, () => number][] = [
						[
							"throwing clock",
							() => {
								throw new Error(`clock failure ${OWNER} ${karl.directory}`);
							},
						],
						["negative time", () => -1],
						["fractional time", () => T + 0.5],
						["NaN time", () => Number.NaN],
						["now plus epsilon overflow", () => MAX],
					];
					for (const [label, read] of clocks) {
						const clock = countingClock(read);
						expectFailure(label, await fixture.query(karl.directory, clock), "invalid", sensitive);
						expect({ label, clockCalls: clock.calls() }).toEqual({ label, clockCalls: 1 });
					}
					const healthy = countingClock(T);
					expect(await fixture.query(karl.directory, healthy)).toStrictEqual(
						evaluated("held", live(false), notYet(R), root, 3),
					);

					const payloads: [string, JsonObject, ClaimRightEvaluation["kind"]][] = [
						["legacy name-based payload", { state: "claimed", holder: OWNER }, "corrupt"],
						// The holder's own fields break the v1 PENDING schema.
						["pending payload", { ...activeState(karl.context.binding), status: "pending" }, "corrupt"],
						["foreign version", { ...activeState(karl.context.binding), claimState: 2 }, "unsupported"],
					];
					for (const [label, payload, kind] of payloads) {
						await fixture.writeState(payload);
						const clock = countingClock(T);
						expectFailure(label, await fixture.query(karl.directory, clock), kind, sensitive);
						expect({ label, clockCalls: clock.calls() }).toEqual({ label, clockCalls: 1 });
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports descriptor and endpoint failures as unknown or unsupported, without initialization or clock",
			async () => {
				await withCase(
					format,
					"descriptor-missing",
					async (fixture) => {
						const karl = await fixture.context();
						const raw = await fixture.setServerBlob(TICKET_REF, `raw ticket ${format}\n`);
						const clock = countingClock(T);
						const result = await fixture.query(karl.directory, clock);
						expectFailure("missing descriptor", result, "unknown", await fixture.sensitive(karl));
						expect(clock.calls()).toBe(0);
						expect((await fixture.serverRefs())[DESCRIPTOR_REF]).toBeUndefined();
						expect(await fixture.hasObject(fixture.primary, raw)).toBe(false);
					},
					"none",
				);

				await withCase(
					format,
					"foreign-format",
					async (fixture) => {
						const karl = await fixture.context();
						const refsBefore = await fixture.serverRefs();
						const clock = countingClock(T);
						const result = await fixture.query(karl.directory, clock);
						expectFailure("foreign format", result, "unknown", await fixture.sensitive(karl));
						expect(clock.calls()).toBe(0);
						expect(await fixture.serverRefs()).toEqual(refsBefore);
					},
					"other",
				);

				const descriptors = [
					{ label: "schema 2", text: `{"epoch":1,"format":"${format}","schema":2}\n`, kind: "unsupported" },
					{ label: "corrupt", text: "not a descriptor\n", kind: "unknown" },
				] as const;
				for (const { label, text, kind } of descriptors) {
					await withCase(
						format,
						`descriptor-${label.replace(" ", "-")}`,
						async (fixture) => {
							const karl = await fixture.context();
							const descriptor = await fixture.setServerBlob(DESCRIPTOR_REF, text);
							const clock = countingClock(T);
							const result = await fixture.query(karl.directory, clock);
							expectFailure(label, result, kind, await fixture.sensitive(karl));
							expect(clock.calls()).toBe(0);
							expect((await fixture.serverRefs())[DESCRIPTOR_REF]).toBe(descriptor);
						},
						"none",
					);
				}

				// Valid descriptor, but the ticket ref holds no claim document: a failed read, never absent or free.
				await withCase(format, "corrupt-ticket", async (fixture) => {
					const karl = await fixture.context();
					const raw = await fixture.setServerBlob(TICKET_REF, `not a claim document ${format}\n`);
					const refsBefore = await fixture.serverRefs();
					const clock = countingClock(T);
					const result = await fixture.query(karl.directory, clock);
					expectFailure("corrupt ticket ref", result, "unknown", [...(await fixture.sensitive(karl)), raw]);
					expect(clock.calls()).toBe(0);
					expect(await fixture.serverRefs()).toEqual(refsBefore);
				});

				await withCase(format, "refused", async (fixture) => {
					const karl = await fixture.context();
					const refused = `git://127.0.0.1:${await unusedLoopbackPort()}/refused.git`;
					const clock = countingClock(T);
					const storage = fixture.storage(fixture.primary, { remote: refused });
					const result = await fixture.query(karl.directory, clock, { storage });
					expectFailure("refused endpoint", result, "unknown", [...(await fixture.sensitive(karl)), refused]);
					expect(clock.calls()).toBe(0);
				});
			},
			LONG_TEST_TIMEOUT,
		);
	});
}
