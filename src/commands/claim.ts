/**
 * `backlog claim <verb>` command group. Thin registration only: every verb is
 * spelled out, no default verb, no aliases; each action resolves the output mode first, calls the matching
 * `runClaim*` from `src/claims/surface/` and prints its document: `--json` always on stdout, errors included,
 * the human text on stdout or stderr by status. The exit code comes from the document; `process.exit` is never
 * called, so the output is always written completely.
 */
import type { Command } from "commander";
import { resolveClaimSettings } from "../claims/config/index.ts";
import { claimContextAuthority } from "../claims/context/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimCommand,
	type ClaimContextCreateInput,
	type ClaimDocument,
	type ClaimInstallEpochInput,
	type ClaimMutationCommand,
	type ClaimMutationInput,
	type ClaimNextInput,
	type ClaimReclaimScopeInput,
	type ClaimSurfaceEnv,
	type ClaimTicketSelection,
	claimErrorDocument,
	claimExitCode,
	runClaimContextCreate,
	runClaimContextShow,
	runClaimInit,
	runClaimInstallEpoch,
	runClaimList,
	runClaimMutation,
	runClaimNext,
	runClaimReclaimBatch,
	runClaimReclaimPreview,
	runClaimResolve,
	runClaimRetry,
	runClaimSetup,
} from "../claims/surface/index.ts";
import { Core } from "../core/backlog.ts";
import { baseEnv, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import { formatClaimDocumentText } from "../formatters/claim-text.ts";
import { printJson } from "../formatters/json-output.ts";
import { findBacklogRoot } from "../utils/find-backlog-root.ts";
import { type ReadOutputMode, type ReadOutputOptions, resolveReadOutputMode } from "../utils/read-output-mode.ts";
import { resolveRuntimeCwd } from "../utils/runtime-cwd.ts";
import { canonicalTaskId } from "../utils/task-id.ts";
import { addHelpSchema, type HelpField, type HelpSchema } from "./help-schema.ts";
import {
	createMultiValueAccumulator,
	mapTaskFilterOptions,
	resolveParentFilterId,
	type TaskFilterOptions,
} from "./task-filter-options.ts";

type MutationOptions = ReadOutputOptions & {
	owner?: string;
	context?: string;
	ttlMs?: string;
	hardEnd?: string;
	expectGeneration?: string;
	operationId?: string;
};

type ResolveOptions = ReadOutputOptions & { context?: string };
type RetryOptions = ReadOutputOptions & { context?: string };
type ListOptions = ReadOutputOptions & { ticket?: string; context?: string };
type SetupOptions = ReadOutputOptions & { endpoint?: string; storageFormat?: string; clockUncertaintyMs?: string };
type InitOptions = ReadOutputOptions;
type ContextCreateOptions = ReadOutputOptions & { parent?: string; recoverFrom?: string };
/** Read-only; local like context create, no project configuration. */
type ContextShowOptions = ReadOutputOptions & { context?: string };
/** The eighth transition action's own verb, patterned on registerTransfer. */
type EmergencyReleaseOptions = ReadOutputOptions & {
	context?: string;
	expectRoot?: string;
	preview?: boolean;
	operationId?: string;
};
/** The raw options of `claim install-epoch`. */
type InstallEpochOptions = ReadOutputOptions & {
	context?: string;
	expectEpoch?: string;
	isolationConfirmed?: boolean;
	storageFormat?: string;
	ticket?: string[];
	preview?: boolean;
};
/** Transfer, resume and change-bounds register on their own, not via registerMutation. */
type TransferOptions = ReadOutputOptions & {
	toContext?: string;
	owner?: string;
	context?: string;
	timeBox?: string;
	/** The new hard end of an explicit restart; foreign on every other time-box action. */
	hardEnd?: string;
	ttlMs?: string;
	expectGeneration?: string;
	operationId?: string;
};
type ResumeOptions = ReadOutputOptions & { context?: string; expectGeneration?: string; operationId?: string };
type ChangeBoundsOptions = ReadOutputOptions & {
	context?: string;
	mode?: string;
	leaseEnd?: string;
	hardEnd?: string;
	graceMs?: string;
	expectGeneration?: string;
	operationId?: string;
};
/**
 * `claim next`, its own verb; no `--operation-id`, no `--ready`, no `--sort`/`--limit`/
 * `--watch`. The task-list filter flags are those of `task list`, mapped by the shared module
 * `task-filter-options.ts`.
 */
type NextOwnOptions = {
	owner?: string;
	context?: string;
	ttlMs?: string;
	hardEnd?: string;
	order?: string;
	maxCandidates?: string;
};
type NextOptions = ReadOutputOptions & TaskFilterOptions & NextOwnOptions;
/**
 * `claim reclaim-batch`/`claim reclaim-preview`, no ticket argument. Scope only:
 * no `--operation-id`, no `--expect-generation` (both per ticket from the selection), no `--owner` (the acquire
 * display name), no `--limit`/`--sort`/window options. The task-list filter flags are those of `task list`, mapped
 * by the shared module `task-filter-options.ts`, same as `claim next`.
 */
type ReclaimOwnOptions = {
	context?: string;
	ticket?: string[];
	all?: boolean;
	claimOwner?: string[];
	ready?: boolean;
};
type ReclaimOptions = ReadOutputOptions & TaskFilterOptions & ReclaimOwnOptions;

const JSON_HELP = "print versioned machine-readable JSON output";
const PLAIN_HELP = "print plain, non-interactive text output";
const CONTEXT_FIELD: HelpField = {
	name: "--context",
	type: "absolute path",
	description: "private claim context from `backlog claim context create`; never derived, never printed",
};
const OUTPUT_FIELDS: HelpField[] = [
	{ name: "--json", type: "Boolean", description: JSON_HELP },
	{ name: "--plain", type: "Boolean", description: PLAIN_HELP },
];
const TICKET_FIELD: HelpField = { name: "ticket", type: "Task ID", description: "ticket to act on" };
const LOCAL_TICKET_FIELD: HelpField = {
	name: "ticket",
	type: "Task ID",
	description: "local ticket to claim; checked before any network",
};
const OWNER_FIELD: HelpField = { name: "--owner", type: "String", description: "display name only, never an identity" };
const TTL_FIELD: HelpField = {
	name: "--ttl-ms",
	type: "positive integer",
	description: "explicit lease length; else lease_ttl_ms",
};
const HARD_END_FIELD: HelpField = {
	name: "--hard-end",
	type: "ISO-8601 with time zone",
	description: "required in lifetime_mode hard",
};
const GENERATION_FIELD: HelpField = {
	name: "--expect-generation",
	type: "positive integer",
	description: "expected claim generation",
};
const OPERATION_ID_FIELD: HelpField = {
	name: "--operation-id",
	type: "String",
	description: "caller-chosen ID, at most 128 characters",
};
const OPERATION_ID_ARGUMENT: HelpField = { name: "operationId", type: "String", description: "printed operation ID" };
const OPERATION_OUTPUT = "JSON claim-operation document; claim-pause while own operations are open; claim-error";
// One schema line per option of transfer, resume and change-bounds, named by the option spelling.
const TO_CONTEXT_FIELD: HelpField = {
	name: "--to-context",
	type: "absolute path",
	description: "private claim context of the receiving agent on this host and user; read once, never printed",
};
const RECEIVER_FIELD: HelpField = {
	name: "--owner",
	type: "String",
	description: "display name of the receiving owner only, never an identity",
};
const TIME_BOX_FIELD: HelpField = {
	name: "--time-box",
	type: "one of: preserve, restart",
	description: "time-box action under a hard end; else claims.transfer_time_box",
};
/** Transfer only; valid only for a restart, else option-not-applicable. */
const TRANSFER_HARD_END_FIELD: HelpField = {
	name: "--hard-end",
	type: "ISO-8601 with time zone",
	description: "new hard deadline of a --time-box restart; a later one than the stored one uses the time path",
};
const RESUME_CONTEXT_FIELD: HelpField = {
	...CONTEXT_FIELD,
	description: "context created with --recover-from from the context that holds the claim; never printed",
};
const MODE_FIELD: HelpField = {
	name: "--mode",
	type: "one of: lease, hard, none",
	description: "must equal the stored mode",
};
const LEASE_END_FIELD: HelpField = {
	name: "--lease-end",
	type: "ISO-8601 with time zone",
	description: "absolute target lease end; required with --mode lease",
};
const BOUND_HARD_END_FIELD: HelpField = {
	name: "--hard-end",
	type: "ISO-8601 with time zone",
	description: "absolute target hard end; required with --mode hard, with --mode lease its absence removes it",
};
const GRACE_FIELD: HelpField = {
	name: "--grace-ms",
	type: "integer >= 0",
	description: "absolute target grace; required with --mode lease and hard",
};
// One schema line per option of emergency-release, named by the option spelling.
const OPERATOR_CONTEXT_FIELD: HelpField = {
	...CONTEXT_FIELD,
	description: "operator context whose authority ID is listed in claims.recovery_authorities; never printed",
};
const EXPECT_ROOT_FIELD: HelpField = {
	name: "--expect-root",
	type: "40 or 64 lowercase hex digits",
	description: "the exact root the preview showed; required unless --preview",
};
const PREVIEW_FIELD: HelpField = {
	name: "--preview",
	type: "Boolean",
	description: "show the state and the root; sends and records nothing; never with --expect-root",
};
// One schema line per option of install-epoch, named by the option spelling.
const EXPECT_EPOCH_FIELD: HelpField = {
	name: "--expect-epoch",
	type: "positive integer",
	description: "the epoch the descriptor holds now, as claim init shows it",
};
const ISOLATION_FIELD: HelpField = {
	name: "--isolation-confirmed",
	type: "Boolean",
	description: "your statement that every claim writer is cut off; recorded in every new claim, it proves nothing",
};
const STORAGE_FORMAT_FIELD: HelpField = {
	name: "--storage-format",
	type: "one of: blob, tree, commit-chain",
	description: "format of the new epoch; omitted keeps the current one",
};
const EPOCH_TICKET_FIELD: HelpField = {
	name: "--ticket",
	type: "Task ID",
	description: "also create a claim ref for this ticket without a local task file; repeatable",
};
const EPOCH_PREVIEW_FIELD: HelpField = {
	name: "--preview",
	type: "Boolean",
	description: "list what a run would write; writes nothing",
};
const RECOVER_FROM_FIELD: HelpField = {
	name: "--recover-from",
	type: "absolute path",
	description: "context whose claims the new context may resume; never printed",
};
// Claim next's own fields, one schema line per option, named by the option spelling.
const ORDER_FIELD: HelpField = {
	name: "--order",
	type: "one of: priority, age",
	description: "candidate order; default priority",
};
const MAX_CANDIDATES_FIELD: HelpField = {
	name: "--max-candidates",
	type: "integer 1 to 50",
	description: "attempt bound, counting every attempt; default 5",
};
const STATUS_FIELD: HelpField = {
	name: "--status",
	type: "String",
	description: "filter tasks by status; unlike task list, an unknown value is refused",
};
const EXCLUDE_STATUS_FIELD: HelpField = { name: "--exclude-status", type: "String", description: "exclude by status" };
const ASSIGNEE_FIELD: HelpField = { name: "--assignee", type: "String", description: "filter the Backlog field only" };
const UNASSIGNED_FIELD: HelpField = {
	name: "--unassigned",
	type: "Boolean",
	description: "filter tasks without an assignee; not the same as unclaimed",
};
const NEXT_MILESTONE_FIELD: HelpField = { name: "--milestone", type: "String", description: "filter by milestone" };
const NEXT_PARENT_FIELD: HelpField = { name: "--parent", type: "Task ID", description: "filter by parent task ID" };
const NEXT_PRIORITY_FIELD: HelpField = {
	name: "--priority",
	type: "String",
	description: "filter by configured priority",
};
const NEXT_TYPE_FIELD: HelpField = { name: "--type", type: "String", description: "filter by configured task type" };
const NEXT_PROJECT_FIELD: HelpField = {
	name: "--project",
	type: "String",
	description: "filter by configured project",
};
const LABELS_FIELD: HelpField = {
	name: "--labels",
	type: "String",
	description: "filter by labels, all comma-separated labels must match",
};
const SEARCH_FIELD: HelpField = { name: "--search", type: "String", description: "search title, description, notes" };

function hasInteractiveTTY(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Strict decimal digits only; anything else becomes NaN, which the core refuses as `invalid-option`. */
function integerOption(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	return /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
}

async function findProjectRoot(): Promise<string | null> {
	try {
		return await findBacklogRoot((await resolveRuntimeCwd()).cwd);
	} catch {
		return null;
	}
}

/**
 * The project of the working directory with its configuration read fresh for this call; a missing project or an
 * unreadable configuration is a refused document, never text on stderr. The env build itself lives in
 * `../core/claim-env.ts` so the MCP claim tools reuse exactly the same code, never a duplicate.
 */
async function projectEnv(command: ClaimCommand): Promise<ClaimSurfaceEnv | ClaimDocument> {
	const projectRoot = await findProjectRoot();
	if (projectRoot === null) return claimErrorDocument({ command, code: "project-not-found" });
	return claimProjectEnv(projectRoot, command);
}

/** Resolves the output mode before any work, so `--json --plain` never reaches the network; then prints. */
async function run(
	command: ClaimCommand,
	options: ReadOutputOptions,
	produce: () => Promise<ClaimDocument>,
): Promise<void> {
	let mode: ReadOutputMode;
	try {
		mode = resolveReadOutputMode(options, hasInteractiveTTY());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}
	let document: ClaimDocument;
	try {
		document = await produce();
	} catch {
		document = claimErrorDocument({ command, code: "internal" });
	}
	if (mode === "json") {
		printJson(document);
	} else {
		const { stdout, stderr } = formatClaimDocumentText(document);
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
	}
	process.exitCode = claimExitCode(document);
}

/** Runs `body` with the project environment, or returns the refusal that no project could be read. */
async function withProject(
	command: ClaimCommand,
	body: (env: ClaimSurfaceEnv) => Promise<ClaimDocument>,
): Promise<ClaimDocument> {
	const env = await projectEnv(command);
	return isClaimDocument(env) ? env : body(env);
}

function withOutputOptions(command: Command): Command {
	return command.option("--json", JSON_HELP).option("--plain", PLAIN_HELP);
}

/** Acquire adds `--owner` and `--hard-end`; renew/release/reclaim add `--expect-generation`. */
function registerMutation(claimCmd: Command, verb: ClaimMutationCommand, withTtl: boolean): void {
	const acquire = verb === "acquire";
	const required: HelpField[] = [acquire ? LOCAL_TICKET_FIELD : TICKET_FIELD];
	if (acquire) required.push(OWNER_FIELD);
	required.push(CONTEXT_FIELD);
	const optional: HelpField[] = [];
	if (withTtl) optional.push(TTL_FIELD);
	optional.push(acquire ? HARD_END_FIELD : GENERATION_FIELD, OPERATION_ID_FIELD, ...OUTPUT_FIELDS);
	let example = `backlog claim ${verb} {{TASK_ID:1}} --context <context> --json`;
	if (acquire) example = "backlog claim acquire {{TASK_ID:1}} --owner agent-a --context <context> --json";
	const command = claimCmd.command(`${verb} <ticket>`).description(`${verb} the claim of one ticket`);
	addHelpSchema(command, {
		reads: "Project claims configuration, the private context, the claim storage endpoint",
		writes: "One intent in the context journal and at most the ticket's claim ref; never a task file",
		required,
		optional,
		output: OPERATION_OUTPUT,
		examples: [example],
	});
	if (acquire) command.option("--owner <name>", "display name of the claiming owner");
	command.option("--context <path>", "absolute path to the private claim context");
	if (withTtl) command.option("--ttl-ms <ms>", "explicit lease time-to-live in milliseconds");
	if (acquire) command.option("--hard-end <iso>", "ISO-8601 hard deadline with a time zone");
	if (!acquire) command.option("--expect-generation <n>", "expected claim generation");
	command.option("--operation-id <id>", "caller-chosen operation identifier");
	withOutputOptions(command).action(async (ticket: string, options: MutationOptions) => {
		const input = {
			command: verb,
			ticket,
			context: options.context ?? "",
			owner: options.owner,
			ttlMs: integerOption(options.ttlMs),
			hardEnd: options.hardEnd,
			expectGeneration: integerOption(options.expectGeneration),
			operationId: options.operationId,
		};
		await run(verb, options, () => withProject(verb, (env) => runClaimMutation(input, env)));
	});
}

/**
 * `claim transfer <ticket>`, its own verb (not registerMutation, whose shape is acquire-shaped). Every
 * option is a plain `.option()`, never `.requiredOption()`, so a missing mandatory option reaches the core and ends
 * in its own refusal; the core input is built by conditional spread, never an explicit `undefined` field.
 */
function registerTransfer(claimCmd: Command): void {
	const command = claimCmd
		.command("transfer <ticket>")
		.description("transfer the claim of one ticket to another context");
	addHelpSchema(command, {
		reads: "Project claims configuration, the own and the target private context (target read only), the endpoint",
		writes: "One intent in the own context journal and at most the ticket's claim ref; never the target or a task file",
		required: [TICKET_FIELD, TO_CONTEXT_FIELD, RECEIVER_FIELD, CONTEXT_FIELD],
		optional: [
			TIME_BOX_FIELD,
			TRANSFER_HARD_END_FIELD,
			TTL_FIELD,
			GENERATION_FIELD,
			OPERATION_ID_FIELD,
			...OUTPUT_FIELDS,
		],
		output: OPERATION_OUTPUT,
		examples: [
			"backlog claim transfer {{TASK_ID:1}} --to-context <target context> --owner agent-b --context <context> --json",
		],
	});
	command.option("--to-context <path>", "absolute path of the private claim context receiving the claim");
	command.option("--owner <name>", "display name of the receiving owner");
	command.option("--context <path>", "absolute path to the private claim context");
	command.option("--time-box <action>", "preserve or restart the hard deadline's time box");
	command.option("--hard-end <iso>", "ISO-8601 hard deadline with a time zone");
	command.option("--ttl-ms <ms>", "explicit lease time-to-live in milliseconds");
	command.option("--expect-generation <n>", "expected claim generation");
	command.option("--operation-id <id>", "caller-chosen operation identifier");
	withOutputOptions(command).action(async (ticket: string, options: TransferOptions) => {
		const input: ClaimMutationInput = {
			command: "transfer",
			ticket,
			context: options.context ?? "",
			...(options.toContext !== undefined ? { toContext: options.toContext } : {}),
			...(options.owner !== undefined ? { owner: options.owner } : {}),
			...(options.timeBox !== undefined ? { timeBox: options.timeBox } : {}),
			...(options.hardEnd !== undefined ? { hardEnd: options.hardEnd } : {}),
			...(options.ttlMs !== undefined ? { ttlMs: integerOption(options.ttlMs) } : {}),
			...(options.expectGeneration !== undefined ? { expectGeneration: integerOption(options.expectGeneration) } : {}),
			...(options.operationId !== undefined ? { operationId: options.operationId } : {}),
		};
		await run("transfer", options, () => withProject("transfer", (env) => runClaimMutation(input, env)));
	});
}

/** `claim resume <ticket>`, its own verb; only the context, the generation guard and the operation ID. */
function registerResume(claimCmd: Command): void {
	const command = claimCmd.command("resume <ticket>").description("resume the claim of one ticket in its context");
	addHelpSchema(command, {
		reads: "Project claims configuration, the private context and its recovery proof, the claim storage endpoint",
		writes: "One intent in the own context journal and at most the ticket's claim ref; never the old context",
		required: [TICKET_FIELD, RESUME_CONTEXT_FIELD],
		optional: [GENERATION_FIELD, OPERATION_ID_FIELD, ...OUTPUT_FIELDS],
		output: OPERATION_OUTPUT,
		examples: ["backlog claim resume {{TASK_ID:1}} --context <replacement context> --json"],
	});
	command.option("--context <path>", "absolute path to the private claim context");
	command.option("--expect-generation <n>", "expected claim generation");
	command.option("--operation-id <id>", "caller-chosen operation identifier");
	withOutputOptions(command).action(async (ticket: string, options: ResumeOptions) => {
		const input: ClaimMutationInput = {
			command: "resume",
			ticket,
			context: options.context ?? "",
			...(options.expectGeneration !== undefined ? { expectGeneration: integerOption(options.expectGeneration) } : {}),
			...(options.operationId !== undefined ? { operationId: options.operationId } : {}),
		};
		await run("resume", options, () => withProject("resume", (env) => runClaimMutation(input, env)));
	});
}

/** `claim change-bounds <ticket>`, its own verb; the complete absolute target of one `--mode`. */
function registerChangeBounds(claimCmd: Command): void {
	const command = claimCmd
		.command("change-bounds <ticket>")
		.description("change the lifetime bounds of one ticket's claim");
	addHelpSchema(command, {
		reads: "Project claims configuration, the private context, the claim storage endpoint",
		writes: "One intent in the context journal and at most the ticket's claim ref; never a task file",
		required: [TICKET_FIELD, MODE_FIELD, CONTEXT_FIELD],
		optional: [
			LEASE_END_FIELD,
			BOUND_HARD_END_FIELD,
			GRACE_FIELD,
			GENERATION_FIELD,
			OPERATION_ID_FIELD,
			...OUTPUT_FIELDS,
		],
		output: OPERATION_OUTPUT,
		examples: [
			"backlog claim change-bounds {{TASK_ID:1}} --mode hard --hard-end <iso> --grace-ms 0 --context <context> --json",
		],
	});
	command.option("--context <path>", "absolute path to the private claim context");
	command.option("--mode <mode>", "lease, hard or none");
	command.option("--lease-end <iso>", "ISO-8601 lease end with a time zone");
	command.option("--hard-end <iso>", "ISO-8601 hard deadline with a time zone");
	command.option("--grace-ms <ms>", "reclaim grace period in milliseconds");
	command.option("--expect-generation <n>", "expected claim generation");
	command.option("--operation-id <id>", "caller-chosen operation identifier");
	withOutputOptions(command).action(async (ticket: string, options: ChangeBoundsOptions) => {
		const input: ClaimMutationInput = {
			command: "change-bounds",
			ticket,
			context: options.context ?? "",
			...(options.mode !== undefined ? { mode: options.mode } : {}),
			...(options.leaseEnd !== undefined ? { leaseEnd: options.leaseEnd } : {}),
			...(options.hardEnd !== undefined ? { hardEnd: options.hardEnd } : {}),
			...(options.graceMs !== undefined ? { graceMs: integerOption(options.graceMs) } : {}),
			...(options.expectGeneration !== undefined ? { expectGeneration: integerOption(options.expectGeneration) } : {}),
			...(options.operationId !== undefined ? { operationId: options.operationId } : {}),
		};
		await run("change-bounds", options, () => withProject("change-bounds", (env) => runClaimMutation(input, env)));
	});
}

/**
 * `claim emergency-release <ticket>`, its own verb, patterned on `registerTransfer`. No
 * `--owner`, `--expect-generation`, force flag or token: the authority is the listed context, the expectation
 * the exact root of `--preview`. Never over MCP.
 */
function registerEmergencyRelease(claimCmd: Command): void {
	const command = claimCmd
		.command("emergency-release <ticket>")
		.description("release the claim of one ticket with a separately granted authority");
	addHelpSchema(command, {
		reads: "Project claims configuration, the operator's private context, the claim storage endpoint",
		writes: "One intent in the operator's journal and at most the ticket's claim ref; with --preview nothing",
		required: [TICKET_FIELD, OPERATOR_CONTEXT_FIELD],
		optional: [EXPECT_ROOT_FIELD, PREVIEW_FIELD, OPERATION_ID_FIELD, ...OUTPUT_FIELDS],
		output: "JSON claim-emergency-preview document with --preview, else claim-operation; claim-error on refusal",
		examples: [
			"backlog claim emergency-release {{TASK_ID:1}} --context <operator context> --preview --json",
			"backlog claim emergency-release {{TASK_ID:1}} --context <operator context> --expect-root <root> --json",
		],
	});
	command.option("--context <path>", "absolute path to the operator's private claim context");
	command.option("--expect-root <oid>", "exact current root of the ticket's claim ref from --preview");
	command.option("--preview", "show the current state and root without sending anything");
	command.option("--operation-id <id>", "caller-chosen operation identifier");
	withOutputOptions(command).action(async (ticket: string, options: EmergencyReleaseOptions) => {
		const input: ClaimMutationInput = {
			command: "emergency-release",
			ticket,
			context: options.context ?? "",
			...(options.expectRoot !== undefined ? { expectRoot: options.expectRoot } : {}),
			...(options.preview ? { preview: true } : {}),
			...(options.operationId !== undefined ? { operationId: options.operationId } : {}),
		};
		await run("emergency-release", options, () =>
			withProject("emergency-release", (env) => runClaimMutation(input, env)),
		);
	});
}

/**
 * `claim install-epoch`, patterned on `registerEmergencyRelease`: the operator's listed
 * context, the expected epoch and the isolation statement; no ticket argument, no operation ID, no force flag.
 * `--expect-epoch` is read like `--expect-generation`: digits only, anything else is `invalid-option`.
 */
function registerInstallEpoch(claimCmd: Command): void {
	const command = claimCmd
		.command("install-epoch")
		.description("install the next claim storage epoch after a restore or for a format migration");
	addHelpSchema(command, {
		reads: "Project claims configuration, local tasks, the operator's private context, the claim storage endpoint",
		writes: "The descriptor, every claim ref and one archive ref per rewritten ticket; with --preview nothing",
		required: [OPERATOR_CONTEXT_FIELD, EXPECT_EPOCH_FIELD, ISOLATION_FIELD],
		optional: [STORAGE_FORMAT_FIELD, EPOCH_TICKET_FIELD, EPOCH_PREVIEW_FIELD, ...OUTPUT_FIELDS],
		output: "JSON claim-epoch-preview document with --preview, else claim-epoch; claim-error on refusal",
		examples: [
			"backlog claim install-epoch --context <operator handle> --expect-epoch 1 --isolation-confirmed --preview --json",
			"backlog claim install-epoch --context <operator handle> --expect-epoch 1 --isolation-confirmed --json",
		],
	});
	command.option("--context <path>", "absolute path to the operator's private claim context");
	command.option("--expect-epoch <n>", "the epoch the descriptor holds now");
	command.option(
		"--isolation-confirmed",
		"your statement that every claim writer is cut off, including in-flight receives",
	);
	command.option("--storage-format <format>", "target storage format; omitted keeps the current one");
	command.option(
		"--ticket <id>",
		"create a claim ref for this ticket as well; repeatable",
		createMultiValueAccumulator(),
	);
	command.option("--preview", "show what a run would install without writing anything");
	withOutputOptions(command).action(async (options: InstallEpochOptions) => {
		const input: ClaimInstallEpochInput = {
			context: options.context ?? "",
			// A missing value is NaN too, so the core refuses it as invalid-option like a malformed one.
			expectEpoch: integerOption(options.expectEpoch) ?? Number.NaN,
			isolationConfirmed: options.isolationConfirmed === true,
			...(options.storageFormat !== undefined ? { storageFormat: options.storageFormat } : {}),
			...(options.ticket !== undefined && options.ticket.length > 0 ? { tickets: options.ticket } : {}),
			...(options.preview ? { preview: true } : {}),
		};
		await run("install-epoch", options, () => withProject("install-epoch", (env) => runClaimInstallEpoch(input, env)));
	});
}

/**
 * The filter flags through the shared module with `--status` validated; a mapping failure, a blank-only
 * value or a `--parent` that names no single local task is `invalid-option`, never the `task list` text. Local only;
 * the claim core has not run yet.
 */
async function nextSelection(
	projectRoot: string,
	taskPrefix: string,
	options: TaskFilterOptions,
): Promise<ClaimTicketSelection | undefined> {
	const core = new Core(projectRoot);
	try {
		const mapped = await mapTaskFilterOptions(core, options, { validateStatus: true });
		if (mapped.kind === "invalid" || mapped.blank.length > 0) return undefined;
		const { filter, query, parent } = mapped;
		if (parent !== undefined) {
			try {
				filter.parentTaskId = await resolveParentFilterId(core, parent, canonicalTaskId(parent, taskPrefix));
			} catch {
				return undefined;
			}
		}
		return query === "" ? { filter } : { filter, query };
	} finally {
		core.disposeSearchService();
		core.disposeContentStore();
	}
}

/**
 * `claim next`, its own verb; no ticket argument, no `--operation-id`, no `--ready`, no
 * `--sort`/`--limit`/`--watch`. Every option is a plain `.option()`, never `.requiredOption()`; the core input is
 * built by conditional spread, never an explicit `undefined` field. The filter flags are mapped first, locally;
 * then the core checks the claim options, selects and attempts.
 */
function registerNext(claimCmd: Command): void {
	const command = claimCmd.command("next").description("acquire the claim of the best ready candidate ticket");
	addHelpSchema(command, {
		reads: "Project claims configuration, the local task corpus for the filter and readiness, the claim endpoint",
		writes: "One intent in the private context journal and at most one ticket's claim ref; never a task file",
		required: [OWNER_FIELD, CONTEXT_FIELD],
		optional: [
			TTL_FIELD,
			HARD_END_FIELD,
			ORDER_FIELD,
			MAX_CANDIDATES_FIELD,
			STATUS_FIELD,
			EXCLUDE_STATUS_FIELD,
			ASSIGNEE_FIELD,
			UNASSIGNED_FIELD,
			NEXT_MILESTONE_FIELD,
			NEXT_PARENT_FIELD,
			NEXT_PRIORITY_FIELD,
			NEXT_TYPE_FIELD,
			NEXT_PROJECT_FIELD,
			LABELS_FIELD,
			SEARCH_FIELD,
			...OUTPUT_FIELDS,
		],
		output: "JSON claim-next document (claim-error on refusal); status applied, rejected, or paused on a stop",
		examples: ["backlog claim next --owner agent-a --context <context> --json"],
	});
	command.option("--owner <name>", "display name of the claiming owner");
	command.option("--context <path>", "absolute path to the private claim context");
	command.option("--ttl-ms <ms>", "explicit lease time-to-live in milliseconds");
	command.option("--hard-end <iso>", "ISO-8601 hard deadline with a time zone");
	command.option("--order <order>", "candidate order: priority (default) or age");
	command.option("--max-candidates <n>", "attempt bound, counting every attempt; default 5");
	command.option(
		"--status <status>",
		"filter tasks by status; an unknown value is refused",
		createMultiValueAccumulator(),
	);
	command.option("--exclude-status <status>", "exclude tasks by status", createMultiValueAccumulator());
	command.option("--assignee <assignee>", "filter tasks by assignee");
	command.option("--unassigned", "filter tasks without an assignee");
	command.option("--milestone <milestone>", "filter tasks by milestone");
	command.option("--parent <taskId>", "filter tasks by parent task ID");
	command.option("--priority <priority>", "filter tasks by configured priority");
	command.option("--type <type>", "filter tasks by configured task type", createMultiValueAccumulator());
	command.option("--project <project>", "filter tasks by configured project", createMultiValueAccumulator());
	command.option(
		"--labels <labels>",
		"filter tasks by labels; require every comma-separated label",
		createMultiValueAccumulator(),
	);
	command.option("--search <query>", "search task title, description, notes, comments, and metadata");
	withOutputOptions(command).action(async (options: NextOptions) => {
		const produce = async (env: ClaimSurfaceEnv): Promise<ClaimDocument> => {
			const selection = await nextSelection(env.projectRoot, env.taskPrefix, options);
			if (selection === undefined) return claimErrorDocument({ command: "next", code: "invalid-option" });
			const input: ClaimNextInput = {
				context: options.context ?? "",
				...(options.owner !== undefined ? { owner: options.owner } : {}),
				...(options.ttlMs !== undefined ? { ttlMs: integerOption(options.ttlMs) } : {}),
				...(options.hardEnd !== undefined ? { hardEnd: options.hardEnd } : {}),
				...(options.order !== undefined ? { order: options.order } : {}),
				...(options.maxCandidates !== undefined ? { maxCandidates: integerOption(options.maxCandidates) } : {}),
				selection,
			};
			return runClaimNext(input, env);
		};
		await run("next", options, () => withProject("next", produce));
	});
}

/** `--ticket`, repeatable or comma-separated. Blanks travel through unchanged, so the
 * core's own scope check can refuse them instead of the CLI dropping them silently. */
function splitList(value: string): string[] {
	return value.split(",");
}

/** The shared module's blank-value report by its internal option name, mapped to the flag spelling. */
const BLANK_FLAG_NAMES: Record<string, string> = {
	status: "--status",
	excludeStatus: "--exclude-status",
	type: "--type",
	project: "--project",
	labels: "--labels",
	assignee: "--assignee",
	milestone: "--milestone",
	parent: "--parent",
	priority: "--priority",
	search: "--search",
};

function blankFlagName(name: string): string {
	return BLANK_FLAG_NAMES[name] ?? `--${name}`;
}

/**
 * The CLI's half of the scope. Task-list filters go through the shared
 * module exactly as `nextSelection` uses it, with `--status` validated; unlike `next`, a blank-only value is not
 * dropped here, it travels as `blankOptions` by flag spelling so `claimReclaimScope` can refuse a silently widened
 * scope. `--ticket`, `--all`, `--claim-owner` and `--ready` are read as given. Local only; the claim core has
 * not run yet.
 */
async function reclaimScopeInput(
	projectRoot: string,
	taskPrefix: string,
	options: ReclaimOptions,
): Promise<ClaimReclaimScopeInput | undefined> {
	const core = new Core(projectRoot);
	try {
		const mapped = await mapTaskFilterOptions(core, options, { validateStatus: true });
		if (mapped.kind === "invalid") return undefined;
		const { filter, query, parent, blank } = mapped;
		// A blank `--parent` stays in the module's blank report for the core instead of failing the lookup here.
		if (parent !== undefined && parent !== "") {
			try {
				filter.parentTaskId = await resolveParentFilterId(core, parent, canonicalTaskId(parent, taskPrefix));
			} catch {
				return undefined;
			}
		}
		const hasSelection = Object.keys(filter).length > 0 || query !== "" || blank.length > 0;
		const selection: ClaimTicketSelection = query === "" ? { filter } : { filter, query };
		const tickets = options.ticket?.flatMap(splitList);
		return {
			...(options.all !== undefined ? { all: options.all } : {}),
			...(tickets !== undefined ? { tickets } : {}),
			...(options.claimOwner !== undefined ? { claimOwners: options.claimOwner } : {}),
			...(hasSelection ? { selection } : {}),
			...(options.ready !== undefined ? { ready: options.ready } : {}),
			...(blank.length > 0 ? { blankOptions: blank.map(blankFlagName) } : {}),
		};
	} finally {
		core.disposeSearchService();
		core.disposeContentStore();
	}
}

// The scope fields of reclaim-batch and reclaim-preview, one schema line per option.
const RECLAIM_TICKET_FIELD: HelpField = {
	name: "--ticket",
	type: "Task ID",
	description: "ticket in the scope, repeatable or comma-separated; read directly, no local file needed",
};
const ALL_FIELD: HelpField = {
	name: "--all",
	type: "Boolean",
	description: "every claim ref of the endpoint; stands alone. A scope option or --all is required",
};
const CLAIM_OWNER_FIELD: HelpField = {
	name: "--claim-owner",
	type: "String",
	description: "stored display name of an active claim, byte-exact, repeatable (OR); not the assignee",
};
const READY_FIELD: HelpField = {
	name: "--ready",
	type: "Boolean",
	description: "only local tickets that are ready under the task list --ready rule",
};
const RECLAIM_SCOPE_FIELDS: HelpField[] = [
	RECLAIM_TICKET_FIELD,
	ALL_FIELD,
	CLAIM_OWNER_FIELD,
	STATUS_FIELD,
	EXCLUDE_STATUS_FIELD,
	ASSIGNEE_FIELD,
	UNASSIGNED_FIELD,
	NEXT_MILESTONE_FIELD,
	NEXT_PARENT_FIELD,
	NEXT_PRIORITY_FIELD,
	NEXT_TYPE_FIELD,
	NEXT_PROJECT_FIELD,
	LABELS_FIELD,
	SEARCH_FIELD,
	READY_FIELD,
];

const RECLAIM_HELP: Record<"reclaim-batch" | "reclaim-preview", HelpSchema> = {
	"reclaim-batch": {
		reads: "Project claims configuration, the local task files for task filters, the private context, the endpoint",
		writes: "Per candidate one intent in the context journal and at most its claim ref; never a task file",
		required: [CONTEXT_FIELD],
		optional: [...RECLAIM_SCOPE_FIELDS, ...OUTPUT_FIELDS],
		output: "JSON claim-reclaim-batch document, one claim reclaim document per candidate (claim-error on refusal)",
		examples: [
			"backlog claim reclaim-batch --ticket {{TASK_ID:1}} --context <context> --json",
			"backlog claim reclaim-batch --claim-owner agent-a --context <context> --json",
		],
	},
	"reclaim-preview": {
		reads: "Project claims configuration, the local task files for task filters, the context journal, the endpoint",
		required: [CONTEXT_FIELD],
		optional: [...RECLAIM_SCOPE_FIELDS, ...OUTPUT_FIELDS],
		output: "JSON claim-reclaim-preview document, a verdict per ticket (claim-error on refusal); status ok or unknown",
		examples: ["backlog claim reclaim-preview --all --context <context> --json"],
	},
};

/**
 * `claim reclaim-batch` (mutating) and `claim reclaim-preview` (read-only), one
 * scope shared between them. Every option is a plain `.option()`, never `.requiredOption()`; the core input is
 * built by conditional spread, never an explicit `undefined` field.
 */
function registerReclaim(claimCmd: Command, verb: "reclaim-batch" | "reclaim-preview"): void {
	const description =
		verb === "reclaim-batch" ? "reclaim every ticket a scope selects" : "preview a reclaim scope without sending";
	const command = claimCmd.command(verb).description(description);
	addHelpSchema(command, RECLAIM_HELP[verb]);
	command.option("--context <path>", "absolute path to the private claim context");
	command.option(
		"--ticket <id>",
		"ticket to include in the scope, repeatable or comma-separated",
		createMultiValueAccumulator(),
	);
	command.option("--all", "every observed claim; stands alone, not combined with another scope option");
	command.option(
		"--claim-owner <name>",
		"claim owner display name to include, repeatable (OR)",
		createMultiValueAccumulator(),
	);
	command.option(
		"--status <status>",
		"filter tasks by status; an unknown value is refused",
		createMultiValueAccumulator(),
	);
	command.option("--exclude-status <status>", "exclude tasks by status", createMultiValueAccumulator());
	command.option("--assignee <assignee>", "filter tasks by assignee");
	command.option("--unassigned", "filter tasks without an assignee");
	command.option("--milestone <milestone>", "filter tasks by milestone");
	command.option("--parent <taskId>", "filter tasks by parent task ID");
	command.option("--priority <priority>", "filter tasks by configured priority");
	command.option("--type <type>", "filter tasks by configured task type", createMultiValueAccumulator());
	command.option("--project <project>", "filter tasks by configured project", createMultiValueAccumulator());
	command.option(
		"--labels <labels>",
		"filter tasks by labels; require every comma-separated label",
		createMultiValueAccumulator(),
	);
	command.option("--search <query>", "search task title, description, notes, comments, and metadata");
	command.option("--ready", "restrict the scope to ready tickets");
	withOutputOptions(command).action(async (options: ReclaimOptions) => {
		const produce = async (env: ClaimSurfaceEnv): Promise<ClaimDocument> => {
			const scope = await reclaimScopeInput(env.projectRoot, env.taskPrefix, options);
			if (scope === undefined) return claimErrorDocument({ command: verb, code: "invalid-option" });
			const input = { scope, context: options.context ?? "" };
			return verb === "reclaim-batch" ? runClaimReclaimBatch(input, env) : runClaimReclaimPreview(input, env);
		};
		await run(verb, options, () => withProject(verb, produce));
	});
}

function registerResolve(claimCmd: Command): void {
	const command = claimCmd.command("resolve <operationId>").description("clarify one recorded claim operation");
	addHelpSchema(command, {
		reads: "The context journal and the claim storage; never sends",
		required: [OPERATION_ID_ARGUMENT, CONTEXT_FIELD],
		optional: OUTPUT_FIELDS,
		output: "JSON claim-resolution document (claim-error on refusal); status applied, rejected, unknown(-history)",
		examples: ["backlog claim resolve op-<uuid> --context <context> --json"],
	});
	command.option("--context <path>", "absolute path to the private claim context");
	withOutputOptions(command).action(async (operationId: string, options: ResolveOptions) => {
		const input = { operationId, context: options.context ?? "" };
		await run("resolve", options, () => withProject("resolve", (env) => runClaimResolve(input, env)));
	});
}

function registerRetry(claimCmd: Command): void {
	const command = claimCmd.command("retry <operationId>").description("resend an open recorded claim operation");
	addHelpSchema(command, {
		reads: "The context journal and the claim storage",
		writes: "The identical recorded change, only while it is still open; never a new intent or ID",
		required: [OPERATION_ID_ARGUMENT, CONTEXT_FIELD],
		optional: OUTPUT_FIELDS,
		output: "JSON claim-operation document (claim-error on refusal); retry never pauses",
		examples: ["backlog claim retry op-<uuid> --context <context> --json"],
	});
	command.option("--context <path>", "absolute path to the private claim context");
	withOutputOptions(command).action(async (operationId: string, options: RetryOptions) => {
		const input = { operationId, context: options.context ?? "" };
		await run("retry", options, () =>
			withProject("retry", async (env) => runClaimRetry(input, env, await releaseAuthority(input.context, env))),
		);
	});
}

/**
 * `claim retry` passes `{administrative: true}` only after it re-ran the release
 * authorisation itself, the configured `claims.recovery_authorities` against the authority ID of `--context`. The
 * core resends a release record only with it and refuses one without it (`authority-required`); records of every
 * other action ignore it. MCP never passes it.
 */
async function releaseAuthority(context: string, env: ClaimSurfaceEnv): Promise<{ administrative: true } | undefined> {
	const resolved = resolveClaimSettings(env.claimsYaml);
	if (resolved.kind !== "configured") return undefined;
	const derived = await claimContextAuthority({ directory: context, io: env.contextIO });
	if (derived.kind !== "derived") return undefined;
	const listed = resolved.settings.recoveryAuthorities?.includes(derived.authorityId) === true;
	return listed ? { administrative: true } : undefined;
}

function registerList(claimCmd: Command): void {
	const command = claimCmd.command("list").description("list observed claims");
	addHelpSchema(command, {
		reads: "The claim storage endpoint; with --context also the rights of that context",
		required: [],
		optional: [
			{ name: "--ticket", type: "Task ID", description: "restrict the listing to one ticket" },
			{ ...CONTEXT_FIELD, description: "adds the rights of this context to every entry" },
			...OUTPUT_FIELDS,
		],
		output: "JSON claim-list document (claim-error on refusal, never an empty list); status ok or unknown",
		examples: ["backlog claim list --json", "backlog claim list --ticket {{TASK_ID:1}} --context <context> --json"],
	});
	command.option("--ticket <id>", "restrict the listing to one ticket");
	command.option("--context <path>", "absolute path to the private claim context");
	withOutputOptions(command).action(async (options: ListOptions) => {
		const input = { ticket: options.ticket, context: options.context };
		await run("list", options, () => withProject("list", (env) => runClaimList(input, env)));
	});
}

function registerSetup(claimCmd: Command): void {
	const command = claimCmd.command("setup").description("write the claims configuration block");
	addHelpSchema(command, {
		writes: "A new claims block with twelve keys in the project configuration; never overwrites an existing block",
		required: [
			{
				name: "--endpoint",
				type: "Git URL",
				description: "explicit git://, ssh://, http://, https:// or file:// URL without credentials",
			},
			{ name: "--storage-format", type: "one of: blob, tree, commit-chain" },
			{ name: "--clock-uncertainty-ms", type: "integer >= 0", description: "assured maximum host clock deviation" },
		],
		optional: OUTPUT_FIELDS,
		output: "JSON claim-setup document with the written key names (claim-error on refusal); status ok",
		examples: ["backlog claim setup --endpoint <url> --storage-format blob --clock-uncertainty-ms 2000 --json"],
	});
	command.option("--endpoint <url>", "claim coordination endpoint URL without credentials");
	command.option("--storage-format <format>", "claim storage format");
	command.option("--clock-uncertainty-ms <ms>", "largest deviation of any host clock from the true time, in ms");
	withOutputOptions(command).action(async (options: SetupOptions) => {
		const input = {
			endpoint: options.endpoint,
			storageFormat: options.storageFormat,
			clockUncertaintyMs: integerOption(options.clockUncertaintyMs),
		};
		await run("setup", options, () => withProject("setup", (env) => runClaimSetup(input, env)));
	});
}

function registerInit(claimCmd: Command): void {
	const command = claimCmd.command("init").description("initialize the claim coordination area");
	addHelpSchema(command, {
		reads: "Project claims configuration and the claim storage endpoint",
		writes: "The storage descriptor of an empty coordination area; allowed while claims are disabled",
		required: [],
		optional: OUTPUT_FIELDS,
		output: "JSON claim-init document with result created or exists (claim-error on refusal); status ok",
		examples: ["backlog claim init --json"],
	});
	withOutputOptions(command).action(async (options: InitOptions) => {
		await run("init", options, () => withProject("init", (env) => runClaimInit(env)));
	});
}

function registerContext(claimCmd: Command): void {
	const contextCmd = claimCmd.command("context").description("manage private claim contexts");
	const command = contextCmd.command("create").description("create a private claim context");
	addHelpSchema(command, {
		writes: "A new private context directory under the parent; the path is never printed",
		required: [{ name: "--parent", type: "absolute path", description: "existing private directory with mode 0700" }],
		optional: [RECOVER_FROM_FIELD, ...OUTPUT_FIELDS],
		output: "JSON claim-context document with the context ID only (claim-error on refusal); status ok",
		examples: [
			"backlog claim context create --parent <private directory> --json",
			"backlog claim context create --parent <private directory> --recover-from <old context> --json",
		],
	});
	command.option("--parent <dir>", "private 0700 parent directory for the new claim context");
	// The recovery source; its failures keep the context create codes.
	command.option("--recover-from <path>", "absolute path of a private context to recover the claim's proof from");
	withOutputOptions(command).action(async (options: ContextCreateOptions) => {
		const env = baseEnv(process.cwd(), undefined, "task");
		const input: ClaimContextCreateInput = {
			parent: options.parent ?? "",
			...(options.recoverFrom !== undefined ? { recoverFrom: options.recoverFrom } : {}),
		};
		await run("context-create", options, () => runClaimContextCreate(input, env));
	});
	// Read-only and local like create; prints the context ID and its authority ID only.
	const show = contextCmd
		.command("show")
		.description("show the context id and authority id of a private claim context");
	addHelpSchema(show, {
		reads: "The private context only; no project configuration and no network",
		required: [CONTEXT_FIELD],
		optional: OUTPUT_FIELDS,
		output: "JSON claim-context document with the context ID and its authority ID (claim-error on refusal); status ok",
		examples: ["backlog claim context show --context <context> --json"],
	});
	show.option("--context <path>", "absolute path to the private claim context");
	withOutputOptions(show).action(async (options: ContextShowOptions) => {
		const env = baseEnv(process.cwd(), undefined, "task");
		await run("context-show", options, () => runClaimContextShow({ context: options.context ?? "" }, env));
	});
}

/** The group help carries the status/exit table, generated from the constant so it cannot drift. */
function exitCodeTable(): string {
	const rows = Object.entries(CLAIM_EXIT_CODES).map(([status, code]) => `  ${status.padEnd(17)} ${code}`);
	return [
		"",
		"Exit codes (status and exit code; Commander usage errors also exit 1):",
		...rows,
		"",
		"Guide: backlog instructions claims",
		"",
	].join("\n");
}

export function registerClaimCommand(program: Command): void {
	const claimCmd = program.command("claim").description("coordinate ticket claims across cooperating agents");
	claimCmd.addHelpText("after", exitCodeTable);
	registerMutation(claimCmd, "acquire", true);
	registerMutation(claimCmd, "renew", true);
	registerMutation(claimCmd, "release", false);
	registerMutation(claimCmd, "reclaim", false);
	registerTransfer(claimCmd);
	registerResume(claimCmd);
	registerChangeBounds(claimCmd);
	registerEmergencyRelease(claimCmd);
	registerInstallEpoch(claimCmd);
	registerNext(claimCmd);
	registerReclaim(claimCmd, "reclaim-batch");
	registerReclaim(claimCmd, "reclaim-preview");
	registerResolve(claimCmd);
	registerRetry(claimCmd);
	registerList(claimCmd);
	registerSetup(claimCmd);
	registerInit(claimCmd);
	registerContext(claimCmd);
}
