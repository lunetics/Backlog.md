/**
 * Level G of batch reclaim: the surface cores `runClaimReclaimBatch` and `runClaimReclaimPreview` in process against
 * the loopback Git daemon of claim-git-fixture.ts, blob only. Wall clock, monotonic clock, random, sleep, operation IDs
 * and the mandatory `loadLocalTickets` seam of `claim next` come in through ClaimSurfaceEnv; a test-local S1 receive
 * script passes, rejects or holds the pushes of the server repository, and the S2 trace2 record counts the Git commands
 * of the batch context's project repository. An independent writer client stores the claims of the foreign contexts
 * KARL and FRANZ, taken a day before T and so reclaimable at T; LENA reclaims. Every test starts with a positive
 * control through the same core, which the typed scaffold answers `claim-error internal`. Follow-up mutating calls run
 * only against a changed root or from another context; bat-05 and bat-08 meet the pause on purpose. Names the scaffold
 * has to provide are marked ASSUMPTION.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { claimOperationIntentOf } from "../claims/execution/index.ts";
import { type ClaimOperationIntent, openClaimIntentJournal } from "../claims/journal/index.ts";
import {
	type ActiveClaimState,
	type ClaimTiming,
	type FreeClaimState,
	parseClaimState,
} from "../claims/rights/index.ts";
import {
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimExitCode,
	runClaimMutation,
	runClaimReclaimBatch,
	runClaimReclaimPreview,
	runClaimRetry,
} from "../claims/surface/index.ts";
import type { ClaimTransitionPlan } from "../claims/transition/index.ts";
import type { TaskCorpus } from "../core/task-detail.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";

const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms of the configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms while the test holds a batch push in post-receive and acts meanwhile. */
const HELD_SEND_TIMEOUT = 10_000;
/** attempt_timeout_ms of the lost-reply cases; every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/** Bound for waiting on hook entries and hook drains. */
const EVENT_TIMEOUT = 10_000;
/** Bound for a started batch to settle once the test released its hold. */
const SETTLE_TIMEOUT = 30_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
/** Appears in the case root, the context parent and planted server objects; no document may contain it. */
const SENTINEL = "SENTINEL-reclaim-git-7c41";
const DESCRIPTOR_REF = "refs/claim-meta/format";
/** A name under refs/claims/* that is no canonical ticket ID: skipped, never guessed (storage/index.ts:299). */
const FOREIGN_REF = "refs/claims/not-a-ticket";
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-execution-retry.test.ts:82
const ABSENT_REF = "(no ref)";
/** Ticket of every leading positive control, so it never shares a key with a case. */
const CONTROL_TICKET = "BACK-9";
/** Display names only: allowed in preview entries, never in a batch or operation document. */
const KARL_OWNER = "agent-sentinel-karl";
const FRANZ_OWNER = "agent-sentinel-franz";
/** Statuses of the in-memory corpus of the `loadLocalTickets` seam; only the shape matters at this level. */
const STATUSES: readonly string[] = ["To Do", "In Progress", "Done"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock of every reclaim. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** A lease taken a day before T: its boundary lies far before T - EPS, so it is reclaimable at T (C - eps >= R). */
const OLD_LEASE_END = T - DAY + TTL;
const OLD_BOUNDARY = OLD_LEASE_END + GRACE;
/** A lease renewed at T: its boundary lies after T, so it is not yet reclaimable. */
const FRESH_LEASE_END = T + TTL;
const FRESH_BOUNDARY = FRESH_LEASE_END + GRACE;
/** The planning instant of a renewal whose window has ended again by T (an edge case). */
const LATE_RENEWAL = T - DAY / 2;
/** The stored claim generation of every set-up claim; an acquisition after a reclaim is GENERATION + 1. */
const GENERATION = 3;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; only differences to it count. */
const MONO_START = 5_000;
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/**
 * con-01: the only ways a batch may lose a ticket to a concurrent batch. The CAS race fails at the
 * client's lease check ("stale info" → `stale`) or, when both pushes overlap, at the server's ref update ("remote
 * rejected (failed to update ref)" → `remote`, storage/index.ts:643-644); both are the lease,
 * ("stale or remote").
 */
const RACE_LOSSES: readonly string[] = ["rejected plan free", "rejected storage stale", "rejected storage remote"];

type Body = Record<string, unknown>;
type ContextHandle = { context: ClaimContext; directory: string; secret: string };
type Sentinel = readonly [label: string, value: string];
/** A whole public document with every non-empty message replaced by MESSAGE, its exit code and the echoed sentinels. */
type DocumentView = { label: string; exit: number; body: Body; echoed: string[] };
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };
/** O3: revision and decoded state of one claim ref, read through the reader client. */
type StoredView = { revision: number; state: unknown };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type Tracked<T> = { promise: Promise<T>; settled: () => boolean };
type Present = Extract<ClaimSnapshot, { kind: "present" }>;
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
/** ASSUMPTION(scaffold): the mandatory seam, typed through the env so no claim next type name is needed. */
type LoadLocalTickets = NonNullable<ClaimSurfaceEnv["loadLocalTickets"]>;
type LocalTickets = Awaited<ReturnType<LoadLocalTickets>>;
type TicketSelection = Parameters<LoadLocalTickets>[0];
/** ASSUMPTION(batch reclaim): `{scope, context}` and the env. */
type BatchInput = Parameters<typeof runClaimReclaimBatch>[0];
type PreviewInput = Parameters<typeof runClaimReclaimPreview>[0];
/** ASSUMPTION(batch reclaim): both new documents are members of ClaimDocument, so claimExitCode takes them. */
type AnyDocument = Parameters<typeof claimExitCode>[0];
type Entry = { ticket: string; result: string; document: Body | null };
/** Configuration values a case sets away from the defaults of claimsYaml. */
type Tuning = { attempts?: number; attemptTimeoutMs?: number; retryPauseMs?: number };
type EnvOptions = {
	ids?: readonly string[];
	seams?: ScriptedSeams;
	tasks?: LocalTasks;
	repository?: string;
	clock?: () => number;
	tuning?: Tuning;
};

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

// adapted from claim-surface-git.test.ts:101-105
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-surface-administration.test.ts:150-154
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:107-110
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-execution-retry.test.ts:268-270
function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-execution-retry.test.ts:292-294
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution-retry.test.ts:297-304
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Writes raw bytes with mode 0600, bypassing every API. */
// adapted from claim-execution-pause.test.ts:285-289
async function writePrivate(path: string, text: string): Promise<void> {
	await writeFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600);
}

// adapted from claim-surface-git.test.ts:112-118
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** `op-<uuid v4>`; the first group names the case, the last one the number within it. */
function operationId(caseNumber: number, n: number): string {
	return `op-${String(caseNumber).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function operationIds(caseNumber: number, first: number, count: number): string[] {
	return Array.from({ length: count }, (_, index) => operationId(caseNumber, first + index));
}

function ticket(n: number): string {
	return `BACK-${n}`;
}

// adapted from claim-execution-pause.test.ts:291-293
function lease(leaseEnd: number): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd: null };
}

/** A stored ACTIVE claim; adapted from claim-execution-pause.test.ts:296-311 without the spread of a Partial. */
function active(
	binding: string,
	timing: ClaimTiming,
	owner = KARL_OWNER,
	claimGeneration = GENERATION,
): ActiveClaimState {
	return { claimState: 1, status: "active", claimGeneration, bindingGeneration: 1, owner, binding, timing };
}

// adapted from claim-execution-pause.test.ts:313-315
function tombstone(claimGeneration = GENERATION): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/** Stores the holder's day-old lease (reclaimable at T) on every ticket, one writer revision each. */
async function writeOldClaims(fixture: SurfaceCase, holder: ContextHandle, tickets: readonly string[]): Promise<void> {
	for (const each of tickets) await fixture.writeState(active(holder.context.binding, lease(OLD_LEASE_END)), each);
}

/** A local task (types/index.ts:46-88) with the required fields only; the filter itself is the stub's answer. */
function localTask(id: string): Task {
	return {
		id,
		title: `Fixture ${id}`,
		status: "To Do",
		assignee: [],
		createdDate: "2026-01-01 10:00",
		labels: [],
		dependencies: [],
	};
}

/**
 * A ticket filter reaches the core as a finished ClaimTicketSelection
 * plus the module's blank-value report; here the report is empty. The field names
 * `selection` and `blankOptions` of ClaimReclaimScopeInput are fixed by the contract.
 */
function filterScope(filter: TaskListFilter): BatchInput["scope"] {
	return { selection: { filter }, blankOptions: [] };
}

// adapted from claim-execution-retry.test.ts:716-723
function tracked<T>(promise: Promise<T>): Tracked<T> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-execution-retry.test.ts:727-739
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

/** Waits, bounded, until `pending` settled; a call that waits on another call fails here instead of hanging. */
// adapted from claim-execution-retry.test.ts:743-750, with SETTLE_TIMEOUT as the bound
async function settleWithin<T>(label: string, pending: Tracked<T>): Promise<T> {
	const deadline = Date.now() + SETTLE_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** Polls `condition` until it holds; fails after EVENT_TIMEOUT. */
// adapted from claim-execution-retry.test.ts:753-759
async function waitUntil(label: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
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
		const argv = field(event, "argv");
		if (field(event, "event") !== "start" || !Array.isArray(argv)) continue;
		const args = argv.map(String);
		if (args[1] === "-C" && args[2] === repository) commands.push(args.slice(3));
	}
	return commands;
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-execution-retry.test.ts:790-813
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
// adapted from claim-execution-retry.test.ts:816-898 (itself from claim-execution-pause.test.ts:945-1004), without
// the stdin invocation reader; the actions per invocation are claim-execution-pause.test.ts:127
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

/** The monotonic, random, sleep and operation ID seams, scripted and recorded; nothing sleeps or draws. */
// adapted from claim-surface-git.test.ts:155-186, plus the public `issued` count and an optional sleep effect
class ScriptedSeams {
	readonly slept: number[] = [];
	draws = 0;
	issued = 0;
	private readonly now: () => number;
	private readonly ids: readonly string[];
	private readonly onSleep: (ms: number) => void;

	constructor(now: () => number, ids: readonly string[], onSleep: (ms: number) => void = () => undefined) {
		this.now = now;
		this.ids = ids;
		this.onSleep = onSleep;
	}

	readonly monotonicNow = (): number => this.now();

	readonly random = (): number => {
		this.draws += 1;
		return 0.5;
	};

	readonly sleep = (ms: number): Promise<void> => {
		this.slept.push(ms);
		this.onSleep(ms);
		return Promise.resolve();
	};

	readonly newOperationId = (): string => {
		const id = this.ids[this.issued];
		this.issued += 1;
		if (id === undefined) throw new Error("fixture: more operation IDs requested than scripted");
		return id;
	};
}

/**
 * The mandatory seam batch reclaim shares with claim next: an in-memory stand-in for the local task files. Every
 * selection matches exactly this stand-in's tasks (the stub returns exactly the tickets a filter case selects); `null`
 * yields the corpus alone. Each call is recorded as a copy of the selection it got, or "corpus only" (shape as the
 * LocalBoard of claim-next-git.test.ts).
 */
class LocalTasks {
	readonly calls: unknown[] = [];
	private readonly tasks: Task[];

	constructor(ids: readonly string[] = []) {
		this.tasks = ids.map(localTask);
	}

	readonly loadLocalTickets = (selection: TicketSelection): Promise<LocalTickets> => {
		this.calls.push(selection === null ? "corpus only" : JSON.parse(JSON.stringify(selection)));
		const corpus: TaskCorpus = { tasks: [...this.tasks], completedTasks: [], statuses: STATUSES };
		const matched = selection === null ? [] : [...this.tasks];
		const loaded: LocalTickets = { kind: "loaded", matched, corpus, priorities: [] };
		return Promise.resolve(loaded);
	};

	/** Local lookup of acquire; no case acquires, so it only completes the env. */
	// adapted from claim-surface-git.test.ts:149-153
	readonly findLocalTicket = (input: string): Promise<LocalTicket> => {
		const known = this.tasks.some((entry) => entry.id === input);
		const found: LocalTicket = known ? { kind: "found", ticket: input } : { kind: "missing" };
		return Promise.resolve(found);
	};
}

/** A deep copy with every non-empty `message` replaced by MESSAGE, also inside batch entries. */
function normalized(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalized);
	if (value === null || typeof value !== "object") return value;
	const copy: Body = {};
	for (const [key, entry] of Object.entries(value)) {
		const message = key === "message" && typeof entry === "string" && entry.trim() !== "";
		copy[key] = message ? MESSAGE : normalized(entry);
	}
	return copy;
}

/** A preview document without its entries' `owner`, the one place an owner is allowed. */
function withoutEntryOwners(document: unknown): unknown {
	const entries = field(document, "entries");
	if (!Array.isArray(entries)) return document;
	const stripped = entries.map((entry: unknown) => {
		if (entry === null || typeof entry !== "object") return entry;
		const { owner: _owner, ...rest } = entry as Body;
		return rest;
	});
	return { ...(document as Body), entries: stripped };
}

function entriesOf(document: unknown): unknown[] {
	const entries = field(document, "entries");
	return Array.isArray(entries) ? entries : [];
}

/** One server repository with the S1 script, LENA's project repository, private contexts and the S2 trace. */
// adapted from claim-surface-git.test.ts:188-381 and claim-surface-administration.test.ts:188-367 (reader client)
class SurfaceCase {
	readonly caseRoot: string;
	readonly url: string;
	/** ClaimSurfaceEnv.projectRoot of LENA and NORA, and the repository S2 counts. */
	readonly project: string;
	/** Private 0700 parent of all contexts of this case, with the sentinel in its name. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	private readonly serverRepo: string;
	/** The initializer's client; the test's own store reads run there, never in the project. */
	private readonly reader: string;
	private readonly tracePath: string;
	private readonly pendings: Tracked<unknown>[] = [];
	private readerStore: ClaimStore | undefined;
	private writerStore: ClaimStore | undefined;
	private writes = 0;
	private clients = 0;
	private previousTrace: string | undefined;
	private tracing = false;

	private constructor(root: string, url: string, serverRepo: string, project: string, reader: string) {
		this.caseRoot = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.project = project;
		this.reader = reader;
		this.parent = join(root, `contexts-${SENTINEL}`);
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.tracePath = resolve(root, "trace2-events.json");
	}

	// adapted from claim-surface-git.test.ts:210-232
	static async create(caseName: string): Promise<SurfaceCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-reclaim-git-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `reclaim-${caseName}`);
			const project = await initClient(join(root, "project"));
			const reader = await initClient(join(root, "client-initializer"));
			const surfaceCase = new SurfaceCase(root, server().url(name), repo, project, reader);
			await surfaceCase.hooks.install();
			await mkdir(surfaceCase.parent);
			await chmod(surfaceCase.parent, 0o700);
			const initialized = await initializeClaimStorage(surfaceCase.storage(reader));
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			surfaceCase.startTrace();
			return surfaceCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** An independent client repository, so another context's calls never share LENA's project (S2 attribution). */
	async client(label: string): Promise<string> {
		this.clients += 1;
		return initClient(join(this.caseRoot, `client-${label}-${this.clients}`));
	}

	storage(repository: string): ClaimStorageOptions {
		return { repository, remote: this.url, format: "blob", timeoutMs: ADAPTER_TIMEOUT };
	}

	/** A private context; its secret is read once now, since bat-07 corrupts the record later. */
	// adapted from claim-surface-git.test.ts:234-238 and claim-execution-pause.test.ts:1087-1096 (secret)
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		const directory = dirname(created.context.journalDirectory);
		const record: unknown = JSON.parse(await readFile(join(directory, "context.json"), "utf8"));
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("fixture: the private record has no string secret");
		return { context: created.context, directory, secret };
	}

	/** Configuration keys plus the three surface keys, all explicit; no start value is relied on. */
	// adapted from claim-surface-git.test.ts:240-257, with the tuning of bat-03/04/05/07/09
	claimsYaml(tuning: Tuning = {}): string {
		const pauseMs = tuning.retryPauseMs ?? 1;
		return [
			"claims:",
			"  enabled: true",
			`  endpoint: ${JSON.stringify(this.url)}`,
			"  storage_format: blob",
			"  lifetime_mode: lease",
			`  lease_ttl_ms: ${TTL}`,
			`  reclaim_grace_ms: ${GRACE}`,
			`  attempt_timeout_ms: ${tuning.attemptTimeoutMs ?? ADAPTER_TIMEOUT}`,
			`  attempts: ${tuning.attempts ?? 3}`,
			`  operation_budget_ms: ${BUDGET_MS}`,
			`  clock_uncertainty_ms: ${EPS}`,
			`  retry_pause_base_ms: ${pauseMs}`,
			`  retry_pause_max_ms: ${pauseMs}`,
		].join("\n");
	}

	/**
	 * The base ClaimSurfaceEnv plus the mandatory `loadLocalTickets` seam; the fixed wall clock T unless a case scripts
	 * it.
	 */
	// adapted from claim-surface-git.test.ts:259-272
	env(options: EnvOptions = {}): ClaimSurfaceEnv {
		const seams = options.seams ?? new ScriptedSeams(() => MONO_START, options.ids ?? []);
		const tasks = options.tasks ?? new LocalTasks();
		return {
			projectRoot: options.repository ?? this.project,
			claimsYaml: this.claimsYaml(options.tuning),
			taskPrefix: "BACK",
			findLocalTicket: tasks.findLocalTicket,
			// The mandatory seam; ASSUMPTION(scaffold): a required field of the type.
			loadLocalTickets: tasks.loadLocalTickets,
			clock: options.clock ?? (() => T),
			monotonicNow: seams.monotonicNow,
			random: seams.random,
			sleep: seams.sleep,
			newOperationId: seams.newOperationId,
		};
	}

	/** ASSUMPTION(batch reclaim): the scope options as parsed, and the explicit absolute context. */
	batchInput(scope: BatchInput["scope"], handle: ContextHandle): BatchInput {
		return { scope, context: handle.directory };
	}

	previewInput(scope: PreviewInput["scope"], handle: ContextHandle): PreviewInput {
		return { scope, context: handle.directory };
	}

	/** One single mutating command of another context; reclaim and renew name no owner. */
	// adapted from claim-surface-administration.test.ts:285-288
	mutation(command: "reclaim" | "renew", ticketId: string, handle: ContextHandle): ClaimMutationInput {
		return { command, ticket: ticketId, context: handle.directory };
	}

	private async store(repository: string): Promise<ClaimStore> {
		const opened = await openClaimStore(this.storage(repository));
		if (opened.kind !== "open") throw new Error(`fixture: claim store cannot be opened (${opened.kind})`);
		return opened.store;
	}

	/** Stores a claim state as an independent writer and returns the applied root (revision + 1 on the read base). */
	// adapted from claim-execution-pause.test.ts:1152-1165 (writeChange, writeState)
	async writeState(payload: JsonObject, ticketId: string): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		this.writes += 1;
		const operation = `writer-op-${this.writes}`;
		const base = await this.writerStore.read(ticketId);
		if (base.kind !== "absent" && base.kind !== "present") {
			throw new Error(`fixture: writer read failed (${base.kind})`);
		}
		const receipt = { schema: 1, intentDigest: sha256Hex(operation), parameterDigest: sha256Hex("parameters") };
		const written = await this.writerStore.write(base, { operationId: operation, receipt, payload });
		if (written.kind !== "applied") throw new Error(`fixture: writer write failed (${written.kind})`);
		return written.root;
	}

	/** Writes raw bytes as a blob directly in the server repository and points `ref` at it (no push, no hook). */
	// adapted from claim-execution.test.ts:1240-1246 (claim-preflight.test.ts:437-441)
	async setServerBlob(ref: string, text: string): Promise<void> {
		const oid = (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
	}

	// adapted from claim-execution.test.ts:1248-1250
	async deleteServerRef(ref: string): Promise<void> {
		await server().git(this.serverRepo, ["update-ref", "-d", ref]);
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

	async root(ticketId: string): Promise<string> {
		return (await this.serverRefs())[`refs/claims/${ticketId}`] ?? ABSENT_REF;
	}

	async roots(tickets: readonly string[]): Promise<string[]> {
		const refs = await this.serverRefs();
		return tickets.map((ticketId) => refs[`refs/claims/${ticketId}`] ?? ABSENT_REF);
	}

	/** O3 through the reader client. */
	async stored(ticketId: string): Promise<StoredView> {
		this.readerStore ??= await this.store(this.reader);
		const observed = await this.readerStore.read(ticketId);
		if (observed.kind !== "present") return { revision: 0, state: observed.kind };
		return { revision: observed.document.revision, state: parseClaimState(observed.document.payload) };
	}

	/** The stored claim of `ticketId` with the descriptor; anything but a present claim is a fixture failure. */
	// adapted from claim-surface-administration.test.ts:302-309
	async observe(ticketId: string): Promise<{ descriptor: ClaimStorageDescriptor; snapshot: Present }> {
		const opened = await openClaimStore(this.storage(this.reader));
		if (opened.kind !== "open") throw new Error(`fixture: claim store cannot be opened (${opened.kind})`);
		const snapshot = await opened.store.read(ticketId);
		if (snapshot.kind !== "present") throw new Error(`fixture: expected a stored claim, got ${snapshot.kind}`);
		return { descriptor: opened.descriptor, snapshot };
	}

	/** Publishes `intent` through the journal API, as an earlier call of this context would have; returns the kind. */
	// adapted from claim-surface-administration.test.ts:311-317
	async prepare(handle: ContextHandle, intent: ClaimOperationIntent): Promise<string> {
		const opened = await openClaimIntentJournal({ directory: handle.context.journalDirectory });
		if (opened.kind !== "open") return `journal ${opened.kind}`;
		return (await opened.journal.prepare(intent)).kind;
	}

	/**
	 * Plants an own reclaim intent of `handle` at the current root of `ticketId`, exactly as a call that stopped
	 * after `prepare` leaves it: a hand-built `planned` plan (FREE successor at the observed generation) mapped by
	 * `claimOperationIntentOf` (execution/index.ts:346) and published by `journal.prepare`. Returns the prepare kind.
	 */
	// adapted from claim-surface-administration.test.ts:657-719 (sad-01: observe, hand-built plan, map, prepare)
	async plantReclaim(handle: ContextHandle, ticketId: string, id: string): Promise<string> {
		const { descriptor, snapshot } = await this.observe(ticketId);
		const plan: Planned = {
			kind: "planned",
			scope: "state-plan-only",
			action: "reclaim",
			expectedRoot: snapshot.root,
			observedClaimGeneration: GENERATION,
			request: { action: "reclaim" },
			next: tombstone(),
		};
		const mapped = claimOperationIntentOf({ operationId: id, remote: this.url, descriptor, ticket: ticketId, plan });
		return mapped.kind === "intent" ? this.prepare(handle, mapped.intent) : "not mapped";
	}

	/** S2: the number of Git commands run so far in `repository`. */
	// adapted from claim-surface-git.test.ts:290-301, with the repository as a parameter
	mark(repository = this.project): number {
		return gitCommandsOf(this.tracePath, repository).length;
	}

	commandsSince(mark: number, repository = this.project): string[][] {
		return gitCommandsOf(this.tracePath, repository).slice(mark);
	}

	pushesSince(mark: number, repository = this.project): number {
		return this.commandsSince(mark, repository).filter((args) => args[0] === "push").length;
	}

	/** The tickets of the project's pushes since `mark`, in push order, from each refspec `<root>:refs/claims/<id>`. */
	pushedTickets(mark: number): string[] {
		const pushes = this.commandsSince(mark).filter((args) => args[0] === "push");
		return pushes.map((args) => (args[args.length - 1] ?? "").split(":refs/claims/")[1] ?? ABSENT_REF);
	}

	/** True once the monotonic seam may jump: the project ran `ls-remote` on the ref of `ticketId` since `mark`. */
	readRef(mark: number, ticketId: string): boolean {
		return this.commandsSince(mark).some((args) => args[0] === "ls-remote" && args.includes(`refs/claims/${ticketId}`));
	}

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

	/** Values no public document may contain: paths, endpoint, owners, bindings, secrets. */
	// adapted from claim-surface-git.test.ts:314-335, with the secret read at context creation
	private async sentinels(handles: readonly ContextHandle[], extra: readonly Sentinel[]): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.caseRoot],
			["endpoint", this.url],
			["owner", KARL_OWNER],
			["other owner", FRANZ_OWNER],
			...extra,
		];
		for (const [ref, oid] of Object.entries(await this.serverRefs())) found.push([`root of ${ref}`, oid]);
		for (const handle of handles) {
			const { binding, journalDirectory } = handle.context;
			found.push(["binding", binding], ["context", handle.directory], ["journal", journalDirectory]);
			found.push(["secret", handle.secret]);
			for (const name of (await this.journalView(handle)).records) {
				const record: unknown = JSON.parse(await readFile(join(journalDirectory, name), "utf8"));
				found.push(["digest", String(field(record, "digest"))]);
				found.push(["parameter digest", String(field(record, "parameterDigest"))]);
			}
		}
		return found;
	}

	/** A batch, preview or single document; a preview is scanned without its entries' `owner`. */
	// adapted from claim-surface-git.test.ts:357-362, with the nested messages of batch entries
	async documentView(
		label: string,
		document: AnyDocument,
		handles: readonly ContextHandle[],
		extra: readonly Sentinel[] = [],
	): Promise<DocumentView> {
		const body = normalized(document) as Body;
		const preview = field(document, "kind") === "claim-reclaim-preview";
		const scanned = JSON.stringify(preview ? withoutEntryOwners(document) : document);
		const echoed = echoedIn(scanned, await this.sentinels(handles, extra));
		return { label, exit: claimExitCode(document), body, echoed };
	}

	/** Starts a call whose push the test holds; dispose settles it, so no call outlives its case. */
	track<T>(promise: Promise<T>): Tracked<T> {
		const pending = tracked(promise);
		this.pendings.push(pending);
		return pending;
	}

	/** Whether the push behind invocation `n` of `phase` is held and still unfinished while `pending` runs. */
	async stillHeld(pending: Tracked<unknown>, phase: ReceivePhase, n: number): Promise<boolean> {
		return !pending.settled() && !(await this.hooks.hasFinished(phase, n));
	}

	/** Waits, bounded, until invocation `n` of `phase` has left its hold. */
	// adapted from claim-execution-retry.test.ts:1194-1197
	async waitFinished(phase: ReceivePhase, n: number): Promise<void> {
		await waitUntil(`receive ${phase}-${n} to finish`, () => this.hooks.hasFinished(phase, n));
	}

	// adapted from claim-surface-git.test.ts:364-375
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

	/** Releases every hold, settles every started call, restores the trace variable and removes the case root. */
	// adapted from claim-execution-retry.test.ts:1220-1229
	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
			await Promise.all(this.pendings.map((pending) => settleWithin("pending call", pending).catch(() => undefined)));
		} finally {
			this.stopTrace();
			await rm(this.caseRoot, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------------------------------------------
// Expected documents: the envelopes, and the single documents in batch entries.
// ---------------------------------------------------------------------------------------------------------------

/** The batch document, keys exactly as listed; observedAt is the selection's one wall-clock read. */
function batchBody(input: {
	status: string;
	entries: Entry[];
	complete?: boolean;
	unreadable?: string[];
	stoppedAt?: string | null;
}): Body {
	return {
		schemaVersion: 1,
		kind: "claim-reclaim-batch",
		status: input.status,
		command: "reclaim-batch",
		observedAt: T,
		complete: input.complete ?? true,
		unreadable: input.unreadable ?? [],
		stoppedAt: input.stoppedAt ?? null,
		entries: input.entries,
	};
}

/** `result` is the document's status; a sent write is never untried. */
function entryOf(ticketId: string, document: Body): Entry {
	return { ticket: ticketId, result: String(document.status), document };
}

function untried(ticketId: string): Entry {
	return { ticket: ticketId, result: "untried", document: null };
}

/** The preview document; `observedAt` is its one wall-clock read. */
function previewBody(status: "ok" | "unknown", complete: boolean, entries: Body[], observedAt = T): Body {
	return {
		schemaVersion: 1,
		kind: "claim-reclaim-preview",
		status,
		command: "reclaim-preview",
		complete,
		observedAt,
		entries,
	};
}

/**
 * The preview entry of an ACTIVE lease with its boundary (eligible or not-yet), owner and timing.
 * `claimGeneration` appears whenever the stored state carries one, ACTIVE and FREE alike, and `owner`/`timing` only
 * for ACTIVE (as `claim-list`, surface/index.ts:1554-1557).
 */
function activeEntry(ticketId: string, verdict: "eligible" | "not-yet", leaseEnd: number, pause?: Body): Body {
	const entry: Body = {
		ticket: ticketId,
		verdict,
		claimGeneration: GENERATION,
		owner: KARL_OWNER,
		timing: { mode: "lease", leaseEnd, hardEnd: null, graceMs: GRACE },
		boundary: leaseEnd + GRACE,
	};
	if (pause !== undefined) entry.pause = pause;
	return entry;
}

/** PlannedDisplay of a reclaim: the FREE successor at the same generation, no timing, never capped. */
function freePlanned(): Body {
	return { status: "free", claimGeneration: GENERATION, timing: null, capped: false };
}

/** RightsView of the final read after an applied reclaim: FREE at the same generation. */
function freeRights(): Body {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: "free",
		claimGeneration: GENERATION,
		workRight: { kind: "none", cause: "free" },
		reclaim: { kind: "not-applicable" },
	};
}

/** RightsView of a claim another context holds, as the reclaiming context sees it (rights/index.ts:283-289). */
function foreignRights(reclaim: "eligible" | "not-yet", boundary: number, claimGeneration = GENERATION): Body {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: "foreign",
		claimGeneration,
		workRight: { kind: "none", cause: "not-holder" },
		reclaim: { kind: reclaim, boundary },
	};
}

/** The applied operation document of one reclaim (what `claim reclaim --expect-generation` prints). */
function appliedReclaim(ticketId: string, id: string, rights: Body = freeRights(), command = "reclaim"): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "applied",
		command,
		action: "reclaim",
		ticket: ticketId,
		operationId: id,
		outcome: "applied",
		rejection: null,
		storage: { kind: "applied" },
		sends: 1,
		stoppedBy: null,
		planned: freePlanned(),
		rights,
	};
}

/** A reclaim that was sent once and did not apply: a remote rejection or a lost reply. */
function sentReclaim(
	ticketId: string,
	id: string,
	outcome: "rejected" | "unknown",
	storage: Body,
	stoppedBy: "attempts" | null,
): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: outcome,
		command: "reclaim",
		action: "reclaim",
		ticket: ticketId,
		operationId: id,
		outcome,
		rejection: outcome === "rejected" ? { stage: "storage", cause: field(storage, "cause") } : null,
		storage,
		sends: 1,
		stoppedBy,
		planned: freePlanned(),
		rights: foreignRights("eligible", OLD_BOUNDARY),
	};
}

/** A plan rejection persists nothing, so it carries no operation ID and no planned display. */
function planRejected(ticketId: string, rejection: Body, rights: Body): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "rejected",
		command: "reclaim",
		action: "reclaim",
		ticket: ticketId,
		operationId: null,
		outcome: "rejected",
		rejection,
		storage: null,
		sends: 0,
		stoppedBy: null,
		planned: null,
		rights,
	};
}

/** A executor pause of one reclaim: no operation ID, the pause view and the rights of the fresh read. */
function pauseBody(ticketId: string, pause: Body): Body {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "reclaim",
		action: "reclaim",
		ticket: ticketId,
		operationId: null,
		pause,
		rights: foreignRights("eligible", OLD_BOUNDARY),
	};
}

/** The claim-error document of one reclaim that failed before any intent. */
function errorBody(ticketId: string, code: string): Body {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "refused",
		command: "reclaim",
		code,
		message: MESSAGE,
		ticket: ticketId,
		operationId: null,
	};
}

/** The lost reply's storage view: sent, then queried, and the intent is still open at its root. */
const QUERIED_OPEN: Body = { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } };

/** O3 of a claim reclaimed once from the writer's first revision: a FREE tombstone of the same generation. */
function freeStored(revision = 2): StoredView {
	return { revision, state: { kind: "state", state: tombstone() } };
}

/**
 * Leading positive control of every test but bat-01 (whose first run is its control) and pre-01 (a preview control):
 * KARL's day-old claim on CONTROL_TICKET is reclaimed by `lena` through the batch core with the seam's ID, one push
 * and one admitted intent. The typed scaffold answers `claim-error internal`, so each test is
 * RED here. CONTROL_TICKET is no ticket of any case, and its record names a root that has moved on.
 */
async function controlBatch(
	fixture: SurfaceCase,
	karl: ContextHandle,
	lena: ContextHandle,
	id: string,
	handles: readonly ContextHandle[],
): Promise<void> {
	await fixture.writeState(active(karl.context.binding, lease(OLD_LEASE_END)), CONTROL_TICKET);
	const before = await fixture.journalView(lena);
	const mark = fixture.mark();
	const input = fixture.batchInput({ tickets: [CONTROL_TICKET] }, lena);
	const document = await runClaimReclaimBatch(input, fixture.env({ ids: [id] }));
	const label = "positive control (catches: missing wiring of selection, single core and batch document)";
	expect({
		document: await fixture.documentView(label, document, handles),
		pushes: fixture.pushesSince(mark),
		journal: await fixture.journalView(lena),
	}).toEqual({
		document: {
			label,
			exit: 0,
			body: batchBody({ status: "ok", entries: [entryOf(CONTROL_TICKET, appliedReclaim(CONTROL_TICKET, id))] }),
			echoed: [],
		},
		pushes: 1,
		journal: { records: [...before.records, `${id}.json`].sort(byCodeUnits), slots: before.slots + 1, other: [] },
	});
}

describe("claim reclaim batch and preview through the surface core over real Git (blob)", () => {
	test(
		"bat-01: a batch over explicit tickets reclaims each candidate once, in ticket order; a repeat finds none, ok",
		async () => {
			await withCase("bat-01", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				await writeOldClaims(fixture, karl, [a, b, c]);
				const idA = operationId(1, 1);
				const idB = operationId(1, 2);
				const idC = operationId(1, 3);
				// The scope names the tickets out of order and one of them twice (canonical, deduplicated,
				// compareTaskIds order).
				const scope = { tickets: [c, a, b, a] };
				const mark = fixture.mark();

				// Positive control (catches: missing wiring of selection, single core and batch document; a wrong order; a
				// ticket sent twice): KARL's three day-old claims are reclaimed by LENA with the seam's IDs in ticket order,
				// one push each. RED: the scaffold's claim-error internal.
				const first = await runClaimReclaimBatch(
					fixture.batchInput(scope, lena),
					fixture.env({ ids: [idA, idB, idC] }),
				);
				const firstLabel = "bat-01 first run (catches: input order kept, a duplicate sent twice, a shared ID)";
				expect({
					document: await fixture.documentView(firstLabel, first, handles),
					pushed: fixture.pushedTickets(mark),
					journal: await fixture.journalView(lena),
					stored: [await fixture.stored(a), await fixture.stored(b), await fixture.stored(c)],
				}).toEqual({
					document: {
						label: firstLabel,
						exit: 0,
						body: batchBody({
							status: "ok",
							entries: [
								entryOf(a, appliedReclaim(a, idA)),
								entryOf(b, appliedReclaim(b, idB)),
								entryOf(c, appliedReclaim(c, idC)),
							],
						}),
						echoed: [],
					},
					pushed: [a, b, c],
					journal: { records: [`${idA}.json`, `${idB}.json`, `${idC}.json`], slots: 3, other: [] },
					// catches: a reclaim that changes the generation or writes anything but the tombstone.
					stored: [freeStored(), freeStored(), freeStored()],
				});

				// bat-01 repeat (a valid scope with zero candidates is a normal result). The same scope against
				// the changed roots; LENA's three records name the old roots (pause/index.ts:86-94), and the tombstones
				// plan `free`, so nothing is a candidate and nothing is sent.
				const refs = await fixture.serverRefs();
				const journal = await fixture.journalView(lena);
				const again = fixture.mark();
				const second = await runClaimReclaimBatch(fixture.batchInput(scope, lena), fixture.env());
				const secondLabel = "bat-01 repeat (catches: zero candidates as an error; a resend; an ID drawn)";
				expect({
					document: await fixture.documentView(secondLabel, second, handles),
					pushes: fixture.pushesSince(again),
					journal: await fixture.journalView(lena),
					refs: await fixture.serverRefs(),
				}).toEqual({
					document: { label: secondLabel, exit: 0, body: batchBody({ status: "ok", entries: [] }), echoed: [] },
					pushes: 0,
					journal,
					refs,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-02: the candidates are fixed at the selection instant; a claim reclaimable only later is not pulled in",
		async () => {
			await withCase("bat-02", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(2, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const a = ticket(1);
				const g = ticket(2);
				const idA = operationId(2, 1);
				await fixture.writeState(active(karl.context.binding, lease(OLD_LEASE_END)), a);
				// G's boundary lies one minute after T + EPS: not yet at the selection instant T, but at LATER.
				const gLeaseEnd = T + EPS + MINUTE - GRACE;
				await fixture.writeState(active(karl.context.binding, lease(gLeaseEnd)), g);
				const gRoot = await fixture.root(g);
				const later = T + 10 * MINUTE;
				const reads: number[] = [];
				// ASSUMPTION(batch reclaim): the selection's one wall-clock read is the batch's first; every later read belongs
				// to a single core, whose fresh plan then runs at LATER.
				const clock = (): number => {
					const now = reads.length === 0 ? T : later;
					reads.push(now);
					return now;
				};
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ all: true }, lena),
					fixture.env({ ids: [idA], clock }),
				);
				// Control preview with the later clock: G is eligible now, so only the fixed candidate set kept it out.
				const preview = await runClaimReclaimPreview(
					fixture.previewInput({ tickets: [g] }, lena),
					fixture.env({ clock: () => later }),
				);
				const label = "bat-02 batch (catches: candidates re-selected per ticket; every ACTIVE claim a candidate)";
				const previewLabel = "bat-02 control preview at LATER (catches: G never reclaimable in this set-up)";
				expect({
					document: await fixture.documentView(label, document, handles),
					gRoot: await fixture.root(g),
					journal: await fixture.journalView(lena),
					preview: await fixture.documentView(previewLabel, preview, handles),
				}).toEqual({
					document: {
						label,
						exit: 0,
						body: batchBody({ status: "ok", entries: [entryOf(a, appliedReclaim(a, idA))] }),
						echoed: [],
					},
					gRoot,
					// catches: an intent for G (no later reclaimable claim is pulled in).
					journal: { records: [`${control}.json`, `${idA}.json`], slots: 2, other: [] },
					preview: {
						label: previewLabel,
						exit: 0,
						body: previewBody("ok", true, [activeEntry(g, "eligible", gLeaseEnd)], later),
						echoed: [],
					},
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-03: a ticket reclaimed and acquired anew after the selection is rejected generation-changed, never reclaimed",
		async () => {
			await withCase("bat-03", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const mara = await fixture.context();
				const handles = [karl, franz, lena, mara];
				const control = operationId(3, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const x = ticket(1);
				const a = ticket(2);
				const idX = operationId(3, 1);
				const idA = operationId(3, 2);
				const idMara = operationId(3, 3);
				await writeOldClaims(fixture, karl, [x, a]);
				const maraRepository = await fixture.client("mara");
				const post = await fixture.hooks.count("post");
				await fixture.hooks.plan("post", ["hold"], "pass");
				const mark = fixture.mark();
				const pending = fixture.track(
					runClaimReclaimBatch(
						fixture.batchInput({ tickets: [x, a] }, lena),
						fixture.env({ ids: [idX, idA], tuning: { attemptTimeoutMs: HELD_SEND_TIMEOUT } }),
					),
				);
				const entered = await whilePending("bat-03 X in post-receive", pending, () =>
					fixture.hooks.hasEntered("post", post + 1),
				);
				// While X's push is held, MARA reclaims A and FRANZ acquires it anew at generation 4, a day old and so
				// reclaimable again (ABA). MARA is another context with an empty journal; FRANZ is
				// the writer client, outside any journal; LENA's batch touches A once.
				const reclaimed = await runClaimMutation(
					fixture.mutation("reclaim", a, mara),
					fixture.env({ ids: [idMara], repository: maraRepository }),
				);
				const franzState = active(franz.context.binding, lease(OLD_LEASE_END), FRANZ_OWNER, GENERATION + 1);
				const franzRoot = await fixture.writeState(franzState, a);
				const held = await fixture.stillHeld(pending, "post", post + 1);
				await fixture.hooks.release("post", post + 1);
				const document = await settleWithin("bat-03 batch", pending);
				const maraLabel = "bat-03 set-up: MARA's reclaim of A (catches: a set-up that never frees A)";
				// catches: a fixture whose intervention did not happen inside the hold.
				expect({
					entered,
					held,
					reclaimed: await fixture.documentView(maraLabel, reclaimed, handles),
				}).toEqual({
					entered: true,
					held: true,
					reclaimed: { label: maraLabel, exit: 0, body: appliedReclaim(a, idMara), echoed: [] },
				});

				const label = "bat-03 batch (catches: a new claim reclaimed on an old order; no expected generation)";
				const aRejection = { stage: "plan", cause: "generation-changed" };
				expect({
					document: await fixture.documentView(label, document, handles),
					aRoot: await fixture.root(a),
					pushes: fixture.pushesSince(mark),
					journal: await fixture.journalView(lena),
				}).toEqual({
					document: {
						label,
						exit: 2,
						body: batchBody({
							status: "rejected",
							entries: [
								entryOf(x, appliedReclaim(x, idX)),
								entryOf(a, planRejected(a, aRejection, foreignRights("eligible", OLD_BOUNDARY, GENERATION + 1))),
							],
						}),
						echoed: [],
					},
					aRoot: franzRoot,
					pushes: 1,
					// catches: a record for A (a plan rejection persists nothing).
					journal: { records: [`${control}.json`, `${idX}.json`], slots: 2, other: [] },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-04: a preview reserves nothing; a renewal before the mutation rejects not-yet, one ended at once is reclaimed",
		async () => {
			await withCase("bat-04", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(4, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);
				const karlRepository = await fixture.client("karl");
				const tickets = [ticket(1), ticket(2), ticket(3), ticket(4), ticket(5), ticket(6)];
				await writeOldClaims(fixture, karl, tickets);

				// bat-04 (a), the preview shows B eligible, then KARL renews B at T and LENA's batch runs.
				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const idA = operationId(4, 1);
				const idC = operationId(4, 3);
				const preview = await runClaimReclaimPreview(fixture.previewInput({ tickets: [b] }, lena), fixture.env());
				// KARL is another context with an empty journal.
				const renewedB = await runClaimMutation(
					fixture.mutation("renew", b, karl),
					fixture.env({ ids: [operationId(4, 11)], repository: karlRepository }),
				);
				const renewedRoot = await fixture.root(b);
				// LENA's only record so far is the control's.
				const batch = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b, c] }, lena),
					fixture.env({ ids: [idA, idC] }),
				);
				const previewLabel = "bat-04a preview (catches: a preview that is no read of the current state)";
				const batchLabel = "bat-04a batch (catches: the preview taken as a permission; a renewed claim reclaimed)";
				expect({
					preview: await fixture.documentView(previewLabel, preview, handles),
					renewed: field(renewedB, "status"),
					batch: await fixture.documentView(batchLabel, batch, handles),
					bRoot: await fixture.root(b),
				}).toEqual({
					preview: {
						label: previewLabel,
						exit: 0,
						body: previewBody("ok", true, [activeEntry(b, "eligible", OLD_LEASE_END)]),
						echoed: [],
					},
					renewed: "applied",
					batch: {
						label: batchLabel,
						exit: 0,
						body: batchBody({
							status: "ok",
							entries: [entryOf(a, appliedReclaim(a, idA)), entryOf(c, appliedReclaim(c, idC))],
						}),
						echoed: [],
					},
					bRoot: renewedRoot,
				});

				// bat-04 (b), E and F are candidates at the selection; while D's push is held, KARL renews E at T
				// (a new window) and F at LATE_RENEWAL (a window that has ended by T again).
				const d = ticket(4);
				const e = ticket(5);
				const f = ticket(6);
				const idD = operationId(4, 4);
				const idE = operationId(4, 5);
				const idF = operationId(4, 6);
				const post = await fixture.hooks.count("post");
				await fixture.hooks.plan("post", ["hold"], "pass");
				const pending = fixture.track(
					runClaimReclaimBatch(
						fixture.batchInput({ tickets: [d, e, f] }, lena),
						fixture.env({ ids: [idD, idE, idF], tuning: { attemptTimeoutMs: HELD_SEND_TIMEOUT } }),
					),
				);
				const entered = await whilePending("bat-04b D in post-receive", pending, () =>
					fixture.hooks.hasEntered("post", post + 1),
				);
				// KARL's records so far are on B (its root moved on); E and F are other tickets.
				const renewedE = await runClaimMutation(
					fixture.mutation("renew", e, karl),
					fixture.env({ ids: [operationId(4, 12)], repository: karlRepository }),
				);
				const renewedF = await runClaimMutation(
					fixture.mutation("renew", f, karl),
					fixture.env({ ids: [operationId(4, 13)], repository: karlRepository, clock: () => LATE_RENEWAL }),
				);
				const eRoot = await fixture.root(e);
				const held = await fixture.stillHeld(pending, "post", post + 1);
				await fixture.hooks.release("post", post + 1);
				const document = await settleWithin("bat-04b batch", pending);
				// catches: a fixture whose renewals did not land inside the hold.
				expect({ entered, held, renewals: [field(renewedE, "status"), field(renewedF, "status")] }).toEqual({
					entered: true,
					held: true,
					renewals: ["applied", "applied"],
				});
				const label = "bat-04b batch (catches: a reclaim over a renewal; an ended renewal spared)";
				const eRejection = { stage: "plan", cause: "not-yet", boundary: FRESH_BOUNDARY };
				expect({
					document: await fixture.documentView(label, document, handles),
					eRoot: await fixture.root(e),
					fStored: await fixture.stored(f),
				}).toEqual({
					document: {
						label,
						exit: 2,
						body: batchBody({
							status: "rejected",
							entries: [
								entryOf(d, appliedReclaim(d, idD)),
								entryOf(e, planRejected(e, eRejection, foreignRights("not-yet", FRESH_BOUNDARY))),
								entryOf(f, appliedReclaim(f, idF)),
							],
						}),
						echoed: [],
					},
					eRoot,
					// Writer revision 1, KARL's renewal 2, LENA's reclaim 3.
					fStored: freeStored(3),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-05: a lost reply on one ticket is unknown and the batch goes on; the report is unknown 3, nothing untried",
		async () => {
			await withCase("bat-05", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(5, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const idA = operationId(5, 1);
				const idB = operationId(5, 2);
				const idC = operationId(5, 3);
				await writeOldClaims(fixture, karl, [a, b, c]);
				const bRoot = await fixture.root(b);
				// B's push is held past the client timeout and declined late (exi-02a, claim-execution-pause.test.ts:
				// 2156-2181); with one attempt the intent stays open. On purpose: that open intent would pause every
				// further LENA call on B's root; the batch meets it only on B, never on C.
				const pre = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["pass", "hold-reject"], "pass");
				const mark = fixture.mark();
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b, c] }, lena),
					fixture.env({ ids: [idA, idB, idC], tuning: { attempts: 1, attemptTimeoutMs: LOSS_TIMEOUT } }),
				);
				const pushed = fixture.pushedTickets(mark);
				await fixture.hooks.release("pre", pre + 2);
				await fixture.waitFinished("pre", pre + 2);
				const label = "bat-05 batch (catches: a stop after one unknown; unknown as success, rejection or untried)";
				expect({
					document: await fixture.documentView(label, document, handles),
					pushed,
					bRoot: await fixture.root(b),
					journal: await fixture.journalView(lena),
				}).toEqual({
					document: {
						label,
						exit: 3,
						body: batchBody({
							status: "unknown",
							entries: [
								entryOf(a, appliedReclaim(a, idA)),
								entryOf(b, sentReclaim(b, idB, "unknown", QUERIED_OPEN, "attempts")),
								entryOf(c, appliedReclaim(c, idC)),
							],
						}),
						echoed: [],
					},
					// catches: C skipped or sent before B.
					pushed: [a, b, c],
					bRoot,
					journal: {
						records: [`${control}.json`, `${idA}.json`, `${idB}.json`, `${idC}.json`],
						slots: 4,
						other: [],
					},
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-06: a remote rejection of one ticket stays isolated; the others apply and the batch is rejected 2",
		async () => {
			await withCase("bat-06", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(6, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const idA = operationId(6, 1);
				const idB = operationId(6, 2);
				const idC = operationId(6, 3);
				await writeOldClaims(fixture, karl, [a, b, c]);
				const bRoot = await fixture.root(b);
				// B's declined intent stays open; no later LENA call touches B.
				await fixture.hooks.plan("pre", ["pass", "reject"], "pass");
				const mark = fixture.mark();
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b, c] }, lena),
					fixture.env({ ids: [idA, idB, idC] }),
				);
				const label = "bat-06 batch (catches: a remote rejection taken as call-wide; a rollback of A)";
				const declined: Body = { kind: "rejected", cause: "remote" };
				expect({
					document: await fixture.documentView(label, document, handles),
					pushed: fixture.pushedTickets(mark),
					bRoot: await fixture.root(b),
				}).toEqual({
					document: {
						label,
						exit: 2,
						body: batchBody({
							status: "rejected",
							entries: [
								entryOf(a, appliedReclaim(a, idA)),
								entryOf(b, sentReclaim(b, idB, "rejected", declined, null)),
								entryOf(c, appliedReclaim(c, idC)),
							],
						}),
						echoed: [],
					},
					pushed: [a, b, c],
					bRoot,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-07: a call-wide fault after the first write stops the batch; later candidates untried, nothing rolled back",
		async () => {
			await withCase("bat-07", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const nora = await fixture.context();
				const handles = [karl, lena, nora];
				const control = operationId(7, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);
				const tickets = [ticket(1), ticket(2), ticket(3), ticket(4), ticket(5), ticket(6)];
				await writeOldClaims(fixture, karl, tickets);

				// bat-07 (a): while A's push is held, the test corrupts LENA's private record, a shared input that every
				// later ticket checks the same way (context-corrupt stops).
				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const idA = operationId(7, 1);
				const bRoot = await fixture.root(b);
				const cRoot = await fixture.root(c);
				const post = await fixture.hooks.count("post");
				await fixture.hooks.plan("post", ["hold"], "pass");
				const mark = fixture.mark();
				const pending = fixture.track(
					runClaimReclaimBatch(
						fixture.batchInput({ tickets: [a, b, c] }, lena),
						fixture.env({
							ids: [idA, operationId(7, 2), operationId(7, 3)],
							tuning: { attemptTimeoutMs: HELD_SEND_TIMEOUT },
						}),
					),
				);
				const entered = await whilePending("bat-07a A in post-receive", pending, () =>
					fixture.hooks.hasEntered("post", post + 1),
				);
				await writePrivate(join(lena.directory, "context.json"), `corrupt ${SENTINEL}\n`);
				const held = await fixture.stillHeld(pending, "post", post + 1);
				await fixture.hooks.release("post", post + 1);
				const document = await settleWithin("bat-07a batch", pending);
				// catches: a fixture whose corruption did not happen inside the hold.
				expect({ entered, held }).toEqual({ entered: true, held: true });
				const label = "bat-07a batch (catches: going on after a proven shared fault; a sent write untried)";
				expect({
					document: await fixture.documentView(label, document, handles),
					pushes: fixture.pushesSince(mark),
					bRoot: await fixture.root(b),
					cRoot: await fixture.root(c),
					journal: await fixture.journalView(lena),
				}).toEqual({
					document: {
						label,
						exit: 5,
						body: batchBody({
							status: "refused",
							stoppedAt: b,
							entries: [
								// A's final rights read loads the corrupt context (execution/index.ts:504-507).
								entryOf(a, appliedReclaim(a, idA, { kind: "corrupt" })),
								entryOf(b, errorBody(b, "context-corrupt")),
								untried(c),
							],
						}),
						echoed: [],
					},
					pushes: 1,
					bRoot,
					cRoot,
					// catches: a rollback of A or an intent for B or C.
					journal: { records: [`${control}.json`, `${idA}.json`], slots: 2, other: [] },
				});

				// bat-07 (b), the variant: NORA's batch, and while D's push is held the server's descriptor turns to
				// another format (pf-03 technique, claim-preflight.test.ts:680). NORA is a fresh context.
				const d = ticket(4);
				const e = ticket(5);
				const f = ticket(6);
				const idD = operationId(7, 4);
				const eRoot = await fixture.root(e);
				const fRoot = await fixture.root(f);
				const post2 = await fixture.hooks.count("post");
				await fixture.hooks.plan("post", ["hold"], "pass");
				const mark2 = fixture.mark();
				const pending2 = fixture.track(
					runClaimReclaimBatch(
						fixture.batchInput({ tickets: [d, e, f] }, nora),
						fixture.env({
							ids: [idD, operationId(7, 5), operationId(7, 6)],
							tuning: { attemptTimeoutMs: HELD_SEND_TIMEOUT },
						}),
					),
				);
				const entered2 = await whilePending("bat-07b D in post-receive", pending2, () =>
					fixture.hooks.hasEntered("post", post2 + 1),
				);
				await fixture.setServerBlob(DESCRIPTOR_REF, `${JSON.stringify({ schema: 1, format: "tree", epoch: 1 })}\n`);
				const held2 = await fixture.stillHeld(pending2, "post", post2 + 1);
				await fixture.hooks.release("post", post2 + 1);
				const document2 = await settleWithin("bat-07b batch", pending2);
				expect({ entered: entered2, held: held2 }).toEqual({ entered: true, held: true });
				const mismatch: Body = {
					schemaVersion: 1,
					kind: "claim-error",
					status: "refused",
					command: "reclaim",
					code: "format-mismatch",
					message: MESSAGE,
					ticket: e,
					operationId: null,
					configuredFormat: "blob",
					existingFormat: "tree",
				};
				const label2 = "bat-07b batch (catches: a descriptor fault read as ticket-local; F sent after the stop)";
				expect({
					document: await fixture.documentView(label2, document2, handles),
					pushes: fixture.pushesSince(mark2),
					eRoot: await fixture.root(e),
					fRoot: await fixture.root(f),
					journal: await fixture.journalView(nora),
				}).toEqual({
					document: {
						label: label2,
						exit: 5,
						body: batchBody({
							status: "refused",
							stoppedAt: e,
							entries: [
								// D's final rights read opens the store and meets the new descriptor (rights/index.ts:353-357).
								entryOf(d, appliedReclaim(d, idD, { kind: "unknown" })),
								entryOf(e, mismatch),
								untried(f),
							],
						}),
						echoed: [],
					},
					pushes: 1,
					eRoot,
					fRoot,
					journal: { records: [`${idD}.json`], slots: 1, other: [] },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-08: an own open intent pauses its ticket only and retry clears it; an unreadable journal stops the batch",
		async () => {
			await withCase("bat-08", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const nora = await fixture.context();
				const handles = [karl, lena, nora];
				const control = operationId(8, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);
				const tickets = [ticket(1), ticket(2), ticket(3), ticket(4), ticket(5)];
				await writeOldClaims(fixture, karl, tickets);

				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const idA = operationId(8, 1);
				const idC = operationId(8, 3);
				const planted = operationId(8, 90);
				// LENA's own reclaim intent on B at B's current root, as a call that stopped after prepare left it.
				const prepared = await fixture.plantReclaim(lena, b, planted);
				// catches: a record the journal refuses, which would turn the pause below into a fixture failure.
				expect({ prepared }).toEqual({ prepared: "prepared" });

				// On purpose: the planted intent pauses LENA on B's unchanged root (pause/index.ts:86-94); A and C are
				// other tickets, so they run (the key holds the ticket, journal/index.ts:166-171).
				const mark = fixture.mark();
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b, c] }, lena),
					fixture.env({ ids: [idA, operationId(8, 2), idC] }),
				);
				const label = "bat-08 batch (catches: one ticket's pause blocking the others; a ticket pause as a stop)";
				expect({
					document: await fixture.documentView(label, document, handles),
					pushed: fixture.pushedTickets(mark),
					journal: await fixture.journalView(lena),
				}).toEqual({
					document: {
						label,
						exit: 7,
						body: batchBody({
							status: "paused",
							entries: [
								entryOf(a, appliedReclaim(a, idA)),
								entryOf(b, pauseBody(b, { kind: "outstanding", operationIds: [planted] })),
								entryOf(c, appliedReclaim(c, idC)),
							],
						}),
						echoed: [],
					},
					pushed: [a, c],
					// The planted record holds no slot until it is admitted.
					journal: {
						records: [`${control}.json`, `${idA}.json`, `${idC}.json`, `${planted}.json`],
						slots: 3,
						other: [],
					},
				});

				// The way out: `claim retry` of the named ID; a resend never pauses
				// (surface/index.ts:1382) and needs no new ID.
				const retried = await runClaimRetry({ operationId: planted, context: lena.directory }, fixture.env());
				const retryLabel = "bat-08 retry of the paused ID (catches: a retry blocked by the batch's pause)";
				expect({
					retry: await fixture.documentView(retryLabel, retried, handles),
					bStored: await fixture.stored(b),
				}).toEqual({
					retry: { label: retryLabel, exit: 0, body: appliedReclaim(b, planted, freeRights(), "retry"), echoed: [] },
					bStored: freeStored(),
				});

				// bat-08 variant: an unreadable entry makes NORA's journal view incomplete, which the executor checks
				// before any ticket (pause/index.ts:67-84, :103-104; notes.txt as in claim-execution-pause.test.ts:
				// 2405-2408). Claim-pause {unknown} stops. NORA is a fresh context.
				const d = ticket(4);
				const e = ticket(5);
				await writePrivate(join(nora.context.journalDirectory, "notes.txt"), "notes\n");
				const mark2 = fixture.mark();
				const stopped = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [d, e] }, nora),
					fixture.env({ ids: [operationId(8, 4), operationId(8, 5)] }),
				);
				const stopLabel = "bat-08 variant (catches: a journal-wide pause read as ticket-local; E sent after it)";
				expect({
					document: await fixture.documentView(stopLabel, stopped, handles),
					pushes: fixture.pushesSince(mark2),
					journal: await fixture.journalView(nora),
				}).toEqual({
					document: {
						label: stopLabel,
						exit: 7,
						body: batchBody({
							status: "paused",
							stoppedAt: d,
							entries: [entryOf(d, pauseBody(d, { kind: "unknown" })), untried(e)],
						}),
						echoed: [],
					},
					pushes: 0,
					journal: { records: [], slots: 0, other: ["notes.txt"] },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-09: every candidate has its own operation budget, never one deadline for the whole batch",
		async () => {
			await withCase("bat-09", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(9, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const a = ticket(1);
				const b = ticket(2);
				const idA = operationId(9, 1);
				const idB = operationId(9, 2);
				await writeOldClaims(fixture, karl, [a, b]);
				// A virtual monotonic clock: a sleep of ms moves it by ms + BUDGET_MS, so A's first retry pause (10 000 of
				// the 20 000 window, claimRetryPauseMs at surface/index.ts:460-466) spends A's budget, and the batch is
				// past its start + BUDGET_MS when B begins.
				const virtual = { now: MONO_START };
				const seams = new ScriptedSeams(
					() => virtual.now,
					[idA, idB],
					(ms) => {
						virtual.now += ms + BUDGET_MS;
					},
				);
				// A's lost intent stays open on A's root; the batch never returns to A.
				const pre = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["hold-reject"], "pass");
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b] }, lena),
					fixture.env({ seams, tuning: { attempts: 5, attemptTimeoutMs: LOSS_TIMEOUT, retryPauseMs: 20_000 } }),
				);
				await fixture.hooks.release("pre", pre + 1);
				await fixture.waitFinished("pre", pre + 1);
				const view = await fixture.documentView("bat-09 batch", document, handles);
				const lost = entriesOf(view.body)[0];
				// A's rights are left out: after its deadline the final read runs with a 1 ms command timeout
				// (surface/index.ts:498), which is no subject of this case.
				expect({
					exit: view.exit,
					status: field(view.body, "status"),
					complete: field(view.body, "complete"),
					stoppedAt: field(view.body, "stoppedAt"),
					tickets: entriesOf(view.body).map((entry) => field(entry, "ticket")),
					lost: {
						result: field(lost, "result"),
						status: field(field(lost, "document"), "status"),
						operationId: field(field(lost, "document"), "operationId"),
						storage: field(field(lost, "document"), "storage"),
						sends: field(field(lost, "document"), "sends"),
						stoppedBy: field(field(lost, "document"), "stoppedBy"),
					},
					// catches: one deadline for the batch (B would be budget-exhausted, unavailable 6).
					next: entriesOf(view.body)[1],
					slept: seams.slept,
					draws: seams.draws,
					virtual: virtual.now,
					echoed: view.echoed,
				}).toEqual({
					exit: 3,
					status: "unknown",
					complete: true,
					stoppedAt: null,
					tickets: [a, b],
					lost: {
						result: "unknown",
						status: "unknown",
						operationId: idA,
						storage: QUERIED_OPEN,
						sends: 1,
						stoppedBy: "budget",
					},
					next: entryOf(b, appliedReclaim(b, idB)),
					slept: [10_000],
					draws: 1,
					virtual: MONO_START + 10_000 + BUDGET_MS,
					echoed: [],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-10: scope sources: --all with a skipped name, a filter selection, owner over check failures, intersection",
		async () => {
			await withCase("bat-10", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, franz, lena];
				const control = operationId(10, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);
				const karlClaim = active(karl.context.binding, lease(OLD_LEASE_END));
				const franzClaim = active(franz.context.binding, lease(OLD_LEASE_END), FRANZ_OWNER);

				// (i) --all (the list itself): A has a local task file, N has none, and a ref name under
				// refs/claims/* is no ticket (lst-01 technique, claim-cli.test.ts:1975-1979).
				const a = ticket(1);
				const n = ticket(2);
				const idA = operationId(10, 1);
				const idN = operationId(10, 2);
				await fixture.writeState(karlClaim, a);
				await fixture.writeState(karlClaim, n);
				await fixture.setServerBlob(FOREIGN_REF, `x ${SENTINEL}\n`);
				const onlyA = new LocalTasks([a]);
				const all = await runClaimReclaimBatch(
					fixture.batchInput({ all: true }, lena),
					fixture.env({ ids: [idA, idN], tasks: onlyA }),
				);
				const allLabel = "bat-10 (i) --all (catches: a ticket without a local file unreachable; a skipped ref ignored)";
				const skipped: Sentinel[] = [["skipped ref name", "not-a-ticket"]];
				expect({
					document: await fixture.documentView(allLabel, all, handles, skipped),
					calls: onlyA.calls,
				}).toEqual({
					document: {
						label: allLabel,
						exit: 6,
						body: batchBody({
							status: "unavailable",
							complete: false,
							entries: [entryOf(a, appliedReclaim(a, idA)), entryOf(n, appliedReclaim(n, idN))],
						}),
						echoed: [],
					},
					// catches: --all made dependent on local task files.
					calls: [],
				});
				await fixture.deleteServerRef(FOREIGN_REF);

				// (ii) a ticket filter: the core gets the
				// finished selection and an empty blank-value report; the seam matches P and X. X has no claim ref, Q is
				// FRANZ's reclaimable claim outside the filter. For (ii) to (iv): each run names other tickets than before.
				const p = ticket(3);
				const q = ticket(4);
				const x = ticket(20);
				const idP = operationId(10, 3);
				await fixture.writeState(karlClaim, p);
				await fixture.writeState(franzClaim, q);
				const qRoot = await fixture.root(q);
				const filtered = new LocalTasks([p, x]);
				const byFilter = await runClaimReclaimBatch(
					fixture.batchInput(filterScope({ labels: ["x"] }), lena),
					fixture.env({ ids: [idP], tasks: filtered }),
				);
				const filterLabel = "bat-10 (ii) ticket filter (catches: a filter that widens; a second filter engine)";
				expect({
					document: await fixture.documentView(filterLabel, byFilter, handles),
					calls: filtered.calls,
					qRoot: await fixture.root(q),
				}).toEqual({
					document: {
						label: filterLabel,
						exit: 0,
						body: batchBody({ status: "ok", entries: [entryOf(p, appliedReclaim(p, idP))] }),
						echoed: [],
					},
					// catches: a lookup per ticket, a selection changed on its way to the seam, the corpus-only form of the gate.
					calls: [{ filter: { labels: ["x"] } }],
					qRoot,
				});

				// (iii) --claim-owner (byte-exact on the stored ACTIVE owner):
				// KARL holds K1 and R1, FRANZ holds Q; C1 stores a corrupt payload and U1 a newer
				// state version, both naming KARL where no owner can be compared. All tickets have one digit, so the
				// listing's name order and compareTaskIds agree and the jump below hits the same tickets either way.
				const k1 = ticket(5);
				const c1 = ticket(6);
				const u1 = ticket(7);
				const r1 = ticket(8);
				const idK1 = operationId(10, 5);
				await fixture.writeState(karlClaim, k1);
				await fixture.writeState({ state: "claimed", holder: KARL_OWNER }, c1);
				await fixture.writeState({ claimState: 2, status: "active", owner: KARL_OWNER }, u1);
				await fixture.writeState(karlClaim, r1);
				const kept = [q, c1, u1, r1, CONTROL_TICKET];
				const keptRoots = await fixture.roots(kept);

				// Positive control of the owner scope (catches: an owner match that drops a state it cannot compare):
				// with every ref readable, the preview under the same scope shows K1 and R1 eligible and C1 and U1 with
				// their check verdicts, nothing of FRANZ's or of FREE tickets. Every ticket was read, so the selection is
				// complete and the status ok: the two verdicts are no incompleteness (
				// Unlike claim list, surface/index.ts:1551-1552, :1648).
				const ownerPreview = await runClaimReclaimPreview(
					fixture.previewInput({ claimOwners: [KARL_OWNER] }, lena),
					fixture.env(),
				);
				const previewLabel = "bat-10 (iii) owner preview (catches: a check state dropped; claim list's unknown/3)";
				expect(await fixture.documentView(previewLabel, ownerPreview, handles)).toEqual({
					label: previewLabel,
					exit: 0,
					body: previewBody("ok", true, [
						activeEntry(k1, "eligible", OLD_LEASE_END),
						{ ticket: c1, verdict: "state-corrupt" },
						{ ticket: u1, verdict: "state-unsupported" },
						activeEntry(r1, "eligible", OLD_LEASE_END),
					]),
					echoed: [],
				});

				// The same preview with the bat-11 jump once U1's ref is read: R1 and CONTROL_TICKET stay unread and get an
				// entry with verdict `unknown`, the preview has no `unreadable` list (addendum), so it is
				// incomplete and unknown/3. The owner of an unread state cannot be compared, so neither drops out.
				const previewMark = fixture.mark();
				const previewSeams = new ScriptedSeams(
					() => (fixture.readRef(previewMark, u1) ? MONO_START + BUDGET_MS : MONO_START),
					[],
				);
				const partialPreview = await runClaimReclaimPreview(
					fixture.previewInput({ claimOwners: [KARL_OWNER] }, lena),
					fixture.env({ seams: previewSeams }),
				);
				const partialLabel = "bat-10 (iii) partial owner preview (catches: an unread state dropped or shown free)";
				expect(await fixture.documentView(partialLabel, partialPreview, handles)).toEqual({
					label: partialLabel,
					exit: 3,
					body: previewBody("unknown", false, [
						activeEntry(k1, "eligible", OLD_LEASE_END),
						{ ticket: c1, verdict: "state-corrupt" },
						{ ticket: u1, verdict: "state-unsupported" },
						{ ticket: r1, verdict: "unknown" },
						{ ticket: CONTROL_TICKET, verdict: "unknown" },
					]),
					echoed: [],
				});

				// The batch under the same scope: its selection budget ends once U1's ref is read (the bat-11 jump), so R1
				// and CONTROL_TICKET stay unread and go to `unreadable` without an entry, never free; C1 and U1 keep their
				// entries with the single core's refusal (surface/index.ts:606-611, :879). IDs beyond K1's are spares for
				// an implementation that runs C1 and U1 through runClaimMutation (step 7 draws before the plan).
				const ownerTasks = new LocalTasks();
				const mark = fixture.mark();
				const ownerSeams = new ScriptedSeams(
					() => (fixture.readRef(mark, u1) ? MONO_START + BUDGET_MS : MONO_START),
					[idK1, operationId(10, 6), operationId(10, 7)],
				);
				const byOwner = await runClaimReclaimBatch(
					fixture.batchInput({ claimOwners: [KARL_OWNER] }, lena),
					fixture.env({ seams: ownerSeams, tasks: ownerTasks }),
				);
				const ownerLabel = "bat-10 (iii) owner batch (catches: owner by binding or assignee; a check failure dropped)";
				expect({
					document: await fixture.documentView(ownerLabel, byOwner, handles),
					calls: ownerTasks.calls,
					kept: await fixture.roots(kept),
				}).toEqual({
					document: {
						label: ownerLabel,
						exit: 5,
						body: batchBody({
							status: "refused",
							complete: false,
							unreadable: [r1, CONTROL_TICKET],
							entries: [
								entryOf(k1, appliedReclaim(k1, idK1)),
								entryOf(c1, errorBody(c1, "state-corrupt")),
								entryOf(u1, errorBody(u1, "state-unsupported")),
							],
						}),
						echoed: [],
					},
					calls: [],
					// catches: R1 guessed free and reclaimed; a write for C1 or U1.
					kept: keptRoots,
				});

				// (iv) owner and explicit tickets intersect: Q is FRANZ's, K3 is KARL's.
				const k3 = ticket(10);
				const idK3 = operationId(10, 10);
				await fixture.writeState(karlClaim, k3);
				const bothTasks = new LocalTasks();
				const both = await runClaimReclaimBatch(
					fixture.batchInput({ claimOwners: [KARL_OWNER], tickets: [q, k3] }, lena),
					fixture.env({ ids: [idK3], tasks: bothTasks }),
				);
				const bothLabel = "bat-10 (iv) owner and tickets (catches: scope options that widen instead of intersect)";
				expect({
					document: await fixture.documentView(bothLabel, both, handles),
					calls: bothTasks.calls,
					qRoot: await fixture.root(q),
				}).toEqual({
					document: {
						label: bothLabel,
						exit: 0,
						body: batchBody({ status: "ok", entries: [entryOf(k3, appliedReclaim(k3, idK3))] }),
						echoed: [],
					},
					calls: [],
					qRoot,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bat-11: a ticket the selection could not read within its budget is unreadable, never a candidate or untried",
		async () => {
			await withCase("bat-11", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const control = operationId(11, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const a = ticket(1);
				const b = ticket(2);
				const idA = operationId(11, 1);
				await writeOldClaims(fixture, karl, [a, b]);
				const bRoot = await fixture.root(b);
				// bud-04 technique (claim-surface-git.test.ts:431-437): the monotonic clock jumps by the whole budget once
				// the selection has run `ls-remote` on A's ref, so B, read next, is past the selection's deadline.
				// A's own budget starts at the jumped value and lasts.
				const mark = fixture.mark();
				const seams = new ScriptedSeams(() => (fixture.readRef(mark, a) ? MONO_START + BUDGET_MS : MONO_START), [idA]);
				const document = await runClaimReclaimBatch(
					fixture.batchInput({ tickets: [a, b] }, lena),
					fixture.env({ seams }),
				);
				const label = "bat-11 batch (catches: an unread ticket dropped silently, guessed free or listed untried)";
				expect({
					document: await fixture.documentView(label, document, handles),
					bRoot: await fixture.root(b),
					pushes: fixture.pushesSince(mark),
					journal: await fixture.journalView(lena),
				}).toEqual({
					document: {
						label,
						exit: 6,
						body: batchBody({
							status: "unavailable",
							complete: false,
							unreadable: [b],
							entries: [entryOf(a, appliedReclaim(a, idA))],
						}),
						echoed: [],
					},
					bRoot,
					pushes: 1,
					journal: { records: [`${control}.json`, `${idA}.json`], slots: 2, other: [] },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"pre-01: the preview is read-only and shows each verdict, boundary, owner and own open operation",
		async () => {
			await withCase("pre-01", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const binding = karl.context.binding;
				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const d = ticket(4);
				const e = ticket(5);
				const f = ticket(6);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), CONTROL_TICKET);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), a);
				await fixture.writeState(active(binding, lease(FRESH_LEASE_END)), b);
				await fixture.writeState(active(binding, { mode: "none" }), c);
				await fixture.writeState(tombstone(), d);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), f);

				// Positive control (catches: missing wiring of the preview's selection, verdict and document; RED: the
				// scaffold's claim-error internal): the control claim previews eligible.
				const controlPreview = await runClaimReclaimPreview(
					fixture.previewInput({ tickets: [CONTROL_TICKET] }, lena),
					fixture.env(),
				);
				const controlLabel = "pre-01 positive control (catches: missing wiring of the preview)";
				expect(await fixture.documentView(controlLabel, controlPreview, handles)).toEqual({
					label: controlLabel,
					exit: 0,
					body: previewBody("ok", true, [activeEntry(CONTROL_TICKET, "eligible", OLD_LEASE_END)]),
					echoed: [],
				});

				// LENA's own open reclaim intent on F (the bat-08 plant).
				const planted = operationId(12, 90);
				const prepared = await fixture.plantReclaim(lena, f, planted);
				// catches: a record the journal refuses, which would hide the pause view below.
				expect({ prepared }).toEqual({ prepared: "prepared" });

				const journal = await fixture.journalView(lena);
				const refs = await fixture.serverRefs();
				const mark = fixture.mark();
				const seams = new ScriptedSeams(() => MONO_START, []);
				const preview = await runClaimReclaimPreview(
					fixture.previewInput({ tickets: [a, b, c, d, e, f] }, lena),
					fixture.env({ seams }),
				);
				const label = "pre-01 preview (catches: a second reclaim rule; a hidden pause; an owner outside entries)";
				expect({
					document: await fixture.documentView(label, preview, handles),
					pushes: fixture.pushesSince(mark),
					journal: await fixture.journalView(lena),
					refs: await fixture.serverRefs(),
					seams: { issued: seams.issued, slept: seams.slept, draws: seams.draws },
				}).toEqual({
					document: {
						label,
						exit: 0,
						body: previewBody("ok", true, [
							activeEntry(a, "eligible", OLD_LEASE_END),
							activeEntry(b, "not-yet", FRESH_LEASE_END),
							{ ticket: c, verdict: "never", claimGeneration: GENERATION, owner: KARL_OWNER, timing: { mode: "none" } },
							{ ticket: d, verdict: "free", claimGeneration: GENERATION },
							{ ticket: e, verdict: "absent" },
							activeEntry(f, "eligible", OLD_LEASE_END, { kind: "outstanding", operationIds: [planted] }),
						]),
						echoed: [],
					},
					// catches: a preview that sends, prepares, admits or draws an ID (read-only).
					pushes: 0,
					journal,
					refs,
					seams: { issued: 0, slept: [], draws: 0 },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"pre-02: preview and batch share one selection; check errors and an unread ticket make the preview unknown 3",
		async () => {
			await withCase("pre-02", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, lena];
				const binding = karl.context.binding;
				const control = operationId(13, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				// (a) parity: same state, same clock, the preview and then the batch over --all.
				const a = ticket(1);
				const b = ticket(2);
				const c = ticket(3);
				const d = ticket(4);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), a);
				await fixture.writeState(active(binding, lease(FRESH_LEASE_END)), b);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), c);
				await fixture.writeState(tombstone(), d);
				const preview = await runClaimReclaimPreview(fixture.previewInput({ all: true }, lena), fixture.env());
				const batch = await runClaimReclaimBatch(
					fixture.batchInput({ all: true }, lena),
					fixture.env({ ids: [operationId(13, 1), operationId(13, 3)] }),
				);
				const previewView = await fixture.documentView("pre-02a preview", preview, handles);
				const batchView = await fixture.documentView("pre-02a batch", batch, handles);
				const verdicts = entriesOf(previewView.body).map((entry) => [field(entry, "ticket"), field(entry, "verdict")]);
				const eligible = verdicts.filter(([, verdict]) => verdict === "eligible").map(([id]) => id);
				// catches: two selection implementations (the batch's candidates differ from the preview's eligible set).
				expect({
					preview: { status: field(previewView.body, "status"), verdicts },
					eligible,
					batch: {
						status: field(batchView.body, "status"),
						entries: entriesOf(batchView.body).map((entry) => [field(entry, "ticket"), field(entry, "result")]),
					},
					echoed: [previewView.echoed, batchView.echoed],
				}).toEqual({
					preview: {
						status: "ok",
						verdicts: [
							[a, "eligible"],
							[b, "not-yet"],
							[c, "eligible"],
							[d, "free"],
							[CONTROL_TICKET, "free"],
						],
					},
					eligible: [a, c],
					batch: {
						status: "ok",
						entries: [
							[a, "applied"],
							[c, "applied"],
						],
					},
					echoed: [[], []],
				});

				// (b) check errors: a corrupt payload (claim-execution-administration.test.ts:1857), a newer state
				// version (rights/index.ts:161) and a ticket past the selection budget (the bat-11 jump, once `newer` is read).
				const corrupt = ticket(5);
				const newer = ticket(6);
				const late = ticket(7);
				await fixture.writeState({ state: "claimed", holder: KARL_OWNER }, corrupt);
				await fixture.writeState({ claimState: 2, status: "active" }, newer);
				await fixture.writeState(active(binding, lease(OLD_LEASE_END)), late);
				const mark = fixture.mark();
				const seams = new ScriptedSeams(() => (fixture.readRef(mark, newer) ? MONO_START + BUDGET_MS : MONO_START), []);
				const checked = await runClaimReclaimPreview(
					fixture.previewInput({ tickets: [b, corrupt, newer, late] }, lena),
					fixture.env({ seams }),
				);
				const label = "pre-02b preview (catches: a check error shown as free or dropped; a partial preview as ok)";
				expect(await fixture.documentView(label, checked, handles)).toEqual({
					label,
					exit: 3,
					body: previewBody("unknown", false, [
						activeEntry(b, "not-yet", FRESH_LEASE_END),
						{ ticket: corrupt, verdict: "state-corrupt" },
						{ ticket: newer, verdict: "state-unsupported" },
						{ ticket: late, verdict: "unknown" },
					]),
					echoed: [],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"con-01: two batches over the same tickets from two contexts reclaim each ticket exactly once",
		async () => {
			await withCase("con-01", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				const mara = await fixture.context();
				const handles = [karl, lena, mara];
				const control = operationId(14, 0);
				// Positive control (catches: missing wiring of the batch core; RED: claim-error internal).
				await controlBatch(fixture, karl, lena, control, handles);

				const tickets = [ticket(1), ticket(2), ticket(3)];
				await writeOldClaims(fixture, karl, tickets);
				const maraRepository = await fixture.client("mara");
				const lenaMark = fixture.mark();
				const maraMark = fixture.mark(maraRepository);
				// Two contexts, each naming every ticket once; neither journal holds an intent on these roots.
				const [lenaDocument, maraDocument] = await Promise.all([
					runClaimReclaimBatch(fixture.batchInput({ tickets }, lena), fixture.env({ ids: operationIds(14, 1, 3) })),
					runClaimReclaimBatch(
						fixture.batchInput({ tickets }, mara),
						fixture.env({ ids: operationIds(14, 11, 3), repository: maraRepository }),
					),
				]);
				const views = [
					await fixture.documentView("con-01 LENA", lenaDocument, handles),
					await fixture.documentView("con-01 MARA", maraDocument, handles),
				];
				const entries = views.flatMap((view) => entriesOf(view.body));
				const appliedCount = (id: string) =>
					entries.filter((entry) => field(entry, "ticket") === id && field(entry, "result") === "applied").length;
				const losses = entries
					.filter((entry) => field(entry, "result") !== "applied")
					.map((entry) => {
						const document = field(entry, "document");
						const rejection = field(document, "rejection");
						return `${field(document, "status")} ${field(rejection, "stage")} ${field(rejection, "cause")}`;
					});
				const consistent = views.map((view) => {
					const allApplied = entriesOf(view.body).every((entry) => field(entry, "result") === "applied");
					return field(view.body, "status") === (allApplied ? "ok" : "rejected");
				});
				const pushes = fixture.pushesSince(lenaMark) + fixture.pushesSince(maraMark, maraRepository);
				const stored: StoredView[] = [];
				for (const each of tickets) stored.push(await fixture.stored(each));
				// The interleaving is not deterministic; only invariants are checked (con-01).
				expect({
					applied: tickets.map(appliedCount),
					unexpectedLosses: losses.filter((loss) => !RACE_LOSSES.includes(loss)),
					consistent,
					complete: views.map((view) => [field(view.body, "complete"), field(view.body, "stoppedAt")]),
					echoed: views.map((view) => view.echoed),
					atMostOnePushPerTicketAndBatch: pushes <= 6,
					stored,
				}).toEqual({
					// catches: a double reclaim, or none.
					applied: [1, 1, 1],
					// catches: a loser reported as applied or unknown (every loss is a plan `free` or a storage lease loss).
					unexpectedLosses: [],
					consistent: [true, true],
					complete: [
						[true, null],
						[true, null],
					],
					echoed: [[], []],
					atMostOnePushPerTicketAndBatch: true,
					stored: [freeStored(), freeStored(), freeStored()],
				});
			});
		},
		TEST_TIMEOUT,
	);
});
