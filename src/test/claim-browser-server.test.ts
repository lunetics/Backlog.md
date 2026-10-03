/**
 * Level G: the claim endpoint `GET /api/tasks/:id/claim` of an in-process `BacklogServer`, its handler called by cast
 * through ClaimServerHandlers, on a claims-configured project over the loopback Git daemon of claim-git-fixture.ts,
 * blob only (cases srv-g01 to srv-g14). Every case builds its own fixture: a server repository with the sentinel in its
 * name, a Backlog project (prefix BACK, tasks BACK-1 to BACK-3) with a claims block, the storage initialized, the
 * holder's context and its acquire of BACK-1 by OWNER through `runClaimMutation` with the environment of
 * `claimProjectEnv` (injected wall clock T, so the lease end is fixed); then `new BacklogServer(project)`. The server
 * runs unseeded, so `observedAt` is checked against the wall clock window of the call. srv-g11 and srv-g12 go through
 * the real route (`start(0, false)` and fetch on 127.0.0.1): a cast proves neither the route nor what it does with a
 * query. srv-g13 scans body and headers of every answer of its own fixture for the sentinels, with the owner name as
 * the positive control. NOT scanned: `GET /api/config` and `GET /api/status`, which send the endpoint URL and the
 * project root today; this file claims nothing about them. Every test opens with a positive control that the typed
 * scaffold fails behaviourally (its handler answers `claim-error internal` with no-store).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ClaimContext, createClaimContext, loadClaimContext } from "../claims/context/index.ts";
import type { ActiveClaimState, PendingClaimState } from "../claims/rights/index.ts";
import { initializeClaimStorage, type JsonObject, openClaimStore } from "../claims/storage/index.ts";
import { type ClaimMutationInput, runClaimMutation } from "../claims/surface/index.ts";
import { Core } from "../core/backlog.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import { BacklogServer } from "../server/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";
import { initializeFilesystemTestProject, withTimeout } from "./test-utils.ts";

/**
 * ASSUMPTION(scaffold): the contract names the route, not the handler; the handler is `handleGetTaskClaim(taskId)`.
 * Every cast goes through this one type, so a rename changes one line (pattern
 * server-task-project-endpoint.test.ts:9-12, :37). `servicesReadyPromise` is the private field `ensureServicesReady`
 * sets (server/index.ts:256, :277-289).
 */
type ClaimServerHandlers = {
	handleGetTaskClaim(taskId: string): Promise<Response>;
	readonly servicesReadyPromise: Promise<void> | null;
};
type Body = Record<string, unknown>;
type Sentinel = readonly [label: string, value: string];
type ContextHandle = { context: ClaimContext; directory: string };
/** The claims block keys a case varies; everything else is fixed in claimsBlock. */
type BlockOptions = { endpoint: string; enabled: boolean; attempts: number; timeoutMs: number };
/** One endpoint answer as the test read it, with the wall clock window and the duration of the call. */
type Answer = {
	label: string;
	status: number;
	/** The three NO_STORE_HEADERS names and what the answer carries for each; null when absent. */
	cache: Record<string, string | null>;
	/** Every response header as `name: value`, for the scan of srv-g13. */
	headers: string[];
	text: string;
	body: unknown;
	from: number;
	to: number;
	elapsedMs: number;
};
/** What a case pins of an answer: the status, the no-store headers (every answer) and the masked body. */
type AnswerView = { status: number; cache: Record<string, string | null>; body: unknown };
type ErrorCode = "invalid-ticket" | "not-configured" | "config-invalid" | "unreachable";

/** One fixture per case with one Git fixture server per file (claim-surface-git.test.ts:29). */
const TEST_TIMEOUT = 30_000;
/** srv-g13 runs fourteen answers, one of them through a stalled endpoint (claim-mcp-git.test.ts:90). */
const SCAN_TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms of every block, far below the 10 s start value so that a hang shows (g07 uses 3 000). */
const ADAPTER_TIMEOUT = 3_000;
/**
 * srv-g07: one stalled network command ends the preflight (storage/index.ts:348, :364, :555 with config/index.ts:574,
 * :603-604), each command capped at attempt_timeout_ms (storage/index.ts:248-255); the read budget never starts
 * (surface/index.ts:2975-2976). A second stalled command would need at least one more attempt timeout.
 */
const STALL_BOUND_MS = 2 * ADAPTER_TIMEOUT;
/** Bound for one endpoint answer, far above STALL_BOUND_MS, so a hang fails with its label. */
const CALL_TIMEOUT = 20_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** In every case, project, context parent, repository, endpoint and config comment; no answer may contain it. */
const SENTINEL = "SENTINEL-browser-srv-3a7c";
/** A comment line INSIDE the claims block; the endpoint must never echo the configuration. */
const CONFIG_COMMENT = `${SENTINEL}-config-comment`;
/** Display name of the holder: the positive control, it MUST reach the list body. */
const OWNER = "agent-ownermark-browser-9e1d";
/** srv-g14: the receiving side of the PENDING transfer. */
const TARGET_OWNER = "agent-ownermark-target-9e1d";
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
const TASK_IDS: readonly string[] = [TICKET, SECOND, THIRD];
const DRAFT = "DRAFT-1";
/** Not a task ID at all (isValidTaskId, utils/task-id.ts:91-94), and no draft ID either. */
const INVALID = "nope!";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock of the acquire. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Lease end of the acquire at T. */
const L = T + TTL;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock of the acquire; it never moves. */
const MONO_START = 5_000;
/** `op-<uuid v4>`: the one operation ID the acquire seam hands out. */
const ACQUIRE_ID = "op-7120b0a1-5eed-4000-8000-000000000001";
/** Stands for an `observedAt` inside the wall clock window of the call (surface/index.ts:3004, claim-env.ts:64). */
const WITHIN_CALL = "<observedAt within the call>";
/** body of an answer whose text is no JSON. */
const UNPARSABLE = "(no JSON body)";
/** The draft refusal, word for word. */
const DRAFT_ERROR = "Drafts have no claim.";
/** server/index.ts:194-198, written out so the constant under test is not its own oracle. */
const NO_STORE: Readonly<Record<string, string>> = {
	"Cache-Control": "no-store, max-age=0, must-revalidate",
	Pragma: "no-cache",
	Expires: "0",
};
/** surface/index.ts:2930: an ACTIVE entry without a context, with the store's epoch; never `rights`. */
const ACTIVE_KEYS: readonly string[] = ["claimGeneration", "epoch", "owner", "state", "ticket", "timing"];
/**
 * The closed tables for the codes this file meets, written out: status from CLAIM_ERROR_CODES (surface/index.ts:189,
 * :199, :200, :209) and message from MESSAGES (:244, :254, :255, :264).
 */
const ERRORS: Record<ErrorCode, { status: string; message: string }> = {
	"invalid-ticket": { status: "refused", message: "the ticket ID is not a valid task ID" },
	"not-configured": { status: "refused", message: "claims are not configured for this project" },
	"config-invalid": {
		status: "refused",
		message: "the claims configuration is invalid; see problems for the affected keys",
	},
	unreachable: { status: "unavailable", message: "the claim coordination endpoint could not be reached" },
};
/** srv-g05: `attempts: 0` (config/index.ts:208, :296, :261; the view drops `message`, surface/index.ts:1450-1457). */
const ATTEMPTS_PROBLEMS: readonly Body[] = [{ key: "claims.attempts", problem: "out-of-range" }];
/** srv-g14: two valid bindings (rights/index.ts:140-144) that belong to no context; no answer may echo them. */
const SOURCE_BINDING = `tb1-${"a".repeat(64)}`;
const TARGET_BINDING = `tb1-${"b".repeat(64)}`;
/** Plus the extra values of srv-g13: the classes the collected set must hold before an empty scan counts. */
const SENTINEL_CLASSES: readonly string[] = [
	"binding",
	"case root",
	"config comment",
	"context parent",
	"context path",
	"context secret",
	"endpoint",
	"fixture git root",
	"garbage object",
	"operation id",
	"project",
	"receipt intentDigest",
	"receipt parameterDigest",
	"sentinel",
	"stalled endpoint",
	"unreachable endpoint",
];

/** The acquire's seams (claim-mcp-git.test.ts:402-413): the wall clock T fixes the lease end L; nothing sleeps. */
const ACQUIRE_SEAMS: ClaimEnvSeams = {
	clock: () => T,
	monotonicNow: () => MONO_START,
	random: () => 0.5,
	sleep: () => Promise.resolve(),
	newOperationId: () => ACQUIRE_ID,
};

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-mcp-git.test.ts:190-193
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-cli.test.ts:252-255
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface-git.test.ts:104-107
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli.test.ts:339-341
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:110-112
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-cli.test.ts:258-260
function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-time-path-git.test.ts:411-413
function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// adapted from claim-mcp-git.test.ts:239-244
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await gitServer().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

// adapted from claim-mcp-git.test.ts:246-257 (no dependencies)
function taskOf(id: string): Task {
	return {
		id,
		title: `Claim target ${id}`,
		status: "To Do",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-29",
		rawContent: "",
	};
}

/** Configuration keys plus the three surface keys, all explicit, and the sentinel comment. */
// adapted from claim-mcp-git.test.ts:261-277
function claimsBlock(options: BlockOptions): string {
	return [
		"claims:",
		`  # ${CONFIG_COMMENT}`,
		`  enabled: ${options.enabled}`,
		`  endpoint: ${JSON.stringify(options.endpoint)}`,
		"  storage_format: blob",
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${options.timeoutMs}`,
		`  attempts: ${options.attempts}`,
		`  operation_budget_ms: ${BUDGET_MS}`,
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

/** A Backlog project with task prefix BACK, the task files, the claims block and one committed repository. */
// adapted from claim-mcp-git.test.ts:281-293
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim browser");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const id of TASK_IDS) await core.filesystem.saveTask(taskOf(id));
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** Writes or removes the claims block through a fresh file system, never through the server under test. */
// adapted from claim-mcp-git.test.ts:472-478
async function saveBlock(project: string, claimsYaml: string | undefined): Promise<void> {
	const filesystem = new Core(project).filesystem;
	const config = await filesystem.loadConfig();
	if (!config) throw new Error("fixture: the project configuration is missing");
	await filesystem.saveConfig({ ...config, claimsYaml });
}

/** The holder's context and its acquire of TICKET through the CLI's core and environment. */
// adapted from claim-mcp-git.test.ts:462-468 (context), :640-650 and :686-687 (the CLI side of a step)
async function acquire(project: string, parent: string): Promise<ContextHandle> {
	const created = await createClaimContext({ parent });
	if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
	const holder = { context: created.context, directory: dirname(created.context.journalDirectory) };
	const env = await claimProjectEnv(project, "acquire", ACQUIRE_SEAMS);
	if (isClaimDocument(env)) throw new Error(`fixture: no acquire environment (${env.kind})`);
	const input: ClaimMutationInput = { command: "acquire", ticket: TICKET, context: holder.directory, owner: OWNER };
	const acquired = await runClaimMutation(input, env);
	if (acquired.kind !== "claim-operation" || acquired.status !== "applied") {
		throw new Error(`fixture: the acquire did not apply (${acquired.kind}, ${acquired.status})`);
	}
	return holder;
}

/** A git:// endpoint on a loopback port; the path carries the sentinel (the endpoint URL). */
function loopbackEndpoint(port: number, name: string): string {
	return `git://127.0.0.1:${port}/${SENTINEL}-${name}.git`;
}

function cacheOf(headers: Headers): Record<string, string | null> {
	return Object.fromEntries(Object.keys(NO_STORE).map((name) => [name, headers.get(name)]));
}

/** Every header as `name: value`, sorted; Bun's `Headers.toJSON` (bun-types 1.3.14 fetch.d.ts:45) keeps no order. */
function headerLines(headers: Headers): string[] {
	const entries = Object.entries(headers.toJSON());
	return entries.map(([name, value]) => `${name}: ${String(value)}`).sort(byCodeUnits);
}

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return UNPARSABLE;
	}
}

/** The body with an `observedAt` inside the call's wall clock window replaced by WITHIN_CALL; else unchanged. */
function masked(answer: Answer): unknown {
	const { body } = answer;
	if (!isRecord(body)) return body;
	const { observedAt } = body;
	if (typeof observedAt !== "number" || observedAt < answer.from || observedAt > answer.to) return body;
	return { ...body, observedAt: WITHIN_CALL };
}

function viewOf(answer: Answer): AnswerView {
	return { status: answer.status, cache: answer.cache, body: masked(answer) };
}

/** The sorted keys of the first list entry; [] when the body has none. */
function entryKeys(answer: Answer): string[] {
	const claims = field(answer.body, "claims");
	const first: unknown = Array.isArray(claims) ? claims[0] : undefined;
	return isRecord(first) ? Object.keys(first).sort(byCodeUnits) : [];
}

/** A duration against [min, max); a value outside names itself, so the diff shows the measurement. */
function within(ms: number, min: number, max: number): string {
	return ms >= min && ms < max ? inside(min, max) : `${Math.round(ms)} ms, outside [${min}, ${max}) ms`;
}

function inside(min: number, max: number): string {
	return `within [${min}, ${max}) ms`;
}

/** `<label>: <status> <kind> <status or code>`; the draft refusal has no kind and shows its keys. */
function shapeOf(answer: Answer): string {
	const kind = field(answer.body, "kind");
	if (kind === undefined) {
		const keys = isRecord(answer.body) ? Object.keys(answer.body).join(",") : String(answer.body);
		return `${answer.label}: ${answer.status} ${keys}`;
	}
	const detail = kind === "claim-error" ? field(answer.body, "code") : field(answer.body, "status");
	return `${answer.label}: ${answer.status} ${String(kind)} ${String(detail)}`;
}

/** Every sentinel in the body or a header of the given answers as `<label> in <answer>`, sorted. */
function leaksIn(answers: readonly Answer[], sentinels: readonly Sentinel[]): string[] {
	const found = new Set<string>();
	for (const answer of answers) {
		const scanned = [answer.text, ...answer.headers].join("\n");
		for (const label of echoedIn(scanned, sentinels)) found.add(`${label} in ${answer.label}`);
	}
	return [...found].sort(byCodeUnits);
}

// ---------------------------------------------------------------------------------------------------------------
// Expected answers (through the endpoint unchanged; shapes as claim-mcp-git.test.ts:968-1027).
// ---------------------------------------------------------------------------------------------------------------

/** surface/index.ts:3023-3031; `observedAt` is the server's own clock, pinned to the call's window. */
function listBody(claims: Body[], complete = true): Body {
	const status = complete ? "ok" : "unknown";
	return { schemaVersion: 1, kind: "claim-list", status, command: "list", complete, observedAt: WITHIN_CALL, claims };
}

/** The holder's ACTIVE entry without a context (surface/index.ts:2930): no `rights`. */
function activeEntry(): Body {
	const timing = { mode: "lease", leaseEnd: L, hardEnd: null, graceMs: GRACE };
	return { ticket: TICKET, state: "active", owner: OWNER, claimGeneration: 1, epoch: 1, timing };
}

/** surface/index.ts:1389-1399 with the literal status and message of ERRORS; `command` is always `list`. */
function errorBody(code: ErrorCode, ticket: string | null, extra: Body = {}): Body {
	const { status, message } = ERRORS[code];
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status,
		command: "list",
		code,
		message,
		ticket,
		operationId: null,
		...extra,
	};
}

/** Every document answers 200 with no-store; the document's status carries the semantics. */
function ok(body: Body): AnswerView {
	return { status: 200, cache: { ...NO_STORE }, body };
}

/** A draft is refused before the core, as 404 with no-store. */
function draftRefused(): AnswerView {
	return { status: 404, cache: { ...NO_STORE }, body: { error: DRAFT_ERROR } };
}

/** srv-g14: one complete ACTIVE side in hard mode (rights/index.ts:168-185). */
// adapted from claim-time-path-git.test.ts:459-469
function hardSide(claimGeneration: number, owner: string, binding: string, hardEnd: number): ActiveClaimState {
	const timing = { mode: "hard" as const, hardEnd, graceMs: GRACE };
	return { claimState: 1, status: "active", claimGeneration, bindingGeneration: 1, owner, binding, timing };
}

// ---------------------------------------------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------------------------------------------

/** One case: server repository, project with block and tasks, storage, the holder's acquire and the server. */
class BrowserCase {
	/** Every answer of this case in call order, for the scan of srv-g13. */
	readonly answers: Answer[] = [];
	private readonly extra: Sentinel[] = [];
	private options: BlockOptions;
	private started = false;

	private constructor(
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		readonly parent: string,
		readonly holder: ContextHandle,
		private readonly backlog: BacklogServer,
		options: BlockOptions,
	) {
		this.options = options;
	}

	// adapted from claim-mcp-git.test.ts:438-459 (Side.create) and claim-surface-git.test.ts:232-254
	static async create(caseId: string): Promise<BrowserCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-browser-server-${SENTINEL}-`));
		try {
			const repository = await gitServer().initRepository(root, `${caseId}-${SENTINEL}`);
			const url = gitServer().url(repository.name);
			const options: BlockOptions = { endpoint: url, enabled: true, attempts: 3, timeoutMs: ADAPTER_TIMEOUT };
			const project = join(root, `project-${SENTINEL}`);
			await initProject(project, claimsBlock(options));
			const parent = join(root, `contexts-${SENTINEL}`);
			await mkdir(parent);
			await chmod(parent, 0o700);
			const initializer = await initClient(join(root, "client-initializer"));
			const initialized = await initializeClaimStorage({
				repository: initializer,
				remote: url,
				format: "blob",
				timeoutMs: ADAPTER_TIMEOUT,
			});
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			const holder = await acquire(project, parent);
			// The server is built once the claim exists, as a running `backlog browser` would be.
			const backlog = new BacklogServer(project);
			return new BrowserCase(root, url, repository.repo, project, parent, holder, backlog, options);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** The handler in process by cast (pattern server-task-detail-dependency-graph.test.ts:12-15, :41). */
	async claim(label: string, taskId: string): Promise<Answer> {
		return this.answer(label, () => this.handlers().handleGetTaskClaim(taskId));
	}

	/** The real route: `start(0, false)` once, then fetch (server-drafts-endpoint.test.ts:16, :45-48). */
	async route(label: string, path: string): Promise<Answer> {
		if (!this.started) {
			await this.backlog.start(0, false);
			this.started = true;
		}
		const port = this.backlog.getPort();
		if (port === null) throw new Error("fixture: the Backlog server has no port");
		return this.answer(label, () => fetch(`http://127.0.0.1:${port}${path}`));
	}

	/** Whether anything started the content store (the claim answer never waits for it). */
	contentStore(): string {
		const handlers = this.handlers();
		if (!("servicesReadyPromise" in handlers)) return "unobservable: servicesReadyPromise is gone";
		return handlers.servicesReadyPromise === null ? "not started" : "started";
	}

	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		this.options = { ...this.options, ...changes };
		await saveBlock(this.project, claimsBlock(this.options));
	}

	async removeBlock(): Promise<void> {
		await saveBlock(this.project, undefined);
	}

	/** An object that is no claim document under a canonical ticket ref, written into the bare repository directly. */
	// adapted from claim-mcp-git.test.ts:500-505
	async writeGarbage(ticket: string): Promise<string> {
		const written = await gitServer().git(this.serverRepo, ["hash-object", "-w", "--stdin"], `x ${SENTINEL}\n`);
		const oid = written.out.trim();
		await gitServer().git(this.serverRepo, ["update-ref", `refs/claims/${ticket}`, oid]);
		return oid;
	}

	/** Writes a claim state as an independent writer: revision 1 on an absent ticket. */
	// adapted from claim-time-path-git.test.ts:1382-1395 (writeChange, writeState) and claim-cli.test.ts:1156
	async writeState(ticket: string, state: PendingClaimState): Promise<void> {
		const writer = await initClient(join(this.root, "client-writer"));
		const storage = { repository: writer, remote: this.url, format: "blob" as const, timeoutMs: ADAPTER_TIMEOUT };
		const opened = await openClaimStore(storage);
		if (opened.kind !== "open") throw new Error(`fixture: the writer could not open the store (${opened.kind})`);
		const base = await opened.store.read(ticket);
		if (base.kind !== "absent") throw new Error(`fixture: ${ticket} is not absent (${base.kind})`);
		const operationId = "writer-op-1";
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		const written = await opened.store.write(base, { operationId, receipt, payload: json(state) });
		if (written.kind !== "applied") throw new Error(`fixture: the writer's change did not apply (${written.kind})`);
	}

	noteSentinel(label: string, value: string): void {
		this.extra.push([label, value]);
	}

	/**
	 * The context path and its parent, the binding through loadClaimContext, receipt and digest of the
	 * acquire's journal record (the stored receipt is `{intentDigest: digest, parameterDigest}`,
	 * resolution/index.ts:72), the project root, the fixture Git root, the endpoint URL and the config comment; plus the
	 * case root, the context secret, the operation ID and the values srv-g13 noted.
	 */
	// adapted from claim-mcp-git.test.ts:523-548
	async sentinels(): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["project", this.project],
			["fixture git root", gitServer().root],
			["endpoint", this.url],
			["context parent", this.parent],
			["context path", this.holder.directory],
			["config comment", CONFIG_COMMENT],
			...this.extra,
		];
		const text = (label: string, value: unknown) => {
			if (typeof value === "string" && value.length > 0) found.push([label, value]);
		};
		const loaded = await loadClaimContext({ directory: this.holder.directory });
		text("binding", loaded.kind === "loaded" ? loaded.context.binding : undefined);
		const contextFile: unknown = JSON.parse(await readFile(join(this.holder.directory, "context.json"), "utf8"));
		text("context secret", field(contextFile, "secret"));
		const { journalDirectory } = this.holder.context;
		const names = await readdir(journalDirectory);
		for (const name of names.filter((entry) => !entry.startsWith(".") && entry.endsWith(".json"))) {
			const record: unknown = JSON.parse(await readFile(join(journalDirectory, name), "utf8"));
			text("operation id", field(field(record, "intent"), "operationId"));
			text("receipt intentDigest", field(record, "digest"));
			text("receipt parameterDigest", field(record, "parameterDigest"));
		}
		return found;
	}

	async dispose(): Promise<void> {
		try {
			await this.backlog.stop();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}

	private handlers(): ClaimServerHandlers {
		return this.backlog as unknown as ClaimServerHandlers;
	}

	private async answer(label: string, call: () => Promise<Response>): Promise<Answer> {
		const from = Date.now();
		const started = performance.now();
		const response = await withTimeout(call(), label, CALL_TIMEOUT);
		const text = await response.text();
		const elapsedMs = performance.now() - started;
		const answer: Answer = {
			label,
			status: response.status,
			cache: cacheOf(response.headers),
			headers: headerLines(response.headers),
			text,
			body: parsed(text),
			from,
			to: Date.now(),
			elapsedMs,
		};
		this.answers.push(answer);
		return answer;
	}
}

/** Runs `body`, then always cleans up (server stopped, directories removed); a body failure wins over a cleanup one. */
// adapted from claim-surface-git.test.ts:406-418, with the cleanup in `finally`
async function withCase(caseId: string, body: (fixture: BrowserCase) => Promise<void>): Promise<void> {
	const fixture = await BrowserCase.create(caseId);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	} finally {
		await fixture.dispose().catch((error: unknown) => {
			failure ??= error;
		});
	}
	if (failure !== undefined) throw failure;
}

// ---------------------------------------------------------------------------------------------------------------
// The cases. Each opens with the holder's ACTIVE answer: the scaffold's `claim-error internal` fails it.
// ---------------------------------------------------------------------------------------------------------------

describe("claim endpoint of the browser server over real Git (blob)", () => {
	test(
		"srv-g01: an active claim answers 200 with the unchanged CLI list document, the owner and no rights",
		async () => {
			await withCase("srv-g01", async (c) => {
				const active = await c.claim("srv-g01 active", TICKET);
				// Positive control (catches: a handler without the core, a status other than 200, a reshaped or cached
				// document, missing no-store headers, a context and its rights in the answer).
				expect({ answer: viewOf(active), entry: entryKeys(active) }).toEqual({
					answer: ok(listBody([activeEntry()])),
					entry: [...ACTIVE_KEYS],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g02: a ticket without a claim ref answers the free entry",
		async () => {
			await withCase("srv-g02", async (c) => {
				const active = await c.claim("srv-g02 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				const free = await c.claim("srv-g02 ticket without a ref", SECOND);
				// catches: the route's ticket not handed to runClaimList (a list of every claim would show BACK-1).
				expect(viewOf(free)).toEqual(ok(listBody([{ ticket: SECOND, state: "free" }])));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g03: a corrupt state blob answers an unknown entry, complete false and status unknown",
		async () => {
			await withCase("srv-g03", async (c) => {
				const active = await c.claim("srv-g03 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				// lst-01 of claim-cli.test.ts:1983-2008: a canonical ticket ref whose object is no claim document.
				await c.writeGarbage(THIRD);
				const unknown = await c.claim("srv-g03 unreadable ticket", THIRD);
				// catches: a partial answer reshaped into free, ok or an HTTP error (unknown is not free).
				expect(viewOf(unknown)).toEqual(ok(listBody([{ ticket: THIRD, state: "unknown" }], false)));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g04: a project without a claims block answers not-configured fast, without the content store",
		async () => {
			await withCase("srv-g04", async (c) => {
				const active = await c.claim("srv-g04 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				await c.removeBlock();
				const unconfigured = await c.claim("srv-g04 without a claims block", TICKET);
				expect({
					answer: viewOf(unconfigured),
					// catches: an answer that waits for anything but the configuration read; no endpoint exists here.
					elapsed: within(unconfigured.elapsedMs, 0, ADAPTER_TIMEOUT),
					// catches: a handler that awaits ensureServicesReady like handleGetTask (server/index.ts:1071).
					contentStore: c.contentStore(),
				}).toEqual({
					answer: ok(errorBody("not-configured", TICKET)),
					elapsed: inside(0, ADAPTER_TIMEOUT),
					contentStore: "not started",
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g05: an invalid claims block answers config-invalid with its problems",
		async () => {
			await withCase("srv-g05", async (c) => {
				const active = await c.claim("srv-g05 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				await c.writeBlock({ attempts: 0 });
				const invalid = await c.claim("srv-g05 attempts 0", TICKET);
				// catches: problems dropped, or the refusal turned into an HTTP error.
				expect(viewOf(invalid)).toEqual(ok(errorBody("config-invalid", TICKET, { problems: [...ATTEMPTS_PROBLEMS] })));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g06: an endpoint on an unused loopback port answers unavailable unreachable",
		async () => {
			await withCase("srv-g06", async (c) => {
				const active = await c.claim("srv-g06 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				await c.writeBlock({ endpoint: loopbackEndpoint(await unusedLoopbackPort(), "refused") });
				const unreachable = await c.claim("srv-g06 refused endpoint", TICKET);
				// catches: unavailable turned into an HTTP error, an empty list or a cached earlier answer.
				expect(viewOf(unreachable)).toEqual(ok(errorBody("unreachable", TICKET)));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g07: a stalled endpoint answers unavailable once one attempt timeout has passed, within the derived bound",
		async () => {
			await withCase("srv-g07", async (c) => {
				const active = await c.claim("srv-g07 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				const stall = await StallProxy.create();
				try {
					await c.writeBlock({ endpoint: loopbackEndpoint(stall.port, "stall"), timeoutMs: ADAPTER_TIMEOUT });
					const stalled = await c.claim("srv-g07 stalled endpoint", TICKET);
					expect({
						answer: viewOf(stalled),
						// catches: a stall that never reached the endpoint; a retry or a second run of the list.
						connections: stall.acceptedConnections,
						// catches: a server-side timeout below the core's (lower bound), a retry or a second stalled
						// command (upper bound); STALL_BOUND_MS is derived above, never tuned to a measurement.
						elapsed: within(stalled.elapsedMs, ADAPTER_TIMEOUT, STALL_BOUND_MS),
					}).toEqual({
						answer: ok(errorBody("unreachable", TICKET)),
						connections: 1,
						elapsed: inside(ADAPTER_TIMEOUT, STALL_BOUND_MS),
					});
				} finally {
					await stall.close();
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g08: under enabled false the list still answers ok",
		async () => {
			await withCase("srv-g08", async (c) => {
				const active = await c.claim("srv-g08 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				await c.writeBlock({ enabled: false });
				const disabled = await c.claim("srv-g08 enabled false", TICKET);
				// catches: a handler-own enabled gate; observe is allowed while disabled (config/index.ts:553-555).
				expect(viewOf(disabled)).toEqual(ok(listBody([activeEntry()])));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g09: a claims block written after new BacklogServer and after a first answer is read on the next call",
		async () => {
			await withCase("srv-g09", async (c) => {
				// The case built the server while the block existed; the block goes, then another writer puts it back.
				await c.removeBlock();
				const before = await c.claim("srv-g09 without a block", TICKET);
				await c.writeBlock({});
				const after = await c.claim("srv-g09 block written again", TICKET);
				// Positive control (catches: a handler without the core; a configuration read once at construction,
				// which answers `before` as active; one cached by the first call, which answers `after` as not-configured).
				expect({ before: viewOf(before), after: viewOf(after) }).toEqual({
					before: ok(errorBody("not-configured", TICKET)),
					after: ok(listBody([activeEntry()])),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g10: a draft answers 404 without any core call; an invalid id answers the core's invalid-ticket",
		async () => {
			await withCase("srv-g10", async (c) => {
				const active = await c.claim("srv-g10 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				// The observable of "no core call": with a StallProxy as endpoint, every preflight connects to it
				// (storage/index.ts:348) before any verdict; `canonicalTaskId` keeps DRAFT-1 a valid ticket
				// (utils/task-id.ts:38-47), so the core would reach the preflight with it.
				const stall = await StallProxy.create();
				try {
					await c.writeBlock({ endpoint: loopbackEndpoint(stall.port, "stall") });
					const upper = await c.claim("srv-g10 DRAFT-1", DRAFT);
					const lower = await c.claim("srv-g10 draft-1", "draft-1");
					// The core refuses before its settings and preflight (surface/index.ts:2952-2954).
					const invalid = await c.claim("srv-g10 invalid id", INVALID);
					const quiet = stall.acceptedConnections;
					// catches: a counter that could never move: a real ticket through the same block reaches the proxy.
					const control = await c.claim("srv-g10 real ticket through the stall", TICKET);
					expect({
						upper: viewOf(upper),
						lower: viewOf(lower),
						invalid: viewOf(invalid),
						quiet,
						control: viewOf(control),
						total: stall.acceptedConnections,
					}).toEqual({
						// catches: a draft read as a claim key (a free or unreachable document) or answered without no-store;
						// a draft test by exact prefix instead of isDraftId (server/index.ts:49-51).
						upper: draftRefused(),
						lower: draftRefused(),
						// catches: an own ID check in the handler answering 400 or 404 instead of the core's document.
						invalid: ok(errorBody("invalid-ticket", null)),
						// catches: a core call for a draft or an invalid id, awaited or not.
						quiet: 0,
						control: ok(errorBody("unreachable", TICKET)),
						total: 1,
					});
				} finally {
					await stall.close();
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g11: the real route ignores ?context=, so the answer equals srv-g01 without rights",
		async () => {
			await withCase("srv-g11", async (c) => {
				const plain = await c.route("srv-g11 route", `/api/tasks/${TICKET}/claim`);
				// Positive control (catches: no route, a route without the core).
				expect(viewOf(plain)).toEqual(ok(listBody([activeEntry()])));

				// The holder's own context: handed to runClaimList it would add held rights (surface/index.ts:3008-3019).
				const query = `?context=${encodeURIComponent(c.holder.directory)}`;
				const withContext = await c.route("srv-g11 route with ?context=", `/api/tasks/${TICKET}/claim${query}`);
				// catches: a query parameter handed to the core as `context`.
				expect({ answer: viewOf(withContext), entry: entryKeys(withContext) }).toEqual({
					answer: ok(listBody([activeEntry()])),
					entry: [...ACTIVE_KEYS],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g12: the real route sends the literal no-store headers on the 200 and on the draft 404",
		async () => {
			await withCase("srv-g12", async (c) => {
				const found = await c.route("srv-g12 route 200", `/api/tasks/${TICKET}/claim`);
				const draft = await c.route("srv-g12 route 404", `/api/tasks/${DRAFT}/claim`);
				// Positive control (catches: no route, a route without the core, no draft guard) with the headers pinned
				// literally on both (catches: a route answer without no-store; the `fetch` fallback of
				// server/index.ts:530-539 adds them only to unmatched paths).
				expect({ found: viewOf(found), draft: viewOf(draft) }).toEqual({
					found: {
						status: 200,
						cache: {
							"Cache-Control": "no-store, max-age=0, must-revalidate",
							Pragma: "no-cache",
							Expires: "0",
						},
						body: listBody([activeEntry()]),
					},
					draft: {
						status: 404,
						cache: {
							"Cache-Control": "no-store, max-age=0, must-revalidate",
							Pragma: "no-cache",
							Expires: "0",
						},
						body: { error: DRAFT_ERROR },
					},
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"srv-g13: no endpoint answer carries a path, binding, receipt, digest, root, endpoint or config comment",
		async () => {
			await withCase("srv-g13", async (c) => {
				const active = await c.claim("srv-g13 active", TICKET);
				const owner: Sentinel[] = [["owner", OWNER]];
				// Positive control (catches: a scan that could never see anything): the owner display name MUST reach
				// the body the scan reads.
				expect({ answer: viewOf(active), ownerShown: echoedIn(active.text, owner) }).toEqual({
					answer: ok(listBody([activeEntry()])),
					ownerShown: ["owner"],
				});

				// Every answer class of srv-g01 to srv-g12 on this one fixture, so the scan depends on no other test.
				await c.claim("srv-g13 free", SECOND);
				await c.route("srv-g13 route", `/api/tasks/${TICKET}/claim`);
				const query = `?context=${encodeURIComponent(c.holder.directory)}`;
				await c.route("srv-g13 route with ?context=", `/api/tasks/${TICKET}/claim${query}`);
				await c.route("srv-g13 route draft", `/api/tasks/${DRAFT}/claim`);
				await c.claim("srv-g13 draft", DRAFT);
				await c.claim("srv-g13 invalid id", INVALID);
				c.noteSentinel("garbage object", await c.writeGarbage(THIRD));
				await c.claim("srv-g13 unknown entry", THIRD);
				await c.writeBlock({ enabled: false });
				await c.claim("srv-g13 enabled false", TICKET);
				await c.writeBlock({ enabled: true, attempts: 0 });
				await c.claim("srv-g13 config-invalid", TICKET);
				const refused = loopbackEndpoint(await unusedLoopbackPort(), "refused");
				c.noteSentinel("unreachable endpoint", refused);
				await c.writeBlock({ attempts: 3, endpoint: refused });
				await c.claim("srv-g13 unreachable", TICKET);
				const stall = await StallProxy.create();
				try {
					const stalled = loopbackEndpoint(stall.port, "stall");
					c.noteSentinel("stalled endpoint", stalled);
					await c.writeBlock({ endpoint: stalled });
					await c.claim("srv-g13 stalled endpoint", TICKET);
				} finally {
					await stall.close();
				}
				await c.removeBlock();
				await c.claim("srv-g13 not-configured", TICKET);
				await c.writeBlock({ endpoint: c.url });
				await c.claim("srv-g13 block written again", TICKET);

				// Over body and headers of every answer of this case (/api/config and /api/status are not
				// among them). `scanned` names what was read, so an empty `leaks` cannot come from a scan of nothing.
				const sentinels = await c.sentinels();
				const classes = new Set(sentinels.map(([label]) => label));
				expect({
					scanned: c.answers.map(shapeOf),
					unread: c.answers.filter((answer) => answer.text === "" || answer.headers.length === 0).length,
					leaks: leaksIn(c.answers, sentinels),
					missing: SENTINEL_CLASSES.filter((label) => !classes.has(label)),
				}).toEqual({
					scanned: [
						"srv-g13 active: 200 claim-list ok",
						"srv-g13 free: 200 claim-list ok",
						"srv-g13 route: 200 claim-list ok",
						"srv-g13 route with ?context=: 200 claim-list ok",
						"srv-g13 route draft: 404 error",
						"srv-g13 draft: 404 error",
						"srv-g13 invalid id: 200 claim-error invalid-ticket",
						"srv-g13 unknown entry: 200 claim-list unknown",
						"srv-g13 enabled false: 200 claim-list ok",
						"srv-g13 config-invalid: 200 claim-error config-invalid",
						"srv-g13 unreachable: 200 claim-error unreachable",
						"srv-g13 stalled endpoint: 200 claim-error unreachable",
						"srv-g13 not-configured: 200 claim-error not-configured",
						"srv-g13 block written again: 200 claim-list ok",
					],
					unread: 0,
					leaks: [],
					missing: [],
				});
			});
		},
		SCAN_TEST_TIMEOUT,
	);

	test(
		"srv-g14: a PENDING transfer answers both display names and the hull, never an owner, timing or binding",
		async () => {
			await withCase("srv-g14", async (c) => {
				const active = await c.claim("srv-g14 active", TICKET);
				// Positive control (catches: a handler without the core).
				expect(viewOf(active)).toEqual(ok(listBody([activeEntry()])));

				// Transfer form (rights/index.ts:195-212): hard ends H < generation plus one, target
				// binding generation 1, another binding; the hull is max(H) + grace (rights/index.ts:237-254).
				const sourceEnd = T + TTL;
				const targetEnd = T + 2 * TTL;
				const source = hardSide(1, OWNER, SOURCE_BINDING, sourceEnd);
				const target = hardSide(2, TARGET_OWNER, TARGET_BINDING, targetEnd);
				await c.writeState(SECOND, { claimState: 1, status: "pending", claimGeneration: 2, source, target });
				const pending = await c.claim("srv-g14 pending transfer", SECOND);
				const bindings: Sentinel[] = [
					["source binding", SOURCE_BINDING],
					["target binding", TARGET_BINDING],
				];
				const transition = { from: OWNER, to: TARGET_OWNER };
				const reclaimBoundary = targetEnd + GRACE;
				const entry = { ticket: SECOND, state: "pending", claimGeneration: 2, epoch: 1, transition, reclaimBoundary };
				// catches: a reshaped PENDING entry (surface/index.ts:2919-2925: epoch 1 beside the generation), a
				// spread of the stored state.
				expect({ answer: viewOf(pending), echoed: echoedIn(pending.text, bindings) }).toEqual({
					answer: ok(listBody([entry])),
					echoed: [],
				});
			});
		},
		TEST_TIMEOUT,
	);
});
