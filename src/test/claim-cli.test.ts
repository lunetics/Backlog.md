/**
 * End-to-end contract of the canonical claim CLI: the real `backlog claim …` subprocess in a real Backlog project
 * against the loopback Git daemon for blob, tree and commit-chain, with scripted receive hooks (S1, test-local), the
 * StallProxy connection counter and private contexts created through the context API. Every JSON document is checked
 * against a test-local validator of the documented schema (doc-04); every stdout and stderr is collected per case and
 * scanned for bindings, secrets, context IDs and paths, endpoints, server roots, journal digests and hook stderr
 * (out-01). Cases that end before the network run with blob only. Every test starts with a positive control that the
 * non-functional scaffold cannot satisfy. Points the CLI contract decides are asserted exactly; the few it leaves open
 * stay marked ASSUMPTION. Setup, init and context create live in the last describe block. The level-G and level-X
 * cases live in claim-surface-git.test.ts and claim-execution-retry.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
import { GitFixtureServer, type ReceivePhase, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

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
type CaseSetup = { descriptor?: boolean; block?: Partial<BlockOptions> | null };
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
type HelpView = { command: string; exit: number; missing: string[]; kind: boolean; json: boolean };
type Shape = { required: readonly string[]; optional: readonly string[] };
type LocalRow = { label: string; catches: string; args: string[]; code: string };
type ConfigRow = LocalRow & { block: Partial<BlockOptions> };

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms of healthy cases, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of lost-reply cases; every scripted hold outlasts it (LOSS_TIMEOUT). */
const LOSS_TIMEOUT = 2_000;
/** attempt_timeout_ms of cases that must contact the stalled endpoint (claim-rights-query.test.ts:31). */
const STALL_TIMEOUT = 750;
/** Bound for one stalled contact beyond a local-only baseline; below the storage default of 3000 ms (pf-06). */
const OVERDUE_MS = 2_500;
/** bud-03: budget 5000 ms plus at most one attempt_timeout_ms overrun plus process start [?]. */
const BUDGET_BOUND_MS = 10_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context and endpoint paths and in hook stderr; no output may contain it. */
const SENTINEL = "SENTINEL-cli-4a2f";
/** Display name shared by every context (out-04); it may appear only in list entries. */
const OWNER = "agent-owner-karl";
/** out-07: an owner written by an independent writer with a terminal escape sequence. */
const ESC_OWNER = "agent-\u001b[31m-owner";
const OTHER_BINDING = `tb1-${"6f".repeat(32)}`;
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const THIRD = "BACK-3";
const MISSING = "BACK-99";
const TICKETS = [TICKET, SECOND, THIRD];
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
const ANY_ID = /op-[0-9a-f-]{36}/;
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
/** The twelve keys a lease-mode template of `claim setup` writes, in schema order. */
const TEMPLATE_KEYS = [
	"enabled",
	"endpoint",
	"storage_format",
	"lifetime_mode",
	"lease_ttl_ms",
	"reclaim_grace_ms",
	"attempt_timeout_ms",
	"attempts",
	"operation_budget_ms",
	"clock_uncertainty_ms",
	"retry_pause_base_ms",
	"retry_pause_max_ms",
];
const CORE_HELP = [
	["acquire", "claim-operation"],
	["renew", "claim-operation"],
	["release", "claim-operation"],
	["reclaim", "claim-operation"],
	["resolve", "claim-resolution"],
	["retry", "claim-operation"],
	["list", "claim-list"],
] as const;
const ADMIN_HELP = [
	["setup", "claim-setup"],
	["init", "claim-init"],
	["context create", "claim-context"],
] as const;

// doc-04: the documented schema, independent of the module under test.
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
		].concat(["rights"]),
		optional: [],
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
const COMMANDS: readonly unknown[] = "acquire renew release reclaim resolve retry list setup init context-create".split(
	" ",
);
const ACTIONS: readonly unknown[] = ["acquire", "renew", "release", "reclaim"];
const OUTCOMES: readonly unknown[] = ["applied", "rejected", "unknown", "unknown-history", "not-sent"];
const RESOLUTIONS: readonly unknown[] = "stored not-stored open conflict unknown unknown-history invalid".split(" ");
const OUTER_QUERIES: readonly unknown[] =
	"record-absent record-corrupt invalid unavailable unknown unknown-history unsupported".split(" ");
const RIGHTS_FAILURES: readonly unknown[] = ["unknown", "corrupt", "unsupported", "invalid", "unavailable"];
const STOPS: readonly unknown[] = [null, "attempts", "budget"];
/** The closed v1 code list without own-operation-open, setup and init codes included. */
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
`
	.trim()
	.split(/\s+/);

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

// adapted from claim-execution.test.ts:250
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-execution.test.ts:271
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

// adapted from claim-execution.test.ts:475
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-execution.test.ts:484
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-execution.test.ts:295
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-execution.test.ts:306 (claim-git-fixture.ts:20 is not exported)
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-execution.test.ts:315
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(server().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from cli-json-output.test.ts:13
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

function commandOf(args: readonly string[]): string {
	if (args[0] !== "claim") return args[0] ?? "";
	return args[1] === "context" ? "context-create" : (args[1] ?? "");
}

function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/** Owner names are display data in list entries only; the collector drops them there before scanning. */
function withoutOwners(doc: unknown): unknown {
	const claims = field(doc, "claims");
	if (!Array.isArray(claims) || !isRecord(doc)) return doc;
	const stripped = claims.map((item: unknown) =>
		isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "owner")) : item,
	);
	return { ...doc, claims: stripped };
}

/** Labels of the sentinels that occur in `text`. */
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

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
				// "earlier-process" is the value of a clarification before a resend.
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

/** The capped-lease display comes from onPlanned as `planned`. */
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

function problemsOk(value: unknown): boolean {
	return Array.isArray(value) && value.every((problem) => exact(problem, ["key", "problem"]));
}

/** An outstanding pause names own operation IDs, an unknown pause carries nothing else. */
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

function applied(command: string, ownership: string, fields: ViewFields = {}): CliView {
	const storage = { kind: "applied" };
	const base = { command, action: command, outcome: "applied", storage, sends: 1, ownership };
	return view({ status: "applied", ...base, operationId: "generated", ...fields });
}

/** Plan rejections persist nothing, so no operation ID is printed. */
function planRejected(command: string, cause: string, ownership: string, boundary?: number): CliView {
	const rejection = boundary === undefined ? { stage: "plan", cause } : { stage: "plan", cause, boundary };
	return view({ status: "rejected", command, action: command, outcome: "rejected", rejection, sends: 0, ownership });
}

function failed(command: string, status: Status, code: string, fields: ViewFields = {}): CliView {
	return view({ status, command, kind: "claim-error", code, ...fields });
}

function queriedStorage(after: string, resolution: string): Record<string, unknown> {
	return { kind: "queried", after, query: { kind: "resolved", resolution } };
}

function resolvedView(status: Status, outcome: string, resolution: string, action: string, id: string): CliView {
	const query = { kind: "resolved", resolution };
	return view({ status, command: "resolve", kind: "claim-resolution", action, outcome, query, operationId: id });
}

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

function listed(claims: EntryView[]): ListView {
	return { exit: 0, schema: [], kind: "claim-list", status: "ok", complete: true, claims };
}

function entry(
	ticket: string,
	state: string,
	claimGeneration: number,
	ownership: string | null,
	owner: string | null = state === "active" ? OWNER : null,
): EntryView {
	return { ticket, state, owner, claimGeneration, ownership };
}

/** cli-05: the first token of the human output is the status; the stream follows. */
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

function plainOf(status: Status, codeShown: boolean | null = null): PlainView {
	return {
		exit: EXIT[status],
		stream: STDERR_STATUSES.includes(status) ? "stderr" : "stdout",
		head: status,
		codeShown,
	};
}

function pick(run: JsonRun, keys: readonly string[]): Record<string, unknown> {
	const picked = Object.fromEntries(keys.map((key) => [key, field(run.doc, key) ?? null]));
	return { exit: run.exit, schema: schemaProblems(run.doc), ...picked };
}

/** The planned lease end from the `planned` display. */
function plannedLeaseEnd(doc: unknown): number {
	const leaseEnd = field(field(field(doc, "planned"), "timing"), "leaseEnd");
	if (typeof leaseEnd !== "number") throw new Error("the document names no planned lease end");
	return leaseEnd;
}

/** Statuses whose exit code row is missing: no line carries the status and its code as separate tokens. */
function missingExitRows(text: string): string[] {
	const lines = text.split("\n").map((line) => line.split(/[^\w-]+/));
	return Object.entries(EXIT)
		.filter(([status, code]) => !lines.some((tokens) => tokens.includes(status) && tokens.includes(String(code))))
		.map(([status]) => status);
}

async function helpView(cwd: string, command: string, kind: string): Promise<HelpView> {
	const run = await runCli(cwd, ["claim", ...command.split(" "), "--help"]);
	const text = run.stdout + run.stderr;
	const missing = ["Input schema:", "Output:", "Examples:"].filter((section) => !text.includes(section));
	return { command, exit: run.exit, missing, kind: text.includes(kind), json: text.includes("--json") };
}

function documented(command: string): HelpView {
	return { command, exit: 0, missing: [], kind: true, json: true };
}

function acquireArgs(ticket: string, handle: ContextHandle, ...extra: string[]): string[] {
	return ["claim", "acquire", ticket, "--owner", OWNER, "--context", handle.directory, ...extra];
}

function onArgs(verb: string, target: string, handle: ContextHandle, ...extra: string[]): string[] {
	return ["claim", verb, target, "--context", handle.directory, ...extra];
}

/** ASSUMPTION(CLI): setup takes the endpoint, the storage format and eps; everything else is template. */
function setupArgs(endpoint: string, format: string): string[] {
	return ["claim", "setup", "--endpoint", endpoint, "--storage-format", format, "--clock-uncertainty-ms", String(EPS)];
}

function foreignState(owner: string, leaseEnd: number): JsonObject {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 1,
		bindingGeneration: 1,
		owner,
		binding: OTHER_BINDING,
		timing: { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd: null },
	};
}

/** The three surface keys join the nine configuration keys. */
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

// adapted from claim-execution.test.ts:1102 (ExecutionCase.initClient)
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the given tickets, the claims block and one committed repository. */
async function initProject(
	directory: string,
	tickets: readonly string[],
	block: string | undefined,
): Promise<Map<string, string>> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	const files = new Map<string, string>();
	for (const ticket of tickets) {
		const task = {
			id: ticket,
			title: `Claim target ${ticket}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-26",
			rawContent: "",
		};
		files.set(ticket, await core.filesystem.saveTask(task));
	}
	// The CLI migrates the configuration before each command; migrating here keeps the rel-01 snapshot stable.
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
	return files;
}

// adapted from claim-execution.test.ts:1139 (ExecutionCase.secretOf)
async function secretOf(handle: ContextHandle): Promise<string> {
	const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	if (typeof secret !== "string") throw new Error("the private record has no string secret");
	return secret;
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-execution.test.ts:918 (a reject also writes the sentinel to stderr, out-03)
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
// adapted from claim-execution.test.ts:949 (ReceiveScript)
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
		private readonly taskFiles: Map<string, string>,
		options: BlockOptions,
	) {
		this.options = options;
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	/** `descriptor: false` leaves the area uninitialized; `block: null` writes no claims block. */
	static async create(format: ClaimStorageFormat, caseName: string, setup: CaseSetup): Promise<CliCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-cli-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `cli-${SENTINEL}-${format}-${caseName}`);
			const url = server().url(name);
			const options: BlockOptions = { ...defaultBlock(url, format), ...(setup.block ?? {}) };
			const project = join(root, `project-${SENTINEL}`);
			const files = await initProject(project, TICKETS, setup.block === null ? undefined : claimsBlock(options));
			const fixture = new CliCase(format, root, url, repo, project, files, options);
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

	/** A second area on the same daemon, initialized with the case format or left without a descriptor. */
	async otherArea(initialized: boolean): Promise<string> {
		const { name } = await server().initRepository(this.root, `cli-${SENTINEL}-${this.format}-other`);
		const url = server().url(name);
		if (initialized) await this.initialize(url);
		return url;
	}

	/** Another project with the current claims block plus `changes` and only the tickets `tickets`. */
	async extraProject(tickets: readonly string[], changes: Partial<BlockOptions> = {}): Promise<string> {
		this.directories += 1;
		const directory = join(this.root, `project-${SENTINEL}-${this.directories}`);
		await initProject(directory, tickets, claimsBlock({ ...this.options, ...changes }));
		return directory;
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

	taskFile(ticket: string): string {
		const file = this.taskFiles.get(ticket);
		if (file === undefined) throw new Error(`no task file for ${ticket}`);
		return resolve(this.project, file);
	}

	// adapted from claim-execution.test.ts:1128 (ExecutionCase.context)
	async context(): Promise<ContextHandle> {
		const context = expectKind(await createClaimContext({ parent: this.parent }), "created").context;
		return this.remember({ context, directory: dirname(context.journalDirectory) });
	}

	/** Registers a context the CLI created, so its binding, secret and path join the leak scan. */
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
		this.outputs.push({ command: commandOf(args), text: stdout + run.stderr, ownerAllowed: false });
		return { ...run, doc };
	}

	/** One human-mode call; the owner may appear only in list output. */
	async plain(args: readonly string[], cwd = this.project): Promise<CliRun> {
		const run = await this.execute([...args, "--plain"], cwd);
		const command = commandOf(args);
		this.outputs.push({ command, text: run.stdout + run.stderr, ownerAllowed: command === "list" });
		return run;
	}

	/** A call with exactly `args`, for Commander usage errors. */
	async raw(args: readonly string[], cwd = this.project): Promise<CliRun> {
		const run = await this.execute(args, cwd);
		this.outputs.push({ command: commandOf(args), text: run.stdout + run.stderr, ownerAllowed: false });
		return run;
	}

	/**
	 * out-01: labels of every sentinel in the collected output. The owner is allowed in human list output only, a
	 * context ID only in the output of `context create`. Roots are never printed.
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
			sentinels.push([`${label} binding`, handle.context.binding], [`${label} path`, handle.directory]);
			sentinels.push([`${label} secret`, await secretOf(handle)]);
			for (const record of await this.records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			if (!output.ownerAllowed && output.text.includes(OWNER)) labels.push("owner");
			if (output.command !== "context-create") {
				for (const [index, handle] of this.handles.entries()) {
					if (output.text.includes(handle.context.contextId)) labels.push(`context ${index + 1} id`);
				}
			}
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	/** Journal records of one context; temporary `.intent-*.tmp` names are ignored (journal/index.ts:276). */
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

	async deleteServerRef(ref: string): Promise<void> {
		await server().git(this.serverRepo, ["update-ref", "-d", ref]);
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

	/** Receipts stored for `ticket`, read through an independent client. */
	async receipts(ticket: string): Promise<Record<string, JsonObject>> {
		const observed = await (await this.store("reader")).read(ticket);
		return observed.kind === "present" ? observed.document.receipts : {};
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

	/** rel-01: bytes of the backlog tree, HEAD, index and porcelain status of the project repository. */
	async snapshot(): Promise<Snapshot> {
		const files: Record<string, string> = {};
		const visit = async (directory: string): Promise<void> => {
			const items = await readdir(directory, { withFileTypes: true });
			for (const item of items.sort((left, right) => byCodeUnits(left.name, right.name))) {
				const path = join(directory, item.name);
				if (item.isDirectory()) await visit(path);
				else files[relative(this.project, path)] = sha256Hex(await readFile(path));
			}
		};
		await visit(join(this.project, "backlog"));
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
	describe(`claim CLI over real Git (${format})`, () => {
		test(
			"cli-01 cli-02 id-01 out-01 out-04: acquire, list, renew, resolve and release",
			async () => {
				await withCase(format, "lifecycle", {}, async (fixture) => {
					// Scanner positive control (out-01): a planted sentinel is found.
					expect(echoedIn(`planted ${SENTINEL}`, [["sentinel", SENTINEL]])).toEqual(["sentinel"]);
					const a = await fixture.context();
					const b = await fixture.context();
					const first = await fixture.json(acquireArgs(TICKET, a));
					// Positive control (catches: missing wiring, the wrong preflight purpose, no operation ID).
					expect(cliView(first)).toEqual(applied("acquire", "held"));
					const firstId = String(field(first.doc, "operationId"));
					// id-01: the human mode prints the generated ID too; IDs differ and name the journal records.
					const second = await fixture.plain(acquireArgs(SECOND, a));
					const secondId = ANY_ID.exec(second.stdout)?.[0] ?? "";
					expect({
						plain: plainView(second),
						distinct: GENERATED_ID.test(secondId) && secondId !== firstId,
						records: await fixture.recordNames(a),
					}).toEqual({
						plain: plainOf("applied"),
						distinct: true,
						records: [`${firstId}.json`, `${secondId}.json`].sort(byCodeUnits),
					});
					// cli-02, out-04: B with the same owner name is not the holder and prepares no intent.
					const own = await fixture.json(["claim", "list", "--context", a.directory]);
					const foreign = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", b.directory]);
					const taken = await fixture.json(acquireArgs(TICKET, b));
					expect({
						own: listView(own),
						foreign: listView(foreign),
						taken: cliView(taken),
						journalB: await fixture.recordNames(b),
					}).toEqual({
						own: listed([entry(TICKET, "active", 1, "held"), entry(SECOND, "active", 1, "held")]),
						foreign: listed([entry(TICKET, "active", 1, "foreign")]),
						taken: planRejected("acquire", "not-free", "foreign"),
						journalB: [],
					});
					const renewed = await fixture.json(onArgs("renew", TICKET, a));
					const resolved = await fixture.json(onArgs("resolve", firstId, a));
					const released = await fixture.json(onArgs("release", TICKET, a));
					const after = await fixture.json(["claim", "list", "--context", a.directory]);
					const afterPlain = await fixture.plain(["claim", "list", "--context", a.directory]);
					expect({
						renewed: cliView(renewed),
						resolved: cliView(resolved),
						released: cliView(released),
						after: listView(after),
						afterPlain: plainView(afterPlain),
					}).toEqual({
						renewed: applied("renew", "held"),
						resolved: resolvedView("applied", "applied", "stored", "acquire", "generated"),
						released: applied("release", "free"),
						after: listed([entry(TICKET, "free", 1, "free"), entry(SECOND, "active", 1, "held")]),
						afterPlain: plainOf("ok"),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"cli-02 cli-03 out-03 out-04: plan rejections carry no ID; a remote reject stays a storage rejection",
			async () => {
				await withCase(format, "rejections", {}, async (fixture) => {
					const a = await fixture.context();
					const b = await fixture.context();
					const acquired = await fixture.json(acquireArgs(TICKET, a));
					// Positive control (catches: missing wiring).
					expect(cliView(acquired)).toEqual(applied("acquire", "held"));
					const boundary = plannedLeaseEnd(acquired.doc) + GRACE;
					const renewed = await fixture.json(onArgs("renew", TICKET, b));
					const released = await fixture.json(onArgs("release", TICKET, b));
					const early = await fixture.json(onArgs("reclaim", TICKET, b));
					expect({
						renewed: cliView(renewed),
						released: cliView(released),
						early: cliView(early),
						journalB: await fixture.recordNames(b),
					}).toEqual({
						renewed: planRejected("renew", "not-holder", "foreign"),
						released: planRejected("release", "not-holder", "foreign"),
						early: planRejected("reclaim", "not-yet", "foreign", boundary),
						journalB: [],
					});
					// cli-03 (remote half), out-03: the hook rejects and writes the sentinel to stderr; no retry follows.
					await fixture.hooks.plan("pre", ["reject", "reject"]);
					const remote = await fixture.json(acquireArgs(SECOND, a));
					const remotePlain = await fixture.plain(acquireArgs(THIRD, a));
					expect({ remote: cliView(remote), plain: plainView(remotePlain) }).toEqual({
						remote: view({
							status: "rejected",
							command: "acquire",
							action: "acquire",
							outcome: "rejected",
							rejection: { stage: "storage", cause: "remote" },
							storage: { kind: "rejected", cause: "remote" },
							sends: 1,
							ownership: "absent",
							operationId: "generated",
						}),
						plain: plainOf("rejected"),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"unk-01 pau-01 unk-03 rsm-01 rsm-02 rsm-03: lost replies, pause, resolve and retry across processes",
			async () => {
				const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
				await withCase(format, "loss", { block }, async (fixture) => {
					const a = await fixture.context();
					// unk-01: the pre-receive hook holds past the timeout and then rejects; one attempt.
					const held = await fixture.hooks.next("pre");
					await fixture.hooks.plan("pre", ["hold-reject"]);
					const lost = await fixture.json(acquireArgs(TICKET, a, "--operation-id", "op-unk-01"));
					// Positive control (catches: a timeout reported as rejected, applied or free).
					expect(cliView(lost)).toEqual(
						view({
							status: "unknown",
							command: "acquire",
							action: "acquire",
							outcome: "unknown",
							storage: queriedStorage("unknown", "open"),
							sends: 1,
							stoppedBy: "attempts",
							ownership: "absent",
							operationId: "op-unk-01",
						}),
					);
					await fixture.hooks.settle("pre", held);
					const open = await fixture.json(onArgs("resolve", "op-unk-01", a));
					const openPlain = await fixture.plain(onArgs("resolve", "op-unk-01", a));
					// Deviation from unk-01: the rejected push leaves the root unchanged, so the intent stays
					// open (resolution/index.ts:128) and resolve reports unknown/3 instead of rejected/2.
					expect({ json: cliView(open), plain: plainView(openPlain) }).toEqual({
						json: resolvedView("unknown", "unknown", "open", "acquire", "op-unk-01"),
						plain: plainOf("unknown"),
					});
					// pau-01: the open acquire pauses a second acquire of the same ticket before any plan,
					// record or send; resolve above ran against the same open intent without pausing.
					const beforePause = await fixture.hooks.count("pre");
					const pausedRun = await fixture.json(acquireArgs(TICKET, a));
					const pausedPlain = await fixture.plain(acquireArgs(TICKET, a));
					const pauseKeys = ["kind", "status", "command", "action", "ticket", "operationId", "pause"];
					const pausedView: Record<string, unknown> = {
						...pick(pausedRun, pauseKeys),
						ownership: field(field(pausedRun.doc, "rights"), "ownership"),
					};
					expect({
						json: pausedView,
						plain: plainView(pausedPlain),
						pushes: (await fixture.hooks.count("pre")) - beforePause,
						records: await fixture.recordNames(a),
					}).toEqual({
						json: {
							exit: 7,
							schema: [],
							kind: "claim-pause",
							status: "paused",
							command: "acquire",
							action: "acquire",
							ticket: TICKET,
							operationId: null,
							pause: { kind: "outstanding", operationIds: ["op-unk-01"] },
							ownership: "absent",
						},
						plain: plainOf("paused"),
						pushes: 0,
						records: ["op-unk-01.json"],
					});
					// rsm-01: `claim retry` resends the frozen change from a new process and never pauses.
					await fixture.hooks.plan("pre", [], "pass");
					const retried = await fixture.json(onArgs("retry", "op-unk-01", a));
					const pushes = await fixture.hooks.lines("pre", held - 1);
					const [record] = await fixture.records(a);
					const reference = record && {
						schema: 1,
						intentDigest: record.digest,
						parameterDigest: record.parameterDigest,
					};
					expect({
						view: cliView(retried),
						pushes: pushes.length,
						identical: JSON.stringify(pushes[0]) === JSON.stringify(pushes[1]),
						records: await fixture.recordNames(a),
						receipt: (await fixture.receipts(TICKET))["op-unk-01"],
					}).toEqual({
						view: applied("retry", "held", { action: "acquire", operationId: "op-unk-01" }),
						pushes: 2,
						identical: true,
						records: ["op-unk-01.json"],
						receipt: reference,
					});
					// rsm-03: a foreign writer lands first; the retry resolves not-stored and sends nothing.
					const heldSecond = await fixture.hooks.next("pre");
					await fixture.hooks.plan("pre", ["hold-reject"]);
					const second = await fixture.json(acquireArgs(SECOND, a, "--operation-id", "op-rsm-03"));
					await fixture.hooks.settle("pre", heldSecond);
					await fixture.hooks.plan("pre", [], "pass");
					await fixture.writeState(SECOND, foreignState("agent-writer", Date.now() + 60 * MINUTE));
					const resolvedSecond = await fixture.json(onArgs("resolve", "op-rsm-03", a));
					const beforeRetry = await fixture.hooks.count("pre");
					const refused = await fixture.json(onArgs("retry", "op-rsm-03", a));
					// A clarification before any resend reports after "earlier-process".
					expect({
						lost: cliView(second).status,
						resolved: cliView(resolvedSecond),
						retried: cliView(refused),
						pushes: (await fixture.hooks.count("pre")) - beforeRetry,
					}).toEqual({
						lost: "unknown",
						resolved: resolvedView("rejected", "rejected", "not-stored", "acquire", "op-rsm-03"),
						retried: view({
							status: "rejected",
							command: "retry",
							action: "acquire",
							outcome: "rejected",
							rejection: { stage: "resolution", cause: "not-stored" },
							storage: queriedStorage("earlier-process", "not-stored"),
							sends: 0,
							ownership: "foreign",
							operationId: "op-rsm-03",
						}),
						pushes: 0,
					});
					// unk-03, rsm-02: the change lands, post-receive holds past the timeout; the query proves it.
					const heldPost = await fixture.hooks.next("post");
					await fixture.hooks.plan("post", ["hold"]);
					const landed = await fixture.json(acquireArgs(THIRD, a, "--operation-id", "op-unk-03"));
					await fixture.hooks.settle("post", heldPost);
					await fixture.hooks.plan("post", [], "pass");
					const beforeResend = await fixture.hooks.count("pre");
					const again = await fixture.json(onArgs("retry", "op-unk-03", a));
					expect({
						landed: cliView(landed),
						again: cliView(again),
						pushes: (await fixture.hooks.count("pre")) - beforeResend,
					}).toEqual({
						landed: applied("acquire", "held", {
							storage: queriedStorage("unknown", "stored"),
							operationId: "op-unk-03",
						}),
						again: applied("retry", "held", {
							action: "acquire",
							storage: queriedStorage("earlier-process", "stored"),
							sends: 0,
							operationId: "op-unk-03",
						}),
						pushes: 0,
					});
					expect(await fixture.leaks([["foreign binding", OTHER_BINDING]])).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"unk-02 unk-04: a lost release is never free; a vanished ref leaves unknown history",
			async () => {
				const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
				await withCase(format, "history", { block }, async (fixture) => {
					const a = await fixture.context();
					// Positive control (catches: missing wiring).
					expect(cliView(await fixture.json(acquireArgs(TICKET, a)))).toEqual(applied("acquire", "held"));
					const held = await fixture.hooks.next("pre");
					await fixture.hooks.plan("pre", ["hold-reject"]);
					const release = await fixture.json(onArgs("release", TICKET, a, "--operation-id", "op-unk-02"));
					await fixture.hooks.settle("pre", held);
					await fixture.hooks.plan("pre", [], "pass");
					const listing = await fixture.json(["claim", "list", "--ticket", TICKET]);
					// catches: a timed-out release reported as released.
					expect({ release: cliView(release), listing: listView(listing) }).toEqual({
						release: view({
							status: "unknown",
							command: "release",
							action: "release",
							outcome: "unknown",
							storage: queriedStorage("unknown", "open"),
							sends: 1,
							stoppedBy: "attempts",
							ownership: "held",
							operationId: "op-unk-02",
						}),
						listing: listed([entry(TICKET, "active", 1, null)]),
					});
					// unk-04 on SECOND: op-unk-02 stays outstanding at the unchanged TICKET root and pauses it.
					// Positive control (catches: missing wiring on the second ticket).
					expect(cliView(await fixture.json(acquireArgs(SECOND, a)))).toEqual(applied("acquire", "held"));
					// unk-04: renew lands, then the server loses the ticket ref (resolution/index.ts:93-95).
					const renewed = await fixture.json(onArgs("renew", SECOND, a, "--operation-id", "op-unk-04"));
					await fixture.deleteServerRef(`refs/claims/${SECOND}`);
					const history = await fixture.json(onArgs("resolve", "op-unk-04", a));
					const historyPlain = await fixture.plain(onArgs("resolve", "op-unk-04", a));
					expect({
						renewed: cliView(renewed),
						history: cliView(history),
						plain: plainView(historyPlain),
					}).toEqual({
						renewed: applied("renew", "held", { operationId: "op-unk-04" }),
						history: resolvedView("unknown-history", "unknown-history", "unknown-history", "renew", "op-unk-04"),
						plain: plainOf("unknown-history"),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"rel-01: release and list work without the ticket file and never touch the project",
			async () => {
				await withCase(format, "release", {}, async (fixture) => {
					const a = await fixture.context();
					const before = await fixture.snapshot();
					const acquired = await fixture.json(acquireArgs(TICKET, a));
					// Positive control (catches: missing wiring).
					expect(cliView(acquired)).toEqual(applied("acquire", "held"));
					expect(await fixture.snapshot()).toEqual(before);
					await rm(fixture.taskFile(TICKET));
					const removed = await fixture.snapshot();
					const released = await fixture.json(onArgs("release", TICKET, a));
					const listing = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", a.directory]);
					// catches: a required ticket file; assignee or status writes; a commit.
					expect({
						released: cliView(released),
						listing: listView(listing),
						project: await fixture.snapshot(),
					}).toEqual({
						released: applied("release", "free"),
						listing: listed([entry(TICKET, "free", 1, "free")]),
						project: removed,
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim CLI single-format cases (blob)", () => {
	test(
		"cli-04 cli-05 out-02: preflight verdicts are refused or unavailable; list never answers empty",
		async () => {
			await withCase("blob", "verdicts", {}, async (fixture) => {
				const a = await fixture.context();
				const acquire = (ticket: string, handle = a) => fixture.json(acquireArgs(ticket, handle));
				const list = () => fixture.json(["claim", "list"]);
				// Positive control (catches: missing wiring).
				expect(cliView(await acquire(TICKET))).toEqual(applied("acquire", "held"));
				// claims-disabled blocks acquire only; release and list keep working.
				await fixture.writeBlock({ enabled: false });
				const disabled = cliView(await acquire(SECOND));
				const released = cliView(await fixture.json(onArgs("release", TICKET, a)));
				const observed = listView(await list());
				await fixture.writeBlock(null);
				const unconfigured = [cliView(await acquire(SECOND)), cliView(await list())];
				await fixture.writeBlock({ enabled: true, attempts: 0 });
				const invalid = await acquire(SECOND);
				await fixture.writeBlock({ attempts: 3, endpoint: await fixture.otherArea(false) });
				const uninitialized = [cliView(await acquire(SECOND)), cliView(await list())];
				await fixture.writeBlock({ endpoint: fixture.url, format: "tree" });
				const mismatch = await acquire(SECOND);
				// out-02: the path of the unreachable endpoint carries the sentinel (the credential rule refuses userinfo
				// before Git).
				const port = await unusedLoopbackPort();
				const secretEndpoint = `http://127.0.0.1:${port}/${SENTINEL}PATH.git`;
				await fixture.writeBlock({ endpoint: secretEndpoint, format: "blob" });
				const unreachable = [cliView(await acquire(SECOND)), cliView(await list())];
				const human = await fixture.plain(acquireArgs(SECOND, a));
				// The context is loaded before the store is opened, so a corrupt context wins over the endpoint.
				const corrupt = cliView(await acquire(SECOND, await fixture.brokenContext()));
				// The validator in cliView also proves that no refusal carries a `claims` key (doc-04).
				expect({
					disabled,
					released,
					observed,
					unconfigured,
					invalid: cliView(invalid),
					uninitialized,
					mismatch: cliView(mismatch),
					unreachable,
					human: plainView(human, "unreachable"),
					corrupt,
				}).toEqual({
					disabled: failed("acquire", "refused", "claims-disabled"),
					released: applied("release", "free"),
					observed: listed([entry(TICKET, "free", 1, null)]),
					unconfigured: [failed("acquire", "refused", "not-configured"), failed("list", "refused", "not-configured")],
					invalid: failed("acquire", "refused", "config-invalid"),
					uninitialized: [
						failed("acquire", "refused", "descriptor-missing"),
						failed("list", "refused", "descriptor-missing"),
					],
					mismatch: failed("acquire", "refused", "format-mismatch"),
					unreachable: [failed("acquire", "unavailable", "unreachable"), failed("list", "unavailable", "unreachable")],
					human: plainOf("unavailable", true),
					corrupt: failed("acquire", "refused", "context-corrupt"),
				});
				expect({
					problems: field(invalid.doc, "problems"),
					formats: [field(mismatch.doc, "configuredFormat"), field(mismatch.doc, "existingFormat")],
				}).toEqual({ problems: [{ key: "claims.attempts", problem: "out-of-range" }], formats: ["tree", "blob"] });
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"cli-06 rel-03 id-02 cfg5-02 bud-05: input and configuration errors end before the network",
		async () => {
			const proxy = await StallProxy.create();
			try {
				const stalled = `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
				const setup = { descriptor: false, block: { endpoint: stalled, timeoutMs: STALL_TIMEOUT } };
				await withCase("blob", "local", setup, async (fixture) => {
					const nowhere = join(fixture.root, "no-project");
					await mkdir(nowhere);
					// Positive control: a missing project is a JSON error document on stdout.
					const noProject = await fixture.json(["claim", "list"], nowhere);
					expect(cliView(noProject)).toEqual(failed("list", "refused", "project-not-found"));
					const both = await fixture.raw(["claim", "list", "--json", "--plain"]);
					const unknown = await fixture.raw(["claim", "frobnicate"]);
					expect({
						both: [both.exit, both.stderr.includes("--json cannot be combined with --plain.")],
						unknown: [unknown.exit, `${unknown.stdout}${unknown.stderr}`.includes("unknown command 'frobnicate'")],
					}).toEqual({ both: [1, true], unknown: [1, true] });
					const a = await fixture.context();
					const acquire = acquireArgs(TICKET, a);
					const local: LocalRow[] = [
						{
							// Acquire needs a local ticket; the lookup runs before the network.
							label: "missing ticket (rel-03)",
							catches: "a remote claim for a typo ID",
							args: acquireArgs(MISSING, a),
							code: "ticket-not-found",
						},
						{
							label: "no owner",
							catches: "an owner derived from the assignee or the configuration",
							args: ["claim", "acquire", TICKET, "--context", a.directory],
							code: "owner-required",
						},
						{
							// The handle travels only as --context.
							label: "no context",
							catches: "a default or derived context",
							args: ["claim", "acquire", TICKET, "--owner", OWNER],
							code: "context-required",
						},
						{
							label: "relative context",
							catches: "a repaired relative handle",
							args: ["claim", "acquire", TICKET, "--owner", OWNER, "--context", "contexts/relative"],
							code: "context-invalid",
						},
						{
							label: "operation ID with a space (id-02)",
							catches: "lax operation ID checks",
							args: [...acquire, "--operation-id", "bad id!"],
							code: "invalid-operation-id",
						},
						{
							label: "operation ID over 128 characters (id-02)",
							catches: "no length limit",
							args: [...acquire, "--operation-id", `op-${"x".repeat(126)}`],
							code: "invalid-operation-id",
						},
						{
							label: "zero TTL",
							catches: "a non-positive TTL passed to the planner",
							args: [...acquire, "--ttl-ms", "0"],
							code: "invalid-option",
						},
					];
					const runs: JsonRun[] = [];
					for (const row of local) runs.push(await fixture.json(row.args));
					const hardEnd = new Date(Date.now() + 60 * MINUTE).toISOString();
					const configured: ConfigRow[] = [
						{
							// The surface reports the missing keys, without network.
							label: "surface keys missing (cfg5-02)",
							catches: "a silent fallback to start values",
							block: { epsMs: null, pauseBaseMs: null, pauseMaxMs: null },
							args: acquire,
							code: "config-invalid",
						},
						{
							label: "hard mode without --hard-end (cap-01)",
							catches: "a hard claim without a work limit",
							block: { epsMs: EPS, pauseBaseMs: 1, pauseMaxMs: 1, mode: "hard" },
							args: acquire,
							code: "hard-end-required",
						},
						{
							label: "--hard-end in mode none",
							catches: "an option silently ignored",
							block: { mode: "none" },
							args: [...acquire, "--hard-end", hardEnd],
							code: "option-not-applicable",
						},
					];
					const configuredRuns: JsonRun[] = [];
					for (const row of configured) {
						await fixture.writeBlock(row.block);
						configuredRuns.push(await fixture.json(row.args));
					}
					await fixture.writeBlock({ mode: "lease" });
					const rows = [...local, ...configured];
					expect({
						views: [...runs, ...configuredRuns].map((run, index) => ({
							label: rows[index]?.label,
							view: cliView(run),
						})),
						problems: field(configuredRuns[0]?.doc, "problems"),
						connections: proxy.acceptedConnections,
					}).toEqual({
						views: rows.map((row) => ({
							label: row.label,
							view: failed("acquire", "refused", row.code),
						})),
						problems: [
							{ key: "claims.clock_uncertainty_ms", problem: "missing" },
							{ key: "claims.retry_pause_base_ms", problem: "missing" },
							{ key: "claims.retry_pause_max_ms", problem: "missing" },
						],
						connections: 0,
					});
					// bud-05 and the counter's positive control: an observe read reaches the stall and stops on time.
					const reached = await fixture.json(["claim", "list"]);
					const baseline = runs[0]?.ms ?? 0;
					expect({
						view: cliView(reached),
						connected: proxy.acceptedConnections > 0,
						onTime: reached.ms - baseline < OVERDUE_MS,
					}).toEqual({ view: failed("list", "unavailable", "unreachable"), connected: true, onTime: true });
					expect(await fixture.leaks()).toEqual([]);
				});
			} finally {
				await proxy.close();
			}
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"id-02 id-03 rsm-04: caller IDs, their reuse, the journal scope and the retry scope",
		async () => {
			const block = { attempts: 1, timeoutMs: LOSS_TIMEOUT };
			await withCase("blob", "ids", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				// Positive control: the caller may set the operation ID.
				const fixed = await fixture.json(acquireArgs(TICKET, a, "--operation-id", "op-fixed-1"));
				expect(cliView(fixed)).toEqual(applied("acquire", "held", { operationId: "op-fixed-1" }));
				const reused = await fixture.json(acquireArgs(SECOND, a, "--operation-id", "op-fixed-1"));
				const notPlanned = await fixture.json(acquireArgs(TICKET, b, "--operation-id", "op-fixed-2"));
				const foreignJournal = await fixture.json(onArgs("resolve", "op-fixed-1", b));
				expect({
					receipts: Object.keys(await fixture.receipts(TICKET)),
					reused: cliView(reused),
					untouched: Object.keys(await fixture.receipts(SECOND)),
					journalA: await fixture.recordNames(a),
					notPlanned: cliView(notPlanned),
					journalB: await fixture.recordNames(b),
					foreignJournal: cliView(foreignJournal),
				}).toEqual({
					receipts: ["op-fixed-1"],
					reused: failed("acquire", "refused", "operation-id-in-use"),
					untouched: [],
					journalA: ["op-fixed-1.json"],
					notPlanned: planRejected("acquire", "not-free", "foreign"),
					journalB: [],
					// Resolve and retry errors echo the requested operation ID.
					foreignJournal: failed("resolve", "refused", "operation-not-found", { operationId: "op-fixed-1" }),
				});
				// rsm-04: one open acquire and one open renew, then the endpoint and the disabled gate change.
				const heldAcquire = await fixture.hooks.next("pre");
				await fixture.hooks.plan("pre", ["hold-reject"]);
				const openAcquire = await fixture.json(acquireArgs(THIRD, a, "--operation-id", "op-rsm-04a"));
				await fixture.hooks.settle("pre", heldAcquire);
				const heldRenew = await fixture.hooks.next("pre");
				await fixture.hooks.plan("pre", ["hold-reject"]);
				const openRenew = await fixture.json(onArgs("renew", TICKET, a, "--operation-id", "op-rsm-04b"));
				await fixture.hooks.settle("pre", heldRenew);
				await fixture.hooks.plan("pre", [], "pass");
				await fixture.writeBlock({ endpoint: await fixture.otherArea(true) });
				const moved = await fixture.json(onArgs("retry", "op-rsm-04a", a));
				await fixture.writeBlock({ endpoint: fixture.url, enabled: false });
				const disabledAcquire = await fixture.json(onArgs("retry", "op-rsm-04a", a));
				const disabledRenew = await fixture.json(onArgs("retry", "op-rsm-04b", a));
				// catches: a resend to another endpoint; enabled:false blocking maintenance (over-locking).
				expect({
					open: [cliView(openAcquire).status, cliView(openRenew).status],
					moved: cliView(moved),
					disabledAcquire: cliView(disabledAcquire),
					disabledRenew: cliView(disabledRenew),
				}).toEqual({
					open: ["unknown", "unknown"],
					moved: failed("retry", "refused", "scope-mismatch", { operationId: "op-rsm-04a" }),
					disabledAcquire: failed("retry", "refused", "claims-disabled", { operationId: "op-rsm-04a" }),
					disabledRenew: applied("retry", "held", { action: "renew", operationId: "op-rsm-04b" }),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"eps-01 cap-01: eps comes from the configuration; a default lease is capped at the hard end",
		async () => {
			// Eps is claims.clock_uncertainty_ms without a start value.
			const block = { ttlMs: 1, graceMs: 0, epsMs: 600_000 };
			await withCase("blob", "eps", { block }, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				const acquired = await fixture.json(acquireArgs(TICKET, a));
				// Positive control (catches: missing wiring).
				expect(cliView(acquired)).toEqual(applied("acquire", "held"));
				const early = await fixture.json(onArgs("reclaim", TICKET, b));
				await fixture.writeBlock({ epsMs: 0 });
				const reclaimed = await fixture.json(onArgs("reclaim", TICKET, b));
				// cap-01: --hard-end is ISO-8601 with a zone; instants print as epoch ms.
				await fixture.writeBlock({ ttlMs: 60 * MINUTE, graceMs: GRACE, epsMs: EPS });
				const hardEnd = Date.now() + 20 * MINUTE;
				const iso = new Date(hardEnd).toISOString();
				const capped = await fixture.json(acquireArgs(SECOND, a, "--hard-end", iso));
				const overlong = await fixture.json(acquireArgs(THIRD, a, "--hard-end", iso, "--ttl-ms", String(120 * MINUTE)));
				// catches: eps hard-wired or ignored; a missing display of the capped lease.
				expect({
					early: cliView(early),
					reclaimed: cliView(reclaimed),
					capped: cliView(capped),
					planned: field(capped.doc, "planned"),
					overlong: cliView(overlong),
				}).toEqual({
					early: planRejected("reclaim", "not-yet", "foreign", plannedLeaseEnd(acquired.doc)),
					reclaimed: applied("reclaim", "free"),
					capped: applied("acquire", "held"),
					planned: {
						status: "active",
						claimGeneration: 1,
						capped: true,
						timing: { mode: "lease", leaseEnd: hardEnd, hardEnd, graceMs: GRACE },
					},
					overlong: planRejected("acquire", "overlong", "absent", hardEnd),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"out-07 out-08: a foreign owner with an escape sequence and a far lease end render in both modes",
		async () => {
			await withCase("blob", "render", {}, async (fixture) => {
				const a = await fixture.context();
				const farEnd = Number.MAX_SAFE_INTEGER - GRACE;
				await fixture.writeState(TICKET, foreignState(ESC_OWNER, farEnd));
				const listing = await fixture.json(["claim", "list", "--context", a.directory]);
				const first = (field(listing.doc, "claims") as unknown[] | undefined)?.[0];
				// Positive control (catches: RangeError from toISOString above 8.64e15 turning list into internal).
				expect({
					view: listView(listing),
					owner: field(first, "owner"),
					timing: field(first, "timing"),
					rawEscape: listing.stdout.includes("\u001b"),
				}).toEqual({
					view: listed([entry(TICKET, "active", 1, "foreign", ESC_OWNER)]),
					owner: ESC_OWNER,
					timing: { mode: "lease", leaseEnd: farEnd, hardEnd: null, graceMs: GRACE },
					rawEscape: false,
				});
				const human = await fixture.plain(["claim", "list", "--context", a.directory]);
				// catches: terminal injection through the owner display name.
				expect({ plain: plainView(human), rawEscape: `${human.stdout}${human.stderr}`.includes("\u001b") }).toEqual({
					plain: plainOf("ok"),
					rawEscape: false,
				});
				expect(await fixture.leaks([["foreign binding", OTHER_BINDING]])).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"bud-03: the operation budget ends resending before the attempts are used up",
		async () => {
			// Budget V1; the deadline is taken before the preflight.
			const block = { attempts: 5, timeoutMs: LOSS_TIMEOUT, budgetMs: 5_000, pauseBaseMs: 1, pauseMaxMs: 1 };
			await withCase("blob", "budget", { block }, async (fixture) => {
				const a = await fixture.context();
				await fixture.hooks.plan("pre", [], "hold-reject");
				const run = await fixture.json(acquireArgs(TICKET, a));
				const actual = cliView(run);
				// Positive control first (catches: the budget ignored or started after the preflight).
				expect({
					status: actual.status,
					exit: actual.exit,
					schema: actual.schema,
					outcome: actual.outcome,
					// ASSUMPTION(CLI): a post-deadline query that ends unknown also counts as a budget stop.
					stoppedBy: actual.stoppedBy,
					fewer: typeof actual.sends === "number" && actual.sends >= 1 && actual.sends < 5,
					inTime: run.ms < BUDGET_BOUND_MS,
				}).toEqual({
					status: "unknown",
					exit: 3,
					schema: [],
					outcome: "unknown",
					stoppedBy: "budget",
					fewer: true,
					inTime: true,
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rel-02: renew, reclaim, list and release work from a project without the ticket",
		async () => {
			await withCase("blob", "elsewhere", {}, async (fixture) => {
				const a = await fixture.context();
				const b = await fixture.context();
				// Positive control (catches: missing wiring).
				expect(cliView(await fixture.json(acquireArgs(TICKET, a)))).toEqual(applied("acquire", "held"));
				// Only acquire looks up a local ticket.
				const other = await fixture.extraProject([]);
				const renewed = await fixture.json(onArgs("renew", TICKET, a), other);
				const early = await fixture.json(onArgs("reclaim", TICKET, b), other);
				const listing = await fixture.json(["claim", "list", "--context", a.directory], other);
				const released = await fixture.json(onArgs("release", TICKET, a), other);
				// catches: a local ticket lookup outside acquire.
				expect({
					renewed: cliView(renewed),
					early: cliView(early),
					listing: listView(listing),
					released: cliView(released),
				}).toEqual({
					renewed: applied("renew", "held"),
					early: planRejected("reclaim", "not-yet", "foreign", plannedLeaseEnd(renewed.doc) + GRACE),
					listing: listed([entry(TICKET, "active", 1, "held")]),
					released: applied("release", "free"),
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"lst-01: a skipped ref name or an unreadable ticket makes the list partial, unknown 3, never a shorter ok",
		async () => {
			await withCase("blob", "partial", {}, async (fixture) => {
				const a = await fixture.context();
				const listArgs = ["claim", "list", "--context", a.directory];
				// Positive control (catches: missing wiring; a list that is partial without a reason).
				expect(cliView(await fixture.json(acquireArgs(TICKET, a)))).toEqual(applied("acquire", "held"));
				expect(listView(await fixture.json(listArgs))).toEqual(listed([entry(TICKET, "active", 1, "held")]));
				// Server-side refs outside the protocol, written directly into the bare repository (no push, no hook).
				const written = await server().git(fixture.serverRepo, ["hash-object", "-w", "--stdin"], `x ${SENTINEL}\n`);
				const garbage = written.out.trim();
				const foreignRef = "refs/claims/not-a-ticket";
				// Via listClaimRefs: a non-canonical name under refs/claims/* is counted as skipped, never guessed.
				await server().git(fixture.serverRepo, ["update-ref", foreignRef, garbage]);
				const skipped = await fixture.json(listArgs);
				const skippedPlain = await fixture.plain(listArgs);
				await fixture.deleteServerRef(foreignRef);
				// The second producer: a canonical ticket whose object is no claim document reads as unknown, not free.
				await server().git(fixture.serverRepo, ["update-ref", `refs/claims/${THIRD}`, garbage]);
				const unreadable = await fixture.json(listArgs);
				const unreadablePlain = await fixture.plain(listArgs);
				const partial = (claims: EntryView[]): ListView => ({
					...listed(claims),
					exit: 3,
					status: "unknown",
					complete: false,
				});
				// catches: skipped names dropped silently (ok 0 with fewer entries); an unreadable ticket listed as free or
				// omitted; the valid ticket lost with the bad one; the partial list reported on stderr or as a refusal.
				expect({
					skipped: listView(skipped),
					skippedPlain: plainView(skippedPlain),
					unreadable: listView(unreadable),
					unreadablePlain: plainView(unreadablePlain),
				}).toEqual({
					skipped: partial([entry(TICKET, "active", 1, "held")]),
					skippedPlain: plainOf("unknown"),
					unreadable: partial([
						entry(TICKET, "active", 1, "held"),
						{ ticket: THIRD, state: "unknown", owner: null, claimGeneration: null, ownership: null },
					]),
					unreadablePlain: plainOf("unknown"),
				});
				// out-01: neither the skipped ref name nor the object ID reaches any output; paths and endpoint as always.
				const extra: Sentinel[] = [
					["skipped ref name", "not-a-ticket"],
					["garbage object", garbage],
				];
				expect(await fixture.leaks(extra)).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim CLI documentation (no project)", () => {
	test(
		"doc-01: the group help carries the exit codes; each command documents its document",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-docs-"));
			try {
				const group = await runCli(cwd, ["claim", "--help"]);
				const text = group.stdout + group.stderr;
				// Positive control (catches: an undocumented exit code; a help table that drifts from the documented one).
				expect(missingExitRows(text)).toEqual([]);
				const helps: HelpView[] = [];
				for (const [command, kind] of CORE_HELP) helps.push(await helpView(cwd, command, kind));
				expect({
					exit: group.exit,
					unlisted: CORE_HELP.map(([command]) => command).filter((command) => !text.includes(command)),
					helps,
				}).toEqual({ exit: 0, unlisted: [], helps: CORE_HELP.map(([command]) => documented(command)) });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);

	test(
		"doc-03: the claims guide prints and the guide index lists it within its invariants",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-docs-"));
			try {
				const guide = await runCli(cwd, ["instructions", "claims"]);
				// Positive control (catches: a guide that is not registered).
				expect(guide.exit).toBe(0);
				const index = await runCli(cwd, ["instructions"]);
				const listing = await runCli(cwd, ["instructions", "--list"]);
				const terms = ["claim resolve", "claim retry", "--context", "schemaVersion", "unknown-history"];
				expect({
					missingRows: missingExitRows(guide.stdout),
					missingTerms: terms.filter((term) => !guide.stdout.includes(term)),
					indexed: index.stdout.includes("backlog instructions claims"),
					listed: listing.stdout.includes("claims"),
					// Index invariants of cli-guidance.test.ts:56 and :62-63.
					leaked: ["--plain", "bundled", "binary"].filter((term) => index.stdout.includes(term)),
				}).toEqual({ missingRows: [], missingTerms: [], indexed: true, listed: true, leaked: [] });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});

// Setup, init and context create belong to the base CLI. Nothing above depends on this block.
describe("claim setup, init and context create", () => {
	for (const format of FORMATS) {
		test(
			`cli-01 ini-01 out-06 (${format}): setup, init twice, context create and a first acquire`,
			async () => {
				await withCase(format, "admin", { descriptor: false, block: null }, async (fixture) => {
					const setup = await fixture.json(setupArgs(fixture.url, format));
					// Positive control (catches: no setup command; values echoed instead of key names).
					expect(pick(setup, ["kind", "status", "keys"])).toEqual({
						exit: 0,
						schema: [],
						kind: "claim-setup",
						status: "ok",
						keys: TEMPLATE_KEYS,
					});
					const created = await fixture.json(["claim", "init"]);
					const exists = await fixture.json(["claim", "init"]);
					const made = await fixture.json(["claim", "context", "create", "--parent", fixture.parent]);
					const contextId = field(made.doc, "contextId");
					if (typeof contextId !== "string") throw new Error("context create printed no context ID");
					const handle = await fixture.adopt(join(fixture.parent, contextId));
					const acquired = await fixture.json(acquireArgs(TICKET, handle));
					const initKeys = ["kind", "status", "result", "format", "epoch"];
					const initView = (result: string) => ({
						exit: 0,
						schema: [],
						kind: "claim-init",
						status: "ok",
						result,
						format,
						epoch: 1,
					});
					// catches: init not idempotent; the handle path printed (out-06); a handle that does not work.
					const madeView: Record<string, unknown> = { ...pick(made, ["kind", "status"]), keys: keysOf(made.doc) };
					expect({
						created: pick(created, initKeys),
						exists: pick(exists, initKeys),
						made: madeView,
						acquired: cliView(acquired),
					}).toEqual({
						created: initView("created"),
						exists: initView("exists"),
						made: {
							exit: 0,
							schema: [],
							kind: "claim-context",
							status: "ok",
							keys: ["command", "contextId", "kind", "schemaVersion", "status"],
						},
						acquired: applied("acquire", "held"),
					});
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			TEST_TIMEOUT,
		);
	}

	test(
		"set-01 ctx-01 out-02 ini-01: setup never overwrites, init conflicts, parents must be private",
		async () => {
			await withCase("blob", "admin-errors", { descriptor: false, block: null }, async (fixture) => {
				const configPath = join(fixture.project, "backlog", "config.yml");
				const pristine = await readFile(configPath, "utf8");
				const invalid = await fixture.json(setupArgs("origin", "blob"));
				// Positive control (catches: an invalid block written to the project file).
				expect({
					view: pick(invalid, ["kind", "status", "code", "problems"]),
					file: await readFile(configPath, "utf8"),
				}).toEqual({
					view: {
						exit: 5,
						schema: [],
						kind: "claim-error",
						status: "refused",
						code: "config-invalid",
						problems: [{ key: "claims.endpoint", problem: "unsupported-endpoint" }],
					},
					file: pristine,
				});
				// out-02: the path of the endpoint carries the sentinel; the unused port makes init unavailable.
				const port = await unusedLoopbackPort();
				const secretEndpoint = `http://127.0.0.1:${port}/${SENTINEL}PATH.git`;
				const written = await fixture.json(setupArgs(secretEndpoint, "blob"));
				const configured = await readFile(configPath, "utf8");
				const again = await fixture.json(setupArgs(fixture.url, "tree"));
				const unreachable = await fixture.json(["claim", "init"]);
				// ini-01: a second project creates the area, a third one with another format conflicts.
				const first = await fixture.extraProject([]);
				const created = await fixture.json(["claim", "init"], first);
				const conflicting = await fixture.extraProject([], { format: "tree" });
				const conflict = await fixture.json(["claim", "init"], conflicting);
				// ctx-01: only an explicit absolute parent with mode 0700 is accepted.
				const open = join(fixture.root, `open-parent-${SENTINEL}`);
				await mkdir(open);
				await chmod(open, 0o755);
				const relativeParent = await fixture.json(["claim", "context", "create", "--parent", "contexts-relative"]);
				const openParent = await fixture.json(["claim", "context", "create", "--parent", open]);
				const made = await fixture.json(["claim", "context", "create", "--parent", fixture.parent]);
				const contextId = field(made.doc, "contextId");
				if (typeof contextId === "string") await fixture.adopt(join(fixture.parent, contextId));
				const codeKeys = ["kind", "status", "code"];
				const refused = (code: string) => ({ exit: 5, schema: [], kind: "claim-error", status: "refused", code });
				// ASSUMPTION(CLI): init unreachable uses the code unreachable, context refusals context-invalid.
				expect({
					written: pick(written, ["kind", "status"]),
					changed: configured !== pristine,
					again: pick(again, codeKeys),
					unchanged: (await readFile(configPath, "utf8")) === configured,
					unreachable: pick(unreachable, codeKeys),
					created: pick(created, ["kind", "status", "result"]),
					conflict: pick(conflict, codeKeys),
					relativeParent: pick(relativeParent, codeKeys),
					openParent: pick(openParent, codeKeys),
					made: pick(made, ["kind", "status"]),
				}).toEqual({
					written: { exit: 0, schema: [], kind: "claim-setup", status: "ok" },
					changed: true,
					again: refused("already-configured"),
					unchanged: true,
					unreachable: { exit: 6, schema: [], kind: "claim-error", status: "unavailable", code: "unreachable" },
					created: { exit: 0, schema: [], kind: "claim-init", status: "ok", result: "created" },
					conflict: refused("format-conflict"),
					relativeParent: refused("context-invalid"),
					openParent: refused("context-invalid"),
					made: { exit: 0, schema: [], kind: "claim-context", status: "ok" },
				});
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"doc-01 (admin): setup, init and context create document their output",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-cli-docs-"));
			try {
				const helps: HelpView[] = [];
				for (const [command, kind] of ADMIN_HELP) helps.push(await helpView(cwd, command, kind));
				expect(helps).toEqual(ADMIN_HELP.map(([command]) => documented(command)));
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
