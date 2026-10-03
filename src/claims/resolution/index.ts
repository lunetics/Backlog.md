/** Internal evidence for one storage mutation, never logical completion or current rights. */
import { createHash } from "node:crypto";
import { type ClaimIntentRecord, isClaimIntentRecord } from "../journal/index.ts";
import { canonicalJson, isJsonObject, isObject, type JsonObject } from "../json.ts";
import { exactFields, type PendingClaimState, parseClaimState } from "../rights/index.ts";
import {
	type ClaimReadResult,
	type ClaimStorageDescriptor,
	isClaimDocumentContent,
	parseClaimStorageFormat,
} from "../storage/index.ts";
import { nonnegative } from "../validate.ts";

export type ClaimMutationReceipt = {
	schema: 1;
	intentDigest: string;
	parameterDigest: string;
};

export type ClaimMutationSource = {
	remote: string;
	descriptor: ClaimStorageDescriptor;
};

export type ClaimMutationResolution =
	| { kind: "stored"; observedRoot: string }
	| { kind: "not-stored"; observedRoot: string }
	| { kind: "open"; observedRoot: string | null }
	| { kind: "conflict"; reason: string }
	| { kind: "unknown"; reason: string }
	| { kind: "unknown-history"; reason: string }
	| { kind: "invalid"; reason: string };

type ResolveClaimMutationOptions = {
	record: ClaimIntentRecord;
	source: ClaimMutationSource;
	observed: ClaimReadResult;
};

/** The phase of a T call's transition: no P, P without witness, witness, A stored. */
type ClaimTransitionPhase = "none" | "pending" | "witnessed" | "confirmed";

/**
 * The clock-free composite outcome of a T call's P and A records: the logical kind, the
 * phase, the single resolution of P (`transition`) and of A (`confirmation`, null without a witness).
 */
export type ClaimTransitionResolution =
	| {
			kind: "applied" | "rejected" | "unknown" | "unknown-history";
			phase: ClaimTransitionPhase;
			transition: ClaimMutationResolution["kind"];
			confirmation: ClaimMutationResolution["kind"] | null;
	  }
	| { kind: "invalid"; reason: string };

function snapshotObject(value: unknown): JsonObject | undefined {
	try {
		// Reject non-JSON values before serialization can normalize them. Only use the resulting snapshot.
		if (!isJsonObject(value)) return undefined;
		const snapshot: unknown = JSON.parse(canonicalJson(value));
		return isJsonObject(snapshot) ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

function snapshotRecord(value: unknown): ClaimIntentRecord | undefined {
	const snapshot = snapshotObject(value);
	return isClaimIntentRecord(snapshot) ? snapshot : undefined;
}

function receiptOf(record: ClaimIntentRecord): ClaimMutationReceipt {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

export function createClaimMutationReceipt(
	record: ClaimIntentRecord,
): { kind: "receipt"; receipt: ClaimMutationReceipt } | { kind: "invalid"; reason: string } {
	const snapshot = snapshotRecord(record);
	return snapshot
		? { kind: "receipt", receipt: receiptOf(snapshot) }
		: { kind: "invalid", reason: "invalid claim intent record" };
}

export function resolveClaimMutation(options: ResolveClaimMutationOptions): ClaimMutationResolution {
	const record = snapshotRecord(options.record);
	if (!record) return { kind: "invalid", reason: "invalid claim intent record" };
	const { intent } = record;
	const source = snapshotObject(options.source);
	if (
		!source ||
		source.remote !== intent.remote ||
		!isObject(source.descriptor) ||
		source.descriptor.schema !== 1 ||
		source.descriptor.format !== intent.format ||
		source.descriptor.epoch !== intent.epoch
	) {
		return { kind: "invalid", reason: "claim mutation source does not match intent" };
	}

	const observed = snapshotObject(options.observed);
	if (!observed || (observed.kind !== "absent" && observed.kind !== "present")) {
		return { kind: "unknown", reason: "claim mutation observation is unavailable or malformed" };
	}
	if (typeof observed.ticket !== "string") {
		return { kind: "unknown", reason: "claim mutation observation is malformed" };
	}
	if (observed.kind === "absent") {
		if (observed.ticket !== intent.ticket) {
			return { kind: "invalid", reason: "claim mutation observation scope does not match intent" };
		}
		return intent.expectedRoot === null
			? { kind: "open", observedRoot: null }
			: { kind: "unknown-history", reason: "previously expected claim root is missing" };
	}

	const { root, document } = observed;
	if (
		typeof root !== "string" ||
		![40, 64].includes(root.length) ||
		/[^a-f0-9]/.test(root) ||
		!isObject(document) ||
		typeof document.ticket !== "string" ||
		parseClaimStorageFormat(document.format).kind === "invalid" ||
		typeof document.epoch !== "number" ||
		!Number.isSafeInteger(document.epoch) ||
		document.epoch <= 0 ||
		!isClaimDocumentContent(document)
	) {
		return { kind: "unknown", reason: "claim mutation observation is malformed" };
	}
	if (
		observed.ticket !== intent.ticket ||
		document.ticket !== intent.ticket ||
		document.format !== intent.format ||
		document.epoch !== intent.epoch
	) {
		return { kind: "invalid", reason: "claim mutation observation scope does not match intent" };
	}

	if (Object.hasOwn(document.receipts, intent.operationId)) {
		const own = document.receipts[intent.operationId];
		if (!own || root === intent.expectedRoot || canonicalJson(own) !== canonicalJson(receiptOf(record))) {
			return { kind: "conflict", reason: "claim mutation receipt contradicts intent" };
		}
		return { kind: "stored", observedRoot: root };
	}
	if (root === intent.expectedRoot) return { kind: "open", observedRoot: root };
	// This is a consistency check under cooperative writers and complete retention, not proof of either.
	return Object.keys(document.receipts).length === document.revision
		? { kind: "not-stored", observedRoot: root }
		: { kind: "unknown-history", reason: "claim mutation receipt history is incomplete" };
}

const CONFIRMATION_DOMAIN = "backlog.md/claim-confirm/v1\0";
const WITNESS_FIELDS = ["stage", "transition", "transitionDigest", "observedAt", "clockSkewMs", "observeBefore"];

/** The ID of a T call's A intent, derived from its P ID alone: "c-" and 40 hex of SHA-256. */
export function claimConfirmationId(operationId: string): string {
	const digest = createHash("sha256").update(CONFIRMATION_DOMAIN, "utf8").update(operationId, "utf8").digest("hex");
	return `c-${digest.slice(0, 40)}`;
}

/** The PENDING state a T call's P record plans; undefined for every other record, an A included. */
export function claimTransitionOf(record: ClaimIntentRecord): PendingClaimState | undefined {
	const decoded = parseClaimState(record.intent.resolved.next);
	if (decoded.kind !== "state") return undefined;
	const { state } = decoded;
	return "source" in state ? state : undefined;
}

/**
 * Whether `confirmation` is the persisted witness of the P record `transition`: the derived ID,
 * P's action, scope and ticket, the target's binding, `next` = P's target, and exactly the six witness parameters
 * naming P by ID and digest, observed before H_s under its skew (`observedAt + clockSkewMs < observeBefore = H_s`).
 * Digests are not checked here; `resolveClaimMutation` checks both records.
 */
export function isClaimConfirmation(transition: ClaimIntentRecord, confirmation: ClaimIntentRecord): boolean {
	try {
		const pending = claimTransitionOf(transition);
		if (pending === undefined) return false;
		const { timing } = pending.source;
		const observeBefore = timing.mode === "none" ? null : timing.hardEnd;
		if (observeBefore === null) return false;
		const p = transition.intent;
		const a = confirmation.intent;
		const witness = a.parameters;
		const next: JsonObject = JSON.parse(JSON.stringify({ next: pending.target }));
		return (
			a.operationId === claimConfirmationId(p.operationId) &&
			a.action === p.action &&
			a.remote === p.remote &&
			a.format === p.format &&
			a.epoch === p.epoch &&
			a.ticket === p.ticket &&
			a.targetBinding === pending.target.binding &&
			canonicalJson(a.resolved) === canonicalJson(next) &&
			exactFields(witness, WITNESS_FIELDS) &&
			witness.stage === "confirm" &&
			witness.transition === p.operationId &&
			witness.transitionDigest === transition.digest &&
			witness.observeBefore === observeBefore &&
			nonnegative(witness.observedAt) &&
			nonnegative(witness.clockSkewMs) &&
			witness.observedAt + witness.clockSkewMs < observeBefore
		);
	} catch {
		return false;
	}
}

/** Whether the observed payload is canonically the PENDING the P record planned (p is current). */
function transitionCurrent(observed: unknown, record: ClaimIntentRecord): boolean {
	const document = snapshotObject(observed)?.document;
	const next = record.intent.resolved.next;
	if (!isJsonObject(document) || document.payload === undefined || next === undefined) return false;
	return canonicalJson(document.payload) === canonicalJson(next);
}

type LogicalOutcome = Exclude<ClaimTransitionResolution, { kind: "invalid" }>;

/**
 * Pure and clock-free: the logical outcome of a T call from the single resolution of its P
 * record, the presence of its A record (the persisted witness), A's single resolution and whether p is current.
 * APPLIED rests only on the exact receipts: A stored, or a witness whose A can no longer land; a later own write or
 * an ACTIVE target payload without A's receipt proves nothing. A foreign or late A record is `invalid`.
 */
export function resolveClaimTransition(input: {
	record: ClaimIntentRecord;
	confirmation: ClaimIntentRecord | null;
	source: ClaimMutationSource;
	observed: ClaimReadResult;
}): ClaimTransitionResolution {
	const invalid = { kind: "invalid", reason: "claim transition records are invalid" } as const;
	try {
		const { record, confirmation, source, observed } = input;
		const transition = resolveClaimMutation({ record, source, observed });
		if (transition.kind === "invalid" || claimTransitionOf(record) === undefined) return invalid;
		let witness: ClaimMutationResolution | null = null;
		if (confirmation !== null) {
			witness = resolveClaimMutation({ record: confirmation, source, observed });
			if (witness.kind === "invalid" || !isClaimConfirmation(record, confirmation)) return invalid;
		}
		const answer = (kind: LogicalOutcome["kind"], phase: ClaimTransitionPhase): LogicalOutcome => ({
			kind,
			phase,
			transition: transition.kind,
			confirmation: witness === null ? null : witness.kind,
		});
		switch (transition.kind) {
			case "open":
			case "unknown":
				return answer("unknown", "none");
			case "not-stored":
				return answer("rejected", "none");
			case "conflict":
			case "unknown-history":
				return answer("unknown-history", "none");
		}
		if (witness === null) return answer(transitionCurrent(observed, record) ? "unknown" : "unknown-history", "pending");
		if (witness.kind === "stored") return answer("applied", "confirmed");
		// An A that may still land keeps the call unknown; one that can no longer land is historical.
		return answer(witness.kind === "open" || witness.kind === "unknown" ? "unknown" : "applied", "witnessed");
	} catch {
		return invalid;
	}
}
