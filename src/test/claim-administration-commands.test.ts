/**
 * The claim CLI core for transfer, resume and change-bounds in process, without a Git server, without a subprocess and
 * without the wall clock; private temp contexts and the ClaimSurfaceEnv seams only. Pinned here: the four additive
 * error codes and their guide rows, the policy key `claims.transfer_time_box` in the preflight resolver, every local
 * check and its precedence before any IO, the advisory context pre-check over real private contexts,
 * `context create --recover-from`, the human hints and the mapping of plan rejections and pauses of the three
 * commands. Every `runClaimMutation` call ends before the executor: at a local check, at the pre-check or at the
 * preflight, which a relative project root stops at its option check (config/index.ts:478) before any Git command. No
 * call prepares an intent, so no own outstanding intent can pause a later call. Every test starts with a positive
 * control; table rows name the deliberately wrong implementation they catch. Names and values the typed scaffold adds
 * are marked ASSUMPTION(scaffold).
 * Harness: adapted copies with "adapted from" notes, no shared fixture module.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ClaimConfigProblem, resolveClaimSettings } from "../claims/config/index.ts";
import { type ClaimContext, claimContextIO, createClaimContext, loadClaimContext } from "../claims/context/index.ts";
import type { ClaimExecutionResult } from "../claims/execution/index.ts";
import { claimJournalIO } from "../claims/journal/index.ts";
import type { ClaimRightEvaluation } from "../claims/rights/index.ts";
import {
	CLAIM_ERROR_CODES,
	type ClaimCommand,
	type ClaimDocument,
	type ClaimErrorCode,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimExitCode,
	claimOperationDocument,
	runClaimContextCreate,
	runClaimMutation,
	runClaimSetup,
} from "../claims/surface/index.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";

type Body = Record<string, unknown>;
type Mode = "lease" | "hard" | "none";
type ContextSeam = typeof claimContextIO;
type JournalSeam = typeof claimJournalIO;
type SeamEntry = (...args: unknown[]) => Promise<unknown>;
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type Sentinel = readonly [label: string, value: string];
type ContextHandle = { name: string; context: ClaimContext; directory: string };
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type NotPlanned = Extract<ClaimExecutionResult, { kind: "not-planned" }>;
type Paused = Extract<ClaimExecutionResult, { kind: "paused" }>;
type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
/**
 * Every option of a mutating command besides command, ticket and context; all optional, so a spread fills no required
 * field. ASSUMPTION(scaffold): ClaimMutationInput carries toContext, timeBox, mode, leaseEnd and graceMs.
 */
type Options = Omit<ClaimMutationInput, "command" | "ticket" | "context">;
/** ASSUMPTION(scaffold): ClaimCommand and ClaimMutationCommand carry the three administration commands. */
type AdministrationCommand = "transfer" | "resume" | "change-bounds";
/** The four plan causes, all without `boundary`. */
type NewCause = "time-box-required" | "requires-time-path" | "lease-required" | "mode-change";
type SettingsView = { label: string; kind: string; settings: unknown };
type SettingsRow = { label: string; catches: string; yaml: string; settings: Body };
type ProblemView = { key: string; problem: string };
type ProblemsView = { label: string; kind: string; problems: ProblemView[]; faultyMessages: string[] };
type ProblemRow = { label: string; catches: string; yaml: string; values: string[]; problems: ProblemView[] };
/** Level P: the whole document with a non-empty message replaced by MESSAGE, exit code, sorted keys and echoes. */
type DocumentView = { label: string; exit: number; keys: string[]; body: Body; echoed: number };
type CodeView = DocumentView & { messageFlaws: string[] };
/** ploc-01: the document and every seam call it caused; a local refusal causes none. */
type LocalView = DocumentView & { calls: string[] };
type LocalRow = { label: string; catches: string; input: ClaimMutationInput; yaml?: string; expected: Body };
/** Real contexts: the document with the context ID shape instead of the random ID, and the echoed sentinel labels. */
type ContextView = { label: string; exit: number; keys: string[]; body: Body; echoed: string[] };
type ContextRow = { label: string; catches: string; input: ClaimMutationInput; failLstatAt?: string; expected: Body };
type RecoverRow = { label: string; catches: string; recoverFrom: string; failLstatAt?: string; expected: Body };
type HumanView = {
	label: string;
	stream: string;
	head: string | null;
	codeShown: boolean | null;
	hint: boolean | null;
	echoed: number;
};
type HumanRow = {
	label: string;
	catches: string;
	doc: ClaimDocument;
	status: string;
	stream: string;
	flag: string | null;
};
type MappedView = {
	label: string;
	exit: number;
	keys: string[];
	rejectionKeys: string[] | null;
	body: Body;
	echoed: number;
};
type MapRow = { label: string; command: AdministrationCommand; result: ClaimExecutionResult; expected: Body };

/** Real private contexts load with four fsyncs each (context/index.ts:182-197); bun's 5 s default is too tight. */
const TEST_TIMEOUT = 30_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** In inputs, in the temp root and in every context parent; no document and no human text may contain it. */
const SENTINEL = "SENTINEL-administration-commands-6c47";
const TICKET = "BACK-1";
/** Display names only; `--owner` of a transfer is never output, not even by an error document. */
const OWNER = "agent-sentinel-karl";
const RECEIVER = "agent-sentinel-franz";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; the other instants derive from it. */
const T = 1_800_000_000_000;
const GRACE = 10 * MINUTE;
/** Lease end "10:05", its reclaim boundary "10:15" and a hard end "10:20". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 20 * MINUTE;
/** The injected monotonic clock never moves, so no budget ever runs out. */
const MONO_START = 5_000;
const OP = "op-7c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a45";
/** A context ID nothing creates. */
// adapted from claim-execution-administration.test.ts:102
const MISSING_CONTEXT = "00000000-0000-4000-8000-000000000000";
/**
 * Relative on purpose: the preflight refuses it at its option check as `invalid` (config/index.ts:478), before the
 * resolver, the Git repository check (a `Bun.spawn`, git/operations.ts:1264-1276) and any context load.
 */
const PROJECT_ROOT = `project-${SENTINEL}`;
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** Stands for the random context ID a `claim-context` document prints. */
const CONTEXT_ID = "<context id>";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Placeholder for a guide row or a context that does not exist; never equals a status or an ID. */
// adapted from claim-execution-retry.test.ts:82
const NO_ROW = "(no row)";

// Level P inputs (adapted from claim-surface-administration.test.ts:121-142): upstream reasons, roots, bindings, paths
// and endpoints carry sentinels, now with the `--to-context` path and both owner names.
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const RESUMED = `tb1-${"9d".repeat(32)}`;
const ROOT = "a1".repeat(20);
const SECRET = `secret-${SENTINEL}`;
const CONTEXT_PATH = `/tmp/contexts-${SENTINEL}/context-1`;
const TARGET_PATH = `/tmp/contexts-${SENTINEL}/context-2`;
const ENDPOINT = `http://127.0.0.1:9/${SENTINEL}/claims.git`;
const REASON = `upstream ${SENTINEL} ${KARL} ${FRANZ} ${RESUMED} ${ROOT}`;
const SENSITIVE = [SENTINEL, KARL, FRANZ, RESUMED, ROOT, SECRET, CONTEXT_PATH, TARGET_PATH, ENDPOINT, OWNER, RECEIVER];
/** Fields a spread of an upstream object would leak (builders set every field one by one). */
const TAINT = {
	binding: KARL,
	targetBinding: FRANZ,
	recoveryBinding: RESUMED,
	owner: RECEIVER,
	secret: SECRET,
	contextDirectory: CONTEXT_PATH,
	targetContextDirectory: TARGET_PATH,
	remote: ENDPOINT,
};
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
/**
 * The closed base code list, copied verbatim from claim-surface.test.ts:145-157, never retyped; plus the four
 * additive names of claim next and batch reclaim, copied from its line 159;
 * plus the three codes of the emergency release.
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
	dependency-blocked dependency-unknown tasks-unavailable scope-required
	authority-required expectation-required isolation-unconfirmed
`
	.trim()
	.split(/\s+/);
/** The four additive codes, their status and the command that raises them. ASSUMPTION(scaffold). */
const K7_CODES: readonly { code: ClaimErrorCode; status: string; command: AdministrationCommand }[] = [
	{ code: "target-context-invalid", status: "refused", command: "transfer" },
	{ code: "target-context-unavailable", status: "unavailable", command: "transfer" },
	{ code: "recovery-missing", status: "refused", command: "resume" },
	{ code: "bounds-required", status: "refused", command: "change-bounds" },
];
const K7_STATUSES: Record<string, string> = Object.fromEntries(K7_CODES.map(({ code, status }) => [code, status]));
const ADMINISTRATION_COMMANDS: readonly AdministrationCommand[] = ["transfer", "resume", "change-bounds"];
const NEW_CAUSES: readonly NewCause[] = ["time-box-required", "requires-time-path", "lease-required", "mode-change"];
/** The three values of the policy key. */
const POLICIES = ["require-explicit", "preserve", "restart"] as const;
const MODES: readonly Mode[] = ["lease", "hard", "none"];
/** The CLI-only guide lives next to the other CLI guides. */
const GUIDE_PATH = join(import.meta.dir, "..", "guidelines", "cli-instructions", "claims.md");
/** The literal heading of the reference section. */
const SECTION = "Transfer, resume and bound changes";
/** pcod-02: terms the claims guide carries once administration is in. */
const GUIDE_TERMS = [
	"claim transfer",
	"claim resume",
	"claim change-bounds",
	"--to-context",
	"--recover-from",
	"--time-box",
	"--mode",
	"--lease-end",
	"--grace-ms",
	"transfer_time_box",
	"require-explicit",
	"preserve",
	"restart",
	"time-box-required",
	"requires-time-path",
	"lease-required",
	"mode-change",
];
const CFG_ENDPOINT = "git://127.0.0.1:9/claims.git";
/** The three surface keys, valid, and the settings fields they yield. */
const SURFACE = ["  clock_uncertainty_ms: 2000", "  retry_pause_base_ms: 1000", "  retry_pause_max_ms: 5000"];
const SURFACE_SETTINGS: Body = { clockUncertaintyMs: 2_000, retryPauseBaseMs: 1_000, retryPauseMaxMs: 5_000 };
const LIFETIME_LINES: Record<Mode, readonly string[]> = {
	lease: ["  lease_ttl_ms: 300000", "  reclaim_grace_ms: 600000"],
	hard: ["  reclaim_grace_ms: 600000"],
	none: [],
};
const LIFETIMES: Record<Mode, Body> = {
	lease: { mode: "lease", leaseTtlMs: 300_000, reclaimGraceMs: 600_000 },
	hard: { mode: "hard", reclaimGraceMs: 600_000 },
	none: { mode: "none" },
};

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

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:108
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** ISO-8601 with zone of an epoch instant; formatting only, never the wall clock. */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// adapted from claim-surface.test.ts:203
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
// adapted from claim-surface.test.ts:221
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

// adapted from claim-surface-administration.test.ts:455, with the recorded action as a parameter
function operation(
	action: Operation["action"],
	storage: Operation["storage"],
	outcome: Operation["outcome"]["kind"],
	sends: number,
	rights: ClaimRightEvaluation,
): ClaimExecutionResult {
	const result: Operation = {
		kind: "operation",
		scope: "transition-execution-only",
		action,
		operationId: OP,
		storage: tainted(storage),
		outcome: { kind: outcome },
		rights: tainted(rights),
		sends,
	};
	return tainted(result);
}

// adapted from claim-surface.test.ts:260
function notPlanned(plan: NotPlanned["plan"], rights: ClaimRightEvaluation): ClaimExecutionResult {
	const result: NotPlanned = { kind: "not-planned", plan: tainted(plan), rights: tainted(rights) };
	return tainted(result);
}

// adapted from claim-surface.test.ts:270
function paused(pause: Paused["pause"], rights: ClaimRightEvaluation): ClaimExecutionResult {
	const result: Paused = { kind: "paused", pause: tainted(pause), rights: tainted(rights) };
	return tainted(result);
}

/** A claim-error document; every error in this file comes before an operation exists (operationId null). */
// adapted from claim-surface.test.ts:332, with the command first and without an operation ID
function errorBody(
	command: string,
	status: string,
	code: string,
	ticket: string | null = TICKET,
	extra: Body = {},
): Body {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status,
		command,
		code,
		message: MESSAGE,
		ticket,
		operationId: null,
		...extra,
	};
}

// adapted from claim-surface.test.ts:401, without the human view
function viewOf(label: string, doc: ClaimDocument): DocumentView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		body,
		echoed: echoes(JSON.stringify(doc)),
	};
}

// adapted from claim-surface.test.ts:414, without the human view
function expectedView(label: string, body: Body): DocumentView {
	return {
		label,
		exit: EXPECTED_EXIT[String(body.status)] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		body,
		echoed: 0,
	};
}

/** pcod-01: a fixed message is non-empty and names no path, no binding and no sentinel. */
function messageFlaws(doc: ClaimDocument): string[] {
	const message = field(doc, "message");
	if (typeof message !== "string" || message.trim() === "") return ["empty"];
	const flaws: string[] = [];
	if (message.includes("/")) flaws.push("path separator");
	if (message.includes("tb1-")) flaws.push("binding prefix");
	if (echoes(message) > 0) flaws.push("sentinel");
	return flaws;
}

// adapted from claim-surface.test.ts:507
function cells(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return [];
	return trimmed
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.replaceAll("`", "").trim());
}

/** Rows of every Markdown table whose first two header cells are `first` and `second`. */
// adapted from claim-surface.test.ts:517
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

/** A Markdown heading of any level whose text is `text`, compared case-insensitively. */
function headingIn(markdown: string, text: string): boolean {
	return markdown
		.split(/\r?\n/)
		.some((line) => /^#{1,6}\s/.test(line) && line.replace(/^#+/, "").trim().toLowerCase() === text.toLowerCase());
}

/** A complete claims block in `mode`; `extra` lines follow the nine configuration keys. */
// adapted from claim-surface.test.ts:481, with mode hard and the endpoint as parameters
function cfgBlock(mode: Mode, extra: readonly string[], endpoint = CFG_ENDPOINT): string {
	const head = ["claims:", "  enabled: true", `  endpoint: ${JSON.stringify(endpoint)}`, "  storage_format: blob"];
	const tail = ["  attempt_timeout_ms: 10000", "  attempts: 3", "  operation_budget_ms: 30000"];
	return [...head, `  lifetime_mode: ${mode}`, ...LIFETIME_LINES[mode], ...tail, ...extra].join("\n");
}

/** The settings literal of base cfg5-01 (claim-surface.test.ts:955-963) in `mode`, plus `extra` fields. */
function settingsOf(mode: Mode, extra: Body = {}): Body {
	return {
		enabled: true,
		endpoint: CFG_ENDPOINT,
		storageFormat: "blob",
		lifetime: LIFETIMES[mode],
		attemptTimeoutMs: 10_000,
		attempts: 3,
		operationBudgetMs: 30_000,
		...extra,
	};
}

// adapted from claim-surface.test.ts:498
function settingsView(label: string, yaml: string): SettingsView {
	const result = resolveClaimSettings(yaml);
	return { label, kind: result.kind, settings: result.kind === "configured" ? result.settings : null };
}

// adapted from claim-config.test.ts:116
function problem(key: string, code: string): ProblemView {
	return { key: `claims.${key}`, problem: code };
}

/** Kind, `{key, problem}` pairs and the keys whose message is empty, misses its key or echoes a raw value. */
// adapted from claim-config.test.ts:120 (viewOf)
function problemsView(label: string, yaml: string, values: readonly string[]): ProblemsView {
	const result = resolveClaimSettings(yaml);
	const problems: ClaimConfigProblem[] = result.kind === "config-invalid" ? result.problems : [];
	const sensitive = [SENTINEL, ...values].filter((value) => value !== "");
	return {
		label,
		kind: result.kind,
		problems: problems.map((entry) => ({ key: entry.key, problem: entry.problem })),
		faultyMessages: problems
			.filter(
				({ key, message }) =>
					message.trim() === "" || !message.includes(key) || sensitive.some((value) => message.includes(value)),
			)
			.map(({ key }) => key),
	};
}

/** One recorded seam entry: notes `<label> <first argument>` in `calls`, then does the real IO. */
// adapted from fixtures/claim-admission-probe.ts:192-199 (untyped forwarding of an overloaded fs function)
function recorded(calls: string[], label: string, real: unknown): SeamEntry {
	const forward = real as SeamEntry;
	return async (...args: unknown[]) => {
		calls.push(`${label} ${String(args[0])}`);
		return forward(...args);
	};
}

/** Context IO that records every call; the `lstat` of exactly `failLstatAt` fails with EIO, everything else is real. */
// adapted from claim-execution-administration.test.ts:864 (failingContextLstat) and :875 (recordingContextIO)
function contextSeam(calls: string[], failLstatAt?: string): ContextSeam {
	const realLstat = recorded(calls, "context.lstat", claimContextIO.lstat);
	const failingLstat = async (...args: unknown[]) => {
		if (failLstatAt !== undefined && String(args[0]) === failLstatAt) {
			calls.push(`context.lstat ${failLstatAt}`);
			throw Object.assign(new Error("injected context lstat failure"), { code: "EIO" });
		}
		return realLstat(...args);
	};
	const seam = {
		open: recorded(calls, "context.open", claimContextIO.open),
		lstat: failingLstat,
		mkdir: recorded(calls, "context.mkdir", claimContextIO.mkdir),
		link: recorded(calls, "context.link", claimContextIO.link),
		unlink: recorded(calls, "context.unlink", claimContextIO.unlink),
	};
	return seam as unknown as ContextSeam;
}

/** Journal IO that records every call and does the real IO; no call of this file may cause one. */
function journalSeam(calls: string[]): JournalSeam {
	const seam = {
		open: recorded(calls, "journal.open", claimJournalIO.open),
		lstat: recorded(calls, "journal.lstat", claimJournalIO.lstat),
		link: recorded(calls, "journal.link", claimJournalIO.link),
		unlink: recorded(calls, "journal.unlink", claimJournalIO.unlink),
		readdir: recorded(calls, "journal.readdir", claimJournalIO.readdir),
	};
	return seam as unknown as JournalSeam;
}

/**
 * The env of every surface call here: the relative PROJECT_ROOT, the fixed wall clock T, a monotonic clock that never
 * moves, and seams that note each call in `calls` (local ticket, clock, sleep, operation ID, context and journal IO).
 */
// adapted from claim-surface-administration.test.ts:263 (env)
function recordingEnv(calls: string[], claimsYaml: string | undefined, contextIO: ContextSeam): ClaimSurfaceEnv {
	return {
		projectRoot: PROJECT_ROOT,
		claimsYaml,
		taskPrefix: "BACK",
		findLocalTicket: (ticket: string) => {
			calls.push("findLocalTicket");
			const found: LocalTicket = { kind: "found", ticket };
			return Promise.resolve(found);
		},
		// The mandatory corpus seam as a spy; no row here reaches the acquire gate, so any call
		// shows up in `calls` and answers unavailable.
		loadLocalTickets: () => {
			calls.push("loadLocalTickets");
			const unavailable: LocalTickets = { kind: "unavailable" };
			return Promise.resolve(unavailable);
		},
		clock: () => {
			calls.push("clock");
			return T;
		},
		monotonicNow: () => MONO_START,
		random: () => 0.5,
		sleep: () => {
			calls.push("sleep");
			return Promise.resolve();
		},
		newOperationId: () => {
			calls.push("newOperationId");
			return OP;
		},
		contextIO,
		journalIO: journalSeam(calls),
	};
}

/** One mutating call on `ticket` from `context`; `options` holds only optional fields. */
function input(
	command: ClaimMutationInput["command"],
	options: Options,
	ticket = TICKET,
	context = CONTEXT_PATH,
): ClaimMutationInput {
	return { command, ticket, context, ...options };
}

/** A healthy transfer of TICKET from `context` to `toContext` for RECEIVER, nothing else. */
function transferInput(context: string, toContext: string): ClaimMutationInput {
	return { command: "transfer", ticket: TICKET, context, toContext, owner: RECEIVER };
}

function resumeInput(context: string): ClaimMutationInput {
	return { command: "resume", ticket: TICKET, context };
}

async function localView(label: string, row: { input: ClaimMutationInput; yaml?: string }): Promise<LocalView> {
	const calls: string[] = [];
	const doc = await runClaimMutation(row.input, recordingEnv(calls, row.yaml ?? LOCAL_YAML, contextSeam(calls)));
	return { ...viewOf(label, doc), calls };
}

function localExpected(label: string, body: Body): LocalView {
	return { ...expectedView(label, body), calls: [] };
}

/** Real contexts: the random context ID of a `claim-context` document is replaced by its shape. */
function contextView(label: string, doc: ClaimDocument, sentinels: readonly Sentinel[]): ContextView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	if (typeof body.contextId === "string" && UUID.test(body.contextId)) body.contextId = CONTEXT_ID;
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		body,
		echoed: echoedIn(JSON.stringify(doc), sentinels),
	};
}

function contextExpected(label: string, body: Body): ContextView {
	return {
		label,
		exit: EXPECTED_EXIT[String(body.status)] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		body,
		echoed: [],
	};
}

/** Seam calls other than the reads of a context load (lstat, open); the pre-check may cause no other. */
function otherCalls(calls: readonly string[]): string[] {
	return calls.filter((call) => !call.startsWith("context.lstat ") && !call.startsWith("context.open "));
}

/** What a created context holds, compared with `source`; the proof itself is never shown. */
function proofOf(handle: ContextHandle | undefined, source: ContextHandle): Body {
	if (handle === undefined) return { loaded: false };
	const { binding, recovery } = handle.context;
	let proof: string | null = null;
	if (recovery !== null) proof = recovery.binding === source.context.binding ? "binding of the source" : "other";
	return { loaded: true, proof, freshBinding: binding !== source.context.binding };
}

// adapted from claim-execution-administration.test.ts:336
function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

/** Type, mode, inode, size, mtime and content digest of `root` and everything below it. */
// adapted from claim-execution-administration.test.ts:345
async function snapshot(root: string) {
	const entries: { path: string; kind: string; mode: number; ino: number; size: number; mtimeMs: number }[] = [];
	const digests: Record<string, string> = {};
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		const kind = kindOf(info);
		const mode = info.mode & 0o7777;
		entries.push({ path: relative, kind, mode, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
		if (kind === "file")
			digests[relative] = createHash("sha256")
				.update(await readFile(path))
				.digest("hex");
		if (kind === "dir") {
			for (const name of (await readdir(path)).sort(byCodeUnits)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return { entries, digests };
}

/** The names in each handle's journal directory. */
async function journals(handles: readonly ContextHandle[]): Promise<Record<string, string[]>> {
	const listing: Record<string, string[]> = {};
	for (const handle of handles) {
		listing[handle.name] = (await readdir(handle.context.journalDirectory)).sort(byCodeUnits);
	}
	return listing;
}

function emptyJournals(handles: readonly ContextHandle[]): Record<string, string[]> {
	const listing: Record<string, string[]> = {};
	for (const handle of handles) listing[handle.name] = [];
	return listing;
}

/** cli-05 at level P, plus whether a line after the first names `flag` (the hint). */
// adapted from claim-surface.test.ts:372 (humanView)
function humanView(label: string, doc: ClaimDocument, flag: string | null): HumanView {
	const { stdout, stderr } = formatClaimDocumentText(doc);
	let stream = "mixed";
	if (stdout !== "" && stderr === "") stream = "stdout";
	if (stderr !== "" && stdout === "") stream = "stderr";
	const lines = (stream === "stderr" ? stderr : stdout).split("\n");
	const first = lines[0] ?? "";
	const colon = first.indexOf(":");
	const status = field(doc, "status");
	const code = field(doc, "code");
	const refusal = status === "refused" || status === "unavailable";
	return {
		label,
		stream,
		head: colon > 0 ? first.slice(0, colon) : null,
		codeShown: refusal && typeof code === "string" ? first.includes(code) : null,
		hint: flag === null ? null : lines.slice(1).some((line) => line.includes(flag)),
		echoed: echoes(stdout + stderr),
	};
}

// adapted from claim-surface.test.ts:391 (human)
function humanExpected(label: string, status: string, stream: string, flag: string | null): HumanView {
	const refusal = status === "refused" || status === "unavailable";
	return {
		label,
		stream,
		head: status,
		codeShown: refusal ? true : null,
		hint: flag === null ? null : true,
		echoed: 0,
	};
}

function errorDocument(command: AdministrationCommand, code: ClaimErrorCode): ClaimDocument {
	return claimErrorDocument({ command, code, ticket: TICKET });
}

function mapCommand(command: ClaimCommand, result: ClaimExecutionResult): ClaimDocument {
	return claimOperationDocument({ command, ticket: TICKET, result, planned: null, stoppedBy: null });
}

/** A plan rejection of an administration command: no operation ID, no record; `boundary` only if the plan has one. */
// adapted from claim-surface-administration.test.ts:528
function planRejectionBody(
	command: AdministrationCommand,
	cause: string,
	rights: ClaimRightEvaluation,
	boundary?: number,
): Body {
	const rejection: Body = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "rejected",
		command,
		action: command,
		ticket: TICKET,
		operationId: null,
		outcome: "rejected",
		rejection,
		storage: null,
		sends: 0,
		stoppedBy: null,
		planned: null,
		rights: publicRights(rights),
	};
}

/** The pause of an administration command; its action is the command. */
// adapted from claim-surface.test.ts:318
function pauseBody(command: AdministrationCommand, pause: Body, rights: ClaimRightEvaluation): Body {
	return {
		schemaVersion: 1,
		kind: "claim-pause",
		status: "paused",
		command,
		action: command,
		ticket: TICKET,
		operationId: null,
		pause,
		rights: publicRights(rights),
	};
}

// adapted from claim-surface-administration.test.ts:547
function keysOf(value: unknown): string[] | null {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : null;
}

// adapted from claim-surface-administration.test.ts:552
function mappedView(label: string, doc: ClaimDocument): MappedView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		rejectionKeys: keysOf(field(doc, "rejection")),
		body,
		echoed: echoes(JSON.stringify(doc)),
	};
}

// adapted from claim-surface-administration.test.ts:566
function mappedExpected(label: string, body: Body): MappedView {
	return {
		label,
		exit: EXPECTED_EXIT[String(body.status)] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		rejectionKeys: keysOf(body.rejection),
		body,
		echoed: 0,
	};
}

/** Private temp parents for the contexts, their byte copies and the contexts pctx-01 creates. */
// adapted from claim-surface-administration.test.ts:190 (SurfaceCase), without Git
class ContextCase {
	readonly root: string;
	/** Private 0700 parents, each with the sentinel in its name. */
	readonly parent: string;
	readonly copies: string;
	readonly fresh: string;

	private constructor(root: string) {
		this.root = root;
		this.parent = join(root, `contexts-${SENTINEL}`);
		this.copies = join(root, `copies-${SENTINEL}`);
		this.fresh = join(root, `fresh-${SENTINEL}`);
	}

	static async create(): Promise<ContextCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-administration-commands-${SENTINEL}-`));
		const fixture = new ContextCase(root);
		try {
			for (const directory of [fixture.parent, fixture.copies, fixture.fresh]) {
				await mkdir(directory);
				await chmod(directory, 0o700);
			}
			return fixture;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** A context through the API below the private parent, optionally recovering from `recoverFrom`. */
	// adapted from claim-execution-administration.test.ts:1169
	async context(name: string, recoverFrom?: string): Promise<ContextHandle> {
		const created = await createClaimContext(
			recoverFrom === undefined ? { parent: this.parent } : { parent: this.parent, recoverFrom },
		);
		if (created.kind !== "created") throw new Error(`fixture: context ${name} was not created (${created.kind})`);
		return { name, context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** A context whose record is no longer private, which the loader reports as corrupt (context/index.ts:80-86). */
	async broken(name: string): Promise<ContextHandle> {
		const handle = await this.context(name);
		await chmod(join(handle.directory, "context.json"), 0o644);
		return handle;
	}

	/** A byte copy of `handle` below the second private parent: same base name, same modes, same binding. */
	async copy(handle: ContextHandle, name: string): Promise<ContextHandle> {
		const directory = join(this.copies, handle.context.contextId);
		const journal = join(directory, "journal");
		const record = join(directory, "context.json");
		await mkdir(directory);
		await chmod(directory, 0o700);
		await mkdir(journal);
		await chmod(journal, 0o700);
		await writeFile(record, await readFile(join(handle.directory, "context.json")));
		await chmod(record, 0o600);
		const loaded = await loadClaimContext({ directory });
		if (loaded.kind !== "loaded") throw new Error(`fixture: the byte copy does not load (${loaded.kind})`);
		return { name, context: loaded.context, directory };
	}

	/** The context a `claim-context` document names below `parent`, or undefined when it names none that loads. */
	// adapted from claim-cli.test.ts:1019 (adopt)
	async adopt(name: string, parent: string, doc: ClaimDocument): Promise<ContextHandle | undefined> {
		const contextId = field(doc, "contextId");
		if (typeof contextId !== "string" || !UUID.test(contextId)) return undefined;
		const directory = join(parent, contextId);
		const loaded = await loadClaimContext({ directory });
		return loaded.kind === "loaded" ? { name, context: loaded.context, directory } : undefined;
	}

	/** Reads the private secret directly; only tests may do this, and only to prove it is never echoed. */
	// adapted from claim-execution-administration.test.ts:1179 (secretOf)
	private async secretOf(handle: ContextHandle): Promise<string> {
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		return String(field(record, "secret"));
	}

	/**
	 * Values no document may contain: the root, the parents, both owner names and every handle's
	 * path, binding, recovery binding, secret and context ID; `printedIds` are the IDs `claim-context` may print.
	 */
	// adapted from claim-surface-administration.test.ts:333 (sentinels)
	async sentinels(handles: readonly ContextHandle[], printedIds: readonly string[] = []): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["root", this.root],
			["owner", OWNER],
			["receiver", RECEIVER],
		];
		for (const directory of [this.parent, this.copies, this.fresh]) found.push(["parent", directory]);
		for (const handle of handles) {
			const { name, context } = handle;
			found.push([`path ${name}`, handle.directory], [`binding ${name}`, context.binding]);
			found.push([`secret ${name}`, await this.secretOf(handle)]);
			if (!printedIds.includes(context.contextId)) found.push([`context id ${name}`, context.contextId]);
			if (context.recovery !== null) found.push([`recovery binding ${name}`, context.recovery.binding]);
		}
		return found;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-surface-administration.test.ts:371
async function withContexts(body: (fixture: ContextCase) => Promise<void>): Promise<void> {
	const fixture = await ContextCase.create();
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

const LOCAL_YAML = cfgBlock("lease", SURFACE, ENDPOINT);
const KEEP_YAML = cfgBlock("lease", [...SURFACE, "  transfer_time_box: keep"], ENDPOINT);
const BARE_YAML = cfgBlock("lease", [], ENDPOINT);
const MISSING_SURFACE: ProblemView[] = [
	problem("clock_uncertainty_ms", "missing"),
	problem("retry_pause_base_ms", "missing"),
	problem("retry_pause_max_ms", "missing"),
];
const TRANSFER: Options = { toContext: TARGET_PATH, owner: RECEIVER };
const LEASE_BOUNDS: Options = { mode: "lease", leaseEnd: iso(L), hardEnd: iso(H), graceMs: GRACE };
const HARD_BOUNDS: Options = { mode: "hard", hardEnd: iso(H), graceMs: GRACE };
const HELD = evaluated("held", { kind: "live", renewalDue: false }, { kind: "not-yet", boundary: R });
/** The source's view after its transfer applied: foreign at the successor's generation. */
const SOURCE_AFTER_TRANSFER = evaluated(
	"foreign",
	{ kind: "none", cause: "not-holder" },
	{ kind: "not-yet", boundary: R },
	4,
);

const SETTINGS_ROWS: SettingsRow[] = [
	...MODES.flatMap((mode) =>
		POLICIES.map(
			(policy): SettingsRow => ({
				label: `${policy} in lifetime mode ${mode}`,
				catches: "a mode gate like DP-4 (not-applicable); the value mapped, renamed or dropped",
				yaml: cfgBlock(mode, [...SURFACE, `  transfer_time_box: ${policy}`]),
				settings: settingsOf(mode, { ...SURFACE_SETTINGS, transferTimeBox: policy }),
			}),
		),
	),
	{
		label: "quoted value",
		catches: "a quoted YAML string read as wrong-type",
		yaml: cfgBlock("hard", [...SURFACE, '  transfer_time_box: "restart"']),
		settings: settingsOf("hard", { ...SURFACE_SETTINGS, transferTimeBox: "restart" }),
	},
	{
		label: "key absent, surface keys present",
		catches: "transferTimeBox always set, even as undefined (breaks toStrictEqual pins of config/base CLI); a default",
		yaml: cfgBlock("lease", SURFACE),
		settings: settingsOf("lease", SURFACE_SETTINGS),
	},
	{
		label: "no optional key at all",
		catches: "require-explicit or another value substituted by the resolver",
		yaml: cfgBlock("none", []),
		settings: settingsOf("none"),
	},
];

/** `transfer_time_box` with the raw YAML text `raw`, or without a value for an empty `raw`. */
function policyLine(raw: string): string {
	return raw === "" ? "  transfer_time_box:" : `  transfer_time_box: ${raw}`;
}

/** Full validation when named, complete schema-ordered problems, no raw value in a message. */
const PROBLEM_ROWS: ProblemRow[] = [
	{
		label: "key without a value",
		catches: "an empty key read as require-explicit, a silent default",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("")]),
		values: [],
		problems: [problem("transfer_time_box", "missing")],
	},
	{
		label: "number",
		catches: "a number coerced to a string",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("42")]),
		values: ["42"],
		problems: [problem("transfer_time_box", "wrong-type")],
	},
	{
		label: "boolean",
		catches: "true read as preserve",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("true")]),
		values: ["true"],
		problems: [problem("transfer_time_box", "wrong-type")],
	},
	{
		label: "sequence",
		catches: "a list read as its first element",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("[]")]),
		values: ["[]"],
		problems: [problem("transfer_time_box", "wrong-type")],
	},
	{
		label: "unknown value keep",
		catches: "a lax value range",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("keep")]),
		values: ["keep"],
		problems: [problem("transfer_time_box", "unsupported-value")],
	},
	{
		label: "value in another case",
		catches: "case folded",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("Preserve")]),
		values: ["Preserve"],
		problems: [problem("transfer_time_box", "unsupported-value")],
	},
	{
		label: "empty string",
		catches: "an empty string read as absent, hence require-explicit",
		yaml: cfgBlock("lease", [...SURFACE, policyLine('""')]),
		values: [],
		problems: [problem("transfer_time_box", "unsupported-value")],
	},
	{
		label: "value with a sentinel",
		catches: "the raw value echoed in the message",
		yaml: cfgBlock("lease", [...SURFACE, policyLine(JSON.stringify(`preserve ${SENTINEL}`))]),
		values: [],
		problems: [problem("transfer_time_box", "unsupported-value")],
	},
	{
		label: "named twice",
		catches: "the last value wins",
		yaml: cfgBlock("lease", [...SURFACE, policyLine("preserve"), policyLine("restart")]),
		values: ["preserve", "restart"],
		problems: [problem("transfer_time_box", "duplicate")],
	},
	{
		label: "unknown value in lifetime mode none",
		catches: "the key skipped or not-applicable outside lease (valid in every mode)",
		yaml: cfgBlock("none", [...SURFACE, policyLine("keep")]),
		values: ["keep"],
		problems: [problem("transfer_time_box", "unsupported-value")],
	},
	{
		// The resolver's own order — per-key problems in SCHEMA_KEYS order (config/index.ts:314-400) with
		// transfer_time_box appended last, then the cross-key pause rule (:402-413), then unknown keys (:415-419).
		label: "schema order with the pause rule and an unknown key",
		catches: "problems in document order; the policy key after the pause rule or after the unknown keys",
		yaml: cfgBlock("lease", [
			"  transfer_time_box_action: preserve",
			policyLine("keep"),
			"  clock_uncertainty_ms: 2000",
			"  retry_pause_base_ms: 3000",
			"  retry_pause_max_ms: 2000",
		]),
		values: ["keep"],
		problems: [
			problem("transfer_time_box", "unsupported-value"),
			problem("retry_pause_max_ms", "out-of-range"),
			problem("transfer_time_box_action", "unknown-key"),
		],
	},
];

/** After the positive control; no row reaches the pre-check, so no seam is ever touched. */
const LOCAL_ROWS: LocalRow[] = [
	{
		label: "transfer without --to-context",
		catches: "a target taken from a default, the environment or the only other context",
		input: input("transfer", { owner: RECEIVER }),
		expected: errorBody("transfer", "refused", "target-context-invalid"),
	},
	{
		label: "empty --to-context",
		catches: "an empty target treated as absent and then derived",
		input: input("transfer", { toContext: "", owner: RECEIVER }),
		expected: errorBody("transfer", "refused", "target-context-invalid"),
	},
	{
		label: "relative --to-context",
		catches: "a target resolved against the working directory",
		input: input("transfer", { toContext: `contexts-${SENTINEL}/peer`, owner: RECEIVER }),
		expected: errorBody("transfer", "refused", "target-context-invalid"),
	},
	{
		label: "--to-context with NUL",
		catches: "a target path cut at NUL",
		input: input("transfer", { toContext: `${TARGET_PATH}\0peer`, owner: RECEIVER }),
		expected: errorBody("transfer", "refused", "target-context-invalid"),
	},
	{
		label: "transfer without --owner",
		catches: "the owner kept from the source or derived from the target",
		input: input("transfer", { toContext: TARGET_PATH }),
		expected: errorBody("transfer", "refused", "owner-required"),
	},
	{
		label: "blank --owner",
		catches: "a blank display name accepted",
		input: input("transfer", { toContext: TARGET_PATH, owner: "  " }),
		expected: errorBody("transfer", "refused", "owner-required"),
	},
	{
		label: "--ttl-ms 0 on transfer",
		catches: "a zero lease accepted",
		input: input("transfer", { ...TRANSFER, ttlMs: 0 }),
		expected: errorBody("transfer", "refused", "invalid-option"),
	},
	{
		label: "--expect-generation 0 on resume",
		catches: "generation 0 accepted",
		input: input("resume", { expectGeneration: 0 }),
		expected: errorBody("resume", "refused", "invalid-option"),
	},
	{
		label: "--grace-ms NaN",
		catches: "a non-number grace accepted (commands/claim.ts:96-100 turns every non-digit value into NaN)",
		input: input("change-bounds", { ...LEASE_BOUNDS, graceMs: Number.NaN }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--grace-ms -1",
		catches: "a negative grace accepted",
		input: input("change-bounds", { ...LEASE_BOUNDS, graceMs: -1 }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--grace-ms 1.5",
		catches: "a fractional grace accepted",
		input: input("change-bounds", { ...LEASE_BOUNDS, graceMs: 1.5 }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--lease-end without a zone",
		catches: "a zone-less instant read as local time",
		input: input("change-bounds", { ...LEASE_BOUNDS, leaseEnd: "2027-01-15T08:05:00" }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--lease-end tomorrow",
		catches: "a second, lax time parser",
		input: input("change-bounds", { ...LEASE_BOUNDS, leaseEnd: "tomorrow" }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--time-box keep",
		catches: "a lax time-box vocabulary",
		input: input("transfer", { ...TRANSFER, timeBox: "keep" }),
		expected: errorBody("transfer", "refused", "invalid-option"),
	},
	{
		label: "--time-box Preserve",
		catches: "the time-box value folded to lower case",
		input: input("transfer", { ...TRANSFER, timeBox: "Preserve" }),
		expected: errorBody("transfer", "refused", "invalid-option"),
	},
	{
		label: "--mode soft",
		catches: "an unknown mode read as none",
		input: input("change-bounds", { ...LEASE_BOUNDS, mode: "soft" }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "renew with --to-context",
		catches: "an administration field ignored on a base verb (MCP calls the core without Commander)",
		input: input("renew", { toContext: TARGET_PATH }),
		expected: errorBody("renew", "refused", "option-not-applicable"),
	},
	{
		label: "acquire with --time-box",
		catches: "a time-box action accepted outside transfer",
		input: input("acquire", { owner: OWNER, timeBox: "preserve" }),
		expected: errorBody("acquire", "refused", "option-not-applicable"),
	},
	{
		label: "release with --mode",
		catches: "a bound change smuggled into release",
		input: input("release", { mode: "lease" }),
		expected: errorBody("release", "refused", "option-not-applicable"),
	},
	{
		label: "reclaim with --grace-ms",
		catches: "a grace accepted and ignored by reclaim",
		input: input("reclaim", { graceMs: GRACE }),
		expected: errorBody("reclaim", "refused", "option-not-applicable"),
	},
	{
		label: "resume with --ttl-ms",
		catches: "a lease window renewed by resume",
		input: input("resume", { ttlMs: 60_000 }),
		expected: errorBody("resume", "refused", "option-not-applicable"),
	},
	{
		label: "resume with --hard-end",
		catches: "a hard end changed by resume",
		input: input("resume", { hardEnd: iso(H) }),
		expected: errorBody("resume", "refused", "option-not-applicable"),
	},
	{
		label: "resume with --owner",
		catches: "an owner change through resume",
		input: input("resume", { owner: RECEIVER }),
		expected: errorBody("resume", "refused", "option-not-applicable"),
	},
	{
		label: "resume with --to-context",
		catches: "resume read as a transfer",
		input: input("resume", { toContext: TARGET_PATH }),
		expected: errorBody("resume", "refused", "option-not-applicable"),
	},
	{
		label: "transfer with --mode",
		catches: "a bound change riding on a transfer",
		input: input("transfer", { ...TRANSFER, mode: "lease" }),
		expected: errorBody("transfer", "refused", "option-not-applicable"),
	},
	{
		label: "transfer with --grace-ms",
		catches: "a grace accepted and ignored by transfer",
		input: input("transfer", { ...TRANSFER, graceMs: GRACE }),
		expected: errorBody("transfer", "refused", "option-not-applicable"),
	},
	{
		label: "transfer with --hard-end",
		catches: "a hard end accepted and ignored by transfer, which keeps or refuses H",
		input: input("transfer", { ...TRANSFER, hardEnd: iso(H) }),
		expected: errorBody("transfer", "refused", "option-not-applicable"),
	},
	{
		label: "change-bounds with --owner",
		catches: "an owner change through change-bounds",
		input: input("change-bounds", { ...LEASE_BOUNDS, owner: RECEIVER }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "change-bounds with --ttl-ms",
		catches: "a relative lease length mixed into an absolute target",
		input: input("change-bounds", { ...LEASE_BOUNDS, ttlMs: 60_000 }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "change-bounds with --time-box",
		catches: "a time-box action accepted outside transfer",
		input: input("change-bounds", { ...LEASE_BOUNDS, timeBox: "preserve" }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "mode hard with --lease-end",
		catches: "a lease end kept on a hard target",
		input: input("change-bounds", { ...HARD_BOUNDS, leaseEnd: iso(L) }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "mode none with --grace-ms",
		catches: "a grace kept on a target without time limit",
		input: input("change-bounds", { mode: "none", graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "mode none with --hard-end",
		catches: "a hard end kept on a target without time limit",
		input: input("change-bounds", { mode: "none", hardEnd: iso(H) }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "change-bounds without --mode",
		catches: "the mode taken from the stored claim, the configuration or the flags",
		input: input("change-bounds", {}),
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "mode lease without --lease-end",
		catches: "the lease end filled from the stored claim",
		input: input("change-bounds", { mode: "lease", hardEnd: iso(H), graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "mode lease without --grace-ms",
		catches: "the grace filled from reclaim_grace_ms (nothing from configuration)",
		input: input("change-bounds", { mode: "lease", leaseEnd: iso(L), hardEnd: iso(H) }),
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "mode hard without --hard-end",
		catches: "the hard end filled from the stored claim",
		input: input("change-bounds", { mode: "hard", graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "mode hard without --grace-ms",
		catches: "--grace-ms required in mode lease only",
		input: input("change-bounds", { mode: "hard", hardEnd: iso(H) }),
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "mode lease without --hard-end passes locally",
		catches: "a missing hard end refused locally or filled in (hardEnd null, the planner decides)",
		input: input("change-bounds", { mode: "lease", leaseEnd: iso(L), graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "preflight-invalid"),
	},
	{
		label: "complete hard target passes locally",
		catches: "a hard target refused by a lease-only check",
		input: input("change-bounds", HARD_BOUNDS),
		expected: errorBody("change-bounds", "refused", "preflight-invalid"),
	},
	{
		label: "mode none passes locally",
		catches: "--grace-ms or an end required in mode none",
		input: input("change-bounds", { mode: "none" }),
		expected: errorBody("change-bounds", "refused", "preflight-invalid"),
	},
	{
		label: "lease end after the hard end",
		catches: "a timing isClaimTiming refuses sent on to the planner",
		input: input("change-bounds", { mode: "lease", leaseEnd: iso(H + MINUTE), hardEnd: iso(H), graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "lease end plus grace overflows",
		catches: "an overflowing L + g accepted (rights/index.ts:138-151)",
		input: input("change-bounds", { ...LEASE_BOUNDS, graceMs: Number.MAX_SAFE_INTEGER }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "policy key with an unknown value",
		catches: "the policy key unvalidated on the surface path",
		input: input("transfer", TRANSFER),
		yaml: KEEP_YAML,
		expected: errorBody("transfer", "refused", "config-invalid", TICKET, {
			problems: [problem("transfer_time_box", "unsupported-value")],
		}),
	},
	{
		label: "resume without the surface keys",
		catches: "resume exempt from the surface keys",
		input: input("resume", {}),
		yaml: BARE_YAML,
		expected: errorBody("resume", "refused", "config-invalid", TICKET, { problems: MISSING_SURFACE }),
	},
	{
		label: "invalid operation ID on change-bounds",
		catches: "the new commands outside the base operation ID rule",
		input: input("change-bounds", { ...LEASE_BOUNDS, operationId: "bad id" }),
		expected: errorBody("change-bounds", "refused", "invalid-operation-id"),
	},
	{
		label: "resume with an empty --context",
		catches: "the own handle derived for resume",
		input: input("resume", {}, TICKET, ""),
		expected: errorBody("resume", "refused", "context-required"),
	},
	{
		label: "release with --owner stays lenient",
		catches: "applied to a base field on a base verb, a behaviour change to the base commands",
		input: input("release", { owner: OWNER }),
		expected: errorBody("release", "refused", "preflight-invalid"),
	},
	{
		label: "invalid ticket before a missing --to-context",
		catches: "the target checked before the ticket",
		input: input("transfer", { owner: RECEIVER }, "not a ticket"),
		expected: errorBody("transfer", "refused", "invalid-ticket", null),
	},
	{
		label: "missing --owner before a relative --to-context",
		catches: "the target checked before the owner",
		input: input("transfer", { toContext: "peer" }),
		expected: errorBody("transfer", "refused", "owner-required"),
	},
	{
		label: "relative --context before a relative --to-context",
		catches: "the target checked before the own handle",
		input: input("transfer", { toContext: "peer", owner: RECEIVER }, TICKET, `contexts-${SENTINEL}/own`),
		expected: errorBody("transfer", "refused", "context-invalid"),
	},
	{
		label: "relative --to-context before an invalid operation ID",
		catches: "the operation ID checked before the target",
		input: input("transfer", { toContext: "peer", owner: RECEIVER, operationId: "bad id" }),
		expected: errorBody("transfer", "refused", "target-context-invalid"),
	},
	{
		label: "zone-less --lease-end before a missing --mode",
		catches: "completeness checked before the instants",
		input: input("change-bounds", { leaseEnd: "2027-01-15T08:05:00", graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "invalid-option"),
	},
	{
		label: "--time-box keep before a foreign --mode",
		catches: "foreign fields checked before the values",
		input: input("transfer", { ...TRANSFER, timeBox: "keep", mode: "lease" }),
		expected: errorBody("transfer", "refused", "invalid-option"),
	},
	{
		label: "foreign --lease-end before a missing --hard-end",
		catches: "completeness checked before foreign fields",
		input: input("change-bounds", { mode: "hard", leaseEnd: iso(L), graceMs: GRACE }),
		expected: errorBody("change-bounds", "refused", "option-not-applicable"),
	},
	{
		label: "missing --mode before an invalid policy key",
		catches: "the configuration read before the bounds check",
		input: input("change-bounds", {}),
		yaml: KEEP_YAML,
		expected: errorBody("change-bounds", "refused", "bounds-required"),
	},
	{
		label: "missing surface keys before a lease end after the hard end",
		catches: "the timing check before the configuration",
		input: input("change-bounds", { mode: "lease", leaseEnd: iso(H + MINUTE), hardEnd: iso(H), graceMs: GRACE }),
		yaml: BARE_YAML,
		expected: errorBody("change-bounds", "refused", "config-invalid", TICKET, { problems: MISSING_SURFACE }),
	},
];

describe("error codes and the claims guide (pure)", () => {
	test("pcod-01: the code list is the base list plus exactly the four administration codes, with statuses", () => {
		// Scanner positive control: a planted owner name is counted.
		expect(echoes(`planted ${RECEIVER}`)).toBe(1);
		// Positive control (catches: a scaffold or GREEN without the administration codes).
		expect(CLAIM_ERROR_CODES["bounds-required"]).toBe("refused");
		const codes: Record<string, string> = { ...CLAIM_ERROR_CODES };
		const added = Object.fromEntries(K7_CODES.map(({ code }) => [code, codes[code] ?? NO_ROW]));
		// catches: a code missing or added beyond the four administration codes ("plus nothing else" amended by exactly
		// four); a status swapped (target-context-unavailable is the only unavailable one); a status outside the closed
		// status table.
		expect({
			codes: Object.keys(codes).sort(byCodeUnits),
			added,
			unknownStatuses: Object.values(codes).filter((status) => !(status in EXPECTED_EXIT)),
		}).toEqual({
			codes: [...PLAN_ERROR_CODES, ...Object.keys(K7_STATUSES)].sort(byCodeUnits),
			added: K7_STATUSES,
			unknownStatuses: [],
		});
		// catches: a code without a fixed message; a message with a path, a binding or a sentinel.
		const views = K7_CODES.map(
			({ code, command }): CodeView => ({
				...viewOf(`${code} document`, errorDocument(command, code)),
				messageFlaws: messageFlaws(errorDocument(command, code)),
			}),
		);
		expect(views).toEqual(
			K7_CODES.map(
				({ code, status, command }): CodeView => ({
					...expectedView(`${code} document`, errorBody(command, status, code)),
					messageFlaws: [],
				}),
			),
		);
	});

	test("pcod-02: the guide names the commands, --recover-from, the policy key, the causes and the codes", async () => {
		const guide = await readFile(GUIDE_PATH, "utf8");
		// Positive control (catches: a guide without the new commands).
		expect(guide.includes("claim transfer")).toBe(true);
		const table: Record<string, string> = Object.fromEntries(
			tableRows(guide, "code", "status").map(([code = "", status = ""]) => [code, status]),
		);
		const rows = Object.fromEntries(K7_CODES.map(({ code }) => [code, table[code] ?? NO_ROW]));
		// catches: a code row missing or with another status (base doc-02 pins the whole table in both directions); a
		// term missing; the reference section missing.
		expect({
			rows,
			missing: GUIDE_TERMS.filter((term) => !guide.includes(term)),
			section: headingIn(guide, SECTION),
		}).toEqual({ rows: K7_STATUSES, missing: [], section: true });
	});
});

describe("claims.transfer_time_box in the preflight resolver (pure)", () => {
	test("pcfg-01: the policy key is optional, taken as written in every lifetime mode and never defaulted", async () => {
		// Positive control (catches: the key reported as unknown-key, the scaffold's resolver).
		const controlLabel = "pcfg-01 positive control";
		const control = settingsView(controlLabel, cfgBlock("lease", [...SURFACE, policyLine("preserve")]));
		const controlSettings = settingsOf("lease", { ...SURFACE_SETTINGS, transferTimeBox: "preserve" });
		expect(control).toStrictEqual({ label: controlLabel, kind: "configured", settings: controlSettings });
		for (const row of SETTINGS_ROWS) {
			const label = `pcfg-01 ${row.label} (catches: ${row.catches})`;
			expect(settingsView(label, row.yaml)).toStrictEqual({ label, kind: "configured", settings: row.settings });
		}
		// Not in the setup template; its twelve keys stay (base claim-cli.test.ts pins the `keys` list).
		const written: string[] = [];
		const calls: string[] = [];
		const setupEnv: ClaimSurfaceEnv = {
			...recordingEnv(calls, undefined, contextSeam(calls)),
			writeClaimsYaml: async (yaml: string) => {
				written.push(yaml);
				return "written" as const;
			},
		};
		const setupInput = { endpoint: CFG_ENDPOINT, storageFormat: "blob", clockUncertaintyMs: 2_000 };
		const setup = await runClaimSetup(setupInput, setupEnv);
		const keys = field(setup, "keys");
		const keyList: unknown[] = Array.isArray(keys) ? keys : [];
		// catches: the policy key written into the template or listed in `keys`, which changes the base setup output.
		expect({
			kind: setup.kind,
			keyCount: keyList.length,
			policyKey: keyList.includes("transfer_time_box"),
			templates: written.map((yaml) => yaml.includes("transfer_time_box")),
		}).toEqual({ kind: "claim-setup", keyCount: 12, policyKey: false, templates: [false] });
	});

	test("pcfg-02: a named policy key is validated fully, in schema order, without echoing its value", () => {
		// Positive control (catches: a valid value refused, the scaffold's unknown-key).
		const controlLabel = "pcfg-02 positive control";
		expect(problemsView(controlLabel, cfgBlock("lease", [...SURFACE, policyLine("restart")]), [])).toEqual({
			label: controlLabel,
			kind: "configured",
			problems: [],
			faultyMessages: [],
		});
		for (const row of PROBLEM_ROWS) {
			const label = `pcfg-02 ${row.label} (catches: ${row.catches})`;
			const expected: ProblemsView = { label, kind: "config-invalid", problems: row.problems, faultyMessages: [] };
			expect(problemsView(label, row.yaml, row.values)).toEqual(expected);
		}
	});
});

describe("local checks of the three commands before any IO (in process, recording seams)", () => {
	test("ploc-01: each check refuses before any IO in administration order, fills in or ignores nothing", async () => {
		// Positive control (catches: no change-bounds wiring; a local check that refuses a complete target; IO before the
		// preflight): a complete lease target passes every local check and ends at the preflight's option check.
		const controlLabel = "ploc-01 positive control";
		const control = await localView(controlLabel, { input: input("change-bounds", LEASE_BOUNDS) });
		const reached = errorBody("change-bounds", "refused", "preflight-invalid");
		expect(control).toEqual(localExpected(controlLabel, reached));
		for (const row of LOCAL_ROWS) {
			const label = `ploc-01 ${row.label} (catches: ${row.catches})`;
			expect(await localView(label, row)).toEqual(localExpected(label, row.expected));
		}
	});
});

describe("context pre-check and --recover-from over private temp contexts (in process)", () => {
	test(
		"ploc-02: the pre-check reports own and target context codes before the preflight and writes nothing",
		async () => {
			await withContexts(async (fixture) => {
				const source = await fixture.context("source");
				const target = await fixture.context("target");
				const recovery = await fixture.context("recovery", source.directory);
				const broken = await fixture.broken("broken");
				const copy = await fixture.copy(source, "copy");
				const missing = join(fixture.parent, MISSING_CONTEXT);
				const handles = [source, target, recovery, broken, copy];
				const sentinels = await fixture.sentinels(handles);
				// Scanner positive control: a planted binding of a handle is counted under its label.
				expect(echoedIn(`planted ${target.context.binding}`, sentinels)).toEqual(["binding target"]);
				// Setup (catches: rows that pass for the wrong reason): the copy loads under another path with the source's
				// binding, the recovery context holds the source's binding as its proof, the broken record is corrupt.
				expect({
					copy: copy.context.binding === source.context.binding && copy.directory !== source.directory,
					recovery: recovery.context.recovery?.binding === source.context.binding,
					broken: (await loadClaimContext({ directory: broken.directory })).kind,
					sourceRecovery: source.context.recovery,
				}).toEqual({ copy: true, recovery: true, broken: "corrupt", sourceRecovery: null });
				const before = await snapshot(fixture.root);

				// Positive control (catches: no transfer wiring; a pre-check outside env.contextIO; a local check that refuses
				// a healthy transfer): source to target passes every local check and the pre-check, which loads both contexts
				// through the seam, and ends at the preflight's option check.
				const controlLabel = "ploc-02 positive control";
				const controlCalls: string[] = [];
				const controlEnv = recordingEnv(controlCalls, LOCAL_YAML, contextSeam(controlCalls));
				const control = await runClaimMutation(transferInput(source.directory, target.directory), controlEnv);
				expect({
					document: contextView(controlLabel, control, sentinels),
					ownLoaded: controlCalls.includes(`context.lstat ${join(source.directory, "context.json")}`),
					targetLoaded: controlCalls.includes(`context.lstat ${join(target.directory, "context.json")}`),
					other: otherCalls(controlCalls),
				}).toEqual({
					document: contextExpected(controlLabel, errorBody("transfer", "refused", "preflight-invalid")),
					ownLoaded: true,
					targetLoaded: true,
					other: [],
				});

				// Own context first (CONTEXT_CODES), then recovery or target; `invalid`/`corrupt` of the target
				// and the own binding as target are target-context-invalid, `unavailable` is target-context-unavailable.
				const rows: ContextRow[] = [
					{
						label: "target missing",
						catches: "a missing target created, derived or reported with the own context's code",
						input: transferInput(source.directory, missing),
						expected: errorBody("transfer", "refused", "target-context-invalid"),
					},
					{
						label: "target record not private",
						catches: "a corrupt target reported as context-corrupt, the own context's code",
						input: transferInput(source.directory, broken.directory),
						expected: errorBody("transfer", "refused", "target-context-invalid"),
					},
					{
						label: "target lstat EIO",
						catches: "an IO failure read as an invalid target; a target load outside env.contextIO",
						input: transferInput(source.directory, target.directory),
						failLstatAt: join(target.directory, "context.json"),
						expected: errorBody("transfer", "unavailable", "target-context-unavailable"),
					},
					{
						label: "target is the own path",
						catches: "a self-transfer planned",
						input: transferInput(source.directory, source.directory),
						expected: errorBody("transfer", "refused", "target-context-invalid"),
					},
					{
						label: "target is a byte copy of the own context",
						catches: "a comparison by path only; the copy under another parent has the same binding",
						input: transferInput(source.directory, copy.directory),
						expected: errorBody("transfer", "refused", "target-context-invalid"),
					},
					{
						label: "own context corrupt, target healthy",
						catches: "the target checked before the own context",
						input: transferInput(broken.directory, target.directory),
						expected: errorBody("transfer", "refused", "context-corrupt"),
					},
					{
						label: "own context missing, target corrupt",
						catches: "the target's code reported for the own context",
						input: transferInput(missing, broken.directory),
						expected: errorBody("transfer", "refused", "context-invalid"),
					},
					{
						label: "own context lstat EIO, target healthy",
						catches: "an own IO failure reported as a target code or as refused",
						input: transferInput(source.directory, target.directory),
						failLstatAt: join(source.directory, "context.json"),
						expected: errorBody("transfer", "unavailable", "context-unavailable"),
					},
					{
						label: "resume without a recovery proof",
						catches: "the recovery check left to the executor after the preflight's network round",
						input: resumeInput(source.directory),
						expected: errorBody("resume", "refused", "recovery-missing"),
					},
					{
						label: "resume in a corrupt context",
						catches: "recovery-missing reported before the own context check",
						input: resumeInput(broken.directory),
						expected: errorBody("resume", "refused", "context-corrupt"),
					},
					{
						label: "resume from a recovery context reaches the preflight",
						catches: "a resume refused although its context holds a proof; the surface reading the proof",
						input: resumeInput(recovery.directory),
						expected: errorBody("resume", "refused", "preflight-invalid"),
					},
				];
				for (const row of rows) {
					const label = `ploc-02 ${row.label} (catches: ${row.catches})`;
					const calls: string[] = [];
					const env = recordingEnv(calls, LOCAL_YAML, contextSeam(calls, row.failLstatAt));
					const document = await runClaimMutation(row.input, env);
					// catches: a write through the context seam, a journal opened, a clock or ID drawn before the preflight.
					expect({ document: contextView(label, document, sentinels), other: otherCalls(calls) }).toEqual({
						document: contextExpected(label, row.expected),
						other: [],
					});
				}

				// catches: the target, the copy or any context written; a journal opened or a record prepared by any call
				// (the target is read only).
				expect({ tree: await snapshot(fixture.root), journals: await journals(handles) }).toEqual({
					tree: before,
					journals: emptyJournals(handles),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"pctx-01: context create --recover-from stores the named context's proof and prints nothing of that context",
		async () => {
			await withContexts(async (fixture) => {
				const source = await fixture.context("source");
				const broken = await fixture.broken("broken");
				const missing = join(fixture.parent, MISSING_CONTEXT);
				const sourceBefore = await snapshot(source.directory);
				const create = (recoverFrom: string | undefined, failLstatAt?: string): Promise<ClaimDocument> => {
					const calls: string[] = [];
					const env = recordingEnv(calls, LOCAL_YAML, contextSeam(calls, failLstatAt));
					if (recoverFrom === undefined) return runClaimContextCreate({ parent: fixture.fresh }, env);
					// ASSUMPTION(scaffold): ClaimContextCreateInput.recoverFrom.
					return runClaimContextCreate({ parent: fixture.fresh, recoverFrom }, env);
				};

				// Positive control (catches: --recover-from not passed to createClaimContext; a replacement without the
				// proof; the source's path, binding, secret or context ID printed): a replacement context of the source.
				const controlLabel = "pctx-01 positive control";
				const replacementDoc = await create(source.directory);
				const replacement = await fixture.adopt("replacement", fixture.fresh, replacementDoc);
				const created: ContextHandle[] = replacement === undefined ? [] : [replacement];
				const printed = created.map((handle) => handle.context.contextId);
				const controlSentinels = await fixture.sentinels([source, broken, ...created], printed);
				const contextBody: Body = {
					schemaVersion: 1,
					kind: "claim-context",
					status: "ok",
					command: "context-create",
					contextId: CONTEXT_ID,
				};
				expect({
					document: contextView(controlLabel, replacementDoc, controlSentinels),
					context: proofOf(replacement, source),
				}).toEqual({
					document: contextExpected(controlLabel, contextBody),
					context: { loaded: true, proof: "binding of the source", freshBinding: true },
				});

				// catches: a recovery proof stored without --recover-from (base behaviour must stay).
				const plainLabel = "pctx-01 without --recover-from";
				const plainDoc = await create(undefined);
				const plain = await fixture.adopt("plain", fixture.fresh, plainDoc);
				if (plain !== undefined) created.push(plain);
				const sentinels = await fixture.sentinels(
					[source, broken, ...created],
					created.map((handle) => handle.context.contextId),
				);
				expect({ document: contextView(plainLabel, plainDoc, sentinels), context: proofOf(plain, source) }).toEqual({
					document: contextExpected(plainLabel, contextBody),
					context: { loaded: true, proof: null, freshBinding: true },
				});

				// Failures of --recover-from keep the context create codes (CONTEXT_CODES).
				const rows: RecoverRow[] = [
					{
						label: "relative --recover-from",
						catches: "a source resolved against the working directory",
						recoverFrom: `contexts-${SENTINEL}/source`,
						expected: errorBody("context-create", "refused", "context-invalid", null),
					},
					{
						label: "missing --recover-from context",
						catches: "a replacement without a proof when the source does not exist",
						recoverFrom: missing,
						expected: errorBody("context-create", "refused", "context-invalid", null),
					},
					{
						label: "corrupt --recover-from context",
						catches: "a proof taken from an unvalidated record",
						recoverFrom: broken.directory,
						expected: errorBody("context-create", "refused", "context-corrupt", null),
					},
					{
						label: "--recover-from lstat EIO",
						catches: "an IO failure of the source read as invalid; a source load outside env.contextIO",
						recoverFrom: source.directory,
						failLstatAt: join(source.directory, "context.json"),
						expected: errorBody("context-create", "unavailable", "context-unavailable", null),
					},
				];
				for (const row of rows) {
					const label = `pctx-01 ${row.label} (catches: ${row.catches})`;
					const document = await create(row.recoverFrom, row.failLstatAt);
					expect(contextView(label, document, sentinels)).toEqual(contextExpected(label, row.expected));
				}

				// catches: a context directory created before the source was checked; the source written or its journal
				// touched (nothing of the old context is imported or changed).
				expect({
					fresh: (await readdir(fixture.fresh)).sort(byCodeUnits),
					source: await snapshot(source.directory),
				}).toEqual({
					fresh: created.map((handle) => handle.context.contextId).sort(byCodeUnits),
					source: sourceBefore,
				});
			});
		},
		TEST_TIMEOUT,
	);
});

describe("human text and documents of the three commands (pure)", () => {
	test("ptxt-01: the new codes and plan causes carry a hint that names the flag to pass, on the right stream", () => {
		// Positive control (catches: no hint for target-context-invalid, the scaffold's formatter): stderr, head refused,
		// code first, and a line after the first names --to-context.
		const controlLabel = "ptxt-01 positive control";
		const control = humanView(controlLabel, errorDocument("transfer", "target-context-invalid"), "--to-context");
		expect(control).toEqual(humanExpected(controlLabel, "refused", "stderr", "--to-context"));
		const applied = operation("transfer", { kind: "applied", root: ROOT }, "applied", 1, SOURCE_AFTER_TRANSFER);
		const rows: HumanRow[] = [
			{
				label: "recovery-missing",
				catches: "no way to a replacement context named",
				doc: errorDocument("resume", "recovery-missing"),
				status: "refused",
				stream: "stderr",
				flag: "--recover-from",
			},
			{
				label: "bounds-required",
				catches: "no hint that the complete target is needed",
				doc: errorDocument("change-bounds", "bounds-required"),
				status: "refused",
				stream: "stderr",
				flag: "--mode",
			},
			{
				label: "target-context-unavailable",
				catches: "an unavailable target printed to stdout",
				doc: errorDocument("transfer", "target-context-unavailable"),
				status: "unavailable",
				stream: "stderr",
				flag: null,
			},
			{
				label: "applied transfer",
				catches: "a transfer text on stderr; the receiver's owner name or target path printed",
				doc: mapCommand("transfer", applied),
				status: "applied",
				stream: "stdout",
				flag: null,
			},
			{
				label: "transfer rejected time-box-required",
				catches: "no hint to --time-box or the policy key",
				doc: mapCommand("transfer", notPlanned({ kind: "rejected", cause: "time-box-required", reason: REASON }, HELD)),
				status: "rejected",
				stream: "stdout",
				flag: "--time-box",
			},
			{
				label: "transfer rejected lease-required",
				catches: "no hint to --ttl-ms",
				doc: mapCommand("transfer", notPlanned({ kind: "rejected", cause: "lease-required", reason: REASON }, HELD)),
				status: "rejected",
				stream: "stdout",
				flag: "--ttl-ms",
			},
		];
		expect(rows.map((row) => humanView(`${row.label} (catches: ${row.catches})`, row.doc, row.flag))).toEqual(
			rows.map((row) => humanExpected(`${row.label} (catches: ${row.catches})`, row.status, row.stream, row.flag)),
		);
	});

	test("pmap-01: plan rejections and pauses of the three commands keep command = action (characterization)", () => {
		// Positive control (catches: actionOfCommand without the administration commands, internal/1; a boundary invented).
		const controlLabel = "pmap-01 positive control";
		const control = mapCommand(
			"transfer",
			notPlanned({ kind: "rejected", cause: "time-box-required", reason: REASON }, HELD),
		);
		const controlBody = planRejectionBody("transfer", "time-box-required", HELD);
		expect(mappedView(controlLabel, control)).toEqual(mappedExpected(controlLabel, controlBody));
		const outstanding: Body = { kind: "outstanding", operationIds: [OP] };
		const rows: MapRow[] = [
			...ADMINISTRATION_COMMANDS.flatMap((command) =>
				NEW_CAUSES.map(
					(cause): MapRow => ({
						label: `${command} ${cause} (catches: the command's action lost, PLAN_CAUSES without the cause)`,
						command,
						result: notPlanned({ kind: "rejected", cause, reason: REASON }, HELD),
						expected: planRejectionBody(command, cause, HELD),
					}),
				),
			),
			{
				label: "transfer overlong (catches: the hard end dropped from a bounded transfer rejection)",
				command: "transfer",
				result: notPlanned({ kind: "rejected", cause: "overlong", reason: REASON, boundary: H }, HELD),
				expected: planRejectionBody("transfer", "overlong", HELD, H),
			},
			{
				label: "transfer hard-expired (catches: the hard end dropped from a bounded transfer rejection)",
				command: "transfer",
				result: notPlanned({ kind: "rejected", cause: "hard-expired", reason: REASON, boundary: H }, HELD),
				expected: planRejectionBody("transfer", "hard-expired", HELD, H),
			},
			...ADMINISTRATION_COMMANDS.map(
				(command): MapRow => ({
					label: `${command} paused (catches: an administration pause mapped to internal or to another action)`,
					command,
					result: paused({ kind: "outstanding", operationIds: [OP] }, HELD),
					expected: pauseBody(command, outstanding, HELD),
				}),
			),
		];
		expect(rows.map((row) => mappedView(row.label, mapCommand(row.command, row.result)))).toEqual(
			rows.map((row) => mappedExpected(row.label, row.expected)),
		);
	});
});
