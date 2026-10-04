/**
 * Level G of the time path: the core `executeClaimTransition` with `timePath` and `resendClaimIntent` run in process
 * against the loopback Git daemon of claim-git-fixture.ts; tpg-10, tpg-12 and the replacement context of crs-03 go
 * through the surface core. tpg-01 and tpg-02 run on blob, tree and commit-chain, every other case on blob: 17 cases,
 * 21 runs. A test-local S1 receive script numbers the pushes of one call (P first, then the witness A) and passes,
 * holds or declines each; S2 is the trace2 record of each client repository. The crash cases, the bound form included,
 * run the child probe fixtures/claim-time-path-probe.ts, an adapted copy of claim-admission-probe.ts (which cannot
 * switch the time path on), and continue in this process, the new process. `attempts` holds per intent, one budget
 * covers P and A. Every test opens with a positive control that the typed scaffold (planner still `requires-time-path`,
 * `claimConfirmationId` → "", `queryClaimTransition` → unavailable) cannot satisfy; every expectation names what it
 * catches. Follow-up calls target a changed root or come from another context, so no own open intent pauses them; the
 * one same-context call at an unchanged root is tpg-06's pause at p, on purpose, and the re-sends of
 * `resendClaimIntent`, which send the very intent that is open and which the pause does not govern (crs-05: the retry
 * of the own P ID is the way out of the pause at q). Names the scaffold adds are ASSUMPTION(scaffold), choices the
 * contract leaves open ASSUMPTION(time path), observations still due [?]. claim-git-fixture.ts,
 * claim-admission-probe.ts and every existing test file stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimExecutionResult,
	type ExecuteClaimTransitionOptions,
	executeClaimTransition,
	resendClaimIntent,
} from "../claims/execution/index.ts";
import type { ClaimIntentRecord, ClaimOperationIntent } from "../claims/journal/index.ts";
import { queryClaimMutation, queryClaimTransition } from "../claims/query/index.ts";
import { type ClaimMutationReceipt, claimConfirmationId } from "../claims/resolution/index.ts";
import {
	type ActiveClaimState,
	type ClaimRightEvaluation,
	type ClaimStateV1,
	type ClaimTiming,
	type PendingClaimState,
	queryClaimRight,
} from "../claims/rights/index.ts";
import {
	type ClaimChange,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimLocalTickets,
	type ClaimMutationInput,
	type ClaimStatus,
	type ClaimSurfaceEnv,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import {
	CLAIM_TRANSITION_ACTIONS,
	type ClaimLeaseRequest,
	type ClaimTimeBoxRequest,
	type ClaimTransitionAction,
	type ClaimTransitionRequest,
} from "../claims/transition/index.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";
import {
	type ExecuteOutput,
	type FileGate,
	type PauseStep,
	ProbeSupervisor,
	type TimePathCommand,
} from "./fixtures/claim-time-path-probe.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/** Bundled cases run several executions per test (claim-execution-administration.test.ts:61-63). */
const TEST_TIMEOUT = 60_000;
/** Cases that wait out scripted holds of LOSS_TIMEOUT or a child process. */
const LONG_TEST_TIMEOUT = 90_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout in lost-reply cases; every scripted hold outlasts it (claim-execution-administration:68). */
const LOSS_TIMEOUT = 2_000;
/** Per-Git-command timeout of a call whose push is held in pre-receive on purpose (:70). */
const HELD_SEND_TIMEOUT = 10_000;
/** Bound for waiting on hook entries, landings, hook drains and settling calls. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
/** How long a child waits at a file gate before it gives up (claim-execution-pause.test.ts:81). */
const CHILD_GATE_TIMEOUT = 8_000;
const SUPERVISOR_LIFETIME = 60_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
const THIRD_TICKET = "BACK-3";
/** Ticket of every leading positive control, so it never shares a root with the case after it. */
const CONTROL_TICKET = "BACK-9";
/** Sends allowed per call unless a case says otherwise; a healthy T call sends P once and A once. */
const ATTEMPTS = 3;
/** Placeholder for a ticket ref the server does not have, or a landing S1 never saw. */
const ABSENT_REF = "(no ref)";
/** Placeholder for a key a document does not have; no document value ever equals it. */
const ABSENT = "(absent)";
/**
 * [?] As claim-execution-administration.test.ts:92-96: the loser of a push against a moved ref fails at the server's
 * ref update ("remote") or at the client's lease check ("stale"); both are accepted, `unknown` or `applied` is not.
 */
const REJECTED_CAUSE = "stale-or-remote";
/** Distinctive owner names that no core result or document may echo (owners only in `claim list`). */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const THIRD_OWNER = "agent-sentinel-lena";
/** operation_budget_ms of the surface configuration (claim-surface-administration.test.ts:101). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the surface's monotonic clock; it never moves, so no budget runs out. */
const MONO_START = 5_000;

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z); the constants of claim-transition.test.ts:36-47, every instant derived from T. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05", its reclaim boundary "10:15" and the source's hard end H_s "11:00". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;
/** The target's hard end H_t = H + 60 min, and one more hour for a second extension. */
const H2 = H + 60 * MINUTE;
const H3 = H2 + 60 * MINUTE;
/** The hull max(R(source), R(target)) of a hard source H and a hard target H2. */
const HULL = H2 + GRACE;
/** A later clock for re-sends, so a re-computed time box would differ from the frozen one. */
const RETRY_AT = T + 2 * MINUTE;

/** The base operation keys (claim-execution-administration.test.ts:116), unchanged for every D result. */
const OPERATION_KEYS = ["action", "kind", "operationId", "outcome", "rights", "scope", "sends", "storage"];
/** ASSUMPTION(scaffold): a T result adds exactly `transition`. */
const TIME_PATH_KEYS = [...OPERATION_KEYS, "transition"];
/** ASSUMPTION(time path): the executor's `transition` object, sorted. */
const TRANSITION_KEYS = ["confirmOperationId", "confirmation", "observeBefore", "phase", "reclaimBoundary"];
const NOT_PLANNED_KEYS = ["kind", "plan", "rights"];
const PAUSED_KEYS = ["kind", "pause", "rights"];
const EVALUATED_KEYS = ["claimGeneration", "kind", "observedRoot", "ownership", "reclaim", "scope", "workRight"];
/** The base claim-operation keys (claim-next-git.test.ts:216-231), sorted by code units. */
const OPERATION_DOCUMENT_KEYS = [
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
/** A T call's claim-operation adds `transition`; "ticket" < "transition" by code units. */
const TIME_PATH_DOCUMENT_KEYS = [...OPERATION_DOCUMENT_KEYS, "transition"];
/** The base claim-resolution keys (surface/index.ts:403-413) plus `transition` of a P ID, sorted. */
const RESOLUTION_DOCUMENT_KEYS = [
	"action",
	"command",
	"kind",
	"operationId",
	"outcome",
	"query",
	"schemaVersion",
	"status",
	"ticket",
	"transition",
];
/** The base claim-error keys without optional fields (claim-next-git.test.ts:233). */
const ERROR_DOCUMENT_KEYS = ["code", "command", "kind", "message", "operationId", "schemaVersion", "status", "ticket"];

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type Outcome = "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
type ContextHandle = { context: ClaimContext; directory: string };
type SequenceClock = { clock: () => number; calls: () => number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type Invocation = { n: number; lines: string[] };
type Receive = { from: string | null; to: string; ref: string };
type Run = { result: ClaimExecutionResult; gitCalls: number; pushes: string[][] };
type Tracked<V> = { promise: Promise<V>; settled: () => boolean };
type Racer = { repository: string; mark: number; pending: Tracked<ClaimExecutionResult> };
type Sentinels = { anywhere: string[]; inReasons: string[] };
type StoredView = { revision: number; payload: string; receipt: string | null };
type QueryView = { kind: string | null; resolution: string | null; observedRoot: string | null };
/** Through the composite query of a P ID: the logical kind and the phase only. */
type TransitionQueryView = { kind: string | null; logical: string | null; phase: string | null };
type StateChanges = { claimGeneration?: number; bindingGeneration?: number; owner?: string };
/** Explicit option overrides; built field by field, never spread over the mandatory options (base type trap). */
type OptionChanges = {
	storage?: ClaimStorageOptions;
	ticket?: string;
	attempts?: number;
	expectedClaimGeneration?: number;
	targetContextDirectory?: string;
};
type ResendChanges = { storage?: ClaimStorageOptions; attempts?: number };
type ResendOptions = Parameters<typeof resendClaimIntent>[0];
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
type PauseView = { kind: string | null; keys: string[]; operationIds: string[] | null };
/** In the executor: phase, A's ID and storage fact, the observation deadline and the hull. */
type TransitionView = {
	keys: string[];
	phase: string | null;
	confirmOperationId: string | null;
	observeBefore: number | null;
	reclaimBoundary: number | null;
	confirmation: StorageView | null;
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
	transition: TransitionView | null;
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
type TimePathExpectation = OperationExpectation & { transition: TransitionView };
/**
 * One not-planned call: the rights evaluation of the planning read, no push, one clock read, root and own journal
 * unchanged.
 */
type RefusalRow = {
	label: string;
	catches: string;
	handle: ContextHandle;
	operationId: string;
	request: ClaimTransitionRequest;
	changes: OptionChanges;
	now: number;
	plan: PlanView;
	rights: RightsView;
};
/** The final records and admission slots of one context journal (claim-next-git.test.ts:134). */
type JournalView = { records: string[]; slots: number };
/** The witness A as persisted in the source journal, read from its record file. */
type WitnessView = {
	present: boolean;
	expectedRoot: unknown;
	targetBinding: unknown;
	/** execution/index.ts:652-654 and surface/index.ts:2120 re-send and retry only records of the seven actions. */
	actionKnown: boolean;
	parameters: unknown;
	next: unknown;
	digestsValid: boolean;
};
/** One healthy T call, the positive control of most cases and the body of tpg-01 and tpg-02. */
type TransitionSpec = {
	label: string;
	catches: string;
	handle: ContextHandle;
	ticket: string;
	operationId: string;
	source: ActiveClaimState;
	request: ClaimTransitionRequest;
	next: ActiveClaimState;
	target?: ContextHandle;
	/** The source's fresh rights view after A at the landed root. */
	rights: (root: string) => RightsView;
	hull: number;
	observeBefore?: number;
	/** The three clock reads of the T call (plan, observation, end); default T, T, T. */
	reads?: [number, number, number];
};
type Confirmed = {
	base: string;
	landed: string;
	root: string;
	pIntent: ClaimOperationIntent;
	confirmId: string;
	/** The pre-receive count after the seed write: `receives("pre", pre)` holds P and A only. */
	pre: number;
};
type ProbeSpec = {
	handle: ContextHandle;
	ticket: string;
	operationId: string;
	request: ClaimTransitionRequest;
	target?: ContextHandle;
	clock: number[];
	gates: FileGate[];
};
type SurfaceSettings = { enabled: boolean; attempts: number; attemptTimeoutMs: number };
type SurfaceDocument =
	| Awaited<ReturnType<typeof runClaimMutation>>
	| Awaited<ReturnType<typeof runClaimRetry>>
	| Awaited<ReturnType<typeof runClaimResolve>>;
/** One public document: keys, the verdict fields, `transition` as a view, the exit code and echoed sentinels. */
type DocumentView = {
	label: string;
	exit: number;
	keys: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	action: unknown;
	ticket: unknown;
	operationId: unknown;
	outcome: unknown;
	rejection: unknown;
	sends: unknown;
	stoppedBy: unknown;
	code: unknown;
	ownership: unknown;
	transition: unknown;
	echoed: string[];
};

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-execution-administration.test.ts:257-260
function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-execution-administration.test.ts:263-266
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-execution-administration.test.ts:270-281
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

// adapted from claim-execution-administration.test.ts:284-286
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** A fresh plain JSON copy of fixture data. */
// adapted from claim-execution-administration.test.ts:290-292
function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// adapted from claim-execution-administration.test.ts:303-306
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-execution-administration.test.ts:316-318
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution-administration.test.ts:321-323
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

// adapted from claim-execution-administration.test.ts:326-333
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** `--hard-end` rule: ISO-8601 with a zone; `toISOString` keeps the millisecond. */
// adapted from claim-cli-administration.test.ts:899-902
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// adapted from claim-execution-administration.test.ts:364-366
function lease(leaseEnd: number, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

// adapted from claim-execution-administration.test.ts:369-371
function hard(hardEnd = H): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

/** The base claim of every case: generation 3, binding generation 1, OWNER; explicit fields instead of a spread. */
// adapted from claim-execution-administration.test.ts:375-385
function active(binding: string, timing: ClaimTiming, changes: StateChanges = {}): ActiveClaimState {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: changes.claimGeneration ?? 3,
		bindingGeneration: changes.bindingGeneration ?? 1,
		owner: changes.owner ?? OWNER,
		binding,
		timing,
	};
}

// adapted from claim-execution-administration.test.ts:388-390
function tombstone(claimGeneration: number): ClaimStateV1 {
	return { claimState: 1, status: "free", claimGeneration };
}

/** The transfer form: generation 4, binding generation 1, the target's binding, OTHER_OWNER. */
// adapted from claim-execution-administration.test.ts:393-395
function transferred(target: ContextHandle, timing: ClaimTiming): ActiveClaimState {
	return active(target.context.binding, timing, { claimGeneration: 4, bindingGeneration: 1, owner: OTHER_OWNER });
}

/** A resume keeps generation, owner and timing and raises the binding generation by one. */
function resumedBy(handle: ContextHandle, from: ActiveClaimState): ActiveClaimState {
	return active(handle.context.binding, from.timing, {
		claimGeneration: from.claimGeneration,
		bindingGeneration: from.bindingGeneration + 1,
		owner: from.owner,
	});
}

/**
 * Exactly `{claimState: 1, status: "pending", claimGeneration, source, target}` with the target's
 * generation. ASSUMPTION(scaffold): the rights type `PendingClaimState` of that shape.
 */
function pendingState(source: ActiveClaimState, target: ActiveClaimState): PendingClaimState {
	return { claimState: 1, status: "pending", claimGeneration: target.claimGeneration, source, target };
}

// adapted from claim-execution-administration.test.ts:403-410
function renew(): ClaimTransitionRequest {
	return { action: "renew", ttlMs: TTL, ttlSource: "default" };
}

// adapted from claim-execution-administration.test.ts:413-420
function release(): ClaimTransitionRequest {
	return { action: "release" };
}

function reclaim(): ClaimTransitionRequest {
	return { action: "reclaim" };
}

function resume(): ClaimTransitionRequest {
	return { action: "resume" };
}

function acquireHard(owner: string, hardEnd: number): ClaimTransitionRequest {
	return { action: "acquire", owner, timing: { mode: "hard", hardEnd, graceMs: GRACE } };
}

function defaultLease(): ClaimLeaseRequest {
	return { ttlMs: TTL, ttlSource: "default" };
}

/** ASSUMPTION(scaffold): `ClaimTimeBoxRequest.hardEnd?: number` on restart. */
function restartTo(hardEnd: number): ClaimTimeBoxRequest {
	return { action: "restart", source: "explicit", hardEnd };
}

/** (ii): a transfer restart with an explicit new hard end; a hard source takes no lease request. */
function transfer(timeBox: ClaimTimeBoxRequest, leaseInput: ClaimLeaseRequest | null = null): ClaimTransitionRequest {
	return { action: "transfer", owner: OTHER_OWNER, timeBox, lease: leaseInput };
}

/** A bound change is an absolute state-form timing. */
function changeBounds(timing: ClaimTiming): ClaimTransitionRequest {
	return { action: "change-bounds", timing };
}

/** A PENDING successor's intent carries the target's binding (today `null`, execution:360). */
function bindingOf(next: ClaimStateV1): string | null {
	if (next.status === "active") return next.binding;
	if (next.status === "pending") return next.target.binding;
	return null;
}

/** The reference intent from constants (epoch 1), never from the plan under test. */
// adapted from claim-execution-administration.test.ts:463-477, targetBinding as the time path defines it
function referenceIntent(remote: string, format: ClaimStorageFormat, spec: IntentSpec): ClaimOperationIntent {
	return {
		operationId: spec.operationId,
		remote,
		format,
		epoch: 1,
		ticket: spec.ticket ?? TICKET,
		expectedRoot: spec.expectedRoot,
		targetBinding: bindingOf(spec.next),
		action: spec.request.action,
		parameters: json(spec.request),
		resolved: { next: json(spec.next) },
	};
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
// adapted from claim-execution-administration.test.ts:481-488
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference receipt: exactly the schema and both digests of the record. */
// adapted from claim-execution-administration.test.ts:492-494
function receiptOf(record: ClaimIntentRecord): ClaimMutationReceipt {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

/** O2 of one final record: the digest of its exact on-disk bytes (claim-execution-administration.test.ts:498). */
function recordDigest(intent: ClaimOperationIntent): string {
	return sha256Hex(`${canonicalJson(recordOf(intent))}\n`);
}

/** O3: the stored payload is `next` and the receipt belongs to the reference record. */
// adapted from claim-execution-administration.test.ts:504-507
function storedView(next: ClaimStateV1, intent: ClaimOperationIntent, revision: number): StoredView {
	const receipt = receiptOf(recordOf(intent));
	return { revision, payload: sha256Hex(canonicalJson(next)), receipt: sha256Hex(canonicalJson(receipt)) };
}

/**
 * The witness parameters, exactly. ASSUMPTION(time path): `transitionDigest` is the digest of
 * the P record; `observeBefore` is H_s of the source.
 */
function witnessParameters(pRecord: ClaimIntentRecord, observedAt: number, observeBefore = H): JsonObject {
	return {
		stage: "confirm",
		transition: pRecord.intent.operationId,
		transitionDigest: pRecord.digest,
		observedAt,
		clockSkewMs: EPS,
		observeBefore,
	};
}

/** The expected witness: expected root p, the target's binding, the witness parameters and `next` = target. */
function witness(
	pIntent: ClaimOperationIntent,
	landed: string,
	next: ActiveClaimState,
	observedAt: number,
	observeBefore = H,
): WitnessView {
	return {
		present: true,
		expectedRoot: landed,
		targetBinding: next.binding,
		actionKnown: true,
		parameters: witnessParameters(recordOf(pIntent), observedAt, observeBefore),
		next: json(next),
		digestsValid: true,
	};
}

const NO_WITNESS: WitnessView = {
	present: false,
	expectedRoot: null,
	targetBinding: null,
	actionKnown: false,
	parameters: null,
	next: null,
	digestsValid: false,
};

/** A receive-hook stdin line `<old> <new> <ref>`; an all-zero old ID (creation) is shown as null. */
// adapted from claim-execution-administration.test.ts:525-528
function receiveOf(line: string): Receive {
	const [from = "", to = "", ref = ""] = line.split(" ");
	return { from: /^0+$/.test(from) ? null : from, to, ref };
}

/** The new root of the first push S1 saw since a mark: p of a T call, whose first push is P. */
function firstLanding(receives: Receive[][]): string {
	return receives.at(0)?.at(0)?.to ?? ABSENT_REF;
}

/** A clock that serves `reads` in order and counts its calls; a call beyond them throws. */
// adapted from claim-execution-administration.test.ts:541-552
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

/** A clock that always reads `now`: for re-sends, whose number of reads is not fixed. */
function steadyClock(now: number): SequenceClock {
	return sequenceClock(now, now, now, now, now, now);
}

// adapted from claim-execution-administration.test.ts:555-558
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

/** The value under `key`, or ABSENT when there is no such own key. */
// adapted from claim-next-git.test.ts:269-272
function entryOf(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return ABSENT;
	return (value as Record<string, unknown>)[key];
}

function textOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberOf(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-execution-administration.test.ts:568-573
function reasonsOf(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, entry]) =>
		key === "reason" && typeof entry === "string" ? [entry] : reasonsOf(entry),
	);
}

// adapted from claim-execution-administration.test.ts:576-589
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

// adapted from claim-execution-administration.test.ts:592-603
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

// adapted from claim-execution-administration.test.ts:606-613
function planViewOf(value: unknown): PlanView {
	const boundary = field(value, "boundary");
	return {
		kind: textOf(field(value, "kind")),
		cause: textOf(field(value, "cause")),
		boundary: typeof boundary === "number" ? boundary : null,
	};
}

// adapted from claim-execution-pause.test.ts:495-505 (pauseViewOf), without the reason of an unknown pause
function pauseViewOf(value: unknown): PauseView {
	const ids = field(value, "operationIds");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		operationIds: Array.isArray(ids) && ids.every((id) => typeof id === "string") ? [...ids] : null,
	};
}

function transitionViewOf(value: unknown): TransitionView {
	const confirmation = field(value, "confirmation");
	return {
		keys: keysOf(value),
		phase: textOf(field(value, "phase")),
		confirmOperationId: textOf(field(value, "confirmOperationId")),
		observeBefore: numberOf(field(value, "observeBefore")),
		reclaimBoundary: numberOf(field(value, "reclaimBoundary")),
		confirmation: confirmation === null || confirmation === undefined ? null : storageViewOf(confirmation),
	};
}

/**
 * The verdict view of one result. `anywhere` values (secrets, bindings, recovery bindings, paths, endpoint, owners)
 * may appear nowhere in the result; `inReasons` values (operation IDs, roots) may appear in no reason at any depth.
 */
// adapted from claim-execution-administration.test.ts:620-649, plus pause (claim-execution-pause.test.ts:512) and
// the `transition` object
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
	const transition = field(result, "transition");
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
		transition: transition === undefined ? null : transitionViewOf(transition),
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
		echoed,
	};
}

/** A D result: exactly the base keys, no `transition` (D documents keep their keys). */
// adapted from claim-execution-administration.test.ts:653-671
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
		transition: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

/** A T result: `operationId` and `storage` are P's, `sends` counts P and A, plus `transition`. */
function timePathView(label: string, expected: TimePathExpectation): ExecutionView {
	return { ...operationView(label, expected), keys: TIME_PATH_KEYS, transition: expected.transition };
}

// adapted from claim-execution-administration.test.ts:674-692
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
		transition: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

/**
 * `paused` has exactly kind, pause and the rights evaluation of the planning read (claim-execution-pause.test.ts:600).
 */
function pausedView(label: string, operationIds: string[], rights: RightsView): ExecutionView {
	return {
		...notPlannedView(label, { kind: null, cause: null, boundary: null }, rights),
		kind: "paused",
		keys: PAUSED_KEYS,
		plan: null,
		pause: { kind: "outstanding", keys: ["kind", "operationIds"], operationIds },
	};
}

/** `applied` carries the root only, never the written document. */
// adapted from claim-execution-administration.test.ts:717-728
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

// adapted from claim-execution-administration.test.ts:732-743
function rejectedStorage(cause: string): StorageView {
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

// adapted from claim-execution-administration.test.ts:746-757
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

/**
 * The executor's `transition`. ASSUMPTION(time path): without a witness
 * `confirmOperationId` and `confirmation` are null; `confirmation` is A's storage fact in the executor's form.
 */
function transitionOf(
	phase: "none" | "pending" | "witnessed" | "confirmed",
	confirmOperationId: string | null,
	confirmation: StorageView | null,
	reclaimBoundary: number,
	observeBefore = H,
): TransitionView {
	return { keys: TRANSITION_KEYS, phase, confirmOperationId, observeBefore, reclaimBoundary, confirmation };
}

/**
 * Folds the two accepted causes of a declined push into REJECTED_CAUSE [?], in `storage` and `confirmation`: the
 * `cause` of a final `rejected` and the `after` of a declined send that went to the query (tpg-07 row i).
 */
// adapted from claim-execution-administration.test.ts:794-800 (normalizedCause)
function normalizedCause(view: ExecutionView): ExecutionView {
	const fold = (storage: StorageView | null): StorageView | null => {
		const cause = storage?.cause ?? null;
		const after = storage?.after ?? null;
		if (storage?.kind === "queried" && (after === "stale" || after === "remote")) {
			return { ...storage, after: REJECTED_CAUSE };
		}
		if (storage === null || storage.kind !== "rejected" || (cause !== "stale" && cause !== "remote")) return storage;
		return { ...storage, cause: REJECTED_CAUSE };
	};
	const { transition } = view;
	const folded = transition === null ? null : { ...transition, confirmation: fold(transition.confirmation) };
	return { ...view, storage: fold(view.storage), transition: folded };
}

// adapted from claim-execution-administration.test.ts:803-819
function live(renewalDue: boolean | null): WorkRight {
	return { kind: "live", renewalDue };
}

/** ASSUMPTION(scaffold): the cause union gains "pending". */
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

// adapted from claim-execution-administration.test.ts:824-840
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

// adapted from claim-execution-administration.test.ts:843-855
function heldRights(root: string, reclaimState: Reclaim, workRight: WorkRight, generation: number): RightsView {
	return evaluatedRights("held", workRight, reclaimState, root, generation);
}

function foreignRights(root: string, reclaimState: Reclaim, generation: number): RightsView {
	return evaluatedRights("foreign", noRight("not-holder"), reclaimState, root, generation);
}

function freeRights(root: string, generation: number): RightsView {
	return evaluatedRights("free", noRight("free"), NOT_APPLICABLE, root, generation);
}

/**
 * On PENDING every binding (source, target, third party) reads ownership `pending`, no work right with
 * cause `pending` and a reclaim verdict against the hull. ASSUMPTION(scaffold): ownership "pending" in the union.
 */
function pendingRights(root: string, hull: number, generation: number): RightsView {
	return evaluatedRights("pending", noRight("pending"), notYet(hull), root, generation);
}

// adapted from claim-execution-administration.test.ts:858-860
function rejectedPlan(cause: string, boundary: number | null = null): PlanView {
	return { kind: "rejected", cause, boundary };
}

// adapted from claim-execution-administration.test.ts:905-912
function tracked<V>(promise: Promise<V>): Tracked<V> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-execution-administration.test.ts:916-928
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
// adapted from claim-execution-administration.test.ts:932-939
async function settleWithin<V>(label: string, pending: Tracked<V>): Promise<V> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** Polls `condition` until it holds; fails after EVENT_TIMEOUT. */
// adapted from claim-execution-administration.test.ts:943-949
async function waitUntil(label: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/** S2, test-local: every trace2 `start` argv of `git -C <repository> ...`, without that prefix. */
// adapted from claim-execution-administration.test.ts:956-978
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

/** The S1 hook script: numbers each invocation atomically (mkdir), logs its stdin, then passes, rejects or holds. */
// adapted from claim-execution-administration.test.ts:982-1004
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
// adapted from claim-execution-administration.test.ts:1008-1088 (ReceiveScript)
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

	/** Entered invocations of `phase` numbered above `since`, in order, with their stdin lines. */
	async invocations(phase: ReceivePhase, since: number): Promise<Invocation[]> {
		const pattern = new RegExp(`^${phase}-(\\d+)$`);
		const numbers = (await readdir(this.control))
			.map((name) => Number(pattern.exec(name)?.[1] ?? Number.NaN))
			.filter((n) => Number.isSafeInteger(n) && n > since)
			.sort((left, right) => left - right);
		const invocations: Invocation[] = [];
		for (const n of numbers) {
			const path = join(this.control, `${phase}-${n}`);
			if (!(await exists(join(path, "entered")))) continue;
			invocations.push({ n, lines: (await readFile(join(path, "stdin"), "utf8")).split("\n").filter(Boolean) });
		}
		return invocations;
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
 * One server repository with S1 hooks, the executor's client, independent clients, contexts, the S2 trace, the
 * surface seams and the child probes of one case.
 */
// adapted from claim-execution-administration.test.ts:1093-1432 (AdministrationCase), plus the witness and journal
// views, the composite query, the surface env of claim-next-git.test.ts:664-704 and the probe start of
// claim-execution-pause.test.ts:1286-1308
class TimePathCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The executor's client repository and the surface's project root. */
	readonly primary: string;
	/** Private 0700 parent of all contexts of this case. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	private readonly tracePath: string;
	/** Every context of the case; the sentinel scans cover all of them. */
	private readonly handles: ContextHandle[] = [];
	/** Operation IDs handed to a call; no reason may echo them. */
	private readonly guarded = new Set<string>();
	private readonly secrets = new Map<string, string>();
	private readonly pendings: Tracked<ClaimExecutionResult>[] = [];
	private readonly supervisors: ProbeSupervisor[] = [];
	private previousTrace: string | undefined;
	private tracing = false;
	private writerStore: ClaimStore | undefined;
	private readerStore: ClaimStore | undefined;
	private observer: string | undefined;
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

	static async create(format: ClaimStorageFormat, caseName: string): Promise<TimePathCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-time-path-git-"));
		try {
			const { name, repo } = await server().initRepository(root, `time-path-${format}-${caseName}`);
			const primary = await TimePathCase.initClient(join(root, "client-executor"));
			const created = new TimePathCase(format, root, server().url(name), repo, primary);
			await created.hooks.install();
			await mkdir(created.parent);
			await chmod(created.parent, 0o700);
			const initializer = await created.client("initializer");
			expectKind(await initializeClaimStorage(created.storage(initializer)), "created");
			created.startTrace();
			return created;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-execution-administration.test.ts:1147-1152
	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An independent client repository; a second party's Git stays out of the executor's repository. */
	async client(label: string): Promise<string> {
		return TimePathCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, timeoutMs = ADAPTER_TIMEOUT): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs };
	}

	private async store(repository: string): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.storage(repository)), "open").store;
	}

	/** Creates a context through the API below the private parent, optionally recovering from `recoverFrom`. */
	// adapted from claim-execution-administration.test.ts:1169-1175
	async context(recoverFrom?: ContextHandle): Promise<ContextHandle> {
		const parent = this.parent;
		const options = recoverFrom === undefined ? { parent } : { parent, recoverFrom: recoverFrom.directory };
		const context = expectKind(await createClaimContext(options), "created").context;
		const handle = { context, directory: dirname(context.journalDirectory) };
		this.handles.push(handle);
		return handle;
	}

	/**
	 * The derived A ID of `operationId`, guarded like every other operation ID.
	 * ASSUMPTION(scaffold): `claimConfirmationId(operationId: string): string` (scaffold → "").
	 */
	confirmationId(operationId: string): string {
		const id = claimConfirmationId(operationId);
		this.guarded.add(id);
		return id;
	}

	// adapted from claim-execution-administration.test.ts:1179-1187
	private async secretOf(handle: ContextHandle): Promise<string> {
		const cached = this.secrets.get(handle.directory);
		if (cached !== undefined) return cached;
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		this.secrets.set(handle.directory, secret);
		return secret;
	}

	// adapted from claim-execution-administration.test.ts:1190-1198, over every context of the case
	async view(label: string, result: unknown): Promise<ExecutionView> {
		const anywhere = [this.root, this.parent, this.url, OWNER, OTHER_OWNER, THIRD_OWNER];
		for (const handle of this.handles) {
			anywhere.push(await this.secretOf(handle), handle.context.binding, handle.directory);
			if (handle.context.recovery) anywhere.push(handle.context.recovery.binding);
		}
		const inReasons = [...this.guarded, ...Object.values(await this.serverRefs())];
		return viewOf(label, result, { anywhere, inReasons });
	}

	async expectView(result: unknown, expected: ExecutionView): Promise<void> {
		expect(await this.view(expected.label, result)).toStrictEqual(expected);
	}

	/**
	 * Executor options, built field by field from explicit overrides. ASSUMPTION(scaffold):
	 * `ExecuteClaimTransitionOptions.timePath?: boolean`; every core call of this file runs with it on, as the surface
	 * does under `enabled: true`; the switched-off path is tpg-10's, through the surface.
	 */
	// adapted from claim-execution-administration.test.ts:1211-1239
	options(
		handle: ContextHandle,
		operationId: string,
		request: ClaimTransitionRequest,
		clock: SequenceClock,
		changes: OptionChanges = {},
	): ExecuteClaimTransitionOptions {
		this.guarded.add(operationId);
		const options: ExecuteClaimTransitionOptions = {
			storage: changes.storage ?? this.storage(),
			ticket: changes.ticket ?? TICKET,
			contextDirectory: handle.directory,
			operationId,
			request,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: changes.attempts ?? ATTEMPTS,
		};
		if (changes.expectedClaimGeneration !== undefined) {
			options.expectedClaimGeneration = changes.expectedClaimGeneration;
		}
		if (changes.targetContextDirectory !== undefined) {
			options.targetContextDirectory = changes.targetContextDirectory;
		}
		options.timePath = true;
		return options;
	}

	/** No ticket, request, plan or `timePath`; the record under `operationId` decides. */
	// adapted from claim-execution-administration.test.ts:1243-1260
	resendOptions(
		handle: ContextHandle,
		operationId: string,
		clock: SequenceClock,
		changes: ResendChanges = {},
	): ResendOptions {
		this.guarded.add(operationId);
		return {
			storage: changes.storage ?? this.storage(),
			contextDirectory: handle.directory,
			operationId,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: changes.attempts ?? ATTEMPTS,
		};
	}

	intent(spec: IntentSpec): ClaimOperationIntent {
		return referenceIntent(this.url, this.format, spec);
	}

	// adapted from claim-execution-administration.test.ts:1268-1273
	async writeChange(ticket: string, change: ClaimChange): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		const base = await this.writerStore.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		return expectKind(await this.writerStore.write(base, change), "applied").root;
	}

	/** Writes a claim state as an independent writer (revision 1 on an absent ticket). */
	// adapted from claim-execution-administration.test.ts:1277-1282
	async writeState(payload: JsonObject, ticket = TICKET): Promise<string> {
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return this.writeChange(ticket, { operationId, receipt, payload });
	}

	/** O3 through an independent reader client. */
	// adapted from claim-execution-administration.test.ts:1286-1296
	async stored(ticket: string, operationId: string): Promise<StoredView> {
		this.readerStore ??= await this.store(await this.client("reader"));
		const observed = await this.readerStore.read(ticket);
		if (observed.kind !== "present") return { revision: 0, payload: observed.kind, receipt: null };
		const receipt = observed.document.receipts[operationId];
		return {
			revision: observed.document.revision,
			payload: sha256Hex(canonicalJson(observed.document.payload)),
			receipt: receipt === undefined ? null : sha256Hex(canonicalJson(receipt)),
		};
	}

	/** O2: digests of the final records; temporaries and admission slots (dot names) are ignored. */
	// adapted from claim-execution-administration.test.ts:1300-1307
	async records(handle: ContextHandle): Promise<Record<string, string>> {
		const records: Record<string, string> = {};
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			records[name] = sha256Hex(await readFile(join(handle.context.journalDirectory, name)));
		}
		return records;
	}

	/** O2 by entry class: record names and the number of admission slots (claim-next-git.test.ts:801-810). */
	async journalView(handle: ContextHandle): Promise<JournalView> {
		const names = (await readdir(handle.context.journalDirectory)).sort(byCodeUnits);
		return {
			records: names.filter((name) => !name.startsWith(".") && name.endsWith(".json")),
			slots: names.filter((name) => name.startsWith(".admission-")).length,
		};
	}

	/** The digest of the exact bytes of one final record, or ABSENT_REF when there is none. */
	async recordBytes(handle: ContextHandle, operationId: string): Promise<string> {
		return (await this.records(handle))[`${operationId}.json`] ?? ABSENT_REF;
	}

	/** The witness A of `handle`'s journal, read from its record file. */
	async witnessOf(handle: ContextHandle, operationId: string): Promise<WitnessView> {
		const path = join(handle.context.journalDirectory, `${operationId}.json`);
		if (operationId === "" || !(await exists(path))) return NO_WITNESS;
		const record: unknown = JSON.parse(await readFile(path, "utf8"));
		const intent = field(record, "intent");
		const parameters = field(intent, "parameters");
		const action = field(intent, "action");
		return {
			present: true,
			expectedRoot: field(intent, "expectedRoot"),
			targetBinding: field(intent, "targetBinding"),
			actionKnown: CLAIM_TRANSITION_ACTIONS.some((known) => known === action),
			parameters,
			next: field(field(intent, "resolved"), "next"),
			digestsValid:
				field(record, "digest") === sha256Hex(canonicalJson(intent)) &&
				field(record, "parameterDigest") === sha256Hex(canonicalJson(parameters)),
		};
	}

	/** The receipt digest the witness record on disk implies, for O3 of A. */
	async witnessReceipt(handle: ContextHandle, operationId: string): Promise<string> {
		const path = join(handle.context.journalDirectory, `${operationId}.json`);
		if (operationId === "" || !(await exists(path))) return ABSENT_REF;
		const record: unknown = JSON.parse(await readFile(path, "utf8"));
		const receipt = {
			schema: 1,
			intentDigest: field(record, "digest"),
			parameterDigest: field(record, "parameterDigest"),
		};
		return sha256Hex(canonicalJson(receipt));
	}

	/** O9: the rights view of `handle` at `now` through an independent observer client (rights/index.ts:297-381). */
	async rightsOf(handle: ContextHandle, ticket: string, now: number): Promise<RightsView> {
		this.observer ??= await this.client("observer");
		const evaluation = await queryClaimRight({
			storage: this.storage(this.observer),
			ticket,
			contextDirectory: handle.directory,
			clockSkewMs: EPS,
			clock: () => now,
		});
		return rightsViewOf(evaluation);
	}

	/** The query single query of one journalled operation of `handle` (query/index.ts:24-105), unchanged. */
	async query(handle: ContextHandle, operationId: string): Promise<QueryView> {
		this.observer ??= await this.client("observer");
		const result = await queryClaimMutation({
			journalDirectory: handle.context.journalDirectory,
			operationId,
			storage: this.storage(this.observer),
		});
		const resolution = field(result, "resolution");
		return {
			kind: textOf(field(result, "kind")),
			resolution: textOf(field(resolution, "kind")),
			observedRoot: textOf(field(resolution, "observedRoot")),
		};
	}

	/**
	 * For a P ID. ASSUMPTION(scaffold): `queryClaimTransition` takes the options of
	 * `queryClaimMutation` and answers `{kind: "resolved", resolution: {kind, phase, …}}`.
	 */
	async transitionQuery(handle: ContextHandle, operationId: string): Promise<TransitionQueryView> {
		this.observer ??= await this.client("observer");
		const result = await queryClaimTransition({
			journalDirectory: handle.context.journalDirectory,
			operationId,
			storage: this.storage(this.observer),
		});
		const resolution = field(result, "resolution");
		return {
			kind: textOf(field(result, "kind")),
			logical: textOf(field(resolution, "kind")),
			phase: textOf(field(resolution, "phase")),
		};
	}

	/** O1. */
	// adapted from claim-execution-administration.test.ts:1340-1348
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
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** S1: the receive lines of every entered invocation of `phase` above `since`, in order. */
	async receives(phase: ReceivePhase, since: number): Promise<Receive[][]> {
		return (await this.hooks.invocations(phase, since)).map((call) => call.lines.map(receiveOf));
	}

	async gitCommands(repository = this.primary): Promise<string[][]> {
		return gitCommandsOf(this.tracePath, repository);
	}

	async mark(repository = this.primary): Promise<number> {
		return (await this.gitCommands(repository)).length;
	}

	/** O4: the Git commands and pushes one call ran in `repository`, from the S2 trace. */
	async finish(pending: Promise<ClaimExecutionResult>, mark: number, repository = this.primary): Promise<Run> {
		const result = await pending;
		const commands = (await this.gitCommands(repository)).slice(mark);
		return { result, gitCalls: commands.length, pushes: commands.filter((args) => args[0] === "push") };
	}

	async run(options: ExecuteClaimTransitionOptions, repository = this.primary): Promise<Run> {
		const mark = await this.mark(repository);
		return this.finish(executeClaimTransition(options), mark, repository);
	}

	async resend(options: ResendOptions, repository = this.primary): Promise<Run> {
		const mark = await this.mark(repository);
		return this.finish(resendClaimIntent(options), mark, repository);
	}

	/** Starts one execution on `repository` without awaiting it; dispose settles it if the test does not. */
	// adapted from claim-execution-administration.test.ts:1387-1397
	async start(options: ExecuteClaimTransitionOptions, repository = this.primary): Promise<Racer> {
		const mark = await this.mark(repository);
		const pending = tracked(executeClaimTransition(options));
		this.pendings.push(pending);
		return { repository, mark, pending };
	}

	async settle(label: string, racer: Racer): Promise<Run> {
		const result = await settleWithin(label, racer.pending);
		return this.finish(Promise.resolve(result), racer.mark, racer.repository);
	}

	/** Releases invocations since+1 to since+count of `phase` and waits until each has left its hold. */
	// adapted from claim-execution-administration.test.ts:1401-1406
	async releaseHeld(phase: ReceivePhase, since: number, count: number): Promise<void> {
		for (let n = since + 1; n <= since + count; n++) {
			await this.hooks.release(phase, n);
			await waitUntil(`receive ${phase}-${n} to finish`, () => this.hooks.hasFinished(phase, n));
		}
	}

	/** Releases every invocation of `phase` above `since` and waits until each has finished. */
	async releaseFrom(phase: ReceivePhase, since: number): Promise<void> {
		await this.releaseHeld(phase, since, (await this.hooks.count(phase)) - since);
	}

	/** A file gate of the time-path probe under the case root (claim-execution-pause.test.ts:1274-1278). */
	async fileGate(step: PauseStep, occurrence: number): Promise<FileGate> {
		const dir = join(this.root, `gate-${++this.sequence}`);
		await mkdir(dir);
		return { step, dir, timeoutMs: CHILD_GATE_TIMEOUT, occurrence };
	}

	/** A supervised time-path probe on the primary client with its own S2 trace file (claim-execution-pause:1287). */
	async startProbe(spec: ProbeSpec): Promise<ProbeSupervisor> {
		this.guarded.add(spec.operationId);
		const command: TimePathCommand = {
			mode: "execute",
			journalDirectory: spec.handle.context.journalDirectory,
			storage: this.storage(),
			ticket: spec.ticket,
			contextDirectory: spec.handle.directory,
			operationId: spec.operationId,
			request: spec.request,
			clockSkewMs: EPS,
			attempts: ATTEMPTS,
			timePath: true,
			clock: spec.clock,
			gates: spec.gates,
		};
		if (spec.target !== undefined) command.targetContextDirectory = spec.target.directory;
		const trace = resolve(this.root, `trace2-probe-${++this.sequence}.json`);
		const supervisor = ProbeSupervisor.start(command, SUPERVISOR_LIFETIME, { ...process.env, [TRACE_VARIABLE]: trace });
		this.supervisors.push(supervisor);
		await supervisor.next("probe-started");
		return supervisor;
	}

	/** Configuration keys plus the three surface keys, all explicit (claim-next-git.test.ts:665-685). */
	claimsYaml(settings: SurfaceSettings): string {
		return [
			"claims:",
			`  enabled: ${settings.enabled}`,
			`  endpoint: ${JSON.stringify(this.url)}`,
			`  storage_format: ${this.format}`,
			"  lifetime_mode: lease",
			`  lease_ttl_ms: ${TTL}`,
			`  reclaim_grace_ms: ${GRACE}`,
			`  attempt_timeout_ms: ${settings.attemptTimeoutMs}`,
			`  attempts: ${settings.attempts}`,
			`  operation_budget_ms: ${BUDGET_MS}`,
			`  clock_uncertainty_ms: ${EPS}`,
			"  retry_pause_base_ms: 1",
			"  retry_pause_max_ms: 1",
		].join("\n");
	}

	/**
	 * ClaimSurfaceEnv with a steady monotonic clock, no draws that matter and no sleep; no case of this file uses the
	 * local ticket seams (acquire only) or asks for a generated operation ID, so both fail loudly if reached.
	 */
	// adapted from claim-next-git.test.ts:688-704
	surfaceEnv(settings: SurfaceSettings, now = T): ClaimSurfaceEnv {
		const unavailable: ClaimLocalTickets = { kind: "unavailable" };
		const missing = { kind: "missing" } as const;
		return {
			projectRoot: this.primary,
			claimsYaml: this.claimsYaml(settings),
			taskPrefix: "BACK",
			findLocalTicket: () => Promise.resolve(missing),
			loadLocalTickets: () => Promise.resolve(unavailable),
			clock: () => now,
			monotonicNow: () => MONO_START,
			random: () => 0.5,
			sleep: () => Promise.resolve(),
			newOperationId: () => {
				throw new Error("fixture: every surface call of this file names its operation ID");
			},
		};
	}

	/** Every value no public document may carry (allowlist): owners included. */
	// adapted from claim-next-git.test.ts:826-849
	private async documentSentinels(): Promise<[string, string][]> {
		const found: [string, string][] = [
			["case root", this.root],
			["endpoint", this.url],
			["owner karl", OWNER],
			["owner franz", OTHER_OWNER],
			["owner lena", THIRD_OWNER],
		];
		for (const [ref, oid] of Object.entries(await this.serverRefs())) found.push([`root of ${ref}`, oid]);
		for (const handle of this.handles) {
			const { binding, journalDirectory } = handle.context;
			found.push(["binding", binding], ["context", handle.directory], ["secret", await this.secretOf(handle)]);
			for (const name of (await this.journalView(handle)).records) {
				const record: unknown = JSON.parse(await readFile(join(journalDirectory, name), "utf8"));
				found.push(["digest", String(field(record, "digest"))]);
				found.push(["parameter digest", String(field(record, "parameterDigest"))]);
			}
		}
		return found;
	}

	/**
	 * One public document as DocumentView; `transition` as keys and scalar facts, `confirmation` as its kind.
	 * ASSUMPTION(time path): the document's `transition.confirmation` is A's StorageView (`kind` first).
	 */
	async documentView(label: string, document: SurfaceDocument): Promise<DocumentView> {
		const text = JSON.stringify(document);
		const echoed = (await this.documentSentinels())
			.filter(([, value]) => value.length > 0 && text.includes(value))
			.map(([name]) => name);
		const transition = entryOf(document, "transition");
		return {
			label,
			exit: CLAIM_EXIT_CODES[document.status],
			keys: keysOf(document),
			kind: entryOf(document, "kind"),
			status: entryOf(document, "status"),
			command: entryOf(document, "command"),
			action: entryOf(document, "action"),
			ticket: entryOf(document, "ticket"),
			operationId: entryOf(document, "operationId"),
			outcome: entryOf(document, "outcome"),
			rejection: entryOf(document, "rejection"),
			sends: entryOf(document, "sends"),
			stoppedBy: entryOf(document, "stoppedBy"),
			code: entryOf(document, "code"),
			ownership: entryOf(entryOf(document, "rights"), "ownership"),
			transition:
				transition === ABSENT
					? ABSENT
					: {
							keys: keysOf(transition),
							phase: entryOf(transition, "phase"),
							confirmOperationId: entryOf(transition, "confirmOperationId"),
							observeBefore: entryOf(transition, "observeBefore"),
							reclaimBoundary: entryOf(transition, "reclaimBoundary"),
							confirmation: entryOf(entryOf(transition, "confirmation"), "kind"),
						},
			echoed,
		};
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

	/** Releases every hold, settles every started call, ends every probe group, restores the trace, removes the root. */
	// adapted from claim-execution-administration.test.ts:1422-1431 and claim-execution-pause.test.ts:1336-1349
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
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup, a cleanup problem is shown. */
// adapted from claim-execution-administration.test.ts:1436-1450
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: TimePathCase) => Promise<void>,
): Promise<void> {
	const fixture = await TimePathCase.create(format, caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	const problems = await fixture.dispose();
	if (failure !== undefined) throw failure;
	expect({ caseName, cleanupProblems: problems }).toEqual({ caseName, cleanupProblems: [] });
}

/**
 * Runs each row as a not-planned call and checks the rights evaluation of its planning read, no push, one clock read,
 * the ticket root and the calling context's journal unchanged. A not-planned call prepares no intent
 * (execution/index.ts:488-489 returns before :526), so the next row at the same root is never paused.
 */
// adapted from claim-execution-administration.test.ts:1457-1474, the client repository taken from the row
async function expectRefusals(fixture: TimePathCase, rows: RefusalRow[]): Promise<void> {
	for (const row of rows) {
		const ticket = row.changes.ticket ?? TICKET;
		const repository = row.changes.storage?.repository ?? fixture.primary;
		const root = await fixture.ticketRoot(ticket);
		const journal = await fixture.records(row.handle);
		const clock = sequenceClock(row.now, row.now);
		const options = fixture.options(row.handle, row.operationId, row.request, clock, row.changes);
		const run = await fixture.run(options, repository);
		const label = `${row.label} (catches: ${row.catches})`;
		await fixture.expectView(run.result, notPlannedView(label, row.plan, row.rights));
		expect({
			label,
			pushes: run.pushes.length,
			clockCalls: clock.calls(),
			root: await fixture.ticketRoot(ticket),
			journal: await fixture.records(row.handle),
		}).toEqual({ label, pushes: 0, clockCalls: 1, root, journal });
	}
}

/**
 * One healthy T call: writes `source`, runs the call with three clock reads and checks the
 * confirmed view: P applied at p, A applied at a, `sends` 2, the hull and H_s in `transition`, and the source's
 * fresh rights view at a. Returns the roots and the reference P intent for the case's further checks.
 * ASSUMPTION(time path): the three reads come in the order plan, observation, final rights.
 */
async function runConfirmed(fixture: TimePathCase, spec: TransitionSpec): Promise<Confirmed> {
	const base = await fixture.writeState(json(spec.source), spec.ticket);
	const confirmId = fixture.confirmationId(spec.operationId);
	const pre = await fixture.hooks.count("pre");
	const clock = sequenceClock(...(spec.reads ?? [T, T, T]));
	const changes: OptionChanges = { ticket: spec.ticket };
	if (spec.target !== undefined) changes.targetContextDirectory = spec.target.directory;
	const run = await fixture.run(fixture.options(spec.handle, spec.operationId, spec.request, clock, changes));
	const landed = firstLanding(await fixture.receives("pre", pre));
	const root = await fixture.ticketRoot(spec.ticket);
	const label = `${spec.label} (catches: ${spec.catches})`;
	await fixture.expectView(
		run.result,
		timePathView(label, {
			action: spec.request.action,
			operationId: spec.operationId,
			storage: appliedStorage(landed),
			outcome: "applied",
			rights: spec.rights(root),
			sends: 2,
			transition: transitionOf("confirmed", confirmId, appliedStorage(root), spec.hull, spec.observeBefore ?? H),
		}),
	);
	// T calls read the clock three times, P and A are two pushes of this client.
	expect({ label, clockCalls: clock.calls(), pushes: run.pushes.length }).toEqual({ label, clockCalls: 3, pushes: 2 });
	const pIntent = fixture.intent({
		operationId: spec.operationId,
		ticket: spec.ticket,
		expectedRoot: base,
		request: spec.request,
		next: pendingState(spec.source, spec.next),
	});
	return { base, landed, root, pIntent, confirmId, pre };
}

/**
 * The positive control of a case (catches: the administration core or the typed scaffold planning
 * `requires-time-path`): a hard H moves to H2 on CONTROL_TICKET through P and A, in contexts of its own, so the case's
 * journals stay untouched.
 */
async function boundControl(fixture: TimePathCase, caseId: string): Promise<void> {
	const holder = await fixture.context();
	await runConfirmed(fixture, {
		label: `${caseId} positive control`,
		catches: "an extension outside the time path",
		handle: holder,
		ticket: CONTROL_TICKET,
		operationId: `op-${caseId}-control`,
		source: active(holder.context.binding, hard(H)),
		request: changeBounds(hard(H2)),
		next: active(holder.context.binding, hard(H2)),
		rights: (root) => heldRights(root, notYet(HULL), live(null), 3),
		hull: HULL,
	});
}

/** The positive control of a transfer case: a hard H moves to a receiver with H2 on CONTROL_TICKET. */
async function transferControl(fixture: TimePathCase, caseId: string): Promise<void> {
	const holder = await fixture.context();
	const receiver = await fixture.context();
	await runConfirmed(fixture, {
		label: `${caseId} positive control`,
		catches: "a transfer restart outside the time path",
		handle: holder,
		ticket: CONTROL_TICKET,
		operationId: `op-${caseId}-control`,
		source: active(holder.context.binding, hard(H)),
		request: transfer(restartTo(H2)),
		next: transferred(receiver, hard(H2)),
		target: receiver,
		rights: (root) => foreignRights(root, notYet(HULL), 4),
		hull: HULL,
	});
}

/**
 * The probe's positive control (catches: a probe or core without the time path, a probe without the transfer
 * target): one ungated child run of a T call on CONTROL_TICKET, in contexts of its own, ends confirmed.
 */
async function probeControl(fixture: TimePathCase, caseId: string, form: "bound" | "transfer"): Promise<void> {
	const holder = await fixture.context();
	const operationId = `op-${caseId}-control`;
	await fixture.writeState(json(active(holder.context.binding, hard(H))), CONTROL_TICKET);
	const confirmId = fixture.confirmationId(operationId);
	const pre = await fixture.hooks.count("pre");
	const request = form === "bound" ? changeBounds(hard(H2)) : transfer(restartTo(H2));
	const clock = [T, T, T];
	const probe: ProbeSpec = { handle: holder, ticket: CONTROL_TICKET, operationId, request, clock, gates: [] };
	if (form === "transfer") probe.target = await fixture.context();
	const child = await fixture.startProbe(probe);
	const output = await child.output<ExecuteOutput>();
	const landed = firstLanding(await fixture.receives("pre", pre));
	const root = await fixture.ticketRoot(CONTROL_TICKET);
	const rights =
		form === "bound" ? heldRights(root, notYet(HULL), live(null), 3) : foreignRights(root, notYet(HULL), 4);
	const label = `${caseId} positive control (catches: a probe or core without the time path or the target)`;
	await fixture.expectView(
		output.result,
		timePathView(label, {
			action: request.action,
			operationId,
			storage: appliedStorage(landed),
			outcome: "applied",
			rights,
			sends: 2,
			transition: transitionOf("confirmed", confirmId, appliedStorage(root), HULL),
		}),
	);
	expect({ label, clockCalls: output.clockCalls }).toEqual({ label, clockCalls: 3 });
	await child.shutdown();
}

/**
 * Starts a T call whose witness A holds in pre-receive (P passes as invocation pre+1, A holds as pre+2) and waits
 * until A holds; the ticket's root is then p. The call runs on the primary client with HELD_SEND_TIMEOUT.
 */
async function startWithHeldWitness(
	fixture: TimePathCase,
	options: ExecuteClaimTransitionOptions,
	label: string,
	rest: HookAction[] = [],
): Promise<{ racer: Racer; pre: number }> {
	const pre = await fixture.hooks.count("pre");
	await fixture.hooks.plan("pre", ["pass", "hold", ...rest], "pass");
	const racer = await fixture.start(options);
	const held = await whilePending(label, racer.pending, () => fixture.hooks.hasEntered("pre", pre + 2));
	expect({ label, witnessHolding: held }).toEqual({ label, witnessHolding: true });
	return { racer, pre };
}

for (const format of FORMATS) {
	describe(`claim time path in the core (${format})`, () => {
		test(
			"tpg-01: extends a hard deadline through P, a persisted witness and A, and confirms it",
			async () => {
				await withCase(format, "tpg-01", async (fixture) => {
					const karl = await fixture.context();
					const source = active(karl.context.binding, hard(H));
					const next = active(karl.context.binding, hard(H2));

					// Positive control (catches: the administration core or the scaffold planning `requires-time-path`, one CAS
					// instead of P and A, A without a witness, the clock read twice): KARL's hard H moves to H2.
					const done = await runConfirmed(fixture, {
						label: "tpg-01 confirmed extension",
						catches: "an extension that is not a T call, a missing or unconfirmed A",
						handle: karl,
						ticket: TICKET,
						operationId: "op-tpg-01",
						source,
						request: changeBounds(hard(H2)),
						next,
						rights: (root) => heldRights(root, notYet(HULL), live(null), 3),
						hull: HULL,
					});
					const { base, landed, root, pIntent, confirmId, pre } = done;
					const line = (from: string, to: string): Receive => ({ from, to, ref: refOf(TICKET) });
					// A's ID is "c-" and 40 hex, derived from the P ID alone (catches: a random or unbound ID).
					expect({
						shape: /^c-[0-9a-f]{40}$/.test(confirmId),
						stable: claimConfirmationId("op-tpg-01") === confirmId,
						distinct: claimConfirmationId("op-tpg-01-other") !== confirmId,
					}).toEqual({ shape: true, stable: true, distinct: true });
					// P is the exact PENDING at q, A the witness at p; P and A each hold one slot (T6: p ≠ q).
					expect({
						receives: await fixture.receives("pre", pre),
						journal: await fixture.journalView(karl),
						pRecord: await fixture.recordBytes(karl, "op-tpg-01"),
						witness: await fixture.witnessOf(karl, confirmId),
						storedP: await fixture.stored(TICKET, "op-tpg-01"),
						storedA: await fixture.stored(TICKET, confirmId),
					}).toEqual({
						receives: [[line(base, landed)], [line(landed, root)]],
						journal: { records: [`${confirmId}.json`, "op-tpg-01.json"].sort(byCodeUnits), slots: 2 },
						pRecord: recordDigest(pIntent),
						witness: witness(pIntent, landed, next, T),
						storedP: storedView(next, pIntent, 3),
						storedA: {
							revision: 3,
							payload: sha256Hex(canonicalJson(next)),
							receipt: await fixture.witnessReceipt(karl, confirmId),
						},
					});
					// (catches: `stored` read as APPLIED in the single resolution, a composite without A):
					// the single query stays `stored`, the composite one is APPLIED/confirmed; KARL works live until H2.
					expect({
						single: await fixture.query(karl, "op-tpg-01"),
						composite: await fixture.transitionQuery(karl, "op-tpg-01"),
						live: await fixture.rightsOf(karl, TICKET, H + MINUTE),
					}).toEqual({
						single: { kind: "resolved", resolution: "stored", observedRoot: root },
						composite: { kind: "resolved", logical: "applied", phase: "confirmed" },
						live: heldRights(root, notYet(HULL), live(null), 3),
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"tpg-02: restarts the time box of a transfer with a new hard end and hands the right over only after A",
			async () => {
				await withCase(format, "tpg-02", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const source = active(karl.context.binding, hard(H));
					const next = transferred(franz, hard(H2));

					// Positive control (catches: a restart planned as `requires-time-path` or as preserve, a target
					// without generation + 1 and binding generation 1, the source keeping its right).
					const done = await runConfirmed(fixture, {
						label: "tpg-02 confirmed transfer restart",
						catches: "a restart without the time path, a direct ACTIVE-to-ACTIVE write",
						handle: karl,
						ticket: TICKET,
						operationId: "op-tpg-02",
						source,
						request: transfer(restartTo(H2)),
						next,
						target: franz,
						rights: (root) => foreignRights(root, notYet(HULL), 4),
						hull: HULL,
					});
					const { base, landed, root, pIntent, confirmId, pre } = done;
					const line = (from: string, to: string): Receive => ({ from, to, ref: refOf(TICKET) });
					// The source holds P and A, the target's journal stays empty (the target need not run).
					expect({
						receives: await fixture.receives("pre", pre),
						journal: await fixture.journalView(karl),
						targetJournal: await fixture.journalView(franz),
						pRecord: await fixture.recordBytes(karl, "op-tpg-02"),
						witness: await fixture.witnessOf(karl, confirmId),
						storedP: await fixture.stored(TICKET, "op-tpg-02"),
					}).toEqual({
						receives: [[line(base, landed)], [line(landed, root)]],
						journal: { records: [`${confirmId}.json`, "op-tpg-02.json"].sort(byCodeUnits), slots: 2 },
						targetJournal: { records: [], slots: 0 },
						pRecord: recordDigest(pIntent),
						witness: witness(pIntent, landed, next, T),
						storedP: storedView(next, pIntent, 3),
					});
					// After A (catches: the target without a right, the source keeping one): FRANZ reads live until H2,
					// KARL foreign; the composite outcome is APPLIED/confirmed.
					expect({
						franz: await fixture.rightsOf(franz, TICKET, T),
						karl: await fixture.rightsOf(karl, TICKET, T),
						composite: await fixture.transitionQuery(karl, "op-tpg-02"),
					}).toEqual({
						franz: heldRights(root, notYet(HULL), live(null), 4),
						karl: foreignRights(root, notYet(HULL), 4),
						composite: { kind: "resolved", logical: "applied", phase: "confirmed" },
					});
					// KARL's renew targets a, which differs from the expected roots q (P) and p (A).
					await expectRefusals(fixture, [
						{
							label: "tpg-02 KARL renews after the transfer",
							catches: "a source that keeps a follow-up right after A",
							handle: karl,
							operationId: "op-tpg-02-renew",
							request: renew(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root, notYet(HULL), 4),
						},
					]);
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim time path in the core (blob)", () => {
	test(
		"tpg-03: grants no right on PENDING while A holds and refuses every follow-up as pending-transition",
		async () => {
			await withCase("blob", "tpg-03", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const franzAgain = await fixture.context(franz);
				// Positive control (catches: the scaffold's `invalid` for a restart with a hard end, a restart outside T).
				await transferControl(fixture, "tpg-03");

				const source = active(karl.context.binding, hard(H));
				await fixture.writeState(json(source));
				const others = fixture.storage(await fixture.client("others"));
				const options = fixture.options(karl, "op-tpg-03", transfer(restartTo(H2)), sequenceClock(T, T, T), {
					storage: fixture.storage(fixture.primary, HELD_SEND_TIMEOUT),
					targetContextDirectory: franz.directory,
				});
				const { racer, pre } = await startWithHeldWitness(fixture, options, "tpg-03 A holds in pre-receive");
				const landed = await fixture.ticketRoot(TICKET);
				// (catches: the target live on PENDING, work before A): FRANZ reads pending, no right.
				expect({ franz: await fixture.rightsOf(franz, TICKET, T) }).toEqual({
					franz: pendingRights(landed, HULL, 4),
				});
				// Other contexts at p, so no pause applies; state slot before the generation check.
				const refused = rejectedPlan("pending-transition", HULL);
				await expectRefusals(fixture, [
					{
						label: "tpg-03 FRANZ renews on PENDING",
						catches: "the target working before A",
						handle: franz,
						operationId: "op-tpg-03-franz-renew",
						request: renew(),
						changes: { storage: others },
						now: T,
						plan: refused,
						rights: pendingRights(landed, HULL, 4),
					},
					{
						label: "tpg-03 FRANZ renews with a wrong expected generation",
						catches: "the generation check before the PENDING state slot",
						handle: franz,
						operationId: "op-tpg-03-franz-generation",
						request: renew(),
						changes: { storage: others, expectedClaimGeneration: 9 },
						now: T,
						plan: refused,
						rights: pendingRights(landed, HULL, 4),
					},
					{
						label: "tpg-03 a replacement of FRANZ resumes on PENDING",
						catches: "a resume directly on PENDING (RESULT:71)",
						handle: franzAgain,
						operationId: "op-tpg-03-resume",
						request: resume(),
						changes: { storage: others },
						now: T,
						plan: refused,
						rights: pendingRights(landed, HULL, 4),
					},
					{
						label: "tpg-03 LENA acquires the PENDING ticket",
						catches: "PENDING read as free (transition/index.ts:386-387)",
						handle: lena,
						operationId: "op-tpg-03-lena",
						request: acquireHard(THIRD_OWNER, H3),
						changes: { storage: others },
						now: T,
						plan: refused,
						rights: pendingRights(landed, HULL, 4),
					},
				]);
				// Releasing A confirms the transfer; only then FRANZ reads live (catches: a right before A).
				await fixture.hooks.release("pre", pre + 2);
				const run = await fixture.settle("tpg-03 transfer", racer);
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					run.result,
					timePathView("tpg-03 confirmed after the held A (catches: A lost while others read p)", {
						action: "transfer",
						operationId: "op-tpg-03",
						storage: appliedStorage(landed),
						outcome: "applied",
						rights: foreignRights(root, notYet(HULL), 4),
						sends: 2,
						transition: transitionOf("confirmed", fixture.confirmationId("op-tpg-03"), appliedStorage(root), HULL),
					}),
				);
				expect({ franz: await fixture.rightsOf(franz, TICKET, T) }).toEqual({
					franz: heldRights(root, notYet(HULL), live(null), 4),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"tpg-04: persists no witness at the late observation, keeps PENDING until the hull and ends UNKNOWN_HISTORY",
		async () => {
			await withCase("blob", "tpg-04", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();

				// Positive control (catches: the scaffold, `<=` instead of `<` in T4): in a context of its own, the
				// observation at H − EPS − 1 still witnesses, and the end read at T sees the confirmed claim.
				const holder = await fixture.context();
				await runConfirmed(fixture, {
					label: "tpg-04 positive control, observed one millisecond in time",
					catches: "a witness condition that is off by one",
					handle: holder,
					ticket: CONTROL_TICKET,
					operationId: "op-tpg-04-control",
					source: active(holder.context.binding, hard(H)),
					request: changeBounds(hard(H2)),
					next: active(holder.context.binding, hard(H2)),
					rights: (root) => heldRights(root, notYet(HULL), live(null), 3),
					hull: HULL,
					reads: [T, H - EPS - 1, T],
				});

				// The observation at H − EPS is too late: C_o + eps = H is not < H.
				const source = active(karl.context.binding, hard(H));
				const next = active(karl.context.binding, hard(H2));
				const base = await fixture.writeState(json(source));
				const pre = await fixture.hooks.count("pre");
				const confirmId = fixture.confirmationId("op-tpg-04");
				const clock = sequenceClock(T, H - EPS, H - EPS);
				const run = await fixture.run(fixture.options(karl, "op-tpg-04", changeBounds(hard(H2)), clock));
				const landed = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					run.result,
					timePathView("tpg-04 no witness after a late observation (catches: a false witness)", {
						action: "change-bounds",
						operationId: "op-tpg-04",
						storage: appliedStorage(landed),
						outcome: "unknown",
						rights: pendingRights(landed, HULL, 3),
						sends: 1,
						transition: transitionOf("pending", null, null, HULL),
					}),
				);
				const pIntent = fixture.intent({
					operationId: "op-tpg-04",
					expectedRoot: base,
					request: changeBounds(hard(H2)),
					next: pendingState(source, next),
				});
				// P is the exact PENDING at q, no A record exists, three clock reads (catches: a witness persisted despite
				// T4, a PENDING of another shape, a skipped observation read).
				expect({
					receives: await fixture.receives("pre", pre),
					journal: await fixture.journalView(karl),
					pRecord: await fixture.recordBytes(karl, "op-tpg-04"),
					witness: await fixture.witnessOf(karl, confirmId),
					clockCalls: clock.calls(),
				}).toEqual({
					receives: [[{ from: base, to: landed, ref: refOf(TICKET) }]],
					journal: { records: ["op-tpg-04.json"], slots: 1 },
					pRecord: recordDigest(pIntent),
					witness: NO_WITNESS,
					clockCalls: 3,
				});
				// KARL's own calls at p are `pending-transition`, not `paused` (P expects q, no A exists).
				await expectRefusals(fixture, [
					{
						label: "tpg-04 KARL extends again on PENDING",
						catches: "a second unresolved transition, a pause without an open A",
						handle: karl,
						operationId: "op-tpg-04-again",
						request: changeBounds(hard(H3)),
						changes: {},
						now: H - EPS,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 3),
					},
					{
						label: "tpg-04 KARL releases the PENDING ticket",
						catches: "a source release on PENDING (judge:21)",
						handle: karl,
						operationId: "op-tpg-04-release",
						request: release(),
						changes: {},
						now: H - EPS,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 3),
					},
					{
						label: "tpg-04 LENA reclaims one millisecond before the hull",
						catches: "a reclaim after the source's boundary only (model old_reclaim_horizon)",
						handle: lena,
						operationId: "op-tpg-04-early",
						request: reclaim(),
						changes: {},
						now: HULL + EPS - 1,
						plan: rejectedPlan("not-yet", HULL),
						rights: pendingRights(landed, HULL, 3),
					},
				]);
				// At the hull LENA's reclaim writes a FREE tombstone with the PENDING generation.
				const reclaimClock = sequenceClock(HULL + EPS, HULL + EPS);
				const reclaimed = await fixture.run(fixture.options(lena, "op-tpg-04-reclaim", reclaim(), reclaimClock));
				const freed = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					reclaimed.result,
					operationView("tpg-04 LENA reclaims at the hull (catches: PENDING blocking past the hull)", {
						action: "reclaim",
						operationId: "op-tpg-04-reclaim",
						storage: appliedStorage(freed),
						outcome: "applied",
						rights: freeRights(freed, 3),
						sends: 1,
					}),
				);
				// (catches: APPLIED from a later root, a lost history read as REJECTED): P without a
				// witness and p gone is UNKNOWN_HISTORY; the single resolution of P stays `stored`.
				expect({
					stored: (await fixture.stored(TICKET, "op-tpg-04")).payload,
					composite: await fixture.transitionQuery(karl, "op-tpg-04"),
					single: await fixture.query(karl, "op-tpg-04"),
				}).toEqual({
					stored: sha256Hex(canonicalJson(tombstone(3))),
					composite: { kind: "resolved", logical: "unknown-history", phase: "pending" },
					single: { kind: "resolved", resolution: "stored", observedRoot: freed },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"tpg-05: observes p by a fresh read after P's lost reply and confirms in the same call without a second P",
		async () => {
			await withCase("blob", "tpg-05", async (fixture) => {
				const karl = await fixture.context();
				// Positive control (catches: the scaffold's `requires-time-path` for an extension of H).
				await boundControl(fixture, "tpg-05");

				const source = active(karl.context.binding, hard(H));
				const next = active(karl.context.binding, hard(H2));
				const base = await fixture.writeState(json(source));
				const pre = await fixture.hooks.count("pre");
				const post = await fixture.hooks.count("post");
				await fixture.hooks.plan("post", ["hold"], "pass");
				const confirmId = fixture.confirmationId("op-tpg-05");
				// The observation reads T + MINUTE, later than the plan: the witness must carry the second reading.
				const clock = sequenceClock(T, T + MINUTE, T + MINUTE);
				const options = fixture.options(karl, "op-tpg-05", changeBounds(hard(H2)), clock, {
					storage: fixture.storage(fixture.primary, LOSS_TIMEOUT),
				});
				const run = await fixture.run(options);
				const receives = await fixture.receives("pre", pre);
				const landed = firstLanding(receives);
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					run.result,
					timePathView("tpg-05 lost P reply resolved and confirmed (catches: a stop at `stored`)", {
						action: "change-bounds",
						operationId: "op-tpg-05",
						storage: queriedStorage("unknown", "resolved", "stored", landed),
						outcome: "applied",
						rights: heldRights(root, notYet(HULL), live(null), 3),
						sends: 2,
						transition: transitionOf("confirmed", confirmId, appliedStorage(root), HULL),
					}),
				);
				const pIntent = fixture.intent({
					operationId: "op-tpg-05",
					expectedRoot: base,
					request: changeBounds(hard(H2)),
					next: pendingState(source, next),
				});
				const line = (from: string, to: string): Receive => ({ from, to, ref: refOf(TICKET) });
				// P was pushed once (catches: a second P push), O came after the fresh read (catches: O from the old
				// reply's clock reading), three clock reads.
				expect({
					receives,
					heldReplies: await fixture.receives("post", post),
					witness: await fixture.witnessOf(karl, confirmId),
					clockCalls: clock.calls(),
				}).toEqual({
					receives: [[line(base, landed)], [line(landed, root)]],
					heldReplies: [[line(base, landed)], [line(landed, root)]],
					witness: witness(pIntent, landed, next, T + MINUTE),
					clockCalls: 3,
				});
				await fixture.releaseHeld("post", post, 1);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"tpg-06: pauses the source at p after A's lost reply and publishes the frozen A by either ID, once",
		async () => {
			await withCase("blob", "tpg-06", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const source = active(karl.context.binding, lease(L, H));
				// A lease target leaseEnd(C = T, default TTL, H2) = min(T + TTL, H2) = L, grace kept.
				const next = transferred(franz, lease(L, H2));
				const request = transfer(restartTo(H2), defaultLease());

				// Positive control (catches: the scaffold, a lease restart planned as preserve or with the source's hard
				// end): in contexts of its own, the lease restart confirms with R as hull (R(source) = R(target) = L + GRACE).
				const holder = await fixture.context();
				const receiver = await fixture.context();
				await runConfirmed(fixture, {
					label: "tpg-06 positive control",
					catches: "a lease restart outside the time path",
					handle: holder,
					ticket: CONTROL_TICKET,
					operationId: "op-tpg-06-control",
					source: active(holder.context.binding, lease(L, H)),
					request,
					next: transferred(receiver, lease(L, H2)),
					target: receiver,
					rights: (root) => foreignRights(root, notYet(R), 4),
					hull: R,
				});

				// Both rows: P passes, every A send of the call holds past LOSS_TIMEOUT and is declined afterwards.
				const lost = async (ticket: string, operationId: string) => {
					const base = await fixture.writeState(json(source), ticket);
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["pass"], "hold-reject");
					const run = await fixture.run(
						fixture.options(karl, operationId, request, sequenceClock(T, T, T), {
							ticket,
							storage: fixture.storage(fixture.primary, LOSS_TIMEOUT),
							attempts: 2,
							targetContextDirectory: franz.directory,
						}),
					);
					const receives = await fixture.receives("pre", pre);
					const landed = firstLanding(receives);
					await fixture.releaseFrom("pre", pre + 1);
					await fixture.hooks.plan("pre", [], "pass");
					return { base, landed, run, from: receives.map((lines) => lines.map((line) => line.from)) };
				};

				// Row i on TICKET: A's reply is lost, A stays open at p (witnessed, UNKNOWN).
				// `attempts` per intent: sends = 1 (P, applied at once) + 2 (A: both permitted
				// sends held past LOSS_TIMEOUT, each queried `open` at p, execution/index.ts:575-586) = 3.
				const idA = fixture.confirmationId("op-tpg-06-a");
				const first = await lost(TICKET, "op-tpg-06-a");
				const openA = queriedStorage("unknown", "resolved", "open", first.landed);
				await fixture.expectView(
					first.run.result,
					timePathView("tpg-06 row i witnessed with A open (catches: APPLIED before A, attempts shared by P and A)", {
						action: "transfer",
						operationId: "op-tpg-06-a",
						storage: appliedStorage(first.landed),
						outcome: "unknown",
						rights: pendingRights(first.landed, R, 4),
						sends: 3,
						transition: transitionOf("witnessed", idA, openA, R),
					}),
				);
				// S1: P once from q, A twice from p (catches: a second P push, an A retry beyond its own attempts).
				expect({ from: first.from }).toEqual({ from: [[first.base], [first.landed], [first.landed]] });
				const pIntent = fixture.intent({
					operationId: "op-tpg-06-a",
					expectedRoot: first.base,
					request,
					next: pendingState(source, next),
				});
				// The witness is persisted with the observation read, the root stays p (catches: a witness dropped when
				// A's reply is lost, A counted as landed although every send of it was declined).
				expect({ witness: await fixture.witnessOf(karl, idA), root: await fixture.ticketRoot(TICKET) }).toEqual({
					witness: witness(pIntent, first.landed, next, T),
					root: first.landed,
				});
				// Exception on purpose: KARL's next call at the unchanged root p pauses on A alone (P expects q).
				const journalBefore = await fixture.records(karl);
				const pausedClock = sequenceClock(T + MINUTE, T + MINUTE);
				const paused = await fixture.run(fixture.options(karl, "op-tpg-06-release", release(), pausedClock));
				await fixture.expectView(
					paused.result,
					pausedView(
						"tpg-06 KARL pauses on the open A (catches: a pause on P, a pause with no way out)",
						[idA],
						pendingRights(first.landed, R, 4),
					),
				);
				expect({
					pushes: paused.pushes.length,
					clockCalls: pausedClock.calls(),
					journal: await fixture.records(karl),
				}).toEqual({ pushes: 0, clockCalls: 1, journal: journalBefore });
				// `retry <A-ID>` later: the ordinary re-send, one push, the frozen target.
				const resendClock = steadyClock(RETRY_AT);
				const retried = await fixture.resend(fixture.resendOptions(karl, idA, resendClock));
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					retried.result,
					operationView("tpg-06 retry of the A ID publishes A (catches: a second A, a planner on A)", {
						// (execution/index.ts:652-654): A records the action of its P.
						action: "transfer",
						operationId: idA,
						storage: appliedStorage(root),
						outcome: "applied",
						rights: foreignRights(root, notYet(R), 4),
						sends: 1,
					}),
				);
				expect({
					clockCalls: resendClock.calls(),
					stored: await fixture.stored(TICKET, idA),
					records: (await fixture.journalView(karl)).records,
					composite: await fixture.transitionQuery(karl, "op-tpg-06-a"),
				}).toEqual({
					clockCalls: 1,
					stored: {
						revision: 3,
						payload: sha256Hex(canonicalJson(next)),
						receipt: await fixture.witnessReceipt(karl, idA),
					},
					records: [`${idA}.json`, "op-tpg-06-a.json"].sort(byCodeUnits),
					composite: { kind: "resolved", logical: "applied", phase: "confirmed" },
				});

				// Row ii on SECOND_TICKET: the same loss, then `retry <P-ID>` publishes the existing A
				// without a second P and without a second witness (catches: a second A, a second restart).
				const idB = fixture.confirmationId("op-tpg-06-b");
				const second = await lost(SECOND_TICKET, "op-tpg-06-b");
				const witnessBytes = await fixture.recordBytes(karl, idB);
				const pre = await fixture.hooks.count("pre");
				const retriedP = await fixture.resend(fixture.resendOptions(karl, "op-tpg-06-b", steadyClock(RETRY_AT)));
				const root2 = await fixture.ticketRoot(SECOND_TICKET);
				await fixture.expectView(
					retriedP.result,
					timePathView("tpg-06 row ii retry of the P ID confirms (catches: a re-sent P, a new observation)", {
						action: "transfer",
						operationId: "op-tpg-06-b",
						// ASSUMPTION(execution/index.ts:721-726 unchanged for P): a stored P is clarified, not re-sent.
						storage: queriedStorage("earlier-process", "resolved", "stored", second.landed),
						outcome: "applied",
						rights: foreignRights(root2, notYet(R), 4),
						sends: 1,
						transition: transitionOf("confirmed", idB, appliedStorage(root2), R),
					}),
				);
				expect({
					receives: await fixture.receives("pre", pre),
					witnessBytes: await fixture.recordBytes(karl, idB),
					records: (await fixture.journalView(karl)).records,
					payload: (await fixture.stored(SECOND_TICKET, idB)).payload,
				}).toEqual({
					receives: [[{ from: second.landed, to: root2, ref: refOf(SECOND_TICKET) }]],
					witnessBytes,
					records: [`${idA}.json`, `${idB}.json`, "op-tpg-06-a.json", "op-tpg-06-b.json"].sort(byCodeUnits),
					payload: sha256Hex(canonicalJson(next)),
				});
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"tpg-07: lets a reclaim past the hull race the held A in both orders without inventing APPLIED",
		async () => {
			await withCase("blob", "tpg-07", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				// Positive control (catches: the scaffold's `invalid` for a restart with a hard end, a restart outside T).
				await transferControl(fixture, "tpg-07");
				const lenaClient = await fixture.client("lena");
				const lenaStorage = fixture.storage(lenaClient, HELD_SEND_TIMEOUT);
				const pastHull = HULL + EPS;
				const source = active(karl.context.binding, hard(H));
				const transferOptions = (operationId: string, ticket: string) =>
					fixture.options(karl, operationId, transfer(restartTo(H2)), sequenceClock(T, T, T), {
						ticket,
						storage: fixture.storage(fixture.primary, HELD_SEND_TIMEOUT),
						targetContextDirectory: franz.directory,
					});

				// Row i on TICKET: LENA's reclaim (invocation pre+3) lands while A holds; A then meets a moved root.
				await fixture.writeState(json(source));
				const idA = fixture.confirmationId("op-tpg-07-a");
				const held = await startWithHeldWitness(fixture, transferOptions("op-tpg-07-a", TICKET), "tpg-07 row i");
				const landed = await fixture.ticketRoot(TICKET);
				const lenaRun = await fixture.run(
					fixture.options(lena, "op-tpg-07-reclaim-a", reclaim(), sequenceClock(pastHull, pastHull), {
						storage: lenaStorage,
					}),
					lenaClient,
				);
				const freed = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					lenaRun.result,
					operationView("tpg-07 row i LENA reclaims past the hull (catches: PENDING blocking past the hull)", {
						action: "reclaim",
						operationId: "op-tpg-07-reclaim-a",
						storage: appliedStorage(freed),
						outcome: "applied",
						rights: freeRights(freed, 4),
						sends: 1,
					}),
				);
				await fixture.hooks.release("pre", held.pre + 2);
				// A always goes out as a re-send, so its declined send at the
				// moved root is queried, not final; the query finds A not stored at LENA's root.
				const lateA = await fixture.settle("tpg-07 row i transfer", held.racer);
				const supersededView = timePathView("tpg-07 row i A superseded (catches: confirmed without A's receipt)", {
					action: "transfer",
					operationId: "op-tpg-07-a",
					storage: appliedStorage(landed),
					outcome: "applied",
					rights: freeRights(freed, 4),
					sends: 2,
					transition: transitionOf(
						"witnessed",
						idA,
						queriedStorage(REJECTED_CAUSE, "resolved", "not-stored", freed),
						HULL,
					),
				});
				expect(normalizedCause(await fixture.view(supersededView.label, lateA.result))).toStrictEqual(supersededView);
				// Witnessed and A no longer landable is APPLIED (historical); FRANZ has nothing
				// (catches: UNKNOWN_HISTORY for a witnessed P, a right for the target after a reclaim).
				expect({
					root: await fixture.ticketRoot(TICKET),
					composite: await fixture.transitionQuery(karl, "op-tpg-07-a"),
					franz: await fixture.rightsOf(franz, TICKET, T),
				}).toEqual({
					root: freed,
					composite: { kind: "resolved", logical: "applied", phase: "witnessed" },
					franz: freeRights(freed, 4),
				});

				// Row ii on SECOND_TICKET: LENA's reclaim holds as pre+3; A is released first and lands.
				await fixture.writeState(json(source), SECOND_TICKET);
				const idB = fixture.confirmationId("op-tpg-07-b");
				const heldB = await startWithHeldWitness(
					fixture,
					transferOptions("op-tpg-07-b", SECOND_TICKET),
					"tpg-07 row ii",
					["hold"],
				);
				const landedB = await fixture.ticketRoot(SECOND_TICKET);
				const reclaimer = await fixture.start(
					fixture.options(lena, "op-tpg-07-reclaim-b", reclaim(), sequenceClock(pastHull, pastHull), {
						ticket: SECOND_TICKET,
						storage: lenaStorage,
					}),
					lenaClient,
				);
				const reclaimHolds = await whilePending("tpg-07 row ii reclaim holds", reclaimer.pending, () =>
					fixture.hooks.hasEntered("pre", heldB.pre + 3),
				);
				// Fixture precondition (catches: a reclaim planned as not-yet past the hull, which would never push).
				expect({ reclaimHolds }).toEqual({ reclaimHolds: true });
				await fixture.hooks.release("pre", heldB.pre + 2);
				await waitUntil("tpg-07 row ii A lands", async () => (await fixture.ticketRoot(SECOND_TICKET)) !== landedB);
				await fixture.hooks.release("pre", heldB.pre + 3);
				const confirmedRun = await fixture.settle("tpg-07 row ii transfer", heldB.racer);
				const lostReclaim = await fixture.settle("tpg-07 row ii reclaim", reclaimer);
				const rootB = await fixture.ticketRoot(SECOND_TICKET);
				await fixture.expectView(
					confirmedRun.result,
					timePathView("tpg-07 row ii A wins (catches: a reclaim through the hull before A)", {
						action: "transfer",
						operationId: "op-tpg-07-b",
						storage: appliedStorage(landedB),
						outcome: "applied",
						rights: foreignRights(rootB, notYet(HULL), 4),
						sends: 2,
						transition: transitionOf("confirmed", idB, appliedStorage(rootB), HULL),
					}),
				);
				const staleView = operationView("tpg-07 row ii the reclaim meets a (catches: a reclaim over ACTIVE)", {
					action: "reclaim",
					operationId: "op-tpg-07-reclaim-b",
					storage: rejectedStorage(REJECTED_CAUSE),
					outcome: "rejected",
					rights: foreignRights(rootB, eligible(HULL), 4),
					sends: 1,
				});
				expect(normalizedCause(await fixture.view(staleView.label, lostReclaim.result))).toStrictEqual(staleView);
				// FRANZ works after A (catches: the target without a right once A won the race).
				expect({ franz: await fixture.rightsOf(franz, SECOND_TICKET, T) }).toEqual({
					franz: heldRights(rootB, notYet(HULL), live(null), 4),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"tpg-08: runs two follow-up operations after a confirmed transition and keeps each time box's hard end",
		async () => {
			await withCase("blob", "tpg-08", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const t1 = T + MINUTE;
				const t2 = T + 2 * MINUTE;
				const source = active(karl.context.binding, lease(L, H));

				// Row A, Positive control (catches: the scaffold, a lease extension outside the time path): KARL's
				// lease keeps L and moves its hard end from H to H2.
				const extended = active(karl.context.binding, lease(L, H2));
				await runConfirmed(fixture, {
					label: "tpg-08 row A first extension",
					catches: "an extension of H that is not a T call",
					handle: karl,
					ticket: TICKET,
					operationId: "op-tpg-08-first",
					source,
					request: changeBounds(lease(L, H2)),
					next: extended,
					rights: (root) => heldRights(root, notYet(R), live(false), 3),
					hull: R,
				});
				// Follow-up 1, D at the confirmed root a (KARL's P expects q, A expects p): the renew keeps H2.
				const renewClock = sequenceClock(t1, t1);
				const renewed = await fixture.run(fixture.options(karl, "op-tpg-08-renew", renew(), renewClock));
				const renewedRoot = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					renewed.result,
					operationView("tpg-08 row A renew after A (catches: a follow-up blocked by a leftover PENDING)", {
						action: "renew",
						operationId: "op-tpg-08-renew",
						storage: appliedStorage(renewedRoot),
						outcome: "applied",
						rights: heldRights(renewedRoot, notYet(t1 + TTL + GRACE), live(false), 3),
						sends: 1,
					}),
				);
				const afterRenew = active(karl.context.binding, lease(t1 + TTL, H2));
				// The renewed lease ends at t1 + TTL under the kept H2 (catches: a renew that moves H, a T renew).
				expect({
					payload: (await fixture.stored(TICKET, "op-tpg-08-renew")).payload,
					clockCalls: renewClock.calls(),
				}).toEqual({ payload: sha256Hex(canonicalJson(afterRenew)), clockCalls: 2 });
				// Follow-up 2, a second T at the renewed root: H2 → H3, observed against the new H_s = H2.
				const idSecond = fixture.confirmationId("op-tpg-08-second");
				const secondPre = await fixture.hooks.count("pre");
				const secondClock = sequenceClock(t2, t2, t2);
				const request = changeBounds(lease(t1 + TTL, H3));
				const second = await fixture.run(fixture.options(karl, "op-tpg-08-second", request, secondClock));
				const secondLanded = firstLanding(await fixture.receives("pre", secondPre));
				const secondRoot = await fixture.ticketRoot(TICKET);
				const boundary = t1 + TTL + GRACE;
				await fixture.expectView(
					second.result,
					timePathView("tpg-08 row A second extension (catches: a second T blocked, H_s of the first box)", {
						action: "change-bounds",
						operationId: "op-tpg-08-second",
						storage: appliedStorage(secondLanded),
						outcome: "applied",
						rights: heldRights(secondRoot, notYet(boundary), live(false), 3),
						sends: 2,
						transition: transitionOf("confirmed", idSecond, appliedStorage(secondRoot), boundary, H2),
					}),
				);
				// The second box is stored exactly, read three times (catches: H3 lost, the first box re-published).
				expect({
					payload: (await fixture.stored(TICKET, idSecond)).payload,
					clockCalls: secondClock.calls(),
				}).toEqual({
					payload: sha256Hex(canonicalJson(active(karl.context.binding, lease(t1 + TTL, H3)))),
					clockCalls: 3,
				});

				// Row B on SECOND_TICKET: a restart to FRANZ confirms, then FRANZ renews within H2 (another context).
				const moved = transferred(franz, lease(L, H2));
				await runConfirmed(fixture, {
					label: "tpg-08 row B restart",
					catches: "a lease restart outside the time path",
					handle: karl,
					ticket: SECOND_TICKET,
					operationId: "op-tpg-08-restart",
					source,
					request: transfer(restartTo(H2), defaultLease()),
					next: moved,
					target: franz,
					rights: (root) => foreignRights(root, notYet(R), 4),
					hull: R,
				});
				const franzClock = sequenceClock(t1, t1);
				const franzRenew = await fixture.run(
					fixture.options(franz, "op-tpg-08-franz-renew", renew(), franzClock, { ticket: SECOND_TICKET }),
				);
				const franzRoot = await fixture.ticketRoot(SECOND_TICKET);
				await fixture.expectView(
					franzRenew.result,
					operationView("tpg-08 row B FRANZ renews after A (catches: a target without a right after A)", {
						action: "renew",
						operationId: "op-tpg-08-franz-renew",
						storage: appliedStorage(franzRoot),
						outcome: "applied",
						rights: heldRights(franzRoot, notYet(t1 + TTL + GRACE), live(false), 4),
						sends: 1,
					}),
				);
				// FRANZ's renew keeps the restarted H2 (catches: a follow-up renew that moves or drops H).
				expect({ payload: (await fixture.stored(SECOND_TICKET, "op-tpg-08-franz-renew")).payload }).toEqual({
					payload: sha256Hex(canonicalJson(transferred(franz, lease(t1 + TTL, H2)))),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"tpg-09: refuses both replacement starts of the target before A and lets exactly one resume after it",
		async () => {
			await withCase("blob", "tpg-09", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				// Positive control (catches: the scaffold's `invalid` for a restart with a hard end, a restart outside T).
				await transferControl(fixture, "tpg-09");
				const first = await fixture.context(franz);
				const second = await fixture.context(franz);
				const replacements = fixture.storage(await fixture.client("replacements"));
				const source = active(karl.context.binding, hard(H));
				const target = transferred(franz, hard(H2));
				await fixture.writeState(json(source));
				const options = fixture.options(karl, "op-tpg-09", transfer(restartTo(H2)), sequenceClock(T, T, T), {
					storage: fixture.storage(fixture.primary, HELD_SEND_TIMEOUT),
					targetContextDirectory: franz.directory,
				});
				const { racer, pre } = await startWithHeldWitness(fixture, options, "tpg-09 A holds in pre-receive");
				const landed = await fixture.ticketRoot(TICKET);
				// Before A (catches: a resume directly on PENDING): both replacements are refused.
				await expectRefusals(fixture, [
					{
						label: "tpg-09 replacement 1 resumes before A",
						catches: "double authorization before the witness is published",
						handle: first,
						operationId: "op-tpg-09-early-1",
						request: resume(),
						changes: { storage: replacements },
						now: T,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 4),
					},
					{
						label: "tpg-09 replacement 2 resumes before A",
						catches: "double authorization before the witness is published",
						handle: second,
						operationId: "op-tpg-09-early-2",
						request: resume(),
						changes: { storage: replacements },
						now: T,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 4),
					},
				]);
				await fixture.hooks.release("pre", pre + 2);
				const run = await fixture.settle("tpg-09 transfer", racer);
				const root = await fixture.ticketRoot(TICKET);
				const transferView = await fixture.view("tpg-09 transfer", run.result);
				// The held A confirms once released (catches: A lost while replacements read p).
				expect({ outcome: transferView.outcome, phase: transferView.transition?.phase ?? null }).toEqual({
					outcome: "applied",
					phase: "confirmed",
				});
				// After A: replacement 1 resumes, replacement 2 then holds only the old proof.
				const resumeClock = sequenceClock(T, T);
				const resumed = await fixture.run(fixture.options(first, "op-tpg-09-resume-1", resume(), resumeClock));
				const resumedRoot = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					resumed.result,
					operationView("tpg-09 replacement 1 resumes after A (catches: no replacement start after A)", {
						action: "resume",
						operationId: "op-tpg-09-resume-1",
						storage: appliedStorage(resumedRoot),
						outcome: "applied",
						rights: heldRights(resumedRoot, notYet(HULL), live(null), 4),
						sends: 1,
					}),
				);
				const resumedState = resumedBy(first, target);
				const intent = fixture.intent({
					operationId: "op-tpg-09-resume-1",
					expectedRoot: root,
					request: resume(),
					next: resumedState,
				});
				// Unchanged after A (catches: a resume that re-reads the proof or restarts the box).
				expect({ stored: await fixture.stored(TICKET, "op-tpg-09-resume-1") }).toEqual({
					stored: storedView(resumedState, intent, 4),
				});
				await expectRefusals(fixture, [
					{
						label: "tpg-09 replacement 2 resumes after replacement 1",
						catches: "two replacement starts that both hold",
						handle: second,
						operationId: "op-tpg-09-resume-2",
						request: resume(),
						changes: {},
						now: T,
						plan: rejectedPlan("not-holder"),
						rights: foreignRights(resumedRoot, notYet(HULL), 4),
					},
				]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"tpg-11: reads a P that took effect before H but answered after it as PENDING, never as witnessed",
		async () => {
			await withCase("blob", "tpg-11", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const source = active(karl.context.binding, hard(H));
				const loss = fixture.storage(fixture.primary, LOSS_TIMEOUT);
				const lostReply = async (ticket: string, operationId: string, observedAt: number) => {
					// The seed write pushes too: plan the hold after it, so only the core's P push is held.
					await fixture.writeState(json(source), ticket);
					const post = await fixture.hooks.count("post");
					await fixture.hooks.plan("post", ["hold"], "pass");
					const clock = sequenceClock(T, observedAt, observedAt);
					const run = await fixture.run(
						fixture.options(karl, operationId, transfer(restartTo(H2)), clock, {
							ticket,
							storage: loss,
							targetContextDirectory: franz.directory,
						}),
					);
					await fixture.releaseHeld("post", post, 1);
					return { run, clock };
				};

				// Positive control (catches: a lost P reply that can never be witnessed): observed at H − EPS − 1.
				const controlId = fixture.confirmationId("op-tpg-11-control");
				const control = await lostReply(CONTROL_TICKET, "op-tpg-11-control", H - EPS - 1);
				const controlView = await fixture.view("tpg-11 positive control", control.run.result);
				expect({
					outcome: controlView.outcome,
					storage: controlView.storage?.resolution ?? null,
					phase: controlView.transition?.phase ?? null,
					confirmOperationId: controlView.transition?.confirmOperationId ?? null,
				}).toEqual({ outcome: "applied", storage: "stored", phase: "confirmed", confirmOperationId: controlId });

				// P lands before H, its reply comes back only at H − EPS: no witness (catches: reply time as effect time).
				const confirmId = fixture.confirmationId("op-tpg-11");
				const late = await lostReply(TICKET, "op-tpg-11", H - EPS);
				const landed = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					late.run.result,
					timePathView("tpg-11 P effective before H, reply after it", {
						action: "transfer",
						operationId: "op-tpg-11",
						storage: queriedStorage("unknown", "resolved", "stored", landed),
						outcome: "unknown",
						rights: pendingRights(landed, HULL, 4),
						sends: 1,
						transition: transitionOf("pending", null, null, HULL),
					}),
				);
				// No A record, three reads, UNKNOWN while p is current, FRANZ without a right (catches: a witness taken from
				// the push time, UNKNOWN_HISTORY while p is still current, the target live on PENDING).
				expect({
					witness: await fixture.witnessOf(karl, confirmId),
					clockCalls: late.clock.calls(),
					composite: await fixture.transitionQuery(karl, "op-tpg-11"),
					franz: await fixture.rightsOf(franz, TICKET, H - EPS),
				}).toEqual({
					witness: NO_WITNESS,
					clockCalls: 3,
					composite: { kind: "resolved", logical: "unknown", phase: "pending" },
					franz: pendingRights(landed, HULL, 4),
				});
				// At most one unresolved transition per ticket; KARL's call targets p, not q.
				await expectRefusals(fixture, [
					{
						label: "tpg-11 KARL starts a second transfer on PENDING",
						catches: "a second unresolved transition on one ticket",
						handle: karl,
						operationId: "op-tpg-11-again",
						request: { action: "transfer", owner: THIRD_OWNER, timeBox: restartTo(H3), lease: null },
						changes: { targetContextDirectory: lena.directory },
						now: H - EPS,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 4),
					},
				]);
			});
		},
		LONG_TEST_TIMEOUT,
	);
});

describe("claim time path through the surface core (blob)", () => {
	test(
		"tpg-10: switches the time path with `enabled` and gates a restart and a P retry like acquire, an A retry not",
		async () => {
			await withCase("blob", "tpg-10", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const on: SurfaceSettings = { enabled: true, attempts: ATTEMPTS, attemptTimeoutMs: ADAPTER_TIMEOUT };
				const off: SurfaceSettings = { ...on, enabled: false };
				const extend = (ticket: string, operationId: string): ClaimMutationInput => ({
					command: "change-bounds",
					ticket,
					context: karl.directory,
					mode: "hard",
					hardEnd: iso(H2),
					graceMs: GRACE,
					operationId,
				});
				const source = json(active(karl.context.binding, hard(H)));
				const pushesSince = async (mark: number) =>
					(await fixture.gitCommands()).slice(mark).filter((args) => args[0] === "push").length;

				// Positive control (catches: the surface not passing `timePath = enabled`, a T document without
				// `transition`): with `enabled: true` the extension is applied/0 and confirmed.
				await fixture.writeState(source, CONTROL_TICKET);
				const controlId = fixture.confirmationId("op-tpg-10-control");
				const control = await runClaimMutation(extend(CONTROL_TICKET, "op-tpg-10-control"), fixture.surfaceEnv(on));
				const operationDocument = (label: string, status: ClaimStatus, spec: Partial<DocumentView>): DocumentView => ({
					label,
					exit: CLAIM_EXIT_CODES[status],
					keys: TIME_PATH_DOCUMENT_KEYS,
					kind: "claim-operation",
					status,
					command: "change-bounds",
					action: "change-bounds",
					ticket: TICKET,
					operationId: ABSENT,
					outcome: ABSENT,
					rejection: null,
					sends: ABSENT,
					stoppedBy: null,
					code: ABSENT,
					ownership: "held",
					transition: ABSENT,
					echoed: [],
					...spec,
				});
				expect(await fixture.documentView("tpg-10 positive control", control)).toEqual(
					operationDocument("tpg-10 positive control", "applied", {
						ticket: CONTROL_TICKET,
						operationId: "op-tpg-10-control",
						outcome: "applied",
						sends: 2,
						transition: {
							keys: TRANSITION_KEYS,
							phase: "confirmed",
							confirmOperationId: controlId,
							observeBefore: H,
							reclaimBoundary: HULL,
							confirmation: "applied",
						},
					}),
				);

				// Setup under `enabled: true`: A's reply is lost (P passes, every A send holds past the attempt
				// timeout and is declined), so P lands and A stays open at p (witnessed → unknown/3).
				await fixture.writeState(source);
				const idA = fixture.confirmationId("op-tpg-10");
				const pre = await fixture.hooks.count("pre");
				await fixture.hooks.plan("pre", ["pass"], "hold-reject");
				const lossy: SurfaceSettings = { enabled: true, attempts: 2, attemptTimeoutMs: LOSS_TIMEOUT };
				const witnessed = await runClaimMutation(extend(TICKET, "op-tpg-10"), fixture.surfaceEnv(lossy));
				await fixture.releaseFrom("pre", pre + 1);
				await fixture.hooks.plan("pre", [], "pass");
				// (catches: exit 0 for a witnessed call whose A is open, a document without the A ID as the way out,
				// `stoppedBy: null` hiding why the call stopped). `attempts` per intent: sends = 1
				// (P, applied at once) + 2 (A: both permitted sends held past the attempt timeout, each queried `open`) = 3;
				// A open after its permitted attempts is `stoppedBy: "attempts"` (the budget never runs out here,
				// the monotonic seam stands still).
				expect(await fixture.documentView("tpg-10 witnessed", witnessed)).toEqual(
					operationDocument("tpg-10 witnessed", "unknown", {
						outcome: "unknown",
						operationId: "op-tpg-10",
						sends: 3,
						stoppedBy: "attempts",
						ownership: "pending",
						transition: {
							keys: TRANSITION_KEYS,
							phase: "witnessed",
							confirmOperationId: idA,
							observeBefore: H,
							reclaimBoundary: HULL,
							confirmation: "queried",
						},
					}),
				);
				const landed = await fixture.ticketRoot(TICKET);

				// Under `enabled: false` (catches: a rights extension while claims are disabled):
				await fixture.writeState(source, SECOND_TICKET);
				await fixture.writeState(source, THIRD_TICKET);
				const journal = await fixture.records(karl);
				const mark = await fixture.mark();
				// (a) an extension stays `requires-time-path` (`timePath = enabled`), rejected/2, no record.
				const extension = await runClaimMutation(extend(SECOND_TICKET, "op-tpg-10-off"), fixture.surfaceEnv(off));
				expect(await fixture.documentView("tpg-10 extension while disabled", extension)).toEqual(
					operationDocument("tpg-10 extension while disabled", "rejected", {
						keys: OPERATION_DOCUMENT_KEYS,
						ticket: SECOND_TICKET,
						operationId: null,
						outcome: "rejected",
						rejection: { stage: "plan", cause: "requires-time-path" },
						sends: 0,
					}),
				);
				// (b) a restart with `--hard-end` has purpose `acquire` (disposition 1): claims-disabled.
				const restart = await runClaimMutation(
					{
						command: "transfer",
						ticket: THIRD_TICKET,
						context: karl.directory,
						owner: OTHER_OWNER,
						toContext: franz.directory,
						timeBox: "restart",
						hardEnd: iso(H2),
						operationId: "op-tpg-10-restart",
					},
					fixture.surfaceEnv(off),
				);
				// (c) `retry <P-ID>` of a T call is gated like an acquire record.
				const retryP = await runClaimRetry(
					{ operationId: "op-tpg-10", context: karl.directory },
					fixture.surfaceEnv(off),
				);
				const refused = (label: string, command: string, ticket: string, operationId: unknown): DocumentView => ({
					label,
					exit: 5,
					keys: ERROR_DOCUMENT_KEYS,
					kind: "claim-error",
					status: "refused",
					command,
					action: ABSENT,
					ticket,
					operationId,
					outcome: ABSENT,
					rejection: ABSENT,
					sends: ABSENT,
					stoppedBy: ABSENT,
					code: "claims-disabled",
					ownership: ABSENT,
					transition: ABSENT,
					echoed: [],
				});
				expect({
					restart: await fixture.documentView("tpg-10 restart while disabled", restart),
					retryP: await fixture.documentView("tpg-10 P retry while disabled", retryP),
					pushes: await pushesSince(mark),
					journal: await fixture.records(karl),
					root: await fixture.ticketRoot(TICKET),
				}).toEqual({
					restart: refused("tpg-10 restart while disabled", "transfer", THIRD_TICKET, null),
					retryP: refused("tpg-10 P retry while disabled", "retry", TICKET, "op-tpg-10"),
					pushes: 0,
					journal,
					root: landed,
				});
				// (d) `retry <A-ID>` is allowed (A records are allowed) and is the single result.
				const retryA = await runClaimRetry({ operationId: idA, context: karl.directory }, fixture.surfaceEnv(off));
				expect(await fixture.documentView("tpg-10 A retry while disabled", retryA)).toEqual(
					operationDocument("tpg-10 A retry while disabled", "applied", {
						keys: OPERATION_DOCUMENT_KEYS,
						command: "retry",
						operationId: idA,
						outcome: "applied",
						sends: 1,
					}),
				);
				// (e) `claim resolve <P-ID>` gives the composite outcome with `transition: {phase, confirmOperationId}`.
				const resolved = await runClaimResolve(
					{ operationId: "op-tpg-10", context: karl.directory },
					fixture.surfaceEnv(off),
				);
				expect(await fixture.documentView("tpg-10 resolve of the P ID", resolved)).toEqual(
					operationDocument("tpg-10 resolve of the P ID", "applied", {
						keys: RESOLUTION_DOCUMENT_KEYS,
						kind: "claim-resolution",
						command: "resolve",
						operationId: "op-tpg-10",
						outcome: "applied",
						rejection: ABSENT,
						stoppedBy: ABSENT,
						ownership: ABSENT,
						transition: {
							keys: ["confirmOperationId", "phase"],
							phase: "confirmed",
							confirmOperationId: idA,
							observeBefore: ABSENT,
							reclaimBoundary: ABSENT,
							confirmation: ABSENT,
						},
					}),
				);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"tpg-12: keeps a T call UNKNOWN while a hook declines A at a current p, and `retry <A-ID>` confirms it (F1)",
		async () => {
			await withCase("blob", "tpg-12", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const on: SurfaceSettings = { enabled: true, attempts: ATTEMPTS, attemptTimeoutMs: ADAPTER_TIMEOUT };
				const idA = fixture.confirmationId("op-tpg-12");
				const transferDocument = (label: string, status: ClaimStatus, spec: Partial<DocumentView>): DocumentView => ({
					label,
					exit: CLAIM_EXIT_CODES[status],
					keys: OPERATION_DOCUMENT_KEYS,
					kind: "claim-operation",
					status,
					command: "transfer",
					action: "transfer",
					ticket: TICKET,
					operationId: ABSENT,
					outcome: ABSENT,
					rejection: null,
					sends: ABSENT,
					stoppedBy: null,
					code: ABSENT,
					ownership: ABSENT,
					transition: ABSENT,
					echoed: [],
					...spec,
				});
				const resolutionDocument = (label: string, status: ClaimStatus, phase: string): DocumentView => ({
					...transferDocument(label, status, {}),
					keys: RESOLUTION_DOCUMENT_KEYS,
					kind: "claim-resolution",
					command: "resolve",
					operationId: "op-tpg-12",
					outcome: status,
					rejection: ABSENT,
					stoppedBy: ABSENT,
					transition: {
						keys: ["confirmOperationId", "phase"],
						phase,
						confirmOperationId: idA,
						observeBefore: ABSENT,
						reclaimBoundary: ABSENT,
						confirmation: ABSENT,
					},
				});
				const resolveP = () =>
					runClaimResolve({ operationId: "op-tpg-12", context: karl.directory }, fixture.surfaceEnv(on));

				// Positive control (catches: applied/0 with a final `rejected` confirmation for a T call whose A a
				// pre-receive hook declined while A stays open at p): P passes, A's one send is declined
				// as `remote` and queried `open`. A declined send is not repeated in the base CLI, so sends = 2 (P + A) and the
				// document is unknown/3, witnessed, `stoppedBy: null`: no attempt ran out, the confirmation carries the
				// cause.
				await fixture.writeState(json(active(karl.context.binding, hard(H))));
				await fixture.hooks.plan("pre", ["pass"], "reject");
				const declined = await runClaimMutation(
					{
						command: "transfer",
						ticket: TICKET,
						context: karl.directory,
						owner: OTHER_OWNER,
						toContext: franz.directory,
						timeBox: "restart",
						hardEnd: iso(H2),
						operationId: "op-tpg-12",
					},
					fixture.surfaceEnv(on),
				);
				await fixture.hooks.plan("pre", [], "pass");
				expect(await fixture.documentView("tpg-12 A declined at p", declined)).toEqual(
					transferDocument("tpg-12 A declined at p", "unknown", {
						keys: TIME_PATH_DOCUMENT_KEYS,
						operationId: "op-tpg-12",
						outcome: "unknown",
						sends: 2,
						ownership: "pending",
						transition: {
							keys: TRANSITION_KEYS,
							phase: "witnessed",
							confirmOperationId: idA,
							observeBefore: H,
							reclaimBoundary: HULL,
							confirmation: "queried",
						},
					}),
				);
				const landed = await fixture.ticketRoot(TICKET);

				// A stays open at p and PENDING stands (catches: A read as unable to land, a right for the target
				// before A): the single query of the A ID, the composite of the P ID, FRANZ's rights.
				const before = await resolveP();
				expect({
					a: await fixture.query(karl, idA),
					resolve: await fixture.documentView("tpg-12 resolve of the P ID while A is open", before),
					franz: await fixture.rightsOf(franz, TICKET, T),
				}).toEqual({
					a: { kind: "resolved", resolution: "open", observedRoot: landed },
					resolve: resolutionDocument("tpg-12 resolve of the P ID while A is open", "unknown", "witnessed"),
					franz: pendingRights(landed, HULL, 4),
				});

				// `retry <A-ID>` sends the frozen A once more and it lands: applied with one send, the
				// P ID resolves confirmed, FRANZ holds and KARL is foreign (catches: a witness lost with the declined
				// send, a retry that plans again or checks a binding, the right handed over without A).
				const retryA = await runClaimRetry({ operationId: idA, context: karl.directory }, fixture.surfaceEnv(on));
				const after = await resolveP();
				const root = await fixture.ticketRoot(TICKET);
				expect({
					retry: await fixture.documentView("tpg-12 A retry", retryA),
					resolve: await fixture.documentView("tpg-12 resolve of the P ID after A", after),
					franz: await fixture.rightsOf(franz, TICKET, T),
					karl: await fixture.rightsOf(karl, TICKET, T),
				}).toEqual({
					retry: transferDocument("tpg-12 A retry", "applied", {
						command: "retry",
						operationId: idA,
						outcome: "applied",
						sends: 1,
						ownership: "foreign",
					}),
					resolve: resolutionDocument("tpg-12 resolve of the P ID after A", "applied", "confirmed"),
					franz: heldRights(root, notYet(HULL), live(null), 4),
					karl: foreignRights(root, notYet(HULL), 4),
				});
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim time path across process crashes (blob)", () => {
	test(
		"crs-01: leaves P without a witness after a kill before A's record and reads it as UNKNOWN_HISTORY at last",
		async () => {
			await withCase("blob", "crs-01", async (fixture) => {
				const karl = await fixture.context();
				const lena = await fixture.context();
				// Positive control (catches: a probe or core without the time path): one ungated child run confirms.
				await probeControl(fixture, "crs-01", "bound");

				const source = active(karl.context.binding, hard(H));
				const next = active(karl.context.binding, hard(H2));
				const base = await fixture.writeState(json(source));
				const pre = await fixture.hooks.count("pre");
				const confirmId = fixture.confirmationId("op-crs-01");
				// The second record link is A's: the kill lands after P and O, before the witness is persisted.
				const gate = await fixture.fileGate("record-link", 2);
				const child = await fixture.startProbe({
					handle: karl,
					ticket: TICKET,
					operationId: "op-crs-01",
					request: changeBounds(hard(H2)),
					clock: [T, T, T],
					gates: [gate],
				});
				expect({ reached: await child.reached(gate) }).toEqual({ reached: true });
				const exit = await child.killProbe();
				const landed = await fixture.ticketRoot(TICKET);
				const pIntent = fixture.intent({
					operationId: "op-crs-01",
					expectedRoot: base,
					request: changeBounds(hard(H2)),
					next: pendingState(source, next),
				});
				// The kill leaves P landed and recorded, no witness (catches: A persisted before its record link, a P
				// that did not land before the observation).
				expect({
					exit: { code: exit.code, signal: exit.signal },
					receives: await fixture.receives("pre", pre),
					journal: await fixture.journalView(karl),
					pRecord: await fixture.recordBytes(karl, "op-crs-01"),
					witness: await fixture.witnessOf(karl, confirmId),
				}).toEqual({
					exit: { code: null, signal: "SIGKILL" },
					receives: [[{ from: base, to: landed, ref: refOf(TICKET) }]],
					journal: { records: ["op-crs-01.json"], slots: 1 },
					pRecord: recordDigest(pIntent),
					witness: NO_WITNESS,
				});
				// `retry <P-ID>` in this process at H − EPS may not re-observe: pending.
				const retried = await fixture.resend(fixture.resendOptions(karl, "op-crs-01", steadyClock(H - EPS)));
				await fixture.expectView(
					retried.result,
					timePathView("crs-01 retry of P after H_s (catches: a re-observation after H_s, AC #3)", {
						action: "change-bounds",
						operationId: "op-crs-01",
						storage: queriedStorage("earlier-process", "resolved", "stored", landed),
						outcome: "unknown",
						rights: pendingRights(landed, HULL, 3),
						sends: 0,
						transition: transitionOf("pending", null, null, HULL),
					}),
				);
				// (catches: a late witness written by the refused retry)
				expect({ journal: await fixture.journalView(karl) }).toEqual({
					journal: { records: ["op-crs-01.json"], slots: 1 },
				});
				// PENDING blocks until the hull; LENA's reclaim then frees it, and P stays UNKNOWN_HISTORY.
				const reclaimClock = sequenceClock(HULL + EPS, HULL + EPS);
				const reclaimed = await fixture.run(fixture.options(lena, "op-crs-01-reclaim", reclaim(), reclaimClock));
				const freed = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					reclaimed.result,
					operationView("crs-01 LENA reclaims at the hull (catches: a lost witness blocking forever)", {
						action: "reclaim",
						operationId: "op-crs-01-reclaim",
						storage: appliedStorage(freed),
						outcome: "applied",
						rights: freeRights(freed, 3),
						sends: 1,
					}),
				);
				// (catches: APPLIED or REJECTED for a P whose witness was lost)
				expect({ composite: await fixture.transitionQuery(karl, "op-crs-01") }).toEqual({
					composite: { kind: "resolved", logical: "unknown-history", phase: "pending" },
				});
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"crs-02: publishes the persisted witness of a killed call through `retry <A-ID>` with a fresh rights view",
		async () => {
			await withCase("blob", "crs-02", async (fixture) => {
				const karl = await fixture.context();
				// Positive control (catches: a probe or core without the time path): one ungated child run confirms.
				await probeControl(fixture, "crs-02", "bound");

				const source = active(karl.context.binding, hard(H));
				const next = active(karl.context.binding, hard(H2));
				const base = await fixture.writeState(json(source));
				const confirmId = fixture.confirmationId("op-crs-02");
				// After A's record link: the witness is persisted, A is neither admitted nor sent.
				const gate = await fixture.fileGate("after-record-link", 2);
				const child = await fixture.startProbe({
					handle: karl,
					ticket: TICKET,
					operationId: "op-crs-02",
					request: changeBounds(hard(H2)),
					clock: [T, T, T],
					gates: [gate],
				});
				expect({ reached: await child.reached(gate) }).toEqual({ reached: true });
				const exit = await child.killProbe();
				const landed = await fixture.ticketRoot(TICKET);
				const pIntent = fixture.intent({
					operationId: "op-crs-02",
					expectedRoot: base,
					request: changeBounds(hard(H2)),
					next: pendingState(source, next),
				});
				// The witness survives the kill, unadmitted (catches: a witness only in memory, A admitted before its record).
				expect({
					exit: { code: exit.code, signal: exit.signal },
					journal: await fixture.journalView(karl),
					witness: await fixture.witnessOf(karl, confirmId),
				}).toEqual({
					exit: { code: null, signal: "SIGKILL" },
					journal: { records: [`${confirmId}.json`, "op-crs-02.json"].sort(byCodeUnits), slots: 1 },
					witness: witness(pIntent, landed, next, T),
				});
				// `retry <A-ID>` later: no planner, no binding check; the document's rights are the
				// publisher's fresh rights view, here held because the bound form keeps the holder.
				const clock = steadyClock(T + MINUTE);
				const retried = await fixture.resend(fixture.resendOptions(karl, confirmId, clock));
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					retried.result,
					operationView("crs-02 retry of the A ID (catches: a lost witness, a publication with a planner)", {
						// (execution/index.ts:652-654): A records the action of its P.
						action: "change-bounds",
						operationId: confirmId,
						storage: appliedStorage(root),
						outcome: "applied",
						rights: heldRights(root, notYet(HULL), live(null), 3),
						sends: 1,
					}),
				);
				// One read, the frozen target, APPLIED/confirmed (catches: a re-planned or re-observed A).
				expect({
					clockCalls: clock.calls(),
					payload: (await fixture.stored(TICKET, confirmId)).payload,
					composite: await fixture.transitionQuery(karl, "op-crs-02"),
				}).toEqual({
					clockCalls: 1,
					payload: sha256Hex(canonicalJson(next)),
					composite: { kind: "resolved", logical: "applied", phase: "confirmed" },
				});
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"crs-03: lets only the source's own context publish a killed transfer's witness, never its replacement",
		async () => {
			await withCase("blob", "crs-03", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				// Positive control (catches: a probe without the transfer target or the time path): a child run confirms.
				await probeControl(fixture, "crs-03", "transfer");

				await fixture.writeState(json(active(karl.context.binding, hard(H))));
				const confirmId = fixture.confirmationId("op-crs-03");
				const gate = await fixture.fileGate("after-record-link", 2);
				const child = await fixture.startProbe({
					handle: karl,
					ticket: TICKET,
					operationId: "op-crs-03",
					request: transfer(restartTo(H2)),
					target: franz,
					clock: [T, T, T],
					gates: [gate],
				});
				expect({ reached: await child.reached(gate) }).toEqual({ reached: true });
				const exit = await child.killProbe();
				// Fixture precondition (catches: a probe that ended before the gate).
				expect({ exit: { code: exit.code, signal: exit.signal } }).toEqual({ exit: { code: null, signal: "SIGKILL" } });
				const landed = await fixture.ticketRoot(TICKET);
				// A replacement of KARL sees no P/A records (resume imports no journal): operation-not-found
				// for either ID (catches: a recovery context publishing a foreign witness).
				const replacement = await fixture.context(karl);
				const on: SurfaceSettings = { enabled: true, attempts: ATTEMPTS, attemptTimeoutMs: ADAPTER_TIMEOUT };
				const notFound = async (operationId: string) => {
					const document = await runClaimRetry({ operationId, context: replacement.directory }, fixture.surfaceEnv(on));
					const view = await fixture.documentView(`crs-03 replacement retries ${operationId}`, document);
					return { exit: view.exit, code: view.code, operationId: view.operationId, echoed: view.echoed };
				};
				expect({ a: await notFound(confirmId), p: await notFound("op-crs-03") }).toEqual({
					a: { exit: 5, code: "operation-not-found", operationId: confirmId, echoed: [] },
					p: { exit: 5, code: "operation-not-found", operationId: "op-crs-03", echoed: [] },
				});
				await expectRefusals(fixture, [
					{
						label: "crs-03 the replacement resumes on PENDING",
						catches: "a resume directly on PENDING",
						handle: replacement,
						operationId: "op-crs-03-resume-early",
						request: resume(),
						changes: {},
						now: T + MINUTE,
						plan: rejectedPlan("pending-transition", HULL),
						rights: pendingRights(landed, HULL, 4),
					},
				]);
				// KARL's own context publishes A; its rights are its fresh rights view: foreign (no right from A).
				const retried = await fixture.resend(fixture.resendOptions(karl, confirmId, steadyClock(T + MINUTE)));
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					retried.result,
					operationView("crs-03 KARL publishes A (catches: a right for the publisher)", {
						// (execution/index.ts:652-654): A records the action of its P.
						action: "transfer",
						operationId: confirmId,
						storage: appliedStorage(root),
						outcome: "applied",
						rights: foreignRights(root, notYet(HULL), 4),
						sends: 1,
					}),
				);
				// (catches: the target without a right after a publication by the source)
				expect({ franz: await fixture.rightsOf(franz, TICKET, T + MINUTE) }).toEqual({
					franz: heldRights(root, notYet(HULL), live(null), 4),
				});
				await expectRefusals(fixture, [
					{
						label: "crs-03 the replacement resumes after A",
						catches: "the source's old proof resuming a claim that moved on",
						handle: replacement,
						operationId: "op-crs-03-resume-late",
						request: resume(),
						changes: {},
						now: T + MINUTE,
						plan: rejectedPlan("not-holder"),
						rights: foreignRights(root, notYet(HULL), 4),
					},
				]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"crs-04: re-observes a landed P through `retry <P-ID>` before H_s and refuses it at H_s",
		async () => {
			await withCase("blob", "crs-04", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				// Positive control (catches: a probe without the transfer target or the time path): a child run confirms.
				await probeControl(fixture, "crs-04", "transfer");
				const source = active(karl.context.binding, hard(H));
				const next = transferred(franz, hard(H2));
				const killBeforeWitness = async (ticket: string, operationId: string) => {
					const base = await fixture.writeState(json(source), ticket);
					const gate = await fixture.fileGate("record-link", 2);
					const child = await fixture.startProbe({
						handle: karl,
						ticket,
						operationId,
						request: transfer(restartTo(H2)),
						target: franz,
						clock: [T, T, T],
						gates: [gate],
					});
					const reached = await child.reached(gate);
					const exit = await child.killProbe();
					expect({ operationId, reached, signal: exit.signal }).toEqual({
						operationId,
						reached: true,
						signal: "SIGKILL",
					});
					return { base, landed: await fixture.ticketRoot(ticket) };
				};

				// Row a on TICKET: the retry before H_s observes p anew and confirms; the witness carries its own reading.
				const idA = fixture.confirmationId("op-crs-04-a");
				const killedA = await killBeforeWitness(TICKET, "op-crs-04-a");
				const retried = await fixture.resend(fixture.resendOptions(karl, "op-crs-04-a", steadyClock(T + MINUTE)));
				const root = await fixture.ticketRoot(TICKET);
				await fixture.expectView(
					retried.result,
					timePathView("crs-04 row a retry before H_s (catches: a P landed by a crash never confirmable)", {
						action: "transfer",
						operationId: "op-crs-04-a",
						storage: queriedStorage("earlier-process", "resolved", "stored", killedA.landed),
						outcome: "applied",
						rights: foreignRights(root, notYet(HULL), 4),
						sends: 1,
						transition: transitionOf("confirmed", idA, appliedStorage(root), HULL),
					}),
				);
				const pIntent = fixture.intent({
					operationId: "op-crs-04-a",
					expectedRoot: killedA.base,
					request: transfer(restartTo(H2)),
					next: pendingState(source, next),
				});
				// (catches: the killed call's plan reading T taken as the observation, A without a slot of its own)
				expect({ witness: await fixture.witnessOf(karl, idA), journal: await fixture.journalView(karl) }).toEqual({
					witness: witness(pIntent, killedA.landed, next, T + MINUTE),
					// P's slot from the killed call, A's slot from the retry (T6: p ≠ q).
					journal: { records: [`${idA}.json`, "op-crs-04-a.json"].sort(byCodeUnits), slots: 2 },
				});

				// Row b on SECOND_TICKET, the negative control: the same retry at H − EPS may not observe (crs-04
				// disposition 4); P stays PENDING without a witness and nothing is sent.
				const idB = fixture.confirmationId("op-crs-04-b");
				const killedB = await killBeforeWitness(SECOND_TICKET, "op-crs-04-b");
				const refused = await fixture.resend(fixture.resendOptions(karl, "op-crs-04-b", steadyClock(H - EPS)));
				await fixture.expectView(
					refused.result,
					timePathView("crs-04 row b retry at H_s (catches: a re-observation after H_s)", {
						action: "transfer",
						operationId: "op-crs-04-b",
						storage: queriedStorage("earlier-process", "resolved", "stored", killedB.landed),
						outcome: "unknown",
						rights: pendingRights(killedB.landed, HULL, 4),
						sends: 0,
						transition: transitionOf("pending", null, null, HULL),
					}),
				);
				// (catches: a witness or an A push after H_s)
				expect({ witness: await fixture.witnessOf(karl, idB), root: await fixture.ticketRoot(SECOND_TICKET) }).toEqual({
					witness: NO_WITNESS,
					root: killedB.landed,
				});
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"crs-05: sends a recorded P that a killed call never sent through `retry <P-ID>` and runs T3-T7 to confirmed",
		async () => {
			await withCase("blob", "crs-05", async (fixture) => {
				// Positive control (catches: a probe or core without the time path): one ungated child run confirms.
				await probeControl(fixture, "crs-05", "bound");
				// ("re-sends P if unsent"). Row a kills at the named point, the first
				// after-record-link: P is recorded, its admission slot not yet linked (journal/index.ts:344-356, then
				// :380-399 via execution/index.ts:526, :546). Row b kills at the first after-slot-link: P is admitted,
				// the addendum's "admitted, NOT sent". Either way nothing was sent and the root stays q.
				// The killed call's P is recorded at q, so any new mutation of KARL on that ticket would pause at q
				// (pause/index.ts:96-104 reads records, not slots); `retry <P-ID>` is the way out and has no pause
				// step (execution/index.ts:622-776). The two rows use two tickets and a KARL context each, so every
				// journal holds exactly its row's records.
				const killAndRetry = async (ticket: string, operationId: string, step: PauseStep, slots: number) => {
					const label = `crs-05 ${operationId} killed at ${step}`;
					const karl = await fixture.context();
					const source = active(karl.context.binding, hard(H));
					const next = active(karl.context.binding, hard(H2));
					const base = await fixture.writeState(json(source), ticket);
					const pIntent = fixture.intent({
						operationId,
						ticket,
						expectedRoot: base,
						request: changeBounds(hard(H2)),
						next: pendingState(source, next),
					});
					const confirmId = fixture.confirmationId(operationId);
					const killedPre = await fixture.hooks.count("pre");
					const gate = await fixture.fileGate(step, 1);
					const child = await fixture.startProbe({
						handle: karl,
						ticket,
						operationId,
						request: changeBounds(hard(H2)),
						clock: [T, T, T],
						gates: [gate],
					});
					const reached = await child.reached(gate);
					const exit = await child.killProbe();
					// P recorded, nothing sent (catches: a send before the admission, a P lost by the kill).
					expect({
						label,
						reached,
						signal: exit.signal,
						receives: await fixture.receives("pre", killedPre),
						root: await fixture.ticketRoot(ticket),
						journal: await fixture.journalView(karl),
						pRecord: await fixture.recordBytes(karl, operationId),
					}).toEqual({
						label,
						reached: true,
						signal: "SIGKILL",
						receives: [],
						root: base,
						journal: { records: [`${operationId}.json`], slots },
						pRecord: recordDigest(pIntent),
					});
					// A new process of KARL's context retries P at T + MINUTE: admission, P's send, T3 observation, witness,
					// A (sends = P 1 + A 1 = 2), then KARL's fresh rights view (catches: an unsent P never sent,
					// a retry that stops at `stored`, a witness without its own observation).
					const pre = await fixture.hooks.count("pre");
					const retried = await fixture.resend(fixture.resendOptions(karl, operationId, steadyClock(T + MINUTE)));
					const receives = await fixture.receives("pre", pre);
					const landed = firstLanding(receives);
					const root = await fixture.ticketRoot(ticket);
					await fixture.expectView(
						retried.result,
						timePathView(`${label}: retry of the P ID`, {
							action: "change-bounds",
							operationId,
							storage: appliedStorage(landed),
							outcome: "applied",
							rights: heldRights(root, notYet(HULL), live(null), 3),
							sends: 2,
							transition: transitionOf("confirmed", confirmId, appliedStorage(root), HULL),
						}),
					);
					const line = (from: string, to: string): Receive => ({ from, to, ref: refOf(ticket) });
					// P once from q, A from p; the witness carries the retry's reading; P and A hold one slot each
					// (catches: a second P push, the killed call's plan reading taken as the observation).
					expect({
						label,
						receives,
						witness: await fixture.witnessOf(karl, confirmId),
						journal: await fixture.journalView(karl),
						payload: (await fixture.stored(ticket, confirmId)).payload,
						composite: await fixture.transitionQuery(karl, operationId),
					}).toEqual({
						label,
						receives: [[line(base, landed)], [line(landed, root)]],
						witness: witness(pIntent, landed, next, T + MINUTE),
						journal: { records: [`${confirmId}.json`, `${operationId}.json`].sort(byCodeUnits), slots: 2 },
						payload: sha256Hex(canonicalJson(next)),
						composite: { kind: "resolved", logical: "applied", phase: "confirmed" },
					});
				};

				await killAndRetry(TICKET, "op-crs-05-a", "after-record-link", 0);
				await killAndRetry(SECOND_TICKET, "op-crs-05-b", "after-slot-link", 1);
			});
		},
		LONG_TEST_TIMEOUT,
	);
});
