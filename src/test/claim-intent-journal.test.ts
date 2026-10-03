/**
 * Behavioural contract for the private pre-dispatch operation intent journal: real files in
 * a private directory, separate Bun processes with barriers and SIGKILL gates, and the injected IO seam
 * for exact failure points. Process kills and call order do not establish power-loss durability.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClaimIntentJournal,
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import {
	gatedIO,
	type IoEvent,
	type IoGate,
	type IoStep,
	type JournalIO,
	type ProbeCommand,
	type ProbeOutput,
} from "./fixtures/claim-intent-journal-probe.ts";

const TEST_TIMEOUT = 15_000;
/** How long the test waits for a child to reach a gate, and how long a child waits to be released. */
const GATE_TIMEOUT = 5_000;
const CHILD_GATE_TIMEOUT = 8_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const PROBE = fileURLToPath(new URL("./fixtures/claim-intent-journal-probe.ts", import.meta.url));
const OP = "op-claim-1";

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Contract canonical JSON: object keys recursively sorted by code units, array order preserved. */
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

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reference record: lowercase hex SHA-256 over the canonical JSON without trailing newline. */
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

function intentOf(operationId = OP, changes: Partial<ClaimOperationIntent> = {}): ClaimOperationIntent {
	return {
		operationId,
		remote: "git://127.0.0.1:9/claims.git",
		format: "blob",
		epoch: 1,
		ticket: "BACK-1",
		expectedRoot: null,
		targetBinding: "binding-a",
		action: "claim",
		parameters: { holder: "agent-a", ttlSeconds: 600, tags: ["x", "y"] },
		resolved: { hardEnd: "2026-09-24T14:00:00Z", leaseEnd: "2026-09-24T13:10:00Z" },
		...changes,
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

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(value)}`);
	return value as Extract<T, { kind: K }>;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function streamText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream).text();
}

function trace(events: IoEvent[]): string[] {
	return events.map((event) => `${event.op}:${event.target}`);
}

type Child = ReturnType<typeof Bun.spawn>;
type Probe = { child: Child; output: Promise<ProbeOutput> };

class JournalCase {
	readonly root: string;
	readonly directory: string;
	private readonly children = new Set<Child>();
	private sequence = 0;

	private constructor(root: string, directory: string) {
		this.root = root;
		this.directory = directory;
	}

	static async create(): Promise<JournalCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-journal-"));
		const directory = join(root, "journal");
		await mkdir(directory);
		await chmod(directory, 0o700);
		return new JournalCase(root, directory);
	}

	finalPath(operationId = OP): string {
		return join(this.directory, `${operationId}.json`);
	}

	async open(io?: JournalIO): Promise<ClaimIntentJournal> {
		return expectKind(await openClaimIntentJournal({ directory: this.directory, io }), "open").journal;
	}

	recordingIO(events: IoEvent[], operationId = OP): JournalIO {
		return gatedIO({ directory: this.directory, operationId, events });
	}

	failingIO(fail: IoStep, operationId = OP): JournalIO {
		return gatedIO({ directory: this.directory, operationId, fail });
	}

	/**
	 * Runs `action` on a journal whose directory is renamed to `<root>/moved` after the directory check and
	 * open, immediately before the first `lstat` of the record path; restores the directory afterwards.
	 */
	async withDirectoryMoved<T>(
		operationId: string,
		action: (journal: ClaimIntentJournal) => Promise<T>,
	): Promise<{ result: T; movedEntries: string[]; originalExists: boolean }> {
		const moved = join(this.root, "moved");
		let renamed = false;
		const onFinalLstat = async () => {
			await rename(this.directory, moved);
			renamed = true;
		};
		const journal = await this.open(gatedIO({ directory: this.directory, operationId, onFinalLstat }));
		try {
			const result = await action(journal);
			if (!renamed) throw new Error("the journal never reached the record lstat");
			return {
				result,
				movedEntries: (await readdir(moved)).sort(byCodeUnits),
				originalExists: await exists(this.directory),
			};
		} finally {
			if (await exists(moved)) await rename(moved, this.directory);
		}
	}

	async entries(): Promise<string[]> {
		return (await readdir(this.directory)).sort(byCodeUnits);
	}

	async fileText(operationId = OP): Promise<string> {
		return readFile(this.finalPath(operationId), "utf8");
	}

	async fileInfo(operationId = OP) {
		const info = await lstat(this.finalPath(operationId));
		return {
			regular: info.isFile(),
			mode: info.mode & 0o777,
			uid: info.uid,
			ino: info.ino,
			nlink: info.nlink,
			size: info.size,
			mtimeMs: info.mtimeMs,
		};
	}

	/** Places raw bytes at the final path as a private regular file, bypassing the journal. */
	async writeRecordFile(text: string, operationId = OP): Promise<void> {
		await writeFile(this.finalPath(operationId), text, { mode: 0o600 });
		await chmod(this.finalPath(operationId), 0o600);
	}

	spawn(command: Omit<ProbeCommand, "directory">): Probe {
		const argument = JSON.stringify({ ...command, directory: this.directory });
		const child = Bun.spawn([process.execPath, PROBE, argument], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
				const output = await probe.output.catch((error: unknown) => String(error));
				throw new Error(`probe ended before gate ${gate.step}: ${JSON.stringify(output)}`);
			}
			if (Date.now() >= deadline) throw new Error(`probe did not reach gate ${gate.step}`);
			await Bun.sleep(10);
		}
	}

	async release(gate: IoGate): Promise<void> {
		await writeFile(join(gate.dir, "release"), "");
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
		await chmod(this.directory, 0o700).catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withJournal(body: (fixture: JournalCase) => Promise<void>): Promise<void> {
	const fixture = await JournalCase.create();
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("claim intent journal directory", () => {
	test(
		"opens only an existing absolute non-symlink directory of the current user with mode 0700",
		async () => {
			await withJournal(async (fixture) => {
				expect((await openClaimIntentJournal({ directory: fixture.directory })).kind).toBe("open");
				const file = join(fixture.root, "plain-file");
				await writeFile(file, "x");
				const link = join(fixture.root, "journal-link");
				await symlink(fixture.directory, link);
				const paths: Record<string, string> = {
					relative: "journal",
					missing: join(fixture.root, "missing"),
					"regular file": file,
					symlink: link,
				};
				for (const [label, directory] of Object.entries(paths)) {
					const opened = await openClaimIntentJournal({ directory });
					expect({ label, kind: opened.kind }).toEqual({ label, kind: "invalid" });
				}
				for (const mode of [0o755, 0o750, 0o711, 0o770, 0o500]) {
					await chmod(fixture.directory, mode);
					const opened = await openClaimIntentJournal({ directory: fixture.directory });
					expect({ mode: mode.toString(8), kind: opened.kind }).toEqual({ mode: mode.toString(8), kind: "invalid" });
				}
				await chmod(fixture.directory, 0o700);
				expect(await fixture.entries()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rechecks the directory on every operation and writes nothing while it is unsafe",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				await chmod(fixture.directory, 0o755);
				expect((await journal.prepare(intentOf())).kind).toBe("invalid");
				expect((await journal.load(OP)).kind).toBe("invalid");
				await chmod(fixture.directory, 0o700);
				expect(await fixture.entries()).toEqual([]);
				expect(await journal.prepare(intentOf())).toEqual({ kind: "prepared", record: recordOf(intentOf()) });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports invalid, not absent, when the journal directory disappears before load reaches the record",
		async () => {
			await withJournal(async (fixture) => {
				const expected = recordOf(intentOf());
				expect(await (await fixture.open()).prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				const bytes = await fixture.fileText();

				const moved = await fixture.withDirectoryMoved(OP, (journal) => journal.load(OP));
				expect(moved.result).toMatchObject({ kind: "invalid" });
				expect(moved.movedEntries).toEqual([`${OP}.json`]);
				expect(moved.originalExists).toBe(false);

				const healthy = await fixture.open();
				expect(await healthy.load(OP)).toEqual({ kind: "loaded", record: expected });
				expect(await healthy.prepare(intentOf())).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText()).toBe(bytes);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports invalid and publishes nothing when the journal directory disappears before prepare reaches the record",
		async () => {
			await withJournal(async (fixture) => {
				const expected = recordOf(intentOf());
				expect(await (await fixture.open()).prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				const bytes = await fixture.fileText();

				const fresh = "op-after-move";
				const moved = await fixture.withDirectoryMoved(fresh, (journal) => journal.prepare(intentOf(fresh)));
				expect(moved.result).toMatchObject({ kind: "invalid" });
				expect(moved.movedEntries).toEqual([`${OP}.json`]);
				expect(moved.originalExists).toBe(false);

				const healthy = await fixture.open();
				expect(await healthy.load(fresh)).toEqual({ kind: "absent" });
				expect(await healthy.load(OP)).toEqual({ kind: "loaded", record: expected });
				expect(await healthy.prepare(intentOf())).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText()).toBe(bytes);
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim intent journal publication", () => {
	test(
		"prepares a new intent as one canonical private record without leftovers and loads it back",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const expected = recordOf(intentOf());
				expect(await journal.prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
				expect(await fixture.fileText()).toBe(recordText(expected));
				expect(await fixture.fileInfo()).toMatchObject({ regular: true, mode: 0o600, uid: process.getuid?.() });
				expect(await journal.load(OP)).toEqual({ kind: "loaded", record: expected });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"writes and syncs the temporary file, links, unlinks it and syncs the directory before prepared",
		async () => {
			await withJournal(async (fixture) => {
				const events: IoEvent[] = [];
				const journal = await fixture.open(fixture.recordingIO(events));
				expect(await journal.prepare(intentOf())).toMatchObject({ kind: "prepared" });
				const calls = trace(events);
				const lastWrite = calls.lastIndexOf("write:temp");
				const fileSync = calls.indexOf("sync:temp");
				const linked = calls.indexOf("link:final");
				const unlinked = calls.indexOf("unlink:temp");
				const dirSync = calls.lastIndexOf("sync:dir");
				const ordered =
					lastWrite >= 0 && lastWrite < fileSync && fileSync < linked && linked < unlinked && unlinked < dirSync;
				expect({ calls, ordered }).toMatchObject({ ordered: true });
				const afterDirSync = calls.slice(dirSync + 1).filter((call) => /^(write|link|sync):/.test(call));
				expect(afterDirSync).toEqual([]);
				expect(calls.filter((call) => call === "write:final" || call === "unlink:final")).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reopens the journal in another process and loads identical bytes",
		async () => {
			await withJournal(async (fixture) => {
				const expected = recordOf(intentOf());
				const writer = fixture.spawn({ operation: "prepare", operationId: OP, intent: intentOf() });
				expect(await writer.output).toEqual({ kind: "prepared", record: expected });
				const reader = fixture.spawn({ operation: "load", operationId: OP });
				expect(await reader.output).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText()).toBe(recordText(expected));
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"creates the record with mode 0600 even under a permissive umask",
		async () => {
			await withJournal(async (fixture) => {
				const writer = fixture.spawn({ operation: "prepare", operationId: OP, intent: intentOf(), umask: 0 });
				expect(await writer.output).toMatchObject({ kind: "prepared" });
				expect(await fixture.fileInfo()).toMatchObject({ regular: true, mode: 0o600 });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"loads the same canonical intent with reordered keys from any process without touching the record",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const expected = recordOf(intentOf());
				expect(await journal.prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				const before = await fixture.fileInfo();
				const bytes = await fixture.fileText();

				expect(await journal.prepare(reordered(intentOf()) as ClaimOperationIntent)).toEqual({
					kind: "loaded",
					record: expected,
				});
				expect(await (await fixture.open()).prepare(structuredClone(intentOf()))).toEqual({
					kind: "loaded",
					record: expected,
				});
				const other = fixture.spawn({ operation: "prepare", operationId: OP, intent: intentOf() });
				expect(await other.output).toEqual({ kind: "loaded", record: expected });

				expect(await fixture.fileInfo()).toEqual(before);
				expect(await fixture.fileText()).toBe(bytes);
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports conflict for a changed value in each bound field and keeps the original record",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const expected = recordOf(intentOf());
				expect(await journal.prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				const bytes = await fixture.fileText();
				const changes: Record<string, Partial<ClaimOperationIntent>> = {
					remote: { remote: "git://127.0.0.1:9/other.git" },
					format: { format: "tree" },
					epoch: { epoch: 2 },
					ticket: { ticket: "BACK-2" },
					expectedRoot: { expectedRoot: "a".repeat(40) },
					targetBinding: { targetBinding: "binding-b" },
					action: { action: "renew" },
					parameters: { parameters: { holder: "agent-a", ttlSeconds: 601, tags: ["x", "y"] } },
					"parameter array order": { parameters: { holder: "agent-a", ttlSeconds: 600, tags: ["y", "x"] } },
					resolved: { resolved: { hardEnd: "2026-09-24T14:00:01Z", leaseEnd: "2026-09-24T13:10:00Z" } },
				};
				for (const [label, change] of Object.entries(changes)) {
					const result = await journal.prepare(intentOf(OP, change));
					expect({ label, kind: result.kind }).toEqual({ label, kind: "conflict" });
				}
				expect(await fixture.fileText()).toBe(bytes);
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
				expect(await journal.load(OP)).toEqual({ kind: "loaded", record: expected });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"freezes the input when prepare is called, so later mutation cannot change the persisted intent",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const intent = intentOf();
				const expected = recordOf(intentOf());
				const pending = journal.prepare(intent);
				intent.targetBinding = "mutated-during-call";
				intent.parameters.holder = "mutated-during-call";
				expect(await pending).toEqual({ kind: "prepared", record: expected });
				intent.resolved.hardEnd = "mutated-after-call";
				expect(await journal.load(OP)).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText()).toBe(recordText(expected));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports absent for a valid unknown operation ID without creating anything",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				expect(await journal.load("op-unknown")).toEqual({ kind: "absent" });
				expect(await fixture.entries()).toEqual([]);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim intent journal input validation", () => {
	test(
		"accepts only operation IDs of the agreed alphabet and length for prepare and load",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const invalid = ["", "-op", "_op", "op.1", "op/1", "..", "op 1", "öp", "op\n", "a".repeat(129)];
				for (const operationId of invalid) {
					const prepared = await journal.prepare(intentOf(operationId));
					const loaded = await journal.load(operationId);
					expect({ operationId, prepared: prepared.kind, loaded: loaded.kind }).toEqual({
						operationId,
						prepared: "invalid",
						loaded: "invalid",
					});
				}
				expect(await fixture.entries()).toEqual([]);
				for (const operationId of ["a", "Z9", "0", "op_1-x", "a".repeat(128)]) {
					expect(await journal.prepare(intentOf(operationId))).toEqual({
						kind: "prepared",
						record: recordOf(intentOf(operationId)),
					});
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rejects intents with missing, unknown or non-JSON fields and invalid bound values",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const base = intentOf();
				const withoutAction = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "action"));
				const cycle: Record<string, unknown> = { holder: "agent-a" };
				cycle.self = cycle;
				const invalid: Record<string, unknown> = {
					"not an object": null,
					array: [base],
					"missing field": withoutAction,
					"unknown field": { ...base, extra: 1 },
					"numeric operation ID": { ...base, operationId: 1 },
					"epoch 0": { ...base, epoch: 0 },
					"negative epoch": { ...base, epoch: -1 },
					"fractional epoch": { ...base, epoch: 1.5 },
					"string epoch": { ...base, epoch: "1" },
					"unsafe epoch": { ...base, epoch: Number.MAX_SAFE_INTEGER + 1 },
					"unknown format": { ...base, format: "Blob" },
					"lowercase ticket": { ...base, ticket: "back-1" },
					"padded ticket": { ...base, ticket: "BACK-01" },
					"uppercase root": { ...base, expectedRoot: "A".repeat(40) },
					"short root": { ...base, expectedRoot: "a".repeat(39) },
					"41-character root": { ...base, expectedRoot: "a".repeat(41) },
					"empty root": { ...base, expectedRoot: "" },
					"non-hex root": { ...base, expectedRoot: "g".repeat(40) },
					"empty target binding": { ...base, targetBinding: "" },
					"invalid action": { ...base, action: "re.new" },
					"empty action": { ...base, action: "" },
					"array parameters": { ...base, parameters: [] },
					"null parameters": { ...base, parameters: null },
					"NaN parameter": { ...base, parameters: { value: Number.NaN } },
					"undefined parameter": { ...base, parameters: { value: undefined } },
					"function parameter": { ...base, parameters: { value: () => 1 } },
					"bigint parameter": { ...base, parameters: { value: BigInt(1) } },
					"cyclic parameters": { ...base, parameters: cycle },
					"array resolved": { ...base, resolved: [] },
					"infinite resolved": { ...base, resolved: { hardEnd: Number.POSITIVE_INFINITY } },
					"empty remote": { ...base, remote: "" },
					"remote name": { ...base, remote: "origin" },
					"option remote": { ...base, remote: "--upload-pack=true" },
				};
				for (const [label, value] of Object.entries(invalid)) {
					const result = await journal.prepare(value as ClaimOperationIntent);
					expect({ label, kind: result.kind }).toEqual({ label, kind: "invalid" });
				}
				expect(await fixture.entries()).toEqual([]);

				const valid: Record<string, ClaimOperationIntent> = {
					"64-character root": intentOf("op-root-64", { expectedRoot: "a".repeat(64) }),
					"40-character root": intentOf("op-root-40", { expectedRoot: "0123456789abcdef".repeat(2).padEnd(40, "0") }),
					"largest safe epoch": intentOf("op-epoch", { epoch: Number.MAX_SAFE_INTEGER }),
					"dotted ticket": intentOf("op-ticket", { ticket: "BACK-7.2" }),
					"commit-chain format": intentOf("op-format", { format: "commit-chain" }),
					"empty objects": intentOf("op-empty", { parameters: {}, resolved: {} }),
				};
				for (const [label, intent] of Object.entries(valid)) {
					const result = await journal.prepare(intent);
					expect({ label, result }).toEqual({ label, result: { kind: "prepared", record: recordOf(intent) } });
				}
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim intent journal corruption and unsafe files", () => {
	test(
		"reports malformed, non-canonical or digest-mismatched records as corrupt without rewriting them",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const intent = intentOf();
				const valid = recordOf(intent);
				await fixture.writeRecordFile(recordText(valid));
				expect(await journal.load(OP)).toEqual({ kind: "loaded", record: valid });

				const extraIntent = { ...intent, extra: 1 };
				const corruptions: Record<string, string> = {
					"not JSON": "{\n",
					truncated: recordText(valid).slice(0, -10),
					"missing newline": canonicalJson(valid),
					"non-canonical bytes": `${JSON.stringify(valid, null, 2)}\n`,
					"extra record field": recordText({ ...valid, extra: 1 }),
					"schema 2": recordText({ ...valid, schema: 2 }),
					"extra intent field": recordText({
						...valid,
						intent: extraIntent,
						digest: sha256Hex(canonicalJson(extraIntent)),
					}),
					"parameter digest mismatch": recordText({ ...valid, parameterDigest: sha256Hex("{}") }),
					"digest mismatch": recordText({ ...valid, digest: sha256Hex("{}") }),
					"uppercase digest": recordText({ ...valid, digest: valid.digest.toUpperCase() }),
					"intent changed under the digests": recordText({
						...valid,
						intent: { ...intent, targetBinding: "binding-b" },
					}),
					"operation ID differs from file name": recordText(recordOf(intentOf("op-other"))),
					"invalid intent with matching digests": recordText(recordOf({ ...intent, epoch: 0 })),
				};
				for (const [label, text] of Object.entries(corruptions)) {
					await fixture.writeRecordFile(text);
					const loaded = await journal.load(OP);
					const prepared = await journal.prepare(intentOf());
					expect({ label, loaded: loaded.kind, prepared: prepared.kind }).toEqual({
						label,
						loaded: "corrupt",
						prepared: "corrupt",
					});
					expect({ label, text: await fixture.fileText() }).toEqual({ label, text });
				}
				expect(await journal.prepare(intentOf("op-unaffected"))).toEqual({
					kind: "prepared",
					record: recordOf(intentOf("op-unaffected")),
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports symlinks, directories, FIFOs and other permissions at the final path as corrupt without following",
		async () => {
			await withJournal(async (fixture) => {
				const journal = await fixture.open();
				const text = recordText(recordOf(intentOf()));
				const final = fixture.finalPath();
				const expectCorrupt = async (label: string) => {
					const loaded = await journal.load(OP);
					const prepared = await journal.prepare(intentOf());
					expect({ label, loaded: loaded.kind, prepared: prepared.kind }).toEqual({
						label,
						loaded: "corrupt",
						prepared: "corrupt",
					});
				};

				const outside = join(fixture.root, "outside.json");
				await writeFile(outside, text, { mode: 0o600 });
				await chmod(outside, 0o600);
				await symlink(outside, final);
				await expectCorrupt("symlink");
				expect((await lstat(final)).isSymbolicLink()).toBe(true);
				expect(await readFile(outside, "utf8")).toBe(text);
				await rm(final);

				await mkdir(final);
				await chmod(final, 0o700);
				await expectCorrupt("directory");
				expect((await lstat(final)).isDirectory()).toBe(true);
				await rm(final, { recursive: true });

				const fifo = Bun.spawn(["mkfifo", "-m", "600", final], { stdout: "ignore", stderr: "pipe" });
				if ((await fifo.exited) !== 0) throw new Error(`mkfifo failed: ${await streamText(fifo.stderr)}`);
				await expectCorrupt("FIFO");
				expect((await lstat(final)).isFIFO()).toBe(true);
				await rm(final);

				await fixture.writeRecordFile(text);
				for (const mode of [0o644, 0o640, 0o400, 0o700]) {
					await chmod(final, mode);
					await expectCorrupt(`mode ${mode.toString(8)}`);
					expect({ mode: mode.toString(8), after: ((await lstat(final)).mode & 0o777).toString(8) }).toEqual({
						mode: mode.toString(8),
						after: mode.toString(8),
					});
				}
				await chmod(final, 0o600);
				expect(await journal.load(OP)).toEqual({ kind: "loaded", record: recordOf(intentOf()) });
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim intent journal injected IO failures", () => {
	test(
		"fails closed on write, file-sync and link failures before publication and recovers with healthy IO",
		async () => {
			await withJournal(async (fixture) => {
				const published: string[] = [];
				for (const step of ["temp-write", "temp-sync", "link"] as const) {
					const operationId = `op-fail-${step}`;
					const failing = await fixture.open(fixture.failingIO(step, operationId));
					const result = await failing.prepare(intentOf(operationId));
					expect({ step, kind: result.kind }).toEqual({ step, kind: "unavailable" });
					expect({ step, entries: await fixture.entries() }).toEqual({ step, entries: published });

					const healthy = await fixture.open();
					expect(await healthy.prepare(intentOf(operationId))).toEqual({
						kind: "prepared",
						record: recordOf(intentOf(operationId)),
					});
					published.push(`${operationId}.json`);
					published.sort(byCodeUnits);
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports a directory-sync failure after link as unavailable and completes it on the next healthy call",
		async () => {
			await withJournal(async (fixture) => {
				const expected = recordOf(intentOf());
				const failing = await fixture.open(fixture.failingIO("dir-sync"));
				expect((await failing.prepare(intentOf())).kind).toBe("unavailable");
				expect(await fixture.fileText()).toBe(recordText(expected));
				expect(await fixture.entries()).toEqual([`${OP}.json`]);

				const healthy = await fixture.open();
				expect(await healthy.load(OP)).toEqual({ kind: "loaded", record: expected });
				expect(await healthy.prepare(intentOf())).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText()).toBe(recordText(expected));
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports unavailable when unlinking its own temporary name fails after publication, keeping the record",
		async () => {
			await withJournal(async (fixture) => {
				const operationId = "op-unlink-fails";
				const expected = recordOf(intentOf(operationId));
				const failing = await fixture.open(fixture.failingIO("temp-unlink", operationId));
				expect(await failing.prepare(intentOf(operationId))).toMatchObject({ kind: "unavailable" });
				expect(await fixture.fileText(operationId)).toBe(recordText(expected));
				expect(await fixture.fileInfo(operationId)).toMatchObject({ regular: true, mode: 0o600 });
				const leftovers = (await fixture.entries()).filter((name) => name !== `${operationId}.json`);

				const healthy = await fixture.open();
				expect(await healthy.prepare(intentOf(operationId))).toEqual({ kind: "loaded", record: expected });
				expect(await healthy.load(operationId)).toEqual({ kind: "loaded", record: expected });
				expect(await fixture.fileText(operationId)).toBe(recordText(expected));
				const after = await fixture.entries();
				expect({ leftovers, swept: leftovers.filter((name) => !after.includes(name)) }).toEqual({
					leftovers,
					swept: [],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"syncs the record and the directory before loaded, and fails closed when either sync fails",
		async () => {
			await withJournal(async (fixture) => {
				const expected = recordOf(intentOf());
				expect(await (await fixture.open()).prepare(intentOf())).toEqual({ kind: "prepared", record: expected });
				const bytes = await fixture.fileText();

				for (const operation of ["load", "prepare"] as const) {
					const events: IoEvent[] = [];
					const journal = await fixture.open(fixture.recordingIO(events));
					const result = operation === "load" ? await journal.load(OP) : await journal.prepare(intentOf());
					expect({ operation, result }).toEqual({ operation, result: { kind: "loaded", record: expected } });
					const calls = trace(events);
					expect({ operation, fileSync: calls.includes("sync:final"), dirSync: calls.includes("sync:dir") }).toEqual({
						operation,
						fileSync: true,
						dirSync: true,
					});
					expect(calls.filter((call) => call === "write:final" || call === "unlink:final")).toEqual([]);
				}

				for (const step of ["final-sync", "dir-sync"] as const) {
					for (const operation of ["load", "prepare"] as const) {
						const journal = await fixture.open(fixture.failingIO(step));
						const result = operation === "load" ? await journal.load(OP) : await journal.prepare(intentOf());
						expect({ step, operation, kind: result.kind }).toEqual({ step, operation, kind: "unavailable" });
					}
				}
				expect(await fixture.fileText()).toBe(bytes);
				expect(await fixture.entries()).toEqual([`${OP}.json`]);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim intent journal separate processes", () => {
	test(
		"lets the first of two gated publishers prepare and gives the second loaded or conflict",
		async () => {
			await withJournal(async (fixture) => {
				const cases = [
					{ label: "same content", operationId: "op-race-same", second: "loaded" },
					{ label: "different content", operationId: "op-race-different", second: "conflict" },
				] as const;
				for (const { label, operationId, second } of cases) {
					const first = intentOf(operationId);
					const other = second === "loaded" ? intentOf(operationId) : intentOf(operationId, { targetBinding: "b" });
					const gateA = await fixture.gate("link");
					const gateB = await fixture.gate("link");
					const a = fixture.spawn({ operation: "prepare", operationId, intent: first, gate: gateA });
					const b = fixture.spawn({ operation: "prepare", operationId, intent: other, gate: gateB });
					await Promise.all([fixture.reached(a, gateA), fixture.reached(b, gateB)]);

					await fixture.release(gateA);
					expect({ label, a: await a.output }).toEqual({ label, a: { kind: "prepared", record: recordOf(first) } });
					await fixture.release(gateB);
					const expectedB = second === "loaded" ? { kind: "loaded", record: recordOf(first) } : { kind: "conflict" };
					expect({ label, b: await b.output }).toEqual({ label, b: expectedB });
					expect({ label, text: await fixture.fileText(operationId) }).toEqual({
						label,
						text: recordText(recordOf(first)),
					});
				}
				expect(await fixture.entries()).toEqual(["op-race-different.json", "op-race-same.json"]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"admits exactly one publisher per ID in a small concurrent sample and both for different IDs",
		async () => {
			await withJournal(async (fixture) => {
				for (const round of [1, 2]) {
					for (const same of [true, false]) {
						const operationId = `op-sample-${same ? "same" : "different"}-${round}`;
						const first = intentOf(operationId);
						const other = same ? intentOf(operationId) : intentOf(operationId, { targetBinding: "binding-b" });
						const barrier = await fixture.barrier();
						const a = fixture.spawn({ operation: "prepare", operationId, intent: first, barrier });
						const b = fixture.spawn({ operation: "prepare", operationId, intent: other, barrier });
						await fixture.openBarrier(barrier, 2);
						const outputs = await Promise.all([a.output, b.output]);
						const kinds = outputs.map((output) => output.kind).sort(byCodeUnits);
						expect({ operationId, kinds }).toEqual({
							operationId,
							kinds: same ? ["loaded", "prepared"] : ["conflict", "prepared"],
						});
						const winner = outputs[0]?.kind === "prepared" ? first : other;
						expect({ operationId, text: await fixture.fileText(operationId) }).toEqual({
							operationId,
							text: recordText(recordOf(winner)),
						});
					}
				}

				const barrier = await fixture.barrier();
				const left = fixture.spawn({
					operation: "prepare",
					operationId: "op-left",
					intent: intentOf("op-left"),
					barrier,
				});
				const right = fixture.spawn({
					operation: "prepare",
					operationId: "op-right",
					intent: intentOf("op-right"),
					barrier,
				});
				await fixture.openBarrier(barrier, 2);
				expect(await Promise.all([left.output, right.output])).toEqual([
					{ kind: "prepared", record: recordOf(intentOf("op-left")) },
					{ kind: "prepared", record: recordOf(intentOf("op-right")) },
				]);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"leaves nothing loadable after a kill during the temporary write or before link, and sweeps no leftovers",
		async () => {
			await withJournal(async (fixture) => {
				for (const step of ["temp-write", "link"] as const) {
					const operationId = `op-kill-${step}`;
					const before = await fixture.entries();
					const gate = await fixture.gate(step);
					const probe = fixture.spawn({ operation: "prepare", operationId, intent: intentOf(operationId), gate });
					await fixture.reached(probe, gate);
					await fixture.kill(probe);

					const journal = await fixture.open();
					expect({ step, load: await journal.load(operationId) }).toEqual({ step, load: { kind: "absent" } });
					const leftovers = (await fixture.entries()).filter((name) => !before.includes(name));
					expect({ step, final: leftovers.includes(`${operationId}.json`) }).toEqual({ step, final: false });
					expect({ step, leftovers: leftovers.length > 0 }).toEqual({ step, leftovers: true });
					for (const name of leftovers) {
						const info = await lstat(join(fixture.directory, name));
						expect({ step, name, regular: info.isFile(), mode: info.mode & 0o777 }).toEqual({
							step,
							name,
							regular: true,
							mode: 0o600,
						});
					}

					expect(await journal.prepare(intentOf(operationId))).toEqual({
						kind: "prepared",
						record: recordOf(intentOf(operationId)),
					});
					const after = await fixture.entries();
					expect({ step, swept: leftovers.filter((name) => !after.includes(name)) }).toEqual({ step, swept: [] });
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"leaves a complete loadable record after a kill after link, before or after the directory sync",
		async () => {
			await withJournal(async (fixture) => {
				const cases = [
					{ step: "after-link", links: 2 },
					{ step: "after-dir-sync", links: 1 },
				] as const;
				for (const { step, links } of cases) {
					const operationId = `op-kill-${step}`;
					const expected = recordOf(intentOf(operationId));
					const gate = await fixture.gate(step);
					const probe = fixture.spawn({ operation: "prepare", operationId, intent: intentOf(operationId), gate });
					await fixture.reached(probe, gate);
					await fixture.kill(probe);
					expect({ step, info: await fixture.fileInfo(operationId) }).toMatchObject({
						step,
						info: { regular: true, mode: 0o600, nlink: links },
					});

					const events: IoEvent[] = [];
					const journal = await fixture.open(fixture.recordingIO(events, operationId));
					expect({ step, load: await journal.load(operationId) }).toEqual({
						step,
						load: { kind: "loaded", record: expected },
					});
					const calls = trace(events);
					expect({ step, fileSync: calls.includes("sync:final"), dirSync: calls.includes("sync:dir") }).toEqual({
						step,
						fileSync: true,
						dirSync: true,
					});
					expect(await journal.prepare(intentOf(operationId))).toEqual({ kind: "loaded", record: expected });
					const changed = await journal.prepare(intentOf(operationId, { action: "renew" }));
					expect({ step, kind: changed.kind }).toEqual({ step, kind: "conflict" });
					expect(await fixture.fileText(operationId)).toBe(recordText(expected));
				}
			});
		},
		TEST_TIMEOUT,
	);
});
