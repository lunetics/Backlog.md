/**
 * Level G of the MCP claim tools: the claim tools of an in-process `McpServer`, registered by
 * `registerClaimTools(server, seams)` and called through `testInterface.callTool`, against the CLI side of the same
 * step, `runClaim*` with the environment of `claimProjectEnv(projectRoot, command, seams)`, on TWIN fixtures over the
 * loopback Git daemon of claim-git-fixture.ts, blob only: the same setup once for the CLI (repository A) and once for
 * MCP (repository B), each with its own server repository and S1 receive script, Backlog project with a claims block
 * and contexts, and identical injected seams (wall clock, monotonic clock, random, sleep, operation IDs).
 * `findLocalTicket` and `loadLocalTickets` are never injected: both sides read their project as the CLI does (mcp-g11).
 * Every step pins the CLI document and, for the MCP result, the exact keys, `content[0].text` byte-equal to the CLI's
 * `formatJson`, `structuredContent` and the JSON round trip equal to the CLI document, no undefined key and the
 * `isError` partition. mcp-g13 scans every MCP result of this file for the sentinels. Every test opens with a positive
 * control that the typed scaffold fails behaviourally (its handlers answer `claim-error internal`, its CLI side is
 * already real).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ClaimContext, createClaimContext, loadClaimContext } from "../claims/context/index.ts";
import { initializeClaimStorage } from "../claims/storage/index.ts";
import {
	type ClaimCommand,
	type ClaimDocument,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimExitCode,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import { Core } from "../core/backlog.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import { formatJson } from "../formatters/json-output.ts";
import { McpServer } from "../mcp/server.ts";
import { registerClaimTools } from "../mcp/tools/claims/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer, type ReceivePhase, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Body = Record<string, unknown>;
type Sentinel = readonly [label: string, value: string];
type ContextHandle = { context: ClaimContext; directory: string };
/** One context per twin, created the same way; the MCP arguments carry the MCP twin's path only. */
type Pair = { cli: ContextHandle; mcp: ContextHandle };
type SideName = "cli" | "mcp";
type TwinCount = { cli: number; mcp: number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
/** The claims block keys a case varies; everything else is fixed in claimsBlock. */
type BlockOptions = { endpoint: string; enabled: boolean; attempts: number; timeoutMs: number };
type TaskSpec = { id: string; dependencies: string[] };
type MutationVerb = "acquire" | "renew" | "release" | "reclaim";
/** The options a caller may give a mutating tool in this file; the MCP arguments carry exactly the given ones. */
type MutationOptions = { owner?: string; ttlMs?: number; expectGeneration?: number; operationId?: string };
/** One scenario step on both twins: the CLI document and the raw MCP result. */
type Step = { label: string; cli: ClaimDocument; mcp: unknown };
/** Per step: the CLI document (message masked), its exit, and the MCP result against it. */
type ParityView = {
	label: string;
	exit: number;
	body: Body;
	keys: string[];
	content: unknown;
	structuredContent: unknown;
	roundTrip: unknown;
	undefinedKeys: string[];
	isError: unknown;
};
/** Claim refs of one twin's server repository and the journal records of one of its contexts. */
type SideState = { claims: string[]; journal: string[] };
type LedgerEntry = { label: string; result: unknown };
type OperationFields = {
	status: string;
	command: string;
	action?: string;
	ticket: string;
	operationId: string | null;
	outcome: string;
	rejection?: Body;
	storage?: Body;
	sends: number;
	stoppedBy?: string;
	planned?: Body;
	rights: Body;
};

const TEST_TIMEOUT = 60_000;
/** The lost-reply test waits out LOSS_TIMEOUT once per twin. */
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of healthy twins, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of the lost-reply twin; every scripted hold outlasts it (claim-cli.test.ts:108-109). */
const LOSS_TIMEOUT = 2_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Appears in every case, project, context and endpoint path and in hook stderr; no MCP result may contain it. */
const SENTINEL = "SENTINEL-mcp-git-6c3e";
/** What a rejecting S1 hook writes to stderr (claim-cli.test.ts:813, :831). */
const HOOK_MARKER = `${SENTINEL}-hook-stderr`;
/** Display name of every acquiring context: it may appear in claim-list entries and nowhere else. */
const OWNER = "agent-sentinel-mcp-karl";
/** Display name of a rejected rival acquire: stored nowhere, so no result may echo it. */
const RIVAL = "agent-sentinel-mcp-franz";
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
/** mcp-g11: depends on THIRD, so the strict default gate blocks it while THIRD is open. */
const BLOCKED = "BACK-4";
const TASKS: readonly TaskSpec[] = [
	{ id: TICKET, dependencies: [] },
	{ id: SECOND, dependencies: [] },
	{ id: THIRD, dependencies: [] },
	{ id: BLOCKED, dependencies: [THIRD] },
];
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock of both twins. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Lease end "10:05" of an acquire at T and its reclaim boundary "10:15". */
const L = T + TTL;
const R = L + GRACE;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;
/** Caller-chosen IDs: the documented way to resolve or retry after a lost reply. */
const FIXED_ID = "op-mcp-g01-fixed";
const LOST_ID = "op-mcp-g06-lost";
const REJECTED_ID = "op-mcp-g08-rejected";
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** parsedText of a result without a parsable first text item. */
const UNPARSABLE = "(no JSON text)";
const INSTRUCTIONS = "claim-mcp-git";
/** The whole MCP result; `isError` is always present. */
const RESULT_KEYS: readonly string[] = ["content", "isError", "structuredContent"];
/** The stderr partition of claim-text.ts:23: the statuses whose result carries `isError: true`. */
const ERROR_STATUSES: readonly string[] = ["refused", "unavailable", "internal"];
/** The closed status table, written out so the constant under test is not its own oracle. */
const EXIT: Record<string, number> = {
	ok: 0,
	applied: 0,
	rejected: 2,
	unknown: 3,
	"unknown-history": 4,
	refused: 5,
	unavailable: 6,
	paused: 7,
	internal: 1,
};
/** The sentinel classes the collected set must hold before an empty scan counts. */
const SENTINEL_CLASSES: readonly string[] = [
	"binding",
	"claim root",
	"context parent",
	"context path",
	"digest",
	"endpoint",
	"fixture server root",
	"hook stderr",
	"owner",
	"parameter digest",
	"project",
	"secret",
	"sentinel",
];

let fixtureServer: GitFixtureServer | undefined;
/** Every MCP result of this file, labelled by step, for the scan of mcp-g13. */
const RESULTS: LedgerEntry[] = [];
/** Every sentinel of every twin of this file, collected before its directories are removed. */
const SENTINELS: Sentinel[] = [];

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

// adapted from claim-cli.test.ts:280-282
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-cli.test.ts:285-292
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:110-112
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** Shape `op-<uuid v4>`: the n-th operation ID the seam of one twin hands out. */
function seamId(n: number): string {
	return `op-5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// adapted from claim-surface-git.test.ts:115-120
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

function taskOf(spec: TaskSpec, status: string): Task {
	return {
		id: spec.id,
		title: `Claim target ${spec.id}`,
		status,
		assignee: [],
		labels: [],
		dependencies: spec.dependencies,
		createdDate: "2026-09-26",
		rawContent: "",
	};
}

/** Configuration keys plus the three surface keys, all explicit; lease mode, blob. */
// adapted from claim-cli.test.ts:725-741
function claimsBlock(options: BlockOptions): string {
	return [
		"claims:",
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

/** A Backlog project with task prefix BACK, the TASKS files, the claims block and one committed repository. */
// adapted from claim-cli.test.ts:769-800 (task specs with dependencies, no file map)
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim MCP");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const spec of TASKS) await core.filesystem.saveTask(taskOf(spec, "To Do"));
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-cli.test.ts:812-835 (a reject writes HOOK_MARKER to stderr)
function receiveHook(control: string, phase: ReceivePhase): string {
	const marker = shellQuote(HOOK_MARKER);
	return [
		"#!/bin/sh",
		`dir=${shellQuote(control)}`,
		`phase=${phase}`,
		"n=1",
		'while ! mkdir "$dir/$phase-$n" 2>/dev/null; do n=$((n + 1)); done',
		'cat > "$dir/$phase-$n/stdin"',
		"action=pass",
		'if [ -f "$dir/$phase-action-$n" ]; then action=$(cat "$dir/$phase-action-$n")',
		'elif [ -f "$dir/$phase-action-rest" ]; then action=$(cat "$dir/$phase-action-rest"); fi',
		': > "$dir/$phase-$n/entered"',
		'case "$action" in hold*)',
		`\ti=0; while [ ! -f "$dir/$phase-$n/release" ] && [ "$i" -lt ${HOLD_POLLS} ]; do`,
		"\t\tsleep 0.05; i=$((i + 1))",
		"\tdone ;;",
		"esac",
		': > "$dir/$phase-$n/done"',
		`case "$action" in *reject) echo ${marker} >&2; exit 1 ;; esac`,
		"exit 0",
		"",
	].join("\n");
}

/** S1, test-local: per-invocation logs and scripted actions for both receive hooks of one server repository. */
// adapted from claim-cli.test.ts:839-918 (without `lines`; settle tolerates an invocation that never started)
class ReceiveScript {
	constructor(
		private readonly serverRepo: string,
		private readonly control: string,
	) {}

	async install(): Promise<void> {
		await mkdir(this.control, { recursive: true });
		for (const phase of ["pre", "post"] as const) {
			const hook = join(this.serverRepo, "hooks", `${phase}-receive`);
			await writeFile(hook, receiveHook(this.control, phase));
			await chmod(hook, 0o755);
		}
	}

	async count(phase: ReceivePhase): Promise<number> {
		const pattern = new RegExp(`^${phase}-\\d+$`);
		return (await readdir(this.control)).filter((name) => pattern.test(name)).length;
	}

	/** Number of the next invocation of `phase`. */
	async next(phase: ReceivePhase): Promise<number> {
		return (await this.count(phase)) + 1;
	}

	/** Actions for the next invocations of `phase`, then `rest` for every later one. */
	async plan(phase: ReceivePhase, actions: readonly HookAction[], rest: HookAction = "pass"): Promise<void> {
		const started = await this.count(phase);
		const numbered = new RegExp(`^${phase}-action-\\d+$`);
		for (const name of await readdir(this.control)) {
			if (numbered.test(name)) await rm(join(this.control, name), { force: true });
		}
		for (const [index, action] of actions.entries()) {
			await writeFile(join(this.control, `${phase}-action-${started + index + 1}`), action);
		}
		await writeFile(join(this.control, `${phase}-action-rest`), rest);
	}

	/** Releases invocation `n` of `phase` and waits, bounded, until its hook has finished; false if it never ran. */
	async settle(phase: ReceivePhase, n: number): Promise<boolean> {
		const path = join(this.control, `${phase}-${n}`);
		if (!(await exists(path))) return false;
		await writeFile(join(path, "release"), "");
		const deadline = Date.now() + EVENT_TIMEOUT;
		while (!(await exists(join(path, "done")))) {
			if (Date.now() > deadline) throw new Error(`receive hook ${phase}-${n} did not finish`);
			await Bun.sleep(10);
		}
		return true;
	}

	/** Releases every hold and waits, bounded, until each invocation has finished. */
	async releaseAll(): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.control)).filter((name) => /^(?:pre|post)-\d+$/.test(name));
		} catch {
			return;
		}
		await Promise.all(names.map((name) => writeFile(join(this.control, name, "release"), "").catch(() => undefined)));
		const deadline = Date.now() + EVENT_TIMEOUT;
		for (const name of names) {
			while (!(await exists(join(this.control, name, "done"))) && Date.now() < deadline) await Bun.sleep(10);
		}
	}
}

/**
 * The wall clock, monotonic clock, random, sleep and operation ID seams of one twin (G stage). Both twins
 * own an instance with the same script, so equal steps draw equal values; nothing sleeps.
 */
// adapted from claim-surface-administration.test.ts:286-305 (env seams) with a movable clock and generated IDs
class TwinSeams {
	/** The injected wall clock; tests move both twins together through Twin.setClock. */
	now = T;
	private issued = 0;

	/** Never loadLocalTickets or findLocalTicket: both stay the project readers of claimProjectEnv (mcp-g11). */
	seams(): ClaimEnvSeams {
		return {
			clock: () => this.now,
			monotonicNow: () => MONO_START,
			random: () => 0.5,
			sleep: () => Promise.resolve(),
			newOperationId: () => {
				this.issued += 1;
				return seamId(this.issued);
			},
		};
	}
}

/** One half of a twin: a server repository with the S1 script, a Backlog project with a claims block, contexts. */
class Side {
	readonly seams = new TwinSeams();
	readonly hooks: ReceiveScript;
	/** Private 0700 parent of this side's contexts, with the sentinel in its name. */
	readonly parent: string;
	private readonly handles: ContextHandle[] = [];
	private options: BlockOptions;

	private constructor(
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		root: string,
		options: BlockOptions,
	) {
		this.options = options;
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	// adapted from claim-cli.test.ts:947-965 (CliCase.create) and claim-surface-git.test.ts:232-254
	static async create(caseRoot: string, name: SideName, caseId: string, block: Partial<BlockOptions>): Promise<Side> {
		const root = join(caseRoot, name);
		await mkdir(root);
		const repository = await server().initRepository(root, `${caseId}-${name}`);
		const url = server().url(repository.name);
		const options: BlockOptions = { endpoint: url, enabled: true, attempts: 3, timeoutMs: ADAPTER_TIMEOUT, ...block };
		const project = join(root, `project-${SENTINEL}`);
		await initProject(project, claimsBlock(options));
		const side = new Side(url, repository.repo, project, root, options);
		await side.hooks.install();
		await mkdir(side.parent);
		await chmod(side.parent, 0o700);
		const initializer = await initClient(join(root, "client-initializer"));
		const initialized = await initializeClaimStorage({
			repository: initializer,
			remote: url,
			format: "blob",
			timeoutMs: ADAPTER_TIMEOUT,
		});
		if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
		return side;
	}

	// adapted from claim-surface-git.test.ts:256-260
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		const handle = { context: created.context, directory: dirname(created.context.journalDirectory) };
		this.handles.push(handle);
		return handle;
	}

	/** Rewrites the claims block through saveConfig, never through the server under test (read per call). */
	// adapted from claim-cli.test.ts:996-1004
	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("fixture: the project configuration is missing");
		this.options = { ...this.options, ...changes };
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.options) });
	}

	/** Rewrites one task file with status Done, the terminal status of the default statuses (readiness). */
	async markDone(ticket: string): Promise<void> {
		const spec = TASKS.find((task) => task.id === ticket);
		if (spec === undefined) throw new Error(`fixture: no task ${ticket}`);
		await new Core(this.project).filesystem.saveTask(taskOf(spec, "Done"));
	}

	// adapted from claim-surface-git.test.ts:303-311
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** An object that is no claim document under a canonical ticket ref, written into the bare repository directly. */
	// adapted from claim-cli.test.ts:1975-1984 (lst-01)
	async writeGarbage(ticket: string): Promise<string> {
		const written = await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], `x ${SENTINEL}\n`);
		const oid = written.out.trim();
		await server().git(this.serverRepo, ["update-ref", `refs/claims/${ticket}`, oid]);
		return oid;
	}

	/** Journal records of one context; temporary and slot names are ignored. */
	async records(handle: ContextHandle): Promise<string[]> {
		const names = await readdir(handle.context.journalDirectory);
		return names.filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort(byCodeUnits);
	}

	async state(handle: ContextHandle): Promise<SideState> {
		const refs = Object.keys(await this.serverRefs()).filter((ref) => ref.startsWith("refs/claims/"));
		return { claims: refs.sort(byCodeUnits), journal: await this.records(handle) };
	}

	/**
	 * For this side: project root, endpoint, server repository, context parent, every server root, and per
	 * context the binding from loadClaimContext, ID, path, journal, secret and each record's digests (the receipt).
	 */
	// adapted from claim-surface-git.test.ts:338-358 and claim-cli.test.ts:1070-1086
	async sentinels(): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["project", this.project],
			["endpoint", this.url],
			["server repository", this.serverRepo],
			["context parent", this.parent],
		];
		for (const oid of Object.values(await this.serverRefs())) found.push(["claim root", oid]);
		const text = (label: string, value: unknown) => {
			if (typeof value === "string" && value.length > 0) found.push([label, value]);
		};
		for (const handle of this.handles) {
			const loaded = await loadClaimContext({ directory: handle.directory });
			text("binding", loaded.kind === "loaded" ? loaded.context.binding : handle.context.binding);
			text("context id", handle.context.contextId);
			text("context path", handle.directory);
			text("journal", handle.context.journalDirectory);
			text("secret", field(JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8")), "secret"));
			for (const name of await this.records(handle)) {
				const record: unknown = JSON.parse(await readFile(join(handle.context.journalDirectory, name), "utf8"));
				text("digest", field(record, "digest"));
				text("parameter digest", field(record, "parameterDigest"));
			}
		}
		return found;
	}
}

/** Twin fixtures: one CLI side, one MCP side with the in-process server, stepped in lockstep. */
class Twin {
	private collected = false;
	private readonly extra: Sentinel[] = [];

	private constructor(
		readonly root: string,
		readonly cli: Side,
		readonly mcp: Side,
		private readonly mcpServer: McpServer,
	) {}

	static async create(caseId: string, block: Partial<BlockOptions>): Promise<Twin> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-mcp-git-${SENTINEL}-`));
		try {
			const cli = await Side.create(root, "cli", caseId, block);
			const mcp = await Side.create(root, "mcp", caseId, block);
			// mcp-server.test.ts:29-44: an in-process server with manual registration, here with the MCP twin's seams.
			const mcpServer = new McpServer(mcp.project, INSTRUCTIONS);
			registerClaimTools(mcpServer, mcp.seams.seams());
			return new Twin(root, cli, mcp, mcpServer);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async pair(): Promise<Pair> {
		return { cli: await this.cli.context(), mcp: await this.mcp.context() };
	}

	/** Moves the injected wall clock of both twins together (identical seams on both sides). */
	setClock(now: number): void {
		this.cli.seams.now = now;
		this.mcp.seams.now = now;
	}

	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		await this.cli.writeBlock(changes);
		await this.mcp.writeBlock(changes);
	}

	async markDone(ticket: string): Promise<void> {
		await this.cli.markDone(ticket);
		await this.mcp.markDone(ticket);
	}

	async writeGarbage(ticket: string): Promise<void> {
		this.noteSentinel("garbage object", await this.cli.writeGarbage(ticket));
		this.noteSentinel("garbage object", await this.mcp.writeGarbage(ticket));
	}

	noteSentinel(label: string, value: string): void {
		this.extra.push([label, value]);
	}

	async planHooks(phase: ReceivePhase, actions: readonly HookAction[], rest: HookAction = "pass"): Promise<void> {
		await this.cli.hooks.plan(phase, actions, rest);
		await this.mcp.hooks.plan(phase, actions, rest);
	}

	async nextHooks(phase: ReceivePhase): Promise<TwinCount> {
		return { cli: await this.cli.hooks.next(phase), mcp: await this.mcp.hooks.next(phase) };
	}

	async settleHooks(phase: ReceivePhase, held: TwinCount): Promise<{ cli: boolean; mcp: boolean }> {
		return { cli: await this.cli.hooks.settle(phase, held.cli), mcp: await this.mcp.hooks.settle(phase, held.mcp) };
	}

	/** Pre-receive invocations so far on each twin: one per push attempt that reached the server. */
	async pushes(): Promise<TwinCount> {
		return { cli: await this.cli.hooks.count("pre"), mcp: await this.mcp.hooks.count("pre") };
	}

	async state(pair: Pair): Promise<{ cli: SideState; mcp: SideState }> {
		return { cli: await this.cli.state(pair.cli), mcp: await this.mcp.state(pair.mcp) };
	}

	/**
	 * A mutating step. The CLI input is built as claim.ts:427-436 builds it (hardEnd left out: no case sets it); the MCP
	 * arguments are those a client sends, exactly the given options.
	 */
	async mutate(
		label: string,
		verb: MutationVerb,
		ticket: string,
		pair: Pair,
		options: MutationOptions = {},
	): Promise<Step> {
		const input: ClaimMutationInput = {
			command: verb,
			ticket,
			context: pair.cli.directory,
			owner: options.owner,
			ttlMs: options.ttlMs,
			expectGeneration: options.expectGeneration,
			operationId: options.operationId,
		};
		const args = { ticket, context: pair.mcp.directory, ...options };
		return this.step(label, verb, (env) => runClaimMutation(input, env), `claim_${verb}`, args);
	}

	/** claim.ts:835: `{operationId, context}`. */
	async resolve(label: string, operationId: string, pair: Pair): Promise<Step> {
		const input = { operationId, context: pair.cli.directory };
		const args = { operationId, context: pair.mcp.directory };
		return this.step(label, "resolve", (env) => runClaimResolve(input, env), "claim_resolve", args);
	}

	/** claim.ts:852: `{operationId, context}`. */
	async retry(label: string, operationId: string, pair: Pair): Promise<Step> {
		const input = { operationId, context: pair.cli.directory };
		const args = { operationId, context: pair.mcp.directory };
		return this.step(label, "retry", (env) => runClaimRetry(input, env), "claim_retry", args);
	}

	/** claim.ts:873: `{ticket, context}`, both possibly undefined; the MCP arguments omit what is not given. */
	async list(label: string, options: { ticket?: string; pair?: Pair } = {}): Promise<Step> {
		const input = { ticket: options.ticket, context: options.pair?.cli.directory };
		const args: Record<string, unknown> = {};
		if (options.ticket !== undefined) args.ticket = options.ticket;
		if (options.pair !== undefined) args.context = options.pair.mcp.directory;
		return this.step(label, "list", (env) => runClaimList(input, env), "claim_list", args);
	}

	/** The CLI side as claim.ts:358-394 (`run`, `withProject`) without printing; then the same step over MCP. */
	private async step(
		label: string,
		command: ClaimCommand,
		produce: (env: ClaimSurfaceEnv) => Promise<ClaimDocument>,
		tool: string,
		args: Record<string, unknown>,
	): Promise<Step> {
		let cli: ClaimDocument;
		try {
			const env = await claimProjectEnv(this.cli.project, command, this.cli.seams.seams());
			cli = isClaimDocument(env) ? env : await produce(env);
		} catch {
			cli = claimErrorDocument({ command, code: "internal" });
		}
		let mcp: unknown;
		try {
			mcp = await this.mcpServer.testInterface.callTool({ params: { name: tool, arguments: args } });
		} catch (error) {
			// The tools never throw; a throw is kept as a result, so the parity view shows it.
			mcp = { thrown: error instanceof Error ? error.name : typeof error };
		}
		RESULTS.push({ label, result: mcp });
		return { label, cli, mcp };
	}

	/** Collects this twin's sentinels once, before any directory is removed. */
	async collect(): Promise<void> {
		if (this.collected) return;
		this.collected = true;
		const shared: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["fixture server root", server().root],
			["hook stderr", HOOK_MARKER],
			["owner", OWNER],
			["owner", RIVAL],
		];
		SENTINELS.push(...shared, ...this.extra, ...(await this.cli.sentinels()), ...(await this.mcp.sentinels()));
	}

	async dispose(): Promise<void> {
		try {
			await this.collect();
			await this.cli.hooks.releaseAll();
			await this.mcp.hooks.releaseAll();
			await this.mcpServer.stop();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-surface-git.test.ts:408-418
async function withTwin(
	caseId: string,
	block: Partial<BlockOptions>,
	body: (twin: Twin) => Promise<void>,
): Promise<void> {
	const twin = await Twin.create(caseId, block);
	let failure: unknown;
	try {
		await body(twin);
	} catch (error) {
		failure = error;
	}
	await twin.dispose();
	if (failure !== undefined) throw failure;
}

// ---------------------------------------------------------------------------------------------------------------
// The parity view and the scan for sentinels.
// ---------------------------------------------------------------------------------------------------------------

/** The whole document with a non-empty message replaced by MESSAGE. */
// adapted from claim-surface-git.test.ts:380-385
function masked(document: ClaimDocument): Body {
	const body: Body = Object.fromEntries(Object.entries(document));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return body;
}

function textOf(result: unknown): string | undefined {
	const content = field(result, "content");
	if (!Array.isArray(content)) return undefined;
	const first: unknown = content[0];
	const text = field(first, "text");
	return typeof text === "string" ? text : undefined;
}

function parsedText(text: string | undefined): unknown {
	if (text === undefined) return UNPARSABLE;
	try {
		return JSON.parse(text);
	} catch {
		return UNPARSABLE;
	}
}

/**
 * Paths of keys and items whose value is `undefined`. JSON drops them, so `toEqual` and the round trip cannot see
 * them, and only the transport would (`testInterface.callTool` skips the SDK result validation).
 */
function undefinedKeys(value: unknown, path = "$"): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item: unknown, index: number) =>
			item === undefined ? [`${path}[${index}]`] : undefinedKeys(item, `${path}[${index}]`),
		);
	}
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, item]) =>
		item === undefined ? [`${path}.${key}`] : undefinedKeys(item, `${path}.${key}`),
	);
}

function parityView(step: Step): ParityView {
	return {
		label: step.label,
		exit: claimExitCode(step.cli),
		body: masked(step.cli),
		keys: isRecord(step.mcp) ? Object.keys(step.mcp).sort(byCodeUnits) : [],
		content: field(step.mcp, "content"),
		structuredContent: field(step.mcp, "structuredContent"),
		roundTrip: parsedText(textOf(step.mcp)),
		undefinedKeys: undefinedKeys(step.mcp),
		isError: field(step.mcp, "isError"),
	};
}

/**
 * The result against the CLI document of the same step: `body` pins that document (real on the scaffold); the MCP
 * result is exactly `{content: [{type, text}], isError, structuredContent}` with the CLI's `formatJson` bytes, the
 * CLI document as structure and as parsed text, and `isError` for refused, unavailable and internal only.
 */
function expectedParity(step: Step, body: Body): ParityView {
	const status = String(body.status);
	return {
		label: step.label,
		exit: EXIT[status] ?? -1,
		body,
		keys: [...RESULT_KEYS],
		content: [{ type: "text", text: formatJson(step.cli) }],
		structuredContent: step.cli,
		roundTrip: step.cli,
		undefinedKeys: [],
		isError: ERROR_STATUSES.includes(status),
	};
}

/** Owner names are display data in list entries only; the scan drops them there, and only there. */
// adapted from claim-cli.test.ts:325-332
function withoutOwners(doc: unknown): unknown {
	const claims = field(doc, "claims");
	if (field(doc, "kind") !== "claim-list" || !Array.isArray(claims) || !isRecord(doc)) return doc;
	const stripped = claims.map((item: unknown) =>
		isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "owner")) : item,
	);
	return { ...doc, claims: stripped };
}

function scrubbedItem(item: unknown): unknown {
	const text = field(item, "text");
	if (!isRecord(item) || typeof text !== "string") return item;
	const parsed = parsedText(text);
	return field(parsed, "kind") === "claim-list" ? { ...item, text: formatJson(withoutOwners(parsed)) } : item;
}

/** One MCP result as scanned text: every key of it, owners removed from list documents in text and structure. */
function scrubbed(result: unknown): string {
	if (!isRecord(result)) return String(result);
	const content = Array.isArray(result.content) ? result.content.map(scrubbedItem) : result.content;
	return JSON.stringify({ ...result, content, structuredContent: withoutOwners(result.structuredContent) });
}

/** Every sentinel in every given MCP result as `<label> in <step>`, sorted; the owner counts outside list entries. */
function leaksIn(entries: readonly LedgerEntry[], sentinels: readonly Sentinel[]): string[] {
	const found = new Set<string>();
	for (const entry of entries) {
		for (const label of echoedIn(scrubbed(entry.result), sentinels)) found.add(`${label} in ${entry.label}`);
	}
	return [...found].sort(byCodeUnits);
}

// ---------------------------------------------------------------------------------------------------------------
// Expected documents (shapes as claim-surface-administration.test.ts:407-428 and
// claim-reclaim-git.test.ts:975-1067). Every claim here is generation 1.
// ---------------------------------------------------------------------------------------------------------------

/** PlannedDisplay of an ACTIVE lease without hard end: never capped. */
function leasePlanned(leaseEnd: number): Body {
	return {
		status: "active",
		claimGeneration: 1,
		timing: { mode: "lease", leaseEnd, hardEnd: null, graceMs: GRACE },
		capped: false,
	};
}

/** RightsView: the rights evaluation without observedRoot and reason. */
function rightsOf(ownership: string, workRight: Body, reclaim: Body, claimGeneration: number | null = 1): Body {
	return { kind: "evaluated", scope: "observed-state-only", ownership, claimGeneration, workRight, reclaim };
}

/** The holder at T or shortly after: live, not due (C + eps < leaseEnd), reclaimable only after leaseEnd + grace. */
function heldRights(leaseEnd: number): Body {
	return rightsOf("held", { kind: "live", renewalDue: false }, { kind: "not-yet", boundary: leaseEnd + GRACE });
}

function foreignRights(leaseEnd: number): Body {
	return rightsOf("foreign", { kind: "none", cause: "not-holder" }, { kind: "not-yet", boundary: leaseEnd + GRACE });
}

/** After a release or reclaim: the FREE tombstone keeps the generation (transition/index.ts:465). */
const FREE_PLANNED: Body = { status: "free", claimGeneration: 1, timing: null, capped: false };
const FREE_RIGHTS: Body = rightsOf("free", { kind: "none", cause: "free" }, { kind: "not-applicable" });
/** A ticket without a ref (rights/index.ts:290-300). */
const ABSENT_RIGHTS: Body = rightsOf("absent", { kind: "none", cause: "absent" }, { kind: "not-applicable" }, null);

/** The claim-operation document with every key; absent optional fields are null. */
function operationBody(fields: OperationFields): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: fields.status,
		command: fields.command,
		action: fields.action ?? fields.command,
		ticket: fields.ticket,
		operationId: fields.operationId,
		outcome: fields.outcome,
		rejection: fields.rejection ?? null,
		storage: fields.storage ?? null,
		sends: fields.sends,
		stoppedBy: fields.stoppedBy ?? null,
		planned: fields.planned ?? null,
		rights: fields.rights,
	};
}

function appliedBody(
	command: string,
	ticket: string,
	operationId: string,
	planned: Body,
	rights: Body,
	action = command,
): Body {
	return operationBody({
		status: "applied",
		command,
		action,
		ticket,
		operationId,
		outcome: "applied",
		storage: { kind: "applied" },
		sends: 1,
		planned,
		rights,
	});
}

/** Plan rejections persist nothing: no operation ID, storage or planned display. */
function planRejectedBody(command: string, ticket: string, cause: string, rights: Body, boundary?: number): Body {
	const rejection: Body = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return operationBody({
		status: "rejected",
		command,
		ticket,
		operationId: null,
		outcome: "rejected",
		rejection,
		sends: 0,
		rights,
	});
}

/** An acquire the endpoint's pre-receive hook rejected once (claim-cli.test.ts:1293-1310, cli-03). */
function remoteRejectedBody(ticket: string, operationId: string): Body {
	return operationBody({
		status: "rejected",
		command: "acquire",
		ticket,
		operationId,
		outcome: "rejected",
		rejection: { stage: "storage", cause: "remote" },
		storage: { kind: "rejected", cause: "remote" },
		sends: 1,
		planned: leasePlanned(L),
		rights: ABSENT_RIGHTS,
	});
}

function errorBody(command: string, status: string, code: string, ticket: string | null, extra: Body = {}): Body {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status,
		command,
		code,
		message: MESSAGE,
		ticket,
		operationId: null,
		...extra,
	};
}

/** resolve of a recorded acquire: stored is applied/0, open is unknown/3; nothing is sent. */
function resolutionBody(outcome: string, operationId: string, ticket: string, resolution: string): Body {
	return {
		schemaVersion: 1,
		kind: "claim-resolution",
		status: outcome,
		command: "resolve",
		operationId,
		ticket,
		action: "acquire",
		outcome,
		query: { kind: "resolved", resolution },
	};
}

/** An acquire paused by own outstanding intents; IDs are data, never a diagnostic. */
function pauseBody(ticket: string, operationIds: string[], rights: Body): Body {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: null,
		pause: { kind: "outstanding", operationIds },
		rights,
	};
}

function listBody(claims: Body[], complete = true): Body {
	const status = complete ? "ok" : "unknown";
	return { schemaVersion: 1, kind: "claim-list", status, command: "list", complete, observedAt: T, claims };
}

/** An ACTIVE list entry of OWNER at epoch 1; rights only with a context (surface/index.ts:2902-2931). */
function activeEntry(ticket: string, leaseEnd: number, rights?: Body): Body {
	const timing = { mode: "lease", leaseEnd, hardEnd: null, graceMs: GRACE };
	const entry: Body = { ticket, state: "active", owner: OWNER, claimGeneration: 1, epoch: 1, timing };
	if (rights !== undefined) entry.rights = rights;
	return entry;
}

function freeEntry(ticket: string): Body {
	return { ticket, state: "free", claimGeneration: 1, epoch: 1 };
}

/** The same claim refs and journal records on both twins. */
function twinState(tickets: readonly string[], ids: readonly string[]): { cli: SideState; mcp: SideState } {
	const claims = tickets.map((ticket) => `refs/claims/${ticket}`).sort(byCodeUnits);
	const journal = ids.map((id) => `${id}.json`).sort(byCodeUnits);
	return { cli: { claims, journal }, mcp: { claims, journal } };
}

// ---------------------------------------------------------------------------------------------------------------
// The cases. An own open intent pauses a further mutating call of the same context on the same ticket while
// that ticket's root is unchanged (pause/index.ts:96-121); every follow-up call below says why it is not paused.
// ---------------------------------------------------------------------------------------------------------------

describe("claim tools over MCP against the CLI on twin fixtures over real Git (blob)", () => {
	test(
		"mcp-g01: claim_acquire applies on the same core and answers the CLI's document byte for byte",
		async () => {
			await withTwin("mcp-g01", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core, an environment built without the
				// injected seams, a text that is not the CLI's formatJson, isError on an applied result).
				const acquired = await twin.mutate("mcp-g01 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// ttlMs and operationId reach the core raw. A has no intent on SECOND.
				const short = T + 2 * MINUTE;
				const options = { owner: OWNER, ttlMs: 2 * MINUTE, operationId: FIXED_ID };
				const label = "mcp-g01 acquire with ttlMs and operationId (catches: an argument dropped or coerced)";
				const fixed = await twin.mutate(label, "acquire", SECOND, a, options);
				const fixedBody = appliedBody("acquire", SECOND, FIXED_ID, leasePlanned(short), heldRights(short));
				expect({ fixed: parityView(fixed), state: await twin.state(a) }).toEqual({
					fixed: expectedParity(fixed, fixedBody),
					// catches: an MCP call that wrote into the other twin, another context or no remote.
					state: twinState([TICKET, SECOND], [seamId(1), FIXED_ID]),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g02: claim_renew applies with the injected clock and honours expectGeneration",
		async () => {
			await withTwin("mcp-g02", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g02 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// One minute later on both twins, so the renewed lease end differs from the acquired one.
				const later = T + MINUTE;
				const renewedEnd = later + TTL;
				twin.setClock(later);
				// The acquire applied and moved TICKET's root, so its intent is not outstanding.
				const renewed = await twin.mutate("mcp-g02 renew (catches: a clock that is not the seam)", "renew", TICKET, a);
				// The renew applied and moved the root again. This plan rejection draws seamId(3) and persists nothing.
				const staleLabel = "mcp-g02 renew with a stale expectGeneration (catches: expectGeneration dropped)";
				const stale = await twin.mutate(staleLabel, "renew", TICKET, a, { expectGeneration: 2 });
				// execution/index.ts:756, :773 with rights/index.ts:357-358: the expectation shows in the work right.
				const changed = { kind: "none", cause: "generation-changed" };
				const staleRights = rightsOf("held", changed, { kind: "not-yet", boundary: renewedEnd + GRACE });
				const renewedBody = appliedBody("renew", TICKET, seamId(2), leasePlanned(renewedEnd), heldRights(renewedEnd));
				expect({ renewed: parityView(renewed), stale: parityView(stale) }).toEqual({
					renewed: expectedParity(renewed, renewedBody),
					stale: expectedParity(stale, planRejectedBody("renew", TICKET, "generation-changed", staleRights)),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g03: claim_release applies and leaves a free tombstone that claim_list shows",
		async () => {
			await withTwin("mcp-g03", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g03 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// The acquire applied and moved TICKET's root.
				const released = await twin.mutate("mcp-g03 release", "release", TICKET, a);
				const listed = await twin.list("mcp-g03 list after the release (catches: a release that stored nothing)");
				expect({ released: parityView(released), listed: parityView(listed) }).toEqual({
					released: expectedParity(released, appliedBody("release", TICKET, seamId(2), FREE_PLANNED, FREE_RIGHTS)),
					listed: expectedParity(listed, listBody([freeEntry(TICKET)])),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g04: claim_reclaim is rejected before the reclaim boundary and applies after it",
		async () => {
			await withTwin("mcp-g04", {}, async (twin) => {
				const a = await twin.pair();
				const b = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g04 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// transition/index.ts:466-470 with rights/index.ts:334-338: eligible once C - eps >= R. b has no intent on
				// TICKET; the early reclaim draws seamId(2) (surface/index.ts:2273-2282) and persists nothing.
				const early = await twin.mutate("mcp-g04 reclaim before the boundary", "reclaim", TICKET, b);
				twin.setClock(R + EPS);
				// b's early reclaim was a plan rejection, so b still has no intent on TICKET.
				const reclaimed = await twin.mutate("mcp-g04 reclaim after the boundary", "reclaim", TICKET, b);
				expect({ early: parityView(early), reclaimed: parityView(reclaimed), state: await twin.state(b) }).toEqual({
					early: expectedParity(early, planRejectedBody("reclaim", TICKET, "not-yet", foreignRights(L), R)),
					reclaimed: expectedParity(reclaimed, appliedBody("reclaim", TICKET, seamId(3), FREE_PLANNED, FREE_RIGHTS)),
					// catches: a rejected reclaim that persisted its intent.
					state: twinState([TICKET], [seamId(3)]),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g05: claim_acquire of a ticket another context holds is a plan rejection, not a tool error",
		async () => {
			await withTwin("mcp-g05", {}, async (twin) => {
				const a = await twin.pair();
				const b = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g05 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// b has no intent on TICKET. Rejected is a result, so isError stays false.
				const label = "mcp-g05 acquire by another context (catches: isError on rejected; a persisted intent)";
				const rival = await twin.mutate(label, "acquire", TICKET, b, { owner: RIVAL });
				expect({ rival: parityView(rival), state: await twin.state(b) }).toEqual({
					rival: expectedParity(rival, planRejectedBody("acquire", TICKET, "not-free", foreignRights(L))),
					state: twinState([TICKET], []),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g06 mcp-g07: a lost reply pauses the next acquire as claim-pause; claim_retry is the way out",
		async () => {
			await withTwin("mcp-g06", { attempts: 1, timeoutMs: LOSS_TIMEOUT }, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g06 acquire", "acquire", SECOND, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", SECOND, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// unk-01 of claim-cli.test.ts:1323-1341 on both twins: pre-receive holds past the attempt timeout, then
				// rejects; one attempt. A has no intent on TICKET yet.
				const held = await twin.nextHooks("pre");
				await twin.planHooks("pre", ["hold-reject"]);
				const lostOptions = { owner: OWNER, operationId: LOST_ID };
				const lost = await twin.mutate("mcp-g06 acquire whose reply is lost", "acquire", TICKET, a, lostOptions);
				const settled = await twin.settleHooks("pre", held);
				await twin.planHooks("pre", [], "pass");
				const lostBody = operationBody({
					status: "unknown",
					command: "acquire",
					ticket: TICKET,
					operationId: LOST_ID,
					outcome: "unknown",
					storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } },
					sends: 1,
					stoppedBy: "attempts",
					planned: leasePlanned(L),
					rights: ABSENT_RIGHTS,
				});
				// catches: unknown reported as a tool error, or an MCP push that never reached its server.
				expect({ lost: parityView(lost), settled }).toEqual({
					lost: expectedParity(lost, lostBody),
					settled: { cli: true, mcp: true },
				});

				// mcp-g06 (executor pause). On purpose: LOST_ID is a's own open intent at TICKET's unchanged absent root,
				// so a's next acquire of TICKET pauses before any plan, record or send (it draws seamId(2), never shown).
				const before = await twin.pushes();
				const pausedLabel = "mcp-g06 acquire while the lost one is open";
				const paused = await twin.mutate(pausedLabel, "acquire", TICKET, a, { owner: OWNER });
				expect({ paused: parityView(paused), pushes: await twin.pushes(), state: await twin.state(a) }).toEqual({
					paused: expectedParity(paused, pauseBody(TICKET, [LOST_ID], ABSENT_RIGHTS)),
					// catches: a pause that sent or recorded anything.
					pushes: before,
					state: twinState([SECOND], [seamId(1), LOST_ID]),
				});

				// mcp-g07: claim_retry resends the frozen change once and applies it; it never pauses.
				const retried = await twin.retry("mcp-g07 retry of the lost acquire", LOST_ID, a);
				// The retry applied and moved TICKET's root, so LOST_ID is no longer outstanding: this acquire meets
				// the holder (it draws seamId(3), never shown).
				const againLabel = "mcp-g07 acquire after the retry (catches: a retry that left the pause in place)";
				const again = await twin.mutate(againLabel, "acquire", TICKET, a, { owner: OWNER });
				const retriedBody = appliedBody("retry", TICKET, LOST_ID, leasePlanned(L), heldRights(L), "acquire");
				expect({ retried: parityView(retried), again: parityView(again), state: await twin.state(a) }).toEqual({
					retried: expectedParity(retried, retriedBody),
					again: expectedParity(again, planRejectedBody("acquire", TICKET, "held", heldRights(L))),
					// catches: a retry that allocated a new ID or record.
					state: twinState([TICKET, SECOND], [seamId(1), LOST_ID]),
				});
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"mcp-g08: claim_resolve reports an applied acquire as applied and an open one as unknown",
		async () => {
			await withTwin("mcp-g08", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g08 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				const stored = await twin.resolve("mcp-g08 resolve of the applied acquire", seamId(1), a);
				// cli-03 of claim-cli.test.ts:1293-1310: the hook rejects once. A has no intent on SECOND; the rejected
				// push leaves REJECTED_ID open at SECOND's unchanged absent root (resolution/index.ts:107-114).
				await twin.planHooks("pre", ["reject"]);
				const rejectedLabel = "mcp-g08 acquire the endpoint rejects";
				const rejectedOptions = { owner: OWNER, operationId: REJECTED_ID };
				const rejected = await twin.mutate(rejectedLabel, "acquire", SECOND, a, rejectedOptions);
				await twin.planHooks("pre", [], "pass");
				// resolve never pauses and never sends (surface/index.ts:2850-2899).
				const openLabel = "mcp-g08 resolve of the open acquire (catches: open as rejected or as a tool error)";
				const open = await twin.resolve(openLabel, REJECTED_ID, a);
				expect({ stored: parityView(stored), rejected: parityView(rejected), open: parityView(open) }).toEqual({
					stored: expectedParity(stored, resolutionBody("applied", seamId(1), TICKET, "stored")),
					rejected: expectedParity(rejected, remoteRejectedBody(SECOND, REJECTED_ID)),
					open: expectedParity(open, resolutionBody("unknown", REJECTED_ID, SECOND, "open")),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g09: claim_list answers with and without context, and a partial list stays unknown, never a shorter ok",
		async () => {
			await withTwin("mcp-g09", {}, async (twin) => {
				const a = await twin.pair();
				const b = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g09 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// catches: a missing context turned into "" (context-required) instead of undefined; the ticket argument
				// dropped; the rights of one context shown for another.
				const all = await twin.list("mcp-g09 list without context");
				const own = await twin.list("mcp-g09 list with a's context", { pair: a });
				const one = await twin.list("mcp-g09 list of one ticket with b's context", { ticket: TICKET, pair: b });
				expect({ all: parityView(all), own: parityView(own), one: parityView(one) }).toEqual({
					all: expectedParity(all, listBody([activeEntry(TICKET, L)])),
					own: expectedParity(own, listBody([activeEntry(TICKET, L, heldRights(L))])),
					one: expectedParity(one, listBody([activeEntry(TICKET, L, foreignRights(L))])),
				});

				// lst-01 of claim-cli.test.ts:1983-2008: a canonical ticket whose object is no claim document.
				await twin.writeGarbage(THIRD);
				const partialLabel = "mcp-g09 list with an unreadable ticket (catches: a shorter ok; unknown as isError)";
				const partial = await twin.list(partialLabel, { pair: a });
				const entries = [activeEntry(TICKET, L, heldRights(L)), { ticket: THIRD, state: "unknown" }];
				expect(parityView(partial)).toEqual(expectedParity(partial, listBody(entries, false)));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g10: under enabled false claim_acquire is claims-disabled while claim_release and claim_list still work",
		async () => {
			await withTwin("mcp-g10", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core; it also loads the configuration once).
				const acquired = await twin.mutate("mcp-g10 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// Written after the registration and the first call; every call must read it fresh.
				await twin.writeBlock({ enabled: false });
				// A has no intent on SECOND; the preflight refuses before any intent or ID (surface/index.ts:2255-2265).
				const disabledLabel = "mcp-g10 acquire under enabled false (catches: a configuration cached by the server)";
				const disabled = await twin.mutate(disabledLabel, "acquire", SECOND, a, { owner: OWNER });
				// TICKET's acquire applied and moved its root. catches: an MCP-own enabled gate.
				const released = await twin.mutate("mcp-g10 release under enabled false", "release", TICKET, a);
				const listed = await twin.list("mcp-g10 list under enabled false");
				expect({ disabled: parityView(disabled), released: parityView(released), listed: parityView(listed) }).toEqual({
					disabled: expectedParity(disabled, errorBody("acquire", "refused", "claims-disabled", SECOND)),
					released: expectedParity(released, appliedBody("release", TICKET, seamId(2), FREE_PLANNED, FREE_RIGHTS)),
					listed: expectedParity(listed, listBody([freeEntry(TICKET)])),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g11: claim_acquire of a blocked ticket is dependency-blocked through the real loadLocalTickets",
		async () => {
			await withTwin("mcp-g11", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core; a loader that refuses every ticket).
				const acquired = await twin.mutate("mcp-g11 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// Over the project's task files; neither twin injects loadLocalTickets. A has no intent on
				// BLOCKED; the gate refuses before any intent or ID (surface/index.ts:2241-2247).
				const blockedLabel = "mcp-g11 acquire of a blocked ticket (catches: the gate skipped or fed a stub corpus)";
				const blocked = await twin.mutate(blockedLabel, "acquire", BLOCKED, a, { owner: OWNER });
				const refusedState = await twin.state(a);
				await twin.markDone(THIRD);
				// The refusal above persisted nothing, so a still has no intent on BLOCKED.
				const readyLabel = "mcp-g11 acquire once the prerequisite is done (catches: a corpus read once per server)";
				const ready = await twin.mutate(readyLabel, "acquire", BLOCKED, a, { owner: OWNER });
				const dependencies = { blocking: [THIRD], unknown: [], unreadable: 0 };
				const blockedBody = errorBody("acquire", "refused", "dependency-blocked", BLOCKED, { dependencies });
				expect({ blocked: parityView(blocked), refusedState, ready: parityView(ready) }).toEqual({
					blocked: expectedParity(blocked, blockedBody),
					refusedState: twinState([TICKET], [seamId(1)]),
					ready: expectedParity(ready, appliedBody("acquire", BLOCKED, seamId(2), leasePlanned(L), heldRights(L))),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g12: an unreachable endpoint answers unavailable with isError for acquire, list and release",
		async () => {
			await withTwin("mcp-g12", {}, async (twin) => {
				const a = await twin.pair();
				// Positive control (catches: a handler that answers without the core).
				const acquired = await twin.mutate("mcp-g12 acquire", "acquire", TICKET, a, { owner: OWNER });
				expect(parityView(acquired)).toEqual(
					expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
				);

				// out-02 of claim-cli.test.ts:1574-1578: the path of the refused endpoint carries the sentinel.
				const port = await unusedLoopbackPort();
				const endpoint = `http://127.0.0.1:${port}/${SENTINEL}PATH.git`;
				twin.noteSentinel("unreachable endpoint", endpoint);
				await twin.writeBlock({ endpoint });
				// A has no intent on SECOND; each call below ends at the preflight, before any intent or ID.
				const acquire = await twin.mutate("mcp-g12 acquire", "acquire", SECOND, a, { owner: OWNER });
				const listed = await twin.list("mcp-g12 list");
				// TICKET's acquire applied and moved its root.
				const release = await twin.mutate("mcp-g12 release", "release", TICKET, a);
				expect({ acquire: parityView(acquire), listed: parityView(listed), release: parityView(release) }).toEqual({
					acquire: expectedParity(acquire, errorBody("acquire", "unavailable", "unreachable", SECOND)),
					listed: expectedParity(listed, errorBody("list", "unavailable", "unreachable", null)),
					release: expectedParity(release, errorBody("release", "unavailable", "unreachable", TICKET)),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"mcp-g13: no MCP result of this file carries a path, endpoint, binding, digest, root or hook stderr",
		async () => {
			await withTwin("mcp-g13", {}, async (twin) => {
				const a = await twin.pair();
				const acquired = await twin.mutate("mcp-g13 acquire", "acquire", TICKET, a, { owner: OWNER });
				const listed = await twin.list("mcp-g13 list with a's context", { pair: a });
				const owner: Sentinel[] = [["owner", OWNER]];
				// Positive control (catches: a scan that could never see anything): the owner display name MUST reach
				// the list result in text and structure, and only the scan's list rule removes it.
				expect({
					acquired: parityView(acquired),
					listed: parityView(listed),
					ownerShown: echoedIn(JSON.stringify(listed.mcp), owner),
					ownerScanned: echoedIn(scrubbed(listed.mcp), owner),
				}).toEqual({
					acquired: expectedParity(acquired, appliedBody("acquire", TICKET, seamId(1), leasePlanned(L), heldRights(L))),
					listed: expectedParity(listed, listBody([activeEntry(TICKET, L, heldRights(L))])),
					ownerShown: ["owner"],
					ownerScanned: [],
				});

				// Hook stderr (claim-cli.test.ts:1293, out-03): the rejecting hook writes HOOK_MARKER. A has no intent
				// on SECOND; the rejected push draws seamId(2) and stays open, which resolve reads without sending.
				await twin.planHooks("pre", ["reject"]);
				const rejectedLabel = "mcp-g13 acquire the endpoint rejects";
				const rejected = await twin.mutate(rejectedLabel, "acquire", SECOND, a, { owner: OWNER });
				await twin.planHooks("pre", [], "pass");
				const open = await twin.resolve("mcp-g13 resolve of the rejected acquire", seamId(2), a);
				expect({ rejected: parityView(rejected), open: parityView(open) }).toEqual({
					rejected: expectedParity(rejected, remoteRejectedBody(SECOND, seamId(2))),
					open: expectedParity(open, resolutionBody("unknown", seamId(2), SECOND, "open")),
				});

				// Over every MCP result of this file: bun:test runs one file's tests serially in source order, so
				// the ledger holds mcp-g01 to mcp-g12 before these four; run alone, it holds these four.
				await twin.collect();
				const classes = new Set(SENTINELS.map(([label]) => label));
				expect({
					leaks: leaksIn(RESULTS, SENTINELS),
					own: RESULTS.filter((entry) => entry.label.startsWith("mcp-g13 ")).length,
					missing: SENTINEL_CLASSES.filter((label) => !classes.has(label)),
				}).toEqual({ leaks: [], own: 4, missing: [] });
			});
		},
		TEST_TIMEOUT,
	);
});
