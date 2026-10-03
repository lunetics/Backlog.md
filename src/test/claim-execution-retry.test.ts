/**
 * Level X of the canonical claim CLI: the executor's additive send schedule and the resumption `resendClaimIntent`
 * over real Git for blob, tree and commit-chain, against the loopback daemon of claim-git-fixture.ts with a test-local
 * S1 receive script, the S2 trace2 record of each client repository and the gated journal seam of
 * claim-admission-probe.ts. bud-02 places every gate call and every per-command timeout request of a recording
 * schedule between the sends; unk-05, rsm-05, rsm-06 and rsm-07 resume an earlier call's intent over a contradicting
 * receipt, over the earlier change landing during the resend, against a held, unwritable or unreadable admission slot,
 * and twice in parallel. Every test starts with a positive control that the typed non-functional scaffold (the executor
 * ignores `schedule`, `resendClaimIntent` answers `unavailable`) cannot satisfy; table rows name the implementation
 * they catch. Open points are marked ASSUMPTION, observations still due [?]. Holds, gates and seams synchronize; no
 * sleep does.
 * claim-execution.test.ts and claim-execution-pause.test.ts stay unchanged. rsm-05 and rsm-07 pin the declined resend
 * exactly (LANDED_AFTER).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimExecutionResult,
	type ClaimSendSchedule,
	type ExecuteClaimTransitionOptions,
	executeClaimTransition,
	resendClaimIntent,
} from "../claims/execution/index.ts";
import {
	type ClaimIntentJournal,
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	claimJournalIO,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import { queryClaimMutation } from "../claims/query/index.ts";
import { createClaimMutationReceipt } from "../claims/resolution/index.ts";
import type { ActiveClaimState, ClaimRightEvaluation, ClaimStateV1, ClaimTiming } from "../claims/rights/index.ts";
import {
	type ClaimChange,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	type JsonValue,
	openClaimStore,
} from "../claims/storage/index.ts";
import type { ClaimTimingRequest, ClaimTransitionAction, ClaimTransitionRequest } from "../claims/transition/index.ts";
import { type PauseEvent, pauseIO } from "./fixtures/claim-admission-probe.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 30_000;
const LONG_TEST_TIMEOUT = 60_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout of lost-reply cases and of the recording schedule; every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/**
 * storage.timeoutMs of every scheduled call, above the longest scripted hold (HOLD_POLLS polls of 50 ms): a call
 * that ignored the schedule's timeout would see a held push end as a remote rejection, not a lost reply.
 */
const UNSCHEDULED_TIMEOUT = 20_000;
/** Per-Git-command timeout of a resend whose push the test holds in pre-receive; far above one writer round trip. */
const HELD_SEND_TIMEOUT = 10_000;
/** Bound for waiting on hook entries, hook drains, landings and settling calls. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
const THIRD_TICKET = "BACK-3";
const FOURTH_TICKET = "BACK-4";
const FIFTH_TICKET = "BACK-5";
/** Ticket of every leading positive control, so it never shares an admission key with a case. */
const CONTROL_TICKET = "BACK-9";
/** Sends allowed per call unless a case says otherwise. */
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
/** Stored lease end "10:05" of a foreign claim and its reclaim boundary "10:15". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
/** The admission slot name domain, followed by the canonical five-field key. */
const ADMISSION_DOMAIN = "backlog.md/claim-admission/v1\0";
/**
 * The `after` of a resend that the server declines at the ref update because the identical change landed meanwhile.
 * The base contract left it open as `remote-or-stale` until RED/GREEN observed the cause. Since then
 * storage reads such a refusal again, finds the ref at exactly this change's root and answers
 * `unknown`, as Git's `=` on a fresh advertisement does; rsm-05 and rsm-07 therefore pin it exactly.
 */
const LANDED_AFTER = "unknown";
const OPERATION_KEYS = ["action", "kind", "operationId", "outcome", "rights", "scope", "sends", "storage"];
const EVALUATED_KEYS = ["claimGeneration", "kind", "observedRoot", "ownership", "reclaim", "scope", "workRight"];
/** As ret-05 (claim-execution.test.ts:3053-3057): a receipt under the own ID that no record of ours made. */
const CONTRADICTING = {
	schema: 1,
	intentDigest: sha256Hex("contradicting intent"),
	parameterDigest: sha256Hex("contradicting parameters"),
};

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type Outcome = "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
type ContextHandle = { context: ClaimContext; directory: string };
type SequenceClock = { clock: () => number; calls: () => number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type JournalSeam = typeof claimJournalIO;
/**
 * `{storage, contextDirectory, contextIO?, journalIO?, operationId, clockSkewMs, clock, attempts,
 * schedule?, onPlanned?}`; taken from the scaffold's signature, so this file names no options type of its own.
 */
type ResendOptions = Parameters<typeof resendClaimIntent>[0];
type Run = { result: ClaimExecutionResult; pushes: string[][] };
type Tracked<T> = { promise: Promise<T>; settled: () => boolean };
type Racer = { repository: string; mark: number; pending: Tracked<ClaimExecutionResult> };
type Invocation = { n: number; lines: string[] };
type Receive = { from: string | null; to: string; ref: string };
type Sentinels = { anywhere: string[]; inReasons: string[] };
type IntentSpec = {
	operationId: string;
	ticket: string;
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
type QueryView = { kind: string | null; resolution: string | null };
/** O2 and O2′ of one context journal: digests of final records and of admission slots, by file name. */
type JournalView = { records: Record<string, string>; slots: Record<string, string> };
/** One gate call of the recording schedule: the send it precedes and the pushes the executor had started by then. */
type GateCall = { send: number; pushed: number };
type ScheduleView = {
	label: string;
	gates: GateCall[];
	timeoutPhases: number[];
	pushes: number;
	distinctPushes: number;
	clockCalls: number;
};
type ScheduledSpec = {
	operationId: string;
	ticket: string;
	attempts: number;
	stopAt: number | null;
	journalIO?: JournalSeam;
};
type ScheduledRun = Run & { schedule: RecordingSchedule; clockCalls: number };
type GateRow = {
	label: string;
	catches: string;
	operationId: string;
	ticket: string;
	stopAt: number | null;
	actions: HookAction[];
	applied: boolean;
	sends: number;
	gates: GateCall[];
	timeoutPhases: number[];
};
type SettledRow = {
	label: string;
	catches: string;
	operationId: string;
	ticket: string;
	resolution: "stored" | "not-stored" | "conflict";
};
type AdmissionRow = {
	label: string;
	catches: string;
	operationId: string;
	cause: string;
	journalIO?: JournalSeam;
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

// adapted from claim-execution-pause.test.ts:235
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-execution-pause.test.ts:242
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

// adapted from claim-execution-pause.test.ts:256
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-execution-pause.test.ts:260
function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** The record's frozen successor state as a JSON object; anything else is a fixture failure. */
function objectOf(value: JsonValue | undefined): JsonObject {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("fixture: the intent carries no successor object");
	}
	return value;
}

// adapted from claim-execution-pause.test.ts:265
function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

// adapted from claim-execution-pause.test.ts:271
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution-pause.test.ts:276
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Writes raw bytes with mode 0600, bypassing the journal. */
// adapted from claim-execution-pause.test.ts:286
async function writePrivate(path: string, text: string): Promise<void> {
	await writeFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600);
}

// adapted from claim-execution-pause.test.ts:291
function lease(leaseEnd: number): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd: null };
}

// adapted from claim-execution-pause.test.ts:296
function active(binding: string, timing: ClaimTiming, changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
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

function leaseRequest(): ClaimTimingRequest {
	return { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
}

function acquire(owner = OWNER): ClaimTransitionRequest {
	return { action: "acquire", owner, timing: leaseRequest() };
}

/** The successor of an acquire from absent at T by `handle`. */
// adapted from claim-execution-pause.test.ts:338
function acquiredOf(handle: ContextHandle, owner = OWNER): ActiveClaimState {
	return active(handle.context.binding, lease(T + TTL), { owner, claimGeneration: 1 });
}

/** The reference intent, built from constants, never from a plan under test (epoch 1 of the fixture). */
// adapted from claim-execution-pause.test.ts:344
function referenceIntent(remote: string, format: ClaimStorageFormat, spec: IntentSpec): ClaimOperationIntent {
	return {
		operationId: spec.operationId,
		remote,
		format,
		epoch: 1,
		ticket: spec.ticket,
		expectedRoot: spec.expectedRoot,
		targetBinding: spec.next.status === "active" ? spec.next.binding : null,
		action: spec.request.action,
		parameters: json(spec.request),
		resolved: { next: json(spec.next) },
	};
}

// adapted from claim-execution-pause.test.ts:360
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

// adapted from claim-execution-pause.test.ts:375
function recordFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [`${intent.operationId}.json`]: sha256Hex(recordText(intent)) };
}

/** `.admission-` and the hex SHA-256 of the domain and the canonical five-field key of the intent. */
// adapted from claim-execution-pause.test.ts:383
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

// adapted from claim-execution-pause.test.ts:395
function slotFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [slotName(intent)]: sha256Hex(recordText(intent)) };
}

/** Expected O2 and O2′ of one context journal, kept in step with each case. */
// adapted from claim-execution-pause.test.ts:400
class Ledger {
	private readonly records: Record<string, string> = {};
	private readonly slots: Record<string, string> = {};

	/** A published intent that holds no slot. */
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
 * A wall clock that serves `reads` in order and counts its calls; a call beyond them throws. For resends,
 * ASSUMPTION(retry): no clock for planning, at most two reads, both only for rights; the count is not pinned.
 */
// adapted from claim-execution-pause.test.ts:425
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

// adapted from claim-execution-pause.test.ts:438
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

// adapted from claim-execution-pause.test.ts:458
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

// adapted from claim-execution-pause.test.ts:473
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

/**
 * The verdict view of one result. `anywhere` values (secrets, bindings, paths, endpoint, owners) may appear nowhere
 * in the result; `inReasons` values (operation IDs, roots) may appear in no reason at any depth.
 */
// adapted from claim-execution-pause.test.ts:513 (viewOf), without plan and pause
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
		sends: typeof sends === "number" ? sends : null,
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
		echoed,
	};
}

/** A resend returns the executor's result type unchanged, so its operation keys are the base executor's. */
// adapted from claim-execution-pause.test.ts:556
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
		sends: expected.sends,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

// adapted from claim-execution-pause.test.ts:661
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

// adapted from claim-execution-pause.test.ts:687
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

// adapted from claim-execution-pause.test.ts:700
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

const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

// adapted from claim-execution-pause.test.ts:731
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

function heldRights(root: string, reclaimState: Reclaim, workRight: WorkRight, generation: number): RightsView {
	return evaluatedRights("held", workRight, reclaimState, root, generation);
}

function foreignRights(root: string, reclaimState: Reclaim, generation: number): RightsView {
	return evaluatedRights("foreign", noRight("not-holder"), reclaimState, root, generation);
}

const ABSENT_RIGHTS: RightsView = evaluatedRights("absent", noRight("absent"), NOT_APPLICABLE, null, null);

/** An acquire from absent at T that applied with one send; rights come from the fresh final read at T. */
// adapted from claim-execution-pause.test.ts:768
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

/** An acquire from absent that sent nothing, with the rights evaluation of its absent read at T. */
function notSentView(label: string, operationId: string, cause: string): ExecutionView {
	return operationView(label, {
		action: "acquire",
		operationId,
		storage: notSentStorage(cause),
		outcome: "not-sent",
		rights: ABSENT_RIGHTS,
		sends: 0,
	});
}

function queryViewOf(value: unknown): QueryView {
	return { kind: textOf(field(value, "kind")), resolution: textOf(field(field(value, "resolution"), "kind")) };
}

function byStorageKind(left: Run, right: Run): number {
	const kindOf = (run: Run) => String(textOf(field(field(run.result, "storage"), "kind")));
	return byCodeUnits(kindOf(left), kindOf(right));
}

// adapted from claim-execution.test.ts:310
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

/** A receive-hook stdin line `<old> <new> <ref>`; an all-zero old ID (creation) is shown as null. */
// adapted from claim-execution.test.ts:447
function receiveOf(line: string): Receive {
	const [from = "", to = "", ref = ""] = line.split(" ");
	return { from: /^0+$/.test(from) ? null : from, to, ref };
}

/** Number of distinct push argument lists; a byte-identical repetition repeats exactly one. */
// adapted from claim-execution.test.ts:453
function distinct(pushes: string[][]): number {
	return new Set(pushes.map((args) => JSON.stringify(args))).size;
}

/**
 * Journal IO for the first `lstat` of `<operationId>.json` after a `link` and once `ready` holds: the record load of
 * the executor's query after a lost reply; `act` runs there once, before that query reads the store.
 */
// adapted from claim-execution.test.ts:835 (recordLstatWhen), effect only
function recordLstatWhen(operationId: string, ready: () => Promise<boolean>, act: () => Promise<void>): JournalSeam {
	const state = { linked: false, fired: false };
	const publish = async (...args: Parameters<JournalSeam["link"]>) => {
		await claimJournalIO.link(...args);
		state.linked = true;
	};
	const lstatWhen = async (...args: Parameters<JournalSeam["lstat"]>) => {
		if (!state.fired && state.linked && String(args[0]).endsWith(`/${operationId}.json`) && (await ready())) {
			state.fired = true;
			await act();
		}
		return claimJournalIO.lstat(...args);
	};
	return {
		...claimJournalIO,
		link: publish as unknown as JournalSeam["link"],
		lstat: lstatWhen as unknown as JournalSeam["lstat"],
	};
}

// adapted from claim-execution-pause.test.ts:821
function tracked<T>(promise: Promise<T>): Tracked<T> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-execution-pause.test.ts:832
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
// adapted from claim-execution-pause.test.ts:847
async function settleWithin<T>(label: string, pending: Tracked<T>): Promise<T> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** Polls `condition` until it holds; fails after EVENT_TIMEOUT. */
async function waitUntil(label: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * S2, test-local and synchronous, so a schedule seam can read it between sends: every trace2 `start` argv of
 * `git -C <repository> ...` without that prefix. Product Git inherits GIT_TRACE2_EVENT (storage/index.ts:180-196).
 */
// adapted from claim-execution-pause.test.ts:892
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
// adapted from claim-execution-pause.test.ts:918, without the receive-pack PID
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
// adapted from claim-execution-pause.test.ts:945 (ReceiveScript) and claim-execution.test.ts:1000 (invocations)
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
 * The fake send schedule of bud-02: "send" except "stop" at `stopAt`, LOSS_TIMEOUT per command, and
 * every call recorded against the pushes the executor had started by then (S2), so calls are placed without a clock.
 */
// ASSUMPTION(retry): ClaimSendSchedule is exported by the execution module, beside the option that takes it.
class RecordingSchedule implements ClaimSendSchedule {
	readonly gates: GateCall[] = [];
	private readonly asked: number[] = [];
	private readonly pushed: () => number;
	private readonly stopAt: number | null;

	constructor(pushed: () => number, stopAt: number | null) {
		this.pushed = pushed;
		this.stopAt = stopAt;
	}

	beforeSend(send: number): Promise<"send" | "stop"> {
		this.gates.push({ send, pushed: this.pushed() });
		const decision: "send" | "stop" = send === this.stopAt ? "stop" : "send";
		return Promise.resolve(decision);
	}

	commandTimeoutMs(): number {
		this.asked.push(this.pushed());
		return LOSS_TIMEOUT;
	}

	/** Distinct push counts at the timeout requests: 0 is the store open, n ≥ 1 a query or the final read after n. */
	phases(): number[] {
		return [...new Set(this.asked)];
	}
}

/** One server repository with S1 hooks, the executor's client, contexts, a writer client and the S2 trace. */
// adapted from claim-execution-pause.test.ts:1008 (ExecutionCase), without children and journal gates
class RetryCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The executor's client repository. */
	readonly primary: string;
	/** Private 0700 parent of all contexts of this case. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	private readonly tracePath: string;
	/** Operation IDs handed to a call; no reason may echo them. */
	private readonly guarded = new Set<string>();
	private readonly secrets = new Map<string, string>();
	private readonly pendings: Tracked<ClaimExecutionResult>[] = [];
	private previousTrace: string | undefined;
	private tracing = false;
	private writerStore: ClaimStore | undefined;
	private writes = 0;

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

	static async create(format: ClaimStorageFormat, caseName: string): Promise<RetryCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-execution-retry-"));
		try {
			const { name, repo } = await server().initRepository(root, `retry-${format}-${caseName}`);
			const primary = await RetryCase.initClient(join(root, "client-executor"));
			const retryCase = new RetryCase(format, root, server().url(name), repo, primary);
			await retryCase.hooks.install();
			await mkdir(retryCase.parent);
			await chmod(retryCase.parent, 0o700);
			const initializer = await retryCase.client("initializer");
			expectKind(await initializeClaimStorage(retryCase.storage(initializer)), "created");
			retryCase.startTrace();
			return retryCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-execution-pause.test.ts:1062
	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An independent client repository; parallel resends use one each so S2 can attribute their pushes. */
	async client(label: string): Promise<string> {
		return RetryCase.initClient(join(this.root, `client-${label}`));
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
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		this.secrets.set(handle.directory, secret);
		return secret;
	}

	async view(label: string, result: unknown, handles: ContextHandle[]): Promise<ExecutionView> {
		const anywhere = [this.root, this.parent, this.url, OWNER, OTHER_OWNER];
		for (const handle of handles) {
			anywhere.push(await this.secretOf(handle), handle.context.binding, handle.directory);
		}
		const inReasons = [...this.guarded, ...Object.values(await this.serverRefs())];
		return viewOf(label, result, { anywhere, inReasons });
	}

	async expectView(result: unknown, expected: ExecutionView, handles: ContextHandle[]): Promise<void> {
		expect(await this.view(expected.label, result, handles)).toStrictEqual(expected);
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

	/** No ticket, request or plan; the record under `operationId` in the context's journal decides. */
	resendOptions(
		handle: ContextHandle,
		operationId: string,
		clock: SequenceClock,
		changes: Partial<ResendOptions> = {},
	): ResendOptions {
		this.guarded.add(operationId);
		return {
			storage: this.storage(),
			contextDirectory: handle.directory,
			operationId,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: ATTEMPTS,
			...changes,
		};
	}

	intent(spec: IntentSpec): ClaimOperationIntent {
		return referenceIntent(this.url, this.format, spec);
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

	async writeState(payload: JsonObject, ticket: string): Promise<string> {
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

	/** O2 and O2′ (adapted from claim-execution-pause.test.ts:1176): final records and admission slots with digests. */
	async journalView(handle: ContextHandle): Promise<JournalView> {
		return {
			records: await this.digestsOf(handle, (name) => !name.startsWith(".") && name.endsWith(".json")),
			slots: await this.digestsOf(handle, (name) => name.startsWith(".admission-")),
		};
	}

	async journal(handle: ContextHandle): Promise<ClaimIntentJournal> {
		return expectKind(await openClaimIntentJournal({ directory: handle.context.journalDirectory }), "open").journal;
	}

	/** Publishes `intent` through the journal API, as an earlier call of this context would have. */
	// adapted from claim-execution-pause.test.ts:1196
	async plant(handle: ContextHandle, intent: ClaimOperationIntent): Promise<void> {
		this.guarded.add(intent.operationId);
		const prepared = await (await this.journal(handle)).prepare(intent);
		expect({ planted: intent.operationId, prepared }).toEqual({
			planted: intent.operationId,
			prepared: { kind: "prepared", record: recordOf(intent) },
		});
	}

	query(handle: ContextHandle, operationId: string) {
		return queryClaimMutation({
			journalDirectory: handle.context.journalDirectory,
			operationId,
			storage: this.storage(),
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

	async ticketRoot(ticket: string): Promise<string> {
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** S2: the number of Git commands run so far in `repository`. */
	mark(repository = this.primary): number {
		return gitCommandsOf(this.tracePath, repository).length;
	}

	pushesSince(mark: number, repository = this.primary): string[][] {
		return gitCommandsOf(this.tracePath, repository)
			.slice(mark)
			.filter((args) => args[0] === "push");
	}

	async run(options: ExecuteClaimTransitionOptions): Promise<Run> {
		const mark = this.mark();
		const result = await executeClaimTransition(options);
		return { result, pushes: this.pushesSince(mark) };
	}

	async resend(options: ResendOptions): Promise<Run> {
		const mark = this.mark();
		const result = await resendClaimIntent(options);
		return { result, pushes: this.pushesSince(mark) };
	}

	/** Starts one resend on `repository` without awaiting it; dispose settles it if the test does not. */
	startResend(options: ResendOptions, repository: string): Racer {
		const mark = this.mark(repository);
		const pending = tracked(resendClaimIntent(options));
		this.pendings.push(pending);
		return { repository, mark, pending };
	}

	async settle(label: string, racer: Racer): Promise<Run> {
		const result = await settleWithin(label, racer.pending);
		return { result, pushes: this.pushesSince(racer.mark, racer.repository) };
	}

	/** Waits, bounded, until invocation `n` of `phase` has left its hold. */
	async waitFinished(phase: ReceivePhase, n: number): Promise<void> {
		await waitUntil(`receive ${phase}-${n} to finish`, () => this.hooks.hasFinished(phase, n));
	}

	/** Releases invocations since+1 to since+count of `phase` and waits until each has left its hold. */
	async releaseHeld(phase: ReceivePhase, since: number, count: number): Promise<void> {
		for (let n = since + 1; n <= since + count; n++) {
			await this.hooks.release(phase, n);
			await this.waitFinished(phase, n);
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

	/** Releases every hold, settles every started call, restores the trace variable and removes the case root. */
	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
			await Promise.all(this.pendings.map((pending) => settleWithin("pending call", pending).catch(() => undefined)));
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-execution-pause.test.ts:1360
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: RetryCase) => Promise<void>,
): Promise<void> {
	const fixture = await RetryCase.create(format, caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

/** An acquire whose slot link fails once: published, never admitted, nothing sent (exi-08b). */
async function unadmitted(
	fixture: RetryCase,
	handle: ContextHandle,
	ledger: Ledger,
	operationId: string,
	ticket: string,
): Promise<ClaimOperationIntent> {
	const journalIO = pauseIO({
		directory: handle.context.journalDirectory,
		faults: [{ op: "link", target: "slot", code: "EIO", times: 1 }],
	});
	const clock = sequenceClock(T, T);
	const run = await fixture.run(fixture.options(handle, operationId, acquire(), clock, { ticket, journalIO }));
	const view = notSentView(`${operationId} set-up: published, unadmitted`, operationId, "admission-unavailable");
	await fixture.expectView(run.result, view, [handle]);
	const intent = fixture.acquireIntent(handle, operationId, ticket);
	ledger.published(intent);
	expect({
		pushes: run.pushes.length,
		clockCalls: clock.calls(),
		ref: await fixture.ticketRoot(ticket),
		journal: await fixture.journalView(handle),
	}).toEqual({ pushes: 0, clockCalls: 1, ref: ABSENT_REF, journal: ledger.view() });
	return intent;
}

/**
 * Leading positive control of every resumption test: an unadmitted acquire on CONTROL_TICKET is resent once and
 * applies, and its bytes now fill its admission slot. The scaffold's `resendClaimIntent` answers
 * `unavailable`, so each of these tests fails here, before any case of its own.
 */
async function controlResend(
	fixture: RetryCase,
	handle: ContextHandle,
	ledger: Ledger,
	operationId: string,
): Promise<void> {
	const intent = await unadmitted(fixture, handle, ledger, operationId, CONTROL_TICKET);
	const resent = await fixture.resend(fixture.resendOptions(handle, operationId, sequenceClock(T, T)));
	const root = await fixture.ticketRoot(CONTROL_TICKET);
	const view = acquiredView(`${operationId} positive control`, operationId, root);
	await fixture.expectView(resent.result, view, [handle]);
	ledger.admitted(intent);
	expect({ pushes: resent.pushes.length, journal: await fixture.journalView(handle) }).toEqual({
		pushes: 1,
		journal: ledger.view(),
	});
}

/**
 * One acquire under a fresh RecordingSchedule with UNSCHEDULED_TIMEOUT in storage. ASSUMPTION(retry): the executor asks
 * `commandTimeoutMs()` for its store open, for every query and for the final read, and uses the value there.
 */
async function runScheduled(fixture: RetryCase, handle: ContextHandle, spec: ScheduledSpec): Promise<ScheduledRun> {
	const mark = fixture.mark();
	const schedule = new RecordingSchedule(() => fixture.pushesSince(mark).length, spec.stopAt);
	const clock = sequenceClock(T, T);
	const options = fixture.options(handle, spec.operationId, acquire(), clock, {
		ticket: spec.ticket,
		storage: fixture.storage(fixture.primary, { timeoutMs: UNSCHEDULED_TIMEOUT }),
		attempts: spec.attempts,
		journalIO: spec.journalIO,
		schedule,
	});
	const run = await fixture.run(options);
	return { ...run, schedule, clockCalls: clock.calls() };
}

function scheduleView(label: string, scheduled: ScheduledRun): ScheduleView {
	return {
		label,
		gates: [...scheduled.schedule.gates],
		timeoutPhases: scheduled.schedule.phases(),
		pushes: scheduled.pushes.length,
		distinctPushes: distinct(scheduled.pushes),
		clockCalls: scheduled.clockCalls,
	};
}

/**
 * Leading positive control of both bud-02 tests: a healthy acquire under the recording schedule applies with one
 * push, asks no gate and asks a timeout for its store open and for its final read. The scaffold keeps the
 * The executor before the pause, which ignores `schedule`, so the timeout phases stay empty and each test fails here.
 */
async function controlScheduled(fixture: RetryCase, handle: ContextHandle, operationId: string): Promise<void> {
	const scheduled = await runScheduled(fixture, handle, {
		operationId,
		ticket: CONTROL_TICKET,
		attempts: ATTEMPTS,
		stopAt: null,
	});
	const label = `${operationId} positive control`;
	const root = await fixture.ticketRoot(CONTROL_TICKET);
	await fixture.expectView(scheduled.result, acquiredView(label, operationId, root), [handle]);
	expect(scheduleView(label, scheduled)).toEqual({
		label,
		gates: [],
		timeoutPhases: [0, 1],
		pushes: 1,
		distinctPushes: 1,
		clockCalls: 2,
	});
}

/**
 * The verdict of a lost reply whose query settles the intent, as ret-01, ret-04 and ret-05 of claim-execution.test.ts.
 */
function gateView(label: string, row: GateRow, root: string): ExecutionView {
	if (row.applied) {
		return operationView(label, {
			action: "acquire",
			operationId: row.operationId,
			storage: appliedStorage(root),
			outcome: "applied",
			rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
			sends: row.sends,
		});
	}
	return operationView(label, {
		action: "acquire",
		operationId: row.operationId,
		storage: queriedStorage("unknown", "resolved", "open", null),
		outcome: "unknown",
		rights: ABSENT_RIGHTS,
		sends: row.sends,
	});
}

function settledView(label: string, row: SettledRow, root: string): ExecutionView {
	switch (row.resolution) {
		case "stored":
			return operationView(label, {
				action: "acquire",
				operationId: row.operationId,
				storage: queriedStorage("unknown", "resolved", "stored", root),
				outcome: "applied",
				rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
				sends: 1,
			});
		case "not-stored":
			return operationView(label, {
				action: "acquire",
				operationId: row.operationId,
				storage: queriedStorage("unknown", "resolved", "not-stored", root),
				outcome: "rejected",
				rights: foreignRights(root, notYet(R), 1),
				sends: 1,
			});
		case "conflict":
			return operationView(label, {
				action: "acquire",
				operationId: row.operationId,
				storage: queriedStorage("unknown", "resolved", "conflict", null),
				outcome: "unknown-history",
				rights: foreignRights(root, notYet(R), 1),
				sends: 1,
			});
	}
}

for (const format of FORMATS) {
	describe(`claim send schedule and resumption over real Git (${format})`, () => {
		test(
			"bud-02: asks the gate before sends 2 and 3 only, stops at its answer, asks a timeout per open and query",
			async () => {
				await withCase(format, "bud-02-gate", async (fixture) => {
					const karl = await fixture.context();
					await controlScheduled(fixture, karl, "op-bud-02-control");
					// The gate runs only before a resend that the retry rule allows.
					const rows: GateRow[] = [
						{
							label: "bud-02a two replies lost by hold-reject, then a pass",
							catches: "a gate before send 1, a resend without its gate, the storage timeout used",
							operationId: "op-bud-02-a",
							ticket: TICKET,
							stopAt: null,
							actions: ["hold-reject", "hold-reject"],
							applied: true,
							sends: 3,
							gates: [
								{ send: 2, pushed: 1 },
								{ send: 3, pushed: 2 },
							],
							timeoutPhases: [0, 1, 2, 3],
						},
						{
							label: "bud-02b the gate answers stop before send 2",
							catches: "a stop ignored, a second send, the stop read as rejected",
							operationId: "op-bud-02-b",
							ticket: SECOND_TICKET,
							stopAt: 2,
							actions: ["hold-reject"],
							applied: false,
							sends: 1,
							gates: [{ send: 2, pushed: 1 }],
							timeoutPhases: [0, 1],
						},
					];
					for (const row of rows) {
						const label = `${row.label} (catches: ${row.catches})`;
						const since = await fixture.hooks.count("pre");
						await fixture.hooks.plan("pre", row.actions, "pass");
						const scheduled = await runScheduled(fixture, karl, {
							operationId: row.operationId,
							ticket: row.ticket,
							attempts: ATTEMPTS,
							stopAt: row.stopAt,
						});
						const root = await fixture.ticketRoot(row.ticket);
						await fixture.expectView(scheduled.result, gateView(label, row, root), [karl]);
						// The stop cause itself is a surface fact (stoppedBy); the executor result keeps its schema.
						expect({ ...scheduleView(label, scheduled), landed: root !== ABSENT_REF }).toEqual({
							label,
							gates: row.gates,
							timeoutPhases: row.timeoutPhases,
							pushes: row.sends,
							distinctPushes: 1,
							clockCalls: 2,
							landed: row.applied,
						});
						await fixture.releaseHeld("pre", since, row.actions.length);
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"bud-02: never asks the gate after the query found the intent stored, not stored or contradicted",
			async () => {
				await withCase(format, "bud-02-settled", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					await controlScheduled(fixture, karl, "op-bud-02-settled-control");
					const foreign = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 1 });
					const rows: SettledRow[] = [
						{
							label: "bud-02c lost reply after landing",
							catches: "a gate call or a resend after stored",
							operationId: "op-bud-02-c",
							ticket: THIRD_TICKET,
							resolution: "stored",
						},
						{
							label: "bud-02d competitor landed while held",
							catches: "a gate call or a resend after not-stored",
							operationId: "op-bud-02-d",
							ticket: FOURTH_TICKET,
							resolution: "not-stored",
						},
						{
							label: "bud-02e contradicting receipt under the own ID",
							catches: "a gate call or a resend after conflict",
							operationId: "op-bud-02-e",
							ticket: FIFTH_TICKET,
							resolution: "conflict",
						},
					];
					for (const row of rows) {
						const label = `${row.label} (catches: ${row.catches})`;
						// As ret-01 (post-receive holds the landed push's reply) and ret-04/ret-05 (a writer lands while
						// pre-receive holds the push, triggered by the query's record load; claim-execution.test.ts:3016-3060).
						const phase: ReceivePhase = row.resolution === "stored" ? "post" : "pre";
						const since = await fixture.hooks.count(phase);
						await fixture.hooks.plan(phase, [row.resolution === "stored" ? "hold" : "hold-reject"], "pass");
						const held = () => fixture.hooks.hasEntered(phase, since + 1);
						const contradiction = { operationId: row.operationId, receipt: CONTRADICTING, payload: foreign };
						const land = async (): Promise<void> => {
							if (row.resolution === "not-stored") await fixture.writeState(foreign, row.ticket);
							else await fixture.writeChange(row.ticket, contradiction);
						};
						const journalIO = row.resolution === "stored" ? undefined : recordLstatWhen(row.operationId, held, land);
						const settled = await runScheduled(fixture, karl, {
							operationId: row.operationId,
							ticket: row.ticket,
							attempts: ATTEMPTS,
							stopAt: null,
							journalIO,
						});
						const root = await fixture.ticketRoot(row.ticket);
						await fixture.expectView(settled.result, settledView(label, row, root), handles);
						expect(scheduleView(label, settled)).toEqual({
							label,
							gates: [],
							timeoutPhases: [0, 1],
							pushes: 1,
							distinctPushes: 1,
							clockCalls: 2,
						});
						await fixture.releaseHeld(phase, since, 1);
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"unk-05: resends nothing over a contradicting receipt under the own ID; resend and query see conflict",
			async () => {
				await withCase(format, "unk-05", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const ledger = new Ledger();
					await controlResend(fixture, karl, ledger, "op-unk-05-control");
					await unadmitted(fixture, karl, ledger, "op-unk-05", TICKET);

					// As ret-05: a foreign writer lands a different receipt under our operation ID on the intent's root.
					const foreign = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 1 });
					const root = await fixture.writeChange(TICKET, {
						operationId: "op-unk-05",
						receipt: CONTRADICTING,
						payload: foreign,
					});
					const refs = await fixture.serverRefs();
					const resent = await fixture.resend(fixture.resendOptions(karl, "op-unk-05", sequenceClock(T, T)));
					// Conflict ends as unknown-history (exit 4 at the surface) and "earlier-process" marks the
					// clarification before any send.
					const expected = operationView("unk-05 resend (catches: conflict as applied or open, a send over it)", {
						action: "acquire",
						operationId: "op-unk-05",
						storage: queriedStorage("earlier-process", "resolved", "conflict", null),
						outcome: "unknown-history",
						rights: foreignRights(root, notYet(R), 1),
						sends: 0,
					});
					await fixture.expectView(resent.result, expected, handles);
					expect({
						pushes: resent.pushes.length,
						refs: await fixture.serverRefs(),
						journal: await fixture.journalView(karl),
						query: queryViewOf(await fixture.query(karl, "op-unk-05")),
					}).toEqual({
						pushes: 0,
						refs,
						journal: ledger.view(),
						query: { kind: "resolved", resolution: "conflict" },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rsm-05: queries a resend that the server declines because the earlier change landed meanwhile",
			async () => {
				await withCase(format, "rsm-05", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlResend(fixture, karl, ledger, "op-rsm-05-control");

					// The earlier call: its push is held past the client timeout and declined late; the intent stays open
					// and admitted (exi-02a, claim-execution-pause.test.ts:2156-2181).
					const lostPre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });
					const lostOptions = fixture.options(karl, "op-rsm-05", acquire(), sequenceClock(T, T), {
						storage: loss,
						attempts: 1,
					});
					const lost = await fixture.run(lostOptions);
					const lostView = operationView("rsm-05 set-up: the earlier call's lost acquire", {
						action: "acquire",
						operationId: "op-rsm-05",
						storage: queriedStorage("unknown", "resolved", "open", null),
						outcome: "unknown",
						rights: ABSENT_RIGHTS,
						sends: 1,
					});
					await fixture.expectView(lost.result, lostView, [karl]);
					await fixture.releaseHeld("pre", lostPre, 1);
					ledger.admitted(fixture.acquireIntent(karl, "op-rsm-05", TICKET));
					expect({ ref: await fixture.ticketRoot(TICKET), journal: await fixture.journalView(karl) }).toEqual({
						ref: ABSENT_REF,
						journal: ledger.view(),
					});

					// The resend's push holds in pre-receive while a second store lands exactly the record's change: the
					// payload `resolved.next` with the receipt of createClaimMutationReceipt, on the same base.
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold"], "pass");
					// ASSUMPTION(retry): without a schedule, resendClaimIntent uses storage.timeoutMs per Git command.
					const held = fixture.storage(fixture.primary, { timeoutMs: HELD_SEND_TIMEOUT });
					const resendClock = sequenceClock(T, T);
					const options = fixture.resendOptions(karl, "op-rsm-05", resendClock, { storage: held, attempts: 1 });
					const racer = fixture.startResend(options, fixture.primary);
					const entered = await whilePending("rsm-05 resend in pre-receive", racer.pending, () =>
						fixture.hooks.hasEntered("pre", pre + 1),
					);
					expect({ entered }).toEqual({ entered: true });
					const loaded = expectKind(await (await fixture.journal(karl)).load("op-rsm-05"), "loaded").record;
					const receipt = expectKind(createClaimMutationReceipt(loaded), "receipt").receipt;
					const change = { operationId: "op-rsm-05", receipt, payload: objectOf(loaded.intent.resolved.next) };
					const landed = await fixture.writeChange(TICKET, change);
					const heldAtLanding = !racer.pending.settled() && !(await fixture.hooks.hasFinished("pre", pre + 1));
					await fixture.hooks.release("pre", pre + 1);
					const resent = await fixture.settle("rsm-05 resend", racer);
					// (catches: the declined resend of a landed identical change read as `stale` or `remote`; addenda 2
					// and 3): the re-read finds this change's root, so `after` is LANDED_AFTER.
					const label = "rsm-05 resend declined after the landing (catches: a declined resend read as final)";
					const expected = operationView(label, {
						action: "acquire",
						operationId: "op-rsm-05",
						storage: queriedStorage(LANDED_AFTER, "resolved", "stored", landed),
						outcome: "applied",
						rights: heldRights(landed, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					expect(await fixture.view(label, resent.result, [karl])).toStrictEqual(expected);
					// Fixture preconditions: the landing happened while the resend was held, and both receive lines are
					// the same creation of the same root (same change on the same base, same graph).
					const line: Receive = { from: null, to: landed, ref: refOf(TICKET) };
					expect({
						heldAtLanding,
						pushes: resent.pushes.length,
						receives: (await fixture.hooks.invocations("pre", pre)).map((call) => call.lines.map(receiveOf)),
						ref: await fixture.ticketRoot(TICKET),
						journal: await fixture.journalView(karl),
						query: queryViewOf(await fixture.query(karl, "op-rsm-05")),
					}).toEqual({
						heldAtLanding: true,
						pushes: 1,
						receives: [[line], [line]],
						ref: landed,
						journal: ledger.view(),
						query: { kind: "resolved", resolution: "stored" },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rsm-06: resends nothing while the admission slot of its key is held, unwritable or unreadable",
			async () => {
				await withCase(format, "rsm-06", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlResend(fixture, karl, ledger, "op-rsm-06-control");
					const journalDirectory = karl.context.journalDirectory;

					// (a): another record of the same key (ticket, endpoint, format, epoch, root) holds the slot.
					await unadmitted(fixture, karl, ledger, "op-rsm-06-a", TICKET);
					const holder = fixture.acquireIntent(karl, "op-rsm-06-holder", TICKET, OTHER_OWNER);
					await fixture.plant(karl, holder);
					expect(await (await fixture.journal(karl)).admit(recordOf(holder))).toEqual({ kind: "admitted" });
					ledger.admitted(holder);
					// (b) every slot link of the resend fails with EIO (as exi-08b).
					await unadmitted(fixture, karl, ledger, "op-rsm-06-b", SECOND_TICKET);
					const events: PauseEvent[] = [];
					const unwritable = pauseIO({
						directory: journalDirectory,
						events,
						faults: [{ op: "link", target: "slot", code: "EIO", times: Number.MAX_SAFE_INTEGER }],
					});
					// (c) the key's slot name holds garbage from before the first send (as exi-08a).
					const occupied = fixture.acquireIntent(karl, "op-rsm-06-c", THIRD_TICKET);
					const garbage = "not an admission slot\n";
					await writePrivate(join(journalDirectory, slotName(occupied)), garbage);
					const foreignSlot = { [slotName(occupied)]: sha256Hex(garbage) };
					const blockedOptions = fixture.options(karl, "op-rsm-06-c", acquire(), sequenceClock(T, T), {
						ticket: THIRD_TICKET,
					});
					const blocked = await fixture.run(blockedOptions);
					const blockedLabel = "rsm-06c set-up: the first send finds garbage in its slot";
					await fixture.expectView(blocked.result, notSentView(blockedLabel, "op-rsm-06-c", "admission-corrupt"), [
						karl,
					]);
					ledger.published(occupied);

					// Every admission failure of a resend is not-sent with its cause and sends nothing.
					const rows: AdmissionRow[] = [
						{
							label: "rsm-06a slot held by another intent of the same key",
							catches: "a resend without its own admission, a replaced slot",
							operationId: "op-rsm-06-a",
							cause: "admission-held",
						},
						{
							label: "rsm-06b every slot link fails with EIO",
							catches: "a fallback write, a send anyway",
							operationId: "op-rsm-06-b",
							cause: "admission-unavailable",
							journalIO: unwritable,
						},
						{
							label: "rsm-06c slot name occupied by garbage",
							catches: "garbage read as admission, a replaced slot",
							operationId: "op-rsm-06-c",
							cause: "admission-corrupt",
						},
					];
					const refs = await fixture.serverRefs();
					for (const row of rows) {
						const label = `${row.label} (catches: ${row.catches})`;
						const clock = sequenceClock(T, T);
						const options = fixture.resendOptions(karl, row.operationId, clock, { journalIO: row.journalIO });
						const resent = await fixture.resend(options);
						await fixture.expectView(resent.result, notSentView(label, row.operationId, row.cause), [karl]);
						expect({
							label,
							pushes: resent.pushes.length,
							refs: await fixture.serverRefs(),
							journal: await fixture.journalView(karl),
						}).toEqual({ label, pushes: 0, refs, journal: ledger.view(foreignSlot) });
					}
					const slotWrites = events.filter(
						(event) => event.target === "slot" && ["open-write", "write", "unlink"].includes(event.op),
					);
					expect({
						slotLinkTried: events.some((event) => event.op === "link" && event.target === "slot"),
						slotWrites: slotWrites.length,
					}).toEqual({ slotLinkTried: true, slotWrites: 0 });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rsm-07: admits two parallel resumptions of one ID; both send the identical change and end applied",
			async () => {
				await withCase(format, "rsm-07", async (fixture) => {
					const karl = await fixture.context();
					const ledger = new Ledger();
					await controlResend(fixture, karl, ledger, "op-rsm-07-control");
					const intent = await unadmitted(fixture, karl, ledger, "op-rsm-07", TICKET);
					const repositories = [await fixture.client("resend-1"), await fixture.client("resend-2")];

					// Both resends pass resolution and the idempotent admission before either lands; pre-receive
					// holds both pushes, so each has sent once when the first is released.
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold", "hold"], "pass");
					const racers = repositories.map((repository) => {
						const storage = fixture.storage(repository, { timeoutMs: HELD_SEND_TIMEOUT });
						const options = fixture.resendOptions(karl, "op-rsm-07", sequenceClock(T, T), { storage });
						return fixture.startResend(options, repository);
					});
					const either = { settled: () => racers.some((racer) => racer.pending.settled()) };
					const bothEntered = async () => {
						const first = await fixture.hooks.hasEntered("pre", pre + 1);
						return first && (await fixture.hooks.hasEntered("pre", pre + 2));
					};
					const bothHeld = await whilePending("rsm-07 both resends in pre-receive", either, bothEntered);
					expect({ bothHeld }).toEqual({ bothHeld: true });
					await fixture.hooks.release("pre", pre + 1);
					await waitUntil("rsm-07 first landing", async () => (await fixture.ticketRoot(TICKET)) !== ABSENT_REF);
					await fixture.hooks.release("pre", pre + 2);
					const runs: Run[] = [];
					for (const [index, racer] of racers.entries()) {
						runs.push(await fixture.settle(`rsm-07 resend ${index + 1}`, racer));
					}
					const root = await fixture.ticketRoot(TICKET);
					const [first, second] = [...runs].sort(byStorageKind);
					// (catches: the declined resend of a landed identical change read as `stale` or `remote`; addenda 2
					// and 3): resend 2 is released only after resend 1 landed, the re-read finds this change's root.
					const landedLabel = "rsm-07 the resend that landed";
					const queriedLabel = "rsm-07 the declined resend (catches: its rejection read as final)";
					const expected = [
						acquiredView(landedLabel, "op-rsm-07", root),
						operationView(queriedLabel, {
							action: "acquire",
							operationId: "op-rsm-07",
							storage: queriedStorage(LANDED_AFTER, "resolved", "stored", root),
							outcome: "applied",
							rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
							sends: 1,
						}),
					];
					expect([
						await fixture.view(landedLabel, first?.result, [karl]),
						await fixture.view(queriedLabel, second?.result, [karl]),
					]).toStrictEqual(expected);
					ledger.admitted(intent);
					const line: Receive = { from: null, to: root, ref: refOf(TICKET) };
					expect({
						pushes: runs.map((run) => run.pushes.length),
						distinctPushes: distinct(runs.flatMap((run) => run.pushes)),
						receives: (await fixture.hooks.invocations("pre", pre)).map((call) => call.lines.map(receiveOf)),
						journal: await fixture.journalView(karl),
						query: queryViewOf(await fixture.query(karl, "op-rsm-07")),
					}).toEqual({
						pushes: [1, 1],
						distinctPushes: 1,
						receives: [[line], [line]],
						journal: ledger.view(),
						query: { kind: "resolved", resolution: "stored" },
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}
