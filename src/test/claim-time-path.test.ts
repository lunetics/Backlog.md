/**
 * Level P: the pure parts of the time path. Pinned here: the v1 PENDING schema and its decoder; the rights projection
 * with ownership and cause `pending` and the hull; the time-path set of the planner, its precondition, the restart
 * target times and the input gate; the follow-up operations on PENDING; the clock-free logical outcome over the P and A
 * records; the continue row of claim next; the document, rights-view and text additions; the preview verdict, preview
 * entry, batch plan and owner match of a PENDING ticket.
 * No Git, no filesystem, no subprocess, no network and no clock: every instant is a fixed millisecond constant, and no
 * call reaches the executor or a journal, so no own intent can pause a later call. Every test starts
 * with a positive control; table rows name the deliberately wrong implementation they catch. Names the typed scaffold
 * adds are marked ASSUMPTION(scaffold), names of batch reclaim ASSUMPTION(batch reclaim), shapes only the names
 * ASSUMPTION(time path). Harness: adapted copies with "adapted from" notes, no shared fixture module.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ClaimExecutionResult, ClaimExecutionStorage } from "../claims/execution/index.ts";
import type { ClaimIntentEnumerationResult, ClaimIntentRecord, ClaimOperationIntent } from "../claims/journal/index.ts";
import { evaluateClaimAcquireStop } from "../claims/pause/index.ts";
import type { ClaimMutationQueryResult } from "../claims/query/index.ts";
// ASSUMPTION(scaffold): claimConfirmationId (stub "") and resolveClaimTransition (stub invalid) with the
// input {record, confirmation, source, observed}.
import { type ClaimMutationSource, claimConfirmationId, resolveClaimTransition } from "../claims/resolution/index.ts";
// ASSUMPTION(scaffold): PendingClaimState inside ClaimStateV1, the ownership and cause `pending` and
// claimReclaimBoundary (stub null).
import {
	type ActiveClaimState,
	type ClaimRightEvaluation,
	type ClaimStateV1,
	type ClaimTiming,
	claimReclaimBoundary,
	type EvaluateClaimRightOptions,
	evaluateClaimRight,
	type FreeClaimState,
	type PendingClaimState,
	parseClaimState,
} from "../claims/rights/index.ts";
import type {
	ClaimReadResult,
	ClaimStorageDescriptor,
	JsonObject,
	ClaimDocument as StoredClaimDocument,
} from "../claims/storage/index.ts";
// ASSUMPTION(batch reclaim): claimReclaimVerdict and ClaimReclaimPreviewEntry with the shapes of the batch reclaim
// draft (claim-reclaim-surface.test.ts:971-987); batch reclaim lands before the time path.
import {
	type ClaimDocument,
	type ClaimNextAttempt,
	type ClaimOperationDocument,
	type ClaimReclaimPreviewEntry,
	type ClaimRightsView,
	claimExitCode,
	claimNextStep,
	claimOperationDocument,
	claimReclaimVerdict,
	claimResolutionDocument,
} from "../claims/surface/index.ts";
// ASSUMPTION(scaffold): ClaimTimeBoxRequest.hardEnd?, PlanClaimTransitionOptions.timePath? and the plan cause
// pending-transition in the rejection union and REASONS.
import {
	type ClaimLeaseRequest,
	type ClaimTimeBoxRequest,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	type PlanClaimTransitionOptions,
	planClaimTransition,
} from "../claims/transition/index.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";

type Body = Record<string, unknown>;
type TtlSource = ClaimLeaseRequest["ttlSource"];
type TimeBoxSource = ClaimTimeBoxRequest["source"];
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type Rejection = Extract<ClaimTransitionPlan, { kind: "rejected" }>["cause"];
type Failure = Exclude<ClaimTransitionPlan["kind"], "planned" | "rejected">;
type Outcome = Extract<ClaimExecutionResult, { kind: "operation" }>["outcome"]["kind"];
type Verdict = {
	label: string;
	kind: string;
	cause: unknown;
	boundary: unknown;
	keys: string[];
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
};
type Case = {
	label: string;
	catches: string;
	observed: ClaimReadResult;
	request: ClaimTransitionRequest;
	changes?: Partial<PlanClaimTransitionOptions>;
};
type PlannedCase = Case & { expected: Planned };
type RejectedCase = Case & { cause: Rejection; boundary?: number };
type FollowUp = {
	action: string;
	catches: string;
	request: ClaimTransitionRequest;
	changes: Partial<PlanClaimTransitionOptions>;
};
/** A resolver answer as kind, exact keys, body (reason as a placeholder) and a count of echoed secrets. */
type LogicalView = { label: string; keys: string[]; body: Body; echoed: number };
type LogicalRow = {
	label: string;
	catches: string;
	record: ClaimIntentRecord;
	confirmation: ClaimIntentRecord | null;
	observed: ClaimReadResult;
	expected: [string, string, string, string | null] | "invalid";
};
type DocView = { label: string; exit: number; keys: string[]; body: Body; echoed: number };
type DocRow = { label: string; catches: string; document: ClaimDocument; expected: Body };
/** The executor's optional transition field before the allowlist. */
type TransitionFact = { phase: string; confirmOperationId: string | null; confirmation: ClaimExecutionStorage | null };
type TextView = {
	label: string;
	stream: string;
	head: string;
	phaseLines: number;
	phaseNamed: boolean | null;
	confirmationRetry: number;
	hints: number;
	hardEndHint: boolean;
	echoed: number;
};
type EntryView = { label: string; keys: string[] | null; entry: Body | null; echoed: number };

// Constants adapted from src/test/claim-transition-administration.test.ts:37-67 (claim-transition.test.ts:25-52).
const TICKET = "BACK-1";
/** q: the stored root the planner sees before P; the 64-hex variant for the diagnostics rows. */
const ROOT = "a1".repeat(20);
const ROOT_64 = "b2".repeat(32);
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
/** Karl is the source, Franz the target, Lena a third context; no diagnostic may echo any of them. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const LENA = `tb1-${"7a".repeat(32)}`;
/** The fresh binding of a replacement context (resume) and an unrelated transfer receiver. */
const RESUMED = `tb1-${"9d".repeat(32)}`;
const SECOND = `tb1-${"5c".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const THIRD_OWNER = "agent-sentinel-lena";
const SENTINELS = [KARL, FRANZ, LENA, RESUMED, SECOND, OWNER, OTHER_OWNER, THIRD_OWNER, ROOT, ROOT_64];

const MINUTE = 60_000;
const MAX = Number.MAX_SAFE_INTEGER;
/** "10:00"; every other instant is derived from it (claim-transition.test.ts:40-47). */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05", its reclaim boundary "10:15" and the stored hard end H_s "11:00". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;
/** The new hard end H_t "12:00" of a time-path call and a third one for a second transition. */
const H2 = H + 60 * MINUTE;
const H3 = H2 + 60 * MINUTE;
/** The hull max(R(source), R(target)) of the canonical PENDING, hard(H) to hard(H2), both with GRACE. */
const HULL = H2 + GRACE;

// Record constants adapted from src/test/claim-mutation-resolution.test.ts:37-52.
const REMOTE = "git://127.0.0.1:9/sentinel-claims.git";
/** The P operation ID; the A ID is always derived from it. */
const P_ID = "op-5d0c8a1e-2b3f-4c6d-8e9f-0a1b2c3d4e5f";
/** A fixed ID in the A form (c- plus 40 hex) for the rows that must not depend on the derivation. */
const A_LITERAL = `c-${"0f".repeat(20)}`;
/** p: the PENDING root P wrote; a: the root A wrote; a later root after a competing write. */
const P_ROOT = "c4".repeat(20);
const A_ROOT = "d5".repeat(20);
const LATER_ROOT = "e6".repeat(20);
/** The witness instant C_o, a record internal that no document or text may echo. */
const OBSERVED_AT = H - 17 * MINUTE - 1_234;
const DIGEST = "c3".repeat(32);
const SENTINEL = "SENTINEL-time-path-3f1d";
const REASON = `upstream ${SENTINEL} ${KARL} ${ROOT}`;
/** Fields a spread of an upstream object would leak into a public document (built field by field). */
const TAINT = { binding: KARL, root: P_ROOT, reason: REASON, owner: OWNER, digest: DIGEST };
/** Record internals a spread of the executor's transition field would leak (allowlist unchanged). */
const TRANSITION_TAINT = { observedAt: OBSERVED_AT, transitionDigest: DIGEST, targetBinding: FRANZ, root: A_ROOT };
/** Never in a claim-operation, claim-resolution or claim-pause document or its text. */
const SENSITIVE: readonly string[] = [
	SENTINEL,
	KARL,
	FRANZ,
	LENA,
	OWNER,
	OTHER_OWNER,
	ROOT,
	P_ROOT,
	A_ROOT,
	LATER_ROOT,
	DIGEST,
	String(OBSERVED_AT),
	REMOTE,
];
/** A preview entry may show owner names, never a binding, root or digest. */
const PREVIEW_SENSITIVE: readonly string[] = [SENTINEL, KARL, FRANZ, LENA, ROOT, DIGEST];
/** Placeholder for a non-empty upstream reason, instead of the raw text inside an expectation. */
// adapted from claim-execution-retry.test.ts:82 (ABSENT_REF)
const NONEMPTY = "(non-empty reason)";

const RECEIPTS: Record<string, JsonObject> = {
	"op-first": { schema: 1, intentDigest: "e5".repeat(32), parameterDigest: "f6".repeat(32) },
	"op-second": { schema: 1, intentDigest: "a7".repeat(32), parameterDigest: "b8".repeat(32) },
};
const EARLIER: Record<string, JsonObject> = {
	"op-earlier-1": { schema: 1, intentDigest: "a9".repeat(32), parameterDigest: "b0".repeat(32) },
};
const FOREIGN_RECEIPT: JsonObject = { schema: 1, intentDigest: "c9".repeat(32), parameterDigest: "d0".repeat(32) };

/** The closed status table, written out so the constant under test is not its own oracle. */
// adapted from claim-surface.test.ts:132-142
const EXPECTED_EXIT: Record<string, number> = {
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
/** Every plan cause of surface/index.ts:901-917 except `held` and `not-free`, written out. */
// adapted from claim-next.test.ts:264-278
const OTHER_PLAN_CAUSES: readonly string[] = [
	"not-holder",
	"free",
	"absent",
	"generation-changed",
	"not-renewable",
	"never",
	"hard-expired",
	"overlong",
	"not-yet",
	"time-box-required",
	"requires-time-path",
	"lease-required",
	"mode-change",
];
/** Lines operationText writes for every operation document (claim-text.ts:105, :120-132); others count as hints. */
const STANDARD_LINES: readonly string[] = [
	"  boundary:",
	"  operation:",
	"  storage:",
	"  sends:",
	"  planned:",
	"  rights:",
	"  next:",
	"  while it stays open:",
];
const ROLES: readonly [string, string][] = [
	["source", KARL],
	["target", FRANZ],
	["third party", LENA],
];

// ---------------------------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-transition.test.ts:79-82
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface.test.ts:190-193
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-reclaim-surface.test.ts:341-343, with the value list per output
function echoes(text: string, values: readonly string[]): number {
	return values.filter((value) => value !== "" && text.includes(value)).length;
}

// adapted from claim-surface-administration.test.ts:449-452
function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

/** A typed result as a plain record: bun-types checks `toEqual(expected: T)` against the actual's type. */
// adapted from claim-next.test.ts:357-360
function plain(value: object): Body {
	return Object.fromEntries(Object.entries(value));
}

function sortedKeys(value: object): string[] {
	return Object.keys(value).sort(byCodeUnits);
}

/** A fresh JSON copy for record and payload fields. */
function jsonOf(value: object): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** A shallow copy of `value` without `key`, built without `delete`. */
// adapted from claim-transition-administration.test.ts:142-145
function without(value: object, key: string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** A copy whose `key` is an enumerable getter instead of a data property. */
// adapted from claim-transition-administration.test.ts:147-152
function withAccessor<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

/** A copy whose `key` is a non-enumerable data property. */
// adapted from claim-transition-administration.test.ts:154-159
function withHidden<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { value: result, enumerable: false, configurable: true, writable: true });
	return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// States: ACTIVE fixtures adapted from claim-transition-administration.test.ts:101-176
// ---------------------------------------------------------------------------------------------------------------

function lease(leaseEnd = L, hardEnd: number | null = null, graceMs = GRACE): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs, hardEnd };
}

function hard(hardEnd = H, graceMs = GRACE): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs };
}

const TIMELESS: ClaimTiming = { mode: "none" };

function active(timing: ClaimTiming, changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 3,
		bindingGeneration: 1,
		owner: OWNER,
		binding: KARL,
		timing,
		...changes,
	};
}

/** The transfer target (transition/index.ts:294-304): generation plus one, binding generation 1, Franz. */
function transferred(timing: ClaimTiming, changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
	return active(timing, { claimGeneration: 4, bindingGeneration: 1, owner: OTHER_OWNER, binding: FRANZ, ...changes });
}

function tombstone(claimGeneration: number): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/** Exactly {claimState, status, claimGeneration, source, target}, the generation being the target's. */
function pending(source: ActiveClaimState, target: ActiveClaimState): PendingClaimState {
	return { claimState: 1, status: "pending", claimGeneration: target.claimGeneration, source, target };
}

/** The canonical transfer PENDING: Karl's hard(H) restarted to Franz with H2; generation 4, hull H2 + GRACE. */
function transferPending(): PendingClaimState {
	return pending(active(hard()), transferred(hard(H2)));
}

/** The canonical bound PENDING: Karl extends hard(H) to hard(H2); generation 3, hull H2 + GRACE. */
function boundPending(): PendingClaimState {
	return pending(active(hard()), active(hard(H2)));
}

// adapted from claim-transition-administration.test.ts:161-176
function documentOf(payload: unknown): StoredClaimDocument {
	return {
		schema: 1,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		revision: 2,
		payload,
		receipts: structuredClone(RECEIPTS),
	} as unknown as StoredClaimDocument;
}

function present(payload: unknown, root = ROOT): ClaimReadResult {
	return { kind: "present", ticket: TICKET, root, document: documentOf(payload) };
}

const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: REASON };
const CORRUPT_PAYLOAD: ClaimReadResult = present({ state: "claimed" });

// ---------------------------------------------------------------------------------------------------------------
// Rights
// ---------------------------------------------------------------------------------------------------------------

function evaluate(observed: ClaimReadResult, changes: Partial<EvaluateClaimRightOptions> = {}): ClaimRightEvaluation {
	return evaluateClaimRight({
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed,
		binding: KARL,
		now: T,
		clockSkewMs: EPS,
		...changes,
	});
}

/** For every binding ownership `pending`, no work right with cause `pending`, reclaim against the hull. */
function pendingRight(reclaim: "eligible" | "not-yet", boundary: number, claimGeneration = 4): Body {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: ROOT,
		claimGeneration,
		ownership: "pending",
		workRight: { kind: "none", cause: "pending" },
		reclaim: { kind: reclaim, boundary },
	};
}

function expectEvaluation(label: string, actual: ClaimRightEvaluation, expected: Body): void {
	expect({ label, result: plain(actual) }).toStrictEqual({ label, result: expected });
}

/** A decoder or evaluator failure: exactly kind and a non-empty reason that echoes no sentinel. */
// adapted from claim-rights.test.ts:192-209
function failureView(label: string, result: object, values: readonly string[] = []): Body {
	const reason = field(result, "reason");
	const text = typeof reason === "string" ? reason : "";
	return {
		label,
		kind: field(result, "kind"),
		keys: sortedKeys(result),
		reasonType: typeof reason,
		reasonEmpty: text.length === 0,
		echoed: echoes(text, [...SENTINELS, ...values]),
	};
}

function failureExpected(label: string, kind: string): Body {
	return { label, kind, keys: ["kind", "reason"], reasonType: "string", reasonEmpty: false, echoed: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Planner: requests and checks adapted from claim-transition-administration.test.ts:204-385
// ---------------------------------------------------------------------------------------------------------------

function acquire(): ClaimTransitionRequest {
	return {
		action: "acquire",
		owner: THIRD_OWNER,
		timing: { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null },
	};
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

function resume(): ClaimTransitionRequest {
	return { action: "resume" };
}

function leaseOf(ttlMs = TTL, ttlSource: TtlSource = "default"): ClaimLeaseRequest {
	return { ttlMs, ttlSource };
}

function preserve(source: TimeBoxSource = "explicit"): ClaimTimeBoxRequest {
	return { action: "preserve", source };
}

/** The transition restart without values. */
function restart(source: TimeBoxSource = "explicit"): ClaimTimeBoxRequest {
	return { action: "restart", source };
}

/** `--time-box restart --hard-end <iso>` as an absolute H_t in the time box. */
function restartTo(hardEnd: number, source: TimeBoxSource = "explicit"): ClaimTimeBoxRequest {
	return { action: "restart", source, hardEnd };
}

function transfer(
	timeBox: ClaimTimeBoxRequest | null,
	fresh: ClaimLeaseRequest | null = null,
	owner = OTHER_OWNER,
): ClaimTransitionRequest {
	return { action: "transfer", owner, timeBox, lease: fresh };
}

function changeBounds(timing: ClaimTiming): ClaimTransitionRequest {
	return { action: "change-bounds", timing };
}

/** Deliberately malformed data for invalid-request controls. */
function asRequest(value: unknown): ClaimTransitionRequest {
	return value as ClaimTransitionRequest;
}

function asTimeBox(value: unknown): ClaimTimeBoxRequest {
	return value as ClaimTimeBoxRequest;
}

/** The option the surface sets to `settings.enabled`; default off. */
const TIME_PATH: Partial<PlanClaimTransitionOptions> = { timePath: true };
const TO_FRANZ: Partial<PlanClaimTransitionOptions> = { targetBinding: FRANZ };
const TO_FRANZ_T: Partial<PlanClaimTransitionOptions> = { targetBinding: FRANZ, timePath: true };

function optionsOf(
	observed: ClaimReadResult,
	request: ClaimTransitionRequest,
	changes: Partial<PlanClaimTransitionOptions> = {},
): PlanClaimTransitionOptions {
	return {
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed,
		binding: KARL,
		request,
		now: T,
		clockSkewMs: EPS,
		...changes,
	};
}

function plan(
	observed: ClaimReadResult,
	request: ClaimTransitionRequest,
	changes: Partial<PlanClaimTransitionOptions> = {},
): ClaimTransitionPlan {
	return planClaimTransition(optionsOf(observed, request, changes));
}

function plannedFor(
	request: ClaimTransitionRequest,
	next: ClaimStateV1,
	expectedRoot: string | null = ROOT,
	observedClaimGeneration: number | null = 3,
): Planned {
	return {
		kind: "planned",
		scope: "state-plan-only",
		action: request.action,
		expectedRoot,
		observedClaimGeneration,
		request,
		next,
	};
}

function plannedResult(label: string, result: ClaimTransitionPlan): Planned {
	if (result.kind !== "planned") throw new Error(`${label}: expected planned, got ${result.kind}`);
	return result;
}

function expectPlanned(label: string, actual: ClaimTransitionPlan, expected: Planned): void {
	expect({ label, result: actual }).toStrictEqual({ label, result: expected });
}

/** Kind, cause, boundary and exact keys; the reason only as type, emptiness and a count of echoed sentinels. */
function verdictOf(label: string, result: ClaimTransitionPlan, values: string[]): Verdict {
	const view = result as { kind: string; cause?: unknown; boundary?: unknown; reason?: unknown };
	const text = typeof view.reason === "string" ? view.reason : "";
	return {
		label,
		kind: view.kind,
		cause: view.cause,
		boundary: view.boundary,
		keys: sortedKeys(result),
		reasonType: typeof view.reason,
		reasonEmpty: text.length === 0,
		echoed: [...SENTINELS, ...values].filter((value) => value !== "" && text.includes(value)).length,
	};
}

/** A rejection has exactly kind, cause and reason, plus boundary for the bounded causes (adds one). */
function expectRejected(
	label: string,
	result: ClaimTransitionPlan,
	cause: Rejection,
	boundary?: number,
	values: string[] = [],
): void {
	const expected: Verdict = {
		label,
		kind: "rejected",
		cause,
		boundary,
		keys: boundary === undefined ? ["cause", "kind", "reason"] : ["boundary", "cause", "kind", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
	expect(verdictOf(label, result, values)).toStrictEqual(expected);
}

function expectFailure(label: string, result: ClaimTransitionPlan, kind: Failure, values: string[] = []): void {
	const expected: Verdict = {
		label,
		kind,
		cause: undefined,
		boundary: undefined,
		keys: ["kind", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
	expect(verdictOf(label, result, values)).toStrictEqual(expected);
}

function checkPlanned(cases: PlannedCase[]): void {
	for (const { label, catches, observed, request, changes, expected } of cases) {
		expectPlanned(`${label} (catches: ${catches})`, plan(observed, request, changes), expected);
	}
}

function checkRejected(cases: RejectedCase[]): void {
	for (const { label, catches, observed, request, changes, cause, boundary } of cases) {
		expectRejected(`${label} (catches: ${catches})`, plan(observed, request, changes), cause, boundary);
	}
}

/** The three negative controls of claim-transition.test.ts:1369-1374: plannable, unreachable, corrupt payload. */
// adapted from claim-transition-administration.test.ts:375-385
function expectInvalidEverywhere(
	label: string,
	observed: ClaimReadResult,
	request: ClaimTransitionRequest,
	changes: Partial<PlanClaimTransitionOptions>,
): void {
	expectFailure(`${label} on a plannable observation`, plan(observed, request, changes), "invalid");
	expectFailure(`${label} on an unreachable read`, plan(UNREACHABLE, request, changes), "invalid");
	expectFailure(`${label} on a corrupt payload`, plan(CORRUPT_PAYLOAD, request, changes), "invalid");
}

/** Every action but reclaim, by the binding of `role`; resume by a replacement with that old proof. */
function followUps(binding: string): FollowUp[] {
	return [
		{
			action: "acquire",
			catches: "PENDING read as free (transition/index.ts:386-387), a second holder",
			request: acquire(),
			changes: { binding },
		},
		{ action: "renew", catches: "the source renewing its old window", request: renew(), changes: { binding } },
		{ action: "release", catches: "a release on PENDING (judge:21)", request: release(), changes: { binding } },
		{
			action: "transfer",
			catches: "a transfer on top of an unresolved one",
			request: transfer(preserve(), leaseOf()),
			changes: { binding, targetBinding: SECOND },
		},
		{
			action: "resume",
			catches: "a resume straight onto PENDING (RESULT:71)",
			request: resume(),
			changes: { binding: RESUMED, recoveryBinding: binding },
		},
		{
			action: "change-bounds",
			catches: "a bound change on PENDING",
			request: changeBounds(hard(H2 - 10 * MINUTE)),
			changes: { binding },
		},
		{
			action: "change-bounds with timePath",
			catches: "a second unresolved transition per ticket",
			request: changeBounds(hard(H3)),
			changes: { binding, timePath: true },
		},
		{
			action: "restart with timePath",
			catches: "a second restart on top of the unresolved one",
			request: transfer(restartTo(H3)),
			changes: { binding, targetBinding: SECOND, timePath: true },
		},
	];
}

// ---------------------------------------------------------------------------------------------------------------
// P and A records: reference digests adapted from claim-mutation-resolution.test.ts:73-124
// ---------------------------------------------------------------------------------------------------------------

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
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

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

function receiptOf(record: ClaimIntentRecord): JsonObject {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

function sourceOf(): ClaimMutationSource {
	return { remote: REMOTE, descriptor: { schema: 1, format: "blob", epoch: 1 } };
}

/** The derived A ID; a function, so a scaffold stub can never fail the module load. */
function confirmId(): string {
	return claimConfirmationId(P_ID);
}

/**
 * The P intent of the canonical restart, expected root q, targetBinding = target.binding, parameters =
 * the request, resolved.next = the planned PENDING (execution/index.ts:346-369 with the time path targetBinding rule).
 */
function transitionRecord(changes: Partial<ClaimOperationIntent> = {}): ClaimIntentRecord {
	return recordOf({
		operationId: P_ID,
		remote: REMOTE,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		expectedRoot: ROOT,
		targetBinding: FRANZ,
		action: "transfer",
		parameters: jsonOf(transfer(restartTo(H2))),
		resolved: { next: jsonOf(transferPending()) },
		...changes,
	});
}

/**
 * The A intent, the persisted witness against exactly p, with `resolved.next` = target. ASSUMPTION
 * (time path): A carries P's action (execution/index.ts:604-606 resends only the seven actions). `parameters` overrides
 * single witness fields.
 */
function confirmationRecord(
	transition: ClaimIntentRecord,
	parameters: Body = {},
	changes: Partial<ClaimOperationIntent> = {},
): ClaimIntentRecord {
	return recordOf({
		operationId: confirmId(),
		remote: REMOTE,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		expectedRoot: P_ROOT,
		targetBinding: FRANZ,
		action: "transfer",
		parameters: jsonOf({
			stage: "confirm",
			transition: transition.intent.operationId,
			transitionDigest: transition.digest,
			observedAt: OBSERVED_AT,
			clockSkewMs: EPS,
			observeBefore: H,
			...parameters,
		}),
		resolved: { next: jsonOf(transferred(hard(H2))) },
		...changes,
	});
}

function snapshotAt(root: string, revision: number, receipts: Record<string, JsonObject>, payload: object) {
	const document: StoredClaimDocument = {
		schema: 1,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		revision,
		payload: jsonOf(payload),
		receipts,
	};
	const observed: ClaimReadResult = { kind: "present", ticket: TICKET, root, document };
	return observed;
}

/** q: nothing of P landed; Karl's ACTIVE state. */
function atQ(): ClaimReadResult {
	return snapshotAt(ROOT, 1, { ...EARLIER }, active(hard()));
}

/** p: P landed with its receipt, A not (yet). */
function atP(transition: ClaimIntentRecord): ClaimReadResult {
	return snapshotAt(P_ROOT, 2, { ...EARLIER, [P_ID]: receiptOf(transition) }, transferPending());
}

/** a: A landed on p with its receipt; the target is ACTIVE. */
function atA(transition: ClaimIntentRecord, confirmation: ClaimIntentRecord): ClaimReadResult {
	const receipts = {
		...EARLIER,
		[P_ID]: receiptOf(transition),
		[confirmation.intent.operationId]: receiptOf(confirmation),
	};
	return snapshotAt(A_ROOT, 3, receipts, transferred(hard(H2)));
}

/** A reclaim after the hull superseded p; revision 3 is complete history, revision 4 is not. */
function reclaimedAfterP(transition: ClaimIntentRecord, revision = 3): ClaimReadResult {
	const receipts = { ...EARLIER, [P_ID]: receiptOf(transition), "op-reclaim": { ...FOREIGN_RECEIPT } };
	return snapshotAt(LATER_ROOT, revision, receipts, tombstone(4));
}

function resolveTransition(
	record: ClaimIntentRecord,
	confirmation: ClaimIntentRecord | null,
	observed: ClaimReadResult,
): object {
	return resolveClaimTransition({ record, confirmation, source: sourceOf(), observed });
}

function logicalView(label: string, result: object, values: readonly string[] = []): LogicalView {
	const body = plain(result);
	if (typeof body.reason === "string") body.reason = body.reason.length > 0 ? NONEMPTY : "";
	const secrets = [REMOTE, KARL, FRANZ, OWNER, OTHER_OWNER, ROOT, P_ROOT, A_ROOT, LATER_ROOT, ...values];
	return { label, keys: sortedKeys(result), body, echoed: echoes(JSON.stringify(result), secrets) };
}

/**
 * The result: the logical kind, the phase, the P
 * resolution and the A resolution or null. ASSUMPTION(time path): the field names `transition` and `confirmation`.
 */
function logical(label: string, expected: LogicalRow["expected"]): LogicalView {
	const body: Body =
		expected === "invalid"
			? { kind: "invalid", reason: NONEMPTY }
			: { kind: expected[0], phase: expected[1], transition: expected[2], confirmation: expected[3] };
	return { label, keys: sortedKeys(body), body, echoed: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Surface: results and documents adapted from claim-surface-administration.test.ts:449-600
// ---------------------------------------------------------------------------------------------------------------

/** The fresh rights view of Karl after a confirmed extension to H2. */
function heldAfterExtension(): ClaimRightEvaluation {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: A_ROOT,
		claimGeneration: 3,
		ownership: "held",
		workRight: { kind: "live", renewalDue: null },
		reclaim: { kind: "not-yet", boundary: HULL },
	};
}

/** For a transfer: the source's view after A, the claim at generation 4 with Franz. */
function foreignAfterRestart(): ClaimRightEvaluation {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: A_ROOT,
		claimGeneration: 4,
		ownership: "foreign",
		workRight: { kind: "none", cause: "not-holder" },
		reclaim: { kind: "not-yet", boundary: HULL },
	};
}

/** As the executor reports it on an unresolved PENDING (typed through the scaffold's widened union). */
function pendingEvaluation(claimGeneration: number): ClaimRightEvaluation {
	const evaluation: Body = {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: P_ROOT,
		claimGeneration,
		ownership: "pending",
		workRight: { kind: "none", cause: "pending" },
		reclaim: { kind: "not-yet", boundary: HULL },
	};
	return evaluation as unknown as ClaimRightEvaluation;
}

const HELD_VIEW: Body = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "held",
	claimGeneration: 3,
	workRight: { kind: "live", renewalDue: null },
	reclaim: { kind: "not-yet", boundary: HULL },
};

const FOREIGN_VIEW: ClaimRightsView = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "foreign",
	claimGeneration: 4,
	workRight: { kind: "none", cause: "not-holder" },
	reclaim: { kind: "not-yet", boundary: HULL },
};

/** RightsView gains ownership and cause `pending`; never the observed root. */
function pendingView(claimGeneration: number): Body {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: "pending",
		claimGeneration,
		workRight: { kind: "none", cause: "pending" },
		reclaim: { kind: "not-yet", boundary: HULL },
	};
}

function fact(
	phase: string,
	confirmOperationId: string | null,
	confirmation: ClaimExecutionStorage | null,
): TransitionFact {
	return { phase, confirmOperationId, confirmation };
}

/**
 * A T call's executor result, tainted like claim-surface-administration.test.ts:474-498. ASSUMPTION(time path): the
 * optional `transition` with phase, confirmOperationId, confirmation, observeBefore and reclaimBoundary.
 */
function transitionResult(
	outcome: Outcome,
	storage: ClaimExecutionStorage,
	sends: number,
	rights: ClaimRightEvaluation,
	transition: TransitionFact | null,
	action = "change-bounds",
): ClaimExecutionResult {
	const result: Body = {
		kind: "operation",
		scope: "transition-execution-only",
		action,
		operationId: P_ID,
		storage: tainted(storage),
		outcome: { kind: outcome },
		rights: tainted(rights),
		sends,
		...TAINT,
	};
	if (transition !== null) {
		const { confirmation } = transition;
		result.transition = {
			...transition,
			confirmation: confirmation === null ? null : tainted(confirmation),
			observeBefore: H,
			reclaimBoundary: HULL,
			...TRANSITION_TAINT,
		};
	}
	return result as unknown as ClaimExecutionResult;
}

function mapped(
	result: ClaimExecutionResult,
	stoppedBy: "attempts" | "budget" | null = null,
	command: "change-bounds" | "transfer" | "retry" = "change-bounds",
): ClaimDocument {
	const retry = command === "retry" ? { operationId: P_ID } : {};
	return claimOperationDocument({ command, ticket: TICKET, result, planned: null, stoppedBy, ...retry });
}

/** Exactly phase, confirmOperationId, observeBefore, reclaimBoundary and confirmation. */
function transitionBody(phase: string, confirmOperationId: string | null, confirmation: Body | null): Body {
	return { phase, confirmOperationId, observeBefore: H, reclaimBoundary: HULL, confirmation };
}

/** The base claim-operation keys, plus `transition` only for a T call (D documents keep their keys). */
function operationBody(fields: {
	command?: string;
	action?: string;
	status: string;
	outcome: string;
	operationId?: string | null;
	rejection?: Body | null;
	storage: Body | null;
	sends: number;
	stoppedBy?: string | null;
	rights: Body;
	transition?: Body;
}): Body {
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-operation",
		status: fields.status,
		command: fields.command ?? "change-bounds",
		action: fields.action ?? "change-bounds",
		ticket: TICKET,
		operationId: fields.operationId === undefined ? P_ID : fields.operationId,
		outcome: fields.outcome,
		rejection: fields.rejection ?? null,
		storage: fields.storage,
		sends: fields.sends,
		stoppedBy: fields.stoppedBy ?? null,
		planned: null,
		rights: fields.rights,
	};
	if (fields.transition !== undefined) body.transition = fields.transition;
	return body;
}

// adapted from claim-surface-administration.test.ts:572-599 (viewOf, expectedView)
function docView(label: string, doc: ClaimDocument): DocView {
	return {
		label,
		exit: claimExitCode(doc),
		keys: sortedKeys(doc),
		body: plain(doc),
		echoed: echoes(JSON.stringify(doc), SENSITIVE),
	};
}

function expectedDoc(label: string, body: Body): DocView {
	return { label, exit: EXPECTED_EXIT[String(body.status)] ?? -1, keys: sortedKeys(body), body, echoed: 0 };
}

function checkDocs(rows: DocRow[]): void {
	for (const row of rows) {
		const label = `${row.label} (catches: ${row.catches})`;
		expect(docView(label, row.document)).toEqual(expectedDoc(label, row.expected));
	}
}

/** A plan rejection persists nothing and carries no operation ID (surface/index.ts:1225-1255). */
function planRejected(cause: string, boundary?: number): ClaimOperationDocument {
	const rejection: ClaimOperationDocument["rejection"] =
		boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "rejected",
		command: "acquire",
		action: "acquire",
		ticket: TICKET,
		operationId: null,
		outcome: "rejected",
		rejection,
		storage: null,
		sends: 0,
		stoppedBy: null,
		planned: null,
		rights: FOREIGN_VIEW,
	};
}

function pauseDoc(operationIds: string[]): ClaimNextAttempt {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "acquire",
		action: "acquire",
		ticket: TICKET,
		operationId: null,
		pause: { kind: "outstanding", operationIds },
		rights: FOREIGN_VIEW,
	};
}

/**
 * The composite answer of `queryClaimTransition`. ASSUMPTION(time path): `claim resolve <P-ID>`
 * hands it to the same mapper as `result`; `query` shows the P resolution.
 */
function compositeQuery(kind: string, phase: string, transition: string, confirmation: string | null): unknown {
	return { kind: "resolved", resolution: tainted({ kind, phase, transition, confirmation }) };
}

function resolutionDoc(result: unknown): ClaimDocument {
	const query = result as ClaimMutationQueryResult;
	return claimResolutionDocument({ operationId: P_ID, ticket: TICKET, action: "transfer", result: query });
}

function resolutionBody(outcome: string, resolution: string, transition?: Body): Body {
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-resolution",
		status: outcome,
		command: "resolve",
		operationId: P_ID,
		ticket: TICKET,
		action: "transfer",
		outcome,
		query: { kind: "resolved", resolution },
	};
	if (transition !== undefined) body.transition = transition;
	return body;
}

/** A literal public document for the renderer alone, independent of the mapper (typed through the scaffold). */
function asDocument(body: Body): ClaimDocument {
	return body as unknown as ClaimDocument;
}

/**
 * On the rendered text: the status head, lines naming the word `phase` (and the phase), the exact
 * `backlog claim retry <A-ID> --context <context>` hint, other hint lines and a `--hard-end` mention.
 */
// adapted from claim-administration-commands.test.ts:684-705 (humanView)
function textView(label: string, doc: ClaimDocument, phase: string | null): TextView {
	const { stdout, stderr } = formatClaimDocumentText(doc);
	const lines = (stdout === "" ? stderr : stdout).split("\n").filter((line) => line !== "");
	const first = lines[0] ?? "";
	const rest = lines.slice(1);
	const retry = `backlog claim retry ${confirmId()} --context <context>`;
	const phaseLine = (line: string) => /\bphase\b/.test(line);
	const hint = (line: string) =>
		!phaseLine(line) && !line.includes(retry) && !STANDARD_LINES.some((prefix) => line.startsWith(prefix));
	return {
		label,
		stream: stdout !== "" && stderr === "" ? "stdout" : "stderr or mixed",
		head: first.slice(0, Math.max(0, first.indexOf(":"))),
		phaseLines: rest.filter(phaseLine).length,
		phaseNamed: phase === null ? null : rest.some((line) => phaseLine(line) && line.includes(phase)),
		confirmationRetry: rest.filter((line) => line.includes(retry)).length,
		hints: rest.filter(hint).length,
		hardEndHint: rest.some((line) => line.includes("--hard-end")),
		echoed: echoes(stdout + stderr, SENSITIVE),
	};
}

function textExpected(
	label: string,
	head: string,
	phase: string | null,
	fields: { confirmationRetry?: number; hints?: number; hardEndHint?: boolean } = {},
): TextView {
	return {
		label,
		stream: "stdout",
		head,
		phaseLines: phase === null ? 0 : 1,
		phaseNamed: phase === null ? null : true,
		confirmationRetry: fields.confirmationRetry ?? 0,
		hints: fields.hints ?? 0,
		hardEndHint: fields.hardEndHint ?? false,
		echoed: 0,
	};
}

/**
 * The batch reclaim preview verdict of one stored state (claim-reclaim-surface.test.ts:971-987), seen by Lena unless a
 * row names another.
 */
function verdictFor(
	state: object,
	now: number,
	claimOwners: string[] | null,
	binding = LENA,
): ClaimReclaimPreviewEntry | null {
	return claimReclaimVerdict({
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed: present(state),
		binding,
		now,
		clockSkewMs: EPS,
		claimOwners,
	});
}

// adapted from claim-reclaim-surface.test.ts:989-1001
function entryView(label: string, entry: object | null): EntryView {
	if (entry === null) return { label, keys: null, entry: null, echoed: 0 };
	return {
		label,
		keys: sortedKeys(entry),
		entry: plain(entry),
		echoed: echoes(JSON.stringify(entry), PREVIEW_SENSITIVE),
	};
}

/** Ticket, verdict, claimGeneration, transition {from, to} and the hull; never owner or timing. */
function previewEntry(
	label: string,
	verdict: string,
	claimGeneration: number,
	from: string,
	to: string,
	boundary = HULL,
): EntryView {
	const entry: Body = { ticket: TICKET, verdict, claimGeneration, transition: { from, to }, boundary };
	return { label, keys: sortedKeys(entry), entry, echoed: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe("PENDING state in the rights module", () => {
	test("pen-01: decodes PENDING in transfer and bound form, hard and lease with H, input unchanged", () => {
		// Positive control (catches: PENDING still unsupported, rights/index.ts:163-165; the scaffold's decoder).
		expect(plain(parseClaimState(transferPending()))).toStrictEqual({ kind: "state", state: transferPending() });
		const states: [string, string, PendingClaimState][] = [
			["transfer, hard", "the transfer form not decoded", transferPending()],
			[
				"transfer, lease with H",
				"a lease PENDING not decoded",
				pending(active(lease(L, H)), transferred(lease(T + TTL, H2))),
			],
			[
				"transfer, lease capped at H2 with the stored grace",
				"a lease end equal to H_t refused",
				pending(active(lease(L, H, 2 * GRACE)), transferred(lease(H2, H2, 2 * GRACE))),
			],
			["bound, hard", "the bound form not decoded", boundPending()],
			[
				"bound, hard with another grace",
				"the target grace pinned to the source grace in the bound form (timing may change as a whole)",
				pending(active(hard()), active(hard(H2, 0))),
			],
			[
				"bound, lease with H",
				"a bound lease PENDING not decoded",
				pending(active(lease(L, H)), active(lease(L + MINUTE, H2))),
			],
			[
				"transfer from a resumed source (binding generation 4)",
				"the source binding generation checked as 1",
				pending(active(hard(), { bindingGeneration: 4, binding: RESUMED }), transferred(hard(H2))),
			],
			[
				"transfer to the same display name",
				"the owner name taken as identity",
				pending(active(hard()), transferred(hard(H2), { owner: OWNER })),
			],
			[
				"largest safe generation",
				"an overflow check on a safe target generation",
				pending(active(hard(), { claimGeneration: MAX - 1 }), transferred(hard(H2), { claimGeneration: MAX })),
			],
		];
		for (const [name, catches, state] of states) {
			const label = `${name} (catches: ${catches})`;
			const input = structuredClone(state);
			expect({ label, result: plain(parseClaimState(input)) }).toStrictEqual({
				label,
				result: { kind: "state", state },
			});
			// catches: a decoder that normalizes or strips its input in place
			expect({ label, input }).toStrictEqual({ label, input: state });
		}
	});

	test("pen-02: rejects every PENDING violation as corrupt, never unsupported or a state", () => {
		// Positive control (catches: a decoder that calls every PENDING corrupt).
		expect(plain(parseClaimState(boundPending()))).toStrictEqual({ kind: "state", state: boundPending() });
		const base = transferPending();
		const rows: [string, string, unknown][] = [
			["missing source", "a PENDING without its source accepted", without(base, "source")],
			["missing target", "a PENDING without its target accepted", without(base, "target")],
			["missing claimGeneration", "the generation defaulted", without(base, "claimGeneration")],
			["extra field observeBefore", "an extra field accepted", { ...base, observeBefore: H }],
			["extra ACTIVE field owner", "ACTIVE fields on PENDING accepted", { ...base, owner: OWNER }],
			[
				"source without H (pure lease)",
				"an unbounded source accepted (the witness deadline is H_s)",
				pending(active(lease(L, null)), transferred(lease(T + TTL, H2))),
			],
			["timeless source", "a timeless source accepted", pending(active(TIMELESS), transferred(hard(H2)))],
			["H_t equal to H_s", "`<=` for `<` on H_t > H_s", pending(active(hard()), transferred(hard(H)))],
			["H_t before H_s", "a shortening stored as PENDING", pending(active(hard()), transferred(hard(H - MINUTE)))],
			[
				"target without H",
				"an unbounded target accepted",
				pending(active(lease(L, H)), transferred(lease(T + TTL, null))),
			],
			[
				"mode change hard to lease",
				"a mode change inside PENDING",
				pending(active(hard()), transferred(lease(T + TTL, H2))),
			],
			[
				"mode change lease to hard",
				"a mode change inside PENDING",
				pending(active(lease(L, H)), transferred(hard(H2))),
			],
			[
				"transfer form with the source generation",
				"the generation taken from the source",
				{ ...base, claimGeneration: 3 },
			],
			[
				"bound form with generation plus one",
				"a generation of neither side",
				{ ...boundPending(), claimGeneration: 4 },
			],
			[
				"transfer target with binding generation 2",
				"binding generation 1 not enforced on a transfer",
				pending(active(hard()), transferred(hard(H2), { bindingGeneration: 2 })),
			],
			[
				"transfer target with the source binding",
				"a transfer onto the own binding",
				pending(active(hard()), transferred(hard(H2), { binding: KARL })),
			],
			[
				"target generation plus two",
				"neither the transfer nor the bound form",
				pending(active(hard()), transferred(hard(H2), { claimGeneration: 5 })),
			],
			[
				"bound form with another owner",
				"the bound form changing more than the timing",
				pending(active(hard()), active(hard(H2), { owner: OTHER_OWNER })),
			],
			[
				"bound form with another binding",
				"the bound form changing more than the timing",
				pending(active(hard()), active(hard(H2), { binding: FRANZ })),
			],
			[
				"bound form with another binding generation",
				"the bound form changing more than the timing",
				pending(active(hard()), active(hard(H2), { bindingGeneration: 2 })),
			],
			[
				"target hard end plus grace unsafe",
				"an unsafe hull (rights ACTIVE rules, rights/index.ts:143)",
				pending(active(hard()), transferred(hard(MAX - 5, 10))),
			],
			[
				"target with an uppercase binding",
				"the rights ACTIVE rules skipped for the target",
				pending(active(hard()), transferred(hard(H2), { binding: FRANZ.toUpperCase() })),
			],
			[
				"source with an empty owner",
				"the rights ACTIVE rules skipped for the source",
				pending(active(hard(), { owner: "" }), transferred(hard(H2))),
			],
			["source a tombstone", "a FREE source accepted", { ...base, source: tombstone(3) }],
			["target a nested PENDING", "a PENDING target accepted", { ...base, target: boundPending() }],
			["source null", "a null side accepted", { ...base, source: null }],
			["generation zero", "a non-positive generation accepted", { ...base, claimGeneration: 0 }],
			[
				"target accessor field",
				"an accessor read on a nested state",
				{ ...base, target: withAccessor(transferred(hard(H2)), "binding", FRANZ) },
			],
			["hidden extra field", "a non-enumerable field ignored", withHidden(base, "note", 1)],
		];
		for (const [name, catches, payload] of rows) {
			const label = `${name} (catches: ${catches})`;
			expect(failureView(label, parseClaimState(payload))).toEqual(failureExpected(label, "corrupt"));
			// catches: an evaluator that grants anything on an invalid PENDING (corrupt, never a right)
			expect(failureView(`${label} evaluated`, evaluate(present(payload)))).toEqual(
				failureExpected(`${label} evaluated`, "corrupt"),
			);
		}
	});

	test("pen-03: gives source, target and third party ownership pending, no work right and the hull", () => {
		const observed = present(transferPending());
		// Positive control (catches: the target read as live on PENDING, the model's "work before A").
		expectEvaluation("target", evaluate(observed, { binding: FRANZ }), pendingRight("not-yet", HULL));
		const rows: [string, string, Partial<EvaluateClaimRightOptions>][] = [
			["source", "the source still held before H_s (it stops before sending, as documented)", { binding: KARL }],
			["third party", "a third binding read as free or foreign", { binding: LENA }],
			[
				"source expecting its old generation",
				"the source's old generation reviving a right",
				{ binding: KARL, expectedClaimGeneration: 3 },
			],
			[
				"target expecting the PENDING generation",
				"a matching expectation granting the target a right",
				{ binding: FRANZ, expectedClaimGeneration: 4 },
			],
			[
				"target with a wrong expectation",
				"generation-changed instead of pending (co-plan pen-03)",
				{ binding: FRANZ, expectedClaimGeneration: 9 },
			],
			["source one minute before H", "a live right from the source's own timing", { binding: KARL, now: H - MINUTE }],
			[
				"target after H2",
				"hard-expired read from the target's timing instead of pending",
				{ binding: FRANZ, now: H2 + MINUTE },
			],
		];
		for (const [name, catches, changes] of rows) {
			expectEvaluation(`${name} (catches: ${catches})`, evaluate(observed, changes), pendingRight("not-yet", HULL));
		}
		expectEvaluation(
			"bound form, Karl on both sides (catches: the bound form read as held)",
			evaluate(present(boundPending())),
			pendingRight("not-yet", HULL, 3),
		);
		// catches: a work right after the hull, or ownership back once the claim is reclaimable
		expectEvaluation(
			"target after the hull",
			evaluate(observed, { binding: FRANZ, now: HULL + EPS }),
			pendingRight("eligible", HULL),
		);
	});

	test("pen-04: reclaims PENDING only at C - eps >= max(R(source), R(target)), in every mix", () => {
		// Positive control (catches: the hull never reached, the scaffold's null boundary).
		expectEvaluation(
			"transfer at the hull",
			evaluate(present(transferPending()), { binding: LENA, now: HULL + EPS }),
			pendingRight("eligible", HULL),
		);
		const rows: { name: string; catches: string; state: PendingClaimState; hull: number; lower: number }[] = [
			{
				name: "hard to hard, R_t > R_s",
				catches: "reclaim after the source's R alone (model old_reclaim_horizon)",
				state: transferPending(),
				hull: HULL,
				lower: H + GRACE,
			},
			{
				name: "lease bound, R_s > R_t",
				catches: "the target's R alone",
				state: pending(active(lease(H - MINUTE, H)), active(lease(L, H2))),
				hull: H - MINUTE + GRACE,
				lower: R,
			},
			{
				name: "lease transfer, R_t > R_s",
				catches: "the lease end instead of lease end plus grace",
				state: pending(active(lease(L, H)), transferred(lease(H2 - 5 * MINUTE, H2))),
				hull: H2 - 5 * MINUTE + GRACE,
				lower: R,
			},
			{
				name: "hard bound, R_s > R_t by grace",
				catches: "the hard ends compared without grace",
				state: pending(active(hard(H, 2 * GRACE)), active(hard(H + MINUTE, 0))),
				hull: H + 2 * GRACE,
				lower: H + MINUTE,
			},
		];
		for (const row of rows) {
			const observed = present(row.state);
			const at = (when: string, now: number, reclaimKind: "eligible" | "not-yet") =>
				expectEvaluation(
					`${row.name}, ${when} (catches: ${row.catches})`,
					evaluate(observed, { binding: LENA, now }),
					pendingRight(reclaimKind, row.hull, row.state.claimGeneration),
				);
			at("C - eps = hull - 1", row.hull - 1 + EPS, "not-yet");
			at("C - eps = hull", row.hull + EPS, "eligible");
			at("C - eps = the lower R", row.lower + EPS, "not-yet");
			at("C = hull, eps ignored", row.hull, "not-yet");
			// catches: a second hull rule beside the rights module (one helper for rights, the planner and batch reclaim)
			const helper = { name: row.name, boundary: claimReclaimBoundary(row.state) };
			expect(helper).toEqual({ name: row.name, boundary: row.hull });
		}
		// catches: the helper's R for ACTIVE differing from the rights module (rights/index.ts:283-284).
		// ASSUMPTION(time path): timeless and FREE have no boundary (null).
		const single: [string, ClaimStateV1, number | null][] = [
			["ACTIVE lease", active(lease()), R],
			["ACTIVE lease under H", active(lease(L, H)), R],
			["ACTIVE hard", active(hard()), H + GRACE],
			["ACTIVE timeless", active(TIMELESS), null],
			["FREE tombstone", tombstone(4), null],
		];
		for (const [name, state, boundary] of single) {
			expect({ name, boundary: claimReclaimBoundary(state) }).toEqual({ name, boundary });
		}
	});

	test("pen-05: keeps ACTIVE fields under pending corrupt, foreign versions and unknown statuses unsupported", () => {
		const holderFields = { ...active(hard()), status: "pending" };
		// Positive control (catches: the old unsupported mapping kept: invalid schema-1 data are corrupt).
		expect(failureView("ACTIVE fields, status pending", parseClaimState(holderFields))).toEqual(
			failureExpected("ACTIVE fields, status pending", "corrupt"),
		);
		const rows: [string, string, unknown, string][] = [
			[
				"claimState 2 with a valid PENDING body",
				"a newer version decoded as a v1 PENDING",
				{ ...transferPending(), claimState: 2 },
				"unsupported",
			],
			[
				"status weird",
				"an unknown status decoded or called corrupt",
				{ ...active(hard()), status: "weird" },
				"unsupported",
			],
			["status PENDING in capitals", "case folding", { ...transferPending(), status: "PENDING" }, "unsupported"],
			["ACTIVE fields, status pending, evaluated", "a right from the holder's own fields", holderFields, "corrupt"],
		];
		for (const [name, catches, payload, kind] of rows) {
			const label = `${name} (catches: ${catches})`;
			expect(failureView(label, parseClaimState(payload))).toEqual(failureExpected(label, kind));
			expect(failureView(`${label} evaluated`, evaluate(present(payload)))).toEqual(
				failureExpected(`${label} evaluated`, kind),
			);
		}
	});
});

describe("time-path planner", () => {
	test("tpl-01: plans a finite H extension as PENDING only with timePath and only while C + eps < H_s", () => {
		const request = changeBounds(hard(H2));
		// Positive control (catches: timePath ignored, the extension still requires-time-path).
		expectPlanned(
			"hard H to H2 at T",
			plan(present(active(hard())), request, TIME_PATH),
			plannedFor(request, boundPending()),
		);
		const carried = { claimGeneration: 7, bindingGeneration: 2, owner: OTHER_OWNER };
		checkPlanned([
			{
				label: "lease with H, H to H2",
				catches: "the lease mode left out of the time path",
				observed: present(active(lease(L, H))),
				request: changeBounds(lease(L, H2)),
				changes: TIME_PATH,
				expected: plannedFor(changeBounds(lease(L, H2)), pending(active(lease(L, H)), active(lease(L, H2)))),
			},
			{
				label: "hard H to H2 with more grace",
				catches: "a raised R beside a raised H sent back to requires-time-path",
				observed: present(active(hard())),
				request: changeBounds(hard(H2, 2 * GRACE)),
				changes: TIME_PATH,
				expected: plannedFor(changeBounds(hard(H2, 2 * GRACE)), pending(active(hard()), active(hard(H2, 2 * GRACE)))),
			},
			{
				label: "C + eps = H - 1",
				catches: "`<=` instead of `<` in the precondition C + eps < H_s",
				observed: present(active(hard())),
				request,
				changes: { timePath: true, now: H - 1 - EPS },
				expected: plannedFor(request, boundPending()),
			},
			{
				label: "generations, owner and binding carried into both sides",
				catches: "the bound form rebuilt from defaults",
				observed: present(active(hard(), carried)),
				request,
				changes: TIME_PATH,
				expected: plannedFor(request, pending(active(hard(), carried), active(hard(H2), carried)), ROOT, 7),
			},
		]);
		checkRejected([
			{
				label: "C + eps = H",
				catches: "an observation at H_s accepted",
				observed: present(active(hard())),
				request,
				changes: { timePath: true, now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "after H",
				catches: "a T plan after H_s, or the boundary H_t instead of H_s",
				observed: present(active(hard())),
				request,
				changes: { timePath: true, now: H + MINUTE },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "lease with H at C + eps = H",
				catches: "the precondition left out in lease mode",
				observed: present(active(lease(L, H))),
				request: changeBounds(lease(L, H2)),
				changes: { timePath: true, now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "without timePath",
				catches: "the time path on by default (the pins of the transition planner)",
				observed: present(active(hard())),
				request,
				cause: "requires-time-path",
			},
			{
				label: "timePath false",
				catches: "a false option read as on",
				observed: present(active(hard())),
				request,
				changes: { timePath: false },
				cause: "requires-time-path",
			},
			{
				label: "timePath on a foreign claim",
				catches: "the time path before the ownership verdict",
				observed: present(active(hard(), { binding: FRANZ, owner: OTHER_OWNER })),
				request,
				changes: TIME_PATH,
				cause: "not-holder",
			},
			{
				label: "timePath with a mode change at H",
				catches: "the precondition before the mode slot",
				observed: present(active(hard())),
				request: changeBounds(lease(L, H2)),
				changes: { timePath: true, now: H - EPS },
				cause: "mode-change",
			},
		]);
	});

	test("tpl-02: keeps removing H and raising R under H at requires-time-path and plans a narrowing directly", () => {
		// Positive control (catches: a narrowing sent to the time path once timePath is on).
		expectPlanned(
			"hard H to H-30 min with timePath",
			plan(present(active(hard())), changeBounds(hard(H - 30 * MINUTE)), TIME_PATH),
			plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
		);
		const permanent: [string, ClaimTiming, ClaimTiming][] = [
			["lease with H, H removed", lease(L, H), lease(L, null)],
			["hard, grace plus one (R raised under H)", hard(), hard(H, GRACE + 1)],
			["lease with H, lease end plus one (R raised under H)", lease(L, H), lease(L + 1, H)],
			["lease with H, grace plus one", lease(L, H), lease(L, H, GRACE + 1)],
			["hard, lower H but a later R", hard(), hard(H - 30 * MINUTE, GRACE + 31 * MINUTE)],
		];
		const instants: [string, number][] = [
			["at T", T],
			["after H", H + MINUTE],
		];
		checkRejected(
			permanent.flatMap(([label, from, to]) =>
				instants.map(
					([when, now]): RejectedCase => ({
						label: `${label}, ${when}`,
						catches: "removal or an R raise under H sent to the time path (permanent in V1)",
						observed: present(active(from)),
						request: changeBounds(to),
						changes: { timePath: true, now },
						cause: "requires-time-path",
					}),
				),
			),
		);
		const narrowing: [string, ClaimTiming, ClaimTiming][] = [
			["lease with H, H lowered", lease(L, H), lease(L, H - 10 * MINUTE)],
			["hard, grace to zero", hard(), hard(H, 0)],
			["pure lease, first hard limit H (K6 bnd-02)", lease(), lease(L, H)],
			["hard, unchanged (no-op write)", hard(), hard()],
		];
		checkPlanned(
			narrowing.map(([label, from, to]) => ({
				label,
				catches: "a narrowing or no-op sent to the time path or turned into PENDING",
				observed: present(active(from)),
				request: changeBounds(to),
				changes: TIME_PATH,
				expected: plannedFor(changeBounds(to), active(to)),
			})),
		);
	});

	test("tpl-03: plans a restart with --hard-end H_t > H_s as PENDING, capped or overlong at H_t, else directly", () => {
		const request = transfer(restartTo(H2));
		// Positive control (catches: hardEnd refused by the request gate, the restart still requires-time-path).
		expectPlanned(
			"hard restart to H2",
			plan(present(active(hard())), request, TO_FRANZ_T),
			plannedFor(request, transferPending()),
		);
		const leaseSource = active(lease(L, H));
		checkPlanned([
			{
				label: "lease with H, default TTL",
				catches: "the restart kept as preserve (lease end from the old window)",
				observed: present(leaseSource),
				request: transfer(restartTo(H2), leaseOf()),
				changes: TO_FRANZ_T,
				expected: plannedFor(transfer(restartTo(H2), leaseOf()), pending(leaseSource, transferred(lease(T + TTL, H2)))),
			},
			{
				label: "lease with H, default TTL beyond H2",
				catches: "a default lease not capped at H_t (transition/index.ts:224-233)",
				observed: present(leaseSource),
				request: transfer(restartTo(H2), leaseOf(4 * 60 * MINUTE)),
				changes: TO_FRANZ_T,
				expected: plannedFor(
					transfer(restartTo(H2), leaseOf(4 * 60 * MINUTE)),
					pending(leaseSource, transferred(lease(H2, H2))),
				),
			},
			{
				label: "lease with H, explicit TTL within H2",
				catches: "an explicit lease replaced by the default",
				observed: present(leaseSource),
				request: transfer(restartTo(H2), leaseOf(30 * MINUTE, "explicit")),
				changes: TO_FRANZ_T,
				expected: plannedFor(
					transfer(restartTo(H2), leaseOf(30 * MINUTE, "explicit")),
					pending(leaseSource, transferred(lease(T + 30 * MINUTE, H2))),
				),
			},
			{
				label: "hard with a stored grace of 20 min",
				catches: "a grace from configuration instead of the stored one",
				observed: present(active(hard(H, 2 * GRACE))),
				request,
				changes: TO_FRANZ_T,
				expected: plannedFor(request, pending(active(hard(H, 2 * GRACE)), transferred(hard(H2, 2 * GRACE)))),
			},
			{
				label: "policy source with hardEnd",
				catches: "a configured restart treated apart from an explicit one",
				observed: present(active(hard())),
				request: transfer(restartTo(H2, "policy")),
				changes: TO_FRANZ_T,
				expected: plannedFor(transfer(restartTo(H2, "policy")), transferPending()),
			},
			{
				label: "planned 30 min later",
				catches: "H_t read as a duration from C instead of an absolute instant",
				observed: present(active(hard())),
				request,
				changes: { ...TO_FRANZ_T, now: T + 30 * MINUTE },
				expected: plannedFor(request, transferPending()),
			},
			{
				label: "H_t = H_s, direct",
				catches: "a non-extending restart sent to the time path",
				observed: present(active(hard())),
				request: transfer(restartTo(H)),
				changes: TO_FRANZ_T,
				expected: plannedFor(transfer(restartTo(H)), transferred(hard(H))),
			},
			{
				label: "H_t < H_s, direct",
				catches: "a narrowing restart sent to the time path",
				observed: present(active(hard())),
				request: transfer(restartTo(H - 10 * MINUTE)),
				changes: TO_FRANZ_T,
				expected: plannedFor(transfer(restartTo(H - 10 * MINUTE)), transferred(hard(H - 10 * MINUTE))),
			},
			{
				label: "lease with H, H_t < H_s, direct",
				catches: "the narrowing restart of a lease ignoring H_t",
				observed: present(leaseSource),
				request: transfer(restartTo(H - 10 * MINUTE), leaseOf()),
				changes: TO_FRANZ_T,
				expected: plannedFor(
					transfer(restartTo(H - 10 * MINUTE), leaseOf()),
					transferred(lease(T + TTL, H - 10 * MINUTE)),
				),
			},
			{
				label: "H_t < H_s without timePath, direct",
				catches: "a narrowing restart that needs timePath",
				observed: present(active(hard())),
				request: transfer(restartTo(H - 10 * MINUTE)),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(restartTo(H - 10 * MINUTE)), transferred(hard(H - 10 * MINUTE))),
			},
		]);
		checkRejected([
			{
				label: "lease with H, explicit TTL beyond H2",
				catches: "an explicit overlong lease capped silently",
				observed: present(leaseSource),
				request: transfer(restartTo(H2), leaseOf(4 * 60 * MINUTE, "explicit")),
				changes: TO_FRANZ_T,
				cause: "overlong",
				boundary: H2,
			},
			{
				label: "restart without values, explicit",
				catches: "a restart without --hard-end given a guessed H_t",
				observed: present(active(hard())),
				request: transfer(restart()),
				changes: TO_FRANZ_T,
				cause: "requires-time-path",
			},
			{
				label: "restart without values, policy",
				catches: "a configured restart without values planned",
				observed: present(active(hard())),
				request: transfer(restart("policy")),
				changes: TO_FRANZ_T,
				cause: "requires-time-path",
			},
			{
				label: "H_t > H_s without timePath",
				catches: "an extending restart planned with timePath off",
				observed: present(active(hard())),
				request,
				changes: TO_FRANZ,
				cause: "requires-time-path",
			},
			{
				label: "C + eps = H",
				catches: "a restart observed at H_s, or the boundary H_t",
				observed: present(active(hard())),
				request,
				changes: { ...TO_FRANZ_T, now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
		]);
	});

	test("tpl-04: plans --hard-end on a pure lease directly with the first bound and on timeless as mode-change", () => {
		const request = transfer(restartTo(H2), leaseOf());
		// Positive control (catches: a pure lease restart with a first bound refused or sent to the time path).
		expectPlanned(
			"pure lease, first bound H2",
			plan(present(active(lease())), request, TO_FRANZ_T),
			plannedFor(request, transferred(lease(T + TTL, H2))),
		);
		checkPlanned([
			{
				label: "pure lease without timePath",
				catches: "a first bound treated as an extension",
				observed: present(active(lease())),
				request,
				changes: TO_FRANZ,
				expected: plannedFor(request, transferred(lease(T + TTL, H2))),
			},
			{
				label: "pure lease, first bound before the default lease end",
				catches: "the first bound not narrowing the new lease",
				observed: present(active(lease())),
				request: transfer(restartTo(T + 2 * MINUTE), leaseOf()),
				changes: TO_FRANZ_T,
				expected: plannedFor(
					transfer(restartTo(T + 2 * MINUTE), leaseOf()),
					transferred(lease(T + 2 * MINUTE, T + 2 * MINUTE)),
				),
			},
		]);
		checkRejected([
			{
				label: "pure lease, explicit TTL beyond the first bound",
				catches: "an explicit lease beyond the new bound capped silently",
				observed: present(active(lease())),
				request: transfer(restartTo(H2), leaseOf(4 * 60 * MINUTE, "explicit")),
				changes: TO_FRANZ_T,
				cause: "overlong",
				boundary: H2,
			},
			{
				label: "timeless with hardEnd and timePath",
				catches: "a silent switch from timeless to hard",
				observed: present(active(TIMELESS)),
				request: transfer(restartTo(H2)),
				changes: TO_FRANZ_T,
				cause: "mode-change",
			},
			{
				label: "timeless with hardEnd without timePath",
				catches: "the mode slot depending on timePath",
				observed: present(active(TIMELESS)),
				request: transfer(restartTo(H2)),
				changes: TO_FRANZ,
				cause: "mode-change",
			},
			{
				label: "timeless, explicit restart without values (administration, tra-03)",
				catches: "the administration restart rule changed",
				observed: present(active(TIMELESS)),
				request: transfer(restart()),
				changes: TO_FRANZ_T,
				cause: "requires-time-path",
			},
		]);
	});

	test("tpl-05: rejects every action but reclaim on PENDING as pending-transition with the hull, any binding", () => {
		const observed = present(transferPending());
		// Positive control (catches: PENDING read as free by acquire, transition/index.ts:386-387).
		expectRejected("third-party acquire", plan(observed, acquire(), { binding: LENA }), "pending-transition", HULL);
		for (const [role, binding] of ROLES) {
			for (const row of followUps(binding)) {
				const label = `${role} ${row.action} (catches: ${row.catches})`;
				expectRejected(label, plan(observed, row.request, row.changes), "pending-transition", HULL);
				// catches: the generation checked before the state slot (precedence)
				const wrong = { ...row.changes, expectedClaimGeneration: 9 };
				expectRejected(`${label}, wrong expectation`, plan(observed, row.request, wrong), "pending-transition", HULL);
				// catches: PENDING read as free or as the target's ACTIVE once the hull has passed
				const late = { ...row.changes, now: HULL + EPS };
				expectRejected(`${label}, after the hull`, plan(observed, row.request, late), "pending-transition", HULL);
			}
		}
		for (const [role, binding] of ROLES) {
			// catches: reclaim before the hull, e.g. after the source's R alone (model old_reclaim_horizon)
			expectRejected(
				`${role} reclaim one ms before the hull`,
				plan(observed, reclaim(), { binding, now: HULL - 1 + EPS }),
				"not-yet",
				HULL,
			);
			expectRejected(
				`${role} reclaim at the source's R`,
				plan(observed, reclaim(), { binding, now: H + GRACE + EPS }),
				"not-yet",
				HULL,
			);
			// catches: no reclaim after the hull, or a tombstone with the source's generation
			expectPlanned(
				`${role} reclaim at the hull`,
				plan(observed, reclaim(), { binding, now: HULL + EPS }),
				plannedFor(reclaim(), tombstone(4), ROOT, 4),
			);
		}
		expectPlanned(
			"reclaim at the hull expecting the PENDING generation (batch expectation)",
			plan(observed, reclaim(), { binding: LENA, now: HULL + EPS, expectedClaimGeneration: 4 }),
			plannedFor(reclaim(), tombstone(4), ROOT, 4),
		);
		// ASSUMPTION(time path): the contract names the precedence only for the other actions; reclaim keeps its generation
		// check first (transition/index.ts:390). catches: a stale selection generation reclaiming a newer PENDING.
		expectRejected(
			"reclaim at the hull expecting the source generation",
			plan(observed, reclaim(), { binding: LENA, now: HULL + EPS, expectedClaimGeneration: 3 }),
			"generation-changed",
		);
		expectPlanned(
			"bound PENDING reclaim at the hull (catches: the bound form's generation 3 lost)",
			plan(present(boundPending()), reclaim(), { binding: LENA, now: HULL + EPS }),
			plannedFor(reclaim(), tombstone(3), ROOT, 3),
		);
	});

	test("tpl-06: validates hardEnd and timePath before the observation", () => {
		const request = transfer(restartTo(H2));
		// Positive control (catches: no restart with hardEnd planned at all).
		expectPlanned(
			"restart to H2",
			plan(present(active(hard())), request, TO_FRANZ_T),
			plannedFor(request, transferPending()),
		);
		const nullHardEnd = transfer(asTimeBox({ ...restart(), hardEnd: null }));
		const requests: [string, unknown, Partial<PlanClaimTransitionOptions>][] = [
			["preserve with hardEnd", transfer(asTimeBox({ ...preserve(), hardEnd: H2 })), TO_FRANZ_T],
			["negative hardEnd", transfer(restartTo(-1)), TO_FRANZ_T],
			["fractional hardEnd", transfer(restartTo(H2 + 0.5)), TO_FRANZ_T],
			["hardEnd beyond the safe integers", transfer(restartTo(2 ** 53)), TO_FRANZ_T],
			["hardEnd as a string", transfer(asTimeBox({ ...restart(), hardEnd: String(H2) })), TO_FRANZ_T],
			["hardEnd null (ASSUMPTION: absent, never null)", nullHardEnd, TO_FRANZ_T],
			["hardEnd accessor", transfer(withAccessor(restartTo(H2), "hardEnd", H2)), TO_FRANZ_T],
			["hardEnd hidden", transfer(withHidden(restart(), "hardEnd", H2)), TO_FRANZ_T],
			["hardEnd on the transfer request", { ...transfer(restart()), hardEnd: H2 }, TO_FRANZ_T],
			["hardEnd on change-bounds", { ...changeBounds(hard(H2)), hardEnd: H2 }, TIME_PATH],
			["hardEnd on renew", { ...renew(), hardEnd: H2 }, TIME_PATH],
		];
		// catches: a second, laxer parser for the time box, or hardEnd outside restart
		for (const [label, value, changes] of requests) {
			expectInvalidEverywhere(label, present(active(hard())), asRequest(value), changes);
		}
		const values: [string, unknown][] = [
			["timePath as a string", "yes"],
			["timePath as a number", 1],
			["timePath null", null],
			["timePath as an object", { enabled: true }],
		];
		// catches: a truthy non-boolean read as on (an option, default off)
		for (const [label, value] of values) {
			const changes = { targetBinding: FRANZ, timePath: value as boolean };
			expectInvalidEverywhere(label, present(active(hard())), request, changes);
		}
		// catches: an accessor read on the option (claim-transition.test.ts:1392-1393)
		for (const observed of [present(active(hard())), UNREACHABLE]) {
			const accessor = withAccessor(optionsOf(observed, request, TO_FRANZ), "timePath", true);
			expectFailure(`timePath accessor on ${observed.kind}`, planClaimTransition(accessor), "invalid");
		}
	});

	test("tpl-07: returns PENDING next states that rights decodes, free of bindings, aliasing and ambient clocks", () => {
		const expected = [
			plannedFor(changeBounds(hard(H2)), boundPending()),
			plannedFor(transfer(restartTo(H2)), transferPending()),
			plannedFor(reclaim(), tombstone(4), ROOT, 4),
		];
		const run = (): ClaimTransitionPlan[] => [
			plan(present(active(hard())), changeBounds(hard(H2)), TIME_PATH),
			plan(present(active(hard())), transfer(restartTo(H2)), TO_FRANZ_T),
			plan(present(transferPending()), reclaim(), { binding: LENA, now: HULL + EPS }),
		];
		// Positive control (catches: the three plans not made at all).
		expect(run()).toStrictEqual(expected);
		const scenarios: [string, ClaimTransitionPlan, string][] = [
			["change-bounds H to H2", plan(present(active(hard())), changeBounds(hard(H2)), TIME_PATH), KARL],
			["transfer restart to H2", plan(present(active(hard())), transfer(restartTo(H2)), TO_FRANZ_T), FRANZ],
			[
				"transfer restart of a lease",
				plan(present(active(lease(L, H))), transfer(restartTo(H2), leaseOf()), TO_FRANZ_T),
				FRANZ,
			],
			["bound lease H to H2", plan(present(active(lease(L, H))), changeBounds(lease(L, H2)), TIME_PATH), KARL],
		];
		for (const [label, result, target] of scenarios) {
			const planned = plannedResult(label, result);
			// catches: a PENDING payload outside the claim schema the planner itself writes
			expect({ label, decoded: plain(parseClaimState(planned.next)) }).toStrictEqual({
				label,
				decoded: { kind: "state", state: planned.next },
			});
			// catches: the target binding in the wrong role, or the source lost
			const shape = plain(planned.next);
			expect({
				label,
				status: shape.status,
				source: field(shape.source, "binding"),
				target: field(shape.target, "binding"),
			}).toEqual({ label, status: "pending", source: KARL, target });
			// catches: a binding in the request that becomes the journal parameters, or anywhere outside next
			const { next: _next, ...envelope } = planned;
			expect({
				label,
				requestBinding: JSON.stringify(planned.request).includes("tb1-"),
				envelopeBinding: JSON.stringify(envelope).includes("tb1-"),
			}).toEqual({ label, requestBinding: false, envelopeBinding: false });
		}
		// catches: next sharing objects with the payload or the request, or the inputs mutated
		const payload = active(hard());
		const timing = hard(H2);
		const options = optionsOf(present(payload), changeBounds(timing), TIME_PATH);
		const before = structuredClone(options);
		const next = plannedResult("aliasing", planClaimTransition(options)).next as PendingClaimState;
		expect({
			sourceIsPayload: next.source === payload,
			targetTimingIsRequest: next.target.timing === timing,
			sidesShareTiming: next.source.timing === next.target.timing,
		}).toEqual({ sourceIsPayload: false, targetTimingIsRequest: false, sidesShareTiming: false });
		next.source.owner = THIRD_OWNER;
		next.target.timing = TIMELESS;
		expect(options).toStrictEqual(before);
		expect(payload).toStrictEqual(active(hard()));
		// catches: a hidden clock read, or nondeterministic output
		const holder: { first: ClaimTransitionPlan[]; second: ClaimTransitionPlan[] } = { first: [], second: [] };
		const wallClock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("hidden wall clock");
		});
		const monotonicClock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("hidden monotonic clock");
		});
		try {
			holder.first = run();
			holder.second = run();
		} finally {
			wallClock.mockRestore();
			monotonicClock.mockRestore();
		}
		expect(holder).toStrictEqual({ first: expected, second: expected });
		// catches: a leak of a binding, owner, root or requested instant in any reason
		const secret = [String(H2), String(H3), "agent-sentinel", "tb1-", FRANZ.toUpperCase(), KARL.slice(4)];
		const rejections: [string, ClaimTransitionPlan, Rejection, number?][] = [
			[
				"pending-transition",
				plan(present(transferPending(), ROOT_64), acquire(), { binding: LENA }),
				"pending-transition",
				HULL,
			],
			[
				"hard-expired on a T plan",
				plan(present(active(hard()), ROOT_64), transfer(restartTo(H2)), { ...TO_FRANZ_T, now: H - EPS }),
				"hard-expired",
				H,
			],
			[
				"overlong on a T restart",
				plan(
					present(active(lease(L, H)), ROOT_64),
					transfer(restartTo(H2), leaseOf(4 * 60 * MINUTE, "explicit")),
					TO_FRANZ_T,
				),
				"overlong",
				H2,
			],
			[
				"requires-time-path on a restart without values",
				plan(present(active(hard()), ROOT_64), transfer(restart()), TO_FRANZ_T),
				"requires-time-path",
			],
			[
				"requires-time-path on a removed H",
				plan(present(active(lease(L, H)), ROOT_64), changeBounds(lease(L, null)), TIME_PATH),
				"requires-time-path",
			],
		];
		for (const [label, result, cause, boundary] of rejections) {
			expectRejected(label, result, cause, boundary, secret);
		}
		const failures: [string, ClaimTransitionPlan, Failure][] = [
			[
				"timePath not a boolean",
				plan(present(active(hard())), transfer(restartTo(H2)), {
					targetBinding: FRANZ,
					timePath: "on" as unknown as boolean,
				}),
				"invalid",
			],
			[
				"ACTIVE fields under status pending",
				plan(present({ ...active(hard()), status: "pending" }), release()),
				"corrupt",
			],
			["newer PENDING version", plan(present({ ...transferPending(), claimState: 2 }), release()), "unsupported"],
		];
		for (const [label, result, kind] of failures) {
			expectFailure(label, result, kind, secret);
		}
	});
});

describe("logical outcome of a transition", () => {
	test("log-01: resolves P and A to the nine rows, clock-free", () => {
		const p = transitionRecord();
		const a = confirmationRecord(p);
		const digests = [p.digest, a.digest];
		// Positive control (catches: no composite resolver, the scaffold's constant invalid, A stored not APPLIED).
		expect(logicalView("confirmed", resolveTransition(p, a, atA(p, a)), digests)).toEqual(
			logical("confirmed", ["applied", "confirmed", "stored", "stored"]),
		);
		// catches: a derived ID the journal refuses (journal/index.ts:109-115), an unstable or a colliding derivation
		expect({
			form: /^c-[0-9a-f]{40}$/.test(confirmId()),
			stable: confirmId() === claimConfirmationId(P_ID),
			distinct: claimConfirmationId("op-other-transition") !== confirmId(),
			notTheP: confirmId() !== P_ID,
		}).toEqual({ form: true, stable: true, distinct: true, notTheP: true });
		const rows: LogicalRow[] = [
			{
				label: "P invalid",
				catches: "a tampered P record resolved",
				record: { ...p, digest: sha256Hex("tampered P") },
				confirmation: null,
				observed: atP(p),
				expected: "invalid",
			},
			{
				label: "P open at q",
				catches: "an unsent P read as rejected",
				record: p,
				confirmation: null,
				observed: atQ(),
				expected: ["unknown", "none", "open", null],
			},
			{
				label: "P unknown (unreachable read)",
				catches: "a failed read read as a verdict",
				record: p,
				confirmation: null,
				observed: UNREACHABLE,
				expected: ["unknown", "none", "unknown", null],
			},
			{
				label: "P not-stored",
				catches: "a lost P read as unknown",
				record: p,
				confirmation: null,
				observed: snapshotAt(LATER_ROOT, 2, { ...EARLIER, "op-other": { ...FOREIGN_RECEIPT } }, tombstone(4)),
				expected: ["rejected", "none", "not-stored", null],
			},
			{
				label: "P unknown-history",
				catches: "incomplete history read as not-stored",
				record: p,
				confirmation: null,
				observed: snapshotAt(LATER_ROOT, 3, { ...EARLIER, "op-other": { ...FOREIGN_RECEIPT } }, tombstone(4)),
				expected: ["unknown-history", "none", "unknown-history", null],
			},
			{
				label: "P conflict",
				catches: "a contradicting P receipt read as stored",
				record: p,
				confirmation: null,
				observed: snapshotAt(LATER_ROOT, 2, { ...EARLIER, [P_ID]: { ...FOREIGN_RECEIPT } }, transferPending()),
				expected: ["unknown-history", "none", "conflict", null],
			},
			{
				label: "P stored, no witness, p current",
				catches: "a landed P without witness read as APPLIED (model result())",
				record: p,
				confirmation: null,
				observed: atP(p),
				expected: ["unknown", "pending", "stored", null],
			},
			{
				label: "P stored, no witness, p superseded",
				catches: "a lost witness read as UNKNOWN forever",
				record: p,
				confirmation: null,
				observed: reclaimedAfterP(p),
				expected: ["unknown-history", "pending", "stored", null],
			},
			{
				label: "witness, A stored",
				catches: "the confirmed transition not APPLIED",
				record: p,
				confirmation: a,
				observed: atA(p, a),
				expected: ["applied", "confirmed", "stored", "stored"],
			},
			{
				label: "witness, A open at p",
				catches: "model-literal APPLIED at the witness (disposition 2: UNKNOWN/3)",
				record: p,
				confirmation: a,
				observed: atP(p),
				expected: ["unknown", "witnessed", "stored", "open"],
			},
			{
				label: "witness, A not-stored after a reclaim",
				catches: "a superseded witness read as rejected (model late-A)",
				record: p,
				confirmation: a,
				observed: reclaimedAfterP(p),
				expected: ["applied", "witnessed", "stored", "not-stored"],
			},
			{
				label: "witness, A unknown-history",
				catches: "a witness dropped under incomplete history",
				record: p,
				confirmation: a,
				observed: reclaimedAfterP(p, 4),
				expected: ["applied", "witnessed", "stored", "unknown-history"],
			},
			{
				label: "witness, A conflict",
				catches: "a contradicting A receipt read as confirmed",
				record: p,
				confirmation: a,
				observed: snapshotAt(
					A_ROOT,
					3,
					{ ...EARLIER, [P_ID]: receiptOf(p), [a.intent.operationId]: { ...FOREIGN_RECEIPT } },
					transferred(hard(H2)),
				),
				expected: ["applied", "witnessed", "stored", "conflict"],
			},
		];
		for (const row of rows) {
			const label = `${row.label} (catches: ${row.catches})`;
			const inputs = { record: row.record, confirmation: row.confirmation, observed: row.observed };
			const before = structuredClone(inputs);
			expect(logicalView(label, resolveTransition(row.record, row.confirmation, row.observed), digests)).toEqual(
				logical(label, row.expected),
			);
			// catches: a resolver that mutates a record or the observation
			expect({ label, inputs }).toStrictEqual({ label, inputs: before });
		}
		// catches: a hidden clock read (the resolver is pure and time-free like the model)
		const holder: { first: object | null; second: object | null } = { first: null, second: null };
		const wallClock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("hidden wall clock");
		});
		const monotonicClock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("hidden monotonic clock");
		});
		try {
			holder.first = resolveTransition(p, a, atP(p));
			holder.second = resolveTransition(p, a, atP(p));
		} finally {
			wallClock.mockRestore();
			monotonicClock.mockRestore();
		}
		const witnessed = { kind: "unknown", phase: "witnessed", transition: "stored", confirmation: "open" };
		expect(holder).toEqual({ first: witnessed, second: witnessed });
	});

	test("log-02: never derives APPLIED from an ACTIVE target payload or a later own renew without the A receipt", () => {
		const p = transitionRecord();
		const a = confirmationRecord(p);
		const renewed = recordOf({
			operationId: "op-renew-franz",
			remote: REMOTE,
			format: "blob",
			epoch: 1,
			ticket: TICKET,
			expectedRoot: A_ROOT,
			targetBinding: FRANZ,
			action: "renew",
			parameters: jsonOf(renew()),
			resolved: { next: jsonOf(transferred(hard(H2))) },
		});
		const digests = [p.digest, a.digest, renewed.digest];
		// Positive control (catches: the exact A receipt not honoured, the scaffold's constant invalid).
		expect(logicalView("A receipt present", resolveTransition(p, a, atA(p, a)), digests)).toEqual(
			logical("A receipt present", ["applied", "confirmed", "stored", "stored"]),
		);
		const target = transferred(hard(H2));
		const afterRenew = { ...EARLIER, [P_ID]: receiptOf(p), "op-renew-franz": receiptOf(renewed) };
		const rows: LogicalRow[] = [
			{
				label: "no witness, target payload after a later own renew",
				catches: "success derived from a later renew receipt",
				record: p,
				confirmation: null,
				observed: snapshotAt(LATER_ROOT, 3, afterRenew, target),
				expected: ["unknown-history", "pending", "stored", null],
			},
			{
				label: "no witness, the exact target payload without a new receipt",
				catches: "success derived from payload equality with A's next (JUDGE-CORRECTION.md:8-13)",
				record: p,
				confirmation: null,
				observed: snapshotAt(A_ROOT, 3, { ...EARLIER, [P_ID]: receiptOf(p) }, target),
				expected: ["unknown-history", "pending", "stored", null],
			},
			{
				label: "witness, the target payload at root p without the A receipt",
				catches: "APPLIED read from the payload while A is still open at p",
				record: p,
				confirmation: a,
				observed: snapshotAt(P_ROOT, 2, { ...EARLIER, [P_ID]: receiptOf(p) }, target),
				expected: ["unknown", "witnessed", "stored", "open"],
			},
			{
				label: "the renew record in place of A",
				catches: "any later own record accepted as the witness (A must name P)",
				record: p,
				confirmation: renewed,
				observed: snapshotAt(LATER_ROOT, 3, afterRenew, target),
				expected: "invalid",
			},
		];
		for (const row of rows) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(logicalView(label, resolveTransition(row.record, row.confirmation, row.observed), digests)).toEqual(
				logical(label, row.expected),
			);
		}
	});

	test("log-03: marks a witness at or after observeBefore and an A record of another P as invalid", () => {
		const p = transitionRecord();
		const other = transitionRecord({ operationId: "op-other-transition" });
		const last = confirmationRecord(p, { observedAt: H - EPS - 1 });
		// Positive control (catches: a witness one ms inside the bound refused, the scaffold's constant invalid).
		expect(logicalView("last valid witness", resolveTransition(p, last, atA(p, last)), [p.digest])).toEqual(
			logical("last valid witness", ["applied", "confirmed", "stored", "stored"]),
		);
		const rows: [string, string, ClaimIntentRecord][] = [
			[
				"observedAt + clockSkewMs = observeBefore",
				"`<=` for `<` on the witness bound (model observe)",
				confirmationRecord(p, { observedAt: H - EPS }),
			],
			[
				"observedAt after observeBefore",
				"a late observation accepted as witness",
				confirmationRecord(p, { observedAt: H + MINUTE }),
			],
			[
				"clock skew pushing past observeBefore",
				"the skew ignored",
				confirmationRecord(p, { clockSkewMs: 20 * MINUTE }),
			],
			[
				"transition naming another P",
				"an A of another transition accepted",
				confirmationRecord(p, { transition: other.intent.operationId }),
			],
			[
				"foreign transitionDigest",
				"the digest binding unchecked",
				confirmationRecord(p, { transitionDigest: other.digest }),
			],
			[
				"transitionDigest = P's parameter digest",
				"the parameter digest accepted for the intent digest",
				confirmationRecord(p, { transitionDigest: p.parameterDigest }),
			],
			["A of another P in both fields", "a witness moved between transitions", confirmationRecord(other)],
		];
		for (const [name, catches, confirmation] of rows) {
			const label = `${name} (catches: ${catches})`;
			const result = resolveTransition(p, confirmation, atA(p, confirmation));
			expect(logicalView(label, result, [p.digest, confirmation.digest])).toEqual(logical(label, "invalid"));
		}
		const a = confirmationRecord(p);
		const forged = { ...p, digest: sha256Hex("forged P") };
		const tampered: [string, string, ClaimIntentRecord, ClaimIntentRecord][] = [
			["A digest replaced", "a record accepted under a foreign digest", p, { ...a, digest: sha256Hex("forged A") }],
			[
				"A parameter digest replaced",
				"the parameter digest unchecked",
				p,
				{ ...a, parameterDigest: sha256Hex("forged parameters") },
			],
			[
				"A witness changed under its old digests",
				"a moved witness instant accepted (model: faking the O record)",
				p,
				{ ...a, intent: { ...a.intent, parameters: { ...a.intent.parameters, observedAt: H + MINUTE } } },
			],
			[
				"P digest replaced, A pointing at it",
				"a forged P confirmed by a matching A",
				forged,
				confirmationRecord(forged),
			],
		];
		for (const [name, catches, record, confirmation] of tampered) {
			const label = `${name} (catches: ${catches})`;
			const result = resolveTransition(record, confirmation, atA(p, a));
			expect(logicalView(label, result, [p.digest, a.digest])).toEqual(logical(label, "invalid"));
		}
	});
});

describe("surface of the time path", () => {
	test("sur-01: claim next continues past pending-transition and counts T intents as maintenance", () => {
		const none: ReadonlySet<string> = new Set<string>();
		// Positive control (catches: the row missing, so a PENDING candidate stops claim next).
		expect(claimNextStep({ document: planRejected("pending-transition", HULL), maintenanceOperationIds: none })).toBe(
			"continue",
		);
		const rows: { label: string; document: ClaimNextAttempt; step: ReturnType<typeof claimNextStep> }[] = [
			...["held", "not-free"].map((cause) => ({
				label: `plan ${cause} (catches: the isolated conflicts of claim next changed)`,
				document: planRejected(cause),
				step: "continue" as const,
			})),
			...OTHER_PLAN_CAUSES.map((cause) => ({
				label: `plan ${cause} (catches: pending-transition added as a blanket continue)`,
				document: planRejected(cause),
				step: "stop" as const,
			})),
		];
		const steps = rows.map((row) => ({
			label: row.label,
			step: claimNextStep({ document: row.document, maintenanceOperationIds: none }),
		}));
		expect(steps).toEqual(rows.map((row) => ({ label: row.label, step: row.step })));
		// catches: a pause by the own P and A counted as an acquire stop (T intents are maintenance)
		const maintenance: ReadonlySet<string> = new Set([P_ID, A_LITERAL]);
		expect(claimNextStep({ document: pauseDoc([P_ID, A_LITERAL]), maintenanceOperationIds: maintenance })).toBe(
			"continue",
		);
		// Green characterization (pause/index.ts:167-184 unchanged): the acquisition stop lists P at q and A at p as
		// maintenance, never as acquire IDs.
		const p = transitionRecord();
		const journal: ClaimIntentEnumerationResult = {
			kind: "enumerated",
			records: [p, confirmationRecord(p, {}, { operationId: A_LITERAL })],
			corrupt: 0,
		};
		const stopAt = (label: string, root: string) => {
			const roots = { [TICKET]: root };
			const stop = evaluateClaimAcquireStop({ journal, remote: REMOTE, descriptor: DESCRIPTOR, roots });
			return { label, stop: plain(stop) };
		};
		expect([stopAt("at q", ROOT), stopAt("at p", P_ROOT)]).toEqual([
			{ label: "at q", stop: { kind: "clear", maintenanceOperationIds: [P_ID] } },
			{ label: "at p", stop: { kind: "clear", maintenanceOperationIds: [A_LITERAL] } },
		]);
	});

	test("sur-02: maps every phase to its status and exit, with exactly the five transition fields and no leak", () => {
		const aId = confirmId();
		const appliedP: ClaimExecutionStorage = { kind: "applied", root: P_ROOT };
		const appliedA: ClaimExecutionStorage = { kind: "applied", root: A_ROOT };
		const staleA: ClaimExecutionStorage = { kind: "rejected", cause: "stale" };
		const heldA: ClaimExecutionStorage = { kind: "not-sent", cause: "admission-held" };
		const notStoredP: ClaimExecutionStorage = {
			kind: "queried",
			after: "remote",
			query: { kind: "resolved", resolution: { kind: "not-stored", observedRoot: LATER_ROOT } },
		};
		const conflictP: ClaimExecutionStorage = {
			kind: "queried",
			after: "unknown",
			query: { kind: "resolved", resolution: { kind: "conflict", reason: REASON } },
		};
		/** On the bound form: the source's own view of its unresolved PENDING (generation 3). */
		const unresolved = pendingEvaluation(3);
		const noPhase = fact("none", null, null);
		const confirmed = transitionResult("applied", appliedP, 2, heldAfterExtension(), fact("confirmed", aId, appliedA));
		const restartFact = fact("confirmed", aId, appliedA);
		const restartConfirmed = transitionResult("applied", appliedP, 2, foreignAfterRestart(), restartFact, "transfer");
		// Positive control (catches: the transition field dropped, the scaffold's unchanged mapper; a root copied).
		expect(docView("confirmed", mapped(confirmed))).toEqual(
			expectedDoc(
				"confirmed",
				operationBody({
					status: "applied",
					outcome: "applied",
					storage: { kind: "applied" },
					sends: 2,
					rights: HELD_VIEW,
					transition: transitionBody("confirmed", aId, { kind: "applied" }),
				}),
			),
		);
		const openA: ClaimExecutionStorage = {
			kind: "queried",
			after: "unknown",
			query: { kind: "resolved", resolution: { kind: "open", observedRoot: P_ROOT } },
		};
		const openView: Body = { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } };
		const rows: DocRow[] = [
			{
				label: "witnessed, A reply lost",
				catches: "phase witnessed reported as applied (unknown/3)",
				document: mapped(
					transitionResult("unknown", appliedP, 4, unresolved, fact("witnessed", aId, openA)),
					"attempts",
				),
				expected: operationBody({
					status: "unknown",
					outcome: "unknown",
					storage: { kind: "applied" },
					sends: 4,
					stoppedBy: "attempts",
					rights: pendingView(3),
					transition: transitionBody("witnessed", aId, openView),
				}),
			},
			{
				label: "witnessed, budget stop after T5",
				catches: "a budget stop after the witness reported as pending or applied",
				document: mapped(transitionResult("unknown", appliedP, 1, unresolved, fact("witnessed", aId, null)), "budget"),
				expected: operationBody({
					status: "unknown",
					outcome: "unknown",
					storage: { kind: "applied" },
					sends: 1,
					stoppedBy: "budget",
					rights: pendingView(3),
					transition: transitionBody("witnessed", aId, null),
				}),
			},
			{
				label: "witnessed, A not sent",
				catches: "an unsent A reported as applied",
				document: mapped(transitionResult("unknown", appliedP, 1, unresolved, fact("witnessed", aId, heldA))),
				expected: operationBody({
					status: "unknown",
					outcome: "unknown",
					storage: { kind: "applied" },
					sends: 1,
					rights: pendingView(3),
					transition: transitionBody("witnessed", aId, { kind: "not-sent", cause: "admission-held" }),
				}),
			},
			{
				label: "witnessed, A superseded",
				catches: "a superseded witness reported as rejected (applied/0)",
				document: mapped(transitionResult("applied", appliedP, 2, unresolved, fact("witnessed", aId, staleA))),
				expected: operationBody({
					status: "applied",
					outcome: "applied",
					storage: { kind: "applied" },
					sends: 2,
					rights: pendingView(3),
					transition: transitionBody("witnessed", aId, { kind: "rejected", cause: "stale" }),
				}),
			},
			{
				label: "pending, no witness",
				catches: "a PENDING without witness reported as applied, or an A ID invented",
				document: mapped(transitionResult("unknown", appliedP, 1, unresolved, fact("pending", null, null))),
				expected: operationBody({
					status: "unknown",
					outcome: "unknown",
					storage: { kind: "applied" },
					sends: 1,
					rights: pendingView(3),
					transition: transitionBody("pending", null, null),
				}),
			},
			{
				label: "P rejected stale",
				catches: "a rejected P given a phase beyond none",
				document: mapped(transitionResult("rejected", staleA, 1, heldAfterExtension(), noPhase)),
				expected: operationBody({
					status: "rejected",
					outcome: "rejected",
					rejection: { stage: "storage", cause: "stale" },
					storage: { kind: "rejected", cause: "stale" },
					sends: 1,
					rights: HELD_VIEW,
					transition: transitionBody("none", null, null),
				}),
			},
			{
				label: "P not-stored after a query",
				catches: "the resolution stage of a rejected P lost",
				document: mapped(transitionResult("rejected", notStoredP, 2, heldAfterExtension(), noPhase)),
				expected: operationBody({
					status: "rejected",
					outcome: "rejected",
					rejection: { stage: "resolution", cause: "not-stored" },
					storage: { kind: "queried", after: "remote", query: { kind: "resolved", resolution: "not-stored" } },
					sends: 2,
					rights: HELD_VIEW,
					transition: transitionBody("none", null, null),
				}),
			},
			{
				label: "P not sent",
				catches: "an unsent P reported as unknown (unavailable/6)",
				document: mapped(transitionResult("not-sent", heldA, 0, heldAfterExtension(), noPhase)),
				expected: operationBody({
					status: "unavailable",
					outcome: "not-sent",
					storage: { kind: "not-sent", cause: "admission-held" },
					sends: 0,
					rights: HELD_VIEW,
					transition: transitionBody("none", null, null),
				}),
			},
			{
				label: "P history unresolved",
				catches: "a contradicting P receipt reported as unknown (unknown-history/4)",
				document: mapped(transitionResult("unknown-history", conflictP, 2, heldAfterExtension(), noPhase)),
				expected: operationBody({
					status: "unknown-history",
					outcome: "unknown-history",
					storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "conflict" } },
					sends: 2,
					rights: HELD_VIEW,
					transition: transitionBody("none", null, null),
				}),
			},
			{
				label: "transfer restart confirmed, the source's view",
				catches: "the target's right shown in the source's document",
				document: mapped(restartConfirmed, null, "transfer"),
				expected: operationBody({
					command: "transfer",
					action: "transfer",
					status: "applied",
					outcome: "applied",
					storage: { kind: "applied" },
					sends: 2,
					rights: plain(FOREIGN_VIEW),
					transition: transitionBody("confirmed", aId, { kind: "applied" }),
				}),
			},
			{
				label: "retry of the P ID, confirmed",
				catches: "the composite result dropped on retry",
				document: mapped(restartConfirmed, null, "retry"),
				expected: operationBody({
					command: "retry",
					action: "transfer",
					status: "applied",
					outcome: "applied",
					storage: { kind: "applied" },
					sends: 2,
					rights: plain(FOREIGN_VIEW),
					transition: transitionBody("confirmed", aId, { kind: "applied" }),
				}),
			},
			{
				label: "D call without transition (green characterization)",
				catches: "a transition key on a D document (base and administration keys exactly)",
				document: mapped(transitionResult("applied", appliedP, 1, heldAfterExtension(), null)),
				expected: operationBody({
					status: "applied",
					outcome: "applied",
					storage: { kind: "applied" },
					sends: 1,
					rights: HELD_VIEW,
				}),
			},
		];
		checkDocs(rows);
	});

	test("sur-03: builds the composite resolution document and the pending rights view", () => {
		const aId = confirmId();
		// Positive control (catches: the composite result mapped as a single resolution, the transition field dropped).
		expect(docView("confirmed", resolutionDoc(compositeQuery("applied", "confirmed", "stored", "stored")))).toEqual(
			expectedDoc("confirmed", resolutionBody("applied", "stored", { phase: "confirmed", confirmOperationId: aId })),
		);
		const rows: DocRow[] = [
			{
				label: "witnessed, A open",
				catches: "a witness with A open resolved as applied",
				document: resolutionDoc(compositeQuery("unknown", "witnessed", "stored", "open")),
				expected: resolutionBody("unknown", "stored", { phase: "witnessed", confirmOperationId: aId }),
			},
			{
				label: "witnessed, A superseded",
				catches: "the historical APPLIED lost",
				document: resolutionDoc(compositeQuery("applied", "witnessed", "stored", "not-stored")),
				expected: resolutionBody("applied", "stored", { phase: "witnessed", confirmOperationId: aId }),
			},
			{
				label: "pending, p current",
				catches: "an A ID named before any witness exists",
				document: resolutionDoc(compositeQuery("unknown", "pending", "stored", null)),
				expected: resolutionBody("unknown", "stored", { phase: "pending", confirmOperationId: null }),
			},
			{
				label: "pending, p superseded",
				catches: "UNKNOWN_HISTORY mapped to unknown",
				document: resolutionDoc(compositeQuery("unknown-history", "pending", "stored", null)),
				expected: resolutionBody("unknown-history", "stored", { phase: "pending", confirmOperationId: null }),
			},
			{
				label: "P open",
				catches: "phase none dropped for a P ID (every P ID)",
				document: resolutionDoc(compositeQuery("unknown", "none", "open", null)),
				expected: resolutionBody("unknown", "open", { phase: "none", confirmOperationId: null }),
			},
			{
				label: "P not-stored",
				catches: "a rejected P given a confirmation",
				document: resolutionDoc(compositeQuery("rejected", "none", "not-stored", null)),
				expected: resolutionBody("rejected", "not-stored", { phase: "none", confirmOperationId: null }),
			},
			{
				label: "P conflict",
				catches: "a contradicting P receipt resolved as unknown",
				document: resolutionDoc(compositeQuery("unknown-history", "none", "conflict", null)),
				expected: resolutionBody("unknown-history", "conflict", { phase: "none", confirmOperationId: null }),
			},
			{
				label: "single mutation (green characterization)",
				catches: "a transition key on a single resolution (resolution and query unchanged)",
				document: resolutionDoc({ kind: "resolved", resolution: tainted({ kind: "stored", observedRoot: A_ROOT }) }),
				expected: resolutionBody("applied", "stored"),
			},
		];
		checkDocs(rows);
		// RightsView gains ownership and cause pending; the plan cause pending-transition joins PLAN_CAUSES
		// (surface/index.ts:901-920) with its boundary.
		const commands = ["acquire", "renew", "release", "transfer", "resume", "change-bounds"] as const;
		const planRows: DocRow[] = commands.map((command) => {
			const result: Body = {
				kind: "not-planned",
				plan: tainted({ kind: "rejected", cause: "pending-transition", reason: REASON, boundary: HULL }),
				rights: tainted(pendingEvaluation(4)),
			};
			return {
				label: `${command} on PENDING`,
				catches: "pending-transition mapped to internal, or the pending view mapped to unknown",
				document: claimOperationDocument({
					command,
					ticket: TICKET,
					result: tainted(result) as unknown as ClaimExecutionResult,
					planned: null,
					stoppedBy: null,
				}),
				expected: operationBody({
					command,
					action: command,
					status: "rejected",
					outcome: "rejected",
					operationId: null,
					rejection: { stage: "plan", cause: "pending-transition", boundary: HULL },
					storage: null,
					sends: 0,
					rights: pendingView(4),
				}),
			};
		});
		checkDocs(planRows);
		const paused: Body = {
			kind: "paused",
			pause: tainted({ kind: "outstanding", operationIds: [A_LITERAL] }),
			rights: tainted(pendingEvaluation(3)),
		};
		checkDocs([
			{
				label: "own A open at p, pending view",
				catches: "the pause document dropping the pending view (the source pauses at p while A is open)",
				document: claimOperationDocument({
					command: "change-bounds",
					ticket: TICKET,
					result: tainted(paused) as unknown as ClaimExecutionResult,
					planned: null,
					stoppedBy: null,
				}),
				expected: {
					schemaVersion: 1,
					kind: "claim-pause",
					status: "paused",
					command: "change-bounds",
					action: "change-bounds",
					ticket: TICKET,
					operationId: null,
					pause: { kind: "outstanding", operationIds: [A_LITERAL] },
					rights: pendingView(3),
				},
			},
		]);
	});

	test("sur-04: renders a phase line, the retry hint with the A ID and hints for both plan causes", () => {
		const aId = confirmId();
		const witnessed = asDocument(
			operationBody({
				status: "unknown",
				outcome: "unknown",
				storage: { kind: "applied" },
				sends: 4,
				stoppedBy: "attempts",
				rights: pendingView(3),
				transition: transitionBody("witnessed", aId, {
					kind: "queried",
					after: "unknown",
					query: { kind: "resolved", resolution: "open" },
				}),
			}),
		);
		// Positive control (catches: no phase line, no way out for an unpublished witness; the scaffold's formatter).
		expect(textView("witnessed", witnessed, "witnessed")).toEqual(
			textExpected("witnessed", "unknown", "witnessed", { confirmationRetry: 1 }),
		);
		const rows: {
			label: string;
			catches: string;
			document: ClaimDocument;
			head: string;
			phase: string | null;
			fields?: Parameters<typeof textExpected>[3];
		}[] = [
			{
				label: "witnessed, budget stop",
				catches: "the A-ID hint missing after a budget stop",
				document: asDocument(
					operationBody({
						status: "unknown",
						outcome: "unknown",
						storage: { kind: "applied" },
						sends: 1,
						stoppedBy: "budget",
						rights: pendingView(3),
						transition: transitionBody("witnessed", aId, null),
					}),
				),
				head: "unknown",
				phase: "witnessed",
				fields: { confirmationRetry: 1 },
			},
			{
				label: "confirmed",
				catches: "a retry hint on a finished transition",
				document: asDocument(
					operationBody({
						status: "applied",
						outcome: "applied",
						storage: { kind: "applied" },
						sends: 2,
						rights: HELD_VIEW,
						transition: transitionBody("confirmed", aId, { kind: "applied" }),
					}),
				),
				head: "applied",
				phase: "confirmed",
			},
			{
				label: "pending",
				catches: "an A-ID hint before any witness exists",
				document: asDocument(
					operationBody({
						status: "unknown",
						outcome: "unknown",
						storage: { kind: "applied" },
						sends: 1,
						rights: pendingView(3),
						transition: transitionBody("pending", null, null),
					}),
				),
				head: "unknown",
				phase: "pending",
			},
			{
				label: "plan pending-transition",
				catches: "no hint for the new cause (PLAN_HINTS)",
				document: planRejected("pending-transition", HULL),
				head: "rejected",
				phase: null,
				fields: { hints: 1 },
			},
			{
				label: "plan requires-time-path",
				catches: "the reworded hint not naming --hard-end",
				document: planRejected("requires-time-path"),
				head: "rejected",
				phase: null,
				fields: { hints: 1, hardEndHint: true },
			},
			{
				label: "plan not-holder (green characterization)",
				catches: "a hint or a phase line on a cause without one",
				document: planRejected("not-holder"),
				head: "rejected",
				phase: null,
			},
			{
				label: "D document (green characterization)",
				catches: "a phase line without a transition",
				document: asDocument(
					operationBody({
						status: "applied",
						outcome: "applied",
						storage: { kind: "applied" },
						sends: 1,
						rights: HELD_VIEW,
					}),
				),
				head: "applied",
				phase: null,
			},
		];
		for (const row of rows) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(textView(label, row.document, row.phase)).toEqual(textExpected(label, row.head, row.phase, row.fields));
		}
	});

	test("sur-05: previews and plans a PENDING ticket by the hull, shows from and to, and matches either owner", () => {
		// Positive control (catches: PENDING still state-unsupported in the preview; an owner or a timing shown).
		expect(entryView("eligible", verdictFor(transferPending(), HULL + EPS, null))).toEqual(
			previewEntry("eligible", "eligible", 4, OWNER, OTHER_OWNER),
		);
		const rows: {
			name: string;
			catches: string;
			state: PendingClaimState;
			now: number;
			binding: string;
			expected: [string, number, string, string];
		}[] = [
			{
				name: "one ms before the hull",
				catches: "eligible before the hull",
				state: transferPending(),
				now: HULL - 1 + EPS,
				binding: LENA,
				expected: ["not-yet", 4, OWNER, OTHER_OWNER],
			},
			{
				name: "at the source's R",
				catches: "the source's R instead of the hull (no second rule)",
				state: transferPending(),
				now: H + GRACE + EPS,
				binding: LENA,
				expected: ["not-yet", 4, OWNER, OTHER_OWNER],
			},
			{
				name: "seen by the source",
				catches: "an own PENDING hidden or shown as held",
				state: transferPending(),
				now: HULL + EPS,
				binding: KARL,
				expected: ["eligible", 4, OWNER, OTHER_OWNER],
			},
			{
				name: "seen by the target",
				catches: "the target's PENDING shown as ACTIVE",
				state: transferPending(),
				now: HULL + EPS,
				binding: FRANZ,
				expected: ["eligible", 4, OWNER, OTHER_OWNER],
			},
			{
				name: "bound form",
				catches: "the bound form's generation or its single owner lost",
				state: boundPending(),
				now: HULL + EPS,
				binding: LENA,
				expected: ["eligible", 3, OWNER, OWNER],
			},
		];
		for (const row of rows) {
			const label = `${row.name} (catches: ${row.catches})`;
			const [verdict, generation, from, to] = row.expected;
			expect(entryView(label, verdictFor(row.state, row.now, null, row.binding))).toEqual(
				previewEntry(label, verdict, generation, from, to),
			);
		}
		// catches: a batch candidate from a second reclaimability rule (the planner's reclaim plan)
		expectPlanned(
			"batch plan at the hull",
			plan(present(transferPending()), reclaim(), { binding: LENA, now: HULL + EPS }),
			plannedFor(reclaim(), tombstone(4), ROOT, 4),
		);
		expectRejected(
			"batch plan one ms before the hull",
			plan(present(transferPending()), reclaim(), { binding: LENA, now: HULL - 1 + EPS }),
			"not-yet",
			HULL,
		);
		// --claim-owner matches source.owner or target.owner byte-exactly.
		const owners: {
			name: string;
			catches: string;
			state: PendingClaimState;
			claimOwners: string[];
			kept: boolean;
		}[] = [
			{
				name: "source owner",
				catches: "the source owner not matched",
				state: transferPending(),
				claimOwners: [OWNER],
				kept: true,
			},
			{
				name: "target owner",
				catches: "only ACTIVE owners matched (the rejected alternative)",
				state: transferPending(),
				claimOwners: [OTHER_OWNER],
				kept: true,
			},
			{
				name: "third and target owner (OR)",
				catches: "AND instead of OR over the listed owners",
				state: transferPending(),
				claimOwners: [THIRD_OWNER, OTHER_OWNER],
				kept: true,
			},
			{
				name: "third owner",
				catches: "a PENDING of other owners selected",
				state: transferPending(),
				claimOwners: [THIRD_OWNER],
				kept: false,
			},
			{
				name: "source owner in capitals",
				catches: "case folding as identity",
				state: transferPending(),
				claimOwners: [OWNER.toUpperCase()],
				kept: false,
			},
			{
				name: "target owner with a trailing blank",
				catches: "trimming as identity",
				state: transferPending(),
				claimOwners: [`${OTHER_OWNER} `],
				kept: false,
			},
			{
				name: "bound form, other owner",
				catches: "a bound PENDING matched by a stranger",
				state: boundPending(),
				claimOwners: [OTHER_OWNER],
				kept: false,
			},
		];
		for (const row of owners) {
			const label = `${row.name} (catches: ${row.catches})`;
			const generation = row.state.claimGeneration;
			const dropped: EntryView = { label, keys: null, entry: null, echoed: 0 };
			const expected = row.kept
				? previewEntry(label, "eligible", generation, row.state.source.owner, row.state.target.owner)
				: dropped;
			expect(entryView(label, verdictFor(row.state, HULL + EPS, row.claimOwners))).toEqual(expected);
		}
	});
});
