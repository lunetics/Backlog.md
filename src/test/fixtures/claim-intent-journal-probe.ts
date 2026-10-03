/**
 * Test-only IO seam and child process for the intent journal tests. `gatedIO` wraps `claimJournalIO`
 * and its FileHandles to record calls, inject a failure at one step or pause at a gate file. Run as a
 * script it performs one journal operation in a separate Bun process and prints one JSON line. It
 * asserts nothing.
 */
import { access, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ClaimOperationIntent, claimJournalIO, openClaimIntentJournal } from "../../claims/journal/index.ts";

export type JournalIO = typeof claimJournalIO;
type FileHandle = Awaited<ReturnType<JournalIO["open"]>>;

export type IoStep =
	| "temp-write"
	| "temp-sync"
	| "link"
	| "after-link"
	| "temp-unlink"
	| "dir-sync"
	| "after-dir-sync"
	| "final-sync";
export type IoTarget = "dir" | "final" | "temp" | "other";
export type IoEvent = { op: string; target: IoTarget };
export type IoGate = { step: IoStep; dir: string; timeoutMs: number };
export type IoPlan = {
	directory: string;
	operationId: string;
	events?: IoEvent[];
	fail?: IoStep;
	gate?: IoGate;
	/** Runs once, in-process, immediately before the first `lstat` of the final record path. */
	onFinalLstat?: () => Promise<void>;
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

/** Wraps the journal IO seam; the wrapped calls reach the real filesystem unless a step fails or holds. */
export function gatedIO(plan: IoPlan): JournalIO {
	const directory = resolve(plan.directory);
	const finalPath = resolve(directory, `${plan.operationId}.json`);
	const classify = (path: unknown): IoTarget => {
		const absolute = resolve(String(path));
		if (absolute === directory) return "dir";
		if (absolute === finalPath) return "final";
		return dirname(absolute) === directory ? "temp" : "other";
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
					if (op === "sync" && target === "temp") await checkpoint("temp-sync");
					if (op === "sync" && target === "dir") await checkpoint("dir-sync");
					if (op === "sync" && target === "final") await checkpoint("final-sync");
					const result: unknown = await value.apply(object, args);
					if (op === "sync" && target === "dir") await checkpoint("after-dir-sync");
					return result;
				};
			},
		});

	const open = async (...args: Parameters<JournalIO["open"]>) => {
		const target = classify(args[0]);
		record("open", target);
		return wrap(await claimJournalIO.open(...args), target);
	};
	let finalLstatHooked = false;
	const lstat = async (...args: Parameters<JournalIO["lstat"]>) => {
		const target = classify(args[0]);
		record("lstat", target);
		if (target === "final" && plan.onFinalLstat && !finalLstatHooked) {
			finalLstatHooked = true;
			await plan.onFinalLstat();
		}
		return claimJournalIO.lstat(...args);
	};
	const link = async (...args: Parameters<JournalIO["link"]>) => {
		record("link", classify(args[1]));
		await checkpoint("link");
		await claimJournalIO.link(...args);
		await checkpoint("after-link");
	};
	const unlink = async (...args: Parameters<JournalIO["unlink"]>) => {
		const target = classify(args[0]);
		record("unlink", target);
		if (target === "temp") await checkpoint("temp-unlink");
		await claimJournalIO.unlink(...args);
	};
	return { open, lstat, link, unlink } as unknown as JournalIO;
}

export type ProbeCommand = {
	directory: string;
	operation: "prepare" | "load";
	operationId: string;
	intent?: ClaimOperationIntent;
	gate?: IoGate;
	/** Directory where the child announces `ready-<pid>` and then waits for `go`. */
	barrier?: string;
	umask?: number;
};
export type ProbeOutput = { kind: string; record?: unknown; reason?: string };

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
	const io = gatedIO({ directory: command.directory, operationId: command.operationId, gate: command.gate });
	const opened = await openClaimIntentJournal({ directory: command.directory, io });
	let output: ProbeOutput;
	if (opened.kind !== "open") {
		output = opened;
	} else {
		if (command.barrier) await barrier(command.barrier, 8_000);
		output =
			command.operation === "prepare" && command.intent
				? await opened.journal.prepare(command.intent)
				: await opened.journal.load(command.operationId);
	}
	process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
