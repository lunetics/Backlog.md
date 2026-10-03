/**
 * Behavioural contract for the pause without Git: the read-only journal enumeration (enu), the pure own-operation pause
 * rule (pau) and the journal-level send admission through a no-replace admission slot (adm). Real files in a private
 * directory, the IO seam of claim-admission-probe.ts for exact failure and gate points, and separate Bun processes for
 * publication races and SIGKILL. Every test starts with a positive control that the non-functional scaffold (enumerate
 * and admit `unavailable`, the rule `invalid`) cannot satisfy; tables name the deliberately wrong implementation each
 * row catches. Expectations beyond the written contract are marked ASSUMPTION(pause). Nothing here is execution
 * admission, a work right, or a statement about other contexts, other hosts or non-cooperating writers.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClaimIntentAdmitResult,
	type ClaimIntentEnumerationResult,
	type ClaimIntentJournal,
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import {
	type ClaimOperationPause,
	type ClaimOperationPauseObservation,
	evaluateClaimOperationPause,
} from "../claims/pause/index.ts";
import type { ClaimDocument, ClaimSnapshot, ClaimStorageDescriptor, JsonObject } from "../claims/storage/index.ts";
import {
	type FileGate,
	type JournalIO,
	type JournalOutput,
	openBarrier,
	type PauseEvent,
	type PauseFault,
	type PauseStep,
	type PauseTarget,
	ProbeSupervisor,
	pauseIO,
	releaseGate,
	withoutReaddir,
} from "./fixtures/claim-admission-probe.ts";
import type { IoGate, IoStep, ProbeCommand, ProbeOutput } from "./fixtures/claim-intent-journal-probe.ts";

const TEST_TIMEOUT = 15_000;
const LONG_TEST_TIMEOUT = 40_000;
/** How long the test waits for a child to reach a gate, and how long a child waits to be released. */
const GATE_TIMEOUT = 5_000;
const CHILD_GATE_TIMEOUT = 8_000;
const SUPERVISOR_LIFETIME = 60_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const JOURNAL_PROBE = fileURLToPath(new URL("./fixtures/claim-intent-journal-probe.ts", import.meta.url));
const UID = process.getuid?.() ?? -1;
const TICKET = "BACK-1";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z); every other instant is derived from it. */
const T = 1_800_000_000_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Distinctive bindings, owners, endpoints and roots; no reason may echo any of them. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const REMOTE = "git://claims.example.invalid:9418/sentinel-claims.git";
const OTHER_REMOTE = "git://claims.example.invalid:9418/sentinel-other.git";
const ROOT = "a1".repeat(20);
const OTHER_ROOT = "c3".repeat(20);
/** 64 hex digits whose first 40 are ROOT, so a prefix comparison becomes visible. */
const ROOT_64 = `${ROOT}${"d4".repeat(12)}`;
const BLOB: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
/** ASSUMPTION(pause): slot name domain, UTF-8 with one trailing NUL, followed by the canonical five-field key. */
const ADMISSION_DOMAIN = "backlog.md/claim-admission/v1\0";
const SENTINELS = [KARL, FRANZ, OWNER, OTHER_OWNER, REMOTE, OTHER_REMOTE, ROOT, OTHER_ROOT, TICKET];
const FAILURE_KEYS = ["kind", "reason"];
/** Seam operations that create, link, remove, write and sync nothing (claim-admission-probe.ts). */
const READ_ONLY_OPS = ["close", "lstat", "open", "read", "readdir", "stat"];
const ADMITTED: ClaimIntentAdmitResult = { kind: "admitted" };

type ActionName = "acquire" | "renew" | "release" | "reclaim" | "transfer";
type IntentFields = Pick<ClaimOperationIntent, "action" | "targetBinding" | "parameters" | "resolved">;
/** Kind, exact keys and IDs; a reason appears only as type, emptiness and a count of echoed sentinels. */
type Verdict = {
	label: string;
	kind: string | null;
	keys: string[];
	operationIds: string[] | null;
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
};
type FileInfo = { kind: string; mode: number; uid: number; ino: number; nlink: number; size: number; mtimeMs: number };
type EntryInfo = FileInfo & { path: string };
type DirectorySnapshot = { entries: EntryInfo[]; digests: Record<string, string> };
type Child = ReturnType<typeof Bun.spawn>;
type JournalProbe = { child: Child; output: Promise<ProbeOutput> };

// adapted from claim-execution.test.ts:250
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-execution.test.ts:257
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

// adapted from claim-execution.test.ts:271
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
// adapted from claim-execution.test.ts:420
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

function recordText(record: unknown): string {
	return `${canonicalJson(record)}\n`;
}

/**
 * Reference slot name. ASSUMPTION(pause): `.admission-` + hex SHA-256 over the domain and the canonical key of
 * exactly ticket, endpoint, format, epoch and expected root; never action, parameters or target binding.
 */
function slotName(intent: ClaimOperationIntent): string {
	const key = {
		epoch: intent.epoch,
		expectedRoot: intent.expectedRoot,
		format: intent.format,
		remote: intent.remote,
		ticket: intent.ticket,
	};
	return `.admission-${sha256Hex(`${ADMISSION_DOMAIN}${canonicalJson(key)}`)}`;
}

function sortedRecords(records: ClaimIntentRecord[]): ClaimIntentRecord[] {
	return [...records].sort((left, right) => byCodeUnits(left.intent.operationId, right.intent.operationId));
}

// adapted from claim-execution.test.ts:295
function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

// adapted from claim-execution.test.ts:315
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

// adapted from claim-execution.test.ts:325
function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

function infoOf(info: Stats): FileInfo {
	return {
		kind: kindOf(info),
		mode: info.mode & 0o7777,
		uid: info.uid,
		ino: info.ino,
		nlink: info.nlink,
		size: info.size,
		mtimeMs: info.mtimeMs,
	};
}

/** O7: type, mode, owner, inode, link count, size, mtime and content digest of everything below `root`. */
// adapted from claim-execution.test.ts:334 (snapshot), with owner and link count
async function snapshotOf(root: string, includeRoot: boolean): Promise<DirectorySnapshot> {
	const entries: EntryInfo[] = [];
	const digests: Record<string, string> = {};
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		if (relative !== "." || includeRoot) entries.push({ path: relative, ...infoOf(info) });
		if (info.isFile()) digests[relative] = sha256Hex(await readFile(path));
		if (info.isDirectory()) {
			for (const name of (await readdir(path)).sort(byCodeUnits)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return { entries, digests };
}

function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function textOf(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

function deepFreeze<V>(value: V): V {
	if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}

/** Writes raw bytes with exactly `mode`, bypassing the journal. */
async function writePrivate(path: string, text: string, mode = 0o600): Promise<void> {
	await writeFile(path, text, { mode });
	await chmod(path, mode);
}

async function mkdirPrivate(path: string): Promise<void> {
	await mkdir(path);
	await chmod(path, 0o700);
}

// adapted from claim-intent-journal.test.ts:128
async function streamText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream).text();
}

function lease(): JsonObject {
	return { mode: "lease", leaseEnd: T + TTL, graceMs: GRACE, hardEnd: null };
}

function activeState(binding: string, owner = OWNER, bindingGeneration = 1): JsonObject {
	return { claimState: 1, status: "active", claimGeneration: 3, bindingGeneration, owner, binding, timing: lease() };
}

const FREE_STATE: JsonObject = { claimState: 1, status: "free", claimGeneration: 3 };

/** Request, successor and target binding per action; `transfer` stands for a transition record naming the receiver. */
function fieldsOf(action: ActionName): IntentFields {
	if (action === "acquire") {
		const timing = { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
		return {
			action,
			targetBinding: KARL,
			parameters: { action, owner: OWNER, timing },
			resolved: { next: { ...activeState(KARL), claimGeneration: 4 } },
		};
	}
	if (action === "renew") {
		return {
			action,
			targetBinding: KARL,
			parameters: { action, ttlMs: TTL, ttlSource: "default" },
			resolved: { next: activeState(KARL) },
		};
	}
	if (action === "transfer") {
		return {
			action,
			targetBinding: FRANZ,
			parameters: { action, to: FRANZ },
			resolved: { next: activeState(FRANZ, OTHER_OWNER, 2) },
		};
	}
	return { action, targetBinding: null, parameters: { action }, resolved: { next: FREE_STATE } };
}

function intentOf(
	operationId: string,
	action: ActionName = "renew",
	changes: Partial<ClaimOperationIntent> = {},
): ClaimOperationIntent {
	return {
		operationId,
		remote: REMOTE,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		expectedRoot: ROOT,
		...fieldsOf(action),
		...changes,
	};
}

function presentSnapshot(root = ROOT, ticket = TICKET): ClaimSnapshot {
	const document: ClaimDocument = {
		schema: 1,
		format: BLOB.format,
		epoch: BLOB.epoch,
		ticket,
		revision: 2,
		payload: activeState(KARL),
		receipts: {},
	};
	return { kind: "present", ticket, root, document };
}

const ABSENT: ClaimSnapshot = { kind: "absent", ticket: TICKET };

function rootOf(snapshot: ClaimSnapshot): string | null {
	return snapshot.kind === "present" ? snapshot.root : null;
}

function observe(
	snapshot: ClaimSnapshot = presentSnapshot(),
	changes: Partial<ClaimOperationPauseObservation> = {},
): ClaimOperationPauseObservation {
	return { remote: REMOTE, descriptor: { ...BLOB }, snapshot, ...changes };
}

/** ASSUMPTION(pause): records sorted by operation ID in code units, unreadable entries only as a count. */
function enumerated(records: ClaimIntentRecord[], corrupt = 0): ClaimIntentEnumerationResult {
	return { kind: "enumerated", records, corrupt };
}

function pauseOf(
	journal: ClaimIntentEnumerationResult,
	observation: ClaimOperationPauseObservation,
): ClaimOperationPause {
	return evaluateClaimOperationPause({ journal, observation });
}

/** A record-shaped value the rule must reject; the cast only lets it into the typed enumeration. */
function forged(value: unknown): ClaimIntentRecord {
	return value as ClaimIntentRecord;
}

// adapted from claim-transition.test.ts:244 (verdictOf)
function verdictOf(label: string, result: unknown, extra: string[] = []): Verdict {
	const reason = field(result, "reason");
	const ids = field(result, "operationIds");
	const text = typeof reason === "string" ? reason : "";
	return {
		label,
		kind: textOf(field(result, "kind")),
		keys: keysOf(result),
		operationIds: Array.isArray(ids) && ids.every((id) => typeof id === "string") ? [...ids] : null,
		reasonType: typeof reason,
		reasonEmpty: text.length === 0,
		echoed: [...SENTINELS, ...extra].filter((value) => value !== "" && text.includes(value)).length,
	};
}

function outstanding(label: string, operationIds: string[]): Verdict {
	return {
		label,
		kind: "outstanding",
		keys: ["kind", "operationIds"],
		operationIds,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

function clear(label: string): Verdict {
	return {
		label,
		kind: "clear",
		keys: ["kind"],
		operationIds: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

function failed(label: string, kind: string): Verdict {
	return { label, kind, keys: FAILURE_KEYS, operationIds: null, reasonType: "string", reasonEmpty: false, echoed: 0 };
}

function expectVerdict(result: unknown, expected: Verdict, extra: string[] = []): void {
	expect(verdictOf(expected.label, result, extra)).toStrictEqual(expected);
}

/** One private journal directory, child processes of both probes and their supervisors. */
// adapted from claim-intent-journal.test.ts:140 (JournalCase)
class JournalCase {
	readonly root: string;
	readonly directory: string;
	private readonly children = new Set<Child>();
	private readonly supervisors: ProbeSupervisor[] = [];
	private sequence = 0;

	private constructor(root: string, directory: string) {
		this.root = root;
		this.directory = directory;
	}

	static async create(): Promise<JournalCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-pause-"));
		const directory = join(root, "journal");
		await mkdirPrivate(directory);
		return new JournalCase(root, directory);
	}

	path(name: string): string {
		return join(this.directory, name);
	}

	async open(io?: JournalIO, directory = this.directory): Promise<ClaimIntentJournal> {
		return expectKind(await openClaimIntentJournal({ directory, io }), "open").journal;
	}

	/** Prepares `intent` and requires exactly the reference record. */
	async prepare(journal: ClaimIntentJournal, intent: ClaimOperationIntent): Promise<ClaimIntentRecord> {
		const record = recordOf(intent);
		const id = intent.operationId;
		expect({ id, prepared: await journal.prepare(intent) }).toEqual({ id, prepared: { kind: "prepared", record } });
		return record;
	}

	async entries(): Promise<string[]> {
		return (await readdir(this.directory)).sort(byCodeUnits);
	}

	async snapshot(includeRoot = true): Promise<DirectorySnapshot> {
		return snapshotOf(this.directory, includeRoot);
	}

	async fileInfo(name: string): Promise<FileInfo> {
		return infoOf(await lstat(this.path(name)));
	}

	async writePrivate(name: string, text: string, mode = 0o600): Promise<void> {
		await writePrivate(this.path(name), text, mode);
	}

	/** Names and digests (or kinds) of every `.intent-*` entry. */
	async temporaries(): Promise<Record<string, string>> {
		const found: Record<string, string> = {};
		for (const name of await this.entries()) {
			if (!name.startsWith(".intent-")) continue;
			const info = await lstat(this.path(name));
			found[name] = info.isFile() ? sha256Hex(await readFile(this.path(name))) : kindOf(info);
		}
		return found;
	}

	async privateDirectory(name: string): Promise<string> {
		const path = join(this.root, name);
		await mkdirPrivate(path);
		return path;
	}

	async gate(step: PauseStep): Promise<FileGate> {
		const dir = join(this.root, `gate-${++this.sequence}`);
		await mkdir(dir);
		return { step, dir, timeoutMs: CHILD_GATE_TIMEOUT };
	}

	async barrier(): Promise<string> {
		const dir = join(this.root, `barrier-${++this.sequence}`);
		await mkdir(dir);
		return dir;
	}

	/** A supervised `journal` probe of claim-admission-probe.ts: prepare, then admit, with file gates. */
	async startJournalChild(intent: ClaimOperationIntent, gates: FileGate[], barrier?: string): Promise<ProbeSupervisor> {
		const command = { mode: "journal" as const, directory: this.directory, intent, gates, barrier };
		const supervisor = ProbeSupervisor.start(command, SUPERVISOR_LIFETIME);
		this.supervisors.push(supervisor);
		await supervisor.next("probe-started");
		return supervisor;
	}

	async journalGate(step: IoStep): Promise<IoGate> {
		const dir = join(this.root, `gate-${++this.sequence}`);
		await mkdir(dir);
		return { step, dir, timeoutMs: CHILD_GATE_TIMEOUT };
	}

	/** The unchanged intent journal probe (prepare only), spawned directly as in its own suite. */
	// adapted from claim-intent-journal.test.ts:230 (spawn)
	spawnJournalProbe(command: Omit<ProbeCommand, "directory">): JournalProbe {
		const argument = JSON.stringify({ ...command, directory: this.directory });
		const child = Bun.spawn([process.execPath, JOURNAL_PROBE, argument], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.children.add(child);
		const output = (async () => {
			const [code, out, err] = await Promise.all([child.exited, streamText(child.stdout), streamText(child.stderr)]);
			const line = out.trim().split("\n").at(-1);
			if (code !== 0 || !line) throw new Error(`journal probe failed (${code}): ${err || out}`);
			return JSON.parse(line) as ProbeOutput;
		})();
		output.catch(() => undefined);
		return { child, output };
	}

	// adapted from claim-intent-journal.test.ts:251 (reached)
	async reachedJournalGate(probe: JournalProbe, gate: IoGate): Promise<void> {
		const deadline = Date.now() + GATE_TIMEOUT;
		while (!(await exists(join(gate.dir, "entered")))) {
			if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
				const output = await probe.output.catch((error: unknown) => String(error));
				throw new Error(`probe ended before gate ${gate.step}: ${JSON.stringify(output)}`);
			}
			if (Date.now() >= deadline) throw new Error(`probe did not reach gate ${gate.step}`);
			await Bun.sleep(10);
		}
	}

	async releaseJournalGate(gate: IoGate): Promise<void> {
		await writeFile(join(gate.dir, "release"), "");
	}

	async dispose(): Promise<string[]> {
		const problems: string[] = [];
		for (const child of this.children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await Promise.all([...this.children].map((child) => child.exited.catch(() => undefined)));
		for (const supervisor of this.supervisors) {
			const problem = await supervisor.shutdown();
			if (problem) problems.push(problem);
			problems.push(...supervisor.errors().map((reason) => `supervisor reported: ${reason}`));
		}
		await chmod(this.directory, 0o700).catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by a cleanup problem. */
// adapted from claim-process-crash.test.ts:372 (withCase)
async function withJournal(body: (fixture: JournalCase) => Promise<void>): Promise<void> {
	const fixture = await JournalCase.create();
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

describe("claim intent journal enumeration (no Git)", () => {
	test(
		"enu-01: lists every published record in code-unit order, null target bindings included",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const published: [string, ActionName][] = [
					["op-B", "acquire"],
					["op-_", "renew"],
					["op-a", "release"],
					["op-1", "reclaim"],
					["op-z", "transfer"],
				];
				const records: ClaimIntentRecord[] = [];
				for (const [id, action] of published) records.push(await fixture.prepare(journal, intentOf(id, action)));
				const before = await fixture.snapshot();
				const expected = enumerated(sortedRecords(records));
				// Positive control (catches: null records skipped or counted corrupt, directory or locale order).
				expect(await journal.enumerate()).toEqual(expected);
				expect(sortedRecords(records).map((record) => record.intent.operationId)).toEqual([
					"op-1",
					"op-B",
					"op-_",
					"op-a",
					"op-z",
				]);
				for (const record of records) {
					const id = record.intent.operationId;
					expect({ id, loaded: await journal.load(id) }).toEqual({ id, loaded: { kind: "loaded", record } });
				}

				// O8, ASSUMPTION(pause): open, read and close only; no write, link, unlink or sync (catches: records
				// rewritten, normalized, relinked or synced by a read-only call).
				const events: PauseEvent[] = [];
				const traced = await fixture.open(pauseIO({ directory: fixture.directory, events }));
				expect(await traced.enumerate()).toEqual(expected);
				const opened = events.filter((event) => event.op === "open" && event.target === "record").length;
				expect({
					readdirSeen: events.some((event) => event.op === "readdir" && event.target === "dir"),
					everyRecordOpened: opened >= records.length,
					mutating: events
						.filter((event) => !READ_ONLY_OPS.includes(event.op))
						.map((event) => `${event.op}:${event.target}`),
				}).toEqual({ readdirSeen: true, everyRecordOpened: true, mutating: [] });
				// O7: nothing changed on disk, including inode, mode, link count and mtime.
				expect(await fixture.snapshot()).toEqual(before);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-02: ignores every temporary, even one with complete record bytes, and leaves it untouched",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const expected = enumerated(
					sortedRecords([
						await fixture.prepare(journal, intentOf("op-B", "acquire")),
						await fixture.prepare(journal, intentOf("op-a", "release")),
					]),
				);
				// Positive control before any temporary exists.
				expect(await journal.enumerate()).toEqual(expected);
				const leftovers: { label: string; catches: string; add: (path: string) => Promise<void> }[] = [
					{
						label: "garbage bytes",
						catches: "a temporary counted as corrupt",
						add: (path) => writePrivate(path, "{not a record"),
					},
					{
						label: "complete record bytes",
						catches: "a never linked, never sent intent paused on",
						add: (path) => writePrivate(path, recordText(recordOf(intentOf("op-temp", "acquire")))),
					},
					{ label: "zero bytes", catches: "a half-written temporary counted", add: (path) => writePrivate(path, "") },
					{
						label: "directory",
						catches: "a temporary directory counted as corrupt",
						add: (path) => mkdirPrivate(path),
					},
					{
						label: "symlink to a record",
						catches: "a temporary followed to a second copy of a record",
						add: (path) => symlink(fixture.path("op-B.json"), path),
					},
				];
				for (const leftover of leftovers) {
					await leftover.add(fixture.path(`.intent-${randomUUID()}.tmp`));
					const before = await fixture.snapshot();
					const label = `${leftover.label} (catches: ${leftover.catches})`;
					expect({ label, result: await journal.enumerate() }).toEqual({ label, result: expected });
					expect({ label, unchanged: await fixture.snapshot() }).toEqual({ label, unchanged: before });
				}
				// Temporaries are classified by name alone: never opened, never linked, never removed.
				const events: PauseEvent[] = [];
				const traced = await fixture.open(pauseIO({ directory: fixture.directory, events }));
				expect(await traced.enumerate()).toEqual(expected);
				expect(events.filter((event) => event.target === "temp" && event.op !== "lstat")).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-03: counts each unreadable record and each unknown name as one corrupt entry",
		async () => {
			const valid = intentOf("op-valid");
			const other = recordText(recordOf(intentOf("op-other", "acquire")));
			await withJournal(async (fixture) => {
				// Positive control: the valid record alone, nothing corrupt.
				const journal = await fixture.open();
				const record = await fixture.prepare(journal, valid);
				expect(await journal.enumerate()).toEqual(enumerated([record]));
			});
			// ASSUMPTION(pause): a name that is neither a record ID, a temporary nor a well-formed slot is corrupt.
			const rows: { label: string; catches: string; add: (fixture: JournalCase) => Promise<void> }[] = [
				{
					label: "non-canonical record",
					catches: "a pretty-printed record accepted or skipped",
					add: (f) => f.writePrivate("op-pretty.json", `${JSON.stringify(recordOf(intentOf("op-pretty")), null, 2)}\n`),
				},
				{
					label: "content ID differs from the file name",
					catches: "a record trusted by its content",
					add: (f) => f.writePrivate("op-named.json", other),
				},
				{
					label: "wrong digest",
					catches: "a digest never checked",
					add: (f) =>
						f.writePrivate(
							"op-digest.json",
							recordText({ ...recordOf(intentOf("op-digest")), digest: "0".repeat(64) }),
						),
				},
				{
					label: "record with mode 0644",
					catches: "a record readable by others accepted",
					add: (f) => f.writePrivate("op-mode.json", recordText(recordOf(intentOf("op-mode"))), 0o644),
				},
				{
					label: "symlinked record name",
					catches: "a symlink followed to a valid record",
					add: (f) => symlink(f.path("op-valid.json"), f.path("op-link.json")),
				},
				{ label: "directory x.json", catches: "a directory skipped", add: (f) => mkdirPrivate(f.path("x.json")) },
				{ label: "-x.json", catches: "an invalid ID name skipped", add: (f) => f.writePrivate("-x.json", other) },
				{ label: "a.b.json", catches: "a dotted ID name skipped", add: (f) => f.writePrivate("a.b.json", other) },
				{ label: "op.JSON", catches: "a case-folded suffix", add: (f) => f.writePrivate("op.JSON", other) },
				{
					label: "129-character ID",
					catches: "the ID length limit ignored",
					add: (f) => f.writePrivate(`op-${"9".repeat(126)}.json`, other),
				},
				{
					label: "notes.txt",
					catches: "unknown names ignored (fail-open)",
					add: (f) => f.writePrivate("notes.txt", "x"),
				},
				{ label: ".DS_Store", catches: "every dot name ignored", add: (f) => f.writePrivate(".DS_Store", "") },
				{
					label: ".admission-zz",
					catches: "a malformed slot name ignored",
					add: (f) => f.writePrivate(".admission-zz", other),
				},
			];
			for (const row of rows) {
				await withJournal(async (fixture) => {
					const journal = await fixture.open();
					const record = await fixture.prepare(journal, valid);
					await row.add(fixture);
					const before = await fixture.snapshot();
					const label = `${row.label} (catches: ${row.catches})`;
					expect({ label, result: await journal.enumerate() }).toEqual({ label, result: enumerated([record], 1) });
					expect({ label, unchanged: await fixture.snapshot() }).toEqual({ label, unchanged: before });
				});
			}
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-04: reports IO failures as unavailable and an unsafe or missing directory as invalid",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const records = sortedRecords([
					await fixture.prepare(journal, intentOf("op-a")),
					await fixture.prepare(journal, intentOf("op-b", "release")),
				]);
				// Positive control.
				expect(await journal.enumerate()).toEqual(enumerated(records));
				const before = await fixture.snapshot(false);
				const failing = async (op: PauseFault["op"], target: PauseTarget) => {
					const faults: PauseFault[] = [{ op, target, code: "EIO", times: 1 }];
					return (await fixture.open(pauseIO({ directory: fixture.directory, faults }))).enumerate();
				};
				const rows: {
					label: string;
					catches: string;
					kind: string;
					run: () => Promise<ClaimIntentEnumerationResult>;
				}[] = [
					{
						label: "readdir EIO",
						catches: "an IO failure read as an empty journal",
						kind: "unavailable",
						run: () => failing("readdir", "dir"),
					},
					{
						label: "record lstat EIO",
						catches: "an unreadable record skipped",
						kind: "unavailable",
						run: () => failing("lstat", "record"),
					},
					{
						label: "record open EIO",
						catches: "an unopenable record skipped",
						kind: "unavailable",
						run: () => failing("open", "record"),
					},
					{
						label: "directory mode 0755",
						catches: "an unsafe directory enumerated",
						kind: "invalid",
						run: async () => {
							await chmod(fixture.directory, 0o755);
							try {
								return await journal.enumerate();
							} finally {
								await chmod(fixture.directory, 0o700);
							}
						},
					},
					{
						label: "directory moved away",
						catches: "a missing directory read as an empty journal",
						kind: "invalid",
						run: async () => {
							const moved = join(fixture.root, "moved");
							await rename(fixture.directory, moved);
							try {
								return await journal.enumerate();
							} finally {
								await rename(moved, fixture.directory);
							}
						},
					},
					{
						// ASSUMPTION(pause): opening never checks the seam's shape; the missing readdir fails here.
						label: "seam without readdir",
						catches: "a TypeError thrown, or a missing readdir read as an empty journal",
						kind: "unavailable",
						run: async () => (await fixture.open(withoutReaddir())).enumerate(),
					},
				];
				for (const row of rows) {
					const label = `${row.label} (catches: ${row.catches})`;
					expectVerdict(await row.run(), failed(label, row.kind), ["op-a", "op-b", fixture.root]);
				}
				expect(await fixture.snapshot(false)).toEqual(before);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-05: reports an empty journal as zero records and zero corrupt entries, then its first record",
		async () => {
			await withJournal(async (fixture) => {
				// Positive control in a populated journal.
				const populated = await fixture.open();
				const control = await fixture.prepare(populated, intentOf("op-control"));
				expect(await populated.enumerate()).toEqual(enumerated([control]));
				// catches: an empty result that no implementation could fail.
				const journal = await fixture.open(undefined, await fixture.privateDirectory("empty-journal"));
				expect(await journal.enumerate()).toEqual(enumerated([]));
				const first = await fixture.prepare(journal, intentOf("op-first", "acquire", { expectedRoot: null }));
				expect(await journal.enumerate()).toEqual(enumerated([first]));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-06: sees a concurrent publication either not yet or complete, never as corrupt",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const known = [await fixture.prepare(journal, intentOf("op-control"))];
				// Positive control.
				expect(await journal.enumerate()).toEqual(enumerated(known));
				const rows: { step: IoStep; catches: string; visible: boolean }[] = [
					{ step: "link", catches: "a complete, never linked temporary read as an intent", visible: false },
					{
						step: "after-link",
						catches: "a linked record hidden while its temporary remains, or counted twice",
						visible: true,
					},
				];
				for (const row of rows) {
					const operationId = `op-child-${row.step}`;
					const intent = intentOf(operationId, "acquire");
					const gate = await fixture.journalGate(row.step);
					const probe = fixture.spawnJournalProbe({ operation: "prepare", operationId, intent, gate });
					await fixture.reachedJournalGate(probe, gate);
					const held = Object.keys(await fixture.temporaries()).length > 0;
					const visible = sortedRecords(row.visible ? [...known, recordOf(intent)] : known);
					expect({ step: row.step, catches: row.catches, held, during: await journal.enumerate() }).toEqual({
						step: row.step,
						catches: row.catches,
						held: true,
						during: enumerated(visible),
					});
					await fixture.releaseJournalGate(gate);
					expect({ step: row.step, output: await probe.output }).toEqual({
						step: row.step,
						output: { kind: "prepared", record: recordOf(intent) },
					});
					known.push(recordOf(intent));
					expect({ step: row.step, after: await journal.enumerate() }).toEqual({
						step: row.step,
						after: enumerated(sortedRecords(known)),
					});
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"enu-07: lists an admitted record exactly once and never its admission slot",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const intent = intentOf("op-admitted");
				const record = await fixture.prepare(journal, intent);
				// Positive control: the record before its admission, then the admission itself.
				expect(await journal.enumerate()).toEqual(enumerated([record]));
				expect(await journal.admit(record)).toEqual(ADMITTED);
				expect(await fixture.entries()).toEqual([slotName(intent), "op-admitted.json"].sort(byCodeUnits));
				// catches: the slot listed as a second record or counted as corrupt.
				expect(await journal.enumerate()).toEqual(enumerated([record]));
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim operation pause rule (pure)", () => {
	test("pau-01: reports the matching own record for a present root and for absent with a null root", () => {
		// ASSUMPTION(pause): every matching record is outstanding; no query and no admission state is consulted.
		const renew = recordOf(intentOf("op-renew"));
		expectVerdict(pauseOf(enumerated([renew]), observe()), outstanding("present root, matching renew", ["op-renew"]));
		const acquire = recordOf(intentOf("op-acquire", "acquire", { expectedRoot: null }));
		expectVerdict(
			pauseOf(enumerated([acquire]), observe(ABSENT)),
			outstanding("absent, matching acquire with a null root (catches: null not read as absent)", ["op-acquire"]),
		);
	});

	test("pau-02: matches ticket, byte-identical endpoint, format, epoch and root, one field at a time", () => {
		const rows: { label: string; catches: string; changes: Partial<ClaimOperationIntent>; snapshot?: ClaimSnapshot }[] =
			[
				{ label: "other ticket", catches: "no ticket filter", changes: { ticket: "BACK-2" } },
				{
					label: "endpoint with a trailing slash",
					catches: "endpoint normalization",
					changes: { remote: `${REMOTE}/` },
				},
				{
					label: "endpoint with an uppercase host",
					catches: "case-folded hosts",
					changes: { remote: REMOTE.replace("claims.example", "CLAIMS.example") },
				},
				{
					label: "endpoint without .git",
					catches: "suffix normalization",
					changes: { remote: REMOTE.replace(/\.git$/, "") },
				},
				{
					label: "endpoint without the default port",
					catches: "port normalization",
					changes: { remote: REMOTE.replace(":9418", "") },
				},
				{ label: "format tree", catches: "no format filter", changes: { format: "tree" } },
				{ label: "epoch 2", catches: "no epoch filter", changes: { epoch: 2 } },
				{
					label: "other root",
					catches: "a pause per ticket instead of per root",
					changes: { expectedRoot: OTHER_ROOT },
				},
				{ label: "null against a present root", catches: "null read as any root", changes: { expectedRoot: null } },
				{
					label: "a root against absent",
					catches: "absent read as any root",
					changes: { expectedRoot: ROOT },
					snapshot: ABSENT,
				},
				{
					label: "64-hex root sharing the observed 40-hex prefix",
					catches: "a prefix comparison",
					changes: { expectedRoot: ROOT_64 },
				},
				{
					label: "40-hex prefix of an observed 64-hex root",
					catches: "a prefix comparison",
					changes: { expectedRoot: ROOT },
					snapshot: presentSnapshot(ROOT_64),
				},
			];
		for (const row of rows) {
			const snapshot = row.snapshot ?? presentSnapshot();
			const observation = observe(snapshot);
			const root = rootOf(snapshot);
			const control = recordOf(intentOf("op-a-control", "renew", { expectedRoot: root }));
			const variant = recordOf(intentOf("op-b-variant", "renew", { expectedRoot: root, ...row.changes }));
			const label = `${row.label} (catches: ${row.catches})`;
			expectVerdict(pauseOf(enumerated([control]), observation), outstanding(`${label}: control`, ["op-a-control"]));
			expectVerdict(pauseOf(enumerated([variant]), observation), clear(`${label}: variant alone`));
			expectVerdict(
				pauseOf(enumerated([control, variant]), observation),
				outstanding(`${label}: beside the control`, ["op-a-control"]),
			);
		}
	});

	test("pau-03: pauses on a matching record of every action; renew is not exempt", () => {
		const actions: { action: ActionName; catches: string }[] = [
			{ action: "acquire", catches: "a pause only for releasing actions" },
			{ action: "renew", catches: "a renew exemption" },
			{ action: "release", catches: "a release exemption" },
			{ action: "reclaim", catches: "a reclaim exemption" },
			{ action: "transfer", catches: "an allow-list of base actions" },
		];
		for (const { action, catches } of actions) {
			const id = `op-${action}`;
			expectVerdict(
				pauseOf(enumerated([recordOf(intentOf(id, action))]), observe()),
				outstanding(`${action} (catches: ${catches})`, [id]),
			);
		}
	});

	test("pau-04: decides membership by the journal alone, never by the target binding", () => {
		const rows: { label: string; catches: string; targetBinding: string | null }[] = [
			{ label: "target binding of the context", catches: "a missing rule", targetBinding: KARL },
			{
				label: "receiver binding of a transfer",
				catches: "a foreign target binding read as foreign",
				targetBinding: FRANZ,
			},
			{ label: "null target binding", catches: "free successors ignored", targetBinding: null },
		];
		for (const [index, row] of rows.entries()) {
			const id = `op-binding-${index + 1}`;
			const record = recordOf(intentOf(id, "renew", { targetBinding: row.targetBinding }));
			expectVerdict(
				pauseOf(enumerated([record]), observe()),
				outstanding(`${row.label} (catches: ${row.catches})`, [id]),
			);
		}
		const unrelated = recordOf(intentOf("op-binding-other-root", "renew", { expectedRoot: OTHER_ROOT }));
		expectVerdict(
			pauseOf(enumerated([unrelated]), observe()),
			clear("the context's target binding on another root (catches: membership by binding)"),
		);
	});

	test("pau-05: reports unknown, never clear or a partial list, for any incomplete journal view", () => {
		const matching = recordOf(intentOf("op-match"));
		const unrelated = recordOf(intentOf("op-unrelated", "renew", { expectedRoot: OTHER_ROOT }));
		// Positive controls: the matching record is outstanding, an empty journal is clear.
		expectVerdict(pauseOf(enumerated([matching]), observe()), outstanding("positive control", ["op-match"]));
		expectVerdict(pauseOf(enumerated([]), observe()), clear("empty journal"));
		class RecordInstance {
			readonly schema = 1;
			readonly intent: ClaimOperationIntent;
			readonly parameterDigest: string;
			readonly digest: string;
			constructor(record: ClaimIntentRecord) {
				this.intent = record.intent;
				this.parameterDigest = record.parameterDigest;
				this.digest = record.digest;
			}
		}
		// A throwing getter stands for "accessor": whatever snapshot style the rule uses, it must not throw or pass.
		const throwing = { ...matching };
		Object.defineProperty(throwing, "digest", {
			get: () => {
				throw new Error(`accessor ${KARL}`);
			},
			enumerable: true,
			configurable: true,
		});
		const failing = (kind: "invalid" | "unavailable"): ClaimIntentEnumerationResult => ({
			kind,
			reason: `journal ${REMOTE} ${ROOT} ${KARL} op-match`,
		});
		const emptyBinding = recordOf({ ...intentOf("op-empty-binding"), targetBinding: "" });
		const rows: { label: string; catches: string; journal: ClaimIntentEnumerationResult }[] = [
			{
				label: "one corrupt entry without a match",
				catches: "corrupt read as no outstanding operation",
				journal: enumerated([unrelated], 1),
			},
			{
				label: "one corrupt entry beside a match",
				catches: "a list presented as complete",
				journal: enumerated([matching], 1),
			},
			{ label: "invalid journal", catches: "an unsafe journal read as empty", journal: failing("invalid") },
			{ label: "unavailable journal", catches: "an IO failure read as empty", journal: failing("unavailable") },
			{
				label: "record with a wrong digest",
				catches: "unchecked in-memory records",
				journal: enumerated([matching, forged({ ...matching, digest: "0".repeat(64) })]),
			},
			{
				label: "record with an extra field",
				catches: "a lax record shape",
				journal: enumerated([matching, forged({ ...matching, extra: true })]),
			},
			{
				label: "record with a throwing accessor",
				catches: "a throw instead of a verdict",
				journal: enumerated([matching, forged(throwing)]),
			},
			{
				label: "record class instance",
				catches: "non-plain data accepted",
				journal: enumerated([matching, forged(new RecordInstance(matching))]),
			},
			{
				label: "record with an empty target binding",
				catches: "the journal schema bypassed",
				journal: enumerated([matching, emptyBinding]),
			},
		];
		for (const row of rows) {
			expectVerdict(pauseOf(row.journal, observe()), failed(`${row.label} (catches: ${row.catches})`, "unknown"), [
				"op-match",
				"op-unrelated",
			]);
		}
	});

	test("pau-06: lists every matching operation ID once, sorted by code units, and no other", () => {
		const others = [
			recordOf(intentOf("op-0", "renew", { ticket: "BACK-2" })),
			recordOf(intentOf("op-Z", "renew", { expectedRoot: OTHER_ROOT })),
		];
		const matching = [recordOf(intentOf("op-b")), recordOf(intentOf("op-A", "release")), recordOf(intentOf("op-_"))];
		const expected = ["op-A", "op-_", "op-b"];
		expectVerdict(
			pauseOf(enumerated([...matching, ...others]), observe()),
			outstanding("matching first (catches: omission, locale order)", expected),
		);
		expectVerdict(
			pauseOf(enumerated([...others, ...matching].reverse()), observe()),
			outstanding("interleaved in reverse (catches: input order kept, duplicates)", expected),
		);
	});

	test("pau-07: rejects an unchecked observation as invalid before it looks at the journal", () => {
		const matching = recordOf(intentOf("op-match"));
		expectVerdict(pauseOf(enumerated([matching]), observe()), outstanding("positive control", ["op-match"]));
		const rows: { label: string; catches: string; observation: ClaimOperationPauseObservation }[] = [
			{
				label: "unreachable read",
				catches: "a failed read treated as absent",
				observation: observe({ kind: "unreachable", reason: `down ${ROOT}` } as unknown as ClaimSnapshot),
			},
			{
				label: "corrupt read",
				catches: "a corrupt read treated as absent",
				observation: observe({ kind: "corrupt", reason: "bad" } as unknown as ClaimSnapshot),
			},
			{
				label: "non-canonical ticket",
				catches: "ticket normalization",
				observation: observe(presentSnapshot(ROOT, "back-1")),
			},
			{
				label: "non-canonical ticket on absent",
				catches: "ticket normalization",
				observation: observe({ kind: "absent", ticket: "back-1" }),
			},
			{ label: "root xyz", catches: "an unchecked root", observation: observe(presentSnapshot("xyz")) },
			{
				label: "root of 39 hex digits",
				catches: "a truncated root compared",
				observation: observe(presentSnapshot(ROOT.slice(0, 39))),
			},
			{
				label: "uppercase root",
				catches: "case-folded roots",
				observation: observe(presentSnapshot(ROOT.toUpperCase())),
			},
			{
				label: "descriptor schema 2",
				catches: "an unsupported descriptor",
				observation: observe(undefined, { descriptor: { ...BLOB, schema: 2 } as unknown as ClaimStorageDescriptor }),
			},
			{
				label: "descriptor format zip",
				catches: "an unknown format",
				observation: observe(undefined, {
					descriptor: { ...BLOB, format: "zip" } as unknown as ClaimStorageDescriptor,
				}),
			},
			{
				label: "descriptor epoch 0",
				catches: "a non-positive epoch",
				observation: observe(undefined, { descriptor: { ...BLOB, epoch: 0 } }),
			},
			{ label: "empty remote", catches: "a missing endpoint", observation: observe(undefined, { remote: "" }) },
			{
				label: "numeric remote",
				catches: "a coerced endpoint",
				observation: observe(undefined, { remote: 9418 as unknown as string }),
			},
		];
		const journals: { label: string; journal: ClaimIntentEnumerationResult }[] = [
			{ label: "matching journal", journal: enumerated([matching]) },
			{ label: "corrupt journal", journal: enumerated([], 1) },
			{ label: "unavailable journal", journal: { kind: "unavailable", reason: "journal down" } },
		];
		for (const row of rows) {
			for (const { label, journal } of journals) {
				const expected = failed(`${row.label} with a ${label} (catches: ${row.catches})`, "invalid");
				expectVerdict(pauseOf(journal, row.observation), expected, ["op-match"]);
			}
		}
	});

	test("pau-08: is pure: frozen inputs, fresh result arrays and no ambient clock", () => {
		const journal = deepFreeze(enumerated([recordOf(intentOf("op-b")), recordOf(intentOf("op-a", "release"))]));
		const observation = deepFreeze(observe());
		const before = canonicalJson({ journal, observation });
		const results: ClaimOperationPause[] = [];
		const wallClock = spyOn(Date, "now").mockImplementation(() => {
			throw new Error("hidden wall clock");
		});
		const monotonicClock = spyOn(performance, "now").mockImplementation(() => {
			throw new Error("hidden monotonic clock");
		});
		try {
			results.push(pauseOf(journal, observation), pauseOf(journal, observation));
		} finally {
			wallClock.mockRestore();
			monotonicClock.mockRestore();
		}
		const [first, second] = results;
		expectVerdict(first, outstanding("first call", ["op-a", "op-b"]));
		expectVerdict(second, outstanding("second call", ["op-a", "op-b"]));
		const firstIds = field(first, "operationIds");
		expect({ fresh: firstIds !== field(second, "operationIds") }).toEqual({ fresh: true });
		try {
			if (Array.isArray(firstIds)) firstIds.push("op-mutated");
		} catch {
			// A frozen result array is just as unaliased.
		}
		expectVerdict(pauseOf(journal, observation), outstanding("after mutating a result", ["op-a", "op-b"]));
		expect(canonicalJson({ journal, observation })).toBe(before);
	});

	test("pau-09: gives every verdict exact keys and fixed reasons that echo no endpoint, root or ID", () => {
		const ids = ["op-sentinel-first", "op-sentinel-second"];
		const first = recordOf(intentOf("op-sentinel-first"));
		const second = recordOf(intentOf("op-sentinel-second", "release"));
		// Positive control and the verdict without a reason.
		expectVerdict(pauseOf(enumerated([first]), observe()), outstanding("outstanding", ["op-sentinel-first"]), ids);
		expectVerdict(pauseOf(enumerated([]), observe()), clear("clear"), ids);
		const noisy = (id: string): ClaimIntentEnumerationResult => ({
			kind: "unavailable",
			reason: `${id} ${REMOTE} ${ROOT} ${KARL} ${FRANZ} ${TICKET}`,
		});
		const cases: {
			label: string;
			group: string;
			kind: string;
			journal: ClaimIntentEnumerationResult;
			observation: ClaimOperationPauseObservation;
		}[] = [
			{
				label: "corrupt beside the first ID",
				group: "corrupt",
				kind: "unknown",
				journal: enumerated([first], 1),
				observation: observe(),
			},
			{
				label: "corrupt beside the second ID",
				group: "corrupt",
				kind: "unknown",
				journal: enumerated([second], 1),
				observation: observe(),
			},
			{
				label: "noisy unavailable, first ID",
				group: "unavailable",
				kind: "unknown",
				journal: noisy(ids[0] ?? ""),
				observation: observe(),
			},
			{
				label: "noisy unavailable, second ID",
				group: "unavailable",
				kind: "unknown",
				journal: noisy(ids[1] ?? ""),
				observation: observe(),
			},
			{
				label: "empty remote beside the first ID",
				group: "remote",
				kind: "invalid",
				journal: enumerated([first]),
				observation: observe(undefined, { remote: "" }),
			},
			{
				label: "empty remote beside the second ID",
				group: "remote",
				kind: "invalid",
				journal: enumerated([second]),
				observation: observe(undefined, { remote: "" }),
			},
		];
		const reasons = new Map<string, Set<string>>();
		for (const entry of cases) {
			const result = pauseOf(entry.journal, entry.observation);
			expectVerdict(result, failed(entry.label, entry.kind), ids);
			const group = reasons.get(entry.group) ?? new Set<string>();
			group.add(String(field(result, "reason")));
			reasons.set(entry.group, group);
		}
		// Fixed text: inputs differing only in IDs, endpoints or roots never change a reason.
		expect([...reasons.entries()].map(([group, texts]) => [group, texts.size])).toEqual([
			["corrupt", 1],
			["unavailable", 1],
			["remote", 1],
		]);
	});
});

describe("claim intent admission slot (journal level, no Git)", () => {
	test(
		"adm-01: publishes one private slot with the record's bytes under the key name, idempotently",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const intent = intentOf("op-adm-a");
				const record = await fixture.prepare(journal, intent);
				const recordBefore = await fixture.fileInfo("op-adm-a.json");
				// Positive control (catches: no slot at all).
				expect(await journal.admit(record)).toEqual(ADMITTED);
				const slot = slotName(intent);
				const entries = [slot, "op-adm-a.json"].sort(byCodeUnits);
				const slotInfo = await fixture.fileInfo(slot);
				// ASSUMPTION(pause): the slot is an own inode, so the record keeps nlink 1 (catches: a key missing one
				// of its five fields, a rewritten record, a hard link, a leftover temporary).
				expect({
					entries: await fixture.entries(),
					bytes: await readFile(fixture.path(slot), "utf8"),
					slot: { kind: slotInfo.kind, mode: slotInfo.mode, uid: slotInfo.uid, nlink: slotInfo.nlink },
					ownInode: slotInfo.ino !== recordBefore.ino,
					record: await fixture.fileInfo("op-adm-a.json"),
				}).toEqual({
					entries,
					bytes: recordText(record),
					slot: { kind: "file", mode: 0o600, uid: UID, nlink: 1 },
					ownInode: true,
					record: recordBefore,
				});
				// catches: an admission that is not idempotent, also across a newly opened journal.
				expect(await journal.admit(record)).toEqual(ADMITTED);
				expect(await (await fixture.open()).admit(record)).toEqual(ADMITTED);
				expect({
					entries: await fixture.entries(),
					slot: await fixture.fileInfo(slot),
					record: await fixture.fileInfo("op-adm-a.json"),
				}).toEqual({ entries, slot: slotInfo, record: recordBefore });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"adm-02: holds a second intent of the same key for the admitted one, whatever its action or target",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const first = intentOf("op-adm-a");
				const firstRecord = await fixture.prepare(journal, first);
				// Positive control.
				expect(await journal.admit(firstRecord)).toEqual(ADMITTED);
				// Same key, other ID, action, parameters and target binding (catches: action, parameters or target
				// binding in the key, which would allow two sends against one root).
				const second = intentOf("op-adm-b", "release");
				expect(slotName(second)).toBe(slotName(first));
				const secondRecord = await fixture.prepare(journal, second);
				const before = await fixture.snapshot(false);
				const held: ClaimIntentAdmitResult = { kind: "held", operationId: "op-adm-a" };
				expect(await journal.admit(secondRecord)).toEqual(held);
				expect(await (await fixture.open()).admit(secondRecord)).toEqual(held);
				expect(await journal.admit(firstRecord)).toEqual(ADMITTED);
				expect(await fixture.snapshot(false)).toEqual(before);
				expect(await fixture.entries()).toEqual([slotName(first), "op-adm-a.json", "op-adm-b.json"].sort(byCodeUnits));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"adm-03: gives every key its own slot: ticket, endpoint, format, epoch and root",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const base = intentOf("op-key-base");
				// Positive control.
				expect(await journal.admit(await fixture.prepare(journal, base))).toEqual(ADMITTED);
				const rows: { label: string; catches: string; changes: Partial<ClaimOperationIntent> }[] = [
					{ label: "ticket", catches: "a key without the ticket", changes: { ticket: "BACK-2" } },
					{ label: "endpoint", catches: "a key without the endpoint", changes: { remote: OTHER_REMOTE } },
					{ label: "format", catches: "a key without the format", changes: { format: "tree" } },
					{ label: "epoch", catches: "a key without the epoch", changes: { epoch: 2 } },
					{ label: "root", catches: "a key without the root", changes: { expectedRoot: OTHER_ROOT } },
					{ label: "absent root", catches: "null folded into a root", changes: { expectedRoot: null } },
				];
				const names = [slotName(base), "op-key-base.json"];
				for (const [index, row] of rows.entries()) {
					const intent = intentOf(`op-key-${index + 1}`, "renew", row.changes);
					const label = `${row.label} (catches: ${row.catches})`;
					const result = await journal.admit(await fixture.prepare(journal, intent));
					expect({ label, result }).toEqual({ label, result: ADMITTED });
					const bytes = await readFile(fixture.path(slotName(intent)), "utf8");
					expect({ label, bytes }).toEqual({ label, bytes: recordText(recordOf(intent)) });
					names.push(slotName(intent), `${intent.operationId}.json`);
				}
				expect(new Set(names).size).toBe(names.length);
				expect(await fixture.entries()).toEqual(names.sort(byCodeUnits));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"adm-04: never replaces, falls back or admits what the journal does not hold byte for byte",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				// Positive control.
				expect(await journal.admit(await fixture.prepare(journal, intentOf("op-adm-control")))).toEqual(ADMITTED);
				const ids = ["op-adm-control"];
				const keyed = (operationId: string, ticket: string): ClaimOperationIntent => {
					ids.push(operationId);
					return intentOf(operationId, "renew", { ticket });
				};

				// Record-first: the argument must be the journal's own published record.
				const unpublished = keyed("op-adm-unpublished", "BACK-11");
				const digestless = keyed("op-adm-digest", "BACK-12");
				await fixture.prepare(journal, digestless);
				const deviating = keyed("op-adm-deviating", "BACK-13");
				await fixture.prepare(journal, deviating);
				const deviated = { ...deviating, parameters: { action: "renew", ttlMs: 2 * TTL, ttlSource: "explicit" } };
				const arguments_: { label: string; catches: string; record: ClaimIntentRecord; kind: string }[] = [
					{
						label: "never published record",
						catches: "a slot without a published record",
						record: recordOf(unpublished),
						kind: "invalid",
					},
					{
						label: "record object with a wrong digest",
						catches: "an unchecked argument",
						record: { ...recordOf(digestless), digest: "0".repeat(64) },
						kind: "invalid",
					},
					{
						label: "record file with other content",
						catches: "the argument trusted over the record file",
						record: recordOf(deviated),
						kind: "corrupt",
					},
				];
				for (const row of arguments_) {
					const before = await fixture.snapshot(false);
					expectVerdict(
						await journal.admit(row.record),
						failed(`${row.label} (catches: ${row.catches})`, row.kind),
						ids,
					);
					expect({ label: row.label, unchanged: await fixture.snapshot(false) }).toEqual({
						label: row.label,
						unchanged: before,
					});
				}

				// A pre-existing entry under the slot name is never replaced, followed or accepted.
				const occupied: {
					label: string;
					catches: string;
					occupy: (path: string, own: ClaimOperationIntent) => Promise<void>;
				}[] = [
					{
						label: "garbage in the slot",
						catches: "a foreign slot overwritten",
						occupy: (path) => writePrivate(path, "{not a record"),
					},
					{
						label: "symlink to the own record",
						catches: "a symlinked slot followed",
						occupy: (path, own) => symlink(fixture.path(`${own.operationId}.json`), path),
					},
					{
						label: "0644 copy of the own record",
						catches: "a slot readable by others accepted",
						occupy: (path, own) => writePrivate(path, recordText(recordOf(own)), 0o644),
					},
					{
						label: "record of another key",
						catches: "a slot trusted without its key hash",
						occupy: (path) =>
							writePrivate(path, recordText(recordOf(intentOf("op-adm-foreign", "renew", { ticket: "BACK-99" })))),
					},
					{ label: "directory", catches: "a directory slot skipped or removed", occupy: (path) => mkdirPrivate(path) },
				];
				for (const [index, row] of occupied.entries()) {
					const own = keyed(`op-adm-occupied-${index + 1}`, `BACK-${index + 14}`);
					const record = await fixture.prepare(journal, own);
					await row.occupy(fixture.path(slotName(own)), own);
					const before = await fixture.snapshot(false);
					expectVerdict(await journal.admit(record), failed(`${row.label} (catches: ${row.catches})`, "corrupt"), ids);
					expect({ label: row.label, unchanged: await fixture.snapshot(false) }).toEqual({
						label: row.label,
						unchanged: before,
					});
				}

				// A failed link ends unavailable and leaves no slot: no rename, no O_EXCL write to the slot name.
				const faults: { label: string; catches: string; code: string; recovers: boolean }[] = [
					{
						label: "slot link EIO, then healthy",
						catches: "a fallback write, or an admission lost for good",
						code: "EIO",
						recovers: true,
					},
					{
						label: "slot link EPERM",
						catches: "a copy fallback where hard links are refused",
						code: "EPERM",
						recovers: false,
					},
				];
				for (const [index, row] of faults.entries()) {
					const own = keyed(`op-adm-link-${index + 1}`, `BACK-${index + 20}`);
					const record = await fixture.prepare(journal, own);
					const events: PauseEvent[] = [];
					const failing = await fixture.open(
						pauseIO({
							directory: fixture.directory,
							events,
							faults: [{ op: "link", target: "slot", code: row.code, times: 1 }],
						}),
					);
					const label = `${row.label} (catches: ${row.catches})`;
					expectVerdict(await failing.admit(record), failed(label, "unavailable"), ids);
					expect({
						label,
						linkTried: events.some((event) => event.op === "link" && event.target === "slot"),
						slotWrites: events.filter(
							(event) => event.target === "slot" && ["open-write", "write", "unlink"].includes(event.op),
						).length,
						slot: await exists(fixture.path(slotName(own))),
					}).toEqual({ label, linkTried: true, slotWrites: 0, slot: false });
					if (row.recovers) {
						expect({ label, retried: await journal.admit(record) }).toEqual({ label, retried: ADMITTED });
						const bytes = await readFile(fixture.path(slotName(own)), "utf8");
						expect({ label, bytes }).toEqual({ label, bytes: recordText(record) });
					}
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"adm-05: admits exactly one of two processes linking the same slot, in either order",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				// Positive control in-process, before any child starts.
				expect(await journal.admit(await fixture.prepare(journal, intentOf("op-race-control")))).toEqual(ADMITTED);
				// ASSUMPTION(pause): publish-then-admit; the no-replace link decides (catches: check-then-create).
				const orders: { label: string; ticket: string; first: "a" | "b" }[] = [
					{ label: "A released first", ticket: "BACK-2", first: "a" },
					{ label: "B released first", ticket: "BACK-3", first: "b" },
				];
				for (const order of orders) {
					const intents = {
						a: intentOf(`op-race-a-${order.ticket}`, "renew", { ticket: order.ticket }),
						b: intentOf(`op-race-b-${order.ticket}`, "release", { ticket: order.ticket }),
					};
					const gates = { a: await fixture.gate("slot-link"), b: await fixture.gate("slot-link") };
					const children = {
						a: await fixture.startJournalChild(intents.a, [gates.a]),
						b: await fixture.startJournalChild(intents.b, [gates.b]),
					};
					const label = order.label;
					expect({ label, a: await children.a.reached(gates.a), b: await children.b.reached(gates.b) }).toEqual({
						label,
						a: true,
						b: true,
					});
					const second = order.first === "a" ? "b" : "a";
					await releaseGate(gates[order.first]);
					const winner = await children[order.first].output<JournalOutput>();
					await releaseGate(gates[second]);
					const loser = await children[second].output<JournalOutput>();
					const expectedWinner: JournalOutput = { prepared: "prepared", admitted: ADMITTED };
					const expectedLoser: JournalOutput = {
						prepared: "prepared",
						admitted: { kind: "held", operationId: intents[order.first].operationId },
					};
					expect({ label, winner, loser }).toEqual({ label, winner: expectedWinner, loser: expectedLoser });
					const bytes = await readFile(fixture.path(slotName(intents.a)), "utf8");
					expect({ label, bytes }).toEqual({ label, bytes: recordText(recordOf(intents[order.first])) });
					await children.a.shutdown();
					await children.b.shutdown();
				}

				// A small concurrent sample behind a barrier: exactly one admitted, one held, one slot.
				for (const round of [1, 2]) {
					const ticket = `BACK-${round + 3}`;
					const a = intentOf(`op-sample-a-${round}`, "renew", { ticket });
					const b = intentOf(`op-sample-b-${round}`, "release", { ticket });
					const barrier = await fixture.barrier();
					const children = [
						await fixture.startJournalChild(a, [], barrier),
						await fixture.startJournalChild(b, [], barrier),
					];
					await openBarrier(barrier, 2);
					const outputs = await Promise.all(children.map((child) => child.output<JournalOutput>()));
					const kinds = outputs.map((output) => String(textOf(field(output.admitted, "kind"))));
					const winner = kinds[0] === "admitted" ? a : b;
					const heldBy = outputs
						.map((output) => field(output.admitted, "operationId"))
						.filter((id) => id !== undefined);
					const slots = (await fixture.entries()).filter((name) => name === slotName(a));
					expect({
						round,
						prepared: outputs.map((output) => output.prepared),
						kinds: [...kinds].sort(byCodeUnits),
						heldBy,
						slots: slots.length,
						bytes: await readFile(fixture.path(slotName(a)), "utf8"),
					}).toEqual({
						round,
						prepared: ["prepared", "prepared"],
						kinds: ["admitted", "held"],
						heldBy: [winner.operationId],
						slots: 1,
						bytes: recordText(recordOf(winner)),
					});
					for (const child of children) await child.shutdown();
				}
			});
		},
		LONG_TEST_TIMEOUT,
	);

	test(
		"adm-06: leaves a killed admission recoverable exactly once, without time, cleanup or a half slot",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const control = await fixture.prepare(journal, intentOf("op-kill-control"));
				// Positive control in-process.
				expect(await journal.admit(control)).toEqual(ADMITTED);
				const known = [control];
				const rows: { label: string; catches: string; step: PauseStep; slot: boolean }[] = [
					{
						label: "G2 after the record link",
						catches: "an intent without slot lost for good",
						step: "after-record-link",
						slot: false,
					},
					{
						label: "G2′ before the slot link",
						catches: "a half slot, or a slot temporary that blocks",
						step: "slot-link",
						slot: false,
					},
					{
						label: "G3 after the slot link",
						catches: "an admission that is not idempotent after a crash",
						step: "after-slot-link",
						slot: true,
					},
				];
				for (const [index, row] of rows.entries()) {
					const ticket = `BACK-${index + 2}`;
					const crashed = intentOf(`op-killed-${index + 1}`, "renew", { ticket });
					const gate = await fixture.gate(row.step);
					const child = await fixture.startJournalChild(crashed, [gate]);
					expect({ label: row.label, reached: await child.reached(gate) }).toEqual({ label: row.label, reached: true });
					const exit = await child.killProbe();
					expect({ label: row.label, code: exit.code, signal: exit.signal }).toEqual({
						label: row.label,
						code: null,
						signal: "SIGKILL",
					});
					const record = recordOf(crashed);
					known.push(record);
					const temporaries = await fixture.temporaries();
					expect({
						label: row.label,
						record: await readFile(fixture.path(`${crashed.operationId}.json`), "utf8"),
						slot: await exists(fixture.path(slotName(crashed))),
						listed: await journal.enumerate(),
					}).toEqual({
						label: row.label,
						record: recordText(record),
						slot: row.slot,
						listed: enumerated(sortedRecords(known)),
					});
					const label = `${row.label} (catches: ${row.catches})`;
					expect({ label, admitted: await journal.admit(record) }).toEqual({ label, admitted: ADMITTED });
					const rival = intentOf(`op-rival-${index + 1}`, "release", { ticket });
					const rivalRecord = await fixture.prepare(journal, rival);
					known.push(rivalRecord);
					expect({
						label,
						rival: await journal.admit(rivalRecord),
						slot: await readFile(fixture.path(slotName(crashed)), "utf8"),
						temporaries: await fixture.temporaries(),
					}).toEqual({
						label,
						rival: { kind: "held", operationId: crashed.operationId },
						slot: recordText(record),
						temporaries,
					});
					await child.shutdown();
				}
			});
		},
		LONG_TEST_TIMEOUT,
	);
});
