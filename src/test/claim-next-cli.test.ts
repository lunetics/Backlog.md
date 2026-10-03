/**
 * End-to-end contract of `backlog claim next`: the real `claim next`, `backlog claim acquire|resolve|list` and
 * `backlog task list|view` subprocesses in real Backlog projects whose task files carry priority, `created_date` in
 * both forms the product writes, dependencies, labels, assignees, milestone, parent, type, project and completed
 * records, against the loopback Git daemon (blob; e-nxt-05 also tree and commit-chain), with scripted receive hooks
 * (S1, test-local), the StallProxy connection counter and private contexts created through the context API. Every JSON
 * document is checked against a test-local validator of the documented schema that gains the `claim-next` kind, the
 * `next` command and the three new codes; the attempts inside a `claim-next` document are validated as the unchanged
 * base documents they are. Every claim stdout and stderr is scanned for owner names (allowed only in human list
 * output), context paths, bindings, secrets and IDs, endpoints, server roots and journal digests; `task` output is task
 * data and stays outside the scan. The CLI runs on the real clock and no expectation depends on it: creation instants
 * are fixed strings in the task files. Every test starts with a positive control the scaffold cannot satisfy, except
 * e-nxt-04, whose direct acquire control is green on the scaffold by design. Follow-up mutating calls run only against
 * a changed root, from another context or after a call that recorded nothing; e-nxt-06 step 2 checks the acquisition
 * stop on purpose. The harness is an adapted copy of claim-cli.test.ts. The shared-filter rows rest on the shared
 * filter reconciliation of `claim next` with batch reclaim. e-nxt-08 pins the guide sentence about the overlapping CAS
 * loser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { type ClaimStorageFormat, initializeClaimStorage } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, type ReceivePhase, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-cli.test.ts:33-99: BlockOptions gains the dependency policy key; CaseSetup carries
// the task files and a block change function instead of a Partial; the claim-next views are new; unused base types
// (setup, init, context, LocalRow configuration rows, ListView entry facts beyond the scan) are left out.
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
	/** `claims.acquire_dependency_policy` as a string, so an invalid value can be written; null omits it. */
	dependencyPolicy: string | null;
};
/** A block change: a full copy with literal overrides, never a spread of a Partial over required fields. */
type BlockChange = (base: BlockOptions) => BlockOptions;
/** One task file (E); `completed` moves it into the completed directory after saving. */
type TicketSpec = {
	id: string;
	/** The two forms the product writes: `YYYY-MM-DD HH:MM` (backlog.ts:1769) and `YYYY-MM-DD` (fixtures). */
	createdDate: string;
	title?: string;
	status?: string;
	priority?: string;
	type?: string;
	project?: string;
	milestone?: string;
	parent?: string;
	assignee?: readonly string[];
	labels?: readonly string[];
	dependencies?: readonly string[];
	completed?: boolean;
};
/** `descriptor: false` leaves the area uninitialized; `block: null` writes no claims block. */
type CaseSetup = {
	tickets: readonly TicketSpec[];
	projects?: readonly string[];
	descriptor?: boolean;
	block?: BlockChange | null;
};
type ContextHandle = { context: ClaimContext; directory: string };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type CliRun = { exit: number; stdout: string; stderr: string; ms: number };
type JsonRun = CliRun & { doc: unknown };
type Output = { command: string; text: string; ownerAllowed: boolean };
type Sentinel = readonly [label: string, value: string];
type JournalRecord = { name: string; digest: string; parameterDigest: string };
type Snapshot = { files: Record<string, string>; head: string; index: string; status: string };
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
/** One attempt inside a claim-next document: its ticket and the base view of the unchanged attempt document. */
type AttemptView = { ticket: unknown; view: CliView };
/** The claim-next document, field by field; the attempts as AttemptViews. */
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
	/** Stops claimed and attempt: ticket and operation ID are those of the last attempt; else null. */
	anchored: boolean | null;
};
type Excluded = { blocked: number; dependencyUnknown: number; notActionable: number };
type NextFacts = {
	order?: "priority" | "age";
	maxCandidates?: number;
	ticket?: string;
	operationId?: string;
	candidates: readonly string[];
	excluded?: Excluded;
	diagnostics?: readonly Record<string, unknown>[];
	attempts: readonly AttemptView[];
	untried: number;
	stop: Record<string, unknown>;
};
type EntryView = { ticket: unknown; state: unknown; owner: unknown; claimGeneration: unknown; ownership: unknown };
type PlainView = { exit: number; stream: string; head: string | null };
type HelpView = { command: string; exit: number; missing: string[]; kind: boolean; json: boolean };
type Shape = { required: readonly string[]; optional: readonly string[] };
type LocalRow = { label: string; catches: string; args: string[]; code: string };
type FilterSet = { label: string; catches: string; flags: readonly string[] };
type Raced = { owner: string; handle: ContextHandle; run: JsonRun };

// adapted from claim-cli.test.ts:101-151 (timeouts, owner, sentinel, ID pattern, exit table)
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of healthy cases, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of lost-reply cases; every scripted hold outlasts it (claim-cli.test.ts:109). */
const LOSS_TIMEOUT = 2_000;
/** attempt_timeout_ms of cases that must contact the stalled endpoint (claim-cli.test.ts:111). */
const STALL_TIMEOUT = 750;
/** e-nxt-05: attempt_timeout_ms 10000, so a loaded host does not turn a race into a timeout. */
const RACE_TIMEOUT = 10_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context and endpoint paths and in hook stderr; no claim output may contain it. */
const SENTINEL = "SENTINEL-next-cli-7c3e";
/** Display names: allowed only in claim-list entries, never in a claim-next document. */
const KARL = "agent-owner-karl";
const FRANZ = "agent-owner-franz";
const LENA = "agent-owner-lena";
const OWNERS: readonly string[] = [KARL, FRANZ, LENA];
const MARIA = "human-maria";
const CLAIM_REF_PREFIX = "refs/claims/";
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
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
/** Default 5 and range 1-50 of --max-candidates; qualification may requalify the numbers. */
const DEFAULT_MAX_CANDIDATES = 5;
const MAX_MAX_CANDIDATES = 50;
const NONE_EXCLUDED: Excluded = { blocked: 0, dependencyUnknown: 0, notActionable: 0 };
/** Fragments of `task list` stderr texts (cli.ts:327-379, :2578-2662); none may reach a claim-next output. */
const TASK_LIST_TEXTS = [
	"Invalid ",
	"Valid values are",
	"Valid statuses are",
	"Valid types are",
	"cannot be combined with --assignee",
	"Cannot use an empty value",
	"No projects are configured",
];
/**
 * The contract names the command, the document kind, the three codes and the two sections; the flags, the key and its
 * two values are ASSUMPTION(what those sections name). All twelve count 0 in the guide before the change.
 */
const GUIDE_TERMS = [
	"claim next",
	"claim-next",
	"--max-candidates",
	"--order",
	"acquire_dependency_policy",
	"strict",
	"permissive",
	"dependency-blocked",
	"dependency-unknown",
	"tasks-unavailable",
	"Ready selection and order",
	"Dependency policy",
];
/** Verbatim: the guide sentence directly under the continue/stop table of `claim next`. */
const REREAD_SENTENCE =
	"A write the endpoint refused is read again before it is reported: `storage` `stale` when the ticket ref no longer " +
	"holds the root the attempt started from, `storage` `remote` when it still does or the re-read fails; a lost race " +
	"therefore moves the call to the next candidate, a refusal by the endpoint itself stops it.";

// e-nxt-01: priority order is 3, 2, 1, 4 (high by age, then low, then none); age order is 4, 1, 3, 2. An ID
// tie-break would put BACK-2 before BACK-3; mixed date forms catch a string comparison only by accident.
const ORDER_TICKETS: readonly TicketSpec[] = [
	{ id: "BACK-1", priority: "low", createdDate: "2026-01-01 10:00" },
	{ id: "BACK-2", priority: "high", createdDate: "2026-03-01" },
	{ id: "BACK-3", priority: "high", createdDate: "2026-02-01 09:30" },
	{ id: "BACK-4", createdDate: "2025-12-01" },
];
// e-nxt-02: ready without flags are 1, 2, 3, 6, 7. BACK-3 depends on BACK-9 (Done, no labels, so any label filter
// hides it); BACK-7 on BACK-10 in the completed directory; BACK-4 is blocked by BACK-3 (In Progress); BACK-5 names
// the missing BACK-98; BACK-8 and BACK-9 are Done. BACK-6 carries `api` alone, so an any-match of --labels differs.
const FILTER_TICKETS: readonly TicketSpec[] = [
	{
		id: "BACK-1",
		title: "Parent epic",
		priority: "high",
		type: "feature",
		project: "web",
		labels: ["backend", "api"],
		milestone: "m-1",
		createdDate: "2026-05-01 08:00",
	},
	{
		id: "BACK-2",
		title: "Login form validation",
		priority: "medium",
		type: "bug",
		project: "web",
		labels: ["frontend"],
		assignee: [MARIA],
		parent: "BACK-1",
		createdDate: "2026-05-02",
	},
	{
		id: "BACK-3",
		title: "Session store",
		status: "In Progress",
		priority: "high",
		type: "feature",
		project: "api",
		labels: ["backend", "api"],
		milestone: "m-1",
		dependencies: ["BACK-9"],
		createdDate: "2026-05-03 09:15",
	},
	{
		id: "BACK-4",
		title: "Login audit trail",
		priority: "low",
		type: "task",
		labels: ["backend"],
		milestone: "m-2",
		parent: "BACK-1",
		dependencies: ["BACK-3"],
		createdDate: "2026-05-04",
	},
	{
		id: "BACK-5",
		title: "Rate limiter",
		priority: "high",
		type: "feature",
		project: "api",
		labels: ["backend", "api", "perf"],
		assignee: [MARIA],
		dependencies: ["BACK-98"],
		createdDate: "2026-05-05 11:00",
	},
	{ id: "BACK-6", title: "Docs refresh", priority: "high", type: "docs", labels: ["api"], createdDate: "2026-05-06" },
	{
		id: "BACK-7",
		title: "API login endpoint",
		priority: "high",
		type: "feature",
		project: "api",
		labels: ["api", "backend"],
		milestone: "m-1",
		parent: "BACK-1",
		dependencies: ["BACK-10"],
		createdDate: "2026-05-07 14:45",
	},
	{
		id: "BACK-8",
		title: "Cleanup",
		status: "Done",
		priority: "medium",
		labels: ["backend", "api"],
		createdDate: "2026-05-08",
	},
	{ id: "BACK-9", title: "Schema migration", status: "Done", priority: "low", createdDate: "2026-05-09" },
	{ id: "BACK-10", title: "Initial setup", status: "Done", createdDate: "2026-04-01", completed: true },
];
const PROJECTS: readonly string[] = ["web", "api"];
/** e-nxt-02: the flag sets plus `--parent 1` and `--project api`; every set narrows the ready list. */
const FILTER_SETS: readonly FilterSet[] = [
	{ label: "no flags", catches: "readiness against the filtered set; the completed corpus ignored", flags: [] },
	{
		// Claim next canonicalizes "to do" to "To Do" (utils/status.ts:44-74); task list does
		// not validate --status but matches it case-insensitively (utils/status-filter.ts:10-18), so both select
		// the same tickets and the row is a valid parity row.
		label: "status",
		catches: "status normalization missing (case)",
		flags: ["--status", "to do"],
	},
	{ label: "labels", catches: "label any-match instead of all-match", flags: ["--labels", "backend,api"] },
	{
		label: "priority and type",
		catches: "priority or type dropped",
		flags: ["--priority", "high", "--type", "feature"],
	},
	{ label: "assignee", catches: "the assignee filter compared with the owner", flags: ["--assignee", MARIA] },
	{ label: "unassigned", catches: "unassigned read as unclaimed", flags: ["--unassigned"] },
	{ label: "milestone", catches: "a second milestone matcher", flags: ["--milestone", "m-1"] },
	{ label: "parent", catches: "the parent filter dropped", flags: ["--parent", "BACK-1"] },
	{ label: "bare parent", catches: "no parent resolution for a bare ID", flags: ["--parent", "1"] },
	{ label: "search", catches: "the search query dropped", flags: ["--search", "login"] },
	// Both sides canonicalize --exclude-status with the same function (cli.ts:2588-2596).
	{ label: "exclude status", catches: "--exclude-status dropped", flags: ["--exclude-status", "In Progress"] },
	{ label: "project", catches: "the project filter dropped", flags: ["--project", "api"] },
];
// e-nxt-03: BACK-3 is acquired directly by FRANZ first; --unassigned must still try it (unassigned is not unclaimed).
const ASSIGNEE_TICKETS: readonly TicketSpec[] = [
	{ id: "BACK-1", priority: "low", assignee: [MARIA], createdDate: "2026-06-01" },
	{ id: "BACK-2", priority: "medium", createdDate: "2026-06-02 10:00" },
	{ id: "BACK-3", priority: "high", createdDate: "2026-06-03" },
];
// e-nxt-04: BACK-2 is blocked by BACK-10 (In Progress, no dependencies, so ready itself and last by priority);
// BACK-3 names the missing BACK-99; BACK-4 depends on BACK-11 in the completed directory.
const POLICY_TICKETS: readonly TicketSpec[] = [
	{ id: "BACK-1", priority: "low", createdDate: "2026-07-01" },
	{ id: "BACK-2", priority: "high", dependencies: ["BACK-10"], createdDate: "2026-07-02 08:00" },
	{ id: "BACK-3", priority: "high", dependencies: ["BACK-99"], createdDate: "2026-07-03" },
	{ id: "BACK-4", priority: "medium", dependencies: ["BACK-11"], createdDate: "2026-07-04 12:00" },
	{ id: "BACK-10", title: "Running prerequisite", status: "In Progress", createdDate: "2026-06-20" },
	{ id: "BACK-11", title: "Finished prerequisite", status: "Done", createdDate: "2026-06-10", completed: true },
];
const PAIR_TICKETS: readonly TicketSpec[] = [
	{ id: "BACK-1", priority: "high", createdDate: "2026-08-01 09:00" },
	{ id: "BACK-2", priority: "low", createdDate: "2026-08-02" },
];
const PAIR: readonly string[] = ["BACK-1", "BACK-2"];
/** e-nxt-05: isolated conflicts of a race; a first-send remote rejection stops the call. */
const RACE_ISOLATED: readonly string[] = ["plan/not-free", "storage/stale"];
const RACE_SHAPES: readonly string[] = ["claimed", "exhausted", "stopped-remote"];
/** e-nxt-05 follow-ups: an own ticket is `held` and continues. */
const FOLLOW_ISOLATED: readonly string[] = ["plan/not-free", "plan/held"];
const FOLLOW_SHAPES: readonly string[] = ["claimed", "exhausted"];

// doc-04 of the base CLI: the documented schema, independent of the module under test.
// adapted from claim-cli.test.ts:182-234: + the claim-next shape, + `dependencies` on claim-error, + command next,
// + three codes; the setup, init and context shapes are left out because no call here produces them.
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
	"claim-resolution": { required: ["operationId", "ticket", "action", "outcome", "query"], optional: [] },
	"claim-list": { required: ["complete", "observedAt", "claims"], optional: [] },
	// The closed key set of the new document.
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
	"claim-error": {
		required: ["code", "message", "ticket", "operationId"],
		// `dependencies` on the dependency refusals; ASSUMPTION(claim next): on no other code.
		optional: ["problems", "configuredFormat", "existingFormat", "dependencies"],
	},
};
const STATUSES: readonly unknown[] = Object.keys(EXIT);
const COMMANDS: readonly unknown[] =
	"acquire renew release reclaim resolve retry list setup init context-create next".split(" ");
const ACTIONS: readonly unknown[] = ["acquire", "renew", "release", "reclaim"];
const OUTCOMES: readonly unknown[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTIONS: readonly unknown[] = "stored not-stored open conflict unknown unknown-history invalid".split(" ");
const OUTER_QUERIES: readonly unknown[] =
	"record-absent record-corrupt invalid unavailable unknown unknown-history unsupported".split(" ");
const RIGHTS_FAILURES: readonly unknown[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
const STOPS: readonly unknown[] = [null, "attempts", "budget"];
const ORDERS: readonly unknown[] = ["priority", "age"];
const ATTEMPT_KINDS: readonly unknown[] = ["claim-operation", "claim-pause", "claim-error"];
const DEPENDENCY_CODES: readonly unknown[] = ["dependency-blocked", "dependency-unknown"];
/** The closed code list with the three additive codes. */
const ERROR_CODES = `
	project-not-found project-config-unreadable invalid-ticket ticket-not-found ticket-ambiguous
	owner-required context-required invalid-option option-not-applicable hard-end-required
	invalid-operation-id operation-id-in-use not-configured config-invalid claims-disabled
	context-invalid context-corrupt context-unavailable descriptor-missing format-mismatch
	schema-unsupported coordination-corrupt unreachable preflight-invalid preflight-unknown
	request-invalid local-unavailable storage-unreadable state-corrupt state-unsupported state-unknown
	budget-exhausted operation-not-found record-corrupt scope-mismatch
	list-unavailable already-configured config-write-failed format-conflict not-empty remote-rejected
	init-unknown internal dependency-blocked dependency-unknown tasks-unavailable
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

function between(value: unknown, min: number, max: number): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

// adapted from claim-cli.test.ts:359-469 (timingOk, queryOk, storageOk, rightsOk, rejectionOk, plannedOk, entryOk,
// problemsOk, pauseOk), unchanged
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

function entryOk(value: unknown): boolean {
	return (
		isRecord(value) &&
		exact(value, ["ticket", "state"], ["owner", "claimGeneration", "timing", "rights"]) &&
		typeof value.ticket === "string" &&
		["active", "free", "unknown"].includes(String(value.state)) &&
		(value.owner === undefined || typeof value.owner === "string") &&
		(value.claimGeneration === undefined || integer(value.claimGeneration)) &&
		(value.timing === undefined || timingOk(value.timing)) &&
		(value.rights === undefined || rightsOk(value.rights))
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

/** Canonical ticket IDs only; ASSUMPTION(claim next): everything else is counted as unreadable. */
function dependenciesOk(value: unknown): boolean {
	return (
		exact(value, ["blocking", "unknown", "unreadable"]) &&
		texts(field(value, "blocking")) &&
		texts(field(value, "unknown")) &&
		integer(field(value, "unreadable"))
	);
}

function excludedOk(value: unknown): boolean {
	return (
		exact(value, ["blocked", "dependencyUnknown", "notActionable"]) &&
		integer(field(value, "blocked")) &&
		integer(field(value, "dependencyUnknown")) &&
		integer(field(value, "notActionable"))
	);
}

function diagnosticOk(value: unknown): boolean {
	return (
		exact(value, ["ticket", "cause", "dependencies"]) &&
		typeof field(value, "ticket") === "string" &&
		field(value, "cause") === "dependency-unknown" &&
		dependenciesOk(field(value, "dependencies"))
	);
}

/** The attempts are the unchanged base documents of the acquire core, `command: "acquire"`. */
function attemptOk(value: unknown): boolean {
	return (
		isRecord(value) &&
		ATTEMPT_KINDS.includes(value.kind) &&
		value.command === "acquire" &&
		schemaProblems(value).length === 0
	);
}

/** The stop kind decides the status; `attempt` carries the stopping attempt's status. */
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

/** doc-04: problems of one document against the documented schema; an empty list means valid. */
// adapted from claim-cli.test.ts:471-539 (+ case claim-next, + `dependencies` on claim-error; setup/init/context cut)
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

// adapted from claim-cli.test.ts:585-589 (without the field overrides no case here needs)
function applied(command: string, ownership: string): CliView {
	const facts = { action: command, outcome: "applied", storage: { kind: "applied" }, sends: 1 };
	return view({ status: "applied", command, ...facts, ownership, operationId: "generated" });
}

/** Plan rejections persist nothing, so no operation ID is printed. */
// adapted from claim-cli.test.ts:591-595 (without the boundary no case here needs)
function planRejected(command: string, cause: string, ownership: string): CliView {
	const rejection = { stage: "plan", cause };
	return view({ status: "rejected", command, action: command, outcome: "rejected", rejection, sends: 0, ownership });
}

// adapted from claim-cli.test.ts:597-599
function failed(command: string, status: Status, code: string): CliView {
	return view({ status, command, kind: "claim-error", code });
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

/** An attempt document inside claim-next, viewed like a top-level base document with the exit code of its status. */
function attemptView(doc: unknown): AttemptView {
	const status = field(doc, "status");
	const exit = typeof status === "string" && status in EXIT ? EXIT[status as Status] : -1;
	return { ticket: field(doc, "ticket") ?? null, view: cliView({ exit, stdout: "", stderr: "", ms: 0, doc }) };
}

function tried(ticket: string, attempt: CliView): AttemptView {
	return { ticket, view: attempt };
}

/** The claim-next document of one run, field by field. */
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
		operationId: typeof id === "string" && GENERATED_ID.test(id) ? "generated" : (id ?? null),
		candidates: field(doc, "candidates") ?? null,
		excluded: field(doc, "excluded") ?? null,
		diagnostics: field(doc, "diagnostics") ?? null,
		attempts: Array.isArray(attempts) ? attempts.map((attempt: unknown) => attemptView(attempt)) : null,
		untried: field(doc, "untried") ?? null,
		stop: field(doc, "stop") ?? null,
		anchored,
	};
}

/**
 * The expected claim-next view. ASSUMPTION(claim next): `ticket` and `operationId` are null unless the call
 * acquired a ticket or an attempt stopped it; `untried` counts every candidate not attempted, also before the loop.
 */
function nextOf(status: Status, facts: NextFacts): NextView {
	const kind = facts.stop.kind;
	return {
		exit: EXIT[status],
		schema: [],
		kind: "claim-next",
		status,
		command: "next",
		order: facts.order ?? "priority",
		maxCandidates: facts.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
		ticket: facts.ticket ?? null,
		operationId: facts.operationId ?? null,
		candidates: [...facts.candidates],
		excluded: facts.excluded ?? NONE_EXCLUDED,
		diagnostics: [...(facts.diagnostics ?? [])],
		attempts: [...facts.attempts],
		untried: facts.untried,
		stop: facts.stop,
		anchored: kind === "claimed" || kind === "attempt" ? true : null,
	};
}

/** One diagnostics entry of a ticket whose prerequisites cannot be resolved locally. */
function unknownDependency(ticket: string, unknown: readonly string[]): Record<string, unknown> {
	return { ticket, cause: "dependency-unknown", dependencies: { blocking: [], unknown: [...unknown], unreadable: 0 } };
}

/** `stage/cause` of a rejected attempt, the outcome of any other operation, `paused` or `error/<code>`. */
function causeOf(attempt: unknown): string {
	const kind = field(attempt, "kind");
	if (kind === "claim-pause") return "paused";
	if (kind === "claim-error") return `error/${String(field(attempt, "code"))}`;
	if (kind !== "claim-operation") return "undocumented";
	const rejection = field(attempt, "rejection");
	if (isRecord(rejection)) return `${String(rejection.stage)}/${String(rejection.cause)}`;
	return String(field(attempt, "outcome"));
}

/**
 * e-nxt-05: the shape of one call. `claimed`: exit 0, one applied attempt, last, after isolated
 * conflicts only, on the document's ticket; `exhausted`: exit 2, isolated conflicts only; `stopped-remote`: exit 2,
 * stop attempt on a first-send remote rejection after isolated conflicts. Anything else is named in full.
 */
function shapeOf(run: JsonRun, isolated: readonly string[]): string {
	const attempts = field(run.doc, "attempts");
	const list: unknown[] = Array.isArray(attempts) ? attempts : [];
	const causes = list.map((attempt) => causeOf(attempt));
	const stop = field(field(run.doc, "stop"), "kind");
	const earlier = causes.slice(0, -1).every((cause) => isolated.includes(cause));
	const lastTicket = field(list.at(-1), "ticket");
	if (run.exit === 0 && stop === "claimed" && causes.at(-1) === "applied" && earlier) {
		if (field(run.doc, "ticket") === lastTicket) return "claimed";
	}
	if (run.exit === 2 && stop === "exhausted" && causes.every((cause) => isolated.includes(cause))) return "exhausted";
	if (run.exit === 2 && stop === "attempt" && causes.at(-1) === "storage/remote" && earlier) return "stopped-remote";
	return `unexpected: exit ${run.exit}, stop ${String(stop)}, attempts [${causes.join(", ")}]`;
}

function sortedTickets(value: unknown): string[] | null {
	return Array.isArray(value) ? value.map((item: unknown) => String(item)).sort(byCodeUnits) : null;
}

/** The task IDs of a `task list --json` document, sorted; null when the output is no list. */
function idsOf(doc: unknown): string[] | null {
	const tasks = field(doc, "tasks");
	return Array.isArray(tasks) ? tasks.map((task: unknown) => String(field(task, "id"))).sort(byCodeUnits) : null;
}

function properSubset(part: readonly string[] | null, whole: readonly string[] | null): boolean {
	if (part === null || whole === null) return false;
	return part.length > 0 && part.length < whole.length && part.every((id) => whole.includes(id));
}

/** Assignees and status of one `task view --json` document (claim-next writes neither). */
function taskFacts(run: JsonRun): Record<string, unknown> {
	const task = field(run.doc, "task");
	return { exit: run.exit, assignees: field(task, "assignees") ?? null, status: field(task, "status") ?? null };
}

// adapted from claim-cli.test.ts:610-628 (only the entry facts)
function entriesOf(run: JsonRun): EntryView[] | null {
	const claims = field(run.doc, "claims");
	if (!Array.isArray(claims)) return null;
	return claims
		.map((item: unknown) => ({
			ticket: field(item, "ticket") ?? null,
			state: field(item, "state") ?? null,
			owner: field(item, "owner") ?? null,
			claimGeneration: field(item, "claimGeneration") ?? null,
			ownership: field(field(item, "rights"), "ownership") ?? null,
		}))
		.filter((item) => item.state === "active")
		.sort((left, right) => byCodeUnits(String(left.ticket), String(right.ticket)));
}

/** An active list entry without --context: owner as display data, no rights. */
function activeEntry(ticket: string, owner: string): EntryView {
	return { ticket, state: "active", owner, claimGeneration: 1, ownership: null };
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

// adapted from claim-cli.test.ts:688-697
async function helpView(cwd: string, command: string, kind: string): Promise<HelpView> {
	const run = await runCli(cwd, ["claim", ...command.split(" "), "--help"]);
	const text = run.stdout + run.stderr;
	const missing = ["Input schema:", "Output:", "Examples:"].filter((section) => !text.includes(section));
	return { command, exit: run.exit, missing, kind: text.includes(kind), json: text.includes("--json") };
}

function documented(command: string): HelpView {
	return { command, exit: 0, missing: [], kind: true, json: true };
}

// adapted from claim-cli.test.ts:699-705 (the owner is a parameter here)
function acquireArgs(ticket: string, handle: ContextHandle, owner: string): string[] {
	return ["claim", "acquire", ticket, "--owner", owner, "--context", handle.directory];
}

function onArgs(verb: string, target: string, handle: ContextHandle): string[] {
	return ["claim", verb, target, "--context", handle.directory];
}

/** `claim next --owner <name> --context <abs> [flags]`, no ticket argument. */
function nextArgs(handle: ContextHandle, owner: string, ...extra: string[]): string[] {
	return ["claim", "next", "--owner", owner, "--context", handle.directory, ...extra];
}

/** Keys plus the policy key (appended last, like SCHEMA_KEYS). */
// adapted from claim-cli.test.ts:724-741 (+ the acquire_dependency_policy line)
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
		...(options.dependencyPolicy === null ? [] : [`  acquire_dependency_policy: ${options.dependencyPolicy}`]),
	].join("\n");
}

// adapted from claim-cli.test.ts:743-758 (+ dependencyPolicy null: the key is missing, which reads strict)
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
		dependencyPolicy: null,
	};
}

// adapted from claim-cli.test.ts:760-766
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/**
 * A Backlog project with task prefix BACK, the given task files, optional configured projects, the claims block and
 * one committed repository. Completed specs are saved first and then moved with FileSystem.completeTask.
 */
// adapted from claim-cli.test.ts:768-800 (task specs instead of fixed tickets, projects, the completed directory)
async function initProject(
	directory: string,
	tickets: readonly TicketSpec[],
	block: string | undefined,
	projects: readonly string[],
): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim next CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	const configured = projects.length > 0 ? [...projects] : config.projects;
	const prefixes = { ...config.prefixes, task: "BACK" };
	await core.filesystem.saveConfig({ ...config, prefixes, claimsYaml: block, projects: configured });
	for (const spec of tickets) {
		await core.filesystem.saveTask({
			id: spec.id,
			title: spec.title ?? `Claim target ${spec.id}`,
			status: spec.status ?? "To Do",
			assignee: [...(spec.assignee ?? [])],
			labels: [...(spec.labels ?? [])],
			dependencies: [...(spec.dependencies ?? [])],
			createdDate: spec.createdDate,
			rawContent: "",
			priority: spec.priority,
			type: spec.type,
			project: spec.project,
			milestone: spec.milestone,
			parentTaskId: spec.parent,
		});
	}
	for (const spec of tickets) {
		if (spec.completed === true && !(await core.filesystem.completeTask(spec.id))) {
			throw new Error(`${spec.id} could not be moved into the completed directory`);
		}
	}
	// The CLI migrates the configuration before each command; migrating here keeps the snapshot stable.
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
// adapted from claim-cli.test.ts:837-918 (without `lines`, which no case here reads)
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

/** One server area with S1 hooks, one project, private contexts and the output collector. */
// adapted from claim-cli.test.ts:920-1188 (task specs, block changes, uncollected `task` calls, claimTickets and a
// task-directory snapshot; the writer store, extra projects, other areas and receipts are left out)
class CliCase {
	readonly hooks: ReceiveScript;
	readonly parent: string;
	private options: BlockOptions;
	private readonly outputs: Output[] = [];
	private readonly handles: ContextHandle[] = [];
	private readonly roots = new Set<string>();
	private directories = 0;

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
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-next-cli-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `next-${SENTINEL}-${format}-${caseName}`);
			const url = server().url(name);
			const base = defaultBlock(url, format);
			const options = setup.block ? setup.block(base) : base;
			const project = join(root, `project-${SENTINEL}`);
			const block = setup.block === null ? undefined : claimsBlock(options);
			await initProject(project, setup.tickets, block, setup.projects ?? []);
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

	private async execute(args: readonly string[], cwd: string): Promise<CliRun> {
		const run = await runCli(cwd, args);
		for (const oid of Object.values(await this.serverRefs())) this.roots.add(oid);
		return run;
	}

	/** One JSON-mode call; list documents enter the collector without their owner fields. */
	async json(args: readonly string[]): Promise<JsonRun> {
		const run = await this.execute([...args, "--json"], this.project);
		const doc = parseDocument(run.stdout);
		const stdout = field(doc, "kind") === "claim-list" ? JSON.stringify(withoutOwners(doc)) : run.stdout;
		this.outputs.push({ command: commandOf(args), text: stdout + run.stderr, ownerAllowed: false });
		return { ...run, doc };
	}

	/** One human-mode call; an owner may appear only in list output. */
	async plain(args: readonly string[]): Promise<CliRun> {
		const run = await this.execute([...args, "--plain"], this.project);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: command === "list" });
		return run;
	}

	/** A call with exactly `args`, for Commander usage errors. */
	async raw(args: readonly string[]): Promise<CliRun> {
		const run = await this.execute(args, this.project);
		this.outputs.push({ command: commandOf(args), text: run.stdout + run.stderr, ownerAllowed: false });
		return run;
	}

	/** A `task …` call: task data, no claim document, so it stays outside the leak scan. */
	async task(args: readonly string[]): Promise<JsonRun> {
		const run = await this.execute(args, this.project);
		return { ...run, doc: parseDocument(run.stdout) };
	}

	/**
	 * Labels of every sentinel in the collected claim output. An owner is allowed in human list output only; a
	 * context ID never appears (no call here creates a context through the CLI). Roots are never printed.
	 */
	// adapted from claim-cli.test.ts:1066-1099 (every owner of the file instead of one)
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

	/** Journal records of one context; temporary and admission names start with a dot. */
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

	/** O1: the tickets with a claim ref on the server (storage/index.ts:298), sorted; the descriptor ref is not one. */
	async claimTickets(): Promise<string[]> {
		return Object.keys(await this.serverRefs())
			.filter((ref) => ref.startsWith(CLAIM_REF_PREFIX))
			.map((ref) => ref.slice(CLAIM_REF_PREFIX.length))
			.sort(byCodeUnits);
	}

	/** Bytes of the active and completed task files, HEAD, index and porcelain status of the project. */
	// adapted from claim-cli.test.ts:1160-1179 (CliCase.snapshot), narrowed to the two task directories
	async taskSnapshot(): Promise<Snapshot> {
		const files: Record<string, string> = {};
		const visit = async (directory: string): Promise<void> => {
			const items = await readdir(directory, { withFileTypes: true });
			for (const item of items.sort((left, right) => byCodeUnits(left.name, right.name))) {
				const path = join(directory, item.name);
				if (item.isDirectory()) await visit(path);
				else files[relative(this.project, path)] = sha256Hex(await readFile(path));
			}
		};
		for (const name of ["tasks", "completed"]) {
			const directory = join(this.project, "backlog", name);
			if (await exists(directory)) await visit(directory);
		}
		const git = async (args: string[]) => (await server().git(this.project, args)).out;
		return {
			files,
			head: (await git(["rev-parse", "HEAD"])).trim(),
			index: sha256Hex(await git(["ls-files", "--stage"])),
			status: await git(["status", "--porcelain"]),
		};
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

describe("claim next over real Git (blob)", () => {
	test(
		"e-nxt-01: priority order by age with --order age as the alternative, both read from created_date",
		async () => {
			await withCase("blob", "order", { tickets: ORDER_TICKETS }, async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const lena = await fixture.context();
				const byPriority = await fixture.json(nextArgs(karl, KARL));
				// Positive control (catches: no claim next; an ID tie-break (BACK-2 first); ascending priority; a missing
				// priority ranked high; created_date not read from the file; more than one attempt after the acquisition).
				expect(nextView(byPriority)).toEqual(
					nextOf("applied", {
						ticket: "BACK-3",
						operationId: "generated",
						candidates: ["BACK-3", "BACK-2", "BACK-1", "BACK-4"],
						attempts: [tried("BACK-3", applied("acquire", "held"))],
						untried: 3,
						stop: { kind: "claimed" },
					}),
				);
				// Franz is another context with an empty journal.
				const byAge = await fixture.json(nextArgs(franz, FRANZ, "--order", "age"));
				// Lena is a third context. No ticket is Done, so the selection is empty and the call ends before the
				// network.
				const empty = await fixture.plain(nextArgs(lena, LENA, "--status", "Done"));
				// catches: --order not passed on; priority still applied under age; a second claim ref or intent per call;
				// the human first line not `<status>:` or on the wrong stream.
				expect({
					byAge: nextView(byAge),
					refs: await fixture.claimTickets(),
					karl: await fixture.recordNames(karl),
					franz: await fixture.recordNames(franz),
					lena: await fixture.recordNames(lena),
					empty: plainView(empty),
					scanner: echoedIn(`planted ${SENTINEL}`, [["sentinel", SENTINEL]]),
				}).toEqual({
					byAge: nextOf("applied", {
						order: "age",
						ticket: "BACK-4",
						operationId: "generated",
						candidates: ["BACK-4", "BACK-1", "BACK-3", "BACK-2"],
						attempts: [tried("BACK-4", applied("acquire", "held"))],
						untried: 3,
						stop: { kind: "claimed" },
					}),
					refs: ["BACK-3", "BACK-4"],
					karl: [`${String(field(byPriority.doc, "operationId"))}.json`],
					franz: [`${String(field(byAge.doc, "operationId"))}.json`],
					lena: [],
					empty: plainOf("rejected"),
					scanner: ["sentinel"],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"e-nxt-02: claim next selects exactly what task list --ready --json lists for the same filter flags",
		async () => {
			await withCase("blob", "parity", { tickets: FILTER_TICKETS, projects: PROJECTS }, async (fixture) => {
				const k = await fixture.context();
				const runs: { set: FilterSet; next: JsonRun; list: JsonRun }[] = [];
				for (const set of FILTER_SETS) {
					// Every earlier call of k either landed (its ticket root moved on) or recorded nothing (plan held
					// or not-free), so none of its intents is outstanding (pause/index.ts:86-94). --max-candidates 1 keeps
					// each call to one attempt; `candidates` stays complete.
					const next = await fixture.json(nextArgs(k, KARL, "--max-candidates", "1", ...set.flags));
					const list = await fixture.task(["task", "list", "--ready", "--json", ...set.flags]);
					runs.push({ set, next, list });
				}
				const none = runs.find((run) => run.set.flags.length === 0);
				if (none === undefined) throw new Error("the flag table has no set without flags");
				const status = runs.find((run) => run.set.label === "status");
				if (status === undefined) throw new Error("the flag table has no status set");
				const everything = idsOf(none.list.doc);
				// Positive control (catches: no claim next; readiness against the filtered set; the completed directory
				// not read (BACK-7 missing); blocked and unresolved tickets not counted or not diagnosed).
				expect({
					kind: field(none.next.doc, "kind") ?? null,
					schema: schemaProblems(none.next.doc),
					settled: none.next.exit === 0 || none.next.exit === 2,
					maxCandidates: field(none.next.doc, "maxCandidates") ?? null,
					candidates: sortedTickets(field(none.next.doc, "candidates")),
					excluded: field(none.next.doc, "excluded") ?? null,
					diagnostics: field(none.next.doc, "diagnostics") ?? null,
				}).toEqual({
					kind: "claim-next",
					schema: [],
					settled: true,
					maxCandidates: 1,
					candidates: everything,
					excluded: { blocked: 1, dependencyUnknown: 1, notActionable: 2 },
					diagnostics: [unknownDependency("BACK-5", ["BACK-98"])],
				});
				// The list window of `task list --json` is unbounded without --max-count or --skip (list-window.ts:123-133)
				// and only a cut list carries `total` (json-output.ts:220-226): no set can hide an entry.
				// catches: a second filter engine (label any-match, status normalization, milestone matching, parent
				// resolution, search, project); a flag table that does not narrow (fixture check, green on the scaffold).
				expect({
					fixture: everything,
					cut: runs.filter((run) => field(run.list.doc, "total") !== undefined).map((run) => run.set.label),
					broad: runs
						.filter((run) => run.set.flags.length > 0 && !properSubset(idsOf(run.list.doc), everything))
						.map((run) => run.set.label),
					parity: runs.map((run) => ({
						label: run.set.label,
						candidates: sortedTickets(field(run.next.doc, "candidates")),
					})),
					schema: runs.flatMap((run) => schemaProblems(run.next.doc)),
					unsettled: runs.filter((run) => run.next.exit !== 0 && run.next.exit !== 2).map((run) => run.set.label),
				}).toEqual({
					fixture: ["BACK-1", "BACK-2", "BACK-3", "BACK-6", "BACK-7"],
					cut: [],
					broad: [],
					parity: runs.map((run) => ({ label: run.set.label, candidates: idsOf(run.list.doc) })),
					schema: [],
					unsettled: [],
				});
				// Invalid values: claim next refuses in JSON; task list keeps its text and exit code.
				// All three end before the executor, so nothing is recorded.
				const urgentNext = await fixture.json(nextArgs(k, KARL, "--priority", "urgent"));
				const urgentList = await fixture.task(["task", "list", "--ready", "--json", "--priority", "urgent"]);
				// Divergence pinned on purpose: claim next refuses an unknown --status, task list
				// does not validate it and keeps zero hits.
				const statusNext = await fixture.json(nextArgs(k, KARL, "--status", "Nonexistent"));
				const statusList = await fixture.task(["task", "list", "--ready", "--json", "--status", "Nonexistent"]);
				// The shared module reports blank-only values; claim next refuses, task list ignores them as
				// before (cli.ts:2633-2638).
				const blankNext = await fixture.json(nextArgs(k, KARL, "--labels", ""));
				const blankList = await fixture.task(["task", "list", "--ready", "--json", "--labels", ""]);
				// "Todo" is a known status in another spelling and is accepted as "To Do"
				// (canonicalization ignores case and spaces). Compared with the "to do" set only: task list treats
				// "todo" differently (no status matches it) and is deliberately not run for this value.
				// As in the loop above, no intent of k is outstanding.
				const squeezed = await fixture.json(nextArgs(k, KARL, "--max-candidates", "1", "--status", "todo"));
				// catches: the task list text in the claim JSON; the extraction changing task list texts or exit codes;
				// --status validated for claim next by exact spelling instead of the --exclude-status rule.
				expect({
					urgent: {
						next: cliView(urgentNext),
						stderr: urgentNext.stderr,
						list: [urgentList.exit, urgentList.stdout, urgentList.stderr],
					},
					status: { next: cliView(statusNext), list: [statusList.exit, idsOf(statusList.doc)] },
					blank: { next: cliView(blankNext), list: [blankList.exit, idsOf(blankList.doc)] },
					canonical: {
						kind: field(squeezed.doc, "kind") ?? null,
						settled: squeezed.exit === 0 || squeezed.exit === 2,
						candidates: sortedTickets(field(squeezed.doc, "candidates")),
					},
				}).toEqual({
					urgent: {
						next: failed("next", "refused", "invalid-option"),
						stderr: "",
						// Characterization of cli.ts:343 with the default priorities (priority-config.ts:3-7).
						list: [1, "", "Invalid priority: urgent. Valid values are: High, Medium, Low\n"],
					},
					status: { next: failed("next", "refused", "invalid-option"), list: [0, []] },
					blank: { next: failed("next", "refused", "invalid-option"), list: [0, everything] },
					canonical: { kind: "claim-next", settled: true, candidates: idsOf(status.list.doc) },
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"e-nxt-03: assignee filters are not owner checks, unassigned is not unclaimed, and no task file changes",
		async () => {
			await withCase("blob", "assignee", { tickets: ASSIGNEE_TICKETS }, async (fixture) => {
				const franz = await fixture.context();
				const karl = await fixture.context();
				const lena = await fixture.context();
				const before = await fixture.taskSnapshot();
				const direct = await fixture.json(acquireArgs("BACK-3", franz, FRANZ));
				// Karl is another context with an empty journal.
				const unassigned = await fixture.json(nextArgs(karl, KARL, "--unassigned"));
				// Positive control (catches: --unassigned read as unclaimed, so BACK-3 is never tried; a stop at the first
				// conflict; the assignee filter applied to the claim owner).
				expect({ direct: cliView(direct), unassigned: nextView(unassigned) }).toEqual({
					direct: applied("acquire", "held"),
					unassigned: nextOf("applied", {
						ticket: "BACK-2",
						operationId: "generated",
						candidates: ["BACK-3", "BACK-2"],
						attempts: [
							tried("BACK-3", planRejected("acquire", "not-free", "foreign")),
							tried("BACK-2", applied("acquire", "held")),
						],
						untried: 0,
						stop: { kind: "claimed" },
					}),
				});
				// Lena is another context with an empty journal.
				const assigned = await fixture.json(nextArgs(lena, LENA, "--assignee", MARIA));
				// Taken before the `task view` reads, so only claim calls stand between the two snapshots.
				const project = await fixture.taskSnapshot();
				const views = [
					await fixture.task(["task", "view", "BACK-1", "--json"]),
					await fixture.task(["task", "view", "BACK-2", "--json"]),
					await fixture.task(["task", "view", "BACK-3", "--json"]),
				];
				// catches: the owner used as the assignee filter; an assignee, status or ticket file written; a
				// commit in the project repository.
				expect({
					assigned: nextView(assigned),
					tasks: views.map((run) => taskFacts(run)),
					project,
				}).toEqual({
					assigned: nextOf("applied", {
						ticket: "BACK-1",
						operationId: "generated",
						candidates: ["BACK-1"],
						attempts: [tried("BACK-1", applied("acquire", "held"))],
						untried: 0,
						stop: { kind: "claimed" },
					}),
					tasks: [
						{ exit: 0, assignees: [MARIA], status: "To Do" },
						{ exit: 0, assignees: [], status: "To Do" },
						{ exit: 0, assignees: [], status: "To Do" },
					],
					project: before,
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"e-nxt-04: strict by default gates direct acquire; permissive lifts only the gate; ready selection stays strict",
		async () => {
			await withCase("blob", "policy", { tickets: POLICY_TICKETS }, async (fixture) => {
				const k = await fixture.context();
				const k2 = await fixture.context();
				const k3 = await fixture.context();
				const k4 = await fixture.context();
				const control = await fixture.json(acquireArgs("BACK-4", k3, FRANZ));
				// Positive control (catches: a gate that refuses a ticket whose prerequisite lies in the completed
				// directory). Green on the scaffold by design: its mutate has no gate yet.
				expect(cliView(control)).toEqual(applied("acquire", "held"));
				// (b) Strict without the key: refused before any record or send.
				const pushes = await fixture.hooks.count("pre");
				const blocked = await fixture.json(acquireArgs("BACK-2", k2, LENA));
				// The refusal above recorded nothing; BACK-3 is another ticket.
				const unknown = await fixture.json(acquireArgs("BACK-3", k2, LENA));
				// catches: the CLI env without loadLocalTickets, so no gate at all; a missing prerequisite read as done;
				// the gate after the executor (a record or a push).
				expect({
					blocked: cliView(blocked),
					blockedDependencies: field(blocked.doc, "dependencies") ?? null,
					unknown: cliView(unknown),
					unknownDependencies: field(unknown.doc, "dependencies") ?? null,
					records: await fixture.recordNames(k2),
					pushes: (await fixture.hooks.count("pre")) - pushes,
				}).toEqual({
					blocked: failed("acquire", "refused", "dependency-blocked"),
					blockedDependencies: { blocking: ["BACK-10"], unknown: [], unreadable: 0 },
					unknown: failed("acquire", "refused", "dependency-unknown"),
					unknownDependencies: { blocking: [], unknown: ["BACK-99"], unreadable: 0 },
					records: [],
					pushes: 0,
				});
				// (a): k is a fresh context.
				const next = await fixture.json(nextArgs(k, KARL));
				// (c) The permissive policy lifts the direct gate only.
				await fixture.writeBlock((base) => ({ ...base, dependencyPolicy: "permissive" }));
				// k2 recorded nothing in (b), and BACK-3 is another ticket than BACK-2.
				const permitted = [
					await fixture.json(acquireArgs("BACK-2", k2, LENA)),
					await fixture.json(acquireArgs("BACK-3", k2, LENA)),
				];
				// k4 is a fresh context.
				const strictNext = await fixture.json(nextArgs(k4, KARL));
				// (d) An unsupported value fails the resolver for every command.
				await fixture.writeBlock((base) => ({ ...base, dependencyPolicy: "lenient" }));
				// Both calls end at the configuration, before the executor.
				const invalidNext = await fixture.json(nextArgs(k, KARL));
				const invalidAcquire = await fixture.json(acquireArgs("BACK-1", k2, LENA));
				const candidates = ["BACK-4", "BACK-1", "BACK-10"];
				const excluded: Excluded = { blocked: 1, dependencyUnknown: 1, notActionable: 0 };
				const diagnostics = [unknownDependency("BACK-3", ["BACK-99"])];
				const problems = [{ key: "claims.acquire_dependency_policy", problem: "unsupported-value" }];
				// catches: the completed directory not read (BACK-4 missing from the candidates); an In Progress ticket
				// without dependencies treated as not ready; the policy applied to the ready selection;
				// an invalid policy value accepted or reported against another key.
				expect({
					next: nextView(next),
					permitted: permitted.map((run) => cliView(run)),
					strictNext: nextView(strictNext),
					invalidNext: cliView(invalidNext),
					invalidAcquire: cliView(invalidAcquire),
					problems: [field(invalidNext.doc, "problems") ?? null, field(invalidAcquire.doc, "problems") ?? null],
				}).toEqual({
					next: nextOf("applied", {
						candidates,
						excluded,
						diagnostics,
						ticket: "BACK-1",
						operationId: "generated",
						attempts: [
							tried("BACK-4", planRejected("acquire", "not-free", "foreign")),
							tried("BACK-1", applied("acquire", "held")),
						],
						untried: 1,
						stop: { kind: "claimed" },
					}),
					permitted: [applied("acquire", "held"), applied("acquire", "held")],
					strictNext: nextOf("applied", {
						candidates,
						excluded,
						diagnostics,
						ticket: "BACK-10",
						operationId: "generated",
						attempts: [
							tried("BACK-4", planRejected("acquire", "not-free", "foreign")),
							tried("BACK-1", planRejected("acquire", "not-free", "foreign")),
							tried("BACK-10", applied("acquire", "held")),
						],
						untried: 0,
						stop: { kind: "claimed" },
					}),
					invalidNext: failed("next", "refused", "config-invalid"),
					invalidAcquire: failed("acquire", "refused", "config-invalid"),
					problems: [problems, problems],
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"e-nxt-06: after an unknown acquire no further ticket is reserved, not even by the next call, until it resolves",
		async () => {
			const block: BlockChange = (base) => ({ ...base, attempts: 2, timeoutMs: LOSS_TIMEOUT });
			await withCase("blob", "unknown", { tickets: PAIR_TICKETS, block }, async (fixture) => {
				const k = await fixture.context();
				const f = await fixture.context();
				// (1) The pre-receive hook holds both sends past attempt_timeout_ms and then rejects them (base unk-01).
				const held = await fixture.hooks.next("pre");
				await fixture.hooks.plan("pre", ["hold-reject", "hold-reject"]);
				const lost = await fixture.json(nextArgs(k, KARL));
				const op1 = String(field(lost.doc, "operationId"));
				// Positive control (catches: unknown treated as a conflict and BACK-2 reserved; the retry inside
				// the attempt counted as a second candidate).
				// adapted from claim-cli.test.ts:1328-1340 (unk-01 view; two sends here)
				expect({
					view: nextView(lost),
					refs: await fixture.claimTickets(),
					records: await fixture.recordNames(k),
				}).toEqual({
					view: nextOf("unknown", {
						ticket: "BACK-1",
						operationId: "generated",
						candidates: PAIR,
						attempts: [
							tried(
								"BACK-1",
								view({
									status: "unknown",
									command: "acquire",
									action: "acquire",
									outcome: "unknown",
									storage: queriedStorage("unknown", "open"),
									sends: 2,
									stoppedBy: "attempts",
									ownership: "absent",
									operationId: "generated",
								}),
							),
						],
						untried: 1,
						stop: { kind: "attempt" },
					}),
					refs: [],
					records: [`${op1}.json`],
				});
				await fixture.hooks.settle("pre", held);
				await fixture.hooks.settle("pre", held + 1);
				await fixture.hooks.plan("pre", [], "pass");
				// (2), deliberate: op1 is still outstanding at BACK-1's unchanged (absent) root, so the acquisition stop
				// pauses the whole call before any attempt, in both output modes.
				const pushesBefore = await fixture.hooks.count("pre");
				const paused = await fixture.json(nextArgs(k, KARL));
				const pausedPlain = await fixture.plain(nextArgs(k, KARL));
				const pausedPushes = (await fixture.hooks.count("pre")) - pushesBefore;
				const pausedRecords = await fixture.recordNames(k);
				// (3): f is another context with an empty journal.
				const other = await fixture.json(nextArgs(f, FRANZ));
				// (4): f's acquisition moved BACK-1's root on, so op1 is no longer outstanding; BACK-2 has no own intent.
				const after = await fixture.json(nextArgs(k, KARL));
				const op4 = String(field(after.doc, "operationId"));
				// (5) resolve is read-only and never pauses.
				const resolved = await fixture.json(onArgs("resolve", op1, k));
				// catches: a second reservation after unknown in a later call; a stop that never lifts; the stop across
				// contexts; resolve inventing success (resolution/index.ts:129-133).
				expect({
					paused: nextView(paused),
					pausedPlain: plainView(pausedPlain),
					pausedPushes,
					pausedRecords,
					other: nextView(other),
					after: nextView(after),
					records: await fixture.recordNames(k),
					resolved: cliView(resolved),
				}).toEqual({
					paused: nextOf("paused", {
						candidates: PAIR,
						attempts: [],
						untried: 2,
						stop: { kind: "outstanding-acquire", operationIds: [op1] },
					}),
					pausedPlain: plainOf("paused"),
					pausedPushes: 0,
					pausedRecords: [`${op1}.json`],
					other: nextOf("applied", {
						ticket: "BACK-1",
						operationId: "generated",
						candidates: PAIR,
						attempts: [tried("BACK-1", applied("acquire", "held"))],
						untried: 1,
						stop: { kind: "claimed" },
					}),
					after: nextOf("applied", {
						ticket: "BACK-2",
						operationId: "generated",
						candidates: PAIR,
						attempts: [
							tried("BACK-1", planRejected("acquire", "not-free", "foreign")),
							tried("BACK-2", applied("acquire", "held")),
						],
						untried: 0,
						stop: { kind: "claimed" },
					}),
					records: [`${op1}.json`, `${op4}.json`].sort(byCodeUnits),
					// adapted from claim-cli.test.ts:1423 (rsm-03: a foreign writer landed first)
					resolved: resolvedView("rejected", "rejected", "not-stored", "acquire", "generated"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim next race over real Git (${format})`, () => {
		test(
			`e-nxt-05 (${format}): parallel calls leave exactly one holder per ticket and never over-reserve`,
			async () => {
				const block: BlockChange = (base) => ({ ...base, timeoutMs: RACE_TIMEOUT });
				await withCase(format, "race", { tickets: PAIR_TICKETS, block }, async (fixture) => {
					const racers: { owner: string; handle: ContextHandle }[] = [];
					for (const owner of OWNERS) racers.push({ owner, handle: await fixture.context() });
					// Three contexts with empty journals start at once.
					const race: Raced[] = await Promise.all(
						racers.map(async (racer) => ({ ...racer, run: await fixture.json(nextArgs(racer.handle, racer.owner)) })),
					);
					const raced = await fixture.json(["claim", "list"]);
					const winners = race
						.filter((entry) => shapeOf(entry.run, RACE_ISOLATED) === "claimed")
						.map((entry) => ({ ticket: String(field(entry.run.doc, "ticket")), owner: entry.owner }));
					const won = winners.map((winner) => winner.ticket).sort(byCodeUnits);
					// Positive control (catches: a double winner per format; a loser applied, unknown or paused; one call
					// holding two tickets; a server ref or list entry without a winning call). A true push race may end
					// the loser `stopped-remote` (storage/index.ts:631-633 row storage remote) [?1].
					expect({
						schema: race.flatMap((entry) => schemaProblems(entry.run.doc)),
						unexpected: race
							.map((entry) => shapeOf(entry.run, RACE_ISOLATED))
							.filter((shape) => !RACE_SHAPES.includes(shape)),
						someWinner: winners.length > 0,
						duplicate: new Set(won).size !== won.length,
						refs: await fixture.claimTickets(),
						listed: entriesOf(raced),
					}).toEqual({
						schema: [],
						unexpected: [],
						someWinner: true,
						duplicate: false,
						refs: won,
						listed: winners
							.map((winner) => activeEntry(winner.ticket, winner.owner))
							.sort((left, right) => byCodeUnits(String(left.ticket), String(right.ticket))),
					});
					const followUps: JsonRun[] = [];
					for (const racer of racers) {
						// Every intent of this context from the race either landed (root moved on) or was rejected on a
						// ticket whose root the winner moved on (stale, remote); none is outstanding. Plan rejections record
						// nothing.
						followUps.push(await fixture.json(nextArgs(racer.handle, racer.owner)));
					}
					const final = await fixture.json(["claim", "list"]);
					const claimedLater = followUps.filter((run) => shapeOf(run, FOLLOW_ISOLATED) === "claimed").length;
					// catches: a follow-up paused by a race intent that already lost; a second holder; a free ticket left
					// behind although a context could take it; `held` stopping the search.
					expect({
						schema: followUps.flatMap((run) => schemaProblems(run.doc)),
						unexpected: followUps
							.map((run) => shapeOf(run, FOLLOW_ISOLATED))
							.filter((shape) => !FOLLOW_SHAPES.includes(shape)),
						acquired: winners.length + claimedLater,
						refs: await fixture.claimTickets(),
						listed: (entriesOf(final) ?? []).map((entry) => entry.ticket),
					}).toEqual({ schema: [], unexpected: [], acquired: 2, refs: [...PAIR], listed: [...PAIR] });
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);
	});
}

describe("claim next inputs and documentation (blob)", () => {
	test(
		"e-nxt-07: input errors are claim-error JSON before the network, usage errors are text, help and guide",
		async () => {
			const proxy = await StallProxy.create();
			try {
				// adapted from claim-cli.test.ts:1621-1626 (the stalled endpoint counts every connection)
				const stalled = `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
				const setup: CaseSetup = {
					descriptor: false,
					tickets: [{ id: "BACK-1", createdDate: "2026-09-01" }],
					block: (base) => ({ ...base, endpoint: stalled, timeoutMs: STALL_TIMEOUT }),
				};
				await withCase("blob", "inputs", setup, async (fixture) => {
					const a = await fixture.context();
					const reached = await fixture.json(nextArgs(a, KARL));
					// Positive control (catches: no claim next; a selection that never reaches the preflight; a counter that
					// counts nothing). Order: selection, then preflight, which meets the stall.
					expect({ view: cliView(reached), connected: proxy.acceptedConnections > 0 }).toEqual({
						view: failed("next", "unavailable", "unreachable"),
						connected: true,
					});
					const before = proxy.acceptedConnections;
					const hardEnd = new Date(Date.now() + 60 * MINUTE).toISOString().replace("Z", "");
					const rows: LocalRow[] = [
						{
							label: "bound 0",
							catches: "no lower limit",
							args: nextArgs(a, KARL, "--max-candidates", "0"),
							code: "invalid-option",
						},
						{
							label: "bound 51",
							catches: "no upper limit",
							args: nextArgs(a, KARL, "--max-candidates", String(MAX_MAX_CANDIDATES + 1)),
							code: "invalid-option",
						},
						{
							label: "bound 2.5",
							catches: "a fractional bound truncated (claim.ts:97-100)",
							args: nextArgs(a, KARL, "--max-candidates", "2.5"),
							code: "invalid-option",
						},
						{
							label: "order newest",
							catches: "an unknown order silently read as priority",
							args: nextArgs(a, KARL, "--order", "newest"),
							code: "invalid-option",
						},
						{
							label: "no owner",
							catches: "an owner derived from the assignee or the configuration",
							args: ["claim", "next", "--context", a.directory],
							code: "owner-required",
						},
						{
							label: "no context",
							catches: "a default or derived context",
							args: ["claim", "next", "--owner", KARL],
							code: "context-required",
						},
						{
							label: "relative context",
							catches: "a repaired relative handle",
							args: ["claim", "next", "--owner", KARL, "--context", "contexts/relative"],
							code: "context-invalid",
						},
						{
							label: "zero TTL",
							catches: "a non-positive TTL passed on to the attempts",
							args: nextArgs(a, KARL, "--ttl-ms", "0"),
							code: "invalid-option",
						},
						{
							label: "hard end without zone",
							catches: "a hard end parsed as local time",
							args: nextArgs(a, KARL, "--hard-end", hardEnd),
							code: "invalid-option",
						},
						{
							label: "unknown priority",
							catches: "the task list text instead of a claim-error",
							args: nextArgs(a, KARL, "--priority", "urgent"),
							code: "invalid-option",
						},
						{
							label: "assignee with unassigned",
							catches: "the contradictory pair silently reduced to one filter",
							args: nextArgs(a, KARL, "--assignee", "x", "--unassigned"),
							code: "invalid-option",
						},
						{
							label: "unknown type",
							catches: "an unknown type matching nothing instead of refusing",
							args: nextArgs(a, KARL, "--type", "nosuchtype"),
							code: "invalid-option",
						},
						{
							label: "unknown excluded status",
							catches: "--exclude-status not validated as in task list",
							args: nextArgs(a, KARL, "--exclude-status", "Nope"),
							code: "invalid-option",
						},
						{
							label: "project without configured projects",
							catches: "the no-projects text (with the config path) in the claim output",
							args: nextArgs(a, KARL, "--project", "web"),
							code: "invalid-option",
						},
						{
							label: "blank parent",
							catches: "a blank parent widened to every task",
							args: nextArgs(a, KARL, "--parent", ""),
							code: "invalid-option",
						},
					];
					const runs: JsonRun[] = [];
					// No row reaches the executor; a is never recorded.
					for (const row of rows) runs.push(await fixture.json(row.args));
					// None of the following calls reaches the executor. No ticket is Done: an empty selection ends
					// without network; Commander and the output mode refuse before any work (claim.ts:164-176).
					const empty = await fixture.json(nextArgs(a, KARL, "--status", "Done"));
					const operationId = await fixture.raw([...nextArgs(a, KARL), "--operation-id", "op-x"]);
					const both = await fixture.raw([...nextArgs(a, KARL), "--json", "--plain"]);
					// catches: a check after the preflight (a connection); the task list text in the claim JSON; --operation-id
					// accepted; output-mode conflicts reaching the network.
					expect({
						rows: runs.map((run, index) => ({
							label: rows[index]?.label ?? "(no row)",
							view: cliView(run),
							stderr: run.stderr,
							foreign: TASK_LIST_TEXTS.filter((text) => run.stdout.includes(text)),
						})),
						empty: nextView(empty),
						operationId: [
							operationId.exit,
							`${operationId.stdout}${operationId.stderr}`.includes("unknown option '--operation-id'"),
						],
						both: [both.exit, both.stderr.includes("--json cannot be combined with --plain.")],
						connections: proxy.acceptedConnections - before,
						records: await fixture.recordNames(a),
					}).toEqual({
						rows: rows.map((row) => ({
							label: row.label,
							view: failed("next", "refused", row.code),
							stderr: "",
							foreign: [],
						})),
						empty: nextOf("rejected", { candidates: [], attempts: [], untried: 0, stop: { kind: "no-candidates" } }),
						operationId: [1, true],
						both: [1, true],
						connections: 0,
						records: [],
					});
					const group = await runCli(fixture.root, ["claim", "--help"]);
					const help = await helpView(fixture.root, "next", "claim-next");
					const guide = await runCli(fixture.root, ["instructions", "claims"]);
					const guideText = guide.stdout.toLowerCase();
					// catches: next missing from the group help; no help schema (cli-guidance); the guide without the
					// command, the document kind, the policy key or the three codes.
					expect({
						listed: /^\s+next\b/m.test(group.stdout + group.stderr),
						help,
						guide: guide.exit,
						missingTerms: GUIDE_TERMS.filter((term) => !guideText.includes(term.toLowerCase())),
					}).toEqual({ listed: true, help: documented("next"), guide: 0, missingTerms: [] });
					expect(await fixture.leaks()).toEqual([]);
				});
			} finally {
				await proxy.close();
			}
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"e-nxt-08: the guide says directly under the continue/stop table that a refused write is read again",
		async () => {
			const setup: CaseSetup = { descriptor: false, tickets: [{ id: "BACK-1", createdDate: "2026-09-01" }] };
			await withCase("blob", "guide", setup, async (fixture) => {
				const guide = await runCli(fixture.root, ["instructions", "claims"]);
				const lines = guide.stdout.split("\n");
				const header = lines.indexOf("| attempt | then |");
				let last = header;
				while (header >= 0 && lines[last + 1]?.startsWith("|")) last++;
				let next = last + 1;
				while (next < lines.length && lines[next]?.trim() === "") next++;
				const paragraph: string[] = [];
				while (next < lines.length && lines[next]?.trim()) paragraph.push(lines[next++] ?? "");
				const first = paragraph.join(" ").replace(/\s+/g, " ").trim();
				// Positive control (catches: no guide, the continue/stop table of `claim next` renamed or without rows).
				expect({ exit: guide.exit, header: header >= 0, rows: last - header - 1 > 0 }).toEqual({
					exit: 0,
					header: true,
					rows: true,
				});
				// (catches: the sentence missing, reworded or placed elsewhere): the first
				// paragraph after the table starts with it, whitespace normalized.
				expect(first.slice(0, REREAD_SENTENCE.length)).toBe(REREAD_SENTENCE);
			});
		},
		TEST_TIMEOUT,
	);
});
