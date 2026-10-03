/**
 * Behavioural contract for the private claim execution context: real directories under
 * CLAIM_JOURNAL_TEST_ROOT, separate Bun processes with barriers and SIGKILL gates, and the injected IO seam
 * for exact failure points. `created` and `loaded` mean persisted local material only; no assertion here
 * reads them as remote ownership or a current right. Process kills and call order do not establish
 * power-loss durability; hostile same-UID clients and copied active secrets stay out of scope.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClaimContext, createClaimContext, loadClaimContext } from "../claims/context/index.ts";
import { type ClaimOperationIntent, openClaimIntentJournal } from "../claims/journal/index.ts";
import {
	type ContextIO,
	gatedIO,
	type IoEvent,
	type IoGate,
	type IoStep,
	type ProbeCommand,
	type ProbeOutput,
} from "./fixtures/claim-context-probe.ts";

const TEST_TIMEOUT = 15_000;
/** How long the test waits for a child to reach a gate, and how long a child waits to be released. */
const GATE_TIMEOUT = 5_000;
const CHILD_GATE_TIMEOUT = 8_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const PROBE = fileURLToPath(new URL("./fixtures/claim-context-probe.ts", import.meta.url));
const UID = process.getuid?.();
/** Contract domain: this UTF-8 text including one trailing NUL, followed by the raw 32 secret bytes. */
const DOMAIN = "backlog.md/claim-context/v1\0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBLIC_FIELDS = ["binding", "contextId", "journalDirectory", "recovery"];
const RECORD_FIELDS = ["binding", "contextId", "recovery", "schema", "secret"];
const LOAD_SYNCS = ["sync:record", "sync:journal", "sync:context", "sync:parent"];
/** Record access and synchronization steps of a load; each must fail closed as unavailable. */
const LOAD_FAILURES = [
	"record-lstat",
	"record-open",
	"record-sync",
	"journal-sync",
	"context-sync",
	"parent-sync",
] as const;

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Contract canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
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

/** `tb1-` + lowercase SHA-256 over the UTF-8 `domain` followed by the raw bytes of the hex `secret`. */
function derive(domain: string, secret: string): string {
	return `tb1-${sha256Hex(Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from(secret, "hex")]))}`;
}

/** Reference derivation of the public binding from a private secret. */
function bindingOf(secret: string): string {
	return derive(DOMAIN, secret);
}

function freshSecret(): string {
	return randomBytes(32).toString("hex");
}

type Recovery = { binding: string; secret: string };

/** Reference private record; `recovery` carries only the immediate source's binding and secret. */
function contextRecord(contextId: string, secret: string, recovery: Recovery | null = null) {
	return { schema: 1, contextId, binding: bindingOf(secret), secret, recovery };
}

function recordText(record: unknown): string {
	return `${canonicalJson(record)}\n`;
}

/** Reference public context of the directory `<parent>/<contextId>`. */
function publicContext(
	parent: string,
	contextId: string,
	secret: string,
	recoveryBinding: string | null = null,
): ClaimContext {
	return {
		contextId,
		binding: bindingOf(secret),
		journalDirectory: join(parent, contextId, "journal"),
		recovery: recoveryBinding === null ? null : { binding: recoveryBinding },
	};
}

/** The same JSON value with every object's keys inserted in reverse order. */
function reordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reordered);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.reverse()
				.map(([key, entry]) => [key, reordered(entry)]),
		);
	}
	return value;
}

/** Failure messages name only the kind: a faulty result could carry a private secret. */
function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

/** The public context a child process printed; any other result fails the test, naming only its kind. */
function probeContext(output: ProbeOutput, kind: "created" | "loaded"): ClaimContext {
	if (output.kind !== kind) throw new Error(`expected ${kind}, got ${output.kind}`);
	return output.context as ClaimContext;
}

/** Compares private record text by digest, so a failing comparison never prints a secret. */
function expectSameText(label: string, actual: string, expected: string): void {
	expect({ label, digest: sha256Hex(actual) }).toEqual({ label, digest: sha256Hex(expected) });
}

/** No rendering of a public result or diagnostic may contain a private secret in any letter case. */
function expectNoSecret(label: string, value: unknown, secrets: string[]): void {
	const renderings = [JSON.stringify(value) ?? "", Bun.inspect(value)].map((text) => text.toLowerCase());
	const leaked = secrets.filter((secret) => renderings.some((text) => text.includes(secret.toLowerCase())));
	// Reports only the count, so a failing run does not print the secrets either.
	expect({ label, leakedSecrets: leaked.length }).toEqual({ label, leakedSecrets: 0 });
}

/** Freezes `Date` for the action; the assertion inside proves the clock is really frozen. */
async function frozenClock<T>(action: () => Promise<T>): Promise<T> {
	const frozen = new Date("2026-09-25T00:00:00.000Z");
	setSystemTime(frozen);
	try {
		expect(Date.now()).toBe(frozen.getTime());
		return await action();
	} finally {
		setSystemTime();
	}
}

function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

async function infoOf(path: string) {
	const info = await lstat(path);
	return { kind: kindOf(info), mode: info.mode & 0o7777, uid: info.uid, nlink: info.nlink, ino: info.ino };
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function entriesOf(directory: string): Promise<string[]> {
	return (await readdir(directory)).sort(byCodeUnits);
}

type TreeEntry = { path: string; kind: string; mode: number; ino: number; size: number; mtimeMs: number };

/** Type, mode, inode, size, mtime and content digest of `root` and everything below it. */
async function snapshot(root: string): Promise<(TreeEntry & { digest?: string })[]> {
	const entries: (TreeEntry & { digest?: string })[] = [];
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		const kind = kindOf(info);
		const entry = { path: relative, kind, mode: info.mode & 0o7777, ino: info.ino, size: info.size };
		// Digests instead of contents: a failing comparison must not print private secrets.
		const digest = kind === "file" ? { digest: sha256Hex(await readFile(path)) } : {};
		entries.push({ ...entry, mtimeMs: info.mtimeMs, ...digest });
		if (kind === "dir") {
			for (const name of await entriesOf(path)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return entries;
}

async function streamText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream).text();
}

function trace(events: IoEvent[]): string[] {
	return events.map((event) => `${event.op}:${event.target}`);
}

/** Best effort: makes every directory below `path` accessible again so the fixture can be removed. */
async function unlock(path: string): Promise<void> {
	const info = await lstat(path).catch(() => undefined);
	if (!info?.isDirectory()) return;
	await chmod(path, 0o700).catch(() => undefined);
	for (const name of await readdir(path).catch((): string[] => [])) await unlock(join(path, name));
}

type Child = ReturnType<typeof Bun.spawn>;
type Probe = { child: Child; output: Promise<ProbeOutput> };

class ContextCase {
	readonly root: string;
	/** The private parent directory of the contexts. */
	readonly parent: string;
	private readonly children = new Set<Child>();
	private sequence = 0;

	private constructor(root: string, parent: string) {
		this.root = root;
		this.parent = parent;
	}

	static async create(): Promise<ContextCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-context-"));
		const parent = join(root, "contexts");
		await mkdir(parent);
		await chmod(parent, 0o700);
		return new ContextCase(root, parent);
	}

	directory(contextId: string): string {
		return join(this.parent, contextId);
	}

	recordPath(contextId: string): string {
		return join(this.parent, contextId, "context.json");
	}

	/** Creates through the API below the fixture parent; any other result fails the test. */
	async create(options: { recoverFrom?: string; io?: ContextIO } = {}): Promise<ClaimContext> {
		return expectKind(await createClaimContext({ parent: this.parent, ...options }), "created").context;
	}

	/** Reads the private record directly; only tests may do this, never the probe. */
	async readRecord(contextId: string): Promise<{ text: string; record: Record<string, unknown>; secret: string }> {
		const text = await readFile(this.recordPath(contextId), "utf8");
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(text) as Record<string, unknown>;
		} catch {
			// A parser message could quote private text; keep the diagnostic fixed.
			throw new Error("the private record is not JSON");
		}
		if (typeof record.secret !== "string") throw new Error("the private record has no string secret");
		return { text, record, secret: record.secret };
	}

	/** Places raw bytes at the record path as a private regular file, bypassing the API. */
	async writeRecordFile(contextId: string, content: string | Uint8Array): Promise<void> {
		const path = this.recordPath(contextId);
		await rm(path, { recursive: true, force: true });
		await writeFile(path, content, { mode: 0o600 });
		await chmod(path, 0o600);
	}

	/** Places a complete context directory with a private journal and the given record, bypassing the API. */
	async writeContext(contextId: string, content: string): Promise<string> {
		const directory = this.directory(contextId);
		await mkdir(directory);
		await chmod(directory, 0o700);
		await mkdir(join(directory, "journal"));
		await chmod(join(directory, "journal"), 0o700);
		await this.writeRecordFile(contextId, content);
		return directory;
	}

	async entries(): Promise<string[]> {
		return entriesOf(this.parent);
	}

	/** The one entry that appeared in the parent since `before`; fails unless there is exactly one. */
	async added(before: string[]): Promise<string> {
		const fresh = (await this.entries()).filter((name) => !before.includes(name));
		const [name] = fresh;
		if (fresh.length !== 1 || name === undefined) {
			throw new Error(`expected exactly one new context directory, got ${JSON.stringify(fresh)}`);
		}
		return name;
	}

	recordingIO(events: IoEvent[]): ContextIO {
		return gatedIO({ parent: this.parent, events });
	}

	failingIO(fail: IoStep): ContextIO {
		return gatedIO({ parent: this.parent, fail });
	}

	spawn(command: Omit<ProbeCommand, "parent">): Probe {
		const argument = JSON.stringify({ ...command, parent: this.parent });
		const child = Bun.spawn([process.execPath, PROBE, argument], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		this.children.add(child);
		const output = (async () => {
			const [code, out, err] = await Promise.all([child.exited, streamText(child.stdout), streamText(child.stderr)]);
			const line = out.trim().split("\n").at(-1);
			// Only the exit code and the probe's own error text: stdout could carry a faulty result.
			if (code !== 0 || !line) throw new Error(`context probe failed (${code}): ${err.trim() || "no error text"}`);
			return JSON.parse(line) as ProbeOutput;
		})();
		output.catch(() => undefined);
		return { child, output };
	}

	async gate(step: IoStep): Promise<IoGate> {
		const dir = join(this.root, `gate-${++this.sequence}`);
		await mkdir(dir);
		return { step, dir, timeoutMs: CHILD_GATE_TIMEOUT };
	}

	/** Waits until the child holds at `gate`; fails fast when the child ends first or never arrives. */
	async reached(probe: Probe, gate: IoGate): Promise<void> {
		const deadline = Date.now() + GATE_TIMEOUT;
		while (!(await exists(join(gate.dir, "entered")))) {
			if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
				const ended = await probe.output.then(
					(output) => `result kind ${output.kind}`,
					(error: unknown) => String(error),
				);
				throw new Error(`probe ended before gate ${gate.step}: ${ended}`);
			}
			if (Date.now() >= deadline) throw new Error(`probe did not reach gate ${gate.step}`);
			await Bun.sleep(10);
		}
	}

	async kill(probe: Probe): Promise<void> {
		probe.child.kill("SIGKILL");
		await probe.child.exited;
		expect(probe.child.signalCode).toBe("SIGKILL");
	}

	async barrier(): Promise<string> {
		const dir = join(this.root, `barrier-${++this.sequence}`);
		await mkdir(dir);
		return dir;
	}

	/** Opens the barrier once `count` children announced themselves, so they start the call together. */
	async openBarrier(dir: string, count: number): Promise<void> {
		const deadline = Date.now() + GATE_TIMEOUT;
		while ((await readdir(dir)).filter((name) => name.startsWith("ready-")).length < count) {
			if (Date.now() >= deadline) throw new Error("children did not reach the barrier");
			await Bun.sleep(5);
		}
		await writeFile(join(dir, "go"), "");
	}

	async dispose(): Promise<void> {
		for (const child of this.children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await Promise.all([...this.children].map((child) => child.exited.catch(() => undefined)));
		await unlock(this.root);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withContext(body: (fixture: ContextCase) => Promise<void>): Promise<void> {
	const fixture = await ContextCase.create();
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("claim context creation", () => {
	test(
		"creates a fresh private context with a derived public binding and an empty journal the journal API opens",
		async () => {
			await withContext(async (fixture) => {
				const created = await createClaimContext({ parent: fixture.parent });
				const context = expectKind(created, "created").context;
				expect(Object.keys(created).sort(byCodeUnits)).toEqual(["context", "kind"]);
				expect(Object.keys(context).sort(byCodeUnits)).toEqual(PUBLIC_FIELDS);
				expect(UUID.test(context.contextId)).toBe(true);

				const directory = fixture.directory(context.contextId);
				const { text, record, secret } = await fixture.readRecord(context.contextId);
				expect(HEX64.test(secret)).toBe(true);
				expect(Object.keys(record).sort(byCodeUnits)).toEqual(RECORD_FIELDS);
				expectSameText("record", text, recordText(contextRecord(context.contextId, secret)));
				expect(context).toEqual(publicContext(fixture.parent, context.contextId, secret));

				expect(await fixture.entries()).toEqual([context.contextId]);
				expect(await entriesOf(directory)).toEqual(["context.json", "journal"]);
				expect(await infoOf(directory)).toMatchObject({ kind: "dir", mode: 0o700, uid: UID });
				expect(await infoOf(context.journalDirectory)).toMatchObject({ kind: "dir", mode: 0o700, uid: UID });
				expect(await entriesOf(context.journalDirectory)).toEqual([]);
				expect(await infoOf(fixture.recordPath(context.contextId))).toMatchObject({
					kind: "file",
					mode: 0o600,
					uid: UID,
					nlink: 1,
				});
				expectNoSecret("created", created, [secret]);

				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
				expect((await openClaimIntentJournal({ directory: context.journalDirectory })).kind).toBe("open");
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"creates exact 0700 and 0600 modes in a separate process whose umask is 0",
		async () => {
			await withContext(async (fixture) => {
				const context = probeContext(await fixture.spawn({ operation: "create", umask: 0 }).output, "created");
				const directory = fixture.directory(context.contextId);
				const { text, secret } = await fixture.readRecord(context.contextId);
				expectSameText("record", text, recordText(contextRecord(context.contextId, secret)));
				expect(context).toEqual(publicContext(fixture.parent, context.contextId, secret));
				expect(await infoOf(directory)).toMatchObject({ kind: "dir", mode: 0o700 });
				expect(await infoOf(context.journalDirectory)).toMatchObject({ kind: "dir", mode: 0o700 });
				expect(await infoOf(fixture.recordPath(context.contextId))).toMatchObject({
					kind: "file",
					mode: 0o600,
					nlink: 1,
				});
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"fails closed as invalid under a umask that clears owner bits, leaving one unrepaired and unadopted directory",
		async () => {
			await withContext(async (fixture) => {
				const before = await fixture.entries();
				const output = await fixture.spawn({ operation: "create", umask: 0o277 }).output;
				expect(output.kind).toBe("invalid");

				const orphan = await fixture.added(before);
				const directory = fixture.directory(orphan);
				expect(await infoOf(directory)).toMatchObject({ kind: "dir", mode: 0o500 });
				expect(await entriesOf(directory)).toEqual([]);
				expect((await loadClaimContext({ directory })).kind).toBe("invalid");
				const leftover = await snapshot(directory);

				// Healthy control under the normal umask: a fresh context, the orphan neither adopted nor repaired.
				const control = await fixture.create();
				expect(control.contextId === orphan).toBe(false);
				expect(await fixture.entries()).toEqual([orphan, control.contextId].sort(byCodeUnits));
				expect(await snapshot(directory)).toEqual(leftover);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"derives nothing from host, process, user or clock: frozen-clock and separate-process creates all differ",
		async () => {
			await withContext(async (fixture) => {
				const local = await frozenClock(async () => [await fixture.create(), await fixture.create()]);
				const child = probeContext(await fixture.spawn({ operation: "create" }).output, "created");
				const contexts = [...local, child];
				const secrets: string[] = [];
				for (const context of contexts) {
					const { text, record, secret } = await fixture.readRecord(context.contextId);
					expect(Object.keys(record).sort(byCodeUnits)).toEqual(RECORD_FIELDS);
					expectSameText(context.contextId, text, recordText(contextRecord(context.contextId, secret)));
					expect(context).toEqual(publicContext(fixture.parent, context.contextId, secret));
					secrets.push(secret);
				}
				expect(new Set(contexts.map((context) => context.contextId)).size).toBe(3);
				expect(new Set(contexts.map((context) => context.binding)).size).toBe(3);
				expect(new Set(secrets).size).toBe(3);
				expect(await fixture.entries()).toEqual(contexts.map((context) => context.contextId).sort(byCodeUnits));
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context loading", () => {
	test(
		"lets separate short processes load one context without rotation, writes or secret output",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const directory = fixture.directory(context.contextId);
				const { secret } = await fixture.readRecord(context.contextId);
				const before = { entries: await fixture.entries(), tree: await snapshot(directory) };

				const barrier = await fixture.barrier();
				const loads = [
					fixture.spawn({ operation: "load", directory, barrier }),
					fixture.spawn({ operation: "load", directory, barrier }),
				];
				await fixture.openBarrier(barrier, 2);
				const outputs = await Promise.all(loads.map((probe) => probe.output));
				expect(outputs).toEqual([
					{ kind: "loaded", context },
					{ kind: "loaded", context },
				]);
				expectNoSecret("child loads", outputs, [secret]);

				const loaded = await loadClaimContext({ directory });
				expect(loaded).toEqual({ kind: "loaded", context });
				expectNoSecret("in-process load", loaded, [secret]);
				expect({ entries: await fixture.entries(), tree: await snapshot(directory) }).toEqual(before);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context explicit paths", () => {
	test(
		"creates only below an existing absolute private parent and never creates or repairs the parent",
		async () => {
			await withContext(async (fixture) => {
				const file = join(fixture.root, "plain-file");
				await writeFile(file, "x");
				const link = join(fixture.root, "parent-link");
				await symlink(fixture.parent, link);
				const missing = join(fixture.root, "missing");
				const nested = join(fixture.parent, "nested");
				const parents: Record<string, string> = {
					empty: "",
					relative: "contexts",
					missing,
					"missing below the parent": nested,
					"regular file": file,
					symlink: link,
					"NUL byte": `${fixture.parent}\0`,
					"not a string": 42 as unknown as string,
				};
				for (const [label, parent] of Object.entries(parents)) {
					const created = await createClaimContext({ parent });
					expect({ label, kind: created.kind }).toEqual({ label, kind: "invalid" });
				}
				expect({ missing: await exists(missing), nested: await exists(nested) }).toEqual({
					missing: false,
					nested: false,
				});

				for (const mode of [0o755, 0o750, 0o711, 0o770, 0o500]) {
					await chmod(fixture.parent, mode);
					const created = await createClaimContext({ parent: fixture.parent });
					const after = (await lstat(fixture.parent)).mode & 0o7777;
					expect({ mode: mode.toString(8), kind: created.kind, after: after.toString(8) }).toEqual({
						mode: mode.toString(8),
						kind: "invalid",
						after: mode.toString(8),
					});
				}
				await chmod(fixture.parent, 0o700);
				expect(await fixture.entries()).toEqual([]);

				const context = await fixture.create();
				expect(await fixture.entries()).toEqual([context.contextId]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rejects an unusable recoverFrom as invalid before creating anything",
		async () => {
			await withContext(async (fixture) => {
				const source = await fixture.create();
				const sourceDirectory = fixture.directory(source.contextId);
				const file = join(fixture.root, "plain-file");
				await writeFile(file, "x");
				const link = join(fixture.root, "source-link");
				await symlink(sourceDirectory, link);
				const sources: Record<string, string> = {
					empty: "",
					relative: source.contextId,
					"missing context": fixture.directory(randomUUID()),
					"regular file": file,
					symlink: link,
					"NUL byte": `${sourceDirectory}\0`,
					"not a string": 42 as unknown as string,
				};
				for (const [label, recoverFrom] of Object.entries(sources)) {
					const created = await createClaimContext({ parent: fixture.parent, recoverFrom });
					expect({ label, kind: created.kind }).toEqual({ label, kind: "invalid" });
				}
				expect(await fixture.entries()).toEqual([source.contextId]);

				const recovered = await fixture.create({ recoverFrom: sourceDirectory });
				expect(recovered.recovery).toEqual({ binding: source.binding });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"loads only an existing absolute private context directory below a private parent",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const directory = fixture.directory(context.contextId);
				const file = join(fixture.root, "plain-file");
				await writeFile(file, "x");
				const link = join(fixture.root, "context-link");
				await symlink(directory, link);
				const directories: Record<string, string> = {
					empty: "",
					relative: context.contextId,
					missing: fixture.directory(randomUUID()),
					"regular file": file,
					symlink: link,
					"NUL byte": `${directory}\0`,
					"not a string": 42 as unknown as string,
				};
				for (const [label, value] of Object.entries(directories)) {
					const loaded = await loadClaimContext({ directory: value });
					expect({ label, kind: loaded.kind }).toEqual({ label, kind: "invalid" });
				}

				for (const mode of [0o755, 0o750, 0o711, 0o500]) {
					await chmod(directory, mode);
					const loaded = await loadClaimContext({ directory });
					expect({ context: mode.toString(8), kind: loaded.kind }).toEqual({
						context: mode.toString(8),
						kind: "invalid",
					});
				}
				await chmod(directory, 0o700);
				for (const mode of [0o755, 0o711]) {
					await chmod(fixture.parent, mode);
					const loaded = await loadClaimContext({ directory });
					expect({ parent: mode.toString(8), kind: loaded.kind }).toEqual({
						parent: mode.toString(8),
						kind: "invalid",
					});
				}
				await chmod(fixture.parent, 0o700);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context recovery", () => {
	test(
		"imports one old context twice in parallel into distinct fresh bindings, keeping the source and empty journals",
		async () => {
			await withContext(async (fixture) => {
				const source = await fixture.create();
				const sourceDirectory = fixture.directory(source.contextId);
				const { secret: sourceSecret } = await fixture.readRecord(source.contextId);
				const intent: ClaimOperationIntent = {
					operationId: "op-before-crash",
					remote: "git://127.0.0.1:9/claims.git",
					format: "blob",
					epoch: 1,
					ticket: "BACK-1",
					expectedRoot: null,
					targetBinding: source.binding,
					action: "claim",
					parameters: { holder: "agent-karl" },
					resolved: {},
				};
				const opened = await openClaimIntentJournal({ directory: source.journalDirectory });
				const journal = expectKind(opened, "open").journal;
				const prepared = expectKind(await journal.prepare(intent), "prepared").record;
				const sourceBefore = await snapshot(sourceDirectory);

				const barrier = await fixture.barrier();
				const imports = [
					fixture.spawn({ operation: "create", recoverFrom: sourceDirectory, barrier }),
					fixture.spawn({ operation: "create", recoverFrom: sourceDirectory, barrier }),
				];
				await fixture.openBarrier(barrier, 2);
				const outputs = await Promise.all(imports.map((probe) => probe.output));
				const recovered = outputs.map((output) => probeContext(output, "created"));

				const all = [source, ...recovered];
				expect(new Set(all.map((context) => context.binding)).size).toBe(3);
				expect(new Set(all.map((context) => context.contextId)).size).toBe(3);
				const secrets = [sourceSecret];
				for (const context of recovered) {
					const { text, secret } = await fixture.readRecord(context.contextId);
					secrets.push(secret);
					expect(context).toEqual(publicContext(fixture.parent, context.contextId, secret, source.binding));
					const sourceRecovery = { binding: source.binding, secret: sourceSecret };
					expectSameText(context.contextId, text, recordText(contextRecord(context.contextId, secret, sourceRecovery)));
					expect(await entriesOf(context.journalDirectory)).toEqual([]);
					expect(await loadClaimContext({ directory: fixture.directory(context.contextId) })).toEqual({
						kind: "loaded",
						context,
					});
				}
				expect(new Set(secrets).size).toBe(3);
				expectNoSecret("imports", outputs, secrets);

				expect(await snapshot(sourceDirectory)).toEqual(sourceBefore);
				expect(await journal.load(intent.operationId)).toEqual({ kind: "loaded", record: prepared });
				expect(await loadClaimContext({ directory: sourceDirectory })).toEqual({ kind: "loaded", context: source });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"retains only the immediate recovery source, not a chain of earlier sources",
		async () => {
			await withContext(async (fixture) => {
				const first = await fixture.create();
				const second = await fixture.create({ recoverFrom: fixture.directory(first.contextId) });
				const third = await fixture.create({ recoverFrom: fixture.directory(second.contextId) });
				const { secret: firstSecret } = await fixture.readRecord(first.contextId);
				const { secret: secondSecret } = await fixture.readRecord(second.contextId);
				const { text, secret } = await fixture.readRecord(third.contextId);

				expect(second.recovery).toEqual({ binding: first.binding });
				expect(third).toEqual(publicContext(fixture.parent, third.contextId, secret, second.binding));
				const secondRecovery = { binding: second.binding, secret: secondSecret };
				expectSameText("third", text, recordText(contextRecord(third.contextId, secret, secondRecovery)));
				expect({ firstSecret: text.includes(firstSecret), firstBinding: text.includes(first.binding) }).toEqual({
					firstSecret: false,
					firstBinding: false,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"accepts no public data as proof: forged own or recovery secrets are corrupt and never imported",
		async () => {
			await withContext(async (fixture) => {
				const genuine = await fixture.create();
				const { secret: genuineSecret } = await fixture.readRecord(genuine.contextId);

				// Controls: hand-written contexts with correct derivations load, so the forgeries below fail
				// only because of their secret-to-binding mismatch.
				const plainId = randomUUID();
				const plainSecret = freshSecret();
				await fixture.writeContext(plainId, recordText(contextRecord(plainId, plainSecret)));
				expect(await loadClaimContext({ directory: fixture.directory(plainId) })).toEqual({
					kind: "loaded",
					context: publicContext(fixture.parent, plainId, plainSecret),
				});
				const withRecoveryId = randomUUID();
				const withRecoverySecret = freshSecret();
				const recovery = { binding: genuine.binding, secret: genuineSecret };
				const withRecoveryText = recordText(contextRecord(withRecoveryId, withRecoverySecret, recovery));
				await fixture.writeContext(withRecoveryId, withRecoveryText);
				expect(await loadClaimContext({ directory: fixture.directory(withRecoveryId) })).toEqual({
					kind: "loaded",
					context: publicContext(fixture.parent, withRecoveryId, withRecoverySecret, genuine.binding),
				});

				const forgedOwnId = randomUUID();
				const forgedOwnSecret = freshSecret();
				await fixture.writeContext(
					forgedOwnId,
					recordText({ ...contextRecord(forgedOwnId, forgedOwnSecret), binding: genuine.binding }),
				);
				const forgedRecoveryId = randomUUID();
				const forgedRecoveryOwn = freshSecret();
				const forgedRecoverySecret = freshSecret();
				const forgedRecovery = { binding: genuine.binding, secret: forgedRecoverySecret };
				const forgedRecoveryText = recordText(contextRecord(forgedRecoveryId, forgedRecoveryOwn, forgedRecovery));
				await fixture.writeContext(forgedRecoveryId, forgedRecoveryText);

				const secrets = [genuineSecret, forgedOwnSecret, forgedRecoveryOwn, forgedRecoverySecret];
				const before = await fixture.entries();
				const forgeries = { "copied public binding": forgedOwnId, "copied recovery binding": forgedRecoveryId };
				for (const [label, contextId] of Object.entries(forgeries)) {
					const directory = fixture.directory(contextId);
					const loaded = await loadClaimContext({ directory });
					const imported = await createClaimContext({ parent: fixture.parent, recoverFrom: directory });
					expect({ label, loaded: loaded.kind, imported: imported.kind }).toEqual({
						label,
						loaded: "corrupt",
						imported: "corrupt",
					});
					expectNoSecret(label, [loaded, imported], secrets);
				}
				expect(await fixture.entries()).toEqual(before);

				const recovered = await fixture.create({ recoverFrom: fixture.directory(genuine.contextId) });
				expect(recovered.recovery).toEqual({ binding: genuine.binding });
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context corrupt and unsafe material", () => {
	test(
		"reports malformed, non-canonical or underived records as corrupt, also as recovery source, without rewriting",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const id = context.contextId;
				const directory = fixture.directory(id);
				const { text: valid, secret } = await fixture.readRecord(id);
				const base = contextRecord(id, secret);
				expectSameText("created record", valid, recordText(base));

				// Control: a well-formed recovery record loads, so each recovery defect below is the only cause.
				const other = freshSecret();
				const otherRecovery = { binding: bindingOf(other), secret: other };
				await fixture.writeRecordFile(id, recordText(contextRecord(id, secret, otherRecovery)));
				expect(await loadClaimContext({ directory })).toEqual({
					kind: "loaded",
					context: publicContext(fixture.parent, id, secret, otherRecovery.binding),
				});

				const short = secret.slice(0, 62);
				const hexTextBinding = `tb1-${sha256Hex(`${DOMAIN}${secret}`)}`;
				const noNulBinding = derive("backlog.md/claim-context/v1", secret);
				const otherDomainBinding = derive("backlog.md/claim-context/v2\0", secret);
				const invalidUtf8At = valid.indexOf(id);
				const corruptions: Record<string, string | Uint8Array> = {
					"not JSON": "{\n",
					empty: "",
					truncated: valid.slice(0, -10),
					"missing newline": valid.slice(0, -1),
					"extra newline": `${valid}\n`,
					"byte order mark": `\uFEFF${valid}`,
					"non-canonical spacing": `${JSON.stringify(base, null, 2)}\n`,
					"non-canonical key order": `${JSON.stringify(reordered(base))}\n`,
					"invalid UTF-8": Buffer.concat([
						Buffer.from(valid.slice(0, invalidUtf8At), "utf8"),
						Buffer.from([0xff]),
						Buffer.from(valid.slice(invalidUtf8At), "utf8"),
					]),
					"extra field": recordText({ ...base, extra: 1 }),
					"missing recovery field": recordText({ schema: 1, contextId: id, binding: base.binding, secret }),
					"schema 2": recordText({ ...base, schema: 2 }),
					"schema as string": recordText({ ...base, schema: "1" }),
					"contextId differs from the directory": recordText({ ...base, contextId: randomUUID() }),
					"uppercase contextId": recordText({ ...base, contextId: id.toUpperCase() }),
					"uppercase secret with the same bytes": recordText({ ...base, secret: secret.toUpperCase() }),
					"short secret": recordText({ ...base, secret: short, binding: bindingOf(short) }),
					"secret without matching binding": recordText({ ...base, secret: other }),
					"binding over the hex text": recordText({ ...base, binding: hexTextBinding }),
					"binding without NUL": recordText({ ...base, binding: noNulBinding }),
					"binding with another domain": recordText({ ...base, binding: otherDomainBinding }),
					"uppercase binding": recordText({ ...base, binding: `tb1-${base.binding.slice(4).toUpperCase()}` }),
					"binding without prefix": recordText({ ...base, binding: base.binding.slice(4) }),
					"recovery without secret": recordText({ ...base, recovery: { binding: otherRecovery.binding } }),
					"recovery with extra field": recordText({ ...base, recovery: { ...otherRecovery, extra: 1 } }),
					"recovery chain": recordText({ ...base, recovery: { ...otherRecovery, recovery: null } }),
					"recovery secret without matching binding": recordText({
						...base,
						recovery: { binding: otherRecovery.binding, secret: freshSecret() },
					}),
					"recovery as string": recordText({ ...base, recovery: "none" }),
				};
				const before = await fixture.entries();
				for (const [label, content] of Object.entries(corruptions)) {
					await fixture.writeRecordFile(id, content);
					const loaded = await loadClaimContext({ directory });
					const imported = await createClaimContext({ parent: fixture.parent, recoverFrom: directory });
					expect({ label, loaded: loaded.kind, imported: imported.kind }).toEqual({
						label,
						loaded: "corrupt",
						imported: "corrupt",
					});
					const unchanged = Buffer.from(await readFile(fixture.recordPath(id))).equals(Buffer.from(content));
					expect({ label, unchanged }).toEqual({ label, unchanged: true });
					expectNoSecret(label, [loaded, imported], [secret, other]);
				}
				expect(await fixture.entries()).toEqual(before);

				await fixture.writeRecordFile(id, valid);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports symlinks, directories, FIFOs, a missing record and other modes as corrupt without following or repair",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const id = context.contextId;
				const directory = fixture.directory(id);
				const record = fixture.recordPath(id);
				const { text } = await fixture.readRecord(id);
				const before = await fixture.entries();
				const expectCorrupt = async (label: string) => {
					const loaded = await loadClaimContext({ directory });
					const imported = await createClaimContext({ parent: fixture.parent, recoverFrom: directory });
					expect({ label, loaded: loaded.kind, imported: imported.kind }).toEqual({
						label,
						loaded: "corrupt",
						imported: "corrupt",
					});
				};

				await rm(record);
				await expectCorrupt("missing record");
				expect(await exists(record)).toBe(false);

				const outside = join(fixture.root, "outside.json");
				await writeFile(outside, text, { mode: 0o600 });
				await chmod(outside, 0o600);
				await symlink(outside, record);
				await expectCorrupt("symlink");
				expect((await lstat(record)).isSymbolicLink()).toBe(true);
				expectSameText("symlink target", await readFile(outside, "utf8"), text);
				await rm(record);

				await mkdir(record);
				await chmod(record, 0o700);
				await expectCorrupt("directory");
				expect((await lstat(record)).isDirectory()).toBe(true);
				await rm(record, { recursive: true });

				const fifo = Bun.spawn(["mkfifo", "-m", "600", record], { stdout: "ignore", stderr: "pipe" });
				if ((await fifo.exited) !== 0) throw new Error(`mkfifo failed: ${await streamText(fifo.stderr)}`);
				await expectCorrupt("FIFO");
				expect((await lstat(record)).isFIFO()).toBe(true);
				await rm(record);

				await fixture.writeRecordFile(id, text);
				for (const mode of [0o644, 0o640, 0o400, 0o700]) {
					await chmod(record, mode);
					await expectCorrupt(`mode ${mode.toString(8)}`);
					expect({ mode: mode.toString(8), after: ((await lstat(record)).mode & 0o7777).toString(8) }).toEqual({
						mode: mode.toString(8),
						after: mode.toString(8),
					});
				}
				await chmod(record, 0o600);
				expect(await fixture.entries()).toEqual(before);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"requires a private journal subdirectory and reports its absence or unsafety as corrupt",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const directory = fixture.directory(context.contextId);
				const journal = context.journalDirectory;
				const outside = join(fixture.root, "outside-journal");
				await mkdir(outside);
				await chmod(outside, 0o700);
				const before = await fixture.entries();
				const reset = async () => {
					await rm(journal, { recursive: true, force: true });
					await mkdir(journal);
					await chmod(journal, 0o700);
				};
				const variants: [string, () => Promise<void>][] = [
					["missing", () => rm(journal, { recursive: true, force: true })],
					[
						"regular file",
						async () => {
							await rm(journal, { recursive: true, force: true });
							await writeFile(journal, "", { mode: 0o600 });
						},
					],
					[
						"symlink to a private directory",
						async () => {
							await rm(journal, { recursive: true, force: true });
							await symlink(outside, journal);
						},
					],
					...[0o755, 0o750, 0o711, 0o500].map((mode): [string, () => Promise<void>] => [
						`mode ${mode.toString(8)}`,
						() => chmod(journal, mode),
					]),
				];
				for (const [label, damage] of variants) {
					await damage();
					const loaded = await loadClaimContext({ directory });
					const imported = await createClaimContext({ parent: fixture.parent, recoverFrom: directory });
					expect({ label, loaded: loaded.kind, imported: imported.kind }).toEqual({
						label,
						loaded: "corrupt",
						imported: "corrupt",
					});
					await reset();
				}
				expect(await fixture.entries()).toEqual(before);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports a record replaced between its lstat and open by an identical copy as corrupt",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const directory = fixture.directory(context.contextId);
				const record = fixture.recordPath(context.contextId);
				const { text } = await fixture.readRecord(context.contextId);
				const originalIno = (await lstat(record)).ino;
				// A holder object: a plain `let` flag set in the callback would stay narrowed to `false`.
				const hook = { swapped: false };
				const io = gatedIO({
					parent: fixture.parent,
					beforeRecordOpen: async (path) => {
						if (path !== record) return;
						const replacement = join(fixture.root, "replacement.json");
						await writeFile(replacement, text, { mode: 0o600 });
						await chmod(replacement, 0o600);
						await rename(replacement, record);
						hook.swapped = true;
					},
				});
				const result = await loadClaimContext({ directory, io });
				expect({ swapped: hook.swapped, kind: result.kind }).toEqual({ swapped: true, kind: "corrupt" });
				expect((await lstat(record)).ino === originalIno).toBe(false);
				expectSameText("replaced record", await readFile(record, "utf8"), text);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context injected IO failures", () => {
	test(
		"fails closed at every create step, never leaves a partial context loadable and adopts nothing afterwards",
		async () => {
			await withContext(async (fixture) => {
				const cases = [
					{ step: "mkdir-context", state: "none" },
					{ step: "mkdir-journal", state: "partial" },
					{ step: "temp-write", state: "partial" },
					{ step: "temp-sync", state: "partial" },
					{ step: "link", state: "partial" },
					{ step: "temp-unlink", state: "published" },
					{ step: "journal-sync", state: "published" },
					{ step: "context-sync", state: "published" },
					{ step: "parent-sync", state: "published" },
				] as const;
				for (const { step, state } of cases) {
					const before = await fixture.entries();
					const result = await createClaimContext({ parent: fixture.parent, io: fixture.failingIO(step) });
					expect({ step, kind: result.kind }).toEqual({ step, kind: "unavailable" });

					let failed: string | undefined;
					if (state === "none") {
						expect({ step, entries: await fixture.entries() }).toEqual({ step, entries: before });
					} else {
						failed = await fixture.added(before);
						const loaded = await loadClaimContext({ directory: fixture.directory(failed) });
						if (state === "partial") {
							expect({ step, record: await exists(fixture.recordPath(failed)), kind: loaded.kind }).toEqual({
								step,
								record: false,
								kind: "corrupt",
							});
						} else {
							const { secret } = await fixture.readRecord(failed);
							expect({ step, loaded }).toEqual({
								step,
								loaded: { kind: "loaded", context: publicContext(fixture.parent, failed, secret) },
							});
						}
					}

					// Healthy control: a separate fresh create succeeds and neither adopts nor cleans the leftover.
					const leftover = failed === undefined ? [] : await snapshot(fixture.directory(failed));
					const control = await fixture.create();
					expect({ step, fresh: !before.includes(control.contextId) && control.contextId !== failed }).toEqual({
						step,
						fresh: true,
					});
					if (failed !== undefined) {
						expect({ step, leftover: await snapshot(fixture.directory(failed)) }).toEqual({ step, leftover });
					}
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"fails without retrying or adopting when the chosen context directory already exists",
		async () => {
			await withContext(async (fixture) => {
				const events: IoEvent[] = [];
				let occupied = "";
				const io = gatedIO({
					parent: fixture.parent,
					events,
					beforeContextMkdir: async (path) => {
						occupied = path;
						await mkdir(path);
						await chmod(path, 0o700);
						await writeFile(join(path, "occupied"), "foreign", { mode: 0o600 });
					},
				});
				const result = await createClaimContext({ parent: fixture.parent, io });
				expect({ hooked: occupied !== "", kind: result.kind }).toEqual({ hooked: true, kind: "unavailable" });
				expect(await fixture.entries()).toEqual([basename(occupied)]);
				expect(await entriesOf(occupied)).toEqual(["occupied"]);
				expect(await readFile(join(occupied, "occupied"), "utf8")).toBe("foreign");
				expect(trace(events).filter((call) => call.startsWith("mkdir:"))).toEqual(["mkdir:context"]);

				const control = await fixture.create();
				expect(control.contextId === basename(occupied)).toBe(false);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"provisions the journal and syncs the temporary record before publication, then syncs all directories",
		async () => {
			await withContext(async (fixture) => {
				const events: IoEvent[] = [];
				const context = await fixture.create({ io: fixture.recordingIO(events) });
				const calls = trace(events);
				const required = [
					"mkdir:context",
					"mkdir:journal",
					"write:temp",
					"sync:temp",
					"link:record",
					"unlink:temp",
					"sync:journal",
					"sync:context",
					"sync:parent",
				];
				expect(required.filter((call) => !calls.includes(call))).toEqual([]);
				const first = (call: string) => calls.indexOf(call);
				const last = (call: string) => calls.lastIndexOf(call);
				const publication = first("link:record");
				expect({
					contextBeforeJournal: first("mkdir:context") < first("mkdir:journal"),
					journalBeforePublication: last("mkdir:journal") < publication,
					writtenBeforeSync: last("write:temp") < last("sync:temp"),
					syncedBeforePublication: last("sync:temp") < publication,
					temporaryRemovedAfterPublication: last("unlink:temp") > publication,
					journalSyncedAfterPublication: last("sync:journal") > publication,
					contextSyncedAfterPublication: last("sync:context") > publication,
					parentSyncedAfterPublication: last("sync:parent") > publication,
				}).toEqual({
					contextBeforeJournal: true,
					journalBeforePublication: true,
					writtenBeforeSync: true,
					syncedBeforePublication: true,
					temporaryRemovedAfterPublication: true,
					journalSyncedAfterPublication: true,
					contextSyncedAfterPublication: true,
					parentSyncedAfterPublication: true,
				});
				expect(calls.filter((call) => call.startsWith("link:"))).toEqual(["link:record"]);
				expect(calls.filter((call) => call.startsWith("mkdir:"))).toEqual(["mkdir:context", "mkdir:journal"]);
				expect(calls.filter((call) => /^(write|unlink):(record|journal|context|parent)$/.test(call))).toEqual([]);

				const { secret } = await fixture.readRecord(context.contextId);
				expect(context).toEqual(publicContext(fixture.parent, context.contextId, secret));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"load syncs record, journal, context and parent without writing and fails closed on access or sync errors",
		async () => {
			await withContext(async (fixture) => {
				const context = await fixture.create();
				const directory = fixture.directory(context.contextId);
				const before = { entries: await fixture.entries(), tree: await snapshot(directory) };

				const events: IoEvent[] = [];
				expect(await loadClaimContext({ directory, io: fixture.recordingIO(events) })).toEqual({
					kind: "loaded",
					context,
				});
				const calls = trace(events);
				expect(LOAD_SYNCS.filter((call) => !calls.includes(call))).toEqual([]);
				expect(calls.filter((call) => /^(write|link|unlink|mkdir):/.test(call))).toEqual([]);

				for (const step of LOAD_FAILURES) {
					const result = await loadClaimContext({ directory, io: fixture.failingIO(step) });
					expect({ step, kind: result.kind }).toEqual({ step, kind: "unavailable" });
				}
				expect({ entries: await fixture.entries(), tree: await snapshot(directory) }).toEqual(before);
				expect(await loadClaimContext({ directory })).toEqual({ kind: "loaded", context });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"propagates a recovery source failure, including unavailable, before creating any destination",
		async () => {
			await withContext(async (fixture) => {
				const source = await fixture.create();
				const sourceDirectory = fixture.directory(source.contextId);
				const before = { entries: await fixture.entries(), tree: await snapshot(sourceDirectory) };
				for (const step of LOAD_FAILURES) {
					const result = await createClaimContext({
						parent: fixture.parent,
						recoverFrom: sourceDirectory,
						io: fixture.failingIO(step),
					});
					expect({ step, kind: result.kind }).toEqual({ step, kind: "unavailable" });
					expect({ step, entries: await fixture.entries() }).toEqual({ step, entries: before.entries });
				}
				expect(await snapshot(sourceDirectory)).toEqual(before.tree);

				const recovered = await fixture.create({ recoverFrom: sourceDirectory });
				expect(recovered.recovery).toEqual({ binding: source.binding });
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim context process crashes", () => {
	test(
		"leaves a corrupt, unadopted partial context after a kill before publication",
		async () => {
			await withContext(async (fixture) => {
				for (const step of ["mkdir-journal", "temp-sync", "link"] as const) {
					const before = await fixture.entries();
					const gate = await fixture.gate(step);
					const probe = fixture.spawn({ operation: "create", gate });
					await fixture.reached(probe, gate);
					await fixture.kill(probe);

					const id = await fixture.added(before);
					const directory = fixture.directory(id);
					const partial = await snapshot(directory);
					expect({ step, record: await exists(fixture.recordPath(id)) }).toEqual({ step, record: false });
					const loaded = await loadClaimContext({ directory });
					const imported = await createClaimContext({ parent: fixture.parent, recoverFrom: directory });
					expect({ step, loaded: loaded.kind, imported: imported.kind }).toEqual({
						step,
						loaded: "corrupt",
						imported: "corrupt",
					});
					expect({ step, entries: await fixture.entries() }).toEqual({
						step,
						entries: [...before, id].sort(byCodeUnits),
					});

					const control = await fixture.create();
					expect({ step, fresh: control.contextId !== id }).toEqual({ step, fresh: true });
					expect({ step, partial: await snapshot(directory) }).toEqual({ step, partial });
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"leaves a complete context after a kill after publication, which a healthy load synchronizes and returns",
		async () => {
			await withContext(async (fixture) => {
				for (const step of ["after-link", "parent-sync", "after-parent-sync"] as const) {
					const before = await fixture.entries();
					const gate = await fixture.gate(step);
					const probe = fixture.spawn({ operation: "create", gate });
					await fixture.reached(probe, gate);
					await fixture.kill(probe);

					const id = await fixture.added(before);
					const directory = fixture.directory(id);
					const { text, secret } = await fixture.readRecord(id);
					expectSameText(step, text, recordText(contextRecord(id, secret)));
					expect({ step, info: await infoOf(fixture.recordPath(id)) }).toMatchObject({
						step,
						info: { kind: "file", mode: 0o600 },
					});

					const events: IoEvent[] = [];
					const loaded = await loadClaimContext({ directory, io: fixture.recordingIO(events) });
					expect({ step, loaded }).toEqual({
						step,
						loaded: { kind: "loaded", context: publicContext(fixture.parent, id, secret) },
					});
					const calls = trace(events);
					expect({ step, missingSyncs: LOAD_SYNCS.filter((call) => !calls.includes(call)) }).toEqual({
						step,
						missingSyncs: [],
					});
					expectSameText(step, (await fixture.readRecord(id)).text, text);
				}
			});
		},
		TEST_TIMEOUT,
	);
});
