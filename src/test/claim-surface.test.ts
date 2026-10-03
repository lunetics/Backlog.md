/**
 * Pure core of the canonical claim CLI, level P: public documents built from synthetic executor, preflight, query and
 * init results; the status to exit code table; the stream split of the human renderer; the full-jitter pause formula;
 * the operation budget schedule behind injected monotonic clock, random and sleep seams; the resolver extension for eps
 * and retry pauses; and the guide tables. No Git, no subprocess, no wall clock and no real sleep. Every test starts
 * with a positive control that the non-functional scaffold cannot satisfy; table rows name the deliberately wrong
 * implementation they catch. Upstream inputs carry sentinels in reasons, roots, bindings and extra fields, so a spread
 * or a copied reason shows as an echo (out-05). Points the CLI contract decides are asserted exactly; the few it
 * leaves open stay marked ASSUMPTION.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CLAIM_START_VALUES,
	type ClaimCoordinationInitResult,
	type ClaimPreflightResult,
	resolveClaimSettings,
} from "../claims/config/index.ts";
import type { ClaimExecutionResult } from "../claims/execution/index.ts";
import type { ClaimMutationQueryResult } from "../claims/query/index.ts";
import type { ClaimMutationResolution } from "../claims/resolution/index.ts";
import type { ClaimRightEvaluation } from "../claims/rights/index.ts";
import {
	CLAIM_ERROR_CODES,
	CLAIM_EXIT_CODES,
	CLAIM_RETRY_START_VALUES,
	type ClaimDocument,
	claimExitCode,
	claimInitDocument,
	claimOperationDocument,
	claimOperationSchedule,
	claimPreflightError,
	claimResolutionDocument,
	claimRetryPauseMs,
} from "../claims/surface/index.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";

type Status =
	| "ok"
	| "applied"
	| "rejected"
	| "unknown"
	| "unknown-history"
	| "refused"
	| "unavailable"
	| "paused"
	| "internal";
type Body = Record<string, unknown>;
type StopCause = "attempts" | "budget" | null;
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type Paused = Extract<ClaimExecutionResult, { kind: "paused" }>;
type NotPlanned = Extract<ClaimExecutionResult, { kind: "not-planned" }>;
type TopLevel = Extract<ClaimExecutionResult, { reason: string }>["kind"];
type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type PreflightFailure = Exclude<ClaimPreflightResult, { kind: "ready" }>;
type HumanView = { stream: string; head: string | null; codeShown: boolean | null; echoed: number };
/** The whole public document with a non-empty message replaced by MESSAGE, plus exit code, keys and echoes. */
type DocumentView = { label: string; exit: number; keys: string[]; body: Body; echoed: number; human: HumanView };
type OperationRow = {
	label: string;
	catches: string;
	result: ClaimExecutionResult;
	stoppedBy?: StopCause;
	expected: Body;
};
type PreflightRow = { label: string; catches: string; verdict: PreflightFailure; expected: Body };
type ResolutionRow = {
	label: string;
	catches: string;
	result: ClaimMutationQueryResult;
	ticket: string | null;
	expected: Body;
};
type InitRow = { label: string; catches: string; result: ClaimCoordinationInitResult; expected: Body };
type SettingsView = { kind: string; settings: unknown; problems: unknown };
type SettingsRow = { label: string; catches: string; yaml: string; expected: SettingsView };
type PauseRow = {
	label: string;
	catches: string;
	send: number;
	draw: number;
	pause: { baseMs: number; maxMs: number };
	expected: number;
};
type ScheduleRow = {
	label: string;
	catches: string;
	startedAt: number;
	budgetMs: number;
	now: number;
	draw: number;
	oversleepMs: number;
	expected: { decision: "send" | "stop"; slept: number[]; stoppedBy: "budget" | null; timeout: number };
};
type Seams = ReturnType<typeof fakeSeams>;

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; the other instants derive from it. */
const T = 1_800_000_000_000;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05" and its reclaim boundary "10:15". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const TICKET = "BACK-1";
const OP = "op-7c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a45";
const OP_OTHER = "op-e4a1c2d3-5b6f-4a7e-8c9d-0e1f2a3b4c5d";
/** Upstream reasons, roots, bindings, paths and endpoints carry sentinels; no public output may contain one. */
const SENTINEL = "SENTINEL-surface-7d31";
const KARL = `tb1-${"4b".repeat(32)}`;
const ROOT = "a1".repeat(20);
const SECRET = `secret-${SENTINEL}`;
const CONTEXT_PATH = `/tmp/contexts-${SENTINEL}/context-1`;
const ENDPOINT = `http://127.0.0.1:9/${SENTINEL}/claims.git`;
const REASON = `upstream ${SENTINEL} ${KARL} ${ROOT}`;
const SENSITIVE = [SENTINEL, KARL, ROOT, SECRET, CONTEXT_PATH, ENDPOINT];
/** Fields a spread of an upstream object would leak (builders set every field one by one). */
const TAINT = { binding: KARL, secret: SECRET, contextDirectory: CONTEXT_PATH, remote: ENDPOINT };
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
const BLOB_DESCRIPTOR = { schema: 1, format: "blob", epoch: 1 } as const;
const PAUSE = { baseMs: 1_000, maxMs: 5_000 };
/** The largest double below 1, the top of Math.random(). */
const TOP = 1 - 2 ** -53;
const ATTEMPT_MS = 3_000;
const MAX_TIMER = 2_147_483_647;
const CFG_ENDPOINT = "git://127.0.0.1:9/claims.git";
/** The CLI-only guide lives next to the other CLI guides. */
const GUIDE_PATH = join(import.meta.dir, "..", "guidelines", "cli-instructions", "claims.md");
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
/**
 * The closed v1 code list without own-operation-open, setup and init codes included; plus the
 * additive codes of later contracts (administration commands; claim next and batch reclaim;
 * the emergency release: the three maintenance codes of both stages).
 */
const PLAN_ERROR_CODES = `
	project-not-found project-config-unreadable invalid-ticket ticket-not-found ticket-ambiguous
	owner-required context-required invalid-option option-not-applicable hard-end-required
	invalid-operation-id operation-id-in-use not-configured config-invalid claims-disabled
	context-invalid context-corrupt context-unavailable descriptor-missing format-mismatch
	schema-unsupported coordination-corrupt unreachable preflight-invalid preflight-unknown
	request-invalid local-unavailable storage-unreadable state-corrupt state-unsupported state-unknown
	budget-exhausted operation-not-found record-corrupt scope-mismatch
	list-unavailable already-configured config-write-failed format-conflict not-empty remote-rejected
	init-unknown internal
	target-context-invalid target-context-unavailable recovery-missing bounds-required
	dependency-blocked dependency-unknown tasks-unavailable scope-required
	authority-required expectation-required isolation-unconfirmed
`
	.trim()
	.split(/\s+/);
/** Statuses the plan states for a code; the rest is left to the guide. */
const FIXED_CODE_STATUSES: Record<string, string> = Object.fromEntries([
	...byStatus(
		"refused",
		`not-configured config-invalid claims-disabled context-invalid context-corrupt descriptor-missing
		format-mismatch schema-unsupported coordination-corrupt preflight-invalid request-invalid state-corrupt
		state-unsupported ticket-not-found hard-end-required operation-not-found scope-mismatch
		already-configured format-conflict`,
	),
	...byStatus(
		"unavailable",
		`context-unavailable unreachable preflight-unknown local-unavailable storage-unreadable state-unknown
		budget-exhausted list-unavailable config-write-failed`,
	),
	...byStatus("unknown", "init-unknown"),
	...byStatus("internal", "internal"),
	// claim next and batch reclaim.
	...byStatus("refused", "dependency-blocked dependency-unknown scope-required"),
	// Three refused codes over both stages.
	...byStatus("refused", "authority-required expectation-required isolation-unconfirmed"),
	...byStatus("unavailable", "tasks-unavailable"),
]);

function byStatus(status: string, codes: string): [string, string][] {
	return codes
		.trim()
		.split(/\s+/)
		.map((code): [string, string] => [code, status]);
}

// adapted from claim-execution.test.ts:250
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-execution.test.ts:475
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function echoes(text: string): number {
	return SENSITIVE.filter((value) => text.includes(value)).length;
}

function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

function evaluated(
	ownership: Evaluated["ownership"],
	workRight: Evaluated["workRight"],
	reclaim: Evaluated["reclaim"],
	claimGeneration: number | null = 3,
): ClaimRightEvaluation {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: ROOT,
		claimGeneration,
		ownership,
		workRight,
		reclaim,
	};
}

/** RightsView: the rights evaluation without observedRoot and reason. */
function publicRights(rights: ClaimRightEvaluation): Body {
	if (rights.kind !== "evaluated") return { kind: rights.kind };
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: rights.ownership,
		claimGeneration: rights.claimGeneration,
		workRight: rights.workRight,
		reclaim: rights.reclaim,
	};
}

function operation(
	storage: Operation["storage"],
	outcome: Operation["outcome"]["kind"],
	sends: number,
	rights: ClaimRightEvaluation,
): ClaimExecutionResult {
	const result: Operation = {
		kind: "operation",
		scope: "transition-execution-only",
		action: "acquire",
		operationId: OP,
		storage: tainted(storage),
		outcome: { kind: outcome },
		rights: tainted(rights),
		sends,
	};
	return tainted(result);
}

function queried(after: "unknown" | "stale" | "remote", query: ClaimMutationQueryResult): Operation["storage"] {
	return { kind: "queried", after, query: tainted(query) };
}

function resolvedQuery(resolution: ClaimMutationResolution): ClaimMutationQueryResult {
	return { kind: "resolved", resolution: tainted(resolution) };
}

function notPlanned(plan: NotPlanned["plan"], rights: ClaimRightEvaluation): ClaimExecutionResult {
	const result: NotPlanned = { kind: "not-planned", plan: tainted(plan), rights: tainted(rights) };
	return tainted(result);
}

function topLevel(kind: TopLevel): ClaimExecutionResult {
	const result: ClaimExecutionResult = { kind, reason: REASON };
	return tainted(result);
}

function paused(pause: Paused["pause"], rights: ClaimRightEvaluation): ClaimExecutionResult {
	const result: Paused = { kind: "paused", pause: tainted(pause), rights: tainted(rights) };
	return tainted(result);
}

/** QueryView: kinds only. */
function queryView(kind: string, resolution?: string): Body {
	return resolution === undefined ? { kind } : { kind, resolution };
}

function queriedView(after: string, query: Body): Body {
	return { kind: "queried", after, query };
}

function op(
	status: Status,
	outcome: string,
	storage: Body | null,
	sends: number,
	rights: ClaimRightEvaluation,
	extra: Body = {},
): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status,
		command: "acquire",
		action: "acquire",
		ticket: TICKET,
		operationId: OP,
		outcome,
		rejection: null,
		storage,
		sends,
		stoppedBy: null,
		planned: null,
		rights: publicRights(rights),
		...extra,
	};
}

/** Plan rejections persist nothing, so the document carries no operation ID. */
function planRejection(cause: string, rights: ClaimRightEvaluation, boundary?: number): Body {
	const rejection: Body = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return op("rejected", "rejected", null, 0, rights, { operationId: null, rejection });
}

/** The pause document; operation IDs are data, an unknown pause drops its reason. */
function pauseBody(pause: Body, rights: ClaimRightEvaluation): Body {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command: "acquire",
		action: "acquire",
		ticket: TICKET,
		operationId: null,
		pause,
		rights: publicRights(rights),
	};
}

function errorBody(
	status: Status,
	code: string,
	extra: Body = {},
	command = "acquire",
	ticket: string | null = TICKET,
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

function resolutionBody(status: Status, outcome: string, query: Body): Body {
	return {
		schemaVersion: 1,
		kind: "claim-resolution",
		status,
		command: "resolve",
		operationId: OP,
		ticket: TICKET,
		action: "renew",
		outcome,
		query,
	};
}

function initBody(result: "created" | "exists", format: string): Body {
	return { schemaVersion: 1, kind: "claim-init", status: "ok", command: "init", result, format, epoch: 1 };
}

/** cli-05 at level P: first token, stream and code of the human text rendered from the public document. */
function humanView(doc: ClaimDocument): HumanView {
	const { stdout, stderr } = formatClaimDocumentText(doc);
	let stream = "mixed";
	if (stdout !== "" && stderr === "") stream = "stdout";
	if (stderr !== "" && stdout === "") stream = "stderr";
	const first = (stream === "stderr" ? stderr : stdout).split("\n")[0] ?? "";
	const colon = first.indexOf(":");
	const status = field(doc, "status");
	const code = field(doc, "code");
	const refusal = status === "refused" || status === "unavailable";
	return {
		stream,
		head: colon > 0 ? first.slice(0, colon) : null,
		codeShown: refusal && typeof code === "string" ? first.includes(code) : null,
		echoed: echoes(stdout + stderr),
	};
}

/** Refused, unavailable and internal go to stderr; refused and unavailable name their code first. */
function human(status: string, code: unknown): HumanView {
	const refusal = status === "refused" || status === "unavailable";
	return {
		stream: STDERR_STATUSES.includes(status) ? "stderr" : "stdout",
		head: status,
		codeShown: refusal && typeof code === "string" ? true : null,
		echoed: 0,
	};
}

function viewOf(label: string, doc: ClaimDocument): DocumentView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		body,
		echoed: echoes(JSON.stringify(doc)),
		human: humanView(doc),
	};
}

function expectedView(label: string, body: Body): DocumentView {
	const status = String(body.status);
	return {
		label,
		exit: EXPECTED_EXIT[status] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		body,
		echoed: 0,
		human: human(status, body.code),
	};
}

function mapOperation(result: ClaimExecutionResult, stoppedBy: StopCause = null): ClaimDocument {
	// One object with command, ticket, executor result, onPlanned view and the stop cause.
	return claimOperationDocument({ command: "acquire", ticket: TICKET, result, planned: null, stoppedBy });
}

function mapPreflight(verdict: PreflightFailure): ClaimDocument {
	// One object with command, ticket and the non-ready verdict.
	return claimPreflightError({ command: "acquire", ticket: TICKET, verdict: tainted(verdict) });
}

function mapResolution(result: ClaimMutationQueryResult, ticket: string | null): ClaimDocument {
	// One object with the requested ID, the record's ticket and action (null without a readable
	// record) and the query result.
	const action = ticket === null ? null : "renew";
	return claimResolutionDocument({ operationId: OP, ticket, action, result: tainted(result) });
}

function fakeSeams(start: number, draws: readonly number[], oversleepMs = 0) {
	const slept: number[] = [];
	const state = { now: start, slept, draws: 0 };
	return {
		state,
		monotonicNow: (): number => state.now,
		random: (): number => {
			const value = draws[state.draws] ?? Number.NaN;
			state.draws += 1;
			return value;
		},
		sleep: (ms: number): Promise<void> => {
			state.slept.push(ms);
			state.now += ms + oversleepMs;
			return Promise.resolve();
		},
	};
}

function schedule(seams: Seams, startedAt: number, budgetMs: number) {
	// One options object with the monotonic start and budget, the per-command attempt timeout, the
	// pause settings and the three seams; the result adds stoppedBy() to ClaimSendSchedule.
	return claimOperationSchedule({
		startedAt,
		budgetMs,
		attemptTimeoutMs: ATTEMPT_MS,
		pause: PAUSE,
		monotonicNow: seams.monotonicNow,
		random: seams.random,
		sleep: seams.sleep,
	});
}

/** The three surface keys and their names. */
function surfaceLines(eps: string, base: string, max: string): string[] {
	return [`  clock_uncertainty_ms: ${eps}`, `  retry_pause_base_ms: ${base}`, `  retry_pause_max_ms: ${max}`];
}

function cfgBlock(mode: "lease" | "none", extra: readonly string[]): string {
	const head = ["claims:", "  enabled: true", `  endpoint: "${CFG_ENDPOINT}"`, "  storage_format: blob"];
	const lifetime = mode === "lease" ? ["  lease_ttl_ms: 300000", "  reclaim_grace_ms: 600000"] : [];
	const tail = ["  attempt_timeout_ms: 10000", "  attempts: 3", "  operation_budget_ms: 30000"];
	return [...head, `  lifetime_mode: ${mode}`, ...lifetime, ...tail, ...extra].join("\n");
}

/** Settings name the keys clockUncertaintyMs, retryPauseBaseMs and retryPauseMaxMs. */
function configured(base: Body, eps: number, pauseBase: number, pauseMax: number): SettingsView {
	const settings = { ...base, clockUncertaintyMs: eps, retryPauseBaseMs: pauseBase, retryPauseMaxMs: pauseMax };
	return { kind: "configured", settings, problems: null };
}

function invalidSetting(key: string, problem: string): SettingsView {
	return { kind: "config-invalid", settings: null, problems: [{ key: `claims.${key}`, problem }] };
}

function settingsView(yaml: string): SettingsView {
	const result = resolveClaimSettings(yaml);
	return {
		kind: result.kind,
		settings: result.kind === "configured" ? result.settings : null,
		problems: result.kind === "config-invalid" ? result.problems.map(({ key, problem }) => ({ key, problem })) : null,
	};
}

function cells(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return [];
	return trimmed
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.replaceAll("`", "").trim());
}

/** ASSUMPTION(surface): rows of every Markdown table whose first two header cells are `first` and `second`. */
function tableRows(markdown: string, first: string, second: string): string[][] {
	const lines = markdown.split(/\r?\n/);
	const rows: string[][] = [];
	for (let index = 0; index < lines.length; index++) {
		const header = cells(lines[index] ?? "");
		if (header[0]?.toLowerCase() !== first || header[1]?.toLowerCase() !== second) continue;
		for (let row = index + 2; row < lines.length && (lines[row] ?? "").trim().startsWith("|"); row++) {
			rows.push(cells(lines[row] ?? ""));
		}
	}
	return rows;
}

const HELD = evaluated("held", { kind: "live", renewalDue: false }, { kind: "not-yet", boundary: R });
const FOREIGN = evaluated("foreign", { kind: "none", cause: "not-holder" }, { kind: "not-yet", boundary: R });
const FREE = evaluated("free", { kind: "none", cause: "free" }, { kind: "not-applicable" });
const ABSENT = evaluated("absent", { kind: "none", cause: "absent" }, { kind: "not-applicable" }, null);
const RIGHTS_INVALID: ClaimRightEvaluation = { kind: "invalid", reason: REASON };
const Q_NOT_STORED = resolvedQuery({ kind: "not-stored", observedRoot: ROOT });
const Q_OPEN = resolvedQuery({ kind: "open", observedRoot: ROOT });
const Q_CONFLICT = resolvedQuery({ kind: "conflict", reason: REASON });
const Q_UNKNOWN: ClaimMutationQueryResult = { kind: "unknown", reason: REASON };
const Q_HISTORY: ClaimMutationQueryResult = { kind: "unknown-history", reason: REASON };
const V_NOT_STORED = queriedView("remote", queryView("resolved", "not-stored"));
const V_OPEN = queriedView("unknown", queryView("resolved", "open"));
const V_UNKNOWN = queriedView("unknown", queryView("unknown"));
const V_CONFLICT = queriedView("unknown", queryView("resolved", "conflict"));
const V_HISTORY = queriedView("unknown", queryView("unknown-history"));

/** Rows after the positive control. */
const OPERATION_ROWS: OperationRow[] = [
	{
		label: "first send rejected stale",
		catches: "a storage rejection as an error document; stale merged with remote",
		result: operation({ kind: "rejected", cause: "stale" }, "rejected", 1, FREE),
		expected: op("rejected", "rejected", { kind: "rejected", cause: "stale" }, 1, FREE, {
			rejection: { stage: "storage", cause: "stale" },
		}),
	},
	{
		label: "first send rejected remote",
		catches: "remote merged with stale; a remote rejection read as ownership",
		result: operation({ kind: "rejected", cause: "remote" }, "rejected", 1, FOREIGN),
		expected: op("rejected", "rejected", { kind: "rejected", cause: "remote" }, 1, FOREIGN, {
			rejection: { stage: "storage", cause: "remote" },
		}),
	},
	{
		label: "later send rejected, query not-stored",
		catches: "a resolution rejection reported as unknown or as a storage rejection",
		result: operation(queried("remote", Q_NOT_STORED), "rejected", 2, FOREIGN),
		expected: op("rejected", "rejected", V_NOT_STORED, 2, FOREIGN, {
			rejection: { stage: "resolution", cause: "not-stored" },
		}),
	},
	{
		label: "open after the last permitted send",
		catches: "a lost reply reported as rejected or free; the stop cause dropped",
		result: operation(queried("unknown", Q_OPEN), "unknown", 3, ABSENT),
		stoppedBy: "attempts",
		expected: op("unknown", "unknown", V_OPEN, 3, ABSENT, { stoppedBy: "attempts" }),
	},
	{
		label: "budget stop before the second send",
		catches: "a budget stop reported without its cause",
		result: operation(queried("unknown", Q_OPEN), "unknown", 1, ABSENT),
		stoppedBy: "budget",
		expected: op("unknown", "unknown", V_OPEN, 1, ABSENT, { stoppedBy: "budget" }),
	},
	{
		label: "query unknown after a lost reply",
		catches: "an unknown query reported as rejected; a failed rights read replacing the outcome",
		result: operation(queried("unknown", Q_UNKNOWN), "unknown", 1, RIGHTS_INVALID),
		expected: op("unknown", "unknown", V_UNKNOWN, 1, RIGHTS_INVALID),
	},
	{
		label: "contradicting receipt",
		catches: "a conflict reported as applied or as plain unknown",
		result: operation(queried("unknown", Q_CONFLICT), "unknown-history", 1, FOREIGN),
		expected: op("unknown-history", "unknown-history", V_CONFLICT, 1, FOREIGN),
	},
	{
		label: "outer unknown-history",
		catches: "lost history reported as rejected or free",
		result: operation(queried("unknown", Q_HISTORY), "unknown-history", 1, ABSENT),
		expected: op("unknown-history", "unknown-history", V_HISTORY, 1, ABSENT),
	},
	{
		label: "journal unavailable before the first send",
		catches: "not-sent reported as applied, as refused or without the operation ID",
		result: operation({ kind: "not-sent", cause: "journal-unavailable" }, "not-sent", 0, FREE),
		expected: op("unavailable", "not-sent", { kind: "not-sent", cause: "journal-unavailable" }, 0, FREE),
	},
	{
		label: "admission held before the first send",
		catches: "an admission refusal reported as paused, as refused or without its cause",
		result: operation({ kind: "not-sent", cause: "admission-held" }, "not-sent", 0, FREE),
		expected: op("unavailable", "not-sent", { kind: "not-sent", cause: "admission-held" }, 0, FREE),
	},
	{
		label: "applied with a failed final rights read",
		catches: "a failed rights read turning a stored mutation into an error (three separate facts)",
		result: operation({ kind: "applied", root: ROOT }, "applied", 1, RIGHTS_INVALID),
		expected: op("applied", "applied", { kind: "applied" }, 1, RIGHTS_INVALID),
	},
	{
		label: "plan rejected not-free",
		catches: "an operation ID without a record; a plan rejection as an error document",
		result: notPlanned({ kind: "rejected", cause: "not-free", reason: REASON }, FOREIGN),
		expected: planRejection("not-free", FOREIGN),
	},
	{
		label: "plan rejected not-yet",
		catches: "the reclaim boundary dropped",
		result: notPlanned({ kind: "rejected", cause: "not-yet", reason: REASON, boundary: R }, FOREIGN),
		expected: planRejection("not-yet", FOREIGN, R),
	},
	{
		label: "plan corrupt",
		catches: "a corrupt state read as free",
		result: notPlanned({ kind: "corrupt", reason: REASON }, RIGHTS_INVALID),
		expected: errorBody("refused", "state-corrupt"),
	},
	{
		label: "plan unsupported",
		catches: "a newer state version treated as corrupt or overwritten",
		result: notPlanned({ kind: "unsupported", reason: REASON }, RIGHTS_INVALID),
		expected: errorBody("refused", "state-unsupported"),
	},
	{
		label: "plan invalid",
		catches: "an invalid request reported as a rejection",
		result: notPlanned({ kind: "invalid", reason: REASON }, RIGHTS_INVALID),
		expected: errorBody("refused", "request-invalid"),
	},
	{
		label: "plan unknown",
		catches: "an unplannable observation reported as refused",
		result: notPlanned({ kind: "unknown", reason: REASON }, RIGHTS_INVALID),
		expected: errorBody("unavailable", "state-unknown"),
	},
	{
		label: "top-level invalid",
		catches: "invalid executor options reported as unknown",
		result: topLevel("invalid"),
		expected: errorBody("refused", "request-invalid"),
	},
	{
		label: "top-level corrupt",
		catches: "a corrupt context reported as unavailable",
		result: topLevel("corrupt"),
		expected: errorBody("refused", "context-corrupt"),
	},
	{
		label: "top-level unsupported",
		catches: "a newer coordination schema reported as corrupt",
		result: topLevel("unsupported"),
		expected: errorBody("refused", "schema-unsupported"),
	},
	{
		label: "top-level unavailable",
		catches: "a local IO failure reported as refused",
		result: topLevel("unavailable"),
		expected: errorBody("unavailable", "local-unavailable"),
	},
	{
		label: "top-level unknown",
		catches: "a failure before any send reported as unknown/3",
		result: topLevel("unknown"),
		expected: errorBody("unavailable", "storage-unreadable"),
	},
];

/** Rows after the positive control (unreachable); `ready` has no error document. */
const PREFLIGHT_ROWS: PreflightRow[] = [
	{
		label: "not-configured",
		catches: "a missing block read as disabled",
		verdict: { kind: "not-configured", reason: REASON },
		expected: errorBody("refused", "not-configured"),
	},
	{
		label: "config-invalid",
		catches: "problem messages copied into JSON; problems dropped",
		verdict: {
			kind: "config-invalid",
			reason: REASON,
			problems: [
				{ key: "claims.attempts", problem: "out-of-range", message: REASON },
				{ key: "claims.endpoint", problem: "unsupported-endpoint", message: REASON },
			],
		},
		expected: errorBody("refused", "config-invalid", {
			problems: [
				{ key: "claims.attempts", problem: "out-of-range" },
				{ key: "claims.endpoint", problem: "unsupported-endpoint" },
			],
		}),
	},
	{
		label: "claims-disabled",
		catches: "disabled merged with not-configured",
		verdict: { kind: "claims-disabled", reason: REASON },
		expected: errorBody("refused", "claims-disabled"),
	},
	{
		label: "context-invalid",
		catches: "a missing handle repaired or defaulted",
		verdict: { kind: "context-invalid", reason: REASON },
		expected: errorBody("refused", "context-invalid"),
	},
	{
		label: "context-corrupt",
		catches: "a corrupt context merged with an invalid one",
		verdict: { kind: "context-corrupt", reason: REASON },
		expected: errorBody("refused", "context-corrupt"),
	},
	{
		label: "context-unavailable",
		catches: "a transient context failure reported as refused",
		verdict: { kind: "context-unavailable", reason: REASON },
		expected: errorBody("unavailable", "context-unavailable"),
	},
	{
		label: "descriptor-missing",
		catches: "an uninitialized area read as an empty list",
		verdict: { kind: "descriptor-missing", reason: REASON },
		expected: errorBody("refused", "descriptor-missing"),
	},
	{
		label: "format-mismatch",
		catches: "the descriptor copied instead of the two formats",
		verdict: { kind: "format-mismatch", reason: REASON, configured: "tree", descriptor: BLOB_DESCRIPTOR },
		expected: errorBody("refused", "format-mismatch", { configuredFormat: "tree", existingFormat: "blob" }),
	},
	{
		label: "schema-unsupported",
		catches: "a newer schema reported as corrupt",
		verdict: { kind: "schema-unsupported", reason: REASON },
		expected: errorBody("refused", "schema-unsupported"),
	},
	{
		label: "corrupt",
		catches: "a corrupt descriptor merged with unreachable",
		verdict: { kind: "corrupt", reason: REASON },
		expected: errorBody("refused", "coordination-corrupt"),
	},
	{
		label: "invalid",
		catches: "invalid preflight options reported as unavailable",
		verdict: { kind: "invalid", reason: REASON },
		expected: errorBody("refused", "preflight-invalid"),
	},
	{
		label: "unknown",
		catches: "an unknown preflight reported as ready or refused",
		verdict: { kind: "unknown", reason: REASON },
		expected: errorBody("unavailable", "preflight-unknown"),
	},
];

/** Resolve rows after the positive control (stored). Errors echo the requested ID. */
const RESOLUTION_ROWS: ResolutionRow[] = [
	{
		label: "not-stored",
		catches: "a foreign successor read as unknown",
		result: Q_NOT_STORED,
		ticket: TICKET,
		expected: resolutionBody("rejected", "rejected", queryView("resolved", "not-stored")),
	},
	{
		label: "open",
		catches: "an open intent read as rejected",
		result: Q_OPEN,
		ticket: TICKET,
		expected: resolutionBody("unknown", "unknown", queryView("resolved", "open")),
	},
	{
		label: "conflict",
		catches: "a contradicting receipt read as unknown",
		result: Q_CONFLICT,
		ticket: TICKET,
		expected: resolutionBody("unknown-history", "unknown-history", queryView("resolved", "conflict")),
	},
	{
		label: "resolved unknown-history",
		catches: "incomplete history read as rejected",
		result: resolvedQuery({ kind: "unknown-history", reason: REASON }),
		ticket: TICKET,
		expected: resolutionBody("unknown-history", "unknown-history", queryView("resolved", "unknown-history")),
	},
	{
		label: "resolved unknown",
		catches: "a malformed observation read as rejected",
		result: resolvedQuery({ kind: "unknown", reason: REASON }),
		ticket: TICKET,
		expected: resolutionBody("unknown", "unknown", queryView("resolved", "unknown")),
	},
	{
		label: "resolved invalid",
		catches: "a scope-mismatched observation read as refused",
		result: resolvedQuery({ kind: "invalid", reason: REASON }),
		ticket: TICKET,
		expected: resolutionBody("unknown", "unknown", queryView("resolved", "invalid")),
	},
	{
		label: "outer unknown",
		catches: "an unreadable store read as unavailable",
		result: Q_UNKNOWN,
		ticket: TICKET,
		expected: resolutionBody("unknown", "unknown", queryView("unknown")),
	},
	{
		label: "outer unknown-history",
		catches: "a changed scope read as rejected",
		result: Q_HISTORY,
		ticket: TICKET,
		expected: resolutionBody("unknown-history", "unknown-history", queryView("unknown-history")),
	},
	{
		label: "outer unavailable",
		catches: "a journal IO failure read as unknown",
		result: { kind: "unavailable", reason: REASON },
		ticket: null,
		// ASSUMPTION(surface): the contract names no code here; the pre-send code local-unavailable is reused.
		expected: errorBody("unavailable", "local-unavailable", {}, "resolve", null, OP),
	},
	{
		label: "record-absent",
		catches: "an absent record read as never sent or as rejected (QUERY-CONTRACT:37-38)",
		result: { kind: "record-absent" },
		ticket: null,
		expected: errorBody("refused", "operation-not-found", {}, "resolve", null, OP),
	},
	{
		label: "record-corrupt",
		catches: "a corrupt record read as absent",
		result: { kind: "record-corrupt", reason: REASON },
		ticket: null,
		expected: errorBody("refused", "record-corrupt", {}, "resolve", null, OP),
	},
	{
		label: "outer invalid",
		catches: "a record of another endpoint or format queried anyway",
		result: { kind: "invalid", reason: REASON },
		ticket: TICKET,
		expected: errorBody("refused", "scope-mismatch", {}, "resolve", TICKET, OP),
	},
	{
		label: "outer unsupported",
		catches: "a newer schema read as unknown",
		result: { kind: "unsupported", reason: REASON },
		ticket: TICKET,
		// ASSUMPTION(surface): the contract names no code here; the preflight code schema-unsupported is reused.
		expected: errorBody("refused", "schema-unsupported", {}, "resolve", TICKET, OP),
	},
];

/** Base 1000 and max 5000 unless the row says otherwise; formula floor(r·(w+1)). */
const PAUSE_ROWS: PauseRow[] = [
	{ label: "send 60", catches: "an overflowing window", send: 60, draw: TOP, pause: PAUSE, expected: 5_000 },
	{
		label: "send 1100",
		catches: "Infinity or NaN once 2^k overflows",
		send: 1_100,
		draw: TOP,
		pause: PAUSE,
		expected: 5_000,
	},
	{
		label: "zero base and maximum",
		catches: "a minimum pause",
		send: 4,
		draw: TOP,
		pause: { baseMs: 0, maxMs: 0 },
		expected: 0,
	},
	{
		label: "1 ms pauses (bud-03)",
		catches: "off-by-one: floor(r·w) never reaches the maximum",
		send: 2,
		draw: TOP,
		pause: { baseMs: 1, maxMs: 1 },
		expected: 1,
	},
	{
		label: "equal base and maximum",
		catches: "doubling beyond the maximum",
		send: 3,
		draw: 0.5,
		pause: { baseMs: 3_000, maxMs: 3_000 },
		expected: 1_500,
	},
];

const SCHEDULE_ROWS: ScheduleRow[] = [
	{
		label: "pause ends exactly at the deadline",
		catches: "> instead of ≥ at the deadline",
		startedAt: 0,
		budgetMs: 1_500,
		now: 1_000,
		draw: 0.5,
		oversleepMs: 0,
		expected: { decision: "stop", slept: [], stoppedBy: "budget", timeout: 500 },
	},
	{
		label: "the sleep itself overruns the deadline",
		catches: "a send after a pause that ended past the deadline",
		startedAt: 0,
		budgetMs: 3_000,
		now: 1_000,
		draw: 0.5,
		oversleepMs: 2_000,
		expected: { decision: "stop", slept: [500], stoppedBy: "budget", timeout: 1 },
	},
	{
		label: "deadline already passed",
		catches: "a pause started after the deadline; a zero or negative command timeout",
		startedAt: 0,
		budgetMs: 1_000,
		now: 1_200,
		draw: 0,
		oversleepMs: 0,
		expected: { decision: "stop", slept: [], stoppedBy: "budget", timeout: 1 },
	},
	{
		label: "late in a long budget",
		catches: "a deadline measured from the first send instead of the start before the preflight",
		startedAt: 0,
		budgetMs: 30_000,
		now: 29_800,
		draw: 0.5,
		oversleepMs: 0,
		expected: { decision: "stop", slept: [], stoppedBy: "budget", timeout: 200 },
	},
];

const LEASE_SETTINGS: Body = {
	enabled: true,
	endpoint: CFG_ENDPOINT,
	storageFormat: "blob",
	lifetime: { mode: "lease", leaseTtlMs: 300_000, reclaimGraceMs: 600_000 },
	attemptTimeoutMs: 10_000,
	attempts: 3,
	operationBudgetMs: 30_000,
};
const NONE_SETTINGS: Body = { ...LEASE_SETTINGS, lifetime: { mode: "none" } };
const SURFACE = surfaceLines("2000", "1000", "5000");
const TIMER = String(MAX_TIMER);

const SETTINGS_ROWS: SettingsRow[] = [
	{
		label: "zero eps and zero pauses",
		catches: "eps or pauses required to be positive",
		yaml: cfgBlock("lease", surfaceLines("0", "0", "0")),
		expected: configured(LEASE_SETTINGS, 0, 0, 0),
	},
	{
		label: "timer cap",
		catches: "a lower cap than 2147483647",
		yaml: cfgBlock("lease", surfaceLines(TIMER, TIMER, TIMER)),
		expected: configured(LEASE_SETTINGS, MAX_TIMER, MAX_TIMER, MAX_TIMER),
	},
	{
		label: "eps above the timer cap",
		catches: "no upper bound",
		yaml: cfgBlock("lease", surfaceLines("2147483648", "1000", "5000")),
		expected: invalidSetting("clock_uncertainty_ms", "out-of-range"),
	},
	{
		label: "negative eps",
		catches: "a negative clock uncertainty accepted",
		yaml: cfgBlock("lease", surfaceLines("-1", "1000", "5000")),
		expected: invalidSetting("clock_uncertainty_ms", "out-of-range"),
	},
	{
		label: "fractional eps",
		catches: "lax numeric parsing",
		yaml: cfgBlock("lease", surfaceLines("1.5", "1000", "5000")),
		expected: invalidSetting("clock_uncertainty_ms", "wrong-type"),
	},
	{
		label: "quoted eps",
		catches: "a string coerced to a number",
		yaml: cfgBlock("lease", surfaceLines('"2000"', "1000", "5000")),
		expected: invalidSetting("clock_uncertainty_ms", "wrong-type"),
	},
	{
		label: "negative pause base",
		catches: "a negative pause accepted",
		yaml: cfgBlock("lease", surfaceLines("2000", "-1", "5000")),
		expected: invalidSetting("retry_pause_base_ms", "out-of-range"),
	},
	{
		label: "pause maximum below the base",
		catches: "the rule max ≥ base missing; ASSUMPTION: reported on the maximum as out-of-range",
		yaml: cfgBlock("lease", surfaceLines("2000", "3000", "2000")),
		expected: invalidSetting("retry_pause_max_ms", "out-of-range"),
	},
	{
		label: "eps in mode none",
		catches: "eps rejected as not-applicable although old lease claims keep their mode",
		yaml: cfgBlock("none", SURFACE),
		expected: configured(NONE_SETTINGS, 2_000, 1_000, 5_000),
	},
	{
		label: "duplicate eps",
		catches: "the new keys outside the resolver's duplicate detector",
		yaml: cfgBlock("lease", [...SURFACE, "  clock_uncertainty_ms: 3000"]),
		expected: invalidSetting("clock_uncertainty_ms", "duplicate"),
	},
	{
		// The resolver keeps the three keys optional; the surface requires them.
		label: "surface keys absent",
		catches: "a start value substituted for a missing key",
		yaml: cfgBlock("lease", []),
		expected: { kind: "configured", settings: LEASE_SETTINGS, problems: null },
	},
	{
		// Each present key is validated on its own.
		label: "only eps present",
		catches: "pause start values filled in by the resolver",
		yaml: cfgBlock("lease", ["  clock_uncertainty_ms: 2000"]),
		expected: { kind: "configured", settings: { ...LEASE_SETTINGS, clockUncertaintyMs: 2_000 }, problems: null },
	},
];

describe("claim documents from module results (pure)", () => {
	test("map-01 out-05: executor results map to one allowlisted operation or error document", () => {
		// Scanner positive control: a planted sentinel is counted.
		expect(echoes(`planted ${SENTINEL}`)).toBe(1);
		// Positive control (catches: no mapping; a copied upstream object; applied without the operation ID).
		const applied = operation({ kind: "applied", root: ROOT }, "applied", 1, HELD);
		const expectedApplied = op("applied", "applied", { kind: "applied" }, 1, HELD);
		expect(viewOf("applied", mapOperation(applied))).toEqual(expectedView("applied", expectedApplied));
		for (const row of OPERATION_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(viewOf(label, mapOperation(row.result, row.stoppedBy))).toEqual(expectedView(label, row.expected));
		}
	});

	test("map-02: every non-ready preflight verdict is refused or unavailable with its own code", () => {
		const unreachable: PreflightFailure = { kind: "unreachable", reason: REASON };
		// Positive control (catches: unreachable read as ok or as an empty list).
		const expectedUnreachable = errorBody("unavailable", "unreachable");
		expect(viewOf("unreachable", mapPreflight(unreachable))).toEqual(expectedView("unreachable", expectedUnreachable));
		for (const row of PREFLIGHT_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(viewOf(label, mapPreflight(row.verdict))).toEqual(expectedView(label, row.expected));
		}
	});

	test("map-03: resolve maps every query result without sending", () => {
		const stored = resolvedQuery({ kind: "stored", observedRoot: ROOT });
		// Positive control (catches: a stored receipt reported as unknown).
		const expectedStored = resolutionBody("applied", "applied", queryView("resolved", "stored"));
		expect(viewOf("stored", mapResolution(stored, TICKET))).toEqual(expectedView("stored", expectedStored));
		for (const row of RESOLUTION_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(viewOf(label, mapResolution(row.result, row.ticket))).toEqual(expectedView(label, row.expected));
		}
	});

	test("map-06: an executor pause maps to claim-pause with exit 7 and names retry as the way out", () => {
		const ids = [OP, OP_OTHER];
		const outstanding = paused({ kind: "outstanding", operationIds: ids }, HELD);
		// Positive control (catches: no pause mapping; the pause as refused own-operation-open or as an error).
		const expectedOutstanding = pauseBody({ kind: "outstanding", operationIds: ids }, HELD);
		const doc = mapOperation(outstanding);
		expect(viewOf("outstanding", doc)).toEqual(expectedView("outstanding", expectedOutstanding));
		// catches: a human text that hides the operation IDs or the way out (retry never pauses).
		const { stdout } = formatClaimDocumentText(doc);
		expect({ ids: ids.map((id) => stdout.includes(id)), retry: stdout.includes("retry") }).toEqual({
			ids: [true, true],
			retry: true,
		});
		const rows = [
			{
				label: "unknown pause (catches: the upstream reason copied; unknown merged with outstanding)",
				result: paused({ kind: "unknown", reason: REASON }, RIGHTS_INVALID),
				expected: pauseBody({ kind: "unknown" }, RIGHTS_INVALID),
			},
			{
				label: "outstanding under foreign rights (catches: rights dropped or taken from another source)",
				result: paused({ kind: "outstanding", operationIds: [OP] }, FOREIGN),
				expected: pauseBody({ kind: "outstanding", operationIds: [OP] }, FOREIGN),
			},
		];
		for (const row of rows) {
			expect(viewOf(row.label, mapOperation(row.result))).toEqual(expectedView(row.label, row.expected));
		}
	});
});

describe("retry pauses and the operation budget (pure, injected seams)", () => {
	test("sch-01: full jitter over a doubling window capped at the maximum", () => {
		// Positive control (catches: no pause formula at all).
		expect(claimRetryPauseMs(2, 0.5, PAUSE)).toBe(500);
		const draws = [0, 0.5, TOP];
		const table = [2, 3, 4, 5, 6, 7].map((send) => ({
			send,
			pauses: draws.map((draw) => claimRetryPauseMs(send, draw, PAUSE)),
		}));
		// Windows 1000, 2000, 4000 and then 5000; a draw of 0 pauses 0 (catches: equal jitter).
		expect(table).toEqual([
			{ send: 2, pauses: [0, 500, 1_000] },
			{ send: 3, pauses: [0, 1_000, 2_000] },
			{ send: 4, pauses: [0, 2_000, 4_000] },
			{ send: 5, pauses: [0, 2_500, 5_000] },
			{ send: 6, pauses: [0, 2_500, 5_000] },
			{ send: 7, pauses: [0, 2_500, 5_000] },
		]);
		const edges = PAUSE_ROWS.map((row) => ({
			label: `${row.label} (catches: ${row.catches})`,
			pause: claimRetryPauseMs(row.send, row.draw, row.pause),
		}));
		expect(edges).toEqual(
			PAUSE_ROWS.map((row) => ({ label: `${row.label} (catches: ${row.catches})`, pause: row.expected })),
		);
	});

	test("bud-01: pauses fit the budget, a late pause stops without sleeping, commands are capped", async () => {
		const seams = fakeSeams(2_000, [0.5, 0.5, 0.5]);
		// Deadline 11_000 on the monotonic clock; attempt timeout 3_000.
		const gate = schedule(seams, 1_000, 10_000);
		// Positive control (catches: always "stop"; no pause; equal jitter).
		expect({ decision: await gate.beforeSend(2), slept: [...seams.state.slept] }).toEqual({
			decision: "send",
			slept: [500],
		});
		const timeouts = [gate.commandTimeoutMs()];
		seams.state.now = 9_000;
		timeouts.push(gate.commandTimeoutMs());
		const decisions = [await gate.beforeSend(3)];
		const before = gate.stoppedBy();
		decisions.push(await gate.beforeSend(4));
		seams.state.now = 11_500;
		timeouts.push(gate.commandTimeoutMs());
		// catches: a pause over the deadline; sleeping and then stopping; more than one draw per gate; an uncapped or
		// zero command timeout (max(1, min(attempt, rest))).
		expect({
			decisions,
			slept: seams.state.slept,
			draws: seams.state.draws,
			timeouts,
			stoppedBy: [before, gate.stoppedBy()],
		}).toEqual({
			decisions: ["send", "stop"],
			slept: [500, 1_000],
			draws: 3,
			timeouts: [3_000, 2_000, 1],
			stoppedBy: [null, "budget"],
		});
		for (const row of SCHEDULE_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			const rowSeams = fakeSeams(row.now, [row.draw], row.oversleepMs);
			const rowGate = schedule(rowSeams, row.startedAt, row.budgetMs);
			const decision = await rowGate.beforeSend(2);
			expect({
				label,
				decision,
				slept: rowSeams.state.slept,
				stoppedBy: rowGate.stoppedBy(),
				timeout: rowGate.commandTimeoutMs(),
			}).toEqual({ label, ...row.expected });
		}
	});
});

describe("claims configuration for eps and retry pauses (pure resolver)", () => {
	test("cfg5-01: eps and pauses are validated fully, never defaulted, optional in the resolver", () => {
		// Positive control (catches: the new keys reported as unknown-key).
		expect(settingsView(cfgBlock("lease", SURFACE))).toEqual(configured(LEASE_SETTINGS, 2_000, 1_000, 5_000));
		for (const row of SETTINGS_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect({ label, ...settingsView(row.yaml) }).toEqual({ label, ...row.expected });
		}
		// The pause start values live in their own constant; eps has none; cfg-16 stays unchanged.
		expect({ retry: { ...CLAIM_RETRY_START_VALUES }, start: { ...CLAIM_START_VALUES } }).toEqual({
			retry: { retryPauseBaseMs: 1_000, retryPauseMaxMs: 5_000 },
			start: {
				leaseTtlMs: 300_000,
				reclaimGraceMs: 600_000,
				attemptTimeoutMs: 10_000,
				attempts: 3,
				operationBudgetMs: 30_000,
			},
		});
	});
});

describe("exit codes, error codes and the guide", () => {
	test("map-05: the exit code table is exactly the documented one and exit 1 stays reserved", () => {
		// Positive control (catches: rejected mapped to 1 like today's text errors).
		expect(CLAIM_EXIT_CODES.rejected).toBe(2);
		const table: Record<string, number> = { ...CLAIM_EXIT_CODES };
		// catches: a status added or merged; exit 1 shared with a claim status (Commander uses it).
		expect({ table, one: Object.keys(table).filter((status) => table[status] === 1) }).toEqual({
			table: EXPECTED_EXIT,
			one: ["internal"],
		});
	});

	test("codes: the closed v1 code list with its documented statuses", () => {
		// Positive control (catches: an exhausted budget reported as unknown).
		expect(CLAIM_ERROR_CODES["budget-exhausted"]).toBe("unavailable");
		const codes: Record<string, string> = { ...CLAIM_ERROR_CODES };
		const fixed = Object.fromEntries(Object.keys(FIXED_CODE_STATUSES).map((code) => [code, codes[code] ?? null]));
		expect({
			codes: Object.keys(codes).sort(byCodeUnits),
			fixed,
			unknownStatuses: Object.values(codes).filter((status) => !(status in EXPECTED_EXIT)),
		}).toEqual({ codes: [...PLAN_ERROR_CODES].sort(byCodeUnits), fixed: FIXED_CODE_STATUSES, unknownStatuses: [] });
	});

	test("doc-02: the guide tables equal the exit code and error code constants in both directions", async () => {
		const guide = await readFile(GUIDE_PATH, "utf8");
		const exits = tableRows(guide, "status", "exit");
		// Positive control (catches: a guide without a status table).
		expect(exits.length).toBeGreaterThan(0);
		const codes = tableRows(guide, "code", "status");
		expect({
			exits: Object.fromEntries(exits.map(([status = "", exit = ""]) => [status, Number(exit)])),
			codes: Object.fromEntries(codes.map(([code = "", status = ""]) => [code, status])),
		}).toEqual({ exits: { ...CLAIM_EXIT_CODES }, codes: { ...CLAIM_ERROR_CODES } });
	});
});

// Setup, init and context create belong to the base CLI.
const TREE_DESCRIPTOR = { schema: 1, format: "tree", epoch: 1 } as const;
const INIT_ROWS: InitRow[] = [
	{
		label: "exists",
		catches: "an idempotent second init reported as a conflict",
		result: { kind: "exists", descriptor: TREE_DESCRIPTOR },
		expected: initBody("exists", "tree"),
	},
	{
		label: "conflict",
		catches: "a conflicting format adopted; ASSUMPTION: both formats as in format-mismatch",
		result: { kind: "conflict", reason: REASON, configured: "tree", descriptor: BLOB_DESCRIPTOR },
		expected: errorBody(
			"refused",
			"format-conflict",
			{ configuredFormat: "tree", existingFormat: "blob" },
			"init",
			null,
		),
	},
	{
		label: "not-empty",
		catches: "ticket refs without a descriptor initialized over",
		result: { kind: "not-empty", reason: REASON },
		expected: errorBody("refused", "not-empty", {}, "init", null),
	},
	{
		label: "rejected",
		catches: "a remote rejection reported as unavailable",
		result: { kind: "rejected", reason: REASON },
		expected: errorBody("refused", "remote-rejected", {}, "init", null),
	},
	{
		label: "config-invalid",
		catches: "problem messages copied into JSON",
		result: {
			kind: "config-invalid",
			reason: REASON,
			problems: [{ key: "claims.storage_format", problem: "unsupported-value", message: REASON }],
		},
		expected: errorBody(
			"refused",
			"config-invalid",
			{ problems: [{ key: "claims.storage_format", problem: "unsupported-value" }] },
			"init",
			null,
		),
	},
	{
		label: "not-configured",
		catches: "init without a block",
		result: { kind: "not-configured", reason: REASON },
		expected: errorBody("refused", "not-configured", {}, "init", null),
	},
	{
		label: "schema-unsupported",
		catches: "a newer schema reported as corrupt",
		result: { kind: "schema-unsupported", reason: REASON },
		expected: errorBody("refused", "schema-unsupported", {}, "init", null),
	},
	{
		label: "unreachable",
		catches: "an unreachable endpoint reported as refused",
		result: { kind: "unreachable", reason: REASON },
		expected: errorBody("unavailable", "unreachable", {}, "init", null),
	},
	{
		label: "unknown",
		catches: "init-unknown reported as ok or as unavailable (DP-13)",
		result: { kind: "unknown", reason: REASON },
		expected: errorBody("unknown", "init-unknown", {}, "init", null),
	},
];
/** The contract names statuses but no codes for these; any listed code is accepted. */
const INIT_STATUS_ROWS: { label: string; result: ClaimCoordinationInitResult; status: Status }[] = [
	{ label: "corrupt", result: { kind: "corrupt", reason: REASON }, status: "refused" },
	{ label: "invalid", result: { kind: "invalid", reason: REASON }, status: "refused" },
	{ label: "not-sent", result: { kind: "not-sent", reason: REASON }, status: "unavailable" },
];

function mapInit(result: ClaimCoordinationInitResult): ClaimDocument {
	// claimInitDocument takes the preflight init result alone.
	return claimInitDocument(tainted(result));
}

describe("claim init documents (pure, removable)", () => {
	test("map-04: init results map to claim-init or to refused, unavailable and init-unknown", () => {
		const created: ClaimCoordinationInitResult = { kind: "created", descriptor: BLOB_DESCRIPTOR };
		// Positive control (catches: no init mapping).
		expect(viewOf("created", mapInit(created))).toEqual(expectedView("created", initBody("created", "blob")));
		for (const row of INIT_ROWS) {
			const label = `${row.label} (catches: ${row.catches})`;
			expect(viewOf(label, mapInit(row.result))).toEqual(expectedView(label, row.expected));
		}
		const statusOnly = INIT_STATUS_ROWS.map((row) => {
			const doc = mapInit(row.result);
			const code = field(doc, "code");
			return {
				label: row.label,
				kind: field(doc, "kind"),
				status: field(doc, "status"),
				exit: claimExitCode(doc),
				listed: typeof code === "string" && Object.hasOwn(CLAIM_ERROR_CODES, code),
				echoed: echoes(JSON.stringify(doc)),
			};
		});
		expect(statusOnly).toEqual(
			INIT_STATUS_ROWS.map((row) => ({
				label: row.label,
				kind: "claim-error",
				status: row.status,
				exit: EXPECTED_EXIT[row.status] ?? -1,
				listed: true,
				echoed: 0,
			})),
		);
	});
});
