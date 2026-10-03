/**
 * Level P: `claim next` and the dependency policy without Git, without a subprocess, without the network, without the
 * disk and without the wall clock. Pinned here: the claim-next order through the selection and the two new
 * comparators; the ready selection over the whole local corpus; the input checks before any IO; the continue/stop
 * table per attempt, the bounded drive over injected attempts and the cross-ticket acquisition stop over a synthetic
 * journal; the claim-next document, the three new codes and the human text; the pure dependency verdict, the policy
 * key in the preflight resolver and the gate in the direct acquire core. Core calls end before the preflight, at the
 * administration context pre-check (a context stub that never touches the disk) or at the preflight option check,
 * which a relative project root fails before any Git command (config/index.ts:478); no call prepares an intent, so no
 * own outstanding intent can pause a later call. Every test starts with a positive control, except dep-02, which puts
 * its green characterization in front; table rows name the deliberately wrong implementation they catch. Names the
 * typed scaffold adds are marked ASSUMPTION(scaffold), names the administration commands add
 * ASSUMPTION(administration). Harness: adapted copies with "adapted from" notes, no shared fixture module.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolveClaimSettings } from "../claims/config/index.ts";
import type { ClaimIntentEnumerationResult, ClaimIntentRecord, ClaimOperationIntent } from "../claims/journal/index.ts";
// ASSUMPTION(scaffold): evaluateClaimAcquireStop exists in pause/ (stub `invalid`).
import { evaluateClaimAcquireStop } from "../claims/pause/index.ts";
import type { ClaimStorageDescriptor } from "../claims/storage/index.ts";
// ASSUMPTION(scaffold): every claim-next name below exists with these shapes ("next" in
// ClaimCommand, the three codes, the mandatory seam loadLocalTickets, ClaimNextDocument inside ClaimDocument).
import {
	CLAIM_ERROR_CODES,
	type ClaimCandidateSelection,
	type ClaimDocument,
	type ClaimErrorCode,
	type ClaimErrorDocument,
	type ClaimLocalTickets,
	type ClaimMutationInput,
	type ClaimNextAttempt,
	type ClaimNextDocument,
	type ClaimNextInput,
	type ClaimNextStop,
	type ClaimOperationDocument,
	type ClaimPauseDocument,
	type ClaimRightsView,
	type ClaimSurfaceEnv,
	type ClaimTicketSelection,
	claimDependencyVerdict,
	claimErrorDocument,
	claimExitCode,
	claimNextDocument,
	claimNextStep,
	driveClaimNext,
	runClaimList,
	runClaimMutation,
	runClaimNext,
	runClaimResolve,
	runClaimRetry,
	selectClaimCandidates,
} from "../claims/surface/index.ts";
import type { TaskCorpus } from "../core/task-detail.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";
import type { Task } from "../types/index.ts";
// ASSUMPTION(scaffold): the three exports (stubs: taskCreatedAt → null, comparators → 0).
import { compareByAge, compareByPriorityThenAge, taskCreatedAt } from "../utils/task-sorting.ts";

type Body = Record<string, unknown>;
type Order = "priority" | "age";
type Step = "claimed" | "continue" | "stop";
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type NotSentCause = Extract<NonNullable<ClaimOperationDocument["storage"]>, { kind: "not-sent" }>["cause"];
/** One scripted attempt document per call of `attempt(ticket)`, in call order. */
type Script = readonly ((ticket: string) => ClaimNextAttempt)[];
type TaskFields = {
	priority?: string;
	createdDate?: string;
	dependencies?: string[];
	status?: string;
	assignee?: string[];
	title?: string;
	ordinal?: number;
	updatedDate?: string;
	filePath?: string;
};
/** Level P: the whole public document with a non-empty message replaced by MESSAGE, exit code, sorted keys, echoes. */
type DocumentView = { label: string; exit: number; keys: string[]; body: Body; echoed: number };
/** O4 (`newOperationId` calls) and O5 (`loadLocalTickets` calls with their argument), plus local lookups. */
type Probe = { loads: (ClaimTicketSelection | null)[]; ids: number; lookups: number };
type ProbedView = DocumentView & Probe;
type OrderView = { label: string; selected: string[]; sorted: string[] };
type InstantRow = { text: string | undefined; catches: string; expected: number | null };
type StepRow = { label: string; catches: string; document: ClaimNextAttempt; expected: Step };
/** The drive result and the claim-next document built from it. */
type DriveView = {
	label: string;
	calls: string[];
	stop: string;
	untried: number;
	attempts: ClaimNextAttempt[];
	status: unknown;
	exit: number;
	ticket: unknown;
	operationId: unknown;
};
type DriveExpectation = {
	calls: string[];
	stop: string;
	untried: number;
	status: string;
	ticket: string | null;
	operationId: string | null;
};
type DriveRow = {
	label: string;
	catches: string;
	candidates: string[];
	maxCandidates: number;
	script: Script;
	expected: DriveExpectation;
};
type NextFields = {
	status: string;
	order?: Order;
	maxCandidates?: number;
	ticket?: string | null;
	operationId?: string | null;
	selection: ClaimCandidateSelection;
	attempts?: ClaimNextAttempt[];
	untried?: number;
	stop: Body;
};
type NextRow = {
	label: string;
	catches: string;
	selection: ClaimCandidateSelection;
	attempts: ClaimNextAttempt[];
	untried: number;
	stop: ClaimNextStop;
	maxCandidates: number;
	expected: { status: string; ticket: string | null; operationId: string | null };
};
/** `command` null means "resolve or retry"; `ids` must all appear in the text. */
type Hint = { command: "claim resolve" | "claim retry" | null; ids: readonly string[] };
type TextView = { label: string; stream: string; head: string | null; wayOut: boolean | null; echoed: number };
type TextRow = { label: string; catches: string; doc: ClaimNextDocument; hint: Hint | null };
type InputRow = {
	label: string;
	catches: string;
	input: ClaimNextInput;
	/** `null`: the project has no claims block at all. */
	yaml?: string | null;
	expected: Body;
	loads: ClaimTicketSelection[];
};
type ProblemView = { key: string; problem: string };
type PolicyView = {
	label: string;
	kind: string;
	keys: string[];
	policy: unknown;
	problems: ProblemView[];
	echoed: number;
};
/** Either the policy the block resolves to or the problems it is refused with. */
type PolicyRow = {
	label: string;
	catches: string;
	yaml: string;
	policy?: "strict" | "permissive";
	problems?: ProblemView[];
};
type StopOptions = Parameters<typeof evaluateClaimAcquireStop>[0];
type StopRow = { label: string; options: StopOptions; expected: Body };
type GateRow = {
	label: string;
	catches: string;
	input: ClaimMutationInput;
	yaml?: string;
	local?: ClaimLocalTickets;
	expected: Body;
	loads: null[];
	lookups: number;
};
/** An entry point other than runClaimMutation, called with the stubbed environment. */
type EntryRow = {
	label: string;
	catches: string;
	run: (env: ClaimSurfaceEnv) => Promise<ClaimDocument>;
	expected: Body;
};
type IntentFields = { action?: string; remote?: string; format?: ClaimOperationIntent["format"]; epoch?: number };

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; only the clock stub returns it. */
const T = 1_800_000_000_000;
/** Arbitrary origin of the injected monotonic clock; only differences count (claim-surface-git.test.ts:51). */
const MONO_START = 5_000;
/** Appears in the owner, the context path and the endpoint; no public document or text may contain it. */
const SENTINEL = "SENTINEL-claim-next-3f81";
/** Display name of the acquire request only; claim-next never outputs it. */
const OWNER = `agent-karl-${SENTINEL}`;
const CONTEXT_PATH = `/tmp/contexts-${SENTINEL}/context-1`;
/** `--to-context` of the transfer row; like CONTEXT_PATH it is never read from the disk (NO_CONTEXTS). */
const TARGET_PATH = `/tmp/contexts-${SENTINEL}/context-2`;
const ENDPOINT = `git://127.0.0.1:9/${SENTINEL}/claims.git`;
const OTHER_ENDPOINT = `git://127.0.0.1:9/${SENTINEL}/other.git`;
const BINDING = `tb1-${"4b".repeat(32)}`;
const ROOT = "a1".repeat(20);
const SENSITIVE = [SENTINEL, OWNER, CONTEXT_PATH, TARGET_PATH, ENDPOINT, BINDING, ROOT];
/** Fields a spread of an upstream object would leak into a document (built field by field). */
const TAINT = { owner: OWNER, contextDirectory: CONTEXT_PATH, remote: ENDPOINT, binding: BINDING, root: ROOT };
/**
 * Relative on purpose: a preflight fails its option check on it (config/index.ts:478) before `isGitRepository` spawns
 * Git (config/index.ts:511, git/operations.ts:1264–1276), so no call of this file can reach a subprocess.
 */
const PROJECT_ROOT = "claim-next-project";
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** Named placeholder for a field that is not there (claim-execution-retry.test.ts:82). */
const ABSENT = "(absent)";
/** Operation IDs are `op-<uuid v4>`. */
const OP_1 = "op-1c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a01";
const OP_2 = "op-2c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a02";
const OP_3 = "op-3c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a03";
/** Plan stp-06: own open acquire intents of the pre-phase enumeration. */
const OP_A = "op-a1e4c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c0a";
const OP_B = "op-b1e4c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c0b";
/** Own open renew/release/reclaim intents of the pre-phase enumeration: `maintenanceOperationIds`. */
const OP_R = "op-c1e4c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c0c";
const OP_W = "op-d1e4c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c0d";
/** An operation ID the pre-phase enumeration did not name. */
const OP_X = "op-e1e4c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c0e";
const MAINTENANCE: ReadonlySet<string> = new Set([OP_R, OP_W]);
/** The closed status table, written out so the constant under test is not its own oracle. */
const EXPECTED_EXIT: Record<string, number> = {
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
const STDERR_STATUSES: readonly string[] = ["refused", "unavailable", "internal"];
const BOUNDARY = T + 15 * MINUTE;
const HELD: ClaimRightsView = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "held",
	claimGeneration: 4,
	workRight: { kind: "live", renewalDue: false },
	reclaim: { kind: "not-yet", boundary: BOUNDARY },
};
const FOREIGN: ClaimRightsView = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "foreign",
	claimGeneration: 3,
	workRight: { kind: "none", cause: "not-holder" },
	reclaim: { kind: "not-yet", boundary: BOUNDARY },
};
const UNREAD: ClaimRightsView = { kind: "unknown" };
/** Every plan cause of surface/index.ts:556–572 except `held` and `not-free`, written out. */
const OTHER_PLAN_CAUSES: readonly string[] = [
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
];
/** All eleven not-sent causes of execution/index.ts:79–90, written out. */
const NOT_SENT_CAUSES: readonly NotSentCause[] = [
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
/** The ticket-bounded errors that continue the search. */
const CONTINUE_CODES: readonly ClaimErrorCode[] = [
	"state-corrupt",
	"state-unsupported",
	"dependency-blocked",
	"dependency-unknown",
	"ticket-not-found",
	"ticket-ambiguous",
];

const LEASE: readonly string[] = ["  lifetime_mode: lease", "  lease_ttl_ms: 300000", "  reclaim_grace_ms: 600000"];
const HARD: readonly string[] = ["  lifetime_mode: hard", "  reclaim_grace_ms: 600000"];
const NONE: readonly string[] = ["  lifetime_mode: none"];
const SURFACE: readonly string[] = [
	"  clock_uncertainty_ms: 2000",
	"  retry_pause_base_ms: 1000",
	"  retry_pause_max_ms: 5000",
];

/** Configuration keys plus the three surface keys, all explicit (claim-surface-git.test.ts:241–257). */
// adapted from claim-surface.test.ts:481–486
function claimsBlock(
	lifetime: readonly string[],
	extra: readonly string[] = [],
	surface: readonly string[] = SURFACE,
): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(ENDPOINT)}`,
		"  storage_format: blob",
		...lifetime,
		"  attempt_timeout_ms: 10000",
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		...surface,
		...extra,
	].join("\n");
}

const CLAIMS_YAML = claimsBlock(LEASE);

// adapted from claim-surface.test.ts:184
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface.test.ts:190
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-surface.test.ts:195
function echoes(text: string): number {
	return SENSITIVE.filter((value) => text.includes(value)).length;
}

// adapted from claim-surface.test.ts:199
function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

/** A typed result as a plain record: bun-types checks `toEqual(expected: T)` against the actual's type. */
function plain(value: object): Body {
	return Object.fromEntries(Object.entries(value));
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks and corpora (P; types/index.ts:46–88, core/task-detail.ts:12–21)
// ---------------------------------------------------------------------------------------------------------------

/** The creation minute of a task whose age does not matter; Backlog writes UTC minutes (core/backlog.ts:1769). */
const DAY = "2026-01-01 10:00";
const STATUSES: readonly string[] = ["To Do", "In Progress", "Done"];

/** A local task record as the loaders return it; every task has its own file unless a case shares one. */
function task(id: string, fields: TaskFields = {}): Task {
	const record: Task = {
		id,
		title: fields.title ?? `Task ${id}`,
		status: fields.status ?? "To Do",
		assignee: fields.assignee ?? [],
		createdDate: fields.createdDate ?? DAY,
		labels: [],
		dependencies: fields.dependencies ?? [],
		filePath: fields.filePath ?? `backlog/tasks/${id.toLowerCase()} - Task.md`,
	};
	if (fields.priority !== undefined) record.priority = fields.priority;
	if (fields.ordinal !== undefined) record.ordinal = fields.ordinal;
	if (fields.updatedDate !== undefined) record.updatedDate = fields.updatedDate;
	return record;
}

function corpusOf(tasks: Task[], completedTasks: Task[] = []): TaskCorpus {
	return { tasks, completedTasks, statuses: STATUSES };
}

function pick(tasks: readonly Task[], ids: readonly string[]): Task[] {
	return tasks.filter((entry) => ids.includes(entry.id));
}

/** Prerequisites that live only in the corpus: Done, In Progress and one identity claimed by two files. */
const PREREQUISITES: Task[] = [
	task("BACK-21", { status: "Done" }),
	task("BACK-22", { status: "In Progress" }),
	task("BACK-23", { filePath: "backlog/tasks/back-23 - First.md" }),
	task("BACK-23", { filePath: "backlog/tasks/back-23 - Second.md" }),
];
/** The completed corpus is completion evidence on its own, whatever the status says (task-record-index.ts:36–40). */
const COMPLETED: Task[] = [task("BACK-20", { filePath: "backlog/completed/back-20 - Task.md" })];
/** Plan sel-01: matched 1 to 8. */
const SEL_MATCHED: Task[] = [
	task("BACK-1"),
	task("BACK-2", { dependencies: ["BACK-20"] }),
	task("BACK-3", { dependencies: ["BACK-21"] }),
	task("BACK-4", { dependencies: ["BACK-22"] }),
	task("BACK-5", { dependencies: ["BACK-99"] }),
	task("BACK-6", { dependencies: ["BACK-23"] }),
	task("BACK-7", { status: "Done", dependencies: ["BACK-22"] }),
	task("BACK-8", { dependencies: ["BACK-4"] }),
];
/** An unfinished and an unresolved prerequisite at once. */
const BOTH = task("BACK-9", { dependencies: ["BACK-22", "BACK-99"] });
/** Plan sel-05: raw frontmatter values, one lowercase, one with a space, one with an escape sequence. */
const RAW = task("BACK-11", { dependencies: ["BACK-99", "back-98", "foo bar", "BACK-97\u001b[31m"] });
/** The whole local corpus of sel-01, sel-04, sel-05, dep-01 and dep-03; BACK-12 is deliberately not in it. */
const SHARED = corpusOf([...SEL_MATCHED, BOTH, RAW, ...PREREQUISITES], COMPLETED);
const SHARED_LOCAL: ClaimLocalTickets = { kind: "loaded", matched: [], corpus: SHARED, priorities: [] };
/** The one seam answers `unavailable` for unreadable local tasks (`tasks-unavailable`). */
const UNAVAILABLE: ClaimLocalTickets = { kind: "unavailable" };
/** Tickets the stubbed local lookup of acquire finds (surface/index.ts:1296–1303); BACK-12 has a file, no corpus. */
const KNOWN: readonly string[] = ["BACK-1", "BACK-4", "BACK-5", "BACK-7", "BACK-9", "BACK-11", "BACK-12"];

/** Plan ord-01: every task at 10:00, BACK-6 with an empty date. */
const ORDER_SET: Task[] = [
	task("BACK-1", { priority: "low", createdDate: "2026-01-01 10:00" }),
	task("BACK-2", { priority: "high", createdDate: "2026-03-01 10:00" }),
	task("BACK-3", { priority: "high", createdDate: "2026-02-01 10:00" }),
	task("BACK-4", { createdDate: "2025-12-01 10:00" }),
	task("BACK-5", { priority: "high", createdDate: "2026-02-01 10:00" }),
	task("BACK-6", { priority: "medium", createdDate: "" }),
	task("BACK-10", { priority: "high", createdDate: "2026-02-01 10:00" }),
];

/** A filter as the shared mapping hands it over; the core passes it to the seam untouched. */
const SELECTION: ClaimTicketSelection = {
	filter: { status: "To Do", labels: ["backend"], labelMatch: "all" },
	query: "login",
};

function unknownDiagnostic(ticket: string, unknown: string[], unreadable = 0): Body {
	return { ticket, cause: "dependency-unknown", dependencies: { blocking: [], unknown, unreadable } };
}

function select(
	matched: Task[],
	all: TaskCorpus,
	order: Order = "priority",
	priorities: readonly string[] = [],
): ClaimCandidateSelection {
	// ASSUMPTION(scaffold): one object with the matched tasks, the whole corpus, the priorities and the order.
	return selectClaimCandidates({ matched, corpus: all, priorities, order });
}

/** Twice: through the selection claim-next uses and through the two exported comparators. */
function orderView(label: string, tasks: Task[], order: Order, priorities: readonly string[] = []): OrderView {
	const compare =
		order === "priority"
			? (left: Task, right: Task) => compareByPriorityThenAge(left, right, priorities)
			: (left: Task, right: Task) => compareByAge(left, right);
	return {
		label,
		selected: select(tasks, corpusOf(tasks), order, priorities).candidates,
		sorted: [...tasks].sort(compare).map((entry) => entry.id),
	};
}

function orderExpected(label: string, ids: string[]): OrderView {
	return { label, selected: ids, sorted: ids };
}

// ---------------------------------------------------------------------------------------------------------------
// Attempt documents: the unchanged base documents, as typed literals or through the base helper.
// ---------------------------------------------------------------------------------------------------------------

function operationDoc(
	ticket: string,
	fields: Pick<
		ClaimOperationDocument,
		"status" | "operationId" | "outcome" | "rejection" | "storage" | "sends" | "stoppedBy" | "rights"
	>,
): ClaimOperationDocument {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: fields.status,
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: fields.operationId,
		outcome: fields.outcome,
		rejection: fields.rejection,
		storage: fields.storage,
		sends: fields.sends,
		stoppedBy: fields.stoppedBy,
		planned: null,
		rights: fields.rights,
	};
}

function applied(ticket: string, operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "applied",
		operationId,
		outcome: "applied",
		rejection: null,
		storage: { kind: "applied" },
		sends: 1,
		stoppedBy: null,
		rights: HELD,
	});
}

/** surface/index.ts:872–902: a plan rejection persists nothing and carries no operation ID. */
function planRejected(ticket: string, cause: string): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "rejected",
		operationId: null,
		outcome: "rejected",
		rejection: { stage: "plan", cause },
		storage: null,
		sends: 0,
		stoppedBy: null,
		rights: cause === "held" ? HELD : FOREIGN,
	});
}

function storageRejected(ticket: string, cause: "stale" | "remote", operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "rejected",
		operationId,
		outcome: "rejected",
		rejection: { stage: "storage", cause },
		storage: { kind: "rejected", cause },
		sends: 1,
		stoppedBy: null,
		rights: FOREIGN,
	});
}

function notStored(ticket: string, operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "rejected",
		operationId,
		outcome: "rejected",
		rejection: { stage: "resolution", cause: "not-stored" },
		storage: { kind: "queried", after: "remote", query: { kind: "resolved", resolution: "not-stored" } },
		sends: 2,
		stoppedBy: null,
		rights: FOREIGN,
	});
}

function unknownOutcome(ticket: string, operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "unknown",
		operationId,
		outcome: "unknown",
		rejection: null,
		storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } },
		sends: 3,
		stoppedBy: "attempts",
		rights: UNREAD,
	});
}

function unknownHistory(ticket: string, operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "unknown-history",
		operationId,
		outcome: "unknown-history",
		rejection: null,
		storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "conflict" } },
		sends: 1,
		stoppedBy: null,
		rights: FOREIGN,
	});
}

/** not-sent is `unavailable` with the operation ID of the prepared intent. */
function notSent(ticket: string, cause: NotSentCause, operationId = OP_1): ClaimOperationDocument {
	return operationDoc(ticket, {
		status: "unavailable",
		operationId,
		outcome: "not-sent",
		rejection: null,
		storage: { kind: "not-sent", cause },
		sends: 0,
		stoppedBy: null,
		rights: UNREAD,
	});
}

function pauseDoc(ticket: string, pause: ClaimPauseDocument["pause"]): ClaimPauseDocument {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "acquire",
		action: "acquire",
		ticket,
		operationId: null,
		pause,
		rights: HELD,
	};
}

function errorAttempt(ticket: string, code: ClaimErrorCode): ClaimErrorDocument {
	return claimErrorDocument({ command: "acquire", code, ticket });
}

/** surface/index.ts:694–705: an unexpected error after the executor call keeps the operation ID and status unknown. */
function unknownAfterStart(ticket: string, operationId = OP_1): ClaimErrorDocument {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "unknown",
		command: "acquire",
		code: "internal",
		message: "an unexpected error ended the command after the operation started; its outcome is unknown",
		ticket,
		operationId,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Documents, views and the stubbed environment
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-surface.test.ts:332–351
function errorBody(
	status: string,
	code: string,
	extra: Body = {},
	command = "acquire",
	ticket: string | null = "BACK-1",
	operationId: string | null = null,
): Body {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status,
		command,
		code,
		message: MESSAGE,
		ticket,
		operationId,
		...extra,
	};
}

/** Errors before the loop are one claim-error of command `next` without ticket and operation ID. */
function nextError(status: string, code: string, extra: Body = {}): Body {
	return errorBody(status, code, extra, "next", null);
}

/** Exactly these fourteen keys, built field by field; default order and bound written out. */
function nextBody(fields: NextFields): Body {
	return {
		schemaVersion: 1,
		kind: "claim-next",
		status: fields.status,
		command: "next",
		order: fields.order ?? "priority",
		maxCandidates: fields.maxCandidates ?? 5,
		ticket: fields.ticket ?? null,
		operationId: fields.operationId ?? null,
		candidates: fields.selection.candidates,
		excluded: fields.selection.excluded,
		diagnostics: fields.selection.diagnostics,
		attempts: fields.attempts ?? [],
		untried: fields.untried ?? 0,
		stop: fields.stop,
	};
}

// adapted from claim-surface.test.ts:401–412 (the echo scan also covers the human text)
function viewOf(label: string, doc: ClaimDocument): DocumentView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	const { stdout, stderr } = formatClaimDocumentText(doc);
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		body,
		echoed: echoes(JSON.stringify(doc) + stdout + stderr),
	};
}

// adapted from claim-surface.test.ts:414–424
function expectedView(label: string, body: Body): DocumentView {
	return {
		label,
		exit: EXPECTED_EXIT[String(body.status)] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		body,
		echoed: 0,
	};
}

function probedExpected(label: string, body: Body, loads: (ClaimTicketSelection | null)[], lookups = 0): ProbedView {
	return { ...expectedView(label, body), loads, ids: 0, lookups };
}

/** A missing entry as node reports it; `loadClaimContext` maps ENOENT to `invalid` (context/index.ts:108–110). */
function absentEntry(): Promise<never> {
	return Promise.reject(Object.assign(new Error("no claim context exists in a level-P test"), { code: "ENOENT" }));
}

/**
 * Context seam that never touches the disk: every context read fails as a missing entry. Only the administration
 * context pre-check of transfer and resume reaches it; every other call ends before any context load.
 */
const NO_CONTEXTS = {
	open: absentEntry,
	lstat: absentEntry,
	mkdir: absentEntry,
	link: absentEntry,
	unlink: absentEntry,
};

/**
 * ClaimSurfaceEnv with the new mandatory seam; relative project root, fixed clocks, recorded seams. Nothing
 * here touches a file, the network or a clock of the host.
 */
function stubEnv(probe: Probe, local: ClaimLocalTickets, claimsYaml: string | undefined): ClaimSurfaceEnv {
	return {
		projectRoot: PROJECT_ROOT,
		claimsYaml,
		taskPrefix: "BACK",
		findLocalTicket: (input: string) => {
			probe.lookups += 1;
			const found: LocalTicket = KNOWN.includes(input) ? { kind: "found", ticket: input } : { kind: "missing" };
			return Promise.resolve(found);
		},
		clock: () => T,
		monotonicNow: () => MONO_START,
		random: () => 0.5,
		sleep: () => Promise.resolve(),
		newOperationId: () => {
			probe.ids += 1;
			return OP_1;
		},
		// The one mandatory seam loadLocalTickets(selection | null); ASSUMPTION(scaffold) until it exists.
		loadLocalTickets: (selection: ClaimTicketSelection | null) => {
			probe.loads.push(selection);
			return Promise.resolve(local);
		},
		contextIO: NO_CONTEXTS,
	};
}

async function nextView(
	label: string,
	input: ClaimNextInput,
	local: ClaimLocalTickets,
	claimsYaml: string | undefined,
): Promise<ProbedView> {
	const probe: Probe = { loads: [], ids: 0, lookups: 0 };
	const doc = await runClaimNext(input, stubEnv(probe, local, claimsYaml));
	return { ...viewOf(label, doc), ...probe };
}

async function gateView(
	label: string,
	input: ClaimMutationInput,
	claimsYaml: string,
	local: ClaimLocalTickets,
): Promise<ProbedView> {
	const probe: Probe = { loads: [], ids: 0, lookups: 0 };
	const doc = await runClaimMutation(input, stubEnv(probe, local, claimsYaml));
	return { ...viewOf(label, doc), ...probe };
}

function acquire(ticket: string): ClaimMutationInput {
	return { command: "acquire", ticket, owner: OWNER, context: CONTEXT_PATH };
}

function maintain(command: "renew" | "release" | "reclaim", ticket: string): ClaimMutationInput {
	return { command, ticket, context: CONTEXT_PATH };
}

function selectionOf(candidates: readonly string[]): ClaimCandidateSelection {
	return {
		candidates: [...candidates],
		excluded: { blocked: 0, dependencyUnknown: 0, notActionable: 0 },
		diagnostics: [],
	};
}

/** The drive over injected attempts, then the document built from its result. */
async function driveView(label: string, row: Omit<DriveRow, "label" | "catches" | "expected">): Promise<DriveView> {
	const calls: string[] = [];
	const result = await driveClaimNext({
		candidates: row.candidates,
		maxCandidates: row.maxCandidates,
		maintenanceOperationIds: MAINTENANCE,
		attempt: (ticket: string) => {
			const scripted = row.script[calls.length];
			calls.push(ticket);
			return Promise.resolve(scripted === undefined ? errorAttempt(ticket, "internal") : scripted(ticket));
		},
	});
	// ASSUMPTION(scaffold): order, bound, selection, the attempts in
	// attempt order, untried and the stop; the result is a ClaimDocument.
	const doc = claimNextDocument({
		order: "priority",
		maxCandidates: row.maxCandidates,
		selection: selectionOf(row.candidates),
		attempts: result.attempts,
		untried: result.untried,
		stop: { kind: result.stop },
	});
	return {
		label,
		calls,
		stop: result.stop,
		untried: result.untried,
		attempts: result.attempts,
		status: field(doc, "status"),
		exit: claimExitCode(doc),
		ticket: field(doc, "ticket"),
		operationId: field(doc, "operationId"),
	};
}

function driveExpected(label: string, script: Script, expected: DriveExpectation): DriveView {
	return {
		label,
		calls: expected.calls,
		stop: expected.stop,
		untried: expected.untried,
		attempts: expected.calls.map((ticket, index) => script[index]?.(ticket) ?? errorAttempt(ticket, "internal")),
		status: expected.status,
		exit: EXPECTED_EXIT[expected.status] ?? -1,
		ticket: expected.ticket,
		operationId: expected.operationId,
	};
}

async function driveRows(rows: readonly DriveRow[]): Promise<{ actual: DriveView[]; expected: DriveView[] }> {
	const actual: DriveView[] = [];
	const expected: DriveView[] = [];
	for (const row of rows) {
		const label = `${row.label} (catches: ${row.catches})`;
		actual.push(await driveView(label, row));
		expected.push(driveExpected(label, row.script, row.expected));
	}
	return { actual, expected };
}

/** A literal claim-next document for the renderer, with upstream-looking extras planted on it. */
function nextDoc(
	status: ClaimNextDocument["status"],
	stop: ClaimNextStop,
	attempts: ClaimNextAttempt[],
	ticket: string | null,
	operationId: string | null,
): ClaimNextDocument {
	const doc: ClaimNextDocument = {
		schemaVersion: 1,
		kind: "claim-next",
		status,
		command: "next",
		order: "priority",
		maxCandidates: 5,
		ticket,
		operationId,
		candidates: ["BACK-3", "BACK-1", "BACK-2"],
		excluded: { blocked: 1, dependencyUnknown: 1, notActionable: 0 },
		diagnostics: [],
		attempts,
		untried: 1,
		stop,
	};
	return tainted(doc);
}

// adapted from claim-surface.test.ts:372–388 (first token and stream), plus the way out
function textView(label: string, doc: ClaimDocument, hint: Hint | null): TextView {
	const { stdout, stderr } = formatClaimDocumentText(doc);
	let stream = "mixed";
	if (stdout !== "" && stderr === "") stream = "stdout";
	if (stderr !== "" && stdout === "") stream = "stderr";
	const text = stdout + stderr;
	const first = text.split("\n")[0] ?? "";
	const colon = first.indexOf(":");
	let wayOut: boolean | null = null;
	if (hint !== null) {
		const named = hint.ids.every((id) => text.includes(id));
		const either = text.includes("claim resolve") || text.includes("claim retry");
		wayOut = named && (hint.command === null ? either : text.includes(hint.command));
	}
	return { label, stream, head: colon > 0 ? first.slice(0, colon) : null, wayOut, echoed: echoes(text) };
}

function textExpected(label: string, status: string, hint: Hint | null): TextView {
	const stream = STDERR_STATUSES.includes(status) ? "stderr" : "stdout";
	return { label, stream, head: status, wayOut: hint === null ? null : true, echoed: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Journal records for the acquisition stop
// ---------------------------------------------------------------------------------------------------------------

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-operation-pause.test.ts:109–120
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => byCodeUnits(left, right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("fixture values must be JSON encodable");
	return encoded;
}

// adapted from claim-operation-pause.test.ts:123–125
function sha256Hex(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
// adapted from claim-operation-pause.test.ts:129–136
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

function intentRecord(
	operationId: string,
	ticket: string,
	expectedRoot: string | null,
	fields: IntentFields = {},
): ClaimIntentRecord {
	const action = fields.action ?? "acquire";
	return recordOf({
		operationId,
		remote: fields.remote ?? ENDPOINT,
		format: fields.format ?? "blob",
		epoch: fields.epoch ?? 1,
		ticket,
		expectedRoot,
		targetBinding: action === "release" ? null : BINDING,
		action,
		parameters: { action },
		resolved: { next: { claimState: 1, status: "free", claimGeneration: 2 } },
	});
}

const BLOB: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
const R2 = "2".repeat(40);
const R3 = "3".repeat(40);
const R4 = "4".repeat(40);
const R5 = "5".repeat(40);
const R6 = "6".repeat(40);
const R7 = "7".repeat(40);
const R8 = "8".repeat(40);
const R9 = "9".repeat(40);
/** Operation IDs of the stp-07 records; A2 sorts before A1 in code units, the records are listed A1 first. */
const A1 = "op-f1000000-0000-4000-8000-000000000001";
const A2 = "op-a2000000-0000-4000-8000-000000000002";
const W4 = "op-d4000000-0000-4000-8000-000000000004";
/** Plan stp-07: A1 open at an absent ref, A2 open at its root; every other record is not open or not an acquire. */
const OPEN_ACQUIRES: ClaimIntentRecord[] = [intentRecord(A1, "BACK-1", null), intentRecord(A2, "BACK-2", R2)];
const OTHER_RECORDS: ClaimIntentRecord[] = [
	intentRecord("op-c3000000-0000-4000-8000-000000000003", "BACK-3", R3),
	intentRecord(W4, "BACK-4", R4, { action: "renew" }),
	intentRecord("op-e5000000-0000-4000-8000-000000000005", "BACK-5", R5, { remote: OTHER_ENDPOINT }),
	intentRecord("op-b6000000-0000-4000-8000-000000000006", "BACK-6", R6, { epoch: 2 }),
	intentRecord("op-97000000-0000-4000-8000-000000000007", "BACK-7", null),
	intentRecord("op-88000000-0000-4000-8000-000000000008", "BACK-8", R8, { action: "release" }),
	intentRecord("op-19000000-0000-4000-8000-000000000009", "BACK-9", R9, { format: "tree" }),
];
/** One `ls-remote` over refs/claims/*: ticket → root; BACK-1 has no ref, BACK-3 and BACK-8 moved on. */
const LISTED_ROOTS: Readonly<Record<string, string>> = {
	"BACK-2": R2,
	"BACK-3": "c".repeat(40),
	"BACK-4": R4,
	"BACK-5": R5,
	"BACK-6": R6,
	"BACK-7": R7,
	"BACK-8": "d".repeat(40),
	"BACK-9": R9,
};

function enumerated(records: ClaimIntentRecord[], corrupt = 0): ClaimIntentEnumerationResult {
	return { kind: "enumerated", records, corrupt };
}

function acquireStopView(label: string, options: StopOptions): Body {
	const result = evaluateClaimAcquireStop(options);
	const kind = field(result, "kind");
	if (kind === "outstanding") return { label, kind, operationIds: field(result, "operationIds") };
	if (kind === "clear") return { label, kind, maintenanceOperationIds: field(result, "maintenanceOperationIds") };
	return { label, kind };
}

// ---------------------------------------------------------------------------------------------------------------
// Resolver views (the policy key under)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The settings keys of a full lease block with the three surface keys (config/index.ts:430–442); `transferTimeBox`
 * appears only when the block names the administration key, which no block here does except the problem-order row.
 */
const BASE_KEYS = [
	"enabled",
	"endpoint",
	"storageFormat",
	"lifetime",
	"attemptTimeoutMs",
	"attempts",
	"operationBudgetMs",
	"clockUncertaintyMs",
	"retryPauseBaseMs",
	"retryPauseMaxMs",
].sort(byCodeUnits);

function policyView(label: string, yaml: string): PolicyView {
	const result = resolveClaimSettings(yaml);
	const settings = result.kind === "configured" ? result.settings : undefined;
	const problems = result.kind === "config-invalid" ? result.problems : [];
	return {
		label,
		kind: result.kind,
		keys: settings === undefined ? [] : Object.keys(settings).sort(byCodeUnits),
		// Untyped on purpose: the scaffold leaves ClaimSettings unchanged (no resolver change).
		policy: field(settings, "acquireDependencyPolicy") ?? ABSENT,
		problems: problems.map(({ key, problem }) => ({ key, problem })),
		echoed: problems.filter((entry) => entry.message.includes(SENTINEL)).length,
	};
}

function configuredPolicy(label: string, policy: "strict" | "permissive" | null): PolicyView {
	const keys = policy === null ? BASE_KEYS : [...BASE_KEYS, "acquireDependencyPolicy"].sort(byCodeUnits);
	return { label, kind: "configured", keys, policy: policy ?? ABSENT, problems: [], echoed: 0 };
}

function invalidPolicy(label: string, problems: ProblemView[]): PolicyView {
	return { label, kind: "config-invalid", keys: [], policy: ABSENT, problems, echoed: 0 };
}

function policyLine(value: string): string {
	return `  acquire_dependency_policy:${value === "" ? "" : ` ${value}`}`;
}

const POLICY_KEY = "claims.acquire_dependency_policy";

// ===============================================================================================================

describe("claim-next order", () => {
	test("ord-01: priority first, then the creation instant, then the numeric task ID", () => {
		const pair = [
			task("BACK-1", { priority: "low", createdDate: "2026-01-01 10:00" }),
			task("BACK-2", { priority: "high", createdDate: "2026-03-01 10:00" }),
		];
		// Positive control (catches: no order at all, the input order kept; the older ticket first despite priority).
		expect(orderView("pair", pair, "priority")).toEqual(orderExpected("pair", ["BACK-2", "BACK-1"]));
		// catches: the ID as age (BACK-2 before BACK-3); string IDs (BACK-10 before BACK-3); ascending priority; a
		// missing priority ranked above low (BACK-4); an empty date dropping BACK-6 out of its priority rank.
		const expected = ["BACK-3", "BACK-5", "BACK-10", "BACK-2", "BACK-6", "BACK-1", "BACK-4"];
		expect(orderView("ORDER_SET", ORDER_SET, "priority")).toEqual(orderExpected("ORDER_SET", expected));
	});

	test("ord-02: --order age sorts by the creation instant alone, a missing date after every dated ticket", () => {
		const pair = [
			task("BACK-2", { priority: "high", createdDate: "2026-03-01 10:00" }),
			task("BACK-1", { priority: "low", createdDate: "2026-01-01 10:00" }),
		];
		// Positive control (catches: --order age ignored, priority still first; the input order kept).
		expect(orderView("pair", pair, "age")).toEqual(orderExpected("pair", ["BACK-1", "BACK-2"]));
		// catches: priority applied under age; the ID as age; a missing date as epoch 0 (BACK-6 first) or as NaN.
		const expected = ["BACK-4", "BACK-1", "BACK-3", "BACK-5", "BACK-10", "BACK-2", "BACK-6"];
		expect(orderView("ORDER_SET", ORDER_SET, "age")).toEqual(orderExpected("ORDER_SET", expected));
	});

	test("ord-03: equal priority and equal minute fall back to the numeric ID, never to a new tie-breaker", () => {
		// Title, ordinal and the newer update all favour BACK-10; only the numeric ID puts BACK-9 first.
		const twins = [
			task("BACK-10", {
				priority: "high",
				createdDate: "2026-02-01 10:00",
				title: "Alpha",
				ordinal: 1,
				updatedDate: "2026-03-01 10:00",
			}),
			task("BACK-9", {
				priority: "high",
				createdDate: "2026-02-01 10:00",
				title: "Zulu",
				ordinal: 2,
				updatedDate: "2026-02-01 10:00",
			}),
		];
		// Positive control (catches: no final tie-break, the input order kept; the string ID, BACK-10 before BACK-9).
		expect(orderView("priority", twins, "priority")).toEqual(orderExpected("priority", ["BACK-9", "BACK-10"]));
		// catches: title, ordinal or updatedDate as tie-breaker (none beyond compareTaskIds).
		expect(orderView("age", twins, "age")).toEqual(orderExpected("age", ["BACK-9", "BACK-10"]));
	});

	test("ord-04: creation instants in UTC, an explicit offset honoured, unreadable dates last by ID", () => {
		// Positive control (catches: no parser; a date-only value not at 00:00 UTC).
		expect(taskCreatedAt("2026-02-01")).toBe(Date.UTC(2026, 1, 1));
		const rows: InstantRow[] = [
			{
				text: "2026-02-01 00:00",
				catches: "the written UTC minute read as local time [?]",
				expected: Date.UTC(2026, 1, 1),
			},
			{ text: "2026-01-31 23:59", catches: "minutes dropped", expected: Date.UTC(2026, 0, 31, 23, 59) },
			{ text: "2026-01-31 23:59:30", catches: "seconds rejected", expected: Date.UTC(2026, 0, 31, 23, 59, 30) },
			{ text: "2026-01-31T23:59:30Z", catches: "the T form rejected", expected: Date.UTC(2026, 0, 31, 23, 59, 30) },
			{ text: "2026-02-01T00:00:00+01:00", catches: "the offset ignored", expected: Date.UTC(2026, 0, 31, 23, 0) },
			{ text: "garbage", catches: "an unreadable date as NaN or 0", expected: null },
			{ text: "2026-13-45", catches: "an impossible calendar date rolled over", expected: null },
			{ text: "", catches: "an empty date as epoch 0", expected: null },
			{ text: undefined, catches: "a missing date as epoch 0", expected: null },
		];
		const label = (row: InstantRow) => `${String(row.text)} (catches: ${row.catches})`;
		expect(rows.map((row) => ({ label: label(row), instant: taskCreatedAt(row.text) }))).toEqual(
			rows.map((row) => ({ label: label(row), instant: row.expected })),
		);
		const dated = [
			task("BACK-1", { createdDate: "2026-02-01" }),
			task("BACK-2", { createdDate: "2026-02-01 00:00" }),
			task("BACK-3", { createdDate: "2026-01-31 23:59" }),
			task("BACK-4", { createdDate: "2026-02-01T00:00:00+01:00" }),
			task("BACK-5", { createdDate: "garbage" }),
			task("BACK-6", { createdDate: "2026-13-45" }),
		];
		// catches: equal instants not falling back to the ID; unreadable dates ahead of dated ones.
		const expected = ["BACK-4", "BACK-3", "BACK-1", "BACK-2", "BACK-5", "BACK-6"];
		expect(orderView("age", dated, "age")).toEqual(orderExpected("age", expected));
		expect(orderView("priority", dated, "priority")).toEqual(orderExpected("priority", expected));
	});

	test("ord-05: the configured priority list decides the rank, case-insensitively; unconfigured ranks last", () => {
		const tasks = [
			task("BACK-1", { createdDate: "2026-01-01 10:00" }),
			task("BACK-2", { priority: "medium", createdDate: "2026-01-02 10:00" }),
			task("BACK-3", { priority: "HIGH", createdDate: "2026-01-03 10:00" }),
			task("BACK-4", { priority: "critical", createdDate: "2026-01-04 10:00" }),
		];
		const priorities = ["Critical", "High", "Low"];
		// Positive control (catches: hard-wired high/medium/low; a case-sensitive rank; medium ranked although not
		// configured, so it would precede the older task without priority).
		const expected = ["BACK-4", "BACK-3", "BACK-1", "BACK-2"];
		expect(orderView("configured", tasks, "priority", priorities)).toEqual(orderExpected("configured", expected));
	});

	test("ord-06: neither the ordinal nor the update date takes part in the claim-next order", () => {
		const tasks = [
			task("BACK-1", {
				priority: "high",
				createdDate: "2026-02-01 10:00",
				ordinal: 1,
				updatedDate: "2026-03-01 10:00",
			}),
			task("BACK-2", {
				priority: "high",
				createdDate: "2026-01-01 10:00",
				ordinal: 1000,
				updatedDate: "2026-01-01 10:00",
			}),
		];
		// Positive control (catches: the sortTasks default, ordinal first; the board order by update date).
		expect(orderView("priority", tasks, "priority")).toEqual(orderExpected("priority", ["BACK-2", "BACK-1"]));
		// catches: the same two orders under --order age.
		expect(orderView("age", tasks, "age")).toEqual(orderExpected("age", ["BACK-2", "BACK-1"]));
	});
});

describe("ready selection over the whole local corpus", () => {
	test("sel-01: only ready tickets are candidates; blocked, unresolved and finished ones are counted", () => {
		// Positive control (catches: no selection at all).
		expect(plain(select(SEL_MATCHED.slice(0, 1), SHARED))).toEqual({
			candidates: ["BACK-1"],
			excluded: { blocked: 0, dependencyUnknown: 0, notActionable: 0 },
			diagnostics: [],
		});
		// catches: a missing prerequisite read as done (BACK-5); an ambiguous identity won by the first record (BACK-6);
		// a Done ticket selected (BACK-7); the completed corpus ignored or its location not taken as completion
		// (BACK-2, its record says To Do); a terminal prerequisite status ignored (BACK-3); a blocked chain (BACK-8).
		expect(plain(select(SEL_MATCHED, SHARED))).toEqual({
			candidates: ["BACK-1", "BACK-2", "BACK-3"],
			excluded: { blocked: 2, dependencyUnknown: 2, notActionable: 1 },
			diagnostics: [unknownDiagnostic("BACK-5", ["BACK-99"]), unknownDiagnostic("BACK-6", ["BACK-23"])],
		});
	});

	test("sel-02: readiness sees prerequisites the filter hid", () => {
		const matched = [task("BACK-8", { dependencies: ["BACK-30"] }), task("BACK-9", { dependencies: ["BACK-31"] })];
		const hidden = [
			task("BACK-30", { status: "Done", assignee: ["human-franz"] }),
			task("BACK-31", { status: "In Progress" }),
		];
		const whole = corpusOf([...matched, ...hidden]);
		// Positive control (catches: readiness judged against the filtered set; task-detail.ts:104–110).
		expect(plain(select(matched, whole))).toEqual({
			candidates: ["BACK-8"],
			excluded: { blocked: 1, dependencyUnknown: 0, notActionable: 0 },
			diagnostics: [],
		});
		// catches: a fixture that cannot tell the two apart; against the matched set alone both would be unresolved.
		expect(plain(select(matched, corpusOf(matched)).excluded)).toEqual({
			blocked: 0,
			dependencyUnknown: 2,
			notActionable: 0,
		});
	});

	test("sel-03: the Backlog assignee never decides the selection; unassigned is not unclaimed", () => {
		const assigned = [
			task("BACK-1", { priority: "high", assignee: ["human-maria"] }),
			task("BACK-2", { priority: "medium" }),
			task("BACK-3", { priority: "low", assignee: ["agent-karl"] }),
		];
		const unassigned = [
			task("BACK-1", { priority: "high" }),
			task("BACK-2", { priority: "medium" }),
			task("BACK-3", { priority: "low" }),
		];
		const expected: Body = {
			candidates: ["BACK-1", "BACK-2", "BACK-3"],
			excluded: { blocked: 0, dependencyUnknown: 0, notActionable: 0 },
			diagnostics: [],
		};
		// Positive control (catches: assigned tickets dropped or moved behind unassigned ones).
		expect(plain(select(assigned, corpusOf(assigned)))).toEqual(expected);
		// catches: the selection reading assignee as ownership.
		expect(plain(select(unassigned, corpusOf(unassigned)))).toEqual(plain(select(assigned, corpusOf(assigned))));
	});

	test("sel-04: an empty or only blocked selection ends no-candidates before any network, never widened", async () => {
		// Scanner positive control: a planted sentinel is counted.
		expect(echoes(`planted ${SENTINEL}`)).toBe(1);
		const valid: ClaimNextInput = { owner: OWNER, context: CONTEXT_PATH, selection: SELECTION };
		const noCandidates: Body = { kind: "no-candidates" };
		const emptyBody = nextBody({ status: "rejected", selection: selectionOf([]), stop: noCandidates });
		// Positive control (catches: no claim-next core; a preflight, an operation ID or an attempt before the local
		// selection; the selection not handed to the seam as given).
		expect(await nextView("empty", valid, SHARED_LOCAL, CLAIMS_YAML)).toEqual(
			probedExpected("empty", emptyBody, [SELECTION]),
		);
		const blocked: ClaimLocalTickets = {
			kind: "loaded",
			matched: pick(SEL_MATCHED, ["BACK-4", "BACK-5", "BACK-7"]),
			corpus: SHARED,
			priorities: [],
		};
		const selection: ClaimCandidateSelection = {
			candidates: [],
			excluded: { blocked: 1, dependencyUnknown: 1, notActionable: 1 },
			diagnostics: [
				{
					ticket: "BACK-5",
					cause: "dependency-unknown",
					dependencies: { blocking: [], unknown: ["BACK-99"], unreadable: 0 },
				},
			],
		};
		const input: ClaimNextInput = { ...valid, order: "age", maxCandidates: 7 };
		const body = nextBody({ status: "rejected", order: "age", maxCandidates: 7, selection, stop: noCandidates });
		// catches: blocked or unresolved tickets tried; "only blocked" indistinguishable from empty (FP:421); order and
		// bound not echoed; the owner or the context path in the document or its text.
		expect(await nextView("only blocked", input, blocked, CLAIMS_YAML)).toEqual(
			probedExpected("only blocked", body, [SELECTION]),
		);
		// -28, the local selection runs before the preflight, so a disabled block with an
		// empty selection still ends no-candidates without network. The half with candidates (claims-disabled/5 at the
		// first attempt's preflight) needs a real preflight and is pinned in G; stp-03 pins its document here.
		const disabledYaml = CLAIMS_YAML.replace("  enabled: true", "  enabled: false");
		// catches: `enabled` checked before the selection (claims-disabled on an empty selection) or a preflight first.
		expect(await nextView("disabled, empty", valid, SHARED_LOCAL, disabledYaml)).toEqual(
			probedExpected("disabled, empty", emptyBody, [SELECTION]),
		);
	});

	test("sel-05: diagnostics carry canonical IDs only and count what cannot be one", () => {
		const expectedDependencies: Body = { blocking: [], unknown: ["BACK-98", "BACK-99"], unreadable: 2 };
		const selection = select([RAW], SHARED);
		// Positive control (catches: raw frontmatter echoed; lowercase kept; a control sequence passed through).
		expect(plain(selection)).toEqual({
			candidates: [],
			excluded: { blocked: 0, dependencyUnknown: 1, notActionable: 0 },
			diagnostics: [{ ticket: "BACK-11", cause: "dependency-unknown", dependencies: expectedDependencies }],
		});
		const verdict = claimDependencyVerdict({ ticket: "BACK-11", corpus: SHARED });
		const expectedVerdict: Body = { kind: "unknown", ...expectedDependencies };
		// catches: the verdict of the gate using another projection than the selection.
		expect(plain(verdict)).toEqual(expectedVerdict);
		const text = JSON.stringify({ selection, verdict });
		// catches: an escaped control character, the value with a space or the lowercase ID anywhere in the output.
		expect(["\\u001b", "foo bar", "back-98"].filter((raw) => text.includes(raw))).toEqual([]);
	});
});

describe("claim next input checks before any IO", () => {
	test("inp-01: invalid options end before the local selection; valid ones reach it and nothing else", async () => {
		const valid: ClaimNextInput = { owner: OWNER, context: CONTEXT_PATH, selection: SELECTION };
		// Unreadable local tasks are tasks-unavailable (unavailable/6); ASSUMPTION(scaffold) code.
		const unavailable = nextError("unavailable", "tasks-unavailable");
		// Positive control (catches: no claim-next core; the local tasks read before the configuration; a preflight or
		// an operation ID before the selection; an unreadable task store reported as an empty selection).
		expect(await nextView("valid", valid, UNAVAILABLE, CLAIMS_YAML)).toEqual(
			probedExpected("valid", unavailable, [SELECTION]),
		);
		const rows: InputRow[] = [
			{
				label: "owner missing",
				catches: "an anonymous acquire request",
				input: { context: CONTEXT_PATH, selection: SELECTION },
				expected: nextError("refused", "owner-required"),
				loads: [],
			},
			{
				label: "owner empty",
				catches: "an empty display name accepted",
				input: { ...valid, owner: "" },
				expected: nextError("refused", "owner-required"),
				loads: [],
			},
			{
				label: "owner blank",
				catches: "a blank display name accepted (base trims, surface/index.ts:1270)",
				input: { ...valid, owner: "   " },
				expected: nextError("refused", "owner-required"),
				loads: [],
			},
			{
				label: "context empty",
				catches: "a default context",
				input: { ...valid, context: "" },
				expected: nextError("refused", "context-required"),
				loads: [],
			},
			{
				label: "context relative",
				catches: "a context resolved against the working directory",
				input: { ...valid, context: "contexts/context-1" },
				expected: nextError("refused", "context-invalid"),
				loads: [],
			},
			{
				label: "order newest",
				catches: "an unknown order silently replaced by priority",
				input: { ...valid, order: "newest" },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "max-candidates 0",
				catches: "a bound that allows no attempt",
				input: { ...valid, maxCandidates: 0 },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "max-candidates 51",
				catches: "a bound without an upper limit (1 to 50)",
				input: { ...valid, maxCandidates: 51 },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "max-candidates 2.5",
				catches: "a fractional bound rounded",
				input: { ...valid, maxCandidates: 2.5 },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "max-candidates NaN",
				catches: "NaN passing every comparison",
				input: { ...valid, maxCandidates: Number.NaN },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "ttl 0",
				catches: "the base option rules skipped for next (surface/index.ts:1276)",
				input: { ...valid, ttlMs: 0 },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "hard end without a zone",
				catches: "a local-time hard end",
				input: { ...valid, hardEnd: "2027-01-15T10:00:00" },
				expected: nextError("refused", "invalid-option"),
				loads: [],
			},
			{
				label: "no claims block",
				catches: "the local tasks read before the configuration",
				input: valid,
				yaml: null,
				expected: nextError("refused", "not-configured"),
				loads: [],
			},
			{
				label: "eps missing",
				catches: "the surface keys not required for next",
				input: valid,
				yaml: claimsBlock(LEASE, [], SURFACE.slice(1)),
				expected: nextError("refused", "config-invalid", {
					problems: [{ key: "claims.clock_uncertainty_ms", problem: "missing" }],
				}),
				loads: [],
			},
			{
				label: "hard mode without --hard-end",
				catches: "the acquire request built after the selection",
				input: valid,
				yaml: claimsBlock(HARD),
				expected: nextError("refused", "hard-end-required"),
				loads: [],
			},
			{
				label: "mode none with --ttl-ms",
				catches: "an inapplicable option ignored",
				input: { ...valid, ttlMs: 60_000 },
				yaml: claimsBlock(NONE),
				expected: nextError("refused", "option-not-applicable"),
				loads: [],
			},
			{
				label: "max-candidates 1 passes",
				catches: "an off-by-one lower bound",
				input: { ...valid, maxCandidates: 1 },
				expected: unavailable,
				loads: [SELECTION],
			},
			{
				label: "max-candidates 50 passes",
				catches: "an off-by-one upper bound",
				input: { ...valid, maxCandidates: 50 },
				expected: unavailable,
				loads: [SELECTION],
			},
			{
				label: "order age passes",
				catches: "the alternative order rejected",
				input: { ...valid, order: "age" },
				expected: unavailable,
				loads: [SELECTION],
			},
		];
		const actual: ProbedView[] = [];
		const expected: ProbedView[] = [];
		for (const row of rows) {
			const label = `${row.label} (catches: ${row.catches})`;
			const yaml = row.yaml === null ? undefined : (row.yaml ?? CLAIMS_YAML);
			actual.push(await nextView(label, row.input, UNAVAILABLE, yaml));
			expected.push(probedExpected(label, row.expected, row.loads));
		}
		expect(actual).toEqual(expected);
	});
});

describe("continue or stop per attempt", () => {
	test("stp-01: the continue/stop table, entry by entry, first match wins", () => {
		// Positive control, entry 3 (catches: no step function; an acquisition not recognized as the end).
		expect(claimNextStep({ document: applied("BACK-1"), maintenanceOperationIds: MAINTENANCE })).toBe("claimed");
		const rows: StepRow[] = [
			// Entry 1: unknown stops (3), also the internal error that keeps status unknown after the start.
			{
				label: "operation unknown",
				catches: "an unknown acquisition read as an isolated conflict",
				document: unknownOutcome("BACK-1"),
				expected: "stop",
			},
			{
				label: "internal error with status unknown",
				catches: "a possibly sent operation read by its code instead of its status",
				document: unknownAfterStart("BACK-1"),
				expected: "stop",
			},
			// Entry 2: unknown-history stops (4).
			{
				label: "operation unknown-history",
				catches: "an unsettled history skipped",
				document: unknownHistory("BACK-1"),
				expected: "stop",
			},
			// Entry 4: the isolated conflicts continue.
			{
				label: "plan not-free",
				catches: "a foreign claim ending the search",
				document: planRejected("BACK-1", "not-free"),
				expected: "continue",
			},
			{
				label: "plan held",
				catches: "an own ready claim ending the search (a second ticket is allowed)",
				document: planRejected("BACK-1", "held"),
				expected: "continue",
			},
			{
				label: "storage stale",
				catches: "a lost CAS ending the search",
				document: storageRejected("BACK-1", "stale"),
				expected: "continue",
			},
			{
				label: "resolution not-stored",
				catches: "a settled not-stored ending the search",
				document: notStored("BACK-1"),
				expected: "continue",
			},
			// Entry 5: any other plan cause stops (2): the same timing request meets every candidate alike.
			...OTHER_PLAN_CAUSES.map(
				(cause): StepRow => ({
					label: `plan ${cause}`,
					catches: "a call-wide plan refusal skipped as isolated",
					document: planRejected("BACK-1", cause),
					expected: "stop",
				}),
			),
			// Entry 6: storage remote stops (2).
			{
				label: "storage remote",
				catches: "a server refusal read as isolated",
				document: storageRejected("BACK-1", "remote"),
				expected: "stop",
			},
			// Entry 7: every not-sent cause stops (6), admission-held included.
			...NOT_SENT_CAUSES.map(
				(cause): StepRow => ({
					label: `not sent ${cause}`,
					catches: "a local or same-context failure skipped (admission-held: an own acquire is in flight)",
					document: notSent("BACK-1", cause),
					expected: "stop",
				}),
			),
			// Entry 8: a pause of maintenance operations only continues; any other pause stops (7).
			{
				label: "pause of maintenance operations only",
				catches: "every pause stopping the search",
				document: pauseDoc("BACK-1", { kind: "outstanding", operationIds: [OP_R, OP_W] }),
				expected: "continue",
			},
			{
				label: "pause naming an own acquire",
				catches: "every pause skipped",
				document: pauseDoc("BACK-1", { kind: "outstanding", operationIds: [OP_A] }),
				expected: "stop",
			},
			{
				label: "pause naming an operation outside the enumeration",
				catches: "an unknown ID read as maintenance",
				document: pauseDoc("BACK-1", { kind: "outstanding", operationIds: [OP_X] }),
				expected: "stop",
			},
			{
				label: "pause mixing maintenance and acquire",
				catches: "one maintenance ID enough to continue",
				document: pauseDoc("BACK-1", { kind: "outstanding", operationIds: [OP_R, OP_A] }),
				expected: "stop",
			},
			{
				// -28, an empty list stops (7); only a non-empty list of non-acquire IDs of
				// the pre-phase enumeration continues.
				label: "pause with an empty ID list",
				catches: "a vacuous 'all maintenance' continuing past unreadable IDs",
				document: pauseDoc("BACK-1", { kind: "outstanding", operationIds: [] }),
				expected: "stop",
			},
			{
				label: "pause unknown",
				catches: "an unreadable own journal skipped",
				document: pauseDoc("BACK-1", { kind: "unknown" }),
				expected: "stop",
			},
			// Entry 9: ticket-bounded data errors and a stale selection continue.
			...CONTINUE_CODES.map(
				(code): StepRow => ({
					label: `error ${code}`,
					catches: "a ticket-bounded refusal ending the search, or read as free",
					document: errorAttempt("BACK-1", code),
					expected: "continue",
				}),
			),
			// Entry 10: every other error stops with its status.
			...(Object.keys(CLAIM_ERROR_CODES) as ClaimErrorCode[])
				.filter((code) => !CONTINUE_CODES.includes(code))
				.map(
					(code): StepRow => ({
						label: `error ${code}`,
						catches: "a call-wide or unprovable error skipped as isolated",
						document: errorAttempt("BACK-1", code),
						expected: "stop",
					}),
				),
		];
		const step = (document: ClaimNextAttempt) => claimNextStep({ document, maintenanceOperationIds: MAINTENANCE });
		const label = (row: StepRow) => `${row.label} (catches: ${row.catches})`;
		expect(rows.map((row) => ({ label: label(row), step: step(row.document) }))).toEqual(
			rows.map((row) => ({ label: label(row), step: row.expected })),
		);
	});

	test("stp-02: the drive continues past isolated conflicts and stops at the first acquisition", async () => {
		const candidates = ["BACK-1", "BACK-2", "BACK-3", "BACK-4"];
		const first: DriveRow = {
			label: "applied at once",
			catches: "no drive; attempt never called",
			candidates,
			maxCandidates: 5,
			script: [(ticket) => applied(ticket)],
			expected: {
				calls: ["BACK-1"],
				stop: "claimed",
				untried: 3,
				status: "applied",
				ticket: "BACK-1",
				operationId: OP_1,
			},
		};
		// Positive control (catches: no drive; the attempt seam never called).
		const control = await driveRows([first]);
		expect(control.actual).toEqual(control.expected);
		const rows: DriveRow[] = [
			{
				label: "not-free, stale, applied",
				catches: "a stop at the first conflict; a second reservation after the acquisition (BACK-4 scripted applied)",
				candidates,
				maxCandidates: 5,
				script: [
					(ticket) => planRejected(ticket, "not-free"),
					(ticket) => storageRejected(ticket, "stale", OP_2),
					(ticket) => applied(ticket, OP_3),
					(ticket) => applied(ticket),
				],
				expected: {
					calls: ["BACK-1", "BACK-2", "BACK-3"],
					stop: "claimed",
					untried: 1,
					status: "applied",
					ticket: "BACK-3",
					operationId: OP_3,
				},
			},
		];
		const { actual, expected } = await driveRows(rows);
		expect(actual).toEqual(expected);
	});

	test("stp-03: an unknown or call-wide outcome stops after exactly one attempt and names it", async () => {
		const candidates = ["BACK-1", "BACK-2", "BACK-3"];
		const stopAt = (status: string, operationId: string | null): DriveExpectation => ({
			calls: ["BACK-1"],
			stop: "attempt",
			untried: 2,
			status,
			ticket: "BACK-1",
			operationId,
		});
		const unknownRow: DriveRow = {
			label: "unknown",
			catches: "blind over-reservation after an unknown acquisition",
			candidates,
			maxCandidates: 5,
			script: [(ticket) => unknownOutcome(ticket), (ticket) => applied(ticket)],
			expected: stopAt("unknown", OP_1),
		};
		// Positive control (catches: an unknown read as a conflict; the stopping attempt's ticket or ID dropped).
		const control = await driveRows([unknownRow]);
		expect(control.actual).toEqual(control.expected);
		const rows: DriveRow[] = [
			{
				label: "internal with status unknown",
				catches: "a possibly sent operation read as internal/1",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => unknownAfterStart(ticket), (ticket) => applied(ticket)],
				expected: stopAt("unknown", OP_1),
			},
			{
				label: "unknown-history",
				catches: "an unsettled history skipped",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => unknownHistory(ticket), (ticket) => applied(ticket)],
				expected: stopAt("unknown-history", OP_1),
			},
			{
				label: "not sent, admission held",
				catches: "a parallel acquire of the same context ignored",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => notSent(ticket, "admission-held"), (ticket) => applied(ticket)],
				expected: stopAt("unavailable", OP_1),
			},
			{
				label: "storage remote",
				catches: "a server refusal read as isolated",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => storageRejected(ticket, "remote"), (ticket) => applied(ticket)],
				expected: stopAt("rejected", OP_1),
			},
			{
				label: "plan hard-expired",
				catches: "a call-wide timing refusal retried on every candidate",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => planRejected(ticket, "hard-expired"), (ticket) => applied(ticket)],
				expected: stopAt("rejected", null),
			},
			{
				label: "pause unknown",
				catches: "an unreadable own journal skipped",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => pauseDoc(ticket, { kind: "unknown" }), (ticket) => applied(ticket)],
				expected: stopAt("paused", null),
			},
			{
				label: "storage unreadable",
				catches: "an unreadable ref read as isolated (execution/index.ts:423–426)",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => errorAttempt(ticket, "storage-unreadable"), (ticket) => applied(ticket)],
				expected: stopAt("unavailable", null),
			},
			{
				// -28, a disabled block with candidates ends claims-disabled/5 at the first
				// attempt's preflight; that attempt document is the stopping attempt and stays in `attempts`.
				label: "claims disabled at the first attempt",
				catches: "claims-disabled skipped as isolated; the stopping attempt dropped; status other than refused/5",
				candidates,
				maxCandidates: 5,
				script: [(ticket) => errorAttempt(ticket, "claims-disabled"), (ticket) => applied(ticket)],
				expected: stopAt("refused", null),
			},
		];
		const { actual, expected } = await driveRows(rows);
		expect(actual).toEqual(expected);
	});

	test("stp-04: the bound counts every attempt; exhausted and bound differ by untried tickets", async () => {
		const rejectedWith = (calls: string[], stop: string, untried: number): DriveExpectation => ({
			calls,
			stop,
			untried,
			status: "rejected",
			ticket: null,
			operationId: null,
		});
		const boundRow: DriveRow = {
			label: "bound 2 over four",
			catches: "held not counted; an off-by-one bound",
			candidates: ["BACK-1", "BACK-2", "BACK-3", "BACK-4"],
			maxCandidates: 2,
			script: [(ticket) => planRejected(ticket, "not-free"), (ticket) => planRejected(ticket, "held")],
			expected: rejectedWith(["BACK-1", "BACK-2"], "bound", 2),
		};
		// Positive control (catches: no bound; held not counted as an attempt).
		const control = await driveRows([boundRow]);
		expect(control.actual).toEqual(control.expected);
		const conflicts: Script = [
			(ticket) => planRejected(ticket, "not-free"),
			(ticket) => storageRejected(ticket, "stale", OP_2),
			(ticket) => notStored(ticket, OP_3),
		];
		const rows: DriveRow[] = [
			{
				label: "bound 3 over three conflicts",
				catches: "exhausted and bound swapped; a document naming a ticket without acquisition",
				candidates: ["BACK-1", "BACK-2", "BACK-3"],
				maxCandidates: 3,
				script: conflicts,
				expected: rejectedWith(["BACK-1", "BACK-2", "BACK-3"], "exhausted", 0),
			},
			{
				label: "bound equal to the candidate count",
				catches: "bound reported although every candidate was tried",
				candidates: ["BACK-1", "BACK-2"],
				maxCandidates: 2,
				script: conflicts,
				expected: rejectedWith(["BACK-1", "BACK-2"], "exhausted", 0),
			},
			{
				label: "bound 1 with an own held ticket first",
				catches: "held skipped without counting",
				candidates: ["BACK-1", "BACK-2"],
				maxCandidates: 1,
				script: [(ticket) => planRejected(ticket, "held"), (ticket) => applied(ticket)],
				expected: rejectedWith(["BACK-1"], "bound", 1),
			},
		];
		const { actual, expected } = await driveRows(rows);
		expect(actual).toEqual(expected);
	});

	test("stp-05: ticket-bounded data errors continue and stay visible in the attempts", async () => {
		const first: DriveRow = {
			label: "state-corrupt, state-unsupported, applied",
			catches: "a corrupt state ending the whole search, or read as free",
			candidates: ["BACK-1", "BACK-2", "BACK-3"],
			maxCandidates: 5,
			script: [
				(ticket) => errorAttempt(ticket, "state-corrupt"),
				(ticket) => errorAttempt(ticket, "state-unsupported"),
				(ticket) => applied(ticket),
			],
			expected: {
				calls: ["BACK-1", "BACK-2", "BACK-3"],
				stop: "claimed",
				untried: 0,
				status: "applied",
				ticket: "BACK-3",
				operationId: OP_1,
			},
		};
		// Positive control (catches: a data error of one ticket stopping the call; the error documents dropped).
		const control = await driveRows([first]);
		expect(control.actual).toEqual(control.expected);
		const rows: DriveRow[] = [
			{
				label: "dependency-blocked, ticket-ambiguous, applied",
				catches: "a local state changed since the selection ending the call",
				candidates: ["BACK-1", "BACK-2", "BACK-3"],
				maxCandidates: 5,
				script: [
					(ticket) => errorAttempt(ticket, "dependency-blocked"),
					(ticket) => errorAttempt(ticket, "ticket-ambiguous"),
					(ticket) => applied(ticket),
				],
				expected: {
					calls: ["BACK-1", "BACK-2", "BACK-3"],
					stop: "claimed",
					untried: 0,
					status: "applied",
					ticket: "BACK-3",
					operationId: OP_1,
				},
			},
		];
		const { actual, expected } = await driveRows(rows);
		expect(actual).toEqual(expected);
	});

	test("stp-06: a pause continues only when every named operation is an own maintenance operation", async () => {
		const pausedAtFirst: DriveExpectation = {
			calls: ["BACK-1"],
			stop: "attempt",
			untried: 1,
			status: "paused",
			ticket: "BACK-1",
			operationId: null,
		};
		const maintenanceRow: DriveRow = {
			label: "maintenance pause, then applied",
			catches: "every pause stopping the search",
			candidates: ["BACK-1", "BACK-2"],
			maxCandidates: 5,
			script: [
				(ticket) => pauseDoc(ticket, { kind: "outstanding", operationIds: [OP_R] }),
				(ticket) => applied(ticket),
			],
			expected: {
				calls: ["BACK-1", "BACK-2"],
				stop: "claimed",
				untried: 0,
				status: "applied",
				ticket: "BACK-2",
				operationId: OP_1,
			},
		};
		// Positive control (catches: no drive; a maintenance pause stopping the search).
		const control = await driveRows([maintenanceRow]);
		expect(control.actual).toEqual(control.expected);
		const pausedBy = (operationIds: string[]): Script => [
			(ticket) => pauseDoc(ticket, { kind: "outstanding", operationIds }),
			(ticket) => applied(ticket),
		];
		const rows: DriveRow[] = [
			{
				label: "pause by an own acquire",
				catches: "every pause skipped",
				candidates: ["BACK-1", "BACK-2"],
				maxCandidates: 5,
				script: pausedBy([OP_A]),
				expected: pausedAtFirst,
			},
			{
				label: "pause by an ID outside the enumeration",
				catches: "an unknown ID read as maintenance",
				candidates: ["BACK-1", "BACK-2"],
				maxCandidates: 5,
				script: pausedBy([OP_X]),
				expected: pausedAtFirst,
			},
			{
				label: "pause by maintenance and an acquire",
				catches: "one maintenance ID enough to continue",
				candidates: ["BACK-1", "BACK-2"],
				maxCandidates: 5,
				script: pausedBy([OP_R, OP_A]),
				expected: pausedAtFirst,
			},
		];
		const { actual, expected } = await driveRows(rows);
		expect(actual).toEqual(expected);
	});

	test("stp-07: an own acquire intent still open at its listed root stops claim next on every ticket", () => {
		// ASSUMPTION(scaffold): journal enumeration, byte-exact endpoint, descriptor and the listed roots.
		const observe = (journal: ClaimIntentEnumerationResult, descriptor = BLOB): StopOptions => ({
			journal,
			remote: ENDPOINT,
			descriptor,
			roots: LISTED_ROOTS,
		});
		// Positive control (catches: no acquisition stop; an empty journal read as unknown).
		expect(acquireStopView("empty", observe(enumerated([])))).toEqual({
			label: "empty",
			kind: "clear",
			maintenanceOperationIds: [],
		});
		const all = [...OPEN_ACQUIRES, ...OTHER_RECORDS];
		const tampered: ClaimIntentRecord = { ...intentRecord(A1, "BACK-1", null), digest: "0".repeat(64) };
		const rows: StopRow[] = [
			{
				label: "all records (catches: only the candidate ticket checked; unsorted IDs; null against an absent ref)",
				options: observe(enumerated(all)),
				expected: { kind: "outstanding", operationIds: [A2, A1] },
			},
			{
				label: "no open acquire (catches: a renew blocking; a moved root, endpoint, epoch or format ignored)",
				options: observe(enumerated(OTHER_RECORDS)),
				expected: { kind: "clear", maintenanceOperationIds: [W4] },
			},
			{
				label: "a corrupt entry (catches: corrupt entries ignored; outstanding beating unknown)",
				options: observe(enumerated(all, 1)),
				expected: { kind: "unknown" },
			},
			{
				label: "a record failing its digest (catches: in-memory records not re-validated)",
				options: observe(enumerated([tampered])),
				expected: { kind: "unknown" },
			},
			{
				label: "journal unavailable (catches: an unreadable journal read as empty)",
				options: observe({ kind: "unavailable", reason: "io" }),
				expected: { kind: "unknown" },
			},
			{
				label: "journal invalid (catches: an invalid journal read as empty)",
				options: observe({ kind: "invalid", reason: "seam" }),
				expected: { kind: "unknown" },
			},
			{
				label: "descriptor with epoch 0 (catches: an invalid observation evaluated anyway)",
				options: observe(enumerated(all), { schema: 1, format: "blob", epoch: 0 }),
				expected: { kind: "invalid" },
			},
		];
		expect(rows.map((row) => acquireStopView(row.label, row.options))).toEqual(
			rows.map((row): Body => ({ label: row.label, ...row.expected })),
		);
	});
});

describe("claim-next document, codes and text", () => {
	const selection: ClaimCandidateSelection = {
		candidates: ["BACK-3", "BACK-1", "BACK-2"],
		excluded: { blocked: 1, dependencyUnknown: 1, notActionable: 2 },
		diagnostics: [
			{
				ticket: "BACK-5",
				cause: "dependency-unknown",
				dependencies: { blocking: [], unknown: ["BACK-99"], unreadable: 1 },
			},
		],
	};
	/** Upstream-looking extras on every nested object of a selection: a spread would carry them into the document. */
	const taintedSelection = (source: ClaimCandidateSelection): ClaimCandidateSelection =>
		tainted({
			candidates: source.candidates,
			excluded: tainted(source.excluded),
			diagnostics: source.diagnostics.map((entry) =>
				tainted({ ticket: entry.ticket, cause: entry.cause, dependencies: tainted(entry.dependencies) }),
			),
		});
	const outstanding: ClaimNextStop = { kind: "outstanding-acquire", operationIds: [OP_A, OP_B] };

	function buildNext(row: NextRow): ClaimDocument {
		// ASSUMPTION(scaffold): see driveView.
		return claimNextDocument({
			order: "priority",
			maxCandidates: row.maxCandidates,
			selection: taintedSelection(row.selection),
			attempts: row.attempts,
			untried: row.untried,
			stop: tainted(row.stop),
		});
	}

	function rowBody(row: NextRow): Body {
		const operationIds = field(row.stop, "operationIds");
		return nextBody({
			status: row.expected.status,
			maxCandidates: row.maxCandidates,
			ticket: row.expected.ticket,
			operationId: row.expected.operationId,
			selection: row.selection,
			attempts: row.attempts,
			untried: row.untried,
			stop: operationIds === undefined ? { kind: row.stop.kind } : { kind: row.stop.kind, operationIds },
		});
	}

	test("doc-n1: every stop kind yields exactly the claim next keys, status, exit, ticket and operation ID", () => {
		const claimed: NextRow = {
			label: "claimed after a conflict",
			catches: "no builder; a spread of the selection; the conflict's null ID taken; attempts rewritten",
			selection,
			attempts: [planRejected("BACK-3", "not-free"), applied("BACK-1", OP_1)],
			untried: 1,
			stop: { kind: "claimed" },
			maxCandidates: 5,
			expected: { status: "applied", ticket: "BACK-1", operationId: OP_1 },
		};
		// Positive control (catches: no claim-next document; owner, path, endpoint or root carried in by a spread).
		expect(viewOf(claimed.label, buildNext(claimed))).toEqual(expectedView(claimed.label, rowBody(claimed)));
		const rows: NextRow[] = [
			{
				label: "no candidates",
				catches: "an empty selection as ok/0; the counts dropped",
				selection: {
					candidates: [],
					excluded: { blocked: 2, dependencyUnknown: 1, notActionable: 0 },
					diagnostics: selection.diagnostics,
				},
				attempts: [],
				untried: 0,
				stop: { kind: "no-candidates" },
				maxCandidates: 5,
				expected: { status: "rejected", ticket: null, operationId: null },
			},
			{
				label: "exhausted",
				catches: "the last conflict's ticket or ID reported as the result",
				selection,
				attempts: [
					planRejected("BACK-3", "not-free"),
					storageRejected("BACK-1", "stale", OP_2),
					notStored("BACK-2", OP_3),
				],
				untried: 0,
				stop: { kind: "exhausted" },
				maxCandidates: 5,
				expected: { status: "rejected", ticket: null, operationId: null },
			},
			{
				label: "bound",
				catches: "the effective bound not echoed; bound as exhausted",
				selection,
				attempts: [planRejected("BACK-3", "not-free"), planRejected("BACK-1", "held")],
				untried: 1,
				stop: { kind: "bound" },
				maxCandidates: 2,
				expected: { status: "rejected", ticket: null, operationId: null },
			},
			{
				label: "attempt unknown",
				catches: "an unknown stop reported as rejected; its operation ID dropped (claim resolve needs it)",
				selection,
				attempts: [planRejected("BACK-3", "not-free"), unknownOutcome("BACK-1", OP_1)],
				untried: 1,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "unknown", ticket: "BACK-1", operationId: OP_1 },
			},
			{
				label: "attempt unknown after the start",
				catches: "status taken from the code (internal/1) instead of the document (unknown/3)",
				selection,
				attempts: [unknownAfterStart("BACK-3", OP_1)],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "unknown", ticket: "BACK-3", operationId: OP_1 },
			},
			{
				label: "attempt unknown-history",
				catches: "exit 3 instead of 4",
				selection,
				attempts: [unknownHistory("BACK-3", OP_1)],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "unknown-history", ticket: "BACK-3", operationId: OP_1 },
			},
			{
				label: "attempt paused",
				catches: "a pause mapped to rejected; an operation ID invented for a pause",
				selection,
				attempts: [pauseDoc("BACK-3", { kind: "outstanding", operationIds: [OP_A] })],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "paused", ticket: "BACK-3", operationId: null },
			},
			{
				label: "attempt refused",
				catches: "a refusal inside the loop reported as rejected/2",
				selection,
				attempts: [errorAttempt("BACK-3", "request-invalid")],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "refused", ticket: "BACK-3", operationId: null },
			},
			{
				label: "attempt not sent",
				catches: "not-sent reported without the prepared operation ID",
				selection,
				attempts: [notSent("BACK-3", "admission-held", OP_1)],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "unavailable", ticket: "BACK-3", operationId: OP_1 },
			},
			{
				label: "attempt internal",
				catches: "an internal attempt error hidden behind rejected",
				selection,
				attempts: [errorAttempt("BACK-3", "internal")],
				untried: 2,
				stop: { kind: "attempt" },
				maxCandidates: 5,
				expected: { status: "internal", ticket: "BACK-3", operationId: null },
			},
			{
				label: "outstanding acquire",
				catches: "the cross-ticket stop as rejected; the IDs dropped or their roots carried along",
				selection,
				attempts: [],
				untried: 3,
				stop: outstanding,
				maxCandidates: 5,
				expected: { status: "paused", ticket: null, operationId: null },
			},
			{
				label: "journal unknown",
				catches: "an unreadable own journal read as clear",
				selection,
				attempts: [],
				untried: 3,
				stop: { kind: "journal-unknown" },
				maxCandidates: 5,
				expected: { status: "paused", ticket: null, operationId: null },
			},
		];
		const label = (row: NextRow) => `${row.label} (catches: ${row.catches})`;
		expect(rows.map((row) => viewOf(label(row), buildNext(row)))).toEqual(
			rows.map((row) => expectedView(label(row), rowBody(row))),
		);
	});

	test("doc-n2: the three new codes carry their statuses and exits; the plain helper adds no dependencies", () => {
		// Positive control (catches: the gate refusal filed as unavailable or as a rejection).
		expect(CLAIM_ERROR_CODES["dependency-blocked"]).toBe("refused");
		// tasks-unavailable is the one code for unreadable local tasks (unavailable/6), shared with the batch reclaim.
		const rows: { code: ClaimErrorCode; status: string; catches: string }[] = [
			{ code: "dependency-blocked", status: "refused", catches: "a blocked ticket reported as unavailable" },
			{ code: "dependency-unknown", status: "refused", catches: "unresolved prerequisites merged into blocked" },
			{ code: "tasks-unavailable", status: "unavailable", catches: "an unreadable task store reported as refused" },
		];
		const cases = rows.map((row) => ({
			label: `${row.code} (catches: ${row.catches})`,
			status: row.status,
			code: row.code,
			doc: claimErrorDocument({ command: "next", code: row.code }),
		}));
		// catches: a message missing or naming a path; an empty dependencies list attached to every error document.
		expect(cases.map((entry) => viewOf(entry.label, entry.doc))).toEqual(
			cases.map((entry) => expectedView(entry.label, nextError(entry.status, entry.code))),
		);
		// catches: a fixed message with a path separator, which the allowlist scanner reads as a leaked path (
		// Rule).
		expect(cases.map((entry) => ({ label: entry.label, slash: entry.doc.message.includes("/") }))).toEqual(
			cases.map((entry) => ({ label: entry.label, slash: false })),
		);
		// catches: a refusal of the gate printed on stdout.
		expect(cases.map((entry) => textView(entry.label, entry.doc, null))).toEqual(
			cases.map((entry) => textExpected(entry.label, entry.status, null)),
		);
	});

	test("doc-n3: the human text starts with the status, uses stderr only for failures and names the way out", () => {
		const unknownDoc = nextDoc("unknown", { kind: "attempt" }, [unknownOutcome("BACK-2", OP_1)], "BACK-2", OP_1);
		// Positive control (catches: no claim-next text; an unknown stop without `claim resolve <operation-id>`).
		expect(textView("unknown", unknownDoc, { command: "claim resolve", ids: [OP_1] })).toEqual(
			textExpected("unknown", "unknown", { command: "claim resolve", ids: [OP_1] }),
		);
		const rows: TextRow[] = [
			{
				label: "claimed",
				catches: "an acquisition on stderr",
				doc: nextDoc("applied", { kind: "claimed" }, [applied("BACK-1")], "BACK-1", OP_1),
				hint: null,
			},
			{
				label: "no candidates",
				catches: "an empty selection on stderr like an error",
				doc: nextDoc("rejected", { kind: "no-candidates" }, [], null, null),
				hint: null,
			},
			{
				label: "exhausted",
				catches: "a text first line that is not the status",
				doc: nextDoc("rejected", { kind: "exhausted" }, [planRejected("BACK-1", "not-free")], null, null),
				hint: null,
			},
			{
				label: "bound",
				catches: "a text first line that is not the status",
				doc: nextDoc("rejected", { kind: "bound" }, [planRejected("BACK-1", "held")], null, null),
				hint: null,
			},
			{
				label: "outstanding acquire",
				catches: "the stop without the operation IDs or without `claim retry` (way out)",
				doc: nextDoc("paused", { kind: "outstanding-acquire", operationIds: [OP_A, OP_B] }, [], null, null),
				hint: { command: "claim retry", ids: [OP_A, OP_B] },
			},
			{
				label: "journal unknown",
				catches: "a paused stop without any way out",
				doc: nextDoc("paused", { kind: "journal-unknown" }, [], null, null),
				hint: { command: null, ids: [] },
			},
			{
				label: "attempt paused",
				catches: "the attempt's open operations not named",
				doc: nextDoc(
					"paused",
					{ kind: "attempt" },
					[pauseDoc("BACK-1", { kind: "outstanding", operationIds: [OP_A] })],
					"BACK-1",
					null,
				),
				hint: { command: "claim retry", ids: [OP_A] },
			},
			{
				label: "attempt unknown after the start",
				catches: "the resolve hint only for claim-operation attempts",
				doc: nextDoc("unknown", { kind: "attempt" }, [unknownAfterStart("BACK-1", OP_1)], "BACK-1", OP_1),
				hint: { command: "claim resolve", ids: [OP_1] },
			},
			{
				label: "attempt unknown-history",
				catches: "an unsettled history on stderr",
				doc: nextDoc("unknown-history", { kind: "attempt" }, [unknownHistory("BACK-1", OP_1)], "BACK-1", OP_1),
				hint: null,
			},
			{
				label: "attempt refused",
				catches: "a refusal on stdout",
				doc: nextDoc("refused", { kind: "attempt" }, [errorAttempt("BACK-1", "request-invalid")], "BACK-1", null),
				hint: null,
			},
			{
				label: "attempt not sent",
				catches: "an unavailable stop on stdout",
				doc: nextDoc("unavailable", { kind: "attempt" }, [notSent("BACK-1", "admission-held")], "BACK-1", OP_1),
				hint: null,
			},
			{
				label: "attempt internal",
				catches: "an internal stop on stdout",
				doc: nextDoc("internal", { kind: "attempt" }, [errorAttempt("BACK-1", "internal")], "BACK-1", null),
				hint: null,
			},
		];
		// catches in every row: owner, context path, endpoint, binding or root printed from fields outside the document.
		const label = (row: TextRow) => `${row.label} (catches: ${row.catches})`;
		expect(rows.map((row) => textView(label(row), row.doc, row.hint))).toEqual(
			rows.map((row) => textExpected(label(row), row.doc.status, row.hint)),
		);
	});
});

describe("dependency policy", () => {
	test("dep-01: the verdict fails closed on isBlocked, never on isReady, over the whole corpus", () => {
		const verdict = (ticket: string) => claimDependencyVerdict({ ticket, corpus: SHARED });
		// Positive control (catches: no verdict, every ticket clear).
		expect(plain(verdict("BACK-4"))).toEqual({ kind: "blocked", blocking: ["BACK-22"], unknown: [], unreadable: 0 });
		const rows: { ticket: string; catches: string; expected: Body }[] = [
			{ ticket: "BACK-1", catches: "a ticket without prerequisites refused", expected: { kind: "clear" } },
			{ ticket: "BACK-2", catches: "the completed corpus ignored", expected: { kind: "clear" } },
			{ ticket: "BACK-3", catches: "a Done prerequisite read as open", expected: { kind: "clear" } },
			{
				ticket: "BACK-5",
				catches: "a missing prerequisite read as done",
				expected: { kind: "unknown", blocking: [], unknown: ["BACK-99"], unreadable: 0 },
			},
			{
				ticket: "BACK-6",
				catches: "an identity claimed twice resolved by the first record",
				expected: { kind: "unknown", blocking: [], unknown: ["BACK-23"], unreadable: 0 },
			},
			{
				ticket: "BACK-7",
				catches: "isReady instead of isBlocked: a Done ticket stays directly acquirable",
				expected: { kind: "clear" },
			},
			{
				ticket: "BACK-8",
				catches: "a blocking ticket that is itself blocked read as done",
				expected: { kind: "blocked", blocking: ["BACK-4"], unknown: [], unreadable: 0 },
			},
			{
				ticket: "BACK-9",
				catches: "unknown winning over blocked; one of the two lists dropped",
				expected: { kind: "blocked", blocking: ["BACK-22"], unknown: ["BACK-99"], unreadable: 0 },
			},
			{
				ticket: "BACK-11",
				catches: "raw values listed instead of canonical IDs",
				expected: { kind: "unknown", blocking: [], unknown: ["BACK-98", "BACK-99"], unreadable: 2 },
			},
		];
		const label = (row: { ticket: string; catches: string }) => `${row.ticket} (catches: ${row.catches})`;
		expect(rows.map((row) => ({ label: label(row), verdict: plain(verdict(row.ticket)) }))).toEqual(
			rows.map((row) => ({ label: label(row), verdict: row.expected })),
		);
		// [?] The contract fixes only the kind for a ticket the corpus lacks; its dependency lists are left open.
		// catches: a ticket missing from the corpus read as free of prerequisites.
		expect(verdict("BACK-12").kind).toBe("unknown");
	});

	test("dep-02: the policy key is optional, validated when named, never defaulted; problems in schema order", () => {
		// Characterization, green on the scaffold: a block without the key resolves as today.
		expect(policyView("no key", CLAIMS_YAML)).toEqual(configuredPolicy("no key", null));
		// Positive control (catches: the key reported as unknown-key; strict dropped).
		expect(policyView("strict", claimsBlock(LEASE, [policyLine("strict")]))).toEqual(
			configuredPolicy("strict", "strict"),
		);
		const rows: PolicyRow[] = [
			{
				label: "permissive",
				catches: "only strict accepted",
				yaml: claimsBlock(LEASE, [policyLine("permissive")]),
				policy: "permissive",
			},
			{
				label: "strict in mode none",
				catches: "the key made mode-dependent (not-applicable)",
				yaml: claimsBlock(NONE, [policyLine("strict")]),
				policy: "strict",
			},
			{
				label: "permissive in mode hard",
				catches: "the key made mode-dependent",
				yaml: claimsBlock(HARD, [policyLine("permissive")]),
				policy: "permissive",
			},
			{
				label: "named without a value",
				catches: "null read as strict (a named key without a value is missing)",
				yaml: claimsBlock(LEASE, [policyLine("")]),
				problems: [{ key: POLICY_KEY, problem: "missing" }],
			},
			{
				label: "a number",
				catches: "a non-string coerced",
				yaml: claimsBlock(LEASE, [policyLine("1")]),
				problems: [{ key: POLICY_KEY, problem: "wrong-type" }],
			},
			{
				label: "a boolean",
				catches: "true read as strict",
				yaml: claimsBlock(LEASE, [policyLine("true")]),
				problems: [{ key: POLICY_KEY, problem: "wrong-type" }],
			},
			{
				label: "another word",
				catches: "an unknown policy read as permissive",
				yaml: claimsBlock(LEASE, [policyLine("lenient")]),
				problems: [{ key: POLICY_KEY, problem: "unsupported-value" }],
			},
			{
				label: "another case",
				catches: "a case-insensitive value (any other string is unsupported)",
				yaml: claimsBlock(LEASE, [policyLine("Strict")]),
				problems: [{ key: POLICY_KEY, problem: "unsupported-value" }],
			},
			{
				label: "an empty string",
				catches: "an empty string read as missing or as strict",
				yaml: claimsBlock(LEASE, [policyLine('""')]),
				problems: [{ key: POLICY_KEY, problem: "unsupported-value" }],
			},
			{
				label: "a sentinel value",
				catches: "the value repeated in the problem message",
				yaml: claimsBlock(LEASE, [policyLine(SENTINEL)]),
				problems: [{ key: POLICY_KEY, problem: "unsupported-value" }],
			},
			{
				label: "named twice",
				catches: "the key outside the resolver's duplicate detector",
				yaml: claimsBlock(LEASE, [policyLine("strict"), policyLine("permissive")]),
				problems: [{ key: POLICY_KEY, problem: "duplicate" }],
			},
			{
				// config/index.ts:314–400 per key in SCHEMA_KEYS order, :402–413 the cross-key rule, :415–419 unknown keys
				// in document order; the new key is appended last to SCHEMA_KEYS, after the administration key
				// transfer_time_box. The block names the unknown key, the policy key and the administration key first, so
				// document order cannot produce the expected order. ASSUMPTION(administration): transfer_time_box exists,
				// `keep` is unsupported.
				label: "problem order",
				catches: "the key inserted elsewhere in SCHEMA_KEYS, checked after the cross-key rule or in document order",
				yaml: [
					"claims:",
					"  acquire_dependency_check: true",
					policyLine("lenient"),
					"  transfer_time_box: keep",
					"  enabled: true",
					`  endpoint: ${JSON.stringify(ENDPOINT)}`,
					"  storage_format: blob",
					"  lifetime_mode: lease",
					"  lease_ttl_ms: 0",
					"  reclaim_grace_ms: 600000",
					"  attempt_timeout_ms: 10000",
					"  attempts: 3",
					"  operation_budget_ms: 30000",
					"  clock_uncertainty_ms: -1",
					"  retry_pause_base_ms: 3000",
					"  retry_pause_max_ms: 2000",
				].join("\n"),
				problems: [
					{ key: "claims.lease_ttl_ms", problem: "out-of-range" },
					{ key: "claims.clock_uncertainty_ms", problem: "out-of-range" },
					{ key: "claims.transfer_time_box", problem: "unsupported-value" },
					{ key: POLICY_KEY, problem: "unsupported-value" },
					{ key: "claims.retry_pause_max_ms", problem: "out-of-range" },
					{ key: "claims.acquire_dependency_check", problem: "unknown-key" },
				],
			},
		];
		const label = (row: PolicyRow) => `${row.label} (catches: ${row.catches})`;
		const expected = (row: PolicyRow): PolicyView =>
			row.problems === undefined
				? configuredPolicy(label(row), row.policy ?? null)
				: invalidPolicy(label(row), row.problems);
		expect(rows.map((row) => policyView(label(row), row.yaml))).toEqual(rows.map(expected));
	});

	test("dep-03: the acquire gate sits between the local lookup and the preflight, for acquire only", async () => {
		// Positive control (catches: a ready ticket refused; the call not reaching the preflight option check).
		const ready = await gateView("ready", acquire("BACK-1"), CLAIMS_YAML, SHARED_LOCAL);
		expect({ exit: ready.exit, body: ready.body }).toEqual({
			exit: 5,
			body: errorBody("refused", "preflight-invalid"),
		});
		const strictYaml = claimsBlock(LEASE, [policyLine("strict")]);
		const permissiveYaml = claimsBlock(LEASE, [policyLine("permissive")]);
		const preflight = (ticket: string, command = "acquire") =>
			errorBody("refused", "preflight-invalid", {}, command, ticket);
		const refusal = (code: string, ticket: string, blocking: string[], unknown: string[], unreadable = 0) =>
			errorBody("refused", code, { dependencies: { blocking, unknown, unreadable } }, "acquire", ticket);
		// The seam's `unavailable` is tasks-unavailable (unavailable/6) for the gate as well.
		const tasksUnavailable = errorBody("unavailable", "tasks-unavailable", {}, "acquire", "BACK-1");
		// Every row ends at a local check, the gate, the administration context pre-check or the preflight option check;
		// nothing is prepared or recorded, so no row can pause a later one.
		const rows: GateRow[] = [
			{
				label: "strict by default, ready",
				catches: "no corpus load under the default (fail-open); the seam asked for a selection instead of null",
				input: acquire("BACK-1"),
				expected: preflight("BACK-1"),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, blocked",
				catches: "the gate after the preflight or missing; the blocking list dropped",
				input: acquire("BACK-4"),
				expected: refusal("dependency-blocked", "BACK-4", ["BACK-22"], []),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, unresolved",
				catches: "a missing prerequisite read as satisfied",
				input: acquire("BACK-5"),
				expected: refusal("dependency-unknown", "BACK-5", [], ["BACK-99"]),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, raw prerequisites",
				catches: "raw frontmatter values in the error document",
				input: acquire("BACK-11"),
				expected: refusal("dependency-unknown", "BACK-11", [], ["BACK-98", "BACK-99"], 2),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, blocked and unresolved",
				catches: "dependency-unknown although one prerequisite is unfinished",
				input: acquire("BACK-9"),
				expected: refusal("dependency-blocked", "BACK-9", ["BACK-22"], ["BACK-99"]),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, Done ticket with an open prerequisite",
				catches: "isReady instead of isBlocked",
				input: acquire("BACK-7"),
				expected: preflight("BACK-7"),
				loads: [null],
				lookups: 1,
			},
			{
				label: "strict by default, tasks unavailable",
				catches: "an unreadable task store passing the gate; dependencies attached to the wrong code",
				input: acquire("BACK-1"),
				local: UNAVAILABLE,
				expected: tasksUnavailable,
				loads: [null],
				lookups: 1,
			},
			{
				label: "explicit strict, blocked",
				catches: "the explicit value treated differently from the default",
				input: acquire("BACK-4"),
				yaml: strictYaml,
				expected: refusal("dependency-blocked", "BACK-4", ["BACK-22"], []),
				loads: [null],
				lookups: 1,
			},
			{
				label: "permissive, blocked",
				catches: "permissive ignored",
				input: acquire("BACK-4"),
				yaml: permissiveYaml,
				expected: preflight("BACK-4"),
				loads: [],
				lookups: 1,
			},
			{
				label: "permissive, tasks unavailable",
				catches: "the corpus loaded although no gate runs",
				input: acquire("BACK-1"),
				yaml: permissiveYaml,
				local: UNAVAILABLE,
				expected: preflight("BACK-1"),
				loads: [],
				lookups: 1,
			},
			{
				label: "renew, blocked",
				catches: "a gate on renew",
				input: maintain("renew", "BACK-4"),
				expected: preflight("BACK-4", "renew"),
				loads: [],
				lookups: 0,
			},
			{
				label: "release, blocked",
				catches: "a gate on release",
				input: maintain("release", "BACK-4"),
				expected: preflight("BACK-4", "release"),
				loads: [],
				lookups: 0,
			},
			{
				label: "reclaim, blocked",
				catches: "a gate on reclaim",
				input: maintain("reclaim", "BACK-4"),
				expected: preflight("BACK-4", "reclaim"),
				loads: [],
				lookups: 0,
			},
			// The frozen contract adds resume and change-bounds to the commands that never check; the administration rows
			// below need the administration tree (ASSUMPTION(administration)). Transfer and resume end at the administration
			// context pre-check on NO_CONTEXTS, so they only show that nothing loads the corpus before it; change-bounds has
			// no pre-check and reaches the preflight.
			{
				label: "transfer, blocked",
				catches: "a corpus load on transfer",
				input: { command: "transfer", ticket: "BACK-4", context: CONTEXT_PATH, toContext: TARGET_PATH, owner: OWNER },
				expected: errorBody("refused", "context-invalid", {}, "transfer", "BACK-4"),
				loads: [],
				lookups: 0,
			},
			{
				label: "resume, blocked",
				catches: "a corpus load on resume",
				input: { command: "resume", ticket: "BACK-4", context: CONTEXT_PATH },
				expected: errorBody("refused", "context-invalid", {}, "resume", "BACK-4"),
				loads: [],
				lookups: 0,
			},
			{
				label: "change-bounds, blocked",
				catches: "a gate on change-bounds",
				input: { command: "change-bounds", ticket: "BACK-4", context: CONTEXT_PATH, mode: "none" },
				expected: preflight("BACK-4", "change-bounds"),
				loads: [],
				lookups: 0,
			},
			{
				label: "no local task file",
				catches: "the gate before the local lookup (after it)",
				input: acquire("BACK-404"),
				expected: errorBody("refused", "ticket-not-found", {}, "acquire", "BACK-404"),
				loads: [],
				lookups: 1,
			},
			{
				label: "owner missing",
				catches: "the corpus loaded before the input checks",
				input: { command: "acquire", ticket: "BACK-1", context: CONTEXT_PATH },
				expected: errorBody("refused", "owner-required"),
				loads: [],
				lookups: 0,
			},
		];
		const actual: ProbedView[] = [];
		const expected: ProbedView[] = [];
		for (const row of rows) {
			const label = `${row.label} (catches: ${row.catches})`;
			actual.push(await gateView(label, row.input, row.yaml ?? CLAIMS_YAML, row.local ?? SHARED_LOCAL));
			expected.push(probedExpected(label, row.expected, row.loads, row.lookups));
		}
		expect(actual).toEqual(expected);
		// [?] The contract fixes the code for a ticket the corpus lacks, not its dependency lists.
		const absent = await gateView("absent from the corpus", acquire("BACK-12"), CLAIMS_YAML, SHARED_LOCAL);
		// catches: a ticket with a local file but without a corpus record read as free of prerequisites.
		expect({ code: field(absent.body, "code"), exit: absent.exit, loads: absent.loads }).toEqual({
			code: "dependency-unknown",
			exit: 5,
			loads: [null],
		});
		// Resolve, list and retry never check either; each reaches the preflight option check.
		const entries: EntryRow[] = [
			{
				label: "retry",
				catches: "a gate on the identical resend",
				run: (env) => runClaimRetry({ operationId: OP_1, context: CONTEXT_PATH }, env),
				expected: errorBody("refused", "preflight-invalid", {}, "retry", null, OP_1),
			},
			{
				label: "resolve",
				catches: "a corpus load on a read-only query",
				run: (env) => runClaimResolve({ operationId: OP_1, context: CONTEXT_PATH }, env),
				expected: errorBody("refused", "preflight-invalid", {}, "resolve", null, OP_1),
			},
			{
				label: "list",
				catches: "a corpus load on the listing",
				run: (env) => runClaimList({ context: CONTEXT_PATH }, env),
				expected: errorBody("refused", "preflight-invalid", {}, "list", null),
			},
		];
		const entryViews: ProbedView[] = [];
		const entryExpected: ProbedView[] = [];
		for (const row of entries) {
			const label = `${row.label} (catches: ${row.catches})`;
			const probe: Probe = { loads: [], ids: 0, lookups: 0 };
			const doc = await row.run(stubEnv(probe, SHARED_LOCAL, CLAIMS_YAML));
			entryViews.push({ ...viewOf(label, doc), ...probe });
			entryExpected.push(probedExpected(label, row.expected, []));
		}
		expect(entryViews).toEqual(entryExpected);
	});
});
