/**
 * Level P: the seven claim tools over MCP, in process and before any network. Inventory, descriptions and schemas come
 * from `listTools`; the pure result builder runs for every status of CLAIM_EXIT_CODES; refusals go through
 * `testInterface.callTool` and must be document-equal to the `runClaim*` core with the same input and the same
 * `claimProjectEnv` seams; every argument passes raw, a non-string context and an unknown argument name are refused by
 * the tool, and no tool ever throws. No Git, no subprocess and no wall clock: the claims block names an endpoint that
 * no case reaches, and tripwire seams prove it. Positive controls run against the scaffold.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimExecutionResult } from "../claims/execution/index.ts";
import type { ClaimRightEvaluation } from "../claims/rights/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimCommand,
	type ClaimDocument,
	type ClaimErrorCode,
	type ClaimErrorDocument,
	type ClaimListDocument,
	type ClaimLocalTickets,
	type ClaimMutationCommand,
	type ClaimMutationInput,
	type ClaimStatus,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimOperationDocument,
	claimPreflightError,
	claimResolutionDocument,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import { Core } from "../core/backlog.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import { formatJson } from "../formatters/json-output.ts";
import { createMcpServer, McpServer } from "../mcp/server.ts";
import {
	CLAIM_TOOL_DESCRIPTIONS,
	CLAIM_TOOL_NAMES,
	type ClaimToolName,
	claimToolInput,
	claimToolResult,
	registerClaimTools,
} from "../mcp/tools/claims/index.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Body = Record<string, unknown>;
type ProjectKey = "lease" | "none" | "broken" | "hard";
type Fixture = { base: string; roots: Record<ProjectKey, string>; servers: Record<ProjectKey, McpServer> };
type CoreCall = (env: ClaimSurfaceEnv) => Promise<ClaimDocument>;
type Verdict = { status: ClaimStatus; code: ClaimErrorCode; ticket: string | null; operationId: string | null };
type VerdictView = { label: string; status: unknown; code: unknown; ticket: unknown; operationId: unknown };
/** A refusal before the network with its CLI partner: the core entry the CLI calls with the same raw input. */
type RefusalRow = {
	label: string;
	catches: string;
	project: ProjectKey;
	tool: ClaimToolName;
	args: Body;
	core: CoreCall;
	verdict: Verdict;
};
/** An MCP-own refusal without a CLI partner; the contract leaves ticket and operation ID of it open. */
type GuardRow = {
	label: string;
	catches: string;
	project: ProjectKey;
	tool: ClaimToolName;
	args: Body;
	code: ClaimErrorCode;
	tickets: readonly (string | null)[];
	operationIds: readonly (string | null)[];
};
type InputRow = { label: string; catches: string; tool: ClaimToolName; args: Body | undefined; expected: Body };
type ResultRow = { label: string; catches: string; status: ClaimStatus; document: ClaimDocument };
/** Everything a client sees of one tool answer; `threw` stands for an exception instead of an answer. */
type ResultView = {
	label: string;
	threw: boolean;
	resultKeys: string[];
	structured: unknown;
	text: unknown;
	roundTrip: unknown;
	isError: unknown;
};
type ParityPair = { actual: ResultView; expected: ResultView; verdict: VerdictView; wanted: VerdictView };
type GuardView = {
	label: string;
	threw: boolean;
	head: Body;
	documentKeys: string[];
	ticketAllowed: boolean;
	operationIdAllowed: boolean;
	isError: unknown;
	resultKeys: string[];
	textMatches: boolean;
	roundTrip: boolean;
};
type ThrowView = {
	label: string;
	threw: boolean;
	resultKeys: string[];
	structured: unknown;
	documentKeys: string[];
	isError: unknown;
	roundTrip: unknown;
	echoed: boolean;
};
type ParameterType = "string" | "integer";
type SchemaRow = {
	properties: Partial<Record<keyof ClaimMutationInput, ParameterType>>;
	required: string[];
	readOnly: boolean;
	destructive: boolean;
};
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type ResolveInput = Parameters<typeof runClaimResolve>[0];
type RetryInput = Parameters<typeof runClaimRetry>[0];
type ListInput = Parameters<typeof runClaimList>[0];

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; the other instants derive from it. */
const T = 1_800_000_000_000;
const GRACE = 10 * MINUTE;
const L = T + 5 * MINUTE;
const R = L + GRACE;
const TICKET = "BACK-1";
const OWNER = "agent a";
const OP = "op-7c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a45";
const OP_GENERATED = "op-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const ROOT = "a1".repeat(20);
const HARD_END = "2027-01-15T10:00:00Z";
/** Context paths, the endpoint and the raw error carry it; no MCP answer may contain it (in P form). */
const SENTINEL = "SENTINEL-claim-mcp-5e02";
/** Absolute but never created: every case here ends before the context is read. */
const CONTEXT = `/claim-mcp-${SENTINEL}/context`;
const RELATIVE_CONTEXT = `claim-mcp-${SENTINEL}/context`;
const TARGET_CONTEXT = `/claim-mcp-${SENTINEL}/target`;
/** Port 9 (discard) on loopback; no case of this file gets as far as a Git command. */
const ENDPOINT = `git://127.0.0.1:9/claims-${SENTINEL}.git`;
const RAW = `raw failure ${SENTINEL}`;
/** Stands for "no such value"; a readable marker instead of a raw index result (noUncheckedIndexedAccess). */
const ABSENT = "<absent>";
/** Written out and sorted so the constant under test is not its own oracle. */
const SEVEN: readonly ClaimToolName[] = [
	"claim_acquire",
	"claim_list",
	"claim_reclaim",
	"claim_release",
	"claim_renew",
	"claim_resolve",
	"claim_retry",
];
/** "Out of scope": administration, filter-driven verbs and the emergency release; both spellings of the hyphen. */
const FORBIDDEN_PARTS = [
	"setup",
	"init",
	"context",
	"transfer",
	"resume",
	"change-bounds",
	"change_bounds",
	"next",
	"batch",
	"preview",
	"emergency",
];
/** The stderr partition of claim-text.ts:23, written out. */
const ERROR_STATUSES: readonly string[] = ["refused", "unavailable", "internal"];
/** `{content, structuredContent, isError}`, nothing else (no exit code, no `details`). */
const RESULT_KEYS = ["content", "isError", "structuredContent"];
/** The eight keys of a plain claim-error document (surface:1389–1398), sorted by code units. */
const ERROR_KEYS = ["code", "command", "kind", "message", "operationId", "schemaVersion", "status", "ticket"];
const HEAD_KEYS = ["schemaVersion", "kind", "status", "command", "code", "message"];
const TOOL_COMMANDS: Record<ClaimToolName, ClaimCommand> = {
	claim_acquire: "acquire",
	claim_renew: "renew",
	claim_release: "release",
	claim_reclaim: "reclaim",
	claim_resolve: "resolve",
	claim_list: "list",
	claim_retry: "retry",
};
/** "Mutating tools"; retry resends its own intent, so it names `backlog claim retry --json`. */
const MUTATING_VERBS: Partial<Record<ClaimToolName, string>> = {
	claim_acquire: "acquire",
	claim_renew: "renew",
	claim_release: "release",
	claim_reclaim: "reclaim",
	claim_retry: "retry",
};
/** Verbatim: every tool. */
const ADMINISTRATION_SENTENCE = [
	"Administrative recovery (emergency release, transfer, resume, change-bounds, setup, init, context creation)",
	"is not exposed over MCP; use the backlog CLI.",
].join(" ");
/** Verbatim: the list tool. */
const LIST_SENTENCE = "Owner names are display data only; unknown is not free.";
/** Verbatim: the mutating tools, each with its own CLI verb. */
function mutatingSentence(verb: string): string {
	return [
		`Returns the claim JSON document of \`backlog claim ${verb} --json\`; status replaces the exit code.`,
		"Pass operationId to resolve or retry after a lost reply.",
		"context is the absolute path of your private claim context and is never echoed.",
	].join(" ");
}
/**
 * Parameters = keys of ClaimMutationInput (the type makes a renamed or snake_case name a compile error),
 * `required` only ticket resp. operationId, integers typed as integers; hints as specified.
 */
const SCHEMAS: Record<ClaimToolName, SchemaRow> = {
	claim_acquire: {
		properties: {
			ticket: "string",
			owner: "string",
			context: "string",
			ttlMs: "integer",
			hardEnd: "string",
			operationId: "string",
		},
		required: ["ticket"],
		readOnly: false,
		destructive: false,
	},
	claim_renew: {
		properties: {
			ticket: "string",
			context: "string",
			ttlMs: "integer",
			expectGeneration: "integer",
			operationId: "string",
		},
		required: ["ticket"],
		readOnly: false,
		destructive: false,
	},
	claim_release: {
		properties: { ticket: "string", context: "string", expectGeneration: "integer", operationId: "string" },
		required: ["ticket"],
		readOnly: false,
		destructive: true,
	},
	claim_reclaim: {
		properties: { ticket: "string", context: "string", expectGeneration: "integer", operationId: "string" },
		required: ["ticket"],
		readOnly: false,
		destructive: true,
	},
	claim_resolve: {
		properties: { operationId: "string", context: "string" },
		required: ["operationId"],
		readOnly: true,
		destructive: false,
	},
	claim_list: {
		properties: { ticket: "string", context: "string" },
		required: [],
		readOnly: true,
		destructive: false,
	},
	claim_retry: {
		properties: { operationId: "string", context: "string" },
		required: ["operationId"],
		readOnly: false,
		destructive: false,
	},
};

/** Every call a refusal before the network must never reach: the local ticket lookup, the corpus load, a sleep. */
const TRIPWIRE: string[] = [];
/** mcp-p07 only: arms a throw in the environment builder (`env`) or in the core's first seam call (`core`). */
const TRAP = { env: false, core: false };
/**
 * One seam set for both sides (identical injected seams). `clock` is a getter, so the spread of the
 * environment builder (claim-env.ts:107, "seams per spread last") can be made to throw; `monotonicNow` is the first
 * seam `runClaimMutation`, `runClaimList` and `runClaimRetry` call (surface:2189, 2950, 2759).
 */
const SEAMS: ClaimEnvSeams = {
	get clock(): () => number {
		if (TRAP.env) throw new Error(RAW);
		return () => T;
	},
	monotonicNow: () => {
		if (TRAP.core) throw new Error(RAW);
		return 0;
	},
	random: () => 0,
	sleep: async (ms: number) => {
		TRIPWIRE.push(`sleep ${ms}`);
	},
	newOperationId: () => OP_GENERATED,
	findLocalTicket: async (input: string): Promise<{ kind: "missing" }> => {
		TRIPWIRE.push(`findLocalTicket ${input}`);
		return { kind: "missing" };
	},
	loadLocalTickets: async (): Promise<ClaimLocalTickets> => {
		TRIPWIRE.push("loadLocalTickets");
		return { kind: "unavailable" };
	},
};

let fixture: Fixture;

// adapted from claim-surface.test.ts:192–195 (byCodeUnits)
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface.test.ts:198–201 (field)
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

/** Own keys, sorted; a key holding `undefined` still counts (catches explicit undefined fields). */
function keysOf(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.keys(value).sort(byCodeUnits);
}

/** The one text item of an MCP answer, or ABSENT when `content` is not exactly one text item. */
function textOf(result: unknown): unknown {
	const content = field(result, "content");
	if (!Array.isArray(content) || content.length !== 1) return ABSENT;
	const item: unknown = content[0];
	return field(item, "type") === "text" ? field(item, "text") : ABSENT;
}

function parsed(text: unknown): unknown {
	if (typeof text !== "string") return ABSENT;
	try {
		return JSON.parse(text);
	} catch {
		return ABSENT;
	}
}

/** adapted from claim-cli.test.ts:725–741 (claimsBlock): the template keys of the mode; endpoint never contacted. */
function claimsBlock(mode: "lease" | "hard"): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(ENDPOINT)}`,
		"  storage_format: blob",
		`  lifetime_mode: ${mode}`,
		...(mode === "lease" ? ["  lease_ttl_ms: 300000"] : []),
		"  reclaim_grace_ms: 600000",
		"  attempt_timeout_ms: 10000",
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		"  clock_uncertainty_ms: 1000",
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

/** Header and `enabled` only: endpoint, format, mode, timeout, attempts and budget are `missing` (config-invalid). */
const BROKEN_BLOCK = ["claims:", "  enabled: true"].join("\n");

/** adapted from claim-cli.test.ts:769–800 (initProject): prefix BACK and the claims block; no tasks, no Git. */
async function createProject(root: string, block: string | undefined): Promise<void> {
	await mkdir(root);
	const core = new Core(root);
	await initializeFilesystemTestProject(core, "Claim MCP");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
}

function resultView(label: string, result: unknown): ResultView {
	const text = textOf(result);
	return {
		label,
		threw: false,
		resultKeys: keysOf(result),
		structured: field(result, "structuredContent"),
		text,
		roundTrip: parsed(text),
		isError: field(result, "isError"),
	};
}

/** mcp-p07: a handler that throws shows as `threw`, never as an uncaught test error. */
async function callView(label: string, project: ProjectKey, tool: ClaimToolName, args: Body): Promise<ResultView> {
	let result: unknown;
	try {
		result = await fixture.servers[project].testInterface.callTool({ params: { name: tool, arguments: args } });
	} catch {
		return {
			label,
			threw: true,
			resultKeys: [],
			structured: ABSENT,
			text: ABSENT,
			roundTrip: ABSENT,
			isError: ABSENT,
		};
	}
	return resultView(label, result);
}

/** The CLI's --json bytes, the document unchanged, its JSON round trip, isError by status. */
function expectedView(label: string, document: ClaimDocument): ResultView {
	return {
		label,
		threw: false,
		resultKeys: RESULT_KEYS,
		structured: document,
		text: formatJson(document),
		roundTrip: document,
		isError: ERROR_STATUSES.includes(document.status),
	};
}

function verdictOf(label: string, document: unknown): VerdictView {
	return {
		label,
		status: field(document, "status"),
		code: field(document, "code"),
		ticket: field(document, "ticket"),
		operationId: field(document, "operationId"),
	};
}

/** The CLI side's environment from the shared module, with the same seams as the MCP side. */
async function coreEnv(project: ProjectKey, tool: ClaimToolName): Promise<ClaimSurfaceEnv> {
	const env = await claimProjectEnv(fixture.roots[project], TOOL_COMMANDS[tool], SEAMS);
	if (isClaimDocument(env)) throw new Error(`the ${project} fixture has no environment: ${env.kind}`);
	return env;
}

/** The raw input the CLI hands the core; ill-typed values are deliberate (surface:2144). */
function viaMutation(command: ClaimMutationCommand, fields: Body): CoreCall {
	const input = { command, ...fields } as unknown as ClaimMutationInput;
	return (env) => runClaimMutation(input, env);
}

function viaResolve(fields: Body): CoreCall {
	const input = fields as unknown as ResolveInput;
	return (env) => runClaimResolve(input, env);
}

function viaRetry(fields: Body): CoreCall {
	const input = fields as unknown as RetryInput;
	return (env) => runClaimRetry(input, env);
}

function viaList(fields: Body): CoreCall {
	const input = fields as unknown as ListInput;
	return (env) => runClaimList(input, env);
}

function refused(code: ClaimErrorCode, ticket: string | null, operationId: string | null = null): Verdict {
	return { status: "refused", code, ticket, operationId };
}

function internal(operationId: string | null = null): Verdict {
	return { status: "internal", code: "internal", ticket: null, operationId };
}

async function parity(row: RefusalRow): Promise<ParityPair> {
	const label = labelled(row);
	const document = await row.core(await coreEnv(row.project, row.tool));
	const actual = await callView(label, row.project, row.tool, row.args);
	return {
		actual,
		expected: expectedView(label, document),
		verdict: verdictOf(label, document),
		wanted: { label, ...row.verdict },
	};
}

async function parities(rows: readonly RefusalRow[]): Promise<ParityPair[]> {
	const pairs: ParityPair[] = [];
	for (const row of rows) pairs.push(await parity(row));
	return pairs;
}

/** Labels of answers that echo the sentinel (context path, endpoint or raw error). */
function echoed(views: readonly ResultView[]): string[] {
	const hits = views.filter((view) => Bun.inspect([view.text, view.structured]).includes(SENTINEL));
	return hits.map((view) => view.label);
}

function labelled(row: { label: string; catches: string }): string {
	return `${row.label} (catches: ${row.catches})`;
}

function headOf(value: unknown): Body {
	return Object.fromEntries(HEAD_KEYS.map((key) => [key, field(value, key)]));
}

/**
 * Guard answers: the head equals the core's claim-error of that code, the keys are exactly the plain error
 * keys; ticket and operation ID must be one of the allowed values (the contract leaves them open [?3]).
 */
async function guardViews(rows: readonly GuardRow[]): Promise<{ actual: GuardView[]; expected: GuardView[] }> {
	const actual: GuardView[] = [];
	const expected: GuardView[] = [];
	for (const row of rows) {
		const label = labelled(row);
		const view = await callView(label, row.project, row.tool, row.args);
		const structured = view.structured;
		actual.push({
			label,
			threw: view.threw,
			head: headOf(structured),
			documentKeys: keysOf(structured),
			ticketAllowed: row.tickets.some((ticket) => ticket === field(structured, "ticket")),
			operationIdAllowed: row.operationIds.some((id) => id === field(structured, "operationId")),
			isError: view.isError,
			resultKeys: view.resultKeys,
			textMatches: view.text === formatJson(structured),
			roundTrip: Bun.deepEquals(view.roundTrip, structured),
		});
		const reference = claimErrorDocument({ command: TOOL_COMMANDS[row.tool], code: row.code });
		expected.push({
			label,
			threw: false,
			head: headOf(reference),
			documentKeys: ERROR_KEYS,
			ticketAllowed: true,
			operationIdAllowed: true,
			isError: true,
			resultKeys: RESULT_KEYS,
			textMatches: true,
			roundTrip: true,
		});
	}
	return { actual, expected };
}

function envThrowLabel(tool: ClaimToolName): string {
	return `${tool} (catches: an environment builder exception that escapes, is mapped elsewhere or leaks)`;
}

function throwView(view: ResultView): ThrowView {
	return {
		label: view.label,
		threw: view.threw,
		resultKeys: view.resultKeys,
		structured: view.structured,
		documentKeys: keysOf(view.structured),
		isError: view.isError,
		roundTrip: view.roundTrip,
		echoed: Bun.inspect([view.text, view.structured]).includes(SENTINEL),
	};
}

/** Every exception ends as `claimErrorDocument({command, code: "internal"})`, like claim.ts:372–376. */
function expectedThrowView(tool: ClaimToolName): ThrowView {
	const document = claimErrorDocument({ command: TOOL_COMMANDS[tool], code: "internal" });
	return {
		label: envThrowLabel(tool),
		threw: false,
		resultKeys: RESULT_KEYS,
		structured: document,
		documentKeys: ERROR_KEYS,
		isError: true,
		roundTrip: document,
		echoed: false,
	};
}

/** A logged value that carries the raw error: the Error object itself or its sentinel message anywhere inside. */
function carriesRaw(args: readonly unknown[]): boolean {
	return args.some((arg) => arg instanceof Error || Bun.inspect(arg).includes(SENTINEL));
}

// ---------------------------------------------------------------------------------------------------------------
// mcp-p04 documents: one realistic document per status, built by the surface's own exported builders where one
// exists (surface:1683, 1705, 1741, 1409); the list document and the unknown-after-start error are typed literals.
// ---------------------------------------------------------------------------------------------------------------

const HELD: ClaimRightEvaluation = {
	kind: "evaluated",
	scope: "observed-state-only",
	observedRoot: ROOT,
	claimGeneration: 1,
	ownership: "held",
	workRight: { kind: "live", renewalDue: false },
	reclaim: { kind: "not-yet", boundary: R },
};
const FOREIGN: ClaimRightEvaluation = {
	kind: "evaluated",
	scope: "observed-state-only",
	observedRoot: ROOT,
	claimGeneration: 2,
	ownership: "foreign",
	workRight: { kind: "none", cause: "not-holder" },
	reclaim: { kind: "not-yet", boundary: R },
};
const LEASE_TIMING = { mode: "lease", leaseEnd: L, hardEnd: null, graceMs: GRACE } as const;

function executed(storage: Operation["storage"], outcome: Operation["outcome"]["kind"], sends: number): Operation {
	return {
		kind: "operation",
		scope: "transition-execution-only",
		action: "acquire",
		operationId: OP,
		storage,
		outcome: { kind: outcome },
		rights: HELD,
		sends,
	};
}

const APPLIED = claimOperationDocument({
	command: "acquire",
	ticket: TICKET,
	result: executed({ kind: "applied", root: ROOT }, "applied", 1),
	planned: { status: "active", claimGeneration: 1, timing: LEASE_TIMING, capped: false },
	stoppedBy: null,
});

/** ClaimListDocument (surface:455–463) as `runClaimList` builds it (:3023–3031); no exported builder exists. */
const LIST_OK: ClaimListDocument = {
	schemaVersion: 1,
	kind: "claim-list",
	status: "ok",
	command: "list",
	complete: true,
	observedAt: T,
	claims: [
		{
			ticket: TICKET,
			state: "active",
			owner: OWNER,
			claimGeneration: 1,
			timing: LEASE_TIMING,
			rights: {
				kind: "evaluated",
				scope: "observed-state-only",
				ownership: "held",
				claimGeneration: 1,
				workRight: { kind: "live", renewalDue: false },
				reclaim: { kind: "not-yet", boundary: R },
			},
		},
		{ ticket: "BACK-2", state: "free" },
	],
};

/** The answer after the executor started (surface:1422–1437, not exported): a claim-error with status unknown. */
const UNKNOWN_AFTER_START: ClaimErrorDocument = {
	schemaVersion: 1,
	kind: "claim-error",
	status: "unknown",
	command: "acquire",
	code: "internal",
	message: "an unexpected error ended the command after the operation started; its outcome is unknown",
	ticket: TICKET,
	operationId: OP,
};

const RESULT_ROWS: ResultRow[] = [
	{
		label: "claim-list ok",
		catches: "isError set on a read that succeeded; the list reshaped",
		status: "ok",
		document: LIST_OK,
	},
	{
		label: "claim-operation plan rejection",
		catches: "a rejection reported as a tool error (the contract keeps rejected a result)",
		status: "rejected",
		document: claimOperationDocument({
			command: "acquire",
			ticket: TICKET,
			result: {
				kind: "not-planned",
				plan: { kind: "rejected", cause: "not-free", reason: "held by another binding" },
				rights: FOREIGN,
			},
			planned: null,
			stoppedBy: null,
		}),
	},
	{
		label: "claim-resolution open",
		catches: "an open intent reported as a tool error",
		status: "unknown",
		document: claimResolutionDocument({
			operationId: OP,
			ticket: TICKET,
			action: "acquire",
			result: { kind: "resolved", resolution: { kind: "open", observedRoot: null } },
		}),
	},
	{
		label: "claim-error unknown after the start",
		catches: "isError keyed on kind claim-error instead of on status",
		status: "unknown",
		document: UNKNOWN_AFTER_START,
	},
	{
		label: "claim-resolution conflict",
		catches: "unknown-history treated as an error",
		status: "unknown-history",
		document: claimResolutionDocument({
			operationId: OP,
			ticket: TICKET,
			action: "acquire",
			result: { kind: "resolved", resolution: { kind: "conflict", reason: "two stored successors" } },
		}),
	},
	{
		label: "claim-error config-invalid with problems",
		catches: "a refusal without isError; the optional problems key dropped",
		status: "refused",
		document: claimPreflightError({
			command: "acquire",
			ticket: TICKET,
			verdict: {
				kind: "config-invalid",
				reason: "the claims configuration is invalid",
				problems: [{ key: "claims.endpoint", problem: "missing", message: "claims.endpoint is missing." }],
			},
		}),
	},
	{
		label: "claim-error unreachable",
		catches: "unavailable read as a result",
		status: "unavailable",
		document: claimErrorDocument({ command: "renew", code: "unreachable", ticket: TICKET }),
	},
	{
		label: "claim-operation not sent",
		catches: "isError keyed on kind: an unavailable claim-operation is still an error",
		status: "unavailable",
		document: claimOperationDocument({
			command: "acquire",
			ticket: TICKET,
			result: executed({ kind: "not-sent", cause: "admission-held" }, "not-sent", 0),
			planned: null,
			stoppedBy: null,
		}),
	},
	{
		label: "claim-pause outstanding",
		catches: "a pause reported as a tool error (retry is its way out)",
		status: "paused",
		document: claimOperationDocument({
			command: "acquire",
			ticket: TICKET,
			result: { kind: "paused", pause: { kind: "outstanding", operationIds: [OP] }, rights: HELD },
			planned: null,
			stoppedBy: null,
		}),
	},
	{
		label: "claim-error internal",
		catches: "internal without isError",
		status: "internal",
		document: claimErrorDocument({ command: "release", code: "internal", ticket: TICKET }),
	},
];

/** The document as passed, before and after the builder ran (catches a builder that edits its input). */
function builtView(label: string, status: ClaimStatus, document: ClaimDocument): Body {
	const before = formatJson(document);
	const view = resultView(label, claimToolResult(document));
	return { ...view, status: document.status, declared: status, unchanged: formatJson(document) === before };
}

function wantedView(label: string, status: ClaimStatus, document: ClaimDocument): Body {
	return {
		...expectedView(label, document),
		isError: ERROR_STATUSES.includes(status),
		status,
		declared: status,
		unchanged: true,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// mcp-p05 and mcp-p06 rows (verdicts: surface:2195–2232 mutate, :2857–2862 resolve, :2760–2766 retry,
// :2952–2962 list; codes and messages :186–293).
// ---------------------------------------------------------------------------------------------------------------

const PK_OWNER: RefusalRow = {
	label: "acquire without owner",
	catches: "a stub or generic answer; a default owner; the owner check left to a schema",
	project: "lease",
	tool: "claim_acquire",
	args: { ticket: TICKET, context: CONTEXT },
	core: viaMutation("acquire", { ticket: TICKET, context: CONTEXT }),
	verdict: refused("owner-required", TICKET),
};

const REFUSAL_ROWS: RefusalRow[] = [
	{
		label: "acquire, owner of two spaces",
		catches: "a blank owner accepted, e.g. a trim that turns it into a missing one with another code",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: "  ", context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: "  ", context: CONTEXT }),
		verdict: refused("owner-required", TICKET),
	},
	{
		label: "acquire, invalid ticket",
		catches: "a tool-side ticket check with another code or a ticket echo",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: "not a ticket", owner: OWNER, context: CONTEXT },
		core: viaMutation("acquire", { ticket: "not a ticket", owner: OWNER, context: CONTEXT }),
		verdict: refused("invalid-ticket", null),
	},
	{
		label: "acquire, ticket missing",
		catches: "`required` enforced by the tool with a foreign error kind (the core answers invalid-ticket)",
		project: "lease",
		tool: "claim_acquire",
		args: { owner: OWNER, context: CONTEXT },
		core: viaMutation("acquire", { owner: OWNER, context: CONTEXT }),
		verdict: refused("invalid-ticket", null),
	},
	{
		label: "list, invalid ticket",
		catches: "the list filter ticket not handed to the core",
		project: "lease",
		tool: "claim_list",
		args: { ticket: "not a ticket" },
		core: viaList({ ticket: "not a ticket" }),
		verdict: refused("invalid-ticket", null),
	},
	{
		label: "renew, context missing",
		catches: "a missing context not defaulted like claim.ts:430 or answered with a foreign kind",
		project: "lease",
		tool: "claim_renew",
		args: { ticket: TICKET },
		core: viaMutation("renew", { ticket: TICKET, context: "" }),
		verdict: refused("context-required", TICKET),
	},
	{
		label: "resolve, context missing",
		catches: "resolve without the context default",
		project: "lease",
		tool: "claim_resolve",
		args: { operationId: OP },
		core: viaResolve({ operationId: OP, context: "" }),
		verdict: refused("context-required", null, OP),
	},
	{
		label: "retry, context missing",
		catches: "retry without the context default",
		project: "lease",
		tool: "claim_retry",
		args: { operationId: OP },
		core: viaRetry({ operationId: OP, context: "" }),
		verdict: refused("context-required", null, OP),
	},
	{
		label: "release, relative context",
		catches: "a context resolved against the server root or the working directory",
		project: "lease",
		tool: "claim_release",
		args: { ticket: TICKET, context: RELATIVE_CONTEXT },
		core: viaMutation("release", { ticket: TICKET, context: RELATIVE_CONTEXT }),
		verdict: refused("context-invalid", TICKET),
	},
	{
		label: "list, relative context",
		catches: "the list context resolved or dropped",
		project: "lease",
		tool: "claim_list",
		args: { context: RELATIVE_CONTEXT },
		core: viaList({ context: RELATIVE_CONTEXT }),
		verdict: refused("context-invalid", null),
	},
	{
		label: 'acquire, ttlMs "5000"',
		catches: "number coercion (parseFloat of the generic validator)",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, ttlMs: "5000" },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT, ttlMs: "5000" }),
		verdict: refused("invalid-option", TICKET),
	},
	{
		label: "renew, ttlMs 1.5",
		catches: "a fraction rounded or truncated",
		project: "lease",
		tool: "claim_renew",
		args: { ticket: TICKET, context: CONTEXT, ttlMs: 1.5 },
		core: viaMutation("renew", { ticket: TICKET, context: CONTEXT, ttlMs: 1.5 }),
		verdict: refused("invalid-option", TICKET),
	},
	{
		label: "acquire, ttlMs 0",
		catches: "zero read as absent (the configured default)",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, ttlMs: 0 },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT, ttlMs: 0 }),
		verdict: refused("invalid-option", TICKET),
	},
	{
		label: 'release, expectGeneration "2"',
		catches: "the generation coerced from a string",
		project: "lease",
		tool: "claim_release",
		args: { ticket: TICKET, context: CONTEXT, expectGeneration: "2" },
		core: viaMutation("release", { ticket: TICKET, context: CONTEXT, expectGeneration: "2" }),
		verdict: refused("invalid-option", TICKET),
	},
	{
		label: "acquire, operation ID with a space",
		catches: "a tool-side ID check with another code",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, operationId: "bad id" },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT, operationId: "bad id" }),
		verdict: refused("invalid-operation-id", TICKET),
	},
	{
		label: "resolve, operation ID with a space",
		catches: "the invalid ID echoed",
		project: "lease",
		tool: "claim_resolve",
		args: { operationId: "bad id", context: CONTEXT },
		core: viaResolve({ operationId: "bad id", context: CONTEXT }),
		verdict: refused("invalid-operation-id", null),
	},
	{
		label: "retry, operation ID of 129 characters",
		catches: "the length limit not the journal's",
		project: "lease",
		tool: "claim_retry",
		args: { operationId: "a".repeat(129), context: CONTEXT },
		core: viaRetry({ operationId: "a".repeat(129), context: CONTEXT }),
		verdict: refused("invalid-operation-id", null),
	},
	{
		label: "resolve, operation ID missing",
		catches: "`required` enforced by the tool with a foreign error kind",
		project: "lease",
		tool: "claim_resolve",
		args: { context: CONTEXT },
		core: viaResolve({ context: CONTEXT }),
		verdict: refused("invalid-operation-id", null),
	},
	{
		label: "acquire, toContext",
		catches: "an administration field passed through or silently dropped",
		project: "lease",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, toContext: TARGET_CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT, toContext: TARGET_CONTEXT }),
		verdict: refused("option-not-applicable", TICKET),
	},
	{
		label: "acquire, project without claims block",
		catches: "an MCP-own configuration gate or a registration-time snapshot",
		project: "none",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("not-configured", TICKET),
	},
	{
		label: "list, no arguments, project without claims block",
		catches: 'the list context defaulted to "" (the core would answer context-required)',
		project: "none",
		tool: "claim_list",
		args: {},
		core: viaList({}),
		verdict: refused("not-configured", null),
	},
	{
		label: "acquire, claims block with missing keys",
		catches: "the cached server configuration instead of a fresh read; problems dropped",
		project: "broken",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("config-invalid", TICKET),
	},
	{
		label: "resolve, claims block with missing keys",
		catches: "the operation ID dropped from a configuration refusal",
		project: "broken",
		tool: "claim_resolve",
		args: { operationId: OP, context: CONTEXT },
		core: viaResolve({ operationId: OP, context: CONTEXT }),
		verdict: refused("config-invalid", null, OP),
	},
	{
		label: "acquire, hard lifetime mode without hardEnd",
		catches: "a default hard end or the lease path taken",
		project: "hard",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("hard-end-required", TICKET),
	},
];

const NUMBER_CONTEXT_ROWS: GuardRow[] = [
	{
		label: "resolve, context 5",
		catches: "a number handed to the core's isAbsolute (internal instead of context-invalid)",
		project: "lease",
		tool: "claim_resolve",
		args: { operationId: OP, context: 5 },
		code: "context-invalid",
		tickets: [null],
		operationIds: [OP, null],
	},
	{
		label: "list, context 5",
		catches: "the list context guard missing",
		project: "lease",
		tool: "claim_list",
		args: { context: 5 },
		code: "context-invalid",
		tickets: [null],
		operationIds: [null],
	},
];

const INPUT_ROWS: InputRow[] = [
	{
		label: "acquire, padded owner",
		catches: "a trim of the display name",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: " x ", context: CONTEXT },
		expected: { command: "acquire", ticket: TICKET, context: CONTEXT, owner: " x " },
	},
	{
		label: "acquire, every value raw",
		catches: "trim, CR normalisation or number coercion of any field",
		tool: "claim_acquire",
		args: {
			ticket: " back-1 ",
			owner: "agent a\r",
			context: `${CONTEXT}\r`,
			ttlMs: "5000",
			hardEnd: `${HARD_END} `,
			operationId: `${OP}\r`,
		},
		expected: {
			command: "acquire",
			ticket: " back-1 ",
			context: `${CONTEXT}\r`,
			owner: "agent a\r",
			ttlMs: "5000",
			hardEnd: `${HARD_END} `,
			operationId: `${OP}\r`,
		},
	},
	{
		label: "acquire, null everywhere but the ticket",
		catches: 'null passed on, or an explicit undefined key; a null context not defaulted to ""',
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: null, context: null, ttlMs: null, hardEnd: null, operationId: null },
		expected: { command: "acquire", ticket: TICKET, context: "" },
	},
	{
		label: "renew, fraction and zero",
		catches: "numbers rounded, zero dropped as falsy",
		tool: "claim_renew",
		args: { ticket: TICKET, ttlMs: 1.5, expectGeneration: 0 },
		expected: { command: "renew", ticket: TICKET, context: "", ttlMs: 1.5, expectGeneration: 0 },
	},
	{
		label: "release, string generation",
		catches: "the generation coerced",
		tool: "claim_release",
		args: { ticket: TICKET, context: CONTEXT, expectGeneration: "2" },
		expected: { command: "release", ticket: TICKET, context: CONTEXT, expectGeneration: "2" },
	},
	{
		label: "reclaim, context missing",
		catches: 'the "" default missing for reclaim',
		tool: "claim_reclaim",
		args: { ticket: TICKET },
		expected: { command: "reclaim", ticket: TICKET, context: "" },
	},
	{
		label: "renew, no arguments object",
		catches: "undefined arguments not handled like an empty object",
		tool: "claim_renew",
		args: undefined,
		expected: { command: "renew", context: "" },
	},
	{
		label: "resolve, padded operation ID",
		catches: "a trimmed ID; a command key or a context-less input for resolve",
		tool: "claim_resolve",
		args: { operationId: ` ${OP}` },
		expected: { operationId: ` ${OP}`, context: "" },
	},
	{
		label: "retry",
		catches: "retry mapped onto another core input",
		tool: "claim_retry",
		args: { operationId: OP, context: CONTEXT },
		expected: { operationId: OP, context: CONTEXT },
	},
	{
		label: "list, no arguments object",
		catches: 'a context "" for list (claim.ts:873 passes undefined)',
		tool: "claim_list",
		args: undefined,
		expected: {},
	},
	{
		label: "list, raw ticket and null context",
		catches: "the list ticket normalised; a null context kept",
		tool: "claim_list",
		args: { ticket: " back-1 ", context: null },
		expected: { ticket: " back-1 " },
	},
	{
		label: "list, relative context",
		catches: "the list context resolved",
		tool: "claim_list",
		args: { context: RELATIVE_CONTEXT },
		expected: { context: RELATIVE_CONTEXT },
	},
];

const RAW_ROWS: RefusalRow[] = [
	{
		label: "resolve, operation ID with a trailing CR",
		catches: "a trimmed operation ID (would reach not-configured)",
		project: "none",
		tool: "claim_resolve",
		args: { operationId: `${OP}\r`, context: CONTEXT },
		core: viaResolve({ operationId: `${OP}\r`, context: CONTEXT }),
		verdict: refused("invalid-operation-id", null),
	},
	{
		label: "acquire, hardEnd with a trailing space",
		catches: "a trimmed instant (would reach not-configured)",
		project: "none",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, hardEnd: `${HARD_END} ` },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT, hardEnd: `${HARD_END} ` }),
		verdict: refused("invalid-option", TICKET),
	},
	{
		label: "acquire, owner with a trailing CR",
		catches: "an MCP-side owner check stricter than the core",
		project: "none",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: "agent a\r", context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: "agent a\r", context: CONTEXT }),
		verdict: refused("not-configured", TICKET),
	},
	{
		label: "acquire, padded owner",
		catches: "an MCP-side owner check stricter than the core",
		project: "none",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: " x ", context: CONTEXT },
		core: viaMutation("acquire", { ticket: TICKET, owner: " x ", context: CONTEXT }),
		verdict: refused("not-configured", TICKET),
	},
	{
		label: "release, expectGeneration null",
		catches: "null passed on (the core would answer invalid-option)",
		project: "none",
		tool: "claim_release",
		args: { ticket: TICKET, context: CONTEXT, expectGeneration: null },
		core: viaMutation("release", { ticket: TICKET, context: CONTEXT }),
		verdict: refused("not-configured", TICKET),
	},
	{
		label: "list, context null",
		catches: 'a null list context turned into "" (context-required) or passed on',
		project: "none",
		tool: "claim_list",
		args: { context: null },
		core: viaList({}),
		verdict: refused("not-configured", null),
	},
	{
		label: "renew, context null",
		catches: 'a null context read as a non-string (context-invalid) instead of absent ("")',
		project: "lease",
		tool: "claim_renew",
		args: { ticket: TICKET, context: null },
		core: viaMutation("renew", { ticket: TICKET, context: "" }),
		verdict: refused("context-required", TICKET),
	},
	{
		label: "acquire, hardEnd null in hard mode",
		catches: "null passed on (invalid-option instead of hard-end-required)",
		project: "hard",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, hardEnd: null },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("hard-end-required", TICKET),
	},
	{
		label: "acquire, ttlMs null in hard mode",
		catches: "null passed on (invalid-option) or counted as present (option-not-applicable)",
		project: "hard",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, ttlMs: null },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("hard-end-required", TICKET),
	},
	{
		label: "acquire, operationId null in hard mode",
		catches: "null passed on (invalid-operation-id instead of hard-end-required)",
		project: "hard",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, operationId: null },
		core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: CONTEXT }),
		verdict: refused("hard-end-required", TICKET),
	},
];

const GUARD_ROWS: GuardRow[] = [
	{
		label: "list, context true",
		catches: "a boolean context handed to the core",
		project: "none",
		tool: "claim_list",
		args: { context: true },
		code: "context-invalid",
		tickets: [null],
		operationIds: [null],
	},
	{
		label: "acquire, unknown argument ttl_ms",
		catches: "an unknown name silently ignored (a typo would pass unnoticed) or a generic VALIDATION_ERROR",
		project: "none",
		tool: "claim_acquire",
		args: { ticket: TICKET, owner: OWNER, context: CONTEXT, ttl_ms: 5000 },
		code: "option-not-applicable",
		tickets: [TICKET, null],
		operationIds: [null],
	},
	{
		label: "release, owner (a core field the tool does not take)",
		catches: "the core's base leniency used instead of the tool's own property set",
		project: "none",
		tool: "claim_release",
		args: { ticket: TICKET, context: CONTEXT, owner: OWNER },
		code: "option-not-applicable",
		tickets: [TICKET, null],
		operationIds: [null],
	},
	{
		label: "resolve, ticket",
		catches: "a foreign argument accepted by resolve",
		project: "none",
		tool: "claim_resolve",
		args: { operationId: OP, context: CONTEXT, ticket: TICKET },
		code: "option-not-applicable",
		tickets: [null],
		operationIds: [OP, null],
	},
	{
		label: "list, hardEnd",
		catches: "a foreign argument accepted by list",
		project: "none",
		tool: "claim_list",
		args: { hardEnd: HARD_END },
		code: "option-not-applicable",
		tickets: [null],
		operationIds: [null],
	},
];

/** mcp-p07: valid-looking arguments per tool, so every handler gets as far as building the environment. */
const THROW_ARGS: Record<ClaimToolName, Body> = {
	claim_acquire: { ticket: TICKET, owner: OWNER, context: CONTEXT },
	claim_renew: { ticket: TICKET, context: CONTEXT },
	claim_release: { ticket: TICKET, context: CONTEXT },
	claim_reclaim: { ticket: TICKET, context: CONTEXT },
	claim_resolve: { operationId: OP, context: CONTEXT },
	claim_list: {},
	claim_retry: { operationId: OP, context: CONTEXT },
};

/** mcp-p07: the core's own catch answers internal (surface:2177–2181, 2938–2942, 2747–2751); MCP passes it on. */
const CORE_THROW_ROWS: RefusalRow[] = [
	{
		label: "acquire, first seam throws",
		catches: "the core's internal document replaced or its exception rethrown",
		project: "lease",
		tool: "claim_acquire",
		args: THROW_ARGS.claim_acquire,
		core: viaMutation("acquire", THROW_ARGS.claim_acquire),
		verdict: internal(),
	},
	{
		label: "renew, first seam throws",
		catches: "the core's internal document replaced",
		project: "lease",
		tool: "claim_renew",
		args: THROW_ARGS.claim_renew,
		core: viaMutation("renew", THROW_ARGS.claim_renew),
		verdict: internal(),
	},
	{
		label: "release, first seam throws",
		catches: "the core's internal document replaced",
		project: "lease",
		tool: "claim_release",
		args: THROW_ARGS.claim_release,
		core: viaMutation("release", THROW_ARGS.claim_release),
		verdict: internal(),
	},
	{
		label: "reclaim, first seam throws",
		catches: "the core's internal document replaced",
		project: "lease",
		tool: "claim_reclaim",
		args: THROW_ARGS.claim_reclaim,
		core: viaMutation("reclaim", THROW_ARGS.claim_reclaim),
		verdict: internal(),
	},
	{
		label: "list, first seam throws",
		catches: "the core's internal document replaced",
		project: "lease",
		tool: "claim_list",
		args: THROW_ARGS.claim_list,
		core: viaList(THROW_ARGS.claim_list),
		verdict: internal(),
	},
	{
		label: "retry, first seam throws",
		catches: "the retry document's operation ID (surface:2750) lost by a tool-side rebuild",
		project: "lease",
		tool: "claim_retry",
		args: THROW_ARGS.claim_retry,
		core: viaRetry(THROW_ARGS.claim_retry),
		verdict: internal(OP),
	},
];

describe("claim tools over MCP (pure, in-process, level P)", () => {
	beforeAll(async () => {
		const base = await mkdtemp(join(tmpdir(), "claim-mcp-"));
		const roots: Record<ProjectKey, string> = {
			lease: join(base, "lease"),
			none: join(base, "none"),
			broken: join(base, "broken"),
			hard: join(base, "hard"),
		};
		await createProject(roots.lease, claimsBlock("lease"));
		await createProject(roots.none, undefined);
		await createProject(roots.broken, BROKEN_BLOCK);
		await createProject(roots.hard, claimsBlock("hard"));
		const servers: Record<ProjectKey, McpServer> = {
			lease: new McpServer(roots.lease, "Claim MCP test"),
			none: new McpServer(roots.none, "Claim MCP test"),
			broken: new McpServer(roots.broken, "Claim MCP test"),
			hard: new McpServer(roots.hard, "Claim MCP test"),
		};
		// Only the claim tools, by hand, like mcp-server.test.ts:39–41 registers the workflow tools.
		for (const server of Object.values(servers)) registerClaimTools(server, SEAMS);
		fixture = { base, roots, servers };
	});

	afterAll(async () => {
		for (const server of Object.values(fixture.servers)) await server.stop();
		await rm(fixture.base, { recursive: true, force: true });
	});

	test("mcp-p01: the inventory is exactly the seven claim tools, none administrative or filter-driven", async () => {
		const listed = (await fixture.servers.lease.testInterface.listTools()).tools.map((tool) => tool.name);
		// Positive control (catches: retry left out of the slice; without it a pause over MCP is a dead end).
		expect(listed).toContain("claim_retry");
		// catches: a missing, renamed or extra tool; a constant that differs from what is registered.
		const registered = [...listed].sort(byCodeUnits);
		const constant = [...CLAIM_TOOL_NAMES].sort(byCodeUnits);
		expect({ registered, constant }).toEqual({ registered: [...SEVEN], constant: [...SEVEN] });
		// catches: transfer, resume, change-bounds, setup, init, context create, next, preview, batch or emergency.
		expect(listed.filter((name) => FORBIDDEN_PARTS.some((part) => name.includes(part)))).toEqual([]);
		// catches: registration only with a claims block (a registration-time snapshot goes stale after setup).
		const created = await createMcpServer(fixture.roots.none);
		let names: string[] = [];
		try {
			names = (await created.testInterface.listTools()).tools.map((tool) => tool.name);
		} finally {
			await created.stop();
		}
		const claimNames = names.filter((name) => name.startsWith("claim_"));
		expect(claimNames.sort(byCodeUnits)).toEqual([...SEVEN]);
	});

	test("mcp-p02: descriptions carry the fixed sentences and match the constants", async () => {
		const listed: unknown[] = (await fixture.servers.lease.testInterface.listTools()).tools;
		const descriptionOf = (name: ClaimToolName): unknown =>
			field(
				listed.find((tool) => field(tool, "name") === name),
				"description",
			);
		const acquire = descriptionOf("claim_acquire");
		// Positive control (catches: empty or free-form descriptions; administration offered over MCP).
		expect(typeof acquire === "string" && acquire.includes(ADMINISTRATION_SENTENCE)).toBe(true);
		const actual: Body[] = [];
		const expected: Body[] = [];
		for (const name of SEVEN) {
			const raw = descriptionOf(name);
			const text = typeof raw === "string" ? raw : "";
			const verb = MUTATING_VERBS[name];
			// catches: a registered text other than the pinned constant (description drift).
			const view: Body = {
				tool: name,
				administration: text.includes(ADMINISTRATION_SENTENCE),
				registered: raw === CLAIM_TOOL_DESCRIPTIONS[name],
			};
			const wanted: Body = { tool: name, administration: true, registered: true };
			if (verb !== undefined) {
				// catches: no operationId advice (a lost reply loses a generated ID) or the wrong verb.
				view.mutating = text.includes(mutatingSentence(verb));
				wanted.mutating = true;
			}
			if (name === "claim_list") {
				// catches: owner names presented as identities; unknown presented as free.
				view.list = text.includes(LIST_SENTENCE);
				wanted.list = true;
			}
			actual.push(view);
			expected.push(wanted);
		}
		expect(actual).toEqual(expected);
	});

	test("mcp-p03: exact property sets, ticket or operationId required, no additional properties", async () => {
		const listed: unknown[] = (await fixture.servers.lease.testInterface.listTools()).tools;
		const toolOf = (name: ClaimToolName): unknown => listed.find((tool) => field(tool, "name") === name);
		const schemaView = (name: ClaimToolName): Body => {
			const tool = toolOf(name);
			const schema = field(tool, "inputSchema");
			const properties = field(schema, "properties");
			const types = Object.fromEntries(
				keysOf(properties).map((property) => [property, field(field(properties, property), "type")]),
			);
			// An absent `required` counts as none (claim_list has no required parameter [?6]).
			const required = field(schema, "required") ?? [];
			const annotations = field(tool, "annotations");
			const readOnly = field(annotations, "readOnlyHint") === true;
			const destructive = field(annotations, "destructiveHint");
			return {
				tool: name,
				type: field(schema, "type"),
				properties: types,
				required: Array.isArray(required) ? [...required].sort(byCodeUnits) : required,
				additionalProperties: field(schema, "additionalProperties"),
				readOnly,
				// MCP ToolAnnotations: destructiveHint defaults to true and counts only when readOnlyHint is false, so
				// a writing tool states it explicitly [?2].
				destructive: readOnly ? destructive === true : destructive,
			};
		};
		const wantedSchema = (name: ClaimToolName): Body => {
			const row = SCHEMAS[name];
			return {
				tool: name,
				type: "object",
				properties: row.properties,
				required: [...row.required].sort(byCodeUnits),
				additionalProperties: false,
				readOnly: row.readOnly,
				destructive: row.destructive,
			};
		};
		// Positive control (catches: an empty or generic schema; a parameter name other than the core's key).
		expect(field(schemaView("claim_acquire"), "properties")).toEqual(SCHEMAS.claim_acquire.properties);
		// catches: an extra or missing property, owner or context in `required` (the core owns those errors),
		// integers typed as numbers or strings, additionalProperties not false, a hint on the wrong tool, a
		// writing tool without an explicit destructiveHint (a client reads the absent hint as destructive).
		expect(SEVEN.map(schemaView)).toEqual(SEVEN.map(wantedSchema));
	});

	test("mcp-p04: claimToolResult keeps every status's document and --json bytes; isError by status", () => {
		const applied = "claim-operation applied";
		// Positive control (catches: a stub result; a reshaped or wrapped document; text other than formatJson).
		expect(builtView(applied, "applied", APPLIED)).toEqual(wantedView(applied, "applied", APPLIED));
		// catches: a status of CLAIM_EXIT_CODES without a row here (a later status would pass untested).
		const covered = new Set<string>([APPLIED.status, ...RESULT_ROWS.map((row) => row.status)]);
		expect([...covered].sort(byCodeUnits)).toEqual(Object.keys(CLAIM_EXIT_CODES).sort(byCodeUnits));
		// catches: isError on the wrong side of the partition; an exit code, `details` or a second content item;
		// a lossy JSON round trip (undefined fields the SDK would only see on the transport).
		const actual = RESULT_ROWS.map((row) => builtView(labelled(row), row.status, row.document));
		const expected = RESULT_ROWS.map((row) => wantedView(labelled(row), row.status, row.document));
		expect(actual).toEqual(expected);
	});

	test("mcp-p05: refusals before the network equal runClaim* with the same input and environment", async () => {
		TRIPWIRE.length = 0;
		// Positive control (catches: a stub or generic answer; a default owner; the owner check left to a schema).
		const control = await parity(PK_OWNER);
		expect(control.verdict).toEqual(control.wanted);
		expect(control.actual).toEqual(control.expected);
		const pairs = await parities(REFUSAL_ROWS);
		// catches: a fixture that refuses for another reason than its row names (the core is the oracle below).
		expect(pairs.map((pair) => pair.verdict)).toEqual(pairs.map((pair) => pair.wanted));
		// catches: another document, text other than the CLI's --json bytes, a lossy round trip, isError off.
		expect(pairs.map((pair) => pair.actual)).toEqual(pairs.map((pair) => pair.expected));
		// catches: the context path or the endpoint echoed into an answer.
		expect(echoed(pairs.map((pair) => pair.actual))).toEqual([]);
		// catches: a refusal that first resolves the ticket, loads the task corpus or sleeps (before any IO).
		expect(TRIPWIRE).toEqual([]);
	});

	test("mcp-p05: the number 5 as context is context-invalid, like a relative path in the core", async () => {
		TRIPWIRE.length = 0;
		const relative = await parity({
			label: "acquire, relative context (core reference)",
			catches: "a fixture whose relative context is not refused",
			project: "lease",
			tool: "claim_acquire",
			args: { ticket: TICKET, owner: OWNER, context: RELATIVE_CONTEXT },
			core: viaMutation("acquire", { ticket: TICKET, owner: OWNER, context: RELATIVE_CONTEXT }),
			verdict: refused("context-invalid", TICKET),
		});
		// Positive control (catches: a stub answer; a relative context accepted; the reference refusing otherwise).
		expect(relative.verdict).toEqual(relative.wanted);
		expect(relative.actual).toEqual(relative.expected);
		const rows: GuardRow[] = [
			{
				label: "acquire, context 5",
				catches: "a number handed to the core's isAbsolute (internal instead of context-invalid)",
				project: "lease",
				tool: "claim_acquire",
				args: { ticket: TICKET, owner: OWNER, context: 5 },
				code: "context-invalid",
				tickets: [TICKET, null],
				operationIds: [null],
			},
			...NUMBER_CONTEXT_ROWS,
		];
		const { actual, expected } = await guardViews(rows);
		// catches: internal instead of context-invalid, a foreign kind, extra keys, isError off, bad text.
		expect(actual).toEqual(expected);
		// catches: the number case taking a longer path than the relative one (the ticket lookup, a sleep).
		expect(TRIPWIRE).toEqual([]);
	});

	test('mcp-p06: claimToolInput passes values raw, null as absent, context "" where the CLI defaults it', () => {
		const inputView = (row: InputRow): Body => {
			const input: unknown = claimToolInput(row.tool, row.args);
			return { label: labelled(row), input, keys: keysOf(input) };
		};
		const wantedInput = (row: InputRow): Body => ({
			label: labelled(row),
			input: row.expected,
			keys: keysOf(row.expected),
		});
		const control: InputRow = {
			label: "acquire, owner with a trailing CR",
			catches: "a stub; CR normalised to LF or trimmed away (the generic validator)",
			tool: "claim_acquire",
			args: { ticket: TICKET, owner: "agent a\r", context: CONTEXT },
			expected: { command: "acquire", ticket: TICKET, context: CONTEXT, owner: "agent a\r" },
		};
		// Positive control (catches: a stub input; the owner not handed on byte for byte).
		expect(inputView(control)).toEqual(wantedInput(control));
		// catches: per row as labelled; `keys` catches an explicit undefined field that toEqual alone would forgive.
		expect(INPUT_ROWS.map(inputView)).toEqual(INPUT_ROWS.map(wantedInput));
	});

	test("mcp-p06: through callTool the raw value decides the refusal, exactly as in the core", async () => {
		TRIPWIRE.length = 0;
		// Positive control (catches: a stub answer; a context trimmed into an absolute path).
		const control = await parity({
			label: "renew, context with a leading space",
			catches: "a trimmed context (would reach not-configured)",
			project: "none",
			tool: "claim_renew",
			args: { ticket: TICKET, context: ` ${CONTEXT}` },
			core: viaMutation("renew", { ticket: TICKET, context: ` ${CONTEXT}` }),
			verdict: refused("context-invalid", TICKET),
		});
		expect(control.verdict).toEqual(control.wanted);
		expect(control.actual).toEqual(control.expected);
		const pairs = await parities(RAW_ROWS);
		// catches: a fixture that ends for another reason than its row names.
		expect(pairs.map((pair) => pair.verdict)).toEqual(pairs.map((pair) => pair.wanted));
		// catches: per row as labelled (trim, CR normalisation, null passed on, the list context defaulted).
		expect(pairs.map((pair) => pair.actual)).toEqual(pairs.map((pair) => pair.expected));
		// catches: a raw value that sends a refusal on to the ticket lookup or a sleep.
		expect(TRIPWIRE).toEqual([]);
	});

	test("mcp-p06: a non-string context and an unknown argument are refused by the tool", async () => {
		TRIPWIRE.length = 0;
		const control: GuardRow = {
			label: "acquire, context as an array of an absolute path",
			catches: "String() coercion ([path] reads as the path) or the array handed to the core",
			project: "none",
			tool: "claim_acquire",
			args: { ticket: TICKET, owner: OWNER, context: [CONTEXT] },
			code: "context-invalid",
			tickets: [TICKET, null],
			operationIds: [null],
		};
		const first = await guardViews([control]);
		// Positive control (catches: a stub answer; a non-string context that reaches not-configured).
		expect(first.actual).toEqual(first.expected);
		const { actual, expected } = await guardViews(GUARD_ROWS);
		// catches: per row as labelled; ignored arguments reach not-configured in this project, so they show.
		expect(actual).toEqual(expected);
		// catches: a guard that runs after the ticket lookup.
		expect(TRIPWIRE).toEqual([]);
	});

	test("mcp-p07: an env builder or core seam that throws ends as claim-error internal, never a throw", async () => {
		// Positive control (catches: a stub handler; a trap left armed by an earlier test).
		const control = await parity(PK_OWNER);
		expect(control.actual).toEqual(control.expected);
		const errors = spyOn(console, "error").mockImplementation(() => undefined);
		const writes = spyOn(process.stdout, "write").mockImplementation(() => true);
		const envViews: ResultView[] = [];
		let corePairs: ParityPair[] = [];
		let rawLogs: string[] = [];
		let stdoutWrites = -1;
		try {
			TRAP.env = true;
			for (const tool of SEVEN) envViews.push(await callView(envThrowLabel(tool), "lease", tool, THROW_ARGS[tool]));
			TRAP.env = false;
			TRAP.core = true;
			corePairs = await parities(CORE_THROW_ROWS);
		} finally {
			TRAP.env = false;
			TRAP.core = false;
			const raw = errors.mock.calls.filter(carriesRaw);
			rawLogs = raw.map((args) => Bun.inspect(args));
			stdoutWrites = writes.mock.calls.length;
			errors.mockRestore();
			writes.mockRestore();
		}
		// catches: a handler that throws, uses handleBacklogToolError (`details`, raw error), answers without isError,
		// a command other than its own, or echoes the raw message.
		expect(envViews.map(throwView)).toEqual(SEVEN.map(expectedThrowView));
		// catches: a fixture whose core seam does not end in the core's own internal document.
		expect(corePairs.map((pair) => pair.verdict)).toEqual(corePairs.map((pair) => pair.wanted));
		// catches: the core's internal document replaced, rebuilt without its operation ID, or rethrown.
		expect(corePairs.map((pair) => pair.actual)).toEqual(corePairs.map((pair) => pair.expected));
		// catches: console.error(error) of the generic MCP error path (mcp-errors.ts:84–98).
		expect(rawLogs).toEqual([]);
		// catches: printJson/run of the CLI writing to stdout, the stdio protocol channel.
		expect(stdoutWrites).toBe(0);
	});
});
