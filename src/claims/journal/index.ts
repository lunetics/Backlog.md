/** Internal pre-dispatch persistence, never an outcome or ownership proof. */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalTaskId, isValidTaskId } from "../../utils/task-id.ts";
import { canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import type { ClaimStorageFormat } from "../storage/index.ts";

export const claimJournalIO = { open, lstat, link, unlink, readdir };

export type ClaimOperationIntent = {
	operationId: string;
	remote: string;
	format: ClaimStorageFormat;
	epoch: number;
	ticket: string;
	expectedRoot: string | null;
	targetBinding: string | null;
	action: string;
	parameters: JsonObject;
	resolved: JsonObject;
};

export type ClaimIntentRecord = {
	schema: 1;
	intent: ClaimOperationIntent;
	parameterDigest: string;
	digest: string;
};

type ClaimJournalFailure = {
	kind: "invalid" | "corrupt" | "unavailable";
	reason: string;
};

type ClaimIntentLoadResult = { kind: "loaded"; record: ClaimIntentRecord } | { kind: "absent" } | ClaimJournalFailure;

export type ClaimIntentPrepareResult =
	| { kind: "prepared"; record: ClaimIntentRecord }
	| { kind: "loaded"; record: ClaimIntentRecord }
	| { kind: "conflict" }
	| ClaimJournalFailure;

export type ClaimIntentEnumerationResult =
	| { kind: "enumerated"; records: ClaimIntentRecord[]; corrupt: number }
	| { kind: "invalid" | "unavailable"; reason: string };

export type ClaimIntentAdmitResult = { kind: "admitted" } | { kind: "held"; operationId: string } | ClaimJournalFailure;

export interface ClaimIntentJournal {
	prepare(intent: ClaimOperationIntent): Promise<ClaimIntentPrepareResult>;
	load(operationId: string): Promise<ClaimIntentLoadResult>;
	/** Read-only: records sorted by operation ID; temporaries and slots ignored; any other entry counts as corrupt. */
	enumerate(): Promise<ClaimIntentEnumerationResult>;
	/** Send admission: publishes `.admission-<key hash>` with exactly this record's bytes; never replaces; idempotent. */
	admit(record: ClaimIntentRecord): Promise<ClaimIntentAdmitResult>;
}

type ClaimIntentJournalOptions = {
	directory: string;
	io?: typeof claimJournalIO;
};

type ClaimIntentJournalOpenResult =
	| { kind: "open"; journal: ClaimIntentJournal }
	| { kind: "invalid" | "unavailable"; reason: string };

/** Names the journal writes besides records: publication temporaries and admission slots (never records). */
const TEMPORARY_NAME = /^\.intent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const SLOT_NAME = /^\.admission-[0-9a-f]{64}$/;
const ADMISSION_DOMAIN = "backlog.md/claim-admission/v1\0";

const INTENT_FIELDS = [
	"operationId",
	"remote",
	"format",
	"epoch",
	"ticket",
	"expectedRoot",
	"targetBinding",
	"action",
	"parameters",
	"resolved",
];

class JournalFault extends Error {
	constructor(
		readonly kind: "invalid" | "corrupt",
		reason: string,
	) {
		super(reason);
	}
}

function failure(error: unknown): ClaimJournalFailure {
	return error instanceof JournalFault
		? { kind: error.kind, reason: error.message }
		: { kind: "unavailable", reason: "claim intent journal IO failed" };
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9_-]/.test(value);
}

function operationId(value: unknown): value is string {
	return identifier(value) && value.length <= 128;
}

function endpoint(value: unknown): value is string {
	if (typeof value !== "string" || /\s|\p{Cc}/u.test(value)) return false;
	try {
		const url = new URL(value);
		return (
			["git:", "https:", "http:", "ssh:", "file:"].includes(url.protocol) &&
			(url.protocol === "file:" || Boolean(url.hostname))
		);
	} catch {
		return false;
	}
}

function exactFields(value: JsonObject, fields: string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

function validIntent(value: unknown): value is ClaimOperationIntent {
	if (!isJsonObject(value) || !exactFields(value, INTENT_FIELDS)) return false;
	return (
		operationId(value.operationId) &&
		endpoint(value.remote) &&
		["blob", "tree", "commit-chain"].includes(String(value.format)) &&
		typeof value.format === "string" &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch > 0 &&
		typeof value.ticket === "string" &&
		isValidTaskId(value.ticket) &&
		canonicalTaskId(value.ticket) === value.ticket &&
		(value.expectedRoot === null ||
			(typeof value.expectedRoot === "string" &&
				[40, 64].includes(value.expectedRoot.length) &&
				!/[^a-f0-9]/.test(value.expectedRoot))) &&
		(value.targetBinding === null || (typeof value.targetBinding === "string" && value.targetBinding.length > 0)) &&
		identifier(value.action) &&
		isJsonObject(value.parameters) &&
		isJsonObject(value.resolved)
	);
}

function digest(value: JsonObject): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return { schema: 1, intent, parameterDigest: digest(intent.parameters), digest: digest(intent) };
}

/** The admission slot of one send key: ticket, endpoint, format, epoch and expected root; never action or binding. */
function slotOf(intent: ClaimOperationIntent): string {
	const { epoch, expectedRoot, format, remote, ticket } = intent;
	const key = canonicalJson({ epoch, expectedRoot, format, remote, ticket });
	return `.admission-${createHash("sha256").update(ADMISSION_DOMAIN, "utf8").update(key, "utf8").digest("hex")}`;
}

function byOperationId(left: ClaimIntentRecord, right: ClaimIntentRecord): number {
	return left.intent.operationId < right.intent.operationId ? -1 : 1;
}

/** Validate record values; disk decoding additionally requires canonical bytes and the expected file ID. */
export function isClaimIntentRecord(value: unknown): value is ClaimIntentRecord {
	if (
		!isJsonObject(value) ||
		!exactFields(value, ["schema", "intent", "parameterDigest", "digest"]) ||
		value.schema !== 1 ||
		!validIntent(value.intent)
	) {
		return false;
	}
	const expected = recordOf(value.intent);
	return value.parameterDigest === expected.parameterDigest && value.digest === expected.digest;
}

function decode(source: string, belongs: (record: ClaimIntentRecord) => boolean): ClaimIntentRecord {
	try {
		const value: unknown = JSON.parse(source);
		if (isClaimIntentRecord(value) && belongs(value) && source === `${canonicalJson(value)}\n`) {
			return value;
		}
	} catch {
		// All malformed representations share a safe diagnostic, never the private contents.
	}
	throw new JournalFault("corrupt", "invalid claim intent record");
}

function privateEntry(info: Stats, uid: number, directory: boolean): boolean {
	return (
		(directory ? info.isDirectory() : info.isFile()) &&
		info.uid === uid &&
		(info.mode & 0o7777) === (directory ? 0o700 : 0o600)
	);
}

export async function openClaimIntentJournal(
	options: ClaimIntentJournalOptions,
): Promise<ClaimIntentJournalOpenResult> {
	if (
		typeof options.directory !== "string" ||
		!isAbsolute(options.directory) ||
		options.directory.includes("\0") ||
		typeof process.getuid !== "function" ||
		!constants.O_NOFOLLOW ||
		!constants.O_DIRECTORY ||
		!constants.O_NONBLOCK
	) {
		return { kind: "invalid", reason: "an absolute private journal directory with POSIX file support is required" };
	}
	const directory = resolve(options.directory);
	const uid = process.getuid();
	const io = options.io ?? claimJournalIO;

	async function checkDirectory(): Promise<void> {
		let info: Stats;
		try {
			info = await io.lstat(directory);
		} catch (error) {
			if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
				throw new JournalFault("invalid", "private journal directory is missing");
			}
			throw error;
		}
		if (!privateEntry(info, uid, true)) {
			throw new JournalFault("invalid", "journal requires an owned nonsymlink directory with mode 0700");
		}
	}

	async function inDirectory<T>(action: (handle: FileHandle) => Promise<T>): Promise<T> {
		await checkDirectory();
		const handle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			if (!privateEntry(await handle.stat(), uid, true)) {
				throw new JournalFault("invalid", "private journal directory changed");
			}
			return await action(handle);
		} finally {
			await handle.close();
		}
	}

	/**
	 * The checks of every entry read: owned private regular file, no-follow open, same inode, UTF-8 and canonical
	 * record bytes that `belongs` accepts. `durableIn` adds the file and directory synchronization of a load; absent
	 * is `undefined` once the directory itself is rechecked.
	 */
	async function inspect(
		name: string,
		belongs: (record: ClaimIntentRecord) => boolean,
		durableIn?: FileHandle,
	): Promise<ClaimIntentRecord | undefined> {
		const path = join(directory, name);
		let info: Stats;
		try {
			info = await io.lstat(path);
		} catch (error) {
			if (hasCode(error, "ENOENT")) {
				await checkDirectory();
				return undefined;
			}
			throw error;
		}
		if (!privateEntry(info, uid, false)) {
			throw new JournalFault("corrupt", "journal record is not an owned private regular file");
		}
		const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = await handle.stat();
			if (!privateEntry(opened, uid, false) || opened.dev !== info.dev || opened.ino !== info.ino) {
				throw new JournalFault("corrupt", "journal record changed while opening");
			}
			const bytes = await handle.readFile();
			const source = bytes.toString("utf8");
			if (!Buffer.from(source, "utf8").equals(bytes)) {
				throw new JournalFault("corrupt", "journal record is not UTF-8");
			}
			const record = decode(source, belongs);
			if (durableIn) {
				await handle.sync();
				await durableIn.sync();
			}
			return record;
		} finally {
			await handle.close();
		}
	}

	async function read(id: string, directoryHandle: FileHandle): Promise<ClaimIntentLoadResult> {
		const record = await inspect(`${id}.json`, (value) => value.intent.operationId === id, directoryHandle);
		return record ? { kind: "loaded", record } : { kind: "absent" };
	}

	/** No-replace publication of `text` under `name`: false when the name already existed, never a replacement. */
	async function publishOnce(name: string, text: string, directoryHandle: FileHandle): Promise<boolean> {
		const temporary = join(directory, `.intent-${randomUUID()}.tmp`);
		const handle = await io.open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		let temporaryExists = true;
		try {
			try {
				if (!privateEntry(await handle.stat(), uid, false)) {
					throw new Error("private temporary file could not be created");
				}
				await handle.writeFile(text, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			let created = true;
			try {
				await io.link(temporary, join(directory, name));
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
				created = false;
			}
			await io.unlink(temporary);
			temporaryExists = false;
			if (created) await directoryHandle.sync();
			return created;
		} finally {
			// Only this call's successfully created temporary name is eligible for cleanup.
			if (temporaryExists) await io.unlink(temporary);
		}
	}

	async function publish(record: ClaimIntentRecord, directoryHandle: FileHandle): Promise<ClaimIntentPrepareResult> {
		const id = record.intent.operationId;
		const compare = (result: ClaimIntentLoadResult): ClaimIntentPrepareResult => {
			if (result.kind !== "loaded") throw new Error("published intent is unavailable");
			return canonicalJson(result.record.intent) === canonicalJson(record.intent) ? result : { kind: "conflict" };
		};
		const existing = await read(id, directoryHandle);
		if (existing.kind !== "absent") return compare(existing);
		if (!(await publishOnce(`${id}.json`, `${canonicalJson(record)}\n`, directoryHandle))) {
			return compare(await read(id, directoryHandle));
		}
		return { kind: "prepared", record };
	}

	/** Read-only: names by code units, records validated like `read` without its synchronization. */
	async function list(): Promise<ClaimIntentEnumerationResult> {
		const names = [...(await io.readdir(directory))].sort();
		const records: ClaimIntentRecord[] = [];
		let corrupt = 0;
		for (const name of names) {
			if (TEMPORARY_NAME.test(name) || SLOT_NAME.test(name)) continue;
			const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
			let record: ClaimIntentRecord | undefined;
			try {
				// A name listed but gone again is corrupt too: the API never deletes a record.
				if (operationId(id)) record = await inspect(name, (value) => value.intent.operationId === id);
			} catch (error) {
				if (!(error instanceof JournalFault && error.kind === "corrupt")) throw error;
			}
			if (record) records.push(record);
			else corrupt += 1;
		}
		return { kind: "enumerated", records: records.sort(byOperationId), corrupt };
	}

	/** Record-first send admission: the stored record, then the slot of its key, linked once and never replaced. */
	async function admitIn(record: ClaimIntentRecord, directoryHandle: FileHandle): Promise<ClaimIntentAdmitResult> {
		const id = record.intent.operationId;
		const text = `${canonicalJson(record)}\n`;
		const stored = await inspect(`${id}.json`, (value) => value.intent.operationId === id, directoryHandle);
		if (!stored) return { kind: "invalid", reason: "claim intent record is not published" };
		if (`${canonicalJson(stored)}\n` !== text) {
			throw new JournalFault("corrupt", "claim intent record differs from the journal");
		}
		const slot = slotOf(record.intent);
		const holder = () => inspect(slot, (value) => slotOf(value.intent) === slot, directoryHandle);
		const decide = (found: ClaimIntentRecord | undefined): ClaimIntentAdmitResult => {
			if (!found) throw new Error("admission slot is unavailable");
			return `${canonicalJson(found)}\n` === text
				? { kind: "admitted" }
				: { kind: "held", operationId: found.intent.operationId };
		};
		const existing = await holder();
		if (existing) return decide(existing);
		return (await publishOnce(slot, text, directoryHandle)) ? { kind: "admitted" } : decide(await holder());
	}

	try {
		await checkDirectory();
	} catch (error) {
		const result = failure(error);
		return { kind: result.kind === "invalid" ? "invalid" : "unavailable", reason: result.reason };
	}
	return {
		kind: "open",
		journal: {
			async prepare(intent) {
				let record: ClaimIntentRecord;
				try {
					if (!validIntent(intent)) return { kind: "invalid", reason: "invalid claim operation intent" };
					// Snapshot before the first await: the caller may mutate its input immediately.
					const snapshot: unknown = JSON.parse(canonicalJson(intent));
					if (!validIntent(snapshot)) return { kind: "invalid", reason: "invalid claim operation intent" };
					record = recordOf(snapshot);
				} catch {
					return { kind: "invalid", reason: "invalid claim operation intent" };
				}
				try {
					return await inDirectory((handle) => publish(record, handle));
				} catch (error) {
					return failure(error);
				}
			},
			async load(id) {
				if (!operationId(id)) return { kind: "invalid", reason: "invalid claim operation ID" };
				try {
					return await inDirectory((handle) => read(id, handle));
				} catch (error) {
					return failure(error);
				}
			},
			async enumerate() {
				try {
					return await inDirectory(() => list());
				} catch (error) {
					const result = failure(error);
					return { kind: result.kind === "invalid" ? "invalid" : "unavailable", reason: result.reason };
				}
			},
			async admit(record) {
				let snapshot: ClaimIntentRecord;
				try {
					// Snapshot before the first await, as in prepare: the caller may mutate its input immediately.
					const copy: unknown = isClaimIntentRecord(record) ? JSON.parse(canonicalJson(record)) : undefined;
					if (!isClaimIntentRecord(copy)) return { kind: "invalid", reason: "invalid claim intent record" };
					snapshot = copy;
				} catch {
					return { kind: "invalid", reason: "invalid claim intent record" };
				}
				try {
					return await inDirectory((handle) => admitIn(snapshot, handle));
				} catch (error) {
					return failure(error);
				}
			},
		},
	};
}
