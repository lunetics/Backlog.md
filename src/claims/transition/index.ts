/** Internal pure transition planner, never an intent, a mutation or an execution admission. */
import {
	type ActiveClaimState,
	type ClaimStateV1,
	type ClaimTiming,
	claimReclaimBoundary,
	dataObject,
	evaluateClaimRight,
	exactFields,
	isClaimBinding,
	isClaimTiming,
	type PendingClaimState,
	parseClaimState,
} from "../rights/index.ts";
import type { ClaimReadResult, ClaimStorageDescriptor } from "../storage/index.ts";
import { nonnegative, positive } from "../validate.ts";

export type ClaimLeaseRequest = { ttlMs: number; ttlSource: "default" | "explicit" };
export type ClaimTimingRequest =
	| ({ mode: "lease"; graceMs: number; hardEnd: number | null } & ClaimLeaseRequest)
	| { mode: "hard"; hardEnd: number; graceMs: number }
	| { mode: "none" };
/**
 * The time-box action of a transfer under a hard deadline; `policy` marks a configured default.
 * `hardEnd` is the new absolute hard end of a restart, frozen into the plan; on
 * `preserve` it is invalid.
 */
export type ClaimTimeBoxRequest = { action: "preserve" | "restart"; source: "explicit" | "policy"; hardEnd?: number };
export type ClaimTransitionRequest =
	| { action: "acquire"; owner: string; timing: ClaimTimingRequest }
	| ({ action: "renew" } & ClaimLeaseRequest)
	| { action: "release" }
	| { action: "reclaim" }
	| { action: "transfer"; owner: string; timeBox: ClaimTimeBoxRequest | null; lease: ClaimLeaseRequest | null }
	| { action: "resume" }
	| { action: "change-bounds"; timing: ClaimTiming }
	/** The eighth transition action, an authorised release against an exact observed root. */
	| { action: "emergency-release"; expectedRoot: string };
export type ClaimTransitionAction = ClaimTransitionRequest["action"];
/** The one action list every consumer derives from; never a second literal list elsewhere. */
const ACTION_KEYS = {
	acquire: true,
	renew: true,
	release: true,
	reclaim: true,
	transfer: true,
	resume: true,
	"change-bounds": true,
	"emergency-release": true,
} satisfies Record<ClaimTransitionAction, true>;
export const CLAIM_TRANSITION_ACTIONS = Object.keys(ACTION_KEYS) as readonly ClaimTransitionAction[];

export type PlanClaimTransitionOptions = {
	ticket: string;
	descriptor: ClaimStorageDescriptor;
	observed: ClaimReadResult;
	binding: string;
	request: ClaimTransitionRequest;
	now: number;
	clockSkewMs: number;
	expectedClaimGeneration?: number;
	/** Transfer only; the receiver's binding, sourced by the executor from a loaded context. */
	targetBinding?: string;
	/** Resume only; the old proof, sourced by the executor from `context.recovery.binding`. */
	recoveryBinding?: string;
	/**
	 * Plans a finite later hard end (change-bounds, restart with `hardEnd`) as PENDING. Absent
	 * or false keeps every extending change at `requires-time-path`; the surface sets it to `settings.enabled`.
	 */
	timePath?: boolean;
};

export type ClaimTransitionRejection =
	| "held"
	| "not-free"
	| "not-holder"
	| "free"
	| "absent"
	| "generation-changed"
	| "not-renewable"
	| "never"
	| "hard-expired"
	| "overlong"
	| "not-yet"
	| "time-box-required"
	| "requires-time-path"
	| "lease-required"
	| "mode-change"
	/** Every action but reclaim on an unresolved PENDING transition, with the hull. */
	| "pending-transition"
	/** The observed root differs from the expected root. */
	| "stale-root";

type BoundedRejection = "hard-expired" | "overlong" | "not-yet" | "pending-transition";

export type ClaimTransitionPlan =
	| {
			kind: "planned";
			scope: "state-plan-only";
			action: ClaimTransitionAction;
			expectedRoot: string | null;
			observedClaimGeneration: number | null;
			request: ClaimTransitionRequest;
			next: ClaimStateV1;
	  }
	| { kind: "rejected"; cause: BoundedRejection; reason: string; boundary: number }
	| { kind: "rejected"; cause: Exclude<ClaimTransitionRejection, BoundedRejection>; reason: string }
	| { kind: "unknown" | "corrupt" | "unsupported" | "invalid"; reason: string };

const INVALID = { kind: "invalid", reason: "invalid claim transition inputs or request" } as const;
const RANGE = { kind: "invalid", reason: "planned claim values are out of range" } as const;
const UNKNOWN = { kind: "unknown", reason: "claim observation cannot be planned" } as const;

const REASONS: Record<ClaimTransitionRejection, string> = {
	held: "the observed claim is already held by this binding",
	"not-free": "the observed claim is held by another binding",
	"not-holder": "this binding does not hold the observed claim",
	free: "the observed ticket is free",
	absent: "the observed ticket is absent",
	"generation-changed": "the observed claim generation differs from the expectation",
	"not-renewable": "the observed claim mode has no renewable lease",
	never: "the observed claim mode never becomes reclaimable",
	"hard-expired": "the hard deadline leaves no remaining time",
	overlong: "the explicit lease would exceed the hard deadline",
	"not-yet": "the reclaim boundary has not been reached",
	"time-box-required": "the hard deadline requires an explicit time-box action",
	"requires-time-path":
		"the change needs the time path, which only takes a later hard end and only when it is switched on",
	"lease-required": "the observed lease requires a lease request",
	"mode-change": "the requested timing would change the claim mode",
	"pending-transition": "the observed claim has an unresolved transition until its reclaim boundary",
	"stale-root": "the observed root differs from the expected root",
};

function leaseFields(data: Record<string, unknown>): ClaimLeaseRequest {
	if (!positive(data.ttlMs) || (data.ttlSource !== "default" && data.ttlSource !== "explicit")) {
		throw new Error("invalid lease request");
	}
	return { ttlMs: data.ttlMs, ttlSource: data.ttlSource };
}

/** A transfer's lease: exactly `ttlMs` and `ttlSource` as data properties. */
function leaseRequest(value: unknown): ClaimLeaseRequest {
	const data = dataObject(value);
	if (!exactFields(data, ["ttlMs", "ttlSource"])) throw new Error("invalid lease request");
	return leaseFields(data);
}

/**
 * A transfer's time-box action: exactly `action` and `source` as data properties, a restart optionally with
 * an absolute `hardEnd`; `null` or any other value is invalid, never read as absent.
 */
function timeBoxRequest(value: unknown): ClaimTimeBoxRequest {
	const data = dataObject(value);
	if (
		(data.action !== "preserve" && data.action !== "restart") ||
		(data.source !== "explicit" && data.source !== "policy")
	) {
		throw new Error("invalid time-box request");
	}
	if (exactFields(data, ["action", "source"])) return { action: data.action, source: data.source };
	if (data.action !== "restart" || !exactFields(data, ["action", "source", "hardEnd"]) || !nonnegative(data.hardEnd)) {
		throw new Error("invalid time-box request");
	}
	return { action: data.action, source: data.source, hardEnd: data.hardEnd };
}

/** A fresh plain copy, so no planned timing aliases a request, a payload or another plan field. */
function timingCopy(timing: ClaimTiming): ClaimTiming {
	if (timing.mode === "none") return { mode: "none" };
	if (timing.mode === "hard") return { mode: "hard", hardEnd: timing.hardEnd, graceMs: timing.graceMs };
	return { mode: "lease", leaseEnd: timing.leaseEnd, graceMs: timing.graceMs, hardEnd: timing.hardEnd };
}

/** A bound change's absolute timing in the claim state form, checked by the rights validator on a data copy. */
function stateTiming(value: unknown): ClaimTiming {
	const data = dataObject(value);
	if (!isClaimTiming(data)) throw new Error("invalid state timing");
	return timingCopy(data);
}

function parseTiming(value: unknown): ClaimTimingRequest {
	const data = dataObject(value);
	if (data.mode === "none" && exactFields(data, ["mode"])) return { mode: "none" };
	if (data.mode === "hard" && exactFields(data, ["mode", "hardEnd", "graceMs"])) {
		if (!nonnegative(data.hardEnd) || !nonnegative(data.graceMs)) throw new Error("invalid hard timing");
		return { mode: "hard", hardEnd: data.hardEnd, graceMs: data.graceMs };
	}
	if (data.mode === "lease" && exactFields(data, ["mode", "ttlMs", "ttlSource", "graceMs", "hardEnd"])) {
		if (!nonnegative(data.graceMs) || (data.hardEnd !== null && !nonnegative(data.hardEnd))) {
			throw new Error("invalid lease timing");
		}
		return { mode: "lease", ...leaseFields(data), graceMs: data.graceMs, hardEnd: data.hardEnd };
	}
	throw new Error("invalid timing request");
}

/** Exact plain-data requests only; every accepted value is copied into a fresh object. */
function parseRequest(value: unknown): ClaimTransitionRequest {
	const data = dataObject(value);
	if (data.action === "release" && exactFields(data, ["action"])) return { action: "release" };
	if (data.action === "reclaim" && exactFields(data, ["action"])) return { action: "reclaim" };
	if (data.action === "renew" && exactFields(data, ["action", "ttlMs", "ttlSource"])) {
		return { action: "renew", ...leaseFields(data) };
	}
	if (data.action === "acquire" && exactFields(data, ["action", "owner", "timing"])) {
		if (typeof data.owner !== "string" || data.owner.length === 0) throw new Error("invalid owner");
		return { action: "acquire", owner: data.owner, timing: parseTiming(data.timing) };
	}
	// No request carries a binding; the target and the old proof are planner options of their own role.
	if (data.action === "resume" && exactFields(data, ["action"])) return { action: "resume" };
	if (data.action === "transfer" && exactFields(data, ["action", "owner", "timeBox", "lease"])) {
		if (typeof data.owner !== "string" || data.owner.length === 0) throw new Error("invalid owner");
		const timeBox = data.timeBox === null ? null : timeBoxRequest(data.timeBox);
		const lease = data.lease === null ? null : leaseRequest(data.lease);
		return { action: "transfer", owner: data.owner, timeBox, lease };
	}
	if (data.action === "change-bounds" && exactFields(data, ["action", "timing"])) {
		return { action: "change-bounds", timing: stateTiming(data.timing) };
	}
	// The eighth action's exact request; a fresh object, never the caller's.
	if (data.action === "emergency-release" && exactFields(data, ["action", "expectedRoot"])) {
		if (typeof data.expectedRoot !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data.expectedRoot)) {
			throw new Error("invalid expected root");
		}
		return { action: "emergency-release", expectedRoot: data.expectedRoot };
	}
	throw new Error("invalid transition request");
}

export { parseRequest as parseClaimTransitionRequest };

function rejected(cause: Exclude<ClaimTransitionRejection, BoundedRejection>): ClaimTransitionPlan;
function rejected(cause: BoundedRejection, boundary: number): ClaimTransitionPlan;
function rejected(cause: ClaimTransitionRejection, boundary?: number): ClaimTransitionPlan {
	if (cause === "hard-expired" || cause === "overlong" || cause === "not-yet" || cause === "pending-transition") {
		return { kind: "rejected", cause, reason: REASONS[cause], boundary: boundary as number };
	}
	return { kind: "rejected", cause, reason: REASONS[cause] };
}

type Clock = { now: number; latest: number };

/** Lease end for a new lease from `now`: time verdicts first, range verdicts last. */
function leaseEnd(
	clock: Clock,
	lease: ClaimLeaseRequest,
	hardEnd: number | null,
	graceMs: number,
): number | ClaimTransitionPlan {
	if (hardEnd !== null && clock.latest >= hardEnd) return rejected("hard-expired", hardEnd);
	const sum = clock.now + lease.ttlMs;
	if (hardEnd !== null && lease.ttlSource === "explicit" && sum > hardEnd) return rejected("overlong", hardEnd);
	if (!Number.isSafeInteger(sum)) return RANGE;
	const end = hardEnd === null ? sum : Math.min(sum, hardEnd);
	if (!Number.isSafeInteger(end + graceMs) || (hardEnd !== null && !Number.isSafeInteger(hardEnd + graceMs))) {
		return RANGE;
	}
	return end;
}

function acquiredTiming(clock: Clock, timing: ClaimTimingRequest): ClaimTiming | ClaimTransitionPlan {
	if (timing.mode === "none") return { mode: "none" };
	if (timing.mode === "hard") {
		if (clock.latest >= timing.hardEnd) return rejected("hard-expired", timing.hardEnd);
		if (!Number.isSafeInteger(timing.hardEnd + timing.graceMs)) return RANGE;
		return { mode: "hard", hardEnd: timing.hardEnd, graceMs: timing.graceMs };
	}
	const end = leaseEnd(clock, timing, timing.hardEnd, timing.graceMs);
	if (typeof end !== "number") return end;
	return { mode: "lease", leaseEnd: end, graceMs: timing.graceMs, hardEnd: timing.hardEnd };
}

/** The target only on transfer and the old proof only on resume, each mandatory there and never the caller. */
function validRoles(action: ClaimTransitionAction, input: Record<string, unknown>): boolean {
	const { binding, targetBinding, recoveryBinding } = input;
	if (action === "transfer") {
		return recoveryBinding === undefined && isClaimBinding(targetBinding) && targetBinding !== binding;
	}
	if (action === "resume") {
		return targetBinding === undefined && isClaimBinding(recoveryBinding) && recoveryBinding !== binding;
	}
	return targetBinding === undefined && recoveryBinding === undefined;
}

/** Hard and timeless timing stay (an explicit lease is never dropped silently); a lease gets a new window. */
function transferTiming(
	clock: Clock,
	timing: ClaimTiming,
	lease: ClaimLeaseRequest | null,
): ClaimTiming | ClaimTransitionPlan {
	if (timing.mode !== "lease") {
		if (lease !== null && lease.ttlSource === "explicit") return rejected("not-renewable");
		return timingCopy(timing);
	}
	if (lease === null) return rejected("lease-required");
	const end = leaseEnd(clock, lease, timing.hardEnd, timing.graceMs);
	if (typeof end !== "number") return end;
	return { mode: "lease", leaseEnd: end, graceMs: timing.graceMs, hardEnd: timing.hardEnd };
}

/**
 * A restarted time box under the new absolute hard end with the stored grace; hard stays hard, a lease
 * gets a fresh window capped at the new end (`overlong` for an explicit one), the timeless mode cannot take an end.
 * `deadline` is the time verdict: H_s for a T plan, the new end otherwise.
 */
function restartTiming(
	clock: Clock,
	timing: ClaimTiming,
	lease: ClaimLeaseRequest | null,
	hardEnd: number,
	deadline: number,
): ClaimTiming | ClaimTransitionPlan {
	if (timing.mode === "none") return rejected("mode-change");
	if (timing.mode === "hard") {
		if (lease !== null && lease.ttlSource === "explicit") return rejected("not-renewable");
		if (clock.latest >= deadline) return rejected("hard-expired", deadline);
		if (!Number.isSafeInteger(hardEnd + timing.graceMs)) return RANGE;
		return { mode: "hard", hardEnd, graceMs: timing.graceMs };
	}
	if (lease === null) return rejected("lease-required");
	if (clock.latest >= deadline) return rejected("hard-expired", deadline);
	const end = leaseEnd(clock, lease, hardEnd, timing.graceMs);
	if (typeof end !== "number") return end;
	return { mode: "lease", leaseEnd: end, graceMs: timing.graceMs, hardEnd };
}

/** The PENDING successor of a T plan with the target's generation; no side aliases the other. */
function pendingOf(source: ActiveClaimState, target: ActiveClaimState): PendingClaimState {
	const copy = { ...source, timing: timingCopy(source.timing) };
	return { claimState: 1, status: "pending", claimGeneration: target.claimGeneration, source: copy, target };
}

/**
 * The mode slot (time path, time box, lease, renewability), then time, then range. The successor carries the
 * target binding with the next claim generation and binding generation 1, in one step from ACTIVE to ACTIVE, or as
 * the target of a PENDING when a restart moves the hard end past H_s over the time path.
 */
function transferred(
	clock: Clock,
	active: ActiveClaimState,
	request: Extract<ClaimTransitionRequest, { action: "transfer" }>,
	target: string,
	timePath: boolean,
): ClaimStateV1 | ClaimTransitionPlan {
	const { timeBox } = request;
	const hardEnd = active.timing.mode === "none" ? null : active.timing.hardEnd;
	let timing: ClaimTiming | ClaimTransitionPlan;
	let pending = false;
	if (timeBox !== null && timeBox.action === "restart" && timeBox.hardEnd !== undefined) {
		// A later end than H_s goes over the time path, observed before H_s; any other is direct.
		const newEnd = timeBox.hardEnd;
		const deadline = hardEnd !== null && newEnd > hardEnd ? hardEnd : newEnd;
		pending = deadline < newEnd;
		if (pending && !timePath) return rejected("requires-time-path");
		timing = restartTiming(clock, active.timing, request.lease, newEnd, deadline);
	} else {
		// A restart without values needs the time path under a stored hard deadline, an explicit one also without;
		// the time path never takes it, so it stays `requires-time-path` in V1.
		if (timeBox !== null && timeBox.action === "restart" && (hardEnd !== null || timeBox.source === "explicit")) {
			return rejected("requires-time-path");
		}
		if (hardEnd !== null && timeBox === null) return rejected("time-box-required");
		timing = transferTiming(clock, active.timing, request.lease);
	}
	if ("kind" in timing) return timing;
	const claimGeneration = active.claimGeneration + 1;
	if (!Number.isSafeInteger(claimGeneration)) return RANGE;
	const successor: ActiveClaimState = {
		claimState: 1,
		status: "active",
		claimGeneration,
		bindingGeneration: 1,
		owner: request.owner,
		binding: target,
		timing,
	};
	return pending ? pendingOf(active, successor) : successor;
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

/** The work-right end W; a lease without a hard deadline and the timeless mode are unbounded. */
function workEnd(timing: ClaimTiming): number {
	if (timing.mode === "none") return UNBOUNDED;
	return timing.hardEnd === null ? UNBOUNDED : timing.hardEnd;
}

/** The reclaim boundary R; the timeless mode never becomes reclaimable. */
function reclaimEnd(timing: ClaimTiming): number {
	if (timing.mode === "none") return UNBOUNDED;
	return (timing.mode === "lease" ? timing.leaseEnd : timing.hardEnd) + timing.graceMs;
}

/** Extending iff W(t) > W(s), or W(s) is finite and R(t) > R(s); without a work limit R moves freely. */
function extending(stored: ClaimTiming, target: ClaimTiming): boolean {
	const limit = workEnd(stored);
	return workEnd(target) > limit || (limit < UNBOUNDED && reclaimEnd(target) > reclaimEnd(stored));
}

export function planClaimTransition(options: PlanClaimTransitionOptions): ClaimTransitionPlan {
	let input: Record<string, unknown>;
	let request: ClaimTransitionRequest;
	try {
		input = dataObject(options);
		request = parseRequest(input.request);
	} catch {
		return INVALID;
	}
	if (!validRoles(request.action, input)) return INVALID;
	if (input.timePath !== undefined && typeof input.timePath !== "boolean") return INVALID;
	const timePath = input.timePath === true;
	const evaluation = evaluateClaimRight(options);
	if (evaluation.kind !== "evaluated") {
		const { kind, reason } = evaluation;
		// The pure evaluator never reports unavailable; this branch is defensive and review-only.
		if (kind === "unavailable") return UNKNOWN;
		return { kind, reason };
	}
	let state: ClaimStateV1 | null = null;
	if (evaluation.ownership !== "absent") {
		// The evaluator already decoded this payload; the failure paths below are defensive and review-only.
		try {
			const document = dataObject(dataObject(input.observed).document);
			const decoded = parseClaimState(document.payload);
			if (decoded.kind !== "state") return decoded;
			state = decoded.state;
		} catch {
			return UNKNOWN;
		}
	}
	const clock: Clock = { now: input.now as number, latest: (input.now as number) + (input.clockSkewMs as number) };
	const expected = input.expectedClaimGeneration;
	const generationChanged = expected !== undefined && (state === null || expected !== state.claimGeneration);
	const active: ActiveClaimState | null = state !== null && state.status === "active" ? state : null;
	const planned = (next: ClaimStateV1): ClaimTransitionPlan => ({
		kind: "planned",
		scope: "state-plan-only",
		action: request.action,
		expectedRoot: evaluation.observedRoot,
		observedClaimGeneration: evaluation.claimGeneration,
		request,
		next,
	});
	// An emergency release plans only at the exact root the operator saw, before every state rule;
	// an absent ticket has no root, so it always ends here.
	const emergency = request.action === "emergency-release";
	if (request.action === "emergency-release" && evaluation.observedRoot !== request.expectedRoot) {
		return rejected("stale-root");
	}
	// An unresolved transition refuses every action but reclaim and the emergency release, for any
	// binding and before the generation check; both keep their own order below.
	if (state !== null && state.status === "pending" && request.action !== "reclaim" && !emergency) {
		const hull = claimReclaimBoundary(state);
		return hull === null ? UNKNOWN : rejected("pending-transition", hull);
	}
	if (request.action === "acquire") {
		if (active !== null) return rejected(evaluation.ownership === "held" ? "held" : "not-free");
		if (generationChanged) return rejected("generation-changed");
		const timing = acquiredTiming(clock, request.timing);
		if ("kind" in timing) return timing;
		const claimGeneration = state === null ? 1 : state.claimGeneration + 1;
		if (!Number.isSafeInteger(claimGeneration)) return RANGE;
		return planned({
			claimState: 1,
			status: "active",
			claimGeneration,
			bindingGeneration: 1,
			owner: request.owner,
			binding: input.binding as string,
			timing,
		});
	}
	if (state === null) return rejected("absent");
	if (state.status === "free") return rejected("free");
	// A reclaimed PENDING leaves its own generation, the target's.
	const tombstone: ClaimStateV1 = { claimState: 1, status: "free", claimGeneration: state.claimGeneration };
	// ACTIVE or PENDING at the expected root becomes the tombstone of the stored generation, for
	// any binding, mode and time; no generation check, and the generation grows only at the next acquire.
	if (emergency) return planned(tombstone);
	if (request.action === "reclaim") {
		if (generationChanged) return rejected("generation-changed");
		if (evaluation.reclaim.kind === "never") return rejected("never");
		if (evaluation.reclaim.kind === "not-yet") return rejected("not-yet", evaluation.reclaim.boundary);
		return planned(tombstone);
	}
	// A PENDING state returned above for every other action; this guard only narrows and is review-only.
	if (active === null) return UNKNOWN;
	if (request.action === "resume") {
		// The fresh binding already holding is `held`, only the holder's old proof resumes, then continuity.
		if (evaluation.ownership === "held") return rejected("held");
		if (active.binding !== input.recoveryBinding) return rejected("not-holder");
		if (generationChanged) return rejected("generation-changed");
		const bindingGeneration = active.bindingGeneration + 1;
		if (!Number.isSafeInteger(bindingGeneration)) return RANGE;
		return planned({
			...active,
			binding: input.binding as string,
			bindingGeneration,
			timing: timingCopy(active.timing),
		});
	}
	if (evaluation.ownership !== "held") return rejected("not-holder");
	if (generationChanged) return rejected("generation-changed");
	if (request.action === "release") return planned(tombstone);
	if (request.action === "transfer") {
		const next = transferred(clock, active, request, input.targetBinding as string, timePath);
		return "kind" in next ? next : planned(next);
	}
	if (request.action === "change-bounds") {
		// Same mode first, then the non-extending predicate; no clock verdict, and a no-op is a planned write.
		if (request.timing.mode !== active.timing.mode) return rejected("mode-change");
		const target: ActiveClaimState = { ...active, timing: timingCopy(request.timing) };
		if (!extending(active.timing, request.timing)) return planned(target);
		// Only a finite later hard end goes over the time path, observed while C + eps < H_s; a
		// removed hard end and a later R under an unchanged one stay `requires-time-path` in V1.
		const stored = workEnd(active.timing);
		const later = workEnd(request.timing);
		if (!timePath || later === UNBOUNDED || later <= stored) return rejected("requires-time-path");
		if (clock.latest >= stored) return rejected("hard-expired", stored);
		return planned(pendingOf(active, target));
	}
	// Every other action returned above; this single guard narrows the request to renew and is review-only.
	if (request.action !== "renew") return INVALID;
	if (active.timing.mode !== "lease") return rejected("not-renewable");
	const end = leaseEnd(clock, request, active.timing.hardEnd, active.timing.graceMs);
	if (typeof end !== "number") return end;
	return planned({
		...active,
		timing: { mode: "lease", leaseEnd: end, graceMs: active.timing.graceMs, hardEnd: active.timing.hardEnd },
	});
}
