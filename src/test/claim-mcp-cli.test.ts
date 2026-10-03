/**
 * Level E: the real `backlog claim … --json` subprocess against the claim tools of an in-process `McpServer` on twin
 * projects over the loopback Git daemon — the same setup once for the CLI (project A) and once for MCP (project B).
 * MCP runs through `registerClaimTools(server)` without seams, so the real clock runs on both sides: operation IDs are
 * fixed, only the clock fields are masked (`observedAt`, the lease ends, the reclaim boundary of `rights`) and only
 * inside the window of the test, and `content[0].text` must equal the CLI stdout byte for byte where a document
 * carries no clock field. Covers the Commander mapping: `integerOption` for `--ttl-ms` against a number `ttlMs`,
 * `?? ""` for a missing `--context` on acquire and resolve, and list without a context. Every test starts with a
 * positive control that the scaffold (every handler answers `claim-error internal`) cannot satisfy; the CLI side is
 * the working reference.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createClaimContext } from "../claims/context/index.ts";
import { type ClaimStorageFormat, initializeClaimStorage } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { McpServer } from "../mcp/server.ts";
import { registerClaimTools } from "../mcp/tools/claims/index.ts";
import type { CallToolResult } from "../mcp/types.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Status = "ok" | "applied" | "refused";
/** One half of a twin: its own server area, project and private context. */
type Side = { label: string; project: string; url: string; directory: string; binding: string; contextId: string };
type CliRun = { exit: number; stdout: string; stderr: string };
/** The facts of one tool result; `testInterface.callTool` skips the SDK result validation. */
type McpRun = { count: number; type: unknown; text: string | null; structured: unknown; isError: unknown };
/** Epoch milliseconds around the steps of one test; a clock field is masked only inside it plus its offset. */
type Window = { from: number; to: number };
type Sentinel = readonly [label: string, value: string];

const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms, far below the 10 s start value so that a hang shows (claim-cli.test.ts:106-107). */
const ADAPTER_TIMEOUT = 3_000;
const FORMAT: ClaimStorageFormat = "blob";
const MINUTE = 60_000;
/** lease_ttl_ms of the block; the explicit TTL differs, so a dropped `--ttl-ms` or `ttlMs` moves the lease end. */
const BLOCK_TTL = 5 * MINUTE;
/** The explicit TTL of every acquire: `--ttl-ms` through integerOption on the CLI, a number over MCP. */
const TTL = 2 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
const OWNER = "agent-owner-mcp";
const TICKET = "BACK-1";
const ACQUIRE_ID = "op-mcp-e01";
const LIST_ID = "op-mcp-e02";
const RESOLVE_ID = "op-mcp-e03";
const REFUSED_ID = "op-mcp-e04";
/** The mask of a clock field that lies inside its window (E stage). */
const CLOCK = "<clock>";
/** The fixed-table message is never compared as a view; the byte checks still cover it. */
const MESSAGE = "<message>";
/** The exit codes of the statuses this file meets. */
const EXIT: Record<Status, number> = { ok: 0, applied: 0, refused: 5 };
/** The held lease of the one ticket as the masked view shows it. */
const LEASE = { mode: "lease", leaseEnd: CLOCK, hardEnd: null, graceMs: GRACE };
const HELD = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "held",
	claimGeneration: 1,
	workRight: { kind: "live", renewalDue: false },
	reclaim: { kind: "not-yet", boundary: CLOCK },
};

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-cli.test.ts:246-249 (server)
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-cli.test.ts:251-255
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-cli.test.ts:262-266
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli.test.ts:273-277
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-cli.test.ts:339-341
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// adapted from claim-cli.test.ts:334-337 (echoedIn)
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-cli.test.ts:316-322 (parseDocument); a missing text is unparsable too
function parseDocument(text: string | null): unknown {
	if (text === null) return { kind: "unparsable" };
	try {
		return JSON.parse(text);
	} catch {
		return { kind: "unparsable" };
	}
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-cli.test.ts:294-297
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-cli.test.ts:299-309 (runCli), without the timing
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// adapted from mcp-server.test.ts:18-21 (getText): the content list stays untyped, its first item is read by shape
function mcpRun(result: CallToolResult): McpRun {
	const items: unknown[] = result.content ?? [];
	const text = field(items[0], "text");
	return {
		count: items.length,
		type: field(items[0], "type") ?? null,
		text: typeof text === "string" ? text : null,
		structured: result.structuredContent ?? null,
		isError: result.isError ?? null,
	};
}

// adapted from claim-cli.test.ts:724-758 (claimsBlock, defaultBlock): the lease block with the three surface keys
function claimsBlock(endpoint: string): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${FORMAT}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${BLOCK_TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

// adapted from claim-cli.test.ts:768-800 (initProject): task prefix BACK, the one ticket, one committed repository
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim MCP CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	const task = {
		id: TICKET,
		title: `Claim target ${TICKET}`,
		status: "To Do",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-29",
		rawContent: "",
	};
	await core.filesystem.saveTask(task);
	// The CLI migrates the configuration before each command; migrating here gives both adapters the same file.
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

// adapted from claim-cli.test.ts:760-766 and :973-978 (initClient, CliCase.initialize): the storage API only
async function initArea(client: string, url: string): Promise<void> {
	await mkdir(client);
	await gitServer().git(client, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(client, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	const options = { repository: client, remote: url, format: FORMAT, timeoutMs: ADAPTER_TIMEOUT };
	expectKind(await initializeClaimStorage(options), "created");
}

/** One half of a twin, set up identically for either adapter. */
async function side(root: string, label: string): Promise<Side> {
	const { name } = await gitServer().initRepository(root, `mcp-e-${label}`);
	const url = gitServer().url(name);
	const project = join(root, `project-${label}`);
	await initProject(project, claimsBlock(url));
	await initArea(join(root, `client-${label}`), url);
	const parent = join(root, `contexts-${label}`);
	await mkdir(parent);
	await chmod(parent, 0o700);
	// adapted from claim-cli.test.ts:1012-1016 (CliCase.context): the context API, never the CLI under test
	const { context } = expectKind(await createClaimContext({ parent }), "created");
	const directory = dirname(context.journalDirectory);
	return { label, project, url, directory, binding: context.binding, contextId: context.contextId };
}

function acquireArgs(target: Side, operationId: string): string[] {
	const options = ["--ttl-ms", String(TTL), "--operation-id", operationId];
	return ["claim", "acquire", TICKET, "--owner", OWNER, "--context", target.directory, ...options];
}

function acquireInput(target: Side, operationId: string): Record<string, unknown> {
	return { ticket: TICKET, owner: OWNER, context: target.directory, ttlMs: TTL, operationId };
}

function listArgs(target: Side): string[] {
	return ["claim", "list", "--ticket", TICKET, "--context", target.directory];
}

/** Twin projects with one in-process MCP server on project B; every output joins the leak scan. */
class Twin {
	private readonly outputs: string[] = [];

	private constructor(
		readonly root: string,
		readonly cliSide: Side,
		readonly mcpSide: Side,
		private readonly mcpServer: McpServer,
	) {}

	/** `shared` puts both adapters on one project: refusals before the network may share a fixture. */
	static async create(shared: boolean): Promise<Twin> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-mcp-cli-"));
		try {
			const [cliSide, mcpSide] = shared
				? await side(root, "shared").then((one) => [one, one] as const)
				: await Promise.all([side(root, "cli"), side(root, "mcp")]);
			// adapted from mcp-server.test.ts:29-44 (bootstrapServer): the constructor and a manual registration, no seams
			const mcpServer = new McpServer(mcpSide.project, "Test instructions");
			registerClaimTools(mcpServer);
			return new Twin(root, cliSide, mcpSide, mcpServer);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** One `--json` call of the CLI in the project of `target`; the working directory alone selects it. */
	async cli(target: Side, args: readonly string[]): Promise<CliRun> {
		const run = await runCli(target.project, [...args, "--json"]);
		this.outputs.push(`${run.stdout}${run.stderr}`);
		return run;
	}

	/** One tool call on project B; its text and its structured document join the leak scan. */
	async mcp(tool: string, args: Record<string, unknown>): Promise<McpRun> {
		const run = mcpRun(await this.mcpServer.testInterface.callTool({ params: { name: tool, arguments: args } }));
		this.outputs.push(`${run.text ?? ""}${JSON.stringify(run.structured)}`);
		return run;
	}

	/** The same acquire on both projects through the reference CLI, so only the step under test differs by adapter. */
	async prepare(operationId: string): Promise<unknown[]> {
		const sides = [this.cliSide, this.mcpSide];
		const runs = await Promise.all(sides.map((target) => this.cli(target, acquireArgs(target, operationId))));
		return runs.map((run) => field(parseDocument(run.stdout), "status") ?? null);
	}

	/** Labels of the paths, bindings, context IDs and endpoints that occur in `texts`. */
	scan(texts: readonly string[]): string[] {
		const sentinels: Sentinel[] = [["case root", this.root]];
		for (const target of new Set([this.cliSide, this.mcpSide])) {
			const { label } = target;
			sentinels.push(
				[`${label} project`, target.project],
				[`${label} context`, target.directory],
				[`${label} binding`, target.binding],
				[`${label} context id`, target.contextId],
				[`${label} endpoint`, target.url],
			);
		}
		return [...new Set(texts.flatMap((text) => echoedIn(text, sentinels)))].sort(byCodeUnits);
	}

	leaks(): string[] {
		return this.scan(this.outputs);
	}

	async dispose(): Promise<void> {
		try {
			await this.mcpServer.stop();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

async function withTwin(shared: boolean, body: (twin: Twin) => Promise<void>): Promise<void> {
	const twin = await Twin.create(shared);
	try {
		await body(twin);
	} finally {
		await twin.dispose();
	}
}

/** A clock value inside `window` shifted by `offset` becomes CLOCK; anything else stays raw, so a diff shows it. */
function clockMark(value: unknown, window: Window, offset: number): unknown {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return value;
	return value >= window.from + offset && value <= window.to + offset ? CLOCK : value;
}

/** A lease end is the acquire's clock plus the explicit TTL (transition/index.ts, `leaseEnd`). */
function maskedTiming(timing: unknown, window: Window): unknown {
	if (!isRecord(timing) || timing.mode !== "lease") return timing;
	return { ...timing, leaseEnd: clockMark(timing.leaseEnd, window, TTL) };
}

/** The reclaim boundary is lease end plus grace (rights/index.ts, `evaluateClaimRight`); kinds, renewalDue stay raw. */
function maskedRights(rights: unknown, window: Window): unknown {
	const reclaim = field(rights, "reclaim");
	if (!isRecord(rights) || !isRecord(reclaim) || !("boundary" in reclaim)) return rights;
	return { ...rights, reclaim: { ...reclaim, boundary: clockMark(reclaim.boundary, window, TTL + GRACE) } };
}

function maskedEntry(entry: unknown, window: Window): unknown {
	if (!isRecord(entry)) return entry;
	const copy: Record<string, unknown> = { ...entry };
	if ("timing" in copy) copy.timing = maskedTiming(copy.timing, window);
	if ("rights" in copy) copy.rights = maskedRights(copy.rights, window);
	return copy;
}

/**
 * E stage: only the clock fields — `observedAt`, the lease ends of `planned.timing` and of list entries, and
 * the reclaim boundary of `rights` — and only inside the window of the test; the key order is kept.
 */
function masked(doc: unknown, window: Window): unknown {
	if (!isRecord(doc)) return doc;
	const copy: Record<string, unknown> = { ...doc };
	if ("observedAt" in copy) copy.observedAt = clockMark(copy.observedAt, window, 0);
	const { planned } = copy;
	if (isRecord(planned) && "timing" in planned) {
		copy.planned = { ...planned, timing: maskedTiming(planned.timing, window) };
	}
	if ("rights" in copy) copy.rights = maskedRights(copy.rights, window);
	if (Array.isArray(copy.claims)) copy.claims = copy.claims.map((entry: unknown) => maskedEntry(entry, window));
	return copy;
}

/** The compared form: the clock fields masked and a non-empty message reduced to a marker. */
function view(doc: unknown, window: Window): unknown {
	const copy = masked(doc, window);
	if (!isRecord(copy) || typeof copy.message !== "string" || copy.message.trim() === "") return copy;
	return { ...copy, message: MESSAGE };
}

/** The text printed again like `formatJson` (json-output.ts) after masking; byte-comparable across the adapters. */
function canonical(text: string | null, window: Window): string {
	return `${JSON.stringify(masked(parseDocument(text), window), null, 2)}\n`;
}

/** True when the text is exactly the formatJson print of its own parse. */
function formatJsonShaped(text: string | null): boolean {
	return text !== null && text === `${JSON.stringify(parseDocument(text), null, 2)}\n`;
}

/** The transport facts of one step: CLI exit and stderr, MCP content shape and isError (no exit code over MCP). */
function transport(cli: CliRun, mcp: McpRun): unknown[] {
	return [cli.exit, cli.stderr, mcp.count, mcp.type, mcp.isError];
}

function transportOf(status: Status): unknown[] {
	return [EXIT[status], "", 1, "text", status === "refused"];
}

/** The leak scan with its positive control: a planted binding must be found (claim-cli.test.ts:1210-1211). */
function leakView(twin: Twin): { planted: string[]; leaks: string[] } {
	return { planted: twin.scan([`planted ${twin.mcpSide.binding}`]), leaks: twin.leaks() };
}

function noLeaks(twin: Twin): { planted: string[]; leaks: string[] } {
	return { planted: [`${twin.mcpSide.label} binding`], leaks: [] };
}

/** The applied acquire with the caller's ID; lease end and reclaim boundary are the masked clock fields. */
function acquiredDocument(operationId: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "applied",
		command: "acquire",
		action: "acquire",
		ticket: TICKET,
		operationId,
		outcome: "applied",
		rejection: null,
		storage: { kind: "applied" },
		sends: 1,
		stoppedBy: null,
		planned: { status: "active", claimGeneration: 1, timing: LEASE, capped: false },
		rights: HELD,
	};
}

/** (list): the one active entry at epoch 1; with a context it carries this context's rights. */
function listDocument(withRights: boolean): Record<string, unknown> {
	const entry = { ticket: TICKET, state: "active", owner: OWNER, claimGeneration: 1, epoch: 1, timing: LEASE };
	return {
		schemaVersion: 1,
		kind: "claim-list",
		status: "ok",
		command: "list",
		complete: true,
		observedAt: CLOCK,
		claims: [withRights ? { ...entry, rights: HELD } : entry],
	};
}

/** (resolve): the stored acquire; the document carries no clock field. */
function resolvedDocument(operationId: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-resolution",
		status: "applied",
		command: "resolve",
		operationId,
		ticket: TICKET,
		action: "acquire",
		outcome: "applied",
		query: { kind: "resolved", resolution: "stored" },
	};
}

/** The handle travels only as an explicit context; resolve and retry errors echo the requested ID. */
function contextRequired(
	command: "acquire" | "resolve",
	ticket: string | null,
	operationId: string | null,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "refused",
		command,
		code: "context-required",
		message: MESSAGE,
		ticket,
		operationId,
	};
}

describe(`claim MCP tools against the claim CLI subprocess (${FORMAT})`, () => {
	test(
		"mcp-e01: acquire with --ttl-ms and --operation-id equals claim_acquire with ttlMs and operationId",
		async () => {
			await withTwin(false, async (twin) => {
				const from = Date.now();
				const cli = await twin.cli(twin.cliSide, acquireArgs(twin.cliSide, ACQUIRE_ID));
				const mcp = await twin.mcp("claim_acquire", acquireInput(twin.mcpSide, ACQUIRE_ID));
				const window = { from, to: Date.now() };
				// Positive control (catches: missing wiring, the stub's internal document, a dropped ttlMs or operationId —
				// the lease end would leave its window, the ID would be generated — and any document other than the CLI's).
				expect({ cli: view(parseDocument(cli.stdout), window), mcp: view(mcp.structured, window) }).toEqual({
					cli: acquiredDocument(ACQUIRE_ID),
					mcp: acquiredDocument(ACQUIRE_ID),
				});
				// catches: undefined fields only the SDK transport would see (toStrictEqual keeps them).
				expect(mcp.structured).toStrictEqual(parseDocument(mcp.text));
				// catches: isError on an applied result, a second content item, a text that is not formatJson of the
				// document or differs from the CLI stdout beyond the masked clock fields (key order included).
				expect({
					transport: transport(cli, mcp),
					shaped: [formatJsonShaped(cli.stdout), formatJsonShaped(mcp.text)],
					text: canonical(mcp.text, window),
				}).toEqual({ transport: transportOf("applied"), shaped: [true, true], text: canonical(cli.stdout, window) });
				// catches: an MCP acquire that never reached the storage the CLI reads on the same project.
				const seen = await twin.cli(twin.mcpSide, listArgs(twin.mcpSide));
				expect(view(parseDocument(seen.stdout), { from, to: Date.now() })).toEqual(listDocument(true));
				// catches: a context path, binding, context ID, project root or endpoint in any output.
				expect(leakView(twin)).toEqual(noLeaks(twin));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-e02: list without a context and with ticket and context equals claim_list",
		async () => {
			await withTwin(false, async (twin) => {
				const from = Date.now();
				const prepared = await twin.prepare(LIST_ID);
				const cliAll = await twin.cli(twin.cliSide, ["claim", "list"]);
				const mcpAll = await twin.mcp("claim_list", {});
				const cliOne = await twin.cli(twin.cliSide, listArgs(twin.cliSide));
				const mcpOne = await twin.mcp("claim_list", { ticket: TICKET, context: twin.mcpSide.directory });
				const window = { from, to: Date.now() };
				// Positive control (catches: missing wiring, the stub's internal document, list handed "" for a missing
				// context — context-required instead of a listing without rights; claim.ts registerList keeps it undefined).
				expect({
					prepared,
					cli: view(parseDocument(cliAll.stdout), window),
					mcp: view(mcpAll.structured, window),
				}).toEqual({ prepared: ["applied", "applied"], cli: listDocument(false), mcp: listDocument(false) });
				// catches: a dropped ticket filter or context (an entry without rights), the rights of another binding.
				expect({ cli: view(parseDocument(cliOne.stdout), window), mcp: view(mcpOne.structured, window) }).toEqual({
					cli: listDocument(true),
					mcp: listDocument(true),
				});
				// catches: undefined fields only the SDK transport would see.
				expect([mcpAll.structured, mcpOne.structured]).toStrictEqual([
					parseDocument(mcpAll.text),
					parseDocument(mcpOne.text),
				]);
				// catches: isError on an ok list, a text that differs from the CLI stdout beyond the masked clock fields.
				expect({
					transport: [transport(cliAll, mcpAll), transport(cliOne, mcpOne)],
					shaped: [cliAll.stdout, mcpAll.text, cliOne.stdout, mcpOne.text].map((text) => formatJsonShaped(text)),
					text: [canonical(mcpAll.text, window), canonical(mcpOne.text, window)],
				}).toEqual({
					transport: [transportOf("ok"), transportOf("ok")],
					shaped: [true, true, true, true],
					text: [canonical(cliAll.stdout, window), canonical(cliOne.stdout, window)],
				});
				// catches: a context path, binding, context ID, project root or endpoint in any output.
				expect(leakView(twin)).toEqual(noLeaks(twin));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-e03: resolve of the fixed operation ID equals claim_resolve byte for byte",
		async () => {
			await withTwin(false, async (twin) => {
				const from = Date.now();
				const prepared = await twin.prepare(RESOLVE_ID);
				const cli = await twin.cli(twin.cliSide, ["claim", "resolve", RESOLVE_ID, "--context", twin.cliSide.directory]);
				const mcp = await twin.mcp("claim_resolve", { operationId: RESOLVE_ID, context: twin.mcpSide.directory });
				const window = { from, to: Date.now() };
				// Positive control (catches: missing wiring, the stub's internal document, an ID or context that does not
				// reach runClaimResolve — operation-not-found or context-required instead of the stored acquire).
				expect({
					prepared,
					cli: view(parseDocument(cli.stdout), window),
					mcp: view(mcp.structured, window),
				}).toEqual({
					prepared: ["applied", "applied"],
					cli: resolvedDocument(RESOLVE_ID),
					mcp: resolvedDocument(RESOLVE_ID),
				});
				// catches: undefined fields only the SDK transport would see.
				expect(mcp.structured).toStrictEqual(parseDocument(mcp.text));
				// catches: isError on an applied resolution, any byte difference to the CLI stdout — a resolution
				// carries no clock field, so nothing is masked here.
				expect({ transport: transport(cli, mcp), text: mcp.text }).toEqual({
					transport: transportOf("applied"),
					text: cli.stdout,
				});
				// catches: a context path, binding, context ID, project root or endpoint in any output.
				expect(leakView(twin)).toEqual(noLeaks(twin));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-e04: a missing context is context-required on acquire and resolve, byte for byte",
		async () => {
			await withTwin(true, async (twin) => {
				const from = Date.now();
				const cliAcquire = await twin.cli(twin.cliSide, ["claim", "acquire", TICKET, "--owner", OWNER]);
				const mcpAcquire = await twin.mcp("claim_acquire", { ticket: TICKET, owner: OWNER });
				const cliResolve = await twin.cli(twin.cliSide, ["claim", "resolve", REFUSED_ID]);
				const mcpResolve = await twin.mcp("claim_resolve", { operationId: REFUSED_ID });
				const window = { from, to: Date.now() };
				// Positive control (catches: missing wiring, the stub's internal document, a derived or default context).
				expect({
					cli: view(parseDocument(cliAcquire.stdout), window),
					mcp: view(mcpAcquire.structured, window),
				}).toEqual({ cli: contextRequired("acquire", TICKET, null), mcp: contextRequired("acquire", TICKET, null) });
				// catches: resolve mapped otherwise than claim.ts registerResolve (`?? ""`), a lost ID in the refusal.
				expect({
					cli: view(parseDocument(cliResolve.stdout), window),
					mcp: view(mcpResolve.structured, window),
				}).toEqual({
					cli: contextRequired("resolve", null, REFUSED_ID),
					mcp: contextRequired("resolve", null, REFUSED_ID),
				});
				// catches: undefined fields only the SDK transport would see.
				expect([mcpAcquire.structured, mcpResolve.structured]).toStrictEqual([
					parseDocument(mcpAcquire.text),
					parseDocument(mcpResolve.text),
				]);
				// catches: isError false on a refusal, an exit code or stderr text on the reference, any byte difference
				// (message included) to the CLI stdout.
				expect({
					transport: [transport(cliAcquire, mcpAcquire), transport(cliResolve, mcpResolve)],
					text: [mcpAcquire.text, mcpResolve.text],
				}).toEqual({
					transport: [transportOf("refused"), transportOf("refused")],
					text: [cliAcquire.stdout, cliResolve.stdout],
				});
				// catches: a context path, binding, context ID, project root or endpoint in any output.
				expect(leakView(twin)).toEqual(noLeaks(twin));
			});
		},
		TEST_TIMEOUT,
	);
});
