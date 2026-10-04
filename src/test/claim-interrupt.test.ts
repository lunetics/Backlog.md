/**
 * A terminal signal reaches the in-flight claim Git call. The real `backlog claim … --json` subprocess, started as the
 * leader of its own process group like a job of an interactive shell, runs a Git call against a loopback endpoint that
 * accepts and never answers (claim-git-fixture.ts StallProxy; `attempt_timeout_ms` 20000 with one attempt, so no claim
 * timeout fires inside the window); once the transport's helper is seen, the test sends the signal to the CLI's GROUP,
 * as a terminal does. Pinned: the command ends by the signal within 2 s (the re-raise reaches signal-exit, loaded with
 * proper-lockfile, as the only listener, and it ends the process) and no process of the call is alive at +100 ms, +1 s
 * and +3 s — `git://` (k21-01, git itself), `https://` (k21-02), `http://` (k21-03) and `ssh://` with a
 * GIT_SSH_COMMAND stand-in that sleeps (k21-04) under SIGINT; SIGTERM (k21-05) and SIGHUP (k21-06) over https; a push
 * stalled in receive-pack behind served reads (k21-07). `mcp start` with a `claim_list` call in flight keeps its own
 * shutdown: exit 0 within 5 s and no process of the call left (k21-08; a minimal stdio JSON-RPC client, because the
 * server must lead its own group). In-process, the module holds one listener per signal only while a call is in flight
 * (k21-09, relative to the test process's own baseline). k21-10 is the positive control without a signal. Processes are
 * attributed by an environment marker that `gitEnvironment()` passes on to git, every helper and the stand-ins, never
 * by "new pid". Every signal row starts with a positive control: the helper was alive before the signal. Linux only
 * (/proc). Harness: adapted copies with "adapted from" notes; every existing file stays unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createClaimContext } from "../claims/context/index.ts";
import { probeClaimRefs } from "../claims/storage/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";
type Proc = { pid: number; name: string };
type Child = ReturnType<typeof Bun.spawn>;
type ScanKey = keyof typeof SCANS;
/** One interrupted command: the positive control, how and when it ended, the marked processes at each scan. */
type Interrupted = {
	helperSeen: boolean;
	/** The signal it ended by (`signalCode`, or an exit status 128 + n), else `exit <code>`; null while it ran. */
	ended: string | null;
	/** Milliseconds from the signal to the end; null while it ran. */
	endedMs: number | null;
	/** Marked processes other than the command itself, at each scan after the signal. */
	left: Record<ScanKey, string[]>;
};

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly Signal[];
const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Review: the marker scan reads /proc, so the suite runs on Linux only (skipped elsewhere, fixtures included). */
const LINUX = process.platform === "linux";
const describeOnLinux = describe.skipIf(!LINUX);
const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms with one attempt: no claim timeout fires while the test waits for the helper and the scans. */
const CALL_TIMEOUT = 20_000;
/** The test's wait for the helper (measured 486–508 ms for the project load and the preflight). */
const HELPER_WAIT = 5_000;
/** The command has ended by the signal within 2 s of it (measured 4–7 ms). */
const END_BOUND = 2_000;
/** The MCP server's own shutdown ends the process within 5 s. */
const MCP_BOUND = 5_000;
/** The leftover scans after the signal (git and its helpers end ≤ 13 ms after the group forward). */
const SCANS = { at100: 100, at1000: 1_000, at3000: 3_000 } as const;
const NONE_LEFT: Record<ScanKey, string[]> = { at100: [], at1000: [], at3000: [] };
/** k21-09: the attempt timeout of the in-process call; the timeout group kill ends it, so the removal is observed. */
const UNIT_TIMEOUT = 1_500;
/** A command without a signal still running here is reported as not ended; the test then ends it. */
const LIVE_CAP = 20_000;
const POLL_MS = 25;
/** The environment marker of one call; it reaches git and every helper through gitEnvironment(). */
const MARK = "BACKLOG_K21_CALL";
const MINUTE = 60_000;
const TTL = 2 * MINUTE;
const OWNER = "agent-owner-interrupt";
const TICKET = "BACK-1";

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

// adapted from claim-transport.test.ts (gitServer)
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-transport.test.ts (proxy)
function proxy(): StallProxy {
	if (!stall) throw new Error("stall proxy was not started");
	return stall;
}

// adapted from claim-transport.test.ts (field, isRecord)
function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// adapted from claim-transport.test.ts (parseDocument)
function parseDocument(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return { kind: "unparsable" };
	}
}

/** The fixture environment without BACKLOG_CWD plus `extra` (an SSH command) and the call's marker. */
// adapted from claim-transport.test.ts (cliEnv): the marker is part of the environment
function cliEnv(mark: string, extra: Record<string, string> = {}): Record<string, string> {
	const base = Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV);
	return { ...Object.fromEntries(base), ...extra, [MARK]: mark };
}

function nextMark(): string {
	return `${process.pid}-${++calls}`;
}

// adapted from claim-transport.test.ts (claimsBlock): blob, one attempt of CALL_TIMEOUT
function claimsBlock(endpoint: string): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		"  storage_format: blob",
		"  lifetime_mode: lease",
		"  lease_ttl_ms: 300000",
		"  reclaim_grace_ms: 600000",
		`  attempt_timeout_ms: ${CALL_TIMEOUT}`,
		"  attempts: 1",
		"  operation_budget_ms: 30000",
		"  clock_uncertainty_ms: 2000",
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

/** A Backlog project with task prefix BACK, the given tickets, the claims block and one commit. */
// adapted from claim-transport.test.ts (initProject)
async function initProject(directory: string, block: string, tickets: readonly string[]): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim interrupt");
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
			createdDate: "2026-10-02",
			rawContent: "",
		});
	}
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** A private context through the context API, never the CLI under test; its directory. */
// adapted from claim-transport.test.ts (newContext)
async function newContext(parent: string): Promise<string> {
	const created = await createClaimContext({ parent });
	if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
	return dirname(created.context.journalDirectory);
}

/** The Git subcommand of an argv (`git -C <dir> ls-remote …` → `ls-remote`). */
// adapted from claim-transport.test.ts (subcommandOf)
function subcommandOf(argv: readonly string[]): string {
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "-c" || arg === "-C") index++;
		else if (!arg.startsWith("-")) return arg;
	}
	return "";
}

/** Live processes other than this test whose environment carries `mark`; zombies are not alive. */
// adapted from claim-transport.test.ts (marked): no session field, the test process itself is skipped (k21-09)
async function marked(mark: string): Promise<Proc[]> {
	const found: Proc[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const environ = (await readFile(`/proc/${entry}/environ`, "utf8")).split("\0");
			if (!environ.includes(`${MARK}=${mark}`)) continue;
			const stat = await readFile(`/proc/${entry}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			if (stat.slice(close + 2).split(" ")[0] === "Z") continue;
			const comm = stat.slice(stat.indexOf("(") + 1, close);
			const argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
			found.push({ pid: Number(entry), name: comm === "git" ? `git ${subcommandOf(argv)}` : comm });
		} catch {
			// ended while reading, or no longer holding an address space: not a live process of the call
		}
	}
	return found;
}

/** Ends every marked process of `mark` and waits until none is left; only marked processes are ever signalled. */
// adapted from claim-transport.test.ts (endMarked)
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

function others(found: readonly Proc[], child: Child): string[] {
	return found
		.filter((entry) => entry.pid !== child.pid)
		.map((entry) => entry.name)
		.sort();
}

/** How a finished child ended, as the shell sees it: Bun's `signalCode`, or an exit status 128 + n, else the code. */
function endOf(child: Child): string {
	if (child.signalCode) return child.signalCode;
	const code = child.exitCode ?? -1;
	const signal = Object.entries(constants.signals).find(([, number]) => number === code - 128);
	return signal ? signal[0] : `exit ${code}`;
}

/** Polls the marked processes until `helper` is alive beside the child (the positive control), at most HELPER_WAIT. */
async function awaitHelper(child: Child, mark: string, helper: string): Promise<boolean> {
	const started = performance.now();
	while (performance.now() - started < HELPER_WAIT && child.exitCode === null && child.signalCode === null) {
		if (others(await marked(mark), child).includes(helper)) return true;
		await Bun.sleep(POLL_MS);
	}
	return false;
}

/**
 * Sends `signal` to the child's process group, as a terminal does to its foreground job, records the child's end
 * as it happens and scans the marked processes other than the child at +100 ms, +1 s and +3 s. Afterwards every
 * marked process is ended, the child included when it still runs.
 */
async function interrupt(child: Child, mark: string, signal: Signal, helperSeen: boolean): Promise<Interrupted> {
	let endedAt: number | undefined;
	void child.exited.then(() => {
		endedAt = performance.now();
	});
	const sentAt = performance.now();
	try {
		process.kill(-child.pid, signal);
	} catch {
		// the child's group is gone already; the positive control and the end report it
	}
	const left = { ...NONE_LEFT };
	for (const [key, at] of Object.entries(SCANS) as [ScanKey, number][]) {
		await Bun.sleep(Math.max(0, sentAt + at - performance.now()));
		left[key] = others(await marked(mark), child);
	}
	const endedMs = endedAt === undefined ? null : Math.round(endedAt - sentAt);
	const ended = endedAt === undefined ? null : endOf(child);
	await endMarked(mark);
	await Promise.race([child.exited, Bun.sleep(2_000)]);
	return { helperSeen, ended, endedMs, left };
}

/**
 * One CLI call with `--json` under a fresh marker as the leader of its own process group and session (like a job of
 * an interactive shell); once `helper` is seen, `signal` goes to the group. Prints one `K21 {…}` evidence line.
 */
async function interruptCli(
	cwd: string,
	args: readonly string[],
	signal: Signal,
	helper: string,
	extra: Record<string, string> = {},
): Promise<Interrupted> {
	const mark = nextMark();
	const child = Bun.spawn(["bun", CLI_PATH, ...args, "--json"], {
		cwd,
		env: cliEnv(mark, extra),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	const stdout = new Response(child.stdout).text();
	void new Response(child.stderr).text();
	const helperSeen = await awaitHelper(child, mark, helper);
	const call = await interrupt(child, mark, signal, helperSeen);
	const doc = parseDocument(await Promise.race([stdout, Bun.sleep(500).then(() => "")]));
	const evidence = { command: args.slice(0, 2).join(" "), signal, helper, ...call, code: field(doc, "code") ?? null };
	console.log(`K21 ${JSON.stringify(evidence)}`);
	return call;
}

/**
 * `mcp start --cwd <project>` as the leader of its own process group with one `claim_list` call in flight; once
 * `helper` is seen, `signal` goes to the group. The client is minimal: newline-delimited JSON-RPC 2.0 on the server's
 * stdio (the framing of the SDK's stdio transport) — the SDK's StdioClientTransport starts the server inside the test's
 * own group, where a group signal would reach the test too. stdin stays open until the end, so the server's stdio
 * shutdown cannot stand in for the signal one.
 */
// adapted from claim-endpoint-cli.test.ts (EndpointCase.mcp): initialize, initialized, one tools/call; no SDK client
async function interruptMcp(
	project: string,
	signal: Signal,
	helper: string,
): Promise<Interrupted & { initialized: boolean }> {
	const mark = nextMark();
	const server = Bun.spawn(["bun", CLI_PATH, "mcp", "start", "--cwd", project], {
		cwd: project,
		env: cliEnv(mark),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	void new Response(server.stderr).text();
	const responses = new Map<number, unknown>();
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of server.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const message = parseDocument(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				const id = field(message, "id");
				if (typeof id === "number") responses.set(id, message);
			}
		}
	})();
	const send = (message: Record<string, unknown>) => {
		server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		server.stdin.flush();
	};
	send({
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "claim-interrupt", version: "1.0.0" },
		},
	});
	const started = performance.now();
	while (!responses.has(1) && performance.now() - started < HELPER_WAIT) await Bun.sleep(POLL_MS);
	const initialized = field(responses.get(1), "result") !== undefined;
	send({ method: "notifications/initialized" });
	send({ id: 2, method: "tools/call", params: { name: "claim_list", arguments: {} } });
	const helperSeen = await awaitHelper(server, mark, helper);
	const call = await interrupt(server, mark, signal, helperSeen);
	try {
		server.stdin.end();
	} catch {
		// the pipe closed with the server
	}
	const evidence = { command: "mcp start · claim_list", signal, helper, initialized, ...call };
	console.log(`K21 ${JSON.stringify(evidence)}`);
	return { ...call, initialized };
}

/** One CLI call with `--json` under a fresh marker, spawned like the signal rows, no signal (k21-10, fixtures). */
async function runCli(
	cwd: string,
	args: readonly string[],
): Promise<{ exit: number | null; doc: unknown; left: string[] }> {
	const mark = nextMark();
	const child = Bun.spawn(["bun", CLI_PATH, ...args, "--json"], {
		cwd,
		env: cliEnv(mark),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	const stdout = new Response(child.stdout).text();
	void new Response(child.stderr).text();
	const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(LIVE_CAP).then(() => false)]);
	const left = others(await marked(mark), child);
	await endMarked(mark);
	const doc = parseDocument(await Promise.race([stdout, Bun.sleep(2_000).then(() => "")]));
	const run = { exit: finished ? child.exitCode : null, doc, left };
	const evidence = { command: args.slice(0, 2).join(" "), exit: run.exit, kind: field(doc, "kind") ?? null, left };
	console.log(`K21 ${JSON.stringify(evidence)}`);
	return run;
}

function listenerCounts(): Record<Signal, number> {
	return {
		SIGINT: process.listenerCount("SIGINT"),
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGHUP: process.listenerCount("SIGHUP"),
	};
}

function delta(now: Record<Signal, number>, base: Record<Signal, number>): Record<Signal, number> {
	return Object.fromEntries(SIGNALS.map((signal) => [signal, now[signal] - base[signal]])) as Record<Signal, number>;
}

/** The end the shell sees and its bound after the signal. */
function endView(call: Interrupted, bound: number): Record<string, unknown> {
	return { ended: call.ended, withinBound: call.endedMs !== null && call.endedMs <= bound };
}

// adapted from claim-transport.test.ts (sshStub): only the two stand-ins this suite needs
/**
 * GIT_SSH_COMMAND stand-ins (the image has no ssh client). Each answers Git's `-G` variant probe as OpenSSH does, so
 * Git runs the transport call (stall probe). `stall` sleeps like an ssh against a silent host; `serve-stall`
 * runs upload-pack on the fixture repository named by the URL path and sleeps on receive-pack.
 */
function sshStub(kind: "stall" | "serve-stall"): string {
	const repos = gitServer().repos;
	const lines = ["#!/bin/sh", '[ "$1" = -G ] && exit 0'];
	if (kind === "stall") lines.push("exec sleep 100");
	if (kind === "serve-stall") {
		const serve = (service: string) =>
			`  "git-${service} '"*) path=\${last#"git-${service} '"}; exec git ${service} ${JSON.stringify(repos)}"\${path%"'"}" ;;`;
		lines.push(
			"for last; do :; done",
			'case "$last" in',
			serve("upload-pack"),
			`  "git-receive-pack '"*) exec sleep 100 ;;`,
			"esac",
			'echo "unexpected ssh command: $last" >&2',
			"exit 1",
		);
	}
	return `${lines.join("\n")}\n`;
}

/** One case: a root with a context parent and the SSH stand-ins. */
// adapted from claim-transport.test.ts (TransportCase): one format, one timeout
class InterruptCase {
	private constructor(
		readonly root: string,
		readonly parent: string,
	) {}

	static async create(label: string): Promise<InterruptCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-interrupt-${label}-`));
		const parent = join(root, "contexts");
		await mkdir(parent);
		await chmod(parent, 0o700);
		return new InterruptCase(root, parent);
	}

	async project(name: string, endpoint: string, tickets: readonly string[] = []): Promise<string> {
		const directory = join(this.root, name);
		await initProject(directory, claimsBlock(endpoint), tickets);
		return directory;
	}

	async ssh(kind: "stall" | "serve-stall"): Promise<string> {
		const path = join(this.root, `ssh-${kind}.sh`);
		await writeFile(path, sshStub(kind));
		await chmod(path, 0o755);
		return path;
	}

	/** An initialized blob coordination area on a fresh bare repository of the fixture server, over git://; its name. */
	async coordination(): Promise<string> {
		const name = `k21-blob-${++repositories}`;
		const repo = join(gitServer().repos, `${name}.git`);
		await gitServer().git(gitServer().repos, ["init", "--quiet", "--bare", repo]);
		await gitServer().git(repo, ["config", "daemon.receivepack", "true"]);
		const init = await this.project(`init-${name}`, gitServer().url(name));
		const created = await runCli(init, ["claim", "init"]);
		if (created.exit !== 0 || field(created.doc, "result") !== "created") {
			throw new Error(`fixture: claim init failed (${JSON.stringify(created.doc)})`);
		}
		return name;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(label: string, body: (fixture: InterruptCase) => Promise<void>): Promise<void> {
	const fixture = await InterruptCase.create(label);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

/** The stalled reads: `git://` has no helper (git itself is seen), http(s) runs git-remote-http, ssh the stand-in. */
const READS = [
	{ row: "k21-01", scheme: "git", signal: "SIGINT", helper: "git ls-remote" },
	{ row: "k21-02", scheme: "https", signal: "SIGINT", helper: "git-remote-http" },
	{ row: "k21-03", scheme: "http", signal: "SIGINT", helper: "git-remote-http" },
	{ row: "k21-04", scheme: "ssh", signal: "SIGINT", helper: "sleep" },
	{ row: "k21-05", scheme: "https", signal: "SIGTERM", helper: "git-remote-http" },
	{ row: "k21-06", scheme: "https", signal: "SIGHUP", helper: "git-remote-http" },
] as const;

describeOnLinux("a terminal signal reaches the in-flight claim Git call", () => {
	for (const read of READS) {
		test(
			`${read.row}: ${read.signal} to the group of a claim list stalled over ${read.scheme}:// ends it by the signal and leaves no process of the call`,
			async () => {
				await withCase(read.row, async (fixture) => {
					const ssh = read.scheme === "ssh";
					const endpoint = `${read.scheme}://${ssh ? "git@" : ""}127.0.0.1:${proxy().port}/x.git`;
					const project = await fixture.project("stalled", endpoint);
					const extra: Record<string, string> = ssh ? { GIT_SSH_COMMAND: await fixture.ssh("stall") } : {};
					const call = await interruptCli(project, ["claim", "list"], read.signal, read.helper, extra);
					// Positive control (catches: a row that passes because Git failed early — a missing helper binary, a
					// refused URL, a config error — or never reached the transport call): the helper was alive before
					// the signal.
					expect({ helperSeen: call.helperSeen }).toEqual({ helperSeen: true });
					// (Catches: the earlier count rule — it sees signal-exit as an
					// owner, only forwards, and the CLI prints its claim document and exits with its claim status instead
					// of the signal, guard mutant M2): the command ended by the signal within 2 s.
					expect(endView(call, END_BOUND)).toEqual({ ended: read.signal, withinBound: true });
					// (catches: no forward — today the detached git and its helpers outlive the
					// command, as measured; a forward to the direct child only, guard mutant M1): no
					// process of the call is alive at +100 ms, +1 s and +3 s.
					expect(call.left).toEqual(NONE_LEFT);
				});
			},
			TEST_TIMEOUT,
		);
	}

	test(
		"k21-07: SIGINT to the group of a claim acquire whose push stalls in receive-pack ends it by SIGINT and leaves no process of the call",
		async () => {
			await withCase("k21-07", async (fixture) => {
				const name = await fixture.coordination();
				const endpoint = `ssh://git@127.0.0.1:${gitServer().port}/${name}.git`;
				const project = await fixture.project("agent", endpoint, [TICKET]);
				const context = await newContext(fixture.parent);
				const args = ["claim", "acquire", TICKET, "--owner", OWNER, "--context", context];
				const options = ["--ttl-ms", String(TTL), "--operation-id", "op-k21-07"];
				const call = await interruptCli(project, [...args, ...options], "SIGINT", "sleep", {
					GIT_SSH_COMMAND: await fixture.ssh("serve-stall"),
				});
				// Positive control (catches: a call that never reached the push — a failed read, context or project):
				// the reads were served and the receive-pack sleep was alive before the signal.
				expect({ pushSeen: call.helperSeen }).toEqual({ pushSeen: true });
				// (catches: the count rule, guard mutant M2): the command ended by SIGINT within 2 s.
				expect(endView(call, END_BOUND)).toEqual({ ended: "SIGINT", withinBound: true });
				// (catches: no forward, guard mutant M1): no process of the push is alive at +100 ms,
				// +1 s and +3 s.
				expect(call.left).toEqual(NONE_LEFT);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k21-08: SIGINT to the group of mcp start with a claim_list call in flight keeps its own shutdown (exit 0) and leaves no process of the call",
		async () => {
			await withCase("k21-08", async (fixture) => {
				const project = await fixture.project("stalled", `https://127.0.0.1:${proxy().port}/x.git`);
				const call = await interruptMcp(project, "SIGINT", "git-remote-http");
				// Positive control (catches: a broken client or server start, a tool call that never reached Git): the
				// server answered initialize and the call's helper was alive before the signal.
				expect({ initialized: call.initialized, helperSeen: call.helperSeen }).toEqual({
					initialized: true,
					helperSeen: true,
				});
				// (catches: a re-raise under the server's `process.once` shutdown — a
				// live count at signal time, or a rule that ignores the gone once-listener — which ends the server by the
				// signal instead of exit 0): the server's own shutdown ended it with exit 0 within 5 s.
				expect(endView(call, MCP_BOUND)).toEqual({ ended: "exit 0", withinBound: true });
				// (catches: no forward under a surface that owns the signal, guard mutant M1): no process of
				// the call is alive at +100 ms, +1 s and +3 s.
				expect(call.left).toEqual(NONE_LEFT);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k21-09: in-process, the module holds one listener per signal only while a claim Git call is in flight",
		async () => {
			await withCase("k21-09", async (fixture) => {
				const repository = join(fixture.root, "unit");
				await mkdir(repository);
				await gitServer().git(repository, ["init", "--quiet"]);
				const mark = nextMark();
				const before = listenerCounts();
				let during = before;
				let lsRemoteSeen = false;
				let result: Awaited<ReturnType<typeof probeClaimRefs>> | undefined;
				// The marker reaches git through gitEnvironment(), which copies process.env at the spawn.
				process.env[MARK] = mark;
				try {
					const pending = probeClaimRefs({
						repository,
						remote: `git://127.0.0.1:${proxy().port}/x.git`,
						format: "blob",
						timeoutMs: UNIT_TIMEOUT,
					});
					const started = performance.now();
					while (!lsRemoteSeen && performance.now() - started < UNIT_TIMEOUT) {
						lsRemoteSeen = (await marked(mark)).some((found) => found.name === "git ls-remote");
						if (!lsRemoteSeen) await Bun.sleep(POLL_MS);
					}
					during = listenerCounts();
					result = await pending;
				} finally {
					delete process.env[MARK];
					await endMarked(mark);
				}
				const after = listenerCounts();
				const view = { during: delta(during, before), after: delta(after, before) };
				console.log(`K21 ${JSON.stringify({ command: "probeClaimRefs", lsRemoteSeen, result, before, ...view })}`);
				// Positive control (catches: a row that passes because the call was never observed in flight — a refused
				// endpoint, a git that never started): the ls-remote was alive while the call ran, and the call ended as
				// a failure (its timeout).
				expect({ lsRemoteSeen, result: result?.kind ?? null }).toEqual({ lsRemoteSeen: true, result: "failure" });
				// (catches: no listener — today; a listener left behind after the call, which would change the
				// process's signal disposition outside a claim call): one more listener per signal while the call is in
				// flight, the test process's baseline again after it returned.
				expect(view).toEqual({
					during: { SIGINT: 1, SIGTERM: 1, SIGHUP: 1 },
					after: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0 },
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k21-10: positive control — the same claim list against the live git:// endpoint, without a signal, lists and leaves no process",
		async () => {
			await withCase("k21-10", async (fixture) => {
				const name = await fixture.coordination();
				const project = await fixture.project("live", gitServer().url(name));
				const listed = await runCli(project, ["claim", "list"]);
				// (catches: a forward that disturbs the normal path — a listener that keeps the process
				// alive or ends it, a changed document or exit code): exit 0 with the list, no process of the call left.
				expect({
					exit: listed.exit,
					kind: field(listed.doc, "kind"),
					status: field(listed.doc, "status"),
					left: listed.left,
				}).toEqual({ exit: 0, kind: "claim-list", status: "ok", left: [] });
			});
		},
		TEST_TIMEOUT,
	);
});
