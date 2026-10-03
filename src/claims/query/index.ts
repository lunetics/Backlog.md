/** Internal read-only query of one persisted storage mutation; never dispatch or current rights. */
import {
	type ClaimIntentJournal,
	type ClaimIntentRecord,
	type claimJournalIO,
	openClaimIntentJournal,
} from "../journal/index.ts";
import { isObject } from "../json.ts";
import {
	type ClaimMutationResolution,
	type ClaimMutationSource,
	type ClaimTransitionResolution,
	claimConfirmationId,
	resolveClaimMutation,
	resolveClaimTransition,
} from "../resolution/index.ts";
import { type ClaimReadResult, type ClaimStorageOptions, openClaimStore } from "../storage/index.ts";

export type ClaimMutationQueryOptions = {
	journalDirectory: string;
	operationId: string;
	storage: ClaimStorageOptions;
	journalIO?: typeof claimJournalIO;
};

export type ClaimMutationQueryResult =
	| { kind: "resolved"; resolution: ClaimMutationResolution }
	| { kind: "record-absent" }
	| { kind: "record-corrupt"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "unavailable"; reason: string }
	| { kind: "unknown"; reason: string }
	| { kind: "unknown-history"; reason: string }
	| { kind: "unsupported"; reason: string };

type Unresolved = Exclude<ClaimMutationQueryResult, { kind: "resolved" }>;

/** The composite answer for a T call's P ID, with the outer kinds of the single query. */
export type ClaimTransitionQueryResult = { kind: "resolved"; resolution: ClaimTransitionResolution } | Unresolved;

type Observed = {
	kind: "observed";
	record: ClaimIntentRecord;
	journal: ClaimIntentJournal;
	source: ClaimMutationSource;
	observed: ClaimReadResult;
};

/** The shared steps: options, the persisted record, the store of its own scope and one fresh read of its ticket. */
async function observe(options: ClaimMutationQueryOptions): Promise<Observed | Unresolved> {
	let captured: ClaimMutationQueryOptions;
	try {
		if (!isObject(options) || !isObject(options.storage)) {
			return { kind: "invalid", reason: "invalid claim mutation query options" };
		}
		const { journalDirectory, operationId, storage, journalIO } = options;
		const { repository, remote, format, timeoutMs } = storage;
		if (
			typeof journalDirectory !== "string" ||
			typeof operationId !== "string" ||
			typeof repository !== "string" ||
			typeof remote !== "string" ||
			typeof format !== "string" ||
			(timeoutMs !== undefined && typeof timeoutMs !== "number")
		) {
			return { kind: "invalid", reason: "invalid claim mutation query options" };
		}
		// Capture all caller-owned entries before the first await, including the narrow IO test seam.
		const io = journalIO === undefined ? undefined : { ...journalIO };
		if (io && [io.open, io.lstat, io.link, io.unlink].some((entry) => typeof entry !== "function")) {
			return { kind: "invalid", reason: "invalid claim mutation query options" };
		}
		captured = {
			journalDirectory,
			operationId,
			storage: { repository, remote, format, timeoutMs },
			journalIO: io,
		};
	} catch {
		return { kind: "invalid", reason: "invalid claim mutation query options" };
	}

	let journal: ClaimIntentJournal;
	let record: ClaimIntentRecord;
	try {
		const opened = await openClaimIntentJournal({ directory: captured.journalDirectory, io: captured.journalIO });
		if (opened.kind !== "open") {
			return { kind: opened.kind, reason: "claim mutation journal cannot be opened" };
		}
		const loaded = await opened.journal.load(captured.operationId);
		if (loaded.kind === "absent") return { kind: "record-absent" };
		if (loaded.kind === "corrupt") return { kind: "record-corrupt", reason: "claim mutation record is corrupt" };
		if (loaded.kind !== "loaded") {
			return { kind: loaded.kind, reason: "claim mutation journal cannot be read" };
		}
		journal = opened.journal;
		record = loaded.record;
	} catch {
		return { kind: "unavailable", reason: "claim mutation journal is unavailable" };
	}

	const { storage } = captured;
	const { intent } = record;
	if (storage.remote !== intent.remote || storage.format !== intent.format) {
		return { kind: "invalid", reason: "claim mutation source does not match original intent" };
	}
	try {
		const opened = await openClaimStore(storage);
		switch (opened.kind) {
			case "invalid":
				return { kind: "invalid", reason: "claim mutation storage options are invalid" };
			case "descriptor-missing":
			case "format-mismatch":
				return { kind: "unknown-history", reason: "claim mutation storage scope is unavailable" };
			case "schema-unsupported":
				return { kind: "unsupported", reason: "claim mutation storage schema is unsupported" };
			case "corrupt":
			case "unreachable":
				return { kind: "unknown", reason: "claim mutation storage cannot be read" };
		}
		const { descriptor, store } = opened;
		if (descriptor.schema !== 1 || descriptor.format !== intent.format || descriptor.epoch !== intent.epoch) {
			return { kind: "unknown-history", reason: "claim mutation storage scope has changed" };
		}
		const observed = await store.read(intent.ticket);
		return { kind: "observed", record, journal, source: { remote: storage.remote, descriptor }, observed };
	} catch {
		return { kind: "unknown", reason: "claim mutation storage is unavailable" };
	}
}

export async function queryClaimMutation(options: ClaimMutationQueryOptions): Promise<ClaimMutationQueryResult> {
	const found = await observe(options);
	if (found.kind !== "observed") return found;
	const { record, source, observed } = found;
	return { kind: "resolved", resolution: resolveClaimMutation({ record, source, observed }) };
}

/**
 * The composite query of a T call's P ID, over the options of `queryClaimMutation`. The A
 * record under the derived ID is loaded after the read, so an A that landed in the read is always seen; a missing A
 * record means no witness was persisted in this journal.
 */
export async function queryClaimTransition(options: ClaimMutationQueryOptions): Promise<ClaimTransitionQueryResult> {
	const found = await observe(options);
	if (found.kind !== "observed") return found;
	const { record, journal, source, observed } = found;
	let confirmation: ClaimIntentRecord | null = null;
	try {
		const loaded = await journal.load(claimConfirmationId(record.intent.operationId));
		if (loaded.kind === "corrupt") return { kind: "record-corrupt", reason: "claim mutation record is corrupt" };
		if (loaded.kind === "loaded") confirmation = loaded.record;
		else if (loaded.kind !== "absent") return { kind: loaded.kind, reason: "claim mutation journal cannot be read" };
	} catch {
		return { kind: "unavailable", reason: "claim mutation journal is unavailable" };
	}
	return { kind: "resolved", resolution: resolveClaimTransition({ record, confirmation, source, observed }) };
}
