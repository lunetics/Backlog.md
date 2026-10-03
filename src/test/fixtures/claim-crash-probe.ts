/**
 * Test-only crash probe with two modes. It asserts nothing.
 *
 * `supervise` is spawned detached by the test, so it leads its own session and process group. It starts one
 * `run` probe as its own child in that same group, relays the probe's stdout/stderr lines and exit status as
 * JSON events, kills the probe only on the parent's `kill-probe` command through its own child handle, and on
 * `shutdown-group` signals its own current process group (pid 0) with SIGKILL. It never signals a numeric
 * PID or group, and it ends its group by itself after `lifetimeMs` so nothing outlives a lost parent.
 *
 * `run` performs the documented primitive order: journal prepare, `prepared` marker, store open and fresh
 * base read, `ready` marker, wait for the parent's `go`, then exactly one storage write whose kind it prints
 * as its only stdout line. Without `go` it gives up after `goTimeoutMs` and never writes.
 */
import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type ClaimOperationIntent, openClaimIntentJournal } from "../../claims/journal/index.ts";
import { type ClaimChange, type ClaimStorageOptions, openClaimStore } from "../../claims/storage/index.ts";

export type RunCommand = {
	journalDirectory: string;
	intent: ClaimOperationIntent;
	storage: ClaimStorageOptions;
	change: ClaimChange;
	/** Directory for the `prepared` and `ready` markers and the parent's `go` file. */
	control: string;
	goTimeoutMs: number;
};
export type ProbeCommand = { mode: "supervise"; run: RunCommand; lifetimeMs: number } | ({ mode: "run" } & RunCommand);
export type SupervisorEvent =
	| { event: "probe-started"; pid: number }
	| { event: "probe-line"; line: string }
	| { event: "probe-stderr"; line: string }
	| { event: "probe-exit"; code: number | null; signal: string | null }
	| { event: "error"; reason: string };

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function emit(event: SupervisorEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Calls `onLine` for every complete line of `stream`, however the chunks are split. */
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

function killOwnGroup(): void {
	try {
		process.kill(0, "SIGKILL");
	} catch {
		emit({ event: "error", reason: "own process group could not be signalled" });
		process.exit(1);
	}
}

function supervise(run: RunCommand, lifetimeMs: number): void {
	// Only a leader of its own group may later signal group 0; otherwise that would be the caller's group.
	try {
		process.kill(-process.pid, 0);
	} catch {
		emit({ event: "error", reason: "supervisor does not lead its own process group" });
		process.exit(1);
	}
	const self = fileURLToPath(import.meta.url);
	const probe = spawn(process.execPath, [self, JSON.stringify({ mode: "run", ...run })], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let probeExited = false;
	probe.on("error", () => emit({ event: "error", reason: "probe could not be started" }));
	// `exit` guards against signalling a finished probe; the event is reported on `close`, after the probe's
	// stdout and stderr are drained, so every relayed line precedes its exit event.
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

async function runProbe(command: RunCommand): Promise<void> {
	const opened = await openClaimIntentJournal({ directory: command.journalDirectory });
	if (opened.kind !== "open") throw new Error(`journal open returned ${opened.kind}`);
	const prepared = await opened.journal.prepare(command.intent);
	if (prepared.kind !== "prepared") throw new Error(`journal prepare returned ${prepared.kind}`);
	await writeFile(join(command.control, "prepared"), "");

	const store = await openClaimStore(command.storage);
	if (store.kind !== "open") throw new Error(`store open returned ${store.kind}`);
	const base = await store.store.read(command.intent.ticket);
	if (base.kind !== "absent" && base.kind !== "present") throw new Error(`base read returned ${base.kind}`);
	await writeFile(join(command.control, "ready"), "");

	const deadline = Date.now() + command.goTimeoutMs;
	while (!(await exists(join(command.control, "go")))) {
		if (Date.now() >= deadline) throw new Error("go was never given");
		await Bun.sleep(5);
	}
	const written = await store.store.write(base, command.change);
	process.stdout.write(`${JSON.stringify({ written: written.kind })}\n`);
}

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("expected the probe command as a JSON argument");
	const command = JSON.parse(raw) as ProbeCommand;
	if (command.mode === "supervise") {
		supervise(command.run, command.lifetimeMs);
		return;
	}
	await runProbe(command);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
