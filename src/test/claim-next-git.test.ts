/**
 * Level G of `claim next`: the surface core `runClaimNext` in process against the loopback Git daemon of
 * claim-git-fixture.ts, blob only. Wall clock, monotonic clock, random, sleep and operation IDs come in through
 * ClaimSurfaceEnv; the mandatory seam `loadLocalTickets` is an in-memory board; a test-local S1 receive script
 * replaces the fixture's gate hooks of the server repository; S2 is the trace2 record of each client repository.
 * Oracles: O1 server refs, O2 one context journal by entry class, O3 Git commands and pushes of the calling client
 * repository, O4 calls of `newOperationId`, O5 calls of `loadLocalTickets`. Every g-nxt test but g-nxt-01, which is
 * that control itself, and g-dep-03 open with a healthy claim next of a context of their own; the typed
 * non-functional scaffold (`runClaimNext` answers `claim-error internal`, `mutate` has no gate) fails them there,
 * g-dep-01 at its first refusal and g-dep-02 at its claim next. Names the scaffold still has to add and what the
 * contract leaves open are marked ASSUMPTION, observations still due [?]. Holds and seams synchronize; no sleep does.
 * claim-git-fixture.ts and every existing test file stay unchanged. g-nxt-09 is the overlapping CAS loser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { claimJournalIO } from "../claims/journal/index.ts";
import { initializeClaimStorage } from "../claims/storage/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimLocalTickets,
	type ClaimMutationInput,
	type ClaimNextInput,
	type ClaimSurfaceEnv,
	type ClaimTicketSelection,
	runClaimMutation,
	runClaimNext,
	runClaimRetry,
} from "../claims/surface/index.ts";
import type { TaskCorpus } from "../core/task-detail.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";

type ContextHandle = { context: ClaimContext; directory: string; owner: string };
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type Sentinel = readonly [label: string, value: string];
type Body = Record<string, unknown>;
type MutationResult = Awaited<ReturnType<typeof runClaimMutation>>;
type RetryResult = Awaited<ReturnType<typeof runClaimRetry>>;
type NextResult = Awaited<ReturnType<typeof runClaimNext>>;
type AnyResult = MutationResult | RetryResult | NextResult;
/** One call's document with the Git commands and pushes S2 saw in the calling client repository meanwhile (O3). */
type Run<D> = { document: D; pushes: number; commands: number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type JournalSeam = typeof claimJournalIO;
type Policy = "strict" | "permissive";
type CaseSettings = { attemptTimeoutMs: number; attempts: number };
/** Per call: another client repository, a journal seam, fewer sends, the dependency policy key, a disabled block. */
type EnvOptions = {
	repository?: string;
	journalIO?: JournalSeam;
	attempts?: number;
	policy?: Policy;
	enabled?: boolean;
};
type NextStatus = "applied" | "rejected" | "unknown" | "unknown-history" | "refused" | "unavailable" | "paused";
type Excluded = { blocked: number; dependencyUnknown: number; notActionable: number };
type DependencyView = { blocking: string[]; unknown: string[]; unreadable: number };
type Diagnostic = { ticket: string; cause: "dependency-unknown"; dependencies: DependencyView };
/**
 * One base document inside `attempts` or returned by a direct call: its sorted keys and the facts a verdict rests on;
 * ABSENT marks a key the document does not have. Plan details and the rest of the rights are not pinned here.
 */
type AttemptView = {
	keys: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	action: unknown;
	ticket: unknown;
	operationId: unknown;
	outcome: unknown;
	rejection: unknown;
	storage: unknown;
	sends: unknown;
	stoppedBy: unknown;
	ownership: unknown;
	code: unknown;
};
type OperationView = { label: string; exit: number; document: AttemptView; echoed: string[] };
/** A whole public document with a non-empty message replaced by MESSAGE, its exit code and the echoed sentinels. */
type DocumentView = { label: string; exit: number; body: Body; echoed: string[] };
/** The claim-next document field by field, its attempts as AttemptView, exit and echoed sentinels. */
type NextView = {
	label: string;
	exit: number;
	keys: string[];
	schemaVersion: unknown;
	kind: unknown;
	status: unknown;
	command: unknown;
	order: unknown;
	maxCandidates: unknown;
	ticket: unknown;
	operationId: unknown;
	candidates: unknown;
	excluded: unknown;
	diagnostics: unknown;
	attempts: unknown;
	untried: unknown;
	stop: unknown;
	echoed: string[];
};
type NextSpec = {
	status: NextStatus;
	ticket: string | null;
	operationId: string | null;
	candidates: string[];
	attempts: AttemptView[];
	untried: number;
	stop: Record<string, unknown>;
	excluded?: Excluded;
	diagnostics?: Diagnostic[];
};
type OperationSpec = {
	status: string;
	command: string;
	action: string;
	ticket: string;
	operationId: string | null;
	outcome: string;
	rejection: Record<string, unknown> | null;
	storage: Record<string, unknown> | null;
	sends: number;
	stoppedBy: string | null;
	ownership: string;
};
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };
type TaskSpec = { priority?: string; status?: string; dependencies?: string[] };
/** g-nxt-07: one selection that leaves no candidate, with the counts and diagnostics the contract asks for. */
type EmptyRow = {
	label: string;
	catches: string;
	board: LocalBoard;
	selection: ClaimTicketSelection;
	excluded: Excluded;
	diagnostics: Diagnostic[];
};
/** g-dep-01: one refused direct acquire; `policy` undefined leaves the key out of the block. */
type GateRow = { label: string; policy: Policy | undefined; ticket: string };

const TEST_TIMEOUT = 60_000;
/** g-nxt-04/05 wait out three scripted holds of LOSS_TIMEOUT and run about twenty calls. */
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of the configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of the lost-reply rows (g-nxt-04: 2000); every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
/** Appears in the case root and the context parent; no document may contain it. */
const SENTINEL = "SENTINEL-next-git-7c41";
/** The only ticket of every leading positive control, so it never shares a key with a case. */
const CONTROL_TICKET = "BACK-9";
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-execution-retry.test.ts:81-82
const ABSENT_REF = "(no ref)";
/** Placeholder for a key a document does not have; no document value ever equals it. */
const ABSENT = "(absent)";
/** Display names only (no claim-next document carries an owner). */
const KARL = "agent-sentinel-karl";
const FRANZ = "agent-sentinel-franz";
const LENA = "agent-sentinel-lena";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock for claim times. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; only differences to it count. */
const MONO_START = 5_000;
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** Corpus statuses of every board; the last one, "Done", is terminal (terminal-status.ts:1-5). */
const STATUSES: readonly string[] = ["To Do", "In Progress", "Done"];
/** The configured priorities every load hands over (`ClaimLocalTickets.priorities`). */
const PRIORITIES: readonly string[] = ["high", "medium", "low"];
/** One creation minute for every task, so only priority and ID order candidates here; P pins the age rules. */
const CREATED = "2026-01-01 10:00";
/** The defaults of `--order` and `--max-candidates` (numbers proposed; qualification qualifies). */
const DEFAULT_ORDER = "priority";
const DEFAULT_MAX_CANDIDATES = 5;
/** A selection without filter or query: every working-copy task of the board is matched. */
const ALL: ClaimTicketSelection = { filter: {} };
const NONE_EXCLUDED: Excluded = { blocked: 0, dependencyUnknown: 0, notActionable: 0 };
/** Sorted by code units. */
const NEXT_KEYS = [
	"attempts",
	"candidates",
	"command",
	"diagnostics",
	"excluded",
	"kind",
	"maxCandidates",
	"operationId",
	"order",
	"schemaVersion",
	"status",
	"stop",
	"ticket",
	"untried",
];
/** The unchanged base claim-operation keys (surface/index.ts:322-338), sorted by code units. */
const OPERATION_KEYS = [
	"action",
	"command",
	"kind",
	"operationId",
	"outcome",
	"planned",
	"rejection",
	"rights",
	"schemaVersion",
	"sends",
	"status",
	"stoppedBy",
	"storage",
	"ticket",
];
/** The base claim-error keys without optional fields (surface/index.ts:401-413), sorted by code units. */
const ERROR_KEYS = ["code", "command", "kind", "message", "operationId", "schemaVersion", "status", "ticket"];
/** Written out, so the constant under test is not its own oracle. */
const EXIT: Record<NextStatus, number> = {
	applied: 0,
	rejected: 2,
	unknown: 3,
	"unknown-history": 4,
	refused: 5,
	unavailable: 6,
	paused: 7,
};

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-surface-git.test.ts:96-99
function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-execution-retry.test.ts:246-250
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** The value under `key`, or ABSENT when there is no such own key, so a missing key never passes as undefined. */
// adapted from claim-surface-git.test.ts:101-105 (field), ABSENT instead of undefined
function entryOf(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return ABSENT;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-execution-retry.test.ts:450-452
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:107-110
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-execution-retry.test.ts:291-294
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution-retry.test.ts:296-304
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Polls `condition` until it holds; fails after EVENT_TIMEOUT. */
// adapted from claim-execution-retry.test.ts:752-759
async function waitUntil(label: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

// adapted from claim-execution-retry.test.ts:672-675
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

// adapted from claim-surface-git.test.ts:112-118
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/**
 * S2, test-local and synchronous, so a monotonic seam can read it: every trace2 `start` argv of
 * `git -C <repository> ...` without that prefix. Product Git inherits GIT_TRACE2_EVENT (storage/index.ts:180-196).
 */
// adapted from claim-surface-git.test.ts:120-147
function gitCommandsOf(tracePath: string, repository: string): string[][] {
	let text: string;
	try {
		text = readFileSync(tracePath, "utf8");
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
		const argv = entryOf(event, "argv");
		if (entryOf(event, "event") !== "start" || !Array.isArray(argv)) continue;
		const args = argv.map(String);
		if (args[1] === "-C" && args[2] === repository) commands.push(args.slice(3));
	}
	return commands;
}

/** `op-<uuid v4>`; the first group names the case, the last one the sequence number within it. */
function operationId(caseNumber: number, n: number): string {
	return `op-${String(caseNumber).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function operationIds(caseNumber: number, first: number, count: number): string[] {
	return Array.from({ length: count }, (_, index) => operationId(caseNumber, first + index));
}

/** A local task (types/index.ts:46-88) created in the same minute as every other; unnamed fields stay empty. */
function task(id: string, spec: TaskSpec = {}): Task {
	const built: Task = {
		id,
		title: `Fixture ${id}`,
		status: spec.status ?? "To Do",
		assignee: [],
		createdDate: CREATED,
		labels: [],
		dependencies: spec.dependencies ?? [],
	};
	if (spec.priority !== undefined) built.priority = spec.priority;
	return built;
}

/** The stand-in filter: `status` (one or several) and `priority` only; level E (e-nxt-02) runs the real engine. */
function matches(entry: Task, filter: TaskListFilter): boolean {
	const statuses = filter.status === undefined ? undefined : [filter.status].flat();
	if (statuses !== undefined && !statuses.includes(entry.status)) return false;
	return filter.priority === undefined || entry.priority === filter.priority;
}

/**
 * The mandatory seam and oracle O5: an in-memory stand-in for `Core.queryTasks` plus `loadTaskCorpus`
 * of one checkout. A selection yields the matching working-copy tasks and the whole corpus; `null` yields the corpus
 * alone with `matched = []`. Every call is recorded as a copy of its argument. Under the strict default a
 * ticket missing from the corpus is `dependency-unknown`, so each board holds exactly the case's tickets.
 */
class LocalBoard {
	readonly calls: (ClaimTicketSelection | null)[] = [];
	unavailable = false;
	private readonly tasks: Task[];
	private readonly completed: Task[];

	constructor(tasks: readonly Task[], completed: readonly Task[] = []) {
		this.tasks = [...tasks];
		this.completed = [...completed];
	}

	/** Adds or replaces one working-copy task: the local ticket state changed between two calls. */
	put(changed: Task): void {
		const index = this.tasks.findIndex((entry) => entry.id === changed.id);
		if (index < 0) this.tasks.push(changed);
		else this.tasks[index] = changed;
	}

	// The one mandatory seam `loadLocalTickets(selection | null)`, shared with batch reclaim; unreadable tasks
	// answer `unavailable` (`tasks-unavailable`).
	readonly loadLocalTickets = (selection: ClaimTicketSelection | null): Promise<ClaimLocalTickets> => {
		const recorded: ClaimTicketSelection | null = selection === null ? null : JSON.parse(JSON.stringify(selection));
		this.calls.push(recorded);
		const corpus: TaskCorpus = { tasks: [...this.tasks], completedTasks: [...this.completed], statuses: STATUSES };
		const matched = selection === null ? [] : this.tasks.filter((entry) => matches(entry, selection.filter));
		const loaded: ClaimLocalTickets = this.unavailable
			? { kind: "unavailable" }
			: { kind: "loaded", matched, corpus, priorities: PRIORITIES };
		return Promise.resolve(loaded);
	};

	/** Local lookup of acquire: a task of this board is found under its canonical ID, nothing else is. */
	// adapted from claim-surface-git.test.ts:149-153
	readonly findLocalTicket = (input: string): Promise<LocalTicket> => {
		const known = [...this.tasks, ...this.completed].some((entry) => entry.id === input);
		const found: LocalTicket = known ? { kind: "found", ticket: input } : { kind: "missing" };
		return Promise.resolve(found);
	};
}

/** The monotonic, random, sleep and operation ID seams, scripted and recorded; nothing sleeps or draws. */
// adapted from claim-surface-git.test.ts:155-186, plus the O4 counter `calls`
class ScriptedSeams {
	readonly slept: number[] = [];
	draws = 0;
	private issued = 0;
	private readonly now: () => number;
	private readonly ids: readonly string[];

	constructor(now: () => number, ids: readonly string[]) {
		this.now = now;
		this.ids = ids;
	}

	/** O4: the number of operation IDs asked for so far, including one beyond the script. */
	get calls(): number {
		return this.issued;
	}

	readonly monotonicNow = (): number => this.now();

	readonly random = (): number => {
		this.draws += 1;
		return 0.5;
	};

	readonly sleep = (ms: number): Promise<void> => {
		this.slept.push(ms);
		return Promise.resolve();
	};

	readonly newOperationId = (): string => {
		const id = this.ids[this.issued];
		this.issued += 1;
		if (id === undefined) throw new Error("fixture: more operation IDs requested than scripted");
		return id;
	};
}

const steady = (): number => MONO_START;

/** A monotonic seam that reads MONO_START until `trigger` held once, then MONO_START + `jump` for good. */
// adapted from the bud-04 trigger, claim-surface-git.test.ts:431-437
function jumpingClock(trigger: () => boolean, jump: number): { now: () => number; jumped: () => boolean } {
	const state = { jumped: false };
	return {
		now: () => {
			if (!state.jumped && trigger()) state.jumped = true;
			return state.jumped ? MONO_START + jump : MONO_START;
		},
		jumped: () => state.jumped,
	};
}

/**
 * Journal IO that runs `act` once, right after `link` published `<operationId>.json` (journal/index.ts:329 via
 * :352): after the plan and before admission and first send of that operation (execution/index.ts:526, :546, :561).
 * The slot link (`.admission-<hex>`, :398 via :329) and the records of other operations pass untouched.
 */
// adapted from claim-execution.test.ts:817-827 (afterLink), with the target test of claim-execution-retry.test.ts:702
function afterRecordLink(id: string, act: () => Promise<void>): JournalSeam {
	const state = { fired: false };
	const linkThenAct = async (...args: Parameters<JournalSeam["link"]>) => {
		await claimJournalIO.link(...args);
		if (state.fired || !String(args[1]).endsWith(`/${id}.json`)) return;
		state.fired = true;
		await act();
	};
	return { ...claimJournalIO, link: linkThenAct as unknown as JournalSeam["link"] };
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-execution-retry.test.ts:790-814
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

/**
 * S1, test-local: scripted receive hooks of one server repository that count, pass, reject or hold pushes. Installed
 * over the gate-helper hooks that `initRepository` writes (claim-git-fixture.ts:219-231); without a plan every push
 * passes.
 */
// adapted from claim-execution-retry.test.ts:816-898, without invocations (hasEntered for g-nxt-09)
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

	/** Number of invocations of `phase` so far, entered or not. */
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

	/** Whether invocation `n` of `phase` has read its stdin and reached its action. */
	hasEntered(phase: ReceivePhase, n: number): Promise<boolean> {
		return exists(join(this.control, `${phase}-${n}`, "entered"));
	}

	/** Whether invocation `n` of `phase` has left its hold; `done` is written once and never removed. */
	hasFinished(phase: ReceivePhase, n: number): Promise<boolean> {
		return exists(join(this.control, `${phase}-${n}`, "done"));
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

/** One server repository with the S1 script, the project repository, a context parent and the S2 trace. */
// adapted from claim-surface-git.test.ts:188-381 (SurfaceCase), S1 installed as in claim-execution-retry.test.ts:972
class SurfaceCase {
	readonly root: string;
	readonly url: string;
	/** ClaimSurfaceEnv.projectRoot of every call that names no other client repository. */
	readonly project: string;
	/** Private 0700 parent of all contexts of this case, with the sentinel in its name. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	/** attempt_timeout_ms and attempts of the block; the lost-reply case lowers both (g-nxt-04). */
	settings: CaseSettings = { attemptTimeoutMs: ADAPTER_TIMEOUT, attempts: 3 };
	private readonly serverRepo: string;
	private readonly tracePath: string;
	/** Every context of the case; the sentinel scan covers all of them. */
	private readonly handles: ContextHandle[] = [];
	private previousTrace: string | undefined;
	private tracing = false;

	private constructor(root: string, url: string, serverRepo: string, project: string) {
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.project = project;
		this.parent = join(root, `contexts-${SENTINEL}`);
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.tracePath = resolve(root, "trace2-events.json");
	}

	static async create(caseName: string): Promise<SurfaceCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-next-git-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `next-${caseName}`);
			const project = await initClient(join(root, "project"));
			const surfaceCase = new SurfaceCase(root, server().url(name), repo, project);
			await surfaceCase.hooks.install();
			await mkdir(surfaceCase.parent);
			await chmod(surfaceCase.parent, 0o700);
			const initializer = await initClient(join(root, "client-initializer"));
			const initialized = await initializeClaimStorage({
				repository: initializer,
				remote: surfaceCase.url,
				format: "blob",
				timeoutMs: ADAPTER_TIMEOUT,
			});
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			surfaceCase.startTrace();
			return surfaceCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** A new private context; with `recoverFrom`, one that holds that context's proof (context/index.ts:22-26). */
	async context(owner: string, recoverFrom?: ContextHandle): Promise<ContextHandle> {
		const parent = this.parent;
		const options = recoverFrom === undefined ? { parent } : { parent, recoverFrom: recoverFrom.directory };
		const created = await createClaimContext(options);
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		const handle = { context: created.context, directory: dirname(created.context.journalDirectory), owner };
		this.handles.push(handle);
		return handle;
	}

	/** Another client repository, so a second party's Git stays out of the project repository's S2 record. */
	peer(label: string): Promise<string> {
		return initClient(join(this.root, `client-${label}`));
	}

	/** Configuration keys plus the three surface keys, all explicit; no start value is relied on. */
	claimsYaml(options: EnvOptions): string {
		const lines = [
			"claims:",
			`  enabled: ${options.enabled ?? true}`,
			`  endpoint: ${JSON.stringify(this.url)}`,
			"  storage_format: blob",
			"  lifetime_mode: lease",
			`  lease_ttl_ms: ${TTL}`,
			`  reclaim_grace_ms: ${GRACE}`,
			`  attempt_timeout_ms: ${this.settings.attemptTimeoutMs}`,
			`  attempts: ${options.attempts ?? this.settings.attempts}`,
			`  operation_budget_ms: ${BUDGET_MS}`,
			`  clock_uncertainty_ms: ${EPS}`,
			"  retry_pause_base_ms: 1",
			"  retry_pause_max_ms: 1",
		];
		// `claims.acquire_dependency_policy`, validated when present; absent means strict. Last line of the
		// block; the resolver's problem order (after `transfer_time_box`) plays no part here.
		if (options.policy !== undefined) lines.push(`  acquire_dependency_policy: ${options.policy}`);
		return lines.join("\n");
	}

	/** The base ClaimSurfaceEnv plus the mandatory `loadLocalTickets` seam, both lookups answered by `board`. */
	env(seams: ScriptedSeams, board: LocalBoard, options: EnvOptions = {}): ClaimSurfaceEnv {
		const env: ClaimSurfaceEnv = {
			projectRoot: options.repository ?? this.project,
			claimsYaml: this.claimsYaml(options),
			taskPrefix: "BACK",
			findLocalTicket: board.findLocalTicket,
			// The mandatory seam; ASSUMPTION(scaffold): a required field of the type.
			loadLocalTickets: board.loadLocalTickets,
			clock: () => T,
			monotonicNow: seams.monotonicNow,
			random: seams.random,
			sleep: seams.sleep,
			newOperationId: seams.newOperationId,
		};
		if (options.journalIO !== undefined) env.journalIO = options.journalIO;
		return env;
	}

	/** ASSUMPTION(scaffold): the `ClaimNextInput` type: one `claim next`'s parsed options; order, bound default. */
	nextInput(handle: ContextHandle, selection: ClaimTicketSelection): ClaimNextInput {
		return { owner: handle.owner, context: handle.directory, selection };
	}

	mutationInput(command: ClaimMutationInput["command"], ticket: string, handle: ContextHandle): ClaimMutationInput {
		const input: ClaimMutationInput = { command, ticket, context: handle.directory };
		if (command === "acquire") input.owner = handle.owner;
		return input;
	}

	async next(
		handle: ContextHandle,
		seams: ScriptedSeams,
		board: LocalBoard,
		selection: ClaimTicketSelection,
		options: EnvOptions = {},
	): Promise<Run<NextResult>> {
		const repository = options.repository ?? this.project;
		const mark = this.mark(repository);
		const document = await runClaimNext(this.nextInput(handle, selection), this.env(seams, board, options));
		return this.ran(document, mark, repository);
	}

	mutate(
		command: ClaimMutationInput["command"],
		ticket: string,
		handle: ContextHandle,
		seams: ScriptedSeams,
		board: LocalBoard,
		options: EnvOptions = {},
	): Promise<Run<MutationResult>> {
		return this.apply(this.mutationInput(command, ticket, handle), seams, board, options);
	}

	/** One direct mutation with a complete input, e.g. the administration commands. */
	async apply(
		input: ClaimMutationInput,
		seams: ScriptedSeams,
		board: LocalBoard,
		options: EnvOptions = {},
	): Promise<Run<MutationResult>> {
		const repository = options.repository ?? this.project;
		const mark = this.mark(repository);
		const document = await runClaimMutation(input, this.env(seams, board, options));
		return this.ran(document, mark, repository);
	}

	async retry(id: string, handle: ContextHandle, seams: ScriptedSeams, board: LocalBoard): Promise<Run<RetryResult>> {
		const mark = this.mark();
		const document = await runClaimRetry({ operationId: id, context: handle.directory }, this.env(seams, board));
		return this.ran(document, mark, this.project);
	}

	private ran<D>(document: D, mark: number, repository: string): Run<D> {
		const commands = this.commandsSince(mark, repository);
		return { document, pushes: commands.filter((args) => args[0] === "push").length, commands: commands.length };
	}

	/** O1. */
	// adapted from claim-surface-git.test.ts:279-288
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** O1 by name: the ticket refs the server holds, sorted by code units. */
	async claimRefs(): Promise<string[]> {
		return Object.keys(await this.serverRefs())
			.filter((ref) => ref.startsWith("refs/claims/"))
			.sort(byCodeUnits);
	}

	// adapted from claim-execution-retry.test.ts:1154-1156
	async ticketRoot(ticket: string): Promise<string> {
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** S2: the number of Git commands run so far in `repository`. */
	// adapted from claim-surface-git.test.ts:290-301
	mark(repository = this.project): number {
		return gitCommandsOf(this.tracePath, repository).length;
	}

	commandsSince(mark: number, repository = this.project): string[][] {
		return gitCommandsOf(this.tracePath, repository).slice(mark);
	}

	/** O2. */
	// adapted from claim-surface-git.test.ts:303-312
	async journalView(handle: ContextHandle): Promise<JournalView> {
		const names = (await readdir(handle.context.journalDirectory)).sort(byCodeUnits);
		const record = (name: string) => !name.startsWith(".") && name.endsWith(".json");
		const slot = (name: string) => name.startsWith(".admission-");
		return {
			records: names.filter(record),
			slots: names.filter(slot).length,
			other: names.filter((name) => !record(name) && !slot(name)),
		};
	}

	/** Releases pre-receive invocations since+1 to since+count and waits until each has left its hold. */
	// adapted from claim-execution-retry.test.ts:1194-1205
	async releaseHeld(since: number, count: number): Promise<void> {
		for (let n = since + 1; n <= since + count; n++) {
			await this.hooks.release("pre", n);
			await waitUntil(`receive pre-${n} to finish`, () => this.hooks.hasFinished("pre", n));
		}
	}

	/** Labels of the sentinels in `value`: paths, endpoint, owners, bindings, secrets, roots and digests. */
	async echoed(value: unknown): Promise<string[]> {
		return echoedIn(JSON.stringify(value), await this.sentinels());
	}

	// adapted from claim-surface-git.test.ts:314-335, over every context of the case and three owners
	private async sentinels(): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["endpoint", this.url],
			["owner karl", KARL],
			["owner franz", FRANZ],
			["owner lena", LENA],
		];
		for (const [ref, oid] of Object.entries(await this.serverRefs())) found.push([`root of ${ref}`, oid]);
		for (const handle of this.handles) {
			const { binding, journalDirectory } = handle.context;
			const secret = entryOf(JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8")), "secret");
			found.push(["binding", binding], ["context", handle.directory], ["journal", journalDirectory]);
			found.push(["secret", String(secret)]);
			for (const name of (await this.journalView(handle)).records) {
				const record: unknown = JSON.parse(await readFile(join(journalDirectory, name), "utf8"));
				found.push(["digest", String(entryOf(record, "digest"))]);
				found.push(["parameter digest", String(entryOf(record, "parameterDigest"))]);
			}
		}
		return found;
	}

	async nextView(label: string, document: NextResult): Promise<NextView> {
		const attempts = entryOf(document, "attempts");
		return {
			label,
			// The computation of claimExitCode (surface/index.ts:1053-1055), whatever union ClaimDocument ends up with.
			exit: CLAIM_EXIT_CODES[document.status],
			keys: keysOf(document),
			schemaVersion: entryOf(document, "schemaVersion"),
			kind: entryOf(document, "kind"),
			status: entryOf(document, "status"),
			command: entryOf(document, "command"),
			order: entryOf(document, "order"),
			maxCandidates: entryOf(document, "maxCandidates"),
			ticket: entryOf(document, "ticket"),
			operationId: entryOf(document, "operationId"),
			candidates: entryOf(document, "candidates"),
			excluded: entryOf(document, "excluded"),
			diagnostics: entryOf(document, "diagnostics"),
			attempts: Array.isArray(attempts) ? attempts.map(attemptViewOf) : attempts,
			untried: entryOf(document, "untried"),
			stop: entryOf(document, "stop"),
			echoed: await this.echoed(document),
		};
	}

	async operationView(label: string, document: MutationResult | RetryResult): Promise<OperationView> {
		return {
			label,
			exit: CLAIM_EXIT_CODES[document.status],
			document: attemptViewOf(document),
			echoed: await this.echoed(document),
		};
	}

	/** A fixed message never holds `/`; one that does is kept, so the comparison shows it. */
	// adapted from claim-surface-git.test.ts:357-362, plus the `/` rule
	async documentView(label: string, document: AnyResult): Promise<DocumentView> {
		const body: Body = Object.fromEntries(Object.entries(document));
		const { message } = body;
		if (typeof message === "string" && message.trim() !== "" && !message.includes("/")) body.message = MESSAGE;
		return { label, exit: CLAIM_EXIT_CODES[document.status], body, echoed: await this.echoed(document) };
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

	/** Releases every hold, restores the trace variable and removes the case root. */
	// adapted from claim-execution-retry.test.ts:1220-1229, without pending calls
	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-surface-git.test.ts:383-395
async function withCase(caseName: string, body: (fixture: SurfaceCase) => Promise<void>): Promise<void> {
	const fixture = await SurfaceCase.create(caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

function attemptViewOf(document: unknown): AttemptView {
	return {
		keys: keysOf(document),
		kind: entryOf(document, "kind"),
		status: entryOf(document, "status"),
		command: entryOf(document, "command"),
		action: entryOf(document, "action"),
		ticket: entryOf(document, "ticket"),
		operationId: entryOf(document, "operationId"),
		outcome: entryOf(document, "outcome"),
		rejection: entryOf(document, "rejection"),
		storage: entryOf(document, "storage"),
		sends: entryOf(document, "sends"),
		stoppedBy: entryOf(document, "stoppedBy"),
		ownership: entryOf(entryOf(document, "rights"), "ownership"),
		code: entryOf(document, "code"),
	};
}

/** A claim-operation document as base builds it (surface/index.ts:839-902); `attempts` keep it unchanged (10). */
function operationAttempt(spec: OperationSpec): AttemptView {
	return {
		keys: OPERATION_KEYS,
		kind: "claim-operation",
		status: spec.status,
		command: spec.command,
		action: spec.action,
		ticket: spec.ticket,
		operationId: spec.operationId,
		outcome: spec.outcome,
		rejection: spec.rejection,
		storage: spec.storage,
		sends: spec.sends,
		stoppedBy: spec.stoppedBy,
		ownership: spec.ownership,
		code: ABSENT,
	};
}

/** An acquire that applied with one send; rights come from the fresh final read (execution/index.ts:504-507). */
function appliedAttempt(ticket: string, id: string): AttemptView {
	return operationAttempt({
		status: "applied",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: id,
		outcome: "applied",
		rejection: null,
		storage: { kind: "applied" },
		sends: 1,
		stoppedBy: null,
		ownership: "held",
	});
}

/** A plan rejection: no record, no send, no operation ID (surface/index.ts:871-902); rights of the planning read. */
function planRejected(ticket: string, cause: "not-free" | "held"): AttemptView {
	return operationAttempt({
		status: "rejected",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: null,
		outcome: "rejected",
		rejection: { stage: "plan", cause },
		storage: null,
		sends: 0,
		stoppedBy: null,
		ownership: cause === "held" ? "held" : "foreign",
	});
}

/** The first send declined finally (execution/index.ts:571-573); rights from the fresh read after it. */
function storageRejected(ticket: string, id: string, cause: "stale" | "remote", ownership: string): AttemptView {
	return operationAttempt({
		status: "rejected",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: id,
		outcome: "rejected",
		rejection: { stage: "storage", cause },
		storage: { kind: "rejected", cause },
		sends: 1,
		stoppedBy: null,
		ownership,
	});
}

/** Every permitted send lost its reply and the query still finds the intent open (`stoppedBy: "attempts"`). */
function lostAttempt(ticket: string, id: string, sends: number, ownership: string): AttemptView {
	return operationAttempt({
		status: "unknown",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: id,
		outcome: "unknown",
		rejection: null,
		storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } },
		sends,
		stoppedBy: "attempts",
		ownership,
	});
}

/** A claim-error of the acquire core before any operation ID (surface/index.ts:658-681). */
function errorAttempt(ticket: string, code: string, status: string): AttemptView {
	return {
		keys: ERROR_KEYS,
		kind: "claim-error",
		status,
		command: "acquire",
		action: ABSENT,
		ticket,
		operationId: null,
		outcome: ABSENT,
		rejection: ABSENT,
		storage: ABSENT,
		sends: ABSENT,
		stoppedBy: ABSENT,
		ownership: ABSENT,
		code,
	};
}

/** The expected claim next view: the defaults and the status/exit table as documented. */
function expectedNext(label: string, spec: NextSpec): NextView {
	return {
		label,
		exit: EXIT[spec.status],
		keys: NEXT_KEYS,
		schemaVersion: 1,
		kind: "claim-next",
		status: spec.status,
		command: "next",
		order: DEFAULT_ORDER,
		maxCandidates: DEFAULT_MAX_CANDIDATES,
		ticket: spec.ticket,
		operationId: spec.operationId,
		candidates: spec.candidates,
		excluded: spec.excluded ?? NONE_EXCLUDED,
		diagnostics: spec.diagnostics ?? [],
		attempts: spec.attempts,
		untried: spec.untried,
		stop: spec.stop,
		echoed: [],
	};
}

function expectedOperation(label: string, exit: number, document: AttemptView): OperationView {
	return { label, exit, document, echoed: [] };
}

/** Fixture precondition of a set-up call: it applied. */
function expectApplied(label: string, run: Run<AnyResult>): void {
	expect({ label, status: run.document.status }).toEqual({ label, status: "applied" });
}

/**
 * Leading positive control of every g-nxt test but g-nxt-01, and of g-dep-03 (catches: seam, selection, attempt loop
 * or document not wired; the scaffold's runClaimNext answers `claim-error internal`): LENA, a context of its
 * own, claims the only local ticket BACK-9 with one push. LENA is not used again in any case.
 */
async function controlNext(fixture: SurfaceCase, caseNumber: number, label: string): Promise<Run<NextResult>> {
	const lena = await fixture.context(LENA);
	const board = new LocalBoard([task(CONTROL_TICKET, { priority: "high" })]);
	const id = operationId(caseNumber, 0);
	const run = await fixture.next(lena, new ScriptedSeams(steady, [id]), board, ALL);
	const expected = expectedNext(label, {
		status: "applied",
		ticket: CONTROL_TICKET,
		operationId: id,
		candidates: [CONTROL_TICKET],
		attempts: [appliedAttempt(CONTROL_TICKET, id)],
		untried: 0,
		stop: { kind: "claimed" },
	});
	expect(await fixture.nextView(label, run.document)).toEqual(expected);
	expect({ label, pushes: run.pushes }).toEqual({ label, pushes: 1 });
	return run;
}

describe("claim next over real Git (blob)", () => {
	test(
		"g-nxt-01: claims the first ready candidate by priority with one record, one push and one operation ID",
		async () => {
			await withCase("g-nxt-01", async (fixture) => {
				const karl = await fixture.context(KARL);
				// Positive control of the sentinel scan (catches: a scanner that never matches, so each echoed: [] is vacuous).
				expect(await fixture.echoed({ leak: `${fixture.url} ${KARL}` })).toEqual(["endpoint", "owner karl"]);

				const board = new LocalBoard([
					task("BACK-1", { priority: "high" }),
					task("BACK-2", { priority: "medium" }),
					task("BACK-3", { priority: "low" }),
				]);
				const id = operationId(1, 1);
				const seams = new ScriptedSeams(steady, operationIds(1, 1, 3));
				// Positive control (catches: seam, selection, preflight, stop, attempt or document not wired):
				// over three ready tickets of the configured priorities.
				const run = await fixture.next(karl, seams, board, ALL);
				const label = "g-nxt-01 claim next over three ready tickets (catches: more than one claim, a wrong ticket)";
				const expected = expectedNext(label, {
					status: "applied",
					ticket: "BACK-1",
					operationId: id,
					candidates: ["BACK-1", "BACK-2", "BACK-3"],
					attempts: [appliedAttempt("BACK-1", id)],
					untried: 2,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(label, run.document)).toEqual(expected);
				// O1 to O5 (catches: a second claim, a record, slot, push or ID per candidate, a second selection, a gate
				// skipped by the attempt).
				expect({
					refs: await fixture.claimRefs(),
					journal: await fixture.journalView(karl),
					pushes: run.pushes,
					operationIds: seams.calls,
					loads: board.calls,
				}).toEqual({
					refs: [refOf("BACK-1")],
					journal: { records: [`${id}.json`], slots: 1, other: [] },
					pushes: 1,
					operationIds: 1,
					// (derived): one load with the selection, then the strict gate of the acquire core
					// once per attempt (`null` = corpus only).
					loads: [ALL, null],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-02: a plan conflict records and sends nothing, and the search continues with the next candidate",
		async () => {
			await withCase("g-nxt-02", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 2, "g-nxt-02 positive control");
				const karl = await fixture.context(KARL);
				const franz = await fixture.context(FRANZ);
				const tickets = [
					task("BACK-1", { priority: "high" }),
					task("BACK-2", { priority: "medium" }),
					task("BACK-3", { priority: "low" }),
				];
				const id = (n: number) => operationId(2, n);
				// Set-up: FRANZ holds BACK-1 through a direct acquire from its own client repository.
				const franzRepo = await fixture.peer("franz");
				const franzSeams = new ScriptedSeams(steady, [id(90)]);
				const options = { repository: franzRepo };
				const held = await fixture.mutate("acquire", "BACK-1", franz, franzSeams, new LocalBoard(tickets), options);
				expectApplied("g-nxt-02 set-up: FRANZ holds BACK-1", held);

				// Row `not-free` → continue; the plan lies before `prepare` (execution/index.ts:488-489).
				// KARL's journal is empty; FRANZ's intent lives in FRANZ's journal.
				const board = new LocalBoard(tickets);
				const seams = new ScriptedSeams(steady, operationIds(2, 1, 3));
				const run = await fixture.next(karl, seams, board, ALL);
				const label = "g-nxt-02 claim next past a foreign claim (catches: a stop at the conflict)";
				const expected = expectedNext(label, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(2),
					candidates: ["BACK-1", "BACK-2", "BACK-3"],
					attempts: [planRejected("BACK-1", "not-free"), appliedAttempt("BACK-2", id(2))],
					untried: 1,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(label, run.document)).toEqual(expected);
				// O2 to O5 (catches: a record or push for the plan conflict, no fresh ID for attempt 2, the gate skipped).
				expect({
					journal: await fixture.journalView(karl),
					pushes: run.pushes,
					operationIds: seams.calls,
					loads: board.calls,
				}).toEqual({
					journal: { records: [`${id(2)}.json`], slots: 1, other: [] },
					pushes: 1,
					operationIds: 2,
					// (derived): one selection load, then one `null` load per attempt.
					loads: [ALL, null, null],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-03: a lost CAS continues, and the next call sees the lost record as settled, not as an open acquire",
		async () => {
			await withCase("g-nxt-03", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 3, "g-nxt-03 positive control");
				const karl = await fixture.context(KARL);
				const franz = await fixture.context(FRANZ);
				const tickets = [
					task("BACK-1", { priority: "high" }),
					task("BACK-2", { priority: "medium" }),
					task("BACK-3", { priority: "low" }),
				];
				const id = (n: number) => operationId(3, n);
				const franzRepo = await fixture.peer("franz");
				// As rej-01 (claim-execution.test.ts:3258-3281): once KARL's first record is linked, FRANZ acquires
				// BACK-1 from its own client repository, so KARL's send meets a newer root and loses the lease.
				const landing: { document: MutationResult | null } = { document: null };
				const journalIO = afterRecordLink(id(1), async () => {
					const franzSeams = new ScriptedSeams(steady, [id(90)]);
					const franzBoard = new LocalBoard(tickets);
					const options = { repository: franzRepo };
					const acquired = await fixture.mutate("acquire", "BACK-1", franz, franzSeams, franzBoard, options);
					landing.document = acquired.document;
				});
				const board = new LocalBoard(tickets);
				const seams = new ScriptedSeams(steady, operationIds(3, 1, 3));
				// KARL's journal is empty; FRANZ runs in its own context and journal. ASSUMPTION(claim next): every
				// attempt runs the acquire core with this env, so the journal seam reaches its executor (surface:1356).
				const lost = await fixture.next(karl, seams, board, ALL, { journalIO });
				const lostLabel = "g-nxt-03 claim next losing the CAS of BACK-1 (catches: stale read as a stop)";
				const lostExpected = expectedNext(lostLabel, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(2),
					candidates: ["BACK-1", "BACK-2", "BACK-3"],
					attempts: [storageRejected("BACK-1", id(1), "stale", "foreign"), appliedAttempt("BACK-2", id(2))],
					untried: 1,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(lostLabel, lost.document)).toEqual(lostExpected);
				// Fixture precondition and O2 to O4 (catches: a resend on the newer root, a landing outside link and send).
				expect({
					landed: landing.document?.status ?? ABSENT,
					journal: await fixture.journalView(karl),
					pushes: lost.pushes,
					operationIds: seams.calls,
				}).toEqual({
					landed: "applied",
					journal: { records: [`${id(1)}.json`, `${id(2)}.json`], slots: 2, other: [] },
					pushes: 2,
					operationIds: 2,
				});

				// Second call (g-nxt-03). KARL's own intents id(1) and id(2) no longer match their expected
				// root null (FRANZ's claim and KARL's own claim moved both roots), so neither the acquisition stop
				// nor the pause of an attempt holds; every attempt runs.
				const againSeams = new ScriptedSeams(steady, operationIds(3, 3, 4));
				const again = await fixture.next(karl, againSeams, board, ALL);
				const againLabel = "g-nxt-03 second claim next (catches: a lost CAS record read as open, held as a stop)";
				const againExpected = expectedNext(againLabel, {
					status: "applied",
					ticket: "BACK-3",
					operationId: id(5),
					candidates: ["BACK-1", "BACK-2", "BACK-3"],
					attempts: [
						planRejected("BACK-1", "not-free"),
						planRejected("BACK-2", "held"),
						appliedAttempt("BACK-3", id(5)),
					],
					untried: 0,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(againLabel, again.document)).toEqual(againExpected);
				expect({
					refs: await fixture.claimRefs(),
					journal: await fixture.journalView(karl),
					pushes: again.pushes,
					operationIds: againSeams.calls,
				}).toEqual({
					refs: [refOf("BACK-1"), refOf("BACK-2"), refOf("BACK-3"), refOf(CONTROL_TICKET)],
					journal: { records: [`${id(1)}.json`, `${id(2)}.json`, `${id(5)}.json`], slots: 3, other: [] },
					pushes: 1,
					operationIds: 3,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-04 g-nxt-05: an unknown acquire stops the call, and this context's next claims wait until it is settled",
		async () => {
			await withCase("g-nxt-04", async (fixture) => {
				fixture.settings = { attemptTimeoutMs: LOSS_TIMEOUT, attempts: 2 };
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 4, "g-nxt-04 positive control");
				const karl = await fixture.context(KARL);
				const franz = await fixture.context(FRANZ);
				const tickets = [task("BACK-1", { priority: "high" }), task("BACK-2", { priority: "medium" })];
				const board = new LocalBoard(tickets);
				const id = (n: number) => operationId(4, n);

				// g-nxt-04 (row `unknown`): pre-receive holds sends 1 and 2 of attempt 1 past
				// attempt_timeout_ms and declines them afterwards, as the rsm-05 set-up
				// (claim-execution-retry.test.ts:1601-1625). KARL's journal is empty.
				const since = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["hold-reject", "hold-reject"], "pass");
				const lostSeams = new ScriptedSeams(steady, operationIds(4, 1, 2));
				const lost = await fixture.next(karl, lostSeams, board, ALL);
				const lostLabel = "g-nxt-04 claim next with two lost replies (catches: unknown read as a conflict)";
				const lostExpected = expectedNext(lostLabel, {
					status: "unknown",
					ticket: "BACK-1",
					operationId: id(1),
					candidates: ["BACK-1", "BACK-2"],
					attempts: [lostAttempt("BACK-1", id(1), 2, "absent")],
					untried: 1,
					stop: { kind: "attempt" },
				});
				expect(await fixture.nextView(lostLabel, lost.document)).toEqual(lostExpected);
				// O1 to O4 (catches: a reservation of BACK-2 after the unknown, a second ID, the holds not reached).
				expect({
					receives: (await fixture.hooks.count("pre")) - since,
					pushes: lost.pushes,
					operationIds: lostSeams.calls,
					journal: await fixture.journalView(karl),
					first: await fixture.ticketRoot("BACK-1"),
					second: await fixture.ticketRoot("BACK-2"),
				}).toEqual({
					receives: 2,
					pushes: 2,
					operationIds: 1,
					journal: { records: [`${id(1)}.json`], slots: 1, other: [] },
					first: ABSENT_REF,
					second: ABSENT_REF,
				});
				await fixture.releaseHeld(since, 2);
				// Fixture precondition: both declined sends left BACK-1 absent, so id(1) stays open at its expected root null.
				expect({ first: await fixture.ticketRoot("BACK-1") }).toEqual({ first: ABSENT_REF });

				// g-nxt-05 (a): only BACK-2 is selected, which the executor pause alone would let through (other
				// ticket). Deliberate pause case — id(1) is KARL's own acquire, open at root null.
				const onlySecond: ClaimTicketSelection = { filter: { priority: "medium" } };
				const waitingSeams = new ScriptedSeams(steady, [id(3)]);
				const waitingLoads = board.calls.length;
				const waitingJournal = await fixture.journalView(karl);
				const waiting = await fixture.next(karl, waitingSeams, board, onlySecond);
				const waitingLabel = "g-nxt-05 (a) claim next of another ticket (catches: a stop on the candidate only)";
				const waitingExpected = expectedNext(waitingLabel, {
					status: "paused",
					// ASSUMPTION(claim next): without an attempt the document names neither a ticket nor an operation ID.
					ticket: null,
					operationId: null,
					candidates: ["BACK-2"],
					attempts: [],
					// ASSUMPTION(claim next): the selection precedes the stop; its candidates stay untried.
					untried: 1,
					stop: { kind: "outstanding-acquire", operationIds: [id(1)] },
				});
				expect(await fixture.nextView(waitingLabel, waiting.document)).toEqual(waitingExpected);
				// The stop comes after the selection, with zero attempts, so no gate load.
				expect({
					pushes: waiting.pushes,
					operationIds: waitingSeams.calls,
					loads: board.calls.slice(waitingLoads),
					journal: await fixture.journalView(karl),
					second: await fixture.ticketRoot("BACK-2"),
				}).toEqual({ pushes: 0, operationIds: 0, loads: [onlySecond], journal: waitingJournal, second: ABSENT_REF });

				// (b) FRANZ, another context, claims BACK-2 (catches: the stop reaching across contexts).
				// FRANZ's journal is empty; KARL's id(1) is not in it.
				const franzRepo = await fixture.peer("franz");
				const franzSeams = new ScriptedSeams(steady, [id(90), id(91)]);
				const franzBoard = new LocalBoard(tickets);
				const other = await fixture.next(franz, franzSeams, franzBoard, onlySecond, { repository: franzRepo });
				const otherLabel = "g-nxt-05 (b) FRANZ claims BACK-2 (catches: a stop across contexts)";
				const otherExpected = expectedNext(otherLabel, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(90),
					candidates: ["BACK-2"],
					attempts: [appliedAttempt("BACK-2", id(90))],
					untried: 0,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(otherLabel, other.document)).toEqual(otherExpected);

				// (c) the way out: KARL resends id(1); every hook passes now. Retry never pauses
				// (surface/index.ts:1382).
				const resent = await fixture.retry(id(1), karl, new ScriptedSeams(steady, []), board);
				const resentLabel = "g-nxt-05 (c) retry of the open acquire (catches: the way out blocked)";
				const resentExpected = expectedOperation(
					resentLabel,
					0,
					operationAttempt({
						status: "applied",
						command: "retry",
						action: "acquire",
						ticket: "BACK-1",
						operationId: id(1),
						outcome: "applied",
						rejection: null,
						storage: { kind: "applied" },
						sends: 1,
						stoppedBy: null,
						ownership: "held",
					}),
				);
				expect(await fixture.operationView(resentLabel, resent.document)).toEqual(resentExpected);
				expect({ pushes: resent.pushes }).toEqual({ pushes: 1 });

				// (d) BACK-3 appears locally. Id(1) landed through (c), its root moved off null, so neither the
				// stop nor the executor pause of an attempt holds any more.
				board.put(task("BACK-3", { priority: "low" }));
				const freedSeams = new ScriptedSeams(steady, operationIds(4, 4, 4));
				const freed = await fixture.next(karl, freedSeams, board, ALL);
				const freedLabel = "g-nxt-05 (d) claim next after the retry (catches: a stop that never lifts)";
				const freedExpected = expectedNext(freedLabel, {
					status: "applied",
					ticket: "BACK-3",
					operationId: id(6),
					candidates: ["BACK-1", "BACK-2", "BACK-3"],
					attempts: [
						planRejected("BACK-1", "held"),
						planRejected("BACK-2", "not-free"),
						appliedAttempt("BACK-3", id(6)),
					],
					untried: 0,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(freedLabel, freed.document)).toEqual(freedExpected);
				expect({ pushes: freed.pushes, operationIds: freedSeams.calls }).toEqual({ pushes: 1, operationIds: 3 });

				// (e) [?] Root equality of ls-remote and read (an observation, not contract): the only row whose open
				// acquire has a non-null expected root. KARL claims and releases BACK-5, so its ref holds a free state at R5.
				const tail = new LocalBoard([task("BACK-5", { priority: "high" }), task("BACK-6", { priority: "low" })]);
				// KARL has no intent on BACK-5 yet; the release runs at the root the acquire moved to.
				const claimedFifth = await fixture.mutate("acquire", "BACK-5", karl, new ScriptedSeams(steady, [id(8)]), tail);
				expectApplied("g-nxt-05 (e) set-up acquire", claimedFifth);
				const releasedFifth = await fixture.mutate("release", "BACK-5", karl, new ScriptedSeams(steady, [id(9)]), tail);
				expectApplied("g-nxt-05 (e) set-up release", releasedFifth);
				const freeRoot = await fixture.ticketRoot("BACK-5");
				const onlyFifth: ClaimTicketSelection = { filter: { priority: "high" } };
				const tailSince = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["hold-reject"], "pass");
				// KARL's acquire and release of BACK-5 both landed (the root moved twice), so the stop and the pause are
				// clear; one send only for this call.
				const overFree = await fixture.next(karl, new ScriptedSeams(steady, [id(10), id(11)]), tail, onlyFifth, {
					attempts: 1,
				});
				const overFreeLabel = "g-nxt-05 (e) claim next of a free ticket with a lost reply";
				const overFreeExpected = expectedNext(overFreeLabel, {
					status: "unknown",
					ticket: "BACK-5",
					operationId: id(10),
					candidates: ["BACK-5"],
					attempts: [lostAttempt("BACK-5", id(10), 1, "free")],
					untried: 0,
					stop: { kind: "attempt" },
				});
				expect(await fixture.nextView(overFreeLabel, overFree.document)).toEqual(overFreeExpected);
				await fixture.releaseHeld(tailSince, 1);
				// Fixture precondition: the declined send left the free state, so id(10) is open at its expected root R5.
				expect({ fifth: await fixture.ticketRoot("BACK-5") }).toEqual({ fifth: freeRoot });
				// Deliberate pause case, as (a). [?] The stop holds only if the root that ls-remote lists for BACK-5
				// equals the root the planning read recorded (storage/index.ts:334-344 against :350-377).
				const onlySixth: ClaimTicketSelection = { filter: { priority: "low" } };
				const heldSeams = new ScriptedSeams(steady, [id(12)]);
				const heldBack = await fixture.next(karl, heldSeams, tail, onlySixth);
				const heldLabel = "g-nxt-05 (e) claim next after the lost acquire (catches: ls-remote root ≠ read root)";
				const heldExpected = expectedNext(heldLabel, {
					status: "paused",
					ticket: null,
					operationId: null,
					candidates: ["BACK-6"],
					attempts: [],
					untried: 1,
					stop: { kind: "outstanding-acquire", operationIds: [id(10)] },
				});
				expect(await fixture.nextView(heldLabel, heldBack.document)).toEqual(heldExpected);
				expect({ pushes: heldBack.pushes, operationIds: heldSeams.calls }).toEqual({ pushes: 0, operationIds: 0 });
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"g-nxt-06: each attempt has an operation budget of its own, and a budget spent in attempt 1 stops the call",
		async () => {
			await withCase("g-nxt-06", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 6, "g-nxt-06 positive control");
				const karl = await fixture.context(KARL);
				const franz = await fixture.context(FRANZ);
				const id = (n: number) => operationId(6, n);
				const first = new LocalBoard([task("BACK-1", { priority: "high" }), task("BACK-2", { priority: "medium" })]);
				const franzSeams = new ScriptedSeams(steady, [id(90)]);
				const held = await fixture.mutate("acquire", "BACK-1", franz, franzSeams, first);
				expectApplied("g-nxt-06 set-up: FRANZ holds BACK-1", held);

				// (i): the clock jumps by BUDGET_MS − 1 once attempt 1's planning read of BACK-1 has
				// started (execution/index.ts:449), after every budget check of attempt 1. ASSUMPTION(claim next): the
				// pre-phase fetches no ticket ref, it only lists them.
				const mark = fixture.mark();
				const planningRead = () =>
					fixture
						.commandsSince(mark)
						.some((args) => args[0] === "fetch" && args.some((arg) => arg.startsWith(`${refOf("BACK-1")}:`)));
				const clock = jumpingClock(planningRead, BUDGET_MS - 1);
				const seams = new ScriptedSeams(clock.now, operationIds(6, 1, 3));
				// KARL's journal is empty; FRANZ's intent is in FRANZ's journal.
				const run = await fixture.next(karl, seams, first, ALL);
				const label = "g-nxt-06 (i) attempt 2 after a late clock jump (catches: one budget for the whole call)";
				const expected = expectedNext(label, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(2),
					candidates: ["BACK-1", "BACK-2"],
					attempts: [planRejected("BACK-1", "not-free"), appliedAttempt("BACK-2", id(2))],
					untried: 0,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(label, run.document)).toEqual(expected);
				expect({ jumped: clock.jumped(), slept: seams.slept, draws: seams.draws }).toEqual({
					jumped: true,
					slept: [],
					draws: 0,
				});

				// (ii) bud-04 (claim-surface-git.test.ts:431-470) moved to attempt 1: the clock jumps by the whole
				// budget once attempt 1's preflight contacted the endpoint — the first ls-remote after the one listing of
				// refs/claims/* (ASSUMPTION(claim next): the listing ends the pre-phase, before attempt 1).
				const second = new LocalBoard([task("BACK-3", { priority: "high" }), task("BACK-4", { priority: "medium" })]);
				const spentMark = fixture.mark();
				const afterListing = () => {
					const commands = fixture.commandsSince(spentMark);
					const listing = commands.findIndex((args) => args[0] === "ls-remote" && args.includes("refs/claims/*"));
					return listing >= 0 && commands.slice(listing + 1).some((args) => args[0] === "ls-remote");
				};
				const spentClock = jumpingClock(afterListing, BUDGET_MS);
				const spentSeams = new ScriptedSeams(spentClock.now, [id(4)]);
				const refs = await fixture.serverRefs();
				const journal = await fixture.journalView(karl);
				// KARL's only record, id(2) of (i), landed, so its root moved; attempt 1 of (i) recorded nothing.
				const spent = await fixture.next(karl, spentSeams, second, ALL);
				const spentLabel = "g-nxt-06 (ii) budget spent in attempt 1's preflight (catches: an ID, intent or send)";
				const spentExpected = expectedNext(spentLabel, {
					status: "unavailable",
					ticket: "BACK-3",
					operationId: null,
					candidates: ["BACK-3", "BACK-4"],
					attempts: [errorAttempt("BACK-3", "budget-exhausted", "unavailable")],
					untried: 1,
					stop: { kind: "attempt" },
				});
				expect(await fixture.nextView(spentLabel, spent.document)).toEqual(spentExpected);
				expect({
					jumped: spentClock.jumped(),
					pushes: spent.pushes,
					operationIds: spentSeams.calls,
					journal: await fixture.journalView(karl),
					refs: await fixture.serverRefs(),
				}).toEqual({ jumped: true, pushes: 0, operationIds: 0, journal, refs });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-07: an empty or unreadable selection ends without Git; a disabled block stops at the first preflight",
		async () => {
			await withCase("g-nxt-07", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`; an S2 record
				// that sees nothing, so every commands: 0 below would be vacuous).
				const control = await controlNext(fixture, 7, "g-nxt-07 positive control");
				expect({ commandsSeen: control.commands > 0 }).toEqual({ commandsSeen: true });
				const karl = await fixture.context(KARL);
				const id = (n: number) => operationId(7, n);
				const unfinished = new LocalBoard([
					task("BACK-1", { priority: "high", dependencies: ["BACK-5"] }),
					task("BACK-2", { priority: "high", dependencies: ["BACK-99"] }),
					task("BACK-3", { priority: "high", status: "Done" }),
					task("BACK-5", { priority: "medium", status: "In Progress" }),
				]);
				// An empty selection stays empty; blocked and unresolved tickets are counted and diagnosed.
				// None of these calls records an intent (no network before the selection).
				const rows: EmptyRow[] = [
					{
						label: "g-nxt-07 nothing matched",
						catches: "a preflight or listing before the selection, widening beyond the filter",
						board: new LocalBoard([task("BACK-1", { priority: "high" })]),
						selection: { filter: { priority: "low" } },
						excluded: NONE_EXCLUDED,
						diagnostics: [],
					},
					{
						label: "g-nxt-07 only blocked, unresolved and done tickets matched",
						catches: "blocked or unresolved tickets tried, an unqualified empty result (FP:421)",
						board: unfinished,
						selection: { filter: { priority: "high" } },
						excluded: { blocked: 1, dependencyUnknown: 1, notActionable: 1 },
						diagnostics: [
							{
								ticket: "BACK-2",
								cause: "dependency-unknown",
								dependencies: { blocking: [], unknown: ["BACK-99"], unreadable: 0 },
							},
						],
					},
				];
				for (const [index, row] of rows.entries()) {
					const label = `${row.label} (catches: ${row.catches})`;
					const seams = new ScriptedSeams(steady, [id(index + 1)]);
					const run = await fixture.next(karl, seams, row.board, row.selection);
					const expected = expectedNext(label, {
						status: "rejected",
						ticket: null,
						operationId: null,
						candidates: [],
						attempts: [],
						untried: 0,
						stop: { kind: "no-candidates" },
						excluded: row.excluded,
						diagnostics: row.diagnostics,
					});
					expect(await fixture.nextView(label, run.document)).toEqual(expected);
					// One load with the call's selection and no network.
					expect({ label, commands: run.commands, operationIds: seams.calls, loads: row.board.calls }).toEqual({
						label,
						commands: 0,
						operationIds: 0,
						loads: [row.selection],
					});
				}

				// Unreadable local tasks are `tasks-unavailable` (unavailable/6), the code shared with batch reclaim.
				const unreadable = new LocalBoard([task("BACK-1", { priority: "high" })]);
				unreadable.unavailable = true;
				const seams = new ScriptedSeams(steady, [id(9)]);
				const failed = await fixture.next(karl, seams, unreadable, ALL);
				const label = "g-nxt-07 unreadable local tasks (catches: Git before the selection, an empty list instead)";
				expect(await fixture.documentView(label, failed.document)).toEqual({
					label,
					exit: 6,
					body: {
						schemaVersion: 1,
						kind: "claim-error",
						status: "unavailable",
						command: "next",
						code: "tasks-unavailable",
						message: MESSAGE,
						ticket: null,
						operationId: null,
					},
					echoed: [],
				});
				expect({ commands: failed.commands, operationIds: seams.calls, loads: unreadable.calls }).toEqual({
					commands: 0,
					operationIds: 0,
					loads: [ALL],
				});

				// -28: `enabled: false` against the
				// selection. The local selection runs before the preflight, so the disabled block decides only once an
				// attempt reaches its preflight (the purpose gate, config/index.ts:502-504).
				const disabled: EnvOptions = { enabled: false };
				const ready = new LocalBoard([task("BACK-1", { priority: "high" }), task("BACK-2", { priority: "medium" })]);
				// Positive control (catches: a disabled block that never reaches the core, which would make the empty-selection
				// row below pass with claims enabled as well): a direct acquire of a ready ticket under it ends
				// `claims-disabled`/5 before any Git command and any operation ID (base behaviour, green on the scaffold).
				// KARL's journal is empty; nothing in this test records an intent.
				const directSeams = new ScriptedSeams(steady, [id(10)]);
				const direct = await fixture.mutate("acquire", "BACK-1", karl, directSeams, ready, disabled);
				expect({
					kind: entryOf(direct.document, "kind"),
					status: direct.document.status,
					code: entryOf(direct.document, "code"),
					commands: direct.commands,
					operationIds: directSeams.calls,
				}).toEqual({ kind: "claim-error", status: "refused", code: "claims-disabled", commands: 0, operationIds: 0 });

				// (a) disabled block, empty selection → `no-candidates`, rejected/2, without network (O3 = no Git command,
				// O4 = 0, O5 = the selection only). The positive control recorded nothing.
				const noneSeams = new ScriptedSeams(steady, [id(11)]);
				const lowOnly: ClaimTicketSelection = { filter: { priority: "low" } };
				const loadsBeforeNone = ready.calls.length;
				const none = await fixture.next(karl, noneSeams, ready, lowOnly, disabled);
				const noneLabel = "g-nxt-07 disabled block, nothing matched (catches: a preflight or refusal before selection)";
				const noneExpected = expectedNext(noneLabel, {
					status: "rejected",
					ticket: null,
					operationId: null,
					candidates: [],
					attempts: [],
					untried: 0,
					stop: { kind: "no-candidates" },
				});
				expect(await fixture.nextView(noneLabel, none.document)).toEqual(noneExpected);
				expect({
					commands: none.commands,
					operationIds: noneSeams.calls,
					loads: ready.calls.slice(loadsBeforeNone),
				}).toEqual({ commands: 0, operationIds: 0, loads: [lowOnly] });

				// (b) disabled block, two ready candidates → the first attempt's preflight ends `claims-disabled`; claim-next
				// is refused/5 with stop `attempt`, that base error document is the only attempt, the rest stays untried, and
				// nothing is recorded or pushed. No call of this test recorded an intent.
				const refusedSeams = new ScriptedSeams(steady, [id(12), id(13)]);
				const refs = await fixture.serverRefs();
				const loadsBeforeRefused = ready.calls.length;
				const refused = await fixture.next(karl, refusedSeams, ready, ALL, disabled);
				const refusedLabel =
					"g-nxt-07 disabled block, ready candidates (catches: a pre-loop claim-error, a second attempt, a record)";
				const refusedExpected = expectedNext(refusedLabel, {
					status: "refused",
					ticket: "BACK-1",
					operationId: null,
					candidates: ["BACK-1", "BACK-2"],
					attempts: [errorAttempt("BACK-1", "claims-disabled", "refused")],
					untried: 1,
					stop: { kind: "attempt" },
				});
				expect(await fixture.nextView(refusedLabel, refused.document)).toEqual(refusedExpected);
				expect({
					pushes: refused.pushes,
					operationIds: refusedSeams.calls,
					journal: await fixture.journalView(karl),
					refs: await fixture.serverRefs(),
					loads: ready.calls.slice(loadsBeforeRefused),
				}).toEqual({
					pushes: 0,
					operationIds: 0,
					journal: { records: [], slots: 0, other: [] },
					refs,
					// (derived): the selection, then the strict gate of attempt 1 before its preflight.
					loads: [ALL, null],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-08: a remote rejection stops the call, and this context's next claim then waits for the rejected intent",
		async () => {
			await withCase("g-nxt-08", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 8, "g-nxt-08 positive control");
				const karl = await fixture.context(KARL);
				const board = new LocalBoard([task("BACK-1", { priority: "high" }), task("BACK-2", { priority: "medium" })]);
				const id = (n: number) => operationId(8, n);

				// Row `storage remote` → stop 2: pre-receive declines the first push. KARL's journal
				// is empty.
				const since = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["reject"], "pass");
				const seams = new ScriptedSeams(steady, operationIds(8, 1, 2));
				const rejected = await fixture.next(karl, seams, board, ALL);
				const label = "g-nxt-08 claim next declined by the server (catches: remote read as isolated)";
				const expected = expectedNext(label, {
					status: "rejected",
					ticket: "BACK-1",
					operationId: id(1),
					candidates: ["BACK-1", "BACK-2"],
					attempts: [storageRejected("BACK-1", id(1), "remote", "absent")],
					untried: 1,
					stop: { kind: "attempt" },
				});
				expect(await fixture.nextView(label, rejected.document)).toEqual(expected);
				expect({
					receives: (await fixture.hooks.count("pre")) - since,
					pushes: rejected.pushes,
					operationIds: seams.calls,
					journal: await fixture.journalView(karl),
					first: await fixture.ticketRoot("BACK-1"),
					second: await fixture.ticketRoot("BACK-2"),
				}).toEqual({
					receives: 1,
					pushes: 1,
					operationIds: 1,
					journal: { records: [`${id(1)}.json`], slots: 1, other: [] },
					first: ABSENT_REF,
					second: ABSENT_REF,
				});

				// Follow-up (a finally rejected intent stays open at its root). Deliberate pause case
				// id(1) is KARL's own acquire, still open at its expected root null.
				const followSeams = new ScriptedSeams(steady, [id(3)]);
				const follow = await fixture.next(karl, followSeams, board, ALL);
				const followLabel = "g-nxt-08 follow-up claim next (catches: the stop ignoring rejected records)";
				const followExpected = expectedNext(followLabel, {
					status: "paused",
					ticket: null,
					operationId: null,
					candidates: ["BACK-1", "BACK-2"],
					attempts: [],
					untried: 2,
					stop: { kind: "outstanding-acquire", operationIds: [id(1)] },
				});
				expect(await fixture.nextView(followLabel, follow.document)).toEqual(followExpected);
				expect({ pushes: follow.pushes, operationIds: followSeams.calls }).toEqual({ pushes: 0, operationIds: 0 });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-nxt-09: the loser of an overlapping CAS continues with the next candidate, and the winner keeps the ticket",
		async () => {
			await withCase("g-nxt-09", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 12, "g-nxt-09 positive control");
				const karl = await fixture.context(KARL);
				const franz = await fixture.context(FRANZ);
				const franzRepo = await fixture.peer("franz");
				const tickets = [task("BACK-1", { priority: "high" }), task("BACK-2", { priority: "medium" })];
				const id = (n: number) => operationId(12, n);

				// Both acquires of BACK-1 pass their client lease check while
				// the ref is still absent and wait at pre-receive; KARL's is released first and lands, then FRANZ's meets the
				// landed ref at the server's old-value check. Both journals are empty.
				const since = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["hold", "hold"], "pass");
				const karlSeams = new ScriptedSeams(steady, operationIds(12, 1, 2));
				const winning = fixture.next(karl, karlSeams, new LocalBoard(tickets), ALL);
				await waitUntil("KARL's send held at pre-receive", () => fixture.hooks.hasEntered("pre", since + 1));
				const franzSeams = new ScriptedSeams(steady, operationIds(12, 11, 2));
				const losing = fixture.next(franz, franzSeams, new LocalBoard(tickets), ALL, { repository: franzRepo });
				await waitUntil("FRANZ's send held at pre-receive", () => fixture.hooks.hasEntered("pre", since + 2));
				await fixture.releaseHeld(since, 1);
				await waitUntil("KARL's root of BACK-1 on the server", async () => {
					return (await fixture.ticketRoot("BACK-1")) !== ABSENT_REF;
				});
				await fixture.releaseHeld(since + 1, 1);
				const [won, lost] = await Promise.all([winning, losing]);

				// Positive control (catches: a race set-up in which KARL does not win BACK-1 with one send).
				const wonLabel = "g-nxt-09 KARL wins BACK-1";
				const wonExpected = expectedNext(wonLabel, {
					status: "applied",
					ticket: "BACK-1",
					operationId: id(1),
					candidates: ["BACK-1", "BACK-2"],
					attempts: [appliedAttempt("BACK-1", id(1))],
					untried: 1,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(wonLabel, won.document)).toEqual(wonExpected);
				expect({ pushes: won.pushes, operationIds: karlSeams.calls }).toEqual({ pushes: 1, operationIds: 1 });
				// (catches: the overlapping loser read as storage `remote`, the call stopped at it):
				// FRANZ's refused send is read again, BACK-1 now holds KARL's root, so the attempt ends `stale` and the call
				// goes on to claim BACK-2.
				const lostLabel = "g-nxt-09 FRANZ loses the overlapping CAS of BACK-1";
				const lostExpected = expectedNext(lostLabel, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(12),
					candidates: ["BACK-1", "BACK-2"],
					attempts: [storageRejected("BACK-1", id(11), "stale", "foreign"), appliedAttempt("BACK-2", id(12))],
					untried: 0,
					stop: { kind: "claimed" },
				});
				expect(await fixture.nextView(lostLabel, lost.document)).toEqual(lostExpected);
				expect({ refs: await fixture.claimRefs(), pushes: lost.pushes, operationIds: franzSeams.calls }).toEqual({
					refs: [refOf("BACK-1"), refOf("BACK-2"), refOf(CONTROL_TICKET)],
					pushes: 2,
					operationIds: 2,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-dep-01: a direct acquire under the strict default refuses blocked and unresolved tickets before any Git",
		async () => {
			await withCase("g-dep-01", async (fixture) => {
				const karl = await fixture.context(KARL);
				const board = new LocalBoard([
					task("BACK-1", { dependencies: ["BACK-2"] }),
					task("BACK-2", { status: "In Progress" }),
					task("BACK-3", { dependencies: ["BACK-99"] }),
					task("BACK-4"),
				]);
				const id = (n: number) => operationId(9, n);
				// Positive control (catches: an acquire core that refuses a ready ticket or needs the key): BACK-4 has no
				// dependency and applies with one push; green on the scaffold.
				const control = await fixture.mutate("acquire", "BACK-4", karl, new ScriptedSeams(steady, [id(1)]), board);
				const controlLabel = "g-dep-01 positive control";
				const controlExpected = expectedOperation(controlLabel, 0, appliedAttempt("BACK-4", id(1)));
				expect(await fixture.operationView(controlLabel, control.document)).toEqual(controlExpected);
				expect({ pushes: control.pushes }).toEqual({ pushes: 1 });

				// Strict is the default and the written value alike; `isBlocked`, refused/5, no record, no
				// network. A refusal records nothing; KARL's only intent (BACK-4) landed.
				const blocked: DependencyView = { blocking: ["BACK-2"], unknown: [], unreadable: 0 };
				const unresolved: DependencyView = { blocking: [], unknown: ["BACK-99"], unreadable: 0 };
				const rows: GateRow[] = [
					{ label: "g-dep-01 strict by default, unfinished prerequisite", policy: undefined, ticket: "BACK-1" },
					{ label: "g-dep-01 strict by default, missing prerequisite", policy: undefined, ticket: "BACK-3" },
					{ label: "g-dep-01 strict written, unfinished prerequisite", policy: "strict", ticket: "BACK-1" },
					{ label: "g-dep-01 strict written, missing prerequisite", policy: "strict", ticket: "BACK-3" },
				];
				for (const row of rows) {
					const label = `${row.label} (catches: a gate after the network, blocked as ready, written ≠ default)`;
					const seams = new ScriptedSeams(steady, []);
					const journal = await fixture.journalView(karl);
					const loads = board.calls.length;
					const options: EnvOptions = row.policy === undefined ? {} : { policy: row.policy };
					const refused = await fixture.mutate("acquire", row.ticket, karl, seams, board, options);
					const first = row.ticket === "BACK-1";
					const body: Body = {
						schemaVersion: 1,
						kind: "claim-error",
						status: "refused",
						command: "acquire",
						code: first ? "dependency-blocked" : "dependency-unknown",
						message: MESSAGE,
						ticket: row.ticket,
						operationId: null,
						dependencies: first ? blocked : unresolved,
					};
					expect(await fixture.documentView(label, refused.document)).toEqual({ label, exit: 5, body, echoed: [] });
					expect({
						label,
						commands: refused.commands,
						operationIds: seams.calls,
						journal: await fixture.journalView(karl),
						loads: board.calls.slice(loads),
						// The strict gate loads the corpus once (`null` = corpus only).
					}).toEqual({ label, commands: 0, operationIds: 0, journal, loads: [null] });
				}

				// Permissive reserves without certifying readiness; no gate, no corpus load.
				// KARL has no intent on BACK-1, since every refusal recorded nothing.
				const loads = board.calls.length;
				const options: EnvOptions = { policy: "permissive" };
				const seams = new ScriptedSeams(steady, [id(2)]);
				const permissive = await fixture.mutate("acquire", "BACK-1", karl, seams, board, options);
				const label = "g-dep-01 permissive, unfinished prerequisite (catches: permissive ignored, a corpus load)";
				const expected = expectedOperation(label, 0, appliedAttempt("BACK-1", id(2)));
				expect(await fixture.operationView(label, permissive.document)).toEqual(expected);
				// Permissive has no gate and loads no corpus.
				expect({ pushes: permissive.pushes, loads: board.calls.slice(loads) }).toEqual({ pushes: 1, loads: [] });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-dep-02: maintenance, retry, transfer, resume and change-bounds skip the gate; claim next skips the ticket",
		async () => {
			await withCase("g-dep-02", async (fixture) => {
				const karl = await fixture.context(KARL);
				const board = new LocalBoard([
					task("BACK-4", { priority: "high" }),
					task("BACK-5", { priority: "low", status: "In Progress" }),
				]);
				const id = (n: number) => operationId(10, n);
				// Positive control (catches: an acquire core that refuses a ready ticket): green on the scaffold.
				const acquired = await fixture.mutate("acquire", "BACK-4", karl, new ScriptedSeams(steady, [id(1)]), board);
				const acquiredLabel = "g-dep-02 positive control";
				const acquiredExpected = expectedOperation(acquiredLabel, 0, appliedAttempt("BACK-4", id(1)));
				expect(await fixture.operationView(acquiredLabel, acquired.document)).toEqual(acquiredExpected);

				// A prerequisite reopens after the claim; the claim stays and maintenance never checks.
				board.put(task("BACK-4", { priority: "high", dependencies: ["BACK-5"] }));
				const loads = board.calls.length;
				// The acquire id(1) landed, so renew plans at the moved root.
				const renewed = await fixture.mutate("renew", "BACK-4", karl, new ScriptedSeams(steady, [id(2)]), board);
				// The renew id(2) landed, so release plans at the root it moved to.
				const released = await fixture.mutate("release", "BACK-4", karl, new ScriptedSeams(steady, [id(3)]), board);
				// Retry never pauses (surface/index.ts:1382); the record of id(1) is clarified as stored.
				const resent = await fixture.retry(id(1), karl, new ScriptedSeams(steady, []), board);
				const maintain = (command: string, n: number, ownership: string) =>
					operationAttempt({
						status: "applied",
						command,
						action: command,
						ticket: "BACK-4",
						operationId: id(n),
						outcome: "applied",
						rejection: null,
						storage: { kind: "applied" },
						sends: 1,
						stoppedBy: null,
						ownership,
					});
				const clarified = operationAttempt({
					status: "applied",
					command: "retry",
					action: "acquire",
					ticket: "BACK-4",
					operationId: id(1),
					outcome: "applied",
					rejection: null,
					storage: { kind: "queried", after: "earlier-process", query: { kind: "resolved", resolution: "stored" } },
					sends: 0,
					stoppedBy: null,
					ownership: "free",
				});
				expect([
					await fixture.operationView("g-dep-02 renew (catches: a gate on maintain)", renewed.document),
					await fixture.operationView("g-dep-02 release (catches: a gate on maintain)", released.document),
					await fixture.operationView("g-dep-02 retry (catches: a gate on retry)", resent.document),
				]).toEqual([
					expectedOperation("g-dep-02 renew (catches: a gate on maintain)", 0, maintain("renew", 2, "held")),
					expectedOperation("g-dep-02 release (catches: a gate on maintain)", 0, maintain("release", 3, "free")),
					expectedOperation("g-dep-02 retry (catches: a gate on retry)", 0, clarified),
				]);
				// Renew, release and retry never call the seam.
				expect({ loads: board.calls.slice(loads), pushes: [renewed.pushes, released.pushes, resent.pushes] }).toEqual({
					loads: [],
					pushes: [1, 1, 0],
				});

				// The contract, as frozen, names transfer, resume and change-bounds as well: the three
				// administration commands never check either. Pinned is the gate fact only — each call reaches its operation
				// ID, which is issued after the preflight, without loading the corpus; the plan outcome on the now free
				// ticket is administration's. ASSUMPTION(administration): `ClaimMutationInput` carries `toContext`, `mode`,
				// `leaseEnd` and `graceMs`, and `ClaimMutationCommand` the three commands (the administration commands landed
				// before claim next).
				const lena = await fixture.context(LENA);
				const recovered = await fixture.context(KARL, karl);
				const leaseEnd = new Date(T + TTL).toISOString();
				const administration: { label: string; input: ClaimMutationInput }[] = [
					{
						label: "g-dep-02 transfer to LENA",
						input: {
							command: "transfer",
							ticket: "BACK-4",
							context: karl.directory,
							owner: LENA,
							toContext: lena.directory,
						},
					},
					{
						label: "g-dep-02 resume from a context recovering KARL's",
						input: { command: "resume", ticket: "BACK-4", context: recovered.directory },
					},
					{
						label: "g-dep-02 change-bounds to a lease",
						input: {
							command: "change-bounds",
							ticket: "BACK-4",
							context: karl.directory,
							mode: "lease",
							leaseEnd,
							graceMs: GRACE,
						},
					},
				];
				for (const [index, row] of administration.entries()) {
					const rowLabel = `${row.label} (catches: a dependency gate on an administration command)`;
					const rowSeams = new ScriptedSeams(steady, [id(20 + index)]);
					const before = board.calls.length;
					// BACK-4 is free since the release; none of KARL's intents on it (acquire at null, renew and release
					// at the roots they left) expects the free state's root, and a plan rejection records nothing, so the
					// rows meet an unchanged journal. The recovered context brings no journal of its own.
					const rowRun = await fixture.apply(row.input, rowSeams, board);
					const code = String(entryOf(rowRun.document, "code"));
					expect({
						label: rowLabel,
						loads: board.calls.slice(before),
						operationIds: rowSeams.calls,
						dependencyRefusal: code === "dependency-blocked" || code === "dependency-unknown",
					}).toEqual({ label: rowLabel, loads: [], operationIds: 1, dependencyRefusal: false });
				}

				// The ready selection sees BACK-4 blocked by BACK-5. Every own intent on BACK-4 is settled
				// (its root moved three times); BACK-5 carries none.
				const nextLoads = board.calls.length;
				const seams = new ScriptedSeams(steady, operationIds(10, 4, 2));
				const run = await fixture.next(karl, seams, board, ALL);
				const label = "g-dep-02 claim next after the reopen (catches: a blocked ticket selected)";
				const expected = expectedNext(label, {
					status: "applied",
					ticket: "BACK-5",
					operationId: id(4),
					candidates: ["BACK-5"],
					attempts: [appliedAttempt("BACK-5", id(4))],
					untried: 0,
					stop: { kind: "claimed" },
					excluded: { blocked: 1, dependencyUnknown: 0, notActionable: 0 },
				});
				expect(await fixture.nextView(label, run.document)).toEqual(expected);
				// (derived): one selection load, then one `null` load per attempt.
				expect({ loads: board.calls.slice(nextLoads) }).toEqual({ loads: [ALL, null] });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"g-dep-03: the permissive policy leaves the ready selection of claim next strict",
		async () => {
			await withCase("g-dep-03", async (fixture) => {
				// Positive control (catches: claim next not wired; the scaffold answers `claim-error internal`).
				await controlNext(fixture, 11, "g-dep-03 positive control");
				const karl = await fixture.context(KARL);
				const board = new LocalBoard([
					task("BACK-1", { priority: "high", dependencies: ["BACK-3"] }),
					task("BACK-2", { priority: "low" }),
					task("BACK-3", { priority: "medium", status: "In Progress" }),
				]);
				const id = (n: number) => operationId(11, n);
				const toDo: ClaimTicketSelection = { filter: { status: "To Do" } };
				const seams = new ScriptedSeams(steady, operationIds(11, 1, 2));
				// The ready selection never reads the key. KARL's journal is empty.
				const run = await fixture.next(karl, seams, board, toDo, { policy: "permissive" });
				const label = "g-dep-03 claim next under permissive (catches: the policy widening the ready selection)";
				const expected = expectedNext(label, {
					status: "applied",
					ticket: "BACK-2",
					operationId: id(1),
					candidates: ["BACK-2"],
					attempts: [appliedAttempt("BACK-2", id(1))],
					untried: 0,
					stop: { kind: "claimed" },
					excluded: { blocked: 1, dependencyUnknown: 0, notActionable: 0 },
				});
				expect(await fixture.nextView(label, run.document)).toEqual(expected);
				// Under permissive the attempt loads no corpus; the selection stays strict.
				expect({ loads: board.calls, pushes: run.pushes, operationIds: seams.calls }).toEqual({
					loads: [toDo],
					pushes: 1,
					operationIds: 1,
				});
			});
		},
		TEST_TIMEOUT,
	);
});
