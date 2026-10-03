/**
 * Test-only journal seam and child probe for the enumeration, pause and admission tests. It asserts nothing.
 *
 * `pauseIO` wraps `claimJournalIO`, including `readdir`, and every FileHandle it opens. It records each call with the
 * class of its target (the journal directory, a final `<id>.json` record, an `.intent-*.tmp` temporary, an
 * `.admission-*` slot, anything else), injects an error code into a bounded number of matching calls, and awaits
 * `onStep` at the gates: G1 after readdir, G0 before and G2 after a record link, G2′ before and G3 after a slot link.
 * An open with write flags is recorded as `open-write`. `withoutReaddir` is the four-function seam that the journal
 * probes pass (claim-intent-journal-probe.ts:144).
 *
 * Run as a script it has three modes. `journal` prepares and then admits one intent; `execute` runs one
 * executeClaimTransition with the gated seam and a clock served from a JSON list. Both hold at file gates (write
 * `<dir>/entered`, then wait for `<dir>/release`) and at an optional barrier, and print one JSON line. `supervise` is
 * spawned detached, leads its own process group, starts one `journal` or `execute` probe in that group, relays its
 * lines and exit, kills it only on `kill-probe` through its own child handle and ends its own group (pid 0) on
 * `shutdown-group` or after `lifetimeMs`; nothing here signals a numeric PID. `ProbeSupervisor` is the parent side.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { executeClaimTransition } from "../../claims/execution/index.ts";
import { type ClaimOperationIntent, claimJournalIO, openClaimIntentJournal } from "../../claims/journal/index.ts";
import type { ClaimStorageOptions } from "../../claims/storage/index.ts";
import type { ClaimTransitionRequest } from "../../claims/transition/index.ts";

export type JournalIO = typeof claimJournalIO;
type FileHandle = Awaited<ReturnType<JournalIO["open"]>>;
export type PauseTarget = "dir" | "record" | "temp" | "slot" | "other";
export type PauseEvent = { op: string; target: PauseTarget };
/** G1 `after-readdir`, G0 `record-link`, G2 `after-record-link`, G2′ `slot-link`, G3 `after-slot-link`. */
export type PauseStep = "after-readdir" | "record-link" | "after-record-link" | "slot-link" | "after-slot-link";
/** Fails the next `times` calls of `op` on `target` with an error carrying `code`. */
export type PauseFault = {
	op: "readdir" | "lstat" | "open" | "link";
	target: PauseTarget;
	code: string;
	times: number;
};
export type PausePlan = {
	directory: string;
	events?: PauseEvent[];
	faults?: PauseFault[];
	/** Awaited at every gate point; a gate holds by not settling until the test releases it. */
	onStep?: (step: PauseStep) => Promise<void>;
};
export type FileGate = { step: PauseStep; dir: string; timeoutMs: number };
export type JournalCommand = {
	mode: "journal";
	directory: string;
	intent: ClaimOperationIntent;
	gates: FileGate[];
	barrier?: string;
};
export type ExecuteCommand = {
	mode: "execute";
	journalDirectory: string;
	storage: ClaimStorageOptions;
	ticket: string;
	contextDirectory: string;
	operationId: string;
	request: ClaimTransitionRequest;
	clockSkewMs: number;
	attempts: number;
	clock: number[];
	gates: FileGate[];
	barrier?: string;
};
export type ChildCommand = JournalCommand | ExecuteCommand;
type SuperviseCommand = { mode: "supervise"; run: ChildCommand; lifetimeMs: number };
export type JournalOutput = { prepared: string; admitted: unknown };
export type ExecuteOutput = { result: unknown; clockCalls: number };
export type SupervisorEvent =
	| { event: "probe-started"; pid: number }
	| { event: "probe-line"; line: string }
	| { event: "probe-stderr"; line: string }
	| { event: "probe-exit"; code: number | null; signal: string | null }
	| { event: "error"; reason: string };

const PROBE = fileURLToPath(import.meta.url);
const EVENT_TIMEOUT = 10_000;
const SHUTDOWN_TIMEOUT = 5_000;
const BARRIER_TIMEOUT = 8_000;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;
const WRITES = new Set(["write", "writeFile", "writev", "appendFile", "truncate", "chmod", "chown", "utimes"]);
const SYNCS = new Set(["sync", "datasync"]);
const READS = new Set(["read", "readFile", "readv"]);
const HANDLE_METHODS = new Set([...WRITES, ...SYNCS, ...READS, "stat", "close"]);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// adapted from claim-process-crash.test.ts:124 (waitUntil)
async function waitUntil(label: string, timeoutMs: number, condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

function operationName(method: string): string {
	if (WRITES.has(method)) return "write";
	if (SYNCS.has(method)) return "sync";
	if (READS.has(method)) return "read";
	return method;
}

function classifier(directory: string): (path: unknown) => PauseTarget {
	const root = resolve(directory);
	return (path) => {
		const absolute = resolve(String(path));
		if (absolute === root) return "dir";
		if (dirname(absolute) !== root) return "other";
		const name = basename(absolute);
		if (name.startsWith(".admission-")) return "slot";
		if (name.startsWith(".intent-") && name.endsWith(".tmp")) return "temp";
		return name.endsWith(".json") && !name.startsWith(".") ? "record" : "other";
	};
}

function injector(faults: PauseFault[] = []): (op: PauseFault["op"], target: PauseTarget) => void {
	const remaining = faults.map((fault) => ({ ...fault }));
	return (op, target) => {
		const fault = remaining.find((entry) => entry.op === op && entry.target === target && entry.times > 0);
		if (fault === undefined) return;
		fault.times -= 1;
		throw Object.assign(new Error(`injected ${op} failure`), { code: fault.code });
	};
}

/** Wraps the journal seam; every call reaches the real filesystem unless a fault or a held gate intervenes. */
// adapted from claim-intent-journal-probe.ts:82 (gatedIO), extended by readdir, target classes and slot gates
export function pauseIO(plan: PausePlan): JournalIO {
	const classify = classifier(plan.directory);
	const inject = injector(plan.faults);
	const record = (op: string, target: PauseTarget): void => {
		plan.events?.push({ op, target });
	};
	const step = async (name: PauseStep): Promise<void> => {
		if (plan.onStep) await plan.onStep(name);
	};
	const wrap = (handle: FileHandle, target: PauseTarget): FileHandle =>
		new Proxy(handle, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== "function") return value;
				if (typeof property !== "string" || !HANDLE_METHODS.has(property)) return value.bind(object);
				return async (...args: unknown[]) => {
					record(operationName(property), target);
					return value.apply(object, args);
				};
			},
		});

	const open = async (...args: Parameters<JournalIO["open"]>) => {
		const target = classify(args[0]);
		const flags = args[1];
		const writing = typeof flags === "number" ? (flags & WRITE_FLAGS) !== 0 : flags !== undefined && flags !== "r";
		record(writing ? "open-write" : "open", target);
		inject("open", target);
		return wrap(await claimJournalIO.open(...args), target);
	};
	const lstat = async (...args: Parameters<JournalIO["lstat"]>) => {
		const target = classify(args[0]);
		record("lstat", target);
		inject("lstat", target);
		return claimJournalIO.lstat(...args);
	};
	const link = async (...args: Parameters<JournalIO["link"]>) => {
		const target = classify(args[1]);
		record("link", target);
		if (target === "record") await step("record-link");
		if (target === "slot") await step("slot-link");
		inject("link", target);
		await claimJournalIO.link(...args);
		if (target === "record") await step("after-record-link");
		if (target === "slot") await step("after-slot-link");
	};
	const unlink = async (...args: Parameters<JournalIO["unlink"]>) => {
		record("unlink", classify(args[0]));
		await claimJournalIO.unlink(...args);
	};
	const listEntries = async (...args: unknown[]) => {
		const target = classify(args[0]);
		record("readdir", target);
		inject("readdir", target);
		const entries: unknown = await (claimJournalIO.readdir as (...values: unknown[]) => Promise<unknown>)(...args);
		await step("after-readdir");
		return entries;
	};
	return { open, lstat, link, unlink, readdir: listEntries } as unknown as JournalIO;
}

/** The seam shape of the intent journal probes: open, lstat, link and unlink, without readdir. */
export function withoutReaddir(io: JournalIO = claimJournalIO): JournalIO {
	return { open: io.open, lstat: io.lstat, link: io.link, unlink: io.unlink } as unknown as JournalIO;
}

/** Holds each gate once: writes `<dir>/entered`, then waits for `<dir>/release`; gives up after its timeout. */
// adapted from claim-intent-journal-probe.ts:62 (hold)
export function fileGates(gates: FileGate[]): (step: PauseStep) => Promise<void> {
	const pending = [...gates];
	return async (step) => {
		const index = pending.findIndex((gate) => gate.step === step);
		if (index < 0) return;
		const [gate] = pending.splice(index, 1);
		if (gate === undefined) return;
		await writeFile(join(gate.dir, "entered"), "");
		const deadline = Date.now() + gate.timeoutMs;
		while (!(await exists(join(gate.dir, "release")))) {
			if (Date.now() >= deadline) throw new Error(`gate ${gate.step} was never released`);
			await Bun.sleep(10);
		}
	};
}

export async function releaseGate(gate: FileGate): Promise<void> {
	await writeFile(join(gate.dir, "release"), "");
}

/** Opens the barrier once `count` children announced themselves, so they start their calls together. */
// adapted from claim-intent-journal.test.ts:280 (openBarrier)
export async function openBarrier(dir: string, count: number): Promise<void> {
	await waitUntil("probe barrier", EVENT_TIMEOUT, async () => {
		return (await readdir(dir)).filter((name) => name.startsWith("ready-")).length >= count;
	});
	await writeFile(join(dir, "go"), "");
}

// adapted from claim-intent-journal-probe.ts:159 (barrier)
async function barrier(dir: string): Promise<void> {
	await writeFile(join(dir, `ready-${process.pid}`), "");
	const deadline = Date.now() + BARRIER_TIMEOUT;
	while (!(await exists(join(dir, "go")))) {
		if (Date.now() >= deadline) throw new Error("barrier was never opened");
		await Bun.sleep(5);
	}
}

async function runJournal(command: JournalCommand): Promise<JournalOutput> {
	const io = pauseIO({ directory: command.directory, onStep: fileGates(command.gates) });
	const opened = await openClaimIntentJournal({ directory: command.directory, io });
	if (opened.kind !== "open") return { prepared: opened.kind, admitted: null };
	if (command.barrier) await barrier(command.barrier);
	const prepared = await opened.journal.prepare(command.intent);
	if (prepared.kind !== "prepared") return { prepared: prepared.kind, admitted: null };
	return { prepared: prepared.kind, admitted: await opened.journal.admit(prepared.record) };
}

async function runExecute(command: ExecuteCommand): Promise<ExecuteOutput> {
	const journalIO = pauseIO({ directory: command.journalDirectory, onStep: fileGates(command.gates) });
	const state = { calls: 0 };
	const clock = () => {
		const value = command.clock[state.calls];
		state.calls += 1;
		if (value === undefined) throw new Error("clock called more often than the case allows");
		return value;
	};
	if (command.barrier) await barrier(command.barrier);
	const result = await executeClaimTransition({
		storage: command.storage,
		ticket: command.ticket,
		contextDirectory: command.contextDirectory,
		journalIO,
		operationId: command.operationId,
		request: command.request,
		clockSkewMs: command.clockSkewMs,
		clock,
		attempts: command.attempts,
	});
	return { result, clockCalls: state.calls };
}

function emit(event: SupervisorEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

// adapted from claim-crash-probe.ts:53
function eachLine(stream: Readable | null, onLine: (line: string) => void): void {
	let buffered = "";
	stream?.on("data", (chunk: Buffer | string) => {
		buffered += String(chunk);
		for (;;) {
			const index = buffered.indexOf("\n");
			if (index < 0) break;
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			if (line) onLine(line);
		}
	});
}

// adapted from claim-crash-probe.ts:67
function killOwnGroup(): void {
	try {
		process.kill(0, "SIGKILL");
	} catch {
		emit({ event: "error", reason: "own process group could not be signalled" });
		process.exit(1);
	}
}

// adapted from claim-crash-probe.ts:76 (supervise), for both probe modes
function supervise(run: ChildCommand, lifetimeMs: number): void {
	// Only a leader of its own group may later signal group 0; otherwise that would be the caller's group.
	try {
		process.kill(-process.pid, 0);
	} catch {
		emit({ event: "error", reason: "supervisor does not lead its own process group" });
		process.exit(1);
	}
	const probe = spawn(process.execPath, [PROBE, JSON.stringify(run)], { stdio: ["ignore", "pipe", "pipe"] });
	let probeExited = false;
	probe.on("error", () => emit({ event: "error", reason: "probe could not be started" }));
	probe.on("exit", () => {
		probeExited = true;
	});
	probe.on("close", (code, signal) => emit({ event: "probe-exit", code, signal }));
	if (probe.pid !== undefined) emit({ event: "probe-started", pid: probe.pid });
	eachLine(probe.stdout, (line) => emit({ event: "probe-line", line }));
	eachLine(probe.stderr, (line) => emit({ event: "probe-stderr", line }));
	eachLine(process.stdin, (command) => {
		if (command === "kill-probe") {
			if (probeExited) {
				emit({ event: "error", reason: "probe already exited" });
				return;
			}
			probe.kill("SIGKILL");
			return;
		}
		if (command === "shutdown-group") {
			killOwnGroup();
			return;
		}
		emit({ event: "error", reason: "unknown supervisor command" });
	});
	// The pending timer keeps the supervisor alive; it also bounds its lifetime if the parent is lost.
	setTimeout(killOwnGroup, lifetimeMs);
}

/**
 * The parent's view of one detached supervisor: its JSON events, its exit, the verified own process group and the
 * only two commands the parent may send. The parent never signals a numeric PID or group itself.
 */
// adapted from claim-process-crash.test.ts:136 (Supervisor)
export class ProbeSupervisor {
	readonly child: ChildProcess;
	readonly events: SupervisorEvent[] = [];
	private exit: { code: number | null; signal: string | null } | undefined;
	private buffered = "";
	private ended: Promise<string | undefined> | undefined;

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

	/** Spawns the supervisor detached with `env` and verifies that it leads its own, existing process group. */
	static start(
		command: ChildCommand,
		lifetimeMs: number,
		env: Record<string, string | undefined> = process.env,
	): ProbeSupervisor {
		const argument = JSON.stringify({ mode: "supervise", run: command, lifetimeMs });
		const child = spawn(process.execPath, [PROBE, argument], { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
		const supervisor = new ProbeSupervisor(child);
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

	private probeExited(): boolean {
		return this.events.some((event) => event.event === "probe-exit");
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

	stderrLines(): string[] {
		return this.events.flatMap((event) => (event.event === "probe-stderr" ? [event.line] : []));
	}

	errors(): string[] {
		return this.events.flatMap((event) => (event.event === "error" ? [event.reason] : []));
	}

	/** True once the probe holds at `gate`; false when it ended first. Fails after the event timeout. */
	async reached(gate: FileGate): Promise<boolean> {
		const state = { entered: false };
		await waitUntil(`probe gate ${gate.step}`, EVENT_TIMEOUT, async () => {
			state.entered = await exists(join(gate.dir, "entered"));
			return state.entered || this.probeExited() || !this.alive;
		});
		return state.entered;
	}

	/** Asks the supervisor to SIGKILL its probe through its own child handle and returns the probe's exit. */
	async killProbe(): Promise<Extract<SupervisorEvent, { event: "probe-exit" }>> {
		if (this.probeExited()) throw new Error("fixture: probe ended before kill");
		this.child.stdin?.write("kill-probe\n");
		return this.next("probe-exit");
	}

	/** The probe's only JSON line after a zero exit; anything else is a fixture failure naming its stderr. */
	async output<T>(): Promise<T> {
		const exit = await this.next("probe-exit");
		const lines = this.probeLines();
		const line = lines.at(-1);
		if (exit.code !== 0 || lines.length !== 1 || line === undefined) {
			throw new Error(`fixture: probe failed (${exit.code} ${exit.signal}): ${this.stderrLines().join(" | ")}`);
		}
		return JSON.parse(line) as T;
	}

	/** Ends the supervisor's own group once; returns a fixture problem instead of signalling anything else. */
	shutdown(): Promise<string | undefined> {
		this.ended ??= this.endGroup();
		return this.ended;
	}

	private async endGroup(): Promise<string | undefined> {
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

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("expected the probe command as a JSON argument");
	const command = JSON.parse(raw) as SuperviseCommand | ChildCommand;
	if (command.mode === "supervise") {
		supervise(command.run, command.lifetimeMs);
		return;
	}
	const output = command.mode === "journal" ? await runJournal(command) : await runExecute(command);
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
