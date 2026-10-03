/**
 * Level G of the emergency release: the surface core, `runClaimMutation`, `runClaimRetry`, `runClaimResolve` and
 * `runClaimList` with the environment of `claimProjectEnv(projectRoot, command, seams)` as claim-mcp-git.test.ts builds
 * it, against the loopback Git daemon of claim-git-fixture.ts. Every case runs on blob, tree and commit-chain (the
 * formats diverge), 8 cases, 24 runs. One project per run holds three contexts: the holder, the operator whose
 * authority ID (recomputed here, never read from the product) is the only entry of `claims.recovery_authorities`, and
 * another context. em-g04 runs the operator's executor in the child probe fixtures/claim-time-path-probe.ts held at
 * `after-slot-link`; em-g05 builds the PENDING over the time path of claim-time-path-git.test.ts through the surface;
 * em-g08 adds the in-process MCP server of claim-mcp-git.test.ts. A test-local S1 receive script counts, declines or
 * holds pushes; S2 is the trace2 record of the project's Git commands, the observable of "no Git call". Every run opens
 * with a positive control that the typed scaffold (the eighth action planned as a fixed rejection,
 * `claimContextAuthority` → "", the retry option ignored) fails behaviourally; every further expectation names what it
 * catches. Names the contract leaves to the scaffold are called through one helper each at the top of the file, marked
 * ASSUMPTION(scaffold); open observations are marked [?]. claim-git-fixture.ts, claim-time-path-probe.ts and every
 * existing test file stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { claimConfirmationId } from "../claims/resolution/index.ts";
import {
	type ClaimStorageFormat,
	type ClaimStore,
	initializeClaimStorage,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimCommand,
	type ClaimDocument,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import type { ClaimTransitionRequest } from "../claims/transition/index.ts";
import { Core } from "../core/backlog.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import { McpServer } from "../mcp/server.ts";
import { registerClaimTools } from "../mcp/tools/claims/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";
import {
	type ExecuteOutput,
	type FileGate,
	ProbeSupervisor,
	releaseGate,
	type TimePathCommand,
} from "./fixtures/claim-time-path-probe.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Body = Record<string, unknown>;
type ContextHandle = { context: ClaimContext; directory: string };
/** The holder of the claims, the operator listed in `claims.recovery_authorities`, and one more context. */
type Parties = { holder: ContextHandle; operator: ContextHandle; other: ContextHandle };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type Mode = "none" | "hard";
/** The claims block keys a case varies; everything else is fixed in claimsBlock. `null` omits the list key. */
type BlockOptions = { mode: Mode; enabled: boolean; timeoutMs: number; authorities: readonly string[] | null };
type OperationInput = { operationId: string; context: string };
type Tracked<V> = { promise: Promise<V>; settled: () => boolean };
/** Server refs, the calling context's journal records and the pre-receive count: what a refusal may not move. */
type Snapshot = { refs: Record<string, string>; journal: string[]; pushes: number };
/** A claim read through an independent reader client (O3 of claim-time-path-git.test.ts:1398-1410). */
type StoredView = { revision: number | null; payload: unknown; receipts: Body };
/** The top layer of a root in its own format: the receipt names it carries itself and its parent commits. */
type LayerView = { receipts: string[]; parents: string[] };
/** One refusal row of em-g02: the list in the block and whether the preview or the release is called. */
type RefusalRow = { label: string; catches: string; authorities: readonly string[] | null; preview: boolean };
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
	planned?: Body;
	rights: Body;
};
type ResolutionFields = {
	status: string;
	operationId: string;
	ticket: string;
	action: string;
	resolution: string;
	transition?: Body;
};

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/** Runs of about fifteen surface calls (claim-mcp-git.test.ts:90, claim-time-path-git.test.ts:82). */
const TEST_TIMEOUT = 60_000;
/** em-g04 (two child probes) and em-g05 (a held push, two rows) (claim-time-path-git.test.ts:84). */
const LONG_TEST_TIMEOUT = 90_000;
/** attempt_timeout_ms of the block, far below the 10 s start value so that a hang shows (claim-mcp-git:94). */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of em-g05, whose witness A holds in pre-receive on purpose (claim-time-path-git.test.ts:89). */
const HELD_SEND_TIMEOUT = 10_000;
/** Bound for waiting on hook entries, hook drains and settling calls. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
/** How long a child waits at a file gate before it gives up (claim-time-path-git.test.ts:95). */
const CHILD_GATE_TIMEOUT = 8_000;
const SUPERVISOR_LIFETIME = 60_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
/** Ticket of every leading positive control, so it never shares a root with the case after it. */
const CONTROL_TICKET = "BACK-9";
const TASK_IDS: readonly string[] = [TICKET, SECOND_TICKET, CONTROL_TICKET];
/** `attempts` of the block and of the probe (claim-time-path-git.test.ts:105). */
const ATTEMPTS = 3;
/** Placeholder for a key a document does not have; no document value ever equals it. */
const ABSENT = "(absent)";
/** Placeholder for a ticket ref the server does not have. */
const ABSENT_REF = "(no ref)";
/**
 * [?] As claim-time-path-git.test.ts:110-114: a late A declined at a moved root fails at the client's
 * lease check ("stale") or at the server's ref update ("remote"); both are the lease, so `after` is
 * folded into this value (see `folded`).
 */
const LEASE_CAUSE = "stale-or-remote";
/** Display names: the holder, the other context, and the target of em-g05's restart. */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const TARGET_OWNER = "agent-sentinel-lena";
/** operation_budget_ms of the block (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock of every call unless a call scripts its reads. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** em-g05: the source's hard end H_s "11:00", the restart's new hard end H_t, and the hull R(target). */
const H = T + 60 * MINUTE;
const H2 = H + 60 * MINUTE;
const HULL = H2 + GRACE;
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
const INSTRUCTIONS = "claim-emergency-git";
/** The authority domain, NUL-terminated like the binding's (context/index.ts:131). */
const AUTHORITY_DOMAIN = "backlog.md/claim-authority/v1\0";
/** mcp-p01 (claim-mcp.test.ts:150): the seven claim tools, sorted by code units. */
const SEVEN: readonly string[] = [
	"claim_acquire",
	"claim_list",
	"claim_reclaim",
	"claim_release",
	"claim_renew",
	"claim_resolve",
	"claim_retry",
];

// ---------------------------------------------------------------------------------------------------------------
// The emergency release names this file calls, each in exactly one place: a scaffold that settles an ASSUMPTION
// otherwise changes one function here and nothing below.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The release as the CLI hands it to the core, with `--operation-id`. The raw `--expect-root` is
 * `ClaimMutationInput.expectRoot` (`COMMAND_FIELDS["emergency-release"] = ["expectRoot"]`).
 */
function releaseInput(ticket: string, context: string, expectRoot: string, operationId: string): ClaimMutationInput {
	return { command: "emergency-release", ticket, context, expectRoot, operationId };
}

/** The preview is the mutation input with `preview: true` and no root . */
type PreviewInput = ClaimMutationInput & { preview: true };

function previewInput(ticket: string, context: string): PreviewInput {
	return { command: "emergency-release", ticket, context, preview: true };
}

/** The eighth transition request with exactly its two fields (`parseRequest`). */
function releaseRequest(expectedRoot: string): ClaimTransitionRequest {
	return { action: "emergency-release", expectedRoot };
}

/** The retry `src/commands/claim.ts` runs for a release record, the only caller of the third parameter. */
function administrativeRetry(input: OperationInput, env: ClaimSurfaceEnv): Promise<ClaimDocument> {
	return runClaimRetry(input, env, { administrative: true });
}

/**
 * Recomputed without `claimContextAuthority`: `ta1-` and the lowercase hex SHA-256 over the domain and
 * the secret bytes, i.e. the 32 bytes the 64 hex characters of `context.json` name, taken exactly as the binding takes
 * them (context/index.ts:129-134: the domain as UTF-8, then `Buffer.from(secret, "hex")`).
 */
function authorityIdOf(secretHex: string): string {
	const digest = createHash("sha256").update(AUTHORITY_DOMAIN, "utf8").update(Buffer.from(secretHex, "hex"));
	return `ta1-${digest.digest("hex")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-time-path-git.test.ts:378-381
function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-time-path-git.test.ts:384-387
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-time-path-git.test.ts:422-424
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-time-path-git.test.ts:427-429
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

// adapted from claim-time-path-git.test.ts:432-439
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** `--hard-end` rule: ISO-8601 with a zone (claim-time-path-git.test.ts:443-445). */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// adapted from claim-time-path-git.test.ts:670-673
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

/** The value under `key`, or ABSENT when there is no such own key (claim-time-path-git.test.ts:677-680). */
function entryOf(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return ABSENT;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-time-path-git.test.ts:690-692
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-mcp-git.test.ts:208-210
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh plain JSON copy, so null-prototype receipt maps compare like plain objects. */
function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** Shape `op-<uuid v4>`: the n-th operation ID the seam hands out (claim-mcp-git.test.ts:234-236). */
function seamId(n: number): string {
	return `op-5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// adapted from claim-time-path-git.test.ts:1011-1018
function tracked<V>(promise: Promise<V>): Tracked<V> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-time-path-git.test.ts:1022-1034
async function whilePending(
	label: string,
	pending: { settled: () => boolean },
	condition: () => Promise<boolean>,
): Promise<boolean> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	for (;;) {
		if (await condition()) return true;
		if (pending.settled()) return false;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/** Waits, bounded, until `pending` settled. */
// adapted from claim-time-path-git.test.ts:1038-1045
async function settleWithin<V>(label: string, pending: Tracked<V>): Promise<V> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/**
 * S2, test-local: the argv of every trace2 `start` event, i.e. of every Git process this test process started with
 * the case's trace variable, the claim storage's `git -C <repository>` (storage/index.ts:226) and the preflight's
 * `git rev-parse --git-dir` (git/operations.ts:1266) alike. The fixture's own Git runs without it
 * (claim-git-fixture.ts:136-140 drops every GIT_ variable).
 */
// adapted from claim-time-path-git.test.ts:1059-1081 (every start event, not only those of one repository)
async function gitStartsOf(tracePath: string): Promise<string[][]> {
	let text: string;
	try {
		text = await readFile(tracePath, "utf8");
	} catch {
		return [];
	}
	const commands: string[][] = [];
	for (const line of text.split("\n")) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// An empty or partially written last line.
			continue;
		}
		const argv = field(event, "argv");
		if (field(event, "event") === "start" && Array.isArray(argv)) commands.push(argv.map(String));
	}
	return commands;
}

/** The S1 hook script: numbers each invocation atomically (mkdir), logs its stdin, then passes, rejects or holds. */
// adapted from claim-time-path-git.test.ts:1085-1107
function receiveHook(control: string, phase: ReceivePhase): string {
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
		'case "$action" in *reject) echo fixture-scripted-reject >&2; exit 1 ;; esac',
		"exit 0",
		"",
	].join("\n");
}

/** S1, test-local: scripted receive hooks of one server repository that count, pass, reject or hold pushes. */
// adapted from claim-time-path-git.test.ts:1111-1191 (without hasFinished and invocations, which no case reads)
class ReceiveScript {
	private readonly serverRepo: string;
	private readonly control: string;

	constructor(serverRepo: string, control: string) {
		this.serverRepo = serverRepo;
		this.control = control;
	}

	async install(): Promise<void> {
		await mkdir(this.control, { recursive: true });
		for (const phase of ["pre", "post"] as const) {
			const hook = join(this.serverRepo, "hooks", `${phase}-receive`);
			await writeFile(hook, receiveHook(this.control, phase));
			await chmod(hook, 0o755);
		}
	}

	/** Number of invocations of `phase` so far, entered or not: one per push that reached the server. */
	async count(phase: ReceivePhase): Promise<number> {
		const pattern = new RegExp(`^${phase}-\\d+$`);
		return (await readdir(this.control)).filter((name) => pattern.test(name)).length;
	}

	/** Actions for the next invocations of `phase`, then `rest` for every later one. */
	async plan(phase: ReceivePhase, actions: HookAction[], rest: HookAction): Promise<void> {
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

	hasEntered(phase: ReceivePhase, n: number): Promise<boolean> {
		return exists(join(this.control, `${phase}-${n}`, "entered"));
	}

	async release(phase: ReceivePhase, n: number): Promise<void> {
		await writeFile(join(this.control, `${phase}-${n}`, "release"), "");
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

// adapted from claim-mcp-git.test.ts:239-244
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
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

/**
 * Configuration keys plus the three surface keys, all explicit, and the recovery authorities list as a YAML flow
 * sequence. The timeless mode takes neither `lease_ttl_ms` nor `reclaim_grace_ms`, the hard mode only the grace
 * (config/index.ts:363-378).
 */
// adapted from claim-mcp-git.test.ts:261-277
function claimsBlock(url: string, format: ClaimStorageFormat, options: BlockOptions): string {
	const lines = [
		"claims:",
		`  enabled: ${options.enabled}`,
		`  endpoint: ${JSON.stringify(url)}`,
		`  storage_format: ${format}`,
		`  lifetime_mode: ${options.mode}`,
	];
	if (options.mode === "hard") lines.push(`  reclaim_grace_ms: ${GRACE}`);
	lines.push(
		`  attempt_timeout_ms: ${options.timeoutMs}`,
		`  attempts: ${ATTEMPTS}`,
		`  operation_budget_ms: ${BUDGET_MS}`,
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	);
	if (options.authorities !== null) lines.push(`  recovery_authorities: ${JSON.stringify(options.authorities)}`);
	return lines.join("\n");
}

/** A Backlog project with task prefix BACK, the TASK_IDS files, the claims block and one committed repository. */
// adapted from claim-mcp-git.test.ts:281-293
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim emergency");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const id of TASK_IDS) await core.filesystem.saveTask(taskOf(id));
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/**
 * One run of a case on one format: a server repository with the S1 script, a Backlog project that is also the
 * surface's repository, contexts below a private 0700 parent, the S2 trace of the project's Git commands, and on
 * demand a reader client, a probe client with its supervised children and in-process MCP servers.
 */
// adapted from claim-mcp-git.test.ts:416-549 (Side) and claim-time-path-git.test.ts:1200-1763 (TimePathCase: trace,
// reader, probes, dispose)
class EmergencyCase {
	readonly hooks: ReceiveScript;
	readonly parent: string;
	private readonly tracePath: string;
	private readonly pendings: Tracked<unknown>[] = [];
	private readonly supervisors: ProbeSupervisor[] = [];
	private readonly servers: McpServer[] = [];
	private options: BlockOptions;
	private readerStore: ClaimStore | undefined;
	private probeClient: string | undefined;
	private previousTrace: string | undefined;
	private tracing = false;
	private issued = 0;
	private sequence = 0;

	private constructor(
		readonly format: ClaimStorageFormat,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		options: BlockOptions,
	) {
		this.options = options;
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.parent = join(root, "contexts");
		this.tracePath = resolve(root, "trace2-events.json");
	}

	// adapted from claim-mcp-git.test.ts:438-459 and claim-time-path-git.test.ts:1237-1254
	static async create(
		format: ClaimStorageFormat,
		caseId: string,
		block: Partial<BlockOptions>,
	): Promise<EmergencyCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-emergency-git-${format}-`));
		try {
			const repository = await server().initRepository(root, `${caseId}-${format}`);
			const url = server().url(repository.name);
			// The list is written by `parties` once the operator's context exists.
			const options: BlockOptions = { mode: "none", enabled: true, timeoutMs: ADAPTER_TIMEOUT, authorities: null };
			Object.assign(options, block);
			const project = join(root, "project");
			await initProject(project, claimsBlock(url, format, options));
			const created = new EmergencyCase(format, root, url, repository.repo, project, options);
			await created.hooks.install();
			await mkdir(created.parent);
			await chmod(created.parent, 0o700);
			const initializer = await initClient(join(root, "client-initializer"));
			const storage = { repository: initializer, remote: url, format, timeoutMs: ADAPTER_TIMEOUT };
			const initialized = await initializeClaimStorage(storage);
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			created.startTrace();
			return created;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-mcp-git.test.ts:462-468
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** The holder, the operator and another context; the operator's authority ID becomes the only list entry. */
	async parties(): Promise<Parties> {
		const holder = await this.context();
		const operator = await this.context();
		const other = await this.context();
		await this.writeBlock({ authorities: [await this.authorityOf(operator)] });
		return { holder, operator, other };
	}

	/** The expected authority ID of a context, from the secret of its private record. */
	// adapted from claim-time-path-git.test.ts:1299-1307 (secretOf)
	async authorityOf(handle: ContextHandle): Promise<string> {
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("fixture: the private record has no string secret");
		return authorityIdOf(secret);
	}

	/** Rewrites the claims block through saveConfig; every call reads it fresh (claim-mcp-git.test.ts:472-478). */
	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("fixture: the project configuration is missing");
		this.options = { ...this.options, ...changes };
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.url, this.format, this.options) });
	}

	/**
	 * The seams of one call (claim-mcp-git.test.ts:396-414): a clock that serves `reads` first and T afterwards, a
	 * steady monotonic clock, no sleep, and seam IDs. Each call owns its clock, so concurrent calls never share reads.
	 */
	seams(reads: readonly number[] = []): ClaimEnvSeams {
		const queue = [...reads];
		return {
			clock: () => queue.shift() ?? T,
			monotonicNow: () => MONO_START,
			random: () => 0.5,
			sleep: () => Promise.resolve(),
			newOperationId: () => {
				this.issued += 1;
				return seamId(this.issued);
			},
		};
	}

	/** The CLI side as claim.ts builds it: `claimProjectEnv`, then the core, no printing (claim-mcp-git:677-700). */
	async call<D>(
		command: ClaimCommand,
		produce: (env: ClaimSurfaceEnv) => Promise<D>,
		reads: readonly number[] = [],
	): Promise<D | ClaimDocument> {
		try {
			const env = await claimProjectEnv(this.project, command, this.seams(reads));
			return isClaimDocument(env) ? env : await produce(env);
		} catch {
			return claimErrorDocument({ command, code: "internal" });
		}
	}

	/** acquire as claim.ts builds it (claim-mcp-git.test.ts:633-651); the hard mode needs `--hard-end` (surface:2013). */
	acquire(handle: ContextHandle, ticket: string, operationId: string, owner = OWNER): Promise<unknown> {
		const input: ClaimMutationInput = { command: "acquire", ticket, context: handle.directory, owner, operationId };
		if (this.options.mode === "hard") input.hardEnd = iso(H);
		return this.call("acquire", (env) => runClaimMutation(input, env));
	}

	/**
	 * The holder's step that moves its root in the timeless mode, where renew is `not-renewable`
	 * (transition/index.ts:510): change-bounds to the same `{mode: "none"}`, a planned write
	 * (transition/index.ts:496-499; surface/index.ts:1858-1862, :1919, :1929-1930).
	 */
	touch(handle: ContextHandle, ticket: string, operationId: string): Promise<unknown> {
		const context = handle.directory;
		const input: ClaimMutationInput = { command: "change-bounds", ticket, context, mode: "none", operationId };
		return this.call("change-bounds", (env) => runClaimMutation(input, env));
	}

	/** A renew with `--ttl-ms`, which the timeless mode requires before any plan (surface/index.ts:2023-2024). */
	renew(handle: ContextHandle, ticket: string, operationId: string): Promise<unknown> {
		const input: ClaimMutationInput = { command: "renew", ticket, context: handle.directory, ttlMs: TTL, operationId };
		return this.call("renew", (env) => runClaimMutation(input, env));
	}

	/**
	 * (ii) through the surface: a transfer restart with the explicit new hard end H2 > H to `receiver`,
	 * the time path's transfer form, so the target's generation differs from the source's.
	 */
	transferRestart(
		handle: ContextHandle,
		ticket: string,
		operationId: string,
		receiver: ContextHandle,
		reads: readonly number[] = [],
	): Promise<unknown> {
		const input: ClaimMutationInput = {
			command: "transfer",
			ticket,
			context: handle.directory,
			toContext: receiver.directory,
			owner: TARGET_OWNER,
			timeBox: "restart",
			hardEnd: iso(H2),
			operationId,
		};
		return this.call("transfer", (env) => runClaimMutation(input, env), reads);
	}

	release(handle: ContextHandle, ticket: string, expectRoot: string, operationId: string): Promise<unknown> {
		const input = releaseInput(ticket, handle.directory, expectRoot, operationId);
		return this.call("emergency-release", (env) => runClaimMutation(input, env));
	}

	preview(handle: ContextHandle, ticket: string): Promise<unknown> {
		const input = previewInput(ticket, handle.directory);
		return this.call("emergency-release", (env) => runClaimMutation(input, env));
	}

	/** commands/claim.ts:757: `{operationId, context}` (claim-mcp-git.test.ts:654-658). */
	resolve(handle: ContextHandle, operationId: string): Promise<unknown> {
		const input: OperationInput = { operationId, context: handle.directory };
		return this.call("resolve", (env) => runClaimResolve(input, env));
	}

	/** commands/claim.ts:774 today: two arguments, as `claim_retry` over MCP calls it. */
	retry(handle: ContextHandle, operationId: string): Promise<unknown> {
		const input: OperationInput = { operationId, context: handle.directory };
		return this.call("retry", (env) => runClaimRetry(input, env));
	}

	retryAdministrative(handle: ContextHandle, operationId: string): Promise<unknown> {
		const input: OperationInput = { operationId, context: handle.directory };
		return this.call("retry", (env) => administrativeRetry(input, env));
	}

	/** commands/claim.ts:795: every ticket, with the rights of `handle` when given (claim-mcp-git.test.ts:668-674). */
	list(handle?: ContextHandle): Promise<unknown> {
		const input = { context: handle?.directory };
		return this.call("list", (env) => runClaimList(input, env));
	}

	/** The in-process MCP server of claim-mcp-git.test.ts:568-571 on this run's project, with this run's seams. */
	mcp(): McpServer {
		const created = new McpServer(this.project, INSTRUCTIONS);
		registerClaimTools(created, this.seams());
		this.servers.push(created);
		return created;
	}

	/** One tool call through `testInterface.callTool`; a throw is kept as a result (claim-mcp-git.test.ts:691-697). */
	async tool(mcp: McpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await mcp.testInterface.callTool({ params: { name, arguments: args } });
		} catch (error) {
			return { thrown: error instanceof Error ? error.name : typeof error };
		}
	}

	/** Starts `promise` without awaiting it; dispose settles it if the test does not. */
	start<V>(promise: Promise<V>): Tracked<V> {
		const pending = tracked(promise);
		this.pendings.push(pending);
		return pending;
	}

	// adapted from claim-mcp-git.test.ts:488-496
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** The root at the server: what `git ls-remote` shows the operator. */
	async ticketRoot(ticket: string): Promise<string> {
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** Journal records of one context; temporary and admission slot names are ignored (claim-mcp-git:508-511). */
	async records(handle: ContextHandle): Promise<string[]> {
		const names = await readdir(handle.context.journalDirectory);
		return names.filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort(byCodeUnits);
	}

	/** Pushes that reached the server: one pre-receive invocation each. */
	pushes(): Promise<number> {
		return this.hooks.count("pre");
	}

	async snapshot(handle: ContextHandle): Promise<Snapshot> {
		return { refs: await this.serverRefs(), journal: await this.records(handle), pushes: await this.pushes() };
	}

	/** S2: the Git processes this run's surface calls started so far (see `gitStartsOf`). */
	async gitCalls(): Promise<number> {
		return (await gitStartsOf(this.tracePath)).length;
	}

	/** O3 through an independent reader client; the receipts as the store decodes them (chain: over parents). */
	async stored(ticket: string): Promise<StoredView> {
		this.readerStore ??= await this.openReader();
		const observed = await this.readerStore.read(ticket);
		if (observed.kind !== "present") return { revision: null, payload: observed.kind, receipts: {} };
		const { revision, payload, receipts } = observed.document;
		return { revision, payload: plain(payload), receipts: plain(receipts) as Body };
	}

	private async openReader(): Promise<ClaimStore> {
		const repository = await initClient(join(this.root, "client-reader"));
		const storage = { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
		const opened = await openClaimStore(storage);
		if (opened.kind !== "open") throw new Error(`fixture: reader store failed (${opened.kind})`);
		return opened.store;
	}

	/**
	 * The top layer of `root` in the server repository, by format (storage/index.ts:505-540, :567-622): a blob and a
	 * tree carry every receipt themselves, a chain commit exactly one and reaches the others over its parent.
	 */
	async layer(root: string): Promise<LayerView> {
		const git = (args: string[]) => server().git(this.serverRepo, args);
		if (this.format === "blob") {
			const document: unknown = JSON.parse((await git(["cat-file", "blob", root])).out);
			return { receipts: keysOf(field(document, "receipts")), parents: [] };
		}
		let tree = root;
		const parents: string[] = [];
		if (this.format === "commit-chain") {
			const headers = (await git(["cat-file", "-p", root])).out.split("\n\n", 1)[0] ?? "";
			for (const line of headers.split("\n")) {
				if (line.startsWith("tree ")) tree = line.slice(5);
				if (line.startsWith("parent ")) parents.push(line.slice(7));
			}
		}
		const listed = await git(["ls-tree", "--name-only", `${tree}:receipts`]);
		return { receipts: listed.out.split("\n").filter(Boolean).sort(byCodeUnits), parents };
	}

	/** The receipt a journal record implies (execution/index.ts:473-476, resolution/index.ts:71-73). */
	async receiptOf(handle: ContextHandle, operationId: string): Promise<Body> {
		const path = join(handle.context.journalDirectory, `${operationId}.json`);
		const record: unknown = JSON.parse(await readFile(path, "utf8"));
		return { schema: 1, intentDigest: field(record, "digest"), parameterDigest: field(record, "parameterDigest") };
	}

	/** The first `after-slot-link` gate of a probe: after the admission, before the send (execution/index.ts:481-496). */
	async fileGate(): Promise<FileGate> {
		this.sequence += 1;
		const dir = join(this.root, `gate-${this.sequence}`);
		await mkdir(dir);
		return { step: "after-slot-link", dir, timeoutMs: CHILD_GATE_TIMEOUT, occurrence: 1 };
	}

	/**
	 * The operator's executor in a supervised child on a client of its own (claim-time-path-git.test.ts:1601-1623):
	 * the eighth request itself, without the surface and so without the authority check (only the lease path), with
	 * the time path on as the surface sets it under `enabled: true` (surface/index.ts:2323).
	 */
	async startProbe(
		handle: ContextHandle,
		ticket: string,
		operationId: string,
		expectedRoot: string,
		gates: FileGate[],
	): Promise<ProbeSupervisor> {
		this.probeClient ??= await initClient(join(this.root, "client-probe"));
		this.sequence += 1;
		const command: TimePathCommand = {
			mode: "execute",
			journalDirectory: handle.context.journalDirectory,
			storage: { repository: this.probeClient, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT },
			ticket,
			contextDirectory: handle.directory,
			operationId,
			request: releaseRequest(expectedRoot),
			clockSkewMs: EPS,
			attempts: ATTEMPTS,
			timePath: true,
			clock: [T, T, T],
			gates,
		};
		const trace = resolve(this.root, `trace2-probe-${this.sequence}.json`);
		const supervisor = ProbeSupervisor.start(command, SUPERVISOR_LIFETIME, { ...process.env, [TRACE_VARIABLE]: trace });
		this.supervisors.push(supervisor);
		await supervisor.next("probe-started");
		return supervisor;
	}

	private startTrace(): void {
		this.previousTrace = process.env[TRACE_VARIABLE];
		process.env[TRACE_VARIABLE] = this.tracePath;
		this.tracing = true;
	}

	private stopTrace(): void {
		if (!this.tracing) return;
		this.tracing = false;
		if (this.previousTrace === undefined) Reflect.deleteProperty(process.env, TRACE_VARIABLE);
		else process.env[TRACE_VARIABLE] = this.previousTrace;
	}

	/** Releases every hold, settles every started call, ends every probe group and server, removes the root. */
	// adapted from claim-time-path-git.test.ts:1747-1762 and claim-mcp-git.test.ts:717-726
	async dispose(): Promise<string[]> {
		const problems: string[] = [];
		try {
			await this.hooks.releaseAll();
			await Promise.all(this.pendings.map((pending) => settleWithin("pending call", pending).catch(() => undefined)));
			for (const supervisor of this.supervisors) {
				const problem = await supervisor.shutdown();
				if (problem) problems.push(problem);
				problems.push(...supervisor.errors().map((reason) => `supervisor reported: ${reason}`));
			}
			for (const mcp of this.servers) await mcp.stop();
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup, a cleanup problem is shown. */
// adapted from claim-time-path-git.test.ts:1767-1782
async function withCase(
	format: ClaimStorageFormat,
	caseId: string,
	block: Partial<BlockOptions>,
	body: (c: EmergencyCase) => Promise<void>,
): Promise<void> {
	const run = await EmergencyCase.create(format, caseId, block);
	let failure: unknown;
	try {
		await body(run);
	} catch (error) {
		failure = error;
	}
	const problems = await run.dispose();
	if (failure !== undefined) throw failure;
	expect({ caseId, cleanupProblems: problems }).toEqual({ caseId, cleanupProblems: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// Views and expected documents (shapes as claim-mcp-git.test.ts:865-1027). Every value of a claim-operation
// is pinned; a message only as MESSAGE.
// ---------------------------------------------------------------------------------------------------------------

/** The whole document with a non-empty message replaced by MESSAGE (claim-mcp-git.test.ts:753-757). */
function masked(document: unknown): unknown {
	if (!isRecord(document)) return document;
	const body: Body = { ...document };
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return body;
}

/** The late A's `after` folded into LEASE_CAUSE when it is `stale` or `remote` (claim-time-path-git:930-943). */
function folded(document: unknown): unknown {
	const transition = field(document, "transition");
	const confirmation = field(transition, "confirmation");
	const after = field(confirmation, "after");
	if (!isRecord(document) || !isRecord(transition) || !isRecord(confirmation)) return document;
	if (after !== "stale" && after !== "remote") return document;
	return { ...document, transition: { ...transition, confirmation: { ...confirmation, after: LEASE_CAUSE } } };
}

function statusOf(document: unknown): unknown {
	return entryOf(document, "status");
}

/** The exit code of a document's status, -1 for anything outside the table. */
function exitOf(document: unknown): number {
	const status = field(document, "status");
	for (const [name, code] of Object.entries(CLAIM_EXIT_CODES)) if (name === status) return code;
	return -1;
}

/** A tool result as its error partition and its document (claim-mcp-git.test.ts:792-804). */
function toolView(result: unknown): Body {
	return { isError: entryOf(result, "isError"), document: masked(field(result, "structuredContent")) };
}

/**
 * The preview by the fields named for an ACTIVE claim, with its exit code; the envelope beyond `kind`, the
 * `owner | transition` alternative and the exact key set are em-p12's (level P). ASSUMPTION(preview exit):
 * a preview is a success document with exit 0.
 */
function previewView(document: unknown): Body {
	return {
		exit: exitOf(document),
		kind: entryOf(document, "kind"),
		ticket: entryOf(document, "ticket"),
		state: entryOf(document, "state"),
		owner: entryOf(document, "owner"),
		claimGeneration: entryOf(document, "claimGeneration"),
		epoch: entryOf(document, "epoch"),
		root: entryOf(document, "root"),
	};
}

/** The preview of OWNER's ACTIVE claim in epoch 1 with the exact root at the server. */
function activePreview(ticket: string, claimGeneration: number, root: string): Body {
	const kind = "claim-emergency-preview";
	return { exit: 0, kind, ticket, state: "active", owner: OWNER, claimGeneration, epoch: 1, root };
}

/** A child probe's executor result by kinds, IDs, counts and the evaluated ownership; roots stay out. */
function coreView(result: unknown): Body {
	const storage = field(result, "storage");
	const rights = field(result, "rights");
	return {
		kind: entryOf(result, "kind"),
		action: entryOf(result, "action"),
		operationId: entryOf(result, "operationId"),
		storage: { kind: entryOf(storage, "kind"), cause: entryOf(storage, "cause") },
		outcome: entryOf(field(result, "outcome"), "kind"),
		sends: entryOf(result, "sends"),
		ownership: entryOf(rights, "ownership"),
		claimGeneration: entryOf(rights, "claimGeneration"),
	};
}

/** A release through the executor with one send (execution/index.ts:107-143, :669-850). */
function coreOf(operationId: string, storage: Body, outcome: string, ownership: string): Body {
	return {
		kind: "operation",
		action: "emergency-release",
		operationId,
		storage,
		outcome,
		sends: 1,
		ownership,
		claimGeneration: 1,
	};
}

/** RightsView: the rights evaluation without observedRoot and reason (rights/index.ts:328-361). */
function rightsOf(ownership: string, workRight: Body, reclaim: Body, claimGeneration: number | null): Body {
	return { kind: "evaluated", scope: "observed-state-only", ownership, claimGeneration, workRight, reclaim };
}

/** The timeless mode never becomes reclaimable (rights/index.ts:238-241, :337-338). */
const NEVER: Body = { kind: "never" };
const NOT_APPLICABLE: Body = { kind: "not-applicable" };

function heldNone(claimGeneration: number): Body {
	return rightsOf("held", { kind: "live", renewalDue: null }, NEVER, claimGeneration);
}

function foreignNone(claimGeneration: number): Body {
	return rightsOf("foreign", { kind: "none", cause: "not-holder" }, NEVER, claimGeneration);
}

/** A FREE tombstone for every binding (rights/index.ts:340-346). */
function freeRights(claimGeneration: number): Body {
	return rightsOf("free", { kind: "none", cause: "free" }, NOT_APPLICABLE, claimGeneration);
}

/** Nobody works on PENDING; the hull decides the reclaim (rights/index.ts:348-350). */
function pendingRights(claimGeneration: number): Body {
	return rightsOf("pending", { kind: "none", cause: "pending" }, { kind: "not-yet", boundary: HULL }, claimGeneration);
}

/** PlannedDisplay of a timeless ACTIVE successor. */
function nonePlanned(claimGeneration: number): Body {
	return { status: "active", claimGeneration, timing: { mode: "none" }, capped: false };
}

/** PlannedDisplay of a FREE tombstone: no timing, never capped (surface/index.ts:1546-1554). */
function freePlanned(claimGeneration: number): Body {
	return { status: "free", claimGeneration, timing: null, capped: false };
}

/** A T call's `planned` shows the target it moves to, generation 2 with H2 (execution :371-378). */
const TARGET_PLANNED: Body = {
	status: "active",
	claimGeneration: 2,
	timing: { mode: "hard", hardEnd: H2, graceMs: GRACE },
	capped: false,
};

/** The claim-operation document with every key; absent optional fields are null (claim-mcp-git.test.ts:896-913). */
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
		stoppedBy: null,
		planned: fields.planned ?? null,
		rights: fields.rights,
	};
}

// adapted from claim-mcp-git.test.ts:915-935
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

/** A release that applied: FREE with generation `claimGeneration`, seen FREE by the operator. */
function releasedBody(ticket: string, operationId: string, claimGeneration: number): Body {
	const planned = freePlanned(claimGeneration);
	return appliedBody("emergency-release", ticket, operationId, planned, freeRights(claimGeneration));
}

/** Plan rejections persist nothing: no operation ID, storage or planned display (surface/index.ts:1626-1656). */
function planRejectedBody(command: string, ticket: string, cause: string, rights: Body): Body {
	return operationBody({
		status: "rejected",
		command,
		ticket,
		operationId: null,
		outcome: "rejected",
		rejection: { stage: "plan", cause },
		sends: 0,
		rights,
	});
}

// adapted from claim-mcp-git.test.ts:968-980
function errorBody(
	command: string,
	status: string,
	code: string,
	ticket: string | null,
	operationId: string | null = null,
): Body {
	return { schemaVersion: 1, kind: "claim-error", status, command, code, message: MESSAGE, ticket, operationId };
}

/** claim-resolution (surface/index.ts:1741-1790): status = outcome; `transition` only for a T call's P ID. */
function resolutionBody(fields: ResolutionFields): Body {
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-resolution",
		status: fields.status,
		command: "resolve",
		operationId: fields.operationId,
		ticket: fields.ticket,
		action: fields.action,
		outcome: fields.status,
		query: { kind: "resolved", resolution: fields.resolution },
	};
	if (fields.transition !== undefined) body.transition = fields.transition;
	return body;
}

/** A complete list observed at T (claim-mcp-git.test.ts:1012-1015). */
function listBody(claims: Body[]): Body {
	return { schemaVersion: 1, kind: "claim-list", status: "ok", command: "list", complete: true, observedAt: T, claims };
}

/** A FREE list entry at epoch 1 (surface/index.ts:2927); rights only with a context. */
function freeEntry(ticket: string, claimGeneration: number, rights?: Body): Body {
	const entry: Body = { ticket, state: "free", claimGeneration, epoch: 1 };
	if (rights !== undefined) entry.rights = rights;
	return entry;
}

/** A timeless ACTIVE list entry of OWNER at epoch 1 (surface/index.ts:2928-2930). */
function activeEntry(ticket: string, claimGeneration: number, rights?: Body): Body {
	const entry: Body = { ticket, state: "active", owner: OWNER, claimGeneration, epoch: 1, timing: { mode: "none" } };
	if (rights !== undefined) entry.rights = rights;
	return entry;
}

/** A PENDING entry with both display names and the hull, no owner or timing (surface:2919-2925). */
function pendingEntry(ticket: string): Body {
	return {
		ticket,
		state: "pending",
		claimGeneration: 2,
		epoch: 1,
		transition: { from: OWNER, to: TARGET_OWNER },
		reclaimBoundary: HULL,
	};
}

/**
 * The positive control of a run (catches: the typed scaffold, whose planner answers the eighth action with a fixed
 * rejection; a listed operator the surface does not authorise; an authority ID derived other than the specified way):
 * the holder acquires CONTROL_TICKET and the listed operator releases it at its exact root, a FREE tombstone of the
 * same generation. The ticket is the run's own, so no later root equals one of it.
 */
async function releaseControl(c: EmergencyCase, parties: Parties, caseId: string): Promise<void> {
	const acquired = await c.acquire(parties.holder, CONTROL_TICKET, `op-${caseId}-control-acquire`);
	const root = await c.ticketRoot(CONTROL_TICKET);
	const released = await c.release(parties.operator, CONTROL_TICKET, root, `op-${caseId}-control`);
	const label = `${caseId} positive control (catches: the scaffold's fixed rejection, a listed operator refused)`;
	expect({ label, acquired: statusOf(acquired), released: masked(released) }).toEqual({
		label,
		acquired: "applied",
		released: releasedBody(CONTROL_TICKET, `op-${caseId}-control`, 1),
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The cases, each on blob, tree and commit-chain. An own open intent pauses a further call of the same
// context on the same ticket only while that ticket's root is unchanged (pause/index.ts:96-121); no mutation below
// meets one, because every earlier intent of the calling context landed, was a plan rejection or names another root.
// em-g08's declined release stays open at r on purpose; only retry and resolve follow it, and neither ever pauses
// (surface/index.ts:2742, :2850).
// ---------------------------------------------------------------------------------------------------------------

for (const format of FORMATS) {
	describe(`claim emergency release through the surface core over real Git (${format})`, () => {
		test(
			"em-g01: releases a timeless claim without the holder; FREE keeps the generation, the next acquire takes +1",
			async () => {
				await withCase(format, "em-g01", {}, async (c) => {
					const { holder, operator, other } = await c.parties();
					const acquired = await c.acquire(holder, TICKET, "op-em-g01-acquire");
					const root = await c.ticketRoot(TICKET);

					// Positive control (catches: the scaffold's fixed rejection of the eighth action; a release that checks the
					// caller's binding, the generation, the time or the mode;): the operator, who never held
					// the claim, releases the holder's timeless claim at its exact root.
					const released = await c.release(operator, TICKET, root, "op-em-g01-release");
					expect({ acquired: masked(acquired), released: masked(released) }).toEqual({
						acquired: appliedBody("acquire", TICKET, "op-em-g01-acquire", nonePlanned(1), heldNone(1)),
						released: releasedBody(TICKET, "op-em-g01-release", 1),
					});

					// (catches: a tombstone of another generation or shape, a reassignment, a proof of the holder
					// read or imported): the stored claim is exactly the FREE tombstone of generation 1, the list shows it free,
					// the holder's journal is untouched and the operator's holds the release alone.
					expect({
						stored: (await c.stored(TICKET)).payload,
						listed: masked(await c.list()),
						holderJournal: await c.records(holder),
						operatorJournal: await c.records(operator),
					}).toEqual({
						stored: { claimState: 1, status: "free", claimGeneration: 1 },
						listed: listBody([freeEntry(TICKET, 1)]),
						holderJournal: ["op-em-g01-acquire.json"],
						operatorJournal: ["op-em-g01-release.json"],
					});

					// The former holder learns it from its next renew, `free` before any mode rule
					// (transition/index.ts:463) (catches: a holder that still renews after the release). Nobody is assigned:
					// the next regular acquire takes generation 2 (transition/index.ts:450) (catches: a release that reassigned
					// the ticket or raised the generation itself).
					const renewed = await c.renew(holder, TICKET, "op-em-g01-renew");
					const taken = await c.acquire(other, TICKET, "op-em-g01-other", OTHER_OWNER);
					const takenPlanned = nonePlanned(2);
					expect({ renewed: masked(renewed), taken: masked(taken) }).toEqual({
						renewed: planRejectedBody("renew", TICKET, "free", freeRights(1)),
						taken: appliedBody("acquire", TICKET, "op-em-g01-other", takenPlanned, heldNone(2)),
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"em-g02: refuses an unauthorised operator with authority-required before any Git call, recording nothing",
			async () => {
				await withCase(format, "em-g02", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator, other } = parties;
					const listed = await c.authorityOf(operator);
					const traceMark = await c.gitCalls();

					// Positive control (catches: the scaffold, and an S2 trace that never records, so that zero Git calls below
					// would prove nothing): the listed operator releases CONTROL_TICKET, and its Git commands show in S2.
					await releaseControl(c, parties, "em-g02");
					expect({ traced: (await c.gitCalls()) > traceMark }).toEqual({ traced: true });

					await c.acquire(holder, TICKET, "op-em-g02-acquire");
					const root = await c.ticketRoot(TICKET);
					const foreign = [await c.authorityOf(holder), await c.authorityOf(other)];
					// The operator's binding digest in the list's form: valid by form, but not the authority ID.
					const lookalike = `ta1-${operator.context.binding.slice(4)}`;
					const rows: RefusalRow[] = [
						{
							label: "em-g02 no recovery_authorities key",
							catches: "a missing list read as allow-all",
							authorities: null,
							preview: false,
						},
						{
							label: "em-g02 a list of other contexts' IDs",
							catches: "any listed ID accepted, the holder's included",
							authorities: foreign,
							preview: false,
						},
						{
							label: "em-g02 the operator's binding in the list's form",
							catches: "the binding or its domain taken for the authority ID",
							authorities: [lookalike],
							preview: false,
						},
						{
							label: "em-g02 the preview under a list of other contexts' IDs",
							catches: "a preview without the release's authorisation",
							authorities: foreign,
							preview: true,
						},
					];
					for (const [index, row] of rows.entries()) {
						await c.writeBlock({ authorities: row.authorities });
						const before = await c.snapshot(operator);
						const mark = await c.gitCalls();
						const operationId = `op-em-g02-row-${index + 1}`;
						const document = row.preview
							? await c.preview(operator, TICKET)
							: await c.release(operator, TICKET, root, operationId);
						const label = `${row.label} (catches: ${row.catches})`;
						// Refused/5 locally, no record, no Git call, nothing pushed, every ref as before.
						expect({
							label,
							document: masked(document),
							exit: exitOf(document),
							gitCalls: (await c.gitCalls()) - mark,
							after: await c.snapshot(operator),
						}).toEqual({
							label,
							document: errorBody("emergency-release", "refused", "authority-required", TICKET),
							exit: 5,
							gitCalls: 0,
							after: before,
						});
					}

					// catches: a refusal that outlives the list: with the operator listed again, the same root releases.
					await c.writeBlock({ authorities: [listed] });
					const released = await c.release(operator, TICKET, root, "op-em-g02-release");
					expect(masked(released)).toEqual(releasedBody(TICKET, "op-em-g02-release", 1));
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"em-g03: a root moved after the preview ends the release as rejected stale-root in the plan, nothing recorded",
			async () => {
				await withCase(format, "em-g03", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator } = parties;

					// Positive control (catches: the scaffold, whose fixed rejection may well be `stale-root` itself).
					await releaseControl(c, parties, "em-g03");

					await c.acquire(holder, TICKET, "op-em-g03-acquire");
					const root = await c.ticketRoot(TICKET);
					const quiet = await c.snapshot(operator);
					const shown = await c.preview(operator, TICKET);
					// (catches: a preview without the exact root, one that sends, records or pauses): r is the root
					// the server shows, and nothing moved.
					expect({ shown: previewView(shown), after: await c.snapshot(operator) }).toEqual({
						shown: activePreview(TICKET, 1, root),
						after: quiet,
					});

					// The holder moves its root: in the timeless mode a change-bounds to the same timing is a planned write
					// (transition/index.ts:496-499); a renew would be `not-renewable` (transition/index.ts:510).
					const touched = await c.touch(holder, TICKET, "op-em-g03-touch");
					const moved = await c.ticketRoot(TICKET);
					const beforeRelease = await c.snapshot(operator);
					const stale = await c.release(operator, TICKET, root, "op-em-g03-stale");
					// (catches: a release planned on the fresh read instead of the expected root, a stale-root
					// that records an intent or pushes, a new error code instead of the plan cause): rejected/2 in the plan.
					expect({
						touched: masked(touched),
						moved: moved !== root,
						stale: masked(stale),
						exit: exitOf(stale),
						after: await c.snapshot(operator),
					}).toEqual({
						touched: appliedBody("change-bounds", TICKET, "op-em-g03-touch", nonePlanned(1), heldNone(1)),
						moved: true,
						stale: planRejectedBody("emergency-release", TICKET, "stale-root", foreignNone(1)),
						exit: 2,
						after: beforeRelease,
					});

					// catches: a preview that keeps an old root, a stale-root that never clears: the fresh preview shows r',
					// and the release at r' applies.
					const fresh = await c.preview(operator, TICKET);
					const released = await c.release(operator, TICKET, moved, "op-em-g03-release");
					expect({ fresh: previewView(fresh), released: masked(released) }).toEqual({
						fresh: activePreview(TICKET, 1, moved),
						released: releasedBody(TICKET, "op-em-g03-release", 1),
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"em-g04: a root moved between the release's read and its push fails at the lease; the holder keeps the claim",
			async () => {
				await withCase(format, "em-g04", {}, async (c) => {
					const { holder, operator } = await c.parties();

					// Positive control (catches: a probe or executor without the eighth action, the scaffold's fixed rejection):
					// one ungated child run releases CONTROL_TICKET at its exact root, D-call clock reads (plan, final rights).
					await c.acquire(holder, CONTROL_TICKET, "op-em-g04-control-acquire");
					const controlRoot = await c.ticketRoot(CONTROL_TICKET);
					const control = await c.startProbe(operator, CONTROL_TICKET, "op-em-g04-control", controlRoot, []);
					const controlOutput = await control.output<ExecuteOutput>();
					const freedControl = await c.ticketRoot(CONTROL_TICKET);
					expect({
						control: coreView(controlOutput.result),
						landed: field(field(controlOutput.result, "storage"), "root") === freedControl,
						moved: freedControl !== controlRoot,
						clockCalls: controlOutput.clockCalls,
					}).toEqual({
						control: coreOf("op-em-g04-control", { kind: "applied", cause: ABSENT }, "applied", "free"),
						landed: true,
						moved: true,
						clockCalls: 2,
					});

					await c.acquire(holder, TICKET, "op-em-g04-acquire");
					const root = await c.ticketRoot(TICKET);
					const gate = await c.fileGate();
					const child = await c.startProbe(operator, TICKET, "op-em-g04-release", root, [gate]);
					const reached = await child.reached(gate);
					// Between the release's read at r and its push the holder moves the root (transition/index.ts:496-499).
					const touched = await c.touch(holder, TICKET, "op-em-g04-touch");
					const moved = await c.ticketRoot(TICKET);
					await releaseGate(gate);
					const output = await child.output<ExecuteOutput>();
					// (catches: a push without the read root as lease, a retried or queried first send of a fresh
					// intent): the lease `--force-with-lease=<ref>:r` meets r' and the client reports stale info
					// (storage/index.ts:626-644); a fresh intent's first rejected send is final (execution/index.ts:513-515).
					expect({
						reached,
						touched: statusOf(touched),
						moved: moved !== root,
						output: coreView(output.result),
						clockCalls: output.clockCalls,
					}).toEqual({
						reached: true,
						touched: "applied",
						moved: true,
						output: coreOf("op-em-g04-release", { kind: "rejected", cause: "stale" }, "rejected", "foreign"),
						clockCalls: 2,
					});

					// The query of the record answers rejected/2: not stored at r', whose receipts are complete
					// (resolution/index.ts:147-151). The holder keeps the claim (catches: a release that landed after all).
					const resolved = await c.resolve(operator, "op-em-g04-release");
					expect({
						resolved: masked(resolved),
						exit: exitOf(resolved),
						root: await c.ticketRoot(TICKET),
						listed: masked(await c.list(holder)),
					}).toEqual({
						resolved: resolutionBody({
							status: "rejected",
							operationId: "op-em-g04-release",
							ticket: TICKET,
							action: "emergency-release",
							resolution: "not-stored",
						}),
						exit: 2,
						root: moved,
						listed: listBody([activeEntry(TICKET, 1, heldNone(1)), freeEntry(CONTROL_TICKET, 1, freeRights(1))]),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"em-g05: releases a PENDING at p with the target's generation; a late A fails at the lease, P stays history",
			async () => {
				// PENDING needs finite hard ends, so this case runs in the hard mode; A holds on purpose.
				await withCase(format, "em-g05", { mode: "hard", timeoutMs: HELD_SEND_TIMEOUT }, async (c) => {
					const parties = await c.parties();
					const { holder, operator, other: receiver } = parties;
					const confirmId = claimConfirmationId("op-em-g05-p1");

					// Positive control (catches: the scaffold; a release refused in the hard mode).
					await releaseControl(c, parties, "em-g05");

					// Row i on TICKET: the holder's restart to H2 lands P at p (generation 1 → target 2); its witness A holds
					// in pre-receive (claim-time-path-git.test.ts:1932-1944, tpg-07).
					const acquired = await c.acquire(holder, TICKET, "op-em-g05-acquire-1");
					const pre = await c.hooks.count("pre");
					await c.hooks.plan("pre", ["pass", "hold"], "pass");
					const transfer = c.start(c.transferRestart(holder, TICKET, "op-em-g05-p1", receiver));
					const holding = await whilePending("em-g05 A holds", transfer, () => c.hooks.hasEntered("pre", pre + 2));
					const p = await c.ticketRoot(TICKET);
					// Fixture precondition (catches: a p that is no PENDING, an A that never held).
					expect({ acquired: statusOf(acquired), holding, listed: masked(await c.list()) }).toEqual({
						acquired: "applied",
						holding: true,
						listed: listBody([pendingEntry(TICKET), freeEntry(CONTROL_TICKET, 1)]),
					});
					// (catches: `pending-transition` for the eighth action, the source's generation 1, a
					// tombstone that reassigns): the release at p writes FREE with the target's generation 2.
					const released = await c.release(operator, TICKET, p, "op-em-g05-release-1");
					const freed = await c.ticketRoot(TICKET);
					await c.hooks.release("pre", pre + 2);
					const late = await settleWithin("em-g05 row i transfer", transfer);
					// The late A fails at the lease; queried, it is not stored at the release's root, and the witnessed P is
					// APPLIED (historical, superseded) (applied/0) (catches: an A that lands over
					// the release, a release that erased P's receipt).
					expect({
						released: masked(released),
						late: folded(masked(late)),
						root: await c.ticketRoot(TICKET),
						resolved: masked(await c.resolve(holder, "op-em-g05-p1")),
					}).toEqual({
						released: releasedBody(TICKET, "op-em-g05-release-1", 2),
						late: {
							...operationBody({
								status: "applied",
								command: "transfer",
								ticket: TICKET,
								operationId: "op-em-g05-p1",
								outcome: "applied",
								storage: { kind: "applied" },
								sends: 2,
								planned: TARGET_PLANNED,
								rights: freeRights(2),
							}),
							transition: {
								phase: "witnessed",
								confirmOperationId: confirmId,
								observeBefore: H,
								reclaimBoundary: HULL,
								confirmation: {
									kind: "queried",
									after: LEASE_CAUSE,
									query: { kind: "resolved", resolution: "not-stored" },
								},
							},
						},
						root: freed,
						resolved: resolutionBody({
							status: "applied",
							operationId: "op-em-g05-p1",
							ticket: TICKET,
							action: "transfer",
							resolution: "stored",
							transition: { phase: "witnessed", confirmOperationId: confirmId },
						}),
					});

					// Row ii on SECOND_TICKET: the observation reads H − EPS, too late for a witness (
					// claim-time-path-git.test.ts:2209-2229, tpg-04): PENDING at p without any A, outcome unknown/3.
					const acquired2 = await c.acquire(holder, SECOND_TICKET, "op-em-g05-acquire-2");
					const reads = [T, H - EPS, H - EPS];
					const unwitnessed = await c.transferRestart(holder, SECOND_TICKET, "op-em-g05-p2", receiver, reads);
					const p2 = await c.ticketRoot(SECOND_TICKET);
					const released2 = await c.release(operator, SECOND_TICKET, p2, "op-em-g05-release-2");
					// (catches: history invented for a P without witness once p is gone):
					// resolve of P answers unknown-history/4, P's single resolution staying `stored`.
					const resolved2 = await c.resolve(holder, "op-em-g05-p2");
					expect({
						acquired2: statusOf(acquired2),
						unwitnessed: masked(unwitnessed),
						released2: masked(released2),
						resolved2: masked(resolved2),
						exit: exitOf(resolved2),
						listed: masked(await c.list()),
					}).toEqual({
						acquired2: "applied",
						unwitnessed: {
							...operationBody({
								status: "unknown",
								command: "transfer",
								ticket: SECOND_TICKET,
								operationId: "op-em-g05-p2",
								outcome: "unknown",
								storage: { kind: "applied" },
								sends: 1,
								planned: TARGET_PLANNED,
								rights: pendingRights(2),
							}),
							transition: {
								phase: "pending",
								confirmOperationId: null,
								observeBefore: H,
								reclaimBoundary: HULL,
								confirmation: null,
							},
						},
						released2: releasedBody(SECOND_TICKET, "op-em-g05-release-2", 2),
						resolved2: resolutionBody({
							status: "unknown-history",
							operationId: "op-em-g05-p2",
							ticket: SECOND_TICKET,
							action: "transfer",
							resolution: "stored",
							transition: { phase: "pending", confirmOperationId: null },
						}),
						exit: 4,
						listed: listBody([freeEntry(TICKET, 2), freeEntry(SECOND_TICKET, 2), freeEntry(CONTROL_TICKET, 1)]),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"em-g06: releases under enabled: false, where acquire is claims-disabled (purpose maintain)",
			async () => {
				await withCase(format, "em-g06", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator, other } = parties;

					// Positive control (catches: the scaffold; enabled: false blamed for a release that fails anyway).
					await releaseControl(c, parties, "em-g06");

					await c.acquire(holder, TICKET, "op-em-g06-acquire");
					const root = await c.ticketRoot(TICKET);
					// Read per call: the block is switched off after the acquire.
					await c.writeBlock({ enabled: false });
					const disabled = await c.acquire(other, SECOND_TICKET, "op-em-g06-other", OTHER_OWNER);
					// CLAIM-DISABLE-001 (catches: the release on purpose `acquire`, config/index.ts:553-555): the
					// acquire proves the block is off, the release applies all the same.
					const released = await c.release(operator, TICKET, root, "op-em-g06-release");
					expect({ disabled: masked(disabled), released: masked(released), listed: masked(await c.list()) }).toEqual({
						disabled: errorBody("acquire", "refused", "claims-disabled", SECOND_TICKET),
						released: releasedBody(TICKET, "op-em-g06-release", 1),
						listed: listBody([freeEntry(TICKET, 1), freeEntry(CONTROL_TICKET, 1)]),
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"em-g07: keeps every receipt of the holder reachable and adds exactly one, under the release's own ID",
			async () => {
				await withCase(format, "em-g07", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator } = parties;

					// Positive control (catches: the scaffold).
					await releaseControl(c, parties, "em-g07");

					await c.acquire(holder, TICKET, "op-em-g07-acquire");
					await c.touch(holder, TICKET, "op-em-g07-touch");
					const root = await c.ticketRoot(TICKET);
					const before = await c.stored(TICKET);
					const holderJournal = await c.records(holder);
					const released = await c.release(operator, TICKET, root, "op-em-g07-release");
					const freed = await c.ticketRoot(TICKET);
					const own = await c.receiptOf(operator, "op-em-g07-release");
					const ids = ["op-em-g07-acquire", "op-em-g07-release", "op-em-g07-touch"];
					// Judge (catches: a release that drops or rewrites an old receipt, a receipt under a
					// foreign or second ID, the holder's journal read or imported): every receipt of revisions 1 and 2 stays
					// byte-equal; the new one is the executor's normal receipt of the operator's record.
					expect({
						released: masked(released),
						before: { revision: before.revision, receipts: keysOf(before.receipts) },
						after: await c.stored(TICKET),
						holderJournal: await c.records(holder),
						operatorJournal: await c.records(operator),
					}).toEqual({
						released: releasedBody(TICKET, "op-em-g07-release", 1),
						before: { revision: 2, receipts: ["op-em-g07-acquire", "op-em-g07-touch"] },
						after: {
							revision: 3,
							payload: { claimState: 1, status: "free", claimGeneration: 1 },
							receipts: { ...before.receipts, "op-em-g07-release": own },
						},
						holderJournal,
						operatorJournal: ["op-em-g07-control.json", "op-em-g07-release.json"],
					});
					// Per format (storage/README.md:18-22): blob and tree hold all three receipts inline, the
					// chain's new commit holds only its own and reaches the old ones over its one parent r (catches: a chain
					// restarted without parent, an inline format that lost the history).
					const chain = format === "commit-chain";
					expect({ layer: await c.layer(freed) }).toEqual({
						layer: chain ? { receipts: ["op-em-g07-release"], parents: [root] } : { receipts: ids, parents: [] },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"em-g08: MCP keeps its seven tools; claim_retry of a release record is authority-required, claim_resolve reads",
			async () => {
				await withCase(format, "em-g08", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator } = parties;
					const recordId = "op-em-g08-release";

					// Positive control (catches: the scaffold).
					await releaseControl(c, parties, "em-g08");

					// With mcp-p01 (claim-mcp.test.ts:1376-1395) (catches: an MCP tool for the release).
					const mcp = c.mcp();
					const names = (await mcp.testInterface.listTools()).tools.map((tool) => tool.name).sort(byCodeUnits);
					expect({ names, emergency: names.filter((name) => name.includes("emergency")) }).toEqual({
						names: [...SEVEN],
						emergency: [],
					});

					// The endpoint declines the release once (claim-mcp-git.test.ts:1258-1264): the record stays open at the
					// unchanged root r (resolution/index.ts:147), so a resend WOULD send.
					await c.acquire(holder, TICKET, "op-em-g08-acquire");
					const root = await c.ticketRoot(TICKET);
					await c.hooks.plan("pre", ["reject"], "pass");
					const declined = await c.release(operator, TICKET, root, recordId);
					await c.hooks.plan("pre", [], "pass");
					expect(masked(declined)).toEqual(
						operationBody({
							status: "rejected",
							command: "emergency-release",
							ticket: TICKET,
							operationId: recordId,
							outcome: "rejected",
							rejection: { stage: "storage", cause: "remote" },
							storage: { kind: "rejected", cause: "remote" },
							sends: 1,
							planned: freePlanned(1),
							rights: foreignNone(1),
						}),
					);

					// (catches: a lock only in the MCP adapter, a resend before the lock, `claim_retry` passing
					// the administrative option): over MCP and through the core with two arguments the record ends
					// authority-required with nothing sent or recorded.
					// ASSUMPTION(emergency release, surface/index.ts:2799-2801): like the claims-disabled lock, the refusal names
					// the record's ticket and ID. `claim_resolve` reads it.
					const quiet = await c.snapshot(operator);
					const args = { operationId: recordId, context: operator.directory };
					const overMcp = await c.tool(mcp, "claim_retry", args);
					const twoArguments = await c.retry(operator, recordId);
					const read = await c.tool(mcp, "claim_resolve", args);
					const locked = errorBody("retry", "refused", "authority-required", TICKET, recordId);
					expect({
						overMcp: toolView(overMcp),
						twoArguments: masked(twoArguments),
						read: toolView(read),
						after: await c.snapshot(operator),
					}).toEqual({
						overMcp: { isError: true, document: locked },
						twoArguments: locked,
						read: {
							isError: false,
							document: resolutionBody({
								status: "unknown",
								operationId: recordId,
								ticket: TICKET,
								action: "emergency-release",
								resolution: "open",
							}),
						},
						after: quiet,
					});

					// catches: a lock that refuses the CLI's administrative retry too: it resends the frozen release once.
					const retried = await c.retryAdministrative(operator, recordId);
					expect({
						retried: masked(retried),
						pushes: await c.pushes(),
						stored: (await c.stored(TICKET)).payload,
					}).toEqual({
						retried: appliedBody("retry", TICKET, recordId, freePlanned(1), freeRights(1), "emergency-release"),
						pushes: quiet.pushes + 1,
						stored: { claimState: 1, status: "free", claimGeneration: 1 },
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}
