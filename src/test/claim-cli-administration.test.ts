/**
 * End-to-end contract of the administration commands: the real `backlog claim transfer|resume|change-bounds …` and
 * `backlog claim context create --recover-from` subprocesses in a real Backlog project against the loopback Git daemon
 * for blob, tree and commit-chain, with scripted receive hooks (S1, test-local), the StallProxy connection counter,
 * private contexts, a byte copy and recovery contexts. Every JSON document is checked against a test-local validator
 * whose closed lists grow by the three commands, the three actions and the four new codes; every stdout and stderr is
 * scanned for both owner names (allowed only in claim-list entries), for path, binding, recovery binding, secret and
 * context ID of every handle, copy and recovery context, and for endpoints, server roots and journal digests. Cases
 * whose logic does not depend on the storage format run with blob only. The CLI runs on the real clock: hard ends come
 * from Date.now() in the test, fresh lease windows are checked as an interval around the call, planted states carry
 * fixed values. Every test starts with a positive control the scaffold cannot satisfy. Follow-up mutating calls run
 * only against a changed root, from another context, on another ticket or after a plan rejection that recorded
 * nothing; cpau-01 checks the pause on purpose. The harness is an adapted copy of claim-cli.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";
import { type ClaimContext, createClaimContext, loadClaimContext } from "../claims/context/index.ts";
import {
	type ClaimStorageFormat,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, type ReceivePhase, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-cli.test.ts:33-99: BlockOptions gains the policy key, Output the one context ID a
// `context create` document may carry, HelpView the schema fields, LocalRow the command; unused base types left out.
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
type Mode = "lease" | "hard" | "none";
type BlockOptions = {
	endpoint: string;
	format: ClaimStorageFormat;
	enabled: boolean;
	mode: Mode;
	ttlMs: number;
	graceMs: number;
	timeoutMs: number;
	attempts: number;
	budgetMs: number;
	/** The three surface keys; null leaves the key out of the block. */
	epsMs: number | null;
	pauseBaseMs: number | null;
	pauseMaxMs: number | null;
	/** `claims.transfer_time_box`, a string so that an invalid value can be written; null leaves it out. */
	timeBoxPolicy: string | null;
};
type CaseSetup = { descriptor?: boolean; block?: Partial<BlockOptions> | null };
type ContextHandle = { context: ClaimContext; directory: string };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type CliRun = { exit: number; stdout: string; stderr: string; ms: number };
type JsonRun = CliRun & { doc: unknown };
/** `allowedId`: the only context ID an output may carry, the one its `context create` document just created. */
type Output = { command: string; text: string; ownerAllowed: boolean; allowedId: string | null };
type Sentinel = readonly [label: string, value: string];
type JournalRecord = { name: string; digest: string; parameterDigest: string };
/** Kinds, codes, facts and counts of one JSON document; the message is never compared. */
type CliView = {
	exit: number;
	schema: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	code: unknown;
	action: unknown;
	outcome: unknown;
	rejection: unknown;
	storage: unknown;
	query: unknown;
	sends: unknown;
	stoppedBy: unknown;
	ownership: unknown;
	operationId: unknown;
};
type EntryView = { ticket: unknown; state: unknown; owner: unknown; claimGeneration: unknown; ownership: unknown };
type ListView = {
	exit: number;
	schema: string[];
	kind: unknown;
	status: unknown;
	complete: unknown;
	claims: EntryView[] | null;
};
type PlainView = { exit: number; stream: string; head: string | null; codeShown: boolean | null };
/** `fields`: options without their own schema line (help-schema.ts:31-35 renders `  - <name>: <type>`). */
type HelpView = { command: string; exit: number; missing: string[]; kind: boolean; json: boolean; fields: string[] };
type Shape = { required: readonly string[]; optional: readonly string[] };
type LocalRow = { label: string; catches: string; command: string; args: string[]; code: string };
/** Ownership, generation and work right of a RightsView; scope and reclaim stay out. */
type RightsFacts = { ownership: unknown; claimGeneration: unknown; workRight: unknown };
/** A send whose pre-receive invocation `held` is scripted to hold past the attempt timeout, then reject. */
type Lost = { run: JsonRun; held: number };

// adapted from claim-cli.test.ts:101-181: an own sentinel, the receiver name and the chain timeout are new; the
// foreign binding, the escape owner, the template keys and the base help lists are left out.
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** crt-01 loses four replies per format, each after LOSS_TIMEOUT plus one query, in about 16 calls [?]. */
const CHAIN_TEST_TIMEOUT = 180_000;
/** attempt_timeout_ms of healthy cases, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of lost-reply cases; every scripted hold outlasts it (LOSS_TIMEOUT). */
const LOSS_TIMEOUT = 2_000;
/** attempt_timeout_ms of the case that must contact the stalled endpoint (claim-rights-query.test.ts:31). */
const STALL_TIMEOUT = 750;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context, copy and endpoint paths and in hook stderr; no output may contain it. */
const SENTINEL = "SENTINEL-cli-admin-7d1c";
/** Owner of every acquired or planted claim; a display name only, allowed in list entries only. */
const OWNER = "agent-owner-karl";
/** The --owner of every transfer; like OWNER it may appear in list entries only. */
const RECEIVER = "agent-receiver-franz";
const OWNER_NAMES: readonly Sentinel[] = [
	["owner", OWNER],
	["receiver", RECEIVER],
];
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
const TICKETS = [TICKET, SECOND, THIRD];
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
/** Stands for a planned lease end inside [t0 + ttl, t1 + ttl] around the call ("Zeit"). */
const IN_WINDOW = "(fresh window around the call)";
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-execution-retry.test.ts:82
const ABSENT_REF = "(no ref)";
/** The closed status and exit code table. */
const EXIT: Record<Status, number> = {
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
/** The three verbs; the group help lists each. */
const NEW_COMMANDS = ["transfer", "resume", "change-bounds"];
/** cdoc-01: every option of the transfer command has its own schema line. */
const TRANSFER_FIELDS = [
	"--to-context",
	"--owner",
	"--context",
	"--time-box",
	"--ttl-ms",
	"--expect-generation",
	"--operation-id",
];
/** cdoc-01: command, document kind and the options its help schema documents. */
const NEW_HELP = [
	["resume", "claim-operation", ["--context", "--expect-generation", "--operation-id"]],
	[
		"change-bounds",
		"claim-operation",
		["--mode", "--lease-end", "--hard-end", "--grace-ms", "--context", "--expect-generation", "--operation-id"],
	],
	["context create", "claim-context", ["--parent", "--recover-from"]],
] as const;
/** cdoc-02 (and pcod-02): terms the guide printed by the CLI carries. */
const GUIDE_TERMS = [
	"claim transfer",
	"--to-context",
	"claim resume",
	"--recover-from",
	"claim change-bounds",
	"--mode",
	"transfer_time_box",
	"time-box-required",
	"requires-time-path",
	"lease-required",
	"mode-change",
	"target-context-invalid",
	"target-context-unavailable",
	"recovery-missing",
	"bounds-required",
];

// doc-04 of claim-cli.test.ts: the documented schema, independent of the module under test.
// adapted from claim-cli.test.ts:182-234; COMMANDS gains the three commands, ACTIONS the three actions and
// ERROR_CODES the four codes, nothing else.
const ENVELOPE = ["schemaVersion", "kind", "status", "command"];
const SHAPES: Record<string, Shape> = {
	"claim-operation": {
		required: [
			"action",
			"ticket",
			"operationId",
			"outcome",
			"rejection",
			"storage",
			"sends",
			"stoppedBy",
			"planned",
			"rights",
		],
		// A time-path call adds the optional `transition`.
		optional: ["transition"],
	},
	"claim-pause": { required: ["action", "ticket", "operationId", "pause", "rights"], optional: [] },
	"claim-resolution": { required: ["operationId", "ticket", "action", "outcome", "query"], optional: [] },
	"claim-list": { required: ["complete", "observedAt", "claims"], optional: [] },
	"claim-setup": { required: ["keys"], optional: [] },
	"claim-init": { required: ["result", "format", "epoch"], optional: [] },
	"claim-context": { required: ["contextId"], optional: [] },
	"claim-error": {
		required: ["code", "message", "ticket", "operationId"],
		optional: ["problems", "configuredFormat", "existingFormat"],
	},
};
const STATUSES: readonly unknown[] = Object.keys(EXIT);
/** The base commands plus the three administration commands. */
const COMMANDS: readonly unknown[] = `
	acquire renew release reclaim resolve retry list setup init context-create
	transfer resume change-bounds
`
	.trim()
	.split(/\s+/);
/** The seven transition actions; command name = action name. */
const ACTIONS: readonly unknown[] = ["acquire", "renew", "release", "reclaim", "transfer", "resume", "change-bounds"];
const OUTCOMES: readonly unknown[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTIONS: readonly unknown[] = "stored not-stored open conflict unknown unknown-history invalid".split(" ");
const OUTER_QUERIES: readonly unknown[] =
	"record-absent record-corrupt invalid unavailable unknown unknown-history unsupported".split(" ");
const RIGHTS_FAILURES: readonly unknown[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
const STOPS: readonly unknown[] = [null, "attempts", "budget"];
/** The base codes amended by exactly the four administration codes. */
const ERROR_CODES = `
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
`
	.trim()
	.split(/\s+/);

// adapted from claim-cli.test.ts:236-249
let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-cli.test.ts:251-255
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-cli.test.ts:257-260
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-cli.test.ts:262-266
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli.test.ts:268-271
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-cli.test.ts:273-277
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-cli.test.ts:279-282
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-cli.test.ts:284-292
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-cli.test.ts:294-297
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(server().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-cli.test.ts:299-309
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const started = performance.now();
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return {
		exit: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		ms: performance.now() - started,
	};
}

// adapted from claim-cli.test.ts:311-314
function commandOf(args: readonly string[]): string {
	if (args[0] !== "claim") return args[0] ?? "";
	return args[1] === "context" ? "context-create" : (args[1] ?? "");
}

// adapted from claim-cli.test.ts:316-322
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/** Owner names are display data in list entries only; the collector drops them there before scanning. */
// adapted from claim-cli.test.ts:324-332
function withoutOwners(doc: unknown): unknown {
	const claims = field(doc, "claims");
	if (!Array.isArray(claims) || !isRecord(doc)) return doc;
	const stripped = claims.map((item: unknown) =>
		isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "owner")) : item,
	);
	return { ...doc, claims: stripped };
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-cli.test.ts:334-337
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-cli.test.ts:339-357
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
	);
}

function integer(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function nullableText(value: unknown): boolean {
	return value === null || typeof value === "string";
}

/** TimingView; instants are epoch milliseconds. */
// adapted from claim-cli.test.ts:359-373
function timingOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.mode === "none") return exact(value, ["mode"]);
	if (value.mode === "hard") {
		return exact(value, ["mode", "hardEnd", "graceMs"]) && integer(value.hardEnd) && integer(value.graceMs);
	}
	return (
		value.mode === "lease" &&
		exact(value, ["mode", "leaseEnd", "hardEnd", "graceMs"]) &&
		integer(value.leaseEnd) &&
		integer(value.graceMs) &&
		(value.hardEnd === null || integer(value.hardEnd))
	);
}

// adapted from claim-cli.test.ts:375-379
function queryOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "resolved") return exact(value, ["kind", "resolution"]) && RESOLUTIONS.includes(value.resolution);
	return exact(value, ["kind"]) && OUTER_QUERIES.includes(value.kind);
}

// adapted from claim-cli.test.ts:381-401
function storageOk(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case "applied":
			return exact(value, ["kind"]);
		case "rejected":
			return exact(value, ["kind", "cause"]) && ["stale", "remote"].includes(String(value.cause));
		case "queried":
			return (
				exact(value, ["kind", "after", "query"]) &&
				["unknown", "stale", "remote", "earlier-process"].includes(String(value.after)) &&
				queryOk(value.query)
			);
		case "not-sent":
			return exact(value, ["kind", "cause"]) && typeof value.cause === "string";
		default:
			return false;
	}
}

/** RightsView; without observedRoot. */
// adapted from claim-cli.test.ts:403-415
function rightsOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind !== "evaluated") return exact(value, ["kind"]) && RIGHTS_FAILURES.includes(value.kind);
	return (
		exact(value, ["kind", "scope", "ownership", "claimGeneration", "workRight", "reclaim"]) &&
		value.scope === "observed-state-only" &&
		["held", "foreign", "free", "absent"].includes(String(value.ownership)) &&
		(value.claimGeneration === null || integer(value.claimGeneration)) &&
		isRecord(value.workRight) &&
		isRecord(value.reclaim)
	);
}

// adapted from claim-cli.test.ts:417-426
function rejectionOk(value: unknown): boolean {
	if (value === null) return true;
	return (
		isRecord(value) &&
		exact(value, ["stage", "cause"], ["boundary"]) &&
		["plan", "storage", "resolution"].includes(String(value.stage)) &&
		typeof value.cause === "string" &&
		(value.boundary === undefined || integer(value.boundary))
	);
}

/** `planned` keeps its four keys; the time-box action and its source are never output. */
// adapted from claim-cli.test.ts:428-439
function plannedOk(value: unknown): boolean {
	if (value === null) return true;
	return (
		isRecord(value) &&
		exact(value, ["status", "claimGeneration", "timing", "capped"]) &&
		["active", "free"].includes(String(value.status)) &&
		integer(value.claimGeneration) &&
		(value.timing === null || timingOk(value.timing)) &&
		typeof value.capped === "boolean"
	);
}

// adapted from claim-cli.test.ts:441-452
function entryOk(value: unknown): boolean {
	return (
		isRecord(value) &&
		exact(value, ["ticket", "state"], ["owner", "claimGeneration", "epoch", "timing", "rights"]) &&
		typeof value.ticket === "string" &&
		["active", "free", "unknown"].includes(String(value.state)) &&
		(value.owner === undefined || typeof value.owner === "string") &&
		(value.claimGeneration === undefined || integer(value.claimGeneration)) &&
		// The store's epoch exactly beside a generation, a positive integer
		(value.epoch === undefined) === (value.claimGeneration === undefined) &&
		(value.epoch === undefined || (integer(value.epoch) && Number(value.epoch) >= 1)) &&
		(value.timing === undefined || timingOk(value.timing)) &&
		(value.rights === undefined || rightsOk(value.rights))
	);
}

// adapted from claim-cli.test.ts:454-456
function problemsOk(value: unknown): boolean {
	return Array.isArray(value) && value.every((problem) => exact(problem, ["key", "problem"]));
}

/** An outstanding pause names own operation IDs, an unknown pause carries nothing else. */
// adapted from claim-cli.test.ts:458-469
function pauseOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "unknown") return exact(value, ["kind"]);
	return (
		value.kind === "outstanding" &&
		exact(value, ["kind", "operationIds"]) &&
		Array.isArray(value.operationIds) &&
		value.operationIds.length > 0 &&
		value.operationIds.every((id: unknown) => typeof id === "string" && id.length > 0)
	);
}

/** doc-04: problems of one document against the documented schema; an empty list means valid. */
// adapted from claim-cli.test.ts:471-539
function schemaProblems(doc: unknown): string[] {
	if (!isRecord(doc)) return ["not a JSON object"];
	const shape = typeof doc.kind === "string" ? SHAPES[doc.kind] : undefined;
	if (shape === undefined) return [`undocumented kind ${String(doc.kind)}`];
	const problems: string[] = [];
	const check = (valid: boolean, name: string) => {
		if (!valid) problems.push(name);
	};
	check(exact(doc, [...ENVELOPE, ...shape.required], shape.optional), `keys ${keysOf(doc).join(",")}`);
	check(doc.schemaVersion === 1, "schemaVersion");
	check(STATUSES.includes(doc.status), "status");
	check(COMMANDS.includes(doc.command), "command");
	switch (doc.kind) {
		case "claim-operation":
			check(ACTIONS.includes(doc.action), "action");
			check(typeof doc.ticket === "string", "ticket");
			check(nullableText(doc.operationId), "operationId");
			check(OUTCOMES.includes(doc.outcome), "outcome");
			check(rejectionOk(doc.rejection), "rejection");
			check(storageOk(doc.storage), "storage");
			check(integer(doc.sends), "sends");
			check(STOPS.includes(doc.stoppedBy), "stoppedBy");
			check(plannedOk(doc.planned), "planned");
			check(rightsOk(doc.rights), "rights");
			break;
		case "claim-pause":
			check(ACTIONS.includes(doc.action), "action");
			check(typeof doc.ticket === "string", "ticket");
			check(doc.operationId === null, "operationId");
			check(pauseOk(doc.pause), "pause");
			check(rightsOk(doc.rights), "rights");
			break;
		case "claim-resolution":
			check(typeof doc.operationId === "string", "operationId");
			check(typeof doc.ticket === "string", "ticket");
			check(ACTIONS.includes(doc.action), "action");
			check(OUTCOMES.includes(doc.outcome), "outcome");
			check(queryOk(doc.query), "query");
			break;
		case "claim-list":
			check(typeof doc.complete === "boolean", "complete");
			check(integer(doc.observedAt), "observedAt");
			check(Array.isArray(doc.claims) && doc.claims.every(entryOk), "claims");
			break;
		case "claim-setup":
			check(Array.isArray(doc.keys) && doc.keys.every((key) => typeof key === "string"), "keys");
			break;
		case "claim-init":
			check(["created", "exists"].includes(String(doc.result)), "result");
			check(
				FORMATS.some((format) => format === doc.format),
				"format",
			);
			check(integer(doc.epoch), "epoch");
			break;
		case "claim-context":
			check(typeof doc.contextId === "string" && doc.contextId.length > 0, "contextId");
			break;
		default:
			check(ERROR_CODES.includes(String(doc.code)), "code");
			check(typeof doc.message === "string" && doc.message.trim().length > 0, "message");
			check(nullableText(doc.ticket), "ticket");
			check(nullableText(doc.operationId), "operationId");
			check(doc.problems === undefined || problemsOk(doc.problems), "problems");
			check((doc.configuredFormat === undefined) === (doc.existingFormat === undefined), "formats");
	}
	return problems;
}

// adapted from claim-cli.test.ts:541-561
function cliView(run: JsonRun): CliView {
	const { doc } = run;
	const id = field(doc, "operationId");
	return {
		exit: run.exit,
		schema: schemaProblems(doc),
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		code: field(doc, "code") ?? null,
		action: field(doc, "action") ?? null,
		outcome: field(doc, "outcome") ?? null,
		rejection: field(doc, "rejection") ?? null,
		storage: field(doc, "storage") ?? null,
		query: field(doc, "query") ?? null,
		sends: field(doc, "sends") ?? null,
		stoppedBy: field(doc, "stoppedBy") ?? null,
		ownership: field(field(doc, "rights"), "ownership") ?? null,
		operationId: typeof id === "string" && GENERATED_ID.test(id) ? "generated" : (id ?? null),
	};
}

/** The CliView fields a helper may set besides the status and the command it names itself. */
type ViewFields = Partial<Omit<CliView, "status" | "command">>;

// adapted from claim-cli.test.ts:563-583
function view(fields: ViewFields & { status: Status; command: string }): CliView {
	return {
		exit: EXIT[fields.status],
		schema: [],
		kind: "claim-operation",
		code: null,
		action: null,
		outcome: null,
		rejection: null,
		storage: null,
		query: null,
		sends: null,
		stoppedBy: null,
		ownership: null,
		operationId: null,
		...fields,
	};
}

/** An applied transfer, resume or change-bounds is a claim-operation with command = action. */
// adapted from claim-cli.test.ts:585-589
function applied(command: string, ownership: string, fields: ViewFields = {}): CliView {
	const storage = { kind: "applied" };
	const base = { command, action: command, outcome: "applied", storage, sends: 1, ownership };
	return view({ status: "applied", ...base, operationId: "generated", ...fields });
}

/** Plan rejections persist nothing, so no operation ID is printed; only H boundaries appear. */
// adapted from claim-cli.test.ts:591-595
function planRejected(command: string, cause: string, ownership: string, boundary?: number): CliView {
	const rejection = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return view({ status: "rejected", command, action: command, outcome: "rejected", rejection, sends: 0, ownership });
}

// adapted from claim-cli.test.ts:597-599
function failed(command: string, status: Status, code: string, fields: ViewFields = {}): CliView {
	return view({ status, command, kind: "claim-error", code, ...fields });
}

// adapted from claim-cli.test.ts:601-603
function queriedStorage(after: string, resolution: string): Record<string, unknown> {
	return { kind: "queried", after, query: { kind: "resolved", resolution } };
}

// adapted from claim-cli.test.ts:605-608
function resolvedView(status: Status, outcome: string, resolution: string, action: string, id: string): CliView {
	const query = { kind: "resolved", resolution };
	return view({ status, command: "resolve", kind: "claim-resolution", action, outcome, query, operationId: id });
}

/** A send held past the attempt timeout with one attempt: the intent stays open, stopped by attempts. */
// adapted from claim-cli.test.ts:1328-1340 (unk-01)
function lostView(command: string, ownership: string, id: string): CliView {
	return view({
		status: "unknown",
		command,
		action: command,
		outcome: "unknown",
		storage: queriedStorage("unknown", "open"),
		sends: 1,
		stoppedBy: "attempts",
		ownership,
		operationId: id,
	});
}

// adapted from claim-cli.test.ts:610-628
function listView(run: JsonRun): ListView {
	const claims = field(run.doc, "claims");
	return {
		exit: run.exit,
		schema: schemaProblems(run.doc),
		kind: field(run.doc, "kind") ?? null,
		status: field(run.doc, "status") ?? null,
		complete: field(run.doc, "complete") ?? null,
		claims: Array.isArray(claims)
			? claims.map((item: unknown) => ({
					ticket: field(item, "ticket") ?? null,
					state: field(item, "state") ?? null,
					owner: field(item, "owner") ?? null,
					claimGeneration: field(item, "claimGeneration") ?? null,
					ownership: field(field(item, "rights"), "ownership") ?? null,
				}))
			: null,
	};
}

// adapted from claim-cli.test.ts:630-632
function listed(claims: EntryView[]): ListView {
	return { exit: 0, schema: [], kind: "claim-list", status: "ok", complete: true, claims };
}

// adapted from claim-cli.test.ts:634-642
function entry(
	ticket: string,
	state: string,
	claimGeneration: number,
	ownership: string | null,
	owner: string | null = state === "active" ? OWNER : null,
): EntryView {
	return { ticket, state, owner, claimGeneration, ownership };
}

/** The first token of the human output is the status; refused, unavailable and internal go to stderr. */
// adapted from claim-cli.test.ts:644-657
function plainView(run: CliRun, code?: string): PlainView {
	let stream = "mixed";
	if (run.stdout !== "" && run.stderr === "") stream = "stdout";
	if (run.stderr !== "" && run.stdout === "") stream = "stderr";
	const first = (stream === "stderr" ? run.stderr : run.stdout).split("\n")[0] ?? "";
	const colon = first.indexOf(":");
	return {
		exit: run.exit,
		stream,
		head: colon > 0 ? first.slice(0, colon) : null,
		codeShown: code === undefined ? null : first.includes(code),
	};
}

// adapted from claim-cli.test.ts:659-666
function plainOf(status: Status, codeShown: boolean | null = null): PlainView {
	return {
		exit: EXIT[status],
		stream: STDERR_STATUSES.includes(status) ? "stderr" : "stdout",
		head: status,
		codeShown,
	};
}

function hinted(run: CliRun, term: string): boolean {
	return `${run.stdout}${run.stderr}`.includes(term);
}

// adapted from claim-cli.test.ts:668-671
function pick(run: JsonRun, keys: readonly string[]): Record<string, unknown> {
	const picked = Object.fromEntries(keys.map((key) => [key, field(run.doc, key) ?? null]));
	return { exit: run.exit, schema: schemaProblems(run.doc), ...picked };
}

/** The pause document of `run` with the ownership of its rights. */
// adapted from claim-cli.test.ts:1355-1359 (pau-01)
function pausedView(run: JsonRun): Record<string, unknown> {
	const shown: Record<string, unknown> = {
		...pick(run, ["kind", "status", "command", "action", "ticket", "operationId", "pause"]),
		ownership: field(field(run.doc, "rights"), "ownership") ?? null,
	};
	return shown;
}

/** A pause of a new command names it as command and action; retry is the way out. */
function pausedOf(command: string, ticket: string, operationIds: string[]): Record<string, unknown> {
	return {
		exit: 7,
		schema: [],
		kind: "claim-pause",
		status: "paused",
		command,
		action: command,
		ticket,
		operationId: null,
		pause: { kind: "outstanding", operationIds },
		ownership: "held",
	};
}

/** The planned lease end from the `planned` display. */
// adapted from claim-cli.test.ts:673-678
function plannedLeaseEnd(doc: unknown): number {
	const leaseEnd = field(field(field(doc, "planned"), "timing"), "leaseEnd");
	if (typeof leaseEnd !== "number") throw new Error("the document names no planned lease end");
	return leaseEnd;
}

/** `planned` with a lease end inside [from, to] shown as IN_WINDOW; the CLI runs on the real clock. */
function windowed(doc: unknown, from: number, to: number): unknown {
	const planned = field(doc, "planned");
	const timing = field(planned, "timing");
	const leaseEnd = field(timing, "leaseEnd");
	if (!isRecord(planned) || !isRecord(timing) || typeof leaseEnd !== "number") return planned ?? null;
	const inWindow = from <= leaseEnd && leaseEnd <= to;
	const shownTiming: Record<string, unknown> = { ...timing, leaseEnd: inWindow ? IN_WINDOW : leaseEnd };
	const shown: Record<string, unknown> = { ...planned, timing: shownTiming };
	return shown;
}

function rightsFacts(doc: unknown): RightsFacts {
	const rights = field(doc, "rights");
	return {
		ownership: field(rights, "ownership") ?? null,
		claimGeneration: field(rights, "claimGeneration") ?? null,
		workRight: field(rights, "workRight") ?? null,
	};
}

function firstEntry(doc: unknown): unknown {
	const claims = field(doc, "claims");
	return Array.isArray(claims) ? claims[0] : undefined;
}

/** Two pre-receive invocations with byte-identical ref lines: the lost send and its retry (rsm-01). */
// adapted from claim-cli.test.ts:1385-1403
function resent(pushes: readonly string[][]): { pushes: number; identical: boolean } {
	const identical = pushes.length === 2 && JSON.stringify(pushes[0]) === JSON.stringify(pushes[1]);
	return { pushes: pushes.length, identical };
}

/** Statuses whose exit code row is missing: no line carries the status and its code as separate tokens. */
// adapted from claim-cli.test.ts:680-686
function missingExitRows(text: string): string[] {
	const lines = text.split("\n").map((line) => line.split(/[^\w-]+/));
	return Object.entries(EXIT)
		.filter(([status, code]) => !lines.some((tokens) => tokens.includes(status) && tokens.includes(String(code))))
		.map(([status]) => status);
}

/** Commander lists every registered option anyway; only the help schema writes `  - <name>: <type>` lines. */
// adapted from claim-cli.test.ts:688-693
async function helpView(cwd: string, command: string, kind: string, fields: readonly string[]): Promise<HelpView> {
	const run = await runCli(cwd, ["claim", ...command.split(" "), "--help"]);
	const text = run.stdout + run.stderr;
	const missing = ["Input schema:", "Output:", "Examples:"].filter((section) => !text.includes(section));
	return {
		command,
		exit: run.exit,
		missing,
		kind: text.includes(kind),
		json: text.includes("--json"),
		fields: fields.filter((name) => !text.includes(`- ${name}:`)),
	};
}

// adapted from claim-cli.test.ts:695-697
function documented(command: string): HelpView {
	return { command, exit: 0, missing: [], kind: true, json: true, fields: [] };
}

// adapted from claim-cli.test.ts:699-705
function acquireArgs(ticket: string, handle: ContextHandle, ...extra: string[]): string[] {
	return ["claim", "acquire", ticket, "--owner", OWNER, "--context", handle.directory, ...extra];
}

function onArgs(verb: string, target: string, handle: ContextHandle, ...extra: string[]): string[] {
	return ["claim", verb, target, "--context", handle.directory, ...extra];
}

/** The target only as an explicit path, the receiver's display name only as --owner. */
function transferTo(ticket: string, from: ContextHandle, target: string, ...extra: string[]): string[] {
	const source = ["--owner", RECEIVER, "--context", from.directory];
	return ["claim", "transfer", ticket, "--to-context", target, ...source, ...extra];
}

function transferArgs(ticket: string, from: ContextHandle, to: ContextHandle, ...extra: string[]): string[] {
	return transferTo(ticket, from, to.directory, ...extra);
}

/** --mode is mandatory; the timing flags of the mode follow in `extra`. */
function boundsArgs(ticket: string, handle: ContextHandle, mode: string, ...extra: string[]): string[] {
	return ["claim", "change-bounds", ticket, "--mode", mode, "--context", handle.directory, ...extra];
}

/** ISO-8601 instants with a zone and an integer grace; a missing --hard-end removes H. */
function leaseBounds(leaseEnd: number, hardEnd: number | null, graceMs: number): string[] {
	const hard = hardEnd === null ? [] : ["--hard-end", iso(hardEnd)];
	return ["--lease-end", iso(leaseEnd), ...hard, "--grace-ms", String(graceMs)];
}

function hardBounds(hardEnd: number, graceMs: number): string[] {
	return ["--hard-end", iso(hardEnd), "--grace-ms", String(graceMs)];
}

/** `context create` with the recovery source; the source is never printed. */
function recoverArgs(parent: string, source: ContextHandle): string[] {
	return ["claim", "context", "create", "--parent", parent, "--recover-from", source.directory];
}

/** `--hard-end` rule: ISO-8601 with a zone; `toISOString` keeps the millisecond. */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Rights state timings (rights/index.ts:14-17) for planted states and exact expectations. */
function leaseTiming(leaseEnd: number, hardEnd: number | null, graceMs = GRACE): JsonObject {
	return { mode: "lease", leaseEnd, graceMs, hardEnd };
}

function hardTiming(hardEnd: number, graceMs = GRACE): JsonObject {
	return { mode: "hard", hardEnd, graceMs };
}

const NONE_TIMING: JsonObject = { mode: "none" };

/** base cli-01: kind, status and the exact key set of a claim-context document. */
// adapted from claim-cli.test.ts:2106
function contextView(run: JsonRun): Record<string, unknown> {
	const shown: Record<string, unknown> = { ...pick(run, ["kind", "status"]), keys: keysOf(run.doc) };
	return shown;
}

const CONTEXT_MADE: Record<string, unknown> = {
	exit: 0,
	schema: [],
	kind: "claim-context",
	status: "ok",
	keys: ["command", "contextId", "kind", "schemaVersion", "status"],
};

// adapted from claim-cli.test.ts:2091-2092
function createdId(run: JsonRun): string {
	const contextId = field(run.doc, "contextId");
	if (typeof contextId !== "string") throw new Error("context create printed no context ID");
	return contextId;
}

/** Keys plus the policy key, written last like its place in SCHEMA_KEYS. */
// adapted from claim-cli.test.ts:724-741
function claimsBlock(options: BlockOptions): string {
	return [
		"claims:",
		`  enabled: ${options.enabled}`,
		`  endpoint: ${JSON.stringify(options.endpoint)}`,
		`  storage_format: ${options.format}`,
		`  lifetime_mode: ${options.mode}`,
		...(options.mode === "lease" ? [`  lease_ttl_ms: ${options.ttlMs}`] : []),
		...(options.mode === "none" ? [] : [`  reclaim_grace_ms: ${options.graceMs}`]),
		`  attempt_timeout_ms: ${options.timeoutMs}`,
		`  attempts: ${options.attempts}`,
		`  operation_budget_ms: ${options.budgetMs}`,
		...(options.epsMs === null ? [] : [`  clock_uncertainty_ms: ${options.epsMs}`]),
		...(options.pauseBaseMs === null ? [] : [`  retry_pause_base_ms: ${options.pauseBaseMs}`]),
		...(options.pauseMaxMs === null ? [] : [`  retry_pause_max_ms: ${options.pauseMaxMs}`]),
		...(options.timeBoxPolicy === null ? [] : [`  transfer_time_box: ${options.timeBoxPolicy}`]),
	].join("\n");
}

/** Without the policy key: absence means require-explicit. */
// adapted from claim-cli.test.ts:743-758
function defaultBlock(endpoint: string, format: ClaimStorageFormat): BlockOptions {
	return {
		endpoint,
		format,
		enabled: true,
		mode: "lease",
		ttlMs: TTL,
		graceMs: GRACE,
		timeoutMs: ADAPTER_TIMEOUT,
		attempts: 3,
		budgetMs: 30_000,
		epsMs: EPS,
		pauseBaseMs: 1,
		pauseMaxMs: 1,
		timeBoxPolicy: null,
	};
}

// adapted from claim-cli.test.ts:760-766
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the given tickets, the claims block and one committed repository. */
// adapted from claim-cli.test.ts:768-800; the task file paths are not kept (no base rel-01 snapshot here)
async function initProject(directory: string, tickets: readonly string[], block: string | undefined): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim CLI administration");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const ticket of tickets) {
		const task = {
			id: ticket,
			title: `Claim target ${ticket}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-28",
			rawContent: "",
		};
		await core.filesystem.saveTask(task);
	}
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** Secret and recovery secret of a private record (context/index.ts:33-38); both are sentinels. */
// adapted from claim-cli.test.ts:802-808 (secretOf), extended by the recovery proof
async function proofsOf(handle: ContextHandle): Promise<{ secret: string; recoverySecret: string | null }> {
	const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	const recoverySecret = field(field(record, "recovery"), "secret");
	if (typeof secret !== "string") throw new Error("the private record has no string secret");
	return { secret, recoverySecret: typeof recoverySecret === "string" ? recoverySecret : null };
}

/** Names, modes and sha256 of every entry under `directory`: the target is read only. */
async function dirSnapshot(directory: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	const visit = async (path: string, name: string): Promise<void> => {
		const info = await lstat(path);
		const mode = (info.mode & 0o7777).toString(8);
		if (!info.isDirectory()) {
			entries[name] = `${mode} ${sha256Hex(await readFile(path))}`;
			return;
		}
		entries[name] = `${mode} directory`;
		for (const child of (await readdir(path)).sort(byCodeUnits)) await visit(join(path, child), `${name}/${child}`);
	};
	await visit(directory, ".");
	return entries;
}

/** A byte copy of `source` at `target` with every mode kept (context/index.ts:80-86 checks 0700/0600). */
async function copyTree(source: string, target: string): Promise<void> {
	const info = await lstat(source);
	if (!info.isDirectory()) {
		await writeFile(target, await readFile(source));
		await chmod(target, info.mode & 0o7777);
		return;
	}
	await mkdir(target);
	await chmod(target, info.mode & 0o7777);
	for (const child of await readdir(source)) await copyTree(join(source, child), join(target, child));
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-cli.test.ts:810-835
function receiveHook(control: string, phase: ReceivePhase): string {
	const marker = shellQuote(`${SENTINEL}-hook-stderr`);
	return [
		"#!/bin/sh",
		`dir=${shellQuote(control)}`,
		`phase=${phase}`,
		"n=1",
		'while ! mkdir "$dir/$phase-$n" 2>/dev/null; do n=$((n + 1)); done',
		'cat > "$dir/$phase-$n/stdin"',
		"action=pass",
		'if [ -f "$dir/$phase-action-$n" ]; then action=$(cat "$dir/$phase-action-$n")',
		'elif [ -f "$dir/$phase-action-rest" ]; then action=$(cat "$dir/$phase-action-rest"); fi',
		': > "$dir/$phase-$n/entered"',
		'case "$action" in hold*)',
		`\ti=0; while [ ! -f "$dir/$phase-$n/release" ] && [ "$i" -lt ${HOLD_POLLS} ]; do`,
		"\t\tsleep 0.05; i=$((i + 1))",
		"\tdone ;;",
		"esac",
		': > "$dir/$phase-$n/done"',
		`case "$action" in *reject) echo ${marker} >&2; exit 1 ;; esac`,
		"exit 0",
		"",
	].join("\n");
}

/** S1, test-local: per-invocation logs and scripted actions for both receive hooks of one server repository. */
// adapted from claim-cli.test.ts:837-918
class ReceiveScript {
	constructor(
		private readonly serverRepo: string,
		private readonly control: string,
	) {}

	async install(): Promise<void> {
		await mkdir(this.control, { recursive: true });
		for (const phase of ["pre", "post"] as const) {
			const hook = join(this.serverRepo, "hooks", `${phase}-receive`);
			await writeFile(hook, receiveHook(this.control, phase));
			await chmod(hook, 0o755);
		}
	}

	async count(phase: ReceivePhase): Promise<number> {
		const pattern = new RegExp(`^${phase}-\\d+$`);
		return (await readdir(this.control)).filter((name) => pattern.test(name)).length;
	}

	/** Number of the next invocation of `phase`. */
	async next(phase: ReceivePhase): Promise<number> {
		return (await this.count(phase)) + 1;
	}

	/** Actions for the next invocations of `phase`, then `rest` for every later one. */
	async plan(phase: ReceivePhase, actions: readonly HookAction[], rest: HookAction = "pass"): Promise<void> {
		const started = await this.count(phase);
		const numbered = new RegExp(`^${phase}-action-\\d+$`);
		for (const name of await readdir(this.control)) {
			if (numbered.test(name)) await rm(join(this.control, name), { force: true });
		}
		for (const [index, action] of actions.entries()) {
			await writeFile(join(this.control, `${phase}-action-${started + index + 1}`), action);
		}
		await writeFile(join(this.control, `${phase}-action-rest`), rest);
	}

	/** Releases invocation `n` of `phase` and waits, bounded, until its hook has finished. */
	async settle(phase: ReceivePhase, n: number): Promise<void> {
		const path = join(this.control, `${phase}-${n}`);
		await writeFile(join(path, "release"), "");
		const deadline = Date.now() + EVENT_TIMEOUT;
		while (!(await exists(join(path, "done")))) {
			if (Date.now() > deadline) throw new Error(`receive hook ${phase}-${n} did not finish`);
			await Bun.sleep(10);
		}
	}

	/** Stdin lines `<old> <new> <ref>` of the entered invocations of `phase` numbered above `since`, in order. */
	async lines(phase: ReceivePhase, since: number): Promise<string[][]> {
		const pattern = new RegExp(`^${phase}-(\\d+)$`);
		const numbers = (await readdir(this.control))
			.map((name) => Number(pattern.exec(name)?.[1] ?? Number.NaN))
			.filter((n) => Number.isSafeInteger(n) && n > since)
			.sort((left, right) => left - right);
		const result: string[][] = [];
		for (const n of numbers) {
			const path = join(this.control, `${phase}-${n}`);
			if (!(await exists(join(path, "entered")))) continue;
			result.push((await readFile(join(path, "stdin"), "utf8")).split("\n").filter(Boolean));
		}
		return result;
	}

	/** Releases every hold and waits, bounded, until each invocation has finished. */
	async releaseAll(): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.control)).filter((name) => /^(?:pre|post)-\d+$/.test(name));
		} catch {
			return;
		}
		await Promise.all(names.map((name) => writeFile(join(this.control, name, "release"), "").catch(() => undefined)));
		const deadline = Date.now() + EVENT_TIMEOUT;
		for (const name of names) {
			while (!(await exists(join(this.control, name, "done"))) && Date.now() < deadline) await Bun.sleep(10);
		}
	}
}

/** One server area with S1 hooks, one project, independent clients, private contexts and the output collector. */
// adapted from claim-cli.test.ts:920-1188: recovery contexts, a byte copy, planted states and the scan of both owner
// names and recovery proofs are new; the project snapshot, task files, extra projects and areas are left out.
class CliCase {
	readonly hooks: ReceiveScript;
	readonly parent: string;
	private options: BlockOptions;
	private readonly outputs: Output[] = [];
	private readonly handles: ContextHandle[] = [];
	private readonly roots = new Set<string>();
	private readonly stores = new Map<string, ClaimStore>();
	private directories = 0;
	private writes = 0;

	private constructor(
		readonly format: ClaimStorageFormat,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		options: BlockOptions,
	) {
		this.options = options;
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	/** `descriptor: false` leaves the area uninitialized; `block: null` writes no claims block. */
	static async create(format: ClaimStorageFormat, caseName: string, setup: CaseSetup): Promise<CliCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-cli-admin-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `cli-admin-${SENTINEL}-${format}-${caseName}`);
			const url = server().url(name);
			const options: BlockOptions = { ...defaultBlock(url, format), ...(setup.block ?? {}) };
			const project = join(root, `project-${SENTINEL}`);
			await initProject(project, TICKETS, setup.block === null ? undefined : claimsBlock(options));
			const fixture = new CliCase(format, root, url, repo, project, options);
			await fixture.hooks.install();
			await mkdir(fixture.parent);
			await chmod(fixture.parent, 0o700);
			if (setup.descriptor !== false) await fixture.initialize(url);
			return fixture;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** A fresh client repository with one seed commit; its objects never reach the project repository. */
	async client(): Promise<string> {
		this.directories += 1;
		return initClient(join(this.root, `client-${this.directories}`));
	}

	/** Initializes an area through the storage API, never through the CLI under test. */
	async initialize(url: string): Promise<void> {
		const repository = await this.client();
		const options = { repository, remote: url, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
		expectKind(await initializeClaimStorage(options), "created");
	}

	/** Rewrites the claims block through saveConfig; null removes it. */
	async writeBlock(changes: Partial<BlockOptions> | null): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("the project configuration is missing");
		if (changes !== null) this.options = { ...this.options, ...changes };
		const claimsYaml = changes === null ? undefined : claimsBlock(this.options);
		await core.filesystem.saveConfig({ ...config, claimsYaml });
	}

	// adapted from claim-execution.test.ts:1128 (ExecutionCase.context)
	async context(): Promise<ContextHandle> {
		const context = expectKind(await createClaimContext({ parent: this.parent }), "created").context;
		return this.remember({ context, directory: dirname(context.journalDirectory) });
	}

	/** A replacement context whose recovery proof is `source`'s, through the context API (context/index.ts:199-254). */
	async recoveryContext(source: ContextHandle): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent, recoverFrom: source.directory });
		const { context } = expectKind(created, "created");
		return this.remember({ context, directory: dirname(context.journalDirectory) });
	}

	/** Registers a context the CLI created or the test copied, so its proofs and path join the leak scan. */
	async adopt(directory: string): Promise<ContextHandle> {
		const context = expectKind(await loadClaimContext({ directory }), "loaded").context;
		return this.remember({ context, directory });
	}

	// adapted from claim-preflight.test.ts:398 (PreflightCase.brokenContext)
	async brokenContext(): Promise<ContextHandle> {
		const handle = await this.context();
		await chmod(join(handle.directory, "context.json"), 0o644);
		return handle;
	}

	/** ctr-04: a byte copy of `handle` in a second private parent under the same base name (called once per case). */
	async copyContext(handle: ContextHandle): Promise<ContextHandle> {
		const copies = join(this.root, `copies-${SENTINEL}`);
		await mkdir(copies);
		await chmod(copies, 0o700);
		const directory = join(copies, basename(handle.directory));
		await copyTree(handle.directory, directory);
		return this.adopt(directory);
	}

	private remember(handle: ContextHandle): ContextHandle {
		this.handles.push(handle);
		return handle;
	}

	private async execute(args: readonly string[], cwd: string): Promise<CliRun> {
		const run = await runCli(cwd, args);
		for (const oid of Object.values(await this.serverRefs())) this.roots.add(oid);
		return run;
	}

	/** One JSON-mode call; list documents enter the collector without their owner fields. */
	async json(args: readonly string[], cwd = this.project): Promise<JsonRun> {
		const run = await this.execute([...args, "--json"], cwd);
		const doc = parseDocument(run.stdout);
		const stdout = field(doc, "kind") === "claim-list" ? JSON.stringify(withoutOwners(doc)) : run.stdout;
		const created = field(doc, "kind") === "claim-context" ? field(doc, "contextId") : null;
		const allowedId = typeof created === "string" ? created : null;
		this.outputs.push({ command: commandOf(args), text: stdout + run.stderr, ownerAllowed: false, allowedId });
		return { ...run, doc };
	}

	/** One human-mode call; owner names may appear only in list output. */
	async plain(args: readonly string[], cwd = this.project): Promise<CliRun> {
		const run = await this.execute([...args, "--plain"], cwd);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: command === "list", allowedId: null });
		return run;
	}

	/** A call with exactly `args`, for Commander usage errors. */
	async raw(args: readonly string[], cwd = this.project): Promise<CliRun> {
		const run = await this.execute(args, cwd);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: false, allowedId: null });
		return run;
	}

	/**
	 * Labels of every sentinel in the collected output. Both owner names are allowed in list output only;
	 * a context ID only in the `context create` document that created it; roots are never printed.
	 */
	async leaks(extra: readonly Sentinel[] = []): Promise<string[]> {
		const sentinels: Sentinel[] = [
			["sentinel", SENTINEL],
			["endpoint", this.url],
			["case root", this.root],
			["context parent", this.parent],
			...extra,
		];
		for (const oid of this.roots) sentinels.push(["server root", oid]);
		for (const [index, handle] of this.handles.entries()) {
			const label = `context ${index + 1}`;
			const { secret, recoverySecret } = await proofsOf(handle);
			sentinels.push([`${label} binding`, handle.context.binding], [`${label} path`, handle.directory]);
			sentinels.push([`${label} secret`, secret]);
			const recovery = handle.context.recovery;
			if (recovery !== null) sentinels.push([`${label} recovery binding`, recovery.binding]);
			if (recoverySecret !== null) sentinels.push([`${label} recovery secret`, recoverySecret]);
			for (const record of await this.records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			if (!output.ownerAllowed) labels.push(...echoedIn(output.text, OWNER_NAMES));
			for (const [index, handle] of this.handles.entries()) {
				const { contextId } = handle.context;
				if (contextId !== output.allowedId && output.text.includes(contextId)) labels.push(`context ${index + 1} id`);
			}
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	/** Journal records of one context; temporary `.intent-*.tmp` names and admission slots are ignored. */
	// adapted from claim-cli.test.ts:1101-1115
	async records(handle: ContextHandle): Promise<JournalRecord[]> {
		const records: JournalRecord[] = [];
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			const record: unknown = JSON.parse(await readFile(join(handle.context.journalDirectory, name), "utf8"));
			const digest = String(field(record, "digest"));
			records.push({ name, digest, parameterDigest: String(field(record, "parameterDigest")) });
		}
		return records;
	}

	async recordNames(handle: ContextHandle): Promise<string[]> {
		return (await this.records(handle)).map((record) => record.name);
	}

	// adapted from claim-execution.test.ts:1216 (ExecutionCase.serverRefs)
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	private async store(label: string): Promise<ClaimStore> {
		const cached = this.stores.get(label);
		if (cached !== undefined) return cached;
		const repository = await this.client();
		const options = { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
		const { store } = expectKind(await openClaimStore(options), "open");
		this.stores.set(label, store);
		return store;
	}

	/** An independent writer's change on the server. */
	// adapted from claim-execution.test.ts:1238 (ExecutionCase.writeChange, writeState)
	async writeState(ticket: string, payload: JsonObject): Promise<string> {
		const store = await this.store("writer");
		const base = await store.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return expectKind(await store.write(base, { operationId, receipt, payload }), "applied").root;
	}

	/**
	 * `plant`: an ACTIVE claim of OWNER bound to `holder`'s context binding, written by the independent
	 * writer, so a test fixes timings the CLI could not reach (a lapsed lease, a past hard end). The test knows the
	 * binding and never prints it; the scan covers it.
	 */
	async plant(ticket: string, holder: ContextHandle, timing: JsonObject, claimGeneration = 1): Promise<string> {
		return this.writeState(ticket, {
			claimState: 1,
			status: "active",
			claimGeneration,
			bindingGeneration: 1,
			owner: OWNER,
			binding: holder.context.binding,
			timing,
		});
	}

	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

// adapted from claim-cli.test.ts:1190-1202
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	setup: CaseSetup,
	body: (fixture: CliCase) => Promise<void>,
): Promise<void> {
	const fixture = await CliCase.create(format, caseName, setup);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

for (const format of FORMATS) {
	describe(`claim CLI administration over real Git (${format})`, () => {
		test(
			"ctr-01: transfer moves a lapsed lease to the receiver in one step and only reads the target context",
			async () => {
				await withCase(format, "transfer", {}, async (fixture) => {
					// Scanner positive control: a planted sentinel and a planted receiver name are found.
					const planted = `planted ${SENTINEL} ${RECEIVER}`;
					expect(echoedIn(planted, [["sentinel", SENTINEL], ...OWNER_NAMES])).toEqual(["sentinel", "receiver"]);
					const a = await fixture.context();
					const b = await fixture.context();
					// A's pure lease ended two minutes ago; its reclaim boundary is still eight minutes ahead.
					await fixture.plant(TICKET, a, leaseTiming(Date.now() - 2 * MINUTE, null));
					const targetBefore = await dirSnapshot(b.directory);
					const t0 = Date.now();
					// A's journal is empty (the claim was planted by another writer).
					const moved = await fixture.json(transferArgs(TICKET, a, b));
					const t1 = Date.now();
					// Positive control (catches: missing wiring; the acquire purpose; a transfer as release plus acquire; the
					// old lease end kept; rights from the target's view instead of the source's).
					expect({
						view: cliView(moved),
						planned: windowed(moved.doc, t0 + TTL, t1 + TTL),
						rights: rightsFacts(moved.doc),
					}).toEqual({
						view: applied("transfer", "foreign"),
						planned: {
							status: "active",
							claimGeneration: 2,
							timing: { mode: "lease", leaseEnd: IN_WINDOW, hardEnd: null, graceMs: GRACE },
							capped: false,
						},
						rights: { ownership: "foreign", claimGeneration: 2, workRight: { kind: "none", cause: "not-holder" } },
					});
					const movedId = String(field(moved.doc, "operationId"));
					// catches: an intent in the target journal; the target context written.
					expect({
						journalA: await fixture.recordNames(a),
						journalB: await fixture.recordNames(b),
						target: await dirSnapshot(b.directory),
					}).toEqual({ journalA: [`${movedId}.json`], journalB: [], target: targetBefore });
					const listB = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", b.directory]);
					const listA = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", a.directory]);
					// B is another context; its journal holds no record that could pause it.
					const renewedB = await fixture.json(onArgs("renew", TICKET, b));
					// A's only record expects the planted root, which the transfer and B's renew replaced.
					const renewedA = await fixture.json(onArgs("renew", TICKET, a));
					// Changed root as above; the rejected renew recorded nothing.
					const releasedA = await fixture.json(onArgs("release", TICKET, a));
					// Changed root as above; the rejected release recorded nothing.
					const againA = await fixture.json(transferArgs(TICKET, a, b));
					// Another ticket; the pause compares the ticket (pause/index.ts:86-94).
					const second = await fixture.json(acquireArgs(SECOND, a));
					// A's record for SECOND expects the absent ref, which its acquire replaced.
					const secondPlain = await fixture.plain(transferArgs(SECOND, a, b));
					// catches: the receiver not holding; the source still holding or able to renew, release or pass on the
					// claim; a transfer without human output.
					expect({
						listB: listView(listB),
						listA: listView(listA),
						renewedB: cliView(renewedB),
						renewedA: cliView(renewedA),
						releasedA: cliView(releasedA),
						againA: cliView(againA),
						second: cliView(second),
						secondPlain: plainView(secondPlain),
					}).toEqual({
						listB: listed([entry(TICKET, "active", 2, "held", RECEIVER)]),
						listA: listed([entry(TICKET, "active", 2, "foreign", RECEIVER)]),
						renewedB: applied("renew", "held"),
						renewedA: planRejected("renew", "not-holder", "foreign"),
						releasedA: planRejected("release", "not-holder", "foreign"),
						againA: planRejected("transfer", "not-holder", "foreign"),
						second: applied("acquire", "held"),
						secondPlain: plainOf("applied"),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"crs-01: context create --recover-from and resume rebind a claim once, keep its timing and use up the proof",
			async () => {
				await withCase(format, "resume", {}, async (fixture) => {
					const a = await fixture.context();
					// A's journal is empty.
					const acquired = await fixture.json(acquireArgs(TICKET, a));
					const made = await fixture.json(recoverArgs(fixture.parent, a));
					// Positive control, first half (catches: --recover-from not passed through; the source's ID, path or
					// binding printed).
					expect({ acquired: cliView(acquired), made: contextView(made) }).toEqual({
						acquired: applied("acquire", "held"),
						made: CONTEXT_MADE,
					});
					const r = await fixture.adopt(join(fixture.parent, createdId(made)));
					// R is another context with an empty journal.
					const resumed = await fixture.json(onArgs("resume", TICKET, r));
					// Positive control, second half (catches: resume not wired; the recovery binding kept as successor so A
					// stays holder; a renewed lease window; `capped` from a TTL instead of the stored ends).
					expect({
						view: cliView(resumed),
						planned: field(resumed.doc, "planned"),
						rights: rightsFacts(resumed.doc),
					}).toEqual({
						view: applied("resume", "held"),
						planned: field(acquired.doc, "planned"),
						rights: { ownership: "held", claimGeneration: 1, workRight: { kind: "live", renewalDue: false } },
					});
					const acquireId = String(field(acquired.doc, "operationId"));
					// A's acquire record expects the absent ref, which the acquire and the resume replaced.
					const renewedA = await fixture.json(onArgs("renew", TICKET, a));
					const resolvedA = await fixture.json(onArgs("resolve", acquireId, a));
					// R's resume record expects the acquire's root, which the resume replaced.
					const renewedR = await fixture.json(onArgs("renew", TICKET, r));
					const madeFromA = await fixture.json(recoverArgs(fixture.parent, a));
					const r2 = await fixture.adopt(join(fixture.parent, createdId(madeFromA)));
					// R2 is another context with an empty journal.
					const fromA = await fixture.json(onArgs("resume", TICKET, r2));
					const madeFromR = await fixture.json(recoverArgs(fixture.parent, r));
					const r3 = await fixture.adopt(join(fixture.parent, createdId(madeFromR)));
					// R3 is another context with an empty journal.
					const fromR = await fixture.json(onArgs("resume", TICKET, r3));
					// R's newest record expects the root before R3's resume, which that resume replaced.
					const renewedLate = await fixture.json(onArgs("renew", TICKET, r));
					const listing = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", r3.directory]);
					// catches: the old holder still renewing; a used proof accepted again; a chain that breaks after
					// one hop; a resume record written into the old journal (one hop, no journal import).
					expect({
						renewedA: cliView(renewedA),
						resolvedA: cliView(resolvedA),
						renewedR: cliView(renewedR),
						fromA: cliView(fromA),
						journalR2: await fixture.recordNames(r2),
						fromR: cliView(fromR),
						renewedLate: cliView(renewedLate),
						listing: listView(listing),
						journalA: await fixture.recordNames(a),
					}).toEqual({
						renewedA: planRejected("renew", "not-holder", "foreign"),
						resolvedA: resolvedView("applied", "applied", "stored", "acquire", "generated"),
						renewedR: applied("renew", "held"),
						fromA: planRejected("resume", "not-holder", "foreign"),
						journalR2: [],
						fromR: applied("resume", "held"),
						renewedLate: planRejected("renew", "not-holder", "foreign"),
						listing: listed([entry(TICKET, "active", 1, "held")]),
						journalA: [`${acquireId}.json`],
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"cbd-01: change-bounds shortens exactly, extends only over the time path, never switches mode or acts for others",
			async () => {
				await withCase(format, "bounds", {}, async (fixture) => {
					const a = await fixture.context();
					const b = await fixture.context();
					const hardEnd = Date.now() + 60 * MINUTE;
					// A's journal is empty.
					const acquired = await fixture.json(acquireArgs(TICKET, a, "--hard-end", iso(hardEnd)));
					const leaseEnd = plannedLeaseEnd(acquired.doc);
					// The grace is below reclaim_grace_ms, so a grace filled in from the configuration shows.
					const target = leaseTiming(leaseEnd - MINUTE, hardEnd - 10 * MINUTE, GRACE - MINUTE);
					const shorter = leaseBounds(leaseEnd - MINUTE, hardEnd - 10 * MINUTE, GRACE - MINUTE);
					// A's acquire record expects the absent ref, which the acquire replaced.
					const shortened = await fixture.json(boundsArgs(TICKET, a, "lease", ...shorter));
					// Positive control (catches: missing wiring; an ISO-to-ms error; the grace taken from the configuration;
					// `capped` from a TTL instead of the stored ends).
					expect({
						acquired: cliView(acquired),
						view: cliView(shortened),
						planned: field(shortened.doc, "planned"),
						rights: rightsFacts(shortened.doc),
					}).toEqual({
						acquired: applied("acquire", "held"),
						view: applied("change-bounds", "held"),
						planned: { status: "active", claimGeneration: 1, timing: target, capped: false },
						rights: { ownership: "held", claimGeneration: 1, workRight: { kind: "live", renewalDue: false } },
					});
					const firstId = field(shortened.doc, "operationId");
					const back = leaseBounds(leaseEnd - MINUTE, hardEnd, GRACE - MINUTE);
					// A's newest record expects the acquire's root, which the shortening replaced.
					const extended = await fixture.json(boundsArgs(TICKET, a, "lease", ...back));
					// The extension landed P and A; A's confirmation expects p, which A itself replaced.
					const extendedPlain = await fixture.plain(boundsArgs(TICKET, a, "lease", ...back));
					// A's newest record is the repeated bound's (a no-op write), whose own write replaced its root.
					const hard = await fixture.json(boundsArgs(TICKET, a, "hard", ...hardBounds(hardEnd - 10 * MINUTE, GRACE)));
					// B is another context with an empty journal.
					const foreign = await fixture.json(boundsArgs(TICKET, b, "lease", ...shorter));
					// A's newest record is still the repeated bound's; the mode change and B recorded nothing in A.
					const noop = await fixture.json(boundsArgs(TICKET, a, "lease", ...shorter));
					const listing = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", a.directory]);
					// catches: an extension refused although the time path carries it, or applied without A;
					// the repeated bound, now a no-op, refused instead of written; a silent mode switch; a foreign
					// change; the listed timing differing from the target.
					expect({
						extended: cliView(extended),
						extendedPhase: field(field(extended.doc, "transition"), "phase") ?? null,
						extendedPlain: plainView(extendedPlain),
						hard: cliView(hard),
						foreign: cliView(foreign),
						journalB: await fixture.recordNames(b),
						noop: cliView(noop),
						fresh: field(noop.doc, "operationId") !== firstId,
						listedTiming: field(firstEntry(listing.doc), "timing") ?? null,
						records: (await fixture.recordNames(a)).length,
					}).toEqual({
						extended: applied("change-bounds", "held", { sends: 2 }),
						extendedPhase: "confirmed",
						extendedPlain: plainOf("applied"),
						hard: planRejected("change-bounds", "mode-change", "held"),
						foreign: planRejected("change-bounds", "not-holder", "foreign"),
						journalB: [],
						noop: applied("change-bounds", "held"),
						fresh: true,
						listedTiming: target,
						// acquire, shortening, P and A of the extension, the repeated bound, the final shortening.
						records: 6,
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"crt-01: resolve and retry of lost transfer, resume and change-bounds operations end in the base document kinds",
			async () => {
				const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
				await withCase(format, "retry", { block }, async (fixture) => {
					const a = await fixture.context();
					const b = await fixture.context();
					// unk-01 of claim-cli.test.ts: the pre-receive hook holds past the timeout and then rejects.
					const lose = async (args: readonly string[], id: string): Promise<Lost> => {
						const held = await fixture.hooks.next("pre");
						await fixture.hooks.plan("pre", ["hold-reject"]);
						return { run: await fixture.json([...args, "--operation-id", id]), held };
					};
					const release = async (held: number): Promise<void> => {
						await fixture.hooks.settle("pre", held);
						await fixture.hooks.plan("pre", [], "pass");
					};
					// A's journal is empty.
					const acquired = await fixture.json(acquireArgs(TICKET, a));
					// A's acquire record expects the absent ref, which the acquire replaced.
					const transfer = await lose(transferArgs(TICKET, a, b), "op-crt-tr");
					// Positive control (catches: missing wiring; a lost transfer reported as rejected, applied or free).
					expect({ acquired: cliView(acquired), lost: cliView(transfer.run) }).toEqual({
						acquired: applied("acquire", "held"),
						lost: lostView("transfer", "held", "op-crt-tr"),
					});
					await release(transfer.held);
					const transferResolved = await fixture.json(onArgs("resolve", "op-crt-tr", a));
					// A transfer retry never reads --to-context, so B's directory is away while it runs.
					const away = `${b.directory}.away`;
					await rename(b.directory, away);
					// Retry never pauses; it is the way out of A's own open transfer.
					const transferRetried = await fixture.json(onArgs("retry", "op-crt-tr", a));
					await rename(away, b.directory);
					const transferPushes = await fixture.hooks.lines("pre", transfer.held - 1);
					const received = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", b.directory]);
					const acquireId = String(field(acquired.doc, "operationId"));
					// catches: resolve or retry of a transfer ending internal or record-corrupt; a retry that reads the
					// target again, plans anew or writes a second record; a target journal written.
					expect({
						resolved: cliView(transferResolved),
						retried: cliView(transferRetried),
						resent: resent(transferPushes),
						records: await fixture.recordNames(a),
						received: listView(received),
						journalB: await fixture.recordNames(b),
					}).toEqual({
						resolved: resolvedView("unknown", "unknown", "open", "transfer", "op-crt-tr"),
						retried: applied("retry", "foreign", { action: "transfer", operationId: "op-crt-tr" }),
						resent: { pushes: 2, identical: true },
						records: [`${acquireId}.json`, "op-crt-tr.json"].sort(byCodeUnits),
						received: listed([entry(TICKET, "active", 2, "held", RECEIVER)]),
						journalB: [],
					});

					// Another ticket; A's transfer record concerns TICKET and landed through the retry.
					const second = await fixture.json(acquireArgs(SECOND, a));
					const r = await fixture.recoveryContext(a);
					// R is another context with an empty journal.
					const resume = await lose(onArgs("resume", SECOND, r), "op-crt-rs");
					const resumeLost = cliView(resume.run);
					await release(resume.held);
					const resumeResolved = await fixture.json(onArgs("resolve", "op-crt-rs", r));
					// Retry never pauses; it is the way out of R's own open resume.
					const resumeRetried = await fixture.json(onArgs("retry", "op-crt-rs", r));
					const resumePushes = await fixture.hooks.lines("pre", resume.held - 1);

					const hardEnd = Date.now() + 60 * MINUTE;
					// Another ticket.
					const third = await fixture.json(acquireArgs(THIRD, a, "--hard-end", iso(hardEnd)));
					const leaseEnd = plannedLeaseEnd(third.doc);
					const shorter = leaseBounds(leaseEnd - MINUTE, hardEnd - 10 * MINUTE, GRACE);
					// A's record for THIRD expects the absent ref, which the acquire replaced.
					const bounds = await lose(boundsArgs(THIRD, a, "lease", ...shorter), "op-crt-bd");
					const boundsLost = cliView(bounds.run);
					await release(bounds.held);
					const boundsResolved = await fixture.json(onArgs("resolve", "op-crt-bd", a));
					// Retry never pauses.
					const boundsRetried = await fixture.json(onArgs("retry", "op-crt-bd", a));
					const boundsPushes = await fixture.hooks.lines("pre", bounds.held - 1);
					// catches: resolve or retry of resume or change-bounds ending internal (the list grown by
					// transfer only; change-bounds missing in the administration resend list [?2]).
					expect({
						second: cliView(second),
						resumeLost,
						resumeResolved: cliView(resumeResolved),
						resumeRetried: cliView(resumeRetried),
						resumeResent: resent(resumePushes),
						journalR: await fixture.recordNames(r),
						third: cliView(third),
						boundsLost,
						boundsResolved: cliView(boundsResolved),
						boundsRetried: cliView(boundsRetried),
						boundsResent: resent(boundsPushes),
					}).toEqual({
						second: applied("acquire", "held"),
						resumeLost: lostView("resume", "foreign", "op-crt-rs"),
						resumeResolved: resolvedView("unknown", "unknown", "open", "resume", "op-crt-rs"),
						resumeRetried: applied("retry", "held", { action: "resume", operationId: "op-crt-rs" }),
						resumeResent: { pushes: 2, identical: true },
						journalR: ["op-crt-rs.json"],
						third: applied("acquire", "held"),
						boundsLost: lostView("change-bounds", "held", "op-crt-bd"),
						boundsResolved: resolvedView("unknown", "unknown", "open", "change-bounds", "op-crt-bd"),
						boundsRetried: applied("retry", "held", { action: "change-bounds", operationId: "op-crt-bd" }),
						boundsResent: { pushes: 2, identical: true },
					});

					// unk-03 of claim-cli.test.ts: the change lands, post-receive holds past the timeout; the query proves it.
					const heldPost = await fixture.hooks.next("post");
					await fixture.hooks.plan("post", ["hold"]);
					const further = leaseBounds(leaseEnd - 2 * MINUTE, hardEnd - 20 * MINUTE, GRACE);
					const furtherArgs = [...boundsArgs(THIRD, a, "lease", ...further), "--operation-id", "op-crt-bd2"];
					// op-crt-bd expects the acquire's root of THIRD, which its retry replaced.
					const landed = await fixture.json(furtherArgs);
					await fixture.hooks.settle("post", heldPost);
					await fixture.hooks.plan("post", [], "pass");
					const beforeResend = await fixture.hooks.count("pre");
					// Retry never pauses.
					const again = await fixture.json(onArgs("retry", "op-crt-bd2", a));
					const againResolved = await fixture.json(onArgs("resolve", "op-crt-bd2", a));
					// catches: a landed bound change resent or reported unknown; resolve of it ending internal.
					expect({
						landed: cliView(landed),
						again: cliView(again),
						againResolved: cliView(againResolved),
						pushes: (await fixture.hooks.count("pre")) - beforeResend,
					}).toEqual({
						landed: applied("change-bounds", "held", {
							storage: queriedStorage("unknown", "stored"),
							operationId: "op-crt-bd2",
						}),
						again: applied("retry", "held", {
							action: "change-bounds",
							storage: queriedStorage("earlier-process", "stored"),
							sends: 0,
							operationId: "op-crt-bd2",
						}),
						againResolved: resolvedView("applied", "applied", "stored", "change-bounds", "op-crt-bd2"),
						pushes: 0,
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			CHAIN_TEST_TIMEOUT,
		);
	});
}

describe("claim CLI administration single-format cases (blob)", () => {
	test(
		"ctr-02: without a policy a hard end needs --time-box; preserve caps the default lease at H; hard stays hard",
		async () => {
			await withCase("blob", "time-box", { block: { ttlMs: 60 * MINUTE } }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 20 * MINUTE;
				await fixture.plant(SECOND, a, leaseTiming(t0 + 5 * MINUTE, hardEnd));
				await fixture.plant(THIRD, a, leaseTiming(t0 + 5 * MINUTE, hardEnd));
				await fixture.plant(TICKET, a, hardTiming(hardEnd));
				const secondRef = `refs/claims/${SECOND}`;
				const refBefore = (await fixture.serverRefs())[secondRef] ?? ABSENT_REF;
				// A's journal is empty (the claims were planted by another writer).
				const required = await fixture.json(transferArgs(SECOND, a, b));
				// Positive control (catches: missing wiring; preserve as a silent default; a record, an admission or
				// a send although the stored H needs an explicit time-box action, require-explicit).
				expect({
					view: cliView(required),
					journalA: await fixture.recordNames(a),
					ref: (await fixture.serverRefs())[secondRef] ?? ABSENT_REF,
				}).toEqual({
					view: planRejected("transfer", "time-box-required", "held"),
					journalA: [],
					ref: refBefore,
				});
				// No record; the plan rejection above recorded nothing.
				const requiredPlain = await fixture.plain(transferArgs(SECOND, a, b));
				// No record, as above.
				const restarted = await fixture.json(transferArgs(SECOND, a, b, "--time-box", "restart"));
				// No record, as above.
				const preserved = await fixture.json(transferArgs(SECOND, a, b, "--time-box", "preserve"));
				const tooLong = ["--time-box", "preserve", "--ttl-ms", String(120 * MINUTE)];
				// Another ticket.
				const overlong = await fixture.json(transferArgs(THIRD, a, b, ...tooLong));
				// Another ticket.
				const hardRequired = await fixture.json(transferArgs(TICKET, a, b));
				// No record on TICKET; the plan rejection above recorded nothing.
				const hardLease = await fixture.json(transferArgs(TICKET, a, b, "--time-box", "preserve", "--ttl-ms", "60000"));
				// No record, as above.
				const hardKept = await fixture.json(transferArgs(TICKET, a, b, "--time-box", "preserve"));
				const stale = ["--time-box", "preserve", "--expect-generation", "5"];
				// No record on THIRD; the overlong rejection recorded nothing.
				const changed = await fixture.json(transferArgs(THIRD, a, b, ...stale));
				// catches: restart without the time path; an explicit TTL cut silently; the cap not shown
				// ; a hard claim given a lease or a moved H; the generation guard skipped; no hint in the text.
				expect({
					plain: { view: plainView(requiredPlain), hint: hinted(requiredPlain, "--time-box") },
					restarted: cliView(restarted),
					preserved: cliView(preserved),
					preservedPlanned: field(preserved.doc, "planned"),
					overlong: cliView(overlong),
					hardRequired: cliView(hardRequired),
					hardLease: cliView(hardLease),
					hardKept: cliView(hardKept),
					hardKeptPlanned: field(hardKept.doc, "planned"),
					changed: cliView(changed),
				}).toEqual({
					plain: { view: plainOf("rejected"), hint: true },
					restarted: planRejected("transfer", "requires-time-path", "held"),
					preserved: applied("transfer", "foreign"),
					preservedPlanned: {
						status: "active",
						claimGeneration: 2,
						timing: leaseTiming(hardEnd, hardEnd),
						capped: true,
					},
					overlong: planRejected("transfer", "overlong", "held", hardEnd),
					hardRequired: planRejected("transfer", "time-box-required", "held"),
					hardLease: planRejected("transfer", "not-renewable", "held"),
					hardKept: applied("transfer", "foreign"),
					hardKeptPlanned: { status: "active", claimGeneration: 2, timing: hardTiming(hardEnd), capped: false },
					changed: planRejected("transfer", "generation-changed", "held"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"ctr-03: claims.transfer_time_box supplies a missing time-box action, the flag wins, a retry never re-reads it",
		async () => {
			const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
			await withCase("blob", "policy", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 20 * MINUTE;
				await fixture.plant(TICKET, a, leaseTiming(t0 + 5 * MINUTE, hardEnd));
				await fixture.plant(SECOND, a, leaseTiming(t0 + 5 * MINUTE, hardEnd));
				await fixture.plant(THIRD, a, leaseTiming(t0 + 5 * MINUTE, null));
				await fixture.writeBlock({ timeBoxPolicy: "preserve" });
				const s0 = Date.now();
				// A's journal is empty (the claims were planted by another writer).
				const preserved = await fixture.json(transferArgs(TICKET, a, b));
				const s1 = Date.now();
				// Positive control (catches: the key reported as unknown-key; the policy ignored; H dropped).
				expect({ view: cliView(preserved), planned: windowed(preserved.doc, s0 + TTL, s1 + TTL) }).toEqual({
					view: applied("transfer", "foreign"),
					planned: {
						status: "active",
						claimGeneration: 2,
						timing: { mode: "lease", leaseEnd: IN_WINDOW, hardEnd, graceMs: GRACE },
						capped: false,
					},
				});
				await fixture.writeBlock({ timeBoxPolicy: "require-explicit" });
				// Another ticket; A's only record concerns TICKET.
				const explicitOnly = await fixture.json(transferArgs(SECOND, a, b));
				await fixture.writeBlock({ timeBoxPolicy: "restart" });
				// No record on SECOND; the plan rejection above recorded nothing.
				const restartHard = await fixture.json(transferArgs(SECOND, a, b));
				// Another ticket with no record.
				const restartLease = await fixture.json(transferArgs(THIRD, a, b));
				await fixture.writeBlock({ timeBoxPolicy: "preserve" });
				// No record on SECOND, as above.
				const explicitWins = await fixture.json(transferArgs(SECOND, a, b, "--time-box", "restart"));
				// The frozen retry: the policy preserve plans the transfer, the reply is lost, then the policy changes.
				const held = await fixture.hooks.next("pre");
				await fixture.hooks.plan("pre", ["hold-reject"]);
				// No record on SECOND, as above.
				const lost = await fixture.json(transferArgs(SECOND, a, b, "--operation-id", "op-ctr-03"));
				await fixture.hooks.settle("pre", held);
				await fixture.hooks.plan("pre", [], "pass");
				await fixture.writeBlock({ timeBoxPolicy: "require-explicit" });
				const recorded = await fixture.recordNames(a);
				// Retry never pauses; it replays the frozen record and never reads the policy.
				const retried = await fixture.json(onArgs("retry", "op-ctr-03", a));
				const pushes = await fixture.hooks.lines("pre", held - 1);
				// catches: the policy ignored or applied without H; the explicit flag losing; a policy restart that blocks
				// a lease without H; a retry that plans anew with the changed policy or records again.
				expect({
					explicitOnly: cliView(explicitOnly),
					restartHard: cliView(restartHard),
					restartLease: cliView(restartLease),
					explicitWins: cliView(explicitWins),
					lost: cliView(lost),
					lostRecorded: recorded.includes("op-ctr-03.json"),
					retried: cliView(retried),
					resent: resent(pushes),
					records: await fixture.recordNames(a),
				}).toEqual({
					explicitOnly: planRejected("transfer", "time-box-required", "held"),
					restartHard: planRejected("transfer", "requires-time-path", "held"),
					restartLease: applied("transfer", "foreign"),
					explicitWins: planRejected("transfer", "requires-time-path", "held"),
					lost: lostView("transfer", "held", "op-ctr-03"),
					lostRecorded: true,
					retried: applied("retry", "foreign", { action: "transfer", operationId: "op-ctr-03" }),
					resent: { pushes: 2, identical: true },
					records: recorded,
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"ctr-04: input, target, recovery, bounds and configuration errors of the three commands end before the network",
		async () => {
			const proxy = await StallProxy.create();
			try {
				const stalled = `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
				const setup = { descriptor: false, block: { endpoint: stalled, timeoutMs: STALL_TIMEOUT } };
				await withCase("blob", "local", setup, async (fixture) => {
					const a = await fixture.context();
					const b = await fixture.context();
					const noTarget = ["claim", "transfer", TICKET, "--owner", RECEIVER, "--context", a.directory];
					const missingTarget = await fixture.json(noTarget);
					// Positive control (catches: missing wiring; a target taken from a default, the environment or the only
					// other context).
					expect(cliView(missingTarget)).toEqual(failed("transfer", "refused", "target-context-invalid"));
					const brokenTarget = await fixture.brokenContext();
					const brokenOwn = await fixture.brokenContext();
					const copy = await fixture.copyContext(a);
					const recovered = await fixture.recoveryContext(a);
					const relativeTarget = "contexts/relative-target";
					const absentTarget = join(fixture.parent, `absent-${SENTINEL}`);
					const hardEnd = Date.now() + 60 * MINUTE;
					const before = { target: await dirSnapshot(b.directory), copy: await dirSnapshot(copy.directory) };
					// No row reaches the executor, so no context records anything that could pause a later row.
					const rows: LocalRow[] = [
						{
							label: "relative --to-context",
							catches: "a repaired relative target",
							command: "transfer",
							args: transferTo(TICKET, a, relativeTarget),
							code: "target-context-invalid",
						},
						{
							label: "absolute --to-context that does not exist",
							catches: "a target created or derived instead",
							command: "transfer",
							args: transferTo(TICKET, a, absentTarget),
							code: "target-context-invalid",
						},
						{
							label: "target with context.json 0644",
							catches: "a corrupt target reported as the own context-corrupt",
							command: "transfer",
							args: transferArgs(TICKET, a, brokenTarget),
							code: "target-context-invalid",
						},
						{
							label: "target is the own context",
							catches: "a transfer to self",
							command: "transfer",
							args: transferArgs(TICKET, a, a),
							code: "target-context-invalid",
						},
						{
							label: "target is a byte copy of the own context",
							catches: "a self-transfer compared by path only",
							command: "transfer",
							args: transferArgs(TICKET, a, copy),
							code: "target-context-invalid",
						},
						{
							label: "own context corrupt, target healthy",
							catches: "own and target codes swapped; the target checked first",
							command: "transfer",
							args: transferArgs(TICKET, brokenOwn, b),
							code: "context-corrupt",
						},
						{
							label: "no --owner",
							catches: "an owner derived from the assignee or the source",
							command: "transfer",
							args: ["claim", "transfer", TICKET, "--to-context", b.directory, "--context", a.directory],
							code: "owner-required",
						},
						{
							label: "--time-box keep",
							catches: "a lax time-box value",
							command: "transfer",
							args: transferArgs(TICKET, a, b, "--time-box", "keep"),
							code: "invalid-option",
						},
						{
							label: "--ttl-ms 0",
							catches: "a non-positive TTL passed to the planner",
							command: "transfer",
							args: transferArgs(TICKET, a, b, "--ttl-ms", "0"),
							code: "invalid-option",
						},
						{
							label: "resume without a recovery proof",
							catches: "a missing proof reported as request-invalid after the network",
							command: "resume",
							args: onArgs("resume", TICKET, a),
							code: "recovery-missing",
						},
						{
							label: "change-bounds without --mode",
							catches: "a mode derived from the flags or the stored state",
							command: "change-bounds",
							args: onArgs("change-bounds", TICKET, a),
							code: "bounds-required",
						},
						{
							label: "--mode soft",
							catches: "a lax mode value",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "soft"),
							code: "invalid-option",
						},
						{
							label: "lease without --lease-end",
							catches: "a lease end filled in from the configuration or the stored state",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "lease", "--grace-ms", String(GRACE)),
							code: "bounds-required",
						},
						{
							label: "hard with --lease-end",
							catches: "an option silently ignored",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "hard", ...hardBounds(hardEnd, GRACE), "--lease-end", iso(hardEnd - MINUTE)),
							code: "option-not-applicable",
						},
						{
							label: "none with --grace-ms",
							catches: "an option silently ignored",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "none", "--grace-ms", "1"),
							code: "option-not-applicable",
						},
						{
							label: "--lease-end without a zone",
							catches: "a second, laxer time parser",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "lease", "--lease-end", "2027-01-15T08:00:00", "--grace-ms", String(GRACE)),
							code: "invalid-option",
						},
						{
							label: "lease end after the hard end",
							catches: "no local isClaimTiming check",
							command: "change-bounds",
							args: boundsArgs(TICKET, a, "lease", ...leaseBounds(hardEnd + MINUTE, hardEnd, GRACE)),
							code: "invalid-option",
						},
						{
							label: "context create --recover-from with a relative source",
							catches: "a repaired relative recovery source",
							command: "context-create",
							args: ["claim", "context", "create", "--parent", fixture.parent, "--recover-from", "rel/x"],
							code: "context-invalid",
						},
					];
					const runs: JsonRun[] = [];
					for (const row of rows) runs.push(await fixture.json(row.args));
					await fixture.writeBlock({ timeBoxPolicy: "keep" });
					// Still no record in any context; the configuration ends the call before the executor.
					const policy = await fixture.json(transferArgs(TICKET, a, b));
					await fixture.writeBlock({ timeBoxPolicy: null });
					const usageArgs = ["claim", "resume", TICKET, "--context", a.directory, "--ttl-ms", "1", "--json"];
					// A Commander usage error never reaches the core.
					const usage = await fixture.raw(usageArgs);
					// catches: network or IO before the local checks; own and target codes swapped; a field filled in; an
					// unknown option accepted; the policy value unchecked; the target or the copy written.
					expect({
						views: runs.map((run, index) => ({ label: rows[index]?.label, view: cliView(run) })),
						policy: cliView(policy),
						problems: field(policy.doc, "problems"),
						usage: [usage.exit, `${usage.stdout}${usage.stderr}`.includes("unknown option '--ttl-ms'")],
						connections: proxy.acceptedConnections,
						journals: [await fixture.recordNames(a), await fixture.recordNames(b), await fixture.recordNames(copy)],
						target: await dirSnapshot(b.directory),
						copy: await dirSnapshot(copy.directory),
					}).toEqual({
						views: rows.map((row) => ({ label: row.label, view: failed(row.command, "refused", row.code) })),
						policy: failed("transfer", "refused", "config-invalid"),
						problems: [{ key: "claims.transfer_time_box", problem: "unsupported-value" }],
						usage: [1, true],
						connections: 0,
						journals: [[], [], []],
						target: before.target,
						copy: before.copy,
					});
					// Counter positive control (catches: a dead counter): a resume from a recovery context of A passes every
					// local check and reaches the stalled endpoint in the preflight.
					// The recovery context is another context with an empty journal.
					const reached = await fixture.json(onArgs("resume", TICKET, recovered));
					expect({ view: cliView(reached), connected: proxy.acceptedConnections > 0 }).toEqual({
						view: failed("resume", "unavailable", "unreachable"),
						connected: true,
					});
					expect(await fixture.leaks([["relative target", relativeTarget]])).toEqual([]);
				});
			} finally {
				await proxy.close();
			}
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"crs-02: resume after the hard end rebinds without reviving a work right; the replaced holder cannot release",
		async () => {
			await withCase("blob", "resume-late", {}, async (fixture) => {
				const a = await fixture.context();
				const hardEnd = Date.now() - MINUTE;
				await fixture.plant(SECOND, a, hardTiming(hardEnd));
				const r = await fixture.recoveryContext(a);
				// R is another context with an empty journal.
				const resumed = await fixture.json(onArgs("resume", SECOND, r));
				// Positive control (catches: missing wiring; a work right revived after H; H moved).
				expect({
					view: cliView(resumed),
					planned: field(resumed.doc, "planned"),
					rights: rightsFacts(resumed.doc),
				}).toEqual({
					view: applied("resume", "held"),
					planned: { status: "active", claimGeneration: 1, timing: hardTiming(hardEnd), capped: false },
					rights: { ownership: "held", claimGeneration: 1, workRight: { kind: "none", cause: "hard-expired" } },
				});
				// A's journal is empty (the claim was planted by another writer).
				const releasedA = await fixture.json(onArgs("release", SECOND, a));
				// R's resume record expects the planted root, which the resume replaced.
				const releasedR = await fixture.json(onArgs("release", SECOND, r));
				// catches: the replaced holder releasing; the new holder unable to release after H.
				expect({ releasedA: cliView(releasedA), releasedR: cliView(releasedR) }).toEqual({
					releasedA: planRejected("release", "not-holder", "foreign"),
					releasedR: applied("release", "free"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"cbd-02: a lease without H moves freely, a first hard end narrows, R under H cannot rise, none stays none",
		async () => {
			await withCase("blob", "bounds-free", {}, async (fixture) => {
				const a = await fixture.context();
				const leaseEnd = Date.now() + 5 * MINUTE;
				await fixture.plant(SECOND, a, leaseTiming(leaseEnd, null));
				await fixture.plant(THIRD, a, NONE_TIMING);
				const unbounded = leaseBounds(leaseEnd + DAY, null, 2 * GRACE);
				// A's journal is empty (the claims were planted by another writer).
				const moved = await fixture.json(boundsArgs(SECOND, a, "lease", ...unbounded));
				// Positive control (catches: missing wiring; a change without a work limit sent to the time path).
				expect({ view: cliView(moved), timing: field(field(moved.doc, "planned"), "timing") }).toEqual({
					view: applied("change-bounds", "held"),
					timing: leaseTiming(leaseEnd + DAY, null, 2 * GRACE),
				});
				const firstEnd = leaseEnd + 30 * MINUTE;
				const narrowing = leaseBounds(firstEnd, firstEnd + 10 * MINUTE, 2 * GRACE);
				// A's record expects the planted root, which the change replaced.
				const narrowed = await fixture.json(boundsArgs(SECOND, a, "lease", ...narrowing));
				const raising = leaseBounds(firstEnd, firstEnd + 10 * MINUTE, 3 * GRACE);
				// A's newest record expects the root before the narrowing, which the narrowing replaced.
				const raised = await fixture.json(boundsArgs(SECOND, a, "lease", ...raising));
				// Another ticket.
				const kept = await fixture.json(boundsArgs(THIRD, a, "none"));
				// A's record for THIRD expects the planted root, which the no-op write replaced.
				const switched = await fixture.json(boundsArgs(THIRD, a, "lease", ...leaseBounds(leaseEnd, null, GRACE)));
				// catches: a first hard end treated as an extension; R raised under H through the bound change; a
				// timeless no-op refused; a mode switch into a lease.
				expect({
					narrowed: cliView(narrowed),
					narrowedTiming: field(field(narrowed.doc, "planned"), "timing"),
					raised: cliView(raised),
					kept: cliView(kept),
					keptTiming: field(field(kept.doc, "planned"), "timing"),
					switched: cliView(switched),
				}).toEqual({
					narrowed: applied("change-bounds", "held"),
					narrowedTiming: leaseTiming(firstEnd, firstEnd + 10 * MINUTE, 2 * GRACE),
					raised: planRejected("change-bounds", "requires-time-path", "held"),
					kept: applied("change-bounds", "held"),
					keptTiming: NONE_TIMING,
					switched: planRejected("change-bounds", "mode-change", "held"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"cdis-01: under enabled false transfer, change-bounds, resume and a transfer retry stay allowed, acquire does not",
		async () => {
			const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
			await withCase("blob", "disabled", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				// A's journal is empty.
				const first = await fixture.json(acquireArgs(TICKET, a));
				// Another ticket.
				const second = await fixture.json(acquireArgs(SECOND, a));
				const held = await fixture.hooks.next("pre");
				await fixture.hooks.plan("pre", ["hold-reject"]);
				// A's record for SECOND expects the absent ref, which its acquire replaced.
				const lost = await fixture.json(transferArgs(SECOND, a, b, "--operation-id", "op-dis-tr"));
				// Positive control (catches: missing wiring of transfer; a lost transfer reported as final).
				expect({ first: cliView(first), second: cliView(second), lost: cliView(lost) }).toEqual({
					first: applied("acquire", "held"),
					second: applied("acquire", "held"),
					lost: lostView("transfer", "held", "op-dis-tr"),
				});
				await fixture.hooks.settle("pre", held);
				await fixture.hooks.plan("pre", [], "pass");
				await fixture.writeBlock({ enabled: false });
				// Another ticket; the open op-dis-tr concerns SECOND.
				const moved = await fixture.json(transferArgs(TICKET, a, b));
				const earlier = leaseBounds(plannedLeaseEnd(moved.doc) - MINUTE, null, GRACE);
				// B is another context with an empty journal.
				const shortened = await fixture.json(boundsArgs(TICKET, b, "lease", ...earlier));
				const r = await fixture.recoveryContext(b);
				// R is another context with an empty journal.
				const resumed = await fixture.json(onArgs("resume", TICKET, r));
				// Another ticket; the disabled gate ends it in the preflight before the executor.
				const refused = await fixture.json(acquireArgs(THIRD, a));
				// Retry never pauses; only acquire records need enabled (surface/index.ts:1437-1439).
				const retried = await fixture.json(onArgs("retry", "op-dis-tr", a));
				// catches: a new command given the acquire purpose; a transfer record treated like acquire on
				// retry; enabled false not blocking acquire.
				expect({
					moved: cliView(moved),
					shortened: cliView(shortened),
					resumed: cliView(resumed),
					refused: cliView(refused),
					retried: cliView(retried),
				}).toEqual({
					moved: applied("transfer", "foreign"),
					shortened: applied("change-bounds", "held"),
					resumed: applied("resume", "held"),
					refused: failed("acquire", "refused", "claims-disabled"),
					retried: applied("retry", "foreign", { action: "transfer", operationId: "op-dis-tr" }),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cpau-01: an own open transfer pauses the next transfer and change-bounds with exit 7; retry is the way out",
		async () => {
			await withCase("blob", "pause", {}, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				// A's journal is empty.
				const acquired = await fixture.json(acquireArgs(TICKET, a));
				await fixture.hooks.plan("pre", ["reject"]);
				// A's acquire record expects the absent ref, which the acquire replaced.
				const rejected = await fixture.json(transferArgs(TICKET, a, b, "--operation-id", "op-pau-01"));
				// Positive control (catches: missing wiring; a remote rejection retried or reported as applied).
				expect({ acquired: cliView(acquired), rejected: cliView(rejected) }).toEqual({
					acquired: applied("acquire", "held"),
					rejected: view({
						status: "rejected",
						command: "transfer",
						action: "transfer",
						outcome: "rejected",
						rejection: { stage: "storage", cause: "remote" },
						storage: { kind: "rejected", cause: "remote" },
						sends: 1,
						ownership: "held",
						operationId: "op-pau-01",
					}),
				});
				const acquireId = String(field(acquired.doc, "operationId"));
				const earlier = leaseBounds(plannedLeaseEnd(acquired.doc) - MINUTE, null, GRACE);
				const beforePause = await fixture.hooks.count("pre");
				// On purpose: op-pau-01 stays outstanding at the unchanged root, so A's next
				// mutating calls on TICKET pause before any plan, record or send; no pause exception for the new commands.
				const pausedTransfer = await fixture.json(transferArgs(TICKET, a, b));
				const pausedPlain = await fixture.plain(transferArgs(TICKET, a, b));
				const pausedBounds = await fixture.json(boundsArgs(TICKET, a, "lease", ...earlier));
				// catches: the pause of a new command mapped to internal; a new command that bypasses the pause.
				expect({
					transfer: pausedView(pausedTransfer),
					plain: plainView(pausedPlain),
					bounds: pausedView(pausedBounds),
					pushes: (await fixture.hooks.count("pre")) - beforePause,
					records: await fixture.recordNames(a),
				}).toEqual({
					transfer: pausedOf("transfer", TICKET, ["op-pau-01"]),
					plain: plainOf("paused"),
					bounds: pausedOf("change-bounds", TICKET, ["op-pau-01"]),
					pushes: 0,
					records: [`${acquireId}.json`, "op-pau-01.json"].sort(byCodeUnits),
				});
				// Retry never pauses and is the way out; the rejected send left the root unchanged, so it resends.
				const retried = await fixture.json(onArgs("retry", "op-pau-01", a));
				const received = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", b.directory]);
				// catches: the way out blocked for a transfer record.
				expect({ retried: cliView(retried), received: listView(received) }).toEqual({
					retried: applied("retry", "foreign", { action: "transfer", operationId: "op-pau-01" }),
					received: listed([entry(TICKET, "active", 2, "held", RECEIVER)]),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);
});

describe("claim CLI administration documentation (no project)", () => {
	test(
		"cdoc-01: transfer, resume, change-bounds and context create document fields, document and examples",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-admin-docs-"));
			try {
				const transfer = await helpView(cwd, "transfer", "claim-operation", TRANSFER_FIELDS);
				// Positive control (catches: a command registered without addHelpSchema).
				expect(transfer).toEqual(documented("transfer"));
				const helps: HelpView[] = [];
				for (const [command, kind, fields] of NEW_HELP) helps.push(await helpView(cwd, command, kind, fields));
				const group = await runCli(cwd, ["claim", "--help"]);
				const text = group.stdout + group.stderr;
				// catches: an undocumented option (--recover-from on context create); a command missing from the group
				// help; an exit code row lost.
				expect({
					helps,
					exit: group.exit,
					unlisted: NEW_COMMANDS.filter((command) => !text.includes(command)),
					missingRows: missingExitRows(text),
				}).toEqual({
					helps: NEW_HELP.map(([command]) => documented(command)),
					exit: 0,
					unlisted: [],
					missingRows: [],
				});
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);

	test(
		"cdoc-02: the claims guide names the three commands, --recover-from, the policy key, four causes and codes",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-admin-docs-"));
			try {
				const guide = await runCli(cwd, ["instructions", "claims"]);
				// Positive control (catches: a guide without the administration commands).
				expect({ exit: guide.exit, missingTerms: GUIDE_TERMS.filter((term) => !guide.stdout.includes(term)) }).toEqual({
					exit: 0,
					missingTerms: [],
				});
				const index = await runCli(cwd, ["instructions"]);
				const listing = await runCli(cwd, ["instructions", "--list"]);
				// catches: a guide no longer registered; exit rows lost; index invariants of cli-guidance.test.ts broken.
				expect({
					missingRows: missingExitRows(guide.stdout),
					indexed: index.stdout.includes("backlog instructions claims"),
					listed: listing.stdout.includes("claims"),
					leaked: ["--plain", "bundled", "binary"].filter((term) => index.stdout.includes(term)),
				}).toEqual({ missingRows: [], indexed: true, listed: true, leaked: [] });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
