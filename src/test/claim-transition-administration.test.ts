/**
 * Behavioural contract for the administrative actions of the pure claim transition planner: preserve and pure-lease
 * transfer to a native target binding, resume of a claim from the old proof onto a fresh binding, and non-extending
 * bound changes, with the precedence, diagnostics and replay boundary of the base planner. A planned result stays
 * scoped "state-plan-only": no intent, no mutation, no execution admission. No Git, filesystem or clock is used; all
 * times are fixed millisecond constants. Every table names the deliberately wrong planner each row catches.
 *
 * Scaffold names fixed by the contract: the request fields, the causes `time-box-required`, `requires-time-path`,
 * `lease-required` and `mode-change`, the planner options `targetBinding` and `recoveryBinding` and
 * `CLAIM_TRANSITION_ACTIONS`. ASSUMPTION(transition): the type name `ClaimTimeBoxRequest` (the contract fixes only its
 * fields).
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
	type ActiveClaimState,
	type ClaimStateV1,
	type ClaimTiming,
	type FreeClaimState,
	parseClaimState,
} from "../claims/rights/index.ts";
import type { ClaimDocument, ClaimReadResult, ClaimStorageDescriptor, JsonObject } from "../claims/storage/index.ts";
import {
	CLAIM_TRANSITION_ACTIONS,
	type ClaimLeaseRequest,
	type ClaimTimeBoxRequest,
	type ClaimTimingRequest,
	type ClaimTransitionAction,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	type PlanClaimTransitionOptions,
	parseClaimTransitionRequest,
	planClaimTransition,
} from "../claims/transition/index.ts";

// Constants adapted from src/test/claim-transition.test.ts:25–52; RESUMED as src/test/claim-rights.test.ts:30.
const TICKET = "BACK-1";
const ROOT = "a1".repeat(20);
const ROOT_64 = "b2".repeat(32);
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
/** Distinctive context bindings, owner names and roots; no diagnostic may echo any of them. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
/** The fresh binding of Karl's replacement context and a second, independent context. */
const RESUMED = `tb1-${"9d".repeat(32)}`;
const SECOND = `tb1-${"7a".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const SENTINELS = [KARL, FRANZ, RESUMED, SECOND, OWNER, OTHER_OWNER, ROOT, ROOT_64];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX = Number.MAX_SAFE_INTEGER;
/** "10:00"; every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05", its reclaim boundary "10:15" and a hard work limit "11:00". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;

const RECEIPTS: Record<string, JsonObject> = {
	"op-first": { schema: 1, intentDigest: "c3".repeat(32), parameterDigest: "d4".repeat(32) },
	"op-second": { schema: 1, intentDigest: "e5".repeat(32), parameterDigest: "f6".repeat(32) },
};

// Types and helpers adapted from src/test/claim-transition.test.ts:54–310 (the frozen suite exports nothing).
type TtlSource = "default" | "explicit";
type TimeBoxSource = ClaimTimeBoxRequest["source"];
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type Rejection = Extract<ClaimTransitionPlan, { kind: "rejected" }>["cause"];
type Failure = Exclude<ClaimTransitionPlan["kind"], "planned" | "rejected">;
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
type FailureCase = Case & { kind: Failure };

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function lease(leaseEnd = L, hardEnd: number | null = null, graceMs = GRACE): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs, hardEnd };
}

function hard(hardEnd = H, graceMs = GRACE): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs };
}

const TIMELESS: ClaimTiming = { mode: "none" };

function active(timing: ClaimTiming = lease(), changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
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

function foreign(timing: ClaimTiming = lease(), changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
	return active(timing, { binding: FRANZ, owner: OTHER_OWNER, ...changes });
}

function tombstone(claimGeneration = 3): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/** The transfer successor: generation plus one, binding generation 1, Franz. */
function transferred(timing: ClaimTiming, claimGeneration = 4): ActiveClaimState {
	return active(timing, { claimGeneration, bindingGeneration: 1, owner: OTHER_OWNER, binding: FRANZ });
}

/** The resume successor: the fresh binding, binding generation plus one. */
function resumed(timing: ClaimTiming = lease(), bindingGeneration = 2): ActiveClaimState {
	return active(timing, { binding: RESUMED, bindingGeneration });
}

/** A shallow copy of `value` without `key`, built without `delete`. */
function without(value: object, key: string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** A copy whose `key` is an enumerable getter instead of a data property. */
function withAccessor<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

/** A copy whose `key` is a non-enumerable data property. */
function withHidden<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { value: result, enumerable: false, configurable: true, writable: true });
	return copy;
}

function documentOf(payload: unknown, changes: Record<string, unknown> = {}): ClaimDocument {
	return {
		schema: 1,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		revision: 2,
		payload,
		receipts: structuredClone(RECEIPTS),
		...changes,
	} as unknown as ClaimDocument;
}

function present(payload: unknown, root = ROOT, documentChanges: Record<string, unknown> = {}): ClaimReadResult {
	return { kind: "present", ticket: TICKET, root, document: documentOf(payload, documentChanges) };
}

const ABSENT: ClaimReadResult = { kind: "absent", ticket: TICKET };
const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: `upstream ${OWNER} ${KARL} ${FRANZ} ${ROOT}` };
const CORRUPT_PAYLOAD: ClaimReadResult = present({ state: "claimed" });

/** A lease timing in acquire form (claim-transition.test.ts:154–161), used only as a wrong change-bounds shape. */
function leaseRequest(): ClaimTimingRequest {
	return { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
}

/** Deliberately malformed data for invalid-request controls. */
function asTiming(value: unknown): ClaimTiming {
	return value as ClaimTiming;
}

function asTimeBox(value: unknown): ClaimTimeBoxRequest {
	return value as ClaimTimeBoxRequest;
}

function asLease(value: unknown): ClaimLeaseRequest {
	return value as ClaimLeaseRequest;
}

function asRequest(value: unknown): ClaimTransitionRequest {
	return value as ClaimTransitionRequest;
}

function acquire(): ClaimTransitionRequest {
	return { action: "acquire", owner: OWNER, timing: leaseRequest() };
}

function renew(ttlMs = TTL, ttlSource: TtlSource = "default"): ClaimTransitionRequest {
	return { action: "renew", ttlMs, ttlSource };
}

function release(): ClaimTransitionRequest {
	return { action: "release" };
}

function reclaim(): ClaimTransitionRequest {
	return { action: "reclaim" };
}

function leaseOf(ttlMs = TTL, ttlSource: TtlSource = "default"): ClaimLeaseRequest {
	return { ttlMs, ttlSource };
}

function preserve(source: TimeBoxSource = "explicit"): ClaimTimeBoxRequest {
	return { action: "preserve", source };
}

function restart(source: TimeBoxSource = "explicit"): ClaimTimeBoxRequest {
	return { action: "restart", source };
}

/** The recipient's display name, the time-box action and the fresh window; no binding. */
function transfer(
	timeBox: ClaimTimeBoxRequest | null = null,
	fresh: ClaimLeaseRequest | null = leaseOf(),
	owner = OTHER_OWNER,
): ClaimTransitionRequest {
	return { action: "transfer", owner, timeBox, lease: fresh };
}

function resume(): ClaimTransitionRequest {
	return { action: "resume" };
}

/** An absolute target timing in the state form of `ClaimTiming`. */
function changeBounds(timing: ClaimTiming): ClaimTransitionRequest {
	return { action: "change-bounds", timing };
}

/** The eighth action; its one field is the exact root the operator saw in the preview. */
function emergencyRelease(): ClaimTransitionRequest {
	return { action: "emergency-release", expectedRoot: ROOT };
}

/** Karl hands over to Franz. */
const TO_FRANZ: Partial<PlanClaimTransitionOptions> = { targetBinding: FRANZ };
/** The replacement's fresh binding with Karl's old proof. */
const AS_RESUMED: Partial<PlanClaimTransitionOptions> = { binding: RESUMED, recoveryBinding: KARL };

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
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof view.reason,
		reasonEmpty: text.length === 0,
		echoed: [...SENTINELS, ...values].filter((value) => value !== "" && text.includes(value)).length,
	};
}

/** A rejection has exactly kind, cause and reason, plus boundary only for hard-expired, overlong and not-yet. */
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

function checkFailures(cases: FailureCase[]): void {
	for (const { label, catches, observed, request, changes, kind } of cases) {
		expectFailure(`${label} (catches: ${catches})`, plan(observed, request, changes), kind);
	}
}

/** The three negative controls of claim-transition.test.ts:1369–1374: plannable, unreachable, corrupt payload. */
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

function parses(value: unknown): boolean {
	try {
		parseClaimTransitionRequest(value);
		return true;
	} catch {
		return false;
	}
}

describe("claim transition administration: transfer", () => {
	test("tra-01 tra-02: transfers a pure lease with a fresh window from C, also after L and after R", () => {
		const source = present(active(lease(), { bindingGeneration: 5 }));
		// Positive control (catches: no transfer planned, generation kept, binding kept at Karl, owner name kept,
		// binding generation inherited or plus one).
		checkPlanned([
			{
				label: "tra-01 at T, no time box, default lease, stored binding generation 5",
				catches: "generation not advanced, binding left at the source, owner kept, binding generation 5 or 6",
				observed: source,
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(lease(T + TTL))),
			},
		]);
		checkPlanned([
			{
				label: "tra-01 stored lease end 30 minutes ahead",
				catches: "the stored L kept, or max(L, C+ttl), instead of a fresh window",
				observed: present(active(lease(T + 30 * MINUTE), { bindingGeneration: 5 })),
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(lease(T + TTL))),
			},
			{
				label: "tra-02 two minutes after L",
				catches: "the lease end as a transfer bar",
				observed: source,
				request: transfer(),
				changes: { ...TO_FRANZ, now: L + 2 * MINUTE },
				expected: plannedFor(transfer(), transferred(lease(L + 2 * MINUTE + TTL))),
			},
			{
				label: "tra-02 already reclaimable, no reclaim has won",
				catches: "reclaimability as a transfer bar",
				observed: source,
				request: transfer(),
				changes: { ...TO_FRANZ, now: R + EPS },
				expected: plannedFor(transfer(), transferred(lease(R + EPS + TTL))),
			},
			{
				label: "tra-02 explicit thirty-day window without H",
				catches: "an overlong verdict without any hard limit",
				observed: source,
				request: transfer(null, leaseOf(30 * DAY, "explicit")),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(null, leaseOf(30 * DAY, "explicit")), transferred(lease(T + 30 * DAY))),
			},
		]);
	});

	test("tra-03: without H plans preserve and a policy restart; an explicit restart needs the time path", () => {
		// Positive control (catches: a time box demanded without any hard deadline).
		checkPlanned([
			{
				label: "pure lease, no time box",
				catches: "a time box demanded without H",
				observed: present(active()),
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(lease(T + TTL))),
			},
		]);
		const plannable: [string, ClaimTimeBoxRequest][] = [
			["preserve, explicit", preserve("explicit")],
			["preserve by policy", preserve("policy")],
			["restart by policy, nothing to restart without H", restart("policy")],
		];
		checkPlanned(
			plannable.map(([label, timeBox]) => ({
				label: `pure lease, ${label}`,
				catches: "a policy restart blocking a pure-lease transfer, or preserve rejected without H",
				observed: present(active()),
				request: transfer(timeBox),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(timeBox), transferred(lease(T + TTL))),
			})),
		);
		checkPlanned([
			{
				label: "timeless, restart by policy (without H)",
				catches: "the policy rule applied to the lease mode only",
				observed: present(active(TIMELESS)),
				request: transfer(restart("policy"), null),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(restart("policy"), null), transferred(TIMELESS)),
			},
		]);
		checkRejected([
			{
				label: "pure lease, restart explicit",
				catches: "an explicit restart silently ignored",
				observed: present(active()),
				request: transfer(restart("explicit")),
				changes: TO_FRANZ,
				cause: "requires-time-path",
			},
			{
				label: "timeless, restart explicit",
				catches: "an explicit restart silently ignored in the timeless mode",
				observed: present(active(TIMELESS)),
				request: transfer(restart("explicit"), null),
				changes: TO_FRANZ,
				cause: "requires-time-path",
			},
		]);
	});

	test("tra-04 tra-05: follows renew under a stored H with preserve: capped, overlong, expired from C+eps>=H", () => {
		const withH = present(active(lease(L, H)));
		// Positive control (catches: capping applied without need, H or grace changed by the transfer).
		checkPlanned([
			{
				label: "preserve at T, default TTL well below H",
				catches: "capping applied without need, H or grace changed",
				observed: withH,
				request: transfer(preserve()),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve()), transferred(lease(T + TTL, H))),
			},
		]);
		checkPlanned([
			{
				label: "tra-04 default TTL at H-3 min",
				catches: "a default window not capped at H, or H moved",
				observed: withH,
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H - 3 * MINUTE },
				expected: plannedFor(transfer(preserve()), transferred(lease(H, H))),
			},
			{
				label: "tra-04 explicit 3 min at H-3 min, C+ttl equal to H",
				catches: "overlong at the exact limit",
				observed: withH,
				request: transfer(preserve(), leaseOf(3 * MINUTE, "explicit")),
				changes: { ...TO_FRANZ, now: H - 3 * MINUTE },
				expected: plannedFor(transfer(preserve(), leaseOf(3 * MINUTE, "explicit")), transferred(lease(H, H))),
			},
			{
				label: "tra-04 zero grace, preserve by policy, at H-3 min",
				catches: "the grace reset by the transfer",
				observed: present(active(lease(L, H, 0))),
				request: transfer(preserve("policy")),
				changes: { ...TO_FRANZ, now: H - 3 * MINUTE },
				expected: plannedFor(transfer(preserve("policy")), transferred(lease(H, H, 0))),
			},
			{
				label: "tra-05 C+eps one ms before H",
				catches: "`<=` instead of `<` at H",
				observed: withH,
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H - EPS - 1 },
				expected: plannedFor(transfer(preserve()), transferred(lease(H, H))),
			},
		]);
		checkRejected([
			{
				label: "tra-04 explicit 5 min at H-3 min",
				catches: "an explicit TTL silently shortened",
				observed: withH,
				request: transfer(preserve(), leaseOf(5 * MINUTE, "explicit")),
				changes: { ...TO_FRANZ, now: H - 3 * MINUTE },
				cause: "overlong",
				boundary: H,
			},
			{
				label: "tra-05 C+eps exactly H",
				catches: "-eps instead of +eps, or `<=` at H",
				observed: withH,
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "tra-05 after H",
				catches: "a window capped to H after H, which would move R from L+g to H+g",
				observed: withH,
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H + MINUTE },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "tra-05 epsilon zero, exactly H",
				catches: "an epsilon default",
				observed: withH,
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H, clockSkewMs: 0 },
				cause: "hard-expired",
				boundary: H,
			},
		]);
	});

	test("tra-06 tra-07: keeps hard and timeless timing, also after H; an explicit lease is not-renewable", () => {
		// Positive control (catches: a hard transfer rejected, given a lease or a recomputed H).
		checkPlanned([
			{
				label: "tra-06 hard, preserve, no lease, at T",
				catches: "a hard claim turned into a lease, or H recomputed",
				observed: present(active(hard())),
				request: transfer(preserve(), null),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve(), null), transferred(hard())),
			},
		]);
		const hardRows: [string, ClaimLeaseRequest | null, number][] = [
			["default lease ignored, at T", leaseOf(), T],
			["no lease, after H", null, H + MINUTE],
			["default lease ignored, after H", leaseOf(), H + MINUTE],
		];
		checkPlanned(
			hardRows.map(([label, fresh, now]) => ({
				label: `tra-06 hard, preserve, ${label}`,
				catches: "a hard-mode transfer after H rejected, a default lease applied, or H recomputed",
				observed: present(active(hard())),
				request: transfer(preserve(), fresh),
				changes: { ...TO_FRANZ, now },
				expected: plannedFor(transfer(preserve(), fresh), transferred(hard())),
			})),
		);
		checkPlanned([
			{
				label: "tra-07 timeless, no time box, no lease",
				catches: "a timeless claim given a lease",
				observed: present(active(TIMELESS)),
				request: transfer(null, null),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(null, null), transferred(TIMELESS)),
			},
			{
				label: "tra-07 timeless, default lease ignored",
				catches: "a default lease applied to the timeless mode",
				observed: present(active(TIMELESS)),
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(TIMELESS)),
			},
		]);
		checkRejected([
			{
				label: "tra-06 hard, preserve, explicit lease, at T",
				catches: "an explicit lease silently dropped",
				observed: present(active(hard())),
				request: transfer(preserve(), leaseOf(TTL, "explicit")),
				changes: TO_FRANZ,
				cause: "not-renewable",
			},
			{
				label: "tra-06 hard, preserve, explicit lease, after H",
				catches: "an explicit lease silently dropped after H",
				observed: present(active(hard())),
				request: transfer(preserve(), leaseOf(TTL, "explicit")),
				changes: { ...TO_FRANZ, now: H + MINUTE },
				cause: "not-renewable",
			},
			{
				label: "tra-07 timeless, explicit lease",
				catches: "a timeless claim given an explicit lease",
				observed: present(active(TIMELESS)),
				request: transfer(null, leaseOf(TTL, "explicit")),
				changes: TO_FRANZ,
				cause: "not-renewable",
			},
		]);
	});

	test("tra-08: requires an explicit time-box action under a stored H, also after H, without a silent default", () => {
		// Positive control (catches: a policy-resolved preserve rejected).
		checkPlanned([
			{
				label: "hard, preserve by policy",
				catches: "a policy-resolved preserve rejected",
				observed: present(active(hard())),
				request: transfer(preserve("policy")),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve("policy")), transferred(hard())),
			},
		]);
		checkPlanned([
			{
				label: "lease with H, preserve by policy",
				catches: "the policy source accepted for hard mode only",
				observed: present(active(lease(L, H))),
				request: transfer(preserve("policy")),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve("policy")), transferred(lease(T + TTL, H))),
			},
		]);
		checkRejected([
			{
				label: "hard, no time box",
				catches: "preserve as a silent default",
				observed: present(active(hard())),
				request: transfer(),
				changes: TO_FRANZ,
				cause: "time-box-required",
			},
			{
				label: "lease with H, no time box",
				catches: "the time-box rule applied to hard mode only",
				observed: present(active(lease(L, H))),
				request: transfer(),
				changes: TO_FRANZ,
				cause: "time-box-required",
			},
			{
				label: "hard, no time box, after H",
				catches: "the time-box check only before H",
				observed: present(active(hard())),
				request: transfer(),
				changes: { ...TO_FRANZ, now: H + MINUTE },
				cause: "time-box-required",
			},
		]);
	});

	test("tra-09: sends every restart under a stored H to the time path, by any source, before and after H", () => {
		// Positive control (catches: every time-box action under H rejected).
		checkPlanned([
			{
				label: "hard, preserve explicit",
				catches: "every time-box action under H rejected",
				observed: present(active(hard())),
				request: transfer(preserve()),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve()), transferred(hard())),
			},
		]);
		const stored: [string, ActiveClaimState][] = [
			["hard", active(hard())],
			["lease with H", active(lease(L, H))],
		];
		const sources: TimeBoxSource[] = ["explicit", "policy"];
		const instants: [string, number][] = [
			["at T", T],
			["after H", H + MINUTE],
		];
		checkRejected(
			stored.flatMap(([mode, state]) =>
				sources.flatMap((source) =>
					instants.map(
						([when, now]): RejectedCase => ({
							label: `${mode}, restart by ${source}, ${when}`,
							catches: "a restart planned as preserve, or a new time box over the direct path",
							observed: present(state),
							request: transfer(restart(source)),
							changes: { ...TO_FRANZ, now },
							cause: "requires-time-path",
						}),
					),
				),
			),
		);
	});

	test("tra-10: requires a lease request in lease mode instead of keeping the stored lease end", () => {
		// Positive control (catches: a lease-mode transfer rejected despite a lease request).
		checkPlanned([
			{
				label: "pure lease, default lease",
				catches: "a lease-mode transfer rejected despite a lease request",
				observed: present(active()),
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(lease(T + TTL))),
			},
		]);
		const rows: [string, ClaimTiming, ClaimTimeBoxRequest | null][] = [
			["pure lease, no time box", lease(), null],
			["pure lease, preserve", lease(), preserve()],
			["pure lease, restart by policy", lease(), restart("policy")],
			["lease with H, preserve", lease(L, H), preserve()],
		];
		checkRejected(
			rows.map(
				([label, timing, timeBox]): RejectedCase => ({
					label: `${label}, no lease`,
					catches: "the stored L silently kept instead of a fresh window",
					observed: present(active(timing)),
					request: transfer(timeBox, null),
					changes: TO_FRANZ,
					cause: "lease-required",
				}),
			),
		);
	});

	test("tra-11: lets only the current binding holder transfer, never a late repeat, a free or an absent ticket", () => {
		// Positive control (catches: no transfer planned at all).
		checkPlanned([
			{
				label: "own claim, matching expectation 3",
				catches: "the expectation compared with the next generation",
				observed: present(active()),
				request: transfer(),
				changes: { ...TO_FRANZ, expectedClaimGeneration: 3 },
				expected: plannedFor(transfer(), transferred(lease(T + TTL))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder carrying Karl's owner name",
				catches: "authority from the owner name, or no binding check",
				observed: present(foreign(lease(), { binding: SECOND, owner: OWNER })),
				request: transfer(),
				changes: TO_FRANZ,
				cause: "not-holder",
			},
			{
				label: "tombstone",
				catches: "a transfer on a free ticket",
				observed: present(tombstone()),
				request: transfer(),
				changes: TO_FRANZ,
				cause: "free",
			},
			{
				label: "absent",
				catches: "a transfer creating a claim",
				observed: ABSENT,
				request: transfer(),
				changes: TO_FRANZ,
				cause: "absent",
			},
			{
				label: "already at Franz with generation 4, Karl transfers again",
				catches: "a late acknowledgement or repeat transferring again",
				observed: present(foreign(lease(), { claimGeneration: 4 })),
				request: transfer(),
				changes: TO_FRANZ,
				cause: "not-holder",
			},
			{
				label: "own claim, expectation 2",
				catches: "a missing continuity check on transfer",
				observed: present(active()),
				request: transfer(),
				changes: { ...TO_FRANZ, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "own claim, expectation 4",
				catches: "a one-sided continuity check",
				observed: present(active()),
				request: transfer(),
				changes: { ...TO_FRANZ, expectedClaimGeneration: 4 },
				cause: "generation-changed",
			},
		]);
	});

	test("tra-12: invalidates the old proof after the transfer and hands every further right to Franz", () => {
		const handedOver = present(transferred(lease(T + TTL)), ROOT_64);
		// Positive control (catches: the recipient without the holder's rights).
		checkPlanned([
			{
				label: "Franz renews",
				catches: "the recipient without the holder's rights",
				observed: handedOver,
				request: renew(),
				changes: { binding: FRANZ },
				expected: plannedFor(renew(), transferred(lease(T + TTL)), ROOT_64, 4),
			},
		]);
		checkPlanned([
			{
				label: "Franz transfers back to Karl",
				catches: "generation not advanced on the second transfer, or a binding blacklist against Karl",
				observed: handedOver,
				request: transfer(null, leaseOf(), OWNER),
				changes: { binding: FRANZ, targetBinding: KARL },
				expected: plannedFor(
					transfer(null, leaseOf(), OWNER),
					active(lease(T + TTL), { claimGeneration: 5, bindingGeneration: 1, owner: OWNER, binding: KARL }),
					ROOT_64,
					4,
				),
			},
		]);
		const oldProof = "the old proof still valid after the transfer";
		checkRejected([
			{ label: "Karl renews", catches: oldProof, observed: handedOver, request: renew(), cause: "not-holder" },
			{ label: "Karl releases", catches: oldProof, observed: handedOver, request: release(), cause: "not-holder" },
			{
				label: "Karl transfers to Second",
				catches: oldProof,
				observed: handedOver,
				request: transfer(),
				changes: { targetBinding: SECOND },
				cause: "not-holder",
			},
			{
				label: "Karl shortens the bounds",
				catches: oldProof,
				observed: handedOver,
				request: changeBounds(lease(T + TTL - MINUTE)),
				cause: "not-holder",
			},
			{
				label: "Karl's replacement resumes with Karl's proof",
				catches: "a replacement of the source inheriting the transferred claim",
				observed: handedOver,
				request: resume(),
				changes: AS_RESUMED,
				cause: "not-holder",
			},
			{
				label: "Franz with expectation 3",
				catches: "the claim generation not advanced by the transfer",
				observed: handedOver,
				request: renew(),
				changes: { binding: FRANZ, expectedClaimGeneration: 3 },
				cause: "generation-changed",
			},
			{
				label: "Karl with expectation 4",
				catches: "generation before ownership",
				observed: handedOver,
				request: renew(),
				changes: { expectedClaimGeneration: 4 },
				cause: "not-holder",
			},
		]);
	});

	test("tra-13: rejects a generation or window beyond the safe-integer range as invalid, plans at the limit", () => {
		// Positive control (catches: an off-by-one generation check).
		checkPlanned([
			{
				label: "generation one below the largest",
				catches: "an off-by-one generation check",
				observed: present(active(lease(), { claimGeneration: MAX - 1 })),
				request: transfer(),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(), transferred(lease(T + TTL), MAX), ROOT, MAX - 1),
			},
		]);
		checkPlanned([
			{
				label: "lease end plus grace exactly at the limit",
				catches: "an off-by-one range check",
				observed: present(active()),
				request: transfer(null, leaseOf(MAX - GRACE - T)),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(null, leaseOf(MAX - GRACE - T)), transferred(lease(MAX - GRACE))),
			},
		]);
		checkFailures([
			{
				label: "generation at the largest safe integer",
				catches: "a wrapped or unsafe generation",
				observed: present(active(lease(), { claimGeneration: MAX })),
				request: transfer(),
				changes: TO_FRANZ,
				kind: "invalid",
			},
			{
				label: "hard claim at the largest generation",
				catches: "the generation range checked on the lease path only",
				observed: present(active(hard(), { claimGeneration: MAX })),
				request: transfer(preserve()),
				changes: TO_FRANZ,
				kind: "invalid",
			},
			{
				label: "C+ttl overflows by the ttl",
				catches: "an unsafe lease end",
				observed: present(active()),
				request: transfer(null, leaseOf(MAX - T + 1)),
				changes: TO_FRANZ,
				kind: "invalid",
			},
			{
				label: "C+ttl overflows by the clock reading",
				catches: "the overflow checked on the ttl alone",
				observed: present(active()),
				request: transfer(),
				changes: { ...TO_FRANZ, now: MAX - EPS },
				kind: "invalid",
			},
			{
				label: "lease end plus grace overflows",
				catches: "an unreclaimable window",
				observed: present(active()),
				request: transfer(null, leaseOf(MAX - GRACE - T + 1)),
				changes: TO_FRANZ,
				kind: "invalid",
			},
		]);
	});
});

describe("claim transition administration: resume", () => {
	test("res-01: resumes onto the replacement's fresh binding with binding generation plus one", () => {
		// Positive control (catches: resume treated as a transfer with generation plus one, the recovery binding as
		// the successor, the binding generation kept, the owner changed).
		checkPlanned([
			{
				label: "pure lease at T",
				catches: "generation plus one, recovery binding as successor, binding generation kept, owner changed",
				observed: present(active()),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed()),
			},
		]);
		checkPlanned([
			{
				label: "two minutes after L",
				catches: "a renewed lease window",
				observed: present(active()),
				request: resume(),
				changes: { ...AS_RESUMED, now: L + 2 * MINUTE },
				expected: plannedFor(resume(), resumed()),
			},
			{
				label: "at a 64-hex root",
				catches: "the expected root not taken from the observation",
				observed: present(active(), ROOT_64),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed(), ROOT_64),
			},
		]);
	});

	test("res-02: resumes in every mode and at any time with unchanged timing, never reviving a right after H", () => {
		// Positive control (catches: no resume planned at all).
		checkPlanned([
			{
				label: "pure lease at T",
				catches: "no resume planned at all",
				observed: present(active()),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed()),
			},
		]);
		const cases: [string, ActiveClaimState, number][] = [
			["pure lease already reclaimable", active(), R + EPS],
			["lease with H after H", active(lease(L, H)), H + MINUTE],
			["hard after H", active(hard()), H + MINUTE],
			["timeless", active(TIMELESS), T],
		];
		checkPlanned(
			cases.map(([label, state, now]) => ({
				label,
				catches: "resume after H rejected (allowed), H moved, a time gate, or the window renewed",
				observed: present(state),
				request: resume(),
				changes: { ...AS_RESUMED, now },
				expected: plannedFor(resume(), resumed(state.timing)),
			})),
		);
		checkPlanned([
			{
				label: "binding generation 7",
				catches: "the binding generation reset to 2 instead of plus one",
				observed: present(active(lease(), { bindingGeneration: 7 })),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed(lease(), 8)),
			},
		]);
	});

	test("res-03: resumes only with the holder's old proof, never an own, foreign, free or absent claim", () => {
		// Positive control (catches: no resume planned at all).
		checkPlanned([
			{
				label: "Karl holds, replacement with Karl's proof",
				catches: "no resume planned at all",
				observed: present(active()),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed()),
			},
		]);
		checkRejected([
			{
				label: "Franz holds",
				catches: "the proof check skipped",
				observed: present(foreign()),
				request: resume(),
				changes: AS_RESUMED,
				cause: "not-holder",
			},
			{
				label: "the replacement already holds",
				catches: "a second resume onto the own binding",
				observed: present(resumed()),
				request: resume(),
				changes: AS_RESUMED,
				cause: "held",
			},
			{
				label: "tombstone",
				catches: "resume as an acquire of a free ticket",
				observed: present(tombstone()),
				request: resume(),
				changes: AS_RESUMED,
				cause: "free",
			},
			{
				label: "absent",
				catches: "resume creating a claim",
				observed: ABSENT,
				request: resume(),
				changes: AS_RESUMED,
				cause: "absent",
			},
			{
				label: "expectation 2",
				catches: "a missing continuity check on resume",
				observed: present(active()),
				request: resume(),
				changes: { ...AS_RESUMED, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "Karl holds, proof of Franz",
				catches: "any well-formed proof accepted instead of the holder's",
				observed: present(active()),
				request: resume(),
				changes: { binding: RESUMED, recoveryBinding: FRANZ },
				cause: "not-holder",
			},
		]);
	});

	test("res-04: consumes the old proof: a second replacement loses, the resumed binding chains", () => {
		const afterResume = present(resumed(), ROOT_64);
		// Positive control (catches: the resumed binding without the holder's rights).
		checkPlanned([
			{
				label: "the replacement renews",
				catches: "the resumed binding without the holder's rights",
				observed: afterResume,
				request: renew(),
				changes: { binding: RESUMED },
				expected: plannedFor(renew(), resumed(lease(T + TTL)), ROOT_64),
			},
		]);
		checkPlanned([
			{
				label: "chain: Second resumes with the replacement's proof",
				catches: "the recovery chain broken, or the binding generation not advanced again",
				observed: afterResume,
				request: resume(),
				changes: { binding: SECOND, recoveryBinding: RESUMED },
				expected: plannedFor(resume(), active(lease(), { binding: SECOND, bindingGeneration: 3 }), ROOT_64),
			},
		]);
		checkRejected([
			{
				label: "a second replacement with Karl's proof",
				catches: "the proof not consumed: double authorization",
				observed: afterResume,
				request: resume(),
				changes: { binding: SECOND, recoveryBinding: KARL },
				cause: "not-holder",
			},
			{
				label: "the replacement resumes again",
				catches: "a repeated resume planned onto the own binding",
				observed: afterResume,
				request: resume(),
				changes: AS_RESUMED,
				cause: "held",
			},
			{
				label: "Karl renews",
				catches: "the original keeps the right after the resume",
				observed: afterResume,
				request: renew(),
				cause: "not-holder",
			},
		]);
	});

	test("res-05: rejects a binding generation beyond the safe-integer range, after the ownership verdict", () => {
		// Positive control (catches: an off-by-one binding generation check).
		checkPlanned([
			{
				label: "binding generation one below the largest",
				catches: "an off-by-one binding generation check",
				observed: present(active(lease(), { bindingGeneration: MAX - 1 })),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed(lease(), MAX)),
			},
		]);
		checkFailures([
			{
				label: "binding generation at the largest safe integer",
				catches: "a wrapped or unsafe binding generation",
				observed: present(active(lease(), { bindingGeneration: MAX })),
				request: resume(),
				changes: AS_RESUMED,
				kind: "invalid",
			},
		]);
		checkRejected([
			{
				label: "foreign holder at the largest binding generation",
				catches: "range before ownership",
				observed: present(foreign(lease(), { bindingGeneration: MAX })),
				request: resume(),
				changes: AS_RESUMED,
				cause: "not-holder",
			},
		]);
	});
});

describe("claim transition administration: change-bounds", () => {
	test("bnd-01: plans shortened deadlines, grace and bounds under H with every other field unchanged", () => {
		// Positive control (catches: no change-bounds planned, or a shortening rejected).
		checkPlanned([
			{
				label: "hard H to H-30 min",
				catches: "a shortening rejected",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				expected: plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
			},
		]);
		const rows: [string, ClaimTiming, ClaimTiming][] = [
			["hard, grace to zero", hard(), hard(H, 0)],
			["hard, deadline moved into the past", hard(), hard(T - MINUTE)],
			["hard, earlier deadline with more grace, R unchanged", hard(), hard(H - MINUTE, GRACE + MINUTE)],
			["lease with H, H lowered by 10 min", lease(L, H), lease(L, H - 10 * MINUTE)],
			[
				"lease with H, earlier lease end with more grace, R unchanged",
				lease(L, H),
				lease(L - MINUTE, H, GRACE + MINUTE),
			],
		];
		checkPlanned(
			rows.map(([label, from, to]) => ({
				label,
				catches: "a non-extending change rejected or sent to the time path",
				observed: present(active(from)),
				request: changeBounds(to),
				expected: plannedFor(changeBounds(to), active(to)),
			})),
		);
		checkPlanned([
			{
				label: "generations, owner and binding carried unchanged",
				catches: "the rest of the state changed by a bound change",
				observed: present(active(hard(), { claimGeneration: 7, bindingGeneration: 2, owner: OTHER_OWNER })),
				request: changeBounds(hard(H - 30 * MINUTE)),
				expected: plannedFor(
					changeBounds(hard(H - 30 * MINUTE)),
					active(hard(H - 30 * MINUTE), { claimGeneration: 7, bindingGeneration: 2, owner: OTHER_OWNER }),
					ROOT,
					7,
				),
			},
			{
				label: "hard, shortened one day after H plus grace",
				catches: "a clock verdict on change-bounds (management after H is allowed)",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				changes: { now: H + GRACE + DAY },
				expected: plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
			},
			{
				label: "lease with H, H lowered after H",
				catches: "a clock verdict on change-bounds",
				observed: present(active(lease(L, H))),
				request: changeBounds(lease(L, H - 10 * MINUTE)),
				changes: { now: H + MINUTE },
				expected: plannedFor(changeBounds(lease(L, H - 10 * MINUTE)), active(lease(L, H - 10 * MINUTE))),
			},
		]);
	});

	test("bnd-02: plans any change of a pure lease without H, including a first hard limit (H-free)", () => {
		// Positive control (catches: an H-free change sent to the time path).
		checkPlanned([
			{
				label: "pure lease to L plus one day",
				catches: "an H-free change sent to the time path",
				observed: present(active()),
				request: changeBounds(lease(L + DAY)),
				expected: plannedFor(changeBounds(lease(L + DAY)), active(lease(L + DAY))),
			},
		]);
		const rows: [string, ClaimTiming][] = [
			["pure lease, grace doubled", lease(L, null, 2 * GRACE)],
			["pure lease, lease end moved into the past", lease(T - MINUTE)],
			["pure lease, first hard limit H", lease(L, H)],
		];
		checkPlanned(
			rows.map(([label, to]) => ({
				label,
				catches: "an H-free change sent to the time path, or a first bound counted as extending",
				observed: present(active()),
				request: changeBounds(to),
				expected: plannedFor(changeBounds(to), active(to)),
			})),
		);
		checkPlanned([
			{
				label: "pure lease, one day later, already reclaimable",
				catches: "a clock verdict on change-bounds",
				observed: present(active()),
				request: changeBounds(lease(L + DAY)),
				changes: { now: R + EPS },
				expected: plannedFor(changeBounds(lease(L + DAY)), active(lease(L + DAY))),
			},
		]);
	});

	test("bnd-03: sends every extension of W, a removed H and every raised R under H to the time path", () => {
		// Positive control (catches: `<` instead of `<=` on R; a lower H with more grace but equal R rejected).
		checkPlanned([
			{
				label: "hard, H-1 with grace+1, R equal",
				catches: "`<` instead of `<=` on R",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 1, GRACE + 1)),
				expected: plannedFor(changeBounds(hard(H - 1, GRACE + 1)), active(hard(H - 1, GRACE + 1))),
			},
			{
				label: "lease with H, L-1 with grace+1, R equal",
				catches: "`<` instead of `<=` on R in lease mode",
				observed: present(active(lease(L, H))),
				request: changeBounds(lease(L - 1, H, GRACE + 1)),
				expected: plannedFor(changeBounds(lease(L - 1, H, GRACE + 1)), active(lease(L - 1, H, GRACE + 1))),
			},
		]);
		const extending: [string, ClaimTiming, ClaimTiming][] = [
			["hard, H+1", hard(), hard(H + 1)],
			["hard, grace+1", hard(), hard(H, GRACE + 1)],
			["hard, H-1 with grace+2, R+1", hard(), hard(H - 1, GRACE + 2)],
			["hard, lower H but a later R", hard(), hard(H - 30 * MINUTE, GRACE + 31 * MINUTE)],
			["lease with H, H+1", lease(L, H), lease(L, H + 1)],
			["lease with H, H removed", lease(L, H), lease(L, null)],
			["lease with H, L+1", lease(L, H), lease(L + 1, H)],
			["lease with H, grace+1", lease(L, H), lease(L, H, GRACE + 1)],
			["lease with H, L-1 with grace+2, R+1", lease(L, H), lease(L - 1, H, GRACE + 2)],
			["lease with H, lower H but a later R", lease(L, H), lease(L + 1, H - 10 * MINUTE)],
		];
		const instants: [string, number][] = [
			["at T", T],
			["after H", H + MINUTE],
		];
		checkRejected(
			extending.flatMap(([label, from, to]) =>
				instants.map(
					([when, now]): RejectedCase => ({
						label: `${label}, ${when}`,
						catches: "an extension planned: `<=` for `<`, H removal or a grace raise as D, W checked alone, a clock",
						observed: present(active(from)),
						request: changeBounds(to),
						changes: { now },
						cause: "requires-time-path",
					}),
				),
			),
		);
	});

	test("bnd-04: rejects every mode change as mode-change, never a silent switch", () => {
		// Positive control (catches: a same-mode change reported as mode-change).
		checkPlanned([
			{
				label: "lease with H, H lowered",
				catches: "a same-mode change reported as mode-change",
				observed: present(active(lease(L, H))),
				request: changeBounds(lease(L, H - 10 * MINUTE)),
				expected: plannedFor(changeBounds(lease(L, H - 10 * MINUTE)), active(lease(L, H - 10 * MINUTE))),
			},
		]);
		const pairs: [string, ClaimTiming, ClaimTiming][] = [
			["lease with H to hard at H", lease(L, H), hard()],
			["hard to lease with H", hard(), lease(L, H)],
			["pure lease to timeless", lease(), TIMELESS],
			["timeless to pure lease", TIMELESS, lease()],
			["hard to timeless", hard(), TIMELESS],
			["timeless to hard", TIMELESS, hard()],
		];
		checkRejected(
			pairs.map(
				([label, from, to]): RejectedCase => ({
					label,
					catches: "a silent mode switch, or a restricting switch planned",
					observed: present(active(from)),
					request: changeBounds(to),
					cause: "mode-change",
				}),
			),
		);
	});

	test("bnd-05: plans an unchanged timing in every mode as a no-op write", () => {
		// Positive control (catches: no change-bounds planned at all).
		checkPlanned([
			{
				label: "hard H to H-30 min",
				catches: "no change-bounds planned at all",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				expected: plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
			},
		]);
		const unchanged: [string, ClaimTiming][] = [
			["pure lease", lease()],
			["lease with H", lease(L, H)],
			["hard", hard()],
			["timeless", TIMELESS],
		];
		checkPlanned(
			unchanged.map(([label, timing]) => ({
				label: `${label}, unchanged`,
				catches: "a no-op counted as extending, as a mode change or as invalid",
				observed: present(active(timing)),
				request: changeBounds(timing),
				expected: plannedFor(changeBounds(timing), active(timing)),
			})),
		);
	});

	test("bnd-06: lets only the own binding change bounds, never on a foreign, free or absent claim", () => {
		// Positive control (catches: an own shortening rejected).
		checkPlanned([
			{
				label: "own hard claim shortened",
				catches: "an own shortening rejected",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				expected: plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder, shortening",
				catches: "a foreign change accepted (no permission model for it)",
				observed: present(foreign(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				cause: "not-holder",
			},
			{
				label: "foreign holder, extending",
				catches: "the time-path verdict before ownership",
				observed: present(foreign(hard())),
				request: changeBounds(hard(H + DAY)),
				cause: "not-holder",
			},
			{
				label: "foreign holder, mode change",
				catches: "the mode verdict before ownership",
				observed: present(foreign(hard())),
				request: changeBounds(TIMELESS),
				cause: "not-holder",
			},
			{
				label: "tombstone",
				catches: "a bound change reviving a released claim",
				observed: present(tombstone()),
				request: changeBounds(hard()),
				cause: "free",
			},
			{
				label: "absent",
				catches: "a bound change creating a claim",
				observed: ABSENT,
				request: changeBounds(hard()),
				cause: "absent",
			},
			{
				label: "own hard claim, expectation 2",
				catches: "a missing continuity check on change-bounds",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
		]);
	});
});

describe("claim transition administration: rejection precedence", () => {
	test("pre-01: orders transfer verdicts: ownership, generation, mode slot, time, range", () => {
		// Positive control (catches: a lease-with-H preserve transfer rejected).
		checkPlanned([
			{
				label: "lease with H, preserve",
				catches: "a lease-with-H preserve transfer rejected",
				observed: present(active(lease(L, H))),
				request: transfer(preserve()),
				changes: TO_FRANZ,
				expected: plannedFor(transfer(preserve()), transferred(lease(T + TTL, H))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder, restart",
				catches: "the time-path verdict before ownership",
				observed: present(foreign(lease(L, H))),
				request: transfer(restart()),
				changes: TO_FRANZ,
				cause: "not-holder",
			},
			{
				label: "foreign holder at the largest generation",
				catches: "range before ownership",
				observed: present(foreign(lease(), { claimGeneration: MAX })),
				request: transfer(),
				changes: { targetBinding: SECOND },
				cause: "not-holder",
			},
			{
				label: "own claim, wrong expectation, restart",
				catches: "the mode slot before generation",
				observed: present(active(lease(L, H))),
				request: transfer(restart()),
				changes: { ...TO_FRANZ, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "own hard claim, wrong expectation, no time box",
				catches: "the time-box rule before generation",
				observed: present(active(hard())),
				request: transfer(),
				changes: { ...TO_FRANZ, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "pure lease, restart explicit, no lease",
				catches: "lease-required before requires-time-path",
				observed: present(active()),
				request: transfer(restart(), null),
				changes: TO_FRANZ,
				cause: "requires-time-path",
			},
			{
				label: "hard, restart explicit, explicit lease",
				catches: "not-renewable before requires-time-path",
				observed: present(active(hard())),
				request: transfer(restart(), leaseOf(TTL, "explicit")),
				changes: TO_FRANZ,
				cause: "requires-time-path",
			},
			{
				label: "hard, no time box, explicit lease",
				catches: "not-renewable before time-box-required",
				observed: present(active(hard())),
				request: transfer(null, leaseOf(TTL, "explicit")),
				changes: TO_FRANZ,
				cause: "time-box-required",
			},
			{
				label: "lease with H, no time box, no lease",
				catches: "lease-required before time-box-required",
				observed: present(active(lease(L, H))),
				request: transfer(null, null),
				changes: TO_FRANZ,
				cause: "time-box-required",
			},
			{
				label: "lease with H, restart at H",
				catches: "time before the mode slot",
				observed: present(active(lease(L, H))),
				request: transfer(restart()),
				changes: { ...TO_FRANZ, now: H },
				cause: "requires-time-path",
			},
			{
				label: "lease with H, no time box after H",
				catches: "time before the time-box rule",
				observed: present(active(lease(L, H))),
				request: transfer(),
				changes: { ...TO_FRANZ, now: H + MINUTE },
				cause: "time-box-required",
			},
			{
				label: "lease with H, preserve, no lease at H",
				catches: "time before lease-required",
				observed: present(active(lease(L, H))),
				request: transfer(preserve(), null),
				changes: { ...TO_FRANZ, now: H },
				cause: "lease-required",
			},
			{
				label: "lease with H, preserve at H, largest generation",
				catches: "range before time",
				observed: present(active(lease(L, H), { claimGeneration: MAX })),
				request: transfer(preserve()),
				changes: { ...TO_FRANZ, now: H },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "lease with H, explicit overlong, largest generation",
				catches: "range before time",
				observed: present(active(lease(L, H), { claimGeneration: MAX })),
				request: transfer(preserve(), leaseOf(90 * MINUTE, "explicit")),
				changes: TO_FRANZ,
				cause: "overlong",
				boundary: H,
			},
		]);
	});

	test("pre-02: orders resume verdicts: state, held before not-holder, then generation", () => {
		// Positive control (catches: no resume planned at all).
		checkPlanned([
			{
				label: "resume with Karl's proof",
				catches: "no resume planned at all",
				observed: present(active()),
				request: resume(),
				changes: AS_RESUMED,
				expected: plannedFor(resume(), resumed()),
			},
		]);
		checkRejected([
			{
				label: "tombstone, wrong expectation",
				catches: "generation before state",
				observed: present(tombstone()),
				request: resume(),
				changes: { ...AS_RESUMED, expectedClaimGeneration: 2 },
				cause: "free",
			},
			{
				label: "absent, any expectation",
				catches: "the acquire rule for an expectation on absent applied to resume",
				observed: ABSENT,
				request: resume(),
				changes: { ...AS_RESUMED, expectedClaimGeneration: 1 },
				cause: "absent",
			},
			{
				label: "foreign holder, wrong expectation",
				catches: "generation before ownership",
				observed: present(foreign()),
				request: resume(),
				changes: { ...AS_RESUMED, expectedClaimGeneration: 2 },
				cause: "not-holder",
			},
			{
				label: "own binding holds, wrong expectation",
				catches: "generation before held",
				observed: present(resumed()),
				request: resume(),
				changes: { ...AS_RESUMED, expectedClaimGeneration: 2 },
				cause: "held",
			},
			{
				label: "own binding holds, proof of Franz",
				catches: "not-holder before held",
				observed: present(resumed()),
				request: resume(),
				changes: { binding: RESUMED, recoveryBinding: FRANZ },
				cause: "held",
			},
			{
				label: "Karl holds, proof of Franz, wrong expectation",
				catches: "generation before the proof check",
				observed: present(active()),
				request: resume(),
				changes: { binding: RESUMED, recoveryBinding: FRANZ, expectedClaimGeneration: 2 },
				cause: "not-holder",
			},
		]);
	});

	test("pre-03: orders change-bounds verdicts: ownership, generation, mode-change, then the time path", () => {
		// Positive control (catches: an own shortening rejected).
		checkPlanned([
			{
				label: "own hard claim shortened",
				catches: "an own shortening rejected",
				observed: present(active(hard())),
				request: changeBounds(hard(H - 30 * MINUTE)),
				expected: plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder, mode change",
				catches: "the mode verdict before ownership",
				observed: present(foreign(lease(L, H))),
				request: changeBounds(hard()),
				cause: "not-holder",
			},
			{
				label: "tombstone, mode change, wrong expectation",
				catches: "mode or generation before state",
				observed: present(tombstone()),
				request: changeBounds(TIMELESS),
				changes: { expectedClaimGeneration: 2 },
				cause: "free",
			},
			{
				label: "own claim, wrong expectation, extending",
				catches: "the time-path verdict before generation",
				observed: present(active(hard())),
				request: changeBounds(hard(H + 1)),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "own claim, wrong expectation, mode change",
				catches: "mode-change before generation",
				observed: present(active(hard())),
				request: changeBounds(TIMELESS),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "lease with H to timeless: mode change and extending",
				catches: "requires-time-path before mode-change",
				observed: present(active(lease(L, H))),
				request: changeBounds(TIMELESS),
				cause: "mode-change",
			},
		]);
	});
});

describe("claim transition administration: inputs and roles", () => {
	test("inp-01: validates the exact transfer request before looking at the observation", () => {
		// Positive control (catches: no transfer planned at all).
		expectPlanned(
			"positive control",
			plan(present(active()), transfer(), TO_FRANZ),
			plannedFor(transfer(), transferred(lease(T + TTL))),
		);
		class TransferRequest {
			action = "transfer";
			owner = OTHER_OWNER;
			timeBox = null;
			lease = null;
		}
		// The bare {action: "transfer"} stays covered by claim-transition.test.ts:1332.
		const requests: [string, unknown][] = [
			["transfer without timeBox", without(transfer(), "timeBox")],
			["transfer without lease", without(transfer(), "lease")],
			["transfer without owner", without(transfer(), "owner")],
			["transfer with empty owner", transfer(null, leaseOf(), "")],
			["transfer with numeric owner", { ...transfer(), owner: 42 }],
			["timeBox as a string", { ...transfer(), timeBox: "preserve" }],
			["timeBox action keep", transfer(asTimeBox({ action: "keep", source: "explicit" }))],
			["timeBox source config", transfer(asTimeBox({ action: "preserve", source: "config" }))],
			["timeBox without source", transfer(asTimeBox({ action: "preserve" }))],
			["timeBox with an extra field", transfer(asTimeBox({ ...preserve(), ttlMs: TTL }))],
			["timeBox accessor", transfer(withAccessor(preserve(), "source", "explicit"))],
			["lease ttl zero", transfer(null, leaseOf(0))],
			["lease ttl fractional", transfer(null, leaseOf(TTL + 0.5))],
			["lease ttlSource auto", transfer(null, asLease({ ttlMs: TTL, ttlSource: "auto" }))],
			["lease with an extra field", transfer(null, asLease({ ...leaseOf(), hardEnd: H }))],
			["lease accessor", transfer(null, withAccessor(leaseOf(), "ttlMs", TTL))],
			["lease hidden field", transfer(null, withHidden(leaseOf(), "ttlSource", "default"))],
			["request with a targetBinding field", { ...transfer(), targetBinding: FRANZ }],
			["request with a binding field", { ...transfer(), binding: FRANZ }],
			["request with a recoveryBinding field", { ...transfer(), recoveryBinding: KARL }],
			["request symbol key", Object.assign(transfer(), { [Symbol("hidden")]: 1 })],
			["request class instance", new TransferRequest()],
		];
		// catches: a lax request gate, or a binding smuggled in through the request
		for (const [label, request] of requests) {
			expectInvalidEverywhere(label, present(active()), asRequest(request), TO_FRANZ);
		}
	});

	test("inp-02: accepts resume only as the bare action", () => {
		// Positive control (catches: no resume planned at all).
		expectPlanned("positive control", plan(present(active()), resume(), AS_RESUMED), plannedFor(resume(), resumed()));
		class ResumeRequest {
			action = "resume";
		}
		const requests: [string, unknown][] = [
			["resume with an owner", { ...resume(), owner: OTHER_OWNER }],
			["resume with a binding", { ...resume(), binding: RESUMED }],
			["resume with a recoveryBinding", { ...resume(), recoveryBinding: KARL }],
			["resume with a timing", { ...resume(), timing: lease() }],
			["resume with a lease", { ...resume(), ttlMs: TTL, ttlSource: "default" }],
			["resume action case variant", { action: "RESUME" }],
			["resume action accessor", withAccessor(resume(), "action", "resume")],
			["resume class instance", new ResumeRequest()],
		];
		// catches: extra fields on resume, or a proof smuggled in through the request
		for (const [label, request] of requests) {
			expectInvalidEverywhere(label, present(active()), asRequest(request), AS_RESUMED);
		}
	});

	test("inp-03: validates the change-bounds timing with the rights state-timing rules before the observation", () => {
		// Positive control (catches: no change-bounds planned at all).
		expectPlanned(
			"positive control",
			plan(present(active(hard())), changeBounds(hard(H - 30 * MINUTE))),
			plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
		);
		class HardTiming {
			mode = "hard";
			hardEnd = H;
			graceMs = GRACE;
		}
		const timings: [string, unknown][] = [
			["acquire-form lease timing with ttlMs", leaseRequest()],
			["lease end after H", lease(H + 1, H)],
			["lease timing without the hardEnd key", without(lease(), "hardEnd")],
			["hard timing with a leaseEnd", { ...hard(), leaseEnd: L }],
			["hard timing without grace", without(hard(), "graceMs")],
			["timeless timing with grace", { mode: "none", graceMs: GRACE }],
			["mode soft", { ...lease(), mode: "soft" }],
			["negative lease end", lease(-1)],
			["negative hard deadline", hard(-1)],
			["negative grace", hard(H, -1)],
			["fractional lease end", lease(L + 0.5)],
			["fractional hard deadline", hard(H + 0.5)],
			["lease end plus grace overflows", lease(MAX - GRACE + 1)],
			["hard deadline plus grace overflows", hard(MAX - 5, 10)],
			["null timing", null],
			["string timing", "hard"],
			["timing accessor", withAccessor(hard(), "hardEnd", H)],
			["timing hidden field", withHidden(hard(), "graceMs", GRACE)],
			["timing symbol key", Object.assign(hard(), { [Symbol("hidden")]: 1 })],
			["timing class instance", new HardTiming()],
		];
		// catches: a second, laxer timing parser instead of the rights validator
		for (const [label, timing] of timings) {
			expectInvalidEverywhere(label, present(active(hard())), changeBounds(asTiming(timing)), {});
		}
		const requests: [string, unknown][] = [
			["change-bounds without timing", { action: "change-bounds" }],
			["change-bounds with a binding", { ...changeBounds(hard()), binding: KARL }],
			["change-bounds with an owner", { ...changeBounds(hard()), owner: OWNER }],
			["change-bounds with a lease request", { ...changeBounds(hard()), ttlMs: TTL, ttlSource: "default" }],
		];
		// catches: extra request fields accepted on change-bounds
		for (const [label, request] of requests) {
			expectInvalidEverywhere(label, present(active(hard())), asRequest(request), {});
		}
	});

	test("inp-04: gates role options before the observation: target only on transfer, proof only on resume", () => {
		// Positive controls (catches: the new actions not planned, or the 701 actions broken by the role gate).
		expectPlanned(
			"transfer to Franz",
			plan(present(active()), transfer(), TO_FRANZ),
			plannedFor(transfer(), transferred(lease(T + TTL))),
		);
		expectPlanned(
			"resume with Karl's proof",
			plan(present(active()), resume(), AS_RESUMED),
			plannedFor(resume(), resumed()),
		);
		const others: [string, ClaimReadResult, ClaimTransitionRequest, Partial<PlanClaimTransitionOptions>][] = [
			["acquire", ABSENT, acquire(), {}],
			["renew", present(active()), renew(), {}],
			["release", present(active()), release(), {}],
			["reclaim", present(active()), reclaim(), { now: R + EPS }],
			["change-bounds", present(active(hard())), changeBounds(hard(H - 30 * MINUTE)), {}],
		];
		for (const [label, observed, request, changes] of others) {
			plannedResult(`${label} without role options`, plan(observed, request, changes));
		}
		const transferRows: [string, Partial<PlanClaimTransitionOptions>][] = [
			["transfer without targetBinding", {}],
			["targetBinding equal to the caller binding", { targetBinding: KARL }],
			["uppercase targetBinding", { targetBinding: FRANZ.toUpperCase() }],
			["targetBinding with 63 hex digits", { targetBinding: FRANZ.slice(0, -1) }],
			["owner name as targetBinding", { targetBinding: OTHER_OWNER }],
			["numeric targetBinding", { targetBinding: 42 as unknown as string }],
			["recoveryBinding on transfer", { ...TO_FRANZ, recoveryBinding: SECOND }],
		];
		// catches: a missing target accepted, a self-transfer, a second binding format, or roles mixed
		for (const [label, changes] of transferRows) {
			expectInvalidEverywhere(label, present(active()), transfer(), changes);
		}
		const resumeRows: [string, Partial<PlanClaimTransitionOptions>][] = [
			["resume without recoveryBinding", { binding: RESUMED }],
			["recoveryBinding equal to the caller binding", { binding: RESUMED, recoveryBinding: RESUMED }],
			["uppercase recoveryBinding", { binding: RESUMED, recoveryBinding: KARL.toUpperCase() }],
			["recoveryBinding with 63 hex digits", { binding: RESUMED, recoveryBinding: KARL.slice(0, -1) }],
			["targetBinding on resume", { ...AS_RESUMED, targetBinding: FRANZ }],
		];
		// catches: a resume without the old proof, a proof equal to the fresh binding, or roles mixed
		for (const [label, changes] of resumeRows) {
			expectInvalidEverywhere(label, present(active()), resume(), changes);
		}
		const roles: [string, Partial<PlanClaimTransitionOptions>][] = [
			["targetBinding", { targetBinding: FRANZ }],
			["recoveryBinding", { recoveryBinding: FRANZ }],
			["both role options", { targetBinding: FRANZ, recoveryBinding: SECOND }],
		];
		// catches: a role option silently ignored or acting on the 701 actions and change-bounds (broken)
		for (const [label, observed, request, changes] of others) {
			for (const [role, extra] of roles) {
				expectInvalidEverywhere(`${label} with ${role}`, observed, request, { ...changes, ...extra });
			}
		}
		// catches: the recovery binding acting as ownership proof on renew
		expectInvalidEverywhere("renew by the replacement with Karl's proof", present(active()), renew(), AS_RESUMED);
		// catches: an accessor read on a role option (claim-transition.test.ts:1392–1393)
		const accessors: [string, PlanClaimTransitionOptions][] = [
			[
				"targetBinding accessor",
				withAccessor(optionsOf(present(active()), transfer(), TO_FRANZ), "targetBinding", FRANZ),
			],
			["targetBinding accessor", withAccessor(optionsOf(UNREACHABLE, transfer(), TO_FRANZ), "targetBinding", FRANZ)],
			[
				"recoveryBinding accessor",
				withAccessor(optionsOf(present(active()), resume(), AS_RESUMED), "recoveryBinding", KARL),
			],
			["recoveryBinding accessor", withAccessor(optionsOf(UNREACHABLE, resume(), AS_RESUMED), "recoveryBinding", KARL)],
		];
		for (const [label, options] of accessors) {
			expectFailure(`${label} on ${options.observed.kind}`, planClaimTransition(options), "invalid");
		}
	});
});

describe("claim transition administration: plan output", () => {
	test("out-01: returns next states that rights decodes, carrying the target, the fresh or own binding by role", () => {
		// Positive control (catches: any scenario not planned): plannedResult throws on the first non-planned result.
		const scenarios: [string, ClaimTransitionPlan, string][] = [
			["transfer of a pure lease", plan(present(active()), transfer(), TO_FRANZ), FRANZ],
			[
				"transfer capped at H",
				plan(present(active(lease(L, H))), transfer(preserve()), { ...TO_FRANZ, now: H - 3 * MINUTE }),
				FRANZ,
			],
			[
				"transfer of a hard claim after H",
				plan(present(active(hard())), transfer(preserve(), null), { ...TO_FRANZ, now: H + MINUTE }),
				FRANZ,
			],
			["transfer of a timeless claim", plan(present(active(TIMELESS)), transfer(null, null), TO_FRANZ), FRANZ],
			[
				"transfer from Franz back to Karl",
				plan(present(foreign()), transfer(null, leaseOf(), OWNER), { binding: FRANZ, targetBinding: KARL }),
				KARL,
			],
			["resume of a pure lease", plan(present(active()), resume(), AS_RESUMED), RESUMED],
			[
				"resume of a hard claim after H",
				plan(present(active(hard())), resume(), { ...AS_RESUMED, now: H + MINUTE }),
				RESUMED,
			],
			["change-bounds of a hard claim", plan(present(active(hard())), changeBounds(hard(H - 30 * MINUTE))), KARL],
			["change-bounds setting a first H", plan(present(active()), changeBounds(lease(L, H))), KARL],
			["change-bounds no-op on a timeless claim", plan(present(active(TIMELESS)), changeBounds(TIMELESS)), KARL],
		];
		for (const [label, result, binding] of scenarios) {
			const planned = plannedResult(label, result);
			// catches: a payload outside the claim schema
			expect({ label, scope: planned.scope, decoded: parseClaimState(planned.next) }).toStrictEqual({
				label,
				scope: "state-plan-only",
				decoded: { kind: "state", state: planned.next },
			});
			// catches: the wrong role in next.binding: the source kept, the recovery proof as successor, an owner name
			const next = planned.next as ActiveClaimState;
			expect({ label, status: next.status, binding: next.binding }).toEqual({ label, status: "active", binding });
		}
	});

	test("out-02: keeps every binding out of the planned request and the plan envelope", () => {
		// Positive control (catches: any scenario not planned): plannedResult throws on the first non-planned result.
		const scenarios: [string, ClaimTransitionPlan, string[]][] = [
			[
				"transfer",
				plan(present(active(lease(L, H))), transfer(preserve("policy")), TO_FRANZ),
				["action", "lease", "owner", "timeBox"],
			],
			["resume", plan(present(active()), resume(), AS_RESUMED), ["action"]],
			["change-bounds", plan(present(active(hard())), changeBounds(hard(H - 30 * MINUTE))), ["action", "timing"]],
		];
		for (const [label, result, keys] of scenarios) {
			const planned = plannedResult(label, result);
			const { next: _next, ...envelope } = planned;
			// catches: a binding in the request that becomes the journal parameters, or anywhere outside next
			expect({
				label,
				keys: Object.keys(planned.request).sort(byCodeUnits),
				requestBinding: JSON.stringify(planned.request).includes("tb1-"),
				envelopeBinding: JSON.stringify(envelope).includes("tb1-"),
			}).toEqual({ label, keys, requestBinding: false, envelopeBinding: false });
		}
	});

	test("out-03: reports the four new causes without boundary and transfer time verdicts with boundary H", () => {
		// Positive control (catches: no transfer planned at all).
		expectPlanned(
			"positive control",
			plan(present(active()), transfer(), TO_FRANZ),
			plannedFor(transfer(), transferred(lease(T + TTL))),
		);
		const rows: [string, ClaimTransitionPlan, Rejection, number?][] = [
			["time-box-required", plan(present(active(hard())), transfer(), TO_FRANZ), "time-box-required"],
			[
				"requires-time-path on transfer",
				plan(present(active(hard())), transfer(restart()), TO_FRANZ),
				"requires-time-path",
			],
			[
				"requires-time-path on change-bounds",
				plan(present(active(hard())), changeBounds(hard(H + 1))),
				"requires-time-path",
			],
			["lease-required", plan(present(active()), transfer(null, null), TO_FRANZ), "lease-required"],
			["mode-change", plan(present(active(hard())), changeBounds(TIMELESS)), "mode-change"],
			[
				"not-renewable on transfer",
				plan(present(active(hard())), transfer(preserve(), leaseOf(TTL, "explicit")), TO_FRANZ),
				"not-renewable",
			],
			[
				"hard-expired on transfer",
				plan(present(active(lease(L, H))), transfer(preserve()), { ...TO_FRANZ, now: H }),
				"hard-expired",
				H,
			],
			[
				"overlong on transfer",
				plan(present(active(lease(L, H))), transfer(preserve(), leaseOf(90 * MINUTE, "explicit")), TO_FRANZ),
				"overlong",
				H,
			],
			["held on resume", plan(present(resumed()), resume(), AS_RESUMED), "held"],
			["not-holder on resume", plan(present(foreign()), resume(), AS_RESUMED), "not-holder"],
		];
		// catches: a boundary on the new causes, a missing boundary H on transfer time verdicts, extra keys
		for (const [label, result, cause, boundary] of rows) {
			expectRejected(label, result, cause, boundary);
		}
	});

	test("out-04: returns fresh copies sharing no object with request or payload, inputs unchanged", () => {
		// Positive control and change-bounds (catches: next.timing aliased to the request timing).
		const target = lease(L, H - 10 * MINUTE);
		const boundsRequest = changeBounds(target);
		const boundsOptions = optionsOf(present(active(lease(L, H))), boundsRequest);
		const boundsBefore = structuredClone(boundsOptions);
		const bounded = plannedResult("change-bounds", planClaimTransition(boundsOptions));
		const copiedTarget = (bounded.request as { timing: object }).timing;
		const boundedNext = bounded.next as ActiveClaimState;
		expect({
			sameRequest: bounded.request === boundsRequest,
			sameRequestTiming: copiedTarget === target,
			nextTimingIsRequestTiming: boundedNext.timing === target,
			nextTimingIsCopiedTiming: boundedNext.timing === copiedTarget,
		}).toEqual({
			sameRequest: false,
			sameRequestTiming: false,
			nextTimingIsRequestTiming: false,
			nextTimingIsCopiedTiming: false,
		});
		boundedNext.timing = TIMELESS;
		(copiedTarget as { graceMs?: number }).graceMs = 0;
		expect(boundsOptions).toStrictEqual(boundsBefore);
		expect(target).toStrictEqual(lease(L, H - 10 * MINUTE));

		// catches: the planned time box or lease shared with the request, or the inputs mutated
		const timeBox = preserve("policy");
		const fresh = leaseOf(TTL, "explicit");
		const transferRequest = transfer(timeBox, fresh);
		const transferOptions = optionsOf(present(active(lease(L, H))), transferRequest, TO_FRANZ);
		const transferBefore = structuredClone(transferOptions);
		const handedOver = plannedResult("transfer", planClaimTransition(transferOptions));
		const copied = handedOver.request as unknown as { timeBox: { source: string }; lease: { ttlMs: number } };
		expect({
			sameRequest: handedOver.request === transferRequest,
			sameTimeBox: copied.timeBox === timeBox,
			sameLease: copied.lease === fresh,
		}).toEqual({ sameRequest: false, sameTimeBox: false, sameLease: false });
		copied.timeBox.source = "explicit";
		copied.lease.ttlMs = 1;
		(handedOver.next as ActiveClaimState).owner = OWNER;
		expect(transferOptions).toStrictEqual(transferBefore);

		// catches: the resumed next sharing the payload's objects, or the payload mutated
		const state = active(lease(L, H), { bindingGeneration: 4 });
		const resumeOptions = optionsOf(present(state), resume(), AS_RESUMED);
		const resumeBefore = structuredClone(resumeOptions);
		const resumedPlan = plannedResult("resume", planClaimTransition(resumeOptions));
		const resumedNext = resumedPlan.next as ActiveClaimState;
		expect({ sameState: resumedNext === state, sameTiming: resumedNext.timing === state.timing }).toEqual({
			sameState: false,
			sameTiming: false,
		});
		resumedNext.timing = TIMELESS;
		resumedNext.binding = SECOND;
		expect(resumeOptions).toStrictEqual(resumeBefore);
		expect(state).toStrictEqual(active(lease(L, H), { bindingGeneration: 4 }));
	});

	test("out-05: plans transfer, resume and change-bounds deterministically without reading an ambient clock", () => {
		const expected = [
			plannedFor(transfer(), transferred(lease(L + 2 * MINUTE + TTL))),
			plannedFor(resume(), resumed(lease(L, H))),
			plannedFor(changeBounds(hard(H - 30 * MINUTE)), active(hard(H - 30 * MINUTE))),
		];
		const run = (): ClaimTransitionPlan[] => [
			plan(present(active()), transfer(), { ...TO_FRANZ, now: L + 2 * MINUTE }),
			plan(present(active(lease(L, H))), resume(), { ...AS_RESUMED, now: H + MINUTE }),
			plan(present(active(hard())), changeBounds(hard(H - 30 * MINUTE)), { now: H + MINUTE }),
		];
		// Positive control (catches: the three actions not planned at all).
		expect(run()).toStrictEqual(expected);
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
		// catches: a hidden clock read, or nondeterministic output
		expect(holder).toStrictEqual({ first: expected, second: expected });
		expect(JSON.stringify(holder.first)).toBe(JSON.stringify(holder.second));
	});

	test("out-06: keeps every diagnostic free of source, target and recovery bindings, owner names and roots", () => {
		// Positive control (catches: no transfer planned at a 64-hex root).
		expectPlanned(
			"positive control",
			plan(present(active(), ROOT_64), transfer(), TO_FRANZ),
			plannedFor(transfer(), transferred(lease(T + TTL)), ROOT_64),
		);
		// No binding, owner, root, request content, targetBinding or recoveryBinding in a reason.
		const secret = [String(90 * MINUTE), String(H + DAY), "agent-sentinel", "tb1-", FRANZ.toUpperCase(), KARL.slice(4)];
		const rejections: [string, ClaimTransitionPlan, Rejection, number?][] = [
			[
				"transfer by a foreign caller",
				plan(present(foreign(), ROOT_64), transfer(), { targetBinding: SECOND }),
				"not-holder",
			],
			[
				"transfer without a time box",
				plan(present(active(hard()), ROOT_64), transfer(), TO_FRANZ),
				"time-box-required",
			],
			[
				"transfer with a restart",
				plan(present(active(hard()), ROOT_64), transfer(restart()), TO_FRANZ),
				"requires-time-path",
			],
			["transfer without a lease", plan(present(active(), ROOT_64), transfer(null, null), TO_FRANZ), "lease-required"],
			[
				"transfer overlong",
				plan(present(active(lease(L, H)), ROOT_64), transfer(preserve(), leaseOf(90 * MINUTE, "explicit")), TO_FRANZ),
				"overlong",
				H,
			],
			[
				"transfer at H",
				plan(present(active(lease(L, H)), ROOT_64), transfer(preserve()), { ...TO_FRANZ, now: H }),
				"hard-expired",
				H,
			],
			["resume onto the own binding", plan(present(resumed(), ROOT_64), resume(), AS_RESUMED), "held"],
			[
				"resume with a foreign proof",
				plan(present(active(), ROOT_64), resume(), { binding: RESUMED, recoveryBinding: SECOND }),
				"not-holder",
			],
			[
				"change-bounds with a mode change",
				plan(present(active(hard()), ROOT_64), changeBounds(TIMELESS)),
				"mode-change",
			],
			[
				"change-bounds extending",
				plan(present(active(hard()), ROOT_64), changeBounds(hard(H + DAY))),
				"requires-time-path",
			],
			[
				"change-bounds by a foreign caller",
				plan(present(foreign(), ROOT_64), changeBounds(lease(L - MINUTE))),
				"not-holder",
			],
		];
		// catches: a leak of the source, target or recovery binding, an owner name or a root in any reason
		for (const [label, result, cause, boundary] of rejections) {
			expectRejected(label, result, cause, boundary, secret);
		}
		const failures: [string, ClaimTransitionPlan, Failure][] = [
			[
				"uppercase target binding",
				plan(present(active()), transfer(), { targetBinding: FRANZ.toUpperCase() }),
				"invalid",
			],
			["target equal to the caller binding", plan(present(active()), transfer(), { targetBinding: KARL }), "invalid"],
			[
				"proof equal to the fresh binding",
				plan(present(active()), resume(), { binding: RESUMED, recoveryBinding: RESUMED }),
				"invalid",
			],
			[
				"request carrying a binding",
				plan(present(active()), asRequest({ ...transfer(), binding: FRANZ }), TO_FRANZ),
				"invalid",
			],
			["unreachable read naming secrets", plan(UNREACHABLE, transfer(), TO_FRANZ), "unknown"],
			["legacy payload naming the target", plan(present({ holder: FRANZ }), transfer(), TO_FRANZ), "corrupt"],
			[
				"PENDING payload on resume",
				plan(present({ ...active(), status: "pending" }), resume(), AS_RESUMED),
				// The holder's own fields break the v1 PENDING schema.
				"corrupt",
			],
		];
		// catches: a leak of a binding or an owner name in a failure reason
		for (const [label, result, kind] of failures) {
			expectFailure(label, result, kind, secret);
		}
	});
});

describe("claim transition administration: action list", () => {
	test("act-01: CLAIM_TRANSITION_ACTIONS lists exactly the eight actions the request parser accepts", () => {
		// (PLAN-DELTA): the list is exported from transition/index.ts, derived from the same source
		// as ClaimTransitionAction; its consumers in execution and surface stay unchanged in the scaffold.
		// emergency-release is the eighth action.
		// Positive control (catches: the shared request parser no longer copying a 701 request).
		expect(parseClaimTransitionRequest(renew())).toStrictEqual(renew());
		const valid: Record<ClaimTransitionAction, ClaimTransitionRequest> = {
			acquire: acquire(),
			renew: renew(),
			release: release(),
			reclaim: reclaim(),
			transfer: transfer(preserve()),
			resume: resume(),
			"change-bounds": changeBounds(hard()),
			"emergency-release": emergencyRelease(),
		};
		// catches: a missing, duplicated or extra action in the exported list
		expect([...CLAIM_TRANSITION_ACTIONS].sort(byCodeUnits)).toEqual([
			"acquire",
			"change-bounds",
			"emergency-release",
			"reclaim",
			"release",
			"renew",
			"resume",
			"transfer",
		]);
		// catches: the list and the parser drifting apart (a listed action the parser rejects or alters)
		for (const action of CLAIM_TRANSITION_ACTIONS) {
			const request = valid[action];
			expect({ action, parses: parses(request) }).toEqual({ action, parses: true });
			expect({ action, parsed: parseClaimTransitionRequest(request) }).toStrictEqual({ action, parsed: request });
		}
		// catches: the parser accepting an action outside the list
		for (const action of ["next", "RESUME", "change_bounds", "changeBounds", "transfer-bounds", "emergency_release"]) {
			expect({
				action,
				listed: (CLAIM_TRANSITION_ACTIONS as readonly string[]).includes(action),
				parses: parses({ ...valid.renew, action }),
			}).toEqual({ action, listed: false, parses: false });
		}
	});
});
