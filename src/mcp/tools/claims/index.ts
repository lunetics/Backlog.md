/**
 * The claim lifecycle over MCP on the same core as the CLI. No
 * `createSimpleValidatedTool` — the claim core validates every value itself, so a weakened generic validator would
 * only mask a caller's mistake as the wrong error kind. Every call builds the environment afresh from the
 * server's current project root, answers the CLI document of `backlog claim <verb> --json` unchanged, and
 * never throws.
 */
import {
	type ClaimDocument,
	type ClaimErrorCode,
	type ClaimMutationInput,
	type ClaimStatus,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimReclaimScope,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../../../claims/surface/index.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../../../core/claim-env.ts";
import { formatJson } from "../../../formatters/json-output.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult, McpToolHandler } from "../../types.ts";
import type { JsonSchema } from "../../validation/validators.ts";

/** Acquire, renew, release, reclaim, resolve, list, plus retry (the only way out of a pause). */
export const CLAIM_TOOL_NAMES = [
	"claim_acquire",
	"claim_renew",
	"claim_release",
	"claim_reclaim",
	"claim_resolve",
	"claim_list",
	"claim_retry",
] as const;

export type ClaimToolName = (typeof CLAIM_TOOL_NAMES)[number];

/** A subset of `ClaimCommand`; `claimProjectEnv(…, command)` makes any other name a compile error. */
type ClaimToolCommand = "acquire" | "renew" | "release" | "reclaim" | "resolve" | "list" | "retry";
/** Parameter names are the keys of `ClaimMutationInput`, so the core's "needs --context" maps one to one. */
type ClaimToolParameter = "ticket" | "owner" | "context" | "ttlMs" | "hardEnd" | "expectGeneration" | "operationId";
type ClaimToolSpec = {
	command: ClaimToolCommand;
	/** The tool's own property set; any other argument name is refused, even where the core is lenient. */
	parameters: readonly ClaimToolParameter[];
	/** Only ticket resp. operationId; owner and context are the core's to check, so the error kinds are the CLI's. */
	required: readonly ClaimToolParameter[];
	annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean };
};

/** The core command, the property set and the hints of each tool (a writing tool states its hint). */
const CLAIM_TOOLS: Record<ClaimToolName, ClaimToolSpec> = {
	claim_acquire: {
		command: "acquire",
		parameters: ["ticket", "owner", "context", "ttlMs", "hardEnd", "operationId"],
		required: ["ticket"],
		annotations: { title: "Acquire Claim", readOnlyHint: false, destructiveHint: false },
	},
	claim_renew: {
		command: "renew",
		parameters: ["ticket", "context", "ttlMs", "expectGeneration", "operationId"],
		required: ["ticket"],
		annotations: { title: "Renew Claim", readOnlyHint: false, destructiveHint: false },
	},
	claim_release: {
		command: "release",
		parameters: ["ticket", "context", "expectGeneration", "operationId"],
		required: ["ticket"],
		annotations: { title: "Release Claim", readOnlyHint: false, destructiveHint: true },
	},
	claim_reclaim: {
		command: "reclaim",
		parameters: ["ticket", "context", "expectGeneration", "operationId"],
		required: ["ticket"],
		annotations: { title: "Reclaim Claim", readOnlyHint: false, destructiveHint: true },
	},
	claim_resolve: {
		command: "resolve",
		parameters: ["operationId", "context"],
		required: ["operationId"],
		annotations: { title: "Resolve Claim", readOnlyHint: true, destructiveHint: false },
	},
	claim_list: {
		command: "list",
		parameters: ["ticket", "context"],
		required: [],
		annotations: { title: "List Claims", readOnlyHint: true, destructiveHint: false },
	},
	claim_retry: {
		command: "retry",
		parameters: ["operationId", "context"],
		required: ["operationId"],
		annotations: { title: "Retry Claim", readOnlyHint: false, destructiveHint: false },
	},
};

/** Integers are typed as integers for the client; only the core validates them. */
const PARAMETER_TYPES: Record<ClaimToolParameter, "string" | "integer"> = {
	ticket: "string",
	owner: "string",
	context: "string",
	ttlMs: "integer",
	hardEnd: "string",
	expectGeneration: "integer",
	operationId: "string",
};

// Fixed sentences, pinned by mcp-p02.
const ADMINISTRATION_SENTENCE = [
	"Administrative recovery (emergency release, transfer, resume, change-bounds, setup, init, context creation)",
	"is not exposed over MCP; use the backlog CLI.",
].join(" ");
const LOST_REPLY_SENTENCE = "Pass operationId to resolve or retry after a lost reply.";
const CONTEXT_SENTENCE = "context is the absolute path of your private claim context and is never echoed.";
const LIST_SENTENCE = "Owner names are display data only; unknown is not free.";

function returnsSentence(verb: string): string {
	return `Returns the claim JSON document of \`backlog claim ${verb} --json\`; status replaces the exit code.`;
}

function mutatingDescription(lead: string, verb: string): string {
	return [lead, returnsSentence(verb), LOST_REPLY_SENTENCE, CONTEXT_SENTENCE, ADMINISTRATION_SENTENCE].join(" ");
}

export const CLAIM_TOOL_DESCRIPTIONS: Record<ClaimToolName, string> = {
	claim_acquire: mutatingDescription("Acquire the claim of one ticket for owner.", "acquire"),
	claim_renew: mutatingDescription("Renew the claim of one ticket.", "renew"),
	claim_release: mutatingDescription("Release the claim of one ticket.", "release"),
	claim_reclaim: mutatingDescription("Reclaim the claim of one ticket after its reclaim boundary.", "reclaim"),
	claim_resolve: [
		"Clarify one recorded claim operation.",
		returnsSentence("resolve"),
		CONTEXT_SENTENCE,
		ADMINISTRATION_SENTENCE,
	].join(" "),
	claim_list: [
		"List observed claims, or the claim of one ticket.",
		returnsSentence("list"),
		CONTEXT_SENTENCE,
		LIST_SENTENCE,
		ADMINISTRATION_SENTENCE,
	].join(" "),
	claim_retry: mutatingDescription("Resend an open recorded claim operation.", "retry"),
};

function claimToolSchema(tool: ClaimToolName): JsonSchema {
	const { parameters, required } = CLAIM_TOOLS[tool];
	const properties: Record<string, JsonSchema> = {};
	for (const parameter of parameters) properties[parameter] = { type: PARAMETER_TYPES[parameter] };
	return { type: "object", properties, required: [...required], additionalProperties: false };
}

type ClaimOperationInput = Parameters<typeof runClaimResolve>[0];
type ClaimListInput = Parameters<typeof runClaimList>[0];

/** The raw core input of one call: `ClaimMutationInput` with its command, or the input of resolve, retry or list. */
export type ClaimToolInput = ClaimMutationInput | ClaimOperationInput | ClaimListInput;

/** The two refusals the tool answers itself: a non-string context and an unknown argument name. */
export type ClaimToolRefusal = Extract<ClaimErrorCode, "context-invalid" | "option-not-applicable">;

/**
 * Pure: values pass RAW — no trim, no CR normalisation, no number coercion — so the core
 * decides every refusal exactly as for the CLI; `null` counts as absent and no key is ever set to `undefined`. A
 * missing context is `""` like claim.ts `options.context ?? ""`, except for list, which passes it as absent. A
 * present non-string context is refused here, because the core's `isAbsolute` expects a string.
 */
export function claimToolInput(
	tool: ClaimToolName,
	args: Record<string, unknown> | undefined,
): ClaimToolInput | ClaimToolRefusal {
	const { command, parameters } = CLAIM_TOOLS[tool];
	const raw: Record<string, unknown> = args ?? {};
	const given = Object.entries(raw).filter(([, value]) => value !== null && value !== undefined);
	const known: readonly string[] = parameters;
	if (given.some(([name]) => !known.includes(name))) return "option-not-applicable";
	const fields: Record<string, unknown> = Object.fromEntries(given);
	if (fields.context !== undefined && typeof fields.context !== "string") return "context-invalid";
	if (command === "list") return fields as ClaimListInput;
	const input: Record<string, unknown> = { ...fields, context: fields.context ?? "" };
	if (command === "resolve" || command === "retry") return input as ClaimOperationInput;
	const mutation: Record<string, unknown> = { command, ...input };
	return mutation as ClaimMutationInput;
}

/** The stderr partition of claim-text.ts; rejected, unknown and paused are results, not tool errors. */
const TOOL_ERROR_STATUSES: readonly ClaimStatus[] = ["refused", "unavailable", "internal"];

/**
 * Pure: the CLI document unchanged as `structuredContent`, its `--json` bytes as the one
 * text item, and `isError` by status; the status replaces the exit code.
 */
export function claimToolResult(document: ClaimDocument): CallToolResult {
	return {
		content: [{ type: "text", text: formatJson(document) }],
		structuredContent: document,
		isError: TOOL_ERROR_STATUSES.includes(document.status),
	};
}

/**
 * The ticket of a tool-own refusal, as the core would carry it: the canonical form of a valid `ticket` argument of a
 * tool that takes one, else null. `claimReclaimScope` is the core's exported pure path to its canonical ticket rule,
 * so no second rule exists here.
 */
function refusalTicket(
	tool: ClaimToolName,
	args: Record<string, unknown> | undefined,
	taskPrefix: string,
): string | null {
	const ticket = args?.ticket;
	if (!CLAIM_TOOLS[tool].parameters.includes("ticket") || typeof ticket !== "string") return null;
	const scope = claimReclaimScope({ tickets: [ticket] }, taskPrefix);
	if (typeof scope === "string") return null;
	return scope.tickets?.[0] ?? null;
}

/** The core entry of each command; the raw input is the core's to validate (surface `ClaimMutationInput`). */
function runCore(command: ClaimToolCommand, input: ClaimToolInput, env: ClaimSurfaceEnv): Promise<ClaimDocument> {
	if (command === "resolve") return runClaimResolve(input as ClaimOperationInput, env);
	if (command === "retry") return runClaimRetry(input as ClaimOperationInput, env);
	if (command === "list") return runClaimList(input as ClaimListInput, env);
	return runClaimMutation(input as ClaimMutationInput, env);
}

/**
 * One call: the environment of the server's current project, read fresh (never the server's cached
 * configuration), with `seams` spread per call; then the tool's own refusals, then the core. Any exception ends as
 * the tool command's `claim-error internal`, never as a throw, a log line or the generic MCP error path.
 */
async function answer(
	server: McpServer,
	tool: ClaimToolName,
	args: Record<string, unknown> | undefined,
	seams: ClaimEnvSeams | undefined,
): Promise<ClaimDocument> {
	const { command } = CLAIM_TOOLS[tool];
	try {
		const env = await claimProjectEnv(server.filesystem.rootDir, command, seams);
		if (isClaimDocument(env)) return env;
		const input = claimToolInput(tool, args);
		if (typeof input === "string") {
			return claimErrorDocument({ command, code: input, ticket: refusalTicket(tool, args, env.taskPrefix) });
		}
		return await runCore(command, input, env);
	} catch {
		return claimErrorDocument({ command, code: "internal" });
	}
}

/**
 * Registers the seven claim tools in the full tool set (independent of the claims
 * configuration, never in the fallback). `seams` are test seams, handed to every call unchanged.
 */
export function registerClaimTools(server: McpServer, seams?: ClaimEnvSeams): void {
	for (const name of CLAIM_TOOL_NAMES) {
		const tool: McpToolHandler = {
			name,
			description: CLAIM_TOOL_DESCRIPTIONS[name],
			inputSchema: claimToolSchema(name),
			annotations: CLAIM_TOOLS[name].annotations,
			handler: async (args) => claimToolResult(await answer(server, name, args, seams)),
		};
		server.addTool(tool);
	}
}
