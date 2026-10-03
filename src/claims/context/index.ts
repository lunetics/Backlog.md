/** Internal local execution context; never proof of remote ownership. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson, isJsonObject, type JsonObject } from "../json.ts";

export const claimContextIO = { open, lstat, mkdir, link, unlink };

export type ClaimContext = {
	contextId: string;
	binding: string;
	journalDirectory: string;
	recovery: { binding: string } | null;
};

type ClaimContextFailure = {
	kind: "invalid" | "corrupt" | "unavailable";
	reason: string;
};

type CreateClaimContextOptions = {
	parent: string;
	recoverFrom?: string;
	io?: typeof claimContextIO;
};

type LoadClaimContextOptions = {
	directory: string;
	io?: typeof claimContextIO;
};

type PrivateProof = { binding: string; secret: string };
type PrivateContext = PrivateProof & {
	schema: 1;
	contextId: string;
	recovery: PrivateProof | null;
};
type ContextIO = typeof claimContextIO;
type InvalidKind = "invalid" | "corrupt";

class ContextFault extends Error {
	constructor(
		readonly kind: InvalidKind,
		reason: string,
	) {
		super(reason);
	}
}

function failure(error: unknown): ClaimContextFailure {
	return error instanceof ContextFault
		? { kind: error.kind, reason: error.message }
		: { kind: "unavailable", reason: "claim context IO or runtime support failed" };
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function explicitPath(value: unknown): string {
	if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
		throw new ContextFault("invalid", "an explicit absolute private context path is required");
	}
	return resolve(value);
}

function currentUid(): number {
	if (
		typeof process.getuid !== "function" ||
		!constants.O_NOFOLLOW ||
		!constants.O_DIRECTORY ||
		!constants.O_NONBLOCK
	) {
		throw new Error("POSIX private file support is required");
	}
	return process.getuid();
}

function privateEntry(info: Stats, uid: number, directory: boolean): boolean {
	return (
		(directory ? info.isDirectory() : info.isFile()) &&
		info.uid === uid &&
		(info.mode & 0o7777) === (directory ? 0o700 : 0o600)
	);
}

/** Point-in-time checks; callers must keep ancestor and context paths trusted and stable. */
async function withPrivateEntry<T>(
	io: ContextIO,
	path: string,
	uid: number,
	directory: boolean,
	kind: InvalidKind,
	action: (handle: FileHandle) => Promise<T>,
): Promise<T> {
	let info: Stats;
	let handle: FileHandle;
	try {
		info = await io.lstat(path);
		if (!privateEntry(info, uid, directory)) {
			throw new ContextFault(kind, "claim context entry is not owned, private and of the required type");
		}
		handle = await io.open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK),
		);
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR") || hasCode(error, "ELOOP")) {
			throw new ContextFault(kind, "claim context entry is missing or unsafe");
		}
		throw error;
	}
	try {
		const opened = await handle.stat();
		if (!privateEntry(opened, uid, directory) || opened.dev !== info.dev || opened.ino !== info.ino) {
			throw new ContextFault(kind, "claim context entry changed while opening");
		}
		return await action(handle);
	} finally {
		await handle.close();
	}
}

function exactFields(value: JsonObject, fields: string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

/** `prefix` plus the lowercase hex SHA-256 over a NUL-terminated UTF-8 domain and the raw secret bytes. */
function derivedId(prefix: string, domain: string, secret: string): string {
	return `${prefix}${createHash("sha256").update(domain, "utf8").update(Buffer.from(secret, "hex")).digest("hex")}`;
}

function bindingOf(secret: string): string {
	return derivedId("tb1-", "backlog.md/claim-context/v1\0", secret);
}

function validProof(value: JsonObject): boolean {
	return (
		typeof value.secret === "string" &&
		value.secret.length === 64 &&
		!/[^a-f0-9]/.test(value.secret) &&
		value.binding === bindingOf(value.secret)
	);
}

function decode(bytes: Buffer, contextId: string): PrivateContext {
	try {
		const source = bytes.toString("utf8");
		const value: unknown = JSON.parse(source);
		if (
			Buffer.from(source, "utf8").equals(bytes) &&
			isJsonObject(value) &&
			exactFields(value, ["schema", "contextId", "binding", "secret", "recovery"]) &&
			value.schema === 1 &&
			value.contextId === contextId &&
			contextId.length === 36 &&
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(contextId) &&
			validProof(value) &&
			(value.recovery === null ||
				(isJsonObject(value.recovery) &&
					exactFields(value.recovery, ["binding", "secret"]) &&
					validProof(value.recovery))) &&
			source === `${canonicalJson(value)}\n`
		) {
			return value as PrivateContext;
		}
	} catch {
		// Never expose parser messages or private record contents.
	}
	throw new ContextFault("corrupt", "invalid private claim context record");
}

function publicContext(record: PrivateContext, directory: string): ClaimContext {
	return {
		contextId: record.contextId,
		binding: record.binding,
		journalDirectory: join(directory, "journal"),
		recovery: record.recovery === null ? null : { binding: record.recovery.binding },
	};
}

/** Keeps private proofs inside this module; public load exposes only the derived binding. */
async function readContext(directory: string, io: ContextIO, uid: number): Promise<PrivateContext> {
	return withPrivateEntry(io, dirname(directory), uid, true, "invalid", (parent) =>
		withPrivateEntry(io, directory, uid, true, "invalid", (context) =>
			withPrivateEntry(io, join(directory, "journal"), uid, true, "corrupt", (journal) =>
				withPrivateEntry(io, join(directory, "context.json"), uid, false, "corrupt", async (file) => {
					const record = decode(await file.readFile(), basename(directory));
					await file.sync();
					await journal.sync();
					await context.sync();
					await parent.sync();
					return record;
				}),
			),
		),
	);
}

export async function createClaimContext(
	options: CreateClaimContextOptions,
): Promise<{ kind: "created"; context: ClaimContext } | ClaimContextFailure> {
	try {
		// Capture caller inputs before the first await; never select a context implicitly.
		const parentPath = explicitPath(options.parent);
		const sourcePath = options.recoverFrom === undefined ? undefined : explicitPath(options.recoverFrom);
		const uid = currentUid();
		const io = options.io ?? claimContextIO;
		const context = await withPrivateEntry(io, parentPath, uid, true, "invalid", async (parent) => {
			const source = sourcePath === undefined ? null : await readContext(sourcePath, io, uid);
			const secret = randomBytes(32).toString("hex");
			const record: PrivateContext = {
				schema: 1,
				contextId: randomUUID(),
				binding: bindingOf(secret),
				secret,
				recovery: source === null ? null : { binding: source.binding, secret: source.secret },
			};
			const directory = join(parentPath, record.contextId);
			// EEXIST is a failure, not a reason to adopt, overwrite or retry another path.
			await io.mkdir(directory, { mode: 0o700 });
			return withPrivateEntry(io, directory, uid, true, "invalid", async (contextDirectory) => {
				const journalPath = join(directory, "journal");
				await io.mkdir(journalPath, { mode: 0o700 });
				return withPrivateEntry(io, journalPath, uid, true, "corrupt", async (journal) => {
					const temporary = join(directory, `.context-${randomUUID()}.tmp`);
					const file = await io.open(
						temporary,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
						0o600,
					);
					try {
						if (!privateEntry(await file.stat(), uid, false)) {
							throw new Error("private temporary context file could not be created");
						}
						await file.writeFile(`${canonicalJson(record)}\n`, "utf8");
						await file.sync();
					} finally {
						await file.close();
					}
					await io.link(temporary, join(directory, "context.json"));
					await io.unlink(temporary);
					await journal.sync();
					await contextDirectory.sync();
					await parent.sync();
					return publicContext(record, directory);
				});
			});
		});
		return { kind: "created", context };
	} catch (error) {
		// Leave partial directories untouched. This call never adopts or sweeps old contexts.
		return failure(error);
	}
}

/** The validated private record of an explicit context directory; throws what `failure` maps. */
async function loadRecord(options: LoadClaimContextOptions): Promise<{ directory: string; record: PrivateContext }> {
	const directory = explicitPath(options.directory);
	const uid = currentUid();
	const record = await readContext(directory, options.io ?? claimContextIO, uid);
	return { directory, record };
}

export async function loadClaimContext(
	options: LoadClaimContextOptions,
): Promise<{ kind: "loaded"; context: ClaimContext } | ClaimContextFailure> {
	try {
		const { directory, record } = await loadRecord(options);
		return { kind: "loaded", context: publicContext(record, directory) };
	} catch (error) {
		return failure(error);
	}
}

/**
 * The emergency-release authority ID of a context, `ta1-` plus the lowercase hex SHA-256
 * over the domain `backlog.md/claim-authority/v1\0` and the context's own secret bytes (never the recovery proof's).
 * It is not the binding: another domain gives another digest. The secret never leaves this module, and the ID is
 * neither stored in `context.json` nor part of the public context. Failures are those of `loadClaimContext`.
 */
export async function claimContextAuthority(
	options: LoadClaimContextOptions,
): Promise<{ kind: "derived"; authorityId: string } | ClaimContextFailure> {
	try {
		const { record } = await loadRecord(options);
		return { kind: "derived", authorityId: derivedId("ta1-", "backlog.md/claim-authority/v1\0", record.secret) };
	} catch (error) {
		return failure(error);
	}
}
