/**
 * Level P: the pure parts of batch reclaim and its preview. Pinned here: the scope rule over the finished selection and
 * the blank-value report, before `--context`, configuration and network; canonical, deduplicated tickets in
 * compareTaskIds order; the per-ticket verdict of the preview and of the batch selection; the `--claim-owner` match on
 * the stored ACTIVE owner without silent drops; the preview entry fields; the closed stop list; the overall status rank
 * with its invariants; the batch document with its allowlist and text.
 * The verdict oracle is the product planner itself, `planClaimTransition` with `{action: "reclaim"}`, and the boundary
 * comes from `evaluateClaimRight(...).reclaim.boundary` (rights/index.ts:57); this file holds no reclaimability rule of
 * its own. No Git, no network, no subprocess, no wall clock and no real sleep: the two IO entry points run only with
 * scopes and an env that end before any IO (no claims block, seams that note and refuse every call). No call reaches
 * the executor, so no own intent can pause a later call. Every test starts with a positive control; table rows name the
 * deliberately wrong implementation they catch. Names the typed scaffold adds are marked ASSUMPTION(scaffold).
 * Harness: adapted copies with "adapted from" notes, no shared fixture module.
 */
import { describe, expect, test } from "bun:test";
import type { ClaimOperationPause } from "../claims/pause/index.ts";
import { type ClaimTiming, evaluateClaimRight } from "../claims/rights/index.ts";
import type {
	ClaimReadResult,
	ClaimStorageDescriptor,
	JsonObject,
	ClaimDocument as StoredClaimDocument,
} from "../claims/storage/index.ts";
// ASSUMPTION(scaffold): the reclaim names exist with these shapes minus findTicketsByFilter;
// ClaimReclaimScopeInput carries `selection`, `ready` and `blankOptions` instead of raw filter values;
// ClaimSurfaceEnv carries the mandatory seam loadLocalTickets of claim next; both new
// document types are members of ClaimDocument, so claimExitCode and formatClaimDocumentText accept them.
import {
	CLAIM_ERROR_CODES,
	type ClaimErrorCode,
	type ClaimErrorDocument,
	type ClaimOperationDocument,
	type ClaimPauseDocument,
	type ClaimReclaimBatchDocument,
	type ClaimReclaimPreviewEntry,
	type ClaimReclaimScope,
	type ClaimReclaimScopeInput,
	type ClaimStatus,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimExitCode,
	claimReclaimBatchDocument,
	claimReclaimScope,
	claimReclaimStops,
	claimReclaimVerdict,
	runClaimReclaimBatch,
	runClaimReclaimPreview,
} from "../claims/surface/index.ts";
import { planClaimTransition } from "../claims/transition/index.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";

type Body = Record<string, unknown>;
/** One per-ticket document of the batch: exactly what `claim reclaim <ticket>` prints. */
type Entry = ClaimOperationDocument | ClaimPauseDocument | ClaimErrorDocument;
type StorageView = NonNullable<ClaimOperationDocument["storage"]>;
type RejectionView = NonNullable<ClaimOperationDocument["rejection"]>;
type Queried = Extract<StorageView, { kind: "queried" }>;
type NotSentCause = Extract<StorageView, { kind: "not-sent" }>["cause"];
type PauseView = ClaimPauseDocument["pause"];
type BatchInput = Parameters<typeof claimReclaimBatchDocument>[0];
type BatchEntryInput = BatchInput["entries"][number];
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
/** ASSUMPTION(scaffold): the `loadLocalTickets` result type, reached through the env field instead of an import. */
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type ContextSeam = NonNullable<ClaimSurfaceEnv["contextIO"]>;
type JournalSeam = NonNullable<ClaimSurfaceEnv["journalIO"]>;
/**
 * ASSUMPTION(scaffold): the finished selection the CLI builds with src/commands/task-filter-options.ts,
 * typed as the `loadLocalTickets` seam parameter: `{filter: TaskListFilter; query?}`.
 */
type TicketSelection = NonNullable<Parameters<ClaimSurfaceEnv["loadLocalTickets"]>[0]>;
type Verb = "reclaim-batch" | "reclaim-preview";
/** A valid scope as source, restrictions, the passed-on selection and `--ready`; a refusal as its code. */
type ScopeView =
	| { code: string }
	| { source: unknown; tickets: unknown; claimOwners: unknown; selection: unknown; ready: boolean };
type ScopeRow = { label: string; catches: string; input: ClaimReclaimScopeInput; expected: ScopeView };
/** A scope error and a `--context` error, or a `--context` error and a configuration error. */
type PrecedenceRow = { label: string; catches: string; input: ClaimReclaimScopeInput; context: string; code: string };
type CanonicalRow = { label: string; catches: string; tickets: string[]; expected: string[] };
/** An IO entry point's answer to a scope: the error envelope, the exit code, echoes and every seam call. */
type CallView = {
	label: string;
	kind: string;
	status: string;
	command: string;
	code: unknown;
	exit: number;
	echoed: number;
	calls: string[];
};
type VerdictRow = {
	label: string;
	catches: string;
	observed: ClaimReadResult | null;
	now: number;
	/** Fixture facts for the expected entry: the stored generation and, for ACTIVE, the owner and the timing. */
	generation: number | null;
	active: { owner: string; timing: ClaimTiming } | null;
};
type TimedState = { name: string; timing: ClaimTiming; boundary: number; catches: string };
type EntryView = { label: string; keys: string[] | null; entry: Body | null; echoed: number };
type OwnerRow = VerdictRow & { single: boolean; either: boolean };
type OperationForm = {
	status: ClaimOperationDocument["status"];
	outcome: ClaimOperationDocument["outcome"];
	storage: StorageView | null;
	rejection?: RejectionView;
	sends: number;
	stoppedBy?: "attempts" | "budget";
};
type StopRow = { label: string; catches: string; document: Entry; stops: boolean };
type EntryKind =
	| "applied"
	| "rejected"
	| "unknown"
	| "unknown-after-start"
	| "unknown-history"
	| "not-sent"
	| "unreadable-error"
	| "paused"
	| "refused"
	| "internal";
type StopKind = "refused-stop" | "paused-stop";
type AggRow = {
	label: string;
	catches: string;
	tried: readonly EntryKind[];
	stop?: StopKind;
	untried?: number;
	complete?: boolean;
	unreadable?: readonly string[];
	status: ClaimStatus;
};
type AggView = {
	label: string;
	status: string;
	exit: number;
	stoppedAt: string | null;
	tickets: string[];
	results: string[];
	withoutUntried: string | null;
	i1: boolean;
	i2: boolean;
};
type BatchView = { label: string; exit: number; keys: string[]; entryKeys: string[][]; body: Body; echoed: number };
type LineView = { ticket: string; count: number; result: string; operationShown: boolean | null };
type TextView = { label: string; head: string | null; lines: LineView[]; echoed: number };
type KeyRow = { label: string; catches: string; row: VerdictRow; pause?: ClaimOperationPause; keys: string[] };
type KeyView = { label: string; keys: string[] | null; pause: unknown; echoed: number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; the other instants derive from it. */
const T = 1_800_000_000_000;
/** clock_uncertainty_ms and grace of the base fixtures (claim-surface-git.test.ts:45, :47). */
const EPS = 2_000;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05"; the grid below sits around its boundary "10:15" (lease end plus grace). */
const L = T + 5 * MINUTE;
const R = L + GRACE;
/** A hard work limit "11:00" above the lease end of a lease that carries one. */
const H = T + 60 * MINUTE;
/** A hard-mode claim ending "10:20"; the grid sits around "10:30". */
const HARD_END = T + 20 * MINUTE;
const RH = HARD_END + GRACE;
const GENERATION = 3;
const TOMBSTONE_GENERATION = 4;
const TICKET = "BACK-1";
const OP = "op-7c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a45";
const OP_OTHER = "op-e4a1c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c5d";
/** The injected monotonic clock never moves, so no budget runs out. */
const MONO_START = 5_000;
/** Upstream reasons, roots, bindings, digests and paths carry sentinels; no public output may contain one. */
const SENTINEL = "SENTINEL-reclaim-surface-5e19";
/** KARL holds every stored claim; LENA previews and reclaims. */
const KARL = `tb1-${"4b".repeat(32)}`;
const LENA = `tb1-${"6f".repeat(32)}`;
const ROOT = "a1".repeat(20);
const DIGEST = "c3".repeat(32);
const REASON = `upstream ${SENTINEL} ${KARL} ${ROOT}`;
/** Display names: `owner` may appear in preview entries, never in a batch document. */
const OWNER = "agent-karl";
const OTHER_OWNER = "agent-franz";
/**
 * Absolute and never created. Without a claims block every surface path ends before it is used: the preflight resolver
 * answers `not-configured` first (config/index.ts:280), also inside the preflight after its option check (:478, :497),
 * before the Git repository check (:511) and before any context load (:515).
 */
const PROJECT_ROOT = `/nonexistent-${SENTINEL}/project`;
const CONTEXT_PATH = `/nonexistent-${SENTINEL}/contexts/context-1`;
const SENSITIVE: readonly string[] = [SENTINEL, KARL, LENA, ROOT, DIGEST];
/** A batch document carries no owner name at all. */
const BATCH_SENSITIVE: readonly string[] = [...SENSITIVE, OWNER, OTHER_OWNER];
/** Fields a spread of an input wrapper would leak into a batch document (built field by field). */
const TAINT = { binding: KARL, root: ROOT, reason: REASON, owner: OWNER };
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
const RECEIPTS: Record<string, JsonObject> = {
	"op-first": { schema: 1, intentDigest: DIGEST, parameterDigest: DIGEST },
};
/** The closed status table, written out so the constant under test is not its own oracle. */
// adapted from claim-surface.test.ts:132-142
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
/** Placeholders that never equal a real value, instead of a raw `undefined` inside an expectation. */
// adapted from claim-execution-retry.test.ts:82 (ABSENT_REF)
const NO_CODE = "(no code)";
const NO_LINE = "(no line)";
const NO_PAUSE = "(no pause)";
const UNMAPPED = "(unmapped plan)";
const BATCH_KEYS = [
	"schemaVersion",
	"kind",
	"status",
	"command",
	"observedAt",
	"complete",
	"unreadable",
	"stoppedAt",
	"entries",
].sort(byCodeUnits);
const ENTRY_KEYS = ["ticket", "result", "document"].sort(byCodeUnits);
/** The closed verdict list of a preview entry. */
const ALL_VERDICTS = [
	"eligible",
	"not-yet",
	"never",
	"free",
	"absent",
	"unknown",
	"state-corrupt",
	"state-unsupported",
].sort(byCodeUnits);

/** The closed stop list for `claim-error` documents; `claim-pause {unknown}` is the one further stop. */
const STOP_CODES: readonly string[] = [
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
/** The base list, copied token for token from claim-surface.test.ts:145-157 (43 codes). */
const CODES_705 = `
	project-not-found project-config-unreadable invalid-ticket ticket-not-found ticket-ambiguous
	owner-required context-required invalid-option option-not-applicable hard-end-required
	invalid-operation-id operation-id-in-use not-configured config-invalid claims-disabled
	context-invalid context-corrupt context-unavailable descriptor-missing format-mismatch
	schema-unsupported coordination-corrupt unreachable preflight-invalid preflight-unknown
	request-invalid local-unavailable storage-unreadable state-corrupt state-unsupported state-unknown
	budget-exhausted operation-not-found record-corrupt scope-mismatch
	list-unavailable already-configured config-write-failed format-conflict not-empty remote-rejected
	init-unknown internal
`
	.trim()
	.split(/\s+/);
/** Four additive codes. */
const CODES_715 = ["target-context-invalid", "target-context-unavailable", "recovery-missing", "bounds-required"];
/** Three additive codes. */
const CODES_710 = ["dependency-blocked", "dependency-unknown", "tasks-unavailable"];
/** The batch reclaim code, appended to the base list after the claim next codes. */
const CODES_711 = ["scope-required"];
/** Every code of CLAIM_ERROR_CODES as it stands after claim next with the batch reclaim name: 43 + 4 + 3 + 1 = 51. */
const ALL_CODES: readonly string[] = [...CODES_705, ...CODES_715, ...CODES_710, ...CODES_711];
/** Transport and IO codes: a single one proves no call-wide fault. */
const TRANSPORT_CODES: readonly string[] = [
	"unreachable",
	"preflight-unknown",
	"context-unavailable",
	"storage-unreadable",
	"tasks-unavailable",
	"budget-exhausted",
];
/** The plan causes of the base mapper (surface/index.ts:556-572); three of them carry a boundary. */
const PLAN_CAUSES = [
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
];
const BOUNDED_CAUSES: readonly string[] = ["hard-expired", "overlong", "not-yet"];
/** The not-sent causes of the base mapper (surface/index.ts:541-553). */
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
/** Seam entry names as the preflight checks them and the journal uses them (config/index.ts:454-456, journal:10). */
const CONTEXT_SEAM_NAMES = ["open", "lstat", "mkdir", "link", "unlink"];
const JOURNAL_SEAM_NAMES = ["open", "lstat", "link", "unlink", "readdir"];

// adapted from claim-surface.test.ts:183-187
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface.test.ts:189-193
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-surface.test.ts:195-197, with the value list per output
function echoes(text: string, values: readonly string[]): number {
	return values.filter((value) => text.includes(value)).length;
}

// adapted from claim-surface.test.ts:199-201
function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

function sortedKeys(value: object): string[] {
	return Object.keys(value).sort(byCodeUnits);
}

function ticketAt(index: number): string {
	return `BACK-${index + 1}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scope: refusals and valid scopes of the pure scope function and of both IO entry points.
// ---------------------------------------------------------------------------------------------------------------

function scope(
	source: "tickets" | "refs",
	tickets: string[] | null,
	owners: string[] | null,
	selection: TicketSelection | null = null,
	ready = false,
): ScopeView {
	return { source, tickets, claimOwners: owners, selection, ready };
}

function refusal(code: string): ScopeView {
	return { code };
}

/**
 * Source, tickets and owners; the selection and `--ready` by name only, so a differently
 * shaped scaffold fails here at run time instead of breaking the type check of the whole file.
 */
function scopeView(result: ClaimReclaimScope | ClaimErrorCode): ScopeView {
	if (typeof result === "string") return { code: result };
	return {
		source: result.source,
		tickets: result.tickets,
		claimOwners: result.claimOwners,
		// ASSUMPTION(batch reclaim): the scope passes the finished selection on unchanged, or null without one.
		selection: field(result, "selection") ?? null,
		ready: field(result, "ready") === true,
	};
}

/** A refusing seam: notes `<label>.<name>` and rejects; nothing at level P may reach context or journal IO. */
function refusingSeam<S>(calls: string[], label: string, names: readonly string[]): S {
	const seam: Record<string, () => Promise<never>> = {};
	for (const name of names) {
		seam[name] = () => {
			calls.push(`${label}.${name}`);
			return Promise.reject(new Error(`level P: no ${label} IO`));
		};
	}
	return seam as unknown as S;
}

/**
 * No claims block, an absolute project root that does not exist, a monotonic clock that never moves, and seams that
 * note every call in `calls`; the IO seams also refuse. Every call of this file ends before any of them is needed.
 */
// adapted from claim-surface-administration.test.ts:261-281 (env), with recording seams instead of scripted ones
function refusingEnv(calls: string[]): ClaimSurfaceEnv {
	return {
		projectRoot: PROJECT_ROOT,
		claimsYaml: undefined,
		taskPrefix: "BACK",
		findLocalTicket: () => {
			calls.push("findLocalTicket");
			const missing: LocalTicket = { kind: "missing" };
			return Promise.resolve(missing);
		},
		clock: () => {
			calls.push("clock");
			return T;
		},
		monotonicNow: () => MONO_START,
		random: () => {
			calls.push("random");
			return 0.5;
		},
		sleep: () => {
			calls.push("sleep");
			return Promise.resolve();
		},
		newOperationId: () => {
			calls.push("newOperationId");
			return OP;
		},
		// ASSUMPTION(scaffold): the mandatory seam; `unavailable` ends in tasks-unavailable.
		loadLocalTickets: () => {
			calls.push("loadLocalTickets");
			const unavailable: LocalTickets = { kind: "unavailable" };
			return Promise.resolve(unavailable);
		},
		contextIO: refusingSeam<ContextSeam>(calls, "context", CONTEXT_SEAM_NAMES),
		journalIO: refusingSeam<JournalSeam>(calls, "journal", JOURNAL_SEAM_NAMES),
	};
}

async function callView(
	label: string,
	verb: Verb,
	input: ClaimReclaimScopeInput,
	context = CONTEXT_PATH,
): Promise<CallView> {
	const calls: string[] = [];
	const env = refusingEnv(calls);
	const request = { scope: input, context };
	const doc =
		verb === "reclaim-batch" ? await runClaimReclaimBatch(request, env) : await runClaimReclaimPreview(request, env);
	return {
		label,
		kind: doc.kind,
		status: doc.status,
		command: doc.command,
		code: field(doc, "code") ?? NO_CODE,
		exit: claimExitCode(doc),
		echoed: echoes(JSON.stringify(doc), SENSITIVE),
		calls,
	};
}

/** Every refusal of this file is `refused`/5 (for scope-required for the reused codes). */
function refusedCall(label: string, verb: Verb, code: string): CallView {
	return {
		label,
		kind: "claim-error",
		status: "refused",
		command: verb,
		code,
		exit: EXPECTED_EXIT.refused ?? -1,
		echoed: 0,
		calls: [],
	};
}

/**
 * The code an IO entry point answers for a scope row: its refusal, or `not-configured` for a valid scope without a
 * ticket filter or `--ready`; such a scope may consult `loadLocalTickets` before the configuration (an order the
 * contract leaves open [?4]), so it stays out of the IO rows (null).
 */
function callCode(row: ScopeRow): string | null {
	if ("code" in row.expected) return row.expected.code;
	return row.input.selection === undefined && row.input.ready !== true ? "not-configured" : null;
}

/** Finished selections as the shared module hands them over (`--labels` matches all labels). */
const IN_PROGRESS: TicketSelection = { filter: { status: "In Progress" } };
const LABEL_X: TicketSelection = { filter: { labels: ["x"], labelMatch: "all" } };
const UNASSIGNED: TicketSelection = { filter: { unassigned: true } };
const SEARCH: TicketSelection = { filter: {}, query: "needle" };
/** A selection that names no criterion: the module's output when every filter flag was absent or blank. */
const NO_CRITERIA: TicketSelection = { filter: {} };
/** Relative on purpose: `context-invalid` before any IO (surface/index.ts:1079-1082, the base rule). */
const RELATIVE_CONTEXT = `contexts-${SENTINEL}/context-1`;

/**
 * The text filter flags of `task list`. The CLI reports each one given with only blank values in
 * `blankOptions`; `claimReclaimScope` refuses any non-empty report. The catches keep the
 * widening each raw row caught before the addendum; the per-flag detection itself is the module's (E).
 */
const BLANK_REPORTS: { flag: string; catches: string }[] = [
	{
		flag: "--status",
		catches: "a blank status dropped silently (parseDelimitedStringList, task-builders.ts:259-266)",
	},
	{ flag: "--exclude-status", catches: "a blank exclusion read as no filter" },
	{ flag: "--labels", catches: 'a list of blank labels (",") read as no filter' },
	{ flag: "--type", catches: "a blank type read as no filter" },
	{ flag: "--project", catches: "a blank project read as no filter" },
	{ flag: "--search", catches: "a blank query matching every ticket" },
	{ flag: "--assignee", catches: "a blank assignee read as no filter" },
	{ flag: "--milestone", catches: "a blank milestone read as no filter" },
	{ flag: "--parent", catches: "a blank parent read as no filter" },
	{ flag: "--priority", catches: "a blank priority read as no filter" },
];

/** Rows: missing scope, blank values, `--all` next to another option, bad IDs. */
const SCOPE_ROWS: ScopeRow[] = [
	{
		label: "--all alone",
		catches: "the explicit project-wide scope read as missing",
		input: { all: true },
		expected: scope("refs", null, null),
	},
	{
		label: "--all with a selection that names no criterion",
		catches: "an empty selection (every filter flag absent) counted as a second scope option",
		input: { all: true, selection: NO_CRITERIA },
		expected: scope("refs", null, null),
	},
	{
		label: "--claim-owner alone",
		catches: "the claim owner ignored as a scope; owners listed from the explicit ticket path",
		input: { claimOwners: [OWNER] },
		expected: scope("refs", null, [OWNER]),
	},
	{
		label: "--claim-owner with a trailing blank",
		catches: "a trimmed owner widening the byte-exact match",
		input: { claimOwners: [`${OWNER} `] },
		expected: scope("refs", null, [`${OWNER} `]),
	},
	{
		label: "--status alone",
		catches: "a ticket filter not accepted as a scope; the finished selection rebuilt or dropped",
		input: { selection: IN_PROGRESS },
		expected: scope("refs", null, null, IN_PROGRESS),
	},
	{
		label: "--search alone",
		catches: "the query of a selection not counted as a filter",
		input: { selection: SEARCH },
		expected: scope("refs", null, null, SEARCH),
	},
	{
		label: "--ready alone",
		catches: "--ready not offered as a scope option",
		input: { ready: true },
		expected: scope("refs", null, null, null, true),
	},
	{
		label: "--unassigned alone",
		catches: "a boolean filter flag read as blank",
		input: { selection: UNASSIGNED },
		expected: scope("refs", null, null, UNASSIGNED),
	},
	{
		label: "--ready with --status",
		catches: "--ready dropped next to a selection, or folded into it",
		input: { selection: IN_PROGRESS, ready: true },
		expected: scope("refs", null, null, IN_PROGRESS, true),
	},
	{
		label: "--ticket with a label filter",
		catches: "the filter dropped next to explicit tickets (intersection); explicit tickets listed instead of read",
		input: { tickets: ["BACK-1"], selection: LABEL_X },
		expected: scope("tickets", ["BACK-1"], null, LABEL_X),
	},
	{
		label: "--ticket with --claim-owner",
		catches: "one of two narrowing options dropped",
		input: { tickets: ["BACK-1"], claimOwners: [OWNER] },
		expected: scope("tickets", ["BACK-1"], [OWNER]),
	},
	{
		label: "an empty blank-value report",
		catches: "an empty report read as a blank option",
		input: { selection: IN_PROGRESS, blankOptions: [] },
		expected: scope("refs", null, null, IN_PROGRESS),
	},
	{
		label: "no scope option",
		catches: "a missing scope read as project-wide",
		input: {},
		expected: refusal("scope-required"),
	},
	{
		label: "--all false",
		catches: "a false flag read as the project-wide scope",
		input: { all: false },
		expected: refusal("scope-required"),
	},
	{
		label: "a selection that names no criterion",
		catches: "an empty selection read as every local ticket",
		input: { selection: NO_CRITERIA },
		expected: refusal("scope-required"),
	},
	{
		label: "--ready false",
		catches: "a false boolean counted as a given filter",
		input: { ready: false },
		expected: refusal("scope-required"),
	},
	{
		label: "--ticket without a value",
		catches: "an empty ticket list read as no restriction (as in task-builders.ts:277, [] means not given)",
		input: { tickets: [] },
		expected: refusal("scope-required"),
	},
	{
		label: '--ticket ""',
		catches: "a blank ticket dropped and the scope widened",
		input: { tickets: [""] },
		expected: refusal("scope-required"),
	},
	{
		label: '--ticket " "',
		catches: "a whitespace ticket dropped and the scope widened",
		input: { tickets: [" "] },
		expected: refusal("scope-required"),
	},
	{
		label: '--claim-owner ""',
		catches: "a blank owner matching every owner",
		input: { claimOwners: [""] },
		expected: refusal("scope-required"),
	},
	{
		label: '--claim-owner " "',
		catches: "a whitespace owner kept as a byte-exact name",
		input: { claimOwners: [" "] },
		expected: refusal("scope-required"),
	},
	...BLANK_REPORTS.map(
		(report): ScopeRow => ({
			label: `${report.flag} reported blank`,
			catches: `the blank-value report ignored: ${report.catches}`,
			input: { selection: NO_CRITERIA, blankOptions: [report.flag] },
			expected: refusal("scope-required"),
		}),
	),
	{
		label: "a blank report without a selection",
		catches: "a report ignored because no selection came with it",
		input: { blankOptions: ["--search"] },
		expected: refusal("scope-required"),
	},
	{
		label: "a blank --status next to a valid --ticket",
		catches: "a blank option dropped because another option narrows (still a silent widening)",
		input: { tickets: ["BACK-1"], selection: NO_CRITERIA, blankOptions: ["--status"] },
		expected: refusal("scope-required"),
	},
	{
		label: "a blank --labels next to a valid --claim-owner",
		catches: "a blank filter dropped next to a valid owner",
		input: { claimOwners: [OWNER], blankOptions: ["--labels"] },
		expected: refusal("scope-required"),
	},
	{
		label: "a blank --labels next to a valid --status",
		catches: "a blank report dropped because the selection still narrows",
		input: { selection: IN_PROGRESS, blankOptions: ["--labels"] },
		expected: refusal("scope-required"),
	},
	{
		label: "a blank --claim-owner next to a valid --status",
		catches: "a blank owner dropped next to a valid filter",
		input: { claimOwners: [" "], selection: IN_PROGRESS },
		expected: refusal("scope-required"),
	},
	{
		label: "--all with --ticket",
		catches: "--all combined with a narrowing option, one of them silently winning",
		input: { all: true, tickets: ["BACK-1"] },
		expected: refusal("invalid-option"),
	},
	{
		label: "--all with --claim-owner",
		catches: "--all combined with the owner filter",
		input: { all: true, claimOwners: [OWNER] },
		expected: refusal("invalid-option"),
	},
	{
		label: "--all with --status",
		catches: "--all combined with a ticket filter",
		input: { all: true, selection: IN_PROGRESS },
		expected: refusal("invalid-option"),
	},
	{
		label: "--all with --ready",
		catches: "--all combined with a boolean filter",
		input: { all: true, ready: true },
		expected: refusal("invalid-option"),
	},
	{
		label: '--ticket "no id"',
		catches: "an invalid ID dropped, or read as a search",
		input: { tickets: ["no id"] },
		expected: refusal("invalid-ticket"),
	},
	{
		label: "an invalid ID among valid ones",
		catches: "an invalid ID dropped silently while the others run",
		input: { tickets: ["BACK-1", "no id"] },
		expected: refusal("invalid-ticket"),
	},
];

/**
 * Scope → `--context` → configuration. Each row carries two errors of
 * neighbouring groups; the earlier group wins, decided before any IO. Configuration here is the missing claims block.
 */
const PRECEDENCE_ROWS: PrecedenceRow[] = [
	{
		label: "a missing scope and a missing --context",
		catches: "--context checked before the scope",
		input: {},
		context: "",
		code: "scope-required",
	},
	{
		label: "a blank report and a relative --context",
		catches: "--context checked before the blank-value report",
		input: { selection: NO_CRITERIA, blankOptions: ["--status"] },
		context: RELATIVE_CONTEXT,
		code: "scope-required",
	},
	{
		label: "--all with --ticket and a relative --context",
		catches: "--context checked before the --all combination",
		input: { all: true, tickets: ["BACK-1"] },
		context: RELATIVE_CONTEXT,
		code: "invalid-option",
	},
	{
		label: "an invalid ID and a missing --context",
		catches: "--context checked before the ticket IDs",
		input: { tickets: ["no id"] },
		context: "",
		code: "invalid-ticket",
	},
	{
		label: "a valid scope, a missing --context and no claims block",
		catches: "the configuration read before --context",
		input: { tickets: ["BACK-1"] },
		context: "",
		code: "context-required",
	},
	{
		label: "a valid scope, a relative --context and no claims block",
		catches: "the configuration read before the --context shape",
		input: { all: true },
		context: RELATIVE_CONTEXT,
		code: "context-invalid",
	},
];

/** Canonical, deduplicated, compareTaskIds order; the single path's forms (surface/index.ts:1072). */
const CANONICAL_ROWS: CanonicalRow[] = [
	{
		label: "leading zeros",
		catches: "a zero-padded ID read as another ticket (canonicalTaskId drops them, task-id.ts:32-35)",
		tickets: ["BACK-09", "BACK-9"],
		expected: ["BACK-9"],
	},
	{
		label: "a bare number takes the project prefix",
		catches: "the task prefix ignored; a bare number refused although `claim reclaim 9` accepts it",
		tickets: ["9", "BACK-9"],
		expected: ["BACK-9"],
	},
	{
		label: "numeric order",
		catches: "lexical order (BACK-100 < BACK-20 < BACK-3)",
		tickets: ["BACK-100", "BACK-20", "BACK-3"],
		expected: ["BACK-3", "BACK-20", "BACK-100"],
	},
	{
		label: "dotted subtasks",
		catches: "a subtask merged with its parent or sorted before it",
		tickets: ["BACK-3.1", "BACK-3", "BACK-2"],
		expected: ["BACK-2", "BACK-3", "BACK-3.1"],
	},
];

// ---------------------------------------------------------------------------------------------------------------
// Verdict: observations, the planner oracle and the expected preview entry.
// ---------------------------------------------------------------------------------------------------------------

const LEASE: ClaimTiming = { mode: "lease", leaseEnd: L, graceMs: GRACE, hardEnd: null };
const LEASE_UNDER_H: ClaimTiming = { mode: "lease", leaseEnd: L, graceMs: GRACE, hardEnd: H };
const HARD: ClaimTiming = { mode: "hard", hardEnd: HARD_END, graceMs: GRACE };
const TIMELESS: ClaimTiming = { mode: "none" };

function activeState(timing: ClaimTiming, owner: string): Body {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: GENERATION,
		bindingGeneration: 1,
		owner,
		binding: KARL,
		timing,
	};
}

const TOMBSTONE: Body = { claimState: 1, status: "free", claimGeneration: TOMBSTONE_GENERATION };
/** ACTIVE without its other fields: the rights module reads it as corrupt (rights/index.ts:169-186). */
const CORRUPT: Body = { claimState: 1, status: "active", claimGeneration: GENERATION };
/** The rights module reads a newer claimState and an unknown status as unsupported (rights/index.ts:161-165). */
const NEWER_VERSION: Body = { claimState: 2, status: "active", claimGeneration: GENERATION };
const PENDING: Body = { claimState: 1, status: "pending", claimGeneration: GENERATION };

/** A stored claim document with the sentinel root and receipt digests; rights decodes the payload separately. */
// adapted from claim-transition.test.ts:134-149 (documentOf, present)
function present(payload: Body): ClaimReadResult {
	const document = {
		schema: 1,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		revision: 2,
		payload,
		receipts: structuredClone(RECEIPTS),
	};
	return { kind: "present", ticket: TICKET, root: ROOT, document: document as unknown as StoredClaimDocument };
}

const ABSENT: ClaimReadResult = { kind: "absent", ticket: TICKET };
const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: REASON };

function activeRow(label: string, catches: string, timing: ClaimTiming, now: number, owner = OWNER): VerdictRow {
	return {
		label,
		catches,
		observed: present(activeState(timing, owner)),
		now,
		generation: GENERATION,
		active: { owner, timing },
	};
}

function stateRow(label: string, catches: string, observed: ClaimReadResult | null, generation: number | null = null) {
	const row: VerdictRow = { label, catches, observed, now: R + EPS, generation, active: null };
	return row;
}

const TIMED: TimedState[] = [
	{
		name: "lease",
		timing: LEASE,
		boundary: R,
		catches: "the lease end instead of lease end + grace; C ≥ R without eps; > instead of ≥ at C − eps = R",
	},
	{
		name: "lease under a hard end",
		timing: LEASE_UNDER_H,
		boundary: R,
		catches: "the hard end instead of lease end + grace for a lease that carries one",
	},
	{
		name: "hard",
		timing: HARD,
		boundary: RH,
		catches: "the hard end instead of hard end + grace; the lease rule applied to the hard mode",
	},
];
/** Fixture positions around each boundary; which side is which is the planner's answer, not this table's. */
const OFFSETS: { name: string; offset: number }[] = [
	{ name: "boundary − eps − 1", offset: -EPS - 1 },
	{ name: "boundary", offset: 0 },
	{ name: "boundary + eps − 1", offset: EPS - 1 },
	{ name: "boundary + eps", offset: EPS },
	{ name: "boundary + eps + 1", offset: EPS + 1 },
];

const VERDICT_ROWS: VerdictRow[] = [
	...TIMED.flatMap((state) =>
		OFFSETS.map((at) =>
			activeRow(`${state.name} at ${at.name}`, state.catches, state.timing, state.boundary + at.offset),
		),
	),
	activeRow("timeless just past the lease grid", "a timeless claim reclaimable (its R is ∞)", TIMELESS, R + EPS + 1),
	activeRow("timeless a year later", "a timeless claim reclaimable after some fixed age", TIMELESS, T + 365 * DAY),
	stateRow("tombstone", "a FREE tombstone offered as a candidate", present(TOMBSTONE), TOMBSTONE_GENERATION),
	stateRow("absent ref", "an absent ticket read as free or eligible", ABSENT),
	stateRow("corrupt payload", "a corrupt state read as free or eligible", present(CORRUPT)),
	stateRow("newer state version", "a newer claimState read as corrupt or reclaimable", present(NEWER_VERSION)),
	stateRow("pending status", "PENDING reclaimed before the time path (state-unsupported until then)", present(PENDING)),
	stateRow("unread ticket", "an unread ticket read as free, eligible or dropped", null),
	stateRow("unreachable read", "a failed read read as free", UNREACHABLE),
];

/** The caller variants of ver-01; the planner never checks ownership for reclaim (transition/index.ts:389-394). */
const CALLERS: { name: string; binding: string; catches: string }[] = [
	{ name: "LENA (foreign)", binding: LENA, catches: "a foreign reclaimable claim skipped" },
	{ name: "KARL (the holder)", binding: KARL, catches: "own claims excluded from reclaim (no ownership check)" },
];

const PLAN_VERDICTS: Record<string, string> = { "not-yet": "not-yet", never: "never", free: "free", absent: "absent" };
const FAILURE_VERDICTS: Record<string, string> = {
	corrupt: "state-corrupt",
	unsupported: "state-unsupported",
	unknown: "unknown",
};

/**
 * The oracle: the product planner's reclaim plan against the same observation, instant, eps and binding, mapped onto
 * the verdict names; the boundary from the rights evaluator the planner uses itself. An unread ticket
 * has no observation to plan against and is `unknown`.
 */
function oracle(row: VerdictRow, binding: string): { verdict: string; boundary: number | undefined } {
	if (row.observed === null) return { verdict: "unknown", boundary: undefined };
	const options = {
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed: row.observed,
		binding,
		now: row.now,
		clockSkewMs: EPS,
	};
	const plan = planClaimTransition({ ...options, request: { action: "reclaim" } });
	let verdict = UNMAPPED;
	if (plan.kind === "planned") verdict = "eligible";
	else if (plan.kind === "rejected") verdict = PLAN_VERDICTS[plan.cause] ?? UNMAPPED;
	else verdict = FAILURE_VERDICTS[plan.kind] ?? UNMAPPED;
	const rights = evaluateClaimRight(options);
	if (rights.kind !== "evaluated") return { verdict, boundary: undefined };
	const { reclaim } = rights;
	const bounded = reclaim.kind === "eligible" || reclaim.kind === "not-yet";
	return { verdict, boundary: bounded ? reclaim.boundary : undefined };
}

/**
 * `ticket` and `verdict` always; `claimGeneration` whenever
 * the stored state carries one (ACTIVE and FREE tombstones); `owner` and `timing` only for ACTIVE; `boundary` only for
 * eligible and not-yet; `pause` only when the caller passes an open or unknown view.
 */
function expectedEntry(row: VerdictRow): Body {
	const { verdict, boundary } = oracle(row, LENA);
	const entry: Body = { ticket: TICKET, verdict };
	if (row.generation !== null) entry.claimGeneration = row.generation;
	if (row.active !== null) {
		entry.owner = row.active.owner;
		entry.timing = { ...row.active.timing };
	}
	if ((verdict === "eligible" || verdict === "not-yet") && boundary !== undefined) entry.boundary = boundary;
	return entry;
}

function verdictFor(
	row: VerdictRow,
	binding: string,
	claimOwners: string[] | null,
	pause?: ClaimOperationPause,
): ClaimReclaimPreviewEntry | null {
	return claimReclaimVerdict({
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed: row.observed,
		binding,
		now: row.now,
		clockSkewMs: EPS,
		claimOwners,
		...(pause === undefined ? {} : { pause }),
	});
}

function entryView(label: string, entry: ClaimReclaimPreviewEntry | null): EntryView {
	if (entry === null) return { label, keys: null, entry: null, echoed: 0 };
	return {
		label,
		keys: sortedKeys(entry),
		entry: Object.fromEntries(Object.entries(entry)),
		echoed: echoes(JSON.stringify(entry), SENSITIVE),
	};
}

function expectedEntryView(label: string, entry: Body | null): EntryView {
	return { label, keys: entry === null ? null : sortedKeys(entry), entry, echoed: 0 };
}

/** Setup view of the grid: every verdict reached, and every timed state seen on both sides of its boundary. */
function gridCoverage(): { verdicts: string[]; sides: { state: string; verdicts: string[] }[] } {
	const verdicts = [...new Set(VERDICT_ROWS.map((row) => oracle(row, LENA).verdict))].sort(byCodeUnits);
	const sides = TIMED.map((state) => {
		const rows = VERDICT_ROWS.filter((row) => row.label.startsWith(`${state.name} at `));
		const seen = new Set(rows.map((row) => oracle(row, LENA).verdict));
		return { state: state.name, verdicts: [...seen].sort(byCodeUnits) };
	});
	return { verdicts, sides };
}

/**
 * ver-02 at the eligible instant: which states the filters `[OWNER]` and `[OTHER_OWNER, OWNER]` keep. A decodable
 * state with another owner, FREE and absent give null; ACTIVE with a listed owner and every state whose owner cannot
 * be read keep their entry. That an unread ticket then lands in the batch's `unreadable` list
 * is the selection's step, not this pure function's; level P cannot observe it.
 */
const OWNER_ROWS: OwnerRow[] = [
	{
		...activeRow("ACTIVE agent-karl, not yet reclaimable", "the owner filter narrowed to eligible claims", LEASE, R),
		single: true,
		either: true,
	},
	{
		...activeRow("ACTIVE agent-karl, timeless", "a never-reclaimable claim hidden by the filter", TIMELESS, R + EPS),
		single: true,
		either: true,
	},
	{
		...activeRow("ACTIVE Agent-Karl", "case folding as identity (as for --assignee)", LEASE, R + EPS, "Agent-Karl"),
		single: false,
		either: false,
	},
	{
		...activeRow("ACTIVE agent-karl with a trailing blank", "trimming as identity", LEASE, R + EPS, `${OWNER} `),
		single: false,
		either: false,
	},
	{
		...activeRow("ACTIVE agent-franz", "another owner selected", LEASE, R + EPS, OTHER_OWNER),
		single: false,
		either: true,
	},
	{
		...stateRow("tombstone", "FREE selected through an owner filter", present(TOMBSTONE), TOMBSTONE_GENERATION),
		single: false,
		either: false,
	},
	{
		...stateRow("absent ref", "an absent ticket selected through an owner filter", ABSENT),
		single: false,
		either: false,
	},
	// A state whose owner cannot be compared never drops out silently.
	{
		...stateRow("unread ticket", "an unread state dropped from the owner match or read as free", null),
		single: true,
		either: true,
	},
	{
		...stateRow("unreachable read", "a failed read dropped from the owner match", UNREACHABLE),
		single: true,
		either: true,
	},
	{
		...stateRow("corrupt payload", "a corrupt state dropped because no owner was compared", present(CORRUPT)),
		single: true,
		either: true,
	},
	{
		...stateRow("newer state version", "an unsupported state dropped from the owner match", present(NEWER_VERSION)),
		single: true,
		either: true,
	},
	{
		...stateRow("pending status", "a PENDING state dropped from the owner match", present(PENDING)),
		single: true,
		either: true,
	},
];

// ---------------------------------------------------------------------------------------------------------------
// Per-ticket documents: the base envelopes with `command: "reclaim"`, built as plain literals.
// ---------------------------------------------------------------------------------------------------------------

const FOREIGN_RIGHTS: ClaimOperationDocument["rights"] = {
	kind: "evaluated",
	scope: "observed-state-only",
	ownership: "foreign",
	claimGeneration: GENERATION,
	workRight: { kind: "none", cause: "not-holder" },
	reclaim: { kind: "eligible", boundary: R },
};
const PLANNED_TOMBSTONE: ClaimOperationDocument["planned"] = {
	status: "free",
	claimGeneration: GENERATION,
	timing: null,
	capped: false,
};
const RESOLVED_OPEN: Queried["query"] = { kind: "resolved", resolution: "open" };

/** A plan rejection persists nothing: no operation ID, no storage, no planned display (base). */
function operationDoc(ticket: string, form: OperationForm): ClaimOperationDocument {
	const planOnly = form.storage === null;
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: form.status,
		command: "reclaim",
		action: "reclaim",
		ticket,
		operationId: planOnly ? null : OP,
		outcome: form.outcome,
		rejection: form.rejection ?? null,
		storage: form.storage,
		sends: form.sends,
		stoppedBy: form.stoppedBy ?? null,
		planned: planOnly ? null : PLANNED_TOMBSTONE,
		rights: FOREIGN_RIGHTS,
	};
}

function pauseDoc(ticket: string, pause: PauseView): ClaimPauseDocument {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "reclaim",
		action: "reclaim",
		ticket,
		operationId: null,
		pause,
		rights: FOREIGN_RIGHTS,
	};
}

/** The base builder (surface/index.ts:684): status from CLAIM_ERROR_CODES, message from the fixed table. */
function errorDoc(ticket: string, code: string): ClaimErrorDocument {
	return claimErrorDocument({ command: "reclaim", code: code as ClaimErrorCode, ticket });
}

/** An unexpected error after the executor call is `internal` with status `unknown` and the ID. */
function unknownAfterStartDoc(ticket: string): ClaimErrorDocument {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "unknown",
		command: "reclaim",
		code: "internal",
		message: "an unexpected error ended the command after the operation started; its outcome is unknown",
		ticket,
		operationId: OP,
	};
}

const APPLIED: OperationForm = { status: "applied", outcome: "applied", storage: { kind: "applied" }, sends: 1 };

function planRejected(cause: string): OperationForm {
	const rejection: RejectionView = BOUNDED_CAUSES.includes(cause)
		? { stage: "plan", cause, boundary: R }
		: { stage: "plan", cause };
	return { status: "rejected", outcome: "rejected", storage: null, rejection, sends: 0 };
}

function storageRejected(cause: "stale" | "remote"): OperationForm {
	const rejection: RejectionView = { stage: "storage", cause };
	return { status: "rejected", outcome: "rejected", storage: { kind: "rejected", cause }, rejection, sends: 1 };
}

const NOT_STORED: OperationForm = {
	status: "rejected",
	outcome: "rejected",
	storage: { kind: "queried", after: "remote", query: { kind: "resolved", resolution: "not-stored" } },
	rejection: { stage: "resolution", cause: "not-stored" },
	sends: 2,
};

function lostReply(after: Queried["after"], query: Queried["query"], stoppedBy?: "attempts" | "budget"): OperationForm {
	const storage: StorageView = { kind: "queried", after, query };
	const form: OperationForm = { status: "unknown", outcome: "unknown", storage, sends: 1 };
	if (stoppedBy !== undefined) form.stoppedBy = stoppedBy;
	return form;
}

function history(query: Queried["query"]): OperationForm {
	return {
		status: "unknown-history",
		outcome: "unknown-history",
		storage: { kind: "queried", after: "unknown", query },
		sends: 1,
	};
}

function notSent(cause: NotSentCause): OperationForm {
	return { status: "unavailable", outcome: "not-sent", storage: { kind: "not-sent", cause }, sends: 0 };
}

const LOST_REPLY = lostReply("unknown", RESOLVED_OPEN, "attempts");

/** Every claim-operation form the base mapper can emit for reclaim; none of them is a call-wide fault. */
const OPERATION_ROWS: { label: string; catches: string; form: OperationForm }[] = [
	{ label: "applied", catches: "a success stopping the batch", form: APPLIED },
	...PLAN_CAUSES.map((cause) => ({
		label: `plan ${cause}`,
		catches: "a plan rejection of one ticket read as call-wide (renewed, reclaimed or re-acquired meanwhile)",
		form: planRejected(cause),
	})),
	{ label: "storage stale", catches: "a lost CAS race read as call-wide", form: storageRejected("stale") },
	{
		label: "storage remote",
		catches: "a hook rejection read as a proven shared permission fault",
		form: storageRejected("remote"),
	},
	{ label: "resolution not-stored", catches: "a later rejection read as call-wide", form: NOT_STORED },
	{
		label: "unknown, budget stop",
		catches: "a budget stop of one ticket read as a batch deadline",
		form: lostReply("unknown", RESOLVED_OPEN, "budget"),
	},
	{
		label: "unknown, query unknown",
		catches: "an unknown query read as a global outage",
		form: lostReply("unknown", { kind: "unknown" }),
	},
	{
		label: "unknown, query unavailable",
		catches: "an unavailable journal query read as call-wide",
		form: lostReply("unknown", { kind: "unavailable" }),
	},
	{
		label: "unknown after stale",
		catches: "an open intent after a stale answer read as call-wide",
		form: lostReply("stale", RESOLVED_OPEN),
	},
	{
		label: "unknown after remote",
		catches: "an open intent after a remote answer read as call-wide",
		form: lostReply("remote", RESOLVED_OPEN),
	},
	{
		label: "unknown after an earlier process",
		catches: "an earlier process's intent read as call-wide",
		form: lostReply("earlier-process", RESOLVED_OPEN),
	},
	{
		label: "unknown-history, conflict",
		catches: "a contradicting receipt read as call-wide",
		form: history({ kind: "resolved", resolution: "conflict" }),
	},
	{
		label: "unknown-history, lost history",
		catches: "lost history of one ticket read as call-wide",
		form: history({ kind: "unknown-history" }),
	},
	...NOT_SENT_CAUSES.map((cause) => ({
		label: `not-sent ${cause}`,
		catches: "a not-sent ticket read as call-wide (the admission slot and the pause are keyed by ticket)",
		form: notSent(cause),
	})),
];

function codeCatches(code: string): string {
	if (STOP_CODES.includes(code)) return "a proven call-wide fault of a shared check that lets the batch keep mutating";
	if (TRANSPORT_CODES.includes(code)) return "a single transport, IO or budget failure read as a global outage";
	return "a ticket-local or unproven fault that stops the batch (only the closed list stops)";
}

/** The union of the contract list and the product table, so a code in either is walked. */
function walkedCodes(): string[] {
	return [...new Set([...ALL_CODES, ...Object.keys(CLAIM_ERROR_CODES)])].sort(byCodeUnits);
}

function stopRows(): StopRow[] {
	const rows: StopRow[] = OPERATION_ROWS.map((row) => ({
		label: `claim-operation ${row.label}`,
		catches: row.catches,
		document: operationDoc(TICKET, row.form),
		stops: false,
	}));
	rows.push(
		{
			label: "claim-pause outstanding",
			catches: "one ticket's open own intent read as call-wide (the pause is keyed by ticket, pause/index.ts:86-94)",
			document: pauseDoc(TICKET, { kind: "outstanding", operationIds: [OP] }),
			stops: false,
		},
		{
			label: "claim-pause unknown",
			catches: "an incomplete journal view (journal-wide, pause/index.ts:103-104) left to pause every candidate",
			document: pauseDoc(TICKET, { kind: "unknown" }),
			stops: true,
		},
		{
			label: "claim-error internal with status unknown",
			catches: "a possibly sent operation read as a proven call-wide fault",
			document: unknownAfterStartDoc(TICKET),
			stops: false,
		},
	);
	for (const code of walkedCodes()) {
		rows.push({
			label: `claim-error ${code}`,
			catches: codeCatches(code),
			document: errorDoc(TICKET, code),
			stops: STOP_CODES.includes(code),
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Overall status: entries per kind, permutations over the tickets, the invariants.
// ---------------------------------------------------------------------------------------------------------------

function entryDocument(kind: EntryKind | StopKind, ticket: string): Entry {
	switch (kind) {
		case "applied":
			return operationDoc(ticket, APPLIED);
		case "rejected":
			return operationDoc(ticket, planRejected("not-yet"));
		case "unknown":
			return operationDoc(ticket, LOST_REPLY);
		case "unknown-after-start":
			return unknownAfterStartDoc(ticket);
		case "unknown-history":
			return operationDoc(ticket, history({ kind: "resolved", resolution: "conflict" }));
		case "not-sent":
			return operationDoc(ticket, notSent("admission-held"));
		case "unreadable-error":
			return errorDoc(ticket, "storage-unreadable");
		case "paused":
			return pauseDoc(ticket, { kind: "outstanding", operationIds: [OP_OTHER] });
		case "refused":
			return errorDoc(ticket, "state-corrupt");
		case "internal":
			return errorDoc(ticket, "internal");
		case "refused-stop":
			return errorDoc(ticket, "context-corrupt");
		case "paused-stop":
			return pauseDoc(ticket, { kind: "unknown" });
	}
}

/** Every distinct order of `items`. */
function permutations<V>(items: readonly V[]): V[][] {
	if (items.length <= 1) return [[...items]];
	const seen = new Set<string>();
	const result: V[][] = [];
	for (const [index, head] of items.entries()) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)];
		for (const tail of permutations(rest)) {
			const order = [head, ...tail];
			const key = JSON.stringify(order);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(order);
		}
	}
	return result;
}

/** Tickets in candidate order; the tried kinds in `order`, then the stopping entry, then the untried tail. */
function aggInput(row: AggRow, order: readonly EntryKind[], untried: number): BatchInput {
	const kinds: (EntryKind | StopKind)[] = row.stop === undefined ? [...order] : [...order, row.stop];
	const entries: BatchEntryInput[] = kinds.map((kind, index) => ({
		ticket: ticketAt(index),
		document: entryDocument(kind, ticketAt(index)),
	}));
	for (let index = kinds.length; index < kinds.length + untried; index++) {
		entries.push({ ticket: ticketAt(index), document: null });
	}
	return {
		observedAt: T,
		complete: row.complete ?? true,
		unreadable: [...(row.unreadable ?? [])],
		stoppedAt: row.stop === undefined ? null : ticketAt(kinds.length - 1),
		entries,
	};
}

function resultOf(entry: BatchEntryInput): string {
	return entry.document === null ? "untried" : entry.document.status;
}

function aggView(label: string, row: AggRow, order: readonly EntryKind[]): AggView {
	const untried = row.untried ?? 0;
	const input = aggInput(row, order, untried);
	const doc = claimReclaimBatchDocument(input);
	const exit = claimExitCode(doc);
	const allApplied = input.entries.every((entry) => entry.document?.status === "applied");
	const anyUnknown = input.entries.some((entry) => entry.document?.status === "unknown");
	return {
		label,
		status: doc.status,
		exit,
		stoppedAt: doc.stoppedAt,
		tickets: doc.entries.map((entry) => entry.ticket),
		results: doc.entries.map((entry) => entry.result),
		withoutUntried: untried === 0 ? null : claimReclaimBatchDocument(aggInput(row, order, 0)).status,
		// I1: exit 0 ⇔ complete selection, no stop, every candidate applied (zero candidates included).
		i1: (exit === 0) === (input.complete && input.stoppedAt === null && allApplied),
		// I2: exit 3 ⇔ at least one entry is unknown.
		i2: (exit === 3) === anyUnknown,
	};
}

function expectedAgg(label: string, row: AggRow, order: readonly EntryKind[]): AggView {
	const untried = row.untried ?? 0;
	const input = aggInput(row, order, untried);
	return {
		label,
		status: row.status,
		exit: EXPECTED_EXIT[row.status] ?? -1,
		stoppedAt: input.stoppedAt,
		tickets: input.entries.map((entry) => entry.ticket),
		results: input.entries.map(resultOf),
		// I4: the untried tail contributes nothing.
		withoutUntried: untried === 0 ? null : row.status,
		i1: true,
		i2: true,
	};
}

/**
 * Rank unknown 3 > unknown-history 4 > internal 1 > paused 7 > refused 5 > unavailable 6 (also an
 * incomplete selection) > rejected 2 > ok 0. Rows after the positive control; every row runs in every order of its
 * tried kinds.
 */
const AGG_ROWS: AggRow[] = [
	{
		label: "an applied ticket and a plan rejection",
		catches: "only rejections read as 0; the first entry wins",
		tried: ["applied", "rejected"],
		status: "rejected",
	},
	{
		label: "two rejections",
		catches: "a sum of exit codes (2 + 2 = 4, unknown-history) instead of a rank",
		tried: ["rejected", "rejected"],
		status: "rejected",
	},
	{
		label: "a rejection and a not-sent ticket",
		catches: "rejected ranked above unavailable",
		tried: ["rejected", "not-sent"],
		status: "unavailable",
	},
	{
		label: "an applied and a not-sent ticket",
		catches: "not-sent read as applied or as ok",
		tried: ["applied", "not-sent"],
		status: "unavailable",
	},
	{
		label: "an unreadable-state error and a rejection",
		catches: "an unavailable error document ranked apart from not-sent",
		tried: ["unreadable-error", "rejected"],
		status: "unavailable",
	},
	{
		label: "a not-sent ticket and a refusal",
		catches: "unavailable ranked above refused",
		tried: ["not-sent", "refused"],
		status: "refused",
	},
	{
		label: "a rejection and a refusal",
		catches: "the last entry wins",
		tried: ["rejected", "refused"],
		status: "refused",
	},
	{
		label: "a refusal and a pause",
		catches: "refused ranked above paused",
		tried: ["refused", "paused"],
		status: "paused",
	},
	{
		label: "a pause and an internal defect",
		catches: "paused ranked above internal",
		tried: ["paused", "internal"],
		status: "internal",
	},
	{
		label: "an internal defect and unknown-history",
		catches: "internal ranked above unknown-history",
		tried: ["internal", "unknown-history"],
		status: "unknown-history",
	},
	{
		label: "unknown-history and a pause",
		catches: "a pause hiding lost history",
		tried: ["unknown-history", "paused"],
		status: "unknown-history",
	},
	{
		label: "unknown-history and unknown",
		catches: "unknown-history ranked above unknown",
		tried: ["unknown-history", "unknown"],
		status: "unknown",
	},
	{
		label: "a pause and unknown",
		catches: "a possibly sent operation hidden behind a pause",
		tried: ["paused", "unknown"],
		status: "unknown",
	},
	{
		label: "an unknown error after the start",
		catches: "the code internal of a status-unknown error read as internal/1",
		tried: ["applied", "unknown-after-start"],
		status: "unknown",
	},
	{
		label: "four statuses up to a refusal",
		catches: "the first or the last entry wins",
		tried: ["applied", "rejected", "not-sent", "refused"],
		status: "refused",
	},
	{
		label: "four statuses up to an internal defect",
		catches: "the most frequent status wins",
		tried: ["rejected", "internal", "paused", "applied"],
		status: "internal",
	},
	{
		label: "zero candidates, complete selection",
		catches: "a valid scope without hits reported as an error",
		tried: [],
		status: "ok",
	},
	{
		label: "zero candidates, an unread ticket",
		catches: "an incomplete selection reported as ok",
		tried: [],
		complete: false,
		unreadable: ["BACK-99"],
		status: "unavailable",
	},
	{
		label: "zero candidates, skipped ref names",
		catches: "skipped ref names ignored when nothing was unread",
		tried: [],
		complete: false,
		status: "unavailable",
	},
	{
		label: "an applied ticket, incomplete selection",
		catches: "an incomplete selection reported as ok because every candidate applied",
		tried: ["applied"],
		complete: false,
		unreadable: ["BACK-99"],
		status: "unavailable",
	},
	{
		label: "a rejection, incomplete selection",
		catches: "an incomplete selection ranked below rejected",
		tried: ["rejected"],
		complete: false,
		unreadable: ["BACK-99"],
		status: "unavailable",
	},
	{
		label: "a refusal, incomplete selection",
		catches: "an incomplete selection ranked above refused",
		tried: ["refused"],
		complete: false,
		unreadable: ["BACK-99"],
		status: "refused",
	},
	{
		label: "a pause, incomplete selection",
		catches: "an incomplete selection ranked above paused",
		tried: ["paused"],
		complete: false,
		unreadable: ["BACK-99"],
		status: "paused",
	},
	{
		label: "unknown, incomplete selection",
		catches: "the incomplete selection hiding a possibly sent operation",
		tried: ["unknown"],
		complete: false,
		unreadable: ["BACK-99"],
		status: "unknown",
	},
	{
		label: "a stop on a refusal after an applied ticket",
		catches: "untried entries counted as unknown, unavailable or rejected",
		tried: ["applied"],
		stop: "refused-stop",
		untried: 2,
		status: "refused",
	},
	{
		label: "a stop on an incomplete journal view",
		catches: "untried entries counted; the journal-wide pause ranked below a rejection",
		tried: ["applied", "rejected"],
		stop: "paused-stop",
		untried: 1,
		status: "paused",
	},
	{
		label: "a stop after an unknown",
		catches: "the stopping entry outranking an earlier unknown",
		tried: ["rejected", "unknown"],
		stop: "refused-stop",
		untried: 1,
		status: "unknown",
	},
];

// ---------------------------------------------------------------------------------------------------------------
// Batch document: exact keys, pass-through entries, no echo, one text line per entry.
// ---------------------------------------------------------------------------------------------------------------

function taintedInput(input: BatchInput): BatchInput {
	return tainted({ ...input, entries: input.entries.map((entry) => tainted(entry)) });
}

function batchView(label: string, doc: ClaimReclaimBatchDocument): BatchView {
	return {
		label,
		exit: claimExitCode(doc),
		keys: sortedKeys(doc),
		entryKeys: doc.entries.map((entry) => sortedKeys(entry)),
		body: Object.fromEntries(Object.entries(doc)),
		echoed: echoes(JSON.stringify(doc), BATCH_SENSITIVE),
	};
}

function expectedBatch(label: string, input: BatchInput, status: ClaimStatus): BatchView {
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-reclaim-batch",
		status,
		command: "reclaim-batch",
		observedAt: input.observedAt,
		complete: input.complete,
		unreadable: [...input.unreadable],
		stoppedAt: input.stoppedAt,
		entries: input.entries.map((entry) => ({
			ticket: entry.ticket,
			result: resultOf(entry),
			document: entry.document,
		})),
	};
	return {
		label,
		exit: EXPECTED_EXIT[status] ?? -1,
		keys: BATCH_KEYS,
		entryKeys: input.entries.map(() => ENTRY_KEYS),
		body,
		echoed: 0,
	};
}

/** The first line `<status>: <sentence>`, then one line per entry `<ticket> <result> [<operationId>]`. */
function textView(label: string, doc: ClaimReclaimBatchDocument): TextView {
	const { stdout, stderr } = formatClaimDocumentText(doc);
	const lines = (stdout !== "" ? stdout : stderr).split("\n").filter((line) => line.trim() !== "");
	const first = lines[0] ?? "";
	const colon = first.indexOf(":");
	return {
		label,
		head: colon > 0 ? first.slice(0, colon) : null,
		lines: doc.entries.map((entry) => {
			const own = lines.slice(1).filter((line) => line.trim().split(/\s+/)[0] === entry.ticket);
			const line = own[0] ?? NO_LINE;
			const operationId = entry.document?.operationId ?? null;
			return {
				ticket: entry.ticket,
				count: own.length,
				result: line.trim().split(/\s+/)[1] ?? NO_LINE,
				operationShown: operationId === null ? null : line.includes(operationId),
			};
		}),
		echoed: echoes(stdout + stderr, BATCH_SENSITIVE),
	};
}

function expectedText(label: string, input: BatchInput, status: ClaimStatus): TextView {
	return {
		label,
		head: status,
		lines: input.entries.map((entry) => ({
			ticket: entry.ticket,
			count: 1,
			result: resultOf(entry),
			operationShown: (entry.document?.operationId ?? null) === null ? null : true,
		})),
		echoed: 0,
	};
}

/** doc-01 batch rows after the positive control; every wrapper carries the taint. */
const BATCH_ROWS: { label: string; catches: string; input: BatchInput; status: ClaimStatus }[] = [
	{
		label: "zero candidates",
		catches: "a missing `entries` array or `stoppedAt` for an empty run",
		input: { observedAt: T, complete: true, unreadable: [], stoppedAt: null, entries: [] },
		status: "ok",
	},
	{
		label: "an unread selection",
		catches: "unreadable tickets listed as untried entries; `unreadable` re-sorted lexically (BACK-12 < BACK-7)",
		input: {
			observedAt: T,
			complete: false,
			unreadable: ["BACK-7", "BACK-12"],
			stoppedAt: null,
			entries: [{ ticket: "BACK-3", document: operationDoc("BACK-3", APPLIED) }],
		},
		status: "unavailable",
	},
	{
		label: "an unknown next to a pause",
		catches: "a sent write reported as untried; the pause's operation IDs dropped",
		input: {
			observedAt: T,
			complete: true,
			unreadable: [],
			stoppedAt: null,
			entries: [
				{ ticket: "BACK-1", document: operationDoc("BACK-1", LOST_REPLY) },
				{ ticket: "BACK-2", document: pauseDoc("BACK-2", { kind: "outstanding", operationIds: [OP_OTHER] }) },
			],
		},
		status: "unknown",
	},
];

function keyView(label: string, entry: ClaimReclaimPreviewEntry | null): KeyView {
	return {
		label,
		keys: entry === null ? null : sortedKeys(entry),
		pause: field(entry, "pause") ?? NO_PAUSE,
		echoed: entry === null ? 0 : echoes(JSON.stringify(entry), SENSITIVE),
	};
}

const ENTRY_BASE = ["ticket", "verdict"];
const ACTIVE_KEYS = [...ENTRY_BASE, "claimGeneration", "owner", "timing"];
const BOUNDED_KEYS = [...ACTIVE_KEYS, "boundary"];
/** The optional fields only where they are backed; `pause` only for an open or incomplete view. */
const KEY_ROWS: KeyRow[] = [
	{
		label: "eligible lease",
		catches: "boundary, owner or timing dropped",
		row: activeRow("eligible", "", LEASE, R + EPS),
		keys: BOUNDED_KEYS,
	},
	{
		label: "not-yet lease",
		catches: "the boundary dropped from a not-yet entry",
		row: activeRow("not-yet", "", LEASE, R),
		keys: BOUNDED_KEYS,
	},
	{
		label: "timeless",
		catches: "a boundary invented for a claim that never becomes reclaimable",
		row: activeRow("never", "", TIMELESS, R + EPS),
		keys: ACTIVE_KEYS,
	},
	{
		label: "tombstone",
		catches: "owner or timing invented for a FREE state; its generation dropped",
		row: stateRow("free", "", present(TOMBSTONE), TOMBSTONE_GENERATION),
		keys: [...ENTRY_BASE, "claimGeneration"],
	},
	{
		label: "absent",
		catches: "a generation invented for an absent ref",
		row: stateRow("absent", "", ABSENT),
		keys: ENTRY_BASE,
	},
	{
		label: "unread",
		catches: "fields guessed for an unread ticket",
		row: stateRow("unread", "", null),
		keys: ENTRY_BASE,
	},
	{
		label: "corrupt",
		catches: "fields of a corrupt payload copied",
		row: stateRow("corrupt", "", present(CORRUPT)),
		keys: ENTRY_BASE,
	},
	{
		label: "unsupported",
		catches: "fields of a newer state copied",
		row: stateRow("unsupported", "", present(NEWER_VERSION)),
		keys: ENTRY_BASE,
	},
	{
		label: "eligible with a clear journal",
		catches: "an empty pause view on every entry",
		row: activeRow("clear", "", LEASE, R + EPS),
		pause: { kind: "clear" },
		keys: BOUNDED_KEYS,
	},
	{
		label: "eligible with an open own operation",
		catches: "the open operation of this context hidden",
		row: activeRow("outstanding", "", LEASE, R + EPS),
		pause: { kind: "outstanding", operationIds: [OP, OP_OTHER] },
		keys: [...BOUNDED_KEYS, "pause"],
	},
	{
		label: "eligible with an incomplete journal view",
		catches: "an incomplete journal view hidden, or its upstream reason copied",
		row: activeRow("unknown pause", "", LEASE, R + EPS),
		pause: { kind: "unknown", reason: REASON },
		keys: [...BOUNDED_KEYS, "pause"],
	},
];

function expectedPause(pause: ClaimOperationPause | undefined): unknown {
	if (pause?.kind === "outstanding") return { kind: "outstanding", operationIds: [...pause.operationIds] };
	if (pause?.kind === "unknown") return { kind: "unknown" };
	return NO_PAUSE;
}

describe("reclaim scope (pure)", () => {
	test("scp-01: a missing, blank or combined scope is refused before --context, configuration and any IO", async () => {
		// Scanner positive control: a planted path sentinel is counted.
		expect(echoes(`planted ${CONTEXT_PATH}`, SENSITIVE)).toBe(1);
		// Positive control (catches: no scope function; the scaffold's constant "internal").
		expect(scopeView(claimReclaimScope({ tickets: ["BACK-1"] }, "BACK"))).toEqual(scope("tickets", ["BACK-1"], null));
		for (const row of SCOPE_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect({ label, view: scopeView(claimReclaimScope(row.input, "BACK")) }).toEqual({ label, view: row.expected });
		}
		// Positive control of the IO entry points (catches: a valid scope refused; explicit tickets sent through
		// loadLocalTickets although they are read directly): no claims block → not-configured, no seam call.
		for (const verb of ["reclaim-batch", "reclaim-preview"] as const) {
			const label = `${verb} explicit ticket without a claims block`;
			expect(await callView(label, verb, { tickets: ["BACK-1"] })).toEqual(refusedCall(label, verb, "not-configured"));
		}
		// catches: the scope checked after the configuration (not-configured instead), after the network or after a seam
		// (a call noted); a refusal worded as another code. Valid rows without a ticket filter reach the configuration.
		for (const row of SCOPE_ROWS) {
			const code = callCode(row);
			if (code === null) continue;
			for (const verb of ["reclaim-batch", "reclaim-preview"] as const) {
				const label = `${verb} ${row.label} (catches: ${row.catches})`;
				expect(await callView(label, verb, row.input)).toEqual(refusedCall(label, verb, code));
			}
		}
		// Scope → --context → configuration, pinned by rows with two errors each.
		for (const row of PRECEDENCE_ROWS) {
			for (const verb of ["reclaim-batch", "reclaim-preview"] as const) {
				const label = `${verb} ${row.label} (catches: ${row.catches})`;
				expect(await callView(label, verb, row.input, row.context)).toEqual(refusedCall(label, verb, row.code));
			}
		}
	});

	test("scp-02: explicit tickets are canonical, deduplicated and in compareTaskIds order", () => {
		// Positive control (catches: the same ticket mutated twice; lexical instead of ID order; no canonical form).
		const view = scopeView(claimReclaimScope({ tickets: ["BACK-10", "back-9", "BACK-9", " BACK-9 "] }, "BACK"));
		expect(view).toEqual(scope("tickets", ["BACK-9", "BACK-10"], null));
		for (const row of CANONICAL_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			const result = scopeView(claimReclaimScope({ tickets: row.tickets }, "BACK"));
			expect({ label, view: result }).toEqual({ label, view: scope("tickets", row.expected, null) });
		}
	});
});

describe("reclaim verdict (pure planner reuse)", () => {
	test("ver-01: the verdict is the planner's reclaim plan and the boundary the evaluator's, for either binding", () => {
		// Scanner positive control: a planted binding is counted.
		expect(echoes(`planted ${KARL}`, SENSITIVE)).toBe(1);
		// Setup expectation (planner since): the grid reaches every verdict and straddles every boundary.
		expect(gridCoverage()).toEqual({
			verdicts: ALL_VERDICTS,
			sides: TIMED.map((state) => ({ state: state.name, verdicts: ["eligible", "not-yet"] })),
		});
		// Positive control (catches: no verdict; the scaffold's constant unknown; the boundary or owner dropped).
		const eligible = activeRow("lease at boundary + eps", "", LEASE, R + EPS);
		expect(entryView("eligible", verdictFor(eligible, LENA, null))).toEqual(
			expectedEntryView("eligible", expectedEntry(eligible)),
		);
		for (const row of VERDICT_ROWS) {
			const expected = expectedEntry(row);
			for (const caller of CALLERS) {
				const label = `${row.label}, caller ${caller.name} (catches: ${row.catches}; ${caller.catches})`;
				expect(entryView(label, verdictFor(row, caller.binding, null))).toEqual(expectedEntryView(label, expected));
			}
		}
	});

	test("ver-02: --claim-owner keeps ACTIVE states of a listed owner, byte-exact, and drops no unreadable state", () => {
		const exact = activeRow("ACTIVE agent-karl, eligible", "", LEASE, R + EPS);
		// Positive control (catches: an owner filter that selects nothing; the owner dropped from the entry).
		expect(entryView("exact owner", verdictFor(exact, LENA, [OWNER]))).toEqual(
			expectedEntryView("exact owner", expectedEntry(exact)),
		);
		for (const row of OWNER_ROWS) {
			const expected = expectedEntry(row);
			const single = `${row.label} under [${OWNER}] (catches: ${row.catches})`;
			expect(entryView(single, verdictFor(row, LENA, [OWNER]))).toEqual(
				expectedEntryView(single, row.single ? expected : null),
			);
			const either = `${row.label} under [${OTHER_OWNER}, ${OWNER}] (catches: AND instead of OR; ${row.catches})`;
			expect(entryView(either, verdictFor(row, LENA, [OTHER_OWNER, OWNER]))).toEqual(
				expectedEntryView(either, row.either ? expected : null),
			);
			// catches: a preview without the owner filter that still drops some states.
			const all = `${row.label} without an owner filter`;
			expect(entryView(all, verdictFor(row, LENA, null))).toEqual(expectedEntryView(all, expected));
		}
	});
});

describe("stop rule and overall status (pure)", () => {
	test("stp-01: only the closed list stops, walked over every claim-error code and every per-ticket form", () => {
		// Positive control (catches: a single UNKNOWN stopping the batch, claim next's rule; the scaffold's constant true).
		expect(claimReclaimStops(operationDoc(TICKET, LOST_REPLY))).toBe(false);
		// Setup expectation (catches: a walk that silently skips a code): every contract name is in the product table.
		expect({
			missing: ALL_CODES.filter((code) => !Object.hasOwn(CLAIM_ERROR_CODES, code)),
			unlisted: STOP_CODES.filter((code) => !ALL_CODES.includes(code)),
			count: ALL_CODES.length,
		}).toEqual({ missing: [], unlisted: [], count: 51 });
		const rows = stopRows();
		const labelOf = (row: StopRow) => `${row.label} (catches: ${row.catches})`;
		expect(rows.map((row) => ({ label: labelOf(row), stops: claimReclaimStops(row.document) }))).toEqual(
			rows.map((row) => ({ label: labelOf(row), stops: row.stops })),
		);
	});

	test("agg-01: the overall status is the most urgent entry, in any order; untried entries add nothing", () => {
		const both: AggRow = { label: "two applied tickets", catches: "", tried: ["applied", "applied"], status: "ok" };
		// Positive control (catches: no aggregation; the scaffold's constant internal; entries dropped).
		expect(aggView("positive control", both, both.tried)).toEqual(expectedAgg("positive control", both, both.tried));
		for (const row of AGG_ROWS) {
			for (const order of permutations(row.tried)) {
				const label = `${row.label} [${order.join(", ")}] (catches: ${row.catches})`;
				expect(aggView(label, row, order)).toEqual(expectedAgg(label, row, order));
			}
		}
	});
});

describe("batch document and preview entries (pure)", () => {
	test("doc-01: exact keys, entries passed through, untried as null, no echo and one text line per entry", () => {
		// Scanner positive control: a planted binding is counted.
		expect(echoes(`planted ${KARL}`, BATCH_SENSITIVE)).toBe(1);
		const stopped: BatchInput = {
			observedAt: T,
			complete: true,
			unreadable: [],
			stoppedAt: "BACK-2",
			entries: [
				{ ticket: "BACK-1", document: operationDoc("BACK-1", APPLIED) },
				{ ticket: "BACK-2", document: errorDoc("BACK-2", "context-corrupt") },
				{ ticket: "BACK-3", document: null },
			],
		};
		// Positive control (catches: no batch builder; a spread input wrapper; untried without `document: null`; an owner
		// or a binding copied from a wrapper; the stopping ticket reported as untried).
		const doc = claimReclaimBatchDocument(taintedInput(stopped));
		expect(batchView("stopped", doc)).toEqual(expectedBatch("stopped", stopped, "refused"));
		// catches: a text without a status head, with several lines per ticket, without the operation ID, or echoing.
		expect(textView("stopped", doc)).toEqual(expectedText("stopped", stopped, "refused"));
		for (const row of BATCH_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			const rowDoc = claimReclaimBatchDocument(taintedInput(row.input));
			expect(batchView(label, rowDoc)).toEqual(expectedBatch(label, row.input, row.status));
			expect(textView(label, rowDoc)).toEqual(expectedText(label, row.input, row.status));
		}
		// catches: optional preview fields where they are not backed; the pause reason or a root, binding or digest
		// copied into an entry (allows only the owner as display).
		for (const row of KEY_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(keyView(label, verdictFor(row.row, LENA, null, row.pause))).toEqual({
				label,
				keys: [...row.keys].sort(byCodeUnits),
				pause: expectedPause(row.pause),
				echoed: 0,
			});
		}
	});
});
