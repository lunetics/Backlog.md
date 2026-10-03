/** Internal pure pause rule over own outstanding intents, never a work right or a proof of quiescence. */
import { canonicalTaskId, isValidTaskId } from "../../utils/task-id.ts";
import { type ClaimIntentEnumerationResult, type ClaimIntentRecord, isClaimIntentRecord } from "../journal/index.ts";
import { canonicalJson, isJsonObject, isObject } from "../json.ts";
import {
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	parseClaimStorageFormat,
} from "../storage/index.ts";

/**
 * The cross-ticket acquisition stop over every ticket, not one; an own open `acquire` intent
 * at its listed root stops `claim next` before any attempt. Open intents of other actions are returned as
 * `maintenanceOperationIds`, so an attempt paused only by them may continue.
 */
export type ClaimAcquireStop =
	| { kind: "clear"; maintenanceOperationIds: string[] }
	| { kind: "outstanding"; operationIds: string[] }
	| { kind: "unknown" | "invalid"; reason: string };

export type ClaimOperationPauseObservation = {
	remote: string;
	descriptor: ClaimStorageDescriptor;
	snapshot: ClaimSnapshot;
};

export type ClaimOperationPause =
	| { kind: "clear" }
	| { kind: "outstanding"; operationIds: string[] }
	| { kind: "unknown"; reason: string }
	| { kind: "invalid"; reason: string };

type ClaimOperationPauseOptions = {
	journal: ClaimIntentEnumerationResult;
	observation: ClaimOperationPauseObservation;
};

/** The five fields an own intent must share with the observation; `root` is `null` for an absent ticket. */
type Observed = { ticket: string; remote: string; format: ClaimStorageFormat; epoch: number; root: string | null };

const INVALID_OBSERVATION = "claim operation pause observation is invalid";
const UNREADABLE_JOURNAL = "own claim operations cannot be enumerated";
const INCOMPLETE_JOURNAL = "own claim operation journal holds unreadable entries";

/** The checked observation, read once; undefined for anything but a successful read of a canonical ticket. */
function observedOf(options: unknown): Observed | undefined {
	try {
		if (!isObject(options)) return undefined;
		const { observation } = options;
		if (!isObject(observation)) return undefined;
		const { remote, descriptor, snapshot } = observation;
		if (typeof remote !== "string" || remote.length === 0 || !isObject(descriptor) || !isObject(snapshot)) {
			return undefined;
		}
		const { schema, format, epoch } = descriptor;
		const parsed = parseClaimStorageFormat(format);
		if (schema !== 1 || parsed.kind !== "valid" || typeof epoch !== "number" || !Number.isSafeInteger(epoch)) {
			return undefined;
		}
		const { kind, ticket, root } = snapshot;
		if (epoch <= 0 || typeof ticket !== "string" || !isValidTaskId(ticket) || canonicalTaskId(ticket) !== ticket) {
			return undefined;
		}
		const observed = { ticket, remote, format: parsed.format, epoch };
		if (kind === "absent") return { ...observed, root: null };
		if (kind !== "present" || typeof root !== "string" || ![40, 64].includes(root.length) || /[^a-f0-9]/.test(root)) {
			return undefined;
		}
		return { ...observed, root };
	} catch {
		return undefined;
	}
}

/** Fresh data snapshots of every listed record, or the fixed reason why the journal view is not complete. */
function recordsOf(options: unknown): ClaimIntentRecord[] | string {
	try {
		if (!isObject(options)) return UNREADABLE_JOURNAL;
		const { journal } = options;
		if (!isObject(journal) || journal.kind !== "enumerated") return UNREADABLE_JOURNAL;
		const { corrupt, records } = journal;
		if (corrupt !== 0 || !Array.isArray(records)) return INCOMPLETE_JOURNAL;
		const snapshots: ClaimIntentRecord[] = [];
		for (const record of records) {
			const snapshot: unknown = isJsonObject(record) ? JSON.parse(canonicalJson(record)) : undefined;
			if (!isClaimIntentRecord(snapshot)) return INCOMPLETE_JOURNAL;
			snapshots.push(snapshot);
		}
		return snapshots;
	} catch {
		return INCOMPLETE_JOURNAL;
	}
}

function outstanding({ intent }: ClaimIntentRecord, observed: Observed): boolean {
	return (
		intent.ticket === observed.ticket &&
		intent.remote === observed.remote &&
		intent.format === observed.format &&
		intent.epoch === observed.epoch &&
		intent.expectedRoot === observed.root
	);
}

/**
 * Pure: no clock, no IO. A record is own by its journal alone and outstanding when ticket, byte-identical endpoint,
 * format, epoch and expected root equal the observation; an incomplete journal view is `unknown`, never a partial list.
 */
export function evaluateClaimOperationPause(options: ClaimOperationPauseOptions): ClaimOperationPause {
	const observed = observedOf(options);
	if (observed === undefined) return { kind: "invalid", reason: INVALID_OBSERVATION };
	const records = recordsOf(options);
	if (typeof records === "string") return { kind: "unknown", reason: records };
	const operationIds = records
		.filter((record) => outstanding(record, observed))
		.map((record) => record.intent.operationId);
	if (operationIds.length === 0) return { kind: "clear" };
	return { kind: "outstanding", operationIds: [...new Set(operationIds)].sort() };
}

const INVALID_ACQUIRE_STOP = "claim acquire stop observation is invalid";
const ROOT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type ClaimAcquireStopOptions = {
	journal: ClaimIntentEnumerationResult;
	remote: string;
	descriptor: ClaimStorageDescriptor;
	/** Ticket to root of one listing of `refs/claims/*`; a ticket without an entry has no ref (root `null`). */
	roots: Readonly<Record<string, string>>;
};

type AcquireScope = { remote: string; format: ClaimStorageFormat; epoch: number; roots: Map<string, string> };

/** The checked endpoint, descriptor and listed roots, read once; undefined when any of them is malformed. */
function acquireScopeOf(options: unknown): AcquireScope | undefined {
	try {
		if (!isObject(options)) return undefined;
		const { remote, descriptor, roots } = options;
		if (typeof remote !== "string" || remote.length === 0 || !isObject(descriptor) || !isObject(roots)) {
			return undefined;
		}
		const { schema, format, epoch } = descriptor;
		const parsed = parseClaimStorageFormat(format);
		if (schema !== 1 || parsed.kind !== "valid" || typeof epoch !== "number" || !Number.isSafeInteger(epoch)) {
			return undefined;
		}
		if (epoch <= 0) return undefined;
		const listed = new Map<string, string>();
		for (const [ticket, root] of Object.entries(roots)) {
			if (typeof root !== "string" || !ROOT_PATTERN.test(root)) return undefined;
			listed.set(ticket, root);
		}
		return { remote, format: parsed.format, epoch, roots: listed };
	} catch {
		return undefined;
	}
}

/**
 * The `outstanding` predicate of `evaluateClaimOperationPause`, applied to every own record at
 * once against the roots `listClaimRefs` lists (storage/index.ts), never to the candidate ticket alone. A record is
 * open when its endpoint (byte for byte), format and epoch match and its expected root equals the listed root of its
 * ticket (`null` for a missing ref). Pure: no clock, no IO. The same precedence as the pause: `invalid` before the
 * journal is looked at, then `unknown` for an incomplete journal view, which beats `outstanding`.
 */
export function evaluateClaimAcquireStop(options: ClaimAcquireStopOptions): ClaimAcquireStop {
	const scope = acquireScopeOf(options);
	if (scope === undefined) return { kind: "invalid", reason: INVALID_ACQUIRE_STOP };
	const records = recordsOf(options);
	if (typeof records === "string") return { kind: "unknown", reason: records };
	const acquires: string[] = [];
	const maintenance: string[] = [];
	for (const record of records) {
		const { ticket, operationId, action } = record.intent;
		const root = scope.roots.get(ticket) ?? null;
		const observed: Observed = { ticket, remote: scope.remote, format: scope.format, epoch: scope.epoch, root };
		if (!outstanding(record, observed)) continue;
		if (action === "acquire") acquires.push(operationId);
		else maintenance.push(operationId);
	}
	if (acquires.length > 0) return { kind: "outstanding", operationIds: [...new Set(acquires)].sort() };
	return { kind: "clear", maintenanceOperationIds: [...new Set(maintenance)].sort() };
}
