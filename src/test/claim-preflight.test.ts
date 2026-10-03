/**
 * Behavioural contract for the shared claim storage preflight and the coordination initialization over real Git: a
 * loopback daemon for blob, tree and commit-chain, gated receive hooks, the StallProxy connection counter and real
 * private claim contexts behind the context IO seam. `ready` is preflight only: it reserves nothing, proves no write
 * capability and never replaces a conditional write. Cases that end before the network run with blob only; every other
 * case runs for all three formats.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type ClaimCoordinationInitResult,
	type ClaimPreflightOptions,
	type ClaimPreflightPurpose,
	type ClaimPreflightResult,
	type ClaimSettings,
	initializeClaimCoordination,
	preflightClaimStorage,
	resolveClaimSettings,
} from "../claims/config/index.ts";
import { type ClaimContext, claimContextIO, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import { planClaimTransition } from "../claims/transition/index.ts";
import { GitFixtureServer, ReceiveGates, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const PURPOSES = ["observe", "maintain", "acquire"] as const satisfies readonly ClaimPreflightPurpose[];
const TEST_TIMEOUT = 20_000;
const LONG_TEST_TIMEOUT = 40_000;
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms for cases that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
const SETTLE_MS = 200;
/** Below the storage default of 3000 ms, so an ignored configured timeout is visible. */
const OVERDUE_MS = 2_500;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Appears in repository names, endpoint paths, client and context paths; no reason may contain it. */
const SENTINEL = "SENTINEL-preflight-5c1e";
const OWNER = `agent-${SENTINEL}`;
const TICKET = "BACK-1";
const TICKET_REF = `refs/claims/${TICKET}`;
const DESCRIPTOR_REF = "refs/claim-meta/format";
const READY_KEYS = ["context", "descriptor", "kind", "scope", "settings", "store"];
const MINUTE = 60_000;
const T = 1_800_000_000_000;
const EPS = 2_000;
const GRACE = 10 * MINUTE;
const L = T + 5 * MINUTE;
const R = L + GRACE;

type Mode = "lease" | "hard" | "none";
type BlockOptions = {
	endpoint: string;
	format: ClaimStorageFormat;
	enabled?: boolean;
	mode?: Mode;
	ttlMs?: number;
	timeoutMs?: number;
};
type Ready = Extract<ClaimPreflightResult, { kind: "ready" }>;
type InitOptions = Parameters<typeof initializeClaimCoordination>[0];
type OptionChanges = { [K in keyof ClaimPreflightOptions]?: unknown };
type ContextHandle = { context: ClaimContext; directory: string };
type VerdictView = {
	label: string;
	kind: string;
	keys: string[];
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
	configured: unknown;
	descriptor: unknown;
	problems: unknown;
};
type ReadyView = {
	label: string;
	kind: string;
	keys: string[];
	scope: unknown;
	settings: unknown;
	descriptor: unknown;
	context: unknown;
	storeUsable: boolean;
};
type VerdictRow = { label: string; catches: string; changes: OptionChanges; expected: VerdictView };

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

function bogus<V>(value: unknown): V {
	return value as V;
}

function otherFormat(format: ClaimStorageFormat): ClaimStorageFormat {
	return format === "blob" ? "tree" : "blob";
}

function descriptorOf(format: ClaimStorageFormat): ClaimStorageDescriptor {
	return { schema: 1, format, epoch: 1 };
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

function jsonCopy(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function activeState(binding: string, changes: JsonObject = {}): JsonObject {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 3,
		bindingGeneration: 1,
		owner: OWNER,
		binding,
		timing: { mode: "lease", leaseEnd: L, graceMs: GRACE, hardEnd: null },
		...changes,
	};
}

function tombstone(claimGeneration: number): JsonObject {
	return { claimState: 1, status: "free", claimGeneration };
}

function change(operationId: string, payload: JsonObject) {
	const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
	return { operationId, receipt, payload };
}

/** ASSUMPTION(preflight): the raw `claims:` block, as BacklogConfig.claimsYaml carries it. */
function claimsBlock(options: BlockOptions): string {
	const { endpoint, format, enabled = true, mode = "lease", ttlMs = 300_000, timeoutMs = ADAPTER_TIMEOUT } = options;
	const lines = [
		"claims:",
		`  enabled: ${enabled}`,
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${format}`,
		`  lifetime_mode: ${mode}`,
		...(mode === "lease" ? [`  lease_ttl_ms: ${ttlMs}`] : []),
		...(mode === "none" ? [] : ["  reclaim_grace_ms: 600000"]),
		`  attempt_timeout_ms: ${timeoutMs}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
	];
	return `${lines.join("\n")}\n`;
}

function settingsFor(options: BlockOptions): ClaimSettings {
	const { endpoint, format, enabled = true, mode = "lease", ttlMs = 300_000, timeoutMs = ADAPTER_TIMEOUT } = options;
	const lifetime: ClaimSettings["lifetime"] =
		mode === "lease"
			? { mode: "lease", leaseTtlMs: ttlMs, reclaimGraceMs: 600_000 }
			: mode === "hard"
				? { mode: "hard", reclaimGraceMs: 600_000 }
				: { mode: "none" };
	return {
		enabled,
		endpoint,
		storageFormat: format,
		lifetime,
		attemptTimeoutMs: timeoutMs,
		attempts: 3,
		operationBudgetMs: 30_000,
	};
}

/** Kind, exact keys and payload fields; the reason only as type, emptiness and a count of echoed sensitive values. */
function verdictOf(label: string, result: { kind: string }, sensitive: readonly string[]): VerdictView {
	const view = result as {
		kind: string;
		reason?: unknown;
		configured?: unknown;
		descriptor?: unknown;
		problems?: unknown;
	};
	const text = typeof view.reason === "string" ? view.reason : "";
	return {
		label,
		kind: view.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof view.reason,
		reasonEmpty: text.length === 0,
		echoed: [SENTINEL, ...sensitive].filter((value) => value !== "" && text.includes(value)).length,
		configured: view.configured,
		descriptor: view.descriptor,
		problems: Array.isArray(view.problems)
			? (view.problems as { key?: unknown; problem?: unknown }[]).map(({ key, problem }) => ({ key, problem }))
			: undefined,
	};
}

/** pf-10: a non-ready verdict has exactly kind and reason, so it carries no store and no ticket observation. */
function failure(label: string, kind: string): VerdictView {
	return {
		label,
		kind,
		keys: ["kind", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
		configured: undefined,
		descriptor: undefined,
		problems: undefined,
	};
}

function mismatch(
	label: string,
	kind: "format-mismatch" | "conflict",
	configured: ClaimStorageFormat,
	descriptor: ClaimStorageDescriptor,
): VerdictView {
	return { ...failure(label, kind), keys: ["configured", "descriptor", "kind", "reason"], configured, descriptor };
}

function configInvalid(label: string, problems: { key: string; problem: string }[]): VerdictView {
	return { ...failure(label, "config-invalid"), keys: ["kind", "problems", "reason"], problems };
}

function expectReady(
	label: string,
	result: ClaimPreflightResult,
	settings: ClaimSettings,
	descriptor: ClaimStorageDescriptor,
	context: ClaimContext | null,
): Ready {
	const view = result as {
		kind: string;
		scope?: unknown;
		settings?: unknown;
		descriptor?: unknown;
		context?: unknown;
		store?: { read?: unknown; write?: unknown };
	};
	const actual: ReadyView = {
		label,
		kind: view.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		scope: view.scope,
		settings: view.settings,
		descriptor: view.descriptor,
		context: view.context,
		storeUsable: typeof view.store?.read === "function" && typeof view.store?.write === "function",
	};
	const expected: ReadyView = {
		label,
		kind: "ready",
		keys: READY_KEYS,
		scope: "preflight-only",
		settings,
		descriptor,
		context,
		storeUsable: true,
	};
	expect(actual).toStrictEqual(expected);
	if (result.kind !== "ready") throw new Error(`${label}: expected ready`);
	return result;
}

function expectInit(label: string, result: ClaimCoordinationInitResult, expected: ClaimCoordinationInitResult): void {
	expect({ label, result }).toStrictEqual({ label, result: expected });
}

/** Context IO that counts every call and otherwise behaves like the real module IO. */
function countingContextIO(): { io: typeof claimContextIO; calls: () => number } {
	const state = { count: 0 };
	const io = Object.fromEntries(
		Object.entries(claimContextIO).map(([name, fn]) => [
			name,
			(...args: unknown[]) => {
				state.count += 1;
				return Reflect.apply(fn, undefined, args);
			},
		]),
	) as unknown as typeof claimContextIO;
	return { io, calls: () => state.count };
}

// adapted from claim-rights-query.test.ts:217
function failingContextLstat(target: string): typeof claimContextIO {
	const lstatTarget = async (...args: Parameters<typeof claimContextIO.lstat>) => {
		if (String(args[0]) === target) {
			throw Object.assign(new Error(`injected context lstat failure ${SENTINEL}`), { code: "EIO" });
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatTarget as unknown as typeof claimContextIO.lstat };
}

// adapted from claim-rights-query.test.ts:276
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** One server area, a primary client, independent clients, a private context parent and receive gates. */
class PreflightCase {
	readonly gates: ReceiveGates;
	readonly parent: string;
	private readonly cleanups: (() => Promise<void>)[] = [];
	private writerStore: ClaimStore | undefined;
	private operations = 0;

	private constructor(
		readonly format: ClaimStorageFormat,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly primary: string,
		label: string,
	) {
		this.gates = new ReceiveGates(root, label);
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	/** `same`: the area is initialized through the storage module with the case format; `none`: left empty. */
	static async create(
		format: ClaimStorageFormat,
		caseName: string,
		descriptor: "same" | "none",
	): Promise<PreflightCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-preflight-"));
		try {
			const label = `pf-${SENTINEL}-${format}-${caseName}`;
			const { name, repo } = await server().initRepository(root, label);
			const primary = await initClient(join(root, `client-${SENTINEL}-primary`));
			const fixture = new PreflightCase(format, root, server().url(name), repo, primary, label);
			await mkdir(fixture.parent);
			await chmod(fixture.parent, 0o700);
			if (descriptor === "same") expectKind(await initializeClaimStorage(fixture.storage()), "created");
			return fixture;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	storage(repository = this.primary, remote = this.url, format = this.format) {
		return { repository, remote, format, timeoutMs: ADAPTER_TIMEOUT };
	}

	block(changes: Partial<BlockOptions> = {}): string {
		return claimsBlock({ endpoint: this.url, format: this.format, ...changes });
	}

	settings(changes: Partial<BlockOptions> = {}): ClaimSettings {
		return settingsFor({ endpoint: this.url, format: this.format, ...changes });
	}

	preflight(changes: OptionChanges = {}): Promise<ClaimPreflightResult> {
		const options = { claimsYaml: this.block(), repository: this.primary, purpose: "observe", ...changes };
		return preflightClaimStorage(options as ClaimPreflightOptions);
	}

	init(changes: { [K in keyof InitOptions]?: unknown } = {}): Promise<ClaimCoordinationInitResult> {
		return initializeClaimCoordination({
			claimsYaml: this.block(),
			repository: this.primary,
			...changes,
		} as InitOptions);
	}

	client(label: string): Promise<string> {
		return initClient(join(this.root, `client-${SENTINEL}-${label}`));
	}

	async context(recoverFrom?: string): Promise<ContextHandle> {
		const options = recoverFrom === undefined ? { parent: this.parent } : { parent: this.parent, recoverFrom };
		const context = expectKind(await createClaimContext(options), "created").context;
		return { context, directory: dirname(context.journalDirectory) };
	}

	async brokenContext(): Promise<ContextHandle> {
		const handle = await this.context();
		await chmod(join(handle.directory, "context.json"), 0o644);
		return handle;
	}

	/** A byte-identical copy of `handle` under a second private parent, with the same context ID. */
	async copyContext(handle: ContextHandle): Promise<string> {
		const parent = join(this.root, `contexts-copy-${SENTINEL}`);
		const copy = join(parent, handle.context.contextId);
		for (const directory of [parent, copy, join(copy, "journal")]) {
			await mkdir(directory);
			await chmod(directory, 0o700);
		}
		await copyFile(join(handle.directory, "context.json"), join(copy, "context.json"));
		await chmod(join(copy, "context.json"), 0o600);
		return copy;
	}

	async sensitive(...handles: ContextHandle[]): Promise<string[]> {
		const values = [OWNER, this.root, this.url, this.primary, this.parent];
		for (const handle of handles) {
			const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
			values.push(String((record as { secret?: unknown }).secret), handle.context.binding, handle.directory);
		}
		return values;
	}

	async setServerBlob(ref: string, text: string, repo = this.serverRepo): Promise<string> {
		const oid = (await server().git(repo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(repo, ["update-ref", ref, oid]);
		return oid;
	}

	async setServerEmptyTree(ref: string): Promise<string> {
		const oid = (await server().git(this.serverRepo, ["mktree"], "")).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async serverRefs(repo = this.serverRepo): Promise<Record<string, string>> {
		const listing = await server().git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** Sorted "oid type" rows of every object in a server repository. */
	async serverObjects(repo = this.serverRepo): Promise<string[]> {
		const args = ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"];
		return (await server().git(repo, args)).out.split("\n").filter(Boolean).sort(byCodeUnits);
	}

	async objectTypes(repo = this.serverRepo): Promise<string[]> {
		return (await this.serverObjects(repo)).map((row) => row.split(" ")[1] ?? "").sort(byCodeUnits);
	}

	async localRefs(repository: string): Promise<string[]> {
		return (await server().git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"])).out
			.split("\n")
			.filter(Boolean);
	}

	/** Another area on the same daemon. */
	async decoy(label: string): Promise<{ url: string; repo: string }> {
		const { name, repo } = await server().initRepository(this.root, `pf-${SENTINEL}-${this.format}-${label}`);
		return { url: server().url(name), repo };
	}

	/** Learns the descriptor object the facade writes for `format` by initializing a scratch area. */
	async learnDescriptorOid(repository: string, format: ClaimStorageFormat): Promise<string> {
		const scratch = await this.decoy(`scratch-${format}`);
		const result = await this.init({ claimsYaml: claimsBlock({ endpoint: scratch.url, format }), repository });
		expectInit(`scratch ${format}`, result, { kind: "created", descriptor: descriptorOf(format) });
		const oid = (await this.serverRefs(scratch.repo))[DESCRIPTOR_REF];
		if (!oid) throw new Error(`scratch initialization left no ${format} descriptor`);
		return oid;
	}

	// adapted from claim-rights-query.test.ts:319
	async writeState(payload: JsonObject): Promise<string> {
		this.writerStore ??= expectKind(await openClaimStore(this.storage(await this.client("writer"))), "open").store;
		const base = await this.writerStore.read(TICKET);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		this.operations += 1;
		const written = await this.writerStore.write(base, change(`op-writer-${this.operations}`, payload));
		return expectKind(written, "applied").root;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	stallUrl(proxy: StallProxy): string {
		return `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
	}

	async refusedUrl(): Promise<string> {
		return `git://127.0.0.1:${await unusedLoopbackPort()}/${SENTINEL}-refused.git`;
	}

	/** An existing directory outside any Git work tree; refuses to run where the check would be vacuous. */
	async plainDirectory(label: string): Promise<string> {
		const path = join(this.root, `plain-${SENTINEL}-${label}`);
		await mkdir(path);
		const probe = await server().git(path, ["rev-parse", "--is-inside-work-tree"], undefined, false);
		if (probe.rc === 0) throw new Error("fixture root lies inside a Git work tree; the non-Git case would be vacuous");
		return path;
	}

	async dispose(): Promise<void> {
		await this.gates.releaseAll();
		for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

/** The loopback daemon port of a fixture URL (claim-git-fixture.ts:181). */
function daemonPort(url: string): number {
	const port = /^git:\/\/127\.0\.0\.1:(\d+)\//.exec(url)?.[1];
	if (port === undefined) throw new Error("not a loopback fixture URL");
	return Number(port);
}

/**
 * Forwards the first `budget` loopback connections to the fixture daemon and destroys every later one on accept, so
 * a Git client meets a hung-up remote from a chosen command on (ini-11).
 */
// adapted from claim-git-fixture.ts:249 (DropProxy)
class BudgetProxy {
	readonly port: number;
	private readonly listener: Server;
	private readonly sockets = new Set<Socket>();
	private accepted = 0;

	private constructor(listener: Server, port: number) {
		this.listener = listener;
		this.port = port;
	}

	static async create(targetPort: number, budget: number): Promise<BudgetProxy> {
		const listener = createServer();
		const port = await new Promise<number>((resolvePort, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", () => {
				listener.off("error", reject);
				const address = listener.address();
				if (!address || typeof address === "string") reject(new Error("proxy did not receive a loopback port"));
				else resolvePort(address.port);
			});
		});
		const proxy = new BudgetProxy(listener, port);
		listener.on("connection", (client) => {
			proxy.accepted += 1;
			proxy.sockets.add(client);
			client.on("error", () => undefined);
			client.once("close", () => proxy.sockets.delete(client));
			if (proxy.accepted > budget) {
				client.destroy();
				return;
			}
			const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
			proxy.sockets.add(upstream);
			upstream.on("error", () => client.destroy());
			upstream.once("close", () => proxy.sockets.delete(upstream));
			client.pipe(upstream).pipe(client);
		});
		return proxy;
	}

	/** Connections accepted so far, forwarded or cut. */
	get acceptedConnections(): number {
		return this.accepted;
	}

	/** `url` with its daemon port replaced by this proxy's port. */
	route(url: string): string {
		return url.replace(`:${daemonPort(url)}/`, `:${this.port}/`);
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolveClose) => this.listener.close(() => resolveClose()));
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: PreflightCase) => Promise<void>,
	descriptor: "same" | "none" = "same",
): Promise<void> {
	const fixture = await PreflightCase.create(format, caseName, descriptor);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

for (const format of FORMATS) {
	describe(`claim preflight over real Git (${format})`, () => {
		test(
			"pf-01 is ready for a matching descriptor, preflight only, with a usable store and nothing written",
			async () => {
				await withCase(format, "ready", async (fixture) => {
					const karl = await fixture.context();
					const before = {
						refs: await fixture.serverRefs(),
						objects: await fixture.serverObjects(),
						local: await fixture.localRefs(fixture.primary),
					};
					for (const purpose of ["acquire", "maintain"] as const) {
						const result = await fixture.preflight({ purpose, contextDirectory: karl.directory });
						const ready = expectReady(purpose, result, fixture.settings(), descriptorOf(format), karl.context);
						expect({ purpose, read: await ready.store.read(TICKET) }).toStrictEqual({
							purpose,
							read: { kind: "absent", ticket: TICKET },
						});
					}
					expectReady("observe", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					expect(resolveClaimSettings(fixture.block())).toStrictEqual({
						kind: "configured",
						settings: fixture.settings(),
					});
					expect({
						refs: await fixture.serverRefs(),
						objects: await fixture.serverObjects(),
						local: await fixture.localRefs(fixture.primary),
					}).toEqual(before);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-02 reports an empty area as descriptor-missing and never initializes it",
			async () => {
				await withCase(
					format,
					"missing",
					async (fixture) => {
						expect(await openClaimStore(fixture.storage())).toEqual({ kind: "descriptor-missing" });
						const karl = await fixture.context();
						const sensitive = await fixture.sensitive(karl);
						for (const purpose of PURPOSES) {
							const result = await fixture.preflight({ purpose, contextDirectory: karl.directory });
							expect(verdictOf(purpose, result, sensitive)).toStrictEqual(failure(purpose, "descriptor-missing"));
						}
						expect({ refs: await fixture.serverRefs(), objects: await fixture.serverObjects() }).toEqual({
							refs: {},
							objects: [],
						});
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-03 reports a descriptor of another format as format-mismatch every time and adopts nothing",
			async () => {
				await withCase(format, "mismatch", async (fixture) => {
					expectReady("control", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const other = otherFormat(format);
					const oid = await fixture.setServerBlob(DESCRIPTOR_REF, `${JSON.stringify(descriptorOf(other))}\n`);
					const sensitive = await fixture.sensitive();
					for (const label of ["first", "second"]) {
						expect(verdictOf(label, await fixture.preflight(), sensitive)).toStrictEqual(
							mismatch(label, "format-mismatch", format, descriptorOf(other)),
						);
					}
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: oid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-04 and pf-05 separate an unsupported schema from every corrupt descriptor and change none",
			async () => {
				await withCase(format, "descriptors", async (fixture) => {
					expectReady("control", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const text = (value: unknown) => `${JSON.stringify(value)}\n`;
					const rows = [
						{
							label: "schema 2",
							catches: "downgrade or mixed with corrupt",
							kind: "schema-unsupported",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, text({ epoch: 1, format, schema: 2 })),
						},
						{
							label: "not JSON",
							catches: "corrupt read as missing",
							kind: "corrupt",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, `not json ${SENTINEL}\n`),
						},
						{
							label: "JSON array",
							catches: "corrupt read as missing",
							kind: "corrupt",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, "[]\n"),
						},
						{
							label: "unknown format",
							catches: "format default",
							kind: "corrupt",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, text({ epoch: 1, format: "git-blob", schema: 1 })),
						},
						{
							label: "missing epoch",
							catches: "epoch default",
							kind: "corrupt",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, text({ format, schema: 1 })),
						},
						// DP-11: any positive safe integer is an epoch; zero is not.
						{
							label: "epoch 0",
							catches: "any integer accepted as an epoch",
							kind: "corrupt",
							set: () => fixture.setServerBlob(DESCRIPTOR_REF, text({ epoch: 0, format, schema: 1 })),
						},
						{
							label: "tree at the ref",
							catches: "object type not checked",
							kind: "corrupt",
							set: () => fixture.setServerEmptyTree(DESCRIPTOR_REF),
						},
					];
					const sensitive = await fixture.sensitive();
					for (const { label, catches, kind, set } of rows) {
						const oid = await set();
						const tagged = `${label} (catches: ${catches})`;
						expect(verdictOf(tagged, await fixture.preflight(), sensitive)).toStrictEqual(failure(tagged, kind));
						expect({ label, oid: (await fixture.serverRefs())[DESCRIPTOR_REF] }).toEqual({ label, oid });
					}
					// DP-11 (catches: a later epoch still read as corrupt, or read
					// with epoch 1): the descriptor of epoch 2 is ready with exactly that descriptor, and nothing is written.
					const epochTwo: ClaimStorageDescriptor = { ...descriptorOf(format), epoch: 2 };
					const epochTwoOid = await fixture.setServerBlob(DESCRIPTOR_REF, text(epochTwo));
					expectReady("epoch 2", await fixture.preflight(), fixture.settings(), epochTwo, null);
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: epochTwoOid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-06 reports refused and stalled endpoints as unreachable within the configured timeout, in one attempt",
			async () => {
				await withCase(format, "unreachable", async (fixture) => {
					expectReady("control", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const karl = await fixture.context();
					const stall = await fixture.stallProxy();
					const sensitive = await fixture.sensitive(karl);
					const endpoints = [
						["never opened port", await fixture.refusedUrl()],
						["stalled endpoint", fixture.stallUrl(stall)],
					] as const;
					for (const [label, endpoint] of endpoints) {
						const claimsYaml = fixture.block({ endpoint, timeoutMs: STALL_TIMEOUT });
						const started = Date.now();
						const result = await fixture.preflight({
							claimsYaml,
							purpose: "acquire",
							contextDirectory: karl.directory,
						});
						const overdue = Date.now() - started >= OVERDUE_MS;
						expect(verdictOf(label, result, sensitive)).toStrictEqual(failure(label, "unreachable"));
						expect({ label, overdue }).toEqual({ label, overdue: false });
					}
					await Bun.sleep(SETTLE_MS);
					// ASSUMPTION(preflight): exactly one attempt despite attempts: 3 [?]; relax to >= 1 only by decision.
					expect({ connections: stall.acceptedConnections }).toEqual({ connections: 1 });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-08 uses only the configured endpoint, never the Git remote of the client",
			async () => {
				await withCase(
					format,
					"origin",
					async (fixture) => {
						const decoy = await fixture.decoy("origin-decoy");
						expectKind(await initializeClaimStorage(fixture.storage(fixture.primary, decoy.url)), "created");
						await server().git(fixture.primary, ["remote", "add", "origin", decoy.url]);
						const decoyBefore = {
							refs: await fixture.serverRefs(decoy.repo),
							objects: await fixture.serverObjects(decoy.repo),
						};
						const control = await fixture.preflight({ claimsYaml: fixture.block({ endpoint: decoy.url }) });
						expectReady(
							"decoy configured",
							control,
							fixture.settings({ endpoint: decoy.url }),
							descriptorOf(format),
							null,
						);
						const label = "empty configured endpoint (catches: endpoint derived from Git remotes)";
						expect(verdictOf(label, await fixture.preflight(), await fixture.sensitive())).toStrictEqual(
							failure(label, "descriptor-missing"),
						);
						expect({
							refs: await fixture.serverRefs(decoy.repo),
							objects: await fixture.serverObjects(decoy.repo),
						}).toEqual(decoyBefore);
						expect(await fixture.serverRefs()).toEqual({});
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-09 reserves nothing: a stale snapshot from a ready preflight is rejected and the winner stays",
			async () => {
				await withCase(format, "no-reservation", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const franzClient = await fixture.client("franz");
					const karlResult = await fixture.preflight({ purpose: "acquire", contextDirectory: karl.directory });
					const karlReady = expectReady("karl", karlResult, fixture.settings(), descriptorOf(format), karl.context);
					const karlBase = await karlReady.store.read(TICKET);
					expect(karlBase).toStrictEqual({ kind: "absent", ticket: TICKET });
					const franzResult = await fixture.preflight({
						repository: franzClient,
						purpose: "acquire",
						contextDirectory: franz.directory,
					});
					const franzReady = expectReady("franz", franzResult, fixture.settings(), descriptorOf(format), franz.context);
					const franzBase = expectKind(await franzReady.store.read(TICKET), "absent");
					const franzWrite = await franzReady.store.write(
						franzBase,
						change("op-franz", activeState(franz.context.binding)),
					);
					const franzRoot = expectKind(franzWrite, "applied").root;
					const karlWrite = await karlReady.store.write(
						expectKind(karlBase, "absent"),
						change("op-karl", activeState(karl.context.binding)),
					);
					expect({ kind: karlWrite.kind, cause: karlWrite.kind === "rejected" ? karlWrite.cause : null }).toEqual({
						kind: "rejected",
						cause: "stale",
					});
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(franzRoot);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"pf-11 echoes no endpoint credentials, repository, context path, binding or secret in any reason",
			async () => {
				await withCase(format, "sentinels", async (fixture) => {
					const karl = await fixture.context();
					const broken = await fixture.brokenContext();
					expectReady("control", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const port = await unusedLoopbackPort();
					// The Git-stderr axis keeps its sentinel in the path; the credential form is refused first.
					const marked = `git://127.0.0.1:${port}/${SENTINEL}.git`;
					const credentials = `git://user-${SENTINEL}:pw-${SENTINEL}@127.0.0.1:${port}/${SENTINEL}.git`;
					const plain = await fixture.plainDirectory("sentinel");
					const sensitive = [...(await fixture.sensitive(karl, broken)), marked, credentials, plain];
					const rows: VerdictRow[] = [
						{
							label: "sentinel in the endpoint path",
							catches: "Git stderr passed through (storage/index.ts:101-105)",
							changes: {
								claimsYaml: fixture.block({ endpoint: marked }),
								purpose: "acquire",
								contextDirectory: karl.directory,
							},
							expected: failure("sentinel in the endpoint path", "unreachable"),
						},
						{
							label: "credentials in the endpoint",
							catches: "a credential URL handed to Git (config-invalid first)",
							changes: {
								claimsYaml: fixture.block({ endpoint: credentials }),
								purpose: "acquire",
								contextDirectory: karl.directory,
							},
							expected: configInvalid("credentials in the endpoint", [
								{ key: "claims.endpoint", problem: "unsupported-endpoint" },
							]),
						},
						{
							label: "corrupt context",
							catches: "context path in the reason",
							changes: { purpose: "maintain", contextDirectory: broken.directory },
							expected: failure("corrupt context", "context-corrupt"),
						},
						{
							label: "non-Git repository",
							catches: "repository path in the reason",
							changes: { repository: plain },
							expected: failure("non-Git repository", "invalid"),
						},
					];
					for (const { label, changes, expected } of rows) {
						expect(verdictOf(label, await fixture.preflight(changes), sensitive)).toStrictEqual(expected);
					}
					await fixture.setServerBlob(DESCRIPTOR_REF, `{"epoch":1,"format":"${SENTINEL}","schema":1}\n`);
					expect(verdictOf("sentinel descriptor", await fixture.preflight(), sensitive)).toStrictEqual(
						failure("sentinel descriptor", "corrupt"),
					);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"off-02 keeps observe and maintain ready while disabled, blocks only acquire and changes no claim",
			async () => {
				await withCase(format, "disabled", async (fixture) => {
					const karl = await fixture.context();
					const payload = activeState(karl.context.binding);
					const root = await fixture.writeState(payload);
					const before = { refs: await fixture.serverRefs(), objects: await fixture.serverObjects() };
					const sensitive = await fixture.sensitive(karl);
					const karlOptions = { contextDirectory: karl.directory };
					const enabled = await fixture.preflight({ purpose: "acquire", ...karlOptions });
					expectReady("enabled acquire", enabled, fixture.settings(), descriptorOf(format), karl.context);
					// ASSUMPTION(preflight): disabling gates only acquire.
					const disabled = fixture.block({ enabled: false });
					const off = fixture.settings({ enabled: false });
					const observe = await fixture.preflight({ claimsYaml: disabled });
					const observed = expectReady("disabled observe", observe, off, descriptorOf(format), null);
					const maintain = await fixture.preflight({ claimsYaml: disabled, purpose: "maintain", ...karlOptions });
					expectReady("disabled maintain", maintain, off, descriptorOf(format), karl.context);
					const acquire = await fixture.preflight({ claimsYaml: disabled, purpose: "acquire", ...karlOptions });
					expect(verdictOf("disabled acquire", acquire, sensitive)).toStrictEqual(
						failure("disabled acquire", "claims-disabled"),
					);

					const stall = await fixture.stallProxy();
					const stalled = fixture.block({
						enabled: false,
						endpoint: fixture.stallUrl(stall),
						timeoutMs: STALL_TIMEOUT,
					});
					const reachedResult = await fixture.preflight({ claimsYaml: stalled });
					expect(verdictOf("disabled observe, stalled", reachedResult, sensitive)).toStrictEqual(
						failure("disabled observe, stalled", "unreachable"),
					);
					const reached = stall.acceptedConnections;
					expect({ reached: reached > 0 }).toEqual({ reached: true });
					const gated = await fixture.preflight({ claimsYaml: stalled, purpose: "acquire", ...karlOptions });
					expect(verdictOf("disabled acquire, stalled", gated, sensitive)).toStrictEqual(
						failure("disabled acquire, stalled", "claims-disabled"),
					);
					await Bun.sleep(SETTLE_MS);
					const read = await observed.store.read(TICKET);
					expect({
						connections: stall.acceptedConnections,
						kind: read.kind,
						root: read.kind === "present" ? read.root : null,
						payload: read.kind === "present" ? read.document.payload : null,
						refs: await fixture.serverRefs(),
						objects: await fixture.serverObjects(),
					}).toStrictEqual({ connections: reached, kind: "present", root, payload, ...before });
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"off-03 lets the holder release and another context reclaim after R while claims are disabled",
			async () => {
				await withCase(format, "disabled-maintain", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					await fixture.writeState(activeState(karl.context.binding));
					const disabled = fixture.block({ enabled: false });
					const off = fixture.settings({ enabled: false });
					// ASSUMPTION(preflight): release and reclaim are maintain and stay available while disabled.
					const karlResult = await fixture.preflight({
						claimsYaml: disabled,
						purpose: "maintain",
						contextDirectory: karl.directory,
					});
					const karlReady = expectReady("karl maintain", karlResult, off, descriptorOf(format), karl.context);
					const held = expectKind(await karlReady.store.read(TICKET), "present");
					const release = planClaimTransition({
						ticket: TICKET,
						descriptor: karlReady.descriptor,
						observed: held,
						binding: karl.context.binding,
						request: { action: "release" },
						now: T,
						clockSkewMs: EPS,
					});
					expect({ plan: release.kind }).toEqual({ plan: "planned" });
					if (release.kind !== "planned") throw new Error("release was not planned");
					const released = await karlReady.store.write(held, change("op-release", jsonCopy(release.next)));
					expect({
						kind: released.kind,
						payload: released.kind === "applied" ? released.document.payload : null,
					}).toStrictEqual({
						kind: "applied",
						payload: tombstone(3),
					});

					await fixture.writeState(activeState(karl.context.binding, { claimGeneration: 4 }));
					const franzClient = await fixture.client("franz");
					const franzResult = await fixture.preflight({
						claimsYaml: disabled,
						repository: franzClient,
						purpose: "maintain",
						contextDirectory: franz.directory,
					});
					const franzReady = expectReady("franz maintain", franzResult, off, descriptorOf(format), franz.context);
					const expired = expectKind(await franzReady.store.read(TICKET), "present");
					const reclaim = planClaimTransition({
						ticket: TICKET,
						descriptor: franzReady.descriptor,
						observed: expired,
						binding: franz.context.binding,
						request: { action: "reclaim" },
						now: R + EPS,
						clockSkewMs: EPS,
					});
					expect({ plan: reclaim.kind }).toEqual({ plan: "planned" });
					if (reclaim.kind !== "planned") throw new Error("reclaim was not planned");
					const reclaimed = await franzReady.store.write(expired, change("op-reclaim", jsonCopy(reclaim.next)));
					expect({
						kind: reclaimed.kind,
						payload: reclaimed.kind === "applied" ? reclaimed.document.payload : null,
					}).toStrictEqual({
						kind: "applied",
						payload: tombstone(4),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ctx-03 returns the public context of the given directory with its own binding, never the recovery one",
			async () => {
				await withCase(format, "recovery", async (fixture) => {
					const karl = await fixture.context();
					const resumed = await fixture.context(karl.directory);
					expect({ recovery: resumed.context.recovery }).toEqual({ recovery: { binding: karl.context.binding } });
					const own = await fixture.preflight({ purpose: "maintain", contextDirectory: karl.directory });
					expectReady("own context", own, fixture.settings(), descriptorOf(format), karl.context);
					const result = await fixture.preflight({ purpose: "maintain", contextDirectory: resumed.directory });
					const ready = expectReady(
						"resumed context",
						result,
						fixture.settings(),
						descriptorOf(format),
						resumed.context,
					);
					expect({ recoveryBinding: ready.context?.binding === karl.context.binding }).toEqual({
						recoveryBinding: false,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ctx-05 cannot tell a byte-identical copy from its original (characterization)",
			async () => {
				await withCase(format, "clone", async (fixture) => {
					const karl = await fixture.context();
					const copy = await fixture.copyContext(karl);
					const original = await fixture.preflight({ purpose: "acquire", contextDirectory: karl.directory });
					const first = expectReady("original", original, fixture.settings(), descriptorOf(format), karl.context);
					const cloned = await fixture.preflight({ purpose: "acquire", contextDirectory: copy });
					const copyContext = { ...karl.context, journalDirectory: join(copy, "journal") };
					const second = expectReady("copy", cloned, fixture.settings(), descriptorOf(format), copyContext);
					expect({ sameBinding: first.context?.binding === second.context?.binding }).toEqual({ sameBinding: true });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ctx-06 needs no context to observe, but never ignores a given broken one",
			async () => {
				await withCase(format, "observe-context", async (fixture) => {
					const karl = await fixture.context();
					const broken = await fixture.brokenContext();
					const withContext = await fixture.preflight({ contextDirectory: karl.directory });
					expectReady("observe with context", withContext, fixture.settings(), descriptorOf(format), karl.context);
					expectReady(
						"observe without context",
						await fixture.preflight(),
						fixture.settings(),
						descriptorOf(format),
						null,
					);
					const label = "observe with corrupt context (catches: given context silently ignored)";
					const result = await fixture.preflight({ contextDirectory: broken.directory });
					expect(verdictOf(label, result, await fixture.sensitive(karl, broken))).toStrictEqual(
						failure(label, "context-corrupt"),
					);
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim preflight before the network (blob)", () => {
	test(
		"pf-07 ends option, configuration, gate and repository failures before any connection, in fixed precedence",
		async () => {
			await withCase("blob", "before-network", async (fixture) => {
				const stall = await fixture.stallProxy();
				const stalled = fixture.stallUrl(stall);
				const block = fixture.block({ endpoint: stalled, timeoutMs: STALL_TIMEOUT });
				const karl = await fixture.context();
				const broken = await fixture.brokenContext();
				const plain = await fixture.plainDirectory("repository");
				const rewritten = await fixture.client("rewrite");
				await server().git(rewritten, ["config", `url.git://127.0.0.1:9/rewritten-${SENTINEL}.git.insteadOf`, stalled]);
				const sensitive = [...(await fixture.sensitive(karl, broken)), stalled, plain, rewritten];
				const base = { claimsYaml: block, purpose: "acquire", contextDirectory: karl.directory };
				const control = await fixture.preflight(base);
				expect(verdictOf("control", control, sensitive)).toStrictEqual(failure("control", "unreachable"));
				const reached = stall.acceptedConnections;
				expect({ reached: reached > 0 }).toEqual({ reached: true });

				const counting = countingContextIO();
				const invalidYaml = block.replace("  attempts: 3\n", "  attempts: 0\n");
				const disabled = fixture.block({ endpoint: stalled, timeoutMs: STALL_TIMEOUT, enabled: false });
				const rows: VerdictRow[] = [
					{
						label: "purpose missing",
						catches: "default purpose",
						changes: { purpose: undefined },
						expected: failure("purpose missing", "invalid"),
					},
					{
						label: "purpose unknown",
						catches: "lax purpose",
						changes: { purpose: "claim" },
						expected: failure("purpose unknown", "invalid"),
					},
					{
						label: "purpose not a string",
						catches: "lax purpose",
						changes: { purpose: 1 },
						expected: failure("purpose not a string", "invalid"),
					},
					{
						label: "relative repository",
						catches: "cwd-relative repository",
						changes: { repository: "client-primary" },
						expected: failure("relative repository", "invalid"),
					},
					{
						label: "non-string repository",
						catches: "lax typing",
						changes: { repository: 42 },
						expected: failure("non-string repository", "invalid"),
					},
					// ASSUMPTION(preflight): a missing or non-Git repository is invalid, never unreachable.
					{
						label: "missing repository",
						catches: "fetch failure as unreachable",
						changes: { repository: join(fixture.root, "missing") },
						expected: failure("missing repository", "invalid"),
					},
					{
						label: "non-Git repository",
						catches: "fetch failure as unreachable",
						changes: { repository: plain },
						expected: failure("non-Git repository", "invalid"),
					},
					{
						label: "context IO not a function",
						catches: "unchecked seam",
						changes: { contextIO: { ...claimContextIO, open: 42 } },
						expected: failure("context IO not a function", "invalid"),
					},
					{
						label: "not configured",
						catches: "hidden default configuration",
						changes: { claimsYaml: undefined },
						expected: failure("not configured", "not-configured"),
					},
					{
						label: "invalid configuration",
						catches: "partial configuration used",
						changes: { claimsYaml: invalidYaml },
						expected: configInvalid("invalid configuration", [{ key: "claims.attempts", problem: "out-of-range" }]),
					},
					// ASSUMPTION(preflight)
					{
						label: "disabled acquire",
						catches: "gate after the network",
						changes: { claimsYaml: disabled },
						expected: failure("disabled acquire", "claims-disabled"),
					},
					{
						label: "URL rewrite",
						catches: "insteadOf redirect",
						changes: { repository: rewritten },
						expected: failure("URL rewrite", "invalid"),
					},
					{
						label: "not configured before missing context",
						catches: "context check first",
						changes: { claimsYaml: undefined, purpose: "maintain", contextDirectory: undefined },
						expected: failure("not configured before missing context", "not-configured"),
					},
					{
						label: "disabled before missing context",
						catches: "context check first",
						changes: { claimsYaml: disabled, contextDirectory: undefined },
						expected: failure("disabled before missing context", "claims-disabled"),
					},
					{
						label: "invalid purpose before not configured",
						catches: "configuration read first",
						changes: { purpose: "bogus", claimsYaml: undefined },
						expected: failure("invalid purpose before not configured", "invalid"),
					},
					{
						label: "invalid configuration before corrupt context",
						catches: "context loaded first",
						changes: {
							claimsYaml: invalidYaml,
							purpose: "maintain",
							contextDirectory: broken.directory,
							contextIO: counting.io,
						},
						expected: configInvalid("invalid configuration before corrupt context", [
							{ key: "claims.attempts", problem: "out-of-range" },
						]),
					},
					{
						label: "repository before context",
						catches: "context loaded first (DP-10)",
						changes: {
							repository: plain,
							purpose: "maintain",
							contextDirectory: broken.directory,
							contextIO: counting.io,
						},
						expected: failure("repository before context", "invalid"),
					},
				];
				for (const { label, catches, changes, expected } of rows) {
					const tagged = `${label} (catches: ${catches})`;
					const view = verdictOf(tagged, await fixture.preflight({ ...base, ...changes }), sensitive);
					expect(view).toStrictEqual({ ...expected, label: tagged });
				}
				const notObject = await preflightClaimStorage(bogus<ClaimPreflightOptions>(null));
				expect(verdictOf("options not an object", notObject, sensitive)).toStrictEqual(
					failure("options not an object", "invalid"),
				);
				await Bun.sleep(SETTLE_MS);
				expect({ connections: stall.acceptedConnections, contextIO: counting.calls() }).toEqual({
					connections: reached,
					contextIO: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"pf-12 captures options before the first await, so later mutation redirects nothing",
		async () => {
			await withCase("blob", "captured", async (fixture) => {
				const karl = await fixture.context();
				const broken = await fixture.brokenContext();
				const stall = await fixture.stallProxy();
				const options: ClaimPreflightOptions = {
					claimsYaml: fixture.block(),
					repository: fixture.primary,
					purpose: "acquire",
					contextDirectory: karl.directory,
				};
				const pending = preflightClaimStorage(options);
				options.claimsYaml = fixture.block({
					endpoint: fixture.stallUrl(stall),
					timeoutMs: STALL_TIMEOUT,
					enabled: false,
				});
				options.purpose = bogus<ClaimPreflightPurpose>("claim");
				options.contextDirectory = broken.directory;
				options.repository = "relative-repository";
				expectReady("captured options", await pending, fixture.settings(), descriptorOf("blob"), karl.context);
				await Bun.sleep(SETTLE_MS);
				expect({ connections: stall.acceptedConnections }).toEqual({ connections: 0 });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"off-01 reports not-configured for every purpose without contacting any endpoint, not even a Git remote",
		async () => {
			await withCase("blob", "not-configured", async (fixture) => {
				const stall = await fixture.stallProxy();
				const stalled = fixture.stallUrl(stall);
				await server().git(fixture.primary, ["remote", "add", "origin", stalled]);
				const karl = await fixture.context();
				const sensitive = [...(await fixture.sensitive(karl)), stalled];
				const control = await fixture.preflight({
					claimsYaml: fixture.block({ endpoint: stalled, timeoutMs: STALL_TIMEOUT }),
				});
				expect(verdictOf("control", control, sensitive)).toStrictEqual(failure("control", "unreachable"));
				const reached = stall.acceptedConnections;
				expect({ reached: reached > 0 }).toEqual({ reached: true });
				for (const purpose of PURPOSES) {
					for (const contextDirectory of [undefined, karl.directory]) {
						const label = `${purpose} ${contextDirectory ? "with" : "without"} context`;
						const result = await fixture.preflight({ claimsYaml: undefined, purpose, contextDirectory });
						expect(verdictOf(label, result, sensitive)).toStrictEqual(failure(label, "not-configured"));
					}
				}
				await Bun.sleep(SETTLE_MS);
				expect({ connections: stall.acceptedConnections }).toEqual({ connections: reached });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ctx-01 never selects a context implicitly, not even the only one below the parent",
		async () => {
			await withCase("blob", "no-default-context", async (fixture) => {
				const karl = await fixture.context();
				const counting = countingContextIO();
				const explicit = await fixture.preflight({
					purpose: "maintain",
					contextDirectory: karl.directory,
					contextIO: counting.io,
				});
				expectReady("explicit context", explicit, fixture.settings(), descriptorOf("blob"), karl.context);
				const loaded = counting.calls();
				expect({ loaded: loaded > 0 }).toEqual({ loaded: true });
				const stall = await fixture.stallProxy();
				const claimsYaml = fixture.block({ endpoint: fixture.stallUrl(stall), timeoutMs: STALL_TIMEOUT });
				const listing = (await readdir(fixture.parent)).sort(byCodeUnits);
				const sensitive = await fixture.sensitive(karl);
				for (const purpose of ["maintain", "acquire"] as const) {
					const label = `${purpose} without context (catches: automatic, host or user default)`;
					const result = await fixture.preflight({ claimsYaml, purpose, contextIO: counting.io });
					expect(verdictOf(label, result, sensitive)).toStrictEqual(failure(label, "invalid"));
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					contextIO: counting.calls() - loaded,
					connections: stall.acceptedConnections,
					listing: (await readdir(fixture.parent)).sort(byCodeUnits),
				}).toEqual({ contextIO: 0, connections: 0, listing });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ctx-02 rejects relative, empty and non-string context paths without context IO",
		async () => {
			await withCase("blob", "context-paths", async (fixture) => {
				const karl = await fixture.context();
				const counting = countingContextIO();
				const explicit = await fixture.preflight({ purpose: "maintain", contextDirectory: karl.directory });
				expectReady("control", explicit, fixture.settings(), descriptorOf("blob"), karl.context);
				const sensitive = await fixture.sensitive(karl);
				const rows: [string, ClaimPreflightPurpose, unknown][] = [
					["relative path", "maintain", basename(karl.directory)],
					["relative path while observing", "observe", basename(karl.directory)],
					["empty path", "maintain", ""],
					["number", "acquire", 42],
					["path with NUL", "maintain", `${karl.directory}\0`],
				];
				for (const [label, purpose, contextDirectory] of rows) {
					const tagged = `${label} (catches: lax path rule)`;
					const result = await fixture.preflight({ purpose, contextDirectory, contextIO: counting.io });
					expect(verdictOf(tagged, result, sensitive)).toStrictEqual(failure(tagged, "invalid"));
				}
				expect({ contextIO: counting.calls() }).toEqual({ contextIO: 0 });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ctx-04 maps corrupt, missing and unavailable contexts before any connection",
		async () => {
			await withCase("blob", "context-failures", async (fixture) => {
				const stall = await fixture.stallProxy();
				const claimsYaml = fixture.block({ endpoint: fixture.stallUrl(stall), timeoutMs: STALL_TIMEOUT });
				const karl = await fixture.context();
				const broken = await fixture.brokenContext();
				const missing = join(fixture.parent, "00000000-0000-4000-8000-000000000000");
				const sensitive = [...(await fixture.sensitive(karl, broken)), missing];
				const base = { claimsYaml, purpose: "maintain", contextDirectory: karl.directory };
				expect(verdictOf("control", await fixture.preflight(base), sensitive)).toStrictEqual(
					failure("control", "unreachable"),
				);
				const reached = stall.acceptedConnections;
				expect({ reached: reached > 0 }).toEqual({ reached: true });
				const rows: VerdictRow[] = [
					{
						label: "mode 0644",
						catches: "unsafe record accepted",
						changes: { contextDirectory: broken.directory },
						expected: failure("mode 0644", "context-corrupt"),
					},
					{
						label: "missing directory",
						catches: "context created or ignored",
						changes: { contextDirectory: missing },
						expected: failure("missing directory", "context-invalid"),
					},
					{
						label: "lstat EIO",
						catches: "IO failure as ready or as network failure",
						changes: { contextIO: failingContextLstat(join(karl.directory, "context.json")) },
						expected: failure("lstat EIO", "context-unavailable"),
					},
				];
				for (const { label, catches, changes, expected } of rows) {
					const tagged = `${label} (catches: ${catches})`;
					const view = verdictOf(tagged, await fixture.preflight({ ...base, ...changes }), sensitive);
					expect(view).toStrictEqual({ ...expected, label: tagged });
				}
				await Bun.sleep(SETTLE_MS);
				expect({ connections: stall.acceptedConnections }).toEqual({ connections: reached });
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim coordination initialization (${format})`, () => {
		test(
			"ini-01 creates only the descriptor, then preflights ready and reports exists again",
			async () => {
				await withCase(
					format,
					"init",
					async (fixture) => {
						expectInit("first", await fixture.init(), { kind: "created", descriptor: descriptorOf(format) });
						const refs = await fixture.serverRefs();
						expect({ refs: Object.keys(refs), types: await fixture.objectTypes() }).toEqual({
							refs: [DESCRIPTOR_REF],
							types: ["blob"],
						});
						expectReady("after init", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
						const again = await fixture.init({ repository: await fixture.client("second") });
						expectInit("second", again, { kind: "exists", descriptor: descriptorOf(format) });
						expect(await fixture.serverRefs()).toEqual(refs);
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-02 lets a gated loser of a format race report conflict with the winner's descriptor, writing nothing",
			async () => {
				await withCase(
					format,
					"init-gated",
					async (fixture) => {
						const other = otherFormat(format);
						const karlClient = await fixture.client("karl");
						const franzClient = await fixture.client("franz");
						const karlOid = await fixture.learnDescriptorOid(karlClient, format);
						const franzOid = await fixture.learnDescriptorOid(franzClient, other);
						await fixture.gates.arm("pre", karlOid);
						const pending = fixture.init({ repository: karlClient });
						await fixture.gates.entered("pre", karlOid);
						const franz = await fixture.init({ claimsYaml: fixture.block({ format: other }), repository: franzClient });
						expectInit("franz", franz, { kind: "created", descriptor: descriptorOf(other) });
						await fixture.gates.release("pre", karlOid);
						const label = "karl (catches: loser overwrites, reports created or opens a second area)";
						expect(verdictOf(label, await pending, await fixture.sensitive())).toStrictEqual(
							mismatch(label, "conflict", format, descriptorOf(other)),
						);
						expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: franzOid });
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-03 lets exactly one of two ungated initializers with different formats create",
			async () => {
				await withCase(
					format,
					"init-race",
					async (fixture) => {
						const other = otherFormat(format);
						const [left, right] = await Promise.all([fixture.client("left"), fixture.client("right")]);
						const results = await Promise.all([
							fixture.init({ repository: left }),
							fixture.init({ claimsYaml: fixture.block({ format: other }), repository: right }),
						]);
						expect({ kinds: results.map((result) => result.kind).sort(byCodeUnits) }).toEqual({
							kinds: ["conflict", "created"],
						});
						const winner = results.find((result) => result.kind === "created");
						const loser = results.find((result) => result.kind === "conflict");
						const winnerDescriptor = winner?.kind === "created" ? winner.descriptor : undefined;
						expect({
							loserSees: loser?.kind === "conflict" ? loser.descriptor : undefined,
							loserConfigured: loser?.kind === "conflict" ? loser.configured : undefined,
							refs: Object.keys(await fixture.serverRefs()),
						}).toEqual({
							loserSees: winnerDescriptor,
							loserConfigured: winnerDescriptor?.format === format ? other : format,
							refs: [DESCRIPTOR_REF],
						});
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-04 never migrates on a local format change: format-mismatch, conflict and identical refs",
			async () => {
				await withCase(format, "format-change", async (fixture) => {
					const karl = await fixture.context();
					await fixture.writeState(activeState(karl.context.binding));
					const refs = await fixture.serverRefs();
					expectReady("control", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const other = otherFormat(format);
					const claimsYaml = fixture.block({ format: other });
					const sensitive = await fixture.sensitive(karl);
					expect(verdictOf("preflight", await fixture.preflight({ claimsYaml }), sensitive)).toStrictEqual(
						mismatch("preflight", "format-mismatch", other, descriptorOf(format)),
					);
					expect(verdictOf("init", await fixture.init({ claimsYaml }), sensitive)).toStrictEqual(
						mismatch("init", "conflict", other, descriptorOf(format)),
					);
					expect(await fixture.serverRefs()).toEqual(refs);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-05 treats a changed endpoint as a new empty area until an explicit init, copying nothing",
			async () => {
				await withCase(format, "endpoint-change", async (fixture) => {
					const karl = await fixture.context();
					await fixture.writeState(activeState(karl.context.binding));
					const areaA = await fixture.serverRefs();
					const b = await fixture.decoy("area-b");
					expectReady("area A", await fixture.preflight(), fixture.settings(), descriptorOf(format), null);
					const claimsYaml = fixture.block({ endpoint: b.url });
					const label = "area B (catches: automatic copy or migration)";
					expect(
						verdictOf(label, await fixture.preflight({ claimsYaml }), await fixture.sensitive(karl)),
					).toStrictEqual(failure(label, "descriptor-missing"));
					expect({
						b: await fixture.serverRefs(b.repo),
						bObjects: await fixture.serverObjects(b.repo),
						a: await fixture.serverRefs(),
					}).toEqual({
						b: {},
						bObjects: [],
						a: areaA,
					});
					expectInit("init B", await fixture.init({ claimsYaml }), {
						kind: "created",
						descriptor: descriptorOf(format),
					});
					expect({
						b: Object.keys(await fixture.serverRefs(b.repo)),
						bTypes: await fixture.objectTypes(b.repo),
						a: await fixture.serverRefs(),
					}).toEqual({ b: [DESCRIPTOR_REF], bTypes: ["blob"], a: areaA });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-06 leaves stored claims untouched when lifetime settings change",
			async () => {
				await withCase(format, "lifetime-change", async (fixture) => {
					const karl = await fixture.context();
					const payload = activeState(karl.context.binding);
					const root = await fixture.writeState(payload);
					const refs = await fixture.serverRefs();
					const variants: Partial<BlockOptions>[] = [
						{},
						{ mode: "hard" },
						{ mode: "none" },
						{ mode: "lease", ttlMs: 1 },
					];
					for (const [index, changes] of variants.entries()) {
						const result = await fixture.preflight({ claimsYaml: fixture.block(changes) });
						const ready = expectReady(
							`variant ${index}`,
							result,
							fixture.settings(changes),
							descriptorOf(format),
							null,
						);
						const read = await ready.store.read(TICKET);
						expect({
							index,
							root: read.kind === "present" ? read.root : null,
							payload: read.kind === "present" ? read.document.payload : null,
						}).toStrictEqual({ index, root, payload });
					}
					expect(await fixture.serverRefs()).toEqual(refs);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-08 reports schema-unsupported, corrupt and unreachable areas exactly and writes nothing",
			async () => {
				await withCase(format, "init-failures", async (fixture) => {
					expectInit("control", await fixture.init(), { kind: "exists", descriptor: descriptorOf(format) });
					const sensitive = await fixture.sensitive();
					const schema2 = await fixture.setServerBlob(DESCRIPTOR_REF, `{"epoch":1,"format":"${format}","schema":2}\n`);
					// ASSUMPTION(preflight): the facade opens first, so the storage mapping to corrupt never surfaces.
					const label = "schema 2 (catches: storage init mapping schema-unsupported to corrupt)";
					expect(verdictOf(label, await fixture.init(), sensitive)).toStrictEqual(failure(label, "schema-unsupported"));
					expect(verdictOf("schema 2 preflight", await fixture.preflight(), sensitive)).toStrictEqual(
						failure("schema 2 preflight", "schema-unsupported"),
					);
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: schema2 });
					const corrupt = await fixture.setServerBlob(DESCRIPTOR_REF, "not a descriptor\n");
					expect(verdictOf("corrupt", await fixture.init(), sensitive)).toStrictEqual(failure("corrupt", "corrupt"));
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: corrupt });
					const refused = await fixture.refusedUrl();
					const unreachable = await fixture.init({ claimsYaml: fixture.block({ endpoint: refused }) });
					expect(verdictOf("unreachable", unreachable, [...sensitive, refused])).toStrictEqual(
						failure("unreachable", "unreachable"),
					);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-09 initializes while claims are disabled, because initialization creates no claim",
			async () => {
				await withCase(
					format,
					"init-disabled",
					async (fixture) => {
						// ASSUMPTION(preflight)
						const result = await fixture.init({ claimsYaml: fixture.block({ enabled: false }) });
						expectInit("disabled", result, { kind: "created", descriptor: descriptorOf(format) });
						expect(Object.keys(await fixture.serverRefs())).toEqual([DESCRIPTOR_REF]);
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-10 passes an unknown push outcome through unchanged instead of re-reading it as exists",
			async () => {
				await withCase(
					format,
					"init-unknown",
					async (fixture) => {
						const oid = await fixture.learnDescriptorOid(fixture.primary, format);
						await fixture.gates.arm("pre", oid);
						const pending = fixture.init({ claimsYaml: fixture.block({ timeoutMs: STALL_TIMEOUT }) });
						await fixture.gates.entered("pre", oid);
						const result = await pending;
						await fixture.gates.release("pre", oid);
						// ASSUMPTION(preflight): a push held beyond attempt_timeout_ms stays unknown.
						const label = "held push (catches: unknown reinterpreted as created or exists)";
						expect(verdictOf(label, result, await fixture.sensitive())).toStrictEqual(failure(label, "unknown"));
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim coordination initialization before the network (blob)", () => {
	test(
		"ini-08 ends configuration and repository failures before any connection",
		async () => {
			await withCase(
				"blob",
				"init-before-network",
				async (fixture) => {
					const stall = await fixture.stallProxy();
					const stalled = fixture.stallUrl(stall);
					await server().git(fixture.primary, ["remote", "add", "origin", stalled]);
					const block = fixture.block({ endpoint: stalled, timeoutMs: STALL_TIMEOUT });
					const plain = await fixture.plainDirectory("init");
					const sensitive = [...(await fixture.sensitive()), stalled, plain];
					expect(verdictOf("control", await fixture.init({ claimsYaml: block }), sensitive)).toStrictEqual(
						failure("control", "unreachable"),
					);
					const reached = stall.acceptedConnections;
					expect({ reached: reached > 0 }).toEqual({ reached: true });
					const rows: [string, { [K in keyof InitOptions]?: unknown }, VerdictView][] = [
						["not configured", { claimsYaml: undefined }, failure("not configured", "not-configured")],
						[
							"invalid configuration",
							{ claimsYaml: block.replace("  attempts: 3\n", "  attempts: 0\n") },
							configInvalid("invalid configuration", [{ key: "claims.attempts", problem: "out-of-range" }]),
						],
						[
							"relative repository",
							{ claimsYaml: block, repository: "client-primary" },
							failure("relative repository", "invalid"),
						],
						// ASSUMPTION(preflight)
						[
							"missing repository",
							{ claimsYaml: block, repository: join(fixture.root, "missing") },
							failure("missing repository", "invalid"),
						],
						["non-Git repository", { claimsYaml: block, repository: plain }, failure("non-Git repository", "invalid")],
					];
					for (const [label, changes, expected] of rows) {
						expect(verdictOf(label, await fixture.init(changes), sensitive)).toStrictEqual(expected);
					}
					await Bun.sleep(SETTLE_MS);
					expect({ connections: stall.acceptedConnections, refs: await fixture.serverRefs() }).toEqual({
						connections: reached,
						refs: {},
					});
				},
				"none",
			);
		},
		TEST_TIMEOUT,
	);
});

/** OPTIONAL — depends on DP-8 (lesende Storage-Probe `refs/claims/*`); remove this whole block if DP-8 is dropped. */
for (const format of FORMATS) {
	describe(`OPTIONAL DP-8 claim coordination initialization over ticket refs (${format})`, () => {
		test(
			"ini-07 refuses to create a descriptor over existing ticket refs and preflights descriptor-missing",
			async () => {
				await withCase(
					format,
					"not-empty",
					async (fixture) => {
						const empty = await fixture.decoy("empty-control");
						const control = await fixture.init({ claimsYaml: fixture.block({ endpoint: empty.url }) });
						expectInit("empty control", control, { kind: "created", descriptor: descriptorOf(format) });
						await fixture.setServerBlob(TICKET_REF, `raw ticket ${format}\n`);
						const refs = await fixture.serverRefs();
						const sensitive = await fixture.sensitive();
						// ASSUMPTION(preflight)
						const label = "ticket ref without descriptor (catches: descriptor laid over foreign ticket refs)";
						expect(verdictOf(label, await fixture.init(), sensitive)).toStrictEqual(failure(label, "not-empty"));
						expect(verdictOf("preflight", await fixture.preflight(), sensitive)).toStrictEqual(
							failure("preflight", "descriptor-missing"),
						);
						expect(await fixture.serverRefs()).toEqual(refs);
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);

		test(
			"ini-11 reports a failed ticket-ref probe as unknown and initializes nothing behind it",
			async () => {
				await withCase(
					format,
					"probe-failure",
					async (fixture) => {
						const port = daemonPort(fixture.url);
						// Positive control: an unlimited proxy is transparent, so an init through it creates the descriptor.
						const empty = await fixture.decoy("probe-control");
						const open = await BudgetProxy.create(port, Number.MAX_SAFE_INTEGER);
						const controlBlock = fixture.block({ endpoint: open.route(empty.url) });
						const control = await fixture.init({ claimsYaml: controlBlock }).finally(() => open.close());
						expectInit("transparent proxy control", control, { kind: "created", descriptor: descriptorOf(format) });
						// The pre-open's single ls-remote passes, the probe's connection is cut; a failed
						// probe must end the init as unknown instead of falling through to initializeClaimStorage.
						const refs = await fixture.serverRefs();
						const cut = await BudgetProxy.create(port, 1);
						const routed = cut.route(fixture.url);
						const result = await fixture
							.init({ claimsYaml: fixture.block({ endpoint: routed }) })
							.finally(() => cut.close());
						const sensitive = [...(await fixture.sensitive()), routed];
						const label = "probe connection cut after the pre-open (catches: an init behind a failed DP-8 probe)";
						expect(verdictOf(label, result, sensitive)).toStrictEqual(failure(label, "unknown"));
						// Pre-open and probe only: a fall-through would open a third connection for the descriptor read.
						expect({ connections: cut.acceptedConnections, refs: await fixture.serverRefs() }).toEqual({
							connections: 2,
							refs,
						});
					},
					"none",
				);
			},
			TEST_TIMEOUT,
		);
	});
}
