/**
 * Behavioural contract of the executor for the three administrative actions: transfer, resume and non-extending bound
 * changes run through the one intent, write, resolve and identical-retry path of the base executor. The transfer target
 * comes only from `loadClaimContext(targetContextDirectory).context.binding` of an explicitly named second context, the
 * old proof of a resume only from the own context's recovery record. Matrix (xlo, xtr, xrs, xbd, xrt, xcp) plus
 * xrt-05, xrt-06 and xrt-07, which re-send a journalled transfer, resume and change-bounds through
 * `resendClaimIntent` and so pin that the execution list comes from transition; that base path is the retry or
 * re-send, never "resume". Local cases run on blob only, every other case on blob, tree and commit-chain against the
 * loopback daemon of claim-git-fixture.ts with the test-local S1 receive script and the S2 trace2 record. Every
 * follow-up call targets a changed root or comes from another context, so no own outstanding intent pauses it; the
 * only same-context calls at an unchanged root are the sanctioned re-sends of xrt-06 and xrt-07, which send the very
 * intent that is open and which the pause rule does not govern. Harness: adapted copies of claim-execution.test.ts and
 * claim-execution-retry.test.ts, no shared module and no fixture file. Every test starts with a positive control that
 * the typed scaffold (new actions `invalid`) cannot satisfy; table rows name the implementation they catch. Names the
 * scaffold must add are ASSUMPTION(scaffold), observations still due are [?]. claim-execution.test.ts,
 * claim-transition.test.ts and claim-git-fixture.ts stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, claimContextIO, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimExecutionResult,
	type ExecuteClaimTransitionOptions,
	executeClaimTransition,
	resendClaimIntent,
} from "../claims/execution/index.ts";
import { type ClaimIntentRecord, type ClaimOperationIntent, claimJournalIO } from "../claims/journal/index.ts";
import { queryClaimMutation } from "../claims/query/index.ts";
import type { ClaimMutationReceipt } from "../claims/resolution/index.ts";
import {
	type ActiveClaimState,
	type ClaimRightEvaluation,
	type ClaimStateV1,
	type ClaimTiming,
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
import type {
	ClaimLeaseRequest,
	ClaimTimingRequest,
	ClaimTransitionAction,
	ClaimTransitionRequest,
} from "../claims/transition/index.ts";
import { GitFixtureServer, type ReceivePhase, StallProxy } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/**
 * Bundled cases run several executions per test (claim-execution.test.ts:3361), so the bounds exceed the executor's.
 */
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 90_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout for executions that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
/** Per-Git-command timeout in lost-reply cases; every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/** Per-Git-command timeout of a push held in pre-receive on purpose (claim-execution-retry.test.ts:65). */
const HELD_SEND_TIMEOUT = 10_000;
/** Margin for any stray asynchronous accept before a zero count is read; the zero itself is the proof. */
const SETTLE_MS = 200;
/** Bound for waiting on hook entries, landings, hook drains and settling calls. */
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
const SIXTH_TICKET = "BACK-6";
/** Ticket of a leading positive control that must never share a root with the case after it. */
const CONTROL_TICKET = "BACK-9";
/** Sends allowed per call unless a case says otherwise; a healthy call must still send exactly once. */
const ATTEMPTS = 3;
/** Placeholder for a ticket ref the server does not have. */
const ABSENT_REF = "(no ref)";
/**
 * [?]: the loser of two pushes held together in pre-receive fails at the server's ref
 * update ("remote rejected", storage/index.ts:633) or at the client's lease check ("stale info", :632). Both are
 * accepted until RED/GREEN observes the cause; `unknown` or `applied` is not.
 */
const REJECTED_CAUSE = "stale-or-remote";
/** Distinctive owner names that no result or diagnostic may echo. */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const THIRD_OWNER = "agent-sentinel-lena";
/** A context directory name under the private parent that no case ever creates. */
const MISSING_CONTEXT = "00000000-0000-4000-8000-000000000000";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05", its reclaim boundary "10:15" and a hard work limit "11:00". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;

const OPERATION_KEYS = ["action", "kind", "operationId", "outcome", "rights", "scope", "sends", "storage"];
const NOT_PLANNED_KEYS = ["kind", "plan", "rights"];
const FAILURE_KEYS = ["kind", "reason"];
const EVALUATED_KEYS = ["claimGeneration", "kind", "observedRoot", "ownership", "reclaim", "scope", "workRight"];

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type FailureKind = Exclude<ClaimExecutionResult["kind"], "operation" | "not-planned" | "paused">;
type Outcome = "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
type ContextHandle = { context: ClaimContext; directory: string };
type SequenceClock = { clock: () => number; calls: () => number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type ContextSeam = typeof claimContextIO;
type JournalSeam = typeof claimJournalIO;
type Invocation = { n: number; lines: string[] };
type Receive = { from: string | null; to: string; ref: string };
type Run = { result: ClaimExecutionResult; gitCalls: number; pushes: string[][] };
type Tracked<V> = { promise: Promise<V>; settled: () => boolean };
type Racer = { repository: string; mark: number; pending: Tracked<ClaimExecutionResult> };
type Sentinels = { anywhere: string[]; inReasons: string[] };
type StoredView = { revision: number; payload: string; receipt: string | null };
type QueryView = { kind: string | null; resolution: string | null; observedRoot: string | null };
/** ASSUMPTION(scaffold): the transfer member of the extended request union. */
type TransferRequest = Extract<ClaimTransitionRequest, { action: "transfer" }>;
type TimeBox = NonNullable<TransferRequest["timeBox"]>;
/** Taken from the signature, as claim-execution-retry.test.ts:125 does, so this file names no options type. */
type ResendOptions = Parameters<typeof resendClaimIntent>[0];
type StateChanges = { claimGeneration?: number; bindingGeneration?: number; owner?: string };
/** Explicit option overrides; built field by field, never spread over the mandatory options (base type trap). */
type OptionChanges = {
	storage?: ClaimStorageOptions;
	ticket?: string;
	contextDirectory?: string;
	contextIO?: ContextSeam;
	journalIO?: JournalSeam;
	attempts?: number;
	expectedClaimGeneration?: number;
	targetContextDirectory?: string;
};
type ResendChanges = { storage?: ClaimStorageOptions; contextIO?: ContextSeam; attempts?: number };
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
/** One call that must end as a top-level failure before any network contact. */
type LocalRow = {
	label: string;
	catches: string;
	handle: ContextHandle;
	request: ClaimTransitionRequest;
	changes: OptionChanges;
	kind: FailureKind;
};
/** One malformed request, run three ways (plannable claim, stalled endpoint, corrupt payload). */
type RequestRow = { label: string; catches: string; handle: ContextHandle; changes: OptionChanges; request: unknown };
/** One leading positive control of xlo-03: an action that must apply before its malformed variants are refused. */
type ControlRow = {
	label: string;
	handle: ContextHandle;
	ticket: string;
	stored: ClaimTiming;
	request: ClaimTransitionRequest;
	changes: OptionChanges;
	next: ActiveClaimState;
	rights: (root: string) => RightsView;
};

const NOT_RUN: ClaimExecutionResult = { kind: "unavailable", reason: "the nested execution never ran" };

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

/** A fresh plain JSON copy of fixture data. */
// adapted from claim-execution.test.ts:276
function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** A copy whose `key` is an enumerable getter instead of a data property. */
// adapted from claim-execution.test.ts:288
function withAccessor<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

// adapted from claim-execution.test.ts:295
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

/** The entry at `index`, or a fixture failure (noUncheckedIndexedAccess). */
function at<V>(items: readonly V[], index: number): V {
	const item = items[index];
	if (item === undefined) throw new Error(`fixture: no entry at ${index}`);
	return item;
}

// adapted from claim-execution.test.ts:306
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution.test.ts:310
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
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

// adapted from claim-execution.test.ts:325
function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

/** O8: type, mode, inode, size, mtime and content digest of `root` and everything below it. */
// adapted from claim-execution.test.ts:334
async function snapshot(root: string) {
	const entries: { path: string; kind: string; mode: number; ino: number; size: number; mtimeMs: number }[] = [];
	const digests: Record<string, string> = {};
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		const kind = kindOf(info);
		const mode = info.mode & 0o7777;
		entries.push({ path: relative, kind, mode, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
		if (kind === "file") digests[relative] = sha256Hex(await readFile(path));
		if (kind === "dir") {
			for (const name of (await readdir(path)).sort(byCodeUnits)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return { entries, digests };
}

// adapted from claim-execution.test.ts:352
function lease(leaseEnd: number, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

// adapted from claim-execution.test.ts:356
function hard(hardEnd = H): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

/** The base claim of every case: generation 3, binding generation 1, OWNER; explicit fields instead of a spread. */
// adapted from claim-execution.test.ts:360
function active(binding: string, timing: ClaimTiming = lease(L), changes: StateChanges = {}): ActiveClaimState {
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

// adapted from claim-execution.test.ts:377
function tombstone(claimGeneration: number): ClaimStateV1 {
	return { claimState: 1, status: "free", claimGeneration };
}

/** A transfer of the base claim yields generation 4, binding generation 1, the target and OTHER_OWNER. */
function transferred(target: ContextHandle, timing: ClaimTiming): ActiveClaimState {
	return active(target.context.binding, timing, { claimGeneration: 4, bindingGeneration: 1, owner: OTHER_OWNER });
}

/** A resume keeps generation, owner and timing and raises the binding generation by one. */
function resumed(handle: ContextHandle, timing: ClaimTiming, bindingGeneration = 2): ActiveClaimState {
	return active(handle.context.binding, timing, { bindingGeneration });
}

// adapted from claim-execution.test.ts:381
function leaseRequest(): ClaimTimingRequest {
	return { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
}

// adapted from claim-execution.test.ts:389
function renew(): ClaimTransitionRequest {
	return { action: "renew", ttlMs: TTL, ttlSource: "default" };
}

// adapted from claim-execution.test.ts:393
function release(): ClaimTransitionRequest {
	return { action: "release" };
}

// adapted from claim-execution.test.ts:397
function reclaim(): ClaimTransitionRequest {
	return { action: "reclaim" };
}

function defaultLease(): ClaimLeaseRequest {
	return { ttlMs: TTL, ttlSource: "default" };
}

function explicitLease(ttlMs: number): ClaimLeaseRequest {
	return { ttlMs, ttlSource: "explicit" };
}

/** ASSUMPTION(scaffold): a time box is exactly `{action: "preserve" | "restart", source}`. */
function preserve(source: TimeBox["source"] = "explicit"): TimeBox {
	return { action: "preserve", source };
}

function restart(source: TimeBox["source"] = "explicit"): TimeBox {
	return { action: "restart", source };
}

/** ASSUMPTION(scaffold): `{action: "transfer", owner, timeBox, lease}`; no request carries a binding. */
function transfer(
	timeBox: TimeBox | null = null,
	leaseInput: ClaimLeaseRequest | null = defaultLease(),
	owner = OTHER_OWNER,
): ClaimTransitionRequest {
	return { action: "transfer", owner, timeBox, lease: leaseInput };
}

/** ASSUMPTION(scaffold): `{action: "resume"}` without further fields. */
function resume(): ClaimTransitionRequest {
	return { action: "resume" };
}

/** ASSUMPTION(scaffold): `{action: "change-bounds", timing}` with an absolute state-form timing. */
function changeBounds(timing: ClaimTiming): ClaimTransitionRequest {
	return { action: "change-bounds", timing };
}

/**
 * The reference intent, built from constants, never from the plan under test (epoch 1 of the fixture).
 * `targetBinding` is the ACTIVE successor's binding (execution/index.ts:353): the target for a transfer, the fresh
 * binding for a resume, the own binding for a bound change (step 7-8). `parameters` is the request.
 */
// adapted from claim-execution-retry.test.ts:348 (referenceIntent)
function referenceIntent(remote: string, format: ClaimStorageFormat, spec: IntentSpec): ClaimOperationIntent {
	return {
		operationId: spec.operationId,
		remote,
		format,
		epoch: 1,
		ticket: spec.ticket ?? TICKET,
		expectedRoot: spec.expectedRoot,
		targetBinding: spec.next.status === "active" ? spec.next.binding : null,
		action: spec.request.action,
		parameters: json(spec.request),
		resolved: { next: json(spec.next) },
	};
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
// adapted from claim-execution.test.ts:420
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference receipt: exactly the schema and both digests of the record. */
// adapted from claim-execution.test.ts:431
function receiptOf(record: ClaimIntentRecord): ClaimMutationReceipt {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

/** O2: the digest of the exact on-disk bytes of one final record, so no private bytes are printed. */
// adapted from claim-execution.test.ts:436
function recordFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [`${intent.operationId}.json`]: sha256Hex(`${canonicalJson(recordOf(intent))}\n`) };
}

/** O3: the stored payload is the frozen next state and the receipt belongs to the reference record. */
// adapted from claim-execution.test.ts:441
function storedView(next: ClaimStateV1, intent: ClaimOperationIntent, revision: number): StoredView {
	const receipt = receiptOf(recordOf(intent));
	return { revision, payload: sha256Hex(canonicalJson(next)), receipt: sha256Hex(canonicalJson(receipt)) };
}

/** Expected O2 of one context journal, kept in step with each case. */
// adapted from claim-execution-retry.test.ts:402 (Ledger), final records only
class Journal {
	private readonly entries: Record<string, string> = {};

	add(intent: ClaimOperationIntent): void {
		Object.assign(this.entries, recordFile(intent));
	}

	view(): Record<string, string> {
		return Object.fromEntries(Object.entries(this.entries));
	}
}

/** A receive-hook stdin line `<old> <new> <ref>`; an all-zero old ID (creation) is shown as null. */
// adapted from claim-execution.test.ts:447
function receiveOf(line: string): Receive {
	const [from = "", to = "", ref = ""] = line.split(" ");
	return { from: /^0+$/.test(from) ? null : from, to, ref };
}

/** Number of distinct push argument lists; a byte-identical retry repeats exactly one. */
// adapted from claim-execution.test.ts:453
function distinct(pushes: string[][]): number {
	return new Set(pushes.map((args) => JSON.stringify(args))).size;
}

/**
 * A clock that serves `reads` in order and counts its calls; a call beyond them throws. 0 calls after a
 * local or open failure, 1 without a send, 2 with at least one send; the target load adds none.
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

// adapted from claim-execution.test.ts:475
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

// adapted from claim-execution.test.ts:495
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

// adapted from claim-execution.test.ts:510
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

// adapted from claim-execution.test.ts:523
function planViewOf(value: unknown): PlanView {
	const boundary = field(value, "boundary");
	return {
		kind: textOf(field(value, "kind")),
		cause: textOf(field(value, "cause")),
		boundary: typeof boundary === "number" ? boundary : null,
	};
}

/**
 * The verdict view of one result. `anywhere` values (secrets, bindings, recovery bindings, paths, endpoint, owners)
 * may appear nowhere in the result; `inReasons` values (operation IDs, roots) may appear in no reason at any depth.
 */
// adapted from claim-execution.test.ts:537
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
		sends: typeof sends === "number" ? sends : null,
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
		echoed,
	};
}

/**
 * An `operation` result with exactly the executor keys and the scope marker; `action` grows by the three new actions.
 */
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
		sends: null,
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
}

/** `applied` carries the root only, never the written document. */
// adapted from claim-execution.test.ts:630
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

/** Stale and remote rejections carry exactly kind and cause: no root, document, owner or binding. */
// adapted from claim-execution.test.ts:644, cause widened to REJECTED_CAUSE
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

// adapted from claim-execution.test.ts:657
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

function appliedView(
	label: string,
	action: ClaimTransitionAction,
	operationId: string,
	root: string,
	rights: RightsView,
): ExecutionView {
	return operationView(label, {
		action,
		operationId,
		storage: appliedStorage(root),
		outcome: "applied",
		rights,
		sends: 1,
	});
}

function staleView(
	label: string,
	action: ClaimTransitionAction,
	operationId: string,
	rights: RightsView,
): ExecutionView {
	return operationView(label, {
		action,
		operationId,
		storage: rejectedStorage("stale"),
		outcome: "rejected",
		rights,
		sends: 1,
	});
}

/** Folds the two accepted causes of a concurrently declined push into REJECTED_CAUSE [?]; every other value stays. */
// adapted from claim-execution-retry.test.ts:657 (normalizedAfter)
function normalizedCause(view: ExecutionView): ExecutionView {
	const cause = view.storage?.cause ?? null;
	if (view.storage === null || view.storage.kind !== "rejected" || (cause !== "stale" && cause !== "remote")) {
		return view;
	}
	return { ...view, storage: { ...view.storage, cause: REJECTED_CAUSE } };
}

// adapted from claim-execution.test.ts:688
function live(renewalDue: boolean | null): WorkRight {
	return { kind: "live", renewalDue };
}

// adapted from claim-execution.test.ts:692
function noRight(cause: Extract<WorkRight, { kind: "none" }>["cause"]): WorkRight {
	return { kind: "none", cause };
}

// adapted from claim-execution.test.ts:696
function notYet(boundary: number): Reclaim {
	return { kind: "not-yet", boundary };
}

function eligible(boundary: number): Reclaim {
	return { kind: "eligible", boundary };
}

const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

// adapted from claim-execution.test.ts:702
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

// adapted from claim-execution.test.ts:720
function heldRights(root: string, reclaimState: Reclaim, workRight: WorkRight = live(false), generation = 3) {
	return evaluatedRights("held", workRight, reclaimState, root, generation);
}

// adapted from claim-execution.test.ts:724
function foreignRights(root: string, reclaimState: Reclaim, generation = 3): RightsView {
	return evaluatedRights("foreign", noRight("not-holder"), reclaimState, root, generation);
}

// adapted from claim-execution.test.ts:728
function freeRights(root: string, generation = 3): RightsView {
	return evaluatedRights("free", noRight("free"), NOT_APPLICABLE, root, generation);
}

// adapted from claim-execution.test.ts:746
function rejectedPlan(cause: string, boundary: number | null = null): PlanView {
	return { kind: "rejected", cause, boundary };
}

/** Context IO that fails the `lstat` of exactly `target` with EIO; everything else is real. */
// adapted from claim-execution.test.ts:756
function failingContextLstat(target: string): ContextSeam {
	const lstatTarget = async (...args: Parameters<ContextSeam["lstat"]>) => {
		if (String(args[0]) === target) {
			throw Object.assign(new Error("injected context lstat failure"), { code: "EIO" });
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatTarget as unknown as ContextSeam["lstat"] };
}

/** Context IO that records the path of every `lstat` and `open` it serves; everything else is real. */
function recordingContextIO(touched: string[]): ContextSeam {
	const lstatPath = async (...args: Parameters<ContextSeam["lstat"]>) => {
		touched.push(String(args[0]));
		return claimContextIO.lstat(...args);
	};
	const openPath = async (...args: Parameters<ContextSeam["open"]>) => {
		touched.push(String(args[0]));
		return claimContextIO.open(...args);
	};
	return {
		...claimContextIO,
		lstat: lstatPath as unknown as ContextSeam["lstat"],
		open: openPath as unknown as ContextSeam["open"],
	};
}

/** Journal IO that runs `action` once, right after the first `link` of `prepare`: between plan and first send. */
// adapted from claim-execution.test.ts:818
function afterLink(action: () => Promise<void>): JournalSeam {
	const state = { fired: false };
	const linkThenAct = async (...args: Parameters<JournalSeam["link"]>) => {
		await claimJournalIO.link(...args);
		if (state.fired) return;
		state.fired = true;
		await action();
	};
	return { ...claimJournalIO, link: linkThenAct as unknown as JournalSeam["link"] };
}

// adapted from claim-execution-retry.test.ts:716
function tracked<V>(promise: Promise<V>): Tracked<V> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-execution-retry.test.ts:727
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
// adapted from claim-execution-retry.test.ts:743
async function settleWithin<V>(label: string, pending: Tracked<V>): Promise<V> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** Polls `condition` until it holds; fails after EVENT_TIMEOUT. */
// adapted from claim-execution-retry.test.ts:753
async function waitUntil(label: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * S2, test-local: every trace2 `start` argv of `git -C <repository> ...`, without that prefix. Product Git inherits
 * GIT_TRACE2_EVENT; the fixture's own Git keeps the environment it copied at start and stays untraced.
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

/** The S1 hook script: numbers each invocation atomically (mkdir), logs its stdin, then passes, rejects or holds. */
// adapted from claim-execution-retry.test.ts:792
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
// adapted from claim-execution-retry.test.ts:818 (ReceiveScript)
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

/** One server repository with S1 hooks, the executor's client, independent clients, contexts and the S2 trace. */
// adapted from claim-execution.test.ts:1033-1316 (ExecutionCase) and claim-execution-retry.test.ts:1057-1205
// (resendOptions, resend, startResend, settle, releaseHeld); new: rightsOf (O9) and query
class AdministrationCase {
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
	private readonly cleanups: (() => Promise<void>)[] = [];
	/** Operation IDs handed to a call; no reason may echo them. */
	private readonly guarded = new Set<string>();
	private readonly secrets = new Map<string, string>();
	private readonly pendings: Tracked<ClaimExecutionResult>[] = [];
	private previousTrace: string | undefined;
	private tracing = false;
	private writerStore: ClaimStore | undefined;
	private readerStore: ClaimStore | undefined;
	private observer: string | undefined;
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

	static async create(format: ClaimStorageFormat, caseName: string): Promise<AdministrationCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-execution-administration-"));
		try {
			const { name, repo } = await server().initRepository(root, `administration-${format}-${caseName}`);
			const primary = await AdministrationCase.initClient(join(root, "client-executor"));
			const created = new AdministrationCase(format, root, server().url(name), repo, primary);
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

	// adapted from claim-execution.test.ts:1093
	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An independent client repository; objects it writes are not in the executor's repository. */
	async client(label: string): Promise<string> {
		return AdministrationCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, timeoutMs = ADAPTER_TIMEOUT, remote = this.url): ClaimStorageOptions {
		return { repository, remote, format: this.format, timeoutMs };
	}

	private async store(repository: string): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.storage(repository)), "open").store;
	}

	/** Creates a context through the API below the private parent, optionally recovering from `recoverFrom`. */
	// adapted from claim-execution.test.ts:1115
	async context(recoverFrom?: string): Promise<ContextHandle> {
		const created = await createClaimContext(
			recoverFrom === undefined ? { parent: this.parent } : { parent: this.parent, recoverFrom },
		);
		const context = expectKind(created, "created").context;
		return { context, directory: dirname(context.journalDirectory) };
	}

	/** Reads the private secret directly (cached); only tests may do this, and only to prove it is never echoed. */
	// adapted from claim-execution.test.ts:1125
	private async secretOf(handle: ContextHandle): Promise<string> {
		const cached = this.secrets.get(handle.directory);
		if (cached !== undefined) return cached;
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		this.secrets.set(handle.directory, secret);
		return secret;
	}

	// adapted from claim-execution.test.ts:1135, recovery bindings of every handle included
	async view(label: string, result: unknown, handles: ContextHandle[], extra: string[] = []): Promise<ExecutionView> {
		const anywhere = [this.root, this.parent, this.url, OWNER, OTHER_OWNER, THIRD_OWNER, ...extra];
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

	/** Executor options, built field by field from explicit overrides. */
	// adapted from claim-execution.test.ts:1158
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
			contextDirectory: changes.contextDirectory ?? handle.directory,
			operationId,
			request,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: changes.attempts ?? ATTEMPTS,
		};
		if (changes.contextIO !== undefined) options.contextIO = changes.contextIO;
		if (changes.journalIO !== undefined) options.journalIO = changes.journalIO;
		if (changes.expectedClaimGeneration !== undefined) {
			options.expectedClaimGeneration = changes.expectedClaimGeneration;
		}
		// ASSUMPTION(scaffold): the executor option `targetContextDirectory?: string`.
		if (changes.targetContextDirectory !== undefined) {
			options.targetContextDirectory = changes.targetContextDirectory;
		}
		return options;
	}

	/** No ticket, request, plan or target; the record under `operationId` in the context's journal decides. */
	// adapted from claim-execution-retry.test.ts:1057
	resendOptions(
		handle: ContextHandle,
		operationId: string,
		clock: SequenceClock,
		changes: ResendChanges = {},
	): ResendOptions {
		this.guarded.add(operationId);
		const options: ResendOptions = {
			storage: changes.storage ?? this.storage(),
			contextDirectory: handle.directory,
			operationId,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: changes.attempts ?? ATTEMPTS,
		};
		if (changes.contextIO !== undefined) options.contextIO = changes.contextIO;
		return options;
	}

	intent(spec: IntentSpec): ClaimOperationIntent {
		return referenceIntent(this.url, this.format, spec);
	}

	/** Writes one change through the independent writer client and returns the applied root. */
	// adapted from claim-execution.test.ts:1187
	async writeChange(ticket: string, change: ClaimChange): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		const base = await this.writerStore.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		return expectKind(await this.writerStore.write(base, change), "applied").root;
	}

	/** Writes a claim state as an independent writer (revision 1 on an absent ticket). */
	// adapted from claim-execution.test.ts:1194
	async writeState(payload: JsonObject, ticket = TICKET): Promise<string> {
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return this.writeChange(ticket, { operationId, receipt, payload });
	}

	/** O3 through an independent reader client. */
	// adapted from claim-execution.test.ts:1202
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
	// adapted from claim-execution.test.ts:1215
	async records(handle: ContextHandle): Promise<Record<string, string>> {
		const records: Record<string, string> = {};
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			records[name] = sha256Hex(await readFile(join(handle.context.journalDirectory, name)));
		}
		return records;
	}

	/** O9: the rights view of `handle` at `now` through an independent observer client (rights/index.ts:294-378). */
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

	/** The query of one journalled operation of `handle` (query/index.ts:24). */
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

	/** O1. */
	// adapted from claim-execution.test.ts:1226
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
	// adapted from claim-execution-retry.test.ts:1182 (startResend)
	async start(options: ExecuteClaimTransitionOptions, repository: string): Promise<Racer> {
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
	// adapted from claim-execution-retry.test.ts:1195-1205
	async releaseHeld(phase: ReceivePhase, since: number, count: number): Promise<void> {
		for (let n = since + 1; n <= since + count; n++) {
			await this.hooks.release(phase, n);
			await waitUntil(`receive ${phase}-${n} to finish`, () => this.hooks.hasFinished(phase, n));
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

	/** Releases every hold, settles every started call, closes proxies, restores the trace and removes the root. */
	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
			await Promise.all(this.pendings.map((pending) => settleWithin("pending call", pending).catch(() => undefined)));
			for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-execution-retry.test.ts:1234
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: AdministrationCase) => Promise<void>,
): Promise<void> {
	const fixture = await AdministrationCase.create(format, caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

/**
 * Runs each row as a not-planned call and checks the rights evaluation of its planning read, no push, one clock read,
 * the ticket root and the calling context's journal unchanged (O1, O2, O4, O6). A not-planned call prepares no intent
 * (execution/index.ts:462-463 returns before :500), so the next row at the same root is never paused.
 */
async function expectRefusals(fixture: AdministrationCase, handles: ContextHandle[], rows: RefusalRow[]) {
	for (const row of rows) {
		const ticket = row.changes.ticket ?? TICKET;
		const root = await fixture.ticketRoot(ticket);
		const journal = await fixture.records(row.handle);
		const clock = sequenceClock(row.now, row.now);
		const run = await fixture.run(fixture.options(row.handle, row.operationId, row.request, clock, row.changes));
		const label = `${row.label} (catches: ${row.catches})`;
		await fixture.expectView(run.result, notPlannedView(label, row.plan, row.rights), handles);
		expect({
			label,
			pushes: run.pushes.length,
			clockCalls: clock.calls(),
			root: await fixture.ticketRoot(ticket),
			journal: await fixture.records(row.handle),
		}).toEqual({ label, pushes: 0, clockCalls: 1, root, journal });
	}
}

describe("claim administration execution before the network (blob)", () => {
	test(
		"xlo-01: takes the transfer target only from a loaded second context and checks it before any network contact",
		async () => {
			await withCase("blob", "xlo-01", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const replacement = await fixture.context(karl.directory);
				const broken = await fixture.context();
				await chmod(join(broken.directory, "context.json"), 0o644);
				const missing = join(fixture.parent, MISSING_CONTEXT);
				const handles = [karl, franz, replacement, broken];
				const base = await fixture.writeState(active(karl.context.binding));
				const targetBefore = await snapshot(franz.directory);

				// Positive control (catches: a scaffold without transfer, a target binding from anywhere but the loaded
				// second context, S2 not recording the executor's Git): KARL's pure lease moves to FRANZ with one push.
				const controlClock = sequenceClock(T, T);
				const controlOptions = fixture.options(karl, "op-xlo-01-control", transfer(), controlClock, {
					targetContextDirectory: franz.directory,
				});
				const control = await fixture.run(controlOptions);
				const root = await fixture.ticketRoot(TICKET);
				const moved = foreignRights(root, notYet(T + TTL + GRACE), 4);
				const controlView = appliedView("xlo-01 positive control", "transfer", "op-xlo-01-control", root, moved);
				await fixture.expectView(control.result, controlView, handles, [missing]);
				const next = transferred(franz, lease(T + TTL));
				const intent = fixture.intent({
					operationId: "op-xlo-01-control",
					expectedRoot: base,
					request: transfer(),
					next,
				});
				// O8 [?] (catches: the target's journal or record touched): loading syncs but never writes
				// (context/index.ts:182-197), so the target snapshot stays byte- and inode-identical.
				expect({
					records: await fixture.records(karl),
					targetRecords: await fixture.records(franz),
					target: await snapshot(franz.directory),
					stored: await fixture.stored(TICKET, "op-xlo-01-control"),
					gitCallsSeen: control.gitCalls > 0,
					pushes: control.pushes.length,
					clockCalls: controlClock.calls(),
				}).toEqual({
					records: recordFile(intent),
					targetRecords: {},
					target: targetBefore,
					stored: storedView(next, intent, 2),
					gitCallsSeen: true,
					pushes: 1,
					clockCalls: 2,
				});

				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, STALL_TIMEOUT, stalledUrl);
				const refsBefore = await fixture.serverRefs();
				const contextsBefore = await snapshot(fixture.parent);
				const journal = await fixture.records(karl);
				const clock = sequenceClock();
				const target = franz.directory;
				const targetRecord = join(target, "context.json");
				// Every row ends before the journal, the store and the clock.
				const rows: LocalRow[] = [
					{
						label: "transfer without a target context",
						catches: "a transfer without a native target binding",
						handle: karl,
						request: transfer(),
						changes: {},
						kind: "invalid",
					},
					{
						label: "target context on a renew",
						catches: "the target option accepted outside transfer",
						handle: karl,
						request: renew(),
						changes: { targetContextDirectory: target },
						kind: "invalid",
					},
					{
						label: "target context on a resume",
						catches: "the target option read as a resume input",
						handle: replacement,
						request: resume(),
						changes: { targetContextDirectory: target },
						kind: "invalid",
					},
					{
						label: "target context on a change-bounds",
						catches: "the target option accepted outside transfer",
						handle: karl,
						request: changeBounds(lease(L - MINUTE)),
						changes: { targetContextDirectory: target },
						kind: "invalid",
					},
					{
						label: "relative target context",
						catches: "an implicitly resolved target",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: "ctx" },
						kind: "invalid",
					},
					{
						label: "target context that is not a string",
						catches: "a coerced target path",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: 42 as unknown as string },
						kind: "invalid",
					},
					{
						label: "own context as target",
						catches: "a self-transfer that bumps the generation and keeps the claim",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: karl.directory },
						kind: "invalid",
					},
					{
						label: "missing target context",
						catches: "an implicitly created target",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: missing },
						kind: "invalid",
					},
					{
						label: "corrupt target context",
						catches: "a target binding from an unvalidated record",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: broken.directory },
						kind: "corrupt",
					},
					{
						// ASSUMPTION(executor): the target loads through the same contextIO seam.
						label: "target context lstat EIO",
						catches: "an IO failure read as a missing target, a target load outside the context seam",
						handle: karl,
						request: transfer(),
						changes: { targetContextDirectory: target, contextIO: failingContextLstat(targetRecord) },
						kind: "unavailable",
					},
					{
						label: "own context corrupt, target unreadable",
						catches: "the target loaded before the own context",
						handle: karl,
						request: transfer(),
						changes: {
							contextDirectory: broken.directory,
							targetContextDirectory: target,
							contextIO: failingContextLstat(targetRecord),
						},
						kind: "corrupt",
					},
					{
						label: "own context missing, target corrupt",
						catches: "the target's failure kind reported for the own context",
						handle: karl,
						request: transfer(),
						changes: { contextDirectory: missing, targetContextDirectory: broken.directory },
						kind: "invalid",
					},
					{
						label: "request with a targetBinding field",
						catches: "a target binding taken from a caller string",
						handle: karl,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: defaultLease(),
							targetBinding: franz.context.binding,
						} as unknown as ClaimTransitionRequest,
						changes: { targetContextDirectory: target },
						kind: "invalid",
					},
				];
				for (const [index, row] of rows.entries()) {
					const operationId = `op-xlo-01-${index + 1}`;
					const changes: OptionChanges = { ...row.changes, storage: stalled };
					const run = await fixture.run(fixture.options(row.handle, operationId, row.request, clock, changes));
					const expected = failureView(`xlo-01 ${row.label} (catches: ${row.catches})`, row.kind);
					await fixture.expectView(run.result, expected, handles, [stalledUrl, missing]);
					expect({ label: row.label, gitCalls: run.gitCalls }).toEqual({ label: row.label, gitCalls: 0 });
				}
				await Bun.sleep(SETTLE_MS);
				// O7 = 0, O6 = 0, O1 and O2 unchanged, O8 over every context (catches: network before local checks).
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					contexts: await snapshot(fixture.parent),
					journal: await fixture.records(karl),
					targetJournal: await fixture.records(franz),
					missingCreated: await exists(missing),
				}).toEqual({
					connections: 0,
					clockCalls: 0,
					refs: refsBefore,
					contexts: contextsBefore,
					journal,
					targetJournal: {},
					missingCreated: false,
				});

				// Positive control at the end: the same valid transfer reaches the stalled listener, still without a clock.
				const stalledOptions = fixture.options(karl, "op-xlo-01-stalled", transfer(), clock, {
					storage: stalled,
					targetContextDirectory: target,
				});
				const stalledRun = await fixture.run(stalledOptions);
				const stalledView = failureView("xlo-01 stalled endpoint", "unknown");
				await fixture.expectView(stalledRun.result, stalledView, handles, [stalledUrl, missing]);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"xlo-02: refuses a resume without a recovery proof as invalid before any network contact",
		async () => {
			await withCase("blob", "xlo-02", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const replacement = await fixture.context(karl.directory);
				const handles = [karl, franz, replacement];
				const base = await fixture.writeState(active(karl.context.binding));

				// Positive control (catches: a scaffold without resume, the recovery binding stored as successor): the
				// replacement of KARL resumes the lease with its fresh binding.
				const controlClock = sequenceClock(T, T);
				const control = await fixture.run(fixture.options(replacement, "op-xlo-02-control", resume(), controlClock));
				const root = await fixture.ticketRoot(TICKET);
				const held = heldRights(root, notYet(R));
				await fixture.expectView(
					control.result,
					appliedView("xlo-02 positive control", "resume", "op-xlo-02-control", root, held),
					handles,
				);
				const next = resumed(replacement, lease(L));
				const intent = fixture.intent({
					operationId: "op-xlo-02-control",
					expectedRoot: base,
					request: resume(),
					next,
				});
				expect({
					records: await fixture.records(replacement),
					stored: await fixture.stored(TICKET, "op-xlo-02-control"),
					pushes: control.pushes.length,
					clockCalls: controlClock.calls(),
				}).toEqual({ records: recordFile(intent), stored: storedView(next, intent, 2), pushes: 1, clockCalls: 2 });

				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, STALL_TIMEOUT, stalledUrl);
				const refsBefore = await fixture.serverRefs();
				const clock = sequenceClock();
				// `recovery === null` is a top-level invalid before the journal.
				const rows: LocalRow[] = [
					{
						label: "resume in the source context itself",
						catches: "the caller binding taken as its own old proof",
						handle: karl,
						request: resume(),
						changes: {},
						kind: "invalid",
					},
					{
						label: "resume in an unrelated context",
						catches: "a resume without an old proof, planned as not-holder after a network read",
						handle: franz,
						request: resume(),
						changes: {},
						kind: "invalid",
					},
				];
				const settings: { where: string; changes: OptionChanges }[] = [
					{ where: "the healthy endpoint", changes: {} },
					{ where: "a stalled endpoint", changes: { storage: stalled } },
				];
				for (const [index, row] of rows.entries()) {
					for (const [position, setting] of settings.entries()) {
						const operationId = `op-xlo-02-${index + 1}-${position + 1}`;
						const changes: OptionChanges = { ...row.changes, ...setting.changes };
						const run = await fixture.run(fixture.options(row.handle, operationId, row.request, clock, changes));
						const label = `xlo-02 ${row.label} at ${setting.where} (catches: ${row.catches})`;
						await fixture.expectView(run.result, failureView(label, row.kind), handles, [stalledUrl]);
						expect({ label, gitCalls: run.gitCalls }).toEqual({ label, gitCalls: 0 });
					}
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					karlRecords: await fixture.records(karl),
					franzRecords: await fixture.records(franz),
				}).toEqual({ connections: 0, clockCalls: 0, refs: refsBefore, karlRecords: {}, franzRecords: {} });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"xlo-03: refuses every malformed transfer, resume and change-bounds request before any IO, three ways",
		async () => {
			await withCase("blob", "xlo-03", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const replacement = await fixture.context(karl.directory);
				const handles = [karl, franz, replacement];
				const toFranz: OptionChanges = { targetContextDirectory: franz.directory };

				// Positive control (catches: a scaffold that refuses a new action outright, so that each row below would
				// only meet the unknown-action refusal): each of the three actions applies once on its own ticket.
				const controls: ControlRow[] = [
					{
						label: "transfer",
						handle: karl,
						ticket: FOURTH_TICKET,
						stored: lease(L),
						request: transfer(),
						changes: { ticket: FOURTH_TICKET, targetContextDirectory: franz.directory },
						next: transferred(franz, lease(T + TTL)),
						rights: (root) => foreignRights(root, notYet(T + TTL + GRACE), 4),
					},
					{
						label: "resume",
						handle: replacement,
						ticket: FIFTH_TICKET,
						stored: lease(L),
						request: resume(),
						changes: { ticket: FIFTH_TICKET },
						next: resumed(replacement, lease(L)),
						rights: (root) => heldRights(root, notYet(R)),
					},
					{
						label: "change-bounds",
						handle: karl,
						ticket: SIXTH_TICKET,
						stored: hard(),
						request: changeBounds(hard(H - 30 * MINUTE)),
						changes: { ticket: SIXTH_TICKET },
						next: active(karl.context.binding, hard(H - 30 * MINUTE)),
						rights: (root) => heldRights(root, notYet(H - 30 * MINUTE + GRACE), live(null)),
					},
				];
				for (const control of controls) {
					const operationId = `op-xlo-03-control-${control.label}`;
					const base = await fixture.writeState(active(karl.context.binding, control.stored), control.ticket);
					const clock = sequenceClock(T, T);
					const run = await fixture.run(
						fixture.options(control.handle, operationId, control.request, clock, control.changes),
					);
					const root = await fixture.ticketRoot(control.ticket);
					const label = `xlo-03 positive control ${control.label}`;
					const action = control.request.action;
					const expected = appliedView(label, action, operationId, root, control.rights(root));
					await fixture.expectView(run.result, expected, handles);
					const intent = fixture.intent({
						operationId,
						ticket: control.ticket,
						expectedRoot: base,
						request: control.request,
						next: control.next,
					});
					expect({ label, stored: await fixture.stored(control.ticket, operationId) }).toEqual({
						label,
						stored: storedView(control.next, intent, 2),
					});
				}

				await fixture.writeState(active(karl.context.binding));
				await fixture.writeState({ state: "claimed", holder: OWNER }, SECOND_TICKET);
				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, STALL_TIMEOUT, stalledUrl);
				const refsBefore = await fixture.serverRefs();
				const contextsBefore = await snapshot(fixture.parent);
				const clock = sequenceClock();
				class TransferInstance {
					action = "transfer";
					owner = OTHER_OWNER;
					timeBox = null;
					lease = defaultLease();
				}
				const hardBounds = { action: "change-bounds", timing: hard() };
				// inp-01 to inp-03: the executor has no second, laxer parser (step 0).
				const rows: RequestRow[] = [
					{
						label: "transfer without timeBox",
						catches: "a missing time box read as null",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", owner: OTHER_OWNER, lease: defaultLease() },
					},
					{
						label: "transfer without lease",
						catches: "a missing lease read as null",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", owner: OTHER_OWNER, timeBox: null },
					},
					{
						label: "transfer without owner",
						catches: "the source owner silently kept",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", timeBox: null, lease: defaultLease() },
					},
					{
						label: "empty owner",
						catches: "an empty display name stored",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", owner: "", timeBox: null, lease: defaultLease() },
					},
					{
						label: "numeric owner",
						catches: "a coerced owner",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", owner: 42, timeBox: null, lease: defaultLease() },
					},
					{
						label: "time box as a string",
						catches: "a shorthand time box",
						handle: karl,
						changes: toFranz,
						request: { action: "transfer", owner: OTHER_OWNER, timeBox: "preserve", lease: defaultLease() },
					},
					{
						label: "unknown time-box action",
						catches: "a lax action set",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: { action: "keep", source: "explicit" },
							lease: defaultLease(),
						},
					},
					{
						label: "unknown time-box source",
						catches: "a lax source set",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: { action: "preserve", source: "config" },
							lease: defaultLease(),
						},
					},
					{
						label: "time box with an extra field",
						catches: "a lax time-box shape",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: { action: "preserve", source: "explicit", until: H },
							lease: defaultLease(),
						},
					},
					{
						label: "lease TTL zero",
						catches: "a default TTL substituted",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: { ttlMs: 0, ttlSource: "default" },
						},
					},
					{
						label: "lease TTL as a string",
						catches: "a coerced TTL",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: { ttlMs: "auto", ttlSource: "default" },
						},
					},
					{
						label: "lease with an extra field",
						catches: "a lax lease shape",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: { ttlMs: TTL, ttlSource: "default", graceMs: GRACE },
						},
					},
					{
						label: "request with a binding field",
						catches: "a caller binding smuggled in through the request",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: defaultLease(),
							binding: karl.context.binding,
						},
					},
					{
						label: "lease accessor",
						catches: "a getter read after the first await",
						handle: karl,
						changes: toFranz,
						request: {
							action: "transfer",
							owner: OTHER_OWNER,
							timeBox: null,
							lease: withAccessor(defaultLease(), "ttlMs", TTL),
						},
					},
					{
						label: "transfer class instance",
						catches: "non-plain data accepted",
						handle: karl,
						changes: toFranz,
						request: new TransferInstance(),
					},
					{
						label: "resume with an owner",
						catches: "extra fields on resume",
						handle: replacement,
						changes: {},
						request: { action: "resume", owner: OWNER },
					},
					{
						label: "resume with a binding",
						catches: "the old proof taken from the request",
						handle: replacement,
						changes: {},
						request: { action: "resume", binding: karl.context.binding },
					},
					{
						label: "resume with a timing",
						catches: "a resume that renews the window",
						handle: replacement,
						changes: {},
						request: { action: "resume", timing: hard() },
					},
					{
						label: "bounds in acquire form",
						catches: "a second, laxer timing parser",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: leaseRequest() },
					},
					{
						label: "lease end after the hard end",
						catches: "L > H accepted",
						handle: karl,
						changes: {},
						request: {
							action: "change-bounds",
							timing: { mode: "lease", leaseEnd: H + 1, graceMs: GRACE, hardEnd: H },
						},
					},
					{
						label: "lease without a hardEnd field",
						catches: "a missing hard end read as null",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: { mode: "lease", leaseEnd: L, graceMs: GRACE } },
					},
					{
						label: "hard with a leaseEnd field",
						catches: "a lax hard shape",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: { mode: "hard", hardEnd: H, graceMs: GRACE, leaseEnd: L } },
					},
					{
						label: "unknown mode",
						catches: "a mode outside lease, hard and none",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: { mode: "soft", hardEnd: H, graceMs: GRACE } },
					},
					{
						label: "negative hard end",
						catches: "a negative instant",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: { mode: "hard", hardEnd: -1, graceMs: GRACE } },
					},
					{
						label: "fractional grace",
						catches: "a non-integer duration",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: { mode: "hard", hardEnd: H, graceMs: 0.5 } },
					},
					{
						label: "hard end plus grace overflows",
						catches: "an unsafe reclaim boundary",
						handle: karl,
						changes: {},
						request: {
							action: "change-bounds",
							timing: { mode: "hard", hardEnd: Number.MAX_SAFE_INTEGER, graceMs: 1 },
						},
					},
					{
						label: "null timing",
						catches: "a missing target timing read as no change",
						handle: karl,
						changes: {},
						request: { action: "change-bounds", timing: null },
					},
					{
						label: "missing timing",
						catches: "a missing target timing read as no change",
						handle: karl,
						changes: {},
						request: { action: "change-bounds" },
					},
					{
						label: "timing accessor",
						catches: "a getter read after the first await",
						handle: karl,
						changes: {},
						request: withAccessor(hardBounds, "timing", hard()),
					},
				];
				const settings: { where: string; changes: OptionChanges }[] = [
					{ where: "a plannable claim", changes: {} },
					{ where: "a stalled endpoint", changes: { storage: stalled } },
					{ where: "a corrupt payload", changes: { ticket: SECOND_TICKET } },
				];
				for (const [index, row] of rows.entries()) {
					for (const [position, setting] of settings.entries()) {
						const operationId = `op-xlo-03-${index + 1}-${position + 1}`;
						const changes: OptionChanges = { ...row.changes, ...setting.changes };
						const request = row.request as ClaimTransitionRequest;
						const run = await fixture.run(fixture.options(row.handle, operationId, request, clock, changes));
						const label = `xlo-03 ${row.label} on ${setting.where} (catches: ${row.catches})`;
						await fixture.expectView(run.result, failureView(label, "invalid"), handles, [stalledUrl]);
						expect({ label, gitCalls: run.gitCalls }).toEqual({ label, gitCalls: 0 });
					}
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					contexts: await snapshot(fixture.parent),
				}).toEqual({ connections: 0, clockCalls: 0, refs: refsBefore, contexts: contextsBefore });

				// Positive control at the end: a valid transfer reaches the stalled listener, still without a clock.
				const stalledOptions = fixture.options(karl, "op-xlo-03-stalled", transfer(), clock, {
					storage: stalled,
					targetContextDirectory: franz.directory,
				});
				const stalledRun = await fixture.run(stalledOptions);
				const stalledView = failureView("xlo-03 stalled endpoint", "unknown");
				await fixture.expectView(stalledRun.result, stalledView, handles, [stalledUrl]);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"xlo-04: captures the target directory and the nested time box and lease before the first await",
		async () => {
			await withCase("blob", "xlo-04", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const handles = [karl, franz, lena];
				const karlJournal = new Journal();
				const request0 = transfer(preserve(), defaultLease());

				// Positive control (catches: a scaffold without transfer): the same transfer, never mutated, applies on
				// SECOND_TICKET; the mutated call below must end exactly like it.
				const controlBase = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
				const controlClock = sequenceClock(T, T);
				const control = await fixture.run(
					fixture.options(karl, "op-xlo-04-control", request0, controlClock, {
						ticket: SECOND_TICKET,
						targetContextDirectory: franz.directory,
					}),
				);
				const controlRoot = await fixture.ticketRoot(SECOND_TICKET);
				const controlRights = foreignRights(controlRoot, notYet(T + TTL + GRACE), 4);
				await fixture.expectView(
					control.result,
					appliedView("xlo-04 positive control", "transfer", "op-xlo-04-control", controlRoot, controlRights),
					handles,
				);
				const next = transferred(franz, lease(T + TTL));
				karlJournal.add(
					fixture.intent({
						operationId: "op-xlo-04-control",
						ticket: SECOND_TICKET,
						expectedRoot: controlBase,
						request: request0,
						next,
					}),
				);

				// The case: every caller-owned entry, including the nested time box and lease, changes right after the call.
				const base = await fixture.writeState(active(karl.context.binding));
				const stall = await fixture.stallProxy();
				const other = await fixture.client("other");
				const storage = fixture.storage();
				const timeBox = { action: "preserve" as TimeBox["action"], source: "explicit" as TimeBox["source"] };
				const leaseInput = { ttlMs: TTL, ttlSource: "default" as ClaimLeaseRequest["ttlSource"] };
				const request = { action: "transfer" as const, owner: OTHER_OWNER, timeBox, lease: leaseInput };
				const original = sequenceClock(T, T);
				const replacementClock = sequenceClock(H, H);
				const options = fixture.options(karl, "op-xlo-04", request, original, {
					storage,
					targetContextDirectory: franz.directory,
				});
				const mark = await fixture.mark();
				const pending = executeClaimTransition(options);
				options.targetContextDirectory = lena.directory;
				timeBox.action = "restart";
				timeBox.source = "policy";
				leaseInput.ttlMs = 30 * MINUTE;
				leaseInput.ttlSource = "explicit";
				request.owner = THIRD_OWNER;
				options.request = resume();
				options.contextDirectory = lena.directory;
				options.clock = replacementClock.clock;
				options.attempts = 0;
				storage.remote = `git://127.0.0.1:${stall.port}/redirected.git`;
				storage.repository = other;
				storage.timeoutMs = 1;
				const run = await fixture.finish(pending, mark);
				const root = await fixture.ticketRoot(TICKET);
				const rights = foreignRights(root, notYet(T + TTL + GRACE), 4);
				// catches: target, time box, lease, owner or clock read after the first await.
				await fixture.expectView(
					run.result,
					appliedView("xlo-04 mutated after the call", "transfer", "op-xlo-04", root, rights),
					handles,
				);
				const intent = fixture.intent({ operationId: "op-xlo-04", expectedRoot: base, request: request0, next });
				karlJournal.add(intent);
				await Bun.sleep(SETTLE_MS);
				const controlStored = await fixture.stored(SECOND_TICKET, "op-xlo-04-control");
				const caseStored = await fixture.stored(TICKET, "op-xlo-04");
				expect({
					connections: stall.acceptedConnections,
					originalClockCalls: original.calls(),
					replacementClockCalls: replacementClock.calls(),
					records: await fixture.records(karl),
					lenaRecords: await fixture.records(lena),
					stored: caseStored,
					sameSuccessorAsControl: caseStored.payload === controlStored.payload,
					pushes: run.pushes.length,
				}).toEqual({
					connections: 0,
					originalClockCalls: 2,
					replacementClockCalls: 0,
					records: karlJournal.view(),
					lenaRecords: {},
					stored: storedView(next, intent, 2),
					sameSuccessorAsControl: true,
					pushes: 1,
				});
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim administration execution over real Git (${format})`, () => {
		test(
			"xtr-01 xtr-02: transfers a lease in one CAS and refuses a hard deadline without an explicit time box",
			async () => {
				await withCase(format, "xtr-a", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const lena = await fixture.context();
					const handles = [karl, franz, lena];
					const karlJournal = new Journal();
					const toFranz = (ticket: string): OptionChanges => ({ ticket, targetContextDirectory: franz.directory });

					// xtr-01 Positive control (catches: a transfer as release plus acquire, the source keeping
					// the right, rights taken from the write result): KARL's pure lease moves to FRANZ at T in one push.
					const base = await fixture.writeState(active(karl.context.binding));
					const clock = sequenceClock(T, T);
					const run = await fixture.run(fixture.options(karl, "op-xtr-01", transfer(), clock, toFranz(TICKET)));
					const root = await fixture.ticketRoot(TICKET);
					const moved = foreignRights(root, notYet(T + TTL + GRACE), 4);
					await fixture.expectView(
						run.result,
						appliedView("xtr-01 transfer of a pure lease at T", "transfer", "op-xtr-01", root, moved),
						handles,
					);
					const next = transferred(franz, lease(T + TTL));
					const intent = fixture.intent({ operationId: "op-xtr-01", expectedRoot: base, request: transfer(), next });
					karlJournal.add(intent);
					// O2 is the reference record (action "transfer", parameters without a binding, targetBinding FRANZ); O3
					// revision base + 1 is one CAS from ACTIVE to ACTIVE; O9 FRANZ holds with a fresh window.
					expect({
						records: await fixture.records(karl),
						targetRecords: await fixture.records(franz),
						stored: await fixture.stored(TICKET, "op-xtr-01"),
						franz: await fixture.rightsOf(franz, TICKET, T),
						pushes: run.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({
						records: karlJournal.view(),
						targetRecords: {},
						stored: storedView(next, intent, 2),
						franz: heldRights(root, notYet(T + TTL + GRACE), live(false), 4),
						pushes: 1,
						clockCalls: 2,
					});

					// Follow-ups at the moved root (KARL's only intent expects `base`).
					await expectRefusals(fixture, handles, [
						{
							label: "xtr-01 KARL renews after the transfer",
							catches: "the old proof still valid",
							handle: karl,
							operationId: "op-xtr-01-renew",
							request: renew(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: moved,
						},
						{
							label: "xtr-01 KARL releases after the transfer",
							catches: "a displaced source freeing the claim",
							handle: karl,
							operationId: "op-xtr-01-release",
							request: release(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: moved,
						},
						{
							label: "xtr-01 KARL transfers again, to LENA",
							catches: "a second transfer by the displaced source",
							handle: karl,
							operationId: "op-xtr-01-again",
							request: transfer(),
							changes: { targetContextDirectory: lena.directory },
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: moved,
						},
					]);

					// FRANZ uses the claim natively (catches: a target binding that no context can prove).
					const renewClock = sequenceClock(T + MINUTE, T + MINUTE);
					const renewRun = await fixture.run(fixture.options(franz, "op-xtr-01-franz", renew(), renewClock));
					const renewed = await fixture.ticketRoot(TICKET);
					const renewedRights = heldRights(renewed, notYet(T + MINUTE + TTL + GRACE), live(false), 4);
					await fixture.expectView(
						renewRun.result,
						appliedView("xtr-01 FRANZ renews", "renew", "op-xtr-01-franz", renewed, renewedRights),
						handles,
					);
					const renewedNext = active(franz.context.binding, lease(T + MINUTE + TTL), {
						claimGeneration: 4,
						owner: OTHER_OWNER,
					});
					const renewIntent = fixture.intent({
						operationId: "op-xtr-01-franz",
						expectedRoot: root,
						request: renew(),
						next: renewedNext,
					});
					expect({
						stored: await fixture.stored(TICKET, "op-xtr-01-franz"),
						records: await fixture.records(franz),
						pushes: renewRun.pushes.length,
						clockCalls: renewClock.calls(),
					}).toEqual({
						stored: storedView(renewedNext, renewIntent, 3),
						records: recordFile(renewIntent),
						pushes: 1,
						clockCalls: 2,
					});

					// xtr-02: KARL holds hard H on SECOND_TICKET. The refusals run first at the unchanged root;
					// each is not-planned, prepares no intent and so cannot pause the next call.
					const hardBase = await fixture.writeState(active(karl.context.binding, hard()), SECOND_TICKET);
					const hardHeld = heldRights(hardBase, notYet(H + GRACE), live(null));
					await expectRefusals(fixture, handles, [
						{
							label: "xtr-02 hard deadline without a time-box action",
							catches: "preserve as a silent default, a mutation despite require-explicit",
							handle: karl,
							operationId: "op-xtr-02-null",
							request: transfer(null, null),
							changes: toFranz(SECOND_TICKET),
							now: T,
							plan: rejectedPlan("time-box-required"),
							rights: hardHeld,
						},
						{
							label: "xtr-02 explicit restart",
							catches: "a new time box over the D path",
							handle: karl,
							operationId: "op-xtr-02-restart",
							request: transfer(restart(), null),
							changes: toFranz(SECOND_TICKET),
							now: T,
							plan: rejectedPlan("requires-time-path"),
							rights: hardHeld,
						},
						{
							label: "xtr-02 restart from policy",
							catches: "a policy restart planned as preserve",
							handle: karl,
							operationId: "op-xtr-02-policy",
							request: transfer(restart("policy"), null),
							changes: toFranz(SECOND_TICKET),
							now: T,
							plan: rejectedPlan("requires-time-path"),
							rights: hardHeld,
						},
					]);
					// preserve applies and keeps H (catches: H recomputed, the time box ignored).
					const hardClock = sequenceClock(T, T);
					const hardRequest = transfer(preserve(), null);
					const hardRun = await fixture.run(
						fixture.options(karl, "op-xtr-02-preserve", hardRequest, hardClock, toFranz(SECOND_TICKET)),
					);
					const hardRoot = await fixture.ticketRoot(SECOND_TICKET);
					const hardMoved = foreignRights(hardRoot, notYet(H + GRACE), 4);
					await fixture.expectView(
						hardRun.result,
						appliedView("xtr-02 preserve under H", "transfer", "op-xtr-02-preserve", hardRoot, hardMoved),
						handles,
					);
					const hardNext = transferred(franz, hard());
					const hardIntent = fixture.intent({
						operationId: "op-xtr-02-preserve",
						ticket: SECOND_TICKET,
						expectedRoot: hardBase,
						request: hardRequest,
						next: hardNext,
					});
					karlJournal.add(hardIntent);
					expect({
						stored: await fixture.stored(SECOND_TICKET, "op-xtr-02-preserve"),
						records: await fixture.records(karl),
						pushes: hardRun.pushes.length,
						clockCalls: hardClock.calls(),
					}).toEqual({
						stored: storedView(hardNext, hardIntent, 2),
						records: karlJournal.view(),
						pushes: 1,
						clockCalls: 2,
					});

					// xtr-02: lease(L, H) at H-3 min on THIRD_TICKET; an explicit 5 min is overlong at H, the
					// default TTL is capped at H (transition/index.ts:143-158, as renew).
					const C = H - 3 * MINUTE;
					const cappedBase = await fixture.writeState(active(karl.context.binding, lease(L, H)), THIRD_TICKET);
					await expectRefusals(fixture, handles, [
						{
							label: "xtr-02 explicit 5 min under H",
							catches: "an explicit TTL silently cut at H",
							handle: karl,
							operationId: "op-xtr-02-overlong",
							request: transfer(preserve(), explicitLease(5 * MINUTE)),
							changes: toFranz(THIRD_TICKET),
							now: C,
							plan: rejectedPlan("overlong", H),
							rights: heldRights(cappedBase, eligible(R), live(true)),
						},
					]);
					const cappedClock = sequenceClock(C, C);
					const cappedRequest = transfer(preserve(), defaultLease());
					const cappedRun = await fixture.run(
						fixture.options(karl, "op-xtr-02-capped", cappedRequest, cappedClock, toFranz(THIRD_TICKET)),
					);
					const cappedRoot = await fixture.ticketRoot(THIRD_TICKET);
					const cappedMoved = foreignRights(cappedRoot, notYet(H + GRACE), 4);
					await fixture.expectView(
						cappedRun.result,
						appliedView("xtr-02 default TTL capped at H", "transfer", "op-xtr-02-capped", cappedRoot, cappedMoved),
						handles,
					);
					const cappedNext = transferred(franz, lease(H, H));
					const cappedIntent = fixture.intent({
						operationId: "op-xtr-02-capped",
						ticket: THIRD_TICKET,
						expectedRoot: cappedBase,
						request: cappedRequest,
						next: cappedNext,
					});
					karlJournal.add(cappedIntent);
					expect({
						stored: await fixture.stored(THIRD_TICKET, "op-xtr-02-capped"),
						records: await fixture.records(karl),
						pushes: cappedRun.pushes.length,
						clockCalls: cappedClock.calls(),
					}).toEqual({
						stored: storedView(cappedNext, cappedIntent, 2),
						records: karlJournal.view(),
						pushes: 1,
						clockCalls: 2,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xtr-03 xtr-04: keeps hard timing past H and binds the target's own binding, never its recovery binding",
			async () => {
				await withCase(format, "xtr-b", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const franz2 = await fixture.context(franz.directory);
					const f3 = await fixture.context(franz2.directory);
					const replacement = await fixture.context(karl.directory);
					const handles = [karl, franz, franz2, f3, replacement];

					// xtr-03 Positive control (catches: a late store granting a right, H recomputed): hard H, planned
					// at H-EPS-1, final read at H+1 min.
					const base = await fixture.writeState(active(karl.context.binding, hard()));
					const clock = sequenceClock(H - EPS - 1, H + MINUTE);
					const request = transfer(preserve(), null);
					const run = await fixture.run(
						fixture.options(karl, "op-xtr-03", request, clock, { targetContextDirectory: franz.directory }),
					);
					const root = await fixture.ticketRoot(TICKET);
					const moved = foreignRights(root, notYet(H + GRACE), 4);
					await fixture.expectView(
						run.result,
						appliedView("xtr-03 hard transfer landing after H", "transfer", "op-xtr-03", root, moved),
						handles,
					);
					const next = transferred(franz, hard());
					const intent = fixture.intent({ operationId: "op-xtr-03", expectedRoot: base, request, next });
					expect({
						stored: await fixture.stored(TICKET, "op-xtr-03"),
						franz: await fixture.rightsOf(franz, TICKET, H + MINUTE),
						pushes: run.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({
						stored: storedView(next, intent, 2),
						franz: heldRights(root, notYet(H + GRACE), noRight("hard-expired"), 4),
						pushes: 1,
						clockCalls: 2,
					});
					// KARL releases first (catches: a displaced holder freeing the claim); after FRANZ's release the same
					// call would read `free`, so this order is fixed. KARL's intent expects `base`.
					await expectRefusals(fixture, handles, [
						{
							label: "xtr-03 KARL releases after the transfer",
							catches: "a displaced holder freeing the claim",
							handle: karl,
							operationId: "op-xtr-03-karl",
							request: release(),
							changes: {},
							now: H + MINUTE,
							plan: rejectedPlan("not-holder"),
							rights: moved,
						},
					]);
					// FRANZ holds without a work right after H and may still release.
					const releaseClock = sequenceClock(H + MINUTE, H + MINUTE);
					const releaseRun = await fixture.run(fixture.options(franz, "op-xtr-03-franz", release(), releaseClock));
					const freed = await fixture.ticketRoot(TICKET);
					await fixture.expectView(
						releaseRun.result,
						appliedView("xtr-03 FRANZ releases after H", "release", "op-xtr-03-franz", freed, freeRights(freed, 4)),
						handles,
					);
					const releaseIntent = fixture.intent({
						operationId: "op-xtr-03-franz",
						expectedRoot: root,
						request: release(),
						next: tombstone(4),
					});
					expect(await fixture.stored(TICKET, "op-xtr-03-franz")).toEqual(storedView(tombstone(4), releaseIntent, 3));

					// xtr-04 (catches: the target's recovery binding used, a target that cannot be taken over natively):
					// the target FRANZ2 is a recovery of FRANZ; the stored binding is FRANZ2's own.
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const clock2 = sequenceClock(T, T);
					const run2 = await fixture.run(
						fixture.options(karl, "op-xtr-04", transfer(), clock2, {
							ticket: SECOND_TICKET,
							targetContextDirectory: franz2.directory,
						}),
					);
					const root2 = await fixture.ticketRoot(SECOND_TICKET);
					const moved2 = foreignRights(root2, notYet(T + TTL + GRACE), 4);
					await fixture.expectView(
						run2.result,
						appliedView("xtr-04 transfer to a recovered target", "transfer", "op-xtr-04", root2, moved2),
						handles,
					);
					const next2 = transferred(franz2, lease(T + TTL));
					const intent2 = fixture.intent({
						operationId: "op-xtr-04",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: transfer(),
						next: next2,
					});
					expect({
						stored: await fixture.stored(SECOND_TICKET, "op-xtr-04"),
						targetRecovery: franz2.context.recovery,
						freshTarget: franz2.context.binding !== franz.context.binding,
						franz: await fixture.rightsOf(franz, SECOND_TICKET, T),
						franz2: await fixture.rightsOf(franz2, SECOND_TICKET, T),
					}).toEqual({
						stored: storedView(next2, intent2, 2),
						targetRecovery: { binding: franz.context.binding },
						freshTarget: true,
						franz: moved2,
						franz2: heldRights(root2, notYet(T + TTL + GRACE), live(false), 4),
					});
					// F3 recovers from FRANZ2 and resumes (catches: a transferred claim that no replacement can take over).
					const clock3 = sequenceClock(T, T);
					const run3 = await fixture.run(
						fixture.options(f3, "op-xtr-04-f3", resume(), clock3, { ticket: SECOND_TICKET }),
					);
					const root3 = await fixture.ticketRoot(SECOND_TICKET);
					const held3 = heldRights(root3, notYet(T + TTL + GRACE), live(false), 4);
					await fixture.expectView(
						run3.result,
						appliedView("xtr-04 F3 resumes the target", "resume", "op-xtr-04-f3", root3, held3),
						handles,
					);
					const next3 = active(f3.context.binding, lease(T + TTL), {
						claimGeneration: 4,
						bindingGeneration: 2,
						owner: OTHER_OWNER,
					});
					const intent3 = fixture.intent({
						operationId: "op-xtr-04-f3",
						ticket: SECOND_TICKET,
						expectedRoot: root2,
						request: resume(),
						next: next3,
					});
					expect(await fixture.stored(SECOND_TICKET, "op-xtr-04-f3")).toEqual(storedView(next3, intent3, 3));
					// KARL's replacement resumes (catches: the source's replacement inheriting the transferred claim).
					await expectRefusals(fixture, handles, [
						{
							label: "xtr-04 KARL's replacement resumes after the transfer",
							catches: "the source's old proof surviving the transfer",
							handle: replacement,
							operationId: "op-xtr-04-replacement",
							request: resume(),
							changes: { ticket: SECOND_TICKET },
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root3, notYet(T + TTL + GRACE), 4),
						},
					]);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xrs-01 xrs-02 xrs-03: rebinds through the recovery proof, consumes it, and revives no right after H",
			async () => {
				await withCase(format, "xrs", async (fixture) => {
					const karl = await fixture.context();
					const first = await fixture.context(karl.directory);
					const second = await fixture.context(karl.directory);
					const handles = [karl, first, second];

					// xrs-01 Positive control (catches: the recovery binding stored as successor, the lease renewed,
					// the original keeping the right): the first replacement resumes KARL's lease at T.
					const base = await fixture.writeState(active(karl.context.binding));
					const clock = sequenceClock(T, T);
					const run = await fixture.run(fixture.options(first, "op-xrs-01", resume(), clock));
					const root = await fixture.ticketRoot(TICKET);
					await fixture.expectView(
						run.result,
						appliedView("xrs-01 resume at T", "resume", "op-xrs-01", root, heldRights(root, notYet(R))),
						handles,
					);
					const next = resumed(first, lease(L));
					const intent = fixture.intent({ operationId: "op-xrs-01", expectedRoot: base, request: resume(), next });
					// O2: action "resume", parameters {action: "resume"}, targetBinding the fresh binding; O3 generation 3,
					// binding generation 2, timing unchanged.
					expect({
						records: await fixture.records(first),
						sourceRecords: await fixture.records(karl),
						stored: await fixture.stored(TICKET, "op-xrs-01"),
						pushes: run.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({
						records: recordFile(intent),
						sourceRecords: {},
						stored: storedView(next, intent, 2),
						pushes: 1,
						clockCalls: 2,
					});
					// Follow-ups at the resumed root (the replacement's intent expects `base`, KARL has none).
					const displaced = foreignRights(root, notYet(R));
					await expectRefusals(fixture, handles, [
						{
							label: "xrs-01 KARL renews after the resume",
							catches: "the original keeping the right",
							handle: karl,
							operationId: "op-xrs-01-renew",
							request: renew(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: displaced,
						},
						{
							label: "xrs-01 KARL releases after the resume",
							catches: "the original freeing a resumed claim",
							handle: karl,
							operationId: "op-xrs-01-release",
							request: release(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: displaced,
						},
					]);
					const renewClock = sequenceClock(T + MINUTE, T + MINUTE);
					const renewRun = await fixture.run(fixture.options(first, "op-xrs-01-renew-own", renew(), renewClock));
					const renewed = await fixture.ticketRoot(TICKET);
					const renewedRights = heldRights(renewed, notYet(T + MINUTE + TTL + GRACE));
					await fixture.expectView(
						renewRun.result,
						appliedView("xrs-01 the replacement renews", "renew", "op-xrs-01-renew-own", renewed, renewedRights),
						handles,
					);
					const renewedNext = resumed(first, lease(T + MINUTE + TTL));
					const renewIntent = fixture.intent({
						operationId: "op-xrs-01-renew-own",
						expectedRoot: root,
						request: renew(),
						next: renewedNext,
					});
					expect(await fixture.stored(TICKET, "op-xrs-01-renew-own")).toEqual(storedView(renewedNext, renewIntent, 3));

					// xrs-02 on SECOND_TICKET: the first replacement resumes, the second finds the proof consumed, a
					// recovery of the first continues the chain with binding generation 3.
					await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const clock2 = sequenceClock(T, T);
					const run2 = await fixture.run(
						fixture.options(first, "op-xrs-02-first", resume(), clock2, { ticket: SECOND_TICKET }),
					);
					const root2 = await fixture.ticketRoot(SECOND_TICKET);
					const held2 = heldRights(root2, notYet(R));
					await fixture.expectView(
						run2.result,
						appliedView("xrs-02 first replacement resumes", "resume", "op-xrs-02-first", root2, held2),
						handles,
					);
					await expectRefusals(fixture, handles, [
						{
							label: "xrs-02 second replacement resumes after the first",
							catches: "a proof that is not consumed",
							handle: second,
							operationId: "op-xrs-02-second",
							request: resume(),
							changes: { ticket: SECOND_TICKET },
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root2, notYet(R)),
						},
					]);
					const chained = await fixture.context(first.directory);
					const chainHandles = [...handles, chained];
					const clock3 = sequenceClock(T, T);
					const run3 = await fixture.run(
						fixture.options(chained, "op-xrs-02-chained", resume(), clock3, { ticket: SECOND_TICKET }),
					);
					const root3 = await fixture.ticketRoot(SECOND_TICKET);
					const held3 = heldRights(root3, notYet(R));
					await fixture.expectView(
						run3.result,
						appliedView("xrs-02 recovery of the first resumes", "resume", "op-xrs-02-chained", root3, held3),
						chainHandles,
					);
					const next3 = resumed(chained, lease(L), 3);
					const intent3 = fixture.intent({
						operationId: "op-xrs-02-chained",
						ticket: SECOND_TICKET,
						expectedRoot: root2,
						request: resume(),
						next: next3,
					});
					expect(await fixture.stored(SECOND_TICKET, "op-xrs-02-chained")).toEqual(storedView(next3, intent3, 3));
					await expectRefusals(fixture, chainHandles, [
						{
							label: "xrs-02 second replacement resumes after the chain",
							catches: "a consumed proof revived by a later rebind",
							handle: second,
							operationId: "op-xrs-02-second-again",
							request: resume(),
							changes: { ticket: SECOND_TICKET },
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root3, notYet(R)),
						},
					]);
					expect(await fixture.records(second)).toEqual({});

					// xrs-03 on THIRD_TICKET: hard H, the second replacement resumes at H+1 min (catches: a right
					// revived after H, H moved).
					const base4 = await fixture.writeState(active(karl.context.binding, hard()), THIRD_TICKET);
					const clock4 = sequenceClock(H + MINUTE, H + MINUTE);
					const run4 = await fixture.run(
						fixture.options(second, "op-xrs-03", resume(), clock4, { ticket: THIRD_TICKET }),
					);
					const root4 = await fixture.ticketRoot(THIRD_TICKET);
					const expired = heldRights(root4, notYet(H + GRACE), noRight("hard-expired"));
					await fixture.expectView(
						run4.result,
						appliedView("xrs-03 resume after H", "resume", "op-xrs-03", root4, expired),
						chainHandles,
					);
					const next4 = resumed(second, hard());
					const intent4 = fixture.intent({
						operationId: "op-xrs-03",
						ticket: THIRD_TICKET,
						expectedRoot: base4,
						request: resume(),
						next: next4,
					});
					expect({
						stored: await fixture.stored(THIRD_TICKET, "op-xrs-03"),
						karl: await fixture.rightsOf(karl, THIRD_TICKET, H + MINUTE),
						pushes: run4.pushes.length,
						clockCalls: clock4.calls(),
					}).toEqual({
						stored: storedView(next4, intent4, 2),
						karl: foreignRights(root4, notYet(H + GRACE)),
						pushes: 1,
						clockCalls: 2,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xbd-01 xbd-02: shortens bounds in place and refuses every extension, mode change or foreign change",
			async () => {
				await withCase(format, "xbd", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];

					// xbd-01 Positive control (catches: a shortening refused, the rest of the state changed): hard H becomes
					// hard H-30 min at T.
					const shortened = hard(H - 30 * MINUTE);
					const base = await fixture.writeState(active(karl.context.binding, hard()));
					const clock = sequenceClock(T, T);
					const request = changeBounds(shortened);
					const run = await fixture.run(fixture.options(karl, "op-xbd-01", request, clock));
					const root = await fixture.ticketRoot(TICKET);
					const held = heldRights(root, notYet(H - 30 * MINUTE + GRACE), live(null));
					await fixture.expectView(
						run.result,
						appliedView("xbd-01 shorten H", "change-bounds", "op-xbd-01", root, held),
						handles,
					);
					const next = active(karl.context.binding, shortened);
					const intent = fixture.intent({ operationId: "op-xbd-01", expectedRoot: base, request, next });
					expect({
						stored: await fixture.stored(TICKET, "op-xbd-01"),
						records: await fixture.records(karl),
						pushes: run.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({ stored: storedView(next, intent, 2), records: recordFile(intent), pushes: 1, clockCalls: 2 });
					// Refusals at the shortened root (KARL's intent expects `base`; each refusal prepares nothing).
					await expectRefusals(fixture, handles, [
						{
							label: "xbd-01 back to the old H",
							catches: "an extension over the D path",
							handle: karl,
							operationId: "op-xbd-01-extend",
							request: changeBounds(hard()),
							changes: {},
							now: T,
							plan: rejectedPlan("requires-time-path"),
							rights: held,
						},
						{
							label: "xbd-01 hard to lease",
							catches: "a silent mode change",
							handle: karl,
							operationId: "op-xbd-01-mode",
							request: changeBounds(lease(L, H - 30 * MINUTE)),
							changes: {},
							now: T,
							plan: rejectedPlan("mode-change"),
							rights: held,
						},
						{
							label: "xbd-01 FRANZ shortens",
							catches: "a foreign change accepted (no permission model for it)",
							handle: franz,
							operationId: "op-xbd-01-foreign",
							request: changeBounds(hard(H - 40 * MINUTE)),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root, notYet(H - 30 * MINUTE + GRACE)),
						},
					]);

					// xbd-02 (catches: an H-free change sent to the T path, a first hard end read as an extension): a pure
					// lease on SECOND_TICKET moves to T+1 day, then gains a first hard end.
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const far = lease(T + DAY);
					const clock2 = sequenceClock(T, T);
					const run2 = await fixture.run(
						fixture.options(karl, "op-xbd-02-far", changeBounds(far), clock2, { ticket: SECOND_TICKET }),
					);
					const root2 = await fixture.ticketRoot(SECOND_TICKET);
					const farRights = heldRights(root2, notYet(T + DAY + GRACE));
					await fixture.expectView(
						run2.result,
						appliedView("xbd-02 H-free lease end", "change-bounds", "op-xbd-02-far", root2, farRights),
						handles,
					);
					const next2 = active(karl.context.binding, far);
					const intent2 = fixture.intent({
						operationId: "op-xbd-02-far",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: changeBounds(far),
						next: next2,
					});
					expect({
						stored: await fixture.stored(SECOND_TICKET, "op-xbd-02-far"),
						pushes: run2.pushes.length,
					}).toEqual({ stored: storedView(next2, intent2, 2), pushes: 1 });
					// KARL's intent expects `base2`; the root is `root2`.
					const bounded = lease(T + 10 * MINUTE, H);
					const clock3 = sequenceClock(T, T);
					const run3 = await fixture.run(
						fixture.options(karl, "op-xbd-02-bounded", changeBounds(bounded), clock3, { ticket: SECOND_TICKET }),
					);
					const root3 = await fixture.ticketRoot(SECOND_TICKET);
					const boundedRights = heldRights(root3, notYet(T + 10 * MINUTE + GRACE));
					await fixture.expectView(
						run3.result,
						appliedView("xbd-02 first hard end", "change-bounds", "op-xbd-02-bounded", root3, boundedRights),
						handles,
					);
					const next3 = active(karl.context.binding, bounded);
					const intent3 = fixture.intent({
						operationId: "op-xbd-02-bounded",
						ticket: SECOND_TICKET,
						expectedRoot: root2,
						request: changeBounds(bounded),
						next: next3,
					});
					expect({
						stored: await fixture.stored(SECOND_TICKET, "op-xbd-02-bounded"),
						pushes: run3.pushes.length,
					}).toEqual({ stored: storedView(next3, intent3, 3), pushes: 1 });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xrt-01 xrt-02: resolves a lost transfer reply as stored and resends an open resume byte-identically",
			async () => {
				await withCase(format, "xrt-a", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const replacement = await fixture.context(karl.directory);
					const handles = [karl, franz, replacement];
					const loss = fixture.storage(fixture.primary, LOSS_TIMEOUT);

					// xrt-01 Positive control (catches: a `=` re-push or a second transfer after stored): the transfer
					// lands, post-receive holds the reply past the client timeout, the query finds it stored.
					const base = await fixture.writeState(active(karl.context.binding));
					const pre1 = await fixture.hooks.count("pre");
					const post1 = await fixture.hooks.count("post");
					await fixture.hooks.plan("post", ["hold"], "pass");
					const clock1 = sequenceClock(T, T);
					const lost = await fixture.run(
						fixture.options(karl, "op-xrt-01", transfer(), clock1, {
							storage: loss,
							targetContextDirectory: franz.directory,
						}),
					);
					const landed = await fixture.ticketRoot(TICKET);
					const moved = foreignRights(landed, notYet(T + TTL + GRACE), 4);
					await fixture.expectView(
						lost.result,
						operationView("xrt-01 lost transfer reply after landing", {
							action: "transfer",
							operationId: "op-xrt-01",
							storage: queriedStorage("unknown", "resolved", "stored", landed),
							outcome: "applied",
							rights: moved,
							sends: 1,
						}),
						handles,
					);
					const next = transferred(franz, lease(T + TTL));
					const intent = fixture.intent({ operationId: "op-xrt-01", expectedRoot: base, request: transfer(), next });
					expect({
						pushes: lost.pushes.length,
						preReceives: (await fixture.hooks.invocations("pre", pre1)).length,
						postReceives: (await fixture.hooks.invocations("post", post1)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(karl),
						stored: await fixture.stored(TICKET, "op-xrt-01"),
						franz: await fixture.rightsOf(franz, TICKET, T),
						clockCalls: clock1.calls(),
					}).toEqual({
						pushes: 1,
						preReceives: 1,
						postReceives: [[{ from: base, to: landed, ref: refOf(TICKET) }]],
						records: recordFile(intent),
						stored: storedView(next, intent, 2),
						franz: heldRights(landed, notYet(T + TTL + GRACE), live(false), 4),
						clockCalls: 2,
					});
					await fixture.releaseHeld("post", post1, 1);

					// xrt-02 on SECOND_TICKET: pre-receive holds the first push of a resume and declines it late; the open
					// intent is resent (catches: a retry with a new ID, a new plan, a fresh binding or a re-read proof).
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const pre2 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject", "pass"], "pass");
					const clock2 = sequenceClock(T, T);
					const retried = await fixture.run(
						fixture.options(replacement, "op-xrt-02", resume(), clock2, {
							ticket: SECOND_TICKET,
							storage: loss,
							attempts: 2,
						}),
					);
					const root2 = await fixture.ticketRoot(SECOND_TICKET);
					await fixture.expectView(
						retried.result,
						operationView("xrt-02 identical retry of an open resume", {
							action: "resume",
							operationId: "op-xrt-02",
							storage: appliedStorage(root2),
							outcome: "applied",
							rights: heldRights(root2, notYet(R)),
							sends: 2,
						}),
						handles,
					);
					const next2 = resumed(replacement, lease(L));
					const intent2 = fixture.intent({
						operationId: "op-xrt-02",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: resume(),
						next: next2,
					});
					const line: Receive = { from: base2, to: root2, ref: refOf(SECOND_TICKET) };
					expect({
						pushes: retried.pushes.length,
						distinctPushes: distinct(retried.pushes),
						receives: (await fixture.hooks.invocations("pre", pre2)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(replacement),
						stored: await fixture.stored(SECOND_TICKET, "op-xrt-02"),
						clockCalls: clock2.calls(),
					}).toEqual({
						pushes: 2,
						distinctPushes: 1,
						receives: [[line], [line]],
						records: recordFile(intent2),
						stored: storedView(next2, intent2, 2),
						clockCalls: 2,
					});
					await fixture.releaseHeld("pre", pre2, 1);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"xrt-03 xrt-04: stops a held change-bounds at the attempt limit and reports a declined transfer as remote",
			async () => {
				await withCase(format, "xrt-b", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const loss = fixture.storage(fixture.primary, LOSS_TIMEOUT);

					// xrt-03 Positive control (catches: unbounded retries, open read as applied or rejected): both pushes of
					// a change-bounds are held past the client timeout and declined late; two attempts.
					const shortened = hard(H - 30 * MINUTE);
					const base = await fixture.writeState(active(karl.context.binding, hard()));
					const pre1 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject", "hold-reject"], "pass");
					const clock1 = sequenceClock(T, T);
					const open = await fixture.run(
						fixture.options(karl, "op-xrt-03", changeBounds(shortened), clock1, { storage: loss, attempts: 2 }),
					);
					await fixture.expectView(
						open.result,
						operationView("xrt-03 two held sends of a change-bounds", {
							action: "change-bounds",
							operationId: "op-xrt-03",
							storage: queriedStorage("unknown", "resolved", "open", base),
							outcome: "unknown",
							rights: heldRights(base, notYet(H + GRACE), live(null)),
							sends: 2,
						}),
						handles,
					);
					const next = active(karl.context.binding, shortened);
					const intent = fixture.intent({
						operationId: "op-xrt-03",
						expectedRoot: base,
						request: changeBounds(shortened),
						next,
					});
					expect({
						pushes: open.pushes.length,
						distinctPushes: distinct(open.pushes),
						preReceives: (await fixture.hooks.invocations("pre", pre1)).length,
						ref: await fixture.ticketRoot(TICKET),
						records: await fixture.records(karl),
						clockCalls: clock1.calls(),
					}).toEqual({
						pushes: 2,
						distinctPushes: 1,
						preReceives: 2,
						ref: base,
						records: recordFile(intent),
						clockCalls: 2,
					});
					await fixture.releaseHeld("pre", pre1, 2);
					// From here KARL pauses at `base` of TICKET (open intent); no KARL call touches TICKET again.

					// xrt-04 on SECOND_TICKET: the server declines a transfer (catches: remote read as stale or unknown, a
					// retry after remote, a transfer claimed although nothing moved).
					// ASSUMPTION(executor, execution/index.ts:476): the final read expects the successor's generation 4, so the
					// still-holding source reads `generation-changed` (rights/index.ts:287-288), not `live`.
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const pre2 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", [], "reject");
					const clock2 = sequenceClock(T, T);
					const declined = await fixture.run(
						fixture.options(karl, "op-xrt-04", transfer(), clock2, {
							ticket: SECOND_TICKET,
							targetContextDirectory: franz.directory,
						}),
					);
					await fixture.expectView(
						declined.result,
						operationView("xrt-04 declined transfer", {
							action: "transfer",
							operationId: "op-xrt-04",
							storage: rejectedStorage("remote"),
							outcome: "rejected",
							rights: heldRights(base2, notYet(R), noRight("generation-changed")),
							sends: 1,
						}),
						handles,
					);
					expect({
						pushes: declined.pushes.length,
						preReceives: (await fixture.hooks.invocations("pre", pre2)).length,
						ref: await fixture.ticketRoot(SECOND_TICKET),
						stored: await fixture.stored(SECOND_TICKET, "op-xrt-04"),
						franz: await fixture.rightsOf(franz, SECOND_TICKET, T),
						clockCalls: clock2.calls(),
					}).toEqual({
						pushes: 1,
						preReceives: 1,
						ref: base2,
						stored: { revision: 1, payload: sha256Hex(canonicalJson(active(karl.context.binding))), receipt: null },
						franz: foreignRights(base2, notYet(R)),
						clockCalls: 2,
					});
					await fixture.hooks.plan("pre", [], "pass");
					// KARL now also pauses at `base2` of SECOND_TICKET (rejected remote); no further KARL call there.
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"xrt-05 xrt-06 xrt-07: re-sends a journalled transfer, resume and change-bounds without re-reading anything",
			async () => {
				await withCase(format, "xrt-c", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const replacement = await fixture.context(karl.directory);
					const handles = [karl, franz, replacement];
					const karlJournal = new Journal();
					const loss = fixture.storage(fixture.primary, LOSS_TIMEOUT);

					// xrt-05 Positive control (catches: a scaffold without transfer, a lost reply read as a failure): the
					// transfer lands, post-receive holds its reply past the client timeout, the executor's query finds it.
					const base = await fixture.writeState(active(karl.context.binding));
					const post = await fixture.hooks.count("post");
					await fixture.hooks.plan("post", ["hold"], "pass");
					const clock = sequenceClock(T, T);
					const lost = await fixture.run(
						fixture.options(karl, "op-xrt-05", transfer(), clock, {
							storage: loss,
							attempts: 1,
							targetContextDirectory: franz.directory,
						}),
					);
					const landed = await fixture.ticketRoot(TICKET);
					const moved = foreignRights(landed, notYet(T + TTL + GRACE), 4);
					// This view also caches FRANZ's secret, so later views need no longer read the removed directory.
					await fixture.expectView(
						lost.result,
						operationView("xrt-05 set-up: lost transfer reply", {
							action: "transfer",
							operationId: "op-xrt-05",
							storage: queriedStorage("unknown", "resolved", "stored", landed),
							outcome: "applied",
							rights: moved,
							sends: 1,
						}),
						handles,
					);
					const next = transferred(franz, lease(T + TTL));
					const intent = fixture.intent({ operationId: "op-xrt-05", expectedRoot: base, request: transfer(), next });
					karlJournal.add(intent);
					expect({
						records: await fixture.records(karl),
						stored: await fixture.stored(TICKET, "op-xrt-05"),
						franz: await fixture.rightsOf(franz, TICKET, T),
						pushes: lost.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({
						records: karlJournal.view(),
						stored: storedView(next, intent, 2),
						franz: heldRights(landed, notYet(T + TTL + GRACE), live(false), 4),
						pushes: 1,
						clockCalls: 2,
					});
					await fixture.releaseHeld("post", post, 1);

					// The target context disappears; the re-send from the source (base `claim retry`) must clarify
					// the record from the store alone. Catches: resendClaimIntent reporting a transfer record as corrupt
					// because its action list is not taken from transition (execution/index.ts:156, :625-627), a
					// re-read target context, a new plan. ResendClaimIntentOptions carries no target (:564-575).
					await rm(franz.directory, { recursive: true, force: true });
					const touched: string[] = [];
					const refs = await fixture.serverRefs();
					const resendClock = sequenceClock(T, T);
					const resent = await fixture.resend(
						fixture.resendOptions(karl, "op-xrt-05", resendClock, { contextIO: recordingContextIO(touched) }),
					);
					// execution/index.ts:681: with no send, rights come from the fresh read without an expected generation.
					await fixture.expectView(
						resent.result,
						operationView("xrt-05 re-send after the target context is gone", {
							action: "transfer",
							operationId: "op-xrt-05",
							storage: queriedStorage("earlier-process", "resolved", "stored", landed),
							outcome: "applied",
							rights: moved,
							sends: 0,
						}),
						handles,
					);
					expect({
						pushes: resent.pushes.length,
						refs: await fixture.serverRefs(),
						records: await fixture.records(karl),
						sourceLoaded: touched.some((path) => path.startsWith(karl.directory)),
						targetTouched: touched.filter((path) => path.startsWith(franz.directory)).length,
						targetExists: await exists(franz.directory),
					}).toEqual({
						pushes: 0,
						refs,
						records: karlJournal.view(),
						sourceLoaded: true,
						targetTouched: 0,
						targetExists: false,
					});

					// xrt-06 on SECOND_TICKET: the replacement's resume is held in pre-receive past the client timeout and
					// declined late, one attempt; the intent stays open at `base2`.
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const clock2 = sequenceClock(T, T);
					const open = await fixture.run(
						fixture.options(replacement, "op-xrt-06", resume(), clock2, {
							ticket: SECOND_TICKET,
							storage: loss,
							attempts: 1,
						}),
					);
					await fixture.expectView(
						open.result,
						operationView("xrt-06 set-up: held and declined resume", {
							action: "resume",
							operationId: "op-xrt-06",
							storage: queriedStorage("unknown", "resolved", "open", base2),
							outcome: "unknown",
							rights: foreignRights(base2, notYet(R)),
							sends: 1,
						}),
						handles,
					);
					await fixture.releaseHeld("pre", pre, 1);
					const next2 = resumed(replacement, lease(L));
					const intent2 = fixture.intent({
						operationId: "op-xrt-06",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: resume(),
						next: next2,
					});
					expect({
						ref: await fixture.ticketRoot(SECOND_TICKET),
						records: await fixture.records(replacement),
						pushes: open.pushes.length,
						clockCalls: clock2.calls(),
					}).toEqual({ ref: base2, records: recordFile(intent2), pushes: 1, clockCalls: 2 });

					// The re-send from the same replacement context meets its own open intent at the unchanged root, and that
					// intent is exactly the one it sends: resendClaimIntent has no pause step (execution/index.ts:595-749),
					// plans nothing and re-admits its own record idempotently (710-719). Catches: resendClaimIntent
					// reporting a resume record as corrupt (156, :625-627), a new binding or plan, the recovery
					// proof demanded again.
					const resendClock2 = sequenceClock(T, T);
					const resent2 = await fixture.resend(fixture.resendOptions(replacement, "op-xrt-06", resendClock2));
					const root2 = await fixture.ticketRoot(SECOND_TICKET);
					const resumedRights = heldRights(root2, notYet(R));
					await fixture.expectView(
						resent2.result,
						appliedView("xrt-06 re-send of the open resume", "resume", "op-xrt-06", root2, resumedRights),
						handles,
					);
					const line: Receive = { from: base2, to: root2, ref: refOf(SECOND_TICKET) };
					expect({
						pushes: resent2.pushes.length,
						receives: (await fixture.hooks.invocations("pre", pre)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(replacement),
						stored: await fixture.stored(SECOND_TICKET, "op-xrt-06"),
						recovery: replacement.context.recovery,
					}).toEqual({
						pushes: 1,
						receives: [[line], [line]],
						records: recordFile(intent2),
						stored: storedView(next2, intent2, 2),
						recovery: { binding: karl.context.binding },
					});

					// xrt-07 on THIRD_TICKET: KARL shortens hard H; the push is held in pre-receive
					// past the client timeout and declined late, one attempt, so the executor ends unknown with the
					// intent open at `base3`.
					const shortened = hard(H - 30 * MINUTE);
					const base3 = await fixture.writeState(active(karl.context.binding, hard()), THIRD_TICKET);
					const pre3 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const clock3 = sequenceClock(T, T);
					const open3 = await fixture.run(
						fixture.options(karl, "op-xrt-07", changeBounds(shortened), clock3, {
							ticket: THIRD_TICKET,
							storage: loss,
							attempts: 1,
						}),
					);
					await fixture.expectView(
						open3.result,
						operationView("xrt-07 set-up: held and declined change-bounds", {
							action: "change-bounds",
							operationId: "op-xrt-07",
							storage: queriedStorage("unknown", "resolved", "open", base3),
							outcome: "unknown",
							rights: heldRights(base3, notYet(H + GRACE), live(null)),
							sends: 1,
						}),
						handles,
					);
					await fixture.releaseHeld("pre", pre3, 1);
					const next3 = active(karl.context.binding, shortened);
					const intent3 = fixture.intent({
						operationId: "op-xrt-07",
						ticket: THIRD_TICKET,
						expectedRoot: base3,
						request: changeBounds(shortened),
						next: next3,
					});
					karlJournal.add(intent3);
					expect({
						ref: await fixture.ticketRoot(THIRD_TICKET),
						records: await fixture.records(karl),
						pushes: open3.pushes.length,
						clockCalls: clock3.calls(),
					}).toEqual({ ref: base3, records: karlJournal.view(), pushes: 1, clockCalls: 2 });

					// The re-send from KARL meets KARL's own open intent at the unchanged `base3`, and that intent is the one
					// it sends; no plan, no pause step (execution/index.ts:595-749), idempotent re-admission (:710-719).
					// Catches: the execution list extended by transfer and resume only, so that a change-bounds record reads
					// corrupt (156, :625-627) while xrt-05/06 stay green; a re-send that replans or changes the
					// generations, the binding or the owner (O3 digest of `next3`: generation 3, binding generation 1, KARL,
					// OWNER, only the timing shortened).
					const resendClock3 = sequenceClock(T, T);
					const resent3 = await fixture.resend(fixture.resendOptions(karl, "op-xrt-07", resendClock3));
					const root3 = await fixture.ticketRoot(THIRD_TICKET);
					const shortenedRights = heldRights(root3, notYet(H - 30 * MINUTE + GRACE), live(null));
					const resentLabel = "xrt-07 re-send of the open change-bounds";
					await fixture.expectView(
						resent3.result,
						appliedView(resentLabel, "change-bounds", "op-xrt-07", root3, shortenedRights),
						handles,
					);
					const line3: Receive = { from: base3, to: root3, ref: refOf(THIRD_TICKET) };
					expect({
						pushes: resent3.pushes.length,
						receives: (await fixture.hooks.invocations("pre", pre3)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(karl),
						stored: await fixture.stored(THIRD_TICKET, "op-xrt-07"),
					}).toEqual({
						pushes: 1,
						receives: [[line3], [line3]],
						records: karlJournal.view(),
						stored: storedView(next3, intent3, 2),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"xcp-01 xcp-02: lets exactly one of two replacement starts win; the loser keeps no follow-up right",
			async () => {
				await withCase(format, "xcp-a", async (fixture) => {
					const karl = await fixture.context();
					const first = await fixture.context(karl.directory);
					const second = await fixture.context(karl.directory);
					const handles = [karl, first, second];
					const other = await fixture.client("inner");
					const innerStorage = fixture.storage(other);

					// xcp-01: the first replacement's link starts the second one on its own client; both
					// resume KARL's lease at T.
					const base = await fixture.writeState(active(karl.context.binding));
					const nested: { run?: Run } = {};
					const innerOptions = fixture.options(second, "op-xcp-01-second", resume(), sequenceClock(T, T), {
						storage: innerStorage,
					});
					const outerOptions = fixture.options(first, "op-xcp-01-first", resume(), sequenceClock(T, T), {
						journalIO: afterLink(async () => {
							nested.run = await fixture.run(innerOptions, other);
						}),
					});
					const outer = await fixture.run(outerOptions);
					const winner = await fixture.ticketRoot(TICKET);
					const won = heldRights(winner, notYet(R));
					const lost = foreignRights(winner, notYet(R));
					// Positive control (catches: a scaffold without resume, double resume): the inner start wins.
					await fixture.expectView(
						nested.run?.result ?? NOT_RUN,
						appliedView("xcp-01 the second replacement wins", "resume", "op-xcp-01-second", winner, won),
						handles,
					);
					await fixture.expectView(
						outer.result,
						staleView("xcp-01 the first replacement loses", "resume", "op-xcp-01-first", lost),
						handles,
					);
					const next = resumed(second, lease(L));
					const intent = fixture.intent({
						operationId: "op-xcp-01-second",
						expectedRoot: base,
						request: resume(),
						next,
					});
					expect({
						stored: await fixture.stored(TICKET, "op-xcp-01-second"),
						pushes: [outer.pushes.length, nested.run?.pushes.length ?? 0],
						// catches: a retry that turns the loser into the winner
						loserQuery: await fixture.query(first, "op-xcp-01-first"),
					}).toEqual({
						stored: storedView(next, intent, 2),
						pushes: [1, 1],
						loserQuery: { kind: "resolved", resolution: "not-stored", observedRoot: winner },
					});
					// No follow-up right for the loser (its intent expects `base`, the root has moved).
					await expectRefusals(fixture, handles, [
						{
							label: "xcp-01 the loser resumes again",
							catches: "a loser that later gains a right",
							handle: first,
							operationId: "op-xcp-01-first-resume",
							request: resume(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: lost,
						},
						{
							label: "xcp-01 the loser renews",
							catches: "a loser that later gains a right",
							handle: first,
							operationId: "op-xcp-01-first-renew",
							request: renew(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: lost,
						},
						{
							label: "xcp-01 the loser releases",
							catches: "a loser freeing the winner's claim",
							handle: first,
							operationId: "op-xcp-01-first-release",
							request: release(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: lost,
						},
					]);

					// xcp-02 on SECOND_TICKET: the same race on hard H with both clocks at H+1 min
					// (catches: a right revived, two winners after H).
					const late = H + MINUTE;
					const base2 = await fixture.writeState(active(karl.context.binding, hard()), SECOND_TICKET);
					const nested2: { run?: Run } = {};
					const innerOptions2 = fixture.options(second, "op-xcp-02-second", resume(), sequenceClock(late, late), {
						ticket: SECOND_TICKET,
						storage: innerStorage,
					});
					const outerOptions2 = fixture.options(first, "op-xcp-02-first", resume(), sequenceClock(late, late), {
						ticket: SECOND_TICKET,
						journalIO: afterLink(async () => {
							nested2.run = await fixture.run(innerOptions2, other);
						}),
					});
					const outer2 = await fixture.run(outerOptions2);
					const winner2 = await fixture.ticketRoot(SECOND_TICKET);
					const expired = heldRights(winner2, notYet(H + GRACE), noRight("hard-expired"));
					await fixture.expectView(
						nested2.run?.result ?? NOT_RUN,
						appliedView("xcp-02 the second replacement wins after H", "resume", "op-xcp-02-second", winner2, expired),
						handles,
					);
					const lost2 = foreignRights(winner2, notYet(H + GRACE));
					await fixture.expectView(
						outer2.result,
						staleView("xcp-02 the first replacement loses after H", "resume", "op-xcp-02-first", lost2),
						handles,
					);
					const next2 = resumed(second, hard());
					const intent2 = fixture.intent({
						operationId: "op-xcp-02-second",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: resume(),
						next: next2,
					});
					expect({
						stored: await fixture.stored(SECOND_TICKET, "op-xcp-02-second"),
						pushes: [outer2.pushes.length, nested2.run?.pushes.length ?? 0],
					}).toEqual({ stored: storedView(next2, intent2, 2), pushes: [1, 1] });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xcp-03 xcp-04: orders resume against a live original and transfer against reclaim atomically, both ways",
			async () => {
				await withCase(format, "xcp-b", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const lena = await fixture.context();
					const replacement = await fixture.context(karl.directory);
					const handles = [karl, franz, lena, replacement];
					const other = await fixture.client("inner");
					const innerStorage = fixture.storage(other);

					// xcp-03 (i): the live original's renew lands inside the replacement's resume.
					await fixture.writeState(active(karl.context.binding));
					const innerRenew: { run?: Run } = {};
					const renewOptions = fixture.options(karl, "op-xcp-03-renew", renew(), sequenceClock(T, T), {
						storage: innerStorage,
					});
					const resumeOptions = fixture.options(replacement, "op-xcp-03-resume-late", resume(), sequenceClock(T, T), {
						journalIO: afterLink(async () => {
							innerRenew.run = await fixture.run(renewOptions, other);
						}),
					});
					const lateResume = await fixture.run(resumeOptions);
					const renewed = await fixture.ticketRoot(TICKET);
					const renewedReclaim = notYet(T + TTL + GRACE);
					// Positive control (catches: a scaffold without resume, renew and resume both succeeding): the inner
					// renew applies and the resume is stale.
					const renewLabel = "xcp-03 (i) the original renews inside the resume";
					await fixture.expectView(
						innerRenew.run?.result ?? NOT_RUN,
						appliedView(renewLabel, "renew", "op-xcp-03-renew", renewed, heldRights(renewed, renewedReclaim)),
						handles,
					);
					const displaced = foreignRights(renewed, renewedReclaim);
					await fixture.expectView(
						lateResume.result,
						staleView("xcp-03 (i) the resume loses", "resume", "op-xcp-03-resume-late", displaced),
						handles,
					);
					// A new resume against the renewed root applies (catches: a live original blocking the resume for
					// good). The replacement's stale intent expects the starting root, the root is `renewed`.
					const clock = sequenceClock(T, T);
					const retaken = await fixture.run(fixture.options(replacement, "op-xcp-03-resume", resume(), clock));
					const resumedRoot = await fixture.ticketRoot(TICKET);
					const retakenRights = heldRights(resumedRoot, renewedReclaim);
					await fixture.expectView(
						retaken.result,
						appliedView("xcp-03 (i) a new resume applies", "resume", "op-xcp-03-resume", resumedRoot, retakenRights),
						handles,
					);
					const next = resumed(replacement, lease(T + TTL));
					const intent = fixture.intent({
						operationId: "op-xcp-03-resume",
						expectedRoot: renewed,
						request: resume(),
						next,
					});
					expect(await fixture.stored(TICKET, "op-xcp-03-resume")).toEqual(storedView(next, intent, 3));
					// KARL's inner renew expects the starting root; the root is `resumedRoot`.
					await expectRefusals(fixture, handles, [
						{
							label: "xcp-03 (i) the original renews after the resume",
							catches: "both the original and the replacement entitled",
							handle: karl,
							operationId: "op-xcp-03-renew-after",
							request: renew(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(resumedRoot, renewedReclaim),
						},
					]);

					// xcp-03 (ii) on SECOND_TICKET: the resume lands inside the live original's renew.
					const base2 = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const innerResume: { run?: Run } = {};
					const resumeOptions2 = fixture.options(replacement, "op-xcp-03-resume-inner", resume(), sequenceClock(T, T), {
						ticket: SECOND_TICKET,
						storage: innerStorage,
					});
					const renewOptions2 = fixture.options(karl, "op-xcp-03-renew-late", renew(), sequenceClock(T, T), {
						ticket: SECOND_TICKET,
						journalIO: afterLink(async () => {
							innerResume.run = await fixture.run(resumeOptions2, other);
						}),
					});
					const lateRenew = await fixture.run(renewOptions2);
					const resumed2 = await fixture.ticketRoot(SECOND_TICKET);
					const innerLabel = "xcp-03 (ii) the resume lands inside the renew";
					await fixture.expectView(
						innerResume.run?.result ?? NOT_RUN,
						appliedView(innerLabel, "resume", "op-xcp-03-resume-inner", resumed2, heldRights(resumed2, notYet(R))),
						handles,
					);
					const original = foreignRights(resumed2, notYet(R));
					await fixture.expectView(
						lateRenew.result,
						staleView("xcp-03 (ii) the original's renew loses", "renew", "op-xcp-03-renew-late", original),
						handles,
					);
					const next2 = resumed(replacement, lease(L));
					const intent2 = fixture.intent({
						operationId: "op-xcp-03-resume-inner",
						ticket: SECOND_TICKET,
						expectedRoot: base2,
						request: resume(),
						next: next2,
					});
					expect(await fixture.stored(SECOND_TICKET, "op-xcp-03-resume-inner")).toEqual(storedView(next2, intent2, 2));

					// xcp-04: a pure lease at C = R + EPS; KARL transfers to FRANZ while LENA reclaims.
					const C = R + EPS;
					// Order 1 on THIRD_TICKET: LENA's reclaim lands inside KARL's transfer (catches: a non-atomic transfer,
					// a transfer that revives a reclaimed claim).
					await fixture.writeState(active(karl.context.binding), THIRD_TICKET);
					const innerReclaim: { run?: Run } = {};
					const reclaimOptions = fixture.options(lena, "op-xcp-04-reclaim", reclaim(), sequenceClock(C, C), {
						ticket: THIRD_TICKET,
						storage: innerStorage,
					});
					const transferOptions = fixture.options(karl, "op-xcp-04-transfer-late", transfer(), sequenceClock(C, C), {
						ticket: THIRD_TICKET,
						targetContextDirectory: franz.directory,
						journalIO: afterLink(async () => {
							innerReclaim.run = await fixture.run(reclaimOptions, other);
						}),
					});
					const lateTransfer = await fixture.run(transferOptions);
					const freed = await fixture.ticketRoot(THIRD_TICKET);
					await fixture.expectView(
						innerReclaim.run?.result ?? NOT_RUN,
						appliedView("xcp-04 LENA's reclaim wins", "reclaim", "op-xcp-04-reclaim", freed, freeRights(freed)),
						handles,
					);
					await fixture.expectView(
						lateTransfer.result,
						staleView("xcp-04 KARL's transfer loses", "transfer", "op-xcp-04-transfer-late", freeRights(freed)),
						handles,
					);
					expect(await fixture.rightsOf(franz, THIRD_TICKET, C)).toEqual(freeRights(freed));

					// Order 2 on FOURTH_TICKET: KARL's transfer lands inside LENA's reclaim (catches: a reclaim after an
					// unobserved transfer, a transfer without a fresh window).
					const base4 = await fixture.writeState(active(karl.context.binding), FOURTH_TICKET);
					const innerTransfer: { run?: Run } = {};
					const transferOptions2 = fixture.options(karl, "op-xcp-04-transfer", transfer(), sequenceClock(C, C), {
						ticket: FOURTH_TICKET,
						targetContextDirectory: franz.directory,
					});
					const reclaimOptions2 = fixture.options(lena, "op-xcp-04-reclaim-late", reclaim(), sequenceClock(C, C), {
						ticket: FOURTH_TICKET,
						storage: innerStorage,
						journalIO: afterLink(async () => {
							innerTransfer.run = await fixture.run(transferOptions2);
						}),
					});
					const lateReclaim = await fixture.run(reclaimOptions2, other);
					const moved = await fixture.ticketRoot(FOURTH_TICKET);
					const freshWindow = notYet(C + TTL + GRACE);
					const movedRights = foreignRights(moved, freshWindow, 4);
					await fixture.expectView(
						innerTransfer.run?.result ?? NOT_RUN,
						appliedView("xcp-04 KARL's transfer wins", "transfer", "op-xcp-04-transfer", moved, movedRights),
						handles,
					);
					await fixture.expectView(
						lateReclaim.result,
						staleView("xcp-04 LENA's reclaim loses", "reclaim", "op-xcp-04-reclaim-late", movedRights),
						handles,
					);
					const next4 = transferred(franz, lease(C + TTL));
					const intent4 = fixture.intent({
						operationId: "op-xcp-04-transfer",
						ticket: FOURTH_TICKET,
						expectedRoot: base4,
						request: transfer(),
						next: next4,
					});
					expect({
						stored: await fixture.stored(FOURTH_TICKET, "op-xcp-04-transfer"),
						franz: await fixture.rightsOf(franz, FOURTH_TICKET, C),
					}).toEqual({
						stored: storedView(next4, intent4, 2),
						franz: heldRights(moved, freshWindow, live(false), 4),
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"xcp-05: lets exactly one of two resumes held together in pre-receive win; the other is rejected for good",
			async () => {
				await withCase(format, "xcp-05", async (fixture) => {
					const karl = await fixture.context();
					const first = await fixture.context(karl.directory);
					const second = await fixture.context(karl.directory);
					const contestants = [first, second];
					const handles = [karl, first, second];

					// Positive control (catches: a scaffold without resume): one resume alone applies on CONTROL_TICKET.
					await fixture.writeState(active(karl.context.binding), CONTROL_TICKET);
					const controlClock = sequenceClock(T, T);
					const control = await fixture.run(
						fixture.options(first, "op-xcp-05-control", resume(), controlClock, { ticket: CONTROL_TICKET }),
					);
					const controlRoot = await fixture.ticketRoot(CONTROL_TICKET);
					const controlRights = heldRights(controlRoot, notYet(R));
					await fixture.expectView(
						control.result,
						appliedView("xcp-05 positive control", "resume", "op-xcp-05-control", controlRoot, controlRights),
						handles,
					);

					// Both replacements resume KARL's lease at T on their own clients.
					// the two holds must be numbered deterministically. S1 numbers invocations by an atomic mkdir
					// (receiveHook); the second resume starts only once the first holds as invocation pre+1, so the first is
					// pre+1 and the second pre+2 in every run. Both then hold in pre-receive together, as the two
					// pushes of rsm-07 do (claim-execution-retry.test.ts:1766-1836), each having read the same base.
					const base = await fixture.writeState(active(karl.context.binding));
					const repositories = [await fixture.client("race-1"), await fixture.client("race-2")];
					const pre = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold", "hold"], "pass");
					const racers: Racer[] = [];
					for (const [index, handle] of contestants.entries()) {
						const repository = at(repositories, index);
						const storage = fixture.storage(repository, HELD_SEND_TIMEOUT);
						const options = fixture.options(handle, `op-xcp-05-${index + 1}`, resume(), sequenceClock(T, T), {
							storage,
						});
						const racer = await fixture.start(options, repository);
						racers.push(racer);
						const label = `xcp-05 resume ${index + 1} holding as invocation ${index + 1}`;
						const entered = await whilePending(label, racer.pending, () =>
							fixture.hooks.hasEntered("pre", pre + index + 1),
						);
						expect({ label, entered }).toEqual({ label, entered: true });
					}
					// Fixture precondition: both pushes hold in pre-receive at the same time, neither has left its hold.
					const firstHolding = !(await fixture.hooks.hasFinished("pre", pre + 1));
					const secondHolding = !(await fixture.hooks.hasFinished("pre", pre + 2));
					expect({ firstHolding, secondHolding }).toEqual({ firstHolding: true, secondHolding: true });
					await fixture.hooks.release("pre", pre + 1);
					await waitUntil("xcp-05 first landing", async () => (await fixture.ticketRoot(TICKET)) !== base);
					await fixture.hooks.release("pre", pre + 2);
					const runs: Run[] = [];
					for (const [index, racer] of racers.entries()) {
						runs.push(await fixture.settle(`xcp-05 resume ${index + 1}`, racer));
					}
					const root = await fixture.ticketRoot(TICKET);
					const winner = at(runs, 0);
					const loser = at(runs, 1);
					// Exactly one winner (catches: two applied starts against one root, or none): the released first.
					await fixture.expectView(
						winner.result,
						appliedView("xcp-05 the first resume wins", "resume", "op-xcp-05-1", root, heldRights(root, notYet(R))),
						handles,
					);
					const loserLabel = "xcp-05 the second resume loses (catches: a second winner, a rejection read as unknown)";
					const loserExpected = operationView(loserLabel, {
						action: "resume",
						operationId: "op-xcp-05-2",
						storage: rejectedStorage(REJECTED_CAUSE),
						outcome: "rejected",
						rights: foreignRights(root, notYet(R)),
						sends: 1,
					});
					expect(normalizedCause(await fixture.view(loserLabel, loser.result, handles))).toStrictEqual(loserExpected);
					const next = resumed(first, lease(L));
					const intent = fixture.intent({ operationId: "op-xcp-05-1", expectedRoot: base, request: resume(), next });
					const receives = (await fixture.hooks.invocations("pre", pre)).map((call) => call.lines.map(receiveOf));
					expect({
						stored: await fixture.stored(TICKET, "op-xcp-05-1"),
						pushes: runs.map((run) => run.pushes.length),
						receives: receives.map((lines) => lines.map((line) => ({ from: line.from, landed: line.to === root }))),
						loserQuery: await fixture.query(second, "op-xcp-05-2"),
					}).toEqual({
						stored: storedView(next, intent, 2),
						pushes: [1, 1],
						receives: [[{ from: base, landed: true }], [{ from: base, landed: false }]],
						loserQuery: { kind: "resolved", resolution: "not-stored", observedRoot: root },
					});
					// No follow-up right for the loser (its intent expects `base`, the root has moved).
					await expectRefusals(fixture, handles, [
						{
							label: "xcp-05 the loser resumes again",
							catches: "a loser that keeps a follow-up right",
							handle: second,
							operationId: "op-xcp-05-2-again",
							request: resume(),
							changes: {},
							now: T,
							plan: rejectedPlan("not-holder"),
							rights: foreignRights(root, notYet(R)),
						},
					]);
				});
			},
			TEST_TIMEOUT,
		);
	});
}
