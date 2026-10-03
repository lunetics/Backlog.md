/** Internal single-transition executor, never execution admission or a proof of own quiescence. */
import { claimContextIO, loadClaimContext } from "../context/index.ts";
import {
	type ClaimIntentAdmitResult,
	type ClaimIntentEnumerationResult,
	type ClaimIntentJournal,
	type ClaimIntentPrepareResult,
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	type claimJournalIO,
	openClaimIntentJournal,
} from "../journal/index.ts";
import { canonicalJson, isJsonObject, isObject, type JsonObject } from "../json.ts";
import { type ClaimOperationPause, evaluateClaimOperationPause } from "../pause/index.ts";
import { type ClaimMutationQueryResult, queryClaimMutation } from "../query/index.ts";
import {
	type ClaimMutationResolution,
	type ClaimMutationSource,
	claimConfirmationId,
	createClaimMutationReceipt,
	isClaimConfirmation,
	resolveClaimMutation,
} from "../resolution/index.ts";
import {
	type ClaimRightEvaluation,
	type ClaimStateV1,
	type ClaimTiming,
	claimReclaimBoundary,
	evaluateClaimRight,
	type PendingClaimState,
	parseClaimState,
	queryClaimRight,
} from "../rights/index.ts";
import {
	type ClaimChange,
	type ClaimReadResult,
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageOptions,
	type ClaimStore,
	type ClaimWriteResult,
	openClaimStore,
	parseClaimStorageFormat,
} from "../storage/index.ts";
import {
	CLAIM_TRANSITION_ACTIONS,
	type ClaimTransitionAction,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	parseClaimTransitionRequest,
	planClaimTransition,
} from "../transition/index.ts";
import { nonnegative, positive, validTicket } from "../validate.ts";

export type ExecuteClaimTransitionOptions = {
	storage: ClaimStorageOptions;
	ticket: string;
	contextDirectory: string;
	/** Transfer only; absolute path of the receiver's context, read for its binding only. */
	targetContextDirectory?: string;
	contextIO?: typeof claimContextIO;
	journalIO?: typeof claimJournalIO;
	operationId: string;
	request: ClaimTransitionRequest;
	clockSkewMs: number;
	clock: () => number;
	expectedClaimGeneration?: number;
	attempts: number;
	/** Additive: the executor ignores both when absent; its result schema is unchanged. */
	schedule?: ClaimSendSchedule;
	/** Called once after `planned`, before `prepare`; a thrown callback is swallowed and the protocol continues. */
	onPlanned?: (planned: ClaimPlannedView) => void;
	/**
	 * The planner's time-path option, default off. The surface sets it to
	 * `settings.enabled`; a PENDING plan runs P, the witness and A in this one call.
	 */
	timePath?: boolean;
};

/** The executor-local retry pause and per-command timeout seam, injected by the surface core. */
export type ClaimSendSchedule = {
	beforeSend(send: number): Promise<"send" | "stop">;
	commandTimeoutMs(): number;
};

/** The capped-lease display passed to `onPlanned`; never a binding, owner or reason. */
export type ClaimPlannedView = {
	at: number | null;
	claimGeneration: number;
	status: "active" | "free";
	timing: ClaimTiming | null;
};

export type ClaimExecutionNotSent =
	| "journal-invalid"
	| "journal-corrupt"
	| "journal-unavailable"
	| "journal-conflict"
	| "journal-loaded"
	| "write-invalid"
	| "write-not-sent"
	| "admission-held"
	| "admission-invalid"
	| "admission-corrupt"
	| "admission-unavailable";

export type ClaimExecutionStorage =
	| { kind: "applied"; root: string }
	| { kind: "rejected"; cause: "stale" | "remote" }
	| {
			kind: "queried";
			/** Additive: "earlier-process" names a clarification before a resend can send. */
			after: "unknown" | "stale" | "remote" | "earlier-process";
			query: ClaimMutationQueryResult;
	  }
	| { kind: "not-sent"; cause: ClaimExecutionNotSent };

type ClaimExecutionOutcome = { kind: "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent" };

export type ClaimExecutionResult =
	| { kind: "invalid" | "corrupt" | "unavailable" | "unknown" | "unsupported"; reason: string }
	| { kind: "not-planned"; plan: Exclude<ClaimTransitionPlan, { kind: "planned" }>; rights: ClaimRightEvaluation }
	| {
			kind: "paused";
			pause: Extract<ClaimOperationPause, { kind: "outstanding" | "unknown" }>;
			rights: ClaimRightEvaluation;
	  }
	| {
			kind: "operation";
			scope: "transition-execution-only";
			action: ClaimTransitionAction;
			operationId: string;
			storage: ClaimExecutionStorage;
			outcome: ClaimExecutionOutcome;
			rights: ClaimRightEvaluation;
			sends: number;
			/**
			 * Only on a T call. `operationId` and `storage` are P's, `sends` counts P and
			 * A, and `outcome` is the logical one. `confirmOperationId` and `confirmation` (A's storage
			 * fact, null while A is unsent) exist once a witness does; `observeBefore` is H_s, `reclaimBoundary` the hull.
			 */
			transition?: ClaimExecutionTransition;
	  };

type ClaimExecutionTransition = {
	phase: "none" | "pending" | "witnessed" | "confirmed";
	confirmOperationId: string | null;
	observeBefore: number;
	reclaimBoundary: number;
	confirmation: ClaimExecutionStorage | null;
};

type ClaimOperationIntentOptions = {
	operationId: string;
	remote: string;
	descriptor: ClaimStorageDescriptor;
	ticket: string;
	plan: Extract<ClaimTransitionPlan, { kind: "planned" }>;
};

type ClaimOperationIntentResult =
	| { kind: "intent"; intent: ClaimOperationIntent }
	| { kind: "invalid"; reason: string };

type Failure = Extract<ClaimExecutionResult, { reason: string }>;
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type Outcome = ClaimExecutionOutcome["kind"];
type Queried = Extract<ClaimExecutionStorage, { kind: "queried" }>;
type PlannedCallback = (planned: ClaimPlannedView) => void;
/** The sends of one call, over P and A of a T call (one budget, `attempts` per intent). */
type Counter = { sends: number };
/** One intent's storage fact and outcome; `landed` is a snapshot this call read or wrote after it was stored. */
type Sent = { fact: ClaimExecutionStorage; outcome: Outcome; landed: ClaimSnapshot | null };
/** A PENDING plan's facts: the state, H_s (the witness deadline) and the hull. */
type TimePath = { pending: PendingClaimState; observeBefore: number; reclaimBoundary: number };
/** A T call after P: its `transition` fact and the logical outcome. */
type Confirmation = { transition: ClaimExecutionTransition; outcome: Outcome };
/** The entries an execution and a resend share, copied before the first await. */
type CapturedBase = {
	storage: ClaimStorageOptions;
	contextDirectory: string;
	contextIO: typeof claimContextIO;
	journalIO: typeof claimJournalIO | undefined;
	operationId: string;
	clockSkewMs: number;
	clock: () => number;
	attempts: number;
	schedule: ClaimSendSchedule | undefined;
	onPlanned: PlannedCallback | undefined;
};
type Captured = CapturedBase & {
	ticket: string;
	request: ClaimTransitionRequest;
	expectedClaimGeneration: number | undefined;
	targetContextDirectory: string | undefined;
	timePath: boolean | undefined;
};

const JOURNAL_CAUSES: Record<Exclude<ClaimIntentPrepareResult["kind"], "prepared">, ClaimExecutionNotSent> = {
	invalid: "journal-invalid",
	corrupt: "journal-corrupt",
	unavailable: "journal-unavailable",
	conflict: "journal-conflict",
	loaded: "journal-loaded",
};

const ADMISSION_CAUSES: Record<Exclude<ClaimIntentAdmitResult["kind"], "admitted">, ClaimExecutionNotSent> = {
	held: "admission-held",
	invalid: "admission-invalid",
	corrupt: "admission-corrupt",
	unavailable: "admission-unavailable",
};

/** A contradicting receipt does not settle with time, so it counts as lost history. */
const RESOLVED_OUTCOMES: Record<ClaimMutationResolution["kind"], Outcome> = {
	stored: "applied",
	"not-stored": "rejected",
	open: "unknown",
	conflict: "unknown-history",
	"unknown-history": "unknown-history",
	unknown: "unknown",
	invalid: "unknown",
};

function failure(kind: Failure["kind"], reason: string): Failure {
	return { kind, reason };
}

/**
 * The answer to a resend whose intent belongs to another epoch than the store: nothing
 * sent, `unknown-history` like the query's changed storage scope, and no rights, since the ticket was not read.
 */
function epochCut(action: ClaimTransitionAction, operationId: string): Operation {
	return {
		kind: "operation",
		scope: "transition-execution-only",
		action,
		operationId,
		storage: {
			kind: "queried",
			after: "earlier-process",
			query: { kind: "unknown-history", reason: "claim mutation storage scope has changed" },
		},
		outcome: { kind: "unknown-history" },
		rights: { kind: "unknown", reason: "claim observation was not read" },
		sends: 0,
	};
}

/** The journal's operation ID rule (journal/index.ts), checked before any IO so no network or file is touched. */
function validOperationId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** A fresh JSON copy, so no intent field aliases the plan. */
function jsonCopy(value: unknown): JsonObject {
	if (!isJsonObject(value)) throw new Error("JSON object required");
	return JSON.parse(canonicalJson(value)) as JsonObject;
}

/** A schedule's two methods bound to it, so a later change of the caller's object cannot redirect them. */
function captureSchedule(schedule: ClaimSendSchedule): ClaimSendSchedule | undefined {
	if (!isObject(schedule)) return undefined;
	const { beforeSend, commandTimeoutMs } = schedule;
	if (typeof beforeSend !== "function" || typeof commandTimeoutMs !== "function") return undefined;
	return {
		beforeSend: (send) => beforeSend.call(schedule, send),
		commandTimeoutMs: () => commandTimeoutMs.call(schedule),
	};
}

/** Copies the entries an execution and a resend share, synchronously and before any await. */
function captureBase(options: ResendClaimIntentOptions): CapturedBase | undefined {
	if (!isObject(options) || !isObject(options.storage)) return undefined;
	const { storage, contextDirectory, contextIO, journalIO, operationId, clockSkewMs, clock, attempts } = options;
	const { schedule, onPlanned } = options;
	const { repository, remote, format, timeoutMs } = storage;
	const parsedFormat = parseClaimStorageFormat(format);
	if (
		typeof repository !== "string" ||
		typeof remote !== "string" ||
		parsedFormat.kind !== "valid" ||
		(timeoutMs !== undefined && !positive(timeoutMs)) ||
		typeof contextDirectory !== "string" ||
		!validOperationId(operationId) ||
		!nonnegative(clockSkewMs) ||
		typeof clock !== "function" ||
		!positive(attempts) ||
		(onPlanned !== undefined && typeof onPlanned !== "function")
	) {
		return undefined;
	}
	const bound = schedule === undefined ? undefined : captureSchedule(schedule);
	if (schedule !== undefined && bound === undefined) return undefined;
	const sourceIO = contextIO === undefined ? claimContextIO : contextIO;
	const context = {
		open: sourceIO.open,
		lstat: sourceIO.lstat,
		mkdir: sourceIO.mkdir,
		link: sourceIO.link,
		unlink: sourceIO.unlink,
	};
	let journal: typeof claimJournalIO | undefined;
	if (journalIO !== undefined) {
		journal = {
			open: journalIO.open,
			lstat: journalIO.lstat,
			link: journalIO.link,
			unlink: journalIO.unlink,
			readdir: journalIO.readdir,
		};
		if (Object.values(journal).some((entry) => typeof entry !== "function")) return undefined;
	}
	if (Object.values(context).some((entry) => typeof entry !== "function")) return undefined;
	return {
		storage: { repository, remote, format: parsedFormat.format, timeoutMs },
		contextDirectory,
		contextIO: context,
		journalIO: journal,
		operationId,
		clockSkewMs,
		clock,
		attempts,
		schedule: bound,
		onPlanned,
	};
}

/** Copies every caller-owned entry synchronously; nothing read after the first await can redirect the call. */
function capture(options: ExecuteClaimTransitionOptions): Captured | undefined {
	try {
		const base = captureBase(options);
		if (base === undefined) return undefined;
		const { ticket, request, expectedClaimGeneration, targetContextDirectory, timePath } = options;
		if (!validTicket(ticket) || (expectedClaimGeneration !== undefined && !positive(expectedClaimGeneration))) {
			return undefined;
		}
		if (timePath !== undefined && typeof timePath !== "boolean") return undefined;
		const parsed = parseClaimTransitionRequest(request);
		// A target context exactly for a transfer; its path is checked by the context loader in step 1b.
		const transfer = parsed.action === "transfer";
		if (transfer !== (targetContextDirectory !== undefined)) return undefined;
		if (transfer && typeof targetContextDirectory !== "string") return undefined;
		return { ...base, ticket, request: parsed, expectedClaimGeneration, targetContextDirectory, timePath };
	} catch {
		return undefined;
	}
}

/** The per-command timeout of the schedule when one is given and sound, else the caller's storage timeout. */
function scheduled(storage: ClaimStorageOptions, schedule: ClaimSendSchedule | undefined): ClaimStorageOptions {
	if (schedule === undefined) return storage;
	let timeoutMs: number;
	try {
		timeoutMs = schedule.commandTimeoutMs();
	} catch {
		return storage;
	}
	return positive(timeoutMs) ? { ...storage, timeoutMs } : storage;
}

/** The gate before a repeated send; a throwing gate stops, it never sends by default. */
async function mayResend(schedule: ClaimSendSchedule, send: number): Promise<boolean> {
	try {
		return (await schedule.beforeSend(send)) === "send";
	} catch {
		return false;
	}
}

function timingOf(timing: ClaimTiming): ClaimTiming {
	if (timing.mode === "none") return { mode: "none" };
	if (timing.mode === "hard") return { mode: "hard", hardEnd: timing.hardEnd, graceMs: timing.graceMs };
	return { mode: "lease", leaseEnd: timing.leaseEnd, graceMs: timing.graceMs, hardEnd: timing.hardEnd };
}

/** Called once before anything is persisted; a thrown or rejected callback never changes the protocol. */
function notifyPlanned(onPlanned: PlannedCallback | undefined, at: number | null, next: ClaimStateV1): void {
	if (onPlanned === undefined) return;
	// A T call shows the target it moves to, never the PENDING state in between.
	const shown = "target" in next ? next.target : next;
	const view: ClaimPlannedView = {
		at,
		claimGeneration: shown.claimGeneration,
		status: shown.status,
		timing: shown.status === "active" ? timingOf(shown.timing) : null,
	};
	try {
		const returned: unknown = onPlanned(view);
		if (returned instanceof Promise) returned.catch(() => undefined);
	} catch {
		// Swallowed by contract: the display seam never decides the protocol.
	}
}

/**
 * Pure: a planned transition becomes the journal intent; targetBinding is the ACTIVE successor's binding, the
 * target's binding of a PENDING one and null for a FREE one.
 */
export function claimOperationIntentOf(options: ClaimOperationIntentOptions): ClaimOperationIntentResult {
	try {
		const { operationId, remote, descriptor, ticket, plan } = options;
		if (plan.kind !== "planned") return { kind: "invalid", reason: "only a planned transition maps to an intent" };
		const { next } = plan;
		const bound = "target" in next ? next.target : next;
		return {
			kind: "intent",
			intent: {
				operationId,
				remote,
				format: descriptor.format,
				epoch: descriptor.epoch,
				ticket,
				expectedRoot: plan.expectedRoot,
				targetBinding: bound.status === "active" ? bound.binding : null,
				action: plan.action,
				parameters: jsonCopy(plan.request),
				resolved: { next: jsonCopy(next) },
			},
		};
	} catch {
		return { kind: "invalid", reason: "invalid claim operation intent inputs" };
	}
}

/** A thrown write may have left the client, so it is as uncertain as a lost reply. */
async function send(store: ClaimStore, base: ClaimSnapshot, change: ClaimChange): Promise<ClaimWriteResult> {
	try {
		return await store.write(base, change);
	} catch {
		return { kind: "unknown", reason: "claim write failed" };
	}
}

function outcomeOf(query: ClaimMutationQueryResult): Outcome {
	if (query.kind === "resolved") return RESOLVED_OUTCOMES[query.resolution.kind];
	return query.kind === "unknown-history" ? "unknown-history" : "unknown";
}

function notSent(cause: ClaimExecutionNotSent): Sent {
	return { fact: { kind: "not-sent", cause }, outcome: "not-sent", landed: null };
}

function settled(fact: Queried): Sent {
	return { fact, outcome: outcomeOf(fact.query), landed: null };
}

/** A thrown read is as unusable as an unreachable one. */
async function readTicket(store: ClaimStore, ticket: string): Promise<ClaimReadResult> {
	try {
		return await store.read(ticket);
	} catch {
		return { kind: "unreachable", reason: "claim storage is unavailable" };
	}
}

type SendIntentOptions = {
	journal: ClaimIntentJournal;
	journalDirectory: string;
	journalIO: typeof claimJournalIO | undefined;
	store: ClaimStore;
	storage: ClaimStorageOptions;
	schedule: ClaimSendSchedule | undefined;
	attempts: number;
	counter: Counter;
};

/**
 * Steps 9 to 11 for one recorded intent: the change frozen from the record, its admission, then the sends on `base`.
 * Only the first send of an intent prepared in this call (`fresh`) can be rejected finally; `attempts` holds per
 * intent, every send counts in the call's counter, and only a repetition passes the schedule's gate.
 */
async function sendIntent(
	options: SendIntentOptions,
	record: ClaimIntentRecord,
	base: ClaimSnapshot,
	fresh: boolean,
): Promise<Sent> {
	const { journal, store, schedule, counter } = options;
	const { intent } = record;
	// The change is frozen once from the record; every send repeats it byte-identically on the same base.
	const receipt = createClaimMutationReceipt(record);
	const payload = intent.resolved.next;
	if (receipt.kind !== "receipt" || !isJsonObject(payload)) return notSent("journal-invalid");
	const change: ClaimChange = { operationId: intent.operationId, receipt: receipt.receipt, payload };

	// Step 10: only the intent that holds the admission slot of its key is sent; the slot is idempotent per record.
	let admission: ClaimIntentAdmitResult;
	try {
		admission = await journal.admit(record);
	} catch {
		admission = { kind: "unavailable", reason: "claim intent journal is unavailable" };
	}
	if (admission.kind !== "admitted") return notSent(ADMISSION_CAUSES[admission.kind]);

	let queried: Queried | undefined;
	let own = 0;
	while (true) {
		// Only a repetition passes the schedule's gate; without a schedule nothing changes.
		if (queried !== undefined && schedule !== undefined && !(await mayResend(schedule, counter.sends + 1))) {
			return settled(queried);
		}
		own += 1;
		counter.sends += 1;
		const written = await send(store, base, change);
		if (written.kind === "applied") {
			const landed: ClaimSnapshot = {
				kind: "present",
				ticket: intent.ticket,
				root: written.root,
				document: written.document,
			};
			return { fact: { kind: "applied", root: written.root }, outcome: "applied", landed };
		}
		if (written.kind === "invalid" || written.kind === "not-sent") {
			// Nothing left the client. A repetition that never left keeps the preceding open query result.
			if (queried !== undefined) return settled(queried);
			return notSent(written.kind === "invalid" ? "write-invalid" : "write-not-sent");
		}
		// Only the first send of this call's fresh intent can be rejected finally; a later one, and every send of an
		// earlier process's intent, may meet a delayed earlier push, so it is queried instead.
		if (written.kind === "rejected" && fresh && own === 1) {
			return { fact: { kind: "rejected", cause: written.cause }, outcome: "rejected", landed: null };
		}
		const after = written.kind === "rejected" ? written.cause : "unknown";
		const query = await queryClaimMutation({
			journalDirectory: options.journalDirectory,
			operationId: intent.operationId,
			storage: scheduled(options.storage, schedule),
			journalIO: options.journalIO,
		});
		queried = { kind: "queried", after, query };
		const open =
			query.kind === "resolved" &&
			query.resolution.kind === "open" &&
			query.resolution.observedRoot === intent.expectedRoot;
		if (!open || after !== "unknown" || own >= options.attempts) return settled(queried);
	}
}

/** The facts of a PENDING successor; undefined for every other one, so a D call stays unchanged. */
function timePathOf(next: ClaimStateV1): TimePath | undefined {
	if (next.status !== "pending") return undefined;
	const { timing } = next.source;
	const observeBefore = timing.mode === "none" ? null : timing.hardEnd;
	const reclaimBoundary = claimReclaimBoundary(next);
	if (observeBefore === null || reclaimBoundary === null) return undefined;
	return { pending: next, observeBefore, reclaimBoundary };
}

/** The `transition` of a T call without a witness: phase `none` (P not stored) or `pending` (P stored). */
function unwitnessed(path: TimePath, phase: "none" | "pending"): ClaimExecutionTransition {
	return {
		phase,
		confirmOperationId: null,
		observeBefore: path.observeBefore,
		reclaimBoundary: path.reclaimBoundary,
		confirmation: null,
	};
}

/** This P's A record in the journal, `undefined` without one, `null` when unreadable or foreign. */
async function witnessOf(
	journal: ClaimIntentJournal,
	record: ClaimIntentRecord,
	confirmOperationId: string,
): Promise<ClaimIntentRecord | null | undefined> {
	try {
		const loaded = await journal.load(confirmOperationId);
		if (loaded.kind === "absent") return undefined;
		return loaded.kind === "loaded" && isClaimConfirmation(record, loaded.record) ? loaded.record : null;
	} catch {
		return null;
	}
}

/**
 * Steps T3 to T6 once P is stored. An A record of this P already in the journal is the witness;
 * otherwise p is observed (a snapshot whose payload is canonically P's PENDING), the clock is read once (C_o) and
 * only while `C_o + eps < H_s` the witness is persisted as the A intent against exactly p. A is sent only while it
 * is open at p, with P's action, no plan, no binding check and no work right; the call's one budget covers it.
 */
async function confirmTransition(
	options: SendIntentOptions & { source: ClaimMutationSource; clock: () => number; clockSkewMs: number },
	record: ClaimIntentRecord,
	path: TimePath,
	landed: ClaimSnapshot | null,
): Promise<Confirmation> {
	const { journal, store, schedule, counter, clockSkewMs } = options;
	const { intent } = record;
	const confirmOperationId = claimConfirmationId(intent.operationId);
	const withoutWitness: Confirmation = { transition: unwitnessed(path, "pending"), outcome: "unknown" };
	const witnessed = (confirmation: ClaimExecutionStorage | null, outcome: Outcome): Confirmation => ({
		transition: {
			phase: outcome === "applied" ? "confirmed" : "witnessed",
			confirmOperationId,
			observeBefore: path.observeBefore,
			reclaimBoundary: path.reclaimBoundary,
			confirmation,
		},
		// A stored confirms; A not stored (the root moved past p) keeps the historical APPLIED; an A the
		// query still shows open, or one never sent, is UNKNOWN.
		outcome: outcome === "unknown" || outcome === "not-sent" ? "unknown" : "applied",
	});

	let witness = await witnessOf(journal, record, confirmOperationId);
	if (witness === null) return withoutWitness;
	let base: ClaimReadResult | null = landed;
	if (witness === undefined) {
		// T3: p is a snapshot of this call whose payload is canonically P's PENDING; after a lost reply a fresh read.
		const observed = landed ?? (await readTicket(store, intent.ticket));
		const next = intent.resolved.next;
		if (observed.kind !== "present" || next === undefined) return withoutWitness;
		// A stored P whose p is no longer current and that has no witness is lost history.
		if (canonicalJson(observed.document.payload) !== canonicalJson(next)) {
			return { transition: withoutWitness.transition, outcome: "unknown-history" };
		}
		// T4: exactly one clock reading after p was seen; a witness only while C_o + eps < H_s.
		let observedAt: number;
		try {
			observedAt = options.clock();
		} catch {
			return withoutWitness;
		}
		if (!nonnegative(observedAt) || !Number.isSafeInteger(observedAt + clockSkewMs)) return withoutWitness;
		if (observedAt + clockSkewMs >= path.observeBefore) return withoutWitness;
		// T5: the witness is the A intent against exactly p, persisted before anything of A is sent.
		let prepared: ClaimIntentPrepareResult;
		try {
			prepared = await journal.prepare({
				operationId: confirmOperationId,
				remote: intent.remote,
				format: intent.format,
				epoch: intent.epoch,
				ticket: intent.ticket,
				expectedRoot: observed.root,
				targetBinding: path.pending.target.binding,
				action: intent.action,
				parameters: {
					stage: "confirm",
					transition: intent.operationId,
					transitionDigest: record.digest,
					observedAt,
					clockSkewMs,
					observeBefore: path.observeBefore,
				},
				resolved: { next: jsonCopy(path.pending.target) },
			});
		} catch {
			prepared = { kind: "unavailable", reason: "claim intent journal is unavailable" };
		}
		// A parallel confirmer of the same context may have persisted its witness of this P first; it is reused.
		if (prepared.kind === "prepared" || prepared.kind === "loaded") witness = prepared.record;
		else if (prepared.kind === "conflict") witness = await witnessOf(journal, record, confirmOperationId);
		if (witness === null || witness === undefined) return withoutWitness;
		base = observed;
	}

	// T6: A goes out only while it is open at its own expected root p, whose slot key is never P's q.
	const current = base ?? (await readTicket(store, intent.ticket));
	const resolution = resolveClaimMutation({ record: witness, source: options.source, observed: current });
	const open = resolution.kind === "open" && resolution.observedRoot === witness.intent.expectedRoot;
	if (!open || current.kind !== "present") {
		const clarified: Queried = { kind: "queried", after: "earlier-process", query: { kind: "resolved", resolution } };
		return witnessed(clarified, RESOLVED_OUTCOMES[resolution.kind]);
	}
	// One budget covers P and A: A's first send passes the gate like any later send of this call.
	if (schedule !== undefined && counter.sends > 0 && !(await mayResend(schedule, counter.sends + 1))) {
		return witnessed(null, "unknown");
	}
	// A is always sent as a re-send, never as a finally rejected first send: a rejection alone cannot tell a root that
	// moved past p from a remote refusing the write, only the query can: A not stored is the historical
	// APPLIED, A still open at p stays UNKNOWN with the witness kept for `retry <A-ID>`.
	const sent = await sendIntent(options, witness, current, false);
	return witnessed(sent.fact, sent.outcome);
}

export async function executeClaimTransition(options: ExecuteClaimTransitionOptions): Promise<ClaimExecutionResult> {
	const captured = capture(options);
	if (!captured) return failure("invalid", "invalid claim transition execution options");
	const { storage, ticket, operationId, clockSkewMs, clock, expectedClaimGeneration, schedule, timePath } = captured;

	// Steps 1 and 2 are local: context, then a free operation ID in its journal, before any network access.
	let binding: string;
	let journalDirectory: string;
	let recoveryBinding: string | undefined;
	try {
		const loaded = await loadClaimContext({ directory: captured.contextDirectory, io: captured.contextIO });
		if (loaded.kind !== "loaded") return failure(loaded.kind, "claim context cannot be loaded");
		binding = loaded.context.binding;
		journalDirectory = loaded.context.journalDirectory;
		// Step 1a: only a resume reads the recovery proof of the same load, and it needs one.
		if (captured.request.action === "resume") {
			if (loaded.context.recovery === null) return failure("invalid", "claim context holds no recovery proof");
			recoveryBinding = loaded.context.recovery.binding;
		}
	} catch {
		return failure("unavailable", "claim context is unavailable");
	}
	// Step 1b: a transfer loads the named target context read-only through the same seam, for its binding only;
	// its recovery record and its journal are never read.
	let targetBinding: string | undefined;
	if (captured.targetContextDirectory !== undefined) {
		try {
			const target = await loadClaimContext({ directory: captured.targetContextDirectory, io: captured.contextIO });
			if (target.kind !== "loaded") return failure(target.kind, "claim transfer target context cannot be loaded");
			if (target.context.binding === binding) return failure("invalid", "claim transfer target is the own context");
			targetBinding = target.context.binding;
		} catch {
			return failure("unavailable", "claim transfer target context is unavailable");
		}
	}
	let journal: ClaimIntentJournal;
	try {
		const opened = await openClaimIntentJournal({ directory: journalDirectory, io: captured.journalIO });
		if (opened.kind !== "open") return failure(opened.kind, "claim intent journal cannot be opened");
		const existing = await opened.journal.load(operationId);
		if (existing.kind === "unavailable") return failure("unavailable", "claim intent journal cannot be read");
		if (existing.kind !== "absent") return failure("invalid", "claim operation ID is not free in the journal");
		journal = opened.journal;
	} catch {
		return failure("unavailable", "claim intent journal is unavailable");
	}

	// Steps 3 and 4: the explicit store without initialization, and one fresh read that every send uses as base.
	let store: ClaimStore;
	let descriptor: ClaimStorageDescriptor;
	let observed: ClaimSnapshot;
	try {
		const opened = await openClaimStore(scheduled(storage, schedule));
		switch (opened.kind) {
			case "invalid":
				return failure("invalid", "claim storage options are invalid");
			case "schema-unsupported":
				return failure("unsupported", "claim storage schema is unsupported");
			case "descriptor-missing":
			case "format-mismatch":
			case "corrupt":
			case "unreachable":
				return failure("unknown", "claim storage cannot be read");
		}
		const read = await opened.store.read(ticket);
		if (read.kind !== "present" && read.kind !== "absent") {
			return failure("unknown", "claim observation cannot be read");
		}
		store = opened.store;
		descriptor = opened.descriptor;
		observed = read;
	} catch {
		return failure("unknown", "claim storage is unavailable");
	}

	// Step 5: the only clock call before the final evaluation.
	let now: number;
	try {
		now = clock();
	} catch {
		return failure("invalid", "claim clock failed");
	}
	if (!nonnegative(now) || !Number.isSafeInteger(now + clockSkewMs)) return failure("invalid", "claim clock failed");
	if (observed.kind === "present" && Object.hasOwn(observed.document.receipts, operationId)) {
		return failure("invalid", "claim operation ID is already stored as a receipt");
	}

	const facts = { ticket, descriptor, observed, binding, now, clockSkewMs, expectedClaimGeneration };

	// Step 6: an own intent of this context's journal against the observed root pauses the call before the plan.
	let enumeration: ClaimIntentEnumerationResult;
	try {
		enumeration = await journal.enumerate();
	} catch {
		enumeration = { kind: "unavailable", reason: "claim intent journal is unavailable" };
	}
	const pause = evaluateClaimOperationPause({
		journal: enumeration,
		observation: { remote: storage.remote, descriptor, snapshot: observed },
	});
	if (pause.kind === "invalid") return failure("invalid", "claim operation pause cannot be evaluated");
	if (pause.kind !== "clear") return { kind: "paused", pause, rights: evaluateClaimRight(facts) };

	const plan = planClaimTransition({ ...facts, request: captured.request, targetBinding, recoveryBinding, timePath });
	if (plan.kind !== "planned") return { kind: "not-planned", plan, rights: evaluateClaimRight(facts) };

	const { action } = plan;
	const path = timePathOf(plan.next);
	const counter: Counter = { sends: 0 };
	// Rights come from the planning read while nothing was sent, afterwards from a fresh read (the last clock call).
	// The final read expects the successor's generation; the caller's expectation only guarded the plan.
	const finalRightQuery = {
		storage,
		ticket,
		contextDirectory: captured.contextDirectory,
		contextIO: captured.contextIO,
		clockSkewMs,
		clock,
		expectedClaimGeneration: plan.next.claimGeneration,
	};
	const finalRights = async (): Promise<ClaimRightEvaluation> => {
		if (counter.sends === 0) return evaluateClaimRight(facts);
		return queryClaimRight({ ...finalRightQuery, storage: scheduled(storage, schedule) });
	};
	// A T call's result always carries `transition`, phase `none` until P is stored.
	const finish = async (
		fact: ClaimExecutionStorage,
		outcome: Outcome,
		transition = path === undefined ? undefined : unwitnessed(path, "none"),
	): Promise<ClaimExecutionResult> => {
		const result: Operation = {
			kind: "operation",
			scope: "transition-execution-only",
			action,
			operationId,
			storage: fact,
			outcome: { kind: outcome },
			rights: await finalRights(),
			sends: counter.sends,
		};
		if (transition !== undefined) result.transition = transition;
		return result;
	};

	// The display seam learns the planned successor once, before anything is persisted.
	notifyPlanned(captured.onPlanned, now, plan.next);

	const mapped = claimOperationIntentOf({ operationId, remote: storage.remote, descriptor, ticket, plan });
	if (mapped.kind !== "intent") return finish({ kind: "not-sent", cause: "journal-invalid" }, "not-sent");
	let prepared: ClaimIntentPrepareResult;
	try {
		prepared = await journal.prepare(mapped.intent);
	} catch {
		prepared = { kind: "unavailable", reason: "claim intent journal is unavailable" };
	}
	if (prepared.kind !== "prepared") {
		return finish({ kind: "not-sent", cause: JOURNAL_CAUSES[prepared.kind] }, "not-sent");
	}

	// Steps 9 to 11: the prepared record's change, its admission and the sends on the planning read.
	const sending: SendIntentOptions = {
		journal,
		journalDirectory,
		journalIO: captured.journalIO,
		store,
		storage,
		schedule,
		attempts: captured.attempts,
		counter,
	};
	const sent = await sendIntent(sending, prepared.record, observed, true);
	if (path === undefined || sent.outcome !== "applied") return finish(sent.fact, sent.outcome);
	// T3 to T7: P is stored at p; then the witness, A, and the source's fresh rights.
	const source: ClaimMutationSource = { remote: storage.remote, descriptor };
	const confirmed = await confirmTransition(
		{ ...sending, source, clock, clockSkewMs },
		prepared.record,
		path,
		sent.landed,
	);
	return finish(sent.fact, confirmed.outcome, confirmed.transition);
}

export type ResendClaimIntentOptions = {
	storage: ClaimStorageOptions;
	contextDirectory: string;
	contextIO?: typeof claimContextIO;
	journalIO?: typeof claimJournalIO;
	operationId: string;
	clockSkewMs: number;
	clock: () => number;
	attempts: number;
	schedule?: ClaimSendSchedule;
	onPlanned?: (planned: ClaimPlannedView) => void;
};

/** The action list comes from transition, so a transfer, resume or bound-change record resends too. */
function actionOf(value: string): ClaimTransitionAction | undefined {
	return CLAIM_TRANSITION_ACTIONS.find((action) => action === value);
}

function captureResend(options: ResendClaimIntentOptions): CapturedBase | undefined {
	try {
		return captureBase(options);
	} catch {
		return undefined;
	}
}

/**
 * Additive: resends an intent an earlier call prepared (`claim retry`). No planner, no clock for
 * planning and no new operation ID: the record decides ticket, change and expected root. Local steps come first;
 * the fresh read is the base of every send, and every rejection of a re-send is queried, since the earlier
 * process's send may still land.
 */
export async function resendClaimIntent(options: ResendClaimIntentOptions): Promise<ClaimExecutionResult> {
	const captured = captureResend(options);
	if (!captured) return failure("invalid", "invalid claim intent resend options");
	const { storage, operationId, clockSkewMs, clock, schedule } = captured;

	// Local steps: the explicit context, then the record of this operation ID in its journal.
	let binding: string;
	let journalDirectory: string;
	try {
		const loaded = await loadClaimContext({ directory: captured.contextDirectory, io: captured.contextIO });
		if (loaded.kind !== "loaded") return failure(loaded.kind, "claim context cannot be loaded");
		binding = loaded.context.binding;
		journalDirectory = loaded.context.journalDirectory;
	} catch {
		return failure("unavailable", "claim context is unavailable");
	}
	let journal: ClaimIntentJournal;
	let record: ClaimIntentRecord;
	try {
		const opened = await openClaimIntentJournal({ directory: journalDirectory, io: captured.journalIO });
		if (opened.kind !== "open") return failure(opened.kind, "claim intent journal cannot be opened");
		const loaded = await opened.journal.load(operationId);
		if (loaded.kind === "absent") return failure("invalid", "no claim intent is recorded under this operation ID");
		if (loaded.kind !== "loaded") return failure(loaded.kind, "claim intent record cannot be loaded");
		journal = opened.journal;
		record = loaded.record;
	} catch {
		return failure("unavailable", "claim intent journal is unavailable");
	}
	const { intent } = record;
	const action = actionOf(intent.action);
	const next = parseClaimState(intent.resolved.next);
	if (action === undefined || next.kind !== "state") return failure("corrupt", "claim intent record cannot be resent");
	// A record of another endpoint or format is never sent to this one.
	if (intent.remote !== storage.remote || intent.format !== storage.format) {
		return failure("invalid", "claim intent scope does not match the storage options");
	}

	// The explicit store without initialization, and one fresh read that every send uses as base.
	let store: ClaimStore;
	let descriptor: ClaimStorageDescriptor;
	let observed: ClaimSnapshot;
	try {
		const opened = await openClaimStore(scheduled(storage, schedule));
		switch (opened.kind) {
			case "invalid":
				return failure("invalid", "claim storage options are invalid");
			case "schema-unsupported":
				return failure("unsupported", "claim storage schema is unsupported");
			case "descriptor-missing":
			case "format-mismatch":
			case "corrupt":
			case "unreachable":
				return failure("unknown", "claim storage cannot be read");
		}
		// An intent of another epoch is never sent into this one, and its history ended
		// with the cut; checked before the read, which would find an earlier epoch's document corrupt.
		if (opened.descriptor.epoch !== intent.epoch) return epochCut(action, operationId);
		const read = await opened.store.read(intent.ticket);
		if (read.kind !== "present" && read.kind !== "absent") {
			return failure("unknown", "claim observation cannot be read");
		}
		store = opened.store;
		descriptor = opened.descriptor;
		observed = read;
	} catch {
		return failure("unknown", "claim storage is unavailable");
	}

	const path = timePathOf(next.state);
	const counter: Counter = { sends: 0 };
	// Rights come from the fresh read while nothing was sent, afterwards from another fresh read; both need the clock.
	const finalRights = async (): Promise<ClaimRightEvaluation> => {
		if (counter.sends > 0) {
			return queryClaimRight({
				storage: scheduled(storage, schedule),
				ticket: intent.ticket,
				contextDirectory: captured.contextDirectory,
				contextIO: captured.contextIO,
				clockSkewMs,
				clock,
				expectedClaimGeneration: next.state.claimGeneration,
			});
		}
		let now: number;
		try {
			now = clock();
		} catch {
			return { kind: "invalid", reason: "claim clock failed" };
		}
		return evaluateClaimRight({ ticket: intent.ticket, descriptor, observed, binding, now, clockSkewMs });
	};
	// A T call's P record answers with `transition`, phase `none` until P is stored.
	const finish = async (
		fact: ClaimExecutionStorage,
		outcome: Outcome,
		transition = path === undefined ? undefined : unwitnessed(path, "none"),
	): Promise<ClaimExecutionResult> => {
		const result: Operation = {
			kind: "operation",
			scope: "transition-execution-only",
			action,
			operationId,
			storage: fact,
			outcome: { kind: outcome },
			rights: await finalRights(),
			sends: counter.sends,
		};
		if (transition !== undefined) result.transition = transition;
		return result;
	};
	const source: ClaimMutationSource = { remote: storage.remote, descriptor };
	const sending: SendIntentOptions = {
		journal,
		journalDirectory,
		journalIO: captured.journalIO,
		store,
		storage,
		schedule,
		attempts: captured.attempts,
		counter,
	};

	// Clarification before any send: only an intent that is still open at its expected root is sent again.
	const resolution = resolveClaimMutation({ record, source, observed });
	let sent: Sent;
	if (resolution.kind !== "open" || resolution.observedRoot !== intent.expectedRoot) {
		const clarified: Queried = { kind: "queried", after: "earlier-process", query: { kind: "resolved", resolution } };
		sent = { fact: clarified, outcome: RESOLVED_OUTCOMES[resolution.kind], landed: observed };
	} else {
		notifyPlanned(captured.onPlanned, null, next.state);
		// The identical change of the record on the fresh base; no rejection of a re-send is final.
		sent = await sendIntent(sending, record, observed, false);
	}
	if (path === undefined || sent.outcome !== "applied") return finish(sent.fact, sent.outcome);
	// A stored P continues with T3 to T7; p is observed anew only while C + eps < H_s.
	const confirmed = await confirmTransition({ ...sending, source, clock, clockSkewMs }, record, path, sent.landed);
	return finish(sent.fact, confirmed.outcome, confirmed.transition);
}
