/**
 * End-to-end contract of the time path: the real
 * `backlog claim change-bounds|transfer|retry|resolve|list|renew|release|next|reclaim-preview` subprocesses in a real
 * Backlog project against the loopback Git daemon (cli-01 in blob, tree and commit-chain, the rest blob), with scripted
 * receive hooks (S1, test-local) that let P pass and hold or lose A, and private contexts created through the context
 * API. Every JSON document is checked against a test-local validator of the documented schema that knows the additive
 * time path fields (the optional `transition` of claim-operation and claim-resolution, the list state `pending` with
 * `transition {from, to}` and `reclaimBoundary`, ownership and cause `pending`, the plan cause `pending-transition`)
 * and no new error code. Every stdout and stderr is scanned for owner names (display data in list and preview entries
 * only), context paths, bindings, secrets and IDs, endpoints, server roots, the expected roots and digests of every
 * journal record and the witness instant of every A record. The CLI runs on the real clock: hard ends come from
 * Date.now() in the test and reach the CLI as ISO instants or planted states, so every boundary compared is one of
 * them plus the grace. Every test starts with a positive control the scaffold cannot satisfy. Follow-up mutating calls
 * run only against a changed root or from a context with no own open intent on that ticket; cli-03 checks the pause at
 * p on purpose. The harness is an adapted copy of claim-cli-administration.test.ts and claim-next-cli.test.ts.
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
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-cli-administration.test.ts:38-112: CaseSetup keeps only the block; CliRun carries the wall-clock
// instants around the call (as in claim-reclaim-cli.test.ts:85-86); JournalRecord gains the expected root
// and the witness instant; the claim-next views come from claim-next-cli.test.ts:118-152 and the preview view from the
// claim-reclaim-cli.test.ts (:125-135); recovery, copy, local-row and Lost types are left out.
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
	/** `claims.transfer_time_box`, a string; null leaves it out. */
	timeBoxPolicy: string | null;
};
type CaseSetup = { block?: Partial<BlockOptions> };
type ContextHandle = { context: ClaimContext; directory: string };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
/** `startedAt`/`endedAt`: the test process's wall clock around the call, for instants the CLI reads itself. */
type CliRun = { exit: number; stdout: string; stderr: string; startedAt: number; endedAt: number };
type JsonRun = CliRun & { doc: unknown };
type Output = { command: string; text: string; ownerAllowed: boolean };
type Sentinel = readonly [label: string, value: string];
/** A journal record's digests, its expected root and, for an A record, its witness instant. */
type JournalRecord = {
	name: string;
	digest: string;
	parameterDigest: string;
	expectedRoot: string | null;
	observedAt: number | null;
};
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
type PlainView = { exit: number; stream: string; head: string | null };
/** `fields`: options without their own schema line (help-schema.ts renders `  - <name>: <type>`). */
type HelpView = { command: string; exit: number; missing: string[]; kind: boolean; json: boolean; fields: string[] };
type Shape = { required: readonly string[]; optional: readonly string[] };
/** Ownership, generation and work right of a RightsView; scope and reclaim stay out. */
type RightsFacts = { ownership: unknown; claimGeneration: unknown; workRight: unknown };
/** One attempt inside a claim-next document: its ticket and the base view of the unchanged attempt document. */
type AttemptView = { ticket: unknown; view: CliView };
/** The claim-next document, field by field. */
type NextView = {
	exit: number;
	schema: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	order: unknown;
	maxCandidates: unknown;
	ticket: unknown;
	operationId: unknown;
	candidates: unknown;
	excluded: unknown;
	diagnostics: unknown;
	attempts: AttemptView[] | null;
	untried: unknown;
	stop: unknown;
	anchored: boolean | null;
};
type Excluded = { blocked: number; dependencyUnknown: number; notActionable: number };
type NextFacts = {
	ticket?: string;
	operationId?: string;
	candidates: readonly string[];
	attempts: readonly AttemptView[];
	untried: number;
	stop: Record<string, unknown>;
};
/** The preview document, field by field; `observedAt` IN_WINDOW inside the call. */
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
/** The phases a witnessed transition can report. */
type WitnessPhase = "witnessed" | "confirmed";

// adapted from claim-cli-administration.test.ts:114-211: an own sentinel, the hold bounds of cli-04, the priorities
// of claim next, the derived ID pattern, --hard-end in the transfer fields and the time path guide terms are new; the
// recovery, chain, stall and administration help and guide lists are left out.
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of healthy cases, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/**
 * attempt_timeout_ms of the lost-confirmation cases; every scripted hold outlasts it (administration: LOSS_TIMEOUT).
 */
const LOSS_TIMEOUT = 2_000;
/** cli-04: attempt_timeout_ms and budget while A is held and context B runs five calls; A must not time out. */
const HOLD_TIMEOUT = 30_000;
const HOLD_BUDGET = 60_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** cli-04: bound for the subprocess to reach its held A push (preflight, P push, observation, A record). */
const ENTER_TIMEOUT = 30_000;
/**
 * A scripted hold ends by itself after HOLD_POLLS polls of 50 ms (60 s, beyond HOLD_TIMEOUT; administration: 300
 * polls).
 */
const HOLD_POLLS = 1_200;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context and endpoint paths and in hook stderr; no output may contain it. */
const SENTINEL = "SENTINEL-cli-time-5e2a";
/** Owner of every planted claim (the source); a display name, allowed in list and preview entries only. */
const OWNER = "agent-owner-karl";
/** The --owner of every transfer (the target); like OWNER only in list and preview entries. */
const RECEIVER = "agent-receiver-franz";
const OWNER_NAMES: readonly Sentinel[] = [
	["owner", OWNER],
	["receiver", RECEIVER],
];
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
const TICKETS: readonly string[] = [TICKET, SECOND, THIRD];
/** cli-04: distinct priorities fix the claim-next candidate order TICKET, SECOND, THIRD. */
const PRIORITIES: Readonly<Record<string, string>> = { [TICKET]: "high", [SECOND]: "medium", [THIRD]: "low" };
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
/** The A intent's ID `claimConfirmationId(P-ID)`, `"c-"` plus 40 hex. */
const DERIVED_ID = /^c-[0-9a-f]{40}$/;
/** Stands for an instant the CLI read between the start and the end of the call. */
const IN_WINDOW = "(read during the call)";
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-execution-retry.test.ts:82
const ABSENT_REF = "(no ref)";
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
/** The default bound and the range of --max-candidates. */
const DEFAULT_MAX_CANDIDATES = 5;
const MAX_MAX_CANDIDATES = 50;
const NONE_EXCLUDED: Excluded = { blocked: 0, dependencyUnknown: 0, notActionable: 0 };
/** cli-06: every option of the transfer command has its own schema line, now with --hard-end. */
// adapted from claim-cli-administration.test.ts:175-183
const TRANSFER_FIELDS = [
	"--to-context",
	"--owner",
	"--context",
	"--time-box",
	"--ttl-ms",
	"--expect-generation",
	"--operation-id",
	"--hard-end",
];
/**
 * cli-06: the section, the new plan cause, two phases and the A ID field. Each
 * counts 0 in the guide before the change (case-sensitive; "time path" in lower case occurs once, claims.md:184).
 * ASSUMPTION(time path) [?8]: the phase name `confirmed` is spelled out in the guide.
 */
const GUIDE_TERMS = ["Time path", "pending-transition", "witnessed", "confirmed", "confirmOperationId"];

// doc-04 of the base CLI: the documented schema, independent of the module under test.
// adapted from claim-cli-administration.test.ts:213-274 and claim-next-cli.test.ts:387-458: + the claim-next shape,
// + the claim-reclaim-preview shape (via the batch reclaim draft :284-287), + the optional `transition` of
// claim-operation and claim-resolution; COMMANDS + next, reclaim-batch, reclaim-preview; ERROR_CODES =
// administration codes + the three claim next codes + `scope-required` and NO time path code.
const ENVELOPE = ["schemaVersion", "kind", "status", "command"];
const OPERATION_FIELDS = [
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
];
/** The exact key set of a claim-operation document of a T call. */
const T_OPERATION_KEYS = [...ENVELOPE, ...OPERATION_FIELDS, "transition"].sort(byCodeUnits);
const SHAPES: Record<string, Shape> = {
	"claim-operation": { required: OPERATION_FIELDS, optional: ["transition"] },
	"claim-pause": { required: ["action", "ticket", "operationId", "pause", "rights"], optional: [] },
	"claim-resolution": { required: ["operationId", "ticket", "action", "outcome", "query"], optional: ["transition"] },
	"claim-list": { required: ["complete", "observedAt", "claims"], optional: [] },
	// The closed key set of the claim-next document.
	"claim-next": {
		required: [
			"order",
			"maxCandidates",
			"ticket",
			"operationId",
			"candidates",
			"excluded",
			"diagnostics",
			"attempts",
			"untried",
			"stop",
		],
		optional: [],
	},
	// ASSUMPTION(batch reclaim): the closed key set of the preview document.
	"claim-reclaim-preview": { required: ["complete", "observedAt", "entries"], optional: [] },
	"claim-error": {
		required: ["code", "message", "ticket", "operationId"],
		optional: ["problems", "configuredFormat", "existingFormat", "dependencies"],
	},
};
const STATUSES: readonly unknown[] = Object.keys(EXIT);
/** The base, administration and claim next commands and the two batch reclaim verbs; the time path adds no verb. */
const COMMANDS: readonly unknown[] = `
	acquire renew release reclaim resolve retry list setup init context-create
	transfer resume change-bounds next reclaim-batch reclaim-preview
`
	.trim()
	.split(/\s+/);
/** transition/index.ts:32-40: the seven actions; the time path adds none. */
const ACTIONS: readonly unknown[] = ["acquire", "renew", "release", "reclaim", "transfer", "resume", "change-bounds"];
const OUTCOMES: readonly unknown[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTIONS: readonly unknown[] = "stored not-stored open conflict unknown unknown-history invalid".split(" ");
const OUTER_QUERIES: readonly unknown[] =
	"record-absent record-corrupt invalid unavailable unknown unknown-history unsupported".split(" ");
const RIGHTS_FAILURES: readonly unknown[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
/** surface/index.ts:918 plus the ownership `pending`. */
const OWNERSHIPS: readonly unknown[] = ["held", "foreign", "free", "absent", "pending"];
/** surface/index.ts:361 plus the list state `pending` (additive enum). */
const LIST_STATES: readonly unknown[] = ["active", "free", "unknown", "pending"];
/** The phases of a T call. */
const PHASES: readonly unknown[] = ["none", "pending", "witnessed", "confirmed"];
/** surface/index.ts:901-917 plus the plan cause `pending-transition`. */
const PLAN_CAUSES: readonly unknown[] = [
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
];
const STOPS: readonly unknown[] = [null, "attempts", "budget"];
const ORDERS: readonly unknown[] = ["priority", "age"];
const ATTEMPT_KINDS: readonly unknown[] = ["claim-operation", "claim-pause", "claim-error"];
const DEPENDENCY_CODES: readonly unknown[] = ["dependency-blocked", "dependency-unknown"];
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
/** `boundary` only for these two; `owner` and `timing` only for an ACTIVE state of these three. */
const BOUNDED_VERDICTS: readonly unknown[] = ["eligible", "not-yet"];
const ACTIVE_VERDICTS: readonly unknown[] = ["eligible", "not-yet", "never"];
/** A generation exactly where the stored state carries one (ACTIVE, FREE and PENDING). */
const GENERATION_VERDICTS: readonly unknown[] = ["eligible", "not-yet", "never", "free"];
/** The base, administration, claim next and batch reclaim codes; the time path adds no error code. */
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
	dependency-blocked dependency-unknown tasks-unavailable scope-required
`
	.trim()
	.split(/\s+/);
/** The documents whose entries may carry owner names, and their entry key. */
const OWNER_ENTRY_KEYS: Readonly<Record<string, string>> = {
	"claim-list": "claims",
	"claim-reclaim-preview": "entries",
};

// adapted from claim-cli-administration.test.ts:276-290
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

// adapted from claim-cli-administration.test.ts:292-296
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-cli-administration.test.ts:298-301
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-cli-administration.test.ts:303-307
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli-administration.test.ts:309-312
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-cli-administration.test.ts:314-318
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-cli-administration.test.ts:320-323
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-cli-administration.test.ts:325-333
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-cli-administration.test.ts:335-339
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(server().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-cli-administration.test.ts:341-351 (wall-clock instants instead of the duration)
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

// adapted from claim-next-cli.test.ts:537-541
function commandOf(args: readonly string[]): string {
	if (args[0] !== "claim") return args[0] ?? "";
	return args[1] ?? "";
}

// adapted from claim-cli-administration.test.ts:359-366
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/**
 * Owner names are display data in list and preview entries only, as `owner` or as `transition.from`/`to`;
 * the collector drops both keys there before scanning.
 */
// adapted from claim-cli-administration.test.ts:368-377 (+ preview entries, + the transition key)
function withoutOwners(doc: unknown): unknown {
	const kind = field(doc, "kind");
	const key = typeof kind === "string" ? OWNER_ENTRY_KEYS[kind] : undefined;
	const items = key === undefined ? undefined : field(doc, key);
	if (key === undefined || !Array.isArray(items) || !isRecord(doc)) return doc;
	const stripped = items.map((item: unknown) =>
		isRecord(item)
			? Object.fromEntries(Object.entries(item).filter(([name]) => name !== "owner" && name !== "transition"))
			: item,
	);
	return { ...doc, [key]: stripped };
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-cli-administration.test.ts:379-383
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-cli-administration.test.ts:385-404 (isRecord, exact, integer, nullableText)
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

// adapted from claim-next-cli.test.ts:590-596
function texts(value: unknown): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function between(value: unknown, min: number, max: number): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** TimingView; instants are epoch milliseconds. */
// adapted from claim-cli-administration.test.ts:406-421
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

// adapted from claim-cli-administration.test.ts:423-428
function queryOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "resolved") return exact(value, ["kind", "resolution"]) && RESOLUTIONS.includes(value.resolution);
	return exact(value, ["kind"]) && OUTER_QUERIES.includes(value.kind);
}

// adapted from claim-cli-administration.test.ts:430-450
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

/** RightsView without observedRoot; ownership `pending` is additive. */
// adapted from claim-cli-administration.test.ts:452-465 (+ ownership pending)
function rightsOk(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind !== "evaluated") return exact(value, ["kind"]) && RIGHTS_FAILURES.includes(value.kind);
	return (
		exact(value, ["kind", "scope", "ownership", "claimGeneration", "workRight", "reclaim"]) &&
		value.scope === "observed-state-only" &&
		OWNERSHIPS.includes(value.ownership) &&
		(value.claimGeneration === null || integer(value.claimGeneration)) &&
		isRecord(value.workRight) &&
		isRecord(value.reclaim)
	);
}

/** A plan rejection names a documented plan cause, `pending-transition` included. */
// adapted from claim-cli-administration.test.ts:467-477 (+ the closed plan cause list)
function rejectionOk(value: unknown): boolean {
	if (value === null) return true;
	return (
		isRecord(value) &&
		exact(value, ["stage", "cause"], ["boundary"]) &&
		["plan", "storage", "resolution"].includes(String(value.stage)) &&
		typeof value.cause === "string" &&
		(value.stage !== "plan" || PLAN_CAUSES.includes(value.cause)) &&
		(value.boundary === undefined || integer(value.boundary))
	);
}

/** `planned` keeps its four keys; a T call shows the target there. */
// adapted from claim-cli-administration.test.ts:479-491
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

/** `transition: {from, to}`, the two owner display names of a PENDING state. */
function fromToOk(value: unknown): boolean {
	const names = [field(value, "from"), field(value, "to")];
	return exact(value, ["from", "to"]) && names.every((name) => typeof name === "string");
}

/** A PENDING entry carries generation, `transition` and `reclaimBoundary`, never owner or timing. */
// adapted from claim-cli-administration.test.ts:493-505 (+ state pending and its two fields)
function entryOk(value: unknown): boolean {
	const optional = ["owner", "claimGeneration", "epoch", "timing", "rights", "transition", "reclaimBoundary"];
	if (!isRecord(value) || !exact(value, ["ticket", "state"], optional)) return false;
	const pending = value.state === "pending";
	const pendingFields = pending
		? integer(value.claimGeneration) && fromToOk(value.transition) && integer(value.reclaimBoundary)
		: value.transition === undefined && value.reclaimBoundary === undefined;
	return (
		typeof value.ticket === "string" &&
		LIST_STATES.includes(value.state) &&
		(value.owner === undefined || (!pending && typeof value.owner === "string")) &&
		(value.claimGeneration === undefined || integer(value.claimGeneration)) &&
		// The store's epoch exactly beside a generation, a positive integer
		(value.epoch === undefined) === (value.claimGeneration === undefined) &&
		(value.epoch === undefined || (integer(value.epoch) && Number(value.epoch) >= 1)) &&
		(value.timing === undefined || (!pending && timingOk(value.timing))) &&
		(value.rights === undefined || rightsOk(value.rights)) &&
		pendingFields
	);
}

// adapted from claim-cli-administration.test.ts:507-510
function problemsOk(value: unknown): boolean {
	return Array.isArray(value) && value.every((problem) => exact(problem, ["key", "problem"]));
}

/** An outstanding pause names own operation IDs, an unknown pause carries nothing else. */
// adapted from claim-cli-administration.test.ts:512-524
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
 * The A ID is set exactly once a witness exists (phases witnessed and confirmed).
 * ASSUMPTION(time path): `confirmOperationId: string | null` is null for the phases none and pending.
 */
function phaseIdOk(phase: unknown, id: unknown): boolean {
	if (!PHASES.includes(phase)) return false;
	if (phase === "witnessed" || phase === "confirmed") return typeof id === "string" && DERIVED_ID.test(id);
	return id === null;
}

/**
 * `transition {phase, confirmOperationId, observeBefore, reclaimBoundary, confirmation}` of a T call;
 * instants as integers, `confirmation` the StorageView of A or null. ASSUMPTION(time path): confirmed has one.
 */
function operationTransitionOk(value: unknown): boolean {
	if (value === undefined) return true;
	if (!exact(value, ["phase", "confirmOperationId", "observeBefore", "reclaimBoundary", "confirmation"])) return false;
	const phase = field(value, "phase");
	const confirmation = field(value, "confirmation");
	return (
		phaseIdOk(phase, field(value, "confirmOperationId")) &&
		integer(field(value, "observeBefore")) &&
		integer(field(value, "reclaimBoundary")) &&
		storageOk(confirmation) &&
		(phase !== "confirmed" || confirmation !== null)
	);
}

/** `transition {phase, confirmOperationId}` on the resolution of a P ID. */
function resolutionTransitionOk(value: unknown): boolean {
	if (value === undefined) return true;
	const id = field(value, "confirmOperationId");
	return exact(value, ["phase", "confirmOperationId"]) && phaseIdOk(field(value, "phase"), id);
}

/** Canonical ticket IDs only. */
// adapted from claim-next-cli.test.ts:707-715
function dependenciesOk(value: unknown): boolean {
	return (
		exact(value, ["blocking", "unknown", "unreadable"]) &&
		texts(field(value, "blocking")) &&
		texts(field(value, "unknown")) &&
		integer(field(value, "unreadable"))
	);
}

// adapted from claim-next-cli.test.ts:717-724
function excludedOk(value: unknown): boolean {
	return (
		exact(value, ["blocked", "dependencyUnknown", "notActionable"]) &&
		integer(field(value, "blocked")) &&
		integer(field(value, "dependencyUnknown")) &&
		integer(field(value, "notActionable"))
	);
}

// adapted from claim-next-cli.test.ts:726-733
function diagnosticOk(value: unknown): boolean {
	return (
		exact(value, ["ticket", "cause", "dependencies"]) &&
		typeof field(value, "ticket") === "string" &&
		field(value, "cause") === "dependency-unknown" &&
		dependenciesOk(field(value, "dependencies"))
	);
}

/** The attempts are the unchanged base documents of the acquire core, `command: "acquire"`. */
// adapted from claim-next-cli.test.ts:735-743
function attemptOk(value: unknown): boolean {
	return (
		isRecord(value) &&
		ATTEMPT_KINDS.includes(value.kind) &&
		value.command === "acquire" &&
		schemaProblems(value).length === 0
	);
}

/** The stop kind decides the status. */
// adapted from claim-next-cli.test.ts:745-770
function nextStopOk(stop: unknown, status: unknown): boolean {
	if (!isRecord(stop)) return false;
	switch (stop.kind) {
		case "claimed":
			return exact(stop, ["kind"]) && status === "applied";
		case "no-candidates":
		case "exhausted":
		case "bound":
			return exact(stop, ["kind"]) && status === "rejected";
		case "attempt":
			return exact(stop, ["kind"]) && status !== "ok" && status !== "applied";
		case "journal-unknown":
			return exact(stop, ["kind"]) && status === "paused";
		case "outstanding-acquire":
			return (
				exact(stop, ["kind", "operationIds"]) &&
				status === "paused" &&
				texts(stop.operationIds) &&
				Array.isArray(stop.operationIds) &&
				stop.operationIds.length > 0
			);
		default:
			return false;
	}
}

/**
 * On PENDING tickets: a `transition` entry has a bounded verdict and no owner or
 * timing; otherwise owner and timing only on the ACTIVE verdicts, the generation on ACTIVE and FREE entries.
 */
// adapted from claim-reclaim-cli.test.ts:618-640 (+ the transition key)
function previewEntryOk(value: unknown): boolean {
	const optional = ["claimGeneration", "owner", "timing", "boundary", "pause", "transition"];
	if (!exact(value, ["ticket", "verdict"], optional)) return false;
	const verdict = field(value, "verdict");
	const transition = field(value, "transition");
	const pending = transition !== undefined;
	const active = ACTIVE_VERDICTS.includes(verdict) && !pending;
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
		(pause === undefined || pauseOk(pause)) &&
		(!pending || (BOUNDED_VERDICTS.includes(verdict) && fromToOk(transition)))
	);
}

/** doc-04: problems of one document against the documented schema; an empty list means valid. */
// adapted from claim-cli-administration.test.ts:526-595 and claim-next-cli.test.ts:772-846 (+ the transition checks
// + the preview case of claim-reclaim-cli.test.ts:689-696; setup, init and context cut)
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
			check(operationTransitionOk(doc.transition), "transition");
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
			check(resolutionTransitionOk(doc.transition), "transition");
			break;
		case "claim-list":
			check(typeof doc.complete === "boolean", "complete");
			check(integer(doc.observedAt), "observedAt");
			check(Array.isArray(doc.claims) && doc.claims.every(entryOk), "claims");
			break;
		case "claim-next":
			check(doc.command === "next", "command next");
			check(ORDERS.includes(doc.order), "order");
			check(between(doc.maxCandidates, 1, MAX_MAX_CANDIDATES), "maxCandidates");
			check(nullableText(doc.ticket), "ticket");
			check(nullableText(doc.operationId), "operationId");
			check(texts(doc.candidates), "candidates");
			check(excludedOk(doc.excluded), "excluded");
			check(Array.isArray(doc.diagnostics) && doc.diagnostics.every(diagnosticOk), "diagnostics");
			check(Array.isArray(doc.attempts) && doc.attempts.every(attemptOk), "attempts");
			check(integer(doc.untried), "untried");
			check(nextStopOk(doc.stop, doc.status), "stop");
			break;
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
			// No fixed message contains a path separator.
			check(typeof doc.message === "string" && !doc.message.includes("/"), "message without /");
			check(nullableText(doc.ticket), "ticket");
			check(nullableText(doc.operationId), "operationId");
			check(doc.problems === undefined || problemsOk(doc.problems), "problems");
			check((doc.configuredFormat === undefined) === (doc.existingFormat === undefined), "formats");
			check(
				doc.dependencies === undefined || (DEPENDENCY_CODES.includes(doc.code) && dependenciesOk(doc.dependencies)),
				"dependencies",
			);
	}
	return problems;
}

/** A generated operation ID shows as "generated", a derived A ID as "derived". */
function idView(id: unknown): unknown {
	if (typeof id === "string" && GENERATED_ID.test(id)) return "generated";
	if (typeof id === "string" && DERIVED_ID.test(id)) return "derived";
	return id ?? null;
}

// adapted from claim-cli-administration.test.ts:597-618 (operation IDs through idView)
function cliView(run: JsonRun): CliView {
	const { doc } = run;
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
		operationId: idView(field(doc, "operationId")),
	};
}

/** The CliView fields a helper may set besides the status and the command it names itself. */
type ViewFields = Partial<Omit<CliView, "exit" | "schema" | "status" | "command">>;

// adapted from claim-next-cli.test.ts:874-893 (field by field instead of spreading the Partial over the defaults)
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

/** An applied operation; `sends` 2 for a T call (P and A), the action, storage and ID overridable. */
// adapted from claim-cli-administration.test.ts:643-649
function applied(command: string, ownership: string, fields: ViewFields = {}): CliView {
	return view({
		status: "applied",
		command,
		action: fields.action ?? command,
		outcome: "applied",
		storage: fields.storage ?? { kind: "applied" },
		sends: fields.sends ?? 1,
		ownership,
		operationId: fields.operationId ?? "generated",
	});
}

/** Plan rejections persist nothing, so no operation ID is printed (surface/index.ts:1224-1238). */
// adapted from claim-cli-administration.test.ts:651-656
function planRejected(command: string, cause: string, ownership: string, boundary?: number): CliView {
	const rejection = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return view({ status: "rejected", command, action: command, outcome: "rejected", rejection, sends: 0, ownership });
}

// adapted from claim-cli-administration.test.ts:658-661 (the operation ID instead of free fields)
function failed(command: string, status: Status, code: string, operationId: unknown = null): CliView {
	return view({ status, command, kind: "claim-error", code, operationId });
}

// adapted from claim-cli-administration.test.ts:663-666
function queriedStorage(after: string, resolution: string): Record<string, unknown> {
	return { kind: "queried", after, query: { kind: "resolved", resolution } };
}

// adapted from claim-cli-administration.test.ts:668-672
function resolvedView(status: Status, outcome: string, resolution: string, action: string, id: string): CliView {
	const query = { kind: "resolved", resolution };
	return view({ status, command: "resolve", kind: "claim-resolution", action, outcome, query, operationId: id });
}

/**
 * A T call whose A stayed open after its one send: P's storage and ID, P + A sends, UNKNOWN,
 * rights of the PENDING state (T7 also after a lost A [?5]). ASSUMPTION(time path) [?1]:
 * stoppedBy `attempts`.
 */
// adapted from claim-cli-administration.test.ts:674-688 (lostView)
function witnessedView(command: string): CliView {
	return view({
		status: "unknown",
		command,
		action: command,
		outcome: "unknown",
		storage: { kind: "applied" },
		sends: 2,
		stoppedBy: "attempts",
		ownership: "pending",
		operationId: "generated",
	});
}

/** The `transition` field with its derived A ID shown as "derived"; null when the document has none. */
function transitionOf(doc: unknown): unknown {
	const transition = field(doc, "transition");
	if (!isRecord(transition)) return transition ?? null;
	const shown: Record<string, unknown> = { ...transition, confirmOperationId: idView(transition.confirmOperationId) };
	return shown;
}

/** The expected `transition` of a witnessed or confirmed T call. */
function phaseView(
	phase: WitnessPhase,
	observeBefore: number,
	reclaimBoundary: number,
	confirmation: unknown,
): Record<string, unknown> {
	return { phase, confirmOperationId: "derived", observeBefore, reclaimBoundary, confirmation };
}

/** The `transition` of the resolution of a confirmed P ID. */
const CONFIRMED_RESOLUTION: Readonly<Record<string, unknown>> = { phase: "confirmed", confirmOperationId: "derived" };

/** The A ID a T document names (`confirmOperationId`). */
function confirmIdOf(doc: unknown): string {
	return String(field(field(doc, "transition"), "confirmOperationId"));
}

/** Journal names of derived A records that `after` has and `before` lacks, without `.json`. */
function confirmations(before: readonly string[], after: readonly string[]): string[] {
	return after
		.filter((name) => !before.includes(name))
		.map((name) => name.replace(/\.json$/, ""))
		.filter((id) => DERIVED_ID.test(id));
}

// adapted from claim-cli-administration.test.ts:690-709
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

// adapted from claim-cli-administration.test.ts:711-714
function listed(claims: EntryView[]): ListView {
	return { exit: 0, schema: [], kind: "claim-list", status: "ok", complete: true, claims };
}

// adapted from claim-cli-administration.test.ts:716-725
function entry(
	ticket: string,
	state: string,
	claimGeneration: number,
	ownership: string | null,
	owner: string | null = state === "active" ? OWNER : null,
): EntryView {
	return { ticket, state, owner, claimGeneration, ownership };
}

/** Nobody holds a work right on PENDING; the hull is the reclaim boundary for every binding. */
function pendingRights(claimGeneration: number, boundary: number): Record<string, unknown> {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: "pending",
		claimGeneration,
		workRight: { kind: "none", cause: "pending" },
		reclaim: { kind: "not-yet", boundary },
	};
}

/**
 * A PENDING list entry read through --context: generation, both display names, the hull, rights;
 * The store's epoch 1 beside the generation.
 */
function pendingEntry(ticket: string, claimGeneration: number, boundary: number): Record<string, unknown> {
	return {
		ticket,
		state: "pending",
		claimGeneration,
		epoch: 1,
		transition: { from: OWNER, to: RECEIVER },
		reclaimBoundary: boundary,
		rights: pendingRights(claimGeneration, boundary),
	};
}

/** (PENDING tickets): verdict and boundary from the hull, both display names, no owner and no timing. */
function pendingPreview(ticket: string, claimGeneration: number, boundary: number): Record<string, unknown> {
	return { ticket, verdict: "not-yet", claimGeneration, transition: { from: OWNER, to: RECEIVER }, boundary };
}

/** The RightsFacts of any binding on a PENDING state. */
function pendingFacts(claimGeneration: number): RightsFacts {
	return { ownership: "pending", claimGeneration, workRight: { kind: "none", cause: "pending" } };
}

/** The first token of the human output is the status; refused, unavailable and internal go to stderr. */
// adapted from claim-next-cli.test.ts:1070-1082
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

// adapted from claim-cli-administration.test.ts:753-755
function hinted(run: CliRun, term: string): boolean {
	return `${run.stdout}${run.stderr}`.includes(term);
}

// adapted from claim-cli-administration.test.ts:757-761
function pick(run: JsonRun, keys: readonly string[]): Record<string, unknown> {
	const picked = Object.fromEntries(keys.map((key) => [key, field(run.doc, key) ?? null]));
	return { exit: run.exit, schema: schemaProblems(run.doc), ...picked };
}

/** The pause document of `run` with the ownership of its rights. */
// adapted from claim-cli-administration.test.ts:763-771
function pausedView(run: JsonRun): Record<string, unknown> {
	const shown: Record<string, unknown> = {
		...pick(run, ["kind", "status", "command", "action", "ticket", "operationId", "pause"]),
		ownership: field(field(run.doc, "rights"), "ownership") ?? null,
	};
	return shown;
}

/** The pause at p names the open A ID; the rights are those of the PENDING state. */
// adapted from claim-cli-administration.test.ts:773-787 (the ownership as a parameter)
function pausedOf(command: string, ticket: string, operationIds: string[], ownership: string): Record<string, unknown> {
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
		ownership,
	};
}

// adapted from claim-cli-administration.test.ts:809-816
function rightsFacts(doc: unknown): RightsFacts {
	const rights = field(doc, "rights");
	return {
		ownership: field(rights, "ownership") ?? null,
		claimGeneration: field(rights, "claimGeneration") ?? null,
		workRight: field(rights, "workRight") ?? null,
	};
}

// adapted from claim-cli-administration.test.ts:818-821
function firstEntry(doc: unknown): unknown {
	const claims = field(doc, "claims");
	return Array.isArray(claims) ? claims[0] : undefined;
}

/** An attempt document inside claim-next, viewed like a top-level base document with the exit code of its status. */
// adapted from claim-next-cli.test.ts:924-929
function attemptView(doc: unknown): AttemptView {
	const status = field(doc, "status");
	const exit = typeof status === "string" && status in EXIT ? EXIT[status as Status] : -1;
	const run: JsonRun = { exit, stdout: "", stderr: "", startedAt: 0, endedAt: 0, doc };
	return { ticket: field(doc, "ticket") ?? null, view: cliView(run) };
}

// adapted from claim-next-cli.test.ts:931-933
function tried(ticket: string, attempt: CliView): AttemptView {
	return { ticket, view: attempt };
}

/** The claim-next document of one run, field by field. */
// adapted from claim-next-cli.test.ts:935-964
function nextView(run: JsonRun): NextView {
	const { doc } = run;
	const attempts = field(doc, "attempts");
	const last: unknown = Array.isArray(attempts) ? attempts.at(-1) : undefined;
	const stopKind = field(field(doc, "stop"), "kind");
	const id = field(doc, "operationId");
	let anchored: boolean | null = null;
	if (stopKind === "claimed" || stopKind === "attempt") {
		anchored = id === (field(last, "operationId") ?? null) && field(doc, "ticket") === field(last, "ticket");
	}
	return {
		exit: run.exit,
		schema: schemaProblems(doc),
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		order: field(doc, "order") ?? null,
		maxCandidates: field(doc, "maxCandidates") ?? null,
		ticket: field(doc, "ticket") ?? null,
		operationId: idView(id),
		candidates: field(doc, "candidates") ?? null,
		excluded: field(doc, "excluded") ?? null,
		diagnostics: field(doc, "diagnostics") ?? null,
		attempts: Array.isArray(attempts) ? attempts.map((attempt: unknown) => attemptView(attempt)) : null,
		untried: field(doc, "untried") ?? null,
		stop: field(doc, "stop") ?? null,
		anchored,
	};
}

/** The expected claim-next view under the defaults (priority order, bound 5, nothing excluded, no diagnostics). */
// adapted from claim-next-cli.test.ts:966-990
function nextOf(status: Status, facts: NextFacts): NextView {
	const kind = facts.stop.kind;
	return {
		exit: EXIT[status],
		schema: [],
		kind: "claim-next",
		status,
		command: "next",
		order: "priority",
		maxCandidates: DEFAULT_MAX_CANDIDATES,
		ticket: facts.ticket ?? null,
		operationId: facts.operationId ?? null,
		candidates: [...facts.candidates],
		excluded: NONE_EXCLUDED,
		diagnostics: [],
		attempts: [...facts.attempts],
		untried: facts.untried,
		stop: facts.stop,
		anchored: kind === "claimed" || kind === "attempt" ? true : null,
	};
}

/** IN_WINDOW for an instant inside [startedAt, endedAt] of the call; anything else stays visible as it is. */
// adapted from claim-reclaim-cli.test.ts:779-783
function windowed(run: CliRun, value: unknown): unknown {
	const inside = typeof value === "number" && value >= run.startedAt && value <= run.endedAt;
	return inside ? IN_WINDOW : (value ?? null);
}

// adapted from claim-reclaim-cli.test.ts:864-876
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

/** Ok for a complete selection. */
// adapted from claim-reclaim-cli.test.ts:878-890 (complete selections only)
function previewOf(entries: readonly Record<string, unknown>[]): PreviewView {
	return {
		exit: 0,
		schema: [],
		kind: "claim-reclaim-preview",
		status: "ok",
		command: "reclaim-preview",
		observedAt: IN_WINDOW,
		complete: true,
		entries: [...entries],
	};
}

/** Statuses whose exit code row is missing: no line carries the status and its code as separate tokens. */
// adapted from claim-cli-administration.test.ts:830-837
function missingExitRows(text: string): string[] {
	const lines = text.split("\n").map((line) => line.split(/[^\w-]+/));
	return Object.entries(EXIT)
		.filter(([status, code]) => !lines.some((tokens) => tokens.includes(status) && tokens.includes(String(code))))
		.map(([status]) => status);
}

/** Commander lists every registered option anyway; only the help schema writes `  - <name>: <type>` lines. */
// adapted from claim-cli-administration.test.ts:839-853
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
		fields: fields.filter((name) => !text.includes(`- ${name}:`)),
	};
}

// adapted from claim-cli-administration.test.ts:855-858
function documented(command: string): HelpView {
	return { command, exit: 0, missing: [], kind: true, json: true, fields: [] };
}

// adapted from claim-cli-administration.test.ts:865-867
function onArgs(verb: string, target: string, handle: ContextHandle): string[] {
	return ["claim", verb, target, "--context", handle.directory];
}

function listArgs(ticket: string, handle: ContextHandle): string[] {
	return ["claim", "list", "--ticket", ticket, "--context", handle.directory];
}

/** The target only as an explicit path, the receiver's display name only as --owner. */
// adapted from claim-cli-administration.test.ts:869-877
function transferArgs(ticket: string, from: ContextHandle, to: ContextHandle, ...extra: string[]): string[] {
	const source = ["--owner", RECEIVER, "--context", from.directory];
	return ["claim", "transfer", ticket, "--to-context", to.directory, ...source, ...extra];
}

/** --mode is mandatory; `hard` needs --hard-end and --grace-ms (surface/index.ts:1500-1505). */
// adapted from claim-cli-administration.test.ts:879-892
function boundsArgs(ticket: string, handle: ContextHandle, hardEnd: number): string[] {
	const bounds = ["--mode", "hard", "--hard-end", iso(hardEnd), "--grace-ms", String(GRACE)];
	return ["claim", "change-bounds", ticket, ...bounds, "--context", handle.directory];
}

/** `claim next --owner <name> --context <abs>`, no ticket argument. */
// adapted from claim-next-cli.test.ts:1105-1108
function nextArgs(handle: ContextHandle, owner: string): string[] {
	return ["claim", "next", "--owner", owner, "--context", handle.directory];
}

/** ASSUMPTION(batch reclaim): `claim reclaim-preview --context <abs> <scope>`. */
function previewArgs(handle: ContextHandle, ...scope: string[]): string[] {
	return ["claim", "reclaim-preview", "--context", handle.directory, ...scope];
}

/** `--hard-end` rule: ISO-8601 with a zone; `toISOString` keeps the millisecond. */
// adapted from claim-cli-administration.test.ts:899-902
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Rights state timing of a hard claim with the configured grace (rights/index.ts:14-17). */
// adapted from claim-cli-administration.test.ts:909-911
function hardTiming(hardEnd: number): JsonObject {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

/** The planned display of a hard target; `capped` stays false without a lease. */
function hardPlanned(claimGeneration: number, hardEnd: number): Record<string, unknown> {
	return { status: "active", claimGeneration, timing: hardTiming(hardEnd), capped: false };
}

/** Keys plus the policy key, written last like its place in SCHEMA_KEYS. */
// adapted from claim-cli-administration.test.ts:937-956
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

/** Lease mode (the planted claims are hard; `claim next` acquires a lease), no policy key (require-explicit). */
// adapted from claim-cli-administration.test.ts:958-976
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

// adapted from claim-cli-administration.test.ts:978-984
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the three tickets with distinct priorities and the claims block. */
// adapted from claim-cli-administration.test.ts:986-1012 (+ the priority of each ticket, claim-next-cli.test.ts:1187)
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim CLI time path");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const ticket of TICKETS) {
		await core.filesystem.saveTask({
			id: ticket,
			title: `Claim target ${ticket}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-28",
			rawContent: "",
			priority: PRIORITIES[ticket],
		});
	}
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

// adapted from claim-next-cli.test.ts:1206-1212
async function secretOf(handle: ContextHandle): Promise<string> {
	const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	if (typeof secret !== "string") throw new Error("the private record has no string secret");
	return secret;
}

/** Names, modes and sha256 of every entry under `directory`: the target is read only. */
// adapted from claim-cli-administration.test.ts:1024-1039
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

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-cli-administration.test.ts:1054-1079 (HOLD_POLLS raised for cli-04)
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
// adapted from claim-cli-administration.test.ts:1081-1162 (+ entered, settleHeld; without lines)
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

	/** Settles invocation `n` if it ever started: a call that ended before that push leaves nothing to release. */
	async settleHeld(phase: ReceivePhase, n: number): Promise<void> {
		if (await exists(join(this.control, `${phase}-${n}`))) await this.settle(phase, n);
	}

	/** Waits, bounded, until invocation `n` of `phase` has entered its hook; false once `stopped()` holds first. */
	async entered(phase: ReceivePhase, n: number, stopped: () => boolean): Promise<boolean> {
		const marker = join(this.control, `${phase}-${n}`, "entered");
		const deadline = Date.now() + ENTER_TIMEOUT;
		while (Date.now() <= deadline) {
			if (await exists(marker)) return true;
			if (stopped()) return exists(marker);
			await Bun.sleep(20);
		}
		return false;
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

/** One server area with S1 hooks, one project, private contexts, an independent writer and the output collector. */
// adapted from claim-cli-administration.test.ts:1164-1421: recovery contexts, copies, broken contexts, raw calls and
// the null block are left out; the scan adds every record's expected root and every A record's witness instant.
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
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-cli-time-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `cli-time-${SENTINEL}-${format}-${caseName}`);
			const url = server().url(name);
			const options: BlockOptions = { ...defaultBlock(url, format), ...(setup.block ?? {}) };
			const project = join(root, `project-${SENTINEL}`);
			await initProject(project, claimsBlock(options));
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

	/** Rewrites the claims block through saveConfig. */
	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("the project configuration is missing");
		this.options = { ...this.options, ...changes };
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.options) });
	}

	// adapted from claim-execution.test.ts:1115-1121 (ExecutionCase.context)
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

	/** One JSON-mode call; list and preview documents enter the collector without their owner fields. */
	async json(args: readonly string[]): Promise<JsonRun> {
		const run = await this.execute([...args, "--json"]);
		const doc = parseDocument(run.stdout);
		const kind = field(doc, "kind");
		const owned = typeof kind === "string" && OWNER_ENTRY_KEYS[kind] !== undefined;
		const stdout = owned ? JSON.stringify(withoutOwners(doc)) : run.stdout;
		this.outputs.push({ command: commandOf(args), text: stdout + run.stderr, ownerAllowed: false });
		return { ...run, doc };
	}

	/** One human-mode call; owner names may appear only in list output. */
	async plain(args: readonly string[]): Promise<CliRun> {
		const run = await this.execute([...args, "--plain"]);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: command === "list" });
		return run;
	}

	/**
	 * Labels of every sentinel in the collected output. Both owner names are allowed in list and preview
	 * entries only; roots, digests, bindings, paths and the witness instant of an A record never appear.
	 */
	// adapted from claim-cli-administration.test.ts:1309-1345 (+ record roots and witness instants)
	async leaks(): Promise<string[]> {
		const sentinels: Sentinel[] = [
			["sentinel", SENTINEL],
			["endpoint", this.url],
			["case root", this.root],
			["context parent", this.parent],
		];
		for (const oid of this.roots) sentinels.push(["server root", oid]);
		for (const [index, handle] of this.handles.entries()) {
			const label = `context ${index + 1}`;
			sentinels.push([`${label} binding`, handle.context.binding], [`${label} path`, handle.directory]);
			sentinels.push([`${label} secret`, await secretOf(handle)]);
			for (const record of await this.records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
				if (record.expectedRoot !== null) sentinels.push([`${label} record root`, record.expectedRoot]);
				if (record.observedAt !== null) sentinels.push([`${label} witness instant`, String(record.observedAt)]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			if (!output.ownerAllowed) labels.push(...echoedIn(output.text, OWNER_NAMES));
			for (const [index, handle] of this.handles.entries()) {
				if (output.text.includes(handle.context.contextId)) labels.push(`context ${index + 1} id`);
			}
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	/**
	 * Journal records of one context (journal/index.ts:12-30); temporary and admission names start with a dot.
	 * ASSUMPTION(time path): an A record keeps its witness instant as `intent.parameters.observedAt`.
	 */
	// adapted from claim-cli-administration.test.ts:1347-1358 (+ expectedRoot, observedAt)
	async records(handle: ContextHandle): Promise<JournalRecord[]> {
		const records: JournalRecord[] = [];
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			const record: unknown = JSON.parse(await readFile(join(handle.context.journalDirectory, name), "utf8"));
			const intent = field(record, "intent");
			const expectedRoot = field(intent, "expectedRoot");
			const observedAt = field(field(intent, "parameters"), "observedAt");
			records.push({
				name,
				digest: String(field(record, "digest")),
				parameterDigest: String(field(record, "parameterDigest")),
				expectedRoot: typeof expectedRoot === "string" ? expectedRoot : null,
				observedAt: typeof observedAt === "number" ? observedAt : null,
			});
		}
		return records;
	}

	async recordNames(handle: ContextHandle): Promise<string[]> {
		return (await this.records(handle)).map((record) => record.name);
	}

	// adapted from claim-execution.test.ts:1226 (ExecutionCase.serverRefs)
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
	// adapted from claim-execution.test.ts:1187-1199 (ExecutionCase.writeChange, writeState)
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
	 * An ACTIVE claim of OWNER bound to `holder`'s context binding, written by the independent writer, so a test fixes
	 * H_s exactly (`plant`); its expected root and binding stay out of every output.
	 */
	// adapted from claim-cli-administration.test.ts:1397-1412 (generation fixed at 1)
	async plant(ticket: string, holder: ContextHandle, timing: JsonObject): Promise<string> {
		return this.writeState(ticket, {
			claimState: 1,
			status: "active",
			claimGeneration: 1,
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

// adapted from claim-cli-administration.test.ts:1423-1436
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

/**
 * cli-03, cli-05: P passes, A is held past attempt_timeout_ms and then rejected (base unk-01), so the A intent stays
 * open at p and the call ends witnessed. ASSUMPTION(time path) [?2]: P is the call's next pre-receive invocation and
 * A the one after it.
 */
// adapted from claim-cli-administration.test.ts:1672-1680 (crt-01 `lose` and `release`)
async function losingConfirmation<R>(fixture: CliCase, call: () => Promise<R>): Promise<R> {
	const held = (await fixture.hooks.next("pre")) + 1;
	await fixture.hooks.plan("pre", ["pass", "hold-reject"]);
	const run = await call();
	await fixture.hooks.settleHeld("pre", held);
	await fixture.hooks.plan("pre", [], "pass");
	return run;
}

for (const format of FORMATS) {
	describe(`claim CLI time path over real Git (${format})`, () => {
		test(
			`cli-01 (${format}): change-bounds extends a hard end through P and A and ends applied and confirmed`,
			async () => {
				await withCase(format, "extend", {}, async (fixture) => {
					// Scanner positive control: a planted sentinel and a planted receiver name are found.
					const planted = `planted ${SENTINEL} ${RECEIVER}`;
					expect(echoedIn(planted, [["sentinel", SENTINEL], ...OWNER_NAMES])).toEqual(["sentinel", "receiver"]);
					const a = await fixture.context();
					const t0 = Date.now();
					const hardEnd = t0 + 60 * MINUTE;
					const newEnd = t0 + 120 * MINUTE;
					const hull = newEnd + GRACE;
					await fixture.plant(TICKET, a, hardTiming(hardEnd));
					// A's journal is empty (the claim was planted by another writer).
					const extended = await fixture.json(boundsArgs(TICKET, a, newEnd));
					// Positive control (catches: missing wiring; the extension still rejected `requires-time-path`
					// (transition/index.ts:419, timePath off); a single CAS instead of P and A (sends 1); no transition
					// field; a phase other than confirmed although A landed; observeBefore not the stored H; the hull not
					// max(R(source), R(target)); the grace or the generation changed by the bound form).
					expect({
						view: cliView(extended),
						keys: keysOf(extended.doc),
						transition: transitionOf(extended.doc),
						planned: field(extended.doc, "planned") ?? null,
						rights: rightsFacts(extended.doc),
					}).toEqual({
						view: applied("change-bounds", "held", { sends: 2 }),
						keys: T_OPERATION_KEYS,
						transition: phaseView("confirmed", hardEnd, hull, { kind: "applied" }),
						planned: hardPlanned(1, newEnd),
						rights: { ownership: "held", claimGeneration: 1, workRight: { kind: "live", renewalDue: null } },
					});
					const transitionId = String(field(extended.doc, "operationId"));
					const confirmId = confirmIdOf(extended.doc);
					const listing = await fixture.json(listArgs(TICKET, a));
					// A's two records expect the planted root (P) and the PENDING root (A); A replaced both.
					const shortened = await fixture.json(boundsArgs(TICKET, a, hardEnd));
					// resolve is read-only and never pauses.
					const resolved = await fixture.json(onArgs("resolve", transitionId, a));
					const resolvedConfirm = await fixture.json(onArgs("resolve", confirmId, a));
					// catches: the A record missing, not derived or equal to P; a record beyond P, A and the
					// D write; the list not showing H_t; a D document with a transition field or two sends;
					// the composite result lost after a later own write (APPLIED rests on the P/A receipts only);
					// the A ID resolved as a composite.
					expect({
						records: await fixture.recordNames(a),
						distinct: confirmId !== transitionId,
						listed: listView(listing),
						listedTiming: field(firstEntry(listing.doc), "timing") ?? null,
						shortened: cliView(shortened),
						shortenedTransition: transitionOf(shortened.doc),
						resolved: cliView(resolved),
						resolvedTransition: transitionOf(resolved.doc),
						resolvedConfirm: cliView(resolvedConfirm),
						resolvedConfirmTransition: transitionOf(resolvedConfirm.doc),
					}).toEqual({
						records: [
							`${transitionId}.json`,
							`${confirmId}.json`,
							`${String(field(shortened.doc, "operationId"))}.json`,
						].sort(byCodeUnits),
						distinct: true,
						listed: listed([entry(TICKET, "active", 1, "held")]),
						listedTiming: hardTiming(newEnd),
						shortened: applied("change-bounds", "held"),
						shortenedTransition: null,
						resolved: resolvedView("applied", "applied", "stored", "change-bounds", "generated"),
						resolvedTransition: CONFIRMED_RESOLUTION,
						// ASSUMPTION(time path) [?3]: the A record carries the action of its P.
						resolvedConfirm: resolvedView("applied", "applied", "stored", "change-bounds", "derived"),
						resolvedConfirmTransition: null,
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);
	});
}

describe("claim CLI time path single-format cases (blob)", () => {
	test(
		"cli-02: transfer --time-box restart takes --hard-end; without it, with preserve or without restart it does not",
		async () => {
			await withCase("blob", "restart", {}, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 60 * MINUTE;
				const newEnd = t0 + 120 * MINUTE;
				const hull = newEnd + GRACE;
				await fixture.plant(TICKET, a, hardTiming(hardEnd));
				await fixture.plant(SECOND, a, hardTiming(hardEnd));
				const targetBefore = await dirSnapshot(b.directory);
				const restart = ["--time-box", "restart", "--hard-end", iso(newEnd)];
				// A's journal is empty (the claims were planted by another writer).
				const moved = await fixture.json(transferArgs(TICKET, a, b, ...restart));
				// Positive control (catches: --hard-end not wired on transfer (commands/claim.ts:435-441 registers none;
				// a bare pass-through ends option-not-applicable, surface/index.ts:1435-1436); the restart still rejected
				// `requires-time-path` (transition/index.ts:287-290); a preserve instead of a restart; the target's view
				// instead of the source's; H_t not frozen into the target; the hull not from H_t).
				// ASSUMPTION(scaffold): commands/claim.ts registers --hard-end on transfer and
				// passes it through, so RED here is a claim document, never a Commander usage error.
				expect({
					view: cliView(moved),
					transition: transitionOf(moved.doc),
					planned: field(moved.doc, "planned") ?? null,
					rights: rightsFacts(moved.doc),
				}).toEqual({
					view: applied("transfer", "foreign", { sends: 2 }),
					transition: phaseView("confirmed", hardEnd, hull, { kind: "applied" }),
					planned: hardPlanned(2, newEnd),
					rights: { ownership: "foreign", claimGeneration: 2, workRight: { kind: "none", cause: "not-holder" } },
				});
				const targetAfter = await dirSnapshot(b.directory);
				const listB = await fixture.json(listArgs(TICKET, b));
				const listA = await fixture.json(listArgs(TICKET, a));
				const restartOnly = ["--time-box", "restart"];
				// A has no record on SECOND.
				const valueless = await fixture.json(transferArgs(SECOND, a, b, ...restartOnly));
				// A has no record on SECOND; the plan rejection above recorded nothing (surface/index.ts:1224-1238).
				const valuelessPlain = await fixture.plain(transferArgs(SECOND, a, b, ...restartOnly));
				const late = ["--hard-end", iso(newEnd)];
				// As above; this and the next two calls end before the configuration or the executor.
				const preserved = await fixture.json(transferArgs(SECOND, a, b, "--time-box", "preserve", ...late));
				const bare = await fixture.json(transferArgs(SECOND, a, b, ...late));
				await fixture.writeBlock({ timeBoxPolicy: "preserve" });
				const policyPreserve = await fixture.json(transferArgs(SECOND, a, b, ...late));
				await fixture.writeBlock({ timeBoxPolicy: "restart" });
				// A has no record on SECOND; every call on SECOND above recorded nothing.
				const policyRestart = await fixture.json(transferArgs(SECOND, a, b, ...late));
				const listSecond = await fixture.json(listArgs(SECOND, b));
				const records = await fixture.recordNames(a);
				// catches: the receiver without a live right after A (fresh check); the source still
				// holding; the target context written; a restart without values extended
				// or without the reworded hint; --hard-end accepted with preserve at stage 1, without a
				// resolved restart after the configuration; the policy restart ignored; a third record
				// per T call or a record for a refused call.
				expect({
					target: targetAfter,
					listB: listView(listB),
					listedTiming: field(firstEntry(listB.doc), "timing") ?? null,
					workRight: field(field(firstEntry(listB.doc), "rights"), "workRight") ?? null,
					listA: listView(listA),
					valueless: cliView(valueless),
					valuelessPlain: { view: plainView(valuelessPlain), hint: hinted(valuelessPlain, "--hard-end") },
					preserved: cliView(preserved),
					bare: cliView(bare),
					policyPreserve: cliView(policyPreserve),
					policyRestart: cliView(policyRestart),
					policyTransition: transitionOf(policyRestart.doc),
					listSecond: listView(listSecond),
					records: records.length,
					confirmations: confirmations([], records).length,
					journalB: await fixture.recordNames(b),
				}).toEqual({
					target: targetBefore,
					listB: listed([entry(TICKET, "active", 2, "held", RECEIVER)]),
					listedTiming: hardTiming(newEnd),
					workRight: { kind: "live", renewalDue: null },
					listA: listed([entry(TICKET, "active", 2, "foreign", RECEIVER)]),
					valueless: planRejected("transfer", "requires-time-path", "held"),
					// ASSUMPTION(time path) [?4]: the reworded requires-time-path hint names --hard-end.
					valuelessPlain: { view: plainOf("rejected"), hint: true },
					preserved: failed("transfer", "refused", "option-not-applicable"),
					bare: failed("transfer", "refused", "option-not-applicable"),
					policyPreserve: failed("transfer", "refused", "option-not-applicable"),
					policyRestart: applied("transfer", "foreign", { sends: 2 }),
					policyTransition: phaseView("confirmed", hardEnd, hull, { kind: "applied" }),
					listSecond: listed([entry(SECOND, "active", 2, "held", RECEIVER)]),
					records: 4,
					confirmations: 2,
					journalB: [],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-03: a lost A ends unknown and witnessed, pauses its context at p, and retry of the A ID publishes it",
		async () => {
			const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
			await withCase("blob", "lost-confirmation", { block }, async (fixture) => {
				const a = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 60 * MINUTE;
				const newEnd = t0 + 120 * MINUTE;
				const hull = newEnd + GRACE;
				for (const ticket of TICKETS) await fixture.plant(ticket, a, hardTiming(hardEnd));
				// A's journal is empty (the claims were planted by another writer).
				const lost = await losingConfirmation(fixture, () => fixture.json(boundsArgs(TICKET, a, newEnd)));
				// Positive control (catches: missing wiring; a lost A reported applied, rejected or pending; the witness
				// not persisted before A was sent (no confirmOperationId); exit 0 while A is open;
				// a work right on PENDING for the source).
				expect({
					view: cliView(lost),
					transition: transitionOf(lost.doc),
					planned: field(lost.doc, "planned") ?? null,
					rights: rightsFacts(lost.doc),
				}).toEqual({
					view: witnessedView("change-bounds"),
					transition: phaseView("witnessed", hardEnd, hull, queriedStorage("unknown", "open")),
					planned: hardPlanned(1, newEnd),
					rights: pendingFacts(1),
				});
				const transitionId = String(field(lost.doc, "operationId"));
				const confirmId = confirmIdOf(lost.doc);
				const before = await fixture.recordNames(a);
				// A has no record on SECOND (the pause compares the ticket, pause/index.ts:96-104).
				const lostPlain = await losingConfirmation(fixture, () => fixture.plain(boundsArgs(SECOND, a, newEnd)));
				const plainConfirms = confirmations(before, await fixture.recordNames(a));
				// cli-03 holds A in post-receive: A lands, so the call's own query proves it (base unk-03).
				const heldPost = (await fixture.hooks.next("post")) + 1;
				await fixture.hooks.plan("post", ["pass", "hold"]);
				// A has no record on THIRD.
				const landed = await fixture.json(boundsArgs(THIRD, a, newEnd));
				await fixture.hooks.settleHeld("post", heldPost);
				await fixture.hooks.plan("post", [], "pass");
				const pushesBefore = await fixture.hooks.count("pre");
				// On purpose: the A intent of TICKET expects p, which is still the root,
				// so A's next mutating call on TICKET pauses before any plan, record or send (pause/index.ts:96-104).
				const paused = await fixture.json(boundsArgs(TICKET, a, newEnd));
				const pausePushes = (await fixture.hooks.count("pre")) - pushesBefore;
				// Retry never pauses; the A ID is the way out.
				const retried = await fixture.json(onArgs("retry", confirmId, a));
				// resolve is read-only and never pauses.
				const resolved = await fixture.json(onArgs("resolve", transitionId, a));
				const listing = await fixture.json(listArgs(TICKET, a));
				const records = await fixture.recordNames(a);
				// catches: the witnessed text without the A-ID retry hint; a landed A whose reply was
				// lost reported witnessed; the pause missing, naming P or sending; the A retry planning anew, gaining a
				// transition field or failing after the lost reply; the P resolution not composite.
				expect({
					plain: plainView(lostPlain),
					plainConfirms: plainConfirms.length,
					hints: plainConfirms.map((id) => hinted(lostPlain, `claim retry ${id}`)),
					landed: cliView(landed),
					landedTransition: transitionOf(landed.doc),
					paused: pausedView(paused),
					pausePushes,
					retried: cliView(retried),
					retriedTransition: transitionOf(retried.doc),
					resolved: cliView(resolved),
					resolvedTransition: transitionOf(resolved.doc),
					listed: listView(listing),
					listedTiming: field(firstEntry(listing.doc), "timing") ?? null,
					records: records.length,
					confirmations: confirmations([], records).length,
				}).toEqual({
					plain: plainOf("unknown"),
					plainConfirms: 1,
					hints: [true],
					landed: applied("change-bounds", "held", { sends: 2 }),
					landedTransition: phaseView("confirmed", hardEnd, hull, queriedStorage("unknown", "stored")),
					paused: pausedOf("change-bounds", TICKET, [confirmId], "pending"),
					pausePushes: 0,
					// ASSUMPTION(time path) [?3]: the A record carries the action of its P.
					retried: applied("retry", "held", { action: "change-bounds", operationId: "derived" }),
					retriedTransition: null,
					resolved: resolvedView("applied", "applied", "stored", "change-bounds", "generated"),
					resolvedTransition: CONFIRMED_RESOLUTION,
					listed: listed([entry(TICKET, "active", 1, "held")]),
					listedTiming: hardTiming(newEnd),
					records: 6,
					confirmations: 3,
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-04: while A is held, context B sees PENDING without owner, is refused on it and claim next moves on",
		async () => {
			const block = { timeoutMs: HOLD_TIMEOUT, budgetMs: HOLD_BUDGET };
			await withCase("blob", "held-confirmation", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 60 * MINUTE;
				const newEnd = t0 + 120 * MINUTE;
				const hull = newEnd + GRACE;
				const ref = `refs/claims/${TICKET}`;
				await fixture.plant(TICKET, a, hardTiming(hardEnd));
				// ASSUMPTION(time path) [?2]: P is the call's next pre-receive invocation and A the one after it.
				const heldA = (await fixture.hooks.next("pre")) + 1;
				await fixture.hooks.plan("pre", ["pass", "hold"]);
				let settled = false;
				const restart = ["--time-box", "restart", "--hard-end", iso(newEnd)];
				// A's journal is empty (the claim was planted by another writer); A makes no other call meanwhile.
				// B's calls below run in the same project repository while this one waits on its A push [?6].
				const moving = fixture.json(transferArgs(TICKET, a, b, ...restart)).then((run) => {
					settled = true;
					return run;
				});
				try {
					const reached = await fixture.hooks.entered("pre", heldA, () => settled);
					// Positive control (catches: missing wiring; no A push at all: a single CAS, or the call ending before
					// the time path as refused option-not-applicable or rejected requires-time-path).
					expect({ reached, early: reached ? null : cliView(await moving) }).toEqual({ reached: true, early: null });
					const pendingRoot = (await fixture.serverRefs())[ref] ?? ABSENT_REF;
					// B is the receiving context; the transfer only read it, so its journal is empty.
					const listing = await fixture.json(listArgs(TICKET, b));
					// PENDING tickets in preview and batch.
					const preview = await fixture.json(previewArgs(b, "--all"));
					// B's journal is empty; list and preview record nothing.
					const renewed = await fixture.json(onArgs("renew", TICKET, b));
					// B's journal is still empty; the plan rejection above recorded nothing (surface/index.ts:1224).
					const passed = await fixture.json(transferArgs(TICKET, b, a, "--time-box", "preserve"));
					// As above; claim next records only for the ticket it acquires.
					const next = await fixture.json(nextArgs(b, RECEIVER));
					const pendingKept = ((await fixture.serverRefs())[ref] ?? ABSENT_REF) === pendingRoot;
					const journalB = (await fixture.recordNames(b)).length;
					// catches: the target given a work right before A (model "work before A"); an owner or a timing on
					// PENDING (judge:23); the hull not max(R(source), R(target)) in list, rights, preview and plan; a
					// second reclaimability rule in the preview; a follow-up planned on PENDING or written
					// (the root moved); claim next stopping at PENDING instead of continuing (row).
					expect({
						listed: listView(listing),
						entry: firstEntry(listing.doc) ?? null,
						preview: previewView(preview),
						renewed: cliView(renewed),
						passed: cliView(passed),
						next: nextView(next),
						pendingKept,
						journalB,
					}).toEqual({
						listed: listed([entry(TICKET, "pending", 2, "pending")]),
						entry: pendingEntry(TICKET, 2, hull),
						preview: previewOf([pendingPreview(TICKET, 2, hull)]),
						renewed: planRejected("renew", "pending-transition", "pending", hull),
						passed: planRejected("transfer", "pending-transition", "pending", hull),
						next: nextOf("applied", {
							ticket: SECOND,
							operationId: "generated",
							candidates: TICKETS,
							attempts: [
								tried(TICKET, planRejected("acquire", "pending-transition", "pending", hull)),
								tried(SECOND, applied("acquire", "held")),
							],
							untried: 1,
							stop: { kind: "claimed" },
						}),
						pendingKept: true,
						journalB: 1,
					});
					await fixture.hooks.settle("pre", heldA);
					await fixture.hooks.plan("pre", [], "pass");
					const moved = await moving;
					const listedAfter = await fixture.json(listArgs(TICKET, b));
					// A's records expect the planted root (P) and p (A); the published A replaced p.
					const releasedA = await fixture.json(onArgs("release", TICKET, a));
					// catches: A lost or sent twice after the follow-ups (they left p untouched); the target still without
					// a live right after A (fresh check); the source still able to release.
					expect({
						moved: cliView(moved),
						transition: transitionOf(moved.doc),
						rights: rightsFacts(moved.doc),
						listedAfter: listView(listedAfter),
						workRight: field(field(firstEntry(listedAfter.doc), "rights"), "workRight") ?? null,
						releasedA: cliView(releasedA),
						records: (await fixture.recordNames(a)).length,
					}).toEqual({
						moved: applied("transfer", "foreign", { sends: 2 }),
						transition: phaseView("confirmed", hardEnd, hull, { kind: "applied" }),
						rights: { ownership: "foreign", claimGeneration: 2, workRight: { kind: "none", cause: "not-holder" } },
						listedAfter: listed([entry(TICKET, "active", 2, "held", RECEIVER)]),
						workRight: { kind: "live", renewalDue: null },
						releasedA: planRejected("release", "not-holder", "foreign"),
						records: 2,
					});
					expect(await fixture.leaks()).toEqual([]);
				} finally {
					await fixture.hooks.releaseAll();
					await moving;
				}
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-05: under enabled false a restart with --hard-end is refused, an extension stays rejected, A still publishes",
		async () => {
			const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
			await withCase("blob", "disabled", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const t0 = Date.now();
				const hardEnd = t0 + 60 * MINUTE;
				const newEnd = t0 + 120 * MINUTE;
				const hull = newEnd + GRACE;
				for (const ticket of TICKETS) await fixture.plant(ticket, a, hardTiming(hardEnd));
				// A's journal is empty (the claims were planted by another writer).
				const lost = await losingConfirmation(fixture, () => fixture.json(boundsArgs(TICKET, a, newEnd)));
				// Positive control (catches: missing wiring; a witnessed transition with A open reported final).
				expect({ view: cliView(lost), transition: transitionOf(lost.doc) }).toEqual({
					view: witnessedView("change-bounds"),
					transition: phaseView("witnessed", hardEnd, hull, queriedStorage("unknown", "open")),
				});
				const transitionId = String(field(lost.doc, "operationId"));
				const confirmId = confirmIdOf(lost.doc);
				await fixture.writeBlock({ enabled: false });
				const restart = ["--time-box", "restart", "--hard-end", iso(newEnd)];
				// A has no record on SECOND; the disabled gate ends the call in the preflight.
				const restarted = await fixture.json(transferArgs(SECOND, a, b, ...restart));
				// A has no record on THIRD.
				const extended = await fixture.json(boundsArgs(THIRD, a, newEnd));
				// Retry never pauses; a P record of a T call needs enabled like acquire.
				const retriedTransition = await fixture.json(onArgs("retry", transitionId, a));
				// Retry never pauses; an A record is allowed under enabled false.
				const retriedConfirm = await fixture.json(onArgs("retry", confirmId, a));
				// resolve is read-only and never pauses.
				const resolved = await fixture.json(onArgs("resolve", transitionId, a));
				// catches: the restart given the maintain purpose; the time path on while
				// disabled (timePath = enabled); a P record resent while disabled; the witness stranded by
				// the disabled block; a record for a refused or rejected call.
				expect({
					restarted: cliView(restarted),
					extended: cliView(extended),
					retriedTransition: cliView(retriedTransition),
					retriedConfirm: cliView(retriedConfirm),
					resolved: cliView(resolved),
					resolvedTransition: transitionOf(resolved.doc),
					journalA: await fixture.recordNames(a),
					journalB: await fixture.recordNames(b),
				}).toEqual({
					restarted: failed("transfer", "refused", "claims-disabled"),
					extended: planRejected("change-bounds", "requires-time-path", "held"),
					retriedTransition: failed("retry", "refused", "claims-disabled", "generated"),
					// ASSUMPTION(time path) [?3]: the A record carries the action of its P.
					retriedConfirm: applied("retry", "held", { action: "change-bounds", operationId: "derived" }),
					resolved: resolvedView("applied", "applied", "stored", "change-bounds", "generated"),
					resolvedTransition: CONFIRMED_RESOLUTION,
					journalA: [`${transitionId}.json`, `${confirmId}.json`].sort(byCodeUnits),
					journalB: [],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);
});

describe("claim CLI time path documentation (no project)", () => {
	test(
		"cli-06: the guide explains the time path, the transfer help documents --hard-end, and no verb is added",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-time-docs-"));
			try {
				const guide = await runCli(cwd, ["instructions", "claims"]);
				// Positive control (catches: a guide without the time path; the scaffold leaves the guide
				// unchanged, so every term counts 0 there).
				expect({ exit: guide.exit, missingTerms: GUIDE_TERMS.filter((term) => !guide.stdout.includes(term)) }).toEqual({
					exit: 0,
					missingTerms: [],
				});
				const transfer = await helpView(cwd, "transfer", "claim-operation", TRANSFER_FIELDS);
				const group = await runCli(cwd, ["claim", "--help"]);
				// catches: --hard-end registered on transfer without its schema line; a new verb (node
				// g2 rejected); the stale "not available yet" sentence kept (claims.md:184); an exit code
				// row lost (adds no status).
				expect({
					transfer,
					confirmVerb: /^\s+confirm\b/m.test(group.stdout + group.stderr),
					stale: guide.stdout.includes("not available yet"),
					missingRows: missingExitRows(guide.stdout),
				}).toEqual({ transfer: documented("transfer"), confirmVerb: false, stale: false, missingRows: [] });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
