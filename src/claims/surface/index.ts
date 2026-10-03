/**
 * Shared core of the canonical claim CLI and the MCP claim tools: composes preflight,
 * executor, query, rights and init into closed public document types. No parser and no
 * resolver of its own. Every document is built field by field from enumerated values: no
 * upstream object is spread, no upstream `reason` is copied, and `message` comes from a fixed table keyed by code.
 */
import { isAbsolute } from "node:path";
import type { TaskCorpus } from "../../core/task-detail.ts";
import type { Task, TaskListFilter } from "../../types/index.ts";
import { createReadinessGraph, getTaskReadiness, type TaskReadiness } from "../../utils/readiness.ts";
import { canonicalTaskId, isValidTaskId } from "../../utils/task-id.ts";
import { createTaskRecordIndex } from "../../utils/task-record-index.ts";
import { compareByAge, compareByPriorityThenAge, compareTaskIds } from "../../utils/task-sorting.ts";
import {
	CLAIM_START_VALUES,
	type ClaimConfigProblem,
	type ClaimConfigProblemCode,
	type ClaimCoordinationInitResult,
	type ClaimPreflightResult,
	type ClaimSettings,
	initializeClaimCoordination,
	preflightClaimStorage,
	resolveClaimSettings,
} from "../config/index.ts";
import {
	type ClaimContext,
	claimContextAuthority,
	type claimContextIO,
	createClaimContext,
	loadClaimContext,
} from "../context/index.ts";
import {
	type ClaimExecutionNotSent,
	type ClaimExecutionResult,
	type ClaimPlannedView,
	executeClaimTransition,
	resendClaimIntent,
} from "../execution/index.ts";
import {
	type ClaimIntentEnumerationResult,
	type ClaimIntentRecord,
	type claimJournalIO,
	openClaimIntentJournal,
} from "../journal/index.ts";
import {
	type ClaimAcquireStop,
	type ClaimOperationPause,
	evaluateClaimAcquireStop,
	evaluateClaimOperationPause,
} from "../pause/index.ts";
import {
	type ClaimMutationQueryResult,
	type ClaimTransitionQueryResult,
	queryClaimMutation,
	queryClaimTransition,
} from "../query/index.ts";
import { claimConfirmationId, claimTransitionOf } from "../resolution/index.ts";
import {
	type ClaimRightEvaluation,
	type ClaimTiming,
	claimReclaimBoundary,
	evaluateClaimRight,
	isClaimTiming,
	parseClaimState,
} from "../rights/index.ts";
import {
	type ClaimEpochTicket,
	type ClaimReadResult,
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStore,
	installClaimEpoch,
	listClaimRefs,
	swapClaimEpoch,
} from "../storage/index.ts";
import {
	CLAIM_TRANSITION_ACTIONS,
	type ClaimLeaseRequest,
	type ClaimTimeBoxRequest,
	type ClaimTimingRequest,
	type ClaimTransitionAction,
	type ClaimTransitionRequest,
	planClaimTransition,
} from "../transition/index.ts";
import { validTicket } from "../validate.ts";

// ---------------------------------------------------------------------------------------------------------------
// Envelope, status and exit codes
// ---------------------------------------------------------------------------------------------------------------

export type ClaimCommand =
	| "acquire"
	| "renew"
	| "release"
	| "reclaim"
	| "transfer"
	| "resume"
	| "change-bounds"
	| "resolve"
	| "retry"
	| "list"
	| "setup"
	| "init"
	| "context-create"
	/** Not a ClaimMutationCommand; actionOfCommand stays intact. */
	| "next"
	/** Not a ClaimMutationCommand; actionOfCommand stays intact. */
	| "reclaim-batch"
	| "reclaim-preview"
	/** The eighth transition action, a ClaimMutationCommand. */
	| "emergency-release"
	/** Read-only; not a ClaimMutationCommand. */
	| "context-show"
	/** New epochs; not a ClaimMutationCommand, runs outside `mutate`. */
	| "install-epoch";

export type ClaimStatus =
	| "ok"
	| "applied"
	| "rejected"
	| "unknown"
	| "unknown-history"
	| "refused"
	| "unavailable"
	| "paused"
	| "internal";

/** The closed status/exit table; exit 1 is reserved for `internal` and Commander usage errors alike. */
export const CLAIM_EXIT_CODES: Record<ClaimStatus, number> = {
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

/** The closed v1 error code list, minus `own-operation-open` (replaced by the pause kind). */
export type ClaimErrorCode =
	| "project-not-found"
	| "project-config-unreadable"
	| "invalid-ticket"
	| "ticket-not-found"
	| "ticket-ambiguous"
	| "owner-required"
	| "context-required"
	| "invalid-option"
	| "option-not-applicable"
	| "hard-end-required"
	| "invalid-operation-id"
	| "operation-id-in-use"
	| "not-configured"
	| "config-invalid"
	| "claims-disabled"
	| "context-invalid"
	| "context-corrupt"
	| "context-unavailable"
	| "descriptor-missing"
	| "format-mismatch"
	| "schema-unsupported"
	| "coordination-corrupt"
	| "unreachable"
	| "preflight-invalid"
	| "preflight-unknown"
	| "request-invalid"
	| "local-unavailable"
	| "storage-unreadable"
	| "state-corrupt"
	| "state-unsupported"
	| "state-unknown"
	| "budget-exhausted"
	| "operation-not-found"
	| "record-corrupt"
	| "scope-mismatch"
	| "list-unavailable"
	| "already-configured"
	| "config-write-failed"
	| "format-conflict"
	| "not-empty"
	| "remote-rejected"
	| "init-unknown"
	| "target-context-invalid"
	| "target-context-unavailable"
	| "recovery-missing"
	| "bounds-required"
	/** The direct-acquire dependency gate; refused before the network. */
	| "dependency-blocked"
	| "dependency-unknown"
	/** The one code for unreadable local tasks, shared with the batch commands. */
	| "tasks-unavailable"
	/** Missing scope, e.g. a batch or preview call with no ticket ids or task filters. */
	| "scope-required"
	/** Emergency-release or install-epoch without a listed recovery authority. */
	| "authority-required"
	/** Emergency-release with --expect-root and --preview together, or with neither. */
	| "expectation-required"
	/** Install-epoch without --isolation-confirmed. */
	| "isolation-unconfirmed"
	| "internal";

type ClaimErrorStatus = Extract<ClaimStatus, "refused" | "unavailable" | "unknown" | "internal">;

/** The status every closed v1 error code maps to; the `claims` guide documents each one. */
export const CLAIM_ERROR_CODES: Record<ClaimErrorCode, ClaimErrorStatus> = {
	"project-not-found": "refused",
	"project-config-unreadable": "refused",
	"invalid-ticket": "refused",
	"ticket-not-found": "refused",
	"ticket-ambiguous": "refused",
	"owner-required": "refused",
	"context-required": "refused",
	"invalid-option": "refused",
	"option-not-applicable": "refused",
	"hard-end-required": "refused",
	"invalid-operation-id": "refused",
	"operation-id-in-use": "refused",
	"not-configured": "refused",
	"config-invalid": "refused",
	"claims-disabled": "refused",
	"context-invalid": "refused",
	"context-corrupt": "refused",
	"context-unavailable": "unavailable",
	"descriptor-missing": "refused",
	"format-mismatch": "refused",
	"schema-unsupported": "refused",
	"coordination-corrupt": "refused",
	unreachable: "unavailable",
	"preflight-invalid": "refused",
	"preflight-unknown": "unavailable",
	"request-invalid": "refused",
	"local-unavailable": "unavailable",
	"storage-unreadable": "unavailable",
	"state-corrupt": "refused",
	"state-unsupported": "refused",
	"state-unknown": "unavailable",
	"budget-exhausted": "unavailable",
	"operation-not-found": "refused",
	"record-corrupt": "refused",
	"scope-mismatch": "refused",
	"list-unavailable": "unavailable",
	"already-configured": "refused",
	"config-write-failed": "unavailable",
	"format-conflict": "refused",
	"not-empty": "refused",
	"remote-rejected": "refused",
	"init-unknown": "unknown",
	"target-context-invalid": "refused",
	"target-context-unavailable": "unavailable",
	"recovery-missing": "refused",
	"bounds-required": "refused",
	"dependency-blocked": "refused",
	"dependency-unknown": "refused",
	"tasks-unavailable": "unavailable",
	"scope-required": "refused",
	"authority-required": "refused",
	"expectation-required": "refused",
	"isolation-unconfirmed": "refused",
	internal: "internal",
};

/** The only source of `message`; fixed per code, never a configured value, path or upstream text. */
const MESSAGES: Record<ClaimErrorCode, string> = {
	"project-not-found": "no Backlog.md project was found in this directory or above it",
	"project-config-unreadable": "the project configuration cannot be read",
	"invalid-ticket": "the ticket ID is not a valid task ID",
	"ticket-not-found": "acquire needs a local task file for the ticket and none was found",
	"ticket-ambiguous": "the ticket ID matches more than one local task",
	"owner-required": "this command needs --owner with a non-empty display name",
	"context-required": "this command needs --context with the absolute path of a private claim context",
	"invalid-option": "an option value is invalid for this command",
	"option-not-applicable": "an option does not apply to this command or to the lifetime mode",
	"hard-end-required": "the hard lifetime mode needs --hard-end with an ISO-8601 instant and a time zone",
	"invalid-operation-id": "the operation ID must use letters, digits, - or _ and have at most 128 characters",
	"operation-id-in-use": "the operation ID is already recorded in this context's journal",
	"not-configured": "claims are not configured for this project",
	"config-invalid": "the claims configuration is invalid; see problems for the affected keys",
	"claims-disabled": "claims are disabled in the project configuration; existing claims are not released",
	"context-invalid": "the private claim context could not be found or is not a private directory",
	"context-corrupt": "the private claim context is corrupt",
	"context-unavailable": "the private claim context is unavailable",
	"descriptor-missing": "the claim coordination area is not initialized",
	"format-mismatch": "the claim coordination area uses a different storage format",
	"schema-unsupported": "the claim coordination data needs a newer version of Backlog.md",
	"coordination-corrupt": "the claim coordination descriptor is unreadable",
	unreachable: "the claim coordination endpoint could not be reached",
	"preflight-invalid": "the claim storage cannot be used from this project",
	"preflight-unknown": "the claim storage check ended without a verdict",
	"request-invalid": "the claim request is invalid; nothing was sent",
	"local-unavailable": "local claim data is unavailable; nothing was sent",
	"storage-unreadable": "the claim storage could not be read; nothing was sent",
	"state-corrupt": "the stored claim state is corrupt; nothing was sent",
	"state-unsupported": "the stored claim state needs a newer version of Backlog.md; nothing was sent",
	"state-unknown": "the stored claim state could not be evaluated; nothing was sent",
	"budget-exhausted": "the operation budget was used up before anything was sent",
	"operation-not-found": "this context's journal records no such operation; that never means it was not sent",
	"record-corrupt": "the recorded operation is corrupt",
	"scope-mismatch": "the recorded operation belongs to another claim endpoint or storage format",
	"list-unavailable": "the claim references could not be listed",
	"already-configured": "the project already has a claims block; setup never overwrites it",
	"config-write-failed": "the project configuration could not be written",
	"format-conflict": "the claim coordination area was already initialized with a different storage format",
	"not-empty": "the claim coordination area already has ticket references without a descriptor",
	"remote-rejected": "the claim coordination endpoint refused to write the descriptor",
	"init-unknown": "the outcome of the initialization is unknown",
	"target-context-invalid": "transfer needs --to-context with the absolute path of another loadable claim context",
	"target-context-unavailable": "the target claim context is unavailable; nothing was sent",
	"recovery-missing": "resume needs a claim context created with --recover-from from the context that holds the claim",
	"bounds-required": "change-bounds needs --mode and the complete target timing of that mode",
	"dependency-blocked": "the ticket has an unfinished prerequisite and cannot be acquired directly",
	"dependency-unknown": "a prerequisite of the ticket could not be resolved against the local task corpus",
	"tasks-unavailable": "the local task corpus is unavailable",
	"scope-required": "the command needs a scope of ticket ids or task filters",
	"authority-required": "this command needs a context whose authority ID is listed in claims.recovery_authorities",
	"expectation-required": "emergency-release needs either --preview or --expect-root with the root the preview showed",
	"isolation-unconfirmed": "this command needs --isolation-confirmed once every claim writer is cut off",
	internal: "an unexpected internal error occurred",
};

/** An unexpected error after the executor call; the intent may have been sent. */
const UNKNOWN_AFTER_START = "an unexpected error ended the command after the operation started; its outcome is unknown";

/** Confirmed start values for the two pause keys, in their own constant; `clock_uncertainty_ms` has none. */
export const CLAIM_RETRY_START_VALUES = { retryPauseBaseMs: 1_000, retryPauseMaxMs: 5_000 } as const;

/** The twelve keys `claim setup` writes, in schema order. */
const TEMPLATE_KEYS = [
	"enabled",
	"endpoint",
	"storage_format",
	"lifetime_mode",
	"lease_ttl_ms",
	"reclaim_grace_ms",
	"attempt_timeout_ms",
	"attempts",
	"operation_budget_ms",
	"clock_uncertainty_ms",
	"retry_pause_base_ms",
	"retry_pause_max_ms",
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Public sub-views: allowlisted projections, never a spread of an upstream object.
// ---------------------------------------------------------------------------------------------------------------

export type ClaimTimingView =
	| { mode: "lease"; leaseEnd: number; hardEnd: number | null; graceMs: number }
	| { mode: "hard"; hardEnd: number; graceMs: number }
	| { mode: "none" };

type ClaimResolutionKind = "stored" | "not-stored" | "open" | "conflict" | "unknown" | "unknown-history" | "invalid";

type ClaimOuterQueryKind =
	| "record-absent"
	| "record-corrupt"
	| "invalid"
	| "unavailable"
	| "unknown"
	| "unknown-history"
	| "unsupported";

/** QueryView: kinds only, never the record or the observed root. */
type ClaimQueryView = { kind: "resolved"; resolution: ClaimResolutionKind } | { kind: ClaimOuterQueryKind };

export type ClaimStorageView =
	| { kind: "applied" }
	| { kind: "rejected"; cause: "stale" | "remote" }
	| { kind: "queried"; after: "unknown" | "stale" | "remote" | "earlier-process"; query: ClaimQueryView }
	| { kind: "not-sent"; cause: ClaimExecutionNotSent };

type EvaluatedRight = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type RightFailure = Exclude<ClaimRightEvaluation["kind"], "evaluated">;

/** RightsView: the rights evaluation without `observedRoot` and `reason`. */
export type ClaimRightsView =
	| {
			kind: "evaluated";
			scope: "observed-state-only";
			ownership: EvaluatedRight["ownership"];
			claimGeneration: number | null;
			workRight: EvaluatedRight["workRight"];
			reclaim: EvaluatedRight["reclaim"];
	  }
	| { kind: RightFailure };

type ClaimRejectionView = { stage: "plan" | "storage" | "resolution"; cause: string; boundary?: number };

/** The capped-lease display, delivered once through the executor's `onPlanned` callback. */
type ClaimPlannedDisplay = {
	status: "active" | "free";
	claimGeneration: number;
	timing: ClaimTimingView | null;
	capped: boolean;
};

type ClaimPauseView = { kind: "outstanding"; operationIds: string[] } | { kind: "unknown" };

type ClaimProblemView = { key: string; problem: ClaimConfigProblemCode };

export type ClaimListEntry = {
	ticket: string;
	state: "active" | "free" | "unknown" | "pending";
	owner?: string;
	claimGeneration?: number;
	/** The epoch of the store the entry was read in; present exactly when `claimGeneration` is. */
	epoch?: number;
	timing?: ClaimTimingView;
	rights?: ClaimRightsView;
	/** PENDING only, the owner display names of source and target; never `owner`/`timing`. */
	transition?: { from: string; to: string };
	/** PENDING only, the hull max(R(source), R(target)). */
	reclaimBoundary?: number;
};

// ---------------------------------------------------------------------------------------------------------------
// Public documents: closed types, built by allowlist, never by spreading an upstream object.
// ---------------------------------------------------------------------------------------------------------------

export type ClaimOperationDocument = {
	schemaVersion: 1;
	kind: "claim-operation";
	/** `unavailable` is a `not-sent` outcome: the intent was prepared but nothing left the client. */
	status: Extract<ClaimStatus, "applied" | "rejected" | "unknown" | "unknown-history" | "unavailable">;
	command: ClaimCommand;
	action: ClaimTransitionAction;
	ticket: string;
	operationId: string | null;
	outcome: "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
	rejection: ClaimRejectionView | null;
	storage: ClaimStorageView | null;
	sends: number;
	stoppedBy: "attempts" | "budget" | null;
	planned: ClaimPlannedDisplay | null;
	rights: ClaimRightsView;
	/**
	 * Only on a T call: the phase, the A ID once a witness exists, H_s, the hull and A's
	 * storage fact; `operationId`, `storage` and `planned` stay P's (`planned` shows the target).
	 */
	transition?: {
		phase: "none" | "pending" | "witnessed" | "confirmed";
		confirmOperationId: string | null;
		observeBefore: number;
		reclaimBoundary: number;
		confirmation: ClaimStorageView | null;
	};
};

/** An executor pause; operation IDs are data, never a diagnostic, and `retry` is the documented way out. */
export type ClaimPauseDocument = {
	schemaVersion: 1;
	kind: "claim-pause";
	status: "paused";
	command: ClaimCommand;
	action: ClaimTransitionAction;
	ticket: string;
	operationId: null;
	pause: ClaimPauseView;
	rights: ClaimRightsView;
};

export type ClaimResolutionDocument = {
	schemaVersion: 1;
	kind: "claim-resolution";
	status: Extract<ClaimStatus, "applied" | "rejected" | "unknown" | "unknown-history">;
	command: ClaimCommand;
	operationId: string;
	ticket: string;
	action: ClaimTransitionAction;
	outcome: "applied" | "rejected" | "unknown" | "unknown-history";
	query: ClaimQueryView;
	/** Only for a T call's P ID, its phase and the A ID once a witness exists. */
	transition?: { phase: "none" | "pending" | "witnessed" | "confirmed"; confirmOperationId: string | null };
};

export type ClaimListDocument = {
	schemaVersion: 1;
	kind: "claim-list";
	status: Extract<ClaimStatus, "ok" | "unknown">;
	command: "list";
	complete: boolean;
	observedAt: number;
	claims: ClaimListEntry[];
};

type ClaimSetupDocument = {
	schemaVersion: 1;
	kind: "claim-setup";
	status: "ok";
	command: "setup";
	keys: string[];
};

type ClaimInitDocument = {
	schemaVersion: 1;
	kind: "claim-init";
	status: "ok";
	command: "init";
	result: "created" | "exists";
	format: ClaimStorageFormat;
	epoch: number;
};

type ClaimContextDocument = {
	schemaVersion: 1;
	kind: "claim-context";
	status: "ok";
	command: "context-create" | "context-show";
	contextId: string;
	/** Context show only; never on context create. */
	authorityId?: string;
};

/** The local prerequisites a dependency verdict names, canonical ticket IDs only. */
type ClaimDependencyView = { blocking: string[]; unknown: string[]; unreadable: number };

export type ClaimErrorDocument = {
	schemaVersion: 1;
	kind: "claim-error";
	status: ClaimErrorStatus;
	command: ClaimCommand;
	code: ClaimErrorCode;
	message: string;
	ticket: string | null;
	operationId: string | null;
	problems?: ClaimProblemView[];
	configuredFormat?: ClaimStorageFormat;
	existingFormat?: ClaimStorageFormat;
	/** Set only for dependency-blocked and dependency-unknown. */
	dependencies?: ClaimDependencyView;
};

// ---------------------------------------------------------------------------------------------------------------
// claim-next and the dependency verdict:
// the pure parts. `runClaimNext` sits beside `runClaimMutation`, whose acquire core every attempt runs.
// ---------------------------------------------------------------------------------------------------------------

/** The shared filter of `task list`, handed to the mandatory seam untouched. */
export type ClaimTicketSelection = { filter: TaskListFilter; query?: string };

/** The one mandatory seam's result; `null` selection yields the corpus alone with `matched = []`. */
export type ClaimLocalTickets =
	| { kind: "loaded"; matched: Task[]; corpus: TaskCorpus; priorities: readonly string[] }
	| { kind: "unavailable" };

type ClaimNextOrder = "priority" | "age";

/** `--max-candidates` default and bounds (numbers are proposals, qualified separately). */
const CLAIM_NEXT_BOUNDS = { defaultMaxCandidates: 5, minMaxCandidates: 1, maxMaxCandidates: 50 } as const;

/** Raw options; the core validates each one, so a bad value is a refusal, never a type error. */
export type ClaimNextInput = {
	owner?: string;
	context: string;
	ttlMs?: number;
	hardEnd?: string;
	order?: string;
	maxCandidates?: number;
	selection: ClaimTicketSelection;
};

export type ClaimCandidateSelection = {
	candidates: string[];
	excluded: { blocked: number; dependencyUnknown: number; notActionable: number };
	diagnostics: { ticket: string; cause: "dependency-unknown"; dependencies: ClaimDependencyView }[];
};

/** A local task ID as a canonical ticket ID, or undefined for a raw value that is none. */
function ticketOf(id: string): string | undefined {
	if (!isValidTaskId(id)) return undefined;
	const ticket = canonicalTaskId(id);
	return validTicket(ticket) ? ticket : undefined;
}

/**
 * The prerequisites a readiness verdict names, as canonical ticket IDs sorted by `compareTaskIds`; every entry that
 * is no canonical ID is only counted in `unreadable`, so no raw frontmatter value reaches a document.
 */
function dependencyView(readiness: TaskReadiness): ClaimDependencyView {
	let unreadable = 0;
	const canonical = (ids: readonly string[]): string[] => {
		const tickets: string[] = [];
		for (const id of ids) {
			const ticket = ticketOf(id);
			if (ticket === undefined) unreadable += 1;
			else if (!tickets.includes(ticket)) tickets.push(ticket);
		}
		return tickets.sort(compareTaskIds);
	};
	const blocking = canonical(readiness.blockingDependencies);
	const unknown = canonical(readiness.missingDependencies);
	return { blocking, unknown, unreadable };
}

/**
 * Pure: the shared ready rule over the WHOLE local corpus, never over the matched set, so a
 * prerequisite a filter hid still resolves. Ready tickets become candidates in claim-next order, each once; blocked
 * (an unfinished prerequisite), unresolved (only unresolvable ones, diagnosed) and finished tickets are counted.
 */
export function selectClaimCandidates(input: {
	matched: readonly Task[];
	corpus: TaskCorpus;
	priorities: readonly string[];
	order: ClaimNextOrder;
}): ClaimCandidateSelection {
	const graph = createReadinessGraph(input.corpus);
	const excluded = { blocked: 0, dependencyUnknown: 0, notActionable: 0 };
	const diagnostics: ClaimCandidateSelection["diagnostics"] = [];
	const ready: Task[] = [];
	for (const task of input.matched) {
		const readiness = getTaskReadiness(task, graph);
		if (readiness.isReady) {
			ready.push(task);
		} else if (!readiness.isBlocked) {
			excluded.notActionable += 1;
		} else if (readiness.blockingDependencies.length > 0) {
			excluded.blocked += 1;
		} else {
			excluded.dependencyUnknown += 1;
			const ticket = ticketOf(task.id);
			if (ticket !== undefined) {
				diagnostics.push({ ticket, cause: "dependency-unknown", dependencies: dependencyView(readiness) });
			}
		}
	}
	const priorities = input.priorities;
	const compare =
		input.order === "age"
			? (left: Task, right: Task) => compareByAge(left, right)
			: (left: Task, right: Task) => compareByPriorityThenAge(left, right, priorities);
	const candidates: string[] = [];
	for (const task of ready.sort(compare)) {
		const ticket = ticketOf(task.id);
		if (ticket === undefined) excluded.notActionable += 1;
		else if (!candidates.includes(ticket)) candidates.push(ticket);
	}
	diagnostics.sort((left, right) => compareTaskIds(left.ticket, right.ticket));
	return { candidates, excluded, diagnostics };
}

/**
 * Pure: the gate verdict on `isBlocked`, never on `isReady`, so a finished ticket stays directly
 * acquirable. `blocked` when a prerequisite is unfinished, `unknown` when only unresolvable ones remain or the
 * ticket itself has no single record in the corpus (missing or claimed by two files).
 */
export function claimDependencyVerdict(input: {
	ticket: string;
	corpus: TaskCorpus;
}): { kind: "clear" } | ({ kind: "blocked" | "unknown" } & ClaimDependencyView) {
	const record = createTaskRecordIndex(input.corpus).lookup(input.ticket);
	if (record === undefined || record === "ambiguous") {
		return { kind: "unknown", blocking: [], unknown: [], unreadable: 0 };
	}
	const readiness = getTaskReadiness(record.task, createReadinessGraph(input.corpus));
	if (!readiness.isBlocked) return { kind: "clear" };
	const view = dependencyView(readiness);
	const kind = readiness.blockingDependencies.length > 0 ? "blocked" : "unknown";
	return { kind, blocking: view.blocking, unknown: view.unknown, unreadable: view.unreadable };
}

export type ClaimNextAttempt = ClaimOperationDocument | ClaimPauseDocument | ClaimErrorDocument;

/** The isolated conflicts of a plan; an unresolved transition is ticket-bounded. */
const CONTINUE_PLAN_CAUSES: readonly string[] = ["not-free", "held", "pending-transition"];
/** Ticket-bounded refusals and a stale selection. */
const CONTINUE_ERROR_CODES: readonly ClaimErrorCode[] = [
	"state-corrupt",
	"state-unsupported",
	"dependency-blocked",
	"dependency-unknown",
	"ticket-not-found",
	"ticket-ambiguous",
];

/** A rejection continues only when it is provably isolated to its ticket. */
function isolatedRejection(rejection: ClaimRejectionView | null): boolean {
	if (rejection === null) return false;
	if (rejection.stage === "plan") return CONTINUE_PLAN_CAUSES.includes(rejection.cause);
	if (rejection.stage === "storage") return rejection.cause === "stale";
	return rejection.cause === "not-stored";
}

/**
 * Pure: the continue/stop table over one attempt document, first match wins. An unknown outcome (also
 * `internal` with status unknown) and an unsettled history stop; an acquisition ends the call; isolated conflicts
 * and ticket-bounded errors continue; a pause continues only when its list is non-empty and names own maintenance
 * operations of the pre-phase enumeration alone; everything else stops.
 */
export function claimNextStep(input: {
	document: ClaimNextAttempt;
	maintenanceOperationIds: ReadonlySet<string>;
}): "claimed" | "continue" | "stop" {
	const { document, maintenanceOperationIds } = input;
	if (document.status === "unknown" || document.status === "unknown-history") return "stop";
	if ("code" in document) return CONTINUE_ERROR_CODES.includes(document.code) ? "continue" : "stop";
	if ("pause" in document) {
		const { pause } = document;
		if (pause.kind !== "outstanding" || pause.operationIds.length === 0) return "stop";
		return pause.operationIds.every((id) => maintenanceOperationIds.has(id)) ? "continue" : "stop";
	}
	if (document.status === "applied") return "claimed";
	// `unavailable` is not-sent (every cause, admission-held included): no rejection, so it stops.
	return isolatedRejection(document.rejection) ? "continue" : "stop";
}

/**
 * The bounded drive over injected attempts: every attempt counts against `maxCandidates`, `held` and
 * `not-free` included; `attempt` is never called past a stop or an acquisition. `exhausted` means every candidate
 * was tried, `bound` that untried ones remain.
 */
export async function driveClaimNext(input: {
	candidates: readonly string[];
	maxCandidates: number;
	maintenanceOperationIds: ReadonlySet<string>;
	attempt(ticket: string): Promise<ClaimNextAttempt>;
}): Promise<{ attempts: ClaimNextAttempt[]; stop: "claimed" | "exhausted" | "bound" | "attempt"; untried: number }> {
	const attempts: ClaimNextAttempt[] = [];
	const untried = () => input.candidates.length - attempts.length;
	for (const ticket of input.candidates) {
		if (attempts.length >= input.maxCandidates) return { attempts, stop: "bound", untried: untried() };
		const document = await input.attempt(ticket);
		attempts.push(document);
		const step = claimNextStep({ document, maintenanceOperationIds: input.maintenanceOperationIds });
		if (step === "claimed") return { attempts, stop: "claimed", untried: untried() };
		if (step === "stop") return { attempts, stop: "attempt", untried: untried() };
	}
	return { attempts, stop: "exhausted", untried: 0 };
}

export type ClaimNextStop =
	| { kind: "claimed" | "no-candidates" | "exhausted" | "bound" | "attempt" | "journal-unknown" }
	| { kind: "outstanding-acquire"; operationIds: string[] };

/** Built field by field, never by spreading an upstream object. */
export type ClaimNextDocument = {
	schemaVersion: 1;
	kind: "claim-next";
	status: Exclude<ClaimStatus, "ok">;
	command: "next";
	order: ClaimNextOrder;
	maxCandidates: number;
	ticket: string | null;
	operationId: string | null;
	candidates: string[];
	excluded: ClaimCandidateSelection["excluded"];
	diagnostics: ClaimCandidateSelection["diagnostics"];
	attempts: ClaimNextAttempt[];
	untried: number;
	stop: ClaimNextStop;
};

/** A dependency view copied field by field, canonical ticket IDs only. */
function dependencyCopy(view: ClaimDependencyView): ClaimDependencyView {
	const { blocking, unknown, unreadable } = view;
	return { blocking: blocking.filter(validTicket), unknown: unknown.filter(validTicket), unreadable };
}

/**
 * The claim-next document, built field by field. Status and exit follow the stop: `claimed` is applied/0,
 * `no-candidates`, `exhausted` and `bound` are rejected/2, `attempt` takes the stopping attempt's status, the
 * acquisition stop and an unreadable journal are paused/7. `ticket` and `operationId` are those of the last attempt
 * for `claimed` and `attempt` and null otherwise; the attempts are the unchanged base documents.
 */
export function claimNextDocument(input: {
	order: ClaimNextOrder;
	maxCandidates: number;
	selection: ClaimCandidateSelection;
	attempts: ClaimNextAttempt[];
	untried: number;
	stop: ClaimNextStop;
}): ClaimNextDocument | ClaimErrorDocument {
	const { selection } = input;
	const last = input.attempts.at(-1);
	let status: ClaimNextDocument["status"] = "rejected";
	let ticket: string | null = null;
	let operationId: string | null = null;
	let stop: ClaimNextStop;
	if ("operationIds" in input.stop) {
		status = "paused";
		stop = { kind: "outstanding-acquire", operationIds: input.stop.operationIds.filter(validOperationId) };
	} else {
		stop = { kind: input.stop.kind };
		if (stop.kind === "journal-unknown") status = "paused";
		if (stop.kind === "claimed" || stop.kind === "attempt") {
			if (last === undefined) return errorDocument("next", "internal", null, null);
			if (stop.kind === "claimed" && last.status !== "applied") return errorDocument("next", "internal", null, null);
			status = last.status;
			ticket = last.ticket;
			operationId = last.operationId;
		}
	}
	const { blocked, dependencyUnknown, notActionable } = selection.excluded;
	return {
		schemaVersion: 1,
		kind: "claim-next",
		status,
		command: "next",
		order: input.order,
		maxCandidates: input.maxCandidates,
		ticket,
		operationId,
		candidates: selection.candidates.filter(validTicket),
		excluded: { blocked, dependencyUnknown, notActionable },
		diagnostics: selection.diagnostics.map((entry) => ({
			ticket: entry.ticket,
			cause: "dependency-unknown" as const,
			dependencies: dependencyCopy(entry.dependencies),
		})),
		attempts: [...input.attempts],
		untried: input.untried,
		stop,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// claim-reclaim-batch and claim-reclaim-preview:
// the pure parts. The two IO entry points sit beside `runClaimNext` further below;
// both share one selection, and the batch runs the base reclaim core per candidate.
// ---------------------------------------------------------------------------------------------------------------

/** One candidate's document, the same union as claim-next's per-attempt document. */
type ClaimReclaimEntryDocument = ClaimOperationDocument | ClaimPauseDocument | ClaimErrorDocument;

/**
 * The core scope input. A raw `filter` field is not used:
 * the shared filter module hands the core a finished `ClaimTicketSelection`
 * instead, plus the module's blank-value report by flag spelling.
 */
export type ClaimReclaimScopeInput = {
	all?: boolean;
	tickets?: string[];
	claimOwners?: string[];
	selection?: ClaimTicketSelection;
	ready?: boolean;
	blankOptions?: string[];
};

/** The resolved scope of a valid input, or the refusal code of an invalid one. */
export type ClaimReclaimScope =
	| {
			source: "tickets" | "refs";
			tickets: string[] | null;
			claimOwners: string[] | null;
			selection: ClaimTicketSelection | null;
			ready: boolean;
	  }
	| ClaimErrorCode;

type ClaimReclaimInput = { scope: ClaimReclaimScopeInput; context: string };

/** The closed verdict list of a preview entry. */
type ClaimReclaimVerdict =
	| "eligible"
	| "not-yet"
	| "never"
	| "free"
	| "absent"
	| "unknown"
	| "state-corrupt"
	| "state-unsupported";

/**
 * `ticket` and `verdict` always; `claimGeneration` whenever the stored state
 * carries one (ACTIVE, FREE tombstones and PENDING); `owner` and `timing` only for ACTIVE, `transition` (both owner
 * display names) only for PENDING; `boundary` only for eligible and not-yet; `pause` only when
 * the caller passes an open or unknown view.
 */
export type ClaimReclaimPreviewEntry = {
	ticket: string;
	verdict: ClaimReclaimVerdict;
	claimGeneration?: number;
	owner?: string;
	timing?: ClaimTimingView;
	transition?: { from: string; to: string };
	boundary?: number;
	pause?: ClaimPauseView;
};

export type ClaimReclaimPreviewDocument = {
	schemaVersion: 1;
	kind: "claim-reclaim-preview";
	status: Extract<ClaimStatus, "ok" | "unknown">;
	command: "reclaim-preview";
	complete: boolean;
	observedAt: number;
	entries: ClaimReclaimPreviewEntry[];
};

/**
 * The only place a root is ever printed. `state` covers every observed
 * ownership; `owner` on ACTIVE, `transition` on PENDING, neither on free/unknown/absent.
 */
export type ClaimEmergencyPreviewDocument = {
	schemaVersion: 1;
	kind: "claim-emergency-preview";
	status: "ok";
	command: "emergency-release";
	ticket: string;
	state: "active" | "free" | "pending" | "unknown" | "absent";
	owner?: string;
	transition?: ClaimListEntry["transition"];
	claimGeneration: number | null;
	epoch: number | null;
	root: string | null;
};

/** `cause` only with status rejected; the rerun hint is `epoch` itself. */
export type ClaimEpochDocument = {
	schemaVersion: 1;
	kind: "claim-epoch";
	status: "applied" | "rejected" | "unknown";
	command: "install-epoch";
	fromEpoch: number;
	epoch: number;
	format: ClaimStorageFormat;
	previousFormat: ClaimStorageFormat;
	rewritten: string[];
	created: string[];
	breached: string[];
	unsettled: string[];
	isolation: "attested";
	cause?: "epoch-changed" | "writes-observed";
};

/** `--preview` of `install-epoch`; nothing written. */
export type ClaimEpochPreviewDocument = {
	schemaVersion: 1;
	kind: "claim-epoch-preview";
	status: "ok";
	command: "install-epoch";
	epoch: number;
	format: ClaimStorageFormat;
	listed: string[];
	toCreate: string[];
	unreadable: string[];
};

/** One entry per candidate, in candidate order; `result` is `document.status` or `"untried"`. */
type ClaimReclaimBatchEntry = {
	ticket: string;
	result: ClaimStatus | "untried";
	document: ClaimReclaimEntryDocument | null;
};

export type ClaimReclaimBatchDocument = {
	schemaVersion: 1;
	kind: "claim-reclaim-batch";
	status: Exclude<ClaimStatus, "applied">;
	command: "reclaim-batch";
	observedAt: number;
	complete: boolean;
	unreadable: string[];
	stoppedAt: string | null;
	entries: ClaimReclaimBatchEntry[];
};

/** A valid scope: every restriction resolved, `null` where the option was not given. */
type ResolvedReclaimScope = Exclude<ClaimReclaimScope, ClaimErrorCode>;

/** A list option given without values, or with a blank one, never widens the scope. */
function blankList(values: readonly string[] | undefined): boolean {
	if (values === undefined) return false;
	return values.length === 0 || values.some((value) => typeof value === "string" && value.trim() === "");
}

/** A filter value that narrows: a non-blank text, a list with one, or `true`; `false` counts as not given. */
function givenFilterValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (Array.isArray(value)) return value.some((item) => typeof item === "string" && item.trim() !== "");
	return value === true;
}

/** A finished selection narrows only when it names a criterion; `labelMatch` names none. */
function selectionNarrows(selection: ClaimTicketSelection): boolean {
	if (typeof selection.query === "string" && selection.query.trim() !== "") return true;
	return Object.entries(selection.filter).some(([key, value]) => key !== "labelMatch" && givenFilterValue(value));
}

/**
 * Pure: the scope of batch and preview, decided before `--context`,
 * configuration and network. A blank-valued option (the module's report included) is `scope-required` whatever else
 * narrows; `--all` stands alone (`invalid-option`); no restriction at all is `scope-required`; a bad ID is
 * `invalid-ticket`. Explicit tickets become canonical, deduplicated and `compareTaskIds`-ordered; owners stay
 * byte-exact; the selection passes on unchanged, or `null` when it names no criterion.
 */
export function claimReclaimScope(input: ClaimReclaimScopeInput, taskPrefix: string): ClaimReclaimScope {
	const { tickets, claimOwners, blankOptions } = input;
	const selection = input.selection !== undefined && selectionNarrows(input.selection) ? input.selection : null;
	const ready = input.ready === true;
	if (blankList(tickets) || blankList(claimOwners) || (blankOptions !== undefined && blankOptions.length > 0)) {
		return "scope-required";
	}
	const narrowed = tickets !== undefined || claimOwners !== undefined || selection !== null || ready;
	if (input.all === true && narrowed) return "invalid-option";
	if (input.all !== true && !narrowed) return "scope-required";
	let canonical: string[] | null = null;
	if (tickets !== undefined) {
		const unique: string[] = [];
		for (const raw of tickets) {
			const ticket = canonicalTicket(raw, taskPrefix);
			if (ticket === undefined) return "invalid-ticket";
			if (!unique.includes(ticket)) unique.push(ticket);
		}
		canonical = unique.sort(compareTaskIds);
	}
	return {
		source: canonical === null ? "refs" : "tickets",
		tickets: canonical,
		claimOwners: claimOwners === undefined ? null : [...claimOwners],
		selection,
		ready,
	};
}

/** The reclaim plan causes that are verdicts of their own; anything else is `unknown`, never eligible. */
const RECLAIM_PLAN_VERDICTS: Partial<Record<string, ClaimReclaimVerdict>> = {
	"not-yet": "not-yet",
	never: "never",
	free: "free",
	absent: "absent",
};
/** Verdicts of a decodable state: they carry `claimGeneration`, the first three also `owner` and `timing`. */
const STATE_VERDICTS: readonly ClaimReclaimVerdict[] = ["eligible", "not-yet", "never", "free"];
/** Verdicts whose owner cannot be compared; `--claim-owner` never drops them. */
const UNCOMPARED_VERDICTS: readonly ClaimReclaimVerdict[] = ["unknown", "state-corrupt", "state-unsupported"];

/**
 * Pure: the preview entry of one read. The verdict is the planner's
 * reclaim plan against this read (`planClaimTransition` with `{action: "reclaim"}`, no second reclaimability rule),
 * the boundary that of `evaluateClaimRight(...).reclaim` (for PENDING the hull); an unread ticket is `unknown`, never
 * free. Under `claimOwners` an ACTIVE state stays only with a byte-exact listed owner, a PENDING one with a listed
 * source or target owner, FREE and absent drop out (null), and a state whose owner cannot be compared keeps its
 * entry. Built field by field; `pause` only for an open or incomplete own view.
 */
export function claimReclaimVerdict(input: {
	ticket: string;
	descriptor: ClaimStorageDescriptor;
	observed: ClaimReadResult | null;
	binding: string;
	now: number;
	clockSkewMs: number;
	claimOwners: string[] | null;
	pause?: ClaimOperationPause;
}): ClaimReclaimPreviewEntry | null {
	const { ticket, observed, claimOwners, pause } = input;
	const entry: ClaimReclaimPreviewEntry = { ticket, verdict: "unknown" };
	if (observed !== null) {
		const options = {
			ticket,
			descriptor: input.descriptor,
			observed,
			binding: input.binding,
			now: input.now,
			clockSkewMs: input.clockSkewMs,
		};
		const plan = planClaimTransition({ ...options, request: { action: "reclaim" } });
		if (plan.kind === "planned") entry.verdict = "eligible";
		else if (plan.kind === "rejected") entry.verdict = RECLAIM_PLAN_VERDICTS[plan.cause] ?? "unknown";
		else if (plan.kind === "corrupt") entry.verdict = "state-corrupt";
		else if (plan.kind === "unsupported") entry.verdict = "state-unsupported";
		if (!stateFields(entry, observed)) return reclaimOwnerMatch({ ticket, verdict: "unknown" }, claimOwners);
		if (entry.verdict === "eligible" || entry.verdict === "not-yet") {
			const rights = evaluateClaimRight(options);
			const reclaim = rights.kind === "evaluated" ? rights.reclaim : undefined;
			const boundary = reclaim !== undefined && "boundary" in reclaim ? reclaim.boundary : undefined;
			if (!safeInteger(boundary)) return reclaimOwnerMatch({ ticket, verdict: "unknown" }, claimOwners);
			entry.boundary = boundary;
		}
	}
	if (pause?.kind === "outstanding") {
		entry.pause = { kind: "outstanding", operationIds: pause.operationIds.filter(validOperationId) };
	} else if (pause?.kind === "unknown") {
		entry.pause = { kind: "unknown" };
	}
	return reclaimOwnerMatch(entry, claimOwners);
}

/**
 * Copies generation, owner and timing of a decodable state into `entry` for the state verdicts;
 * false when such a verdict has no decodable state, which the caller reports as `unknown` instead of guessing.
 */
function stateFields(entry: ClaimReclaimPreviewEntry, observed: ClaimReadResult): boolean {
	if (!STATE_VERDICTS.includes(entry.verdict)) return true;
	if (observed.kind !== "present") return false;
	const decoded = parseClaimState(observed.document.payload);
	if (decoded.kind !== "state" || !safeInteger(decoded.state.claimGeneration)) return false;
	const { state } = decoded;
	entry.claimGeneration = state.claimGeneration;
	if ("source" in state) {
		// Both display names instead of an owner, the verdict and boundary from the hull.
		entry.transition = { from: state.source.owner, to: state.target.owner };
		return entry.verdict === "eligible" || entry.verdict === "not-yet";
	}
	if (state.status !== "active") return entry.verdict === "free";
	const timing = timingView(state.timing);
	if (entry.verdict === "free" || timing === undefined || typeof state.owner !== "string") return false;
	entry.owner = state.owner;
	entry.timing = timing;
	return true;
}

/**
 * `--claim-owner` over one entry, byte-exact; without the option every entry stays. A PENDING entry
 * stays when its source or its target owner is listed.
 */
function reclaimOwnerMatch(
	entry: ClaimReclaimPreviewEntry,
	claimOwners: readonly string[] | null,
): ClaimReclaimPreviewEntry | null {
	if (claimOwners === null || UNCOMPARED_VERDICTS.includes(entry.verdict)) return entry;
	const { owner, transition } = entry;
	const owners: (string | undefined)[] = transition === undefined ? [owner] : [transition.from, transition.to];
	return owners.some((name) => name !== undefined && claimOwners.includes(name)) ? entry : null;
}

/** The claim-error codes that only shared, call-wide inputs produce; the closed stop list. */
const RECLAIM_STOP_CODES: readonly ClaimErrorCode[] = [
	"not-configured",
	"config-invalid",
	"context-invalid",
	"context-corrupt",
	"descriptor-missing",
	"format-mismatch",
	"schema-unsupported",
	"coordination-corrupt",
	"preflight-invalid",
];

/**
 * Pure: the batch stops only on a proven call-wide fault, a `claim-error` of the closed list or
 * a `claim-pause` whose own journal view is incomplete. Everything else continues, an `unknown` outcome included:
 * the opposite of `claim next`, which stops on it.
 */
export function claimReclaimStops(document: ClaimReclaimEntryDocument): boolean {
	if ("code" in document) return RECLAIM_STOP_CODES.includes(document.code);
	if ("pause" in document) return document.pause.kind === "unknown";
	return false;
}

/** The batch status from the most to the least urgent; `applied` ranks as `ok`, `untried` not at all. */
const RECLAIM_STATUS_RANK: readonly ClaimReclaimBatchDocument["status"][] = [
	"unknown",
	"unknown-history",
	"internal",
	"paused",
	"refused",
	"unavailable",
	"rejected",
	"ok",
];

/**
 * Pure: the batch document, built field by field. Its status is the most urgent entry status,
 * an incomplete selection counting as `unavailable`, so exit 0 means a complete selection with every candidate
 * applied and exit 3 at least one `unknown` entry, in any entry order. Entries keep candidate order and their
 * unchanged single documents; an untried one has `document: null`. `unreadable` is sorted by `compareTaskIds`.
 */
export function claimReclaimBatchDocument(input: {
	observedAt: number;
	complete: boolean;
	unreadable: string[];
	stoppedAt: string | null;
	entries: { ticket: string; document: ClaimReclaimEntryDocument | null }[];
}): ClaimReclaimBatchDocument {
	const complete = input.complete === true;
	const seen = new Set<ClaimStatus>(complete ? [] : ["unavailable"]);
	const entries: ClaimReclaimBatchEntry[] = [];
	for (const { ticket, document } of input.entries) {
		if (document !== null) seen.add(document.status === "applied" ? "ok" : document.status);
		entries.push({ ticket, result: document === null ? "untried" : document.status, document });
	}
	return {
		schemaVersion: 1,
		kind: "claim-reclaim-batch",
		status: RECLAIM_STATUS_RANK.find((status) => seen.has(status)) ?? "ok",
		command: "reclaim-batch",
		observedAt: input.observedAt,
		complete,
		unreadable: input.unreadable.filter(validTicket).sort(compareTaskIds),
		stoppedAt: typeof input.stoppedAt === "string" ? input.stoppedAt : null,
		entries,
	};
}

export type ClaimDocument =
	| ClaimOperationDocument
	| ClaimPauseDocument
	| ClaimResolutionDocument
	| ClaimListDocument
	| ClaimSetupDocument
	| ClaimInitDocument
	| ClaimContextDocument
	| ClaimNextDocument
	| ClaimReclaimBatchDocument
	| ClaimReclaimPreviewDocument
	| ClaimEmergencyPreviewDocument
	| ClaimEpochDocument
	| ClaimEpochPreviewDocument
	| ClaimErrorDocument;

// ---------------------------------------------------------------------------------------------------------------
// Environment: the caller-injected seams; the MCP claim tools reuse the same shape unchanged.
// ---------------------------------------------------------------------------------------------------------------

export type ClaimSurfaceEnv = {
	/** Absolute; the repository the storage seam operates on. */
	projectRoot: string;
	/** The byte-identical `claims:` block `parseConfig` captured; `undefined` means no block at all. */
	claimsYaml: string | undefined;
	taskPrefix: string;
	findLocalTicket(input: string): Promise<{ kind: "found"; ticket: string } | { kind: "missing" | "ambiguous" }>;
	clock(): number;
	monotonicNow(): number;
	random(): number;
	sleep(ms: number): Promise<void>;
	newOperationId(): string;
	/**
	 * The one mandatory seam so no surface can drop the dependency gate silently; `null`
	 * selection loads the corpus alone with `matched = []` (the direct-acquire gate). The CLI wires the same calls
	 * as `runTaskList`/`loadTaskListItems`; the batch commands reuse it unchanged.
	 */
	loadLocalTickets(selection: ClaimTicketSelection | null): Promise<ClaimLocalTickets>;
	/** `claim setup` only: writes a new block through the project's config guard; `exists` if one appeared meanwhile. */
	writeClaimsYaml?: (claimsYaml: string) => Promise<"written" | "exists">;
	/** Test seams only; production omits both and the storage/journal modules fall back to their own IO. */
	contextIO?: typeof claimContextIO;
	journalIO?: typeof claimJournalIO;
	/**
	 * Test seam only: awaited right after the first listing and right after a won descriptor CAS; a throw
	 * there ends the run like a crash: `internal` after the first listing (nothing written), `claim-epoch` unknown
	 * after the swap.
	 */
	installEpochSeams?: { afterFirstListing?: () => Promise<void>; afterDescriptorSwap?: () => Promise<void> };
};

// ---------------------------------------------------------------------------------------------------------------
// Retry pauses and the operation budget: pure, injected seams.
// ---------------------------------------------------------------------------------------------------------------

export type ClaimSendSchedule = {
	/** Only before send n >= 2 of the same intent; "stop" ends further sending. */
	beforeSend(send: number): Promise<"send" | "stop">;
	/** Timeout for the next Git command: min(attempt, remaining budget), never less than 1. */
	commandTimeoutMs(): number;
};

/** Full jitter over `window(n) = min(max, base · 2^(n−2))`: `floor(random · (window + 1))`, within [0, window]. */
export function claimRetryPauseMs(send: number, random: number, pause: { baseMs: number; maxMs: number }): number {
	const exponent = Math.max(0, send - 2);
	// 2^k may overflow to Infinity; min(max, Infinity) is max, and a zero base never multiplies Infinity.
	const window = pause.baseMs === 0 ? 0 : Math.min(pause.maxMs, pause.baseMs * 2 ** exponent);
	const draw = Number.isFinite(random) && random > 0 ? random : 0;
	return Math.min(window, Math.floor(draw * (window + 1)));
}

/**
 * The deadline is `startedAt + budgetMs` on the monotonic clock. A gate draws exactly once, stops without
 * sleeping when the pause would reach the deadline, else sleeps and stops if the deadline passed meanwhile.
 */
export function claimOperationSchedule(options: {
	startedAt: number;
	budgetMs: number;
	attemptTimeoutMs: number;
	pause: { baseMs: number; maxMs: number };
	monotonicNow: () => number;
	random: () => number;
	sleep: (ms: number) => Promise<void>;
}): ClaimSendSchedule & { stoppedBy(): "budget" | null } {
	const { startedAt, budgetMs, attemptTimeoutMs, pause, monotonicNow, random, sleep } = options;
	const deadline = startedAt + budgetMs;
	const state: { stopped: "budget" | null } = { stopped: null };
	return {
		beforeSend: async (send: number): Promise<"send" | "stop"> => {
			const wait = claimRetryPauseMs(send, random(), pause);
			if (monotonicNow() + wait >= deadline) {
				state.stopped = "budget";
				return "stop";
			}
			await sleep(wait);
			if (monotonicNow() >= deadline) {
				state.stopped = "budget";
				return "stop";
			}
			return "send";
		},
		commandTimeoutMs: (): number => Math.max(1, Math.floor(Math.min(attemptTimeoutMs, deadline - monotonicNow()))),
		stoppedBy: () => state.stopped,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Allowlist helpers: every public value is checked against its enumerated range before it is copied.
// ---------------------------------------------------------------------------------------------------------------

type ErrorExtra = {
	problems?: ClaimProblemView[];
	configuredFormat?: ClaimStorageFormat;
	existingFormat?: ClaimStorageFormat;
	dependencies?: ClaimDependencyView;
};
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type NotPlanned = Extract<ClaimExecutionResult, { kind: "not-planned" }>;
type Paused = Extract<ClaimExecutionResult, { kind: "paused" }>;
type TopLevel = Extract<ClaimExecutionResult, { reason: string }>["kind"];
type PreflightFailure = Exclude<ClaimPreflightResult, { kind: "ready" }>;
type StopCause = "attempts" | "budget" | null;
type OperationOutcome = ClaimOperationDocument["outcome"];

const FORMATS: readonly ClaimStorageFormat[] = ["blob", "tree", "commit-chain"];
const ACTIONS: readonly ClaimTransitionAction[] = CLAIM_TRANSITION_ACTIONS;
const OUTCOMES: readonly OperationOutcome[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTION_KINDS: readonly ClaimResolutionKind[] = [
	"stored",
	"not-stored",
	"open",
	"conflict",
	"unknown",
	"unknown-history",
	"invalid",
];
const OUTER_QUERY_KINDS: readonly ClaimOuterQueryKind[] = [
	"record-absent",
	"record-corrupt",
	"invalid",
	"unavailable",
	"unknown",
	"unknown-history",
	"unsupported",
];
const NOT_SENT_CAUSES: readonly ClaimExecutionNotSent[] = [
	"journal-invalid",
	"journal-corrupt",
	"journal-unavailable",
	"journal-conflict",
	"journal-loaded",
	"write-invalid",
	"write-not-sent",
	"admission-held",
	"admission-invalid",
	"admission-corrupt",
	"admission-unavailable",
];
const AFTER_KINDS = ["unknown", "stale", "remote", "earlier-process"] as const;
const REJECTION_CAUSES = ["stale", "remote"] as const;
const PLAN_CAUSES: readonly string[] = [
	"held",
	"not-free",
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
	"pending-transition",
	"stale-root",
];
const OWNERSHIPS: readonly EvaluatedRight["ownership"][] = ["held", "foreign", "free", "absent", "pending"];
const RIGHT_FAILURES: readonly RightFailure[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
const NO_RIGHT_CAUSES = ["not-holder", "free", "absent", "hard-expired", "generation-changed", "pending"] as const;
const STOP_CAUSES = ["attempts", "budget"] as const;
/** The phases of a T call. */
const PHASES = ["none", "pending", "witnessed", "confirmed"] as const;
const LOGICAL_OUTCOMES: readonly ClaimResolutionDocument["outcome"][] = [
	"applied",
	"rejected",
	"unknown",
	"unknown-history",
];
const PROBLEM_CODES: readonly ClaimConfigProblemCode[] = [
	"missing",
	"duplicate",
	"unknown-key",
	"unreadable",
	"wrong-type",
	"out-of-range",
	"unsupported-value",
	"unsupported-endpoint",
	"not-applicable",
];

const OUTCOME_STATUS: Record<OperationOutcome, ClaimOperationDocument["status"]> = {
	applied: "applied",
	rejected: "rejected",
	unknown: "unknown",
	"unknown-history": "unknown-history",
	"not-sent": "unavailable",
};

/** Failures before the pause; `unknown` there lies before any send, so it is `unavailable`. */
const TOP_LEVEL_CODES: Record<TopLevel, ClaimErrorCode> = {
	invalid: "request-invalid",
	corrupt: "context-corrupt",
	unsupported: "schema-unsupported",
	unavailable: "local-unavailable",
	unknown: "storage-unreadable",
};

const PLAN_FAILURE_CODES: Record<Exclude<NotPlanned["plan"]["kind"], "rejected">, ClaimErrorCode> = {
	corrupt: "state-corrupt",
	unsupported: "state-unsupported",
	invalid: "request-invalid",
	unknown: "state-unknown",
};

type PreflightCode = Exclude<PreflightFailure["kind"], "config-invalid" | "format-mismatch">;
const PREFLIGHT_CODES: Record<PreflightCode, ClaimErrorCode> = {
	"not-configured": "not-configured",
	"claims-disabled": "claims-disabled",
	"context-invalid": "context-invalid",
	"context-corrupt": "context-corrupt",
	"context-unavailable": "context-unavailable",
	"descriptor-missing": "descriptor-missing",
	"schema-unsupported": "schema-unsupported",
	corrupt: "coordination-corrupt",
	unreachable: "unreachable",
	invalid: "preflight-invalid",
	unknown: "preflight-unknown",
};

type InitFailure = Exclude<ClaimCoordinationInitResult["kind"], "created" | "exists" | "conflict" | "config-invalid">;
const INIT_CODES: Record<InitFailure, ClaimErrorCode> = {
	"not-configured": "not-configured",
	"not-empty": "not-empty",
	"schema-unsupported": "schema-unsupported",
	corrupt: "coordination-corrupt",
	unreachable: "unreachable",
	invalid: "preflight-invalid",
	"not-sent": "local-unavailable",
	rejected: "remote-rejected",
	unknown: "init-unknown",
};

/** Context loader failure kinds: `context create` (with `--recover-from`) and the own context of transfer/resume. */
const CONTEXT_CODES: Record<"invalid" | "corrupt" | "unavailable", ClaimErrorCode> = {
	invalid: "context-invalid",
	corrupt: "context-corrupt",
	unavailable: "context-unavailable",
};

function member<T>(values: readonly T[], value: unknown): T | undefined {
	return values.find((candidate) => candidate === value);
}

function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/** The journal's operation ID rule (journal/index.ts), checked before any IO. */
function validOperationId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** A full lowercase object name, SHA-1 or SHA-256; the preview's `root` is the only one shown. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function validRoot(value: unknown): value is string {
	return typeof value === "string" && OID.test(value);
}

function errorDocument(
	command: ClaimCommand,
	code: ClaimErrorCode,
	ticket: string | null,
	operationId: string | null,
	extra: ErrorExtra = {},
): ClaimErrorDocument {
	const document: ClaimErrorDocument = {
		schemaVersion: 1,
		kind: "claim-error",
		status: CLAIM_ERROR_CODES[code],
		command,
		code,
		message: MESSAGES[code],
		ticket,
		operationId,
	};
	if (extra.problems !== undefined) document.problems = extra.problems;
	if (extra.configuredFormat !== undefined && extra.existingFormat !== undefined) {
		document.configuredFormat = extra.configuredFormat;
		document.existingFormat = extra.existingFormat;
	}
	if (extra.dependencies !== undefined) document.dependencies = dependencyCopy(extra.dependencies);
	return document;
}

/** Error documents the caller of the core builds itself, e.g. `project-not-found` before any environment exists. */
export function claimErrorDocument(input: {
	command: ClaimCommand;
	code: ClaimErrorCode;
	ticket?: string | null;
	operationId?: string | null;
}): ClaimErrorDocument {
	return errorDocument(input.command, input.code, input.ticket ?? null, input.operationId ?? null);
}

/**
 * After the executor call an unexpected error is `unknown` with the operation ID, never `internal`; a batch
 * reports it without ticket and ID once its first single reclaim ran.
 */
function unknownAfterStart(
	command: ClaimCommand,
	ticket: string | null,
	operationId: string | null,
): ClaimErrorDocument {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "unknown",
		command,
		code: "internal",
		message: UNKNOWN_AFTER_START,
		ticket,
		operationId,
	};
}

function isErrorDocument(value: object): value is ClaimErrorDocument {
	return "kind" in value && value.kind === "claim-error";
}

function formatPair(configured: unknown, existing: unknown): ErrorExtra {
	const configuredFormat = member(FORMATS, configured);
	const existingFormat = member(FORMATS, existing);
	return configuredFormat && existingFormat ? { configuredFormat, existingFormat } : {};
}

/** Problems are `{key, problem}` only; the preflight message stays out of every document. */
function problemsView(problems: readonly ClaimConfigProblem[]): ClaimProblemView[] {
	const view: ClaimProblemView[] = [];
	for (const entry of problems) {
		const problem = member(PROBLEM_CODES, entry.problem);
		if (typeof entry.key === "string" && problem !== undefined) view.push({ key: entry.key, problem });
	}
	return view;
}

function timingView(timing: ClaimTiming): ClaimTimingView | undefined {
	if (timing.mode === "none") return { mode: "none" };
	if (timing.mode === "hard") {
		if (!safeInteger(timing.hardEnd) || !safeInteger(timing.graceMs)) return undefined;
		return { mode: "hard", hardEnd: timing.hardEnd, graceMs: timing.graceMs };
	}
	if (timing.mode !== "lease" || !safeInteger(timing.leaseEnd) || !safeInteger(timing.graceMs)) return undefined;
	if (timing.hardEnd !== null && !safeInteger(timing.hardEnd)) return undefined;
	return { mode: "lease", leaseEnd: timing.leaseEnd, hardEnd: timing.hardEnd, graceMs: timing.graceMs };
}

function optionalTiming(timing: ClaimTiming | ClaimTimingView | null): ClaimTimingView | null {
	if (timing === null) return null;
	return timingView(timing) ?? null;
}

function workRightView(workRight: EvaluatedRight["workRight"]): EvaluatedRight["workRight"] | undefined {
	if (workRight.kind === "live") {
		return { kind: "live", renewalDue: typeof workRight.renewalDue === "boolean" ? workRight.renewalDue : null };
	}
	const cause = member(NO_RIGHT_CAUSES, workRight.cause);
	return workRight.kind === "none" && cause !== undefined ? { kind: "none", cause } : undefined;
}

function reclaimView(reclaim: EvaluatedRight["reclaim"]): EvaluatedRight["reclaim"] | undefined {
	if (reclaim.kind === "never" || reclaim.kind === "not-applicable") return { kind: reclaim.kind };
	if ((reclaim.kind === "eligible" || reclaim.kind === "not-yet") && safeInteger(reclaim.boundary)) {
		return { kind: reclaim.kind, boundary: reclaim.boundary };
	}
	return undefined;
}

function rightsView(rights: ClaimRightEvaluation): ClaimRightsView {
	if (rights.kind !== "evaluated") return { kind: member(RIGHT_FAILURES, rights.kind) ?? "unknown" };
	const ownership = member(OWNERSHIPS, rights.ownership);
	const workRight = workRightView(rights.workRight);
	const reclaim = reclaimView(rights.reclaim);
	const generation = rights.claimGeneration;
	if (!ownership || !workRight || !reclaim || (generation !== null && !safeInteger(generation))) {
		return { kind: "unknown" };
	}
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership,
		claimGeneration: generation,
		workRight,
		reclaim,
	};
}

function queryView(query: ClaimMutationQueryResult | ClaimTransitionQueryResult): ClaimQueryView {
	if (query.kind === "resolved") {
		return { kind: "resolved", resolution: member(RESOLUTION_KINDS, query.resolution.kind) ?? "unknown" };
	}
	return { kind: member(OUTER_QUERY_KINDS, query.kind) ?? "unknown" };
}

function storageView(storage: Operation["storage"]): ClaimStorageView | undefined {
	switch (storage.kind) {
		case "applied":
			return { kind: "applied" };
		case "rejected": {
			const cause = member(REJECTION_CAUSES, storage.cause);
			return cause === undefined ? undefined : { kind: "rejected", cause };
		}
		case "queried": {
			const after = member(AFTER_KINDS, storage.after);
			return after === undefined ? undefined : { kind: "queried", after, query: queryView(storage.query) };
		}
		case "not-sent": {
			const cause = member(NOT_SENT_CAUSES, storage.cause);
			return cause === undefined ? undefined : { kind: "not-sent", cause };
		}
		default:
			return undefined;
	}
}

function plannedCopy(planned: ClaimPlannedDisplay | null): ClaimPlannedDisplay | null {
	if (planned === null || !safeInteger(planned.claimGeneration)) return null;
	const status = planned.status === "active" ? "active" : "free";
	const timing = optionalTiming(planned.timing);
	return { status, claimGeneration: planned.claimGeneration, timing, capped: planned.capped === true };
}

/** The capped-lease display; `capped` names a lease end cut to the hard end. */
function plannedDisplay(view: ClaimPlannedView, ttlMs: number | null): ClaimPlannedDisplay {
	const timing = optionalTiming(view.timing);
	let capped = false;
	if (timing !== null && timing.mode === "lease" && timing.hardEnd !== null) {
		// A resend has no planning instant (`at: null`); there only the stored ends tell.
		capped = view.at !== null && ttlMs !== null ? view.at + ttlMs > timing.hardEnd : timing.leaseEnd === timing.hardEnd;
	}
	return { status: view.status, claimGeneration: view.claimGeneration, timing, capped };
}

function actionOfCommand(command: ClaimCommand): ClaimTransitionAction | undefined {
	return member(ACTIONS, command);
}

// ---------------------------------------------------------------------------------------------------------------
// Pure mappers.
// ---------------------------------------------------------------------------------------------------------------

function rejectionOf(outcome: OperationOutcome, storage: ClaimStorageView): ClaimRejectionView | null {
	if (storage.kind === "rejected") return { stage: "storage", cause: storage.cause };
	const notStored =
		storage.kind === "queried" && storage.query.kind === "resolved" && storage.query.resolution === "not-stored";
	return outcome === "rejected" && notStored ? { stage: "resolution", cause: "not-stored" } : null;
}

/** The `transition` of a T call, field by field; undefined when any value is out of range. */
function transitionView(fact: NonNullable<Operation["transition"]>): ClaimOperationDocument["transition"] {
	const phase = member(PHASES, fact.phase);
	const id = fact.confirmOperationId;
	const confirmation = fact.confirmation === null ? null : storageView(fact.confirmation);
	if (phase === undefined || confirmation === undefined || (id !== null && !validOperationId(id))) return undefined;
	if (!safeInteger(fact.observeBefore) || !safeInteger(fact.reclaimBoundary)) return undefined;
	const { observeBefore, reclaimBoundary } = fact;
	return { phase, confirmOperationId: id, observeBefore, reclaimBoundary, confirmation };
}

function operationDocument(
	command: ClaimCommand,
	ticket: string,
	result: Operation,
	planned: ClaimPlannedDisplay | null,
	stoppedBy: StopCause,
): ClaimOperationDocument | ClaimErrorDocument {
	const action = member(ACTIONS, result.action);
	const outcome = member(OUTCOMES, result.outcome.kind);
	const storage = storageView(result.storage);
	const stop = outcome === "unknown" ? member(STOP_CAUSES, stoppedBy) : undefined;
	const transition = result.transition === undefined ? undefined : transitionView(result.transition);
	if (
		!action ||
		!outcome ||
		!storage ||
		!safeInteger(result.sends) ||
		!validOperationId(result.operationId) ||
		(result.transition !== undefined && transition === undefined)
	) {
		return errorDocument(command, "internal", ticket, null);
	}
	const document: ClaimOperationDocument = {
		schemaVersion: 1,
		kind: "claim-operation",
		status: OUTCOME_STATUS[outcome],
		command,
		action,
		ticket,
		operationId: result.operationId,
		outcome,
		rejection: rejectionOf(outcome, storage),
		storage,
		sends: result.sends,
		stoppedBy: stop ?? null,
		planned: plannedCopy(planned),
		rights: rightsView(result.rights),
	};
	// Additive, only on a T call; a D document keeps exactly its base keys.
	if (transition !== undefined) document.transition = transition;
	return document;
}

/** A plan rejection persists nothing, so it carries no operation ID. */
function notPlannedDocument(
	command: ClaimCommand,
	ticket: string,
	result: NotPlanned,
): ClaimOperationDocument | ClaimErrorDocument {
	const { plan } = result;
	if (plan.kind !== "rejected") {
		return errorDocument(command, PLAN_FAILURE_CODES[plan.kind] ?? "internal", ticket, null);
	}
	const action = actionOfCommand(command);
	const cause = member(PLAN_CAUSES, plan.cause);
	if (action === undefined || cause === undefined) return errorDocument(command, "internal", ticket, null);
	const rejection: ClaimRejectionView = { stage: "plan", cause };
	if ("boundary" in plan && safeInteger(plan.boundary)) rejection.boundary = plan.boundary;
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "rejected",
		command,
		action,
		ticket,
		operationId: null,
		outcome: "rejected",
		rejection,
		storage: null,
		sends: 0,
		stoppedBy: null,
		planned: null,
		rights: rightsView(result.rights),
	};
}

/** Operation IDs of an outstanding pause are data; an unknown pause drops its reason. */
function pauseDocument(command: ClaimCommand, ticket: string, result: Paused): ClaimPauseDocument | ClaimErrorDocument {
	const action = actionOfCommand(command);
	if (action === undefined) return errorDocument(command, "internal", ticket, null);
	let pause: ClaimPauseView = { kind: "unknown" };
	if (result.pause.kind === "outstanding") {
		pause = { kind: "outstanding", operationIds: result.pause.operationIds.filter(validOperationId) };
	}
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command,
		action,
		ticket,
		operationId: null,
		pause,
		rights: rightsView(result.rights),
	};
}

/**
 * `operationId` is the requested ID of `retry`; errors echo it, a mutation
 * leaves it out because a failure before the pause has persisted nothing.
 */
export function claimOperationDocument(input: {
	command: ClaimCommand;
	ticket: string;
	result: ClaimExecutionResult;
	planned: ClaimPlannedDisplay | null;
	stoppedBy: StopCause;
	operationId?: string | null;
}): ClaimOperationDocument | ClaimPauseDocument | ClaimErrorDocument {
	const { command, ticket, result } = input;
	switch (result.kind) {
		case "operation":
			return operationDocument(command, ticket, result, input.planned, input.stoppedBy);
		case "not-planned":
			return notPlannedDocument(command, ticket, result);
		case "paused":
			return pauseDocument(command, ticket, result);
		default:
			return errorDocument(command, TOP_LEVEL_CODES[result.kind] ?? "internal", ticket, input.operationId ?? null);
	}
}

/** Every non-ready preflight verdict is refused or unavailable with its own code. */
export function claimPreflightError(input: {
	command: ClaimCommand;
	ticket: string | null;
	verdict: PreflightFailure;
	operationId?: string | null;
}): ClaimErrorDocument {
	const { command, ticket, verdict } = input;
	const operationId = input.operationId ?? null;
	switch (verdict.kind) {
		case "config-invalid": {
			const problems = problemsView(verdict.problems);
			return errorDocument(command, "config-invalid", ticket, operationId, { problems });
		}
		case "format-mismatch": {
			const formats = formatPair(verdict.configured, verdict.descriptor.format);
			return errorDocument(command, "format-mismatch", ticket, operationId, formats);
		}
		default:
			return errorDocument(command, PREFLIGHT_CODES[verdict.kind] ?? "internal", ticket, operationId);
	}
}

const RESOLVED_OUTCOMES: Record<ClaimResolutionKind, ClaimResolutionDocument["outcome"]> = {
	stored: "applied",
	"not-stored": "rejected",
	open: "unknown",
	conflict: "unknown-history",
	"unknown-history": "unknown-history",
	unknown: "unknown",
	invalid: "unknown",
};

/**
 * Resolve: `resolved/open` is unknown/3; nothing is ever sent. The composite answer of a
 * T call's P ID gives the logical outcome, P's single resolution as `query` and `transition`.
 */
export function claimResolutionDocument(input: {
	operationId: string;
	ticket: string | null;
	action: ClaimTransitionAction | null;
	result: ClaimMutationQueryResult | ClaimTransitionQueryResult;
}): ClaimResolutionDocument | ClaimErrorDocument {
	const { operationId, ticket, action, result } = input;
	const refuse = (code: ClaimErrorCode) => errorDocument("resolve", code, ticket, operationId);
	switch (result.kind) {
		case "record-absent":
			return refuse("operation-not-found");
		case "record-corrupt":
			return refuse("record-corrupt");
		case "invalid":
			return refuse("scope-mismatch");
		case "unavailable":
			return refuse("local-unavailable");
		case "unsupported":
			return refuse("schema-unsupported");
	}
	let query = queryView(result);
	let outcome: ClaimResolutionDocument["outcome"] = "unknown";
	let transition: ClaimResolutionDocument["transition"];
	const composite = result.kind === "resolved" ? result.resolution : undefined;
	if (composite !== undefined && "phase" in composite) {
		const phase = member(PHASES, composite.phase);
		const logical = member(LOGICAL_OUTCOMES, composite.kind);
		const single = member(RESOLUTION_KINDS, composite.transition);
		if (phase === undefined || logical === undefined || single === undefined) return refuse("internal");
		const witnessed = phase === "witnessed" || phase === "confirmed";
		query = { kind: "resolved", resolution: single };
		outcome = logical;
		transition = { phase, confirmOperationId: witnessed ? claimConfirmationId(operationId) : null };
	} else if (query.kind === "resolved") outcome = RESOLVED_OUTCOMES[query.resolution];
	else if (query.kind === "unknown-history") outcome = "unknown-history";
	if (ticket === null || action === null) return refuse("internal");
	const document: ClaimResolutionDocument = {
		schemaVersion: 1,
		kind: "claim-resolution",
		status: outcome,
		command: "resolve",
		operationId,
		ticket,
		action,
		outcome,
		query,
	};
	if (transition !== undefined) document.transition = transition;
	return document;
}

/** Init: an unknown push outcome stays `init-unknown`, never ok. */
export function claimInitDocument(result: ClaimCoordinationInitResult): ClaimInitDocument | ClaimErrorDocument {
	switch (result.kind) {
		case "created":
		case "exists": {
			const format = member(FORMATS, result.descriptor.format);
			const { epoch } = result.descriptor;
			if (format === undefined || !safeInteger(epoch)) return errorDocument("init", "internal", null, null);
			return {
				schemaVersion: 1,
				kind: "claim-init",
				status: "ok",
				command: "init",
				result: result.kind,
				format,
				epoch,
			};
		}
		case "conflict": {
			const formats = formatPair(result.configured, result.descriptor.format);
			return errorDocument("init", "format-conflict", null, null, formats);
		}
		case "config-invalid": {
			const problems = problemsView(result.problems);
			return errorDocument("init", "config-invalid", null, null, { problems });
		}
		default:
			return errorDocument("init", INIT_CODES[result.kind] ?? "internal", null, null);
	}
}

export function claimExitCode(document: ClaimDocument): number {
	return CLAIM_EXIT_CODES[document.status] ?? 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared steps of the commands: input checks without IO, configuration, journal lookups.
// ---------------------------------------------------------------------------------------------------------------

const SURFACE_KEY_NAMES = {
	clockUncertaintyMs: "claims.clock_uncertainty_ms",
	retryPauseBaseMs: "claims.retry_pause_base_ms",
	retryPauseMaxMs: "claims.retry_pause_max_ms",
} as const;
type SurfaceField = keyof typeof SURFACE_KEY_NAMES;
const MUTATION_FIELDS: readonly SurfaceField[] = ["clockUncertaintyMs", "retryPauseBaseMs", "retryPauseMaxMs"];

// The raw options of the mutating commands and which command uses which.
type OptionField =
	| "owner"
	| "ttlMs"
	| "hardEnd"
	| "toContext"
	| "timeBox"
	| "mode"
	| "leaseEnd"
	| "graceMs"
	/** Emergency-release only. */
	| "expectRoot";
type BoundMode = "lease" | "hard" | "none";
type Instants = { hardEnd: number | null; leaseEnd: number | null };
const ADMINISTRATION_COMMANDS: readonly ClaimMutationCommand[] = [
	"transfer",
	"resume",
	"change-bounds",
	"emergency-release",
];
/** The administration fields; a base verb refuses them, its own base fields stay lenient. */
const ADMINISTRATION_FIELDS: readonly OptionField[] = [
	"toContext",
	"timeBox",
	"mode",
	"leaseEnd",
	"graceMs",
	"expectRoot",
];
const OPTION_FIELDS: readonly OptionField[] = ["owner", "ttlMs", "hardEnd", ...ADMINISTRATION_FIELDS];
const COMMAND_FIELDS: Record<ClaimMutationCommand, readonly OptionField[]> = {
	acquire: ["owner", "ttlMs", "hardEnd"],
	renew: ["ttlMs"],
	release: [],
	reclaim: [],
	// `hardEnd` sets the new hard end of a restart only; preserve and no time box refuse it.
	transfer: ["toContext", "owner", "timeBox", "ttlMs", "hardEnd"],
	resume: [],
	"change-bounds": ["mode", "leaseEnd", "hardEnd", "graceMs"],
	"emergency-release": ["expectRoot"],
};
const BOUND_MODES: readonly BoundMode[] = ["lease", "hard", "none"];
const BOUNDS_FIELDS: Record<BoundMode, readonly OptionField[]> = {
	lease: ["mode", "leaseEnd", "hardEnd", "graceMs"],
	hard: ["mode", "hardEnd", "graceMs"],
	none: ["mode"],
};
const TIME_BOX_ACTIONS: readonly ClaimTimeBoxRequest["action"][] = ["preserve", "restart"];

/** ISO-8601 with a date, a time and a zone; `Date.parse` decides validity afterwards. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A context ID as `createClaimContext` makes it: a lowercase UUID. */
const CONTEXT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function canonicalTicket(input: string, prefix: string): string | undefined {
	if (typeof input !== "string" || !isValidTaskId(input)) return undefined;
	const ticket = canonicalTaskId(input, prefix);
	return validTicket(ticket) ? ticket : undefined;
}

/** The handle travels only as an explicit absolute `--context`; nothing is derived or repaired. */
function contextCode(context: string | undefined): ClaimErrorCode | undefined {
	if (context === undefined || context === "") return "context-required";
	return isAbsolute(context) && !context.includes("\0") ? undefined : "context-invalid";
}

/** The receiving context, like `--context` only as an explicit absolute path, never derived. */
function validTarget(target: string | undefined): target is string {
	return target !== undefined && target !== "" && isAbsolute(target) && !target.includes("\0");
}

function optionalPositive(value: number | undefined): boolean {
	return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

/** The grace of a bound change may be zero. */
function optionalGrace(value: number | undefined): boolean {
	return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

/** For `--hard-end` and `--lease-end`: absent is null, a present instant needs ISO-8601 with a zone. */
function optionalInstant(text: string | undefined): number | null | undefined {
	if (text === undefined) return null;
	if (!ISO_WITH_ZONE.test(text)) return undefined;
	const value = Date.parse(text);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A field is foreign when the command does not use it. The base verbs keep their leniency for the base
 * fields and refuse only the administration ones; the three administration commands refuse every field they do not
 * use, change-bounds per `--mode` (a missing mode is left to the completeness check).
 */
function foreignField(input: ClaimMutationInput): boolean {
	const administration = member(ADMINISTRATION_COMMANDS, input.command) !== undefined;
	const checked = administration ? OPTION_FIELDS : ADMINISTRATION_FIELDS;
	let used = COMMAND_FIELDS[input.command];
	const mode = member(BOUND_MODES, input.mode);
	if (input.command === "change-bounds" && mode !== undefined) used = BOUNDS_FIELDS[mode];
	return checked.some((name) => !used.includes(name) && input[name] !== undefined);
}

/** `--mode` and, for lease and hard, the end of that mode and `--grace-ms`; never filled in. */
function boundsMissing(input: ClaimMutationInput): boolean {
	if (input.mode === undefined) return true;
	if (input.mode === "none") return false;
	if (input.graceMs === undefined) return true;
	return input.mode === "hard" ? input.hardEnd === undefined : input.leaseEnd === undefined;
}

/** The complete absolute target of the given mode in state form, checked by the rights validator. */
function boundsTiming(input: ClaimMutationInput, instants: Instants): ClaimTiming | undefined {
	const { leaseEnd, hardEnd } = instants;
	const { graceMs } = input;
	let timing: ClaimTiming;
	if (input.mode === "none") {
		timing = { mode: "none" };
	} else if (input.mode === "hard" && hardEnd !== null && graceMs !== undefined) {
		timing = { mode: "hard", hardEnd, graceMs };
	} else if (input.mode === "lease" && leaseEnd !== null && graceMs !== undefined) {
		timing = { mode: "lease", leaseEnd, graceMs, hardEnd };
	} else {
		return undefined;
	}
	return isClaimTiming(timing) ? timing : undefined;
}

/**
 * The advisory pre-check of transfer and resume, read only through `io`. The own context comes first
 * with the preflight's codes; resume then needs a recovery proof (never read here), transfer a loadable target with
 * another binding. The target's journal is never opened; the executor checks the same facts again.
 */
async function administrationCheck(
	resume: boolean,
	context: string,
	target: string | undefined,
	io: typeof claimContextIO | undefined,
): Promise<ClaimErrorCode | undefined> {
	const own = await loadClaimContext({ directory: context, io });
	if (own.kind !== "loaded") return CONTEXT_CODES[own.kind];
	if (resume) return own.context.recovery === null ? "recovery-missing" : undefined;
	if (target === undefined) return "target-context-invalid";
	const loaded = await loadClaimContext({ directory: target, io });
	if (loaded.kind !== "loaded") {
		return loaded.kind === "unavailable" ? "target-context-unavailable" : "target-context-invalid";
	}
	return loaded.context.binding === own.context.binding ? "target-context-invalid" : undefined;
}

/**
 * The emergency release's authorisation, local and before any Git command or record. The operator
 * context's authority ID must be listed in `claims.recovery_authorities`; an absent key authorises nobody. A context
 * that cannot be read keeps the context codes.
 */
async function authorityCode(
	context: string,
	settings: ClaimSettings,
	io: typeof claimContextIO | undefined,
): Promise<ClaimErrorCode | undefined> {
	const derived = await claimContextAuthority({ directory: context, io });
	if (derived.kind !== "derived") return CONTEXT_CODES[derived.kind];
	return settings.recoveryAuthorities?.includes(derived.authorityId) === true ? undefined : "authority-required";
}

/** The configuration resolver first; a not-configured or invalid block ends the command before any network. */
function configuredSettings(
	command: ClaimCommand,
	ticket: string | null,
	operationId: string | null,
	claimsYaml: string | undefined,
): ClaimSettings | ClaimErrorDocument {
	const resolved = resolveClaimSettings(claimsYaml);
	if (resolved.kind === "not-configured") return errorDocument(command, "not-configured", ticket, operationId);
	if (resolved.kind === "config-invalid") {
		return errorDocument(command, "config-invalid", ticket, operationId, { problems: problemsView(resolved.problems) });
	}
	return resolved.settings;
}

/** The surface requires the keys the resolver leaves optional, as `missing`, without network. */
function missingKeys(
	command: ClaimCommand,
	ticket: string | null,
	operationId: string | null,
	settings: ClaimSettings,
	fields: readonly SurfaceField[],
): ClaimErrorDocument | undefined {
	const missing = fields.filter((field) => settings[field] === undefined);
	if (missing.length === 0) return undefined;
	const problems = missing.map((field): ClaimProblemView => ({ key: SURFACE_KEY_NAMES[field], problem: "missing" }));
	return errorDocument(command, "config-invalid", ticket, operationId, { problems });
}

/**
 * The transition request from the options and the configured lifetime mode, as plain
 * object literals. transfer takes only its time-box policy and default lease from the configuration; change-bounds
 * takes nothing from the configuration or the stored state.
 */
function requestOf(
	input: ClaimMutationInput,
	settings: ClaimSettings,
	instants: Instants,
): ClaimTransitionRequest | ClaimErrorCode {
	const { lifetime } = settings;
	const { hardEnd } = instants;
	switch (input.command) {
		case "acquire": {
			let timing: ClaimTimingRequest;
			if (lifetime.mode === "lease") {
				const ttlSource = input.ttlMs === undefined ? "default" : "explicit";
				const ttlMs = input.ttlMs ?? lifetime.leaseTtlMs;
				timing = { mode: "lease", ttlMs, ttlSource, graceMs: lifetime.reclaimGraceMs, hardEnd };
			} else if (lifetime.mode === "hard") {
				if (input.ttlMs !== undefined) return "option-not-applicable";
				if (hardEnd === null) return "hard-end-required";
				timing = { mode: "hard", hardEnd, graceMs: lifetime.reclaimGraceMs };
			} else {
				if (input.ttlMs !== undefined || hardEnd !== null) return "option-not-applicable";
				timing = { mode: "none" };
			}
			return { action: "acquire", owner: input.owner ?? "", timing };
		}
		case "renew": {
			// A stored lease keeps its mode; without a configured lease TTL it needs --ttl-ms.
			const ttlMs = input.ttlMs ?? (lifetime.mode === "lease" ? lifetime.leaseTtlMs : undefined);
			if (ttlMs === undefined) return "invalid-option";
			return { action: "renew", ttlMs, ttlSource: input.ttlMs === undefined ? "default" : "explicit" };
		}
		case "release":
			return { action: "release" };
		case "reclaim":
			return { action: "reclaim" };
		case "transfer": {
			// explicit ?? policy ?? null; require-explicit and an absent key both leave `timeBox: null`.
			const explicit = member(TIME_BOX_ACTIONS, input.timeBox);
			const policy = member(TIME_BOX_ACTIONS, settings.transferTimeBox);
			let timeBox: ClaimTimeBoxRequest | null = null;
			if (explicit !== undefined) timeBox = { action: explicit, source: "explicit" };
			else if (policy !== undefined) timeBox = { action: policy, source: "policy" };
			// `--hard-end` only on a resolved restart, explicit or configured; the planner freezes it.
			if (hardEnd !== null) {
				if (timeBox === null || timeBox.action !== "restart") return "option-not-applicable";
				timeBox = { action: "restart", source: timeBox.source, hardEnd };
			}
			// No local refusal without a TTL: the planner decides by the stored mode (lease-required, not-renewable).
			let lease: ClaimLeaseRequest | null = null;
			if (input.ttlMs !== undefined) lease = { ttlMs: input.ttlMs, ttlSource: "explicit" };
			else if (lifetime.mode === "lease") lease = { ttlMs: lifetime.leaseTtlMs, ttlSource: "default" };
			return { action: "transfer", owner: input.owner ?? "", timeBox, lease };
		}
		case "resume":
			// The recovery proof is the executor's to read; the surface never touches `recovery.binding`.
			return { action: "resume" };
		case "change-bounds": {
			const timing = boundsTiming(input, instants);
			return timing === undefined ? "invalid-option" : { action: "change-bounds", timing };
		}
		// The root's form was checked in step 1; a preview carries no root and never reaches the executor.
		case "emergency-release":
			return { action: "emergency-release", expectedRoot: input.expectRoot ?? "" };
	}
}

/** Transfer shows `capped` like renew; resume and change-bounds by the stored ends. */
function ttlOf(request: ClaimTransitionRequest): number | null {
	if (request.action === "renew") return request.ttlMs;
	if (request.action === "acquire" && request.timing.mode === "lease") return request.timing.ttlMs;
	if (request.action === "transfer" && request.lease !== null) return request.lease.ttlMs;
	return null;
}

/** The recorded intent of an operation ID in the context's journal, or the code of why it cannot be read. */
async function loadRecord(
	journalDirectory: string,
	operationId: string,
	io: typeof claimJournalIO | undefined,
): Promise<ClaimIntentRecord | ClaimErrorCode> {
	const opened = await openClaimIntentJournal({ directory: journalDirectory, io });
	if (opened.kind !== "open") return "local-unavailable";
	const loaded = await opened.journal.load(operationId);
	switch (loaded.kind) {
		case "loaded":
			return loaded.record;
		case "absent":
			return "operation-not-found";
		case "corrupt":
			return "record-corrupt";
		case "invalid":
			return "invalid-operation-id";
		default:
			return "local-unavailable";
	}
}

/** A caller's operation ID must be free in the journal before anything else happens with it. */
async function operationIdTaken(
	journalDirectory: string,
	operationId: string,
	io: typeof claimJournalIO | undefined,
): Promise<ClaimErrorCode | undefined> {
	const loaded = await loadRecord(journalDirectory, operationId, io);
	if (loaded === "operation-not-found") return undefined;
	if (loaded === "record-corrupt" || typeof loaded !== "string") return "operation-id-in-use";
	return loaded;
}

/**
 * `budget` for a gate that stopped and for an unknown outcome reached past the deadline (bud-03);
 * `attempts` for an intent still open after the last permitted send.
 * A T call reads A's fact once a witness has one.
 */
function stopCause(
	result: ClaimExecutionResult,
	schedule: { stoppedBy(): "budget" | null },
	expired: boolean,
	attempts: number,
): StopCause {
	if (result.kind !== "operation" || result.outcome.kind !== "unknown") return null;
	if (schedule.stoppedBy() === "budget" || expired) return "budget";
	const storage = result.transition?.confirmation ?? result.storage;
	const open =
		storage.kind === "queried" &&
		storage.after === "unknown" &&
		storage.query.kind === "resolved" &&
		storage.query.resolution.kind === "open";
	return open && result.sends >= attempts ? "attempts" : null;
}

type ReadyPreflight = Extract<ClaimPreflightResult, { kind: "ready" }>;

/** A ready verdict with the context every mutating command and `resolve` requires. */
function contextOf(verdict: ReadyPreflight): ClaimContext | undefined {
	return verdict.context ?? undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// `runClaim*`: the entry points `src/commands/claim.ts` calls.
// ---------------------------------------------------------------------------------------------------------------

export type ClaimMutationCommand =
	| "acquire"
	| "renew"
	| "release"
	| "reclaim"
	| "transfer"
	| "resume"
	| "change-bounds"
	/** The eighth transition action. */
	| "emergency-release";

/** Raw options; the core validates each one, so an MCP caller's bad value is a refusal, never a type error. */
export type ClaimMutationInput = {
	command: ClaimMutationCommand;
	ticket: string;
	context: string;
	/** acquire, transfer: a display name only. */
	owner?: string;
	/** acquire, renew, transfer. */
	ttlMs?: number;
	/** acquire, change-bounds: ISO-8601 with a zone. */
	hardEnd?: string;
	/** transfer: absolute path of the receiving context; read once, never printed. */
	toContext?: string;
	/** transfer: `preserve` or `restart`. */
	timeBox?: string;
	/** change-bounds: `lease`, `hard` or `none`. */
	mode?: string;
	/** change-bounds: ISO-8601 with a zone. */
	leaseEnd?: string;
	/** change-bounds: integer >= 0. */
	graceMs?: number;
	expectGeneration?: number;
	/** Emergency-release only; the exact current root from --preview, 40 or 64 hex. */
	expectRoot?: string;
	/** Emergency-release only; the read-only preview; never combined with expectRoot. */
	preview?: boolean;
	operationId?: string;
};

/**
 * Local checks, configuration, local ticket and the dependency gate of
 * acquire, the context pre-check of transfer and resume, preflight, budget, operation ID, executor, mapping.
 */
export async function runClaimMutation(
	input: ClaimMutationInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimOperationDocument | ClaimPauseDocument | ClaimEmergencyPreviewDocument | ClaimErrorDocument> {
	try {
		return await mutate(input, env);
	} catch {
		return errorDocument(input.command, "internal", null, null);
	}
}

/**
 * Only `emergency-release` answers a preview; the acquire of `claim next` and the reclaim
 * of `reclaim-batch` never reach it, so this branch is defensive and review-only.
 */
async function mutationOnly(
	input: ClaimMutationInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimOperationDocument | ClaimPauseDocument | ClaimErrorDocument> {
	const document = await runClaimMutation(input, env);
	if (document.kind === "claim-emergency-preview") return errorDocument(input.command, "internal", null, null);
	return document;
}

async function mutate(
	input: ClaimMutationInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimOperationDocument | ClaimPauseDocument | ClaimEmergencyPreviewDocument | ClaimErrorDocument> {
	// Step 0: the budget starts first, so it includes the preflight.
	const startedAt = env.monotonicNow();
	const { command } = input;
	const typed = canonicalTicket(input.ticket, env.taskPrefix);
	const refuse = (code: ClaimErrorCode) => errorDocument(command, code, typed ?? null, null);

	// Step 1: input checks without IO, in a fixed order.
	if (typed === undefined) return refuse("invalid-ticket");
	const needsOwner = command === "acquire" || command === "transfer";
	if (needsOwner && (typeof input.owner !== "string" || input.owner.trim() === "")) return refuse("owner-required");
	const contextProblem = contextCode(input.context);
	if (contextProblem !== undefined) return refuse(contextProblem);
	// The release takes exactly one of --preview and --expect-root, and the root is a full OID.
	const release = command === "emergency-release";
	if (release && (input.expectRoot !== undefined) === (input.preview === true)) return refuse("expectation-required");
	if (release && input.expectRoot !== undefined && !validRoot(input.expectRoot)) return refuse("invalid-option");
	// The target is never derived; missing, empty, relative or with NUL it ends here, without IO.
	const target = command === "transfer" ? input.toContext : undefined;
	if (command === "transfer" && !validTarget(target)) return refuse("target-context-invalid");
	if (input.operationId !== undefined && !validOperationId(input.operationId)) return refuse("invalid-operation-id");
	const numbersValid =
		optionalPositive(input.ttlMs) && optionalPositive(input.expectGeneration) && optionalGrace(input.graceMs);
	if (!numbersValid) return refuse("invalid-option");
	const hardEnd = optionalInstant(input.hardEnd);
	const leaseEnd = optionalInstant(input.leaseEnd);
	if (hardEnd === undefined || leaseEnd === undefined) return refuse("invalid-option");
	if (input.timeBox !== undefined && member(TIME_BOX_ACTIONS, input.timeBox) === undefined) {
		return refuse("invalid-option");
	}
	if (input.mode !== undefined && member(BOUND_MODES, input.mode) === undefined) return refuse("invalid-option");
	// The release takes no generation expectation (its root is stricter), and its preview no operation ID
	// (it records nothing); no other command previews.
	const previewId = input.preview === true && input.operationId !== undefined;
	const foreignRelease = release ? input.expectGeneration !== undefined || previewId : input.preview !== undefined;
	if (foreignField(input) || foreignRelease) return refuse("option-not-applicable");
	// A new hard end never goes with an explicit preserve.
	if (command === "transfer" && input.hardEnd !== undefined && input.timeBox === "preserve") {
		return refuse("option-not-applicable");
	}
	if (command === "change-bounds" && boundsMissing(input)) return refuse("bounds-required");

	// Step 2: the configuration, read fresh by the caller; the surface keys are required here, the transfer
	// policy key only validated. The request includes the local timing check of change-bounds.
	const settings = configuredSettings(command, typed, null, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	const missing = missingKeys(command, typed, null, settings, MUTATION_FIELDS);
	if (missing !== undefined) return missing;
	const { clockUncertaintyMs, retryPauseBaseMs, retryPauseMaxMs } = settings;
	if (clockUncertaintyMs === undefined || retryPauseBaseMs === undefined || retryPauseMaxMs === undefined) {
		return refuse("internal");
	}
	const request = requestOf(input, settings, { hardEnd, leaseEnd });
	if (typeof request === "string") return refuse(request);

	// Step 3: only acquire needs a local task file, and it is looked up before any network.
	let ticket = typed;
	if (command === "acquire") {
		const found = await env.findLocalTicket(input.ticket);
		if (found.kind !== "found") return refuse(found.kind === "missing" ? "ticket-not-found" : "ticket-ambiguous");
		if (!validTicket(found.ticket)) return refuse("invalid-ticket");
		ticket = found.ticket;
		// Step 3a: the dependency gate, local, fail-closed and before any network; an absent
		// policy key is strict, `permissive` skips the gate and loads nothing. No other command checks.
		if (settings.acquireDependencyPolicy !== "permissive") {
			const refused = await dependencyGate(command, ticket, env);
			if (refused !== undefined) return refused;
		}
	}

	// Step 3b: the advisory context pre-check of transfer and resume, local and before any network.
	if (command === "transfer" || command === "resume") {
		const checked = await administrationCheck(command === "resume", input.context, target, env.contextIO);
		if (checked !== undefined) return refuse(checked);
	}

	// Step 3c: the release and its preview need the operator's listed authority, checked locally, so an
	// unauthorised call starts no Git command and records nothing.
	if (release) {
		const refused = await authorityCode(input.context, settings, env.contextIO);
		if (refused !== undefined) return refuse(refused);
	}

	// Step 4: the shared preflight with the command's purpose; every verdict but ready ends here. A restart with a
	// new hard end can extend a right, so it needs `enabled` like acquire. The emergency
	// release is `maintain`, so it runs under `enabled: false`.
	const acquiring = command === "acquire" || (command === "transfer" && hardEnd !== null);
	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: acquiring ? "acquire" : "maintain",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	if (verdict.kind !== "ready") return claimPreflightError({ command, ticket, verdict });
	// Step 5: the preview reads the ticket once and answers; no journal, intent, admission, pause or send.
	if (release && input.preview === true) {
		const [read] = await readAll(verdict.store, [ticket], () => false);
		return emergencyPreview(ticket, read?.observed ?? null);
	}
	const context = contextOf(verdict);
	if (context === undefined) return errorDocument(command, "internal", ticket, null);

	// Step 6: nothing is prepared once the budget is gone.
	const deadline = startedAt + settings.operationBudgetMs;
	if (env.monotonicNow() >= deadline) return errorDocument(command, "budget-exhausted", ticket, null);

	// Step 7: the caller's ID must be free in the journal; a generated one is `op-<uuid v4>`.
	let operationId: string;
	if (input.operationId === undefined) {
		operationId = env.newOperationId();
		if (!validOperationId(operationId)) return errorDocument(command, "internal", ticket, null);
	} else {
		const taken = await operationIdTaken(context.journalDirectory, input.operationId, env.journalIO);
		if (taken !== undefined) return errorDocument(command, taken, ticket, null);
		operationId = input.operationId;
	}

	// Step 8: the executor with the schedule and the display seam.
	const schedule = claimOperationSchedule({
		startedAt,
		budgetMs: settings.operationBudgetMs,
		attemptTimeoutMs: settings.attemptTimeoutMs,
		pause: { baseMs: retryPauseBaseMs, maxMs: retryPauseMaxMs },
		monotonicNow: env.monotonicNow,
		random: env.random,
		sleep: env.sleep,
	});
	const seen: { planned: ClaimPlannedDisplay | null } = { planned: null };
	const ttlMs = ttlOf(request);
	// The receiving context exactly for a transfer, by conditional spread, never as an explicit undefined.
	const receiver = target === undefined ? {} : { targetContextDirectory: target };
	let result: ClaimExecutionResult;
	try {
		result = await executeClaimTransition({
			storage: {
				repository: env.projectRoot,
				remote: settings.endpoint,
				format: settings.storageFormat,
				timeoutMs: schedule.commandTimeoutMs(),
			},
			ticket,
			contextDirectory: input.context,
			...receiver,
			contextIO: env.contextIO,
			journalIO: env.journalIO,
			operationId,
			request,
			clockSkewMs: clockUncertaintyMs,
			clock: env.clock,
			expectedClaimGeneration: input.expectGeneration,
			attempts: settings.attempts,
			schedule,
			onPlanned: (view) => {
				seen.planned = plannedDisplay(view, ttlMs);
			},
			// The time path follows `enabled`; with it off every extension stays `requires-time-path`.
			timePath: settings.enabled,
		});
	} catch {
		return unknownAfterStart(command, ticket, operationId);
	}

	// Step 9: the public document; an unexpected error from here on leaves the outcome unknown.
	try {
		const expired = env.monotonicNow() >= deadline;
		const stoppedBy = stopCause(result, schedule, expired, settings.attempts);
		return claimOperationDocument({ command, ticket, result, planned: seen.planned, stoppedBy });
	} catch {
		return unknownAfterStart(command, ticket, operationId);
	}
}

/**
 * The strict gate of a direct acquire over the whole local corpus (`loadLocalTickets(null)`), refused/5
 * with the canonical prerequisites, or `tasks-unavailable`/6 when the local tasks cannot be read; no record, no
 * network. `undefined` lets the acquire continue.
 */
async function dependencyGate(
	command: ClaimCommand,
	ticket: string,
	env: ClaimSurfaceEnv,
): Promise<ClaimErrorDocument | undefined> {
	const local = await env.loadLocalTickets(null);
	if (local.kind !== "loaded") return errorDocument(command, "tasks-unavailable", ticket, null);
	const verdict = claimDependencyVerdict({ ticket, corpus: local.corpus });
	if (!("blocking" in verdict)) return undefined;
	const code = verdict.kind === "blocked" ? "dependency-blocked" : "dependency-unknown";
	return errorDocument(command, code, ticket, null, { dependencies: verdict });
}

const NEXT_ORDERS: readonly ClaimNextOrder[] = ["priority", "age"];

/** The direct acquire one claim-next attempt runs; the raw options pass through so the base core checks them. */
function acquireInput(input: ClaimNextInput, ticket: string): ClaimMutationInput {
	const acquire: ClaimMutationInput = { command: "acquire", ticket, context: input.context, owner: input.owner };
	if (input.ttlMs !== undefined) acquire.ttlMs = input.ttlMs;
	if (input.hardEnd !== undefined) acquire.hardEnd = input.hardEnd;
	return acquire;
}

/**
 * The cross-ticket acquisition stop after a ready preflight, inside the pre-phase budget. One listing of
 * `refs/claims/*` and this context's journal feed the executor's `outstanding` predicate over every ticket; a listing
 * failure is `list-unavailable`, and a journal that cannot be opened counts as not enumerated (`unknown`).
 */
async function acquisitionStop(
	verdict: ReadyPreflight,
	settings: ClaimSettings,
	startedAt: number,
	env: ClaimSurfaceEnv,
): Promise<ClaimAcquireStop | ClaimErrorDocument> {
	const context = contextOf(verdict);
	if (context === undefined) return errorDocument("next", "internal", null, null);
	const deadline = startedAt + settings.operationBudgetMs;
	if (env.monotonicNow() >= deadline) return errorDocument("next", "budget-exhausted", null, null);
	const timeouts = claimOperationSchedule({
		startedAt,
		budgetMs: settings.operationBudgetMs,
		attemptTimeoutMs: settings.attemptTimeoutMs,
		pause: { baseMs: 0, maxMs: 0 },
		monotonicNow: env.monotonicNow,
		random: env.random,
		sleep: env.sleep,
	});
	const listed = await listClaimRefs({
		repository: env.projectRoot,
		remote: settings.endpoint,
		format: settings.storageFormat,
		timeoutMs: timeouts.commandTimeoutMs(),
	});
	if (listed.kind !== "listed") return errorDocument("next", "list-unavailable", null, null);
	const opened = await openClaimIntentJournal({ directory: context.journalDirectory, io: env.journalIO });
	const journal: ClaimIntentEnumerationResult =
		opened.kind === "open" ? await opened.journal.enumerate() : { kind: opened.kind, reason: opened.reason };
	return evaluateClaimAcquireStop({
		journal,
		remote: settings.endpoint,
		descriptor: verdict.descriptor,
		roots: listed.roots,
	});
}

/**
 * `claim next`. The pre-phase (own read budget) checks the input without IO, then the
 * configuration and the acquire request, selects locally (no network before an empty selection ends it), runs the
 * preflight with purpose `acquire` and the acquisition stop; then every candidate, at most `maxCandidates`, runs the
 * base acquire core with its own budget and operation ID until the continue/stop table stops. Errors before the loop
 * are one `claim-error`; a disabled block reaches the loop, whose first preflight refuses.
 */
export async function runClaimNext(
	input: ClaimNextInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimNextDocument | ClaimErrorDocument> {
	try {
		return await next(input, env);
	} catch {
		return errorDocument("next", "internal", null, null);
	}
}

async function next(input: ClaimNextInput, env: ClaimSurfaceEnv): Promise<ClaimNextDocument | ClaimErrorDocument> {
	// Step 0: the pre-phase budget starts first; every attempt starts its own.
	const startedAt = env.monotonicNow();
	const refuse = (code: ClaimErrorCode) => errorDocument("next", code, null, null);

	// Step 1: input checks without IO.
	if (typeof input.owner !== "string" || input.owner.trim() === "") return refuse("owner-required");
	const contextProblem = contextCode(input.context);
	if (contextProblem !== undefined) return refuse(contextProblem);
	const order = input.order === undefined ? "priority" : member(NEXT_ORDERS, input.order);
	const maxCandidates = input.maxCandidates ?? CLAIM_NEXT_BOUNDS.defaultMaxCandidates;
	const bounded =
		Number.isSafeInteger(maxCandidates) &&
		maxCandidates >= CLAIM_NEXT_BOUNDS.minMaxCandidates &&
		maxCandidates <= CLAIM_NEXT_BOUNDS.maxMaxCandidates;
	if (order === undefined || !bounded || !optionalPositive(input.ttlMs)) return refuse("invalid-option");
	const hardEnd = optionalInstant(input.hardEnd);
	if (hardEnd === undefined) return refuse("invalid-option");

	// Step 2: the configuration with the three surface keys every attempt needs; step 3: the acquire request.
	const settings = configuredSettings("next", null, null, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	const missing = missingKeys("next", null, null, settings, MUTATION_FIELDS);
	if (missing !== undefined) return missing;
	const request = requestOf(acquireInput(input, ""), settings, { hardEnd, leaseEnd: null });
	if (typeof request === "string") return refuse(request);

	// Step 4: the local selection over the shared filter and ready rule; an empty one ends here, without network.
	const local = await env.loadLocalTickets(input.selection);
	if (local.kind !== "loaded") return refuse("tasks-unavailable");
	const { matched, corpus, priorities } = local;
	const selection = selectClaimCandidates({ matched, corpus, priorities, order });
	const documentOf = (attempts: ClaimNextAttempt[], untried: number, stop: ClaimNextStop) =>
		claimNextDocument({ order, maxCandidates, selection, attempts, untried, stop });
	const { candidates } = selection;
	if (candidates.length === 0) return documentOf([], 0, { kind: "no-candidates" });

	// Step 5: the preflight with purpose `acquire`; a disabled block goes on to the first attempt, which refuses.
	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: "acquire",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	let maintenanceOperationIds: ReadonlySet<string> = new Set<string>();
	if (verdict.kind === "ready") {
		// Step 6: the cross-ticket acquisition stop; no operation ID is drawn before it clears.
		const stopped = await acquisitionStop(verdict, settings, startedAt, env);
		if (isErrorDocument(stopped)) return stopped;
		switch (stopped.kind) {
			case "outstanding": {
				const operationIds = stopped.operationIds;
				return documentOf([], candidates.length, { kind: "outstanding-acquire", operationIds });
			}
			case "unknown":
				return documentOf([], candidates.length, { kind: "journal-unknown" });
			case "invalid":
				return refuse("internal");
			case "clear":
				maintenanceOperationIds = new Set(stopped.maintenanceOperationIds);
				break;
		}
	} else if (verdict.kind !== "claims-disabled") {
		return claimPreflightError({ command: "next", ticket: null, verdict });
	}

	// Step 7: the bounded drive; each attempt is the base acquire core with its own budget and operation ID.
	const drive = await driveClaimNext({
		candidates,
		maxCandidates,
		maintenanceOperationIds,
		attempt: (ticket) => mutationOnly(acquireInput(input, ticket), env),
	});
	return documentOf(drive.attempts, drive.untried, { kind: drive.stop });
}

type ReclaimCommand = "reclaim-batch" | "reclaim-preview";

/** The one selection of batch and preview; `complete` counts skipped ref names only. */
type ReclaimSelection = { observedAt: number; complete: boolean; entries: ClaimReclaimPreviewEntry[] };

/** The read of a ticket as the pause rule observes it; any other read has no snapshot. */
function snapshotOf(observed: ClaimReadResult | null): ClaimSnapshot | undefined {
	if (observed === null) return undefined;
	switch (observed.kind) {
		case "absent":
		case "present":
			return observed;
		default:
			return undefined;
	}
}

/**
 * The canonical IDs of the local tasks the selection matches (`task list` without a selection for a lone
 * `--ready`), with `--ready` only those ready under the shared rule over the whole corpus.
 */
async function localReclaimTickets(
	scope: ResolvedReclaimScope,
	env: ClaimSurfaceEnv,
): Promise<ReadonlySet<string> | "unavailable"> {
	const local = await env.loadLocalTickets(scope.selection ?? { filter: {} });
	if (local.kind !== "loaded") return "unavailable";
	const graph = scope.ready ? createReadinessGraph(local.corpus) : null;
	const tickets = new Set<string>();
	for (const task of local.matched) {
		const ticket = ticketOf(task.id);
		if (ticket !== undefined && (graph === null || getTaskReadiness(task, graph).isReady)) tickets.add(ticket);
	}
	return tickets;
}

/**
 * The one selection of batch and preview. Scope, `--context` and the configuration are checked
 * before any IO; ticket filters and `--ready` read the local tasks before any network; then the
 * preflight (`maintain` for the batch, `observe` for the preview, both allowed under `enabled: false`). Explicit
 * tickets are read directly, every other scope starts with one `listClaimRefs`; the reads share one budget from the
 * start of the call, and one wall-clock read after them is `observedAt`. The preview adds this context's read-only
 * journal view. Every read becomes a verdict entry, or none when `--claim-owner` drops it.
 */
async function selectReclaim(
	command: ReclaimCommand,
	input: ClaimReclaimInput,
	env: ClaimSurfaceEnv,
): Promise<ReclaimSelection | ClaimErrorDocument> {
	const startedAt = env.monotonicNow();
	const refuse = (code: ClaimErrorCode) => errorDocument(command, code, null, null);
	const scope = claimReclaimScope(input.scope, env.taskPrefix);
	if (typeof scope === "string") return refuse(scope);
	const contextProblem = contextCode(input.context);
	if (contextProblem !== undefined) return refuse(contextProblem);
	const batch = command === "reclaim-batch";
	const settings = configuredSettings(command, null, null, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	const missing = missingKeys(command, null, null, settings, batch ? MUTATION_FIELDS : ["clockUncertaintyMs"]);
	if (missing !== undefined) return missing;
	const eps = settings.clockUncertaintyMs;
	if (eps === undefined) return refuse("internal");

	const local = scope.selection === null && !scope.ready ? null : await localReclaimTickets(scope, env);
	if (local === "unavailable") return refuse("tasks-unavailable");

	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: batch ? "maintain" : "observe",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	if (verdict.kind !== "ready") return claimPreflightError({ command, ticket: null, verdict });
	const context = contextOf(verdict);
	if (context === undefined) return refuse("internal");
	const deadline = startedAt + settings.operationBudgetMs;
	const timeouts = claimOperationSchedule({
		startedAt,
		budgetMs: settings.operationBudgetMs,
		attemptTimeoutMs: settings.attemptTimeoutMs,
		pause: { baseMs: 0, maxMs: 0 },
		monotonicNow: env.monotonicNow,
		random: env.random,
		sleep: env.sleep,
	});

	let complete = true;
	let tickets: string[];
	if (scope.tickets !== null) {
		tickets = scope.tickets;
	} else {
		const listed = await listClaimRefs({
			repository: env.projectRoot,
			remote: settings.endpoint,
			format: settings.storageFormat,
			timeoutMs: timeouts.commandTimeoutMs(),
		});
		if (listed.kind !== "listed") return refuse("list-unavailable");
		tickets = [...listed.tickets].sort(compareTaskIds);
		if (listed.skipped > 0) complete = false;
	}
	if (local !== null) tickets = tickets.filter((ticket) => local.has(ticket));

	const reads = await readAll(verdict.store, tickets, () => env.monotonicNow() >= deadline);
	const observedAt = env.clock();
	if (!safeInteger(observedAt)) return refuse("internal");
	let journal: ClaimIntentEnumerationResult | null = null;
	if (!batch) {
		const opened = await openClaimIntentJournal({ directory: context.journalDirectory, io: env.journalIO });
		journal = opened.kind === "open" ? await opened.journal.enumerate() : { kind: opened.kind, reason: opened.reason };
	}
	const entries: ClaimReclaimPreviewEntry[] = [];
	for (const { ticket, observed } of reads) {
		const snapshot = snapshotOf(observed);
		let pause: ClaimOperationPause | undefined;
		if (journal !== null && snapshot !== undefined) {
			const observation = { remote: settings.endpoint, descriptor: verdict.descriptor, snapshot };
			pause = evaluateClaimOperationPause({ journal, observation });
		}
		const entry = claimReclaimVerdict({
			ticket,
			descriptor: verdict.descriptor,
			observed,
			binding: context.binding,
			now: observedAt,
			clockSkewMs: eps,
			claimOwners: scope.claimOwners,
			pause,
		});
		if (entry !== null) entries.push(entry);
	}
	return { observedAt, complete, entries };
}

/** A candidate reclaimed with its selection generation, or a corrupt or unsupported state's refusal. */
type ReclaimCandidate = { ticket: string; expectGeneration: number } | { ticket: string; code: ClaimErrorCode };

/**
 * `claim reclaim-batch`. The shared selection fixes the candidates once: every
 * eligible ticket with its observed generation, plus every corrupt or unsupported state with the refusal the single
 * core gives it; unread tickets go to `unreadable`, never free, never tried. Each candidate then runs the base reclaim
 * core (`runClaimMutation` with `expectGeneration`): fresh read, plan, CAS, own operation ID and budget, pause and
 * admission per ticket. The closed stop list of `claimReclaimStops` ends the loop; later candidates are untried, and
 * nothing is rolled back. An unexpected error after the first single reclaim is `unknown`, before it `internal`.
 */
export async function runClaimReclaimBatch(
	input: ClaimReclaimInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimReclaimBatchDocument | ClaimErrorDocument> {
	const progress = { started: false };
	try {
		return await reclaimBatch(input, env, progress);
	} catch {
		if (progress.started) return unknownAfterStart("reclaim-batch", null, null);
		return errorDocument("reclaim-batch", "internal", null, null);
	}
}

async function reclaimBatch(
	input: ClaimReclaimInput,
	env: ClaimSurfaceEnv,
	progress: { started: boolean },
): Promise<ClaimReclaimBatchDocument | ClaimErrorDocument> {
	const selected = await selectReclaim("reclaim-batch", input, env);
	if (isErrorDocument(selected)) return selected;
	const candidates: ReclaimCandidate[] = [];
	const unreadable: string[] = [];
	for (const { ticket, verdict, claimGeneration } of selected.entries) {
		if (verdict === "state-corrupt" || verdict === "state-unsupported") {
			candidates.push({ ticket, code: verdict === "state-corrupt" ? "state-corrupt" : "state-unsupported" });
		} else if (verdict === "unknown") {
			unreadable.push(ticket);
		} else if (verdict === "eligible") {
			// Never a reclaim without the observed generation as its expectation.
			if (claimGeneration === undefined) unreadable.push(ticket);
			else candidates.push({ ticket, expectGeneration: claimGeneration });
		}
	}
	const entries: { ticket: string; document: ClaimReclaimEntryDocument | null }[] = [];
	let stoppedAt: string | null = null;
	for (const candidate of candidates) {
		const { ticket } = candidate;
		let document: ClaimReclaimEntryDocument | null = null;
		if (stoppedAt === null) document = await reclaimCandidate(candidate, input.context, env, progress);
		entries.push({ ticket, document });
		if (document !== null && claimReclaimStops(document)) stoppedAt = ticket;
	}
	const complete = selected.complete && unreadable.length === 0;
	return claimReclaimBatchDocument({ observedAt: selected.observedAt, complete, unreadable, stoppedAt, entries });
}

/** One candidate's document: the single core's refusal of a corrupt or unsupported state, else the reclaim itself. */
async function reclaimCandidate(
	candidate: ReclaimCandidate,
	context: string,
	env: ClaimSurfaceEnv,
	progress: { started: boolean },
): Promise<ClaimReclaimEntryDocument> {
	if ("code" in candidate) return errorDocument("reclaim", candidate.code, candidate.ticket, null);
	progress.started = true;
	const reclaim: ClaimMutationInput = {
		command: "reclaim",
		ticket: candidate.ticket,
		context,
		expectGeneration: candidate.expectGeneration,
	};
	return mutationOnly(reclaim, env);
}

/**
 * `claim reclaim-preview`, read-only: the same selection and verdicts as the batch, no prepare, no
 * admission, no operation ID, no store write. Incomplete (an unread ticket or a skipped ref name) is `unknown`/3 like
 * `claim list`; corrupt and unsupported states are verdicts, never incompleteness.
 */
export async function runClaimReclaimPreview(
	input: ClaimReclaimInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimReclaimPreviewDocument | ClaimErrorDocument> {
	try {
		const selected = await selectReclaim("reclaim-preview", input, env);
		if (isErrorDocument(selected)) return selected;
		const { observedAt, entries } = selected;
		const complete = selected.complete && entries.every((entry) => entry.verdict !== "unknown");
		return {
			schemaVersion: 1,
			kind: "claim-reclaim-preview",
			status: complete ? "ok" : "unknown",
			command: "reclaim-preview",
			complete,
			observedAt,
			entries,
		};
	} catch {
		return errorDocument("reclaim-preview", "internal", null, null);
	}
}

/**
 * Resends an existing intent from a new process; never pauses, plans or allocates a new ID.
 * `options.administrative` says the caller re-checked the release authority itself; only
 * `src/commands/claim.ts` sets it. Without it a record whose action is `emergency-release` ends `authority-required`
 * before any send, so MCP, which calls with two arguments, can never resend a release.
 */
export async function runClaimRetry(
	input: { operationId: string; context: string },
	env: ClaimSurfaceEnv,
	options?: { administrative?: boolean },
): Promise<ClaimOperationDocument | ClaimErrorDocument> {
	try {
		return await retry(input, env, options?.administrative === true);
	} catch {
		return errorDocument("retry", "internal", null, validOperationId(input.operationId) ? input.operationId : null);
	}
}

async function retry(
	input: { operationId: string; context: string },
	env: ClaimSurfaceEnv,
	administrative: boolean,
): Promise<ClaimOperationDocument | ClaimErrorDocument> {
	const command = "retry";
	const startedAt = env.monotonicNow();
	if (!validOperationId(input.operationId)) return errorDocument(command, "invalid-operation-id", null, null);
	const { operationId } = input;
	const contextProblem = contextCode(input.context);
	if (contextProblem !== undefined) return errorDocument(command, contextProblem, null, operationId);

	const settings = configuredSettings(command, null, operationId, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	const missing = missingKeys(command, null, operationId, settings, MUTATION_FIELDS);
	if (missing !== undefined) return missing;
	const { clockUncertaintyMs, retryPauseBaseMs, retryPauseMaxMs } = settings;
	if (clockUncertaintyMs === undefined || retryPauseBaseMs === undefined || retryPauseMaxMs === undefined) {
		return errorDocument(command, "internal", null, operationId);
	}

	// Maintain purpose: an acquire record additionally needs `enabled`, checked below.
	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: "maintain",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	if (verdict.kind !== "ready") return claimPreflightError({ command, ticket: null, verdict, operationId });
	const context = contextOf(verdict);
	if (context === undefined) return errorDocument(command, "internal", null, operationId);

	const record = await loadRecord(context.journalDirectory, operationId, env.journalIO);
	if (typeof record === "string") return errorDocument(command, record, null, operationId);
	const { intent } = record;
	if (!validTicket(intent.ticket) || member(ACTIONS, intent.action) === undefined) {
		return errorDocument(command, "record-corrupt", null, operationId);
	}
	const ticket = intent.ticket;
	// A release record resends only for a caller that re-checked the authority, before any other check.
	if (intent.action === "emergency-release" && !administrative) {
		return errorDocument(command, "authority-required", ticket, operationId);
	}
	// A record of another endpoint or format is never resent there.
	if (intent.remote !== settings.endpoint || intent.format !== settings.storageFormat) {
		return errorDocument(command, "scope-mismatch", ticket, operationId);
	}
	// A record of another epoch is out of scope too, but no refusal: resendClaimIntent compares the
	// same epochs and answers it unknown-history/4, unsent. So the `enabled` gate of a send below does not apply to it.
	const otherEpoch = intent.epoch !== verdict.descriptor.epoch;
	// An acquire record, and the P record of a T call (its successor is PENDING), need `enabled`; an A record does
	// not, so a witness is never stranded by a disabled block.
	const enabling = intent.action === "acquire" || claimTransitionOf(record) !== undefined;
	if (!otherEpoch && enabling && !settings.enabled) {
		return errorDocument(command, "claims-disabled", ticket, operationId);
	}
	const deadline = startedAt + settings.operationBudgetMs;
	if (env.monotonicNow() >= deadline) return errorDocument(command, "budget-exhausted", ticket, operationId);

	const schedule = claimOperationSchedule({
		startedAt,
		budgetMs: settings.operationBudgetMs,
		attemptTimeoutMs: settings.attemptTimeoutMs,
		pause: { baseMs: retryPauseBaseMs, maxMs: retryPauseMaxMs },
		monotonicNow: env.monotonicNow,
		random: env.random,
		sleep: env.sleep,
	});
	const seen: { planned: ClaimPlannedDisplay | null } = { planned: null };
	let result: ClaimExecutionResult;
	try {
		result = await resendClaimIntent({
			storage: {
				repository: env.projectRoot,
				remote: settings.endpoint,
				format: settings.storageFormat,
				timeoutMs: schedule.commandTimeoutMs(),
			},
			contextDirectory: input.context,
			contextIO: env.contextIO,
			journalIO: env.journalIO,
			operationId,
			clockSkewMs: clockUncertaintyMs,
			clock: env.clock,
			attempts: settings.attempts,
			schedule,
			onPlanned: (view) => {
				seen.planned = plannedDisplay(view, null);
			},
		});
	} catch {
		return unknownAfterStart(command, ticket, operationId);
	}
	try {
		const expired = env.monotonicNow() >= deadline;
		const stoppedBy = stopCause(result, schedule, expired, settings.attempts);
		const document = claimOperationDocument({ command, ticket, result, planned: seen.planned, stoppedBy, operationId });
		// A resend never pauses and never ends not-planned; either would be a defect, never a document.
		return document.kind === "claim-pause" ? errorDocument(command, "internal", ticket, operationId) : document;
	} catch {
		return unknownAfterStart(command, ticket, operationId);
	}
}

/** The query of one recorded operation; read-only, never pauses and never sends. */
export async function runClaimResolve(
	input: { operationId: string; context: string },
	env: ClaimSurfaceEnv,
): Promise<ClaimResolutionDocument | ClaimErrorDocument> {
	const command = "resolve";
	try {
		if (!validOperationId(input.operationId)) return errorDocument(command, "invalid-operation-id", null, null);
		const { operationId } = input;
		const contextProblem = contextCode(input.context);
		if (contextProblem !== undefined) return errorDocument(command, contextProblem, null, operationId);
		const settings = configuredSettings(command, null, operationId, env.claimsYaml);
		if (isErrorDocument(settings)) return settings;
		// Any verdict other than ready is refused or unavailable, never a guessed history.
		const verdict = await preflightClaimStorage({
			claimsYaml: env.claimsYaml,
			repository: env.projectRoot,
			purpose: "observe",
			contextDirectory: input.context,
			contextIO: env.contextIO,
		});
		if (verdict.kind !== "ready") return claimPreflightError({ command, ticket: null, verdict, operationId });
		const context = contextOf(verdict);
		if (context === undefined) return errorDocument(command, "internal", null, operationId);
		const record = await loadRecord(context.journalDirectory, operationId, env.journalIO);
		if (typeof record === "string") return errorDocument(command, record, null, operationId);
		const { intent } = record;
		const action = member(ACTIONS, intent.action);
		if (!validTicket(intent.ticket) || action === undefined) {
			return errorDocument(command, "record-corrupt", null, operationId);
		}
		const query = {
			journalDirectory: context.journalDirectory,
			operationId,
			storage: {
				repository: env.projectRoot,
				remote: settings.endpoint,
				format: settings.storageFormat,
				timeoutMs: settings.attemptTimeoutMs,
			},
			journalIO: env.journalIO,
		};
		// A T call's P ID resolves as the composite; every other ID, an A ID included, as one mutation.
		const composite = claimTransitionOf(record) !== undefined;
		const result = composite ? await queryClaimTransition(query) : await queryClaimMutation(query);
		return claimResolutionDocument({ operationId, ticket: intent.ticket, action, result });
	} catch {
		return errorDocument(command, "internal", null, validOperationId(input.operationId) ? input.operationId : null);
	}
}

/** One list entry from one read; owner is display data here and nowhere else. */
function listEntry(
	ticket: string,
	observed: ClaimReadResult | null,
	rights: (observed: ClaimReadResult) => ClaimRightsView | undefined,
	epoch?: number,
): ClaimListEntry {
	if (observed === null || (observed.kind !== "absent" && observed.kind !== "present")) {
		return { ticket, state: "unknown" };
	}
	const view = rights(observed);
	const withRights = (entry: ClaimListEntry): ClaimListEntry => {
		if (view !== undefined) entry.rights = view;
		return entry;
	};
	if (observed.kind === "absent") return withRights({ ticket, state: "free" });
	const decoded = parseClaimState(observed.document.payload);
	if (decoded.kind !== "state") return { ticket, state: "unknown" };
	const { state } = decoded;
	if ("source" in state) {
		// An unresolved transition names both display names and the hull, never an owner or a timing.
		const reclaimBoundary = claimReclaimBoundary(state);
		if (reclaimBoundary === null) return { ticket, state: "unknown" };
		const { claimGeneration } = state;
		const transition = { from: state.source.owner, to: state.target.owner };
		return withRights({
			ticket,
			state: "pending",
			claimGeneration,
			...(epoch !== undefined ? { epoch } : {}),
			transition,
			reclaimBoundary,
		});
	}
	if (!("timing" in state)) {
		return withRights({
			ticket,
			state: "free",
			claimGeneration: state.claimGeneration,
			...(epoch !== undefined ? { epoch } : {}),
		});
	}
	const timing = timingView(state.timing);
	if (timing === undefined || typeof state.owner !== "string") return { ticket, state: "unknown" };
	return withRights({
		ticket,
		state: "active",
		owner: state.owner,
		claimGeneration: state.claimGeneration,
		...(epoch !== undefined ? { epoch } : {}),
		timing,
	});
}

/**
 * The only document that shows a root. State, owner and transition come from the list entry of the same
 * read, generation and epoch from the stored document; nothing else of the stored claim, no rights, no receipts.
 */
function emergencyPreview(ticket: string, observed: ClaimReadResult | null): ClaimEmergencyPreviewDocument {
	const envelope = {
		schemaVersion: 1,
		kind: "claim-emergency-preview",
		status: "ok",
		command: "emergency-release",
	} as const;
	const unread = { claimGeneration: null, epoch: null, root: null } as const;
	if (observed?.kind === "absent") return { ...envelope, ticket, state: "absent", ...unread };
	if (observed?.kind !== "present") return { ...envelope, ticket, state: "unknown", ...unread };
	const entry = listEntry(ticket, observed, () => undefined);
	const { epoch } = observed.document;
	return {
		...envelope,
		ticket,
		state: entry.state,
		...(entry.owner !== undefined ? { owner: entry.owner } : {}),
		...(entry.transition !== undefined ? { transition: entry.transition } : {}),
		claimGeneration: entry.claimGeneration ?? null,
		epoch: safeInteger(epoch) ? epoch : null,
		root: validRoot(observed.root) ? observed.root : null,
	};
}

/** List: refused on every non-ready verdict, partial results are `complete: false`, unknown/3. */
export async function runClaimList(
	input: { ticket?: string; context?: string },
	env: ClaimSurfaceEnv,
): Promise<ClaimListDocument | ClaimErrorDocument> {
	try {
		return await list(input, env);
	} catch {
		return errorDocument("list", "internal", null, null);
	}
}

async function list(
	input: { ticket?: string; context?: string },
	env: ClaimSurfaceEnv,
): Promise<ClaimListDocument | ClaimErrorDocument> {
	const command = "list";
	const startedAt = env.monotonicNow();
	let only: string | null = null;
	if (input.ticket !== undefined) {
		const ticket = canonicalTicket(input.ticket, env.taskPrefix);
		if (ticket === undefined) return errorDocument(command, "invalid-ticket", null, null);
		only = ticket;
	}
	if (input.context !== undefined) {
		const contextProblem = contextCode(input.context);
		if (contextProblem !== undefined) return errorDocument(command, contextProblem, only, null);
	}
	const settings = configuredSettings(command, only, null, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	// With a context the rights need eps; without one no surface key is required.
	if (input.context !== undefined) {
		const missing = missingKeys(command, only, null, settings, ["clockUncertaintyMs"]);
		if (missing !== undefined) return missing;
	}
	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: "observe",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	if (verdict.kind !== "ready") return claimPreflightError({ command, ticket: only, verdict });
	const deadline = startedAt + settings.operationBudgetMs;
	const timeouts = claimOperationSchedule({
		startedAt,
		budgetMs: settings.operationBudgetMs,
		attemptTimeoutMs: settings.attemptTimeoutMs,
		pause: { baseMs: 0, maxMs: 0 },
		monotonicNow: env.monotonicNow,
		random: env.random,
		sleep: env.sleep,
	});

	let complete = true;
	let tickets: string[];
	if (only !== null) {
		tickets = [only];
	} else {
		const listed = await listClaimRefs({
			repository: env.projectRoot,
			remote: settings.endpoint,
			format: settings.storageFormat,
			timeoutMs: timeouts.commandTimeoutMs(),
		});
		if (listed.kind !== "listed") return errorDocument(command, "list-unavailable", null, null);
		tickets = listed.tickets;
		if (listed.skipped > 0) complete = false;
	}

	const reads = await readAll(verdict.store, tickets, () => env.monotonicNow() >= deadline);
	const observedAt = env.clock();
	if (!safeInteger(observedAt)) return errorDocument(command, "internal", only, null);
	const context = contextOf(verdict);
	const eps = settings.clockUncertaintyMs;
	const rights = (ticket: string, observed: ClaimReadResult): ClaimRightsView | undefined => {
		if (context === undefined || eps === undefined) return undefined;
		const evaluation = evaluateClaimRight({
			ticket,
			descriptor: verdict.descriptor,
			observed,
			binding: context.binding,
			now: observedAt,
			clockSkewMs: eps,
		});
		return rightsView(evaluation);
	};
	const claims = reads.map(({ ticket, observed }) =>
		listEntry(ticket, observed, (read) => rights(ticket, read), verdict.descriptor.epoch),
	);
	if (claims.some((entry) => entry.state === "unknown")) complete = false;
	claims.sort((left, right) => compareTaskIds(left.ticket, right.ticket));
	return {
		schemaVersion: 1,
		kind: "claim-list",
		status: complete ? "ok" : "unknown",
		command,
		complete,
		observedAt,
		claims,
	};
}

/** Reads one ticket after another while the budget lasts; an unread or failed ticket is `unknown`, never free. */
async function readAll(
	store: ClaimStore,
	tickets: readonly string[],
	expired: () => boolean,
): Promise<{ ticket: string; observed: ClaimReadResult | null }[]> {
	const reads: { ticket: string; observed: ClaimReadResult | null }[] = [];
	for (const ticket of tickets) {
		if (expired()) {
			reads.push({ ticket, observed: null });
			continue;
		}
		try {
			reads.push({ ticket, observed: await store.read(ticket) });
		} catch {
			reads.push({ ticket, observed: null });
		}
	}
	return reads;
}

/** `claim setup` options; the CLI passes what the caller gave, the core decides what is missing or invalid. */
type ClaimSetupInput = {
	endpoint: string | undefined;
	storageFormat: string | undefined;
	clockUncertaintyMs: number | undefined;
};

/** The twelve-key template; start values only where confirmed, eps always from the caller. */
function setupTemplate(endpoint: string, storageFormat: string, clockUncertaintyMs: number): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${JSON.stringify(storageFormat)}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${CLAIM_START_VALUES.leaseTtlMs}`,
		`  reclaim_grace_ms: ${CLAIM_START_VALUES.reclaimGraceMs}`,
		`  attempt_timeout_ms: ${CLAIM_START_VALUES.attemptTimeoutMs}`,
		`  attempts: ${CLAIM_START_VALUES.attempts}`,
		`  operation_budget_ms: ${CLAIM_START_VALUES.operationBudgetMs}`,
		`  clock_uncertainty_ms: ${clockUncertaintyMs}`,
		`  retry_pause_base_ms: ${CLAIM_RETRY_START_VALUES.retryPauseBaseMs}`,
		`  retry_pause_max_ms: ${CLAIM_RETRY_START_VALUES.retryPauseMaxMs}`,
	].join("\n");
}

/** Writes the template once through the project's config guard; an existing block is never overwritten. */
export async function runClaimSetup(
	input: ClaimSetupInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimSetupDocument | ClaimErrorDocument> {
	const command = "setup";
	try {
		const { endpoint, storageFormat, clockUncertaintyMs } = input;
		if (endpoint === undefined || storageFormat === undefined || clockUncertaintyMs === undefined) {
			return errorDocument(command, "invalid-option", null, null);
		}
		if (!Number.isSafeInteger(clockUncertaintyMs)) return errorDocument(command, "invalid-option", null, null);
		if (env.claimsYaml !== undefined) return errorDocument(command, "already-configured", null, null);
		const template = setupTemplate(endpoint, storageFormat, clockUncertaintyMs);
		const resolved = resolveClaimSettings(template);
		if (resolved.kind === "config-invalid") {
			return errorDocument(command, "config-invalid", null, null, { problems: problemsView(resolved.problems) });
		}
		if (resolved.kind !== "configured") return errorDocument(command, "internal", null, null);
		if (env.writeClaimsYaml === undefined) return errorDocument(command, "config-write-failed", null, null);
		let written: "written" | "exists";
		try {
			written = await env.writeClaimsYaml(template);
		} catch {
			return errorDocument(command, "config-write-failed", null, null);
		}
		if (written === "exists") return errorDocument(command, "already-configured", null, null);
		return { schemaVersion: 1, kind: "claim-setup", status: "ok", command, keys: [...TEMPLATE_KEYS] };
	} catch {
		return errorDocument(command, "internal", null, null);
	}
}

/** Initialization; allowed while `enabled: false`, since it creates no claim. */
export async function runClaimInit(env: ClaimSurfaceEnv): Promise<ClaimInitDocument | ClaimErrorDocument> {
	try {
		const result = await initializeClaimCoordination({ claimsYaml: env.claimsYaml, repository: env.projectRoot });
		return claimInitDocument(result);
	} catch {
		return errorDocument("init", "internal", null, null);
	}
}

/** The raw options of `claim install-epoch`, as the CLI hands them; the core checks each. */
export type ClaimInstallEpochInput = {
	context: string;
	expectEpoch: number;
	isolationConfirmed: boolean;
	storageFormat?: string;
	tickets?: string[];
	preview?: boolean;
};

type EpochDocument = ClaimEpochDocument | ClaimEpochPreviewDocument | ClaimErrorDocument;
type EpochFacts = Pick<ClaimEpochDocument, "fromEpoch" | "epoch" | "format" | "previousFormat">;
type EpochTickets = Pick<ClaimEpochDocument, "rewritten" | "created" | "breached" | "unsettled">;
type Listing = Extract<Awaited<ReturnType<typeof listClaimRefs>>, { kind: "listed" }>;

const NO_TICKETS: EpochTickets = { rewritten: [], created: [], breached: [], unsettled: [] };

/** The ticket lists of `claim-epoch` and its preview in the order of `claim list`. */
function ticketOrder(tickets: Iterable<string>): string[] {
	return [...new Set(tickets)].sort(compareTaskIds);
}

/** Every field, built from enumerated values; `cause` only on a rejection. */
function epochDocument(
	status: ClaimEpochDocument["status"],
	facts: EpochFacts,
	tickets: EpochTickets,
	cause?: ClaimEpochDocument["cause"],
): ClaimEpochDocument {
	const document: ClaimEpochDocument = {
		schemaVersion: 1,
		kind: "claim-epoch",
		status,
		command: "install-epoch",
		fromEpoch: facts.fromEpoch,
		epoch: facts.epoch,
		format: facts.format,
		previousFormat: facts.previousFormat,
		rewritten: ticketOrder(tickets.rewritten),
		created: ticketOrder(tickets.created),
		breached: ticketOrder(tickets.breached),
		unsettled: ticketOrder(tickets.unsettled),
		isolation: "attested",
	};
	if (cause !== undefined) document.cause = cause;
	return document;
}

/** Two listings agree when every name, every root and the count of skipped names agree. */
function sameListing(first: Listing, second: Listing): boolean {
	return (
		first.skipped === second.skipped &&
		first.tickets.length === second.tickets.length &&
		first.tickets.every((ticket) => second.roots[ticket] === first.roots[ticket])
	);
}

/** One more than the old generation for a document readable in the old epoch, else `undefined`. */
function nextGeneration(read: ClaimReadResult): number | undefined {
	if (read.kind !== "present") return undefined;
	const parsed = parseClaimState(read.document.payload);
	if (parsed.kind !== "state") return undefined;
	const generation = parsed.state.claimGeneration + 1;
	return Number.isSafeInteger(generation) ? generation : undefined;
}

/**
 * `claim install-epoch`, a storage operation beside the executor; no journal, no
 * budget (every Git command has `attempt_timeout_ms`), never over MCP. An unexpected error before the descriptor
 * swap is `internal`, since nothing was written; from the swap on the run answers `claim-epoch` unknown.
 */
export async function runClaimInstallEpoch(
	input: ClaimInstallEpochInput,
	env: ClaimSurfaceEnv,
): Promise<EpochDocument> {
	try {
		return await installEpoch(input, env);
	} catch {
		return errorDocument("install-epoch", "internal", null, null);
	}
}

async function installEpoch(input: ClaimInstallEpochInput, env: ClaimSurfaceEnv): Promise<EpochDocument> {
	const command = "install-epoch";
	const refuse = (code: ClaimErrorCode) => errorDocument(command, code, null, null);

	// Step 1: the options without IO, the configuration, the statement, the authorisation and the
	// local corpus. Nothing before the preflight starts a Git command (ep-g07), so a refusal reads local files only.
	const contextProblem = contextCode(input.context);
	if (contextProblem !== undefined) return refuse(contextProblem);
	const { expectEpoch } = input;
	// The next epoch must be a safe integer too.
	if (!safeInteger(expectEpoch) || expectEpoch < 1 || expectEpoch >= Number.MAX_SAFE_INTEGER) {
		return refuse("invalid-option");
	}
	const format = input.storageFormat === undefined ? undefined : member(FORMATS, input.storageFormat);
	if (input.storageFormat !== undefined && format === undefined) return refuse("invalid-option");
	const named: string[] = [];
	for (const raw of input.tickets ?? []) {
		const ticket = canonicalTicket(raw, env.taskPrefix);
		if (ticket === undefined) return refuse("invalid-ticket");
		named.push(ticket);
	}
	const settings = configuredSettings(command, null, null, env.claimsYaml);
	if (isErrorDocument(settings)) return settings;
	if (input.isolationConfirmed !== true) return refuse("isolation-unconfirmed");
	const unauthorised = await authorityCode(input.context, settings, env.contextIO);
	if (unauthorised !== undefined) return refuse(unauthorised);
	// Every local task, the completed ones included, may need a ref the run creates.
	const local = await env.loadLocalTickets(null);
	if (local.kind !== "loaded") return refuse("tasks-unavailable");
	const corpus = [...local.corpus.tasks, ...local.corpus.completedTasks].map((task) => ticketOf(task.id));

	// The shared preflight; `maintain` runs under `enabled: false`.
	const verdict = await preflightClaimStorage({
		claimsYaml: env.claimsYaml,
		repository: env.projectRoot,
		purpose: "maintain",
		contextDirectory: input.context,
		contextIO: env.contextIO,
	});
	if (verdict.kind !== "ready") return claimPreflightError({ command, ticket: null, verdict });

	// Step 2: the descriptor the preflight read; another epoch than the expected one ends here, nothing written.
	const { descriptor, store } = verdict;
	const facts: EpochFacts = {
		fromEpoch: expectEpoch,
		epoch: expectEpoch + 1,
		format: format ?? descriptor.format,
		previousFormat: descriptor.format,
	};
	if (descriptor.epoch !== expectEpoch) return epochDocument("rejected", facts, NO_TICKETS, "epoch-changed");

	// Step 3: the first listing L1 and one read per listed ticket, for its generation only. A ticket that cannot
	// be read now stops the run; a corrupt or unsupported one starts again at generation 1.
	const storage = {
		repository: env.projectRoot,
		remote: settings.endpoint,
		format: settings.storageFormat,
		timeoutMs: settings.attemptTimeoutMs,
	};
	const first = await listClaimRefs(storage);
	if (first.kind !== "listed") return refuse("list-unavailable");
	const generations = new Map<string, number>();
	const unreadable: string[] = [];
	for (const ticket of first.tickets) {
		const read = await store.read(ticket);
		if (read.kind !== "present" && read.kind !== "corrupt" && read.kind !== "absent") {
			return refuse("storage-unreadable");
		}
		const generation = nextGeneration(read);
		if (generation === undefined) unreadable.push(ticket);
		else generations.set(ticket, generation);
	}
	// The creation set M: the local tasks and every --ticket without a ref in L1; a listed one is rewritten once.
	const listed = new Set(first.tickets);
	const created = ticketOrder(
		[...corpus, ...named].filter((ticket): ticket is string => ticket !== undefined && !listed.has(ticket)),
	);
	if (input.preview === true) {
		return {
			schemaVersion: 1,
			kind: "claim-epoch-preview",
			status: "ok",
			command,
			epoch: facts.epoch,
			format: facts.format,
			listed: ticketOrder(first.tickets),
			toCreate: created,
			unreadable: ticketOrder(unreadable),
		};
	}
	await env.installEpochSeams?.afterFirstListing?.();

	// Step 4: the second listing L2 right before the swap; any difference is a writer the isolation missed.
	const second = await listClaimRefs(storage);
	if (second.kind !== "listed") return refuse("list-unavailable");
	if (!sameListing(first, second)) return epochDocument("rejected", facts, NO_TICKETS, "writes-observed");

	// Every ticket becomes FREE in the new epoch, leased on its L2 root or created.
	const free = (claimGeneration: number) => ({ claimState: 1, status: "free", claimGeneration });
	const plan: ClaimEpochTicket[] = [
		...second.tickets.map((ticket) => ({
			ticket,
			root: second.roots[ticket] ?? "",
			payload: free(generations.get(ticket) ?? 1),
		})),
		...created.map((ticket) => ({ ticket, root: "", payload: free(1) })),
	];
	const open = epochDocument("unknown", facts, { ...NO_TICKETS, unsettled: plan.map((entry) => entry.ticket) });

	// Step 5: the descriptor CAS, leased on the descriptor of step 2. From here every client reads every earlier
	// document as corrupt (unknown, never free), so an interrupted run is unknown and its rerun names `epoch`.
	// A lost CAS (stale, or remote with a moved descriptor) is epoch-changed; a CAS the endpoint refused while the
	// descriptor stayed, or whose re-read failed, is remote-rejected; an unknown push outcome may have swapped it.
	const swapped = await swapClaimEpoch(store, facts.format);
	if (swapped.kind !== "swapped") {
		if (swapped.kind === "epoch-changed") return epochDocument("rejected", facts, NO_TICKETS, "epoch-changed");
		if (swapped.kind === "declined") return refuse("remote-rejected");
		if (swapped.kind === "unknown") return open;
		return refuse(swapped.kind === "not-sent" ? "local-unavailable" : "internal");
	}
	try {
		await env.installEpochSeams?.afterDescriptorSwap?.();

		// Step 6: archive and rewrite every listed ticket, create every ticket of M.
		const written = await installClaimEpoch(store, { descriptor: swapped.descriptor, tickets: plan });
		if (written.kind !== "written") return open;
		const { roots, unsettled } = written;

		// Step 7: the last listing L3; every ticket ref must name the root this run wrote for it.
		// An extra ref, another root or a missing ref is breached; an unsettled ticket keeps whatever it had.
		const last = await listClaimRefs(storage);
		const breached: string[] = [];
		if (last.kind === "listed") {
			for (const ticket of ticketOrder([...last.tickets, ...Object.keys(roots)])) {
				if (!unsettled.includes(ticket) && last.roots[ticket] !== roots[ticket]) breached.push(ticket);
			}
		}
		const tickets: EpochTickets = {
			rewritten: second.tickets.filter((ticket) => roots[ticket] !== undefined),
			created: created.filter((ticket) => roots[ticket] !== undefined),
			breached,
			unsettled,
		};
		// A non-canonical name under refs/claims/* that appeared since L2 is a foreign ref the run did not write (F1).
		const settled =
			last.kind === "listed" && last.skipped === second.skipped && breached.length === 0 && unsettled.length === 0;
		return epochDocument(settled ? "applied" : "unknown", facts, tickets);
	} catch {
		return open;
	}
}

/** `recoverFrom`: the context whose claims the new one may resume; never printed. */
export type ClaimContextCreateInput = { parent: string; recoverFrom?: string };

/**
 * A new private context under an explicit 0700 parent; only its ID is printed, never a path (out-06). With
 * `recoverFrom` the loader validates that context first and stores its proof; its failures keep these codes.
 */
export async function runClaimContextCreate(
	input: ClaimContextCreateInput,
	env: ClaimSurfaceEnv,
): Promise<ClaimContextDocument | ClaimErrorDocument> {
	const command = "context-create";
	try {
		const { parent, recoverFrom } = input;
		const source = recoverFrom === undefined ? {} : { recoverFrom };
		const created = await createClaimContext({ parent, ...source, io: env.contextIO });
		if (created.kind !== "created") {
			return errorDocument(command, CONTEXT_CODES[created.kind] ?? "internal", null, null);
		}
		const { contextId } = created.context;
		if (!CONTEXT_ID.test(contextId)) return errorDocument(command, "internal", null, null);
		return { schemaVersion: 1, kind: "claim-context", status: "ok", command, contextId };
	} catch {
		return errorDocument(command, "internal", null, null);
	}
}

/**
 * Read-only and local, like `context create`. It loads the context and prints its ID and
 * its authority ID, the value an operator lists in `claims.recovery_authorities`; nothing else of the context.
 */
export async function runClaimContextShow(
	input: { context: string },
	env: ClaimSurfaceEnv,
): Promise<ClaimContextDocument | ClaimErrorDocument> {
	const command = "context-show";
	try {
		const contextProblem = contextCode(input.context);
		if (contextProblem !== undefined) return errorDocument(command, contextProblem, null, null);
		const options = { directory: input.context, io: env.contextIO };
		const loaded = await loadClaimContext(options);
		if (loaded.kind !== "loaded") return errorDocument(command, CONTEXT_CODES[loaded.kind], null, null);
		const derived = await claimContextAuthority(options);
		if (derived.kind !== "derived") return errorDocument(command, CONTEXT_CODES[derived.kind], null, null);
		const { contextId } = loaded.context;
		const { authorityId } = derived;
		if (!CONTEXT_ID.test(contextId)) return errorDocument(command, "internal", null, null);
		return { schemaVersion: 1, kind: "claim-context", status: "ok", command, contextId, authorityId };
	} catch {
		return errorDocument(command, "internal", null, null);
	}
}
