/**
 * A claim Git call that feeds its stdin leaves no process behind when the feed fails. In-process through the storage
 * boundary, against the loopback Git daemon of claim-git-fixture.ts: `initializeClaimStorage`, whose descriptor write
 * is `git hash-object -w --stdin`, with the test seam `seams.beforeStdinWrite(child)` throwing a marked error (k23-a);
 * the same call without the seam as the control (k23-b); and a document write of an opened store whose input is larger
 * than a pipe buffer, fed to a git the seam stops and kills before it reads, so the pending feed fails asynchronously
 * with EPIPE (k23-c). Pinned: the mapped result, the call registered as in flight at the feed (one more listener per
 * signal at the seam, as for signal forwarding), no process of the call alive at +100 ms, +1 s and +3 s after it
 * returned, and the test process's listener baseline again afterwards. Nothing unhandled is pinned by the runner
 * itself: bun test fails the running test at an unhandled rejection, and a process listener never sees it (measured on
 * Bun 1.3.8); every row stays in its body for the 3 s of scans after the call returned, so a late rejection of its
 * feed fails that row. Processes are attributed by an environment marker that `gitEnvironment()` passes on to git,
 * never by "new pid". The seam is the store options' test-only `seams` field; the rows pass it through `withSeams`
 * (ASSUMPTION(seam)). Linux only (/proc). Harness: adapted copies with "adapted from" notes; every existing file stays
 * unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaimStorageOptions, initializeClaimStorage, openClaimStore } from "../claims/storage/index.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";
type Proc = { pid: number; name: string };
type ScanKey = keyof typeof SCANS;
type Child = ReturnType<typeof Bun.spawn>;
/** ASSUMPTION(seam): the store options carry a test-only `seams` field, `seams?.beforeStdinWrite?: (child) => void`. */
type FeedSeams = { beforeStdinWrite?: (child: Child) => void };
/** One fed call: its result, the time it took, the marked processes after it returned, the listener delta then. */
type Fed<R> = { result: R; elapsedMs: number; left: Record<ScanKey, string[]>; listeners: Record<Signal, number> };

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly Signal[];
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** The marker scan reads /proc, so the suite runs on Linux only (skipped elsewhere, fixtures included). */
const LINUX = process.platform === "linux";
const describeOnLinux = describe.skipIf(!LINUX);
const TEST_TIMEOUT = 60_000;
/** The store's per-command timeout (storage DEFAULT_TIMEOUT_MS); a failed feed ends the call well inside it. */
const CALL_TIMEOUT = 3_000;
/** The pipes' settle bound after a group kill (storage TRANSPORT_SETTLE_MS). */
const SETTLE_MS = 250;
/** The leftover scans after the call returned. */
const SCANS = { at100: 100, at1000: 1_000, at3000: 3_000 } as const;
const NONE_LEFT: Record<ScanKey, string[]> = { at100: [], at1000: [], at3000: [] };
const BASELINE: Record<Signal, number> = { SIGINT: 0, SIGTERM: 0, SIGHUP: 0 };
const IN_FLIGHT: Record<Signal, number> = { SIGINT: 1, SIGTERM: 1, SIGHUP: 1 };
/** k23-c: an input far above a pipe buffer (64 KiB on Linux, at most /proc/sys/fs/pipe-max-size = 1 MiB). */
const LARGE_INPUT = 4 * 1024 * 1024;
/** k23-c: the stopped git is killed this long after the seam, while the larger part of the feed is still pending. */
const KILL_DELAY = 200;
/** The environment marker of one call; it reaches git through gitEnvironment(), which copies process.env. */
const MARK = "BACKLOG_K23_CALL";
const ABSENT_REF = "(no ref)";
const DESCRIPTOR_REF = "refs/claim-meta/format";
const TICKET = "BACK-1";

let fixtureServer: GitFixtureServer | undefined;
let calls = 0;
let repositories = 0;

beforeAll(async () => {
	// Bun runs file-level hooks even when every test of the file is skipped: no fixture off Linux.
	if (!LINUX) return;
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-interrupt.test.ts (gitServer)
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function nextMark(): string {
	return `${process.pid}-${++calls}`;
}

/** The store options' test-only `seams` field; the rows pass it through `withSeams`. */
function withSeams(options: ClaimStorageOptions, seams: FeedSeams): ClaimStorageOptions {
	return { ...options, seams } as ClaimStorageOptions;
}

// adapted from claim-interrupt.test.ts (subcommandOf)
function subcommandOf(argv: readonly string[]): string {
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "-c" || arg === "-C") index++;
		else if (!arg.startsWith("-")) return arg;
	}
	return "";
}

/** Live processes other than this test whose environment carries `mark`; zombies are not alive. */
// adapted from claim-interrupt.test.ts (marked)
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
// adapted from claim-interrupt.test.ts (endMarked)
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

// adapted from claim-interrupt.test.ts (listenerCounts, delta)
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

function describeError(value: unknown): string {
	return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

/**
 * Runs one call under a fresh marker; the scans run after the call returned, so the row stays in its body for 3 s
 * more (a late rejection of the call's feed fails this row, never the next). Every marked process is ended last.
 */
async function fed<R>(call: () => Promise<R>): Promise<Fed<R>> {
	const mark = nextMark();
	const base = listenerCounts();
	process.env[MARK] = mark;
	try {
		const started = performance.now();
		const result = await call();
		const returned = performance.now();
		const left = { ...NONE_LEFT };
		for (const [key, offset] of Object.entries(SCANS) as [ScanKey, number][]) {
			const wait = returned + offset - performance.now();
			if (wait > 0) await Bun.sleep(wait);
			left[key] = (await marked(mark)).map((found) => found.name).sort();
		}
		return { result, elapsedMs: Math.round(returned - started), left, listeners: delta(listenerCounts(), base) };
	} finally {
		delete process.env[MARK];
		await endMarked(mark);
	}
}

/** One case: a fresh bare coordination repository on the fixture server and a client repository. */
class FeedCase {
	private constructor(
		readonly root: string,
		readonly name: string,
		readonly options: ClaimStorageOptions,
	) {}

	static async create(label: string): Promise<FeedCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-feed-${label}-`));
		// adapted from claim-interrupt.test.ts (InterruptCase.coordination): a bare repository that accepts pushes
		const name = `k23-blob-${++repositories}`;
		const repo = join(gitServer().repos, `${name}.git`);
		await gitServer().git(gitServer().repos, ["init", "--quiet", "--bare", repo]);
		await gitServer().git(repo, ["config", "daemon.receivepack", "true"]);
		const repository = join(root, "client");
		await mkdir(repository);
		await gitServer().git(repository, ["init", "--quiet"]);
		const options = { repository, remote: gitServer().url(name), format: "blob", timeoutMs: CALL_TIMEOUT } as const;
		return new FeedCase(root, name, options);
	}

	/** The ref's object at the coordination repository, ABSENT_REF without it. */
	async serverRef(ref: string): Promise<string> {
		const repo = join(gitServer().repos, `${this.name}.git`);
		const read = await gitServer().git(repo, ["rev-parse", "--verify", "--quiet", ref], undefined, false);
		return read.rc === 0 ? read.out.trim() : ABSENT_REF;
	}

	/** The descriptor at the coordination repository, decoded without the product; ABSENT_REF without the ref. */
	async descriptor(): Promise<unknown> {
		const repo = join(gitServer().repos, `${this.name}.git`);
		const read = await gitServer().git(repo, ["cat-file", "blob", DESCRIPTOR_REF], undefined, false);
		return read.rc === 0 ? JSON.parse(read.out) : ABSENT_REF;
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(label: string, body: (fixture: FeedCase) => Promise<void>): Promise<void> {
	const fixture = await FeedCase.create(label);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describeOnLinux("a claim Git call whose stdin feed fails leaves no process behind", () => {
	test(
		"k23-a: a throw while feeding the descriptor write ends the call not-sent within its bound and leaves no git behind",
		async () => {
			await withCase("k23-a", async (fixture) => {
				const thrown = "K23 seam: the stdin write throws";
				const seam: { calls: number; atFeed: Record<Signal, number> | null } = { calls: 0, atFeed: null };
				const base = listenerCounts();
				const seams: FeedSeams = {
					beforeStdinWrite: () => {
						seam.calls++;
						seam.atFeed = delta(listenerCounts(), base);
						throw new Error(thrown);
					},
				};
				const call = await fed(() => initializeClaimStorage(withSeams(fixture.options, seams)));
				const view = {
					seamCalls: seam.calls,
					result: call.result,
					atFeed: seam.atFeed,
					withinBound: call.elapsedMs <= CALL_TIMEOUT + SETTLE_MS,
					waitedForGit: call.elapsedMs >= SETTLE_MS,
					left: call.left,
					listeners: call.listeners,
					descriptor: await fixture.descriptor(),
				};
				console.log(`K23 ${JSON.stringify({ row: "k23-a", elapsedMs: call.elapsedMs, ...view })}`);
				// Positive control (catches: a row that passes because the feed never ran through the seam — a call
				// that failed before the descriptor write, a seam that is not wired): the seam ran once, for the
				// descriptor write.
				expect({ seamCalls: view.seamCalls }).toEqual({ seamCalls: 1 });
				// (catches: today's order — the throw returns from the spawn `try`
				// before the call is registered, and the detached `git hash-object -w --stdin` waits for a stdin that is
				// never closed, alive at +3 s; a fix that registers but leaves the group or a listener behind on the
				// throw path; a fix that waits for the killer instead of ending the group; a failed feed that ends the
				// group at once instead of first giving git the settle window to end on its own — git still waits for its
				// stdin here, so the call returns only after that window): the call ends not-sent with the thrown message
				// as today, registered as in flight at the feed, within its bound and not before the settle window; no
				// process of the call is alive at +100 ms, +1 s and +3 s; the listener baseline is back; nothing was sent.
				expect(view).toEqual({
					seamCalls: 1,
					result: { kind: "not-sent", reason: thrown },
					atFeed: IN_FLIGHT,
					withinBound: true,
					waitedForGit: true,
					left: NONE_LEFT,
					listeners: BASELINE,
					descriptor: ABSENT_REF,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k23-b: control — the same descriptor write without the seam initializes and leaves no process behind",
		async () => {
			await withCase("k23-b", async (fixture) => {
				const call = await fed(() => initializeClaimStorage(fixture.options));
				const view = {
					result: call.result,
					left: call.left,
					listeners: call.listeners,
					descriptor: await fixture.descriptor(),
				};
				console.log(`K23 ${JSON.stringify({ row: "k23-b", elapsedMs: call.elapsedMs, ...view })}`);
				// (catches: a reordered feed that disturbs the normal path — a group ended before git
				// read its input, a listener kept after the call, a changed result): the descriptor is created, no
				// process of the call is left, the listener baseline is back.
				const descriptor = { schema: 1, format: "blob", epoch: 1 } as const;
				expect(view).toEqual({
					result: { kind: "created", descriptor },
					left: NONE_LEFT,
					listeners: BASELINE,
					descriptor,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k23-c: a feed larger than the pipe that git never reads ends the write not-sent, with no unhandled rejection and no git behind",
		async () => {
			await withCase("k23-c", async (fixture) => {
				const initialized = await initializeClaimStorage(fixture.options);
				const seam: { opened: string | null; calls: number; killed: boolean | string } = {
					opened: null,
					calls: 0,
					killed: false,
				};
				// The early-ending git: the seam stops git before the feed, so it reads nothing while the
				// feed fills the pipe and the rest stays pending; KILL_DELAY later it kills git, and the pending write
				// fails asynchronously (EPIPE), after the call's synchronous part.
				const seams: FeedSeams = {
					beforeStdinWrite: (child) => {
						seam.calls++;
						if (seam.calls > 1) return;
						process.kill(-child.pid, "SIGSTOP");
						setTimeout(() => {
							try {
								process.kill(-child.pid, "SIGKILL");
								seam.killed = true;
							} catch (error) {
								seam.killed = describeError(error);
							}
						}, KILL_DELAY);
					},
				};
				const call = await fed(async () => {
					const opened = await openClaimStore(withSeams(fixture.options, seams));
					seam.opened = opened.kind;
					if (opened.kind !== "open") return { kind: `store ${opened.kind}` };
					const payload = { claimState: 1, status: "free", claimGeneration: 1, padding: "x".repeat(LARGE_INPUT) };
					const change = { operationId: "op-k23-c", receipt: { kind: "k23-c" }, payload };
					return opened.store.write({ kind: "absent", ticket: TICKET }, change);
				});
				const view = {
					seamCalls: seam.calls,
					killed: seam.killed,
					result: (call.result as { kind?: unknown }).kind,
					left: call.left,
					listeners: call.listeners,
					ticketRef: await fixture.serverRef(`refs/claims/${TICKET}`),
				};
				console.log(`K23 ${JSON.stringify({ row: "k23-c", elapsedMs: call.elapsedMs, ...view })}`);
				// Positive control (catches: a row that passes because the large feed never met a git that stopped
				// reading — a seam that is not wired, a store that failed before the document write, a git already
				// gone): the coordination area was initialized and opened, the seam ran for the document write, and
				// its kill met the stopped git.
				expect({
					initialized: initialized.kind,
					opened: seam.opened,
					seamCalls: view.seamCalls,
					killed: view.killed,
				}).toEqual({ initialized: "created", opened: "open", seamCalls: 1, killed: true });
				// (catches: today's `write(input); void end()` — the feed's promise rejects
				// with EPIPE after git died and nothing handles it, which ends a CLI with exit 1, as measured; a fix
				// that handles the throw but not a rejection — bun test then fails this row at the rejection,
				// about KILL_DELAY after the feed, before any view is printed): the write ends not-sent, no process of
				// the call is alive at +100 ms, +1 s and +3 s, the listener baseline is back, and the ticket ref was
				// never written.
				expect(view).toEqual({
					seamCalls: 1,
					killed: true,
					result: "not-sent",
					left: NONE_LEFT,
					listeners: BASELINE,
					ticketRef: ABSENT_REF,
				});
			});
		},
		TEST_TIMEOUT,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// A failed feed defers to git's own ending. When git ends on its own before it reads its input, the pending feed fails
// with EPIPE; the call then reports git's own result (its code and its stderr), never the feed's EPIPE, and still
// leaves nothing behind (k23-d). The trigger is natural: the client checkout stops being a repository after the store
// opened (its .git/HEAD no longer names a ref). `git config --get-regexp`, the write's routing check, then runs outside
// a repository and finds no rewrite; `git hash-object -w --stdin`, the write's first fed call, stops at startup with
// "not a git repository" before it reads stdin (measured: a 4 MiB writer gets SIGPIPE, git exits 128). A configuration
// that git cannot parse would already fail the routing check, so the write would never feed. k23-e is the same large
// write against the intact repository.
// ---------------------------------------------------------------------------------------------------------------

/** k23-d: git's own message once the client checkout is no repository. */
const NO_REPOSITORY = "not a git repository";

/** The document change of a write whose input is LARGE_INPUT bytes and more. */
function largeChange(operationId: string): { operationId: string; receipt: Body; payload: Body } {
	const payload = { claimState: 1, status: "free", claimGeneration: 1, padding: "x".repeat(LARGE_INPUT) };
	return { operationId, receipt: { kind: operationId }, payload };
}

type Body = { [key: string]: string | number };

/** The seam as an observer only: how often the store fed git, and how git ended on its own. */
function observedFeeds(): { seams: FeedSeams; seen: { calls: number; gitExit: number | null } } {
	const seen: { calls: number; gitExit: number | null } = { calls: 0, gitExit: null };
	const seams: FeedSeams = {
		beforeStdinWrite: (child) => {
			seen.calls++;
			void child.exited.then((code) => {
				seen.gitExit ??= code;
			});
		},
	};
	return { seams, seen };
}

describeOnLinux("a failed feed reports git's own result when git ended on its own", () => {
	test(
		"k23-d: a large write to a git that stops before it reads ends not-sent with git's own message, never EPIPE, no git behind",
		async () => {
			await withCase("k23-d", async (fixture) => {
				const initialized = await initializeClaimStorage(fixture.options);
				const enclosing = await gitServer().git(fixture.root, ["rev-parse", "--git-dir"], undefined, false);
				const { seams, seen } = observedFeeds();
				let opened = "";
				const call = await fed(async () => {
					const store = await openClaimStore(withSeams(fixture.options, seams));
					opened = store.kind;
					if (store.kind !== "open") return { kind: `store ${store.kind}` };
					await Bun.write(join(fixture.options.repository, ".git", "HEAD"), "not a ref\n");
					return store.store.write({ kind: "absent", ticket: TICKET }, largeChange("op-k23-d"));
				});
				const result = call.result as { kind?: unknown; reason?: unknown };
				const reason = typeof result.reason === "string" ? result.reason : "";
				const view = {
					result: result.kind,
					gitMessage: reason.includes(NO_REPOSITORY),
					epipe: reason.includes("EPIPE"),
					withinBound: call.elapsedMs <= CALL_TIMEOUT + 2 * SETTLE_MS,
					left: call.left,
					listeners: call.listeners,
					ticketRef: await fixture.serverRef(`refs/claims/${TICKET}`),
				};
				const evidence = { row: "k23-d", elapsedMs: call.elapsedMs, ...seen, reason, ...view };
				console.log(`K23 ${JSON.stringify(evidence)}`);
				// Positive control (catches: a row that passes because the write never fed a git that ended on its own —
				// a routing check that failed first, a git that found an enclosing repository and read its input, a git
				// that was killed instead): the coordination area was initialized and opened, no repository encloses the
				// case, the store fed git once, and git ended on its own with exit 128.
				expect({
					initialized: initialized.kind,
					opened,
					enclosingRepository: enclosing.rc === 0,
					seamCalls: seen.calls,
					gitExit: seen.gitExit,
				}).toEqual({ initialized: "created", opened: "open", enclosingRepository: false, seamCalls: 1, gitExit: 128 });
				// A failed feed defers to git's own ending (catches: today's immediate group kill with code -1, whose
				// result depends on which of two continuations runs first — the feed's EPIPE rejection or git's exit —
				// so the reason is "EPIPE …" in a share of runs; an error that replaces git's stderr even when git spoke):
				// the write ends not-sent with git's own message and no EPIPE, within its bound, no process of the call
				// is alive at +100 ms, +1 s and +3 s, the listener baseline is back, and the ticket ref was never written.
				expect(view).toEqual({
					result: "not-sent",
					gitMessage: true,
					epipe: false,
					withinBound: true,
					left: NONE_LEFT,
					listeners: BASELINE,
					ticketRef: ABSENT_REF,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"k23-e: control — the same large write against the intact repository is written and leaves no process behind",
		async () => {
			await withCase("k23-e", async (fixture) => {
				const initialized = await initializeClaimStorage(fixture.options);
				const { seams, seen } = observedFeeds();
				const call = await fed(async () => {
					const store = await openClaimStore(withSeams(fixture.options, seams));
					if (store.kind !== "open") return { kind: `store ${store.kind}` };
					return store.store.write({ kind: "absent", ticket: TICKET }, largeChange("op-k23-e"));
				});
				const result = call.result as { kind?: unknown; root?: unknown };
				const view = {
					initialized: initialized.kind,
					result: result.kind,
					seamCalls: seen.calls,
					gitExit: seen.gitExit,
					left: call.left,
					listeners: call.listeners,
					ticketRef: await fixture.serverRef(`refs/claims/${TICKET}`),
				};
				console.log(`K23 ${JSON.stringify({ row: "k23-e", elapsedMs: call.elapsedMs, ...view })}`);
				// The happy path of a large feed (catches: a deferred or watched feed that disturbs a git that reads its
				// whole input — a group ended while git still reads, an error set on success, a listener kept): the
				// document is written in one fed call that git ends with 0, the ticket ref names the written root, no
				// process of the call is left, the listener baseline is back.
				expect(view).toEqual({
					initialized: "created",
					result: "applied",
					seamCalls: 1,
					gitExit: 0,
					left: NONE_LEFT,
					listeners: BASELINE,
					ticketRef: typeof result.root === "string" ? result.root : "(no root)",
				});
			});
		},
		TEST_TIMEOUT,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// A timed-out call ends the members of git's group even after git itself ended. When git ends on its own while a
// member of its process group (a transport helper's child) still holds git's stderr, the call's pipes stay open, so it
// runs into its killer; the killer must still end the group. While a member lives, the group id cannot be reused
// (POSIX: a process ID that is a live group's ID is not reused until the group's lifetime ends), so the kill reaches
// only this call's processes. The trigger is an ssh stand-in that leaves such a member and exits at once (k23-f).
// ---------------------------------------------------------------------------------------------------------------

/** k23-f: the per-command timeout of the call that runs into its killer (short: the row waits for it). */
const KILLER_TIMEOUT = 1_500;
/** k23-f: the scan while the call still waits for its killer, long after git and the stand-in ended. */
const MIDWAY = 750;
/** k23-f: a claim endpoint over ssh, answered by the stand-in below. */
const SSH_REMOTE = "ssh://k23.invalid/k23-f.git";
/**
 * k23-f: a GIT_SSH_COMMAND stand-in (the image has no ssh client), run as `sh <file>`. It answers Git's `-G` variant
 * probe as OpenSSH does, starts a sleep that stays in git's process group and keeps the inherited stderr open, and
 * exits 255 at once; git reads EOF on its protocol pipe and ends on its own with 128. The sleep's stdout goes to
 * /dev/null: a helper's stdout is git's protocol pipe, and holding it would keep git itself alive until the killer.
 */
const SSH_EXITS_EARLY = ['[ "$1" = -G ] && exit 0', "sleep 30 > /dev/null &", "exit 255", ""].join("\n");

describeOnLinux("a timed-out claim Git call ends git's group even after git ended on its own", () => {
	test(
		"k23-f: a read whose ssh stand-in leaves a member holding stderr and exits runs into its killer, and no member of the group survives the call",
		async () => {
			await withCase("k23-f", async (fixture) => {
				const stub = join(fixture.root, "ssh-exits-early.sh");
				await Bun.write(stub, SSH_EXITS_EARLY);
				const call = await fed(async () => {
					const mark = process.env[MARK] ?? "";
					const before = process.env.GIT_SSH_COMMAND;
					process.env.GIT_SSH_COMMAND = `sh ${stub}`;
					try {
						const midway = Bun.sleep(MIDWAY).then(async () => (await marked(mark)).map((found) => found.name).sort());
						const options = { ...fixture.options, remote: SSH_REMOTE, timeoutMs: KILLER_TIMEOUT };
						const opened = await openClaimStore(options);
						return { opened, midway: await midway };
					} finally {
						if (before === undefined) delete process.env.GIT_SSH_COMMAND;
						else process.env.GIT_SSH_COMMAND = before;
					}
				});
				const view = {
					midway: call.result.midway,
					ranIntoKiller: call.elapsedMs >= KILLER_TIMEOUT,
					result: call.result.opened,
					withinBound: call.elapsedMs <= KILLER_TIMEOUT + 2 * SETTLE_MS,
					left: call.left,
					listeners: call.listeners,
				};
				console.log(`K23 ${JSON.stringify({ row: "k23-f", elapsedMs: call.elapsedMs, ...view })}`);
				// Positive control (catches: a row that passes because git never ended on its own while a member held its
				// stderr — a stand-in whose sleep also holds git's protocol pipe, so git itself waits for the killer; a
				// sleep that never started; a call that failed before the transport, such as an endpoint rejected as
				// invalid): at the midway scan only the sleep of the call was alive, and the call returned at its killer.
				expect({ midway: view.midway, ranIntoKiller: view.ranIntoKiller }).toEqual({
					midway: ["sleep"],
					ranIntoKiller: true,
				});
				// (catches: a group kill that is skipped once git, the group's leader, has ended — the member then outlives
				// the call and the pipes are cut only at the settle bound): the open ends unreachable as a timed-out call,
				// within its bound, no process of the call is alive at +100 ms, +1 s and +3 s, and the listener baseline
				// is back.
				expect(view).toEqual({
					midway: ["sleep"],
					ranIntoKiller: true,
					result: { kind: "unreachable", reason: "git command timed out" },
					withinBound: true,
					left: NONE_LEFT,
					listeners: BASELINE,
				});
			});
		},
		TEST_TIMEOUT,
	);
});
