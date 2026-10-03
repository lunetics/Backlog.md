/**
 * Emergency release, level E (em-e01, em-e02, em-e03, doc-e01a): the real `backlog claim emergency-release …`,
 * `backlog claim context show|create …`, `backlog claim list …`, `backlog claim retry …` and
 * `backlog instructions claims` subprocesses in a real Backlog project against the loopback Git daemon (em-e01 for
 * blob, tree and commit-chain, the other cases with blob or without an area). The operator is a private context made
 * through the context API; the test derives its authority ID on its own (`ta1-` + SHA-256 over
 * `backlog.md/claim-authority/v1\0` and the secret bytes of `context.json`, read as the binding derivation reads them)
 * and lists it in `claims.recovery_authorities`. The holder acquires through the CLI. The root a preview prints is read
 * again with `git ls-remote` against the fixture endpoint. Every stdout and stderr is scanned for the sentinel in every
 * path, the endpoint, every server root (allowed only in the preview's `root`), the owner name (allowed only in list
 * entries and the preview's `owner`), bindings, secrets, recovery proofs, context paths, journal digests, context IDs
 * and authority IDs (an ID only in the context document of that context, its authority ID only in `context show`).
 * The CLI runs on the real clock; no expectation depends on it. Every test starts with a positive control the
 * scaffold (empty help of both new registrations, a fixed plan rejection for the new action, `claimContextAuthority`
 * returning "", guide and CLAIMS.md unchanged) cannot satisfy. The harness is an adapted copy of
 * claim-cli-administration.test.ts and claim-mcp-cli.test.ts; the Git fixture is used unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createClaimContext } from "../claims/context/index.ts";
import { type ClaimStorageFormat, initializeClaimStorage } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-cli-administration.test.ts:40-112: the status union and the run types; Handle replaces the
// ClaimContext handle (the private record carries what the scan and the authority derivation need); the operation,
// list, help and context views are narrowed to the facts the emergency release pins.
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
type CliRun = { exit: number; stdout: string; stderr: string };
type JsonRun = CliRun & { doc: unknown };
type Sentinel = readonly [label: string, value: string];
/** A private context as the test knows it: its path, its record (context/index.ts:33-38) and its authority ID. */
type Handle = {
	directory: string;
	contextId: string;
	binding: string;
	secret: string;
	recoveryBinding: string | null;
	recoverySecret: string | null;
	authorityId: string;
};
/** `allowedId`: the one context ID an output may carry; `authorityAllowed`: it may carry that context's authority. */
type Output = { command: string; text: string; allowedId: string | null; authorityAllowed: boolean };
type JournalRecord = { name: string; digest: string; parameterDigest: string };
/** Kinds, codes, facts and counts of one JSON document; the message is never compared. */
type OperationView = {
	exit: number;
	keys: string[];
	kind: unknown;
	status: unknown;
	command: unknown;
	code: unknown;
	action: unknown;
	outcome: unknown;
	rejection: unknown;
	storage: unknown;
	sends: unknown;
	stoppedBy: unknown;
	planned: unknown;
	ownership: unknown;
	operationId: unknown;
};
type EntryView = { ticket: unknown; state: unknown; owner: unknown; claimGeneration: unknown; ownership: unknown };
type ListView = {
	exit: number;
	kind: unknown;
	status: unknown;
	complete: unknown;
	observed: boolean;
	claims: EntryView[] | null;
};
/** Missing help sections, unnamed documents and options without a schema line (help-schema.ts:30-35, :49-77). */
type HelpFacts = { exit: number; missing: string[]; kinds: string[]; fields: string[] };
/** A Markdown heading and the line where its section ends (the next heading of the same or a higher level). */
type Heading = { level: number; title: string; line: number; end: number };
/** The statuses a code has in the code tables and the exit its status has in the status table. */
type CodeFacts = { code: string; statuses: string[]; exit: string | null };

// adapted from claim-cli-administration.test.ts:116-137
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context and endpoint paths; no output may contain it. */
const SENTINEL = "SENTINEL-emergency-3b9e";
/** Owner of every acquired claim; a display name, allowed only in list entries and the preview's `owner`. */
const OWNER = "agent-owner-emergency";
const TICKET = "BACK-1";
const SECOND = "BACK-2";
const TICKETS = [TICKET, SECOND];
/** The new verb; command name = action name. */
const RELEASE = "emergency-release";
/** . */
const PREVIEW_KIND = "claim-emergency-preview";
/** The command literal of `context show`, patterned on `context-create`. */
const CONTEXT_SHOW = "context-show";
/** The one new plan cause. */
const STALE_ROOT = "stale-root";
/** The three new codes over both stages, all refused/5. */
const NEW_CODES = ["authority-required", "expectation-required", "isolation-unconfirmed"];
const RELEASE_ID = "op-em-e01";
const CONTROL_ID = "op-em-e02";
/** A root of 40 hex digits: the fixture repositories use SHA-1 object names. */
const HEX40 = /^[0-9a-f]{40}$/;
/** Placeholder for a ticket ref `git ls-remote` did not print; never an object name. */
// adapted from claim-cli-administration.test.ts:158
const ABSENT_ROOT = "(no ref)";
/** The binding derivation (context/index.ts:129-134) and the authority derivation: prefix and domain. */
const BINDING_PREFIX = "tb1-";
const BINDING_DOMAIN = "backlog.md/claim-context/v1\0";
const AUTHORITY_PREFIX = "ta1-";
const AUTHORITY_DOMAIN = "backlog.md/claim-authority/v1\0";
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
/** Guide "Output" (claims.md:58-59): the keys of a claim-operation outside the time path. */
const OPERATION_KEYS = [
	"action",
	"command",
	"kind",
	"operationId",
	"outcome",
	"planned",
	"rejection",
	"rights",
	"schemaVersion",
	"sends",
	"status",
	"stoppedBy",
	"storage",
	"ticket",
].sort(byCodeUnits);
/** errorDocument (surface/index.ts:1382-1406) of a code without problems, formats or dependencies. */
const ERROR_KEYS = ["code", "command", "kind", "message", "operationId", "schemaVersion", "status", "ticket"].sort(
	byCodeUnits,
);
/** Exit, kind and status of a setup step the reference CLI applied (acquire, renew). */
const APPLIED_STEP: Record<string, unknown> = { exit: 0, kind: "claim-operation", status: "applied" };
/** claim-cli-administration.test.ts:916-929: `context create` keeps exactly its keys; no authority ID there. */
const CONTEXT_MADE: Record<string, unknown> = {
	exit: 0,
	kind: "claim-context",
	status: "ok",
	command: "context-create",
	keys: ["command", "contextId", "kind", "schemaVersion", "status"],
};
/** help-schema.ts:50, :70, :73: the sections addHelpSchema writes. */
const HELP_SECTIONS = ["Input schema:", "Output:", "Examples:"];
/** Each option of both command forms has its own schema line (convention). */
const RELEASE_FIELDS = ["--context", "--expect-root", "--preview", "--operation-id", "--json"];
/** The preview document and the executor's operation document. */
const RELEASE_KINDS = [PREVIEW_KIND, "claim-operation"];
/** The options of `claim emergency-release` besides the shared ones. */
const RELEASE_OPTIONS = ["--context", "--expect-root", "--preview", "--operation-id"];
/**
 * ASSUMPTION: every claim command carries the output pair of withOutputOptions (claim.ts:317-319) and Commander's own
 * help option; em-e03 measures exactly this set on `claim resolve --help` (claim.ts:745-759).
 */
const SHARED_OPTIONS = ["--help", "--json", "--plain"];
/** `backlog claim context show --context <abs> [--json]`. */
const SHOW_FIELDS = ["--context", "--json"];
/** Commander's option lines: two spaces, then `-x, --name` or `--name` (Help.formatItem, item indent 2). */
const OPTION_LINE = /^ {2}(?:-[A-Za-z], )?(--[a-z][a-z0-9-]*)/;
/** The new guide section. */
const SECTION = "Emergency release and new epochs";
/** Verbatim; compared with whitespace collapsed. */
const RELEASE_SENTENCE = [
	"`emergency-release` needs a context whose authority ID is listed in `claims.recovery_authorities`, and the",
	"exact root from `--preview`. It frees the claim and nothing else: nobody is assigned, the former holder is not",
	"stopped and learns it from its next renew or list, and a running `claim next` loop may take the ticket at once.",
].join(" ");
/** "Command table rows": the two new commands in the guide's command list (claims.md:9-42). */
const GUIDE_COMMANDS = ["backlog claim emergency-release", "backlog claim context show"];
/** The plan cause list of the guide (claims.md:230-238): a top-level bullet led by the cause in backticks. */
const STALE_ROOT_BULLET = /^- `stale-root`:/;
/** CLAIMS.md:797: the section the new sentence extends. */
const NOT_DO = "What claims do not do";
/** Its bullets lead with a bold head (CLAIMS.md:799-823). */
const NO_REASSIGNMENT = /^- \*\*No automatic reassignment after an emergency release\.?\*\*/;
/** The level-3 headings of CLAIMS.md at the base (CLAIMS.md:72-745); a level-3 heading not in it is new. */
const BASE_SECTIONS: readonly string[] = [
	"S1 First claim",
	"S2 Heartbeat under a lease",
	"S3 Two agents, one ticket",
	"S4 Claim the next ready ticket",
	"S5 Dependency gate",
	"S7 Hand a claim to a colleague",
	"S9 Shorten a claim",
	"S13 Extend a hard end over the time path",
	"S14 Restart a hand-over's time box",
	"S12 Reading a result without parsing the text",
	"Heartbeat loop",
	"Renew before an irreversible effect",
	"Lost reply: resolve, then retry",
	"Resolve before acting on unknown",
	"S6 Lost reply",
	"S15 A witnessed transition",
	"S8 Replace a crashed agent",
	"S10 Clean up after a departed agent",
	"S11 Errors an agent meets",
];
const CLAIMS_PATH = join(import.meta.dir, "..", "..", "CLAIMS.md");

// adapted from claim-cli-administration.test.ts:278-291
let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-cli-administration.test.ts:294-297
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-cli-administration.test.ts:300-302
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** `prefix` + SHA-256 over the domain and the secret's bytes, read as context/index.ts:129-134 reads them. */
function derivedId(prefix: string, domain: string, secret: string): string {
	const hash = createHash("sha256").update(domain, "utf8");
	return `${prefix}${hash.update(Buffer.from(secret, "hex")).digest("hex")}`;
}

/** The expected authority ID, derived by the test alone; the product's derivation is never called. */
function authorityOf(secret: string): string {
	return derivedId(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, secret);
}

// adapted from claim-cli-administration.test.ts:305-308
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli-administration.test.ts:311-313
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-cli-administration.test.ts:316-319
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-cli-administration.test.ts:387-389
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// adapted from claim-cli-administration.test.ts:399-401
function integer(value: unknown): boolean {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-cli-administration.test.ts:382-384
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-cli-administration.test.ts:338-340
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-mcp-cli.test.ts:136-140 (runCli without the timing)
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The label of an output in the scan: the claim verb, `context-<verb>` for the context group. */
// adapted from claim-cli-administration.test.ts:355-358; `context show` gets its own label
function commandOf(args: readonly string[]): string {
	if (args[0] !== "claim") return args[0] ?? "";
	return args[1] === "context" ? `context-${args[2] ?? ""}` : (args[1] ?? "");
}

// adapted from claim-cli-administration.test.ts:361-367
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

function withoutKeys(doc: unknown, keys: readonly string[]): unknown {
	if (!isRecord(doc)) return doc;
	return Object.fromEntries(Object.entries(doc).filter(([key]) => !keys.includes(key)));
}

/** Owner names are display data in list entries; the collector drops them there before scanning. */
// adapted from claim-cli-administration.test.ts:371-378
function withoutOwners(doc: unknown): unknown {
	const claims = field(doc, "claims");
	if (!Array.isArray(claims) || !isRecord(doc)) return doc;
	return { ...doc, claims: claims.map((item: unknown) => withoutKeys(item, ["owner"])) };
}

/**
 * Allowlist: the owner name only in list entries and in the preview's `owner`, a root only in the
 * preview's `root`; both fields are dropped before the scan, so a copy anywhere else is found.
 */
function scannedText(doc: unknown, stdout: string): string {
	const kind = field(doc, "kind");
	if (kind === "claim-list") return JSON.stringify(withoutOwners(doc));
	if (kind === PREVIEW_KIND) return JSON.stringify(withoutKeys(doc, ["owner", "root"]));
	return stdout;
}

// adapted from claim-cli-administration.test.ts:599-619: `keys` stands in for the schema validator; operation IDs
// are not mapped to "generated" (every release here carries its own --operation-id)
function operationView(run: JsonRun): OperationView {
	const { doc } = run;
	return {
		exit: run.exit,
		keys: keysOf(doc),
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		code: field(doc, "code") ?? null,
		action: field(doc, "action") ?? null,
		outcome: field(doc, "outcome") ?? null,
		rejection: field(doc, "rejection") ?? null,
		storage: field(doc, "storage") ?? null,
		sends: field(doc, "sends") ?? null,
		stoppedBy: field(doc, "stoppedBy") ?? null,
		planned: field(doc, "planned") ?? null,
		ownership: field(field(doc, "rights"), "ownership") ?? null,
		operationId: field(doc, "operationId") ?? null,
	};
}

/** The OperationView fields a builder may set besides the status it names itself. */
type ViewFields = Partial<Omit<OperationView, "status">>;

// adapted from claim-cli-administration.test.ts:625-642: command and action default to emergency-release
function view(status: Status, fields: ViewFields): OperationView {
	return {
		exit: EXIT[status],
		keys: OPERATION_KEYS,
		kind: "claim-operation",
		status,
		command: RELEASE,
		code: null,
		action: RELEASE,
		outcome: null,
		rejection: null,
		storage: null,
		sends: null,
		stoppedBy: null,
		planned: null,
		ownership: null,
		operationId: null,
		...fields,
	};
}

/**
 * One send, the FREE tombstone with the generation the claim had (no reassignment), the caller's
 * operation ID and the operator's own view of the FREE state (surface/index.ts:1538-1554, execution/index.ts:369-378).
 */
function released(operationId: string): OperationView {
	const planned = { status: "free", claimGeneration: 1, timing: null, capped: false };
	return view("applied", {
		outcome: "applied",
		storage: { kind: "applied" },
		sends: 1,
		planned,
		ownership: "free",
		operationId,
	});
}

/** With surface/index.ts:1626-1656: a plan rejection records and sends nothing and names no ID. */
function staleRoot(): OperationView {
	const rejection = { stage: "plan", cause: STALE_ROOT };
	return view("rejected", { outcome: "rejected", rejection, sends: 0, ownership: "foreign" });
}

/** A refusal before any network is a claim-error without an operation ID. */
function refused(code: string): OperationView {
	return view("refused", { keys: ERROR_KEYS, kind: "claim-error", code, action: null });
}

function outcomeOf(run: JsonRun): Record<string, unknown> {
	return { exit: run.exit, kind: field(run.doc, "kind") ?? null, status: field(run.doc, "status") ?? null };
}

/** For an ACTIVE claim; status `ok`, command = the verb. */
function previewOf(root: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: PREVIEW_KIND,
		status: "ok",
		command: RELEASE,
		ticket: TICKET,
		state: "active",
		owner: OWNER,
		claimGeneration: 1,
		epoch: 1,
		root,
	};
}

// adapted from claim-cli-administration.test.ts:810-817
function rightsFacts(doc: unknown): Record<string, unknown> {
	const rights = field(doc, "rights");
	return {
		ownership: field(rights, "ownership") ?? null,
		claimGeneration: field(rights, "claimGeneration") ?? null,
		workRight: field(rights, "workRight") ?? null,
	};
}

// adapted from claim-cli-administration.test.ts:692-710: the schema validator gives way to an observedAt check
function listView(run: JsonRun): ListView {
	const claims = field(run.doc, "claims");
	return {
		exit: run.exit,
		kind: field(run.doc, "kind") ?? null,
		status: field(run.doc, "status") ?? null,
		complete: field(run.doc, "complete") ?? null,
		observed: integer(field(run.doc, "observedAt")),
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

/**
 * The long option names of Commander's `Options:` block, which ends at its first empty line. Wrapped description
 * lines are indented past the term column and never match; the schema lines of help-schema.ts (`  - <name>: …`)
 * follow the block and never match either.
 */
function optionsOf(help: string): string[] {
	const lines = help.split("\n");
	const start = lines.indexOf("Options:");
	if (start < 0) return [];
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "") break;
		const name = OPTION_LINE.exec(line)?.[1];
		if (name !== undefined) names.push(name);
	}
	return names.sort(byCodeUnits);
}

/** Commander lists every registered option anyway; only the help schema writes `  - <name>: <type>` lines. */
// adapted from claim-cli-administration.test.ts:840-854: several kinds; --json as a schema line like the others
function helpFacts(run: CliRun, fields: readonly string[], kinds: readonly string[]): HelpFacts {
	const text = `${run.stdout}${run.stderr}`;
	return {
		exit: run.exit,
		missing: HELP_SECTIONS.filter((section) => !text.includes(section)),
		kinds: kinds.filter((kind) => !text.includes(kind)),
		fields: fields.filter((name) => !text.includes(`- ${name}:`)),
	};
}

// adapted from claim-cli-administration.test.ts:857-859
const DOCUMENTED: HelpFacts = { exit: 0, missing: [], kinds: [], fields: [] };

/** The context ID, its authority ID, nothing else. */
function shownDocument(handle: Handle): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-context",
		status: "ok",
		command: CONTEXT_SHOW,
		contextId: handle.contextId,
		authorityId: handle.authorityId,
	};
}

function shownView(run: JsonRun): Record<string, unknown> {
	return { exit: run.exit, stderr: run.stderr, doc: run.doc };
}

/** base cli-01: kind, status, command and the exact key set of a `context create` document. */
// adapted from claim-cli-administration.test.ts:916-921
function madeView(run: JsonRun): Record<string, unknown> {
	return {
		exit: run.exit,
		kind: field(run.doc, "kind") ?? null,
		status: field(run.doc, "status") ?? null,
		command: field(run.doc, "command") ?? null,
		keys: keysOf(run.doc),
	};
}

// adapted from claim-cli-administration.test.ts:932-936
function createdId(run: JsonRun): string {
	const contextId = field(run.doc, "contextId");
	if (typeof contextId !== "string") throw new Error("context create printed no context ID");
	return contextId;
}

/**
 * The surface keys plus the recovery authority list, written last like its place in SCHEMA_KEYS
 * (config/index.ts:166-183).
 */
// adapted from claim-mcp-cli.test.ts:155-172
function claimsBlock(endpoint: string, format: ClaimStorageFormat, authorities: readonly string[]): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${format}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
		"  recovery_authorities:",
		...authorities.map((id) => `    - ${JSON.stringify(id)}`),
	].join("\n");
}

// adapted from claim-cli-administration.test.ts:980-985
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await gitServer().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, BACK-1 and BACK-2, the claims block and one committed repository. */
// adapted from claim-cli-administration.test.ts:989-1013
async function initProject(directory: string, block: string | undefined): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim emergency CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const ticket of TICKETS) {
		const task = {
			id: ticket,
			title: `Claim target ${ticket}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-29",
			rawContent: "",
		};
		await core.filesystem.saveTask(task);
	}
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** Initializes an area through the storage API, never through the CLI under test. */
// adapted from claim-cli-administration.test.ts:1220-1224
async function initializeArea(client: string, url: string, format: ClaimStorageFormat): Promise<void> {
	const options = { repository: client, remote: url, format, timeoutMs: ADAPTER_TIMEOUT };
	expectKind(await initializeClaimStorage(options), "created");
}

/**
 * The private record of a context (context/index.ts:33-38) with the authority ID the test expects. The guard proves
 * that the test reads the secret bytes as the binding derivation does (context/index.ts:129-134), so the same reading
 * of the same bytes under the domain gives the expected authority ID.
 */
// adapted from claim-cli-administration.test.ts:1017-1023 (proofsOf)
async function handleOf(directory: string): Promise<Handle> {
	const record: unknown = JSON.parse(await readFile(join(directory, "context.json"), "utf8"));
	const contextId = field(record, "contextId");
	const binding = field(record, "binding");
	const secret = field(record, "secret");
	const recoveryBinding = field(field(record, "recovery"), "binding");
	const recoverySecret = field(field(record, "recovery"), "secret");
	if (typeof contextId !== "string" || typeof binding !== "string" || typeof secret !== "string") {
		throw new Error("the private record has no string context ID, binding or secret");
	}
	if (derivedId(BINDING_PREFIX, BINDING_DOMAIN, secret) !== binding) {
		throw new Error("the test reads the secret bytes otherwise than the binding derivation");
	}
	return {
		directory,
		contextId,
		binding,
		secret,
		recoveryBinding: typeof recoveryBinding === "string" ? recoveryBinding : null,
		recoverySecret: typeof recoverySecret === "string" ? recoverySecret : null,
		authorityId: authorityOf(secret),
	};
}

/** A context through the context API (context/index.ts:199-254), never through the CLI under test. */
// adapted from claim-cli-administration.test.ts:1237-1247
async function newContext(parent: string, recoverFrom: string | undefined): Promise<Handle> {
	const source = recoverFrom === undefined ? {} : { recoverFrom };
	const { context } = expectKind(await createClaimContext({ parent, ...source }), "created");
	return handleOf(dirname(context.journalDirectory));
}

/** Journal records of one context; temporary `.intent-*.tmp` names and `.admission-*` slots are ignored. */
// adapted from claim-cli-administration.test.ts:1350-1359
async function records(handle: Handle): Promise<JournalRecord[]> {
	const journal = join(handle.directory, "journal");
	const found: JournalRecord[] = [];
	for (const name of (await readdir(journal)).sort(byCodeUnits)) {
		if (name.startsWith(".") || !name.endsWith(".json")) continue;
		const record: unknown = JSON.parse(await readFile(join(journal, name), "utf8"));
		const digest = String(field(record, "digest"));
		found.push({ name, digest, parameterDigest: String(field(record, "parameterDigest")) });
	}
	return found;
}

// adapted from claim-cli-administration.test.ts:1361-1363
async function recordNames(handle: Handle): Promise<string[]> {
	return (await records(handle)).map((record) => record.name);
}

/** Names, modes and sha256 of every entry under `directory`: the holder's journal is never written. */
// adapted from claim-cli-administration.test.ts:1026-1040
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

// adapted from claim-cli-administration.test.ts:862-864
function acquireArgs(ticket: string, handle: Handle): string[] {
	return ["claim", "acquire", ticket, "--owner", OWNER, "--context", handle.directory];
}

/** The operator's context first; --preview, --expect-root and --operation-id follow in `extra`. */
function releaseArgs(ticket: string, handle: Handle, ...extra: string[]): string[] {
	return ["claim", RELEASE, ticket, "--context", handle.directory, ...extra];
}

function showArgs(handle: Handle): string[] {
	return ["claim", "context", "show", "--context", handle.directory];
}

/** ATX headings outside fenced blocks; a section ends at the next heading of the same or a higher level. */
function headingsOf(lines: readonly string[]): Heading[] {
	const found: Heading[] = [];
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const [, marks, title] = /^(#{1,6}) (.+?)\s*$/.exec(line) ?? [];
		if (marks === undefined || title === undefined) continue;
		found.push({ level: marks.length, title, line: index, end: lines.length });
	}
	for (const [index, heading] of found.entries()) {
		const next = found.slice(index + 1).find((other) => other.level <= heading.level);
		heading.end = next?.line ?? lines.length;
	}
	return found;
}

function sectionOf(lines: readonly string[], heading: Heading | undefined): string[] {
	return heading === undefined ? [] : lines.slice(heading.line + 1, heading.end);
}

// adapted from claim-surface.test.ts:515-522
function cells(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return [];
	return trimmed
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.replaceAll("`", "").trim());
}

/** Rows of every Markdown table whose first two header cells are `first` and `second`, as doc-02 reads them. */
// adapted from claim-surface.test.ts:524-536
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

/**
 * "The three codes in BOTH code tables" read against doc-02 (claim-surface.test.ts:1241-1251): the
 * statuses a code has in every `code | status` table and the exit the status table gives the first of them.
 */
function codeFacts(code: string, codes: readonly string[][], exits: readonly string[][]): CodeFacts {
	const statuses = [...new Set(codes.filter(([name]) => name === code).map(([, status]) => status ?? ""))];
	const exit = exits.find(([status]) => status === statuses[0])?.[1] ?? null;
	return { code, statuses, exit };
}

/** Whitespace collapsed and blockquote markers dropped, so a wrapped or quoted sentence still reads as one line. */
function normalized(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s*>\s?/, ""))
		.join(" ")
		.replace(/\s+/g, " ");
}

/** An example comment or a bash or sh block makes a scenario a checked workflow. */
function pinnedStep(line: string): boolean {
	return line.includes("<!-- example") || /^\s*```(?:bash|sh)/.test(line);
}

/** One server area, one project, private contexts made through the context API and the output collector. */
// adapted from claim-cli-administration.test.ts:1168-1422: the operator context is made before the project, so its
// authority ID can stand in the claims block; hooks, stores, copies and planted states are left out.
class EmergencyCase {
	private readonly outputs: Output[] = [];
	private readonly handles: Handle[] = [];
	private readonly roots = new Set<string>();

	private constructor(
		readonly format: ClaimStorageFormat,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly client: string,
		readonly project: string,
		readonly parent: string,
		readonly operator: Handle,
	) {
		this.handles.push(operator);
	}

	/** `area: false` leaves the endpoint uninitialized and writes no claims block (em-e03 needs neither). */
	static async create(format: ClaimStorageFormat, caseName: string, area: boolean): Promise<EmergencyCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-emergency-cli-${SENTINEL}-`));
		try {
			const { name, repo } = await gitServer().initRepository(root, `emergency-${SENTINEL}-${format}-${caseName}`);
			const url = gitServer().url(name);
			const parent = join(root, `contexts-${SENTINEL}`);
			await mkdir(parent);
			await chmod(parent, 0o700);
			const operator = await newContext(parent, undefined);
			const project = join(root, `project-${SENTINEL}`);
			await initProject(project, area ? claimsBlock(url, format, [operator.authorityId]) : undefined);
			const client = await initClient(join(root, "client"));
			if (area) await initializeArea(client, url, format);
			return new EmergencyCase(format, root, url, repo, client, project, parent, operator);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async context(): Promise<Handle> {
		return this.remember(await newContext(this.parent, undefined));
	}

	/** A replacement context holding `source`'s proof; its recovery binding and secret join the scan. */
	async recoveryContext(source: Handle): Promise<Handle> {
		return this.remember(await newContext(this.parent, source.directory));
	}

	/** Rewrites the claims block with `authorities` as the list; every CLI call reads the configuration fresh. */
	// adapted from claim-emergency-git.test.ts (EmergencyCase.writeBlock)
	async writeAuthorities(authorities: readonly string[]): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("the project configuration is missing");
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.url, this.format, authorities) });
	}

	/** Registers a context the CLI created, so its proofs, path and IDs join the scan. */
	async adopt(directory: string): Promise<Handle> {
		return this.remember(await handleOf(directory));
	}

	private remember(handle: Handle): Handle {
		this.handles.push(handle);
		return handle;
	}

	private async execute(args: readonly string[]): Promise<CliRun> {
		const run = await runCli(this.project, args);
		for (const oid of Object.values(await this.serverRefs())) this.roots.add(oid);
		return run;
	}

	/** One JSON-mode call in the project; the allowlist decides what the scan may see. */
	async json(args: readonly string[]): Promise<JsonRun> {
		const run = await this.execute([...args, "--json"]);
		const doc = parseDocument(run.stdout);
		const command = commandOf(args);
		const contextId = field(doc, "contextId");
		const allowedId = field(doc, "kind") === "claim-context" && typeof contextId === "string" ? contextId : null;
		const text = `${scannedText(doc, run.stdout)}${run.stderr}`;
		this.outputs.push({ command, text, allowedId, authorityAllowed: command === CONTEXT_SHOW });
		return { ...run, doc };
	}

	/** `backlog claim <words> --help`; the help text joins the scan like every other output. */
	async help(words: readonly string[]): Promise<CliRun> {
		const args = ["claim", ...words, "--help"];
		const run = await this.execute(args);
		this.outputs.push({
			command: `${commandOf(args)} --help`,
			text: `${run.stdout}${run.stderr}`,
			allowedId: null,
			authorityAllowed: false,
		});
		return run;
	}

	/**
	 * Labels of every sentinel in the collected output. A server root counts everywhere but in the
	 * preview's `root`, the owner everywhere but in list entries and the preview's `owner` (both dropped before), a
	 * context ID everywhere but in the context document of that context, an authority ID also there unless the output
	 * is `context show`.
	 */
	async leaks(): Promise<string[]> {
		const sentinels: Sentinel[] = [
			["sentinel", SENTINEL],
			["endpoint", this.url],
			["case root", this.root],
			["context parent", this.parent],
			["owner", OWNER],
		];
		for (const oid of this.roots) sentinels.push(["server root", oid]);
		for (const [index, handle] of this.handles.entries()) {
			const label = `context ${index + 1}`;
			sentinels.push([`${label} binding`, handle.binding], [`${label} secret`, handle.secret]);
			sentinels.push([`${label} path`, handle.directory]);
			if (handle.recoveryBinding !== null) sentinels.push([`${label} recovery binding`, handle.recoveryBinding]);
			if (handle.recoverySecret !== null) sentinels.push([`${label} recovery secret`, handle.recoverySecret]);
			for (const record of await records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			for (const [index, handle] of this.handles.entries()) {
				const own = handle.contextId === output.allowedId;
				if (!own && output.text.includes(handle.contextId)) labels.push(`context ${index + 1} id`);
				if (!(own && output.authorityAllowed) && output.text.includes(handle.authorityId)) {
					labels.push(`context ${index + 1} authority`);
				}
			}
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	// adapted from claim-cli-administration.test.ts:1366-1374
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await gitServer().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** The ticket's root as `git ls-remote` against the endpoint prints it: the operator's own check. */
	async lsRemote(ticket: string): Promise<string | null> {
		const ref = `refs/claims/${ticket}`;
		const listing = await gitServer().git(this.client, ["ls-remote", this.url, ref]);
		const line = listing.out.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
		return line?.split("\t")[0] ?? null;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

// adapted from claim-cli-administration.test.ts:1425-1437
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	area: boolean,
	body: (fixture: EmergencyCase) => Promise<void>,
): Promise<void> {
	const fixture = await EmergencyCase.create(format, caseName, area);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

for (const format of FORMATS) {
	describe(`claim emergency-release CLI over real Git (${format})`, () => {
		test(
			"em-e01: preview, release and list exit 0; the preview's root is the ls-remote root and printed nowhere else",
			async () => {
				await withCase(format, "e01", true, async (fixture) => {
					const { operator } = fixture;
					const holder = await fixture.context();
					// The holder's journal is empty.
					const acquired = await fixture.json(acquireArgs(TICKET, holder));
					const root = (await fixture.lsRemote(TICKET)) ?? ABSENT_ROOT;
					const refs = await fixture.serverRefs();
					const holderJournal = await dirSnapshot(join(holder.directory, "journal"));
					// The operator's journal is empty.
					const preview = await fixture.json(releaseArgs(TICKET, operator, "--preview"));
					// Positive control (catches: missing wiring; the scaffold's empty preview; a root other than the ref's,
					// e.g. the blob inside a tree or a commit; a missing or extra field; owner, generation or epoch read
					// wrongly). `harness`: ls-remote agrees with the server's for-each-ref, and the scanner finds a
					// planted sentinel.
					expect({
						acquired: outcomeOf(acquired),
						harness: {
							root: HEX40.test(root),
							agrees: refs[`refs/claims/${TICKET}`] === root,
							scanner: echoedIn(`planted ${SENTINEL}`, [["sentinel", SENTINEL]]),
						},
						preview: { exit: preview.exit, stderr: preview.stderr, doc: preview.doc },
					}).toEqual({
						acquired: APPLIED_STEP,
						harness: { root: true, agrees: true, scanner: ["sentinel"] },
						preview: { exit: 0, stderr: "", doc: previewOf(root) },
					});
					// catches: a preview that sends, writes or records anything.
					expect({ root: await fixture.lsRemote(TICKET), records: await recordNames(operator) }).toEqual({
						root,
						records: [],
					});
					const expectRoot = ["--expect-root", String(field(preview.doc, "root")), "--operation-id", RELEASE_ID];
					// The preview recorded nothing (checked above); the operator's journal is still empty.
					const release = await fixture.json(releaseArgs(TICKET, operator, ...expectRoot));
					const moved = (await fixture.lsRemote(TICKET)) ?? ABSENT_ROOT;
					// Read-only; the holder's own rights are what the former holder learns from its next list.
					const listing = await fixture.json(["claim", "list", "--ticket", TICKET, "--context", holder.directory]);
					// catches: the release refused, rejected or sent twice; a tombstone with another generation or an owner
					// (a reassignment); rights from the holder's view; the record in another journal or none; the
					// holder's journal written; a list that still shows the claim active.
					expect({
						release: operationView(release),
						rights: rightsFacts(release.doc),
						moved: HEX40.test(moved) && moved !== root,
						listing: listView(listing),
						stderr: [release.stderr, listing.stderr],
						operatorRecords: await recordNames(operator),
						holderJournal: await dirSnapshot(join(holder.directory, "journal")),
					}).toEqual({
						release: released(RELEASE_ID),
						rights: { ownership: "free", claimGeneration: 1, workRight: { kind: "none", cause: "free" } },
						moved: true,
						listing: {
							exit: 0,
							kind: "claim-list",
							status: "ok",
							complete: true,
							observed: true,
							claims: [{ ticket: TICKET, state: "free", owner: null, claimGeneration: 1, ownership: "free" }],
						},
						stderr: ["", ""],
						operatorRecords: [`${RELEASE_ID}.json`],
						holderJournal,
					});
					// catches: the root printed outside the preview's `root`: in another preview field, on stderr, in the
					// operation document or in the list.
					expect({
						previewField: field(preview.doc, "root") === root,
						previewElsewhere: JSON.stringify(withoutKeys(preview.doc, ["root"])).includes(root),
						previewStderr: preview.stderr.includes(root),
						operation: `${release.stdout}${release.stderr}`.includes(root),
						list: `${listing.stdout}${listing.stderr}`.includes(root),
					}).toEqual({
						previewField: true,
						previewElsewhere: false,
						previewStderr: false,
						operation: false,
						list: false,
					});
					// catches: a path, binding, secret, digest, context or authority ID, the endpoint, the owner name outside
					// its fields or any other server root in any output.
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("claim emergency-release CLI single-format cases (blob)", () => {
	test(
		"em-e02: applied 0, authority-required and expectation-required 5, stale-root 2; retry re-checks the authority",
		async () => {
			await withCase("blob", "e02", true, async (fixture) => {
				const { operator } = fixture;
				const holder = await fixture.context();
				const unlisted = await fixture.context();
				// The holder's journal is empty.
				const first = await fixture.json(acquireArgs(TICKET, holder));
				// Another ticket.
				const second = await fixture.json(acquireArgs(SECOND, holder));
				const firstRoot = (await fixture.lsRemote(TICKET)) ?? ABSENT_ROOT;
				const secondRoot = (await fixture.lsRemote(SECOND)) ?? ABSENT_ROOT;
				// The operator's journal is empty.
				const control = await fixture.json(
					releaseArgs(TICKET, operator, "--expect-root", firstRoot, "--operation-id", CONTROL_ID),
				);
				// Positive control (catches: missing wiring; the scaffold's fixed plan rejection; a listed operator refused;
				// an exit code other than 0 for applied).
				expect({ first: outcomeOf(first), second: outcomeOf(second), control: operationView(control) }).toEqual({
					first: APPLIED_STEP,
					second: APPLIED_STEP,
					control: released(CONTROL_ID),
				});
				const before = await fixture.serverRefs();
				// The unlisted context's journal is empty. The root is SECOND's current one, so a surface without the
				// authority check would release SECOND here.
				const foreign = await fixture.json(releaseArgs(SECOND, unlisted, "--expect-root", secondRoot));
				// The operator has no record on SECOND (its only record concerns TICKET).
				const bare = await fixture.json(releaseArgs(SECOND, operator));
				// As above; the refusal before recorded nothing.
				const both = await fixture.json(releaseArgs(SECOND, operator, "--preview", "--expect-root", secondRoot));
				const afterRefusals = await fixture.serverRefs();
				// The holder's record on SECOND expects the absent ref, which its acquire replaced.
				const renewed = await fixture.json(["claim", "renew", SECOND, "--context", holder.directory]);
				const renewedRoot = await fixture.lsRemote(SECOND);
				// The operator still has no record on SECOND; the refusals recorded nothing.
				const stale = await fixture.json(releaseArgs(SECOND, operator, "--expect-root", secondRoot));
				// catches: the authority check skipped or run after the network (the unlisted context would release
				// SECOND); a missing --expect-root taken as a preview, --preview beside --expect-root taken as a release;
				// a stale root planned anyway, recorded, or reported as a storage rejection or as
				// generation-changed; any refusal that records, sends or moves a ref.
				expect({
					foreign: operationView(foreign),
					bare: operationView(bare),
					both: operationView(both),
					refsKept: afterRefusals,
					renewed: outcomeOf(renewed),
					renewedMoved: renewedRoot !== null && renewedRoot !== secondRoot,
					stale: operationView(stale),
					staleKept: await fixture.lsRemote(SECOND),
					unlistedRecords: await recordNames(unlisted),
					operatorRecords: await recordNames(operator),
				}).toEqual({
					foreign: refused("authority-required"),
					bare: refused("expectation-required"),
					both: refused("expectation-required"),
					refsKept: before,
					renewed: APPLIED_STEP,
					renewedMoved: true,
					stale: staleRoot(),
					staleKept: renewedRoot,
					unlistedRecords: [],
					operatorRecords: [`${CONTROL_ID}.json`],
				});
				// Only the CLI sets {administrative: true}, after re-running the authority check. The
				// control release landed, so a permitted retry only clarifies it (stored → applied, nothing sent,
				// execution/index.ts resendClaimIntent); taken off the list, the same operator is refused.
				const refsBeforeRetry = await fixture.serverRefs();
				const retried = await fixture.json(["claim", "retry", CONTROL_ID, "--context", operator.directory]);
				await fixture.writeAuthorities([unlisted.authorityId]);
				const delisted = await fixture.json(["claim", "retry", CONTROL_ID, "--context", operator.directory]);
				const retriedView: Record<string, unknown> = {
					...outcomeOf(retried),
					sends: field(retried.doc, "sends") ?? null,
				};
				const delistedView: Record<string, unknown> = {
					...outcomeOf(delisted),
					code: field(delisted.doc, "code") ?? null,
				};
				// catches: claim.ts never passing the option, so a listed operator can never retry a release; the option
				// passed without the check, so a revoked operator still resends; a retry that sends or records.
				expect({
					retried: retriedView,
					delisted: delistedView,
					refs: await fixture.serverRefs(),
					operatorRecords: await recordNames(operator),
				}).toEqual({
					retried: { exit: 0, kind: "claim-operation", status: "applied", sends: 0 },
					delisted: { exit: 5, kind: "claim-error", status: "refused", code: "authority-required" },
					refs: refsBeforeRetry,
					operatorRecords: [`${CONTROL_ID}.json`],
				});
				// catches: a path, binding, secret, digest, context or authority ID, the endpoint, the owner name or a
				// server root in any output.
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"em-e03: both new helps document their options and document; context show prints the ID and its authority only",
		async () => {
			await withCase("blob", "e03", false, async (fixture) => {
				const release = await fixture.help([RELEASE]);
				const resolve = await fixture.help(["resolve"]);
				// Positive control (catches: the scaffold's empty help; an option without its
				// schema line; the preview or operation document unnamed). `parser`, the harness control: `claim resolve`
				// registers --context and the output pair (claim.ts:754-755, :317-319), Commander adds --help.
				expect({
					release: helpFacts(release, RELEASE_FIELDS, RELEASE_KINDS),
					parser: optionsOf(resolve.stdout),
				}).toEqual({ release: DOCUMENTED, parser: ["--context", ...SHARED_OPTIONS].sort(byCodeUnits) });
				const show = await fixture.help(["context", "show"]);
				// catches: any further option on emergency-release (--owner, --ttl-ms, --expect-generation, a force flag or
				// a token); context show without its schema lines, sections or document kind.
				expect({ options: optionsOf(release.stdout), show: helpFacts(show, SHOW_FIELDS, ["claim-context"]) }).toEqual({
					options: [...RELEASE_OPTIONS, ...SHARED_OPTIONS].sort(byCodeUnits),
					show: DOCUMENTED,
				});
				const plain = await fixture.context();
				const source = await fixture.context();
				const recovered = await fixture.recoveryContext(source);
				const shownPlain = await fixture.json(showArgs(plain));
				const shownRecovered = await fixture.json(showArgs(recovered));
				const made = await fixture.json(["claim", "context", "create", "--parent", fixture.parent]);
				await fixture.adopt(join(fixture.parent, createdId(made)));
				// catches: an authority ID from another derivation, from the recovery secret or from the binding; any
				// further field of the context (binding, path, journal, recovery); an authority ID in `context create`,
				// whose exact key set is pinned by base cli-01.
				expect({ plain: shownView(shownPlain), recovered: shownView(shownRecovered), made: madeView(made) }).toEqual({
					plain: { exit: 0, stderr: "", doc: shownDocument(plain) },
					recovered: { exit: 0, stderr: "", doc: shownDocument(recovered) },
					made: CONTEXT_MADE,
				});
				// catches: a binding, secret, recovery proof, path, the source's or another context's ID or authority ID
				// in any output, help included.
				expect(await fixture.leaks()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim emergency-release documentation (no project)", () => {
	test(
		"doc-e01a: the guide and CLAIMS.md carry the release section, codes, cause, sentence, point and a prose scenario",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-emergency-docs-"));
			try {
				const guide = await runCli(cwd, ["instructions", "claims"]);
				const lines = guide.stdout.split("\n");
				// Positive control (catches: a guide without the emergency release section; the scaffold leaves the guide as
				// is).
				expect({
					exit: guide.exit,
					section: headingsOf(lines).some((heading) => heading.title === SECTION),
				}).toEqual({ exit: 0, section: true });
				const codes = tableRows(guide.stdout, "code", "status");
				const exits = tableRows(guide.stdout, "status", "exit");
				// catches: a new code missing from the code table or listed with another status or exit (doc-02
				// compares the tables with the constants); `stale-root` missing from the plan cause list; a new
				// command missing from the command list; the mandatory sentence reworded.
				expect({
					codes: NEW_CODES.map((code) => codeFacts(code, codes, exits)),
					staleRoot: lines.some((line) => STALE_ROOT_BULLET.test(line)),
					commands: GUIDE_COMMANDS.filter((command) => !guide.stdout.includes(command)),
					sentence: normalized(guide.stdout).includes(RELEASE_SENTENCE),
				}).toEqual({
					codes: NEW_CODES.map((code) => ({ code, statuses: ["refused"], exit: "5" })),
					staleRoot: true,
					commands: [],
					sentence: true,
				});
				const claims = await readFile(CLAIMS_PATH, "utf8");
				const claimLines = claims.split("\n");
				const headings = headingsOf(claimLines);
				const notDo = headings.find((heading) => heading.level === 2 && heading.title === NOT_DO);
				const scenarios = headings
					.filter((heading) => heading.level === 3 && !BASE_SECTIONS.includes(heading.title))
					.map((heading) => ({ title: heading.title, body: sectionOf(claimLines, heading) }))
					.filter((scenario) => scenario.body.join("\n").includes(RELEASE));
				// catches: CLAIMS.md without the sentence or without the new "What claims do not do" point; no new
				// scenario naming the command; a scenario with an example comment or a bash or sh block, which the
				// suite would run or reject.
				expect({
					sentence: normalized(claims).includes(RELEASE_SENTENCE),
					notDo: sectionOf(claimLines, notDo).some((line) => NO_REASSIGNMENT.test(line)),
					scenarios: scenarios.length > 0,
					pinned: scenarios.filter((scenario) => scenario.body.some(pinnedStep)).map((scenario) => scenario.title),
				}).toEqual({ sentence: true, notDo: true, scenarios: true, pinned: [] });
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
