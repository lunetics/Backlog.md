/** Internal observed-state projection, never a standalone execution authorization. */
import { claimContextIO, loadClaimContext } from "../context/index.ts";
import { isObject, type JsonValue } from "../json.ts";
import {
	type ClaimReadResult,
	type ClaimStorageDescriptor,
	type ClaimStorageOptions,
	isClaimDocumentContent,
	openClaimStore,
	parseClaimStorageFormat,
} from "../storage/index.ts";
import { nonnegative, positive, validTicket } from "../validate.ts";

export type ClaimTiming =
	| { mode: "lease"; leaseEnd: number; graceMs: number; hardEnd: number | null }
	| { mode: "hard"; hardEnd: number; graceMs: number }
	| { mode: "none" };

export type ActiveClaimState = {
	claimState: 1;
	status: "active";
	claimGeneration: number;
	bindingGeneration: number;
	owner: string;
	binding: string;
	timing: ClaimTiming;
};
export type FreeClaimState = { claimState: 1; status: "free"; claimGeneration: number };
/**
 * An unresolved transition between two complete ACTIVE states of the same mode, both with a
 * finite hard end and `target` ending later; the generation is the target's. Nobody holds a work right on it.
 */
export type PendingClaimState = {
	claimState: 1;
	status: "pending";
	claimGeneration: number;
	source: ActiveClaimState;
	target: ActiveClaimState;
};
export type ClaimStateV1 = ActiveClaimState | FreeClaimState | PendingClaimState;
export type ClaimStateResult =
	| { kind: "state"; state: ClaimStateV1 }
	| { kind: "corrupt" | "unsupported"; reason: string };

export type EvaluateClaimRightOptions = {
	ticket: string;
	descriptor: ClaimStorageDescriptor;
	observed: ClaimReadResult;
	binding: string;
	now: number;
	clockSkewMs: number;
	expectedClaimGeneration?: number;
};

export type ClaimRightEvaluation =
	| {
			kind: "evaluated";
			scope: "observed-state-only";
			observedRoot: string | null;
			claimGeneration: number | null;
			/** `pending` on every binding of an unresolved transition. */
			ownership: "held" | "foreign" | "free" | "absent" | "pending";
			workRight:
				| { kind: "live"; renewalDue: boolean | null }
				| {
						kind: "none";
						cause: "not-holder" | "free" | "absent" | "hard-expired" | "generation-changed" | "pending";
				  };
			reclaim: { kind: "eligible" | "not-yet"; boundary: number } | { kind: "never" | "not-applicable" };
	  }
	| { kind: "unknown" | "corrupt" | "unsupported" | "invalid" | "unavailable"; reason: string };

export type QueryClaimRightOptions = {
	storage: ClaimStorageOptions;
	ticket: string;
	contextDirectory: string;
	contextIO?: typeof claimContextIO;
	clockSkewMs: number;
	clock: () => number;
	expectedClaimGeneration?: number;
};

/** Read data descriptors, never accessors. This is not a sandbox against hostile Proxies. */
export function dataObject(value: unknown): Record<string, unknown> {
	if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
		throw new Error("plain data object required");
	}
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !property?.enumerable || !Object.hasOwn(property, "value")) {
			throw new Error("enumerable data property required");
		}
		copy[key] = property.value;
	}
	return copy;
}

function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || ancestors.has(value)) throw new Error("JSON data required");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("plain array required");
			const descriptors = Object.getOwnPropertyDescriptors(value as object);
			const length = descriptors.length?.value;
			if (!Number.isSafeInteger(length) || Reflect.ownKeys(descriptors).length !== length + 1) {
				throw new Error("dense JSON array required");
			}
			const copy: JsonValue[] = [];
			for (let index = 0; index < length; index++) {
				const property = descriptors[String(index)];
				if (!property?.enumerable || !Object.hasOwn(property, "value")) throw new Error("data element required");
				copy.push(copyJson(property.value, ancestors));
			}
			return copy;
		}
		return Object.fromEntries(
			Object.entries(dataObject(value)).map(([key, entry]) => [key, copyJson(entry, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}

export function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

function validBinding(value: unknown): value is string {
	return (
		typeof value === "string" && value.length === 68 && value.startsWith("tb1-") && !/[^a-f0-9]/.test(value.slice(4))
	);
}

function validTiming(value: unknown): value is ClaimTiming {
	if (!isObject(value)) return false;
	if (value.mode === "none") return exactFields(value, ["mode"]);
	if (!nonnegative(value.graceMs)) return false;
	const graceMs = value.graceMs;
	const validEnd = (end: unknown): end is number => nonnegative(end) && Number.isSafeInteger(end + graceMs);
	if (value.mode === "hard") return exactFields(value, ["mode", "hardEnd", "graceMs"]) && validEnd(value.hardEnd);
	return (
		value.mode === "lease" &&
		exactFields(value, ["mode", "leaseEnd", "graceMs", "hardEnd"]) &&
		validEnd(value.leaseEnd) &&
		(value.hardEnd === null || (validEnd(value.hardEnd) && value.leaseEnd <= value.hardEnd))
	);
}

/** The rights binding and state-timing rules for the transition planner; never a second parser. */
export { validBinding as isClaimBinding, validTiming as isClaimTiming };

const ACTIVE_FIELDS = ["claimState", "status", "claimGeneration", "bindingGeneration", "owner", "binding", "timing"];
const PENDING_FIELDS = ["claimState", "status", "claimGeneration", "source", "target"];

/** The rights rules of one complete ACTIVE state, also for both sides of a PENDING one. */
function validActive(value: unknown): value is ActiveClaimState {
	return (
		isObject(value) &&
		exactFields(value, ACTIVE_FIELDS) &&
		value.claimState === 1 &&
		value.status === "active" &&
		positive(value.claimGeneration) &&
		positive(value.bindingGeneration) &&
		typeof value.owner === "string" &&
		value.owner.length > 0 &&
		validBinding(value.binding) &&
		validTiming(value.timing)
	);
}

function hardEndOf(timing: ClaimTiming): number | null {
	return timing.mode === "none" ? null : timing.hardEnd;
}

/**
 * Two ACTIVE sides of one mode with finite hard ends, the target's later, and the target's generation.
 * Transfer form: generation plus one, binding generation 1, another binding. Bound form: equal except the timing.
 */
function validPending(state: Record<string, unknown>): boolean {
	const { source, target } = state;
	if (!exactFields(state, PENDING_FIELDS) || !validActive(source) || !validActive(target)) return false;
	const sourceEnd = hardEndOf(source.timing);
	const targetEnd = hardEndOf(target.timing);
	if (sourceEnd === null || targetEnd === null || targetEnd <= sourceEnd) return false;
	if (source.timing.mode !== target.timing.mode || state.claimGeneration !== target.claimGeneration) return false;
	const transfer =
		target.claimGeneration === source.claimGeneration + 1 &&
		target.bindingGeneration === 1 &&
		target.binding !== source.binding;
	const bound =
		target.claimGeneration === source.claimGeneration &&
		target.bindingGeneration === source.bindingGeneration &&
		target.owner === source.owner &&
		target.binding === source.binding;
	return transfer || bound;
}

export function parseClaimState(payload: unknown): ClaimStateResult {
	const corrupt = { kind: "corrupt", reason: "claim state is malformed" } as const;
	try {
		const state = copyJson(payload);
		if (!isObject(state) || !positive(state.claimState)) return corrupt;
		if (state.claimState !== 1) return { kind: "unsupported", reason: "claim state version is unsupported" };
		if (typeof state.status !== "string") return corrupt;
		if (state.status !== "active" && state.status !== "free" && state.status !== "pending") {
			return { kind: "unsupported", reason: "claim state status is unsupported" };
		}
		if (!positive(state.claimGeneration)) return corrupt;
		if (state.status === "free") {
			if (!exactFields(state, ["claimState", "status", "claimGeneration"])) return corrupt;
		} else if (state.status === "active" ? !validActive(state) : !validPending(state)) {
			// Invalid schema-1 data are corrupt, a PENDING breaking the rules of `validPending` included.
			return corrupt;
		}
		return { kind: "state", state: state as ClaimStateV1 };
	} catch {
		return corrupt;
	}
}

/** R of one ACTIVE timing: lease end or hard end plus grace; the timeless mode has none. */
function activeBoundary(timing: ClaimTiming): number | null {
	if (timing.mode === "none") return null;
	return (timing.mode === "lease" ? timing.leaseEnd : timing.hardEnd) + timing.graceMs;
}

/**
 * The reclaim boundary of a state, R for ACTIVE and the hull max(R(source), R(target)) for PENDING;
 * `null` for the timeless mode and a FREE tombstone. The one rule of rights, the planner and batch reclaim.
 */
export function claimReclaimBoundary(state: ClaimStateV1): number | null {
	if ("source" in state) {
		const source = activeBoundary(state.source.timing);
		const target = activeBoundary(state.target.timing);
		return source === null || target === null ? null : Math.max(source, target);
	}
	return "timing" in state ? activeBoundary(state.timing) : null;
}

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;

export function evaluateClaimRight(options: EvaluateClaimRightOptions): ClaimRightEvaluation {
	const invalid = { kind: "invalid", reason: "invalid claim right inputs or scope" } as const;
	const unknown = { kind: "unknown", reason: "claim observation cannot be evaluated" } as const;
	let input: Record<string, unknown>;
	let descriptor: Record<string, unknown>;
	try {
		input = dataObject(options);
		descriptor = dataObject(input.descriptor);
		if (
			!validTicket(input.ticket) ||
			!validBinding(input.binding) ||
			!nonnegative(input.now) ||
			!nonnegative(input.clockSkewMs) ||
			!Number.isSafeInteger(input.now + input.clockSkewMs) ||
			!Number.isSafeInteger(input.now - input.clockSkewMs) ||
			(input.expectedClaimGeneration !== undefined && !positive(input.expectedClaimGeneration)) ||
			!exactFields(descriptor, ["schema", "format", "epoch"]) ||
			descriptor.schema !== 1 ||
			parseClaimStorageFormat(descriptor.format).kind !== "valid" ||
			!positive(descriptor.epoch)
		)
			return invalid;
	} catch {
		return invalid;
	}
	// Layered copies keep malformed payloads distinct from malformed observations.
	let observed: Record<string, unknown>;
	let document: Record<string, unknown>;
	try {
		observed = dataObject(input.observed);
		if (observed.kind !== "absent" && observed.kind !== "present") return unknown;
		if (typeof observed.ticket !== "string") return unknown;
		if (observed.kind === "absent") {
			if (observed.ticket !== input.ticket) return invalid;
			return {
				kind: "evaluated",
				scope: "observed-state-only",
				observedRoot: null,
				claimGeneration: null,
				ownership: "absent",
				workRight: { kind: "none", cause: "absent" },
				reclaim: { kind: "not-applicable" },
			};
		}
		if (
			typeof observed.root !== "string" ||
			![40, 64].includes(observed.root.length) ||
			/[^a-f0-9]/.test(observed.root)
		) {
			return unknown;
		}
		document = dataObject(observed.document);
		// Content checking reuses the storage contract; the payload is decoded separately below.
		const { payload: _payload, ...envelope } = document;
		const metadata = copyJson(envelope);
		if (!isObject(metadata) || !isClaimDocumentContent({ ...metadata, payload: {} })) return unknown;
		if (
			observed.ticket !== input.ticket ||
			document.ticket !== input.ticket ||
			document.format !== descriptor.format ||
			document.epoch !== descriptor.epoch
		) {
			return invalid;
		}
	} catch {
		return unknown;
	}
	const decoded = parseClaimState(document.payload);
	if (decoded.kind !== "state") return decoded;
	const state = decoded.state;
	const base = {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: observed.root as string,
		claimGeneration: state.claimGeneration,
	} as const;
	const latest = (input.now as number) + (input.clockSkewMs as number);
	const earliest = (input.now as number) - (input.clockSkewMs as number);
	const boundary = claimReclaimBoundary(state);
	const reclaim: Evaluated["reclaim"] =
		boundary === null ? { kind: "never" } : { kind: earliest >= boundary ? "eligible" : "not-yet", boundary };
	if (state.status !== "active") {
		if (state.status === "free") {
			return {
				...base,
				ownership: "free",
				workRight: { kind: "none", cause: "free" },
				reclaim: { kind: "not-applicable" },
			};
		}
		// Nobody works on an unresolved transition, whatever the binding or the expectation; the hull
		// decides the reclaim.
		return { ...base, ownership: "pending", workRight: { kind: "none", cause: "pending" }, reclaim };
	}
	const { timing } = state;
	const ownership = state.binding === input.binding ? "held" : "foreign";
	const hardEnd = hardEndOf(timing);
	let workRight: Evaluated["workRight"];
	if (ownership === "foreign") workRight = { kind: "none", cause: "not-holder" };
	else if (input.expectedClaimGeneration !== undefined && input.expectedClaimGeneration !== state.claimGeneration) {
		workRight = { kind: "none", cause: "generation-changed" };
	} else if (hardEnd !== null && latest >= hardEnd) workRight = { kind: "none", cause: "hard-expired" };
	else workRight = { kind: "live", renewalDue: timing.mode === "lease" ? latest >= timing.leaseEnd : null };
	return { ...base, ownership, workRight, reclaim };
}

export async function queryClaimRight(options: QueryClaimRightOptions): Promise<ClaimRightEvaluation> {
	const invalid = { kind: "invalid", reason: "invalid claim right query options or clock" } as const;
	let captured: QueryClaimRightOptions;
	try {
		if (!isObject(options)) return invalid;
		const { storage, ticket, contextDirectory, contextIO, clockSkewMs, clock, expectedClaimGeneration } = options;
		if (!isObject(storage)) return invalid;
		const { repository, remote, format, timeoutMs } = storage;
		if (
			!validTicket(ticket) ||
			typeof contextDirectory !== "string" ||
			!nonnegative(clockSkewMs) ||
			typeof clock !== "function" ||
			(expectedClaimGeneration !== undefined && !positive(expectedClaimGeneration)) ||
			typeof repository !== "string" ||
			typeof remote !== "string" ||
			parseClaimStorageFormat(format).kind !== "valid" ||
			(timeoutMs !== undefined && !positive(timeoutMs))
		)
			return invalid;
		const sourceIO = contextIO === undefined ? claimContextIO : contextIO;
		const io = {
			open: sourceIO.open,
			lstat: sourceIO.lstat,
			mkdir: sourceIO.mkdir,
			link: sourceIO.link,
			unlink: sourceIO.unlink,
		};
		if (Object.values(io).some((entry) => typeof entry !== "function")) return invalid;
		captured = {
			storage: { repository, remote, format, timeoutMs },
			ticket,
			contextDirectory,
			contextIO: io,
			clockSkewMs,
			clock,
			expectedClaimGeneration,
		};
	} catch {
		return invalid;
	}
	let binding: string;
	try {
		const loaded = await loadClaimContext({ directory: captured.contextDirectory, io: captured.contextIO });
		if (loaded.kind !== "loaded") return { kind: loaded.kind, reason: "claim context cannot be loaded" };
		binding = loaded.context.binding;
	} catch {
		return { kind: "unavailable", reason: "claim context is unavailable" };
	}
	try {
		const opened = await openClaimStore(captured.storage);
		switch (opened.kind) {
			case "invalid":
				return invalid;
			case "schema-unsupported":
				return { kind: "unsupported", reason: "claim storage schema is unsupported" };
			case "descriptor-missing":
			case "format-mismatch":
			case "corrupt":
			case "unreachable":
				return { kind: "unknown", reason: "claim storage cannot be read" };
		}
		const observed = await opened.store.read(captured.ticket);
		if (observed.kind !== "present" && observed.kind !== "absent") {
			return { kind: "unknown", reason: "claim observation cannot be read" };
		}
		let now: number;
		try {
			now = captured.clock();
		} catch {
			return invalid;
		}
		return evaluateClaimRight({
			ticket: captured.ticket,
			descriptor: opened.descriptor,
			observed,
			binding,
			now,
			clockSkewMs: captured.clockSkewMs,
			expectedClaimGeneration: captured.expectedClaimGeneration,
		});
	} catch {
		return { kind: "unknown", reason: "claim storage is unavailable" };
	}
}
