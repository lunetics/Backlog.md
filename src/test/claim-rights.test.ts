/**
 * Behavioural contract for the pure observed-state rights projection: exact schema-1
 * claim state decoding and the evaluation of ownership, conditional work right and reclaim eligibility over one
 * explicitly scoped observation, a context binding and explicit numeric time. Every evaluated result is scoped
 * "observed-state-only": nothing here authorizes an external effect, proves freshness beyond the observation,
 * qualifies a clock, proves the absence of an outstanding own operation or fences a worker. No Git, filesystem
 * or clock is used; all times are fixed millisecond constants.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
	type ActiveClaimState,
	type ClaimRightEvaluation,
	type ClaimStateResult,
	type ClaimStateV1,
	type ClaimTiming,
	type EvaluateClaimRightOptions,
	evaluateClaimRight,
	type FreeClaimState,
	parseClaimState,
} from "../claims/rights/index.ts";
import type { ClaimDocument, ClaimReadResult, ClaimStorageDescriptor, JsonObject } from "../claims/storage/index.ts";

const TICKET = "BACK-1";
const ROOT = "a1".repeat(20);
const ROOT_64 = "b2".repeat(32);
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
/** Distinctive context bindings and owner names; no diagnostic may echo any of them. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const RESUMED = `tb1-${"9d".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const SENTINELS = [KARL, FRANZ, RESUMED, OWNER, OTHER_OWNER];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX = Number.MAX_SAFE_INTEGER;
/** "10:00" example; every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const GRACE = 10 * MINUTE;
/** Lease end "10:05" and its reclaim boundary "10:15". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
/** A hard work limit well after the lease end. */
const H = T + 60 * MINUTE;

const RECEIPTS: Record<string, JsonObject> = {
	"op-first": { schema: 1, intentDigest: "c3".repeat(32), parameterDigest: "d4".repeat(32) },
	"op-second": { schema: 1, intentDigest: "e5".repeat(32), parameterDigest: "f6".repeat(32) },
};

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type NoRightCause = Extract<WorkRight, { kind: "none" }>["cause"];

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

function tombstone(claimGeneration = 4): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/** A shallow copy of `value` without `key`, built without `delete`. */
function without(value: object, key: string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** A copy whose `key` is an enumerable getter instead of a data property. */
function withAccessor<T extends object>(value: T, key: string, result: unknown): T {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

/** A copy whose `key` is a non-enumerable data property. */
function withHidden<T extends object>(value: T, key: string, result: unknown): T {
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

function optionsOf(
	observed: ClaimReadResult,
	changes: Partial<EvaluateClaimRightOptions> = {},
): EvaluateClaimRightOptions {
	return {
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed,
		binding: KARL,
		now: T,
		clockSkewMs: EPS,
		...changes,
	};
}

function evaluate(observed: ClaimReadResult, changes: Partial<EvaluateClaimRightOptions> = {}): ClaimRightEvaluation {
	return evaluateClaimRight(optionsOf(observed, changes));
}

function evaluated(
	ownership: Evaluated["ownership"],
	workRight: WorkRight,
	reclaim: Reclaim,
	observedRoot: string | null = ROOT,
	claimGeneration: number | null = 3,
): Evaluated {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot,
		claimGeneration,
		ownership,
		workRight,
		reclaim,
	};
}

function live(renewalDue: boolean | null): WorkRight {
	return { kind: "live", renewalDue };
}

function noRight(cause: NoRightCause): WorkRight {
	return { kind: "none", cause };
}

function eligible(boundary: number): Reclaim {
	return { kind: "eligible", boundary };
}

function notYet(boundary: number): Reclaim {
	return { kind: "not-yet", boundary };
}

const NEVER: Reclaim = { kind: "never" };
const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

function expectEvaluation(label: string, actual: ClaimRightEvaluation, expected: Evaluated): void {
	expect({ label, result: actual }).toStrictEqual({ label, result: expected });
}

/**
 * A failure carries exactly `kind` and a nonempty string `reason` that echoes no binding, owner or given value.
 * Only counts are compared, so a failing run prints no raw values either.
 */
function expectFailure(
	label: string,
	result: ClaimRightEvaluation | ClaimStateResult,
	kind: ClaimRightEvaluation["kind"] | ClaimStateResult["kind"],
	values: string[] = [],
): void {
	const reason = (result as { reason?: unknown }).reason;
	const text = typeof reason === "string" ? reason : "";
	const echoed = [...SENTINELS, ...values].filter((value) => value !== "" && text.includes(value)).length;
	expect({
		label,
		kind: result.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof reason,
		reasonEmpty: text.length === 0,
		echoed,
	}).toEqual({ label, kind, keys: ["kind", "reason"], reasonType: "string", reasonEmpty: false, echoed: 0 });
}

describe("claim state parser", () => {
	test("decodes exact schema-1 lease, hard, timeless and free states and leaves the input unchanged", () => {
		const states: [string, ClaimStateV1][] = [
			["lease without H", active(lease())],
			["lease with H", active(lease(L, H))],
			["lease ending exactly at H", active(lease(H, H))],
			["lease at epoch zero without grace", active(lease(0, null, 0))],
			["hard", active(hard())],
			["hard without grace", active(hard(H, 0))],
			["timeless", active(TIMELESS)],
			["resumed binding", active(lease(), { binding: RESUMED, bindingGeneration: 2 })],
			["largest safe values", active(lease(MAX - GRACE), { claimGeneration: MAX, bindingGeneration: MAX })],
			["tombstone", tombstone()],
		];
		for (const [label, state] of states) {
			const input = structuredClone(state);
			expect({ label, result: parseClaimState(input) }).toStrictEqual({ label, result: { kind: "state", state } });
			expect({ label, input }).toStrictEqual({ label, input: state });
		}
	});

	test("marks foreign versions and unknown string statuses unsupported, bad discriminators corrupt", () => {
		// Positive control: the same shapes with the known version and status decode.
		expect(parseClaimState(active())).toStrictEqual({ kind: "state", state: active() });

		const unsupported: [string, unknown][] = [
			["version 2", { ...active(), claimState: 2 }],
			["version 7 tombstone", { ...tombstone(), claimState: 7 }],
			["largest safe version", { ...active(), claimState: MAX }],
			["version 2 with unknown fields", { claimState: 2, anything: true }],
			["unknown status", { ...active(), status: "weird" }],
			["status case variant", { ...active(), status: "ACTIVE" }],
		];
		for (const [label, payload] of unsupported) expectFailure(label, parseClaimState(payload), "unsupported");

		const corrupt: [string, unknown][] = [
			// v1 PENDING is decoded; a form breaking its invariants is corrupt, not unsupported
			// (no finite hard end on the source, the same generation on both sides, the holder's own fields).
			[
				"pending with source and target",
				{
					claimState: 1,
					status: "pending",
					claimGeneration: 3,
					source: active(),
					target: active(lease(), { binding: FRANZ }),
				},
			],
			["pending with the holder's own fields", { ...active(), status: "pending" }],
			["missing version", without(active(), "claimState")],
			["string version", { ...active(), claimState: "1" }],
			["version zero", { ...active(), claimState: 0 }],
			["negative version", { ...active(), claimState: -1 }],
			["fractional version", { ...active(), claimState: 1.5 }],
			["null version", { ...active(), claimState: null }],
			["boolean version", { ...active(), claimState: true }],
			["unsafe version", { ...active(), claimState: MAX + 1 }],
			["missing status", without(active(), "status")],
			["numeric status", { ...active(), status: 1 }],
			["null status", { ...active(), status: null }],
			["object status", { ...active(), status: {} }],
		];
		for (const [label, payload] of corrupt) expectFailure(label, parseClaimState(payload), "corrupt");
	});

	test("rejects every schema-1 field violation as corrupt, including unsafe boundary sums", () => {
		const base = active(lease(L, H));
		expect(parseClaimState(base)).toStrictEqual({ kind: "state", state: base });

		const fields = ["claimGeneration", "bindingGeneration", "owner", "binding", "timing"];
		const cases: [string, unknown][] = [
			["legacy name-based payload", { state: "claimed", holder: OWNER }],
			["legacy payload naming a binding", { state: "claimed", holder: KARL }],
			["empty object", {}],
			...fields.map((field): [string, unknown] => [`missing ${field}`, without(base, field)]),
			["extra field", { ...base, assignee: "human-maria" }],
			["generation zero", { ...base, claimGeneration: 0 }],
			["negative generation", { ...base, claimGeneration: -1 }],
			["fractional generation", { ...base, claimGeneration: 1.5 }],
			["string generation", { ...base, claimGeneration: "3" }],
			["unsafe generation", { ...base, claimGeneration: MAX + 1 }],
			["binding generation zero", { ...base, bindingGeneration: 0 }],
			["empty owner", { ...base, owner: "" }],
			["numeric owner", { ...base, owner: 42 }],
			["uppercase binding", { ...base, binding: KARL.toUpperCase() }],
			["uppercase hex binding", { ...base, binding: `tb1-${"4B".repeat(32)}` }],
			["short binding", { ...base, binding: KARL.slice(0, -1) }],
			["long binding", { ...base, binding: `${KARL}0` }],
			["unprefixed binding", { ...base, binding: KARL.slice(4) }],
			["other binding prefix", { ...base, binding: `tb2-${KARL.slice(4)}` }],
			["binding with newline", { ...base, binding: `${KARL}\n` }],
			["owner name as binding", { ...base, binding: OWNER }],
			["null timing", { ...base, timing: null }],
			["array timing", { ...base, timing: [] }],
			["unknown mode", { ...base, timing: { ...lease(L, H), mode: "soft" } }],
			["missing mode", { ...base, timing: without(lease(L, H), "mode") }],
			["negative lease end", { ...base, timing: lease(-1, H) }],
			["fractional lease end", { ...base, timing: lease(L + 0.5, H) }],
			["string lease end", { ...base, timing: { ...lease(L, H), leaseEnd: String(L) } }],
			["negative grace", { ...base, timing: lease(L, H, -1) }],
			["missing grace", { ...base, timing: without(lease(L, H), "graceMs") }],
			["missing hardEnd key", { ...base, timing: without(lease(L, H), "hardEnd") }],
			["H before the lease end", { ...base, timing: lease(L, L - 1) }],
			["negative H", { ...base, timing: lease(0, -1) }],
			["lease end plus grace overflow", { ...base, timing: lease(MAX - 10, null, 11) }],
			["extra timing field", { ...base, timing: { ...lease(L, H), ttlMs: 5 * MINUTE } }],
			["hard without grace field", { ...base, timing: without(hard(), "graceMs") }],
			["hard with a lease end", { ...base, timing: { ...hard(), leaseEnd: L } }],
			["negative hard end", { ...base, timing: hard(-1) }],
			["null hard end in hard mode", { ...base, timing: { mode: "hard", hardEnd: null, graceMs: GRACE } }],
			["hard end plus grace overflow", { ...base, timing: hard(MAX - 10, 11) }],
			["timeless with grace", { ...base, timing: { mode: "none", graceMs: 0 } }],
			["tombstone with a binding", { ...tombstone(), binding: KARL }],
			["tombstone generation zero", tombstone(0)],
			["tombstone without generation", without(tombstone(), "claimGeneration")],
		];
		for (const [label, payload] of cases) expectFailure(label, parseClaimState(payload), "corrupt");
	});

	test("rejects non-JSON values, cycles, class instances, accessors, symbols and hidden fields as corrupt", () => {
		const base = active(lease(L, H));
		const cyclic: Record<string, unknown> = { ...base };
		cyclic.timing = { ...lease(L, H), self: cyclic };
		class StatePayload {
			describe(): string {
				return "claim state";
			}
		}
		const cases: [string, unknown][] = [
			["null payload", null],
			["undefined payload", undefined],
			["array payload", [base]],
			["string payload", "active"],
			["numeric payload", 42],
			["date value", { ...base, owner: new Date(0) }],
			["NaN time", { ...base, timing: lease(Number.NaN, H) }],
			["infinite time", { ...base, timing: lease(L, Number.POSITIVE_INFINITY) }],
			["undefined value", { ...base, owner: undefined }],
			["function value", { ...base, owner: () => OWNER }],
			["bigint value", { ...base, claimGeneration: 3n }],
			["cycle", cyclic],
			["class instance", Object.assign(new StatePayload(), base)],
			["accessor field", withAccessor(base, "binding", KARL)],
			["nested accessor", { ...base, timing: withAccessor(lease(L, H), "leaseEnd", L) }],
			["symbol key", Object.assign({ ...base }, { [Symbol("hidden")]: 1 })],
			["hidden extra field", withHidden(base, "hidden", 1)],
			["hidden required field", withHidden(base, "binding", KARL)],
		];
		for (const [label, payload] of cases) expectFailure(label, parseClaimState(payload), "corrupt");
		// Positive control: the plain data behind the accessor cases decodes.
		expect(parseClaimState({ ...base })).toStrictEqual({ kind: "state", state: base });
	});
});

describe("claim right evaluation", () => {
	test("pure lease: neither the lease end nor the reclaim boundary revokes the holder's work right", () => {
		const observed = present(active(lease()));
		const cases: [string, number, Evaluated][] = [
			["before the lease end", T, evaluated("held", live(false), notYet(R))],
			["renewal not yet due one ms before L", L - 1 - EPS, evaluated("held", live(false), notYet(R))],
			["renewal due at L by the +eps reading", L - EPS, evaluated("held", live(true), notYet(R))],
			["two minutes after the lease end", L + 2 * MINUTE, evaluated("held", live(true), notYet(R))],
			["one ms before eligibility by the -eps reading", R - 1 + EPS, evaluated("held", live(true), notYet(R))],
			["reclaim boundary reached, no reclaim yet", R + EPS, evaluated("held", live(true), eligible(R))],
			["thirty days later without H", L + 30 * DAY, evaluated("held", live(true), eligible(R))],
		];
		for (const [label, now, expected] of cases) {
			const options = optionsOf(observed, { now });
			const before = structuredClone(options);
			expectEvaluation(label, evaluateClaimRight(options), expected);
			expect({ label, options }).toStrictEqual({ label, options: before });
		}
	});

	test("gives a former holder no right after a successor, a tombstone or a missing ref", () => {
		const successorLease = T + 20 * MINUTE;
		const successor = present(
			active(lease(successorLease), { binding: FRANZ, owner: OTHER_OWNER, claimGeneration: 4 }),
			ROOT_64,
		);
		const now = T + 16 * MINUTE;
		const boundary = successorLease + GRACE;
		expectEvaluation(
			"former holder after reclaim and reacquisition",
			evaluate(successor, { now }),
			evaluated("foreign", noRight("not-holder"), notYet(boundary), ROOT_64, 4),
		);
		expectEvaluation(
			"successor",
			evaluate(successor, { now, binding: FRANZ }),
			evaluated("held", live(false), notYet(boundary), ROOT_64, 4),
		);
		for (const binding of [KARL, FRANZ]) {
			expectEvaluation(
				`tombstone for ${binding === KARL ? "former holder" : "other binding"}`,
				evaluate(present(tombstone(4)), { now, binding }),
				evaluated("free", noRight("free"), NOT_APPLICABLE, ROOT, 4),
			);
		}
		expectEvaluation(
			"absent ref",
			evaluate(ABSENT, { now }),
			evaluated("absent", noRight("absent"), NOT_APPLICABLE, null, null),
		);
	});

	test("ends the work right at now+eps>=H in hard mode and under a lease, never extended by grace", () => {
		const hardMode = present(active(hard()));
		const hardBoundary = H + GRACE;
		const cases: [string, ClaimReadResult, number, Evaluated][] = [
			["hard: one ms before H", hardMode, H - 1 - EPS, evaluated("held", live(null), notYet(hardBoundary))],
			["hard: at H", hardMode, H - EPS, evaluated("held", noRight("hard-expired"), notYet(hardBoundary))],
			[
				"hard: +eps reading past H while -eps is not",
				hardMode,
				H - EPS + 1,
				evaluated("held", noRight("hard-expired"), notYet(hardBoundary)),
			],
			[
				"hard: inside grace after H",
				hardMode,
				H + 5 * MINUTE,
				evaluated("held", noRight("hard-expired"), notYet(hardBoundary)),
			],
			[
				"hard: after grace",
				hardMode,
				hardBoundary + EPS,
				evaluated("held", noRight("hard-expired"), eligible(hardBoundary)),
			],
			[
				"lease capped at H",
				present(active(lease(H, H))),
				H - EPS,
				evaluated("held", noRight("hard-expired"), notYet(H + GRACE)),
			],
			["lease with H after the lease end", present(active(lease(L, H))), L, evaluated("held", live(true), notYet(R))],
			[
				"lease with H reclaimable before H",
				present(active(lease(L, H))),
				R + EPS,
				evaluated("held", live(true), eligible(R)),
			],
			[
				"lease with H past H",
				present(active(lease(L, H))),
				H + MINUTE,
				evaluated("held", noRight("hard-expired"), eligible(R)),
			],
		];
		for (const [label, observed, now, expected] of cases) {
			expectEvaluation(label, evaluate(observed, { now }), expected);
		}
	});

	test("keeps a late preserve transfer stored after H without work right, the old holder foreign", () => {
		const observed = present(active(lease(H, H), { binding: FRANZ, owner: OTHER_OWNER, claimGeneration: 4 }));
		const now = H + MINUTE;
		expectEvaluation(
			"current holder after H",
			evaluate(observed, { now, binding: FRANZ }),
			evaluated("held", noRight("hard-expired"), notYet(H + GRACE), ROOT, 4),
		);
		expectEvaluation(
			"displaced holder",
			evaluate(observed, { now }),
			evaluated("foreign", noRight("not-holder"), notYet(H + GRACE), ROOT, 4),
		);
	});

	test("never expires or becomes reclaimable by time in timeless mode", () => {
		const now = T + 3650 * DAY;
		expectEvaluation(
			"holder ten years later",
			evaluate(present(active(TIMELESS)), { now }),
			evaluated("held", live(null), NEVER),
		);
		expectEvaluation(
			"other binding",
			evaluate(present(active(TIMELESS, { binding: FRANZ })), { now }),
			evaluated("foreign", noRight("not-holder"), NEVER),
		);
	});

	test("derives authority from the exact context binding, never from the owner name or a replaced binding", () => {
		expectEvaluation(
			"same owner name, other binding",
			evaluate(present(active(lease(), { binding: FRANZ }))),
			evaluated("foreign", noRight("not-holder"), notYet(R)),
		);
		expectEvaluation(
			"other owner name, own binding",
			evaluate(present(active(lease(), { owner: OTHER_OWNER }))),
			evaluated("held", live(false), notYet(R)),
		);
		const resumed = present(active(lease(), { binding: RESUMED, bindingGeneration: 2 }));
		expectEvaluation(
			"binding replaced by resume",
			evaluate(resumed),
			evaluated("foreign", noRight("not-holder"), notYet(R)),
		);
		expectEvaluation(
			"resumed binding",
			evaluate(resumed, { binding: RESUMED }),
			evaluated("held", live(false), notYet(R)),
		);

		const observed = present(active());
		const bindings = [
			KARL.toUpperCase(),
			`tb1-${"4B".repeat(32)}`,
			KARL.slice(0, -1),
			`${KARL}0`,
			` ${KARL}`,
			`${KARL}\n`,
			KARL.slice(4),
			OWNER,
			"",
			42 as unknown as string,
		];
		for (const binding of bindings) {
			const label = `invalid binding ${typeof binding === "string" ? binding.length : typeof binding}`;
			expectFailure(label, evaluate(observed, { binding }), "invalid", typeof binding === "string" ? [binding] : []);
		}
	});

	test("checks an expected claim generation as continuity, before the hard limit and after the holder", () => {
		const observed = present(active());
		expectEvaluation("no expectation", evaluate(observed), evaluated("held", live(false), notYet(R)));
		expectEvaluation(
			"matching generation",
			evaluate(observed, { expectedClaimGeneration: 3 }),
			evaluated("held", live(false), notYet(R)),
		);
		for (const expectedClaimGeneration of [2, 4]) {
			expectEvaluation(
				`expected generation ${expectedClaimGeneration}`,
				evaluate(observed, { expectedClaimGeneration }),
				evaluated("held", noRight("generation-changed"), notYet(R)),
			);
		}
		expectEvaluation(
			"other binding with a stale expectation",
			evaluate(present(active(lease(), { binding: FRANZ })), { expectedClaimGeneration: 2 }),
			evaluated("foreign", noRight("not-holder"), notYet(R)),
		);
		expectEvaluation(
			"stale expectation after H",
			evaluate(present(active(hard())), { now: H, expectedClaimGeneration: 2 }),
			evaluated("held", noRight("generation-changed"), notYet(H + GRACE)),
		);
		expectEvaluation(
			"stale expectation in timeless mode",
			evaluate(present(active(TIMELESS)), { expectedClaimGeneration: 2 }),
			evaluated("held", noRight("generation-changed"), NEVER),
		);
	});

	test("never yields a right from PENDING, foreign versions or corrupt payloads carrying the caller's binding", () => {
		expectEvaluation("positive control", evaluate(present(active())), evaluated("held", live(false), notYet(R)));
		const unsupported: [string, unknown][] = [["version 2", { ...active(), claimState: 2 }]];
		for (const [label, payload] of unsupported) expectFailure(label, evaluate(present(payload)), "unsupported");
		const corrupt: [string, unknown][] = [
			// v1 PENDING is decoded; a form breaking its invariants is corrupt, not unsupported
			// (source or target missing, the caller's own fields); a valid PENDING is pinned in claim-time-path.test.ts.
			["pending with caller as source", { claimState: 1, status: "pending", claimGeneration: 3, source: active() }],
			[
				"pending with caller as target",
				{ claimState: 1, status: "pending", claimGeneration: 3, target: active(lease(), { bindingGeneration: 2 }) },
			],
			["pending with the caller's own fields", { ...active(), status: "pending" }],
			["legacy name-based payload", { state: "claimed", holder: OWNER }],
			["legacy payload naming the caller's binding", { state: "claimed", holder: KARL }],
			["missing discriminator", without(active(), "claimState")],
			["missing timing", without(active(), "timing")],
			["H before the lease end", active(lease(L, L - 1))],
		];
		for (const [label, payload] of corrupt) expectFailure(label, evaluate(present(payload)), "corrupt");
	});

	test("ignores historical receipts: an own receipt never creates ownership, missing receipts never remove it", () => {
		const own = { "op-own": { schema: 1, intentDigest: "ab".repeat(32), parameterDigest: "cd".repeat(32) } };
		expectEvaluation(
			"own receipt, other holder",
			evaluate(present(active(lease(), { binding: FRANZ }), ROOT, { receipts: own })),
			evaluated("foreign", noRight("not-holder"), notYet(R)),
		);
		expectEvaluation(
			"no receipts, own binding",
			evaluate(present(active(), ROOT, { receipts: {} })),
			evaluated("held", live(false), notYet(R)),
		);
	});

	test("reports unavailable or malformed observations as unknown and scope mismatches as invalid", () => {
		expectEvaluation(
			"64-hex root",
			evaluate(present(active(), ROOT_64)),
			evaluated("held", live(false), notYet(R), ROOT_64),
		);
		expectEvaluation(
			"matching descriptor and document epoch 2",
			evaluate(present(active(), ROOT, { epoch: 2 }), { descriptor: { ...DESCRIPTOR, epoch: 2 } }),
			evaluated("held", live(false), notYet(R)),
		);
		const upstream = `upstream ${OWNER} ${KARL}`;
		const unknown: [string, unknown][] = [
			["unreachable", { kind: "unreachable", reason: upstream }],
			["corrupt read", { kind: "corrupt", reason: upstream }],
			["invalid read", { kind: "invalid", reason: upstream }],
			["null observation", null],
			["unknown kind", { kind: "stale", ticket: TICKET }],
			["absent without ticket", { kind: "absent" }],
			["present without root", without(present(active()), "root")],
			["uppercase root", present(active(), ROOT.toUpperCase())],
			["short root", present(active(), ROOT.slice(1))],
			["present without document", { kind: "present", ticket: TICKET, root: ROOT }],
			["document schema 2", present(active(), ROOT, { schema: 2 })],
			["document revision zero", present(active(), ROOT, { revision: 0 })],
			["receipts not an object", present(active(), ROOT, { receipts: [] })],
			["receipt not an object", present(active(), ROOT, { receipts: { "op-first": "stored" } })],
		];
		for (const [label, observed] of unknown) {
			expectFailure(label, evaluate(observed as ClaimReadResult), "unknown", [upstream]);
		}
		const scope: [string, ClaimReadResult, Partial<EvaluateClaimRightOptions>][] = [
			["other observed ticket", { kind: "present", ticket: "BACK-2", root: ROOT, document: documentOf(active()) }, {}],
			["other document ticket", present(active(), ROOT, { ticket: "BACK-2" }), {}],
			["other document format", present(active(), ROOT, { format: "tree" }), {}],
			["other document epoch", present(active(), ROOT, { epoch: 2 }), {}],
			["descriptor of another format", present(active()), { descriptor: { ...DESCRIPTOR, format: "tree" } }],
			["absent for another ticket", { kind: "absent", ticket: "BACK-2" }, {}],
		];
		for (const [label, observed, changes] of scope) expectFailure(label, evaluate(observed, changes), "invalid");
	});

	test("checks observation structure before ticket scope: a malformed wrong-ticket observation is unknown", () => {
		// Contrast: a well-formed observation of another ticket is a scope error, decided before the payload.
		const otherTicket: ClaimReadResult = {
			kind: "present",
			ticket: "BACK-2",
			root: ROOT,
			document: documentOf(active()),
		};
		expectFailure("well-formed, other ticket", evaluate(otherTicket), "invalid");
		expectFailure(
			"well-formed, other ticket, corrupt payload",
			evaluate({ ...otherTicket, document: documentOf({ state: "claimed" }) }),
			"invalid",
		);
		expectFailure("absent for another ticket", evaluate({ kind: "absent", ticket: "BACK-2" }), "invalid");
		const malformed: [string, unknown][] = [
			["other ticket, invalid root", { ...otherTicket, root: "xyz" }],
			["other ticket, uppercase root", { ...otherTicket, root: ROOT.toUpperCase() }],
			["other ticket, missing root", without(otherTicket, "root")],
			["other ticket, missing document", without(otherTicket, "document")],
			["other ticket, null document", { ...otherTicket, document: null }],
			["other ticket, document revision zero", { ...otherTicket, document: documentOf(active(), { revision: 0 }) }],
			["other ticket, document schema 2", { ...otherTicket, document: documentOf(active(), { schema: 2 }) }],
		];
		for (const [label, observed] of malformed) {
			expectFailure(label, evaluate(observed as ClaimReadResult), "unknown");
		}
	});

	test("validates caller inputs before looking at the observation", () => {
		const observed = present(active());
		expectEvaluation("positive control", evaluate(observed), evaluated("held", live(false), notYet(R)));
		const asDescriptor = (value: unknown) => value as ClaimStorageDescriptor;
		const cases: [string, Partial<EvaluateClaimRightOptions>][] = [
			["non-canonical ticket", { ticket: "back-1" }],
			["padded ticket", { ticket: " BACK-1" }],
			["not a ticket", { ticket: "not a ticket" }],
			["numeric ticket", { ticket: 42 as unknown as string }],
			["negative now", { now: -1 }],
			["fractional now", { now: T + 0.5 }],
			["NaN now", { now: Number.NaN }],
			["string now", { now: String(T) as unknown as number }],
			["unsafe now", { now: MAX + 1, clockSkewMs: 0 }],
			["negative epsilon", { clockSkewMs: -1 }],
			["fractional epsilon", { clockSkewMs: 0.5 }],
			["NaN epsilon", { clockSkewMs: Number.NaN }],
			["now plus epsilon overflow", { now: MAX, clockSkewMs: 1 }],
			["expected generation zero", { expectedClaimGeneration: 0 }],
			["negative expected generation", { expectedClaimGeneration: -1 }],
			["fractional expected generation", { expectedClaimGeneration: 2.5 }],
			["string expected generation", { expectedClaimGeneration: "3" as unknown as number }],
			["descriptor schema 2", { descriptor: asDescriptor({ ...DESCRIPTOR, schema: 2 }) }],
			["descriptor with unknown format", { descriptor: asDescriptor({ ...DESCRIPTOR, format: "zip" }) }],
			["descriptor epoch zero", { descriptor: { ...DESCRIPTOR, epoch: 0 } }],
			["fractional descriptor epoch", { descriptor: { ...DESCRIPTOR, epoch: 1.5 } }],
			["descriptor without epoch", { descriptor: asDescriptor(without(DESCRIPTOR, "epoch")) }],
			["null descriptor", { descriptor: asDescriptor(null) }],
		];
		for (const [label, changes] of cases) expectFailure(label, evaluate(observed, changes), "invalid");
		expectFailure("null options", evaluateClaimRight(null as unknown as EvaluateClaimRightOptions), "invalid");

		// Invalid inputs win over an unusable observation or payload.
		const unreachable: ClaimReadResult = { kind: "unreachable", reason: "down" };
		expectFailure("bad epsilon, unreachable read", evaluate(unreachable, { clockSkewMs: -1 }), "invalid");
		const corruptPayload = present({ state: "claimed" });
		expectFailure("bad ticket, corrupt payload", evaluate(corruptPayload, { ticket: "back-1" }), "invalid");

		// Near the epoch, now-eps may be negative; that is valid, and the largest safe now+eps is valid too.
		expectEvaluation(
			"now below epsilon",
			evaluate(present(active(lease(0, null, 0))), { now: 0, clockSkewMs: 5 }),
			evaluated("held", live(true), notYet(0)),
		);
		expectEvaluation(
			"largest safe now plus epsilon",
			evaluate(observed, { now: MAX - EPS }),
			evaluated("held", live(true), eligible(R)),
		);
	});

	test("rejects accessors by layer: options and descriptor invalid, observation unknown, payload corrupt", () => {
		const observed = present(active());
		const plain = evaluateClaimRight(optionsOf(observed));
		expectEvaluation("plain control", plain, evaluated("held", live(false), notYet(R)));
		expectFailure("options accessor", evaluateClaimRight(withAccessor(optionsOf(observed), "now", T)), "invalid");
		expectFailure(
			"options hidden field",
			evaluateClaimRight(withHidden(optionsOf(observed), "binding", KARL)),
			"invalid",
		);
		expectFailure(
			"descriptor accessor",
			evaluate(observed, { descriptor: withAccessor({ ...DESCRIPTOR }, "epoch", 1) }),
			"invalid",
		);
		expectFailure("observation accessor", evaluate(withAccessor(observed, "root", ROOT)), "unknown");
		const document = withAccessor(documentOf(active()), "revision", 2);
		expectFailure(
			"document accessor",
			evaluate({ kind: "present", ticket: TICKET, root: ROOT, document } as ClaimReadResult),
			"unknown",
		);
		expectFailure("payload accessor", evaluate(present(withAccessor(active(), "binding", KARL))), "corrupt");
		expectFailure("payload hidden field", evaluate(present(withHidden(active(), "hidden", 1))), "corrupt");
	});

	test("uses no hidden clock: explicit now alone decides", () => {
		const holder: { result?: ClaimRightEvaluation } = {};
		const wallClock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("hidden wall clock");
		});
		const monotonicClock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("hidden monotonic clock");
		});
		try {
			holder.result = evaluate(present(active()), { now: L + 2 * MINUTE });
		} finally {
			wallClock.mockRestore();
			monotonicClock.mockRestore();
		}
		expect(holder.result).toStrictEqual(evaluated("held", live(true), notYet(R)));
	});

	test("places every boundary exactly when epsilon is zero", () => {
		const exact = { clockSkewMs: 0 };
		const cases: [string, ClaimReadResult, number, Evaluated][] = [
			["one ms before H", present(active(hard())), H - 1, evaluated("held", live(null), notYet(H + GRACE))],
			["at H", present(active(hard())), H, evaluated("held", noRight("hard-expired"), notYet(H + GRACE))],
			["one ms before L", present(active()), L - 1, evaluated("held", live(false), notYet(R))],
			["at L", present(active()), L, evaluated("held", live(true), notYet(R))],
			["one ms before R", present(active()), R - 1, evaluated("held", live(true), notYet(R))],
			["at R", present(active()), R, evaluated("held", live(true), eligible(R))],
		];
		for (const [label, observed, now, expected] of cases) {
			expectEvaluation(label, evaluate(observed, { ...exact, now }), expected);
		}
	});

	test("returns exactly the scoped fields and fixed diagnostics", () => {
		const result = evaluate(present(active()));
		expect(Object.keys(result).sort(byCodeUnits)).toEqual([
			"claimGeneration",
			"kind",
			"observedRoot",
			"ownership",
			"reclaim",
			"scope",
			"workRight",
		]);
		expect(JSON.stringify(result).includes(KARL) || JSON.stringify(result).includes(OWNER)).toBe(false);
		const failures: [string, ClaimRightEvaluation, ClaimRightEvaluation["kind"]][] = [
			["invalid", evaluate(present(active()), { binding: OWNER }), "invalid"],
			["unknown", evaluate({ kind: "unreachable", reason: `${OWNER} ${KARL}` }), "unknown"],
			["corrupt", evaluate(present({ ...active(), owner: "" })), "corrupt"],
			["unsupported", evaluate(present({ ...active(), claimState: 2 })), "unsupported"],
		];
		for (const [label, failure, kind] of failures) expectFailure(label, failure, kind);
	});
});
