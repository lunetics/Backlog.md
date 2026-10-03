/**
 * Test-only child probe for the time path crash cases: one
 * `executeClaimTransition` in a child process with the time path switched on, an optional transfer target and a clock
 * served from a JSON list, gated at the journal's record and slot links. It asserts nothing.
 *
 * Adapted from claim-admission-probe.ts (whole file), which stays unchanged: its ExecuteCommand carries neither
 * `targetContextDirectory` nor `timePath` (claim-admission-probe.ts:57-70, :269-279), so it can drive neither the
 * transfer form nor any T call. Kept: the link gates G0/G2/G2′/G3 of the seam, the file-gate protocol, the detached
 * supervisor and its parent side. Dropped: the `journal` mode, readdir gating, fault injection, barriers and the
 * four-function seam, which no time-path case uses. New: a gate may name the `occurrence` of its step, because a T
 * call links two records and two slots (P, then the witness A), and the first link must pass.
 *
 * Run as a script it has one probe mode, `execute`, and the `supervise` mode that leads its own process group,
 * starts one probe in it, relays its lines and exit, kills it only on `kill-probe` through its own child handle and
 * ends its own group (pid 0) on `shutdown-group` or after `lifetimeMs`; nothing here signals a numeric PID.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type ExecuteClaimTransitionOptions, executeClaimTransition } from "../../claims/execution/index.ts";
import { claimJournalIO } from "../../claims/journal/index.ts";
import type { ClaimStorageOptions } from "../../claims/storage/index.ts";
import type { ClaimTransitionRequest } from "../../claims/transition/index.ts";

export type JournalIO = typeof claimJournalIO;
type LinkTarget = "record" | "slot" | "other";
/** G0 `record-link`, G2 `after-record-link`, G2′ `slot-link`, G3 `after-slot-link` (claim-admission-probe.ts:33-34). */
export type PauseStep = "record-link" | "after-record-link" | "slot-link" | "after-slot-link";
/**
 * Holds the `occurrence`-th time its step is reached (1-based, default 1): writes `<dir>/entered`, then waits for
 * `<dir>/release`. Earlier occurrences of the step pass untouched.
 */
export type FileGate = { step: PauseStep; dir: string; timeoutMs: number; occurrence?: number };
export type TimePathCommand = {
	mode: "execute";
	journalDirectory: string;
	storage: ClaimStorageOptions;
	ticket: string;
	contextDirectory: string;
	/** Transfer only: the receiver's context, loaded by the executor for its binding. */
	targetContextDirectory?: string;
	operationId: string;
	request: ClaimTransitionRequest;
	clockSkewMs: number;
	attempts: number;
	/** The executor option of the time path, passed through unchanged. */
	timePath: boolean;
	clock: number[];
	gates: FileGate[];
};
type SuperviseCommand = { mode: "supervise"; run: TimePathCommand; lifetimeMs: number };
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

// adapted from claim-admission-probe.ts:92-99
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

// adapted from claim-admission-probe.ts:101-108 (waitUntil)
async function waitUntil(label: string, timeoutMs: number, condition: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/** A final record `<id>.json` or an `.admission-*` slot directly in the journal directory; anything else is other. */
// adapted from claim-admission-probe.ts:117-128 (classifier), reduced to the two link targets
function classifier(directory: string): (path: unknown) => LinkTarget {
	const root = resolve(directory);
	return (path) => {
		const absolute = resolve(String(path));
		if (dirname(absolute) !== root) return "other";
		const name = basename(absolute);
		if (name.startsWith(".admission-")) return "slot";
		return name.endsWith(".json") && !name.startsWith(".") ? "record" : "other";
	};
}

/** The journal seam with gates around every record and slot link; every call reaches the real filesystem. */
// adapted from claim-admission-probe.ts:142-201 (pauseIO), link gates only
export function gatedIO(directory: string, onStep: (step: PauseStep) => Promise<void>): JournalIO {
	const classify = classifier(directory);
	const link = async (...args: Parameters<JournalIO["link"]>) => {
		const target = classify(args[1]);
		if (target === "record") await onStep("record-link");
		if (target === "slot") await onStep("slot-link");
		await claimJournalIO.link(...args);
		if (target === "record") await onStep("after-record-link");
		if (target === "slot") await onStep("after-slot-link");
	};
	return { ...claimJournalIO, link: link as unknown as JournalIO["link"] };
}

/** Holds each gate once at its occurrence of its step; gives up after the gate's timeout. */
// adapted from claim-admission-probe.ts:208-224 (fileGates), plus the occurrence count per step
export function fileGates(gates: FileGate[]): (step: PauseStep) => Promise<void> {
	const pending = [...gates];
	const reached = new Map<PauseStep, number>();
	return async (step) => {
		const count = (reached.get(step) ?? 0) + 1;
		reached.set(step, count);
		const index = pending.findIndex((gate) => gate.step === step && (gate.occurrence ?? 1) === count);
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

// adapted from claim-admission-probe.ts:226-228
export async function releaseGate(gate: FileGate): Promise<void> {
	await writeFile(join(gate.dir, "release"), "");
}

// adapted from claim-admission-probe.ts:259-281 (runExecute), with the target context and the time path
async function runExecute(command: TimePathCommand): Promise<ExecuteOutput> {
	const journalIO = gatedIO(command.journalDirectory, fileGates(command.gates));
	const state = { calls: 0 };
	const clock = () => {
		const value = command.clock[state.calls];
		state.calls += 1;
		if (value === undefined) throw new Error("clock called more often than the case allows");
		return value;
	};
	const options: ExecuteClaimTransitionOptions = {
		storage: command.storage,
		ticket: command.ticket,
		contextDirectory: command.contextDirectory,
		journalIO,
		operationId: command.operationId,
		request: command.request,
		clockSkewMs: command.clockSkewMs,
		clock,
		attempts: command.attempts,
	};
	// Conditional, never an explicit undefined: the executor refuses a target outside transfer (execution/index.ts:293).
	if (command.targetContextDirectory !== undefined) options.targetContextDirectory = command.targetContextDirectory;
	// ASSUMPTION(scaffold): `ExecuteClaimTransitionOptions.timePath?: boolean`.
	options.timePath = command.timePath;
	const result = await executeClaimTransition(options);
	return { result, clockCalls: state.calls };
}

// adapted from claim-admission-probe.ts:283-285
function emit(event: SupervisorEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

// adapted from claim-admission-probe.ts:287-300 (eachLine)
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

// adapted from claim-admission-probe.ts:302-310 (killOwnGroup)
function killOwnGroup(): void {
	try {
		process.kill(0, "SIGKILL");
	} catch {
		emit({ event: "error", reason: "own process group could not be signalled" });
		process.exit(1);
	}
}

// adapted from claim-admission-probe.ts:312-348 (supervise), for the one probe mode
function supervise(run: TimePathCommand, lifetimeMs: number): void {
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
// adapted from claim-admission-probe.ts:350-476 (ProbeSupervisor), unchanged but for the command type
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
		command: TimePathCommand,
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

// adapted from claim-admission-probe.ts:478-488 (main), one probe mode
async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("expected the probe command as a JSON argument");
	const command = JSON.parse(raw) as SuperviseCommand | TimePathCommand;
	if (command.mode === "supervise") {
		supervise(command.run, command.lifetimeMs);
		return;
	}
	process.stdout.write(`${JSON.stringify(await runExecute(command))}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
