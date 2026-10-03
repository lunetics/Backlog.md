/**
 * Level G: a claim Git command that exceeds `attempt_timeout_ms` is killed together with its transport helpers, and the
 * call returns within the attempt bound. The real `backlog claim … --json` subprocess against a loopback endpoint that
 * accepts and never answers (claim-git-fixture.ts StallProxy): `git://` as the control that returns today (k19-01),
 * `https://` (k19-02), `http://` (k19-03) and `ssh://` with a GIT_SSH_COMMAND stand-in that sleeps on the transport
 * call (k19-04; the image has no ssh client); a helper that escapes the group with `setsid` and keeps stderr open past
 * the kill, bounded by the margin ε (k19-05); and a push that stalls in receive-pack while every read is served, over
 * an ssh stand-in that runs upload-pack on the fixture repository and sleeps on receive-pack (k19-06, per storage
 * format). Pinned: the call returns within the bound with the unchanged mapping (`unreachable` for a read, `unknown`
 * for a push, the retry rule of the execution README) and a /proc scan right after the return finds no process of the
 * call. Processes are attributed by an environment marker that `gitEnvironment()` passes on to git, every helper and
 * the stand-ins, never by "new pid". Every row starts with a positive control: the transport's helper is seen alive
 * while the call runs (k19-05 also the escaped process); k19-01, k19-04 and k19-06 add a call against the live
 * loopback endpoint. Linux only (/proc, util-linux setsid). Harness: adapted copies with "adapted from" notes; every
 * existing file stays unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClaimContext } from "../claims/context/index.ts";
import { CLAIM_EXIT_CODES } from "../claims/surface/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Format = "blob" | "tree" | "commit-chain";
type Proc = { pid: number; comm: string; session: number; name: string };
type Call = {
	returned: boolean;
	elapsedMs: number | null;
	exit: number | null;
	doc: unknown;
	/** Name of every marked process seen while the call ran (`git <subcommand>` for git), the CLI itself excluded. */
	seen: string[];
	/** A marked `sleep` that leads its own session was seen while the call ran (k19-05). */
	escapedSeen: boolean;
	/** Marked processes alive right after the return (or at the cap), before the cleanup. */
	left: string[];
};

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly Format[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Review: the marker scan reads /proc, so the suite runs on Linux only (skipped elsewhere, fixtures included). */
const LINUX = process.platform === "linux";
const describeOnLinux = describe.skipIf(!LINUX);
const TEST_TIMEOUT = 90_000;
/** attempt_timeout_ms against the stalled endpoint (claim-endpoint-cli.test.ts STALL_TIMEOUT). */
const STALL_TIMEOUT = 750;
/** attempt_timeout_ms of the fixture work that is not under test: `claim init` and the live reads. */
const LIVE_TIMEOUT = 20_000;
const ATTEMPTS = 3;
/** The bound of the pipe reads after the kill. */
const EPSILON = 250;
/**
 * Scheduling margins over the attempt bound: the CLI start, the preflight and the local Git work, not
 * the kill (k19-probe1: pipes settle ≤ 2 ms after the group kill). Measured on the author's GREEN simulation k19-sim1
 * (Testbox, one CPU): stalled reads returned after 1.46–1.54 s, stalled pushes after 3.19–3.21 s; the margins keep
 * at least 2.5 times that. The failure they separate is a call that never returns, so a generous margin costs no
 * discrimination.
 */
const READ_MARGIN = 3_000;
const PUSH_MARGIN = 5_000;
/** A read ends after its first timed-out Git command (the preflight's first ls-remote; list pauses are fixed at 0). */
const READ_BOUND = STALL_TIMEOUT + EPSILON + READ_MARGIN;
/** Three pushes, each timed out, with the queries and reads in between served locally; pauses of at most 1 ms. */
const PUSH_BOUND = ATTEMPTS * (STALL_TIMEOUT + EPSILON) + PUSH_MARGIN;
/** A call still running here is reported as not returned; the test then ends it and every marked process. */
const CALL_CAP = 20_000;
const POLL_MS = 25;
/** The environment marker of one call; it reaches git and every helper through gitEnvironment(). */
const MARK = "BACKLOG_K19_CALL";
const MINUTE = 60_000;
const BLOCK_TTL = 5 * MINUTE;
const TTL = 2 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
const OWNER = "agent-owner-transport";
const TICKET = "BACK-1";
const CONTROL_TICKET = "BACK-2";
/** A read against the stalled endpoint: the preflight's store open times out (stall probe). */
const UNREACHABLE = {
	exit: CLAIM_EXIT_CODES.unavailable,
	kind: "claim-error",
	status: "unavailable",
	code: "unreachable",
};

let fixtureServer: GitFixtureServer | undefined;
let stall: StallProxy | undefined;
let calls = 0;
let repositories = 0;

beforeAll(async () => {
	// Bun runs file-level hooks even when every test of the file is skipped: no fixture off Linux.
	if (!LINUX) return;
	fixtureServer = await GitFixtureServer.create();
	stall = await StallProxy.create();
});

afterAll(async () => {
	await stall?.close();
	await fixtureServer?.close();
});

// adapted from claim-endpoint-cli.test.ts (gitServer)
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-endpoint-cli.test.ts (proxy)
function proxy(): StallProxy {
	if (!stall) throw new Error("stall proxy was not started");
	return stall;
}

// adapted from claim-endpoint-cli.test.ts (field, isRecord)
function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// adapted from claim-endpoint-cli.test.ts (parseDocument)
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/** The fixture environment without BACKLOG_CWD plus `extra` (an SSH command). */
// adapted from claim-endpoint-cli.test.ts (cliEnv)
function cliEnv(extra: Record<string, string>): Record<string, string> {
	const base = Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV);
	return { ...Object.fromEntries(base), ...extra };
}

// adapted from claim-endpoint-cli.test.ts (claimsBlock): the storage format and the attempt timeout are parameters
function claimsBlock(endpoint: string, format: Format, timeoutMs: number): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		`  storage_format: ${format}`,
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${BLOCK_TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${timeoutMs}`,
		`  attempts: ${ATTEMPTS}`,
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

/** A Backlog project with task prefix BACK, the given tickets, the claims block and one commit. */
// adapted from claim-endpoint-cli.test.ts (initProject): the tickets are a parameter
async function initProject(directory: string, block: string, tickets: readonly string[]): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim transport");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const ticket of tickets) {
		await core.filesystem.saveTask({
			id: ticket,
			title: `Claim target ${ticket}`,
			status: "To Do",
			assignee: [],
			labels: [],
			dependencies: [],
			createdDate: "2026-09-30",
			rawContent: "",
		});
	}
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** A private context through the context API, never the CLI under test; its directory. */
// adapted from claim-endpoint-cli.test.ts (newContext)
async function newContext(parent: string): Promise<string> {
	const created = await createClaimContext({ parent });
	if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
	return dirname(created.context.journalDirectory);
}

/** The Git subcommand of an argv (`git -C <dir> ls-remote …` → `ls-remote`; adapted from claim-endpoint-cli subcommandOf). */
function subcommandOf(argv: readonly string[]): string {
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "-c" || arg === "-C") index++;
		else if (!arg.startsWith("-")) return arg;
	}
	return "";
}

/** Live processes whose environment carries `mark` (adapted from k19-probe1: the environment tag). */
async function marked(mark: string): Promise<Proc[]> {
	const found: Proc[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const environ = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
			if (!environ.includes(`${MARK}=${mark}`)) continue;
			const stat = await readFile(`/proc/${entry}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).split(" ");
			if (fields[0] === "Z") continue;
			const comm = stat.slice(stat.indexOf("(") + 1, close);
			const argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
			const name = comm === "git" ? `git ${subcommandOf(argv)}` : comm;
			found.push({ pid: Number(entry), comm, session: Number(fields[3]), name });
		} catch {
			// ended while reading, or no longer holding an address space: not a live process of the call
		}
	}
	return found;
}

function described(found: Proc): string {
	return found.session === found.pid ? `${found.name} (own session)` : found.name;
}

/** Ends every marked process of `mark` and waits until none is left; only marked processes are ever signalled. */
async function endMarked(mark: string): Promise<void> {
	for (let round = 0; round < 40; round++) {
		const alive = await marked(mark);
		if (alive.length === 0) return;
		for (const { pid } of alive) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		await Bun.sleep(50);
	}
	throw new Error(`fixture: marked processes of ${mark} did not end`);
}

/**
 * One CLI call with `--json` under a fresh marker: polls the marked processes while it runs, reports whether it
 * returned before CALL_CAP, the elapsed time, the document and the marked processes alive right after the return.
 * A call that did not return is killed with every marked process; each call prints one `K19 {…}` evidence line.
 */
async function runCall(cwd: string, args: readonly string[], extra: Record<string, string> = {}): Promise<Call> {
	const mark = `${process.pid}-${++calls}`;
	const started = performance.now();
	const child = Bun.spawn(["bun", CLI_PATH, ...args, "--json"], {
		cwd,
		env: { ...cliEnv(extra), [MARK]: mark },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	void new Response(child.stderr).text();
	let exitedAt: number | undefined;
	void child.exited.then(() => {
		exitedAt = performance.now();
	});
	const seen = new Set<string>();
	let escapedSeen = false;
	while (exitedAt === undefined && performance.now() - started < CALL_CAP) {
		for (const found of await marked(mark)) {
			if (found.pid === child.pid) continue;
			seen.add(found.name);
			if (found.comm === "sleep" && found.session === found.pid) escapedSeen = true;
		}
		await Promise.race([child.exited, Bun.sleep(POLL_MS)]);
	}
	const returned = exitedAt !== undefined;
	const left = (await marked(mark))
		.filter((found) => found.pid !== child.pid)
		.map(described)
		.sort();
	if (!returned) child.kill("SIGKILL");
	await endMarked(mark);
	const text = await Promise.race([stdout, Bun.sleep(2_000).then(() => "")]);
	const elapsedMs = exitedAt === undefined ? null : Math.round(exitedAt - started);
	const call: Call = {
		returned,
		elapsedMs,
		exit: returned ? child.exitCode : null,
		doc: parseDocument(text),
		seen: [...seen].sort(),
		escapedSeen,
		left,
	};
	const evidence = { command: args.slice(0, 2).join(" "), ...call, doc: undefined, code: field(call.doc, "code") };
	console.log(`K19 ${JSON.stringify({ ...evidence, status: field(call.doc, "status") })}`);
	return call;
}

function within(call: Call, bound: number): boolean {
	return call.returned && call.elapsedMs !== null && call.elapsedMs <= bound;
}

/** Return, bound, the error document and the survivors of a read (k19-01 to k19-05). */
function readView(call: Call): Record<string, unknown> {
	return {
		returned: call.returned,
		withinBound: within(call, READ_BOUND),
		exit: call.exit,
		kind: field(call.doc, "kind") ?? null,
		status: field(call.doc, "status") ?? null,
		code: field(call.doc, "code") ?? null,
		left: call.left,
	};
}

/** The fields of a claim-operation document the unk-01 view compares (claim-cli.test.ts cliView), plus the return. */
function operationView(call: Call, bound: number): Record<string, unknown> {
	return {
		returned: call.returned,
		withinBound: within(call, bound),
		exit: call.exit,
		kind: field(call.doc, "kind") ?? null,
		status: field(call.doc, "status") ?? null,
		outcome: field(call.doc, "outcome") ?? null,
		storage: field(call.doc, "storage") ?? null,
		sends: field(call.doc, "sends") ?? null,
		stoppedBy: field(call.doc, "stoppedBy") ?? null,
		ownership: field(field(call.doc, "rights"), "ownership") ?? null,
		operationId: field(call.doc, "operationId") ?? null,
		left: call.left,
	};
}

function acquireArgs(ticket: string, context: string, operationId: string): string[] {
	const options = ["--ttl-ms", String(TTL), "--operation-id", operationId];
	return ["claim", "acquire", ticket, "--owner", OWNER, "--context", context, ...options];
}

/**
 * GIT_SSH_COMMAND stand-ins (the image has no ssh client). Each answers Git's `-G` variant probe as OpenSSH does,
 * so Git runs the transport call (stall probe). `stall` sleeps like an ssh against a silent host; `escape` also
 * starts a `setsid` sleep that leaves the process group and keeps the inherited stderr open (it cannot keep stdout:
 * a helper's stdout is Git's protocol pipe); `serve` runs upload-pack and receive-pack on the fixture repository
 * named by the URL path; `serve-stall` serves upload-pack and sleeps on receive-pack.
 */
function sshStub(kind: "stall" | "escape" | "serve" | "serve-stall"): string {
	const repos = gitServer().repos;
	const lines = ["#!/bin/sh", '[ "$1" = -G ] && exit 0'];
	if (kind === "stall") lines.push("exec sleep 100");
	if (kind === "escape") lines.push("setsid sleep 100 < /dev/null > /dev/null &", "exec sleep 100");
	if (kind === "serve" || kind === "serve-stall") {
		const serve = (service: string) =>
			`  "git-${service} '"*) path=\${last#"git-${service} '"}; exec git ${service} ${JSON.stringify(repos)}"\${path%"'"}" ;;`;
		lines.push(
			"for last; do :; done",
			'case "$last" in',
			serve("upload-pack"),
			kind === "serve" ? serve("receive-pack") : `  "git-receive-pack '"*) exec sleep 100 ;;`,
			"esac",
			'echo "unexpected ssh command: $last" >&2',
			"exit 1",
		);
	}
	return `${lines.join("\n")}\n`;
}

/** One case: a root with a context parent and the SSH stand-ins. */
class TransportCase {
	private constructor(
		readonly root: string,
		readonly parent: string,
	) {}

	static async create(label: string): Promise<TransportCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-transport-${label}-`));
		const parent = join(root, "contexts");
		await mkdir(parent);
		await chmod(parent, 0o700);
		return new TransportCase(root, parent);
	}

	async project(
		name: string,
		endpoint: string,
		options: { format?: Format; tickets?: readonly string[]; timeoutMs?: number } = {},
	): Promise<string> {
		const directory = join(this.root, name);
		const block = claimsBlock(endpoint, options.format ?? "blob", options.timeoutMs ?? STALL_TIMEOUT);
		await initProject(directory, block, options.tickets ?? []);
		return directory;
	}

	async ssh(kind: "stall" | "escape" | "serve" | "serve-stall"): Promise<string> {
		const path = join(this.root, `ssh-${kind}.sh`);
		await writeFile(path, sshStub(kind));
		await chmod(path, 0o755);
		return path;
	}

	/**
	 * An initialized coordination area on a fresh bare repository of the fixture server, created over git://; its
	 * name. No receive hooks: this suite needs no gates, and a hook start would only slow the pushes under test.
	 */
	async coordination(format: Format): Promise<string> {
		const name = `k19-${format}-${++repositories}`;
		const repo = join(gitServer().repos, `${name}.git`);
		await gitServer().git(gitServer().repos, ["init", "--quiet", "--bare", repo]);
		await gitServer().git(repo, ["config", "daemon.receivepack", "true"]);
		const init = await this.project(`init-${name}`, gitServer().url(name), { format, timeoutMs: LIVE_TIMEOUT });
		const created = await runCall(init, ["claim", "init"]);
		if (created.exit !== 0 || field(created.doc, "result") !== "created") {
			throw new Error(`fixture: claim init failed (${JSON.stringify(created.doc)})`);
		}
		return name;
	}

	async serverRef(name: string, ref: string): Promise<string | null> {
		const repo = join(gitServer().repos, `${name}.git`);
		const result = await gitServer().git(repo, ["for-each-ref", "--format=%(objectname)", ref]);
		return result.out.trim() || null;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(label: string, body: (fixture: TransportCase) => Promise<void>): Promise<void> {
	const fixture = await TransportCase.create(label);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describeOnLinux("a timed-out claim Git call ends its transport helpers and returns within the bound", () => {
	test(
		"k19-01: git:// control — a stalled read returns unreachable within the bound with no process left",
		async () => {
			await withCase("k19-01", async (fixture) => {
				// Positive control (catches: a broken project, CLI or fixture): the same read against the live
				// loopback endpoint lists.
				const name = await fixture.coordination("blob");
				const live = await fixture.project("live", gitServer().url(name), { timeoutMs: LIVE_TIMEOUT });
				const listed = await runCall(live, ["claim", "list"]);
				expect({ exit: listed.exit, kind: field(listed.doc, "kind"), status: field(listed.doc, "status") }).toEqual({
					exit: 0,
					kind: "claim-list",
					status: "ok",
				});
				const project = await fixture.project("stalled", `git://127.0.0.1:${proxy().port}/x.git`);
				const call = await runCall(project, ["claim", "list"]);
				// Control of the scan (catches: a scan that never sees the call): the ls-remote was seen while it ran.
				expect({ lsRemoteSeen: call.seen.includes("git ls-remote") }).toEqual({ lsRemoteSeen: true });
				// The control that returns today: git:// has no helper, the kill of git ends the call.
				expect(readView(call)).toEqual({ returned: true, withinBound: true, ...UNREACHABLE, left: [] });
			});
		},
		TEST_TIMEOUT,
	);

	for (const scheme of ["https", "http"] as const) {
		test(
			`${scheme === "https" ? "k19-02" : "k19-03"}: ${scheme}:// — a stalled read returns unreachable within the bound and leaves no helper`,
			async () => {
				await withCase(scheme, async (fixture) => {
					const project = await fixture.project("stalled", `${scheme}://127.0.0.1:${proxy().port}/x.git`);
					const call = await runCall(project, ["claim", "list"]);
					// Positive control (catches: a row that passes because Git failed early — a missing helper binary, a
					// refused URL, a config error): the transport helper was alive while the call ran.
					expect({ helperSeen: call.seen.includes("git-remote-http") }).toEqual({ helperSeen: true });
					// (catches: the kill of git alone, which leaves `git remote-http(s)` and `git-remote-http(s)`
					// holding stderr, so the call never returns; a group kill that misses a helper): the call returns
					// within the bound as unreachable and no process of the call is left.
					expect(readView(call)).toEqual({ returned: true, withinBound: true, ...UNREACHABLE, left: [] });
				});
			},
			TEST_TIMEOUT,
		);
	}

	test(
		"k19-04: ssh:// — a read stalled in the ssh command returns unreachable within the bound and leaves no helper",
		async () => {
			await withCase("k19-04", async (fixture) => {
				// Positive control (catches: a broken stand-in or endpoint): the same read over ssh against the live
				// fixture repository lists.
				const name = await fixture.coordination("blob");
				const endpoint = `ssh://git@127.0.0.1:${gitServer().port}/${name}.git`;
				const live = await fixture.project("live", endpoint, { timeoutMs: LIVE_TIMEOUT });
				const listed = await runCall(live, ["claim", "list"], { GIT_SSH_COMMAND: await fixture.ssh("serve") });
				expect({ exit: listed.exit, kind: field(listed.doc, "kind"), status: field(listed.doc, "status") }).toEqual({
					exit: 0,
					kind: "claim-list",
					status: "ok",
				});
				const project = await fixture.project("stalled", `ssh://git@127.0.0.1:${proxy().port}/x.git`);
				const call = await runCall(project, ["claim", "list"], { GIT_SSH_COMMAND: await fixture.ssh("stall") });
				// Positive control (catches: a row that passes because Git never ran the transport call): the ssh
				// command's sleep was alive while the call ran.
				expect({ helperSeen: call.seen.includes("sleep") }).toEqual({ helperSeen: true });
				// (catches: the kill of git alone, which leaves the ssh command holding stderr, so the call never
				// returns): the call returns within the bound as unreachable and no process of the call is left.
				expect(readView(call)).toEqual({ returned: true, withinBound: true, ...UNREACHABLE, left: [] });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k19-05: a helper that escapes the group and keeps stderr open cannot hold the call past the margin",
		async () => {
			await withCase("k19-05", async (fixture) => {
				const project = await fixture.project("escaped", `ssh://git@127.0.0.1:${proxy().port}/x.git`);
				const call = await runCall(project, ["claim", "list"], { GIT_SSH_COMMAND: await fixture.ssh("escape") });
				// Positive control (catches: an escape that never happened — then the row would pass on the group kill
				// alone and pin nothing): the ssh command's sleep and a sleep in its own session were alive.
				expect({ helperSeen: call.seen.includes("sleep"), escapedSeen: call.escapedSeen }).toEqual({
					helperSeen: true,
					escapedSeen: true,
				});
				// (catches: reads that wait for EOF after the kill, which an escaped helper withholds): the call
				// returns within the attempt timeout plus ε plus the margin as unreachable; only the escaped
				// sleep, outside the call's group, is left — git and the ssh command are gone.
				expect(readView(call)).toEqual({
					returned: true,
					withinBound: true,
					...UNREACHABLE,
					left: ["sleep (own session)"],
				});
			});
		},
		TEST_TIMEOUT,
	);

	for (const format of FORMATS) {
		test(
			`k19-06 (${format}): a push stalled in receive-pack ends unknown after ${ATTEMPTS} sends within the bound and leaves no helper`,
			async () => {
				await withCase(`k19-06-${format}`, async (fixture) => {
					const name = await fixture.coordination(format);
					const endpoint = `ssh://git@127.0.0.1:${gitServer().port}/${name}.git`;
					const project = await fixture.project("agent", endpoint, { format, tickets: [TICKET, CONTROL_TICKET] });
					const context = await newContext(fixture.parent);
					// Positive control (catches: a broken stand-in, context or project): the same acquire of another
					// ticket over the fully serving ssh command applies.
					const control = await runCall(project, acquireArgs(CONTROL_TICKET, context, `op-k19-06-control-${format}`), {
						GIT_SSH_COMMAND: await fixture.ssh("serve"),
					});
					expect({
						exit: control.exit,
						outcome: field(control.doc, "outcome"),
						sends: field(control.doc, "sends"),
						ref: (await fixture.serverRef(name, `refs/claims/${CONTROL_TICKET}`)) !== null,
					}).toEqual({ exit: 0, outcome: "applied", sends: 1, ref: true });
					const operationId = `op-k19-06-${format}`;
					const call = await runCall(project, acquireArgs(TICKET, context, operationId), {
						GIT_SSH_COMMAND: await fixture.ssh("serve-stall"),
					});
					// Positive control (catches: a call that never reached the push): the reads were served and the
					// receive-pack sleep was alive.
					expect({ pushSeen: call.seen.includes("sleep") }).toEqual({ pushSeen: true });
					// (catches: the kill of git alone, which leaves the ssh command holding stderr, so the first push
					// never returns; a changed mapping): every push times out, is killed with its ssh command and ends
					// unknown; each query shows the intent open, so it is sent again up to the attempts (execution README,
					// "Retry rule"; the unk-01 view of claim-cli.test.ts with three sends); the call returns within the
					// bound, no process of the call is left and the ticket ref was never written.
					const pushed: Record<string, unknown> = {
						...operationView(call, PUSH_BOUND),
						ref: await fixture.serverRef(name, `refs/claims/${TICKET}`),
					};
					expect(pushed).toEqual({
						returned: true,
						withinBound: true,
						exit: CLAIM_EXIT_CODES.unknown,
						kind: "claim-operation",
						status: "unknown",
						outcome: "unknown",
						storage: { kind: "queried", after: "unknown", query: { kind: "resolved", resolution: "open" } },
						sends: ATTEMPTS,
						stoppedBy: "attempts",
						ownership: "absent",
						operationId,
						left: [],
						ref: null,
					});
				});
			},
			TEST_TIMEOUT,
		);
	}
});
