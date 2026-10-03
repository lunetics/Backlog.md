/**
 * Behavioural contract for the pause in the executor over real Git: step 6a pauses a call while an own journal record
 * targets the observed root (`paused {pause, rights}`), step 9a sends only after the call's own intent won the
 * admission slot of its key (`not-sent {admission-*}` otherwise), and neither same-context races in one or two
 * processes nor a SIGKILL between scan and send let two intents of one key reach the server. Git cases run for blob,
 * tree and commit-chain against the loopback daemon with the S1 receive log, the S2 trace2 push record (one trace file
 * per child process) and the gated journal seam of claim-admission-probe.ts; child processes run under that probe's
 * supervisor. Every test starts with a healthy acquire whose admission slot (O2′) the executor before the pause never
 * writes. Expectations beyond the written contract are marked ASSUMPTION(pause). The pause is no execution admission,
 * no work right and says nothing about other contexts, other hosts, other endpoint spellings or non-cooperating
 * writers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, claimContextIO, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimExecutionResult,
	type ExecuteClaimTransitionOptions,
	executeClaimTransition,
} from "../claims/execution/index.ts";
import {
	type ClaimIntentAdmitResult,
	type ClaimIntentJournal,
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	claimJournalIO,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import { queryClaimMutation } from "../claims/query/index.ts";
import type {
	ActiveClaimState,
	ClaimRightEvaluation,
	ClaimStateV1,
	ClaimTiming,
	FreeClaimState,
} from "../claims/rights/index.ts";
import {
	type ClaimChange,
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import type { ClaimTimingRequest, ClaimTransitionAction, ClaimTransitionRequest } from "../claims/transition/index.ts";
import {
	type ExecuteCommand,
	type ExecuteOutput,
	type FileGate,
	type JournalIO,
	openBarrier,
	type PauseEvent,
	type PauseStep,
	ProbeSupervisor,
	pauseIO,
	releaseGate,
	withoutReaddir,
} from "./fixtures/claim-admission-probe.ts";
import { GitFixtureServer, type ReceivePhase, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 20_000;
const LONG_TEST_TIMEOUT = 40_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout for executions that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
/** Per-Git-command timeout in lost-reply cases; every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/** Margin for any stray asynchronous accept before a zero count is read; the zero itself is the proof. */
const SETTLE_MS = 200;
/** Bound for waiting on gate entries, hook drains and settling calls. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
/** How long a child waits at a file gate before it gives up. */
const CHILD_GATE_TIMEOUT = 8_000;
const SUPERVISOR_LIFETIME = 60_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
const THIRD_TICKET = "BACK-3";
const FOURTH_TICKET = "BACK-4";
/** Ticket of every leading positive control, so it never shares an admission key with a case. */
const CONTROL_TICKET = "BACK-9";
/** Sends allowed per call unless a case says otherwise; a healthy call still sends exactly once. */
const ATTEMPTS = 3;
/** Placeholder for a ticket ref the server does not have. */
const ABSENT_REF = "(no ref)";
/** Distinctive owner names that no result or diagnostic may echo. */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05" and its reclaim boundary "10:15". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
/** ASSUMPTION(pause): slot name domain, UTF-8 with one trailing NUL, followed by the canonical five-field key. */
const ADMISSION_DOMAIN = "backlog.md/claim-admission/v1\0";

const OPERATION_KEYS = ["action", "kind", "operationId", "outcome", "rights", "scope", "sends", "storage"];
const NOT_PLANNED_KEYS = ["kind", "plan", "rights"];
const PAUSED_KEYS = ["kind", "pause", "rights"];
const FAILURE_KEYS = ["kind", "reason"];
const EVALUATED_KEYS = ["claimGeneration", "kind", "observedRoot", "ownership", "reclaim", "scope", "workRight"];
/** Verdicts a sampled race loser may show; each sends nothing. */
const LOSER_VERDICTS = ["admission-held", "paused", "not-planned"];
const ADMITTED: ClaimIntentAdmitResult = { kind: "admitted" };

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type FailureKind = Exclude<ClaimExecutionResult["kind"], "operation" | "not-planned" | "paused">;
type Outcome = "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
type ContextHandle = { context: ClaimContext; directory: string };
type SequenceClock = { clock: () => number; calls: () => number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type Run = { result: ClaimExecutionResult; gitCalls: number; pushes: string[][] };
type Sentinels = { anywhere: string[]; inReasons: string[] };
type IntentSpec = {
	operationId: string;
	ticket?: string;
	expectedRoot: string | null;
	request: ClaimTransitionRequest;
	next: ClaimStateV1;
};
type StorageView = {
	kind: string | null;
	keys: string[];
	root: string | null;
	cause: string | null;
	after: string | null;
	query: string | null;
	resolution: string | null;
	observedRoot: string | null;
};
type RightsView = {
	kind: string | null;
	keys: string[];
	ownership: string | null;
	workRight: unknown;
	reclaim: unknown;
	observedRoot: string | null;
	claimGeneration: number | null;
};
type PlanView = { kind: string | null; cause: string | null; boundary: number | null };
type PauseView = {
	kind: string | null;
	keys: string[];
	operationIds: string[] | null;
	reasonType: string;
	reasonEmpty: boolean;
};
/** Kinds, keys, facts and counts only; reasons appear as type, emptiness and a count of echoed sentinels. */
type ExecutionView = {
	label: string;
	kind: string | null;
	keys: string[];
	scope: string | null;
	action: string | null;
	operationId: string | null;
	storage: StorageView | null;
	outcome: string | null;
	outcomeKeys: string[];
	rights: RightsView | null;
	plan: PlanView | null;
	pause: PauseView | null;
	sends: number | null;
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
};
type OperationExpectation = {
	action: ClaimTransitionAction;
	operationId: string;
	storage: StorageView;
	outcome: Outcome;
	rights: RightsView;
	sends: number;
};
/** O2 and O2′ of one context journal: digests of final records and of admission slots, by file name. */
type JournalView = { records: Record<string, string>; slots: Record<string, string> };
type Tracked<T> = { promise: Promise<T>; settled: () => boolean };
type RaceSpec = {
	operationId: string;
	ticket: string;
	request: ClaimTransitionRequest;
	repository: string;
	steps: PauseStep[];
};
type Racer = {
	operationId: string;
	repository: string;
	clock: SequenceClock;
	gates: StepGates;
	mark: number;
	pending: Tracked<ClaimExecutionResult>;
};
type ChildSpec = {
	handle: ContextHandle;
	operationId: string;
	ticket: string;
	request: ClaimTransitionRequest;
	gates: FileGate[];
	barrier?: string;
};
type ExecuteChild = { supervisor: ProbeSupervisor; trace: string };

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

// adapted from claim-execution.test.ts:250
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-execution.test.ts:257
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

// adapted from claim-execution.test.ts:271
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// adapted from claim-execution.test.ts:295
function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

// adapted from claim-execution.test.ts:306
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution.test.ts:315
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Writes raw bytes with mode 0600, bypassing the journal. */
async function writePrivate(path: string, text: string): Promise<void> {
	await writeFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600);
}

function lease(leaseEnd: number, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

// adapted from claim-execution.test.ts:360
function active(
	binding: string,
	timing: ClaimTiming = lease(L),
	changes: Partial<ActiveClaimState> = {},
): ActiveClaimState {
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

function tombstone(claimGeneration: number): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

function leaseRequest(): ClaimTimingRequest {
	return { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
}

function acquire(owner = OWNER): ClaimTransitionRequest {
	return { action: "acquire", owner, timing: leaseRequest() };
}

function renew(): ClaimTransitionRequest {
	return { action: "renew", ttlMs: TTL, ttlSource: "default" };
}

function release(): ClaimTransitionRequest {
	return { action: "release" };
}

function reclaim(): ClaimTransitionRequest {
	return { action: "reclaim" };
}

/** The successor of an acquire from absent at T by `handle`. */
function acquiredOf(handle: ContextHandle, owner = OWNER): ActiveClaimState {
	return active(handle.context.binding, lease(T + TTL), { owner, claimGeneration: 1 });
}

/** The reference intent, built from constants, never from the plan under test. */
// adapted from claim-execution.test.ts:402
function referenceIntent(remote: string, descriptor: ClaimStorageDescriptor, spec: IntentSpec): ClaimOperationIntent {
	return {
		operationId: spec.operationId,
		remote,
		format: descriptor.format,
		epoch: descriptor.epoch,
		ticket: spec.ticket ?? TICKET,
		expectedRoot: spec.expectedRoot,
		targetBinding: spec.next.status === "active" ? spec.next.binding : null,
		action: spec.request.action,
		parameters: json(spec.request),
		resolved: { next: json(spec.next) },
	};
}

// adapted from claim-execution.test.ts:420
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

function recordText(intent: ClaimOperationIntent): string {
	return `${canonicalJson(recordOf(intent))}\n`;
}

/** O2: the digest of the exact bytes of one final record. */
// adapted from claim-execution.test.ts:436
function recordFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [`${intent.operationId}.json`]: sha256Hex(recordText(intent)) };
}

/**
 * Reference slot name. ASSUMPTION(pause): `.admission-` + hex SHA-256 over the domain and the canonical key of
 * exactly ticket, endpoint, format, epoch and expected root; never action, parameters or target binding.
 */
function slotName(intent: ClaimOperationIntent): string {
	const key = {
		epoch: intent.epoch,
		expectedRoot: intent.expectedRoot,
		format: intent.format,
		remote: intent.remote,
		ticket: intent.ticket,
	};
	return `.admission-${sha256Hex(`${ADMISSION_DOMAIN}${canonicalJson(key)}`)}`;
}

/** O2′, ASSUMPTION(pause): the slot is its own file holding exactly the admitted record's bytes. */
function slotFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [slotName(intent)]: sha256Hex(recordText(intent)) };
}

/** Expected O2 and O2′ of one context journal, kept in step with each case. */
class Ledger {
	private readonly records: Record<string, string> = {};
	private readonly slots: Record<string, string> = {};

	/** A published intent that holds no slot: a race loser, a not-sent intent, a crash before its admission. */
	published(intent: ClaimOperationIntent): void {
		Object.assign(this.records, recordFile(intent));
	}

	/** A published intent whose bytes fill the admission slot of its key. */
	admitted(intent: ClaimOperationIntent): void {
		this.published(intent);
		Object.assign(this.slots, slotFile(intent));
	}

	view(extraSlots: Record<string, string> = {}): JournalView {
		return { records: { ...this.records }, slots: { ...this.slots, ...extraSlots } };
	}
}

/**
 * A clock that serves `reads` in order and counts its calls; a call beyond them throws. ASSUMPTION(pause):
 * 0 calls after a failed open or read, 1 without a send (also for `paused` and `admission-*`), 2 with a send.
 */
// adapted from claim-execution.test.ts:462
function sequenceClock(...reads: number[]): SequenceClock {
	const state = { count: 0 };
	return {
		clock: () => {
			state.count += 1;
			const read = reads[state.count - 1];
			if (read === undefined) throw new Error("clock called more often than the contract allows");
			return read;
		},
		calls: () => state.count,
	};
}

function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function textOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

function reasonsOf(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, entry]) =>
		key === "reason" && typeof entry === "string" ? [entry] : reasonsOf(entry),
	);
}

function storageViewOf(value: unknown): StorageView {
	const query = field(value, "query");
	const resolution = field(query, "resolution");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		root: textOf(field(value, "root")),
		cause: textOf(field(value, "cause")),
		after: textOf(field(value, "after")),
		query: textOf(field(query, "kind")),
		resolution: textOf(field(resolution, "kind")),
		observedRoot: textOf(field(resolution, "observedRoot")),
	};
}

function rightsViewOf(value: unknown): RightsView {
	const generation = field(value, "claimGeneration");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		ownership: textOf(field(value, "ownership")),
		workRight: field(value, "workRight") ?? null,
		reclaim: field(value, "reclaim") ?? null,
		observedRoot: textOf(field(value, "observedRoot")),
		claimGeneration: typeof generation === "number" ? generation : null,
	};
}

function planViewOf(value: unknown): PlanView {
	const boundary = field(value, "boundary");
	return {
		kind: textOf(field(value, "kind")),
		cause: textOf(field(value, "cause")),
		boundary: typeof boundary === "number" ? boundary : null,
	};
}

function pauseViewOf(value: unknown): PauseView {
	const reason = field(value, "reason");
	const ids = field(value, "operationIds");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		operationIds: Array.isArray(ids) && ids.every((id) => typeof id === "string") ? [...ids] : null,
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
	};
}

/**
 * The verdict view of one result. `anywhere` values (secrets, bindings, paths, endpoint, owners) may appear nowhere
 * in the result; `inReasons` values (operation IDs, roots) may appear in no reason at any depth, so operation IDs
 * may appear in `pause.operationIds` only.
 */
// adapted from claim-execution.test.ts:537 (viewOf), with the pause
function viewOf(label: string, result: unknown, sentinels: Sentinels): ExecutionView {
	const reason = field(result, "reason");
	const serialized = String(JSON.stringify(result));
	const reasons = reasonsOf(result).join("\n");
	const echoed =
		sentinels.anywhere.filter((value) => value !== "" && serialized.includes(value)).length +
		sentinels.inReasons.filter((value) => value !== "" && reasons.includes(value)).length;
	const storage = field(result, "storage");
	const outcome = field(result, "outcome");
	const rights = field(result, "rights");
	const plan = field(result, "plan");
	const pause = field(result, "pause");
	const sends = field(result, "sends");
	return {
		label,
		kind: textOf(field(result, "kind")),
		keys: keysOf(result),
		scope: textOf(field(result, "scope")),
		action: textOf(field(result, "action")),
		operationId: textOf(field(result, "operationId")),
		storage: storage === undefined ? null : storageViewOf(storage),
		outcome: textOf(field(outcome, "kind")),
		outcomeKeys: keysOf(outcome),
		rights: rights === undefined ? null : rightsViewOf(rights),
		plan: plan === undefined ? null : planViewOf(plan),
		pause: pause === undefined ? null : pauseViewOf(pause),
		sends: typeof sends === "number" ? sends : null,
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
		echoed,
	};
}

/** The coarse verdict of a result for sampled interleavings. */
function verdictKind(result: unknown): string {
	const kind = textOf(field(result, "kind"));
	if (kind !== "operation") return String(kind);
	const storage = field(result, "storage");
	const storageKind = textOf(field(storage, "kind"));
	return storageKind === "not-sent" ? String(textOf(field(storage, "cause"))) : String(storageKind);
}

// adapted from claim-execution.test.ts:569
function operationView(label: string, expected: OperationExpectation): ExecutionView {
	return {
		label,
		kind: "operation",
		keys: OPERATION_KEYS,
		scope: "transition-execution-only",
		action: expected.action,
		operationId: expected.operationId,
		storage: expected.storage,
		outcome: expected.outcome,
		outcomeKeys: ["kind"],
		rights: expected.rights,
		plan: null,
		pause: null,
		sends: expected.sends,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

// adapted from claim-execution.test.ts:589
function notPlannedView(label: string, plan: PlanView, rights: RightsView): ExecutionView {
	return {
		label,
		kind: "not-planned",
		keys: NOT_PLANNED_KEYS,
		scope: null,
		action: null,
		operationId: null,
		storage: null,
		outcome: null,
		outcomeKeys: [],
		rights,
		plan,
		pause: null,
		sends: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

/**
 * ASSUMPTION(pause): `paused` has exactly kind, pause and the rights evaluation of the planning read with the same now.
 */
function pausedView(label: string, pause: PauseView, rights: RightsView): ExecutionView {
	return {
		label,
		kind: "paused",
		keys: PAUSED_KEYS,
		scope: null,
		action: null,
		operationId: null,
		storage: null,
		outcome: null,
		outcomeKeys: [],
		rights,
		plan: null,
		pause,
		sends: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

// adapted from claim-execution.test.ts:609
function failureView(label: string, kind: FailureKind): ExecutionView {
	return {
		label,
		kind,
		keys: FAILURE_KEYS,
		scope: null,
		action: null,
		operationId: null,
		storage: null,
		outcome: null,
		outcomeKeys: [],
		rights: null,
		plan: null,
		pause: null,
		sends: null,
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
}

function outstandingPause(operationIds: string[]): PauseView {
	return {
		kind: "outstanding",
		keys: ["kind", "operationIds"],
		operationIds,
		reasonType: "undefined",
		reasonEmpty: true,
	};
}

const UNKNOWN_PAUSE: PauseView = {
	kind: "unknown",
	keys: FAILURE_KEYS,
	operationIds: null,
	reasonType: "string",
	reasonEmpty: false,
};

function appliedStorage(root: string): StorageView {
	return {
		kind: "applied",
		keys: ["kind", "root"],
		root,
		cause: null,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
	};
}

function rejectedStorage(cause: "stale" | "remote"): StorageView {
	return {
		kind: "rejected",
		keys: ["cause", "kind"],
		root: null,
		cause,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
	};
}

function queriedStorage(after: string, query: string, resolution: string, observedRoot: string | null): StorageView {
	return {
		kind: "queried",
		keys: ["after", "kind", "query"],
		root: null,
		cause: null,
		after,
		query,
		resolution,
		observedRoot,
	};
}

function notSentStorage(cause: string): StorageView {
	return {
		kind: "not-sent",
		keys: ["cause", "kind"],
		root: null,
		cause,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
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

function eligible(boundary: number): Reclaim {
	return { kind: "eligible", boundary };
}

const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

function evaluatedRights(
	ownership: Evaluated["ownership"],
	workRight: WorkRight,
	reclaimState: Reclaim,
	observedRoot: string | null,
	claimGeneration: number | null,
): RightsView {
	return {
		kind: "evaluated",
		keys: EVALUATED_KEYS,
		ownership,
		workRight,
		reclaim: reclaimState,
		observedRoot,
		claimGeneration,
	};
}

function heldRights(root: string, reclaimState: Reclaim, workRight: WorkRight = live(false), generation = 3) {
	return evaluatedRights("held", workRight, reclaimState, root, generation);
}

function foreignRights(root: string, reclaimState: Reclaim, generation = 3): RightsView {
	return evaluatedRights("foreign", noRight("not-holder"), reclaimState, root, generation);
}

function freeRights(root: string, generation = 3): RightsView {
	return evaluatedRights("free", noRight("free"), NOT_APPLICABLE, root, generation);
}

const ABSENT_RIGHTS: RightsView = evaluatedRights("absent", noRight("absent"), NOT_APPLICABLE, null, null);

function rejectedPlan(cause: string, boundary: number | null = null): PlanView {
	return { kind: "rejected", cause, boundary };
}

/** An acquire from absent at T that applied with one send; rights come from the fresh final read. */
function acquiredView(label: string, operationId: string, root: string): ExecutionView {
	return operationView(label, {
		action: "acquire",
		operationId,
		storage: appliedStorage(root),
		outcome: "applied",
		rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
		sends: 1,
	});
}

/**
 * ASSUMPTION(pause): a race loser is an `operation` that sent nothing, with the rights evaluation of its planning read.
 */
function heldView(label: string, operationId: string, rights: RightsView = ABSENT_RIGHTS): ExecutionView {
	return operationView(label, {
		action: "acquire",
		operationId,
		storage: notSentStorage("admission-held"),
		outcome: "not-sent",
		rights,
		sends: 0,
	});
}

/** Journal IO whose `link` publishes and then reports EEXIST, as a parallel identical publish would. */
// adapted from claim-execution.test.ts:809
function racedLink(): JournalIO {
	const publishTwice = async (...args: Parameters<JournalIO["link"]>) => {
		await claimJournalIO.link(...args);
		throw Object.assign(new Error("injected concurrent publish"), { code: "EEXIST" });
	};
	return { ...claimJournalIO, link: publishTwice as unknown as JournalIO["link"] };
}

/** Context IO that runs `action` once, at the first `lstat` of `<directory>/context.json` for which `ready` holds. */
// adapted from claim-execution.test.ts:771
function contextLstatWhen(
	directory: string,
	ready: () => Promise<boolean>,
	action: () => Promise<void>,
): typeof claimContextIO {
	const target = join(directory, "context.json");
	const state = { fired: false };
	const lstatWhen = async (...args: Parameters<typeof claimContextIO.lstat>) => {
		if (!state.fired && String(args[0]) === target && (await ready())) {
			state.fired = true;
			await action();
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatWhen as unknown as typeof claimContextIO.lstat };
}

// adapted from claim-execution.test.ts:862
function tracked<T>(promise: Promise<T>): Tracked<T> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-execution.test.ts:873
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
async function settleWithin<T>(label: string, pending: Tracked<T>): Promise<T> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** In-process gates on the journal seam: each armed step holds its first occurrence until the test releases it. */
class StepGates {
	private readonly gates = new Map<PauseStep, { entered: boolean; release: () => void; released: Promise<void> }>();

	constructor(steps: PauseStep[]) {
		for (const step of steps) {
			const { promise, resolve: release } = Promise.withResolvers<void>();
			this.gates.set(step, { entered: false, release: () => release(), released: promise });
		}
	}

	readonly hook = async (step: PauseStep): Promise<void> => {
		const gate = this.gates.get(step);
		if (gate === undefined || gate.entered) return;
		gate.entered = true;
		await gate.released;
	};

	entered(step: PauseStep): boolean {
		return this.gates.get(step)?.entered ?? false;
	}

	release(step: PauseStep): void {
		this.gates.get(step)?.release();
	}

	releaseAll(): void {
		for (const gate of this.gates.values()) gate.release();
	}
}

/**
 * S2, test-local: every trace2 `start` argv of `git -C <repository> ...`, without that prefix. Product Git inherits
 * GIT_TRACE2_EVENT through gitEnvironment (storage/index.ts:180-196); each child process gets its own file.
 */
// adapted from claim-execution.test.ts:893
async function gitCommandsOf(tracePath: string, repository: string): Promise<string[][]> {
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
		if (field(event, "event") !== "start" || !Array.isArray(argv)) continue;
		const args = argv.map(String);
		if (args[1] === "-C" && args[2] === repository) commands.push(args.slice(3));
	}
	return commands;
}

/** The S1 hook script: numbers each invocation atomically, logs it, then passes, rejects or holds. */
// adapted from claim-execution.test.ts:918
function receiveHook(control: string, phase: ReceivePhase): string {
	return [
		"#!/bin/sh",
		`dir=${shellQuote(control)}`,
		`phase=${phase}`,
		"n=1",
		'while ! mkdir "$dir/$phase-$n" 2>/dev/null; do n=$((n + 1)); done',
		'cat > "$dir/$phase-$n/stdin"',
		'echo "$PPID" > "$dir/$phase-$n/ppid"',
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

/** S1, test-local: scripted receive hooks of one server repository that count, pass, reject or hold pushes (O5). */
// adapted from claim-execution.test.ts:949 (ReceiveScript)
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
	async plan(phase: ReceivePhase, actions: HookAction[], rest: HookAction = "pass"): Promise<void> {
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

/** One server repository with S1 hooks, the executor's client, contexts, the S2 trace, gates and supervisors. */
// adapted from claim-execution.test.ts:1033 (ExecutionCase)
class ExecutionCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The executor's client repository; children of syn-04 share it (ASSUMPTION(pause)). */
	readonly primary: string;
	/** Private 0700 parent of all contexts of this case. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	private readonly tracePath: string;
	private readonly cleanups: (() => Promise<void>)[] = [];
	/** Operation IDs handed to an executor; no reason may echo them. */
	private readonly guarded = new Set<string>();
	private readonly secrets = new Map<string, string>();
	private readonly supervisors: ProbeSupervisor[] = [];
	private readonly gateSets: StepGates[] = [];
	private readonly pendings: Tracked<ClaimExecutionResult>[] = [];
	private previousTrace: string | undefined;
	private tracing = false;
	private writerStore: ClaimStore | undefined;
	private writes = 0;
	private sequence = 0;

	private constructor(format: ClaimStorageFormat, root: string, url: string, serverRepo: string, primary: string) {
		this.format = format;
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.primary = primary;
		this.parent = join(root, "contexts");
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.tracePath = resolve(root, "trace2-events.json");
	}

	static async create(format: ClaimStorageFormat, caseName: string): Promise<ExecutionCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-pause-execution-"));
		try {
			const { name, repo } = await server().initRepository(root, `pause-${format}-${caseName}`);
			const primary = await ExecutionCase.initClient(join(root, "client-executor"));
			const executionCase = new ExecutionCase(format, root, server().url(name), repo, primary);
			await executionCase.hooks.install();
			await mkdir(executionCase.parent);
			await chmod(executionCase.parent, 0o700);
			const initializer = await executionCase.client("initializer");
			expectKind(await initializeClaimStorage(executionCase.storage(initializer)), "created");
			executionCase.startTrace();
			return executionCase;
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

	/** An independent client repository; in-process racers use one each so S2 can attribute their pushes. */
	async client(label: string): Promise<string> {
		return ExecutionCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, changes: Partial<ClaimStorageOptions> = {}): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT, ...changes };
	}

	private async store(repository: string): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.storage(repository)), "open").store;
	}

	async context(): Promise<ContextHandle> {
		const context = expectKind(await createClaimContext({ parent: this.parent }), "created").context;
		return { context, directory: dirname(context.journalDirectory) };
	}

	/** Reads the private secret directly; only tests may do this, and only to prove it is never echoed. */
	private async secretOf(handle: ContextHandle): Promise<string> {
		const cached = this.secrets.get(handle.directory);
		if (cached !== undefined) return cached;
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = (record as { secret?: unknown }).secret;
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		this.secrets.set(handle.directory, secret);
		return secret;
	}

	async view(label: string, result: unknown, handles: ContextHandle[], extra: string[] = []): Promise<ExecutionView> {
		const anywhere = [this.root, this.parent, this.url, OWNER, OTHER_OWNER, ...extra];
		for (const handle of handles) {
			anywhere.push(await this.secretOf(handle), handle.context.binding, handle.directory);
			if (handle.context.recovery) anywhere.push(handle.context.recovery.binding);
		}
		const inReasons = [...this.guarded, ...Object.values(await this.serverRefs())];
		return viewOf(label, result, { anywhere, inReasons });
	}

	async expectView(
		result: unknown,
		expected: ExecutionView,
		handles: ContextHandle[],
		extra: string[] = [],
	): Promise<void> {
		expect(await this.view(expected.label, result, handles, extra)).toStrictEqual(expected);
	}

	options(
		handle: ContextHandle,
		operationId: string,
		request: ClaimTransitionRequest,
		clock: SequenceClock,
		changes: Partial<ExecuteClaimTransitionOptions> = {},
	): ExecuteClaimTransitionOptions {
		this.guarded.add(operationId);
		return {
			storage: this.storage(),
			ticket: TICKET,
			contextDirectory: handle.directory,
			operationId,
			request,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: ATTEMPTS,
			...changes,
		};
	}

	intent(spec: IntentSpec): ClaimOperationIntent {
		return referenceIntent(this.url, { schema: 1, format: this.format, epoch: 1 }, spec);
	}

	acquireIntent(handle: ContextHandle, operationId: string, ticket: string, owner = OWNER): ClaimOperationIntent {
		return this.intent({
			operationId,
			ticket,
			expectedRoot: null,
			request: acquire(owner),
			next: acquiredOf(handle, owner),
		});
	}

	/** Writes one change through the independent writer client and returns the applied root. */
	async writeChange(ticket: string, change: ClaimChange): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		const base = await this.writerStore.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		return expectKind(await this.writerStore.write(base, change), "applied").root;
	}

	async writeState(payload: JsonObject, ticket = TICKET): Promise<string> {
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return this.writeChange(ticket, { operationId, receipt, payload });
	}

	private async digestsOf(handle: ContextHandle, keep: (name: string) => boolean): Promise<Record<string, string>> {
		const found: Record<string, string> = {};
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (keep(name)) found[name] = sha256Hex(await readFile(join(handle.context.journalDirectory, name)));
		}
		return found;
	}

	/** O2 (adapted from claim-execution.test.ts:1215) and O2′: final records and admission slots with digests. */
	async journalView(handle: ContextHandle): Promise<JournalView> {
		return {
			records: await this.digestsOf(handle, (name) => !name.startsWith(".") && name.endsWith(".json")),
			slots: await this.slots(handle),
		};
	}

	async slots(handle: ContextHandle): Promise<Record<string, string>> {
		return this.digestsOf(handle, (name) => name.startsWith(".admission-"));
	}

	async temporaries(handle: ContextHandle): Promise<Record<string, string>> {
		return this.digestsOf(handle, (name) => name.startsWith(".intent-"));
	}

	async journal(handle: ContextHandle): Promise<ClaimIntentJournal> {
		return expectKind(await openClaimIntentJournal({ directory: handle.context.journalDirectory }), "open").journal;
	}

	/** Publishes `intent` through the journal API, as an earlier call of this context would have. */
	async plant(handle: ContextHandle, intent: ClaimOperationIntent): Promise<void> {
		this.guarded.add(intent.operationId);
		const prepared = await (await this.journal(handle)).prepare(intent);
		expect({ planted: intent.operationId, prepared }).toEqual({
			planted: intent.operationId,
			prepared: { kind: "prepared", record: recordOf(intent) },
		});
	}

	/** O1. */
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	async ticketRoot(ticket = TICKET): Promise<string> {
		return (await this.serverRefs())[`refs/claims/${ticket}`] ?? ABSENT_REF;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	async gitCommands(repository = this.primary): Promise<string[][]> {
		return gitCommandsOf(this.tracePath, repository);
	}

	async mark(repository = this.primary): Promise<number> {
		return (await this.gitCommands(repository)).length;
	}

	/** O4: the Git commands and pushes one execution ran in `repository`, from the S2 trace. */
	async finish(pending: Promise<ClaimExecutionResult>, mark: number, repository = this.primary): Promise<Run> {
		const result = await pending;
		const commands = (await this.gitCommands(repository)).slice(mark);
		return { result, gitCalls: commands.length, pushes: commands.filter((args) => args[0] === "push") };
	}

	async run(options: ExecuteClaimTransitionOptions, repository = this.primary): Promise<Run> {
		const mark = await this.mark(repository);
		return this.finish(executeClaimTransition(options), mark, repository);
	}

	/** Starts one in-process call on its own client repository with gates armed at `steps`. */
	async race(handle: ContextHandle, spec: RaceSpec): Promise<Racer> {
		const gates = new StepGates(spec.steps);
		this.gateSets.push(gates);
		const clock = sequenceClock(T, T);
		const journalIO = pauseIO({ directory: handle.context.journalDirectory, onStep: gates.hook });
		const options = this.options(handle, spec.operationId, spec.request, clock, {
			ticket: spec.ticket,
			storage: this.storage(spec.repository),
			journalIO,
		});
		const mark = await this.mark(spec.repository);
		const pending = tracked(executeClaimTransition(options));
		this.pendings.push(pending);
		return { operationId: spec.operationId, repository: spec.repository, clock, gates, mark, pending };
	}

	/** True once `racer` holds at `step`, false when it ended first. */
	atGate(label: string, racer: Racer, step: PauseStep): Promise<boolean> {
		return whilePending(label, racer.pending, async () => racer.gates.entered(step));
	}

	async settle(label: string, racer: Racer): Promise<Run> {
		const result = await settleWithin(label, racer.pending);
		const commands = (await this.gitCommands(racer.repository)).slice(racer.mark);
		return { result, gitCalls: commands.length, pushes: commands.filter((args) => args[0] === "push") };
	}

	async fileGate(step: PauseStep): Promise<FileGate> {
		const dir = join(this.root, `gate-${++this.sequence}`);
		await mkdir(dir);
		return { step, dir, timeoutMs: CHILD_GATE_TIMEOUT };
	}

	async barrierDirectory(): Promise<string> {
		const dir = join(this.root, `barrier-${++this.sequence}`);
		await mkdir(dir);
		return dir;
	}

	/** A supervised `execute` probe on the primary client repository with its own S2 trace file. */
	async startExecuteChild(spec: ChildSpec): Promise<ExecuteChild> {
		this.guarded.add(spec.operationId);
		const trace = resolve(this.root, `trace2-child-${++this.sequence}.json`);
		const command: ExecuteCommand = {
			mode: "execute",
			journalDirectory: spec.handle.context.journalDirectory,
			storage: this.storage(),
			ticket: spec.ticket,
			contextDirectory: spec.handle.directory,
			operationId: spec.operationId,
			request: spec.request,
			clockSkewMs: EPS,
			attempts: ATTEMPTS,
			clock: [T, T],
			gates: spec.gates,
			barrier: spec.barrier,
		};
		const supervisor = ProbeSupervisor.start(command, SUPERVISOR_LIFETIME, { ...process.env, [TRACE_VARIABLE]: trace });
		this.supervisors.push(supervisor);
		await supervisor.next("probe-started");
		return { supervisor, trace };
	}

	async childPushes(child: ExecuteChild): Promise<number> {
		return (await gitCommandsOf(child.trace, this.primary)).filter((args) => args[0] === "push").length;
	}

	/** Waits, bounded, until invocation `n` of `phase` has left its hold. */
	async waitFinished(phase: ReceivePhase, n: number): Promise<void> {
		const deadline = Date.now() + EVENT_TIMEOUT;
		while (!(await this.hooks.hasFinished(phase, n))) {
			if (Date.now() >= deadline) throw new Error(`receive ${phase}-${n} did not finish`);
			await Bun.sleep(10);
		}
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

	async dispose(): Promise<string[]> {
		const problems: string[] = [];
		try {
			for (const gates of this.gateSets) gates.releaseAll();
			await Promise.all(
				this.pendings.map((pending) => settleWithin("pending execution", pending).catch(() => undefined)),
			);
			await this.hooks.releaseAll();
			for (const supervisor of this.supervisors) {
				const problem = await supervisor.shutdown();
				if (problem) problems.push(problem);
				problems.push(...supervisor.errors().map((reason) => `supervisor reported: ${reason}`));
			}
			for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by a cleanup problem. */
// adapted from claim-process-crash.test.ts:372 (withCase)
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: ExecutionCase) => Promise<void>,
): Promise<void> {
	const fixture = await ExecutionCase.create(format, caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	const problems = await fixture.dispose();
	if (failure !== undefined) throw failure;
	expect(problems).toEqual([]);
}

/**
 * Leading positive control of every executor test: a healthy acquire on CONTROL_TICKET applies with one push and
 * two clock calls and leaves exactly its reference record and its reference admission slot (O2, O2′). A base
 * executor applies but never writes a slot, so each test fails here, before any gate, pause or child process.
 */
async function controlAcquire(
	fixture: ExecutionCase,
	handle: ContextHandle,
	ledger: Ledger,
	operationId: string,
): Promise<void> {
	const clock = sequenceClock(T, T);
	const run = await fixture.run(fixture.options(handle, operationId, acquire(), clock, { ticket: CONTROL_TICKET }));
	const root = await fixture.ticketRoot(CONTROL_TICKET);
	await fixture.expectView(run.result, acquiredView(`${operationId} positive control`, operationId, root), [handle]);
	ledger.admitted(fixture.acquireIntent(handle, operationId, CONTROL_TICKET));
	expect({ pushes: run.pushes.length, clockCalls: clock.calls(), journal: await fixture.journalView(handle) }).toEqual({
		pushes: 1,
		clockCalls: 2,
		journal: ledger.view(),
	});
}

for (const format of FORMATS) {
	describe(`claim pause and admission in the executor over real Git (${format})`, () => {
		test(
			"syn-01: admits one of two same-context calls whose scans both ended before any publication",
			async () => {
				await withCase(format, "syn-01", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-syn-01-control");
					const other = await fixture.client("syn-b");
					const rows: { label: string; catches: string; ticket: string; winner: "a" | "b"; holdB: boolean }[] = [
						{
							label: "(a) both held after their scans, A released first",
							catches: "a scan-only check whose loser sends and turns stale",
							ticket: TICKET,
							winner: "a",
							holdB: true,
						},
						{
							label: "(b) both held after their scans, B released first",
							catches: "admission by ID or by start order",
							ticket: SECOND_TICKET,
							winner: "b",
							holdB: true,
						},
						{
							label: "(c) only A held after its scan, B runs through",
							catches: "a blocking lock that makes B wait for A",
							ticket: THIRD_TICKET,
							winner: "b",
							holdB: false,
						},
					];
					for (const [index, row] of rows.entries()) {
						const pre = await fixture.hooks.count("pre");
						const a = await fixture.race(karl, {
							operationId: `op-syn-01-${index + 1}-a`,
							ticket: row.ticket,
							request: acquire(),
							repository: fixture.primary,
							steps: ["after-readdir"],
						});
						const aHeld = await fixture.atGate(`${row.label}: A at G1`, a, "after-readdir");
						expect({ label: row.label, aHeld }).toEqual({ label: row.label, aHeld: true });
						const b = await fixture.race(karl, {
							operationId: `op-syn-01-${index + 1}-b`,
							ticket: row.ticket,
							request: acquire(),
							repository: other,
							steps: row.holdB ? ["after-readdir"] : [],
						});
						const [winner, loser]: [Racer, Racer] = row.winner === "a" ? [a, b] : [b, a];
						let winnerRun: Run;
						let loserRun: Run;
						if (row.holdB) {
							const bHeld = await fixture.atGate(`${row.label}: B at G1`, b, "after-readdir");
							expect({ label: row.label, bHeld }).toEqual({ label: row.label, bHeld: true });
							winner.gates.release("after-readdir");
							winnerRun = await fixture.settle(`${row.label}: winner`, winner);
							loser.gates.release("after-readdir");
							loserRun = await fixture.settle(`${row.label}: loser`, loser);
						} else {
							// Non-blocking: B finishes while A still holds after its scan.
							winnerRun = await fixture.settle(`${row.label}: B while A holds`, winner);
							expect({ label: row.label, aStillHeld: !loser.pending.settled() }).toEqual({
								label: row.label,
								aStillHeld: true,
							});
							loser.gates.release("after-readdir");
							loserRun = await fixture.settle(`${row.label}: A after B`, loser);
						}
						const root = await fixture.ticketRoot(row.ticket);
						const label = `syn-01 ${row.label} (catches: ${row.catches})`;
						await fixture.expectView(winnerRun.result, acquiredView(`${label}: winner`, winner.operationId, root), [
							karl,
						]);
						await fixture.expectView(loserRun.result, heldView(`${label}: loser`, loser.operationId), [karl]);
						ledger.admitted(fixture.acquireIntent(karl, winner.operationId, row.ticket));
						ledger.published(fixture.acquireIntent(karl, loser.operationId, row.ticket));
						expect({
							label: row.label,
							pushes: [winnerRun.pushes.length, loserRun.pushes.length],
							receives: (await fixture.hooks.count("pre")) - pre,
							clockCalls: [winner.clock.calls(), loser.clock.calls()],
							journal: await fixture.journalView(karl),
						}).toEqual({ label: row.label, pushes: [1, 0], receives: 1, clockCalls: [2, 1], journal: ledger.view() });
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"syn-02 syn-03: decides by the slot, not by record order, and pauses on an admitted unsent intent",
			async () => {
				await withCase(format, "syn-02", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-syn-02-control");
					const other = await fixture.client("syn-b");

					// syn-02: both hold after their scans, then both after their record links; A is released first
					// (catches: admission by record order, or a rescan that lets both back off).
					const pre = await fixture.hooks.count("pre");
					const steps: PauseStep[] = ["after-readdir", "after-record-link"];
					const a = await fixture.race(karl, {
						operationId: "op-syn-02-a",
						ticket: TICKET,
						request: acquire(),
						repository: fixture.primary,
						steps,
					});
					const b = await fixture.race(karl, {
						operationId: "op-syn-02-b",
						ticket: TICKET,
						request: acquire(),
						repository: other,
						steps,
					});
					expect({
						aScanned: await fixture.atGate("syn-02 A at G1", a, "after-readdir"),
						bScanned: await fixture.atGate("syn-02 B at G1", b, "after-readdir"),
					}).toEqual({ aScanned: true, bScanned: true });
					a.gates.release("after-readdir");
					b.gates.release("after-readdir");
					expect({
						aPublished: await fixture.atGate("syn-02 A at G2", a, "after-record-link"),
						bPublished: await fixture.atGate("syn-02 B at G2", b, "after-record-link"),
					}).toEqual({ aPublished: true, bPublished: true });
					a.gates.release("after-record-link");
					const aRun = await fixture.settle("syn-02 A", a);
					b.gates.release("after-record-link");
					const bRun = await fixture.settle("syn-02 B", b);
					const root = await fixture.ticketRoot(TICKET);
					await fixture.expectView(aRun.result, acquiredView("syn-02 A released first", "op-syn-02-a", root), [karl]);
					await fixture.expectView(bRun.result, heldView("syn-02 B finds A's slot", "op-syn-02-b"), [karl]);
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-02-a", TICKET));
					ledger.published(fixture.acquireIntent(karl, "op-syn-02-b", TICKET));
					expect({
						pushes: [aRun.pushes.length, bRun.pushes.length],
						receives: (await fixture.hooks.count("pre")) - pre,
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: [1, 0], receives: 1, journal: ledger.view() });

					// syn-03: A holds after its slot link, admitted but unsent; B runs through and pauses on it
					// (catches: a scan that only sees sent intents).
					const held = await fixture.race(karl, {
						operationId: "op-syn-03-a",
						ticket: SECOND_TICKET,
						request: acquire(),
						repository: fixture.primary,
						steps: ["after-slot-link"],
					});
					expect({ admitted: await fixture.atGate("syn-03 A at G3", held, "after-slot-link") }).toEqual({
						admitted: true,
					});
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-03-a", SECOND_TICKET));
					const pre3 = await fixture.hooks.count("pre");
					const clock = sequenceClock(T, T);
					const changes = { ticket: SECOND_TICKET, storage: fixture.storage(other) };
					const paused = await fixture.run(fixture.options(karl, "op-syn-03-b", acquire(), clock, changes), other);
					const expected = pausedView(
						"syn-03 B beside an admitted unsent intent",
						outstandingPause(["op-syn-03-a"]),
						ABSENT_RIGHTS,
					);
					await fixture.expectView(paused.result, expected, [karl]);
					expect({
						pushes: paused.pushes.length,
						clockCalls: clock.calls(),
						receives: (await fixture.hooks.count("pre")) - pre3,
						aStillHeld: !held.pending.settled(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, receives: 0, aStillHeld: true, journal: ledger.view() });
					held.gates.release("after-slot-link");
					const heldRun = await fixture.settle("syn-03 A", held);
					const secondRoot = await fixture.ticketRoot(SECOND_TICKET);
					await fixture.expectView(
						heldRun.result,
						acquiredView("syn-03 A sends after release", "op-syn-03-a", secondRoot),
						[karl],
					);
					expect({ pushes: heldRun.pushes.length, journal: await fixture.journalView(karl) }).toEqual({
						pushes: 1,
						journal: ledger.view(),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"syn-04: keeps the admission across processes: two probes of one context never both send",
			async () => {
				await withCase(format, "syn-04", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-syn-04-control");

					// Ordered at G1 in both orders (catches: a process-local mutex another process never sees).
					for (const [index, first] of (["a", "b"] as const).entries()) {
						const ticket = `BACK-${index + 1}`;
						const second = first === "a" ? "b" : "a";
						const ids = { a: `op-syn-04-${index + 1}-a`, b: `op-syn-04-${index + 1}-b` };
						const gates = { a: await fixture.fileGate("after-readdir"), b: await fixture.fileGate("after-readdir") };
						const children = {
							a: await fixture.startExecuteChild({
								handle: karl,
								operationId: ids.a,
								ticket,
								request: acquire(),
								gates: [gates.a],
							}),
							b: await fixture.startExecuteChild({
								handle: karl,
								operationId: ids.b,
								ticket,
								request: acquire(),
								gates: [gates.b],
							}),
						};
						const label = `syn-04 ${first} released first on ${ticket}`;
						expect({
							label,
							a: await children.a.supervisor.reached(gates.a),
							b: await children.b.supervisor.reached(gates.b),
						}).toEqual({ label, a: true, b: true });
						const pre = await fixture.hooks.count("pre");
						await releaseGate(gates[first]);
						const winner = await children[first].supervisor.output<ExecuteOutput>();
						await releaseGate(gates[second]);
						const loser = await children[second].supervisor.output<ExecuteOutput>();
						const root = await fixture.ticketRoot(ticket);
						await fixture.expectView(winner.result, acquiredView(`${label}: winner`, ids[first], root), [karl]);
						await fixture.expectView(loser.result, heldView(`${label}: loser`, ids[second]), [karl]);
						ledger.admitted(fixture.acquireIntent(karl, ids[first], ticket));
						ledger.published(fixture.acquireIntent(karl, ids[second], ticket));
						expect({
							label,
							pushes: [await fixture.childPushes(children[first]), await fixture.childPushes(children[second])],
							receives: (await fixture.hooks.count("pre")) - pre,
							clockCalls: [winner.clockCalls, loser.clockCalls],
							journal: await fixture.journalView(karl),
						}).toEqual({ label, pushes: [1, 0], receives: 1, clockCalls: [2, 1], journal: ledger.view() });
						await children.a.supervisor.shutdown();
						await children.b.supervisor.shutdown();
					}

					// Three barrier rounds: any interleaving, still exactly one send (catches: two sends against one root).
					for (const round of [11, 12, 13]) {
						const ticket = `BACK-${round}`;
						const ids = [`op-syn-04-${round}-a`, `op-syn-04-${round}-b`];
						const barrier = await fixture.barrierDirectory();
						const pre = await fixture.hooks.count("pre");
						const children: ExecuteChild[] = [];
						for (const operationId of ids) {
							children.push(
								await fixture.startExecuteChild({
									handle: karl,
									operationId,
									ticket,
									request: acquire(),
									gates: [],
									barrier,
								}),
							);
						}
						await openBarrier(barrier, 2);
						const outputs = await Promise.all(children.map((child) => child.supervisor.output<ExecuteOutput>()));
						const verdicts = outputs.map((output) => verdictKind(output.result));
						const pushes = await Promise.all(children.map((child) => fixture.childPushes(child)));
						const winnerId = ids.find((_, position) => verdicts[position] === "applied") ?? "(no winner)";
						const winner = fixture.acquireIntent(karl, winnerId, ticket);
						const slots = await fixture.slots(karl);
						expect({
							round,
							verdicts,
							applied: verdicts.filter((verdict) => verdict === "applied").length,
							losersAllowed: verdicts.every((verdict) => verdict === "applied" || LOSER_VERDICTS.includes(verdict)),
							pushes: pushes.reduce((sum, count) => sum + count, 0),
							receives: (await fixture.hooks.count("pre")) - pre,
							slot: slots[slotName(winner)] ?? null,
						}).toEqual({
							round,
							verdicts,
							applied: 1,
							losersAllowed: true,
							pushes: 1,
							receives: 1,
							slot: sha256Hex(recordText(winner)),
						});
						ledger.admitted(winner);
						for (const [position, operationId] of ids.entries()) {
							if (verdicts[position] === "admission-held")
								ledger.published(fixture.acquireIntent(karl, operationId, ticket));
						}
						expect({ round, journal: await fixture.journalView(karl) }).toEqual({ round, journal: ledger.view() });
						for (const child of children) await child.supervisor.shutdown();
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"syn-05: never blocks other tickets, other contexts or a later root; CAS decides between contexts",
			async () => {
				await withCase(format, "syn-05", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const ledger = new Ledger();
					const franzLedger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-syn-05-control");
					const other = await fixture.client("syn-b");
					const franzRepo = await fixture.client("franz");

					// (a) A on BACK-1 and B on BACK-2, both held after their scans (catches: a key without the ticket).
					const a = await fixture.race(karl, {
						operationId: "op-syn-05-a",
						ticket: TICKET,
						request: acquire(),
						repository: fixture.primary,
						steps: ["after-readdir"],
					});
					const b = await fixture.race(karl, {
						operationId: "op-syn-05-b",
						ticket: SECOND_TICKET,
						request: acquire(),
						repository: other,
						steps: ["after-readdir"],
					});
					expect({
						a: await fixture.atGate("syn-05a A at G1", a, "after-readdir"),
						b: await fixture.atGate("syn-05a B at G1", b, "after-readdir"),
					}).toEqual({ a: true, b: true });
					a.gates.release("after-readdir");
					const aRun = await fixture.settle("syn-05a A", a);
					b.gates.release("after-readdir");
					const bRun = await fixture.settle("syn-05a B", b);
					const aRoot = await fixture.ticketRoot(TICKET);
					const bRoot = await fixture.ticketRoot(SECOND_TICKET);
					await fixture.expectView(
						aRun.result,
						acquiredView("syn-05a A on the first ticket", "op-syn-05-a", aRoot),
						handles,
					);
					await fixture.expectView(
						bRun.result,
						acquiredView("syn-05a B on the second ticket", "op-syn-05-b", bRoot),
						handles,
					);
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-05-a", TICKET));
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-05-b", SECOND_TICKET));

					// (b) two contexts, same absent root: both admitted in their own journals, CAS picks one
					// (catches: a pause or an admission across context boundaries).
					const k = await fixture.race(karl, {
						operationId: "op-syn-05-karl",
						ticket: THIRD_TICKET,
						request: acquire(),
						repository: fixture.primary,
						steps: ["after-readdir"],
					});
					const f = await fixture.race(franz, {
						operationId: "op-syn-05-franz",
						ticket: THIRD_TICKET,
						request: acquire(OTHER_OWNER),
						repository: franzRepo,
						steps: ["after-readdir"],
					});
					expect({
						karl: await fixture.atGate("syn-05b Karl at G1", k, "after-readdir"),
						franz: await fixture.atGate("syn-05b Franz at G1", f, "after-readdir"),
					}).toEqual({ karl: true, franz: true });
					k.gates.release("after-readdir");
					const kRun = await fixture.settle("syn-05b Karl", k);
					f.gates.release("after-readdir");
					const fRun = await fixture.settle("syn-05b Franz", f);
					const kRoot = await fixture.ticketRoot(THIRD_TICKET);
					await fixture.expectView(
						kRun.result,
						acquiredView("syn-05b Karl wins by CAS", "op-syn-05-karl", kRoot),
						handles,
					);
					const staleView = operationView("syn-05b Franz admitted in his context, stale at the server", {
						action: "acquire",
						operationId: "op-syn-05-franz",
						storage: rejectedStorage("stale"),
						outcome: "rejected",
						rights: foreignRights(kRoot, notYet(T + TTL + GRACE), 1),
						sends: 1,
					});
					await fixture.expectView(fRun.result, staleView, handles);
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-05-karl", THIRD_TICKET));
					franzLedger.admitted(fixture.acquireIntent(franz, "op-syn-05-franz", THIRD_TICKET, OTHER_OWNER));

					// (c) B reads only after A landed, while A is still in its final rights read (catches: an own
					// settled intent or its slot blocking the newer root).
					const landing = { acquired: ABSENT_REF };
					const nested: { run?: Run } = {};
					const landed = async () => (await fixture.ticketRoot(FOURTH_TICKET)) !== ABSENT_REF;
					const contextIO = contextLstatWhen(karl.directory, landed, async () => {
						landing.acquired = await fixture.ticketRoot(FOURTH_TICKET);
						const renewOptions = fixture.options(karl, "op-syn-05-renew", renew(), sequenceClock(T, T), {
							ticket: FOURTH_TICKET,
							storage: fixture.storage(other),
						});
						nested.run = await fixture.run(renewOptions, other);
					});
					const outerClock = sequenceClock(T, T);
					const outer = await fixture.run(
						fixture.options(karl, "op-syn-05-acquire", acquire(), outerClock, { ticket: FOURTH_TICKET, contextIO }),
					);
					const renewed = await fixture.ticketRoot(FOURTH_TICKET);
					const outerView = operationView("syn-05c acquire, final read after the renew", {
						action: "acquire",
						operationId: "op-syn-05-acquire",
						storage: appliedStorage(landing.acquired),
						outcome: "applied",
						rights: heldRights(renewed, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(outer.result, outerView, handles);
					const nestedView = operationView("syn-05c renew after the acquire landed", {
						action: "renew",
						operationId: "op-syn-05-renew",
						storage: appliedStorage(renewed),
						outcome: "applied",
						rights: heldRights(renewed, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					expect({ nestedRan: nested.run !== undefined }).toEqual({ nestedRan: true });
					await fixture.expectView(nested.run?.result, nestedView, handles);
					ledger.admitted(fixture.acquireIntent(karl, "op-syn-05-acquire", FOURTH_TICKET));
					ledger.admitted(
						fixture.intent({
							operationId: "op-syn-05-renew",
							ticket: FOURTH_TICKET,
							expectedRoot: landing.acquired,
							request: renew(),
							next: acquiredOf(karl),
						}),
					);
					expect({
						pushes: [aRun.pushes.length, bRun.pushes.length, kRun.pushes.length, fRun.pushes.length],
						karl: await fixture.journalView(karl),
						franz: await fixture.journalView(franz),
					}).toEqual({ pushes: [1, 1, 1, 1], karl: ledger.view(), franz: franzLedger.view() });
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"crs-01: leaves nothing that pauses or needs cleanup after a kill before the record link",
			async () => {
				await withCase(format, "crs-01", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-crs-01-control");
					const rows: { label: string; catches: string; step: PauseStep; ticket: string; temporary: boolean }[] = [
						{
							label: "k1 after the scan, before prepare",
							catches: "a scan marker that pauses the next call",
							step: "after-readdir",
							ticket: TICKET,
							temporary: false,
						},
						{
							label: "k1′ in prepare, before the record link",
							catches: "a temporary that pauses the next call or must be swept",
							step: "record-link",
							ticket: SECOND_TICKET,
							temporary: true,
						},
					];
					for (const [index, row] of rows.entries()) {
						const crashed = fixture.acquireIntent(karl, `op-crs-01-${index + 1}`, row.ticket);
						const refs = await fixture.serverRefs();
						const pre = await fixture.hooks.count("pre");
						const journalBefore = await fixture.journalView(karl);
						const temporariesBefore = await fixture.temporaries(karl);
						const gate = await fixture.fileGate(row.step);
						const child = await fixture.startExecuteChild({
							handle: karl,
							operationId: crashed.operationId,
							ticket: row.ticket,
							request: acquire(),
							gates: [gate],
						});
						expect({ label: row.label, reached: await child.supervisor.reached(gate) }).toEqual({
							label: row.label,
							reached: true,
						});
						const exit = await child.supervisor.killProbe();
						const temporaries = await fixture.temporaries(karl);
						const added = Object.keys(temporaries).filter((name) => !Object.hasOwn(temporariesBefore, name));
						expect({
							label: row.label,
							exit: { code: exit.code, signal: exit.signal },
							journal: await fixture.journalView(karl),
							refs: await fixture.serverRefs(),
							receives: (await fixture.hooks.count("pre")) - pre,
							added: added.map((name) => temporaries[name]),
						}).toEqual({
							label: row.label,
							exit: { code: null, signal: "SIGKILL" },
							journal: journalBefore,
							refs,
							receives: 0,
							added: row.temporary ? [sha256Hex(recordText(crashed))] : [],
						});
						// The next call with a new ID applies at once, and the temporary stays byte-identical.
						const next = `op-crs-01-${index + 1}-next`;
						const clock = sequenceClock(T, T);
						const run = await fixture.run(fixture.options(karl, next, acquire(), clock, { ticket: row.ticket }));
						const root = await fixture.ticketRoot(row.ticket);
						await fixture.expectView(
							run.result,
							acquiredView(`${row.label}: next call (catches: ${row.catches})`, next, root),
							[karl],
						);
						ledger.admitted(fixture.acquireIntent(karl, next, row.ticket));
						expect({
							label: row.label,
							pushes: run.pushes.length,
							journal: await fixture.journalView(karl),
							temporaries: await fixture.temporaries(karl),
						}).toEqual({ label: row.label, pushes: 1, journal: ledger.view(), temporaries });
						await child.supervisor.shutdown();
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"crs-02: reports a killed published intent as outstanding and keeps it admissible exactly once",
			async () => {
				await withCase(format, "crs-02", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-crs-02-control");
					const journal = await fixture.journal(karl);
					const rows: { label: string; catches: string; step: PauseStep; ticket: string; slot: boolean }[] = [
						{
							label: "k2 after the record link, before the slot",
							catches: "an unadmitted intent invisible to the pause, or lost for good",
							step: "after-record-link",
							ticket: TICKET,
							slot: false,
						},
						{
							label: "k3 after the slot link, before the send",
							catches: "an admission lost, granted twice or freed by time after a crash",
							step: "after-slot-link",
							ticket: SECOND_TICKET,
							slot: true,
						},
					];
					for (const [index, row] of rows.entries()) {
						const crashed = fixture.acquireIntent(karl, `op-crs-02-${index + 1}`, row.ticket);
						const refs = await fixture.serverRefs();
						const pre = await fixture.hooks.count("pre");
						const gate = await fixture.fileGate(row.step);
						const child = await fixture.startExecuteChild({
							handle: karl,
							operationId: crashed.operationId,
							ticket: row.ticket,
							request: acquire(),
							gates: [gate],
						});
						expect({ label: row.label, reached: await child.supervisor.reached(gate) }).toEqual({
							label: row.label,
							reached: true,
						});
						const exit = await child.supervisor.killProbe();
						if (row.slot) ledger.admitted(crashed);
						else ledger.published(crashed);
						expect({
							label: row.label,
							exit: { code: exit.code, signal: exit.signal },
							journal: await fixture.journalView(karl),
							refs: await fixture.serverRefs(),
							receives: (await fixture.hooks.count("pre")) - pre,
						}).toEqual({
							label: row.label,
							exit: { code: null, signal: "SIGKILL" },
							journal: ledger.view(),
							refs,
							receives: 0,
						});

						// The next call pauses on the crashed intent and publishes nothing.
						const label = `${row.label} (catches: ${row.catches})`;
						const clock = sequenceClock(T, T);
						const next = `op-crs-02-${index + 1}-next`;
						const run = await fixture.run(fixture.options(karl, next, acquire(), clock, { ticket: row.ticket }));
						const expected = pausedView(`${label}: next call`, outstandingPause([crashed.operationId]), ABSENT_RIGHTS);
						await fixture.expectView(run.result, expected, [karl]);
						expect({
							label,
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							journal: await fixture.journalView(karl),
						}).toEqual({ label, pushes: 0, clockCalls: 1, journal: ledger.view() });

						// The read-only query still sees the intent open on the absent root.
						const query = await queryClaimMutation({
							journalDirectory: karl.context.journalDirectory,
							operationId: crashed.operationId,
							storage: fixture.storage(await fixture.client(`query-${index + 1}`)),
						});
						expect({ label, query }).toEqual({
							label,
							query: { kind: "resolved", resolution: { kind: "open", observedRoot: null } },
						});

						// Admission stays available exactly once: the crashed intent holds its slot, a rival is held.
						expect({ label, admitted: await journal.admit(recordOf(crashed)) }).toEqual({ label, admitted: ADMITTED });
						ledger.admitted(crashed);
						const rival = fixture.acquireIntent(karl, `op-crs-02-${index + 1}-rival`, row.ticket);
						const prepared = await journal.prepare(rival);
						expect({ label, prepared: prepared.kind, rival: await journal.admit(recordOf(rival)) }).toEqual({
							label,
							prepared: "prepared",
							rival: { kind: "held", operationId: crashed.operationId },
						});
						ledger.published(rival);
						expect({ label, journal: await fixture.journalView(karl), refs: await fixture.serverRefs() }).toEqual({
							label,
							journal: ledger.view(),
							refs,
						});
						await child.supervisor.shutdown();
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"exi-01: runs a lifecycle in one context, each call admitted once and none paused by settled ones",
			async () => {
				await withCase(format, "exi-01", async (fixture) => {
					const karl = await fixture.context();
					const binding = karl.context.binding;
					const ledger = new Ledger();
					// ASSUMPTION(pause): the executor captures readdir from a spread seam as well as from the default.
					const seams: { label: string; ticket: string; journalIO?: JournalIO }[] = [
						{ label: "default journal IO", ticket: TICKET },
						{ label: "spread journal IO", ticket: SECOND_TICKET, journalIO: { ...claimJournalIO } },
					];
					const steps: {
						label: string;
						request: ClaimTransitionRequest;
						now: number;
						next: ClaimStateV1;
						rights: (root: string) => RightsView;
					}[] = [
						{
							label: "acquire (positive control)",
							request: acquire(),
							now: T,
							next: active(binding, lease(T + TTL), { claimGeneration: 1 }),
							rights: (root) => heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
						},
						{
							label: "renew",
							request: renew(),
							now: T + MINUTE,
							next: active(binding, lease(T + MINUTE + TTL), { claimGeneration: 1 }),
							rights: (root) => heldRights(root, notYet(T + MINUTE + TTL + GRACE), live(false), 1),
						},
						{
							label: "second renew",
							request: renew(),
							now: T + 2 * MINUTE,
							next: active(binding, lease(T + 2 * MINUTE + TTL), { claimGeneration: 1 }),
							rights: (root) => heldRights(root, notYet(T + 2 * MINUTE + TTL + GRACE), live(false), 1),
						},
						{
							label: "release",
							request: release(),
							now: T + 3 * MINUTE,
							next: tombstone(1),
							rights: (root) => freeRights(root, 1),
						},
						{
							label: "acquire on the tombstone",
							request: acquire(),
							now: T + 4 * MINUTE,
							next: active(binding, lease(T + 4 * MINUTE + TTL), { claimGeneration: 2 }),
							rights: (root) => heldRights(root, notYet(T + 4 * MINUTE + TTL + GRACE), live(false), 2),
						},
					];
					for (const seam of seams) {
						let base: string | null = null;
						for (const [index, step] of steps.entries()) {
							const operationId = `op-exi-01-${seam.ticket}-${index + 1}`;
							const clock = sequenceClock(step.now, step.now);
							const changes =
								seam.journalIO === undefined
									? { ticket: seam.ticket }
									: { ticket: seam.ticket, journalIO: seam.journalIO };
							const run = await fixture.run(fixture.options(karl, operationId, step.request, clock, changes));
							const root = await fixture.ticketRoot(seam.ticket);
							const label = `exi-01 ${seam.label}: ${step.label} (catches: over-blocking by settled own intents)`;
							await fixture.expectView(
								run.result,
								operationView(label, {
									action: step.request.action,
									operationId,
									storage: appliedStorage(root),
									outcome: "applied",
									rights: step.rights(root),
									sends: 1,
								}),
								[karl],
							);
							ledger.admitted(
								fixture.intent({
									operationId,
									ticket: seam.ticket,
									expectedRoot: base,
									request: step.request,
									next: step.next,
								}),
							);
							expect({
								label,
								pushes: run.pushes.length,
								clockCalls: clock.calls(),
								journal: await fixture.journalView(karl),
							}).toEqual({ label, pushes: 1, clockCalls: 2, journal: ledger.view() });
							base = root;
						}
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"exi-02 exi-05: pauses every action on the root of a lost own intent, not on a newer root",
			async () => {
				await withCase(format, "exi-02", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const binding = karl.context.binding;
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-02-control");
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });

					// exi-02(a): an acquire held past the client timeout and declined late stays open (as ret-03a).
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const lostClock = sequenceClock(T, T);
					const lostOptions = fixture.options(karl, "op-exi-02-lost", acquire(), lostClock, {
						storage: loss,
						attempts: 1,
					});
					const lost = await fixture.run(lostOptions);
					const lostView = operationView("exi-02a lost acquire", {
						action: "acquire",
						operationId: "op-exi-02-lost",
						storage: queriedStorage("unknown", "resolved", "open", null),
						outcome: "unknown",
						rights: ABSENT_RIGHTS,
						sends: 1,
					});
					await fixture.expectView(lost.result, lostView, handles);
					await fixture.hooks.release("pre", pre + 1);
					await fixture.waitFinished("pre", pre + 1);
					ledger.admitted(fixture.acquireIntent(karl, "op-exi-02-lost", TICKET));
					const refs = await fixture.serverRefs();
					expect({ ref: await fixture.ticketRoot(TICKET), journal: await fixture.journalView(karl) }).toEqual({
						ref: ABSENT_REF,
						journal: ledger.view(),
					});
					const retryClock = sequenceClock(T, T);
					const retry = await fixture.run(fixture.options(karl, "op-exi-02-retry", acquire(), retryClock));
					const retryView = pausedView(
						"exi-02a new acquire (catches: a record before the pause, a plan-dependent exemption)",
						outstandingPause(["op-exi-02-lost"]),
						ABSENT_RIGHTS,
					);
					await fixture.expectView(retry.result, retryView, handles);
					expect({
						pushes: retry.pushes.length,
						clockCalls: retryClock.calls(),
						refs: await fixture.serverRefs(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, refs, journal: ledger.view() });

					// exi-05: a foreign claim lands, the root changes and the old intent no longer pauses
					// (catches: a pause per ticket instead of per root).
					const foreignRoot = await fixture.writeState(active(franz.context.binding, lease(L), { owner: OTHER_OWNER }));
					const foreignClock = sequenceClock(T, T);
					const refused = await fixture.run(fixture.options(karl, "op-exi-05", acquire(), foreignClock));
					const refusedView = notPlannedView(
						"exi-05 acquire on the newer foreign root",
						rejectedPlan("not-free"),
						foreignRights(foreignRoot, notYet(R)),
					);
					await fixture.expectView(refused.result, refusedView, handles);
					expect({
						pushes: refused.pushes.length,
						clockCalls: foreignClock.calls(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, journal: ledger.view() });

					// exi-02(b): the own claim's renew is lost the same way; renew, release and reclaim all pause.
					const base = await fixture.writeState(active(binding), SECOND_TICKET);
					const pre2 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const lostRenew = await fixture.run(
						fixture.options(karl, "op-exi-02-renew", renew(), sequenceClock(T, T), {
							ticket: SECOND_TICKET,
							storage: loss,
							attempts: 1,
						}),
					);
					const lostRenewView = operationView("exi-02b lost renew", {
						action: "renew",
						operationId: "op-exi-02-renew",
						storage: queriedStorage("unknown", "resolved", "open", base),
						outcome: "unknown",
						rights: heldRights(base, notYet(R)),
						sends: 1,
					});
					await fixture.expectView(lostRenew.result, lostRenewView, handles);
					await fixture.hooks.release("pre", pre2 + 1);
					await fixture.waitFinished("pre", pre2 + 1);
					ledger.admitted(
						fixture.intent({
							operationId: "op-exi-02-renew",
							ticket: SECOND_TICKET,
							expectedRoot: base,
							request: renew(),
							next: active(binding, lease(T + TTL)),
						}),
					);
					const C = R + EPS;
					const rows: {
						label: string;
						catches: string;
						request: ClaimTransitionRequest;
						now: number;
						rights: RightsView;
					}[] = [
						{
							label: "renew",
							catches: "a renew exemption",
							request: renew(),
							now: T,
							rights: heldRights(base, notYet(R)),
						},
						{
							label: "release",
							catches: "a release exemption",
							request: release(),
							now: T,
							rights: heldRights(base, notYet(R)),
						},
						{
							label: "reclaim at C-EPS=R",
							catches: "a reclaim exemption",
							request: reclaim(),
							now: C,
							rights: heldRights(base, eligible(R), live(true)),
						},
					];
					for (const [index, row] of rows.entries()) {
						const clock = sequenceClock(row.now, row.now);
						const run = await fixture.run(
							fixture.options(karl, `op-exi-02-b-${index + 1}`, row.request, clock, { ticket: SECOND_TICKET }),
						);
						const label = `exi-02b ${row.label} (catches: ${row.catches})`;
						await fixture.expectView(
							run.result,
							pausedView(label, outstandingPause(["op-exi-02-renew"]), row.rights),
							handles,
						);
						expect({
							label,
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							ref: await fixture.ticketRoot(SECOND_TICKET),
							journal: await fixture.journalView(karl),
						}).toEqual({ label, pushes: 0, clockCalls: 1, ref: base, journal: ledger.view() });
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"exi-03 exi-04: pauses on an unadmitted not-sent intent and on a remotely rejected one",
			async () => {
				await withCase(format, "exi-03", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-03-control");

					// exi-03, ASSUMPTION(pause): every matching record pauses, admitted or not.
					const racedClock = sequenceClock(T, T);
					const raced = await fixture.run(
						fixture.options(karl, "op-exi-03-raced", acquire(), racedClock, { journalIO: racedLink() }),
					);
					const racedView = operationView("exi-03 identical intent published concurrently", {
						action: "acquire",
						operationId: "op-exi-03-raced",
						storage: notSentStorage("journal-loaded"),
						outcome: "not-sent",
						rights: ABSENT_RIGHTS,
						sends: 0,
					});
					await fixture.expectView(raced.result, racedView, [karl]);
					ledger.published(fixture.acquireIntent(karl, "op-exi-03-raced", TICKET));
					expect({ pushes: raced.pushes.length, journal: await fixture.journalView(karl) }).toEqual({
						pushes: 0,
						journal: ledger.view(),
					});
					const nextClock = sequenceClock(T, T);
					const next = await fixture.run(fixture.options(karl, "op-exi-03-next", acquire(), nextClock));
					const nextView = pausedView(
						"exi-03 next call (catches: a pause only on admitted intents)",
						outstandingPause(["op-exi-03-raced"]),
						ABSENT_RIGHTS,
					);
					await fixture.expectView(next.result, nextView, [karl]);
					expect({
						pushes: next.pushes.length,
						clockCalls: nextClock.calls(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, journal: ledger.view() });

					// exi-04, ASSUMPTION(pause): a final remote rejection leaves the intent pausing its root.
					const base = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					await fixture.hooks.plan("pre", [], "reject");
					const rejectedClock = sequenceClock(T, T);
					const rejected = await fixture.run(
						fixture.options(karl, "op-exi-04-rejected", renew(), rejectedClock, { ticket: SECOND_TICKET }),
					);
					await fixture.hooks.plan("pre", [], "pass");
					const rejectedView = operationView("exi-04 renew declined by the server", {
						action: "renew",
						operationId: "op-exi-04-rejected",
						storage: rejectedStorage("remote"),
						outcome: "rejected",
						rights: heldRights(base, notYet(R)),
						sends: 1,
					});
					await fixture.expectView(rejected.result, rejectedView, [karl]);
					ledger.admitted(
						fixture.intent({
							operationId: "op-exi-04-rejected",
							ticket: SECOND_TICKET,
							expectedRoot: base,
							request: renew(),
							next: active(karl.context.binding, lease(T + TTL)),
						}),
					);
					const againClock = sequenceClock(T, T);
					const again = await fixture.run(
						fixture.options(karl, "op-exi-04-next", renew(), againClock, { ticket: SECOND_TICKET }),
					);
					const againView = pausedView(
						"exi-04 next renew (catches: the journal read as outcome evidence)",
						outstandingPause(["op-exi-04-rejected"]),
						heldRights(base, notYet(R)),
					);
					await fixture.expectView(again.result, againView, [karl]);
					expect({
						pushes: again.pushes.length,
						clockCalls: againClock.calls(),
						ref: await fixture.ticketRoot(SECOND_TICKET),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, ref: base, journal: ledger.view() });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exi-06: pauses as unknown when the journal is unreadable, and rejects a seam without readdir up front",
			async () => {
				await withCase(format, "exi-06", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-06-control");
					const base = await fixture.writeState(active(karl.context.binding));
					const journalDirectory = karl.context.journalDirectory;
					const pretty = recordOf(fixture.acquireIntent(karl, "op-exi-06-pretty", THIRD_TICKET));
					// ASSUMPTION(pause): enumeration failures pause with unknown instead of a top-level failure.
					type Row = {
						label: string;
						catches: string;
						entry?: { name: string; text: string };
						journalIO?: JournalIO;
						optionsError?: true;
					};
					const rows: Row[] = [
						{
							label: "unknown entry notes.txt",
							catches: "an unknown name ignored (fail-open)",
							entry: { name: "notes.txt", text: "notes\n" },
						},
						{
							label: "non-canonical record",
							catches: "an unreadable record skipped",
							entry: { name: "op-exi-06-pretty.json", text: `${JSON.stringify(pretty, null, 2)}\n` },
						},
						{
							label: "readdir EIO",
							catches: "an IO failure read as an empty journal",
							journalIO: pauseIO({
								directory: journalDirectory,
								faults: [{ op: "readdir", target: "dir", code: "EIO", times: 1 }],
							}),
						},
						{
							// readdir is checked with the other seam entries,
							// so a seam without it is an options error before any clock call, never a pause.
							label: "journal seam without readdir",
							catches: "a capture that drops readdir and pauses instead of rejecting the options",
							journalIO: withoutReaddir(),
							optionsError: true,
						},
					];
					for (const [index, row] of rows.entries()) {
						const path = row.entry === undefined ? undefined : join(journalDirectory, row.entry.name);
						if (row.entry !== undefined && path !== undefined) await writePrivate(path, row.entry.text);
						const clock = sequenceClock(T, T);
						const changes = row.journalIO === undefined ? {} : { journalIO: row.journalIO };
						const run = await fixture.run(fixture.options(karl, `op-exi-06-${index + 1}`, renew(), clock, changes));
						if (path !== undefined) await rm(path);
						const label = `exi-06 ${row.label} (catches: ${row.catches})`;
						const expected = row.optionsError
							? failureView(label, "invalid")
							: pausedView(label, UNKNOWN_PAUSE, heldRights(base, notYet(R)));
						await fixture.expectView(run.result, expected, [karl]);
						expect({
							label,
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							ref: await fixture.ticketRoot(TICKET),
							journal: await fixture.journalView(karl),
						}).toEqual({
							label,
							pushes: 0,
							clockCalls: row.optionsError ? 0 : 1,
							ref: base,
							journal: ledger.view(),
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exi-07: keeps precedence: collision and early failures first, then the pause, then the plan",
			async () => {
				await withCase(format, "exi-07", async (fixture) => {
					const karl = await fixture.context();
					const broken = await fixture.context();
					const handles = [karl, broken];
					const binding = karl.context.binding;
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-07-control");
					const readdirCalls = (events: PauseEvent[]) => events.filter((event) => event.op === "readdir").length;

					// (a) a receipt collision beside an open own record on the same root stays invalid
					// (catches: the pause before the collision check).
					const receipt = { schema: 1, intentDigest: sha256Hex("taken"), parameterDigest: sha256Hex("taken") };
					const takenRoot = await fixture.writeChange(TICKET, {
						operationId: "op-exi-07-taken",
						receipt,
						payload: active(binding),
					});
					const open = fixture.intent({
						operationId: "op-exi-07-open",
						expectedRoot: takenRoot,
						request: renew(),
						next: active(binding, lease(T + TTL)),
					});
					await fixture.plant(karl, open);
					ledger.published(open);
					const collisionEvents: PauseEvent[] = [];
					const collisionClock = sequenceClock(T, T);
					const collision = await fixture.run(
						fixture.options(karl, "op-exi-07-taken", renew(), collisionClock, {
							journalIO: pauseIO({ directory: karl.context.journalDirectory, events: collisionEvents }),
						}),
					);
					await fixture.expectView(
						collision.result,
						failureView("exi-07a receipt collision beside an open record", "invalid"),
						handles,
					);
					expect({
						readdir: readdirCalls(collisionEvents),
						pushes: collision.pushes.length,
						clockCallsAtMostOne: collisionClock.calls() <= 1,
						journal: await fixture.journalView(karl),
					}).toEqual({ readdir: 0, pushes: 0, clockCallsAtMostOne: true, journal: ledger.view() });

					// (b) option errors three ways stay invalid: no enumeration, no clock, no network.
					await writePrivate(join(broken.context.journalDirectory, "notes.txt"), "notes\n");
					const stall = await fixture.stallProxy();
					const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
					const stalled = fixture.storage(fixture.primary, { remote: stalledUrl, timeoutMs: STALL_TIMEOUT });
					const settings: { where: string; handle: ContextHandle; storage: ClaimStorageOptions }[] = [
						{ where: "a healthy endpoint", handle: karl, storage: fixture.storage() },
						{ where: "a stalled endpoint", handle: karl, storage: stalled },
						{ where: "a corrupt journal entry", handle: broken, storage: fixture.storage() },
					];
					const earlyClock = sequenceClock();
					for (const [index, setting] of settings.entries()) {
						const events: PauseEvent[] = [];
						const journalIO = pauseIO({ directory: setting.handle.context.journalDirectory, events });
						const options = fixture.options(setting.handle, `op-exi-07-b-${index + 1}`, renew(), earlyClock, {
							storage: setting.storage,
							journalIO,
							attempts: 0,
						});
						const run = await fixture.run(options);
						const label = `exi-07b zero attempts on ${setting.where} (catches: enumeration before local checks)`;
						await fixture.expectView(run.result, failureView(label, "invalid"), handles, [stalledUrl]);
						expect({ label, readdir: readdirCalls(events), gitCalls: run.gitCalls }).toEqual({
							label,
							readdir: 0,
							gitCalls: 0,
						});
					}

					// (c) a read failure beside a corrupt journal is unknown: no enumeration before the read, no clock.
					const refused = `git://127.0.0.1:${await unusedLoopbackPort()}/refused.git`;
					const refusedEvents: PauseEvent[] = [];
					const refusedRun = await fixture.run(
						fixture.options(broken, "op-exi-07-c", renew(), earlyClock, {
							storage: fixture.storage(fixture.primary, { remote: refused }),
							journalIO: pauseIO({ directory: broken.context.journalDirectory, events: refusedEvents }),
						}),
					);
					const refusedLabel =
						"exi-07c unreadable store beside a corrupt journal (catches: enumeration before the read)";
					await fixture.expectView(refusedRun.result, failureView(refusedLabel, "unknown"), handles, [refused]);
					await Bun.sleep(SETTLE_MS);
					expect({
						readdir: readdirCalls(refusedEvents),
						clockCalls: earlyClock.calls(),
						connections: stall.acceptedConnections,
					}).toEqual({ readdir: 0, clockCalls: 0, connections: 0 });

					// (d) ASSUMPTION(pause): an open own acquire against absent pauses a release before the planner
					// can say not-planned {absent} (catches: the plan before the pause).
					const planted = fixture.acquireIntent(karl, "op-exi-07-planted", FOURTH_TICKET);
					await fixture.plant(karl, planted);
					ledger.published(planted);
					const releaseClock = sequenceClock(T, T);
					const released = await fixture.run(
						fixture.options(karl, "op-exi-07-d", release(), releaseClock, { ticket: FOURTH_TICKET }),
					);
					const releasedView = pausedView(
						"exi-07d release beside an open own acquire",
						outstandingPause(["op-exi-07-planted"]),
						ABSENT_RIGHTS,
					);
					await fixture.expectView(released.result, releasedView, handles);
					expect({
						pushes: released.pushes.length,
						clockCalls: releaseClock.calls(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, journal: ledger.view() });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exi-08: sends nothing without its own slot and falls back to nothing when it cannot link one",
			async () => {
				await withCase(format, "exi-08", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-08-control");
					const journalDirectory = karl.context.journalDirectory;

					// (a) the key's slot name is occupied by garbage (catches: a send without admission, a replaced slot).
					const occupied = fixture.acquireIntent(karl, "op-exi-08-a", SECOND_TICKET);
					const garbage = "not an admission slot\n";
					await writePrivate(join(journalDirectory, slotName(occupied)), garbage);
					const foreignSlot = { [slotName(occupied)]: sha256Hex(garbage) };
					const occupiedClock = sequenceClock(T, T);
					const blocked = await fixture.run(
						fixture.options(karl, "op-exi-08-a", acquire(), occupiedClock, { ticket: SECOND_TICKET }),
					);
					const blockedView = operationView("exi-08a slot occupied by garbage", {
						action: "acquire",
						operationId: "op-exi-08-a",
						storage: notSentStorage("admission-corrupt"),
						outcome: "not-sent",
						rights: ABSENT_RIGHTS,
						sends: 0,
					});
					await fixture.expectView(blocked.result, blockedView, [karl]);
					ledger.published(occupied);
					expect({
						pushes: blocked.pushes.length,
						clockCalls: occupiedClock.calls(),
						ref: await fixture.ticketRoot(SECOND_TICKET),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, ref: ABSENT_REF, journal: ledger.view(foreignSlot) });

					// (b) every slot link fails with EIO (catches: a fallback rename or O_EXCL write, a send anyway).
					const unlinked = fixture.acquireIntent(karl, "op-exi-08-b", THIRD_TICKET);
					const events: PauseEvent[] = [];
					const journalIO = pauseIO({
						directory: journalDirectory,
						events,
						faults: [{ op: "link", target: "slot", code: "EIO", times: Number.MAX_SAFE_INTEGER }],
					});
					const failedClock = sequenceClock(T, T);
					const failedRun = await fixture.run(
						fixture.options(karl, "op-exi-08-b", acquire(), failedClock, { ticket: THIRD_TICKET, journalIO }),
					);
					const failedView = operationView("exi-08b slot link EIO", {
						action: "acquire",
						operationId: "op-exi-08-b",
						storage: notSentStorage("admission-unavailable"),
						outcome: "not-sent",
						rights: ABSENT_RIGHTS,
						sends: 0,
					});
					await fixture.expectView(failedRun.result, failedView, [karl]);
					ledger.published(unlinked);
					const slotWrites = events.filter(
						(event) => event.target === "slot" && ["open-write", "write", "unlink"].includes(event.op),
					);
					expect({
						pushes: failedRun.pushes.length,
						clockCalls: failedClock.calls(),
						linkTried: events.some((event) => event.op === "link" && event.target === "slot"),
						slotWrites: slotWrites.length,
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, linkTried: true, slotWrites: 0, journal: ledger.view(foreignSlot) });

					// The published but unadmitted intent now pauses its root until its own admission succeeds.
					const nextClock = sequenceClock(T, T);
					const next = await fixture.run(
						fixture.options(karl, "op-exi-08-b-next", acquire(), nextClock, { ticket: THIRD_TICKET }),
					);
					const nextView = pausedView("exi-08b next call", outstandingPause(["op-exi-08-b"]), ABSENT_RIGHTS);
					await fixture.expectView(next.result, nextView, [karl]);
					expect({
						pushes: next.pushes.length,
						clockCalls: nextClock.calls(),
						journal: await fixture.journalView(karl),
					}).toEqual({ pushes: 0, clockCalls: 1, journal: ledger.view(foreignSlot) });
					const recovery = await fixture.journal(karl);
					expect(await recovery.admit(recordOf(unlinked))).toEqual(ADMITTED);
					ledger.admitted(unlinked);
					expect(await fixture.journalView(karl)).toEqual(ledger.view(foreignSlot));
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exi-09: a retry resends under the admission of its first send and never admits again",
			async () => {
				await withCase(format, "exi-09", async (fixture) => {
					const karl = await fixture.context();
					const binding = karl.context.binding;
					const ledger = new Ledger();
					await controlAcquire(fixture, karl, ledger, "op-exi-09-control");
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });

					// The set-up of ret-02; the first push is held past the client timeout and declined
					// late, the open intent is resent once (catches: an admission per attempt at the loop head).
					const base = await fixture.writeState(active(binding), SECOND_TICKET);
					const events: PauseEvent[] = [];
					let admittedAt = -1;
					const journalIO = pauseIO({
						directory: karl.context.journalDirectory,
						events,
						onStep: (step) => {
							if (step === "after-slot-link" && admittedAt < 0) admittedAt = events.length;
							return Promise.resolve();
						},
					});
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const clock = sequenceClock(T, T);
					const run = await fixture.run(
						fixture.options(karl, "op-exi-09", renew(), clock, {
							ticket: SECOND_TICKET,
							storage: loss,
							attempts: 2,
							journalIO,
						}),
					);
					const renewed = await fixture.ticketRoot(SECOND_TICKET);
					const view = operationView("exi-09 identical retry under one admission", {
						action: "renew",
						operationId: "op-exi-09",
						storage: appliedStorage(renewed),
						outcome: "applied",
						rights: heldRights(renewed, notYet(T + TTL + GRACE)),
						sends: 2,
					});
					await fixture.expectView(run.result, view, [karl]);
					const receives = (await fixture.hooks.count("pre")) - pre;
					await fixture.hooks.release("pre", pre + 1);
					await fixture.waitFinished("pre", pre + 1);
					ledger.admitted(
						fixture.intent({
							operationId: "op-exi-09",
							ticket: SECOND_TICKET,
							expectedRoot: base,
							request: renew(),
							next: active(binding, lease(T + TTL)),
						}),
					);
					const slotEvents = events.filter((event) => event.target === "slot");
					const afterAdmission =
						admittedAt < 0 ? null : events.slice(admittedAt).filter((event) => event.target === "slot");
					expect({
						pushes: run.pushes.length,
						distinctPushes: new Set(run.pushes.map((args) => args.join("\0"))).size,
						receives,
						slotLinks: slotEvents.filter((event) => event.op === "link").length,
						afterAdmission,
						clockCalls: clock.calls(),
						ref: await fixture.ticketRoot(SECOND_TICKET),
						journal: await fixture.journalView(karl),
					}).toEqual({
						pushes: 2,
						distinctPushes: 1,
						receives: 2,
						slotLinks: 1,
						afterAdmission: [],
						clockCalls: 2,
						ref: renewed,
						journal: ledger.view(),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);
	});
}
