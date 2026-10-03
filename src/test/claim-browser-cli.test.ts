/**
 * Level E: the claim owner route `GET /api/tasks/:id/claim` of a real in-process `BacklogServer`, fetched over HTTP on
 * 127.0.0.1 like server-drafts-endpoint.test.ts, against the real `backlog claim list --ticket <id> --json`
 * subprocess on the same project over the loopback Git daemon (e01), and the documented join recipe of
 * `claim list --json` with `task list --json --revision` on one fixture (e02). Both sides of e01 run `runClaimList`
 * without a context, so the parity view masks `observedAt` only, and only inside the window of the test; the lease end
 * stays raw because both read the same stored state. Only the endpoint body is compared here: `/api/config` and
 * `/api/status`, which already send the endpoint URL and the project root, are outside this file and outside the
 * sentinel scan of srv-g13. Every test starts with a positive control that the scaffold (the route answers
 * `claim-error internal`, `--revision` is registered and ignored) cannot satisfy; the CLI side is the working
 * reference.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createClaimContext } from "../claims/context/index.ts";
import { type ClaimStorageFormat, initializeClaimStorage } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BacklogServer } from "../server/index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type CliRun = { exit: number; stdout: string; stderr: string };
/** One answer of the claim owner route: the HTTP status and the raw body. */
type HttpRun = { status: number; text: string };
/** Epoch milliseconds around the steps of one test; a clock field is masked only inside it plus its offset. */
type Window = { from: number; to: number };
/** Where the claims block of an e01 project points: the case area, nowhere (no block) or a refused loopback port. */
type EndpointKind = "area" | "none" | "refused";
type ParityRow = {
	label: string;
	endpoint: EndpointKind;
	acquire: boolean;
	/** The exit code of the reference CLI for the document's status (claims/surface/index.ts:114-124). */
	exit: number;
	expected: Record<string, unknown>;
};
/** One joined ticket of the recipe: the owner from the claim list, presence and revision from the task list. */
type JoinRow = { owner: unknown; local: boolean; revision: unknown };

const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Like claim-mcp-cli.test.ts:42: Git daemon, area init, up to five CLI starts and one server per test. */
const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms, far below the 10 s start value so that a hang shows (claim-cli.test.ts:106-107). */
const ADAPTER_TIMEOUT = 3_000;
const FORMAT: ClaimStorageFormat = "blob";
const MINUTE = 60_000;
/** lease_ttl_ms of the block; every acquire here takes it, so a lease end is the acquire's clock plus TTL. */
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
const TICKET = "BACK-1";
/** A local ticket nobody claimed: in the task list only. */
const LOCAL_ONLY = "BACK-2";
/** A ticket claimed from a second project on the same endpoint: in the claim list only. */
const REMOTE_ONLY = "BACK-3";
const OWNER = "agent-owner-browser";
const REMOTE_OWNER = "agent-owner-elsewhere";
/** The mask of a clock field that lies inside its window. */
const CLOCK = "<clock>";
/** A key the document does not carry; distinct from null, which a document may carry. */
const ABSENT = "<absent>";
/** MESSAGES["not-configured"], base/src/claims/surface/index.ts:254. */
const NOT_CONFIGURED = "claims are not configured for this project";
/** MESSAGES.unreachable, base/src/claims/surface/index.ts:264. */
const UNREACHABLE = "the claim coordination endpoint could not be reached";
/** The held lease of one ticket as the masked positive-control view shows it (claims/surface/index.ts:2930). */
const LEASE = { mode: "lease", leaseEnd: CLOCK, hardEnd: null, graceMs: GRACE };

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-mcp-cli.test.ts:87-90
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-mcp-cli.test.ts:93-96
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-mcp-cli.test.ts:99-102
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-mcp-cli.test.ts:105-108
function expectKind<V extends { kind: string }, K extends V["kind"]>(value: V, kind: K): Extract<V, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<V, { kind: K }>;
}

// adapted from claim-mcp-cli.test.ts:111-113
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value under `key`, or ABSENT when the object does not carry the key at all. */
function own(value: unknown, key: string): unknown {
	return isRecord(value) && key in value ? value[key] : ABSENT;
}

function arrayField(value: unknown, key: string): unknown[] {
	const items = field(value, key);
	return Array.isArray(items) ? items : [];
}

// adapted from claim-mcp-cli.test.ts:121-128; an unparsable body (the SPA fallback, a text 500) stays comparable
function parseDocument(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { kind: "unparsable" };
	}
}

/** The fixture environment without BACKLOG_CWD, so the working directory alone selects the project. */
// adapted from claim-mcp-cli.test.ts:132-134
function cliEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV));
}

// adapted from claim-mcp-cli.test.ts:137-140
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv()).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// adapted from claim-mcp-cli.test.ts:156-172: the lease block with the three surface keys
function claimsBlock(endpoint: string): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${FORMAT}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

// adapted from claim-mcp-cli.test.ts:175-198 (and claim-cli.test.ts:769-800 for several tickets): task prefix BACK,
// the given tickets, the block or none, one committed repository
async function initProject(directory: string, tickets: readonly string[], block: string | undefined): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim Browser CLI");
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
			createdDate: "2026-09-29",
			rawContent: "",
		};
		await core.filesystem.saveTask(task);
	}
	// The CLI migrates the configuration before each command; migrating here gives the server the same file.
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

// adapted from claim-mcp-cli.test.ts:201-207: the storage API only, never the CLI under test
async function initArea(client: string, url: string): Promise<void> {
	await mkdir(client);
	await gitServer().git(client, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(client, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	const options = { repository: client, remote: url, format: FORMAT, timeoutMs: ADAPTER_TIMEOUT };
	expectKind(await initializeClaimStorage(options), "created");
}

/** One case root with its own server area, projects and private contexts; nothing is shared between tests. */
class Fixture {
	private areaUrl: string | undefined;
	private contexts = 0;

	private constructor(readonly root: string) {}

	static async create(): Promise<Fixture> {
		return new Fixture(await mkdtemp(join(FIXTURE_ROOT, "claim-browser-cli-")));
	}

	/** The initialized coordination area of this case on the loopback daemon, created on first use. */
	async area(): Promise<string> {
		if (this.areaUrl !== undefined) return this.areaUrl;
		const { name } = await gitServer().initRepository(this.root, "browser-e");
		const url = gitServer().url(name);
		await initArea(join(this.root, "client"), url);
		this.areaUrl = url;
		return url;
	}

	/** A project with the given local tickets and a claims block on `endpoint`, or none when it is null. */
	async project(label: string, tickets: readonly string[], endpoint: string | null): Promise<string> {
		const directory = join(this.root, `project-${label}`);
		await initProject(directory, tickets, endpoint === null ? undefined : claimsBlock(endpoint));
		return directory;
	}

	// adapted from claim-mcp-cli.test.ts:216-221 (side): the context API, never the CLI under test
	async context(): Promise<string> {
		this.contexts += 1;
		const parent = join(this.root, `contexts-${this.contexts}`);
		await mkdir(parent);
		await chmod(parent, 0o700);
		const { context } = expectKind(await createClaimContext({ parent }), "created");
		return dirname(context.journalDirectory);
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = await Fixture.create();
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

/** The claims endpoint of an e01 row; a refused port was never a Git endpoint (claim-preflight.test.ts:511-513). */
async function endpointOf(fixture: Fixture, kind: EndpointKind): Promise<string | null> {
	if (kind === "none") return null;
	if (kind === "area") return fixture.area();
	return `git://127.0.0.1:${await unusedLoopbackPort()}/claim-browser-refused.git`;
}

/** The reference acquire through the canonical CLI; returns the document's status. */
async function acquire(project: string, ticket: string, context: string, owner: string): Promise<unknown> {
	const run = await runCli(project, ["claim", "acquire", ticket, "--owner", owner, "--context", context, "--json"]);
	return field(parseDocument(run.stdout), "status") ?? null;
}

/**
 * One GET of the claim owner route on a fresh in-process server of `project`, over HTTP on 127.0.0.1 (adapted from
 * server-drafts-endpoint.test.ts:15-17 and :44-48). A fresh server per call, so no answer can come from an earlier one.
 */
async function endpointRun(project: string, ticket: string): Promise<HttpRun> {
	const server = new BacklogServer(project);
	try {
		await server.start(0, false);
		const port = server.getPort();
		if (port === null) throw new Error("the Backlog server reported no port");
		const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(ticket)}/claim`);
		return { status: response.status, text: await response.text() };
	} finally {
		await server.stop();
	}
}

// adapted from claim-mcp-cli.test.ts:326-329
function clockMark(value: unknown, window: Window, offset: number): unknown {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return value;
	return value >= window.from + offset && value <= window.to + offset ? CLOCK : value;
}

/** The parity view masks `observedAt` only, and only inside the window; the key order is kept. */
function withoutClock(doc: unknown, window: Window): unknown {
	if (!isRecord(doc) || !("observedAt" in doc)) return doc;
	return { ...doc, observedAt: clockMark(doc.observedAt, window, 0) };
}

/** A lease end is the acquire's clock plus the block TTL (claim-mcp-cli.test.ts:331-335). */
function maskedEntry(entry: unknown, window: Window): unknown {
	const timing = field(entry, "timing");
	if (!isRecord(entry) || !isRecord(timing) || timing.mode !== "lease") return entry;
	return { ...entry, timing: { ...timing, leaseEnd: clockMark(timing.leaseEnd, window, TTL) } };
}

/** The positive-control view against a literal document: additionally the lease ends of the entries. */
function view(doc: unknown, window: Window): unknown {
	const copy = withoutClock(doc, window);
	if (!isRecord(copy) || !Array.isArray(copy.claims)) return copy;
	return { ...copy, claims: copy.claims.map((entry: unknown) => maskedEntry(entry, window)) };
}

/** The text printed again like `formatJson` (json-output.ts:280-282) after the parity mask; byte-comparable. */
function canonical(text: string, window: Window): string {
	return `${JSON.stringify(withoutClock(parseDocument(text), window), null, 2)}\n`;
}

/** (list): an ok listing with its entries; the observation instant is the masked clock. */
function listed(claims: readonly Record<string, unknown>[]): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-list",
		status: "ok",
		command: "list",
		complete: true,
		observedAt: CLOCK,
		claims,
	};
}

/** An active entry without a context: owner, generation, epoch 1, timing, never `rights` (surface :2930). */
function activeEntry(ticket: string, owner: string): Record<string, unknown> {
	return { ticket, state: "active", owner, claimGeneration: 1, epoch: 1, timing: LEASE };
}

/** A refusal of the list for the one ticket (surface :1382-1406); status and message from the fixed tables. */
function listError(status: string, code: string, message: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status,
		command: "list",
		code,
		message,
		ticket: TICKET,
		operationId: null,
	};
}

/** The documented join on the canonical id: owner from the claim list, revision from the task list. */
function joined(claimDocument: unknown, taskDocument: unknown): Record<string, JoinRow> {
	const owners = new Map<string, unknown>();
	for (const entry of arrayField(claimDocument, "claims")) {
		owners.set(String(field(entry, "ticket")), field(entry, "owner") ?? null);
	}
	const revisions = new Map<string, unknown>();
	for (const task of arrayField(taskDocument, "tasks")) revisions.set(String(field(task, "id")), own(task, "revision"));
	const ids = [...new Set([...owners.keys(), ...revisions.keys()])].sort(byCodeUnits);
	const row = (id: string): JoinRow => ({
		owner: owners.get(id) ?? null,
		local: revisions.has(id),
		revision: revisions.get(id) ?? ABSENT,
	});
	return Object.fromEntries(ids.map((id): [string, JoinRow] => [id, row(id)]));
}

function taskIds(taskDocument: unknown): string[] {
	const ids = arrayField(taskDocument, "tasks").map((task) => String(field(task, "id")));
	return ids.sort(byCodeUnits);
}

/** The task file of `id` in `project`, found by its file name (`<id> - <title>.md`), independent of the product. */
async function taskFile(project: string, id: string): Promise<string> {
	const directory = join(project, "backlog", "tasks");
	const prefix = `${id.toLowerCase()} - `;
	const matches = (await readdir(directory)).filter((name) => name.toLowerCase().startsWith(prefix));
	const [match] = matches;
	if (matches.length !== 1 || match === undefined) throw new Error(`expected one task file for ${id}`);
	return join(directory, match);
}

/** `sha256:` plus the SHA-256 of the task file's bytes, computed here with node:crypto. */
async function fileRevision(project: string, id: string): Promise<string> {
	const bytes = await readFile(await taskFile(project, id));
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const PARITY_ROWS: readonly ParityRow[] = [
	{ label: "active", endpoint: "area", acquire: true, exit: 0, expected: listed([activeEntry(TICKET, OWNER)]) },
	{ label: "free", endpoint: "area", acquire: false, exit: 0, expected: listed([{ ticket: TICKET, state: "free" }]) },
	{
		label: "not-configured",
		endpoint: "none",
		acquire: false,
		exit: 5,
		expected: listError("refused", "not-configured", NOT_CONFIGURED),
	},
	{
		label: "unreachable",
		endpoint: "refused",
		acquire: false,
		exit: 6,
		expected: listError("unavailable", "unreachable", UNREACHABLE),
	},
];

describe(`claim owner endpoint against the claim CLI subprocess (${FORMAT})`, () => {
	for (const row of PARITY_ROWS) {
		test(
			`e01: ${row.label} — the endpoint body equals claim list --ticket ${TICKET} --json with observedAt masked`,
			async () => {
				await withFixture(async (fixture) => {
					const project = await fixture.project(row.label, [TICKET], await endpointOf(fixture, row.endpoint));
					const from = Date.now();
					const prepared = row.acquire ? await acquire(project, TICKET, await fixture.context(), OWNER) : null;
					const cli = await runCli(project, ["claim", "list", "--ticket", TICKET, "--json"]);
					const endpoint = await endpointRun(project, TICKET);
					const window = { from, to: Date.now() };
					// Positive control (catches: a missing route — the SPA fallback or a text 404 is unparsable —, the
					// scaffold's claim-error internal, a browser projection instead of the CLI document, a document built
					// with a context — `rights` in the entry — and any other document than the reference CLI's).
					expect({
						prepared,
						cli: view(parseDocument(cli.stdout), window),
						endpoint: view(parseDocument(endpoint.text), window),
					}).toEqual({ prepared: row.acquire ? "applied" : null, cli: row.expected, endpoint: row.expected });
					// catches: a projection that rebuilds or drops a field (the lease end stays raw here,
					// only observedAt is masked, both sides read the same stored state).
					expect(withoutClock(parseDocument(endpoint.text), window)).toEqual(
						withoutClock(parseDocument(cli.stdout), window),
					);
					// catches: a rebuilt document in another key order ("the UNCHANGED CLI document").
					expect(canonical(endpoint.text, window)).toBe(canonical(cli.stdout, window));
					// catches: a non-200 answer for a refusal or an unavailable endpoint (the document's
					// status carries the semantics), an exit code or stderr text on the reference.
					expect({ http: endpoint.status, exit: cli.exit, stderr: cli.stderr }).toEqual({
						http: 200,
						exit: row.exit,
						stderr: "",
					});
				});
			},
			TEST_TIMEOUT,
		);
	}

	test(
		"e02: the join recipe — claim list --json and task list --json --revision on one fixture",
		async () => {
			await withFixture(async (fixture) => {
				const url = await fixture.area();
				const local = await fixture.project("local", [TICKET, LOCAL_ONLY], url);
				const remote = await fixture.project("remote", [REMOTE_ONLY], url);
				const from = Date.now();
				const prepared = [
					await acquire(local, TICKET, await fixture.context(), OWNER),
					await acquire(remote, REMOTE_ONLY, await fixture.context(), REMOTE_OWNER),
				];
				const claims = await runCli(local, ["claim", "list", "--json"]);
				const tasks = await runCli(local, ["task", "list", "--json", "--revision"]);
				const window = { from, to: Date.now() };
				const claimedRevision = await fileRevision(local, TICKET);
				const unclaimedRevision = await fileRevision(local, LOCAL_ONLY);
				const claimDocument = parseDocument(claims.stdout);
				const taskDocument = parseDocument(tasks.stdout);
				// Positive control (catches: an ignored --revision — the scaffold —, a revision that is not the SHA-256
				// of the local file bytes, a claim list narrowed to local tickets).
				expect({
					prepared,
					claims: view(claimDocument, window),
					join: joined(claimDocument, taskDocument),
				}).toEqual({
					prepared: ["applied", "applied"],
					claims: listed([activeEntry(TICKET, OWNER), activeEntry(REMOTE_ONLY, REMOTE_OWNER)]),
					join: {
						[TICKET]: { owner: OWNER, local: true, revision: claimedRevision },
						[LOCAL_ONLY]: { owner: null, local: true, revision: unclaimedRevision },
						[REMOTE_ONLY]: { owner: REMOTE_OWNER, local: false, revision: ABSENT },
					},
				});
				// catches: a task list that lists a ticket it knows only from the claim area (a ticket only in the
				// claim list is not local), or ids in another case than the claim list's canonical ones.
				expect(taskIds(taskDocument)).toEqual([TICKET, LOCAL_ONLY]);
				// catches: an exit code or stderr text on either side of the recipe.
				expect([claims.exit, claims.stderr, tasks.exit, tasks.stderr]).toEqual([0, "", 0, ""]);
			});
		},
		TEST_TIMEOUT,
	);
});
