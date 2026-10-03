/**
 * Qualification of the existing journal, storage and read-only query primitives under a real client SIGKILL, for blob,
 * tree and commit-chain over loopback TCP with gated receive hooks. Test-only: the child
 * probe runs the documented primitive order; this is not a production executor and proves no dispatch gating,
 * retry permission, logical APPLIED or work right. A process kill is not power loss.
 *
 * Checkpoints: C0 healthy completion, C1 durable prepare before write, C2 held pre-receive (assertions only while
 * the gate is held, inside a conservative window), C3 held post-receive (commit before the missing reply).
 * Owned client processes run in a detached supervisor's own process group, which the supervisor itself ends.
 * The fixture assumes that the detached supervisor's new session already exists when `spawn` returns, as observed
 * on Bun 1.3.14 on Linux; other runtime timing fails the fixture check and is not covered by any portable guarantee.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimIntentRecord, ClaimOperationIntent } from "../claims/journal/index.ts";
import { queryClaimMutation } from "../claims/query/index.ts";
import {
	type ClaimChange,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import type { RunCommand, SupervisorEvent } from "./fixtures/claim-crash-probe.ts";
import { GitFixtureServer, ReceiveGates } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 30_000;
const PROBE = fileURLToPath(new URL("./fixtures/claim-crash-probe.ts", import.meta.url));
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Per-Git-command timeout of queries and the parent's own store work. */
const QUERY_TIMEOUT = 3_000;
/** The probe's per-Git-command timeout exceeds the 5 s gate-helper deadline, so a held push is never cut short. */
const PROBE_STORAGE_TIMEOUT = 8_000;
const PROBE_GO_TIMEOUT = 15_000;
const SUPERVISOR_LIFETIME = 60_000;
const EVENT_TIMEOUT = 10_000;
/** C2 validity: from before `go` to after the last held-gate assertion, well inside the helper's 5 s. */
const HOLD_WINDOW_MS = 4_000;
/** Bounded wait after releasing gates before the supervisor ends its own group. */
const DRAIN_MS = 1_000;
const SHUTDOWN_TIMEOUT = 5_000;
const TICKET = "BACK-1";
const TICKET_REF = `refs/claims/${TICKET}`;
const BINDING = `tb1-${"5e".repeat(32)}`;
const HOLDER = "agent-sentinel-holder";
const CLAIMED: JsonObject = { state: "claimed", holder: HOLDER };

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

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => byCodeUnits(left, right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("fixture values must be JSON encodable");
	return encoded;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Reference record and its exact on-disk bytes. */
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference change with the resolver receipt: exactly the schema and both record digests. */
function changeOf(record: ClaimIntentRecord): ClaimChange {
	const receipt = { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
	return { operationId: record.intent.operationId, receipt, payload: CLAIMED };
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

/** Polls `condition` until it holds; fails with `label` after `timeoutMs`. */
async function waitUntil(label: string, timeoutMs: number, condition: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * The parent's view of one detached supervisor: its JSON events, its exit, the verified own process group,
 * and the only two commands the parent may send. The parent never signals a numeric PID or group itself.
 */
class Supervisor {
	readonly child: ChildProcess;
	readonly events: SupervisorEvent[] = [];
	exit: { code: number | null; signal: string | null } | undefined;
	private buffered = "";

	private constructor(child: ChildProcess) {
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer | string) => {
			this.buffered += String(chunk);
			for (;;) {
				const index = this.buffered.indexOf("\n");
				if (index < 0) break;
				const line = this.buffered.slice(0, index);
				this.buffered = this.buffered.slice(index + 1);
				if (line) this.events.push(JSON.parse(line) as SupervisorEvent);
			}
		});
		child.stderr?.resume();
		child.on("exit", (code, signal) => {
			this.exit = { code, signal };
		});
	}

	/** Spawns the supervisor detached and verifies that it leads its own, existing process group. */
	static start(run: RunCommand): Supervisor {
		const argument = JSON.stringify({ mode: "supervise", run, lifetimeMs: SUPERVISOR_LIFETIME });
		const child = spawn(process.execPath, [PROBE, argument], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
		const supervisor = new Supervisor(child);
		const pid = child.pid;
		if (pid === undefined) throw new Error("fixture: supervisor did not start");
		try {
			// Signal 0 only checks existence of the group whose ID equals the new session leader's PID.
			process.kill(-pid, 0);
		} catch {
			throw new Error("fixture: supervisor has no own process group");
		}
		return supervisor;
	}

	get alive(): boolean {
		return this.exit === undefined && this.child.exitCode === null && this.child.signalCode === null;
	}

	async next<K extends SupervisorEvent["event"]>(event: K): Promise<Extract<SupervisorEvent, { event: K }>> {
		let found: SupervisorEvent | undefined;
		await waitUntil(`supervisor event ${event}`, EVENT_TIMEOUT, () => {
			found = this.events.find((candidate) => candidate.event === event);
			return found !== undefined || !this.alive;
		});
		if (!found) throw new Error(`fixture: supervisor ended before ${event}`);
		return found as Extract<SupervisorEvent, { event: K }>;
	}

	probeLines(): string[] {
		return this.events.flatMap((event) => (event.event === "probe-line" ? [event.line] : []));
	}

	errors(): string[] {
		return this.events.flatMap((event) => (event.event === "error" ? [event.reason] : []));
	}

	/** Asks the supervisor to SIGKILL its probe through its own child handle and returns the probe's exit. */
	async killProbe(): Promise<Extract<SupervisorEvent, { event: "probe-exit" }>> {
		if (this.events.some((event) => event.event === "probe-exit")) throw new Error("fixture: probe ended before kill");
		this.child.stdin?.write("kill-probe\n");
		return this.next("probe-exit");
	}

	/**
	 * Asks the live supervisor to SIGKILL its own current process group, then requires its own SIGKILL exit.
	 * Returns a fixture problem instead of signalling anything else when that does not happen.
	 */
	async shutdown(): Promise<string | undefined> {
		if (!this.alive) return "fixture: supervisor was lost before shutdown";
		this.child.stdin?.write("shutdown-group\n");
		try {
			await waitUntil("supervisor exit", SHUTDOWN_TIMEOUT, () => !this.alive);
		} catch {
			return "fixture: supervisor did not exit after shutdown-group";
		}
		const signal = this.exit?.signal ?? this.child.signalCode;
		if (signal !== "SIGKILL") return "fixture: supervisor did not end by its own group SIGKILL";
		return undefined;
	}
}

/** One server repository, an initialized descriptor, a private journal, gates and owned supervisors. */
class CrashCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly label: string;
	readonly url: string;
	readonly serverRepo: string;
	readonly journalDirectory: string;
	readonly control: string;
	readonly gates: ReceiveGates;
	private readonly supervisors: Supervisor[] = [];
	private clientNumber = 0;

	private constructor(format: ClaimStorageFormat, root: string, label: string, url: string, serverRepo: string) {
		this.format = format;
		this.root = root;
		this.label = label;
		this.url = url;
		this.serverRepo = serverRepo;
		this.journalDirectory = join(root, "journal");
		this.control = join(root, "control");
		this.gates = new ReceiveGates(root, label);
	}

	static async create(format: ClaimStorageFormat, caseName: string): Promise<CrashCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-crash-"));
		try {
			const label = `crash-${format}-${caseName}`;
			const { name, repo } = await server().initRepository(root, label);
			const crashCase = new CrashCase(format, root, label, server().url(name), repo);
			await mkdir(crashCase.journalDirectory);
			await chmod(crashCase.journalDirectory, 0o700);
			await mkdir(crashCase.control);
			expectKind(await initializeClaimStorage(crashCase.storage(await crashCase.client())), "created");
			return crashCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** A fresh independent client repository. */
	async client(): Promise<string> {
		const path = join(this.root, `client-${++this.clientNumber}`);
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	storage(repository: string, remote = this.url, timeoutMs = QUERY_TIMEOUT): ClaimStorageOptions {
		return { repository, remote, format: this.format, timeoutMs };
	}

	intent(operationId: string): ClaimOperationIntent {
		return {
			operationId,
			remote: this.url,
			format: this.format,
			epoch: 1,
			ticket: TICKET,
			expectedRoot: null,
			targetBinding: BINDING,
			action: "claim",
			parameters: { holder: HOLDER, ttlSeconds: 300 },
			resolved: { leaseEnd: "2026-09-25T00:05:00Z" },
		};
	}

	/**
	 * Root that writing `change` to the absent ticket creates, learned by the product writing the same change to a
	 * scratch repository (deterministic object IDs). Used only to address gates, never as an outcome oracle.
	 */
	async candidateRoot(change: ClaimChange): Promise<string> {
		const { name } = await server().initRepository(this.root, `${this.label}-scratch`);
		const scratch = this.storage(await this.client(), server().url(name));
		expectKind(await initializeClaimStorage(scratch), "created");
		const store = expectKind(await openClaimStore(scratch), "open").store;
		return expectKind(await store.write(expectKind(await store.read(TICKET), "absent"), change), "applied").root;
	}

	/** Starts a supervised probe that prepares `intent` and holds at its barrier until `go`. */
	async startProbe(intent: ClaimOperationIntent, change: ClaimChange): Promise<Supervisor> {
		const run: RunCommand = {
			journalDirectory: this.journalDirectory,
			intent,
			storage: this.storage(await this.client(), this.url, PROBE_STORAGE_TIMEOUT),
			change,
			control: this.control,
			goTimeoutMs: PROBE_GO_TIMEOUT,
		};
		const supervisor = Supervisor.start(run);
		this.supervisors.push(supervisor);
		await supervisor.next("probe-started");
		await waitUntil("probe ready", EVENT_TIMEOUT, async () => {
			if (supervisor.events.some((event) => event.event === "probe-exit")) {
				const stderr = supervisor.events.flatMap((event) => (event.event === "probe-stderr" ? [event.line] : []));
				throw new Error(`probe ended before ready: ${stderr.join(" | ")}`);
			}
			return exists(join(this.control, "ready"));
		});
		expect(await exists(join(this.control, "prepared"))).toBe(true);
		return supervisor;
	}

	async go(): Promise<void> {
		await writeFile(join(this.control, "go"), "");
	}

	/** A fresh query from an independent client repository, reading the original record from the journal. */
	async query(operationId: string, repository: string) {
		return queryClaimMutation({
			journalDirectory: this.journalDirectory,
			operationId,
			storage: this.storage(repository),
		});
	}

	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** Digest of the persisted record bytes, compared against the reference so no private bytes are printed. */
	async recordDigest(operationId: string): Promise<string> {
		return sha256Hex(await readFile(join(this.journalDirectory, `${operationId}.json`)));
	}

	/** Releases gates, drains, lets every supervisor end its own group, and removes the case. */
	async dispose(): Promise<string[]> {
		await this.gates.releaseAll();
		await Bun.sleep(DRAIN_MS);
		const problems: string[] = [];
		for (const supervisor of this.supervisors) {
			const problem = await supervisor.shutdown();
			if (problem) problems.push(problem);
			problems.push(...supervisor.errors().map((reason) => `supervisor reported: ${reason}`));
		}
		await rm(this.root, { recursive: true, force: true });
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by a cleanup problem. */
async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: CrashCase) => Promise<void>,
): Promise<void> {
	const fixture = await CrashCase.create(format, caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	const problems = await fixture.dispose();
	if (failure !== undefined) throw failure;
	expect(problems).toEqual([]);
}

for (const format of FORMATS) {
	describe(`claim primitive chain under client process death (${format})`, () => {
		test(
			"C0 healthy control: the same probe without a kill applies and the fresh query reconstructs stored",
			async () => {
				await withCase(format, "c0-healthy", async (fixture) => {
					const intent = fixture.intent("op-c0");
					const change = changeOf(recordOf(intent));
					const root = await fixture.candidateRoot(change);
					const supervisor = await fixture.startProbe(intent, change);
					await fixture.go();

					const exit = await supervisor.next("probe-exit");
					expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
					expect(supervisor.probeLines()).toEqual([JSON.stringify({ written: "applied" })]);
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(root);
					expect(await fixture.recordDigest("op-c0")).toBe(sha256Hex(`${canonicalJson(recordOf(intent))}\n`));
					expect(await fixture.query("op-c0", await fixture.client())).toEqual({
						kind: "resolved",
						resolution: { kind: "stored", observedRoot: root },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"C1 killed after durable prepare and before write: record unchanged, refs unchanged, query open",
			async () => {
				await withCase(format, "c1-prepared", async (fixture) => {
					const intent = fixture.intent("op-c1");
					const change = changeOf(recordOf(intent));
					const refsBefore = await fixture.serverRefs();
					const supervisor = await fixture.startProbe(intent, change);

					// No `go` is ever given; a SIGKILL exit proves the probe was still held at its barrier.
					const exit = await supervisor.killProbe();
					expect({ code: exit.code, signal: exit.signal }).toEqual({ code: null, signal: "SIGKILL" });
					expect(supervisor.probeLines()).toEqual([]);
					expect(await exists(join(fixture.control, "go"))).toBe(false);
					expect(await fixture.recordDigest("op-c1")).toBe(sha256Hex(`${canonicalJson(recordOf(intent))}\n`));
					expect(await fixture.serverRefs()).toEqual(refsBefore);
					expect(await fixture.query("op-c1", await fixture.client())).toEqual({
						kind: "resolved",
						resolution: { kind: "open", observedRoot: null },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"C2 killed while pre-receive is held: ref absent and query open while still held, no terminal claim",
			async () => {
				await withCase(format, "c2-pre", async (fixture) => {
					const intent = fixture.intent("op-c2");
					const change = changeOf(recordOf(intent));
					const root = await fixture.candidateRoot(change);
					const supervisor = await fixture.startProbe(intent, change);
					const queryClient = await fixture.client();
					await fixture.gates.arm("pre", root);

					// Conservative validity window: starts before `go`, so before the helper's timer can start.
					const started = performance.now();
					await fixture.go();
					await fixture.gates.entered("pre", root);
					const exit = await supervisor.killProbe();
					expect({ code: exit.code, signal: exit.signal }).toEqual({ code: null, signal: "SIGKILL" });
					expect(supervisor.probeLines()).toEqual([]);
					expect((await fixture.serverRefs())[TICKET_REF]).toBeUndefined();
					expect(await fixture.query("op-c2", queryClient)).toEqual({
						kind: "resolved",
						resolution: { kind: "open", observedRoot: null },
					});
					const elapsed = performance.now() - started;
					expect({ heldWindowBelowLimit: elapsed < HOLD_WINDOW_MS }).toEqual({ heldWindowBelowLimit: true });
					expect(await fixture.recordDigest("op-c2")).toBe(sha256Hex(`${canonicalJson(recordOf(intent))}\n`));
					// Release and drain happen in cleanup; nothing read afterwards is a terminal no-commit verdict.
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"C3 killed after post-receive entry: committed before the missing reply, query stored, record unchanged",
			async () => {
				await withCase(format, "c3-post", async (fixture) => {
					const intent = fixture.intent("op-c3");
					const change = changeOf(recordOf(intent));
					const root = await fixture.candidateRoot(change);
					const supervisor = await fixture.startProbe(intent, change);
					await fixture.gates.arm("post", root);

					await fixture.go();
					await fixture.gates.entered("post", root);
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(root);
					const exit = await supervisor.killProbe();
					expect({ code: exit.code, signal: exit.signal }).toEqual({ code: null, signal: "SIGKILL" });
					expect(supervisor.probeLines()).toEqual([]);
					expect(await fixture.recordDigest("op-c3")).toBe(sha256Hex(`${canonicalJson(recordOf(intent))}\n`));
					expect(await fixture.query("op-c3", await fixture.client())).toEqual({
						kind: "resolved",
						resolution: { kind: "stored", observedRoot: root },
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}
