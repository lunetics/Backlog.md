/**
 * Workflow examples of the human claims guide `CLAIMS.md` (level E, subprocess). The test reads `CLAIMS.md` at the
 * repository root as a reader does: it parses the `<!-- example Sn.m: … -->` comments and the bash blocks directly
 * after them, replaces the ten placeholders by shell-quoted values and runs every step of every scenario S1 to S15 in
 * order through `/bin/sh -c` in a fresh Backlog project, with a `backlog` wrapper first on PATH and a temporary HOME,
 * against one loopback Git area per scenario (blob). Two oracles bind the document: every comment must equal the real
 * run (status, exit code and each named code, cause and kind), and every scenario must contain this file's own table of
 * mandatory steps, derived from the claims guide, the contracts and the frozen suites and never from the wording of the
 * example list, as an ordered subsequence. Configuration the document shows as YAML prose, the lost reply of S6, the
 * departed claims of S10 and the witnessed call of S15 (a prologue the test runs through the reader's CLI, the refused
 * A of tpg-12) are the test's part; no step waits for a boundary. Four document tests pin the structure, the README
 * entry, the two guideline sentences and cheap drift points against the guide. The harness is an adapted copy of
 * claim-reclaim-cli.test.ts; the Git fixture is used unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ClaimStore, type JsonObject, openClaimStore } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, type ReceivePhase } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

// adapted from claim-reclaim-cli.test.ts:46-86 (status union, hook actions, the CLI run with its wall-clock interval);
// the document, example, mandatory-step and scenario types are new; every batch reclaim view type is left out.
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
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
/** `startedAt`/`endedAt`: the test process's wall clock around the call. */
type CliRun = { exit: number; stdout: string; stderr: string; startedAt: number; endedAt: number };
/** The keys an example comment may carry; `ticket` only on `backlog task create`. */
type PinKey = "status" | "exit" | "code" | "cause" | "kind" | "ticket";
type Pins = Partial<Record<PinKey, string>>;
/** A Markdown heading and the line where its section ends (the next heading of the same or a higher level). */
type Heading = { level: number; title: string; line: number; end: number };
/** A fenced block: its info string, the line of its opening fence and its body. */
type Block = { lang: string; open: number; body: string[] };
/** One example step: its comment, the joined command line of its bash block and what is wrong with either. */
type Example = {
	id: string;
	scenario: string;
	line: number;
	pins: Pins;
	command: string;
	verb: string | null;
	problems: string[];
};
type ParsedDoc = {
	lines: string[];
	fenced: ReadonlySet<number>;
	headings: Heading[];
	blocks: Block[];
	examples: Example[];
	problems: string[];
};
type Home = "Everyday workflows" | "When something goes wrong";
type ScenarioHeading = { id: string; name: string; home: string; heading: Heading };
/** A claims-block key the test writes before a step; `null` removes the key. */
type ConfigChange = readonly [key: string, value: string | null];
type Outcome = { example: Example; run: CliRun | null; doc: unknown; pushes: number; problem: string | null };
type CheckContext = { scene: Scene; self: Outcome; markdown: ParsedDoc; heading: Heading };
/** A fact beside status and exit that the guide names for a mandatory step; `catches` says what a failure means. */
type Check = {
	label: string;
	catches: string;
	read: (context: CheckContext) => unknown;
	want: (context: CheckContext) => unknown;
};
/**
 * One mandatory step: the verb, the pins the comment must carry, options its line must show
 * (`args`, space-bounded, placeholders unsubstituted) or must not show (`absent`), the configuration the test writes
 * before it, whether the test loses its reply and the checks of its real run.
 */
type Mandatory = {
	verb: string;
	pins: Pins;
	args?: readonly string[];
	absent?: readonly string[];
	config?: readonly ConfigChange[];
	lostReply?: boolean;
	checks?: readonly Check[];
};
type MandatoryExtra = Omit<Mandatory, "verb" | "pins">;
/** A claim planted by an independent writer under a foreign binding before the scenario. */
type Plant = { ticket: string; owner: string; leaseEnd: number };
/**
 * A call the test makes through the reader's CLI before the document's steps: its line with
 * placeholders, whether the pre-receive hook refuses the confirmation A, and the status and phase it must end in.
 */
type PrologueCall = { line: string; refuseConfirmation?: boolean; status: Status; phase?: string };
type ScenarioSpec = {
	id: string;
	name: string;
	title: string;
	home: Home;
	/** "Set up as in S1": the test runs setup, init and two context creates first. */
	prepared: boolean;
	/** `fixture`: BACK-1 to BACK-3 as To Do task files; `document`: the scenario creates its tickets (decision 8). */
	tickets: "fixture" | "document";
	plants?: readonly Plant[];
	/** The claims block and the calls that put the scenario where its document starts. */
	prologue?: { config: readonly ConfigChange[]; calls: readonly PrologueCall[] };
	steps: readonly Mandatory[];
};
type TicketFacts = { status: string; labels: string[]; dependencies: string[] };
type TicketWant = { status: string; dependencies: string[]; backend?: boolean };
type Row = Record<string, unknown>;
type Toolbox = { root: string; bin: string; home: string };

// adapted from claim-reclaim-cli.test.ts:149-239 (paths, timeouts, the foreign binding, the lapsed lease end, the ID
// pattern and the exit table); owners, tickets and placeholders are those the guide defines.
const CLI_PATH = resolve(getTestCliPath());
const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Up to eleven subprocesses per scenario, the first of the file with a cold transpiler cache. */
const SCENARIO_TIMEOUT = 150_000;
const DOC_TIMEOUT = 30_000;
/** timeoutMs of the independent writer's storage client (claim-reclaim-cli.test.ts:153-154). */
const ADAPTER_TIMEOUT = 3_000;
/** attempt_timeout_ms of the S6 lost reply; the scripted hold outlasts it (claim-cli.test.ts:108-109). */
const LOSS_TIMEOUT = 2_000;
/** Bound for waiting on hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms. */
const HOLD_POLLS = 300;
const MINUTE = 60_000;
/** reclaim_grace_ms of every planted lease, equal to the setup template (config/index.ts:19). */
const GRACE = 10 * MINUTE;
/** In the scenario roots and in hook stderr, as in the batch reclaim harness. */
const SENTINEL = "SENTINEL-workflow-9d2b";
/** clock_uncertainty_ms of the prepared setup, the value of the setup help example (commands/claim.ts:872). */
const EPS_ARG = "2000";
/** The binding of every planted claim; it belongs to no context of the scenario (claim-reclaim-cli.test.ts:193-194). */
const OTHER_BINDING = `tb1-${"6f".repeat(32)}`;
/** A lease end in the past: reclaimable at any real clock of a run (claim-reclaim-cli.test.ts:213-214). */
const LAPSED_END = Date.UTC(2026, 0, 1);
/** Generated operation IDs are `op-<uuid v4>`. */
const GENERATED_ID = /^op-[0-9a-f-]{36}$/;
/** claims.md:83-93: the closed status and exit code table. */
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
const STATUSES: readonly string[] = Object.keys(EXIT);
const ONE_DOCUMENT = "one JSON document";
const EVERYDAY: Home = "Everyday workflows";
const WRONG: Home = "When something goes wrong";
/** The seven sections of CLAIMS.md, in this order. */
const DOC_SECTIONS: readonly string[] = [
	"What a claim is",
	"Setup",
	EVERYDAY,
	"Recipes",
	WRONG,
	"What claims do not do",
	"Reading the JSON",
];
/** The placeholders of the guide; each is replaced by a shell-quoted value before a step runs. */
const PLACEHOLDERS: readonly string[] = [
	"<endpoint>",
	"<context-a>",
	"<context-b>",
	"<context-a-recovered>",
	"<hard-end>",
	"<earlier-hard-end>",
	"<private-dir>",
	"<operation-id>",
	// Placeholders nine and ten.
	"<later-hard-end>",
	"<confirm-operation-id>",
];
const TASK_CREATE = "task create";
/** The verbs of the claims guide (claims.md:9-41) and the ticket setup of S4/S5. */
const VERBS: readonly string[] = [
	"claim setup",
	"claim init",
	"claim context create",
	"claim acquire",
	"claim next",
	"claim renew",
	"claim release",
	"claim reclaim",
	"claim transfer",
	"claim resume",
	"claim change-bounds",
	"claim resolve",
	"claim retry",
	"claim list",
	"claim reclaim-preview",
	"claim reclaim-batch",
	TASK_CREATE,
];
const PIN_KEYS: readonly PinKey[] = ["status", "exit", "code", "cause", "kind", "ticket"];
/** The pins compared with a run besides the exit code. */
const COMPARED: readonly Exclude<PinKey, "exit">[] = ["status", "code", "cause", "kind", "ticket"];
/** claims.md:309-311: every scope option of reclaim-batch and reclaim-preview. */
const SCOPE_FLAGS: readonly string[] = [
	"--ticket",
	"--all",
	"--claim-owner",
	"--status",
	"--exclude-status",
	"--assignee",
	"--unassigned",
	"--milestone",
	"--parent",
	"--priority",
	"--type",
	"--project",
	"--labels",
	"--search",
	"--ready",
];
const ENVELOPE = ["schemaVersion", "kind", "status", "command"];
/** Guide "Output" (claims.md:55-58); the contract keeps these keys for every document outside the time path. */
const CLAIM_OPERATION_KEYS = [
	...ENVELOPE,
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
].sort(byCodeUnits);
/** claim-cli.test.ts:2106-2121: a context create document carries the context ID and nothing of the handle. */
const CONTEXT_KEYS = ["command", "contextId", "kind", "schemaVersion", "status"];
/** The task files of every scenario with `tickets: "fixture"` (claim-reclaim-cli.test.ts:203-205). */
const FIXTURE_TICKETS: readonly string[] = ["BACK-1", "BACK-2", "BACK-3"];
/** claims.md:83: the head of the status table that "Reading the JSON" copies line by line. */
const STATUS_HEADER = "| status | exit |";
/** A "Claims" entry linking CLAIMS.md. */
const CLAIMS_LINK = /\[[^\]]*Claims[^\]]*\]\(CLAIMS\.md\)/;
/** When to read the claims guide (word stems, compared case-insensitively). */
const WHEN_TERMS: readonly string[] = ["acquir", "renew", "transfer", "reclaim"];
/** ASSUMPTION(guide): cheap wording proxies per section, case-insensitive. */
const CONTENT_PINS: readonly (readonly [section: string, term: string])[] = [
	["What a claim is", "lease"],
	["What a claim is", "hard"],
	["What a claim is", "none"],
	["What a claim is", "assignee"],
	["What a claim is", "--owner"],
	["Setup", "backlog claim setup"],
	["Setup", "backlog claim init"],
	["Setup", "backlog claim context create"],
	["Recipes", "jitter"],
	["Recipes", "fencing"],
	["What claims do not do", "fencing"],
	["What claims do not do", "schedul"],
	["What claims do not do", "offline"],
	["What claims do not do", "enabled: false"],
	// The pointer to the guide's "Time path" and its non-promises (guide "What the time path does
	// not promise"): no work right on a pending claim, no time authority, no rescue of a lost witness, no liveness.
	["What claims do not do", '"time path"'],
	["What claims do not do", "pending"],
	["What claims do not do", "time authority"],
	["What claims do not do", "lost witness"],
	["What claims do not do", "liveness"],
	["Reading the JSON", "schemaVersion"],
	["Reading the JSON", "claim resolve"],
];
/** `<!-- example S6.2: status=unknown exit=3 kind=claim-resolution -->`. */
const EXAMPLE_COMMENT = /^<!-- example (S\d{1,2})\.(\d{1,2}): (.+?) -->$/;
const PIN_TOKEN = /^(status|exit|code|cause|kind|ticket)=([A-Za-z0-9-]+)$/;
/** ASSUMPTION(guide): `### S1 First claim`; `.`, `:`, ` —` or ` -` after the ID are accepted. */
const SCENARIO_TITLE = /^(S\d{1,2})(?:\.|:| —| -)? (.+)$/;
const PLACEHOLDER = /<[^<>\s]*>/g;
const FENCE = /^```([\w-]*)\s*$/;

// Mandatory steps: derived from the guide, the contracts and the frozen suites.
// A comment of the document matches a row when verb, every pin of the row, every `args` entry and no `absent`
// flag agree; the rows must appear in this order, other steps may stand between them.
const SCENARIOS: readonly ScenarioSpec[] = [
	{
		id: "S1",
		name: "First claim",
		title: "first claim: setup, init, context create, acquire, list and release run as documented",
		home: EVERYDAY,
		prepared: false,
		tickets: "fixture",
		steps: [
			step("claim setup", pins("ok"), { args: ["--endpoint <endpoint>", "--storage-format blob"] }),
			step("claim init", pins("ok"), {
				checks: [
					{
						label: "result and format",
						catches: "an area the reader's own init did not create, or another format than blob",
						read: ({ self }) => pick(self.doc, ["result", "format"]),
						want: () => ({ result: "created", format: "blob" }),
					},
				],
			}),
			step("claim context create", pins("ok"), {
				args: ["--parent <private-dir>"],
				checks: [contextOnly("the handle path or binding printed besides the context ID (claims.md:12-13)")],
			}),
			step("claim acquire", pins("applied"), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>"],
				checks: [ownershipIs("held", "the new context not the holder of its own claim")],
			}),
			step("claim list", pins("ok"), {
				args: ["--context <context-a>"],
				checks: [listedAs("BACK-1", "agent-a", "held", "list not showing the claim with its owner and own rights")],
			}),
			step("claim release", pins("applied"), {
				args: ["BACK-1", "--context <context-a>"],
				checks: [ownershipIs("free", "a release that leaves the ticket held")],
			}),
		],
	},
	{
		id: "S2",
		name: "Heartbeat under a lease",
		title: "heartbeat: an acquire with --ttl-ms, two renews, and the listed lease end has moved",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied"), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>", "--ttl-ms"],
			}),
			step("claim renew", pins("applied"), { args: ["BACK-1", "--context <context-a>"] }),
			step("claim renew", pins("applied"), { args: ["BACK-1", "--context <context-a>"] }),
			step("claim list", pins("ok"), {
				args: ["--context <context-a>"],
				checks: [
					{
						label: "listed lease end",
						catches: "a renew that does not move the stored lease end, or a list showing an older one",
						read: ({ scene, self }) => leaseMoved(scene, self),
						want: () => ({ moved: true, lastRenew: true }),
					},
				],
			}),
		],
	},
	{
		id: "S3",
		name: "Two agents, one ticket",
		title: "two agents, one ticket: not-free, not-yet with its boundary, release, then the other context acquires",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied"), { args: ["BACK-1", "--owner agent-a", "--context <context-a>"] }),
			step("claim acquire", pins("rejected", { cause: "not-free" }), {
				args: ["BACK-1", "--owner agent-b", "--context <context-b>"],
			}),
			step("claim reclaim", pins("rejected", { cause: "not-yet" }), {
				args: ["BACK-1", "--context <context-b>"],
				checks: [
					{
						label: "boundary",
						catches: "a not-yet without its boundary, or one other than lease end plus grace (claim-cli.test.ts:1278)",
						read: ({ scene, self }) => boundaryIsReclaimEnd(scene, self),
						want: () => true,
					},
				],
			}),
			step("claim release", pins("applied"), { args: ["BACK-1", "--context <context-a>"] }),
			step("claim acquire", pins("applied"), {
				args: ["BACK-1", "--owner agent-b", "--context <context-b>"],
				checks: [ownershipIs("held", "a released ticket that the other context cannot acquire")],
			}),
		],
	},
	{
		id: "S4",
		name: "Claim the next ready ticket",
		title: "claim next: three created tickets, the ready one claimed, the same filters then exhausted",
		home: EVERYDAY,
		prepared: true,
		tickets: "document",
		steps: [
			step(TASK_CREATE, created("BACK-1"), {
				checks: [ticketIs("BACK-1", { status: "Done", dependencies: [], backend: true }, "no finished ticket")],
			}),
			step(TASK_CREATE, created("BACK-2"), {
				checks: [ticketIs("BACK-2", { status: "To Do", dependencies: [], backend: true }, "no ready ticket")],
			}),
			step(TASK_CREATE, created("BACK-3"), {
				checks: [ticketIs("BACK-3", { status: "To Do", dependencies: ["BACK-2"], backend: true }, "no blocked ticket")],
			}),
			step("claim next", pins("applied"), {
				args: ["--owner agent-a", "--labels backend"],
				checks: [
					{
						label: "selection",
						catches: "the finished or the blocked ticket claimed; readiness on the filtered list (claims.md:238-241)",
						read: ({ self }) => pick(self.doc, ["ticket", "candidates", "excluded"]),
						want: () => ({
							ticket: "BACK-2",
							candidates: ["BACK-2"],
							excluded: { blocked: 1, dependencyUnknown: 0, notActionable: 1 },
						}),
					},
				],
			}),
			step("claim next", pins("rejected", { cause: "exhausted" }), {
				args: ["--labels backend"],
				checks: [
					{
						label: "stop",
						catches: "a claimed ticket dropped from the local candidates, or a second claim by the same call",
						read: ({ self }) => pick(self.doc, ["ticket", "candidates", "untried"]),
						want: () => ({ ticket: null, candidates: ["BACK-2"], untried: 0 }),
					},
				],
			}),
		],
	},
	{
		id: "S5",
		name: "Dependency gate",
		title: "dependency gate: refused while a prerequisite is open, applied under the permissive policy",
		home: EVERYDAY,
		prepared: true,
		tickets: "document",
		steps: [
			step(TASK_CREATE, created("BACK-1"), {
				checks: [ticketIs("BACK-1", { status: "Done", dependencies: [] }, "no finished prerequisite")],
			}),
			step(TASK_CREATE, created("BACK-2"), {
				checks: [ticketIs("BACK-2", { status: "To Do", dependencies: [] }, "no open prerequisite")],
			}),
			step(TASK_CREATE, created("BACK-3"), {
				checks: [ticketIs("BACK-3", { status: "To Do", dependencies: ["BACK-1", "BACK-2"] }, "no gated ticket")],
			}),
			step("claim acquire", pins("refused", { code: "dependency-blocked" }), {
				args: ["BACK-3", "--owner agent-a", "--context <context-a>"],
				checks: [
					{
						label: "dependencies",
						catches: "the finished prerequisite counted as blocking, or the open one missing (claims.md:173-176)",
						read: ({ self }) => field(self.doc, "dependencies") ?? null,
						want: () => ({ blocking: ["BACK-2"], unknown: [], unreadable: 0 }),
					},
				],
			}),
			step("claim acquire", pins("applied"), {
				args: ["BACK-3", "--owner agent-a", "--context <context-a>"],
				config: [["acquire_dependency_policy", "permissive"]],
				checks: [ownershipIs("held", "the permissive policy not lifting the gate (claims.md:384-385)")],
			}),
		],
	},
	{
		id: "S6",
		name: "Lost reply",
		title: "lost reply: unknown, resolve reports it open, a second acquire pauses, retry resends and applies",
		home: WRONG,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("unknown"), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>"],
				config: [
					["attempts", "1"],
					["attempt_timeout_ms", String(LOSS_TIMEOUT)],
				],
				lostReply: true,
				checks: [
					{
						label: "operation ID and send",
						catches: "a lost reply reported without its operation ID, or no send at all (claims.md:97-99)",
						read: ({ self }) => ({
							generated: GENERATED_ID.test(String(field(self.doc, "operationId"))),
							pushes: self.pushes,
						}),
						want: () => ({ generated: true, pushes: 1 }),
					},
				],
			}),
			step("claim resolve", pins("unknown", { kind: "claim-resolution" }), {
				args: ["<operation-id>", "--context <context-a>"],
				checks: [
					{
						label: "resolution",
						catches: "resolve inventing an outcome instead of reporting the operation as open (claims.md:97-99)",
						read: ({ self }) => field(field(self.doc, "query"), "resolution") ?? null,
						want: () => "open",
					},
				],
			}),
			step("claim acquire", pins("paused", { kind: "claim-pause" }), {
				args: ["BACK-1", "--context <context-a>"],
				checks: [
					{
						label: "pause",
						catches: "a second acquire sent while the first is open, or a pause without its IDs (claims.md:104)",
						read: ({ self }) => ({
							operationIds: field(field(self.doc, "pause"), "operationIds") ?? null,
							pushes: self.pushes,
						}),
						want: ({ scene }) => ({ operationIds: [boundId(scene)], pushes: 0 }),
					},
				],
			}),
			step("claim retry", pins("applied"), {
				args: ["<operation-id>", "--context <context-a>"],
				checks: [
					{
						label: "identical resend",
						catches: "retry planning anew, using a new ID or sending nothing (claims.md:33-34)",
						read: ({ scene, self }) => ({
							...pick(self.doc, ["command", "action"]),
							same: field(self.doc, "operationId") === boundId(scene),
							pushes: self.pushes,
							ownership: ownershipOf(self.doc),
						}),
						want: () => ({ command: "retry", action: "acquire", same: true, pushes: 1, ownership: "held" }),
					},
				],
			}),
		],
	},
	{
		id: "S15",
		name: "A witnessed transition",
		title: "witnessed transition: resolve reports it open, retry of the confirmation ID publishes A, resolve confirms",
		home: WRONG,
		prepared: true,
		tickets: "fixture",
		// The witnessed call is the test's part (tpg-12): P passes, the pre-receive
		// hook refuses A at a current p, so the call ends unknown/3 with phase `witnessed` and A open.
		prologue: {
			config: [
				["lifetime_mode", "hard"],
				["lease_ttl_ms", null],
			],
			calls: [
				{
					line: "backlog claim acquire BACK-1 --owner agent-a --context <context-a> --hard-end <hard-end> --json",
					status: "applied",
				},
				{
					line: [
						"backlog claim change-bounds BACK-1 --context <context-a> --mode hard --hard-end <later-hard-end>",
						`--grace-ms ${GRACE} --json`,
					].join(" "),
					refuseConfirmation: true,
					status: "unknown",
					phase: "witnessed",
				},
			],
		},
		steps: [
			step("claim resolve", pins("unknown", { kind: "claim-resolution" }), {
				args: ["<operation-id>", "--context <context-a>"],
				checks: [
					resolvedAs("witnessed", "resolve of P not composite, or witnessed reported as applied (guide Time path)"),
					proseHas(["hull", "lost witness"], "S15 without the hull and the lost witness"),
				],
			}),
			step("claim retry", pins("applied"), {
				args: ["<confirm-operation-id>", "--context <context-a>"],
				checks: [
					{
						label: "confirmation retry",
						catches: "retry of the confirmation ID planning anew, with a transition, another ID or no send (cli-03)",
						read: ({ scene, self }) => ({
							...pick(self.doc, ["command", "action"]),
							same: field(self.doc, "operationId") === confirmId(scene),
							transition: field(self.doc, "transition") ?? null,
							pushes: self.pushes,
							ownership: ownershipOf(self.doc),
						}),
						want: () => ({
							command: "retry",
							action: "change-bounds",
							same: true,
							transition: null,
							pushes: 1,
							ownership: "held",
						}),
					},
				],
			}),
			step("claim resolve", pins("applied", { kind: "claim-resolution" }), {
				args: ["<operation-id>", "--context <context-a>"],
				checks: [resolvedAs("confirmed", "the transition not confirmed after A was published (cli-03)")],
			}),
		],
	},
	{
		id: "S7",
		name: "Hand a claim to a colleague",
		title: "hand over: a lease transferred, the receiver holds, time-box required, restart rejected, preserve applied",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied"), { args: ["BACK-1", "--owner agent-a", "--context <context-a>"] }),
			step("claim transfer", pins("applied"), {
				args: ["BACK-1", "--to-context <context-b>", "--owner agent-b", "--context <context-a>", "--ttl-ms"],
				checks: [ownershipIs("foreign", "rights from the receiver's view instead of the sender's (claims.md:188-189)")],
			}),
			step("claim list", pins("ok"), {
				args: ["--context <context-b>"],
				checks: [listedAs("BACK-1", "agent-b", "held", "the receiver not holding under the new display name")],
			}),
			step("claim acquire", pins("applied"), {
				args: ["BACK-2", "--owner agent-a", "--context <context-a>", "--hard-end <hard-end>"],
				checks: [hardEndIs(false, "the hard end dropped or moved by the acquire")],
			}),
			step("claim transfer", pins("rejected", { cause: "time-box-required" }), {
				args: ["BACK-2", "--to-context <context-b>", "--context <context-a>"],
				absent: ["--time-box"],
			}),
			step("claim transfer", pins("rejected", { cause: "requires-time-path" }), {
				args: ["BACK-2", "--to-context <context-b>", "--time-box restart", "--context <context-a>"],
				absent: ["--hard-end"],
			}),
			step("claim transfer", pins("applied"), {
				args: ["BACK-2", "--to-context <context-b>", "--time-box preserve", "--context <context-a>"],
				checks: [
					ownershipIs("foreign", "the sender still holding after the transfer"),
					hardEndIs(false, "preserve moving or dropping the hard end (claims.md:196)"),
				],
			}),
		],
	},
	{
		id: "S8",
		name: "Replace a crashed agent",
		title: "replace a crashed agent: a recovery context resumes the claim once; a second resume is held",
		home: WRONG,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied"), { args: ["BACK-1", "--owner agent-a", "--context <context-a>"] }),
			step("claim context create", pins("ok"), {
				args: ["--parent <private-dir>", "--recover-from <context-a>"],
				checks: [contextOnly("the old context's ID, path or binding printed (claims.md:12-15)")],
			}),
			step("claim resume", pins("applied"), {
				args: ["BACK-1", "--context <context-a-recovered>"],
				checks: [ownershipIs("held", "the replacement not holding after resume")],
			}),
			step("claim resume", pins("rejected", { cause: "held" }), {
				args: ["BACK-1", "--context <context-a-recovered>"],
			}),
		],
	},
	{
		id: "S9",
		name: "Shorten a claim",
		title: "shorten: a hard end moved earlier is applied, a mode change is rejected",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied"), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>", "--hard-end <hard-end>"],
				absent: ["--ttl-ms"],
				config: [
					["lifetime_mode", "hard"],
					["lease_ttl_ms", null],
				],
				checks: [hardEndIs(false, "a lease claim in a hard project, or the hard end moved (claims.md:209-212)")],
			}),
			step("claim change-bounds", pins("applied"), {
				args: ["BACK-1", "--context <context-a>", "--mode hard", "--hard-end <earlier-hard-end>", "--grace-ms"],
				checks: [hardEndIs(true, "the shortening not stored exactly (claims.md:209-212)")],
			}),
			step("claim change-bounds", pins("rejected", { cause: "mode-change" }), {
				args: ["BACK-1", "--context <context-a>", "--mode lease"],
			}),
		],
	},
	{
		id: "S13",
		name: "Extend a hard end over the time path",
		title: "extend: a later hard end goes through P and A and ends applied and confirmed; list shows it",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			// On S9's hard project (cli-01 plants a hard claim; here the reader acquires it).
			step("claim acquire", pins("applied"), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>", "--hard-end <hard-end>"],
				absent: ["--ttl-ms"],
				config: [
					["lifetime_mode", "hard"],
					["lease_ttl_ms", null],
				],
				checks: [hardEndIs(false, "a lease claim in a hard project, or the hard end moved (as S9.1)")],
			}),
			step("claim change-bounds", pins("applied"), {
				args: ["BACK-1", "--context <context-a>", "--mode hard", "--hard-end <later-hard-end>", "--grace-ms"],
				checks: [
					confirmedTo("held", "an extension in one write, not confirmed, or the later hard end not planned (cli-01)"),
					proseHas(["stop", "confirmed"], "S13 without the rule to stop before the call (guide Time path)"),
				],
			}),
			step("claim list", pins("ok"), {
				args: ["--context <context-a>"],
				checks: [
					listedAs("BACK-1", "agent-a", "held", "the holder not holding after the confirmed extension"),
					listedHardEnd("BACK-1", "list not showing the later hard end (cli-01 listedTiming)"),
				],
			}),
		],
	},
	{
		id: "S14",
		name: "Restart a hand-over's time box",
		title: "restart on hand-over: transfer --time-box restart --hard-end confirms; the receiver holds to the new end",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			// On a hard project, the ground cli-02 pins (a hard source, a hard target).
			step("claim acquire", pins("applied"), {
				args: ["BACK-2", "--owner agent-a", "--context <context-a>", "--hard-end <hard-end>"],
				absent: ["--ttl-ms"],
				config: [
					["lifetime_mode", "hard"],
					["lease_ttl_ms", null],
				],
				checks: [hardEndIs(false, "a lease claim in a hard project, or the hard end moved (as S9.1)")],
			}),
			step("claim transfer", pins("applied"), {
				args: [
					"BACK-2",
					"--to-context <context-b>",
					"--owner agent-b",
					"--time-box restart",
					"--hard-end <later-hard-end>",
					"--context <context-a>",
				],
				checks: [
					confirmedTo("foreign", "a restart in one write, the target's view, or the new hard end not planned (cli-02)"),
					proseHas(["enabled: false"], "S14 without the note that enabled: false refuses the restart (cli-05)"),
				],
			}),
			step("claim list", pins("ok"), {
				args: ["--context <context-b>"],
				checks: [
					listedAs("BACK-2", "agent-b", "held", "the receiver not holding under the new display name after A"),
					listedHardEnd("BACK-2", "the receiver's claim without the restarted hard end (cli-02 listedTiming)"),
				],
			}),
		],
	},
	{
		id: "S10",
		name: "Clean up after a departed agent",
		title: "clean up: preview and batch by claim owner, a missing scope, --all beside another scope",
		home: WRONG,
		prepared: true,
		tickets: "fixture",
		plants: [
			{ ticket: "BACK-1", owner: "agent-x", leaseEnd: LAPSED_END },
			{ ticket: "BACK-2", owner: "agent-x", leaseEnd: LAPSED_END },
		],
		steps: [
			step("claim acquire", pins("applied"), { args: ["BACK-3", "--owner agent-x", "--context <context-a>"] }),
			step("claim reclaim-preview", pins("ok"), {
				args: ["--claim-owner agent-x"],
				checks: [
					{
						label: "verdicts",
						catches: "a fresh claim previewed as eligible, or a departed one missing (claims.md:356-362)",
						read: ({ self }) => entriesOf(self.doc, ["ticket", "verdict"]),
						want: () => [
							{ ticket: "BACK-1", verdict: "eligible" },
							{ ticket: "BACK-2", verdict: "eligible" },
							{ ticket: "BACK-3", verdict: "not-yet" },
						],
					},
				],
			}),
			step("claim reclaim-batch", pins("ok"), {
				args: ["--claim-owner agent-x"],
				checks: [
					{
						label: "entries",
						catches: "the fresh claim tried or reclaimed; a departed claim left out (claims.md:326-329)",
						read: ({ self }) => entriesOf(self.doc, ["ticket", "result"]),
						want: () => [
							{ ticket: "BACK-1", result: "applied" },
							{ ticket: "BACK-2", result: "applied" },
						],
					},
				],
			}),
			step("claim reclaim-batch", pins("refused", { code: "scope-required" }), { absent: SCOPE_FLAGS }),
			step("claim reclaim-batch", pins("refused", { code: "invalid-option" }), {
				args: ["--all", "--claim-owner agent-x"],
			}),
		],
	},
	{
		id: "S11",
		name: "Errors an agent meets",
		title: "errors: no context, no owner, a relative context, a missing ticket, an unknown status, claims disabled",
		home: WRONG,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("refused", { code: "context-required" }), {
				args: ["BACK-1", "--owner agent-a"],
				absent: ["--context"],
			}),
			step("claim acquire", pins("refused", { code: "owner-required" }), {
				args: ["BACK-1", "--context <context-a>"],
				absent: ["--owner"],
			}),
			step("claim acquire", pins("refused", { code: "context-invalid" }), { args: ["BACK-1", "--owner agent-a"] }),
			step("claim acquire", pins("refused", { code: "ticket-not-found" }), {
				args: ["BACK-999", "--owner agent-a", "--context <context-a>"],
			}),
			step("claim next", pins("refused", { code: "invalid-option" }), { args: ["--status"] }),
			step("claim acquire", pins("refused", { code: "claims-disabled" }), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>"],
				config: [["enabled", "false"]],
			}),
		],
	},
	{
		id: "S12",
		name: "Reading a result without parsing the text",
		title: "reading a result: the shown claim-operation document has the guide's keys and those of a real run",
		home: EVERYDAY,
		prepared: true,
		tickets: "fixture",
		steps: [
			step("claim acquire", pins("applied", { kind: "claim-operation" }), {
				args: ["BACK-1", "--owner agent-a", "--context <context-a>"],
				checks: [
					{
						label: "shown document",
						catches: "a shown document with other keys than the guide's and the real run's (claims.md:55-58)",
						read: ({ self, markdown, heading }) => shownDocument(markdown, heading, self.doc),
						want: () => ({ shown: CLAIM_OPERATION_KEYS, real: CLAIM_OPERATION_KEYS, same: [true, true, true] }),
					},
					{
						label: "decision rule",
						catches: "S12 without the rule to decide on status and code, never on message (claims.md:75-76)",
						read: ({ markdown, heading }) => sectionWords(markdown, heading).includes("never on `message`"),
						want: () => true,
					},
				],
			}),
		],
	},
];

// adapted from claim-reclaim-cli.test.ts:351-365
let fixtureServer: GitFixtureServer | undefined;
let toolbox: Toolbox | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
	const root = await mkdtemp(join(FIXTURE_ROOT, "claim-workflow-tools-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	await mkdir(bin);
	await mkdir(home);
	// Brief decision 2: `backlog` on PATH is this checkout's CLI, run by the same Bun as the test.
	const wrapper = join(bin, "backlog");
	const exec = `exec ${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} "$@"`;
	await writeFile(wrapper, ["#!/bin/sh", exec, ""].join("\n"));
	await chmod(wrapper, 0o755);
	toolbox = { root, bin, home };
});

afterAll(async () => {
	await fixtureServer?.close();
	if (toolbox !== undefined) await rm(toolbox.root, { recursive: true, force: true });
});

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function tools(): Toolbox {
	if (!toolbox) throw new Error("the backlog wrapper was not written");
	return toolbox;
}

function step(verb: string, pinned: Pins, extra: MandatoryExtra = {}): Mandatory {
	return { verb, pins: pinned, ...extra };
}

/** Status and its exit code from the guide table (claims.md:83-93), plus a code, cause or kind. */
function pins(status: Status, extra: Pins = {}): Pins {
	return { status, exit: String(EXIT[status]), ...extra };
}

/** Brief decision 8: a task create comment carries `exit=0 ticket=<ID>` and no status. */
function created(ticket: string): Pins {
	return { exit: "0", ticket };
}

// adapted from claim-reclaim-cli.test.ts:367-398 (byCodeUnits, sha256Hex, field, keysOf, expectKind, shellQuote)
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-reclaim-cli.test.ts:400-408
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

// adapted from claim-reclaim-cli.test.ts:461-464
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(keys.map((key) => [key, field(value, key) ?? null]));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function normalized(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The fixture environment without BACKLOG_CWD, the wrapper first on PATH and the temporary HOME (decision 2). */
// adapted from claim-reclaim-cli.test.ts:410-414
function shellEnv(): Record<string, string> {
	const { bin, home } = tools();
	const env = Object.fromEntries(Object.entries(server().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
	return { ...env, PATH: `${bin}:${env.PATH ?? ""}`, HOME: home };
}

/** Brief decision 2: one joined command line through `/bin/sh -c`, as a reader's shell runs it. */
// adapted from claim-reclaim-cli.test.ts:416-427 (a shell line instead of `bun <cli> <args>`)
async function shell(cwd: string, line: string): Promise<CliRun> {
	const startedAt = Date.now();
	const child = Bun.spawn(["/bin/sh", "-c", line], {
		cwd,
		env: shellEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exit, stdout, stderr, startedAt, endedAt: Date.now() };
}

/** `bash -n` over a snippet on stdin; 0 means it parses. */
// adapted from fixtures/claim-git-fixture.ts:189-203 (stdin written, then closed)
async function bashSyntax(script: string): Promise<number> {
	const child = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
	child.stdin.write(script);
	void child.stdin.end();
	return child.exited;
}

/** A shipped guide as a reader prints it: `backlog instructions <name>` outside any project. */
async function guideText(name: string): Promise<string> {
	const run = await shell(tools().root, `backlog instructions ${name}`);
	if (run.exit !== 0) throw new Error(`backlog instructions ${name} exited ${run.exit}: ${run.stderr}`);
	return run.stdout.replace(/\r\n/g, "\n");
}

async function readDocument(path: string): Promise<ParsedDoc | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	return parseMarkdown(text);
}

/**
 * Headings, fenced blocks and example steps of a Markdown file. Headings and example comments count only outside
 * fences; a fence opens with three backticks and an info string and closes with three bare backticks.
 */
function parseMarkdown(text: string): ParsedDoc {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const found: Omit<Heading, "end">[] = [];
	const blocks: Block[] = [];
	const comments: number[] = [];
	const fenced = new Set<number>();
	const problems: string[] = [];
	let open: Block | null = null;
	for (const [index, line] of lines.entries()) {
		if (open !== null) {
			fenced.add(index);
			if (line.trim() === "```") {
				blocks.push(open);
				open = null;
			} else {
				open.body.push(line);
			}
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence !== null) {
			fenced.add(index);
			open = { lang: fence[1] ?? "", open: index, body: [] };
			continue;
		}
		const heading = /^(#{1,6}) (.+)$/.exec(line);
		if (heading !== null) found.push({ level: heading[1]?.length ?? 0, title: (heading[2] ?? "").trim(), line: index });
		if (/^<!--\s*example\b/.test(line)) comments.push(index);
	}
	if (open !== null) problems.push(`line ${open.open + 1}: a fence that never closes`);
	const headings = found.map((heading, index) => {
		const next = found.slice(index + 1).find((other) => other.level <= heading.level);
		return { ...heading, end: next?.line ?? lines.length };
	});
	const examples = pairExamples(lines, blocks, comments, problems);
	return { lines, fenced, headings, blocks, examples, problems };
}

/** Every example comment directly before a bash block, every bash block directly after a comment. */
function pairExamples(
	lines: readonly string[],
	blocks: readonly Block[],
	comments: readonly number[],
	problems: string[],
): Example[] {
	const byOpen = new Map(blocks.map((block) => [block.open, block] as const));
	for (const block of blocks) {
		if (block.lang === "bash" && !comments.includes(block.open - 1)) {
			problems.push(`line ${block.open + 1}: a bash block without an example comment on the line before`);
		}
	}
	const examples: Example[] = [];
	for (const line of comments) {
		const block = byOpen.get(line + 1);
		if (block === undefined || block.lang !== "bash") {
			problems.push(`line ${line + 1}: an example comment without a bash block on the next line`);
			continue;
		}
		examples.push(exampleOf((lines[line] ?? "").trim(), line, block));
	}
	return examples;
}

function exampleOf(text: string, line: number, block: Block): Example {
	const match = EXAMPLE_COMMENT.exec(text);
	const scenario = match?.[1] ?? "";
	const id = match === null ? `line ${line + 1}` : `${scenario}.${match[2] ?? ""}`;
	const problems: string[] = [];
	if (match === null) problems.push(`${id}: not of the form <!-- example Sn.m: key=value … -->`);
	const pinned: Pins = {};
	for (const token of (match?.[3] ?? "").split(/\s+/).filter(Boolean)) {
		const pin = PIN_TOKEN.exec(token);
		const key = pin?.[1] as PinKey | undefined;
		const value = pin?.[2];
		if (key === undefined || value === undefined) problems.push(`${id}: unknown pin "${token}"`);
		else if (pinned[key] !== undefined) problems.push(`${id}: ${key} given twice`);
		else pinned[key] = value;
	}
	// A reader's shell joins a line ending in a backslash with the next one.
	const joined = block.body.join("\n").replace(/\\\n/g, " ");
	const commands = joined
		.split("\n")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	const command = normalized(commands[0] ?? "");
	const verb = verbOf(command);
	if (commands.length !== 1) problems.push(`${id}: the block holds ${commands.length} command lines instead of one`);
	problems.push(...commandProblems(id, command, verb, pinned));
	return { id, scenario, line, pins: pinned, command, verb, problems };
}

function verbOf(command: string): string | null {
	const [program, group, sub, detail] = command.split(" ");
	if (program !== "backlog") return null;
	if (group === "task" && sub === "create") return TASK_CREATE;
	if (group !== "claim" || sub === undefined) return null;
	const verb = sub === "context" && detail === "create" ? "claim context create" : `claim ${sub}`;
	return VERBS.includes(verb) ? verb : null;
}

/** The comment grammar, checked before anything runs. */
function commandProblems(id: string, command: string, verb: string | null, pinned: Pins): string[] {
	const problems: string[] = [];
	const add = (problem: string) => {
		problems.push(`${id}: ${problem}`);
	};
	if (verb === null) add(`"${command}" is neither a claim command of the guide nor backlog task create`);
	const exit = pinned.exit;
	if (exit === undefined || !/^\d+$/.test(exit)) add("exit=<n> missing");
	if (verb === TASK_CREATE) {
		for (const key of ["status", "code", "cause", "kind"] as const) {
			if (pinned[key] !== undefined) add(`${key}= on a task create step`);
		}
		if (pinned.ticket === undefined) add("ticket=<ID> missing on a task create step");
	} else {
		const status = pinned.status;
		if (status === undefined || !STATUSES.includes(status)) add(`status "${status ?? ""}" is no status of the guide`);
		else if (String(EXIT[status as Status]) !== exit) add(`exit ${exit ?? "?"} does not belong to ${status}`);
		if (status === "refused" && pinned.code === undefined) add("refused without code=");
		if (status === "rejected" && pinned.cause === undefined) add("rejected without cause=");
		if (pinned.ticket !== undefined) add("ticket= on a claim step");
		if (!command.split(" ").includes("--json")) add("a claim line without --json");
	}
	for (const name of command.match(PLACEHOLDER) ?? []) {
		if (!PLACEHOLDERS.includes(name)) add(`unknown placeholder ${name}`);
	}
	if (/["']<[^<>\s]*>|<[^<>\s]*>["']/.test(command)) add("a quoted placeholder; the test quotes every value itself");
	if (/[|;&<>`$]/.test(command.replace(PLACEHOLDER, ""))) add("a shell operator; a block holds one plain command");
	if (verb === "claim context create" && !hasArg(command, "--parent <private-dir>")) {
		add("context create without --parent <private-dir>");
	}
	return problems;
}

/** ASSUMPTION(guide): scenario headings are level-3 headings of the two scenario sections. */
function scenarioHeadings(markdown: ParsedDoc): ScenarioHeading[] {
	const found: ScenarioHeading[] = [];
	for (const heading of markdown.headings) {
		if (heading.level !== 3) continue;
		const parent = markdown.headings.filter((other) => other.level <= 2 && other.line < heading.line).at(-1);
		if (parent === undefined || parent.level !== 2 || (parent.title !== EVERYDAY && parent.title !== WRONG)) continue;
		const match = SCENARIO_TITLE.exec(heading.title);
		found.push({ id: match?.[1] ?? "", name: match?.[2] ?? heading.title, home: parent.title, heading });
	}
	return found;
}

function examplesIn(markdown: ParsedDoc, heading: Heading): Example[] {
	return markdown.examples.filter((example) => example.line > heading.line && example.line < heading.end);
}

/** No duplicate IDs: the steps of a scenario are numbered 1, 2, 3 … in document order under its own ID. */
function sequenceProblems(scenario: string, examples: readonly Example[]): string[] {
	return examples.flatMap((example, index) => {
		const expected = `${scenario}.${index + 1}`;
		return example.id === expected ? [] : [`${example.id}: expected ${expected} (steps of ${scenario} in order)`];
	});
}

function hasArg(command: string, arg: string): boolean {
	return ` ${command} `.includes(` ${arg} `);
}

function hasFlag(command: string, flag: string): boolean {
	return command.split(" ").some((token) => token === flag || token.startsWith(`${flag}=`));
}

function fits(example: Example, mandatory: Mandatory): boolean {
	return (
		example.verb === mandatory.verb &&
		PIN_KEYS.every((key) => mandatory.pins[key] === undefined || example.pins[key] === mandatory.pins[key]) &&
		(mandatory.args ?? []).every((arg) => hasArg(example.command, arg)) &&
		(mandatory.absent ?? []).every((flag) => !hasFlag(example.command, flag))
	);
}

function describeStep(position: number, mandatory: Mandatory): string {
	const pinned = PIN_KEYS.flatMap((key) => {
		const value = mandatory.pins[key];
		return value === undefined ? [] : [`${key}=${value}`];
	});
	const shown = (mandatory.args ?? []).map((arg) => `"${arg}"`);
	const hidden = (mandatory.absent ?? []).map((flag) => `no ${flag}`);
	return [`mandatory ${position + 1}: ${mandatory.verb}`, ...pinned, ...shown, ...hidden].join(" ");
}

/** The mandatory rows as an ordered subsequence of the examples, matched greedily. */
function matchMandatory(examples: readonly Example[], steps: readonly Mandatory[]) {
	const matched: (number | undefined)[] = [];
	const missing: string[] = [];
	let cursor = 0;
	for (const [position, mandatory] of steps.entries()) {
		const at = examples.findIndex((example, index) => index >= cursor && fits(example, mandatory));
		if (at < 0) {
			matched.push(undefined);
			missing.push(describeStep(position, mandatory));
			continue;
		}
		matched.push(at);
		cursor = at + 1;
	}
	return { matched, missing };
}

/** Brief decision 4: every key the test writes appears as YAML prose of the scenario; a removed key is named. */
function configNotShown(markdown: ParsedDoc, heading: Heading, steps: readonly Mandatory[]): string[] {
	const yaml = markdown.blocks
		.filter((block) => block.lang === "yaml" && block.open > heading.line && block.open < heading.end)
		.flatMap((block) => block.body.map((line) => line.trim()));
	const prose = markdown.lines.slice(heading.line, heading.end).join("\n");
	return steps.flatMap((mandatory) =>
		(mandatory.config ?? []).flatMap(([key, value]) => {
			if (value === null) return prose.includes(key) ? [] : [`${key} (removed)`];
			return yaml.includes(`${key}: ${value}`) ? [] : [`${key}: ${value}`];
		}),
	);
}

function sectionState(markdown: ParsedDoc | null, found: ScenarioHeading | undefined, spec: ScenarioSpec): string {
	if (markdown === null) return `${spec.id} section missing (CLAIMS.md absent)`;
	if (found === undefined) return `${spec.id} section missing (no "### ${spec.id} ${spec.name}" under "${spec.home}")`;
	if (found.home !== spec.home) return `${spec.id} under "${found.home}" instead of "${spec.home}"`;
	if (found.name !== spec.name) return `${spec.id} named "${found.name}" instead of "${spec.name}"`;
	return "present";
}

/**
 * The reading of a document for the `cause` pin. ASSUMPTION(guide): the plan or storage cause of a
 * `claim-operation`, the stop kind of `claim-next` (claims.md:274-277), the resolution of `claim-resolution`.
 */
function causeOf(doc: unknown): unknown {
	switch (field(doc, "kind")) {
		case "claim-operation":
			return field(field(doc, "rejection"), "cause") ?? null;
		case "claim-next":
			return field(field(doc, "stop"), "kind") ?? null;
		case "claim-resolution": {
			const query = field(doc, "query");
			return (field(query, "kind") === "resolved" ? field(query, "resolution") : field(query, "kind")) ?? null;
		}
		default:
			return null;
	}
}

function observedPins(outcome: Outcome): Record<Exclude<PinKey, "exit">, unknown> {
	const { doc, run } = outcome;
	const createdTicket = run === null ? null : (/^Created task (\S+)$/m.exec(run.stdout)?.[1] ?? null);
	return {
		status: field(doc, "status") ?? null,
		code: field(doc, "code") ?? null,
		cause: causeOf(doc),
		kind: field(doc, "kind") ?? null,
		ticket: createdTicket,
	};
}

/** What the comment promises: its pins and, for a claim step, one JSON document on stdout and no stderr text. */
function expectedRow(example: Example): Row {
	const row: Row = { step: example.id, problem: null, exit: Number(example.pins.exit) };
	for (const key of COMPARED) {
		if (example.pins[key] !== undefined) row[key] = example.pins[key];
	}
	if (example.verb !== TASK_CREATE) Object.assign(row, { output: ONE_DOCUMENT, stderr: "" });
	return row;
}

function actualRow(outcome: Outcome): Row {
	const { example, run } = outcome;
	const observed = observedPins(outcome);
	const row: Row = { step: example.id, problem: outcome.problem, exit: run?.exit ?? null };
	for (const key of COMPARED) {
		if (example.pins[key] !== undefined) row[key] = observed[key];
	}
	if (example.verb !== TASK_CREATE) {
		const output = isRecord(outcome.doc) ? ONE_DOCUMENT : "no JSON document";
		Object.assign(row, { output, stderr: run?.stderr ?? null });
	}
	return row;
}

function ownershipOf(doc: unknown): unknown {
	return field(field(doc, "rights"), "ownership") ?? null;
}

function timingOf(doc: unknown): unknown {
	return field(field(doc, "planned"), "timing") ?? null;
}

function entryOf(doc: unknown, ticket: string): unknown {
	const claims = field(doc, "claims");
	return Array.isArray(claims) ? (claims.find((item: unknown) => field(item, "ticket") === ticket) ?? null) : null;
}

function entriesOf(doc: unknown, keys: readonly string[]): unknown {
	const entries = field(doc, "entries");
	return Array.isArray(entries) ? entries.map((entry: unknown) => pick(entry, keys)) : null;
}

function boundId(scene: Scene): string {
	return scene.bindings.get("<operation-id>") ?? "(unbound)";
}

function ownershipIs(ownership: string, catches: string): Check {
	return { label: "rights.ownership", catches, read: ({ self }) => ownershipOf(self.doc), want: () => ownership };
}

function contextOnly(catches: string): Check {
	return { label: "document keys", catches, read: ({ self }) => keysOf(self.doc), want: () => CONTEXT_KEYS };
}

function listedAs(ticket: string, owner: string, ownership: string, catches: string): Check {
	return {
		label: `list entry ${ticket}`,
		catches,
		read: ({ self }) => {
			const entry = entryOf(self.doc, ticket);
			return { ...pick(entry, ["state", "owner"]), ownership: ownershipOf(entry) };
		},
		want: () => ({ state: "active", owner, ownership }),
	};
}

/** The planned hard end: `<hard-end>`, or `<earlier-hard-end>` after a shortening. */
function hardEndIs(earlier: boolean, catches: string): Check {
	return {
		label: "planned hard end",
		catches,
		read: ({ self }) => field(timingOf(self.doc), "hardEnd") ?? null,
		want: ({ scene }) => (earlier ? scene.earlierHardEnd : scene.hardEnd),
	};
}

function confirmId(scene: Scene): string {
	return scene.bindings.get("<confirm-operation-id>") ?? "(unbound)";
}

/** cli-01, cli-02: a T call sends P and A, confirms and plans `<later-hard-end>` (caller's rights). */
function confirmedTo(ownership: string, catches: string): Check {
	return {
		label: "time path",
		catches,
		read: ({ self }) => ({
			phase: field(field(self.doc, "transition"), "phase") ?? null,
			sends: field(self.doc, "sends") ?? null,
			ownership: ownershipOf(self.doc),
			hardEnd: field(timingOf(self.doc), "hardEnd") ?? null,
		}),
		want: ({ scene }) => ({ phase: "confirmed", sends: 2, ownership, hardEnd: scene.laterHardEnd }),
	};
}

/** cli-01, cli-02 `listedTiming`: the list entry carries the later hard end. */
function listedHardEnd(ticket: string, catches: string): Check {
	return {
		label: `listed hard end ${ticket}`,
		catches,
		read: ({ self }) => field(field(entryOf(self.doc, ticket), "timing"), "hardEnd") ?? null,
		want: ({ scene }) => scene.laterHardEnd,
	};
}

/** (tpg-12, cli-03): `resolve` of P is composite, with the phase and the confirmation ID. */
function resolvedAs(phase: string, catches: string): Check {
	return {
		label: "transition",
		catches,
		read: ({ self }) => pick(field(self.doc, "transition"), ["phase", "confirmOperationId"]),
		want: ({ scene }) => ({ phase, confirmOperationId: confirmId(scene) }),
	};
}

/** ASSUMPTION(guide): the scenario's prose names these words (wording proxies). */
function proseHas(terms: readonly string[], catches: string): Check {
	return {
		label: "prose",
		catches,
		read: ({ markdown, heading }) => terms.filter((term) => !sectionWords(markdown, heading).includes(term)),
		want: () => [],
	};
}

/** Brief decision 8: after a task create step the test reads the ticket through Core. */
function ticketIs(id: string, want: TicketWant, catches: string): Check {
	return {
		label: `ticket ${id}`,
		catches: `${catches} as the guide needs it; labels or dependencies not stored as given`,
		read: async ({ scene }) => {
			const facts = await scene.ticketFacts(id);
			if (facts === null) return null;
			const view: Record<string, unknown> = { status: facts.status, dependencies: facts.dependencies };
			if (want.backend !== undefined) view.backend = facts.labels.includes("backend");
			return view;
		},
		want: () => want,
	};
}

function leaseMoved(scene: Scene, self: Outcome): Record<string, boolean> {
	const listed = field(field(entryOf(self.doc, "BACK-1"), "timing"), "leaseEnd");
	const acquired = field(timingOf(scene.mandatory(0)?.doc), "leaseEnd");
	const renewed = field(timingOf(scene.mandatory(2)?.doc), "leaseEnd");
	return {
		moved: typeof listed === "number" && typeof acquired === "number" && listed > acquired,
		lastRenew: typeof renewed === "number" && listed === renewed,
	};
}

/** claims.md:219 with claim-cli.test.ts:1278: the boundary of not-yet is the lease end plus the grace. */
function boundaryIsReclaimEnd(scene: Scene, self: Outcome): boolean {
	const timing = timingOf(scene.mandatory(0)?.doc);
	const leaseEnd = field(timing, "leaseEnd");
	const graceMs = field(timing, "graceMs");
	const boundary = field(field(self.doc, "rejection"), "boundary");
	return typeof leaseEnd === "number" && typeof graceMs === "number" && boundary === leaseEnd + graceMs;
}

/** S12: the first json block of the section, its keys, and kind, status and command against the real run. */
function shownDocument(markdown: ParsedDoc, heading: Heading, real: unknown): Record<string, unknown> {
	const block = markdown.blocks.find(
		(entry) => entry.lang === "json" && entry.open > heading.line && entry.open < heading.end,
	);
	const shown = block === undefined ? null : parseJson(block.body.join("\n"));
	if (!isRecord(shown)) {
		return { shown: block === undefined ? "no json block" : "unparsable", real: keysOf(real), same: [] };
	}
	const same = ["kind", "status", "command"].map((key) => shown[key] === field(real, key));
	return { shown: keysOf(shown), real: keysOf(real), same };
}

function sectionWords(markdown: ParsedDoc, heading: Heading): string {
	return normalized(markdown.lines.slice(heading.line, heading.end).join(" ")).toLowerCase();
}

function headingOf(markdown: ParsedDoc, title: string, level: number): Heading | undefined {
	return markdown.headings.find((heading) => heading.level === level && heading.title === title);
}

function sectionText(markdown: ParsedDoc, title: string): string {
	const heading = headingOf(markdown, title, 2);
	return heading === undefined ? "" : markdown.lines.slice(heading.line + 1, heading.end).join("\n");
}

/** Lines of a section outside fences. */
function proseLines(markdown: ParsedDoc, heading: Heading): string[] {
	const lines: string[] = [];
	for (let index = heading.line + 1; index < heading.end; index += 1) {
		if (!markdown.fenced.has(index)) lines.push(markdown.lines[index] ?? "");
	}
	return lines;
}

function subheadings(markdown: ParsedDoc, title: string): Heading[] {
	const parent = headingOf(markdown, title, 2);
	if (parent === undefined) return [];
	return markdown.headings.filter(
		(heading) => heading.level === 3 && heading.line > parent.line && heading.line < parent.end,
	);
}

/** Block quotes of prose lines, whitespace-normalized; GitHub callouts (`> [!NOTE]`) are no quotes of the guide. */
function quoteBlocks(lines: readonly string[]): string[] {
	const quotes: string[] = [];
	let current: string[] = [];
	for (const line of [...lines, ""]) {
		if (line.startsWith(">")) {
			current.push(line.replace(/^>\s?/, ""));
			continue;
		}
		if (current.length > 0 && !(current[0] ?? "").startsWith("[!")) quotes.push(normalized(current.join(" ")));
		current = [];
	}
	return quotes;
}

/** The table that starts with `header` and every following line that starts with `|`. */
function tableAfter(lines: readonly string[], header: string): string[] {
	const at = lines.indexOf(header);
	if (at < 0) return [];
	const rows = [header];
	for (const line of lines.slice(at + 1)) {
		if (!line.startsWith("|")) break;
		rows.push(line);
	}
	return rows;
}

function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function isHeartbeat(block: Block): boolean {
	const text = block.body.join("\n");
	return text.includes("backlog claim renew") && text.includes("--json") && text.includes("sleep");
}

function withKey(lines: readonly string[], key: string, value: string | null): string[] {
	const at = lines.findIndex((line) => line.trimStart().startsWith(`${key}:`));
	if (value === null) return lines.filter((_, index) => index !== at);
	if (at < 0) return [...lines, `  ${key}: ${value}`];
	return lines.map((line, index) => (index === at ? `  ${key}: ${value}` : line));
}

/** Rights state timing of a lease without hard end and with the template grace (rights/index.ts:15). */
// adapted from claim-reclaim-cli.test.ts:1030-1033
function leaseTiming(leaseEnd: number): JsonObject {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd: null };
}

/** An ACTIVE state of a departed holder under OTHER_BINDING. */
// adapted from claim-reclaim-cli.test.ts:1035-1047 (generation fixed at 1)
function activeState(owner: string, timing: JsonObject): JsonObject {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 1,
		bindingGeneration: 1,
		owner,
		binding: OTHER_BINDING,
		timing,
	};
}

// adapted from claim-reclaim-cli.test.ts:1100-1106
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** A Backlog project with task prefix BACK, the given To Do task files, no claims block and one commit. */
// adapted from claim-reclaim-cli.test.ts:1108-1135 (no claims block: S1 writes it with `claim setup`, every other
// scenario through the prepared setup; plain To Do tickets, or none where the scenario creates its own)
async function initProject(directory: string, tickets: readonly string[]): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim workflow examples");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" } });
	for (const id of tickets) {
		await core.filesystem.saveTask({
			id,
			title: `Workflow target ${id}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-29",
			rawContent: "",
		});
	}
	// The CLI migrates the configuration before each command; migrating here keeps the project stable.
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** The S1 hook script: numbers each invocation atomically, logs its stdin, then passes, rejects or holds. */
// adapted from claim-reclaim-cli.test.ts:1145-1170, unchanged
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

/** S1, test-local: scripted actions for both receive hooks of one server repository. */
// adapted from claim-reclaim-cli.test.ts:1172-1248 (settle and lines left out: no step here reads a push log)
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

/**
 * One scenario: a server area with S1 hooks, one project, a private parent for contexts, the placeholder bindings and
 * the outcomes of the document's steps. New; the writer is adapted from claim-reclaim-cli.test.ts:1428-1454.
 */
class Scene {
	readonly hooks: ReceiveScript;
	readonly bindings = new Map<string, string>();
	readonly outcomes: Outcome[] = [];
	readonly hardEnd: number;
	readonly earlierHardEnd: number;
	readonly laterHardEnd: number;
	matched: readonly (number | undefined)[] = [];
	private writes = 0;
	private writer: ClaimStore | undefined;

	private constructor(
		readonly spec: ScenarioSpec,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		readonly privateDir: string,
	) {
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		// Brief decision 3: <hard-end> is the scenario start plus one hour, <earlier-hard-end> plus thirty minutes.
		const startedAt = Date.now();
		this.hardEnd = startedAt + 60 * MINUTE;
		this.earlierHardEnd = startedAt + 30 * MINUTE;
		// <later-hard-end> about two hours ahead (cli-01 and cli-02 extend by the same hour).
		this.laterHardEnd = startedAt + 120 * MINUTE;
		this.bindings.set("<endpoint>", url);
		this.bindings.set("<private-dir>", privateDir);
		this.bindings.set("<hard-end>", new Date(this.hardEnd).toISOString());
		this.bindings.set("<earlier-hard-end>", new Date(this.earlierHardEnd).toISOString());
		this.bindings.set("<later-hard-end>", new Date(this.laterHardEnd).toISOString());
	}

	static async create(spec: ScenarioSpec): Promise<Scene> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-workflow-${SENTINEL}-${spec.id}-`));
		try {
			const { name, repo } = await server().initRepository(root, `workflow-${spec.id}`);
			const project = join(root, "project");
			await initProject(project, spec.tickets === "fixture" ? FIXTURE_TICKETS : []);
			// Brief decision 3: <private-dir> is a 0700 directory of this scenario (claim-cli.test.ts:2165-2170).
			const privateDir = join(root, "contexts");
			await mkdir(privateDir);
			await chmod(privateDir, 0o700);
			const scene = new Scene(spec, root, server().url(name), repo, project, privateDir);
			await scene.hooks.install();
			return scene;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** "Set up as in S1" through the reader's own commands, over the same wrapper. */
	async prepare(): Promise<void> {
		if (!this.spec.prepared) return;
		const parent = shellQuote(this.privateDir);
		const endpoint = shellQuote(this.url);
		const lines = [
			`backlog claim setup --endpoint ${endpoint} --storage-format blob --clock-uncertainty-ms ${EPS_ARG} --json`,
			"backlog claim init --json",
			`backlog claim context create --parent ${parent} --json`,
			`backlog claim context create --parent ${parent} --json`,
		];
		for (const line of lines) {
			const run = await shell(this.project, line);
			const doc = parseJson(run.stdout);
			if (run.exit !== 0 || field(doc, "status") !== "ok") {
				throw new Error(`${this.spec.id} preparation failed at ${line}: exit ${run.exit}, ${run.stdout}${run.stderr}`);
			}
			const problem = this.bindContext(line, doc);
			if (problem !== null) throw new Error(`${this.spec.id} preparation: ${problem}`);
		}
	}

	/** Brief decision 6: departed claims exist before the first step; the document describes them in prose. */
	async plantAll(): Promise<void> {
		for (const plant of this.spec.plants ?? []) {
			await this.writeState(plant.ticket, activeState(plant.owner, leaseTiming(plant.leaseEnd)));
		}
	}

	/** Brief decision 4: the test writes the claims block, never a `backlog config set` step (cli.ts:173-189). */
	async configure(changes: readonly ConfigChange[]): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (config?.claimsYaml === undefined) throw new Error(`${this.spec.id}: no claims block to change`);
		let lines = config.claimsYaml.split("\n");
		for (const [key, value] of changes) lines = withKey(lines, key, value);
		await core.filesystem.saveConfig({ ...config, claimsYaml: lines.join("\n") });
	}

	/** One step as a reader runs it; binds a created context and the ID of an `unknown` step (decision 3). */
	async execute(example: Example): Promise<Outcome> {
		const unbound: string[] = [];
		const line = example.command.replace(PLACEHOLDER, (name) => {
			const value = this.bindings.get(name);
			if (value === undefined) unbound.push(name);
			return value === undefined ? name : shellQuote(value);
		});
		if (unbound.length > 0) {
			return { example, run: null, doc: null, pushes: 0, problem: `unbound ${unbound.join(", ")}` };
		}
		const before = await this.hooks.count("pre");
		const run = await shell(this.project, line);
		const pushes = (await this.hooks.count("pre")) - before;
		const doc = example.verb === TASK_CREATE ? null : parseJson(run.stdout);
		const problem = this.bindContext(example.command, doc);
		const operationId = field(doc, "operationId");
		if (field(doc, "status") === "unknown" && typeof operationId === "string") {
			this.bindings.set("<operation-id>", operationId);
		}
		// The confirmation ID of the last `unknown` time-path call, by the rule of <operation-id>.
		const confirmOperationId = field(field(doc, "transition"), "confirmOperationId");
		if (field(doc, "status") === "unknown" && typeof confirmOperationId === "string") {
			this.bindings.set("<confirm-operation-id>", confirmOperationId);
		}
		return { example, run, doc, pushes, problem };
	}

	/**
	 * The calls that bring the scenario to where its document starts, through the reader's CLI and
	 * the bindings of `execute`; each must end as its row says, else the scenario cannot show what it documents.
	 */
	async runPrologue(): Promise<void> {
		const prologue = this.spec.prologue;
		if (prologue === undefined) return;
		await this.configure(prologue.config);
		for (const [index, call] of prologue.calls.entries()) {
			const id = `${this.spec.id} prologue ${index + 1}`;
			const example: Example = {
				id,
				scenario: this.spec.id,
				line: 0,
				pins: {},
				command: call.line,
				verb: verbOf(call.line),
				problems: [],
			};
			// tpg-12: P passes, the pre-receive hook refuses A while p stays current, A stays open.
			if (call.refuseConfirmation === true) await this.hooks.plan("pre", ["pass"], "reject");
			const outcome = await this.execute(example);
			if (call.refuseConfirmation === true) await this.hooks.plan("pre", [], "pass");
			const status = field(outcome.doc, "status") ?? null;
			const phase = field(field(outcome.doc, "transition"), "phase") ?? null;
			if (outcome.problem !== null || status !== call.status || phase !== (call.phase ?? null)) {
				const output = outcome.run === null ? outcome.problem : `${outcome.run.stdout}${outcome.run.stderr}`;
				throw new Error(`${id} ended ${String(status)}/${String(phase)}: ${output}`);
			}
		}
	}

	/** The outcome of mandatory row `position`, when it was matched and has run. */
	mandatory(position: number): Outcome | undefined {
		const at = this.matched[position];
		return at === undefined ? undefined : this.outcomes[at];
	}

	async ticketFacts(id: string): Promise<TicketFacts | null> {
		const tasks = await new Core(this.project).filesystem.listTasks();
		const task = tasks.find((candidate) => candidate.id.toUpperCase() === id);
		if (task === undefined) return null;
		return { status: task.status, labels: [...task.labels], dependencies: [...task.dependencies].sort(byCodeUnits) };
	}

	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}

	/** `<private-dir>/<contextId>` to the next free of <context-a>, <context-b>, or the recovery. */
	private bindContext(command: string, doc: unknown): string | null {
		if (!command.startsWith("backlog claim context create") || field(doc, "status") !== "ok") return null;
		const contextId = field(doc, "contextId");
		if (typeof contextId !== "string") return "context create printed no contextId";
		const recovered = command.split(" ").includes("--recover-from");
		const free = recovered ? ["<context-a-recovered>"] : ["<context-a>", "<context-b>"];
		const slot = free.find((name) => !this.bindings.has(name));
		if (slot === undefined) return `no free placeholder for a new context (${free.join(", ")} bound)`;
		this.bindings.set(slot, join(this.privateDir, contextId));
		return null;
	}

	/** An independent writer's change on the server. */
	// adapted from claim-reclaim-cli.test.ts:1428-1449 (one cached writer)
	private async writeState(ticket: string, payload: JsonObject): Promise<void> {
		const store = await this.store();
		const base = await store.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		expectKind(await store.write(base, { operationId, receipt, payload }), "applied");
	}

	private async store(): Promise<ClaimStore> {
		if (this.writer !== undefined) return this.writer;
		const repository = await initClient(join(this.root, "writer"));
		const options = { repository, remote: this.url, format: "blob" as const, timeoutMs: ADAPTER_TIMEOUT };
		this.writer = expectKind(await openClaimStore(options), "open").store;
		return this.writer;
	}
}

/** One scenario test: document checks first (RED stops there), then every step in order, then the mandatory facts. */
async function runScenario(spec: ScenarioSpec): Promise<void> {
	const markdown = await readDocument(join(REPO_ROOT, "CLAIMS.md"));
	const found = markdown === null ? undefined : scenarioHeadings(markdown).find((entry) => entry.id === spec.id);
	// Positive control (catches: CLAIMS.md absent at the repository root, RED on the base commit; the heading of this
	// scenario missing, renamed or outside the section this file assigns it).
	expect({ scenario: spec.id, section: sectionState(markdown, found, spec) }).toEqual({
		scenario: spec.id,
		section: "present",
	});
	if (markdown === null || found === undefined) throw new Error(`${spec.id}: unreachable after the positive control`);
	const { heading } = found;
	const examples = examplesIn(markdown, heading);
	// catches: a scenario without steps; a comment grammar the test cannot read; a claim line without --json; an
	// unknown or quoted placeholder; a shell operator; steps out of order or numbered for another scenario.
	expect({
		scenario: spec.id,
		steps: examples.length > 0,
		problems: [...examples.flatMap((example) => example.problems), ...sequenceProblems(spec.id, examples)],
	}).toEqual({ scenario: spec.id, steps: true, problems: [] });
	const { matched, missing } = matchMandatory(examples, spec.steps);
	// catches: the document recording what the product happens to do instead of the contract: a
	// mandatory step missing, reordered, with another status, exit, code or cause, or without its option.
	expect({ scenario: spec.id, missing }).toEqual({ scenario: spec.id, missing: [] });
	// catches: a configuration change the test makes but the reader is never shown.
	expect({ scenario: spec.id, notShown: configNotShown(markdown, heading, spec.steps) }).toEqual({
		scenario: spec.id,
		notShown: [],
	});
	const scene = await Scene.create(spec);
	try {
		scene.matched = matched;
		await scene.prepare();
		await scene.plantAll();
		await scene.runPrologue();
		for (const [index, example] of examples.entries()) {
			const position = matched.indexOf(index);
			const mandatory = position < 0 ? undefined : spec.steps[position];
			if (mandatory?.config !== undefined) await scene.configure(mandatory.config);
			// Brief decision 7 (adapted from claim-cli.test.ts:1320-1341): one attempt, held past the attempt timeout,
			// then rejected, so the intent stays open; every hold is released after the step.
			if (mandatory?.lostReply === true) await scene.hooks.plan("pre", ["hold-reject"], "pass");
			scene.outcomes.push(await scene.execute(example));
			if (mandatory?.lostReply === true) {
				await scene.hooks.releaseAll();
				await scene.hooks.plan("pre", [], "pass");
			}
		}
		// catches: a documented result that differs from the real run (status, exit code, a named code, cause or kind);
		// a text or more than one document on stdout, or a stderr text in JSON mode (claims.md:54); an unbound value.
		expect(scene.outcomes.map((outcome) => actualRow(outcome))).toEqual(
			examples.map((example) => expectedRow(example)),
		);
		const actual: Row[] = [];
		const wanted: Row[] = [];
		for (const [position, mandatory] of spec.steps.entries()) {
			const self = scene.mandatory(position);
			for (const check of mandatory.checks ?? []) {
				const label = `${spec.id} mandatory ${position + 1} (${self?.example.id ?? "not run"}): ${check.label}`;
				const context = self === undefined ? undefined : { scene, self, markdown, heading };
				actual.push({ check: label, value: context === undefined ? "(not run)" : await check.read(context) });
				wanted.push({ check: label, value: context === undefined ? "(not run)" : check.want(context) });
			}
		}
		// catches: the facts beside status and exit that the guide names per step (ticket, candidates, boundary, verdicts,
		// ownership, the real send of a retry); each row of the scenario table names its own catch.
		expect(actual).toEqual(wanted);
	} finally {
		await scene.dispose();
	}
}

function caseId(spec: ScenarioSpec): string {
	return `wf-S${spec.id.slice(1).padStart(2, "0")}`;
}

describe("CLAIMS.md workflow scenarios over real Git (blob)", () => {
	for (const spec of SCENARIOS) {
		test(`${caseId(spec)}: ${spec.title}`, () => runScenario(spec), SCENARIO_TIMEOUT);
	}
});

describe("CLAIMS.md structure, README entry and guideline sentences", () => {
	test(
		"wf-doc-01: CLAIMS.md holds the seven sections, S1 to S15 where they belong and only paired, well-formed steps",
		async () => {
			const markdown = await readDocument(join(REPO_ROOT, "CLAIMS.md"));
			// Positive control (catches: CLAIMS.md absent at the repository root; RED on the base commit).
			expect({ file: markdown === null ? "absent" : "present" }).toEqual({ file: "present" });
			if (markdown === null) throw new Error("unreachable after the positive control");
			const scenarios = scenarioHeadings(markdown);
			const listedIn = (home: Home) =>
				scenarios.filter((entry) => entry.home === home).map((entry) => `${entry.id} ${entry.name}`);
			const expectedIn = (home: Home) =>
				SCENARIOS.filter((spec) => spec.home === home).map((spec) => `${spec.id} ${spec.name}`);
			// catches: a section missing, renamed, reordered or added; a scenario missing, renamed, in the
			// other section or out of order (ASSUMPTION(guide): the split of the scenarios between the sections).
			expect({
				sections: markdown.headings.filter((heading) => heading.level === 2).map((heading) => heading.title),
				everyday: listedIn(EVERYDAY),
				wrong: listedIn(WRONG),
			}).toEqual({ sections: DOC_SECTIONS as string[], everyday: expectedIn(EVERYDAY), wrong: expectedIn(WRONG) });
			const inScenario = new Set(scenarios.flatMap((entry) => examplesIn(markdown, entry.heading)));
			const problems = [
				...markdown.problems,
				...markdown.examples.flatMap((example) => example.problems),
				...markdown.examples
					.filter((example) => !inScenario.has(example))
					.map((example) => `${example.id}: an example outside the scenarios S1 to S15`),
				...scenarios.flatMap((entry) => sequenceProblems(entry.id, examplesIn(markdown, entry.heading))),
			];
			// catches: a bash block without its comment or a comment without its block; a duplicate or misnumbered
			// step ID; an unknown placeholder; a claim line without --json; an example outside a scenario.
			expect({
				problems,
				empty: scenarios.filter((entry) => examplesIn(markdown, entry.heading).length === 0).map((entry) => entry.id),
			}).toEqual({ problems: [], empty: [] });
		},
		DOC_TIMEOUT,
	);

	test(
		"wf-doc-02: the README links CLAIMS.md beside the two guides and names the claims guide for agents",
		async () => {
			const readme = await readDocument(join(REPO_ROOT, "README.md"));
			if (readme === null) throw new Error("README.md is missing at the repository root");
			const links = sectionText(readme, "Working without AI agents")
				.split("\n")
				.filter((line) => line.includes("(CLI-INSTRUCTIONS.md)") && line.includes("(ADVANCED-CONFIG.md)"));
			// Positive control (catches: no "Claims" entry on the line of the two guide links, README.md:183 on the base
			// commit; RED on the base README).
			expect({ linkLines: links.length, claims: links.some((line) => CLAIMS_LINK.test(line)) }).toEqual({
				linkLines: 1,
				claims: true,
			});
			// catches: "Working with AI agents" without a paragraph naming `backlog instructions claims`.
			expect({ named: sectionText(readme, "Working with AI agents").includes("backlog instructions claims") }).toEqual({
				named: true,
			});
		},
		DOC_TIMEOUT,
	);

	test(
		"wf-doc-03: the overview names the claims guide and when to read it; task-execution adds its sentence at step 3",
		async () => {
			const overview = await guideText("overview");
			const execution = await guideText("task-execution");
			const paragraph = paragraphs(overview).find((part) => part.includes("backlog instructions claims")) ?? "";
			// Positive control (catches: an overview without a paragraph naming `backlog instructions claims`;
			// RED on the base guide overview.md).
			expect({ named: paragraph !== "" }).toEqual({ named: true });
			// catches: the paragraph without its moment: before acquiring, renewing, transferring or reclaiming.
			expect({ missing: WHEN_TERMS.filter((term) => !paragraph.toLowerCase().includes(term)) }).toEqual({
				missing: [],
			});
			const mark = execution.indexOf("Mark it in progress");
			const research = execution.indexOf("Research the current system");
			const at = execution.indexOf("backlog instructions claims");
			const stepThree = mark >= 0 && research > mark ? execution.slice(mark, research) : "";
			// catches: the sentence missing or away from "Mark it in progress" (step 3 ends where step 4 begins,
			// task-execution.md:17-20); the sentence without the assignee distinction.
			expect({
				anchors: stepThree !== "",
				beside: at > mark && at < research,
				assignee: stepThree.includes("assignee"),
			}).toEqual({ anchors: true, beside: true, assignee: true });
		},
		DOC_TIMEOUT,
	);

	test(
		"wf-doc-04: the JSON table equals the guide, recipes quote it verbatim, shell loops parse, the limits are named",
		async () => {
			const markdown = await readDocument(join(REPO_ROOT, "CLAIMS.md"));
			const guide = await guideText("claims");
			const guideTable = tableAfter(guide.split("\n"), STATUS_HEADER);
			const reading = markdown === null ? undefined : headingOf(markdown, "Reading the JSON", 2);
			const table =
				markdown === null || reading === undefined ? [] : tableAfter(proseLines(markdown, reading), STATUS_HEADER);
			// Positive control (catches: CLAIMS.md absent, RED on the base commit; the status table of "Reading the
			// JSON" not copied line by line from the guide or drifted from it; a guide table not found).
			expect({ guideRows: guideTable.length, table }).toEqual({ guideRows: 11, table: guideTable });
			if (markdown === null) throw new Error("unreachable after the positive control");
			const flat = normalized(guide);
			const recipes = subheadings(markdown, "Recipes").map((heading) => {
				const quotes = quoteBlocks(proseLines(markdown, heading));
				const paraphrased = quotes.filter((quote) => !flat.includes(quote));
				return { recipe: heading.title, quoted: quotes.length > 0, paraphrased };
			});
			// catches: fewer than the four recipes; a recipe without the guide sentence it rests on; a
			// quote that paraphrases or has drifted from the guide.
			expect({ atLeastFour: recipes.length >= 4, recipes }).toEqual({
				atLeastFour: true,
				recipes: recipes.map((entry) => ({ recipe: entry.recipe, quoted: true, paraphrased: [] })),
			});
			const recipesHeading = headingOf(markdown, "Recipes", 2);
			const snippets = markdown.blocks.filter((block) => block.lang === "sh");
			const loops = snippets.filter(
				(block) => recipesHeading !== undefined && block.open > recipesHeading.line && block.open < recipesHeading.end,
			);
			const broken: number[] = [];
			for (const block of snippets) {
				if ((await bashSyntax(block.body.join("\n"))) !== 0) broken.push(block.open + 1);
			}
			// catches: a heartbeat the reader cannot copy: no loop with `backlog claim renew`, `--json`
			// and `sleep`, or any sh block that fails `bash -n`.
			expect({ heartbeat: loops.some((block) => isHeartbeat(block)), broken }).toEqual({ heartbeat: true, broken: [] });
			const absentTerms = CONTENT_PINS.filter(
				([section, term]) => !sectionText(markdown, section).toLowerCase().includes(term.toLowerCase()),
			).map(([section, term]) => `${section}: ${term}`);
			// catches: a section that leaves out what the requirements name (ASSUMPTION(guide): wording proxies).
			expect(absentTerms).toEqual([]);
		},
		DOC_TIMEOUT,
	);
});
