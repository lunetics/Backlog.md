/**
 * Test-only IO seam and child process for the claim context tests. `gatedIO` wraps
 * `claimContextIO` and its FileHandles to record calls, inject a failure at one step, pause at a gate file
 * or run a one-shot hook. Paths are classified relative to the parent directory of the contexts. Run as a
 * script it performs one create or load in a separate Bun process and prints one JSON line with the public
 * API result only; it never reads or prints private context files. It asserts nothing.
 */
import { access, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { claimContextIO, createClaimContext, loadClaimContext } from "../../claims/context/index.ts";

export type ContextIO = typeof claimContextIO;
type FileHandle = Awaited<ReturnType<ContextIO["open"]>>;

export type IoStep =
	| "mkdir-context"
	| "mkdir-journal"
	| "temp-write"
	| "temp-sync"
	| "link"
	| "after-link"
	| "temp-unlink"
	| "journal-sync"
	| "context-sync"
	| "parent-sync"
	| "after-parent-sync"
	| "record-lstat"
	| "record-open"
	| "record-sync";
/** `context` is a direct child of the parent, `journal`/`record`/`temp` live directly inside a context. */
export type IoTarget = "parent" | "context" | "journal" | "record" | "temp" | "other";
export type IoEvent = { op: string; target: IoTarget };
export type IoGate = { step: IoStep; dir: string; timeoutMs: number };
export type IoPlan = {
	parent: string;
	events?: IoEvent[];
	fail?: IoStep;
	gate?: IoGate;
	/** Runs once, in-process, immediately before the real `mkdir` of a context directory. */
	beforeContextMkdir?: (path: string) => Promise<void>;
	/** Runs once, in-process, immediately before the real `open` of a context record. */
	beforeRecordOpen?: (path: string) => Promise<void>;
};

const WRITES = new Set(["write", "writeFile", "writev", "appendFile"]);
const SYNCS = new Set(["sync", "datasync"]);
const ASYNC_METHODS = new Set([
	...WRITES,
	...SYNCS,
	"read",
	"readFile",
	"readv",
	"stat",
	"close",
	"truncate",
	"chmod",
	"chown",
	"utimes",
]);
const SYNC_STEPS: Partial<Record<IoTarget, IoStep>> = {
	temp: "temp-sync",
	journal: "journal-sync",
	context: "context-sync",
	parent: "parent-sync",
	record: "record-sync",
};

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Writes `<gate>/entered`, then waits for `<gate>/release`; gives up after the timeout. */
async function hold(gate: IoGate): Promise<void> {
	await writeFile(join(gate.dir, "entered"), "");
	const deadline = Date.now() + gate.timeoutMs;
	while (!(await exists(join(gate.dir, "release")))) {
		if (Date.now() >= deadline) throw new Error(`gate ${gate.step} was never released`);
		await Bun.sleep(10);
	}
}

function operationName(method: string): string {
	if (WRITES.has(method)) return "write";
	if (SYNCS.has(method)) return "sync";
	return method;
}

function injected(step: IoStep): Error {
	return Object.assign(new Error(`injected failure at ${step}`), { code: step === "link" ? "EPERM" : "EIO" });
}

/** Wraps the context IO seam; the wrapped calls reach the real filesystem unless a step fails or holds. */
export function gatedIO(plan: IoPlan): ContextIO {
	const parent = resolve(plan.parent);
	const classify = (path: unknown): IoTarget => {
		const absolute = resolve(String(path));
		if (absolute === parent) return "parent";
		if (dirname(absolute) === parent) return "context";
		if (dirname(dirname(absolute)) !== parent) return "other";
		const name = basename(absolute);
		if (name === "journal") return "journal";
		if (name === "context.json") return "record";
		return "temp";
	};
	const record = (op: string, target: IoTarget) => plan.events?.push({ op, target });
	const checkpoint = async (step: IoStep) => {
		if (plan.fail === step) throw injected(step);
		if (plan.gate?.step === step) await hold(plan.gate);
	};

	const wrap = (handle: FileHandle, target: IoTarget): FileHandle =>
		new Proxy(handle, {
			get(object, property) {
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== "function") return value;
				if (typeof property !== "string" || !ASYNC_METHODS.has(property)) return value.bind(object);
				return async (...args: unknown[]) => {
					const op = operationName(property);
					record(op, target);
					if (op === "write" && target === "temp") await checkpoint("temp-write");
					const syncStep = op === "sync" ? SYNC_STEPS[target] : undefined;
					if (syncStep) await checkpoint(syncStep);
					const result: unknown = await value.apply(object, args);
					if (op === "sync" && target === "parent") await checkpoint("after-parent-sync");
					return result;
				};
			},
		});

	let recordOpenHooked = false;
	const open = async (...args: Parameters<ContextIO["open"]>) => {
		const target = classify(args[0]);
		record("open", target);
		if (target === "record") {
			if (plan.beforeRecordOpen && !recordOpenHooked) {
				recordOpenHooked = true;
				await plan.beforeRecordOpen(resolve(String(args[0])));
			}
			await checkpoint("record-open");
		}
		return wrap(await claimContextIO.open(...args), target);
	};
	const lstat = async (...args: Parameters<ContextIO["lstat"]>) => {
		const target = classify(args[0]);
		record("lstat", target);
		if (target === "record") await checkpoint("record-lstat");
		return claimContextIO.lstat(...args);
	};
	let contextMkdirHooked = false;
	const mkdir = async (...args: Parameters<ContextIO["mkdir"]>) => {
		const target = classify(args[0]);
		record("mkdir", target);
		if (target === "context") {
			if (plan.beforeContextMkdir && !contextMkdirHooked) {
				contextMkdirHooked = true;
				await plan.beforeContextMkdir(resolve(String(args[0])));
			}
			await checkpoint("mkdir-context");
		}
		if (target === "journal") await checkpoint("mkdir-journal");
		return claimContextIO.mkdir(...args);
	};
	const link = async (...args: Parameters<ContextIO["link"]>) => {
		record("link", classify(args[1]));
		await checkpoint("link");
		await claimContextIO.link(...args);
		await checkpoint("after-link");
	};
	const unlink = async (...args: Parameters<ContextIO["unlink"]>) => {
		const target = classify(args[0]);
		record("unlink", target);
		if (target === "temp") await checkpoint("temp-unlink");
		await claimContextIO.unlink(...args);
	};
	return { open, lstat, mkdir, link, unlink } as unknown as ContextIO;
}

export type ProbeCommand = {
	operation: "create" | "load";
	/** Parent directory of the contexts; also the classification root of the IO seam. */
	parent: string;
	recoverFrom?: string;
	/** Context directory for `load`. */
	directory?: string;
	gate?: IoGate;
	/** Directory where the child announces `ready-<pid>` and then waits for `go`. */
	barrier?: string;
	umask?: number;
};
export type ProbeOutput = { kind: string; context?: unknown; reason?: string };

async function barrier(dir: string, timeoutMs: number): Promise<void> {
	await writeFile(join(dir, `ready-${process.pid}`), "");
	const deadline = Date.now() + timeoutMs;
	while (!(await exists(join(dir, "go")))) {
		if (Date.now() >= deadline) throw new Error("barrier was never opened");
		await Bun.sleep(5);
	}
}

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("expected the probe command as a JSON argument");
	const command = JSON.parse(raw) as ProbeCommand;
	if (command.umask !== undefined) process.umask(command.umask);
	const io = gatedIO({ parent: command.parent, gate: command.gate });
	if (command.barrier) await barrier(command.barrier, 8_000);
	let output: ProbeOutput;
	if (command.operation === "create") {
		output = await createClaimContext({
			parent: command.parent,
			...(command.recoverFrom === undefined ? {} : { recoverFrom: command.recoverFrom }),
			io,
		});
	} else {
		if (command.directory === undefined) throw new Error("load requires a context directory");
		output = await loadClaimContext({ directory: command.directory, io });
	}
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
