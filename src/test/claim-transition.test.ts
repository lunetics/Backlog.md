/**
 * Behavioural contract for the pure claim transition planner: acquire, renew, release and
 * reclaim over one explicitly scoped observation, a caller binding, explicit numeric time and an exact request. A
 * planned result is scoped "state-plan-only": an expected root and a complete next state, never a journal intent, a
 * mutation, execution admission or proof that no own operation is outstanding. No Git, filesystem or clock is used;
 * all times are fixed millisecond constants. Every table names the deliberately wrong planner each row catches.
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
	type ClaimTimingRequest,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	type PlanClaimTransitionOptions,
	planClaimTransition,
} from "../claims/transition/index.ts";

const TICKET = "BACK-1";
const ROOT = "a1".repeat(20);
const ROOT_64 = "b2".repeat(32);
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
/** Distinctive context bindings, owner names and roots; no diagnostic may echo any of them. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const SENTINELS = [KARL, FRANZ, OWNER, OTHER_OWNER, ROOT, ROOT_64];

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

type TtlSource = "default" | "explicit";
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
const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: `upstream ${OWNER} ${KARL} ${ROOT}` };

function leaseRequest(
	ttlMs = TTL,
	ttlSource: TtlSource = "default",
	hardEnd: number | null = null,
	graceMs = GRACE,
): ClaimTimingRequest {
	return { mode: "lease", ttlMs, ttlSource, graceMs, hardEnd };
}

function hardRequest(hardEnd = H, graceMs = GRACE): ClaimTimingRequest {
	return { mode: "hard", hardEnd, graceMs };
}

function noneRequest(): ClaimTimingRequest {
	return { mode: "none" };
}

/** Deliberately malformed timing data for invalid-request controls. */
function asTiming(value: unknown): ClaimTimingRequest {
	return value as ClaimTimingRequest;
}

function acquire(timing: ClaimTimingRequest = leaseRequest(), owner = OWNER): ClaimTransitionRequest {
	return { action: "acquire", owner, timing };
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

describe("claim transition planner: acquire", () => {
	test("acquires from absent with generation 1 and from a tombstone with its generation plus one", () => {
		checkPlanned([
			{
				label: "absent, default lease",
				catches: "wrong generation or a non-null expected root for a never-claimed ticket",
				observed: ABSENT,
				request: acquire(),
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: 1 }), null, null),
			},
			{
				label: "tombstone generation 4",
				catches: "generation not advanced, or an empty expectation against an existing tombstone",
				observed: present(tombstone(4)),
				request: acquire(),
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: 5 }), ROOT, 4),
			},
			{
				label: "tombstone at a 64-hex root",
				catches: "expected root not taken from the observation",
				observed: present(tombstone(1), ROOT_64),
				request: acquire(),
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: 2 }), ROOT_64, 1),
			},
			{
				label: "tombstone 4 with matching expectation 4",
				catches: "expected generation confused with the next generation",
				observed: present(tombstone(4)),
				request: acquire(),
				changes: { expectedClaimGeneration: 4 },
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: 5 }), ROOT, 4),
			},
			{
				label: "absent, hard deadline",
				catches: "hard mode stored as a lease",
				observed: ABSENT,
				request: acquire(hardRequest()),
				expected: plannedFor(acquire(hardRequest()), active(hard(), { claimGeneration: 1 }), null, null),
			},
			{
				label: "absent, timeless",
				catches: "invented deadlines for the no-expiry mode",
				observed: ABSENT,
				request: acquire(noneRequest()),
				expected: plannedFor(acquire(noneRequest()), active(TIMELESS, { claimGeneration: 1 }), null, null),
			},
			{
				label: "absent, explicit thirty-day lease without H",
				catches: "an overlong verdict without any hard limit",
				observed: ABSENT,
				request: acquire(leaseRequest(30 * DAY, "explicit")),
				expected: plannedFor(
					acquire(leaseRequest(30 * DAY, "explicit")),
					active(lease(T + 30 * DAY), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "absent, other owner name, zero grace, caller Franz",
				catches: "binding taken from the owner name, or a default grace",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", null, 0), OTHER_OWNER),
				changes: { binding: FRANZ },
				expected: plannedFor(
					acquire(leaseRequest(TTL, "default", null, 0), OTHER_OWNER),
					active(lease(T + TTL, null, 0), { claimGeneration: 1, owner: OTHER_OWNER, binding: FRANZ }),
					null,
					null,
				),
			},
		]);
		checkRejected([
			{
				label: "tombstone 4 with expectation 5",
				catches: "expected generation compared with the next generation",
				observed: present(tombstone(4)),
				request: acquire(),
				changes: { expectedClaimGeneration: 5 },
				cause: "generation-changed",
			},
		]);
	});

	test("caps a default lease at a requested H, rejects an explicit overlong one and every lease from C+eps>=H", () => {
		checkPlanned([
			{
				label: "default TTL well below H",
				catches: "capping applied without need",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				expected: plannedFor(
					acquire(leaseRequest(TTL, "default", H)),
					active(lease(T + TTL, H), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "explicit C+ttl equal to H",
				catches: "overlong at the exact limit",
				observed: ABSENT,
				request: acquire(leaseRequest(60 * MINUTE, "explicit", H)),
				expected: plannedFor(
					acquire(leaseRequest(60 * MINUTE, "explicit", H)),
					active(lease(H, H), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "default C+ttl one ms beyond H",
				catches: "default lease not capped at H",
				observed: ABSENT,
				request: acquire(leaseRequest(60 * MINUTE + 1, "default", H)),
				expected: plannedFor(
					acquire(leaseRequest(60 * MINUTE + 1, "default", H)),
					active(lease(H, H), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "C+eps one ms before H, default TTL capped",
				catches: "`<=` instead of `<` at H",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				changes: { now: H - EPS - 1 },
				expected: plannedFor(
					acquire(leaseRequest(TTL, "default", H)),
					active(lease(H, H), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "epsilon zero, one ms before H",
				catches: "an epsilon default",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				changes: { now: H - 1, clockSkewMs: 0 },
				expected: plannedFor(
					acquire(leaseRequest(TTL, "default", H)),
					active(lease(H, H), { claimGeneration: 1 }),
					null,
					null,
				),
			},
		]);
		checkRejected([
			{
				label: "explicit C+ttl one ms beyond H",
				catches: "an explicit TTL silently shortened",
				observed: ABSENT,
				request: acquire(leaseRequest(60 * MINUTE + 1, "explicit", H)),
				cause: "overlong",
				boundary: H,
			},
			{
				label: "C+eps exactly H",
				catches: "-eps instead of +eps, or `<=` at H",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				changes: { now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "after H",
				catches: "capping to H instead of rejecting a lease without remaining time",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				changes: { now: H + MINUTE },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "epsilon zero, exactly H",
				catches: "an epsilon default",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", H)),
				changes: { now: H, clockSkewMs: 0 },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "explicit overlong request at C+eps exactly H",
				catches: "overlong reported before the missing remaining time",
				observed: ABSENT,
				request: acquire(leaseRequest(60 * MINUTE, "explicit", H)),
				changes: { now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
		]);
	});

	test("rejects a well-formed hard deadline in the past as hard-expired, a missing or malformed one as invalid", () => {
		checkPlanned([
			{
				label: "C+eps one ms before the hard deadline",
				catches: "`<=` instead of `<` at the hard deadline",
				observed: ABSENT,
				request: acquire(hardRequest()),
				changes: { now: H - EPS - 1 },
				expected: plannedFor(acquire(hardRequest()), active(hard(), { claimGeneration: 1 }), null, null),
			},
		]);
		checkRejected([
			{
				label: "C+eps exactly H",
				catches: "-eps instead of +eps",
				observed: ABSENT,
				request: acquire(hardRequest()),
				changes: { now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "one day after H",
				catches: "a past deadline accepted",
				observed: ABSENT,
				request: acquire(hardRequest()),
				changes: { now: H + DAY },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "deadline one minute before now",
				catches: "a past deadline reported as malformed input",
				observed: ABSENT,
				request: acquire(hardRequest(T - MINUTE)),
				cause: "hard-expired",
				boundary: T - MINUTE,
			},
			{
				label: "deadline at epoch zero",
				catches: "zero treated as a missing deadline",
				observed: ABSENT,
				request: acquire(hardRequest(0)),
				cause: "hard-expired",
				boundary: 0,
			},
		]);
		const malformed: [string, unknown][] = [
			["missing hardEnd", { mode: "hard", graceMs: GRACE }],
			["null hardEnd", { mode: "hard", hardEnd: null, graceMs: GRACE }],
			["string hardEnd", { mode: "hard", hardEnd: String(H), graceMs: GRACE }],
			["negative hardEnd", { mode: "hard", hardEnd: -1, graceMs: GRACE }],
			["fractional hardEnd", { mode: "hard", hardEnd: H + 0.5, graceMs: GRACE }],
		];
		for (const [label, timing] of malformed) {
			expectFailure(label, plan(ABSENT, acquire(asTiming(timing))), "invalid");
		}
	});

	test("never acquires an active claim, not even a reclaimable, expired or timeless foreign one", () => {
		checkPlanned([
			{
				label: "positive control",
				catches: "nothing; the absent ticket plans",
				observed: ABSENT,
				request: acquire(),
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: 1 }), null, null),
			},
		]);
		checkRejected([
			{
				label: "own active lease",
				catches: "a second acquire of an own claim",
				observed: present(active()),
				request: acquire(),
				cause: "held",
			},
			{
				label: "own hard claim after H",
				catches: "a time verdict before the state verdict",
				observed: present(active(hard())),
				request: acquire(hardRequest(H + DAY)),
				changes: { now: H + MINUTE },
				cause: "held",
			},
			{
				label: "foreign lease",
				catches: "acquire over a foreign holder",
				observed: present(foreign()),
				request: acquire(),
				cause: "not-free",
			},
			{
				label: "foreign lease already reclaimable",
				catches: "acquire as an implicit reclaim",
				observed: present(foreign()),
				request: acquire(),
				changes: { now: R + EPS },
				cause: "not-free",
			},
			{
				label: "foreign hard claim after H plus grace",
				catches: "an expired hard claim treated as free",
				observed: present(foreign(hard())),
				request: acquire(),
				changes: { now: H + GRACE + EPS },
				cause: "not-free",
			},
			{
				label: "foreign timeless claim",
				catches: "the no-expiry mode treated as free",
				observed: present(foreign(TIMELESS)),
				request: acquire(),
				cause: "not-free",
			},
		]);
	});
});

describe("claim transition planner: renew", () => {
	test("renews an own pure lease from C, also after L and after R, never taking max with the stored L", () => {
		checkPlanned([
			{
				label: "before the lease end",
				catches: "a wrong lease end or changed fields",
				observed: present(active()),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
			{
				label: "two minutes after L",
				catches: "the lease end as a renew bar",
				observed: present(active()),
				request: renew(),
				changes: { now: L + 2 * MINUTE },
				expected: plannedFor(renew(), active(lease(L + 2 * MINUTE + TTL))),
			},
			{
				label: "already reclaimable, no reclaim has won",
				catches: "reclaimability as a renew bar",
				observed: present(active()),
				request: renew(),
				changes: { now: R + EPS },
				expected: plannedFor(renew(), active(lease(R + EPS + TTL))),
			},
			{
				label: "stored lease end 30 minutes ahead, five-minute renew",
				catches: "max(L, C+ttl) instead of C+ttl",
				observed: present(active(lease(T + 30 * MINUTE))),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
			{
				label: "explicit thirty-day renew without H",
				catches: "an overlong verdict without any hard limit",
				observed: present(active()),
				request: renew(30 * DAY, "explicit"),
				expected: plannedFor(renew(30 * DAY, "explicit"), active(lease(T + 30 * DAY))),
			},
			{
				label: "grace, generations, owner and binding carried unchanged",
				catches: "renew resetting grace, generations or owner",
				observed: present(active(lease(L, null, 0), { claimGeneration: 7, bindingGeneration: 2, owner: OTHER_OWNER })),
				request: renew(),
				expected: plannedFor(
					renew(),
					active(lease(T + TTL, null, 0), { claimGeneration: 7, bindingGeneration: 2, owner: OTHER_OWNER }),
					ROOT,
					7,
				),
			},
			{
				label: "the same reclaimable observation with a reclaim request",
				catches: "only one of two legal operations planned",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R + EPS },
				expected: plannedFor(reclaim(), tombstone(3)),
			},
		]);
	});

	test("caps at the stored H, rejects an explicit overlong renew and every renew from C+eps>=H", () => {
		checkPlanned([
			{
				label: "default TTL well below H",
				catches: "capping applied without need",
				observed: present(active(lease(L, H))),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL, H))),
			},
			{
				label: "default TTL beyond H",
				catches: "default renew not capped at H",
				observed: present(active(lease(L, H))),
				request: renew(90 * MINUTE),
				expected: plannedFor(renew(90 * MINUTE), active(lease(H, H))),
			},
			{
				label: "explicit C+ttl equal to H",
				catches: "overlong at the exact limit",
				observed: present(active(lease(L, H))),
				request: renew(60 * MINUTE, "explicit"),
				expected: plannedFor(renew(60 * MINUTE, "explicit"), active(lease(H, H))),
			},
			{
				label: "reclaimable but before H",
				catches: "H checked with the reclaim boundary",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: R + EPS },
				expected: plannedFor(renew(), active(lease(R + EPS + TTL, H))),
			},
			{
				label: "C+eps one ms before H",
				catches: "`<=` instead of `<` at H",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: H - EPS - 1 },
				expected: plannedFor(renew(), active(lease(H, H))),
			},
		]);
		checkRejected([
			{
				label: "explicit renew beyond H",
				catches: "an explicit TTL silently shortened",
				observed: present(active(lease(L, H))),
				request: renew(90 * MINUTE, "explicit"),
				cause: "overlong",
				boundary: H,
			},
			{
				label: "C+eps exactly H",
				catches: "-eps instead of +eps",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: H - EPS },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "a new renew after H",
				catches: "capping to H, which would move the reclaim boundary from L+g to H+g",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: H + MINUTE },
				cause: "hard-expired",
				boundary: H,
			},
			{
				label: "epsilon zero, exactly H",
				catches: "an epsilon default",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: H, clockSkewMs: 0 },
				cause: "hard-expired",
				boundary: H,
			},
		]);
	});

	test("rejects renew by non-holders, on free or absent tickets, in hard or timeless mode, on a new generation", () => {
		checkPlanned([
			{
				label: "positive control",
				catches: "nothing; the own lease renews",
				observed: present(active()),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder",
				catches: "authority from the owner name or no binding check",
				observed: present(foreign(lease(), { owner: OWNER })),
				request: renew(),
				cause: "not-holder",
			},
			{
				label: "tombstone",
				catches: "a renew resurrecting a released claim",
				observed: present(tombstone()),
				request: renew(),
				cause: "free",
			},
			{ label: "absent", catches: "a renew creating a claim", observed: ABSENT, request: renew(), cause: "absent" },
			{
				label: "own hard claim",
				catches: "a renew extending a hard deadline",
				observed: present(active(hard())),
				request: renew(),
				cause: "not-renewable",
			},
			{
				label: "own timeless claim",
				catches: "a renew introducing a lease",
				observed: present(active(TIMELESS)),
				request: renew(),
				cause: "not-renewable",
			},
			{
				label: "expectation 2 on generation 3",
				catches: "a missing continuity check",
				observed: present(active()),
				request: renew(),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "expectation 4 on generation 3",
				catches: "a one-sided continuity check",
				observed: present(active()),
				request: renew(),
				changes: { expectedClaimGeneration: 4 },
				cause: "generation-changed",
			},
		]);
	});
});

describe("claim transition planner: release", () => {
	test("releases an own claim in every mode and at any time to a tombstone with the same generation", () => {
		const cases: [string, ActiveClaimState, number][] = [
			["lease before L", active(), T],
			["lease after L", active(), L + MINUTE],
			["lease after R", active(), R + EPS],
			["lease with H after H (1A)", active(lease(L, H)), H + MINUTE],
			["hard before H", active(hard()), T],
			["hard after H (1A)", active(hard()), H + MINUTE],
			["hard after H plus grace", active(hard()), H + GRACE + EPS],
			["timeless now", active(TIMELESS), T],
			["timeless ten years later", active(TIMELESS), T + 3650 * DAY],
			["generation 9", active(lease(), { claimGeneration: 9 }), T],
		];
		checkPlanned(
			cases.map(([label, state, now]) => ({
				label,
				catches: "release tied to the work right, the lease end or the hard limit, or a changed generation",
				observed: present(state),
				request: release(),
				changes: { now },
				expected: plannedFor(release(), tombstone(state.claimGeneration), ROOT, state.claimGeneration),
			})),
		);
	});

	test("lets only the current binding holder release, also after a late preserve transfer", () => {
		const transferred = present(foreign(lease(H, H), { claimGeneration: 4 }));
		checkPlanned([
			{
				label: "current holder Franz after H",
				catches: "release bound to a work right",
				observed: transferred,
				request: release(),
				changes: { now: H + MINUTE, binding: FRANZ },
				expected: plannedFor(release(), tombstone(4), ROOT, 4),
			},
		]);
		checkRejected([
			{
				label: "displaced holder Karl",
				catches: "a superseded proof releasing the successor",
				observed: transferred,
				request: release(),
				changes: { now: H + MINUTE },
				cause: "not-holder",
			},
			{
				label: "tombstone",
				catches: "a release of a released claim",
				observed: present(tombstone()),
				request: release(),
				cause: "free",
			},
			{ label: "absent", catches: "a release creating a ref", observed: ABSENT, request: release(), cause: "absent" },
			{
				label: "own claim, expectation 2",
				catches: "a missing continuity check on release",
				observed: present(active()),
				request: release(),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
		]);
	});
});

describe("claim transition planner: reclaim", () => {
	test("reclaims at C-eps>=R regardless of the caller binding, own claims included", () => {
		checkPlanned([
			{
				label: "Franz reclaims Karl's lease at R",
				catches: "reclaim bound to the holder's binding",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R + EPS, binding: FRANZ },
				expected: plannedFor(reclaim(), tombstone(3)),
			},
			{
				label: "Karl reclaims his own lease at R",
				catches: "an own claim excluded from reclaim",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R + EPS },
				expected: plannedFor(reclaim(), tombstone(3)),
			},
			{
				label: "epsilon zero, exactly R",
				catches: "an epsilon default",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R, clockSkewMs: 0 },
				expected: plannedFor(reclaim(), tombstone(3)),
			},
			{
				label: "hard claim at H plus grace",
				catches: "the hard boundary without grace",
				observed: present(foreign(hard())),
				request: reclaim(),
				changes: { now: H + GRACE + EPS },
				expected: plannedFor(reclaim(), tombstone(3)),
			},
			{
				label: "lease with H, reclaimable at L+g before H",
				catches: "H+g used for a lease with H",
				observed: present(foreign(lease(L, H), { claimGeneration: 6 })),
				request: reclaim(),
				changes: { now: R + EPS },
				expected: plannedFor(reclaim(), tombstone(6), ROOT, 6),
			},
		]);
		checkRejected([
			{
				label: "one ms before R by the -eps reading",
				catches: "+eps instead of -eps",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R + EPS - 1 },
				cause: "not-yet",
				boundary: R,
			},
			{
				label: "before the lease end",
				catches: "reclaim of a live lease",
				observed: present(active()),
				request: reclaim(),
				cause: "not-yet",
				boundary: R,
			},
			{
				label: "hard claim one ms before H plus grace",
				catches: "+eps instead of -eps on the hard boundary",
				observed: present(foreign(hard())),
				request: reclaim(),
				changes: { now: H + GRACE + EPS - 1 },
				cause: "not-yet",
				boundary: H + GRACE,
			},
			{
				label: "hard claim inside grace after H",
				catches: "H instead of H+g",
				observed: present(foreign(hard())),
				request: reclaim(),
				changes: { now: H + MINUTE },
				cause: "not-yet",
				boundary: H + GRACE,
			},
			{
				label: "lease ending one minute before H, past H but before L+g",
				catches: "H+g instead of L+g for a lease with H",
				observed: present(foreign(lease(H - MINUTE, H))),
				request: reclaim(),
				changes: { now: H + MINUTE },
				cause: "not-yet",
				boundary: H - MINUTE + GRACE,
			},
			{
				label: "timeless claim ten years later",
				catches: "time-based reclaim of the no-expiry mode",
				observed: present(foreign(TIMELESS)),
				request: reclaim(),
				changes: { now: T + 3650 * DAY },
				cause: "never",
			},
			{
				label: "tombstone",
				catches: "a reclaim of a free ticket",
				observed: present(tombstone()),
				request: reclaim(),
				cause: "free",
			},
			{ label: "absent", catches: "a reclaim creating a ref", observed: ABSENT, request: reclaim(), cause: "absent" },
			{
				label: "reclaimable claim, expectation 2",
				catches: "a missing continuity check on reclaim",
				observed: present(active()),
				request: reclaim(),
				changes: { now: R + EPS, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
		]);
	});
});

describe("claim transition planner: rejection precedence", () => {
	test("orders state and ownership, generation, mode, time and range verdicts as the contract fixes them", () => {
		checkPlanned([
			{
				label: "positive control",
				catches: "nothing; the own lease renews",
				observed: present(active()),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
		]);
		checkRejected([
			{
				label: "foreign holder, H expired, renew",
				catches: "time before ownership",
				observed: present(foreign(lease(L, H))),
				request: renew(),
				changes: { now: H + MINUTE },
				cause: "not-holder",
			},
			{
				label: "foreign holder, wrong expectation, renew",
				catches: "generation before ownership",
				observed: present(foreign()),
				request: renew(),
				changes: { expectedClaimGeneration: 2 },
				cause: "not-holder",
			},
			{
				label: "own active claim, wrong expectation, acquire",
				catches: "generation before state",
				observed: present(active()),
				request: acquire(),
				changes: { expectedClaimGeneration: 2 },
				cause: "held",
			},
			{
				label: "tombstone, wrong expectation, reclaim",
				catches: "generation before state on a free ticket",
				observed: present(tombstone()),
				request: reclaim(),
				changes: { expectedClaimGeneration: 2 },
				cause: "free",
			},
			{
				label: "tombstone, renew",
				catches: "a renew rule applied to a free ticket",
				observed: present(tombstone()),
				request: renew(),
				cause: "free",
			},
			{
				label: "absent, release",
				catches: "a release rule applied to an absent ticket",
				observed: ABSENT,
				request: release(),
				cause: "absent",
			},
			{
				label: "own hard claim after H, renew",
				catches: "time before mode",
				observed: present(active(hard())),
				request: renew(),
				changes: { now: H + MINUTE },
				cause: "not-renewable",
			},
			{
				label: "own hard claim, wrong expectation, renew",
				catches: "mode before generation",
				observed: present(active(hard())),
				request: renew(),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "timeless claim, wrong expectation, reclaim",
				catches: "mode before generation on reclaim",
				observed: present(foreign(TIMELESS)),
				request: reclaim(),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "own lease not yet reclaimable, wrong expectation, reclaim",
				catches: "time before generation on reclaim",
				observed: present(active()),
				request: reclaim(),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "own lease with H after H, wrong expectation, renew",
				catches: "time before generation on renew",
				observed: present(active(lease(L, H))),
				request: renew(),
				changes: { now: H + MINUTE, expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
			{
				label: "tombstone, lease with a past H, wrong expectation, acquire",
				catches: "time before generation on acquire",
				observed: present(tombstone(4)),
				request: acquire(leaseRequest(TTL, "default", T - MINUTE)),
				changes: { expectedClaimGeneration: 5 },
				cause: "generation-changed",
			},
			{
				label: "absent with any expectation, acquire",
				catches: "an expectation ignored on an absent ticket",
				observed: ABSENT,
				request: acquire(),
				changes: { expectedClaimGeneration: 1 },
				cause: "generation-changed",
			},
			{
				label: "hard deadline in the past whose sum with grace overflows",
				catches: "range before time",
				observed: ABSENT,
				request: acquire(hardRequest(MAX - EPS, EPS + 1)),
				changes: { now: MAX - EPS },
				cause: "hard-expired",
				boundary: MAX - EPS,
			},
			{
				label: "foreign holder, renew whose C+ttl overflows",
				catches: "range before ownership",
				observed: present(foreign()),
				request: renew(MAX - T + 1),
				cause: "not-holder",
			},
			{
				label: "own active claim, acquire whose hardEnd+graceMs overflows",
				catches: "request-internal range before state",
				observed: present(active()),
				request: acquire(hardRequest(MAX - 5, 10)),
				cause: "held",
			},
			{
				label: "own hard claim, renew whose C+ttl overflows",
				catches: "range before mode",
				observed: present(active(hard())),
				request: renew(MAX - T + 1),
				cause: "not-renewable",
			},
			{
				label: "own lease, wrong expectation, renew whose C+ttl overflows",
				catches: "range before generation",
				observed: present(active()),
				request: renew(MAX - T + 1),
				changes: { expectedClaimGeneration: 2 },
				cause: "generation-changed",
			},
		]);
		checkFailures([
			{
				label: "own lease, renew whose C+ttl overflows",
				catches: "an overflowing lease end planned or wrapped",
				observed: present(active()),
				request: renew(MAX - T + 1),
				kind: "invalid",
			},
			{
				label: "legacy payload, renew whose C+ttl overflows",
				catches: "range before the observation verdict",
				observed: present({ state: "claimed", holder: OWNER }),
				request: renew(MAX - T + 1),
				kind: "corrupt",
			},
		]);
	});

	test("classifies observations exactly like the rights module before any action rule", () => {
		checkPlanned([
			{
				label: "positive control",
				catches: "nothing; the own lease renews",
				observed: present(active()),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
		]);
		const otherTicket: Extract<ClaimReadResult, { kind: "present" }> = {
			kind: "present",
			ticket: "BACK-2",
			root: ROOT,
			document: documentOf(active()),
		};
		// v1 PENDING is decoded; a form breaking its invariants is corrupt, not unsupported:
		// no finite hard end on the source, the same generation on both sides; claim-time-path.test.ts plans a valid one.
		const pending = { claimState: 1, status: "pending", claimGeneration: 3, source: active(), target: foreign() };
		checkFailures([
			{
				label: "unreachable read",
				catches: "a read failure as absent",
				observed: UNREACHABLE,
				request: acquire(),
				kind: "unknown",
			},
			{
				label: "corrupt read",
				catches: "a corrupt ref as free",
				observed: { kind: "corrupt", reason: `broken ${ROOT}` },
				request: acquire(),
				kind: "unknown",
			},
			{
				label: "invalid read",
				catches: "an invalid read as absent",
				observed: { kind: "invalid", reason: "bad" },
				request: release(),
				kind: "unknown",
			},
			{
				label: "malformed root",
				catches: "a malformed observation planned",
				observed: present(active(), "xyz"),
				request: renew(),
				kind: "unknown",
			},
			{
				label: "legacy name-based payload",
				catches: "an unknown payload read as free or active",
				observed: present({ state: "claimed", holder: KARL }),
				request: renew(),
				kind: "corrupt",
			},
			{
				label: "missing discriminator",
				catches: "a second, laxer parser",
				observed: present(without(active(), "claimState")),
				request: release(),
				kind: "corrupt",
			},
			{
				label: "PENDING, acquire",
				catches: "PENDING read as free",
				observed: present(pending),
				request: acquire(),
				kind: "corrupt",
			},
			{
				label: "PENDING, release",
				catches: "a source release on PENDING",
				observed: present(pending),
				request: release(),
				kind: "corrupt",
			},
			{
				label: "PENDING, reclaim",
				catches: "a reclaim without the PENDING hull",
				observed: present(pending),
				request: reclaim(),
				changes: { now: T + 3650 * DAY },
				kind: "corrupt",
			},
			{
				label: "version 2",
				catches: "a version fallback",
				observed: present({ ...active(), claimState: 2 }),
				request: renew(),
				kind: "unsupported",
			},
			{
				label: "well-formed observation of another ticket",
				catches: "a missing scope check",
				observed: otherTicket,
				request: renew(),
				kind: "invalid",
			},
			{
				label: "malformed observation of another ticket",
				catches: "scope checked before structure",
				observed: { ...otherTicket, root: "xyz" },
				request: renew(),
				kind: "unknown",
			},
			{
				label: "document of another format",
				catches: "a missing format scope check",
				observed: present(active(), ROOT, { format: "tree" }),
				request: renew(),
				kind: "invalid",
			},
			{
				label: "absent for another ticket",
				catches: "a missing scope check on absent",
				observed: { kind: "absent", ticket: "BACK-2" },
				request: acquire(),
				kind: "invalid",
			},
		]);
	});

	test("validates options and the exact request before looking at the observation", () => {
		checkPlanned([
			{
				label: "positive control, renew",
				catches: "nothing; the own lease renews",
				observed: present(active()),
				request: renew(),
				expected: plannedFor(renew(), active(lease(T + TTL))),
			},
			{
				label: "positive control, release",
				catches: "nothing; the own lease releases",
				observed: present(active()),
				request: release(),
				expected: plannedFor(release(), tombstone(3)),
			},
		]);
		class RenewRequest {
			action = "renew";
			ttlMs = TTL;
			ttlSource = "default";
		}
		const requests: [string, unknown][] = [
			["null request", null],
			["array request", [renew()]],
			["string request", "renew"],
			["missing action", { ttlMs: TTL, ttlSource: "default" }],
			["unknown action transfer", { action: "transfer" }],
			["unknown action next", { action: "next" }],
			["action case variant", { ...renew(), action: "RENEW" }],
			["renew with an owner field", { ...renew(), owner: OWNER }],
			["renew without ttlSource", without(renew(), "ttlSource")],
			["renew ttl zero", renew(0)],
			["renew ttl negative", renew(-1)],
			["renew ttl fractional", renew(TTL + 0.5)],
			["renew ttl string", { ...renew(), ttlMs: String(TTL) }],
			["renew ttl unsafe", renew(MAX + 1)],
			["renew ttlSource auto", { ...renew(), ttlSource: "auto" }],
			["release with a ttl", { action: "release", ttlMs: TTL }],
			["reclaim with an owner", { action: "reclaim", owner: OWNER }],
			["acquire without timing", { action: "acquire", owner: OWNER }],
			["acquire without owner", { action: "acquire", timing: leaseRequest() }],
			["acquire with empty owner", acquire(leaseRequest(), "")],
			["acquire with numeric owner", { ...acquire(), owner: 42 }],
			["acquire with an extra field", { ...acquire(), binding: KARL }],
			["acquire with null timing", { ...acquire(), timing: null }],
			["acquire with unknown mode", acquire(asTiming({ ...leaseRequest(), mode: "soft" }))],
			["lease timing without the hardEnd key", acquire(asTiming(without(leaseRequest(), "hardEnd")))],
			["lease timing without graceMs", acquire(asTiming(without(leaseRequest(), "graceMs")))],
			["lease timing with negative grace", acquire(leaseRequest(TTL, "default", null, -1))],
			["lease timing with negative hardEnd", acquire(leaseRequest(TTL, "default", -1))],
			["lease timing with fractional hardEnd", acquire(leaseRequest(TTL, "default", H + 0.5))],
			["lease timing with ttl zero", acquire(leaseRequest(0))],
			["lease timing with ttlSource auto", acquire(asTiming({ ...leaseRequest(), ttlSource: "auto" }))],
			["lease timing with an extra field", acquire(asTiming({ ...leaseRequest(), leaseEnd: L }))],
			["hard timing with a ttl", acquire(asTiming({ ...hardRequest(), ttlMs: TTL }))],
			["hard timing without grace", acquire(asTiming(without(hardRequest(), "graceMs")))],
			["timeless timing with grace", acquire(asTiming({ mode: "none", graceMs: GRACE }))],
			["request accessor", withAccessor(renew(), "ttlMs", TTL)],
			["timing accessor", acquire(withAccessor(leaseRequest(), "ttlMs", TTL))],
			["request symbol key", Object.assign(renew(), { [Symbol("hidden")]: 1 })],
			["request hidden field", withHidden(renew(), "ttlSource", "default")],
			["request class instance", new RenewRequest()],
		];
		for (const [label, request] of requests) {
			const typed = request as ClaimTransitionRequest;
			expectFailure(`${label} on a plannable observation`, plan(present(active()), typed), "invalid");
			expectFailure(`${label} on an unreachable read`, plan(UNREACHABLE, typed), "invalid");
			expectFailure(`${label} on a corrupt payload`, plan(present({ state: "claimed" }), typed), "invalid");
		}
		const options: [string, Partial<PlanClaimTransitionOptions>][] = [
			["owner name as binding", { binding: OWNER }],
			["uppercase binding", { binding: KARL.toUpperCase() }],
			["negative now", { now: -1 }],
			["fractional now", { now: T + 0.5 }],
			["negative epsilon", { clockSkewMs: -1 }],
			["now plus epsilon overflow", { now: MAX, clockSkewMs: 1 }],
			["non-canonical ticket", { ticket: "back-1" }],
			["expected generation zero", { expectedClaimGeneration: 0 }],
			["fractional expected generation", { expectedClaimGeneration: 2.5 }],
			["descriptor schema 2", { descriptor: { ...DESCRIPTOR, schema: 2 } as unknown as ClaimStorageDescriptor }],
			["descriptor epoch zero", { descriptor: { ...DESCRIPTOR, epoch: 0 } }],
		];
		for (const [label, changes] of options) {
			expectFailure(`${label} on a plannable observation`, plan(present(active()), renew(), changes), "invalid");
			expectFailure(`${label} on an unreachable read`, plan(UNREACHABLE, renew(), changes), "invalid");
		}
		const accessorOptions = withAccessor(optionsOf(present(active()), renew()), "request", renew());
		expectFailure("options accessor on the request", planClaimTransition(accessorOptions), "invalid");
		expectFailure("null options", planClaimTransition(null as unknown as PlanClaimTransitionOptions), "invalid");
	});

	test("rejects values beyond the safe-integer range as invalid and plans exactly at the limit", () => {
		checkPlanned([
			{
				label: "lease end plus grace exactly at the limit",
				catches: "an off-by-one range check",
				observed: ABSENT,
				request: acquire(leaseRequest(MAX - GRACE - T)),
				expected: plannedFor(
					acquire(leaseRequest(MAX - GRACE - T)),
					active(lease(MAX - GRACE), { claimGeneration: 1 }),
					null,
					null,
				),
			},
			{
				label: "tombstone one below the largest generation",
				catches: "an off-by-one generation check",
				observed: present(tombstone(MAX - 1)),
				request: acquire(),
				expected: plannedFor(acquire(), active(lease(T + TTL), { claimGeneration: MAX }), ROOT, MAX - 1),
			},
		]);
		checkFailures([
			{
				label: "tombstone at the largest generation",
				catches: "a wrapped or unsafe generation",
				observed: present(tombstone(MAX)),
				request: acquire(),
				kind: "invalid",
			},
			{
				label: "acquire whose C+ttl overflows",
				catches: "an unsafe lease end",
				observed: ABSENT,
				request: acquire(leaseRequest(MAX - T + 1)),
				kind: "invalid",
			},
			{
				label: "default acquire under H whose C+ttl overflows before capping",
				catches: "capping applied to an unsafe lease end",
				observed: ABSENT,
				request: acquire(leaseRequest(MAX - T + 1, "default", H)),
				kind: "invalid",
			},
			{
				label: "default renew under stored H whose C+ttl overflows before capping",
				catches: "capping applied to an unsafe renewed lease end",
				observed: present(active(lease(L, H))),
				request: renew(MAX - T + 1, "default"),
				kind: "invalid",
			},
			{
				label: "acquire whose lease end plus grace overflows",
				catches: "an unreclaimable lease",
				observed: ABSENT,
				request: acquire(leaseRequest(MAX - GRACE - T + 1)),
				kind: "invalid",
			},
			{
				label: "hard acquire whose deadline plus grace overflows",
				catches: "an unreclaimable hard claim",
				observed: ABSENT,
				request: acquire(hardRequest(MAX - 5, 10)),
				kind: "invalid",
			},
			{
				label: "lease acquire whose requested H plus grace overflows",
				catches: "a range check on the lease end only",
				observed: ABSENT,
				request: acquire(leaseRequest(TTL, "default", MAX - 5, 10)),
				kind: "invalid",
			},
			{
				label: "renew whose lease end plus stored grace overflows",
				catches: "the stored grace ignored in the range check",
				observed: present(active()),
				request: renew(MAX - GRACE - T + 1),
				kind: "invalid",
			},
		]);
	});
});

describe("claim transition planner: plan output", () => {
	test("returns complete next states that rights decodes, carrying the caller binding and never the owner name", () => {
		const scenarios: [string, ClaimTransitionPlan][] = [
			["acquire lease", plan(ABSENT, acquire())],
			["acquire capped lease", plan(ABSENT, acquire(leaseRequest(90 * MINUTE, "default", H)))],
			["acquire hard", plan(ABSENT, acquire(hardRequest()))],
			["acquire timeless", plan(ABSENT, acquire(noneRequest()))],
			["acquire over a tombstone", plan(present(tombstone(4)), acquire())],
			["acquire as Franz", plan(ABSENT, acquire(leaseRequest(), OTHER_OWNER), { binding: FRANZ })],
			["renew capped", plan(present(active(lease(L, H))), renew(90 * MINUTE))],
			["release", plan(present(active()), release())],
			["reclaim", plan(present(active()), reclaim(), { now: R + EPS, binding: FRANZ })],
		];
		for (const [label, result] of scenarios) {
			const planned = plannedResult(label, result);
			expect({ label, scope: planned.scope, decoded: parseClaimState(planned.next) }).toStrictEqual({
				label,
				scope: "state-plan-only",
				decoded: { kind: "state", state: planned.next },
			});
			if (planned.next.status === "active") {
				const expectedBinding = label === "acquire as Franz" ? FRANZ : KARL;
				expect({ label, binding: planned.next.binding }).toEqual({ label, binding: expectedBinding });
			}
		}
	});

	test("reports exact rejection keys, with a boundary only for hard-expired, overlong and not-yet", () => {
		expectPlanned("positive control", plan(present(active()), renew()), plannedFor(renew(), active(lease(T + TTL))));
		expectRejected("held", plan(present(active()), acquire()), "held");
		expectRejected("not-free", plan(present(foreign()), acquire()), "not-free");
		expectRejected("not-holder", plan(present(foreign()), renew()), "not-holder");
		expectRejected("free", plan(present(tombstone()), renew()), "free");
		expectRejected("absent", plan(ABSENT, release()), "absent");
		expectRejected(
			"generation-changed",
			plan(present(active()), renew(), { expectedClaimGeneration: 2 }),
			"generation-changed",
		);
		expectRejected("not-renewable", plan(present(active(hard())), renew()), "not-renewable");
		expectRejected("never", plan(present(active(TIMELESS)), reclaim()), "never");
		expectRejected("hard-expired", plan(present(active(lease(L, H))), renew(), { now: H }), "hard-expired", H);
		expectRejected("overlong", plan(present(active(lease(L, H))), renew(90 * MINUTE, "explicit")), "overlong", H);
		expectRejected("not-yet", plan(present(active()), reclaim()), "not-yet", R);
	});

	test("returns a fresh copy that shares no object with its inputs and leaves the inputs unchanged", () => {
		const request = acquire(leaseRequest(TTL, "default", H));
		const acquireOptions = optionsOf(present(tombstone(4)), request);
		const acquireBefore = structuredClone(acquireOptions);
		const acquired = plannedResult("acquire", planClaimTransition(acquireOptions));
		const requestTiming = (request as { timing: object }).timing;
		const copiedTiming = (acquired.request as { timing: object }).timing;
		const acquiredNext = acquired.next as ActiveClaimState;
		expect({
			sameRequest: acquired.request === request,
			sameRequestTiming: copiedTiming === requestTiming,
			nextTimingIsRequestTiming: acquiredNext.timing === requestTiming,
			nextTimingIsCopiedTiming: acquiredNext.timing === copiedTiming,
		}).toEqual({
			sameRequest: false,
			sameRequestTiming: false,
			nextTimingIsRequestTiming: false,
			nextTimingIsCopiedTiming: false,
		});
		acquiredNext.timing = TIMELESS;
		(acquired.request as { owner: string }).owner = OTHER_OWNER;
		(copiedTiming as { graceMs?: number }).graceMs = 0;
		expect(acquireOptions).toStrictEqual(acquireBefore);

		const state = active();
		const renewOptions = optionsOf(present(state), renew());
		const renewBefore = structuredClone(renewOptions);
		const renewed = plannedResult("renew", planClaimTransition(renewOptions));
		const renewedNext = renewed.next as ActiveClaimState;
		expect({ sameState: renewedNext === state, sameTiming: renewedNext.timing === state.timing }).toEqual({
			sameState: false,
			sameTiming: false,
		});
		renewedNext.owner = OTHER_OWNER;
		renewedNext.timing = TIMELESS;
		expect(renewOptions).toStrictEqual(renewBefore);
		expect(state).toStrictEqual(active());
	});

	test("is deterministic and reads no ambient clock", () => {
		const holder: { first?: ClaimTransitionPlan; second?: ClaimTransitionPlan } = {};
		const wallClock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("hidden wall clock");
		});
		const monotonicClock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("hidden monotonic clock");
		});
		try {
			holder.first = plan(present(active()), renew(), { now: L + 2 * MINUTE });
			holder.second = plan(present(active()), renew(), { now: L + 2 * MINUTE });
		} finally {
			wallClock.mockRestore();
			monotonicClock.mockRestore();
		}
		const expected = plannedFor(renew(), active(lease(L + 2 * MINUTE + TTL)));
		expect({ first: holder.first, second: holder.second }).toStrictEqual({ first: expected, second: expected });
		expect(JSON.stringify(holder.first)).toBe(JSON.stringify(holder.second));
	});

	test("keeps every diagnostic free of bindings, owner names, roots and request contents", () => {
		expectPlanned(
			"positive control",
			plan(present(foreign(), ROOT_64), reclaim(), { now: R + EPS }),
			plannedFor(reclaim(), tombstone(3), ROOT_64),
		);
		const secret = [String(90 * MINUTE), "agent-sentinel"];
		expectRejected("not-holder", plan(present(foreign(), ROOT_64), renew()), "not-holder", undefined, secret);
		expectRejected("not-free", plan(present(foreign(), ROOT_64), acquire()), "not-free", undefined, secret);
		expectRejected(
			"overlong",
			plan(present(active(lease(L, H)), ROOT_64), renew(90 * MINUTE, "explicit")),
			"overlong",
			H,
			secret,
		);
		expectFailure("owner name as binding", plan(present(active()), renew(), { binding: OWNER }), "invalid", secret);
		expectFailure("unreachable read naming secrets", plan(UNREACHABLE, renew()), "unknown", secret);
		expectFailure("legacy payload naming the binding", plan(present({ holder: KARL }), renew()), "corrupt", secret);
		expectFailure("PENDING", plan(present({ ...active(), status: "pending" }), release()), "corrupt", secret);
	});
});
