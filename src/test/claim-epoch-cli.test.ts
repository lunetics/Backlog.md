/**
 * Epoch swap, level E (ep-e01, ep-e02, doc-e01b): the real `backlog claim install-epoch …`,
 * `backlog claim init|list|acquire|release …` and `backlog instructions claims` subprocesses in a real Backlog project
 * against the loopback Git daemon (ep-e01 for blob, tree and commit-chain; ep-e02 with blob, once over Git and once
 * against a stalled endpoint). The operator is a private context made through the context API; the test derives its
 * authority ID on its own, as claim-emergency-cli.test.ts does, and lists it in `claims.recovery_authorities`. A breach
 * is a foreign ref that a test-local post-receive hook of the server repository creates while the swap's descriptor
 * push is still open, so it exists before the run's last listing. Every stdout and stderr is scanned for the sentinel
 * in every path, the endpoint, every server root (allowed nowhere: install-epoch prints no root), the owner name
 * (allowed only in list entries), bindings, secrets, context paths, journal digests, context and authority IDs,
 * maintenance receipt IDs and Git's own stderr wording. The CLI runs on the real clock; no expectation depends on it.
 * Every test starts with a positive control the scaffold cannot satisfy. The open document forms sit each in one
 * ASSUMPTION(scaffold) helper right below the types. The harness is an adapted copy of claim-emergency-cli.test.ts; the
 * Git fixture is used unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createClaimContext } from "../claims/context/index.ts";
import { type ClaimStorageFormat, initializeClaimStorage } from "../claims/storage/index.ts";
import { CLAIM_ERROR_CODES, CLAIM_EXIT_CODES, type ClaimErrorCode } from "../claims/surface/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { compareTaskIds } from "../utils/task-sorting.ts";
import { GitFixtureServer, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-emergency-cli.test.ts:39-97: the status union, the run types and the Handle without recovery
// proofs (install-epoch makes no recovery context); the operation, help-context and preview views of the emergency
// release give way to the epoch comparisons; an output carries no allowance (install-epoch prints no context ID and no
// authority ID).
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
type Handle = { directory: string; contextId: string; binding: string; secret: string; authorityId: string };
type Output = { command: string; text: string };
type JournalDigests = { digest: string; parameterDigest: string };
/** Missing help sections, unnamed documents and options without a schema line (help-schema.ts:30-35, :49-77). */
type HelpFacts = { exit: number; missing: string[]; kinds: string[]; fields: string[] };
/** A Markdown heading and the line where its section ends (the next heading of the same or a higher level). */
type Heading = { level: number; title: string; line: number; end: number };
/** The statuses a code has in the code tables and the exit its status has in the status table. */
type CodeFacts = { code: string; statuses: string[]; exit: string | null };
/** An actual run beside the expectation it is compared with; one ASSUMPTION(scaffold) helper builds both. */
type Comparison = { actual: unknown; expected: unknown };
/** For a run that installed its epoch; the ticket lists in any order (the helper sorts them). */
type Installed = {
	status: "applied" | "unknown";
	fromEpoch: number;
	epoch: number;
	format: ClaimStorageFormat;
	previousFormat: ClaimStorageFormat;
	rewritten: readonly string[];
	created: readonly string[];
	breached: readonly string[];
	unsettled: readonly string[];
};
/** A run that wrote nothing. */
type Rejected = { status: "rejected"; cause: "epoch-changed" | "writes-observed" };
/** `--preview`; the ticket lists in any order. */
type Previewed = {
	epoch: number;
	format: ClaimStorageFormat;
	listed: readonly string[];
	toCreate: readonly string[];
	unreadable: readonly string[];
};
/** `area`: a server repository with an initialized area; `stalled`: that endpoint, never initialized. */
type Endpoint = { kind: "area" } | { kind: "stalled"; url: string };

// ---------------------------------------------------------------------------------------------------------------
// ASSUMPTION(scaffold): the open document forms, each in exactly one helper; another
// decision changes only that helper. The seams of ep-g06 and ep-g11 do not reach a subprocess.
// ---------------------------------------------------------------------------------------------------------------

/** ASSUMPTION(scaffold): every install-epoch document opens with this envelope; `command` is the verb. */
function envelope(kind: string, status: Status): Record<string, unknown> {
	return { schemaVersion: 1, kind, status, command: INSTALL };
}

/**
 * ASSUMPTION(scaffold): `claim-epoch` holds the envelope and exactly the fields: `rewritten`,
 * `created`, `breached` and `unsettled` are ticket lists sorted like `claim list`. A `rejected` one adds `cause`
 * on the top level and keeps its lists empty; for it only kind, status, cause and the exit are compared.
 */
function epochResult(run: JsonRun, facts: Installed | Rejected): Comparison {
	if (facts.status === "rejected") {
		const { doc } = run;
		return {
			actual: {
				exit: run.exit,
				stderr: run.stderr,
				kind: field(doc, "kind") ?? null,
				status: field(doc, "status") ?? null,
				cause: field(doc, "cause") ?? null,
			},
			expected: { exit: EXIT.rejected, stderr: "", kind: EPOCH_KIND, status: "rejected", cause: facts.cause },
		};
	}
	const doc = {
		...envelope(EPOCH_KIND, facts.status),
		fromEpoch: facts.fromEpoch,
		epoch: facts.epoch,
		format: facts.format,
		previousFormat: facts.previousFormat,
		rewritten: sorted(facts.rewritten),
		created: sorted(facts.created),
		breached: sorted(facts.breached),
		unsettled: sorted(facts.unsettled),
		isolation: "attested",
	};
	return {
		actual: { exit: run.exit, stderr: run.stderr, doc: run.doc },
		expected: { exit: EXIT[facts.status], stderr: "", doc },
	};
}

/**
 * ASSUMPTION(scaffold): `claim-epoch-preview` holds the envelope with status `ok` (it sends and writes nothing, like
 * the emergency release preview) and exactly these fields: `epoch` is the epoch a run would install (N+1), `format`
 * the target format, `listed`, `toCreate` and `unreadable` ticket lists sorted like `claim list`.
 */
function previewResult(run: JsonRun, facts: Previewed): Comparison {
	const doc = {
		...envelope(EPOCH_PREVIEW_KIND, "ok"),
		epoch: facts.epoch,
		format: facts.format,
		listed: sorted(facts.listed),
		toCreate: sorted(facts.toCreate),
		unreadable: sorted(facts.unreadable),
	};
	return {
		actual: { exit: run.exit, stderr: run.stderr, doc: run.doc },
		expected: { exit: EXIT.ok, stderr: "", doc },
	};
}

/**
 * ASSUMPTION(scaffold): a `claim-list` entry carries `epoch`, the epoch of the store,
 * exactly beside `claimGeneration`; an `unknown` entry carries none. Every entry this file expects is a free one
 * read without `--context` (surface/index.ts:3070): ticket, state, generation and the epoch, nothing else.
 */
function listEntry(ticket: string, claimGeneration: number, epoch: number): Record<string, unknown> {
	return { ticket, state: "free", claimGeneration, epoch };
}

// adapted from claim-emergency-cli.test.ts:99-238
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 120_000;
/** attempt_timeout_ms, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms against the stalled endpoint (claim-cli-administration.test.ts:128). */
const STALL_TIMEOUT = 750;
const MINUTE = 60_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
/** Appears in case, project, context and endpoint paths and in the planting hook's stderr; no output may contain it. */
const SENTINEL = "SENTINEL-epoch-7c41";
/** Owner of every acquired claim; a display name, allowed only in list entries. */
const OWNER = "agent-owner-epoch";
/** Acquired by the holder: ACTIVE when the epoch is installed. */
const ACTIVE = "BACK-1";
/** Acquired and released by the holder: FREE with generation 1 when the epoch is installed. */
const FREED = "BACK-2";
/** A local task without a claim ref: in the creation set M. */
const BARE = "BACK-3";
/** The local task corpus of every project. */
const CORPUS = [ACTIVE, FREED, BARE];
/** Named with `--ticket`, neither a local task nor a ref: in M as well. */
const EXTRA = "BACK-7";
/** Neither local nor named: the ticket a foreign writer creates after the swap. */
const FOREIGN = "BACK-9";
/** The verb. */
const INSTALL = "install-epoch";
const INSTALL_COMMAND = "backlog claim install-epoch";
/** The two document kinds of install-epoch. */
const EPOCH_KIND = "claim-epoch";
const EPOCH_PREVIEW_KIND = "claim-epoch-preview";
/** . */
const EPOCH_CHANGED = "epoch-changed";
/** The descriptor ref the swap moves (storage/index.ts:68). */
const DESCRIPTOR_REF = "refs/claim-meta/format";
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
/** errorDocument (surface/index.ts:1433-1457) of a code without problems, formats or dependencies. */
const ERROR_KEYS = ["code", "command", "kind", "message", "operationId", "schemaVersion", "status", "ticket"].sort(
	byCodeUnits,
);
/** Exit, kind and status of a setup step the reference CLI applied (acquire, release). */
const APPLIED_STEP: Record<string, unknown> = { exit: 0, kind: "claim-operation", status: "applied" };
/** A maintenance receipt key, `m-` and a UUID; the receipt stays in the store, never in an output. */
const RECEIPT_ID = /\bm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
/** A key of that form for the scanner's positive control; no store holds it. */
const PLANTED_RECEIPT = "m-00000000-0000-4000-8000-000000000000";
/** Git's own push and error wording (never Git stderr); no output may forward it. */
const GIT_STDERR: readonly Sentinel[] = [
	["git stderr", "fatal:"],
	["git stderr", "remote:"],
	["git stderr", "[rejected]"],
	["git stderr", "[remote rejected]"],
	["git stderr", "stale info"],
];
/** help-schema.ts:50, :70, :73: the sections addHelpSchema writes. */
const HELP_SECTIONS = ["Input schema:", "Output:", "Examples:"];
/** Each option has its own schema line (convention, as em-e03). */
const INSTALL_FIELDS = [
	"--context",
	"--expect-epoch",
	"--isolation-confirmed",
	"--storage-format",
	"--ticket",
	"--preview",
	"--json",
];
/** The options of `claim install-epoch` besides the shared ones. */
const INSTALL_OPTIONS = [
	"--context",
	"--expect-epoch",
	"--isolation-confirmed",
	"--storage-format",
	"--ticket",
	"--preview",
];
/** The two documents the command prints besides claim-error. */
const INSTALL_KINDS = [EPOCH_PREVIEW_KIND, EPOCH_KIND];
/**
 * Harness fact, measured in ep-e01 on `claim resolve --help` (claim.ts:811-825): every claim command carries the output
 * pair of withOutputOptions (claim.ts:344-346), and Commander adds its help option.
 */
const SHARED_OPTIONS = ["--help", "--json", "--plain"];
/** Commander's option lines: two spaces, then `-x, --name` or `--name` (Help.formatItem, item indent 2). */
const OPTION_LINE = /^ {2}(?:-[A-Za-z], )?(--[a-z][a-z0-9-]*)/;
/** The guide section the emergency release opened and the epoch swap continues. */
const SECTION = "Emergency release and new epochs";
/** Verbatim; compared with whitespace collapsed. */
const QUIESCENCE_SENTENCE = [
	"None of these proves that no write is still in flight: deleting refs, an empty `claim list`, a client timeout, or",
	"two scans that show the same refs. `--isolation-confirmed` records your statement in every new claim; it proves",
	"nothing either.",
].join(" ");
/**
 * Sentence 2 as re-pinned after GREEN: the verbatim sentence said `unknown` for a difference
 * between the listings, and ep-g06 say `rejected` with nothing written for L1 against L2. Re-pinned
 * in the claims close-out: the last listing ends `unknown` on a foreign ticket ref or on a
 * changed count of names under refs/claims/* that are no ticket ID (surface/index.ts compares the count only); such
 * names that stood before the run end `applied` (ep-g12, unchanged).
 */
const DETECTION_SENTENCE = [
	"`install-epoch` detects some writes that break isolation, never all. A difference between its first two listings",
	"ends the run `rejected` with nothing written; a ticket ref in its last listing that the run did not write, or a",
	"change in the number of names under `refs/claims/*` that are no ticket ID, ends `unknown`; such names that stood",
	"before the run are counted and left alone; no difference is no evidence.",
].join(" ");
/**
 * Sentence 3 as re-pinned after the qualification run (it replaced "No Git host is qualified for this path yet.
 * The loopback fixture of the test suite is no qualification." with the measured host paragraph in CLAIMS.md and the
 * guide): the paragraph from "in Linux containers" to "on a host where:", verbatim in both. Both documents now open
 * it with "This path was measured" (CLAIMS.md named the qualification ticket as the subject until the ticket ids
 * left the shipped documents); the pin starts after the subject, so the two stay in step on the measured paragraph.
 * The hosting conditions follow it as a list (sectionsHolding below).
 */
const QUALIFICATION_SENTENCE = [
	"in Linux containers against a plain Git 2.47.3 server (`git daemon`, `git http-backend`, OpenSSH 10.0p2) and Gitea",
	"1.24.7 (its HTTP and built-in SSH server), with clients running Git 2.47.3: both hosts accept, list and keep",
	"`refs/claims/*` and `refs/claim-meta/*` in all three storage formats, through the host's garbage collection too. On",
	"the plain Git server, `install-epoch` behaved as described above: over `https://` and `ssh://`, an old-epoch write",
	"released after the swap ended `rejected` and one that landed between the swap and the rewrite left the run",
	"`unknown` with that ticket unreadable until a rerun settled it; over `ssh://`, a restore followed by `install-epoch`",
	"freed every ticket. That qualifies no host's isolation: no host was shown to cut off the write paths for you, and",
	"the path is not qualified on a host where:",
].join(" ");
const SENTENCES = [QUIESCENCE_SENTENCE, DETECTION_SENTENCE, QUALIFICATION_SENTENCE];
/** The causes of claim-epoch, the codes install-epoch refuses with and the rerun flag. */
const SECTION_TERMS = [
	EPOCH_CHANGED,
	"writes-observed",
	"isolation-unconfirmed",
	"authority-required",
	"--expect-epoch",
];
/** The emergency release placeholder (claims.md:541-542) the epoch section replaces. */
const PLACEHOLDER = "follow in a later version";
/** The codes install-epoch refuses with. */
const EPOCH_CODES: readonly ClaimErrorCode[] = ["authority-required", "isolation-unconfirmed"];
/** ep-e02: `--expect-epoch` values Number() reads as 1 and a digits-only parser refuses. */
const LENIENT_EPOCHS = ["0x1", "1e0", "+1"];
/** The statuses of claim-epoch, claim-epoch-preview and the refusals. */
const EPOCH_STATUSES: readonly Status[] = ["ok", "applied", "rejected", "unknown", "refused"];
/** CLAIMS.md:821: the section the new hosting text extends; its bullets lead with a bold head (CLAIMS.md:823-856). */
const NOT_DO = "What claims do not do";
const NO_QUIESCENCE = /^- \*\*No quiescence proof\.?\*\*/;
/** CLAIMS.md:503: the level-2 section whose level-3 recipes wf-doc-01 does not read. */
const RECIPES = "Recipes";
/** The doc rule; compared case-insensitively with whitespace collapsed. */
const GENERATION_RULE = "compare generations only within an epoch";
/** Restore recipe: the command words of the steps `resolve`, `install-epoch --preview` and the run. */
const RECIPE_STEPS = ["resolve", "--preview", "--expect-epoch", "--isolation-confirmed"];
/** The five hosting conditions, each by words of the contract. */
const HOSTING: readonly (readonly [label: string, pattern: RegExp])[] = [
	["writes and ref creation not restricted to the run", /refs\/claim-meta\//],
	["pushes past a new gate", /\bgate\b/i],
	["replicas or mirrors replicating asynchronously", /\basynchronous/i],
	["refs outside branches and tags rejected, hidden or pruned", /\bbranches and tags\b/i],
	["older clients reading every epoch but 1 as unreadable", /\bolder Backlog\.md\b/i],
];
/** A Markdown list item: `-`, `*` or `1.` at any indentation. */
const BULLET = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;
/**
 * The level-3 headings of CLAIMS.md at the base (after the emergency release, CLAIMS.md:72-769); a level-3 heading not
 * in it is new.
 */
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
	"Free a claim whose holder is gone",
	"S6 Lost reply",
	"S15 A witnessed transition",
	"S8 Replace a crashed agent",
	"S10 Clean up after a departed agent",
	"S11 Errors an agent meets",
];
const CLAIMS_PATH = join(import.meta.dir, "..", "..", "CLAIMS.md");

// adapted from claim-emergency-cli.test.ts:240-254
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

// adapted from claim-emergency-cli.test.ts:256-260
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Ticket lists in the order of `claim list`. */
function sorted(list: readonly string[]): string[] {
	return [...list].sort(compareTaskIds);
}

/** `prefix` + SHA-256 over the domain and the secret's bytes, read as context/index.ts:129-136 reads them. */
// adapted from claim-emergency-cli.test.ts:267-271
function derivedId(prefix: string, domain: string, secret: string): string {
	const hash = createHash("sha256").update(domain, "utf8");
	return `${prefix}${hash.update(Buffer.from(secret, "hex")).digest("hex")}`;
}

// adapted from claim-emergency-cli.test.ts:278-282
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-emergency-cli.test.ts:284-287
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-emergency-cli.test.ts:289-293
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-emergency-cli.test.ts:295-298
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-emergency-cli.test.ts:305-309
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-emergency-cli.test.ts:311-315
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-emergency-cli.test.ts:317-321
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The label of an output in the scan: the claim verb (no context verb runs through the CLI here). */
// adapted from claim-emergency-cli.test.ts:323-328
function commandOf(args: readonly string[]): string {
	return args[0] === "claim" ? (args[1] ?? "") : (args[0] ?? "");
}

// adapted from claim-emergency-cli.test.ts:330-337
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

// adapted from claim-emergency-cli.test.ts:339-342
function withoutKeys(doc: unknown, keys: readonly string[]): unknown {
	if (!isRecord(doc)) return doc;
	return Object.fromEntries(Object.entries(doc).filter(([key]) => !keys.includes(key)));
}

/** Owner names are display data in list entries; the collector drops them there before scanning. */
// adapted from claim-emergency-cli.test.ts:344-350
function withoutOwners(doc: unknown): unknown {
	const claims = field(doc, "claims");
	if (!Array.isArray(claims) || !isRecord(doc)) return doc;
	return { ...doc, claims: claims.map((item: unknown) => withoutKeys(item, ["owner"])) };
}

/** Allowlist: the owner name only in list entries; install-epoch prints no root, so nothing else is dropped. */
// adapted from claim-emergency-cli.test.ts:352-361
function scannedText(doc: unknown, stdout: string): string {
	return field(doc, "kind") === "claim-list" ? JSON.stringify(withoutOwners(doc)) : stdout;
}

/** A claim-error with its exact key set; the message is never compared. */
function errorView(run: JsonRun): Record<string, unknown> {
	const { doc } = run;
	return {
		exit: run.exit,
		keys: keysOf(doc),
		schemaVersion: field(doc, "schemaVersion") ?? null,
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		command: field(doc, "command") ?? null,
		code: field(doc, "code") ?? null,
	};
}

/** An install-epoch refusal or a failed preflight is a claim-error without ticket or operation ID. */
function failed(status: Status, code: ClaimErrorCode): Record<string, unknown> {
	return { exit: EXIT[status], keys: ERROR_KEYS, ...envelope("claim-error", status), code };
}

// adapted from claim-emergency-cli.test.ts:438-440
function outcomeOf(run: JsonRun): Record<string, unknown> {
	return { exit: run.exit, kind: field(run.doc, "kind") ?? null, status: field(run.doc, "status") ?? null };
}

/** claimInitDocument (surface/index.ts:1844-1860) for an area that already exists. */
function initDocument(format: ClaimStorageFormat, epoch: number): Record<string, unknown> {
	return { schemaVersion: 1, kind: "claim-init", status: "ok", command: "init", result: "exists", format, epoch };
}

// adapted from claim-emergency-cli.test.ts:468-487: the entries stay whole, so listEntry pins their exact fields
function listView(run: JsonRun): Record<string, unknown> {
	return {
		exit: run.exit,
		kind: field(run.doc, "kind") ?? null,
		status: field(run.doc, "status") ?? null,
		complete: field(run.doc, "complete") ?? null,
		claims: field(run.doc, "claims") ?? null,
	};
}

/**
 * The long option names of Commander's `Options:` block, which ends at its first empty line. Wrapped description
 * lines are indented past the term column and never match; the schema lines of help-schema.ts (`  - <name>: …`)
 * follow the block and never match either.
 */
// adapted from claim-emergency-cli.test.ts:489-505
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

/** A kind named as a whole word: `claim-epoch` inside `claim-epoch-preview` does not count. */
function mentions(text: string, kind: string): boolean {
	return new RegExp(`(?<![a-z-])${kind}(?![a-z-])`).test(text);
}

/** Commander lists every registered option anyway; only the help schema writes `  - <name>: <type>` lines. */
// adapted from claim-emergency-cli.test.ts:507-517: a kind counts only as a whole word
function helpFacts(run: CliRun, fields: readonly string[], kinds: readonly string[]): HelpFacts {
	const text = `${run.stdout}${run.stderr}`;
	return {
		exit: run.exit,
		missing: HELP_SECTIONS.filter((section) => !text.includes(section)),
		kinds: kinds.filter((kind) => !mentions(text, kind)),
		fields: fields.filter((name) => !text.includes(`- ${name}:`)),
	};
}

// adapted from claim-emergency-cli.test.ts:519-520
const DOCUMENTED: HelpFacts = { exit: 0, missing: [], kinds: [], fields: [] };

/**
 * The surface keys plus the recovery authority list, written last like its place in SCHEMA_KEYS
 * (config/index.ts:171-190).
 */
// adapted from claim-emergency-cli.test.ts:557-577: the attempt timeout is a parameter (the stalled endpoint)
function claimsBlock(
	endpoint: string,
	format: ClaimStorageFormat,
	authorities: readonly string[],
	timeoutMs: number,
): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${format}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${timeoutMs}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
		"  recovery_authorities:",
		...authorities.map((id) => `    - ${JSON.stringify(id)}`),
	].join("\n");
}

// adapted from claim-emergency-cli.test.ts:579-585
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await gitServer().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the corpus BACK-1 to BACK-3, the claims block and one commit. */
// adapted from claim-emergency-cli.test.ts:587-613: three tasks instead of two
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim epoch CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const ticket of CORPUS) {
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
// adapted from claim-emergency-cli.test.ts:615-620
async function initializeArea(client: string, url: string, format: ClaimStorageFormat): Promise<void> {
	const options = { repository: client, remote: url, format, timeoutMs: ADAPTER_TIMEOUT };
	expectKind(await initializeClaimStorage(options), "created");
}

/**
 * The private record of a context (context/index.ts:33-38) with the authority ID it derives: `ta1-` +
 * SHA-256 over `backlog.md/claim-authority/v1\0` and the secret bytes. The guard proves that the test reads the
 * secret bytes as the binding derivation does (context/index.ts:129-136).
 */
// adapted from claim-emergency-cli.test.ts:622-650 and :273-276 (authorityOf); no recovery proofs
async function handleOf(directory: string): Promise<Handle> {
	const record: unknown = JSON.parse(await readFile(join(directory, "context.json"), "utf8"));
	const contextId = field(record, "contextId");
	const binding = field(record, "binding");
	const secret = field(record, "secret");
	if (typeof contextId !== "string" || typeof binding !== "string" || typeof secret !== "string") {
		throw new Error("the private record has no string context ID, binding or secret");
	}
	if (derivedId("tb1-", "backlog.md/claim-context/v1\0", secret) !== binding) {
		throw new Error("the test reads the secret bytes otherwise than the binding derivation");
	}
	const authorityId = derivedId("ta1-", "backlog.md/claim-authority/v1\0", secret);
	return { directory, contextId, binding, secret, authorityId };
}

/** A context through the context API (context/index.ts:201-256), never through the CLI under test. */
// adapted from claim-emergency-cli.test.ts:652-658: no recovery source
async function newContext(parent: string): Promise<Handle> {
	const { context } = expectKind(await createClaimContext({ parent }), "created");
	return handleOf(dirname(context.journalDirectory));
}

/** Digests of one context's journal records; `.intent-*.tmp` names and `.admission-*` slots are ignored. */
// adapted from claim-emergency-cli.test.ts:660-672
async function records(handle: Handle): Promise<JournalDigests[]> {
	const journal = join(handle.directory, "journal");
	const found: JournalDigests[] = [];
	for (const name of (await readdir(journal)).sort(byCodeUnits)) {
		if (name.startsWith(".") || !name.endsWith(".json")) continue;
		const record: unknown = JSON.parse(await readFile(join(journal, name), "utf8"));
		found.push({ digest: String(field(record, "digest")), parameterDigest: String(field(record, "parameterDigest")) });
	}
	return found;
}

// adapted from claim-emergency-cli.test.ts:697-700
function acquireArgs(ticket: string, handle: Handle): string[] {
	return ["claim", "acquire", ticket, "--owner", OWNER, "--context", handle.directory];
}

/** The operator's context, the expected epoch and the statement; `--ticket` and `--preview` follow. */
function installArgs(handle: Handle, expectEpoch: number, ...extra: string[]): string[] {
	const statement = ["--expect-epoch", String(expectEpoch), "--isolation-confirmed"];
	return ["claim", INSTALL, "--context", handle.directory, ...statement, ...extra];
}

// adapted from claim-cli.test.ts:280-282
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** ATX headings outside fenced blocks; a section ends at the next heading of the same or a higher level. */
// adapted from claim-emergency-cli.test.ts:711-730
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

// adapted from claim-emergency-cli.test.ts:732-734
function sectionOf(lines: readonly string[], heading: Heading | undefined): string[] {
	return heading === undefined ? [] : lines.slice(heading.line + 1, heading.end);
}

// adapted from claim-emergency-cli.test.ts:736-744
function cells(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return [];
	return trimmed
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.replaceAll("`", "").trim());
}

/** Rows of every Markdown table whose first two header cells are `first` and `second`, as doc-02 reads them. */
// adapted from claim-emergency-cli.test.ts:746-759
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

/** The statuses a code has in every `code | status` table and the exit the status table gives the first of them. */
// adapted from claim-emergency-cli.test.ts:761-769
function codeFacts(code: string, codes: readonly string[][], exits: readonly string[][]): CodeFacts {
	const statuses = [...new Set(codes.filter(([name]) => name === code).map(([, status]) => status ?? ""))];
	const exit = exits.find(([status]) => status === statuses[0])?.[1] ?? null;
	return { code, statuses, exit };
}

/** Whitespace collapsed and blockquote markers dropped, so a wrapped or quoted sentence still reads as one line. */
// adapted from claim-emergency-cli.test.ts:771-778
function normalized(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s*>\s?/, ""))
		.join(" ")
		.replace(/\s+/g, " ");
}

/** An example comment or a bash or sh block makes a scenario a checked workflow. */
// adapted from claim-emergency-cli.test.ts:780-783
function pinnedStep(line: string): boolean {
	return line.includes("<!-- example") || /^\s*```(?:bash|sh)/.test(line);
}

/**
 * The innermost sections whose text holds `sentence` (whitespace collapsed); the contract lists the hosts beside it.
 */
function sectionsHolding(lines: readonly string[], headings: readonly Heading[], sentence: string): Heading[] {
	const holding = headings.filter((heading) => normalized(sectionOf(lines, heading).join("\n")).includes(sentence));
	return holding.filter((outer) => !holding.some((inner) => inner.line > outer.line && inner.line < outer.end));
}

/** List items outside fenced blocks, quoted or not, each with its indented continuation lines, whitespace collapsed. */
function bulletsOf(lines: readonly string[]): string[] {
	const items: string[][] = [];
	let open = false;
	let fenced = false;
	for (const quoted of lines) {
		const line = quoted.replace(/^(?:\s*>)+\s?/, "");
		if (line.trimStart().startsWith("```")) {
			fenced = !fenced;
			open = false;
			continue;
		}
		if (fenced) continue;
		const start = BULLET.exec(line)?.[1];
		if (start !== undefined) {
			items.push([start]);
			open = true;
			continue;
		}
		const last = items.at(-1);
		if (open && last !== undefined && /^\s+\S/.test(line)) {
			last.push(line.trim());
			continue;
		}
		open = false;
	}
	return items.map((item) => normalized(item.join(" ")));
}

/** One endpoint, one project listing the operator, private contexts from the context API and the output collector. */
// adapted from claim-emergency-cli.test.ts:785-948 (EmergencyCase): the endpoint is an initialized area or a stalled
// one; the project holds three tasks; the post-receive hook can plant a foreign ref at the swap; ls-remote, adoption,
// recovery contexts, the authority rewrite and the per-output allowances are left out.
class EpochCase {
	private readonly outputs: Output[] = [];
	private readonly handles: Handle[] = [];
	private readonly roots = new Set<string>();

	private constructor(
		readonly root: string,
		readonly url: string,
		private readonly serverRepo: string | null,
		readonly project: string,
		readonly parent: string,
		readonly operator: Handle,
	) {
		this.handles.push(operator);
	}

	static async create(format: ClaimStorageFormat, caseName: string, endpoint: Endpoint): Promise<EpochCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-epoch-cli-${SENTINEL}-`));
		try {
			const parent = join(root, `contexts-${SENTINEL}`);
			await mkdir(parent);
			await chmod(parent, 0o700);
			const operator = await newContext(parent);
			const project = join(root, `project-${SENTINEL}`);
			const authorities = [operator.authorityId];
			if (endpoint.kind === "stalled") {
				await initProject(project, claimsBlock(endpoint.url, format, authorities, STALL_TIMEOUT));
				return new EpochCase(root, endpoint.url, null, project, parent, operator);
			}
			const { name, repo } = await gitServer().initRepository(root, `epoch-${SENTINEL}-${format}-${caseName}`);
			const url = gitServer().url(name);
			await initProject(project, claimsBlock(url, format, authorities, ADAPTER_TIMEOUT));
			await initializeArea(await initClient(join(root, "client")), url, format);
			return new EpochCase(root, url, repo, project, parent, operator);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async context(): Promise<Handle> {
		const handle = await newContext(this.parent);
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
		this.outputs.push({ command: commandOf(args), text: `${scannedText(doc, run.stdout)}${run.stderr}` });
		return { ...run, doc };
	}

	/** `backlog claim <words> --help`; the help text joins the scan like every other output. */
	async help(words: readonly string[]): Promise<CliRun> {
		const args = ["claim", ...words, "--help"];
		const run = await this.execute(args);
		this.outputs.push({ command: `${commandOf(args)} --help`, text: `${run.stdout}${run.stderr}` });
		return run;
	}

	/**
	 * A foreign writer that lands right after the swap: the server repository's post-receive
	 * hook, replaced for this case only (test-local, like claim-cli.test.ts:810-852), creates `refs/claims/<ticket>` on
	 * a foreign blob whenever the descriptor ref moves, and writes a sentinel marker to stderr. It runs inside the
	 * swap's push, before that push returns, so the ref exists before step 6 and the last listing; a CLI that forwarded
	 * Git's stderr would print the marker. Returns the foreign root.
	 */
	async plantAtSwap(ticket: string): Promise<string> {
		const repo = this.serverRepo;
		if (repo === null) throw new Error("a stalled case has no server repository");
		const written = await gitServer().git(repo, ["hash-object", "-w", "--stdin"], `foreign claim write ${ticket}\n`);
		const oid = written.out.trim();
		const hook = join(repo, "hooks", "post-receive");
		const script = [
			"#!/bin/sh",
			"while read -r old new ref; do",
			`\tif [ "$ref" = ${shellQuote(DESCRIPTOR_REF)} ]; then`,
			`\t\tgit update-ref ${shellQuote(`refs/claims/${ticket}`)} ${shellQuote(oid)}`,
			`\t\techo ${shellQuote(`${SENTINEL}-hook-stderr`)} >&2`,
			"\tfi",
			"done",
			"exit 0",
			"",
		].join("\n");
		await writeFile(hook, script);
		await chmod(hook, 0o755);
		return oid;
	}

	/**
	 * Labels of every sentinel in the collected output. install-epoch prints no root, no context ID and no authority
	 * ID anywhere; the owner name counts everywhere but in list entries (dropped before); a maintenance receipt key and
	 * Git's own stderr wording count everywhere.
	 */
	// adapted from claim-emergency-cli.test.ts:886-924
	async leaks(): Promise<string[]> {
		const sentinels: Sentinel[] = [
			["sentinel", SENTINEL],
			["endpoint", this.url],
			["case root", this.root],
			["context parent", this.parent],
			["owner", OWNER],
			...GIT_STDERR,
		];
		for (const oid of this.roots) sentinels.push(["server root", oid]);
		for (const [index, handle] of this.handles.entries()) {
			const label = `context ${index + 1}`;
			sentinels.push([`${label} binding`, handle.binding], [`${label} secret`, handle.secret]);
			sentinels.push([`${label} path`, handle.directory], [`${label} id`, handle.contextId]);
			sentinels.push([`${label} authority`, handle.authorityId]);
			for (const record of await records(handle)) {
				sentinels.push([`${label} digest`, record.digest], [`${label} parameter digest`, record.parameterDigest]);
			}
		}
		const found = new Set<string>();
		for (const output of this.outputs) {
			const labels = echoedIn(output.text, sentinels);
			if (RECEIPT_ID.test(output.text)) labels.push("receipt id");
			for (const label of labels) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	// adapted from claim-emergency-cli.test.ts:926-935; a stalled case has no refs
	async serverRefs(): Promise<Record<string, string>> {
		if (this.serverRepo === null) return {};
		const listing = await gitServer().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

// adapted from claim-emergency-cli.test.ts:950-963
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	endpoint: Endpoint,
	body: (fixture: EpochCase) => Promise<void>,
): Promise<void> {
	const fixture = await EpochCase.create(format, caseName, endpoint);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

for (const format of FORMATS) {
	describe(`claim install-epoch CLI over real Git (${format})`, () => {
		test(
			"ep-e01: preview and run exit 0 with their exact documents; init shows epoch 2, list every ticket free in it",
			async () => {
				await withCase(format, "e01", { kind: "area" }, async (fixture) => {
					const { operator } = fixture;
					const holder = await fixture.context();
					// The holder's journal is empty.
					const acquired = await fixture.json(acquireArgs(ACTIVE, holder));
					// Another ticket.
					const second = await fixture.json(acquireArgs(FREED, holder));
					// The holder's record on FREED expects the absent ref, which its acquire replaced.
					const freed = await fixture.json(["claim", "release", FREED, "--context", holder.directory]);
					const before = await fixture.serverRefs();
					// install-epoch records no intent (a storage operation beside the executor); nothing pauses it.
					const preview = await fixture.json(installArgs(operator, 1, "--ticket", EXTRA, "--preview"));
					const previewed = previewResult(preview, {
						epoch: 2,
						format,
						listed: [ACTIVE, FREED],
						toCreate: [BARE, EXTRA],
						unreadable: [],
					});
					// Positive control (catches: missing wiring; the scaffold's stub document; the current instead of the next
					// epoch; a corpus ticket without a ref or the --ticket ticket missing from toCreate; an old document
					// reported unreadable; another field). `harness`: the scanner finds a planted sentinel and a planted
					// receipt key.
					expect({
						steps: [outcomeOf(acquired), outcomeOf(second), outcomeOf(freed)],
						harness: {
							scanner: echoedIn(`planted ${SENTINEL}`, [["sentinel", SENTINEL]]),
							receipt: RECEIPT_ID.test(`"${PLANTED_RECEIPT}"`),
						},
						preview: previewed.actual,
					}).toEqual({
						steps: [APPLIED_STEP, APPLIED_STEP, APPLIED_STEP],
						harness: { scanner: ["sentinel"], receipt: true },
						preview: previewed.expected,
					});
					// catches: a preview that swaps the descriptor, archives a root or writes a ticket ref.
					expect(await fixture.serverRefs()).toEqual(before);
					const run = await fixture.json(installArgs(operator, 1, "--ticket", EXTRA));
					const installed = epochResult(run, {
						status: "applied",
						fromEpoch: 1,
						epoch: 2,
						format,
						previousFormat: format,
						rewritten: [ACTIVE, FREED],
						created: [BARE, EXTRA],
						breached: [],
						unsettled: [],
					});
					const init = await fixture.json(["claim", "init"]);
					const listing = await fixture.json(["claim", "list"]);
					// catches: a run that refuses, rejects or ends unknown on a clean area; a missing, extra or unsorted field
					// or a count instead of a list; the descriptor left at epoch 1 (init) or refused as corrupt at epoch
					// 2; an ACTIVE claim that survives the cut, a generation kept or restarted instead of old + 1
					// for a readable document and 1 otherwise, a created ticket missing, or no `epoch` in the entries (points
					// 10 and 11).
					expect({
						run: installed.actual,
						init: { exit: init.exit, stderr: init.stderr, doc: init.doc },
						list: listView(listing),
					}).toEqual({
						run: installed.expected,
						init: { exit: 0, stderr: "", doc: initDocument(format, 2) },
						list: {
							exit: 0,
							kind: "claim-list",
							status: "ok",
							complete: true,
							claims: [listEntry(ACTIVE, 2, 2), listEntry(FREED, 2, 2), listEntry(BARE, 1, 2), listEntry(EXTRA, 1, 2)],
						},
					});
					const help = await fixture.help([INSTALL]);
					const resolve = await fixture.help(["resolve"]);
					// catches: an empty help (the scaffold registration); an option without its schema
					// line; a document unnamed; any further option (a force flag, a token, --operation-id). `parser`,
					// the harness control: `claim resolve` registers --context and the output pair, Commander adds --help.
					expect({
						help: helpFacts(help, INSTALL_FIELDS, INSTALL_KINDS),
						options: optionsOf(help.stdout),
						parser: optionsOf(resolve.stdout),
					}).toEqual({
						help: DOCUMENTED,
						options: [...INSTALL_OPTIONS, ...SHARED_OPTIONS].sort(byCodeUnits),
						parser: ["--context", ...SHARED_OPTIONS].sort(byCodeUnits),
					});
					// catches: a root (old, new, archived or the descriptor's), a receipt key, a path, binding, secret, digest,
					// context or authority ID, the endpoint, the owner name or Git stderr in any output, help included
					// (install-epoch prints no root at all).
					expect(await fixture.leaks()).toEqual([]);
				});
			},
			LONG_TEST_TIMEOUT,
		);
	});
}

describe("claim install-epoch CLI single-format cases (blob)", () => {
	test(
		"ep-e02: applied 0, a breach 3, epoch-changed 2 over Git; isolation-unconfirmed and authority-required 5 offline",
		async () => {
			await withCase("blob", "e02", { kind: "area" }, async (fixture) => {
				const { operator } = fixture;
				const holder = await fixture.context();
				// The holder's journal is empty.
				const acquired = await fixture.json(acquireArgs(ACTIVE, holder));
				// install-epoch records no intent; no earlier record can pause any of the three runs.
				const control = await fixture.json(installArgs(operator, 1));
				const first = epochResult(control, {
					status: "applied",
					fromEpoch: 1,
					epoch: 2,
					format: "blob",
					previousFormat: "blob",
					rewritten: [ACTIVE],
					created: [FREED, BARE],
					breached: [],
					unsettled: [],
				});
				// Positive control (catches: missing wiring; the scaffold's stub document; an exit other than 0 for applied,
				// Corpus tickets without a ref left out of the creation set).
				expect({ acquired: outcomeOf(acquired), first: first.actual }).toEqual({
					acquired: APPLIED_STEP,
					first: first.expected,
				});
				const foreignRoot = await fixture.plantAtSwap(FOREIGN);
				const breach = await fixture.json(installArgs(operator, 2));
				const refs = await fixture.serverRefs();
				const broken = epochResult(breach, {
					status: "unknown",
					fromEpoch: 2,
					epoch: 3,
					format: "blob",
					previousFormat: "blob",
					rewritten: CORPUS,
					created: [],
					breached: [FOREIGN],
					unsettled: [],
				});
				// catches: a foreign ref after the swap missed by the last listing, reported applied, or as unsettled
				// instead of breached; a second run that reuses the epoch instead of installing the next one; an exit other
				// than 3 for unknown. `planted`, the harness fact: the hook fired on the swap.
				expect({ breach: broken.actual, planted: refs[`refs/claims/${FOREIGN}`] === foreignRoot }).toEqual({
					breach: broken.expected,
					planted: true,
				});
				const stale = await fixture.json(installArgs(operator, 2));
				const rejected = epochResult(stale, { status: "rejected", cause: EPOCH_CHANGED });
				// catches: the expectation checked after writing anything, or not at all (a fourth epoch installed); the
				// rejection reported as refused, unknown or with another cause.
				expect({ stale: rejected.actual, refs: await fixture.serverRefs() }).toEqual({
					stale: rejected.expected,
					refs,
				});
				// catches: the planted root, any other root, the hook's stderr marker, a receipt key or another sentinel in
				// any output.
				expect(await fixture.leaks()).toEqual([]);
			});
			const proxy = await StallProxy.create();
			try {
				const stalled = `git://127.0.0.1:${proxy.port}/${SENTINEL}-stalled.git`;
				await withCase("blob", "e02-local", { kind: "stalled", url: stalled }, async (fixture) => {
					const { operator } = fixture;
					const unlisted = await fixture.context();
					const withoutStatement = ["claim", INSTALL, "--context", operator.directory, "--expect-epoch", "1"];
					const unconfirmed = await fixture.json(withoutStatement);
					// The unlisted context carries the statement, so only its authority can fail.
					const foreign = await fixture.json(installArgs(unlisted, 1));
					// Forms Number() reads as the current epoch 1; the CLI reads --expect-epoch like --expect-generation
					// (claim.ts:278, digits only), so each is a malformed value.
					const lenient: Record<string, unknown> = {};
					for (const form of LENIENT_EPOCHS) {
						const args = ["claim", INSTALL, "--context", operator.directory, "--expect-epoch", form];
						lenient[form] = errorView(await fixture.json([...args, "--isolation-confirmed"]));
					}
					const quiet = proxy.acceptedConnections;
					const reached = await fixture.json(installArgs(operator, 1));
					// Counter positive control (catches: a dead counter; a listed, confirmed operator refused before the
					// network): the call passes every local check and reaches the stalled endpoint in its maintain preflight
					// as a resume does in claim-cli-administration.test.ts:2160-2167.
					expect({ reached: errorView(reached), connected: proxy.acceptedConnections > quiet }).toEqual({
						reached: failed("unavailable", "unreachable"),
						connected: true,
					});
					// catches: the statement or the authority checked after a connection, or not at all (
					// nothing read but local files; no Git call); one refusal reported as the other;
					// a refusal with a ticket, an operation ID or another command; --expect-epoch parsed with Number(),
					// which takes 0x1, 1e0 and +1 for the epoch 1 and sends the run.
					expect({
						unconfirmed: errorView(unconfirmed),
						unlisted: errorView(foreign),
						lenient,
						connections: quiet,
					}).toEqual({
						unconfirmed: failed("refused", "isolation-unconfirmed"),
						unlisted: failed("refused", "authority-required"),
						lenient: Object.fromEntries(LENIENT_EPOCHS.map((form) => [form, failed("refused", "invalid-option")])),
						connections: 0,
					});
					// catches: the stalled endpoint, a path, binding, secret or ID in any refusal.
					expect(await fixture.leaks()).toEqual([]);
				});
			} finally {
				await proxy.close();
			}
		},
		LONG_TEST_TIMEOUT,
	);
});

describe("claim install-epoch documentation (no project)", () => {
	test(
		"doc-e01b: the guide section and CLAIMS.md carry the epoch sentences, causes, codes, recipe, point, rule and hosts",
		async () => {
			const cwd = await mkdtemp(join(FIXTURE_ROOT, "claim-epoch-docs-"));
			try {
				const guide = await runCli(cwd, ["instructions", "claims"]);
				const lines = guide.stdout.split("\n");
				const headings = headingsOf(lines);
				const section = (title: string): string =>
					sectionOf(
						lines,
						headings.find((heading) => heading.level === 2 && heading.title === title),
					).join("\n");
				const epochs = section(SECTION);
				// Positive control (catches: a guide section that does not name the new command; the scaffold
				// leaves the guide as it is).
				expect({ exit: guide.exit, named: epochs.includes(INSTALL_COMMAND) }).toEqual({ exit: 0, named: true });
				// catches: a mandatory sentence reworded or missing from the section; a cause, a refusal code or the rerun
				// flag unnamed there; the emergency release placeholder "follow in a later version" left in place.
				expect({
					sentences: SENTENCES.filter((sentence) => !normalized(epochs).includes(sentence)),
					terms: SECTION_TERMS.filter((term) => !epochs.includes(term)),
					placeholder: epochs.includes(PLACEHOLDER),
				}).toEqual({ sentences: [], terms: [], placeholder: false });
				// catches: the command missing from the command list, or its two documents from the output list (
				// the emergency release added its preview kind there, claims.md:79-80).
				expect({
					commands: section("Commands").includes(INSTALL_COMMAND),
					kinds: INSTALL_KINDS.filter((kind) => !mentions(section("Output"), kind)),
				}).toEqual({ commands: true, kinds: [] });
				const codes = tableRows(guide.stdout, "code", "status");
				const exits = tableRows(guide.stdout, "status", "exit");
				// catches: a code install-epoch refuses with, or a status its documents take, listed with another status or
				// exit than the constants say (doc-02 compares the whole tables both ways; here only the epoch swap rows).
				expect({
					codes: EPOCH_CODES.map((code) => codeFacts(code, codes, exits)),
					exits: EPOCH_STATUSES.map((status) => exits.find(([name]) => name === status)?.[1] ?? null),
				}).toEqual({
					codes: EPOCH_CODES.map((code) => ({
						code,
						statuses: [CLAIM_ERROR_CODES[code]],
						exit: String(CLAIM_EXIT_CODES[CLAIM_ERROR_CODES[code]]),
					})),
					exits: EPOCH_STATUSES.map((status) => String(CLAIM_EXIT_CODES[status])),
				});
				const claims = await readFile(CLAIMS_PATH, "utf8");
				const claimLines = claims.split("\n");
				const claimHeadings = headingsOf(claimLines);
				const notDo = claimHeadings.find((heading) => heading.level === 2 && heading.title === NOT_DO);
				const recipes = claimHeadings.find((heading) => heading.level === 2 && heading.title === RECIPES);
				const restores = claimHeadings
					.filter((heading) => heading.level === 3 && !BASE_SECTIONS.includes(heading.title))
					.filter((heading) => recipes !== undefined && heading.line > recipes.line && heading.line < recipes.end)
					.map((heading) => ({ title: heading.title, body: sectionOf(claimLines, heading).join("\n") }))
					.filter((recipe) => recipe.body.includes(INSTALL));
				const text = normalized(claims);
				// catches: CLAIMS.md without a mandatory sentence, the "No quiescence proof" point or the generation rule;
				// no new level-3 recipe under "Recipes" naming install-epoch; a recipe with an example comment or a bash or
				// sh block, which the workflow suite would run or reject (wf-doc-01); a recipe without the resolve, the
				// preview, the expected epoch or the statement.
				expect({
					sentences: SENTENCES.filter((sentence) => !text.includes(sentence)),
					notDo: sectionOf(claimLines, notDo).some((line) => NO_QUIESCENCE.test(line)),
					rule: text.toLowerCase().includes(GENERATION_RULE),
					recipes: restores.length > 0,
					pinned: restores.filter((recipe) => recipe.body.split("\n").some(pinnedStep)).map((recipe) => recipe.title),
					steps: RECIPE_STEPS.filter((step) => !restores.some((recipe) => recipe.body.includes(step))),
				}).toEqual({ sentences: [], notDo: true, rule: true, recipes: true, pinned: [], steps: [] });
				const homes = sectionsHolding(claimLines, claimHeadings, QUALIFICATION_SENTENCE);
				const items = homes.flatMap((home) => bulletsOf(sectionOf(claimLines, home)));
				const single = items.filter((item) => HOSTING.filter(([, pattern]) => pattern.test(item)).length === 1);
				// catches: a hosting condition missing beside the qualification sentence, or folded with another
				// into one list item instead of a list (an item naming two conditions, like a recipe step with the meta refs
				// and the gate, counts for neither).
				expect(
					HOSTING.filter(([, pattern]) => !single.some((item) => pattern.test(item))).map(([label]) => label),
				).toEqual([]);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});
