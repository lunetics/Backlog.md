/**
 * End-to-end contract of batch reclaim and its preview: the real `backlog claim reclaim-batch` and
 * `backlog claim reclaim-preview` subprocesses, plus one `claim acquire` control, in real Backlog projects whose task
 * files carry status, labels, assignees and dependencies, against the loopback Git daemon (blob; cli-08 tree and
 * commit-chain), with scripted receive hooks (S1, test-local) whose pre-receive counter and stdin log are the push
 * oracle, the StallProxy connection counter and private contexts created through the context API. Claims are planted
 * by an independent writer under a foreign binding with fixed timings: a lease that ended on 2026-01-01 is
 * reclaimable at any real clock of a run, one that ends in 2100 never is; no test waits for a boundary. The CLI runs
 * on the real clock, so `observedAt` is checked as an interval around the call. Every JSON document is checked
 * against a test-local validator whose closed lists gain the two kinds, the two commands and `scope-required`
 * besides the commands, actions and codes the administration commands and `claim next` add; a batch document is
 * checked entry by entry as the unchanged `claim reclaim` documents it carries, and its stop structure and overall
 * status rank are re-derived independently. Every stdout and stderr is scanned for bindings, secrets, context paths,
 * the endpoint, server roots, journal digests, hook stderr, filter values and owner names (allowed only in preview
 * entries). Every test starts with a positive control the scaffold cannot satisfy. Follow-up mutating calls run only
 * against a changed root or from another context; each names why it does not pause. The harness is an adapted copy of
 * claim-cli.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
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

// adapted from claim-cli.test.ts:33-99: CaseSetup carries task specs and a block change function instead of a
// Partial; CliRun carries the wall-clock interval of the call instead of its duration; the batch, entry, preview,
// line and stored-state views are new; the list, setup, init, context, snapshot and configuration-row types are left
// out because no call here produces them.
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
};
/** A block change: a full copy with literal overrides, never a spread of a Partial over required fields. */
type BlockChange = (base: BlockOptions) => BlockOptions;
/** One local task file; claim refs are planted separately, so a ticket may have a file, a ref, both or neither. */
type TicketSpec = {
	id: string;
	status?: string;
	labels?: readonly string[];
	assignee?: readonly string[];
	dependencies?: readonly string[];
};
type CaseSetup = { tickets?: readonly TicketSpec[]; block?: BlockChange };
type ContextHandle = { context: ClaimContext; directory: string };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
/** `startedAt`/`endedAt`: the test process's wall clock around the call, for instants the CLI reads itself. */
type CliRun = { exit: number; stdout: string; stderr: string; startedAt: number; endedAt: number };
type JsonRun = CliRun & { doc: unknown };
type Output = { command: string; text: string; ownerAllowed: boolean };
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
/** One batch entry: ticket, result and the base view of its `claim reclaim` document; null for an untried entry. */
type EntryView = { ticket: unknown; result: unknown; view: CliView | null };
/** Field by field; `observedAt` reads IN_WINDOW when it lies within the call. */
type BatchView = {
	exit: number;
	schema: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	observedAt: unknown;
	complete: unknown;
	unreadable: unknown;
	stoppedAt: unknown;
	entries: EntryView[] | null;
};
/** Field by field; the entries stay plain data and are compared whole. */
type PreviewView = {
	exit: number;
	schema: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	observedAt: unknown;
	complete: unknown;
	entries: unknown;
};
type PlainView = { exit: number; stream: string; head: string | null };
/** One human batch line `<ticket> <result> [<operationId>]`. */
type LineView = { ticket: string; result: string | null; operationId: "generated" | null };
/** The human preview line of one ticket, its verdict and whether it shows the boundary. */
type PreviewLine = { ticket: string; verdict: string | null; boundary: boolean | null };
/** `fields`: options without their own schema line (help-schema.ts:31-35 renders `  - <name>: <type>`). */
type HelpView = { command: string; exit: number; missing: string[]; kind: boolean; json: boolean; fields: string[] };
type Shape = { required: readonly string[]; optional: readonly string[] };
type LocalRow = { label: string; catches: string; command: string; args: string[]; code: string };
/** O1: status, owner and generation of the stored claim state as an independent reader sees it. */
type StoredView = { status: unknown; owner: unknown; claimGeneration: unknown };

// adapted from claim-cli.test.ts:101-151: an own sentinel, several owners, the filter values, the fixed lease ends
// and the window placeholder are new; the template keys and the base help lists are left out.
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of healthy cases, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of lost-reply cases; every scripted hold outlasts it (claim-cli.test.ts:108-109). */
const LOSS_TIMEOUT = 2_000;
/** attempt_timeout_ms of the case that must contact the stalled endpoint (claim-cli.test.ts:110-111). */
const STALL_TIMEOUT = 750;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** cli-08: the two formats besides blob, which every other case uses. */
const CHAIN_FORMATS = ["tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/** Appears in case, project, context and endpoint paths and in hook stderr; no output may contain it. */
const SENTINEL = "SENTINEL-reclaim-cli-5b9e";
/** Display names of planted claims and of the acquire control; allowed only in preview entries. */
const KARL = "agent-owner-karl";
const FRANZ = "agent-owner-franz";
const LENA_OWNER = "agent-owner-lena";
/** out-07 of base (claim-cli.test.ts:128-129): an owner written by an independent writer with an escape sequence. */
const ESC_OWNER = "agent-\u001b[31m-owner";
const OWNERS: readonly string[] = [KARL, FRANZ, LENA_OWNER, ESC_OWNER];
/** cli-02 task data and one unconfigured status; filter values are never echoed. */
const MARIA = "assignee-human-maria";
const OTTO = "assignee-human-otto";
const LABEL_X = "wiring-label-x";
const LABEL_Y = "wiring-label-y";
const LABEL_NONE = "wiring-label-none";
const NO_STATUS = "status-nowhere-configured";
const FILTER_VALUES: readonly Sentinel[] = [
	["filter value", MARIA],
	["filter value", OTTO],
	["filter value", LABEL_X],
	["filter value", LABEL_Y],
	["filter value", LABEL_NONE],
	["filter value", NO_STATUS],
];
/** The binding of every planted claim; it belongs to no context of the case (claim-cli.test.ts:130). */
const OTHER_BINDING = `tb1-${"6f".repeat(32)}`;
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
const FOURTH = "BACK-4";
const FIFTH = "BACK-5";
const SIXTH = "BACK-6";
const NINTH = "BACK-9";
const TENTH = "BACK-10";
const TICKETS: readonly string[] = [TICKET, SECOND, THIRD];
/** The task files of every case without its own list: three To Do tickets without dependencies (base fixture). */
const DEFAULT_TICKETS: readonly TicketSpec[] = TICKETS.map((id) => ({ id }));
/** cli-02: THIRD waits for SECOND (To Do), so it is blocked; TICKET and FOURTH carry assignees. */
const WIRING_TICKETS: readonly TicketSpec[] = [
	{ id: TICKET, status: "In Progress", labels: [LABEL_X], assignee: [MARIA] },
	{ id: SECOND, status: "To Do", labels: [LABEL_X] },
	{ id: THIRD, status: "In Progress", labels: [LABEL_Y], dependencies: [SECOND] },
	{ id: FOURTH, status: "To Do", labels: [LABEL_X], assignee: [OTTO] },
];
/** A lease end in the past: R = LAPSED_END + GRACE lies months before any real clock of a run (reclaimable). */
const LAPSED_END = Date.UTC(2026, 0, 1);
/** A lease end no run reaches: not-yet at any real clock of a run. */
const FUTURE_END = Date.UTC(2100, 0, 1);
/** Rights state timing of the timeless mode (rights/index.ts:17); never reclaimable. */
const NONE_TIMING: JsonObject = { mode: "none" };
/** Stands for an instant the CLI read between the start and the end of the call (real clock). */
const IN_WINDOW = "(read during the call)";
const CLAIM_REF_PREFIX = "refs/claims/";
/** lst-01 of base (claim-cli.test.ts:1977): a name under refs/claims/ that is no canonical ticket ID. */
const FOREIGN_REF = "refs/claims/not-a-ticket";
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
const ANY_ID = /op-[0-9a-f-]{36}/g;
/** The closed status and exit code table; the contract adds no status. */
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
/** cli-06: both verbs and the kind their help names (convention claim.ts:90, :253, :290). */
const RECLAIM_HELP = [
	["reclaim-batch", "claim-reclaim-batch"],
	["reclaim-preview", "claim-reclaim-preview"],
] as const;
/**
 * ASSUMPTION(batch reclaim): scope options with their own help schema line, named by spelling (claim.ts:53-57, :286).
 */
const SCOPE_FIELDS: readonly string[] = ["--context", "--ticket", "--all", "--claim-owner"];
/** ASSUMPTION(batch reclaim): terms of the guide after GREEN; each counts 0 in the guide before the change. */
const GUIDE_TERMS: readonly string[] = [
	"claim reclaim-batch",
	"claim reclaim-preview",
	"claim-reclaim-batch",
	"claim-reclaim-preview",
	"--all",
	"--claim-owner",
	"scope-required",
];

// doc-04 of the base CLI: the documented schema, independent of the module under test.
// adapted from claim-cli.test.ts:182-234: + the batch and preview shapes, COMMANDS + the administration, claim next
// and batch reclaim commands, ACTIONS = the seven actions of transition/index.ts:32-40, ERROR_CODES + the
// administration codes, The list, resolution, setup, init and context shapes are left out.
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
		optional: [],
	},
	"claim-pause": { required: ["action", "ticket", "operationId", "pause", "rights"], optional: [] },
	"claim-error": {
		required: ["code", "message", "ticket", "operationId"],
		optional: ["problems", "configuredFormat", "existingFormat"],
	},
	// ASSUMPTION(batch reclaim): the closed key set of the batch document.
	"claim-reclaim-batch": { required: ["observedAt", "complete", "unreadable", "stoppedAt", "entries"], optional: [] },
	// ASSUMPTION(batch reclaim): the closed key set of the preview document.
	"claim-reclaim-preview": { required: ["complete", "observedAt", "entries"], optional: [] },
};
const STATUSES: readonly unknown[] = Object.keys(EXIT);
/** Base commands, the administration commands (transfer, resume, change-bounds), `next` and the two reclaim verbs. */
const COMMANDS: readonly unknown[] = `
	acquire renew release reclaim resolve retry list setup init context-create
	transfer resume change-bounds next reclaim-batch reclaim-preview
`
	.trim()
	.split(/\s+/);
const ACTIONS: readonly unknown[] = ["acquire", "renew", "release", "reclaim", "transfer", "resume", "change-bounds"];
const OUTCOMES: readonly unknown[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTIONS: readonly unknown[] = "stored not-stored open conflict unknown unknown-history invalid".split(" ");
const OUTER_QUERIES: readonly unknown[] =
	"record-absent record-corrupt invalid unavailable unknown unknown-history unsupported".split(" ");
const RIGHTS_FAILURES: readonly unknown[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
const STOPS: readonly unknown[] = [null, "attempts", "budget"];
/** The kinds a batch entry can carry, each with `command: "reclaim"`. */
const ENTRY_KINDS: readonly unknown[] = ["claim-operation", "claim-pause", "claim-error"];
/** ASSUMPTION(batch reclaim): the closed verdict list of preview entries. */
const VERDICTS: readonly unknown[] = [
	"eligible",
	"not-yet",
	"never",
	"free",
	"absent",
	"unknown",
	"state-corrupt",
	"state-unsupported",
];
/** `boundary` only for these two; `owner` and `timing` only for an ACTIVE state (these three). */
const BOUNDED_VERDICTS: readonly unknown[] = ["eligible", "not-yet"];
const ACTIVE_VERDICTS: readonly unknown[] = ["eligible", "not-yet", "never"];
/** A generation exactly where the stored state carries one. */
const GENERATION_VERDICTS: readonly unknown[] = ["eligible", "not-yet", "never", "free"];
/** Entry statuses from the most to the least urgent; `applied` ranks as ok, `untried` not at all. */
const URGENCY: readonly string[] = [
	"unknown",
	"unknown-history",
	"internal",
	"paused",
	"refused",
	"unavailable",
	"rejected",
	"ok",
];
/** The base codes plus the administration codes (four), the claim next codes (three) and scope-required. */
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
	dependency-blocked dependency-unknown tasks-unavailable
	scope-required
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

// adapted from claim-cli.test.ts:299-309 (the wall-clock interval instead of the duration)
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const startedAt = Date.now();
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return {
		exit: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		startedAt,
		endedAt: Date.now(),
	};
}

// adapted from claim-cli.test.ts:311-314 (no context create here)
function commandOf(args: readonly string[]): string {
	if (args[0] !== "claim") return args[0] ?? "";
	return args[1] ?? "";
}

// adapted from claim-cli.test.ts:316-322
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/** Owner names are display data in preview entries only; the collector drops them there. */
// adapted from claim-cli.test.ts:324-332 (preview entries instead of list claims)
function withoutOwners(doc: unknown): unknown {
	const entries = field(doc, "entries");
	if (field(doc, "kind") !== "claim-reclaim-preview" || !Array.isArray(entries) || !isRecord(doc)) return doc;
	const stripped = entries.map((item: unknown) =>
		isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "owner")) : item,
	);
	return { ...doc, entries: stripped };
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-cli.test.ts:334-337
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-cli.test.ts:339-357 (isRecord, exact, integer, nullableText)
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

function texts(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// adapted from claim-cli.test.ts:359-469 (timingOk, queryOk, storageOk, rightsOk, rejectionOk, plannedOk, problemsOk,
// pauseOk), unchanged; entryOk of the list is left out
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

function queryOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "resolved") return exact(value, ["kind", "resolution"]) && RESOLUTIONS.includes(value.resolution);
	return exact(value, ["kind"]) && OUTER_QUERIES.includes(value.kind);
}

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

function problemsOk(value: unknown): boolean {
	return Array.isArray(value) && value.every((problem) => exact(problem, ["key", "problem"]));
}

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

/**
 * `{ticket, result, document}`; untried exactly when the document is null; otherwise the unchanged
 * `claim reclaim` document of that ticket (an internal error of the single core may carry no ticket, surface:1254).
 */
function batchEntryOk(value: unknown): boolean {
	if (!exact(value, ["ticket", "result", "document"])) return false;
	const ticket = field(value, "ticket");
	const result = field(value, "result");
	const document = field(value, "document");
	if (typeof ticket !== "string") return false;
	if (result === "untried") return document === null;
	if (!isRecord(document) || !ENTRY_KINDS.includes(document.kind)) return false;
	const own =
		document.kind === "claim-error"
			? document.ticket === null || document.ticket === ticket
			: document.ticket === ticket && document.action === "reclaim";
	return own && document.command === "reclaim" && document.status === result && schemaProblems(document).length === 0;
}

/** No stop means no untried entry; after the stopping ticket every entry is untried, before it none. */
function stopOk(entries: readonly unknown[], stoppedAt: unknown): boolean {
	const results = entries.map((entry) => field(entry, "result"));
	if (stoppedAt === null) return !results.includes("untried");
	const at = entries.findIndex((entry) => field(entry, "ticket") === stoppedAt);
	if (typeof stoppedAt !== "string" || at < 0) return false;
	return results.every((result, index) => index > at === (result === "untried"));
}

/** The most urgent entry status; an incomplete selection is at least unavailable. */
function rankedStatus(results: readonly unknown[], complete: boolean): string {
	const tried = results.filter((result) => result !== "untried");
	const levels = tried.map((result) => (result === "applied" ? "ok" : result));
	if (!complete) levels.push("unavailable");
	return URGENCY.find((status) => levels.includes(status)) ?? "ok";
}

/**
 * Boundary exactly for eligible and not-yet; owner and timing only on the ACTIVE verdicts; the generation
 * on ACTIVE and FREE entries, never on absent, unknown, state-corrupt or state-unsupported.
 */
function previewEntryOk(value: unknown): boolean {
	if (!exact(value, ["ticket", "verdict"], ["claimGeneration", "owner", "timing", "boundary", "pause"])) return false;
	const verdict = field(value, "verdict");
	const active = ACTIVE_VERDICTS.includes(verdict);
	const owner = field(value, "owner");
	const timing = field(value, "timing");
	const boundary = field(value, "boundary");
	const generation = field(value, "claimGeneration");
	const pause = field(value, "pause");
	return (
		typeof field(value, "ticket") === "string" &&
		VERDICTS.includes(verdict) &&
		(BOUNDED_VERDICTS.includes(verdict) ? integer(boundary) : boundary === undefined) &&
		(owner === undefined || (active && typeof owner === "string")) &&
		(timing === undefined || (active && timingOk(timing))) &&
		(GENERATION_VERDICTS.includes(verdict) ? integer(generation) : generation === undefined) &&
		(pause === undefined || pauseOk(pause))
	);
}

/** doc-04: problems of one document against the documented schema; an empty list means valid. */
// adapted from claim-cli.test.ts:471-539 (+ the batch and preview cases; list, resolution, setup, init, context cut)
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
		case "claim-reclaim-batch": {
			const entries: unknown[] | null = Array.isArray(doc.entries) ? doc.entries : null;
			const results = (entries ?? []).map((entry) => field(entry, "result"));
			check(doc.command === "reclaim-batch", "command reclaim-batch");
			check(doc.status !== "applied", "status applied");
			check(integer(doc.observedAt), "observedAt");
			check(typeof doc.complete === "boolean", "complete");
			check(texts(doc.unreadable), "unreadable");
			check(entries?.every(batchEntryOk) === true, "entries");
			check(entries !== null && stopOk(entries, doc.stoppedAt), "stoppedAt");
			check(doc.status === rankedStatus(results, doc.complete === true), "status rank");
			break;
		}
		case "claim-reclaim-preview":
			check(doc.command === "reclaim-preview", "command reclaim-preview");
			check(integer(doc.observedAt), "observedAt");
			check(typeof doc.complete === "boolean", "complete");
			check(Array.isArray(doc.entries) && doc.entries.every(previewEntryOk), "entries");
			// An incomplete preview is unknown like `list`, a complete one ok.
			check(doc.status === (doc.complete === true ? "ok" : "unknown"), "status complete");
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

/** The exit code the status of a document would have on its own; -1 for no documented status. */
function exitOf(status: unknown): number {
	return typeof status === "string" && Object.hasOwn(EXIT, status) ? EXIT[status as Status] : -1;
}

// adapted from claim-cli.test.ts:541-561 (cliView), split so that an entry document is viewed like a top-level one
function viewOf(doc: unknown, exit: number): CliView {
	const id = field(doc, "operationId");
	return {
		exit,
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

function cliView(run: JsonRun): CliView {
	return viewOf(run.doc, run.exit);
}

/** The CliView fields a helper may set besides the status and the command it names itself. */
type ViewFields = Partial<Omit<CliView, "exit" | "schema" | "status" | "command">>;

// adapted from claim-cli.test.ts:563-583: field by field instead of spreading the Partial over the defaults
function view(fields: ViewFields & { status: Status; command: string }): CliView {
	return {
		exit: EXIT[fields.status],
		schema: [],
		kind: fields.kind ?? "claim-operation",
		status: fields.status,
		command: fields.command,
		code: fields.code ?? null,
		action: fields.action ?? null,
		outcome: fields.outcome ?? null,
		rejection: fields.rejection ?? null,
		storage: fields.storage ?? null,
		query: fields.query ?? null,
		sends: fields.sends ?? null,
		stoppedBy: fields.stoppedBy ?? null,
		ownership: fields.ownership ?? null,
		operationId: fields.operationId ?? null,
	};
}

// adapted from claim-cli.test.ts:585-589 (without field overrides)
function applied(command: string, ownership: string): CliView {
	const facts = { action: command, outcome: "applied", storage: { kind: "applied" }, sends: 1 };
	return view({ status: "applied", command, ...facts, ownership, operationId: "generated" });
}

// adapted from claim-cli.test.ts:597-599
function failed(command: string, status: Status, code: string): CliView {
	return view({ status, command, kind: "claim-error", code });
}

// adapted from claim-cli.test.ts:601-603
function queriedStorage(after: string, resolution: string): Record<string, unknown> {
	return { kind: "queried", after, query: { kind: "resolved", resolution } };
}

/** IN_WINDOW for an instant inside [startedAt, endedAt] of the call; anything else stays visible as it is. */
function windowed(run: CliRun, value: unknown): unknown {
	const inside = typeof value === "number" && value >= run.startedAt && value <= run.endedAt;
	return inside ? IN_WINDOW : (value ?? null);
}

function entryView(value: unknown): EntryView {
	const document = field(value, "document");
	const untried = document === null || document === undefined;
	const shown = untried ? null : viewOf(document, exitOf(field(document, "status")));
	return { ticket: field(value, "ticket") ?? null, result: field(value, "result") ?? null, view: shown };
}

function batchView(run: JsonRun): BatchView {
	const { doc } = run;
	const entries = field(doc, "entries");
	return {
		exit: run.exit,
		schema: schemaProblems(doc),
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		observedAt: windowed(run, field(doc, "observedAt")),
		complete: field(doc, "complete") ?? null,
		unreadable: field(doc, "unreadable") ?? null,
		stoppedAt: field(doc, "stoppedAt") ?? null,
		entries: Array.isArray(entries) ? entries.map((item: unknown) => entryView(item)) : null,
	};
}

/** A complete batch without a stop or an unread ticket (the stop cases are G bat-07 and bat-08). */
function batchOf(status: Status, entries: readonly EntryView[]): BatchView {
	return {
		exit: EXIT[status],
		schema: [],
		kind: "claim-reclaim-batch",
		status,
		command: "reclaim-batch",
		observedAt: IN_WINDOW,
		complete: true,
		unreadable: [],
		stoppedAt: null,
		entries: [...entries],
	};
}

/** The single reclaim applied; the tombstone makes the fresh rights `free` (base eps-01, :1849). */
function reclaimed(ticket: string): EntryView {
	return { ticket, result: "applied", view: applied("reclaim", "free") };
}

/** A first send the pre-receive hook rejects is final (execution/index.ts:569-573); KARL still holds the ticket. */
// adapted from claim-cli.test.ts:1298-1308 (cli-03, remote half)
function remoteRejected(ticket: string): EntryView {
	const shown = view({
		status: "rejected",
		command: "reclaim",
		action: "reclaim",
		outcome: "rejected",
		rejection: { stage: "storage", cause: "remote" },
		storage: { kind: "rejected", cause: "remote" },
		sends: 1,
		ownership: "foreign",
		operationId: "generated",
	});
	return { ticket, result: "rejected", view: shown };
}

/** One attempt held past attempt_timeout_ms, then rejected: queried, still open, unknown (base unk-01). */
// adapted from claim-cli.test.ts:1328-1340
function lostReply(ticket: string): EntryView {
	const shown = view({
		status: "unknown",
		command: "reclaim",
		action: "reclaim",
		outcome: "unknown",
		storage: queriedStorage("unknown", "open"),
		sends: 1,
		stoppedBy: "attempts",
		ownership: "foreign",
		operationId: "generated",
	});
	return { ticket, result: "unknown", view: shown };
}

function previewView(run: JsonRun): PreviewView {
	const { doc } = run;
	return {
		exit: run.exit,
		schema: schemaProblems(doc),
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		observedAt: windowed(run, field(doc, "observedAt")),
		complete: field(doc, "complete") ?? null,
		entries: field(doc, "entries") ?? null,
	};
}

/** Ok for a complete selection, unknown/3 for an incomplete one (as `list`). */
function previewOf(status: "ok" | "unknown", entries: readonly Record<string, unknown>[]): PreviewView {
	return {
		exit: EXIT[status],
		schema: [],
		kind: "claim-reclaim-preview",
		status,
		command: "reclaim-preview",
		observedAt: IN_WINDOW,
		complete: status === "ok",
		entries: [...entries],
	};
}

/**
 * An ACTIVE lease entry with owner, generation, timing view (surface/index.ts:727-736) and the boundary
 * R = L + g of the rights evaluation (rights/index.ts:283-286).
 */
function leaseEntry(
	ticket: string,
	verdict: "eligible" | "not-yet",
	owner: string,
	leaseEnd: number,
	claimGeneration = 1,
): Record<string, unknown> {
	const timing = { mode: "lease", leaseEnd, hardEnd: null, graceMs: GRACE };
	return { ticket, verdict, claimGeneration, owner, timing, boundary: leaseEnd + GRACE };
}

/** An ACTIVE timeless claim is never reclaimable, so it carries no boundary. */
function neverEntry(ticket: string, owner: string): Record<string, unknown> {
	return { ticket, verdict: "never", claimGeneration: 1, owner, timing: { mode: "none" } };
}

/** A FREE tombstone keeps its generation, as claim list reports it. */
function freeEntry(ticket: string, claimGeneration: number): Record<string, unknown> {
	return { ticket, verdict: "free", claimGeneration };
}

function absentEntry(ticket: string): Record<string, unknown> {
	return { ticket, verdict: "absent" };
}

/** The operation IDs of the batch entries as journal record names, sorted; one own ID per ticket. */
function recordsOf(...runs: JsonRun[]): string[] {
	const names: string[] = [];
	for (const run of runs) {
		const entries = field(run.doc, "entries");
		for (const entry of Array.isArray(entries) ? entries : []) {
			const id = field(field(entry, "document"), "operationId");
			if (typeof id === "string") names.push(`${id}.json`);
		}
	}
	return names.sort(byCodeUnits);
}

// adapted from claim-cli.test.ts:644-666 (without the code check)
function plainView(run: CliRun): PlainView {
	let stream = "mixed";
	if (run.stdout !== "" && run.stderr === "") stream = "stdout";
	if (run.stderr !== "" && run.stdout === "") stream = "stderr";
	const first = (stream === "stderr" ? run.stderr : run.stdout).split("\n")[0] ?? "";
	const colon = first.indexOf(":");
	return { exit: run.exit, stream, head: colon > 0 ? first.slice(0, colon) : null };
}

function plainOf(status: Status): PlainView {
	return { exit: EXIT[status], stream: STDERR_STATUSES.includes(status) ? "stderr" : "stdout", head: status };
}

/** After the first line, the lines whose first token is one of `tickets`; brackets around IDs optional. */
function entryLines(text: string, tickets: readonly string[]): LineView[] {
	const lines: LineView[] = [];
	for (const line of text.split("\n").slice(1)) {
		const tokens = line.trim().split(/\s+/);
		const ticket = tokens[0] ?? "";
		if (!tickets.includes(ticket)) continue;
		const ids = tokens.slice(2).map((token) => token.replace(/^\[|\]$/g, ""));
		const operationId = ids.some((id) => GENERATED_ID.test(id)) ? "generated" : null;
		lines.push({ ticket, result: tokens[1] ?? null, operationId });
	}
	return lines;
}

/** The verdict on the line of `ticket` and, where the entry has one, the boundary as ISO or epoch ms. */
function previewLine(text: string, ticket: string, boundary: number | null): PreviewLine {
	const line =
		text
			.split("\n")
			.slice(1)
			.find((candidate) => candidate.trim().split(/\s+/)[0] === ticket) ?? "";
	const verdict =
		line
			.trim()
			.split(/\s+/)
			.find((token) => VERDICTS.includes(token)) ?? null;
	const iso = boundary === null ? "" : new Date(boundary).toISOString();
	const shown = boundary === null ? null : line.includes(iso) || line.includes(String(boundary));
	return { ticket, verdict, boundary: shown };
}

/** Every generated operation ID printed in `text`, as journal record names, sorted. */
function recordNamesIn(text: string): string[] {
	return (text.match(ANY_ID) ?? []).map((id) => `${id}.json`).sort(byCodeUnits);
}

// adapted from claim-cli.test.ts:688-697 (+ one schema line per option, help-schema.ts:31-35)
async function helpView(cwd: string, command: string, kind: string, fields: readonly string[]): Promise<HelpView> {
	const run = await runCli(cwd, ["claim", command, "--help"]);
	const text = run.stdout + run.stderr;
	const missing = ["Input schema:", "Output:", "Examples:"].filter((section) => !text.includes(section));
	return {
		command,
		exit: run.exit,
		missing,
		kind: text.includes(kind),
		json: text.includes("--json"),
		fields: fields.filter((name) => !text.includes(`  - ${name}:`)),
	};
}

function documented(command: string): HelpView {
	return { command, exit: 0, missing: [], kind: true, json: true, fields: [] };
}

/** Statuses whose exit code row is missing: no line carries the status and its code as separate tokens. */
// adapted from claim-cli.test.ts:680-686
function missingExitRows(text: string): string[] {
	const lines = text.split("\n").map((line) => line.split(/[^\w-]+/));
	return Object.entries(EXIT)
		.filter(([status, code]) => !lines.some((tokens) => tokens.includes(status) && tokens.includes(String(code))))
		.map(([status]) => status);
}

/** A guide table row naming `code` and `status` as separate tokens (base doc-02 compares both directions). */
function hasCodeRow(text: string, code: string, status: string): boolean {
	return text.split("\n").some((line) => {
		const tokens = line.split(/[^\w-]+/);
		return tokens.includes(code) && tokens.includes(status);
	});
}

/** ASSUMPTION(batch reclaim): `claim reclaim-batch --context <abs> <scope>`; no ticket argument. */
function batchArgs(handle: ContextHandle, ...scope: string[]): string[] {
	return ["claim", "reclaim-batch", "--context", handle.directory, ...scope];
}

/** ASSUMPTION(batch reclaim): `claim reclaim-preview --context <abs> <scope>`; no ticket argument. */
function previewArgs(handle: ContextHandle, ...scope: string[]): string[] {
	return ["claim", "reclaim-preview", "--context", handle.directory, ...scope];
}

/** Rights state timing of a lease without hard end and with the configured grace (rights/index.ts:15). */
function leaseTiming(leaseEnd: number): JsonObject {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd: null };
}

/** An ACTIVE state of a foreign holder under OTHER_BINDING. */
// adapted from claim-cli.test.ts:712-722 (foreignState): owner, timing and generation are parameters
function activeState(owner: string, timing: JsonObject, claimGeneration: number): JsonObject {
	return {
		claimState: 1,
		status: "active",
		claimGeneration,
		bindingGeneration: 1,
		owner,
		binding: OTHER_BINDING,
		timing,
	};
}

/** A tombstone as a release or reclaim leaves it (rights/index.ts:28). */
function freeState(claimGeneration: number): JsonObject {
	return { claimState: 1, status: "free", claimGeneration };
}

function activeStored(owner: string, claimGeneration: number): StoredView {
	return { status: "active", owner, claimGeneration };
}

function freeStored(claimGeneration: number): StoredView {
	return { status: "free", owner: null, claimGeneration };
}

/** The three surface keys join the nine configuration keys. */
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
	].join("\n");
}

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
	};
}

// adapted from claim-cli.test.ts:760-766
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the given task files, the claims block and one committed repository. */
// adapted from claim-cli.test.ts:768-800 (task specs with status, labels, assignees and dependencies instead of three
// fixed To Do tickets; no file map, since no case removes a task file)
async function initProject(directory: string, tickets: readonly TicketSpec[], block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim reclaim CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const spec of tickets) {
		await core.filesystem.saveTask({
			id: spec.id,
			title: `Reclaim target ${spec.id}`,
			status: spec.status ?? "To Do",
			assignee: [...(spec.assignee ?? [])],
			labels: [...(spec.labels ?? [])],
			dependencies: [...(spec.dependencies ?? [])],
			createdDate: "2026-09-26",
			rawContent: "",
		});
	}
	// The CLI migrates the configuration before each command; migrating here keeps the project stable.
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

// adapted from claim-cli.test.ts:802-808
async function secretOf(handle: ContextHandle): Promise<string> {
	const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	if (typeof secret !== "string") throw new Error("the private record has no string secret");
	return secret;
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
// adapted from claim-cli.test.ts:837-918, unchanged
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
// adapted from claim-cli.test.ts:920-1188: task specs and block change functions; `plant`, `stored` and
// `pushedTickets` are new; snapshot, extra projects, other areas, receipts, adopt and broken contexts are left out
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

	static async create(format: ClaimStorageFormat, caseName: string, setup: CaseSetup): Promise<CliCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-reclaim-cli-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `reclaim-${SENTINEL}-${format}-${caseName}`);
			const url = server().url(name);
			const base = defaultBlock(url, format);
			const options = setup.block === undefined ? base : setup.block(base);
			const project = join(root, `project-${SENTINEL}`);
			await initProject(project, setup.tickets ?? DEFAULT_TICKETS, claimsBlock(options));
			const fixture = new CliCase(format, root, url, repo, project, options);
			await fixture.hooks.install();
			await mkdir(fixture.parent);
			await chmod(fixture.parent, 0o700);
			await fixture.initialize(url);
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

	/** Rewrites the claims block through saveConfig with `change` applied to the current options. */
	async writeBlock(change: BlockChange): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("the project configuration is missing");
		this.options = change(this.options);
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.options) });
	}

	// adapted from claim-cli.test.ts:1012-1016
	async context(): Promise<ContextHandle> {
		const context = expectKind(await createClaimContext({ parent: this.parent }), "created").context;
		const handle = { context, directory: dirname(context.journalDirectory) };
		this.handles.push(handle);
		return handle;
	}

	private async execute(args: readonly string[]): Promise<CliRun> {
		const run = await runCli(this.project, args);
		for (const oid of Object.values(await this.serverRefs())) this.roots.add(oid);
		return run;
	}

	/** One JSON-mode call; preview documents enter the collector without their owner fields. */
	async json(args: readonly string[]): Promise<JsonRun> {
		const run = await this.execute([...args, "--json"]);
		const doc = parseDocument(run.stdout);
		const kind = field(doc, "kind");
		const stdout = kind === "claim-reclaim-preview" ? JSON.stringify(withoutOwners(doc)) : run.stdout;
		this.outputs.push({ command: commandOf(args), text: stdout + run.stderr, ownerAllowed: false });
		return { ...run, doc };
	}

	/** One human-mode call; an owner may appear only in preview output. */
	async plain(args: readonly string[]): Promise<CliRun> {
		const run = await this.execute([...args, "--plain"]);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: command === "reclaim-preview" });
		return run;
	}

	/** A call with exactly `args`, for Commander usage errors. */
	async raw(args: readonly string[]): Promise<CliRun> {
		const run = await this.execute(args);
		this.outputs.push({ command: commandOf(args), text: run.stdout + run.stderr, ownerAllowed: false });
		return run;
	}

	/**
	 * Labels of every sentinel in the collected output. Owners are allowed in preview output
	 * only; no context ID ever appears (no call here creates a context through the CLI); roots are never printed.
	 */
	// adapted from claim-cli.test.ts:1066-1099 (every owner of the file, the foreign binding, the filter values)
	async leaks(extra: readonly Sentinel[] = []): Promise<string[]> {
		const sentinels: Sentinel[] = [
			["sentinel", SENTINEL],
			["endpoint", this.url],
			["case root", this.root],
			["context parent", this.parent],
			["foreign binding", OTHER_BINDING],
			...FILTER_VALUES,
			...extra,
		];
		for (const oid of this.roots) sentinels.push(["server root", oid]);
		for (const [index, handle] of this.handles.entries()) {
			const label = `context ${index + 1}`;
			sentinels.push([`${label} binding`, handle.context.binding], [`${label} path`, handle.directory]);
			sentinels.push([`${label} secret`, await secretOf(handle)]);
			for (const record of await this.records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			if (!output.ownerAllowed && OWNERS.some((owner) => output.text.includes(owner))) labels.push("owner");
			for (const [index, handle] of this.handles.entries()) {
				if (output.text.includes(handle.context.contextId)) labels.push(`context ${index + 1} id`);
			}
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	/** Journal records of one context; temporary and admission names start with a dot (journal/index.ts:73-74). */
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

	// adapted from claim-cli.test.ts:1117-1126
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	// adapted from claim-cli.test.ts:1128-1130
	async deleteServerRef(ref: string): Promise<void> {
		await server().git(this.serverRepo, ["update-ref", "-d", ref]);
	}

	// adapted from claim-cli.test.ts:1132-1140
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
	// adapted from claim-cli.test.ts:1148-1158
	async writeState(ticket: string, payload: JsonObject): Promise<string> {
		const store = await this.store("writer");
		const base = await store.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return expectKind(await store.write(base, { operationId, receipt, payload }), "applied").root;
	}

	/** An ACTIVE claim of `owner` under the foreign binding, written by the independent writer. */
	async plant(ticket: string, owner: string, timing: JsonObject, claimGeneration = 1): Promise<string> {
		return this.writeState(ticket, activeState(owner, timing, claimGeneration));
	}

	/** O1: the stored state of `ticket`, read through an independent client; a failed read names its kind. */
	async stored(ticket: string): Promise<StoredView> {
		const observed = await (await this.store("reader")).read(ticket);
		if (observed.kind !== "present") return { status: observed.kind, owner: null, claimGeneration: null };
		const { payload } = observed.document;
		return {
			status: field(payload, "status") ?? null,
			owner: field(payload, "owner") ?? null,
			claimGeneration: field(payload, "claimGeneration") ?? null,
		};
	}

	/** S1 push oracle: the ticket of every push that entered pre-receive after invocation `since`, in push order. */
	async pushedTickets(since: number): Promise<string[]> {
		const pushes = await this.hooks.lines("pre", since);
		return pushes.flatMap((lines) =>
			lines.map((line) => {
				const ref = line.split(" ")[2] ?? "";
				return ref.startsWith(CLAIM_REF_PREFIX) ? ref.slice(CLAIM_REF_PREFIX.length) : ref;
			}),
		);
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

describe("claim reclaim batch and preview over real Git (blob)", () => {
	test(
		"cli-01: a missing, blank or mixed scope and bad inputs end before the network; a lone ticket is reclaimed",
		async () => {
			const proxy = await StallProxy.create();
			try {
				await withCase("blob", "inputs", {}, async (fixture) => {
					const lena = await fixture.context();
					await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END));
					const since = await fixture.hooks.count("pre");
					const lone = await fixture.json(batchArgs(lena, "--ticket", TICKET));
					// Positive control (catches: no reclaim-batch; the single reclaim document instead of the batch
					// envelope; an entry without its own operation ID and journal record).
					expect({
						batch: batchView(lone),
						pushed: await fixture.pushedTickets(since),
						records: await fixture.recordNames(lena),
					}).toEqual({ batch: batchOf("ok", [reclaimed(TICKET)]), pushed: [TICKET], records: recordsOf(lone) });
					// adapted from claim-cli.test.ts:1621-1626: from here on the endpoint is the stall, which counts contacts.
					const stalled = `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
					await fixture.writeBlock((base) => ({ ...base, endpoint: stalled, timeoutMs: STALL_TIMEOUT }));
					const before = proxy.acceptedConnections;
					const batch = "reclaim-batch";
					const scopeRequired = "scope-required";
					const rows: LocalRow[] = [
						{
							label: "no scope",
							catches: "a missing scope read as project-wide",
							command: batch,
							args: batchArgs(lena),
							code: scopeRequired,
						},
						{
							label: "blank ticket",
							catches: "a blank ticket list dropped, so the scope widens",
							command: batch,
							args: batchArgs(lena, "--ticket", ""),
							code: scopeRequired,
						},
						{
							label: "blank status",
							catches: "a blank filter ignored as task list does (blank-value report of claim next)",
							command: batch,
							args: batchArgs(lena, "--status", ""),
							code: scopeRequired,
						},
						{
							label: "blank labels",
							catches: "parseDelimitedStringList semantics: `,` becomes no filter at all",
							command: batch,
							args: batchArgs(lena, "--labels", ","),
							code: scopeRequired,
						},
						{
							label: "blank claim owner",
							catches: "a blank owner filter read as every owner",
							command: batch,
							args: batchArgs(lena, "--claim-owner", " "),
							code: scopeRequired,
						},
						{
							label: "blank search",
							catches: "a blank query read as no query",
							command: batch,
							args: batchArgs(lena, "--search", "  "),
							code: scopeRequired,
						},
						{
							label: "preview without scope",
							catches: "a preview of every claim without --all (batch and preview)",
							command: "reclaim-preview",
							args: previewArgs(lena),
							code: scopeRequired,
						},
						{
							label: "--all with a filter",
							catches: "--all combined with another scope option instead of standing alone",
							command: batch,
							args: batchArgs(lena, "--all", "--status", "In Progress"),
							code: "invalid-option",
						},
						{
							label: "invalid ticket",
							catches: "a typo ID read from the storage",
							command: batch,
							args: batchArgs(lena, "--ticket", "no id"),
							code: "invalid-ticket",
						},
						{
							label: "no context",
							catches: "a default or derived context",
							command: batch,
							args: ["claim", "reclaim-batch", "--ticket", TICKET],
							code: "context-required",
						},
						{
							label: "relative context",
							catches: "a repaired relative handle",
							command: batch,
							args: ["claim", "reclaim-batch", "--ticket", TICKET, "--context", "contexts/relative"],
							code: "context-invalid",
						},
						// Scope before --context before configuration.
						{
							label: "no scope, no context",
							catches: "the context checked before the scope, so the missing scope goes unreported",
							command: batch,
							args: ["claim", "reclaim-batch"],
							code: scopeRequired,
						},
						{
							label: "no scope, relative context",
							catches: "the context checked before the scope",
							command: batch,
							args: ["claim", "reclaim-batch", "--context", "contexts/relative"],
							code: scopeRequired,
						},
					];
					const runs: JsonRun[] = [];
					// No row reaches the executor (input checks); LENA's only intent landed, so
					// TICKET's root moved on (pause/index.ts:86-94).
					for (const row of rows) runs.push(await fixture.json(row.args));
					// Options the verbs do not offer are Commander usage errors, text and exit 1.
					const usage: readonly (readonly [option: string, value: string])[] = [
						["--operation-id", "op-x"],
						["--expect-generation", "1"],
						["--owner", KARL],
						["--limit", "5"],
					];
					const usageRuns: CliRun[] = [];
					// Commander refuses before the action runs, so nothing reaches the core.
					for (const [option, value] of usage) {
						usageRuns.push(await fixture.raw([...batchArgs(lena, "--ticket", TICKET), option, value, "--json"]));
					}
					// catches: a check after the preflight (a stall contact); the refusal on stderr in JSON mode; an
					// option of claim acquire or task list silently accepted (--owner, --limit); a caller operation ID
					// shared by several tickets.
					expect({
						rows: runs.map((run, index) => ({
							label: rows[index]?.label ?? "(no row)",
							view: cliView(run),
							stderr: run.stderr,
						})),
						usage: usageRuns.map((run, index) => {
							const option = usage[index]?.[0] ?? "(no option)";
							const named = `${run.stdout}${run.stderr}`.includes(`unknown option '${option}'`);
							return { option, exit: run.exit, named };
						}),
						connections: proxy.acceptedConnections - before,
						records: await fixture.recordNames(lena),
					}).toEqual({
						rows: rows.map((row) => ({ label: row.label, view: failed(row.command, "refused", row.code), stderr: "" })),
						usage: usage.map(([option]) => ({ option, exit: 1, named: true })),
						connections: 0,
						records: recordsOf(lone),
					});
					// The counter's positive control: the same lone ticket now meets the stall in the preflight of the
					// call, which ends there as a call-level claim-error (preflight codes via
					// claimPreflightError). The preflight fails before any selection or intent.
					const reached = await fixture.json(batchArgs(lena, "--ticket", TICKET));
					// catches: a counter that counts nothing; an unreachable endpoint reported as a batch with error entries.
					expect({ view: cliView(reached), connected: proxy.acceptedConnections > before }).toEqual({
						view: failed("reclaim-batch", "unavailable", "unreachable"),
						connected: true,
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			} finally {
				await proxy.close();
			}
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-02: ticket filters read the real task files; assignee is no claim owner and unassigned is not unclaimed",
		async () => {
			await withCase("blob", "filters", { tickets: WIRING_TICKETS }, async (fixture) => {
				const lena = await fixture.context();
				for (const ticket of TICKETS) await fixture.plant(ticket, KARL, leaseTiming(LAPSED_END));
				await fixture.plant(FOURTH, FRANZ, leaseTiming(LAPSED_END));
				let since = await fixture.hooks.count("pre");
				const narrowed = await fixture.json(batchArgs(lena, "--status", "In Progress", "--labels", LABEL_X));
				// Positive control (catches: the filters not passed on, so every reclaimable claim is taken; status or
				// labels matched as any-of (THIRD); a second filter engine beside the shared module).
				expect({ batch: batchView(narrowed), pushed: await fixture.pushedTickets(since) }).toEqual({
					batch: batchOf("ok", [reclaimed(TICKET)]),
					pushed: [TICKET],
				});
				since = await fixture.hooks.count("pre");
				// For these five: LENA's only intent landed and moved TICKET's root on; none of them selects a candidate.
				const unmatched = await fixture.json(batchArgs(lena, "--labels", LABEL_NONE));
				const assignee = await fixture.json(batchArgs(lena, "--assignee", KARL));
				const unknownStatus = await fixture.json(batchArgs(lena, "--status", NO_STATUS));
				// The shared module reports options given with blank values only, and the CLI hands the
				// report to the core as `blankOptions`; with SECOND, THIRD
				// and FOURTH reclaimable a silent widening would push here, unlike the stalled endpoint of cli-01.
				const blankLabels = await fixture.json(batchArgs(lena, "--labels", ","));
				const blankStatus = await fixture.json(batchArgs(lena, "--status", ""));
				// catches: a valid selection without hits reported as an error or widened; the assignee filter
				// compared with the claim owner; an unknown status matching nothing instead of being
				// refused (--status is validated for claim commands); a blank-only filter dropped as
				// task list drops it, so the batch reclaims every claim.
				expect({
					unmatched: batchView(unmatched),
					assignee: batchView(assignee),
					unknownStatus: cliView(unknownStatus),
					blank: [cliView(blankLabels), cliView(blankStatus)],
					pushed: await fixture.pushedTickets(since),
				}).toEqual({
					unmatched: batchOf("ok", []),
					assignee: batchOf("ok", []),
					unknownStatus: failed("reclaim-batch", "refused", "invalid-option"),
					blank: [
						failed("reclaim-batch", "refused", "scope-required"),
						failed("reclaim-batch", "refused", "scope-required"),
					],
					pushed: [],
				});
				await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END), 2);
				since = await fixture.hooks.count("pre");
				// LENA's TICKET intent landed and the new plant moved TICKET's root once more; SECOND has none.
				const owned = await fixture.json(batchArgs(lena, "--claim-owner", KARL, "--labels", LABEL_X));
				const ownedPushes = await fixture.pushedTickets(since);
				await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END), 3);
				await fixture.plant(SECOND, KARL, leaseTiming(LAPSED_END), 2);
				since = await fixture.hooks.count("pre");
				// Every LENA intent so far landed and the new plants moved TICKET and SECOND on; THIRD has none.
				const unassigned = await fixture.json(batchArgs(lena, "--unassigned"));
				const unassignedPushes = await fixture.pushedTickets(since);
				await fixture.plant(THIRD, KARL, leaseTiming(LAPSED_END), 2);
				since = await fixture.hooks.count("pre");
				// Every LENA intent so far landed and the new plant moved THIRD on; FOURTH has no LENA intent.
				const ready = await fixture.json(batchArgs(lena, "--ready"));
				// catches: the owner filter matched against the assignee or ignored (FOURTH is FRANZ's, also label x);
				// unassigned read as unclaimed (TICKET and FOURTH carry assignees); --ready dropped (THIRD waits for
				// SECOND, readiness.ts:83-103); a shared operation ID or an entry without its journal record.
				expect({
					owned: batchView(owned),
					ownedPushes,
					unassigned: batchView(unassigned),
					unassignedPushes,
					ready: batchView(ready),
					readyPushes: await fixture.pushedTickets(since),
					records: await fixture.recordNames(lena),
					stored: [
						await fixture.stored(TICKET),
						await fixture.stored(SECOND),
						await fixture.stored(THIRD),
						await fixture.stored(FOURTH),
					],
				}).toEqual({
					owned: batchOf("ok", [reclaimed(TICKET), reclaimed(SECOND)]),
					ownedPushes: [TICKET, SECOND],
					unassigned: batchOf("ok", [reclaimed(SECOND), reclaimed(THIRD)]),
					unassignedPushes: [SECOND, THIRD],
					ready: batchOf("ok", [reclaimed(TICKET), reclaimed(FOURTH)]),
					readyPushes: [TICKET, FOURTH],
					records: recordsOf(narrowed, owned, unassigned, ready),
					stored: [freeStored(3), freeStored(2), activeStored(KARL, 2), freeStored(1)],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-03: mixed results exit with the most urgent status; every entry is the unchanged claim reclaim document",
		async () => {
			await withCase("blob", "mixed", {}, async (fixture) => {
				const lena = await fixture.context();
				const mara = await fixture.context();
				for (const ticket of TICKETS) await fixture.plant(ticket, KARL, leaseTiming(LAPSED_END));
				const since = await fixture.hooks.count("pre");
				// SECOND's push is the second of the call; its pre-receive hook rejects it (base cli-03, remote half).
				await fixture.hooks.plan("pre", ["pass", "reject"]);
				const rejected = await fixture.json(batchArgs(lena, "--ticket", `${TICKET},${SECOND},${THIRD}`));
				const rejectedPushes = await fixture.pushedTickets(since);
				await fixture.hooks.plan("pre", [], "pass");
				// Positive control (catches: an own entry type instead of the single reclaim document; the exit code of
				// the first or the last ticket (0) instead of the most urgent one (2); a stop after an isolated
				// rejection; a resend after a final first-send rejection (execution/index.ts:569-573)).
				expect({
					batch: batchView(rejected),
					pushed: rejectedPushes,
					records: await fixture.recordNames(lena),
				}).toEqual({
					batch: batchOf("rejected", [reclaimed(TICKET), remoteRejected(SECOND), reclaimed(THIRD)]),
					pushed: [TICKET, SECOND, THIRD],
					records: recordsOf(rejected),
				});
				// The second setup: three tickets without task files (explicit tickets are read directly),
				// one attempt each and a timeout every scripted hold outlasts (base unk-01).
				await fixture.writeBlock((base) => ({ ...base, attempts: 1, timeoutMs: LOSS_TIMEOUT }));
				for (const ticket of [FOURTH, FIFTH, SIXTH]) await fixture.plant(ticket, KARL, leaseTiming(LAPSED_END));
				const lostSince = await fixture.hooks.count("pre");
				const held = lostSince + 2;
				await fixture.hooks.plan("pre", ["pass", "hold-reject"]);
				// MARA is another context with an empty journal; LENA's SECOND intent stays outstanding at SECOND's
				// unchanged root, and no later call of this test acts on SECOND from LENA.
				const lost = await fixture.json(batchArgs(mara, "--ticket", FOURTH, "--ticket", FIFTH, "--ticket", SIXTH));
				const lostPushes = await fixture.pushedTickets(lostSince);
				await fixture.hooks.settle("pre", held);
				await fixture.hooks.plan("pre", [], "pass");
				// catches: a single unknown stopping the batch (the opposite of claim next); unknown shown as
				// rejected, applied or untried; exit 2 or 0 while a write may have landed (exit 3 exactly
				// with an unknown entry); a rolled-back or re-sent neighbour.
				expect({
					lost: batchView(lost),
					pushed: lostPushes,
					records: await fixture.recordNames(mara),
					stored: [
						await fixture.stored(TICKET),
						await fixture.stored(SECOND),
						await fixture.stored(THIRD),
						await fixture.stored(FOURTH),
						await fixture.stored(FIFTH),
						await fixture.stored(SIXTH),
					],
				}).toEqual({
					lost: batchOf("unknown", [reclaimed(FOURTH), lostReply(FIFTH), reclaimed(SIXTH)]),
					pushed: [FOURTH, FIFTH, SIXTH],
					records: recordsOf(lost),
					stored: [
						freeStored(1),
						activeStored(KARL, 1),
						freeStored(1),
						freeStored(1),
						activeStored(KARL, 1),
						freeStored(1),
					],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-04: the preview reads the same selection, needs a context, reports incompleteness and never writes",
		async () => {
			await withCase("blob", "preview", {}, async (fixture) => {
				const lena = await fixture.context();
				await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END));
				await fixture.plant(SECOND, KARL, leaseTiming(FUTURE_END));
				await fixture.writeState(THIRD, freeState(1));
				await fixture.plant(FOURTH, KARL, NONE_TIMING);
				const since = await fixture.hooks.count("pre");
				const refs = await fixture.serverRefs();
				const all = await fixture.json(previewArgs(lena, "--all"));
				const verdicts = [
					leaseEntry(TICKET, "eligible", KARL, LAPSED_END),
					leaseEntry(SECOND, "not-yet", KARL, FUTURE_END),
					freeEntry(THIRD, 1),
					neverEntry(FOURTH, KARL),
				];
				// Positive control (catches: no reclaim-preview; a second reclaimability rule (L instead of L + g, C ≥ R
				// without eps, rights/index.ts:283-286); owner or timing missing on ACTIVE entries or present on others;
				// a boundary on a free or timeless entry; non-candidates left out of the preview).
				expect(previewView(all)).toEqual(previewOf("ok", verdicts));
				// Read-only from here on: a preview never prepares, admits or sends, so it cannot pause.
				const explicit = await fixture.json(previewArgs(lena, "--ticket", `${TENTH},${NINTH},${TICKET}`));
				const noContext = await fixture.json(["claim", "reclaim-preview", "--all"]);
				const human = await fixture.plain(previewArgs(lena, "--all"));
				// adapted from claim-cli.test.ts:1974-1982 (lst-01): a non-canonical name under refs/claims/* is skipped.
				const written = await server().git(fixture.serverRepo, ["hash-object", "-w", "--stdin"], `x ${SENTINEL}\n`);
				const garbage = written.out.trim();
				await server().git(fixture.serverRepo, ["update-ref", FOREIGN_REF, garbage]);
				const partial = await fixture.json(previewArgs(lena, "--all"));
				await fixture.deleteServerRef(FOREIGN_REF);
				// catches: explicit tickets taken from the listing (the absent BACK-9 and BACK-10 lost) or kept in input or
				// string order; a preview without context and so without the pause view; a partial
				// selection reported ok (3 as for list); a write, an intent or an operation ID from a preview.
				expect({
					explicit: previewView(explicit),
					noContext: cliView(noContext),
					human: plainView(human),
					partial: previewView(partial),
					pushed: await fixture.pushedTickets(since),
					refs: await fixture.serverRefs(),
					records: await fixture.recordNames(lena),
				}).toEqual({
					explicit: previewOf("ok", [
						leaseEntry(TICKET, "eligible", KARL, LAPSED_END),
						absentEntry(NINTH),
						absentEntry(TENTH),
					]),
					noContext: failed("reclaim-preview", "refused", "context-required"),
					human: plainOf("ok"),
					partial: previewOf("unknown", verdicts),
					pushed: [],
					refs,
					records: [],
				});
				const extra: Sentinel[] = [
					["skipped ref name", "not-a-ticket"],
					["garbage object", garbage],
				];
				expect(await fixture.leaks(extra)).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"cli-05: human text leads with the status, one line per entry; owners only in the preview and never raw",
		async () => {
			await withCase("blob", "text", {}, async (fixture) => {
				const lena = await fixture.context();
				await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END));
				await fixture.plant(SECOND, KARL, leaseTiming(LAPSED_END));
				await fixture.plant(THIRD, ESC_OWNER, leaseTiming(FUTURE_END));
				const batch = await fixture.plain(batchArgs(lena, "--all"));
				// Positive control (catches: no human batch text; a first line other than `<status>:` or on stderr; a
				// candidate without its line, a non-candidate listed, or the operation ID left out).
				expect({ plain: plainView(batch), lines: entryLines(batch.stdout, TICKETS) }).toEqual({
					plain: plainOf("ok"),
					lines: [
						{ ticket: TICKET, result: "applied", operationId: "generated" },
						{ ticket: SECOND, result: "applied", operationId: "generated" },
					],
				});
				// Read-only: a preview never prepares or pauses.
				const human = await fixture.plain(previewArgs(lena, "--all"));
				const data = await fixture.json(previewArgs(lena, "--all"));
				const records = await fixture.recordNames(lena);
				// catches: terminal injection through a planted owner (base out-07); a preview line without verdict or
				// boundary; the owner dropped from the preview JSON, where it is data; printed IDs that
				// name no journal record; owners or filter values in batch output (scan below).
				expect({
					plain: plainView(human),
					lines: [
						previewLine(human.stdout, TICKET, null),
						previewLine(human.stdout, SECOND, null),
						previewLine(human.stdout, THIRD, FUTURE_END + GRACE),
					],
					json: previewView(data),
					rawEscape: [batch, human, data].map((run) => `${run.stdout}${run.stderr}`.includes("\u001b")),
					printedIds: recordNamesIn(batch.stdout),
					recordCount: records.length,
					scanner: echoedIn(`planted ${SENTINEL} ${KARL}`, [
						["sentinel", SENTINEL],
						["owner", KARL],
					]),
				}).toEqual({
					plain: plainOf("ok"),
					lines: [
						{ ticket: TICKET, verdict: "free", boundary: null },
						{ ticket: SECOND, verdict: "free", boundary: null },
						{ ticket: THIRD, verdict: "not-yet", boundary: true },
					],
					json: previewOf("ok", [
						freeEntry(TICKET, 1),
						freeEntry(SECOND, 1),
						leaseEntry(THIRD, "not-yet", ESC_OWNER, FUTURE_END),
					]),
					rawEscape: [false, false, false],
					printedIds: records,
					recordCount: 2,
					scanner: ["sentinel", "owner"],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"cli-07: under enabled false both verbs still run; acquire alone is refused",
		async () => {
			await withCase("blob", "disabled", {}, async (fixture) => {
				const lena = await fixture.context();
				await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END));
				await fixture.writeBlock((base) => ({ ...base, enabled: false }));
				const batch = await fixture.json(batchArgs(lena, "--ticket", TICKET));
				// Positive control (catches: the batch run under purpose acquire, so enabled false blocks maintenance
				// ; the disabled gate turned into error entries).
				expect(batchView(batch)).toEqual(batchOf("ok", [reclaimed(TICKET)]));
				// Read-only: a preview never prepares or pauses.
				const preview = await fixture.json(previewArgs(lena, "--all"));
				// LENA holds no intent on SECOND, and the purpose gate refuses before the executor.
				const acquireArgs = ["claim", "acquire", SECOND, "--owner", LENA_OWNER, "--context", lena.directory];
				const acquire = await fixture.json(acquireArgs);
				// catches: the preview under purpose acquire; enabled false no longer refusing acquire.
				expect({
					exits: [batch.exit, preview.exit, acquire.exit],
					preview: previewView(preview),
					acquire: cliView(acquire),
				}).toEqual({
					exits: [0, 0, 5],
					preview: previewOf("ok", [freeEntry(TICKET, 1)]),
					acquire: failed("acquire", "refused", "claims-disabled"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of CHAIN_FORMATS) {
	describe(`claim reclaim over real Git (${format})`, () => {
		test(
			`cli-08 (${format}): listing, reading and reclaiming do not depend on the storage format`,
			async () => {
				await withCase(format, "formats", {}, async (fixture) => {
					const lena = await fixture.context();
					await fixture.plant(TICKET, KARL, leaseTiming(LAPSED_END));
					await fixture.plant(SECOND, KARL, leaseTiming(LAPSED_END));
					await fixture.plant(THIRD, KARL, leaseTiming(FUTURE_END));
					const since = await fixture.hooks.count("pre");
					const batch = await fixture.json(batchArgs(lena, "--all"));
					// Positive control (catches: a format-dependent listing or read (storage/index.ts:285-303); the
					// not-yet claim taken along; entries out of candidate order).
					expect({ batch: batchView(batch), pushed: await fixture.pushedTickets(since) }).toEqual({
						batch: batchOf("ok", [reclaimed(TICKET), reclaimed(SECOND)]),
						pushed: [TICKET, SECOND],
					});
					// Read-only: a preview never prepares or pauses.
					const preview = await fixture.json(previewArgs(lena, "--all"));
					// catches: tombstones of this format misread; a reclaim that left the ref active; a missing record.
					expect({
						preview: previewView(preview),
						stored: [await fixture.stored(TICKET), await fixture.stored(SECOND), await fixture.stored(THIRD)],
						records: await fixture.recordNames(lena),
					}).toEqual({
						preview: previewOf("ok", [
							freeEntry(TICKET, 1),
							freeEntry(SECOND, 1),
							leaseEntry(THIRD, "not-yet", KARL, FUTURE_END),
						]),
						stored: [freeStored(1), freeStored(1), activeStored(KARL, 1)],
						records: recordsOf(batch),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim reclaim documentation (no project)", () => {
	test(
		"cli-06: both verbs document input and output; the group help keeps its exit table; the guide names them",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-reclaim-cli-docs-"));
			try {
				const helps: HelpView[] = [];
				for (const [command, kind] of RECLAIM_HELP) helps.push(await helpView(cwd, command, kind, SCOPE_FIELDS));
				// Positive control (catches: a verb without addHelpSchema (cli-guidance); a help that names neither its
				// document kind nor the scope options).
				expect(helps).toEqual(RECLAIM_HELP.map(([command]) => documented(command)));
				const group = await runCli(cwd, ["claim", "--help"]);
				const text = group.stdout + group.stderr;
				const guide = await runCli(cwd, ["instructions", "claims"]);
				// catches: an exit table that drifts with the new verbs (claim.ts:359-370); a verb missing from the group
				// help; the guide without the verbs, the kinds, the scope options or the scope-required row.
				expect({
					exit: group.exit,
					missingRows: missingExitRows(text),
					unlisted: RECLAIM_HELP.map(([command]) => command).filter(
						(command) => !new RegExp(`^\\s+${command}\\b`, "m").test(text),
					),
					guide: guide.exit,
					missingTerms: GUIDE_TERMS.filter((term) => !guide.stdout.includes(term)),
					codeRow: hasCodeRow(guide.stdout, "scope-required", "refused"),
				}).toEqual({ exit: 0, missingRows: [], unlisted: [], guide: 0, missingTerms: [], codeRow: true });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
