/**
 * Behavioural contract for the internal claim storage adapters over real Git processes and
 * loopback TCP. The blob adapter plus the shared configuration, descriptor and preflight and the tree adapter are
 * covered; further formats join through ADAPTER_FORMATS. This is
 * not a public CLI/MCP test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClaimChange,
	type ClaimDocument,
	type ClaimSnapshot,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	type ClaimWriteResult,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
	parseClaimStorageFormat,
} from "../claims/storage/index.ts";
import {
	DropProxy,
	finish,
	GitFixtureServer,
	ReceiveGates,
	StallProxy,
	unusedLoopbackPort,
} from "./fixtures/claim-git-fixture.ts";
import type { ProbeInput, ProbeReport } from "./fixtures/claim-storage-env-probe.ts";

const STORAGE_FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const ADAPTER_FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/** Object type a ticket ref points at in each format. */
const ROOT_OBJECT_TYPE: Record<ClaimStorageFormat, string> = { blob: "blob", tree: "tree", "commit-chain": "commit" };
/**
 * Server objects after a raw descriptor plus revision 1 with one receipt, sorted. Tree layout: root tree
 * with a `state` blob (document without receipts) and a `receipts` tree holding one blob per operation ID.
 * Commit-chain: one commit per revision, single parent, whose tree has the tree layout with only the
 * receipt that revision added.
 */
const CREATED_OBJECT_TYPES: Record<(typeof ADAPTER_FORMATS)[number], string[]> = {
	blob: ["blob", "blob"],
	tree: ["blob", "blob", "blob", "tree", "tree"],
	"commit-chain": ["blob", "blob", "blob", "commit", "tree", "tree"],
};
/** Agreed constant commit identity and time; they only make object IDs deterministic, with no actor or clock meaning. */
const CHAIN_IDENTITY = "Backlog.md Claims <claims@backlog.invalid> 0 +0000";
const DESCRIPTOR_REF = "refs/claim-meta/format";
const TICKET = "BACK-1";
const TICKET_REF = `refs/claims/${TICKET}`;
const ADAPTER_TIMEOUT = 3_000;
const TEST_TIMEOUT = 10_000;
/**
 * How long a fixture waits for something the test started (a held push, a landed ref): longer than the adapter's
 * per-command timeout, because a loaded runner can take that long just to spawn and connect a git process, yet short
 * enough that one exhausted wait still ends a row with the fixture's own message before TEST_TIMEOUT.
 */
const FIXTURE_WAIT = 6_000;
const FETCH_HEAD_SENTINEL = "fixture sentinel: claim storage must not write FETCH_HEAD\n";
/** (amended): a refused ticket write whose re-read finds the ref moved or gone, with its fixed reason. */
const REREAD_STALE: ClaimWriteResult = {
	kind: "rejected",
	cause: "stale",
	reason: "the ticket ref moved since the snapshot; the endpoint refused the update",
};
/** A refused repetition whose re-read finds the ref at exactly this write's root, with its fixed reason. */
const REREAD_LANDED: ClaimWriteResult = {
	kind: "unknown",
	reason: "the ticket ref already holds this write; the endpoint refused the repetition",
};

const CLAIM_A: ClaimChange = {
	operationId: "op-claim-a",
	receipt: { action: "claim", by: "agent-a" },
	payload: { state: "claimed", holder: "agent-a" },
};
const RENEW_A: ClaimChange = {
	operationId: "op-renew-a",
	receipt: { action: "renew", by: "agent-a" },
	payload: { state: "claimed", holder: "agent-a", renewed: 1 },
};
const CLAIM_B: ClaimChange = {
	operationId: "op-claim-b",
	receipt: { action: "claim", by: "agent-b" },
	payload: { state: "claimed", holder: "agent-b" },
};
const RENEW_B: ClaimChange = {
	operationId: "op-renew-b",
	receipt: { action: "renew", by: "agent-b" },
	payload: { state: "claimed", holder: "agent-b", renewed: 1 },
};
/** Opaque payloads only; the storage layer attaches no lifecycle meaning to them. */
const RELEASE_A: ClaimChange = {
	operationId: "op-release-a",
	receipt: { action: "release", by: "agent-a" },
	payload: { state: "free" },
};
const RECLAIM_A: ClaimChange = { ...CLAIM_A, operationId: "op-reclaim-a" };

const OTHER_TICKET = "BACK-2";
const VALID_TICKETS = ["BACK-1", "BACK-7.2", "TASK-0", "TASK-A7"];
const INVALID_TICKETS = [
	"back-1",
	"task-a7",
	"BACK-01",
	"BACK-7.02",
	"1",
	" BACK-1",
	"BACK-1\n",
	"BACK-1.lock",
	"BACK-1/x",
	"../BACK-1",
	"-BACK-1",
	"",
];
const INVALID_OPERATION_IDS = ["a/b", "..", "", " op", "op\u0000"];
const NON_JSON_CHANGES: Record<string, unknown> = {
	"NaN in payload": { ...CLAIM_A, payload: { count: Number.NaN } },
	"Infinity in payload": { ...CLAIM_A, payload: { limit: Number.POSITIVE_INFINITY } },
	"undefined in payload": { ...CLAIM_A, payload: { missing: undefined } },
	"undefined in array": { ...CLAIM_A, payload: { list: [1, undefined] } },
	"bigint in payload": { ...CLAIM_A, payload: { big: BigInt(1) } },
	"array payload": { ...CLAIM_A, payload: [] },
	"null receipt": { ...CLAIM_A, receipt: null },
	"function in receipt": { ...CLAIM_A, receipt: { run: () => 1 } },
};

/** Keys whose code-unit order differs from locale order, so canonical sorting is observable. */
const UNSORTED_A: ClaimChange = {
	operationId: "op-a",
	receipt: { zeta: 1, Alpha: { b: [2, { y: 1, X: 0 }], a: null } },
	payload: { zeta: "z", "ä-key": true, Beta: [{ y: 1, x: 2 }], alpha: { b: 2, a: 1 }, Z: false, n: 1.5 },
};
const UNSORTED_B: ClaimChange = {
	operationId: "op-B",
	receipt: { by: "agent-b", at: "t" },
	payload: { state: "renewed" },
};

const PROTO_RECEIPT = '{"__proto__":{"polluted":1},"action":"claim"}';
const PROTO_PAYLOAD = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"state":"claimed"}';
const PROTO_CHANGE: ClaimChange = {
	operationId: "op-proto",
	receipt: JSON.parse(PROTO_RECEIPT) as JsonObject,
	payload: JSON.parse(PROTO_PAYLOAD) as JsonObject,
};

const ENV_PROBE = fileURLToPath(new URL("./fixtures/claim-storage-env-probe.ts", import.meta.url));
const PROBE_TIMEOUT = 8_000;
/** Adapter timeout for stalled or held operations, and the wall-clock bound such an operation must return within. */
const SHORT_TIMEOUT = 750;
const OVERDUE_BOUND = 3_000;

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function descriptorOf(format: ClaimStorageFormat): { schema: 1; format: ClaimStorageFormat; epoch: number } {
	return { schema: 1, format, epoch: 1 };
}

function otherFormat(format: ClaimStorageFormat): ClaimStorageFormat {
	const other = STORAGE_FORMATS.find((candidate) => candidate !== format);
	if (!other) throw new Error(`no storage format other than ${format}`);
	return other;
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(value)}`);
	return value as Extract<T, { kind: K }>;
}

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Agreed document encoding: recursively code-unit-sorted keys, no whitespace. */
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

function canonicalText(value: unknown): string {
	return `${canonicalJson(value)}\n`;
}

function receiptsOf(...changes: ClaimChange[]): Record<string, JsonObject> {
	return Object.fromEntries(changes.map((change) => [change.operationId, change.receipt]));
}

function documentOf(
	format: ClaimStorageFormat,
	ticket: string,
	revision: number,
	payload: JsonObject,
	receipts: Record<string, JsonObject>,
): ClaimDocument {
	return { ...descriptorOf(format), ticket, revision, payload, receipts };
}

function documentAfterClaim(format: ClaimStorageFormat, revision: number): ClaimDocument {
	return documentOf(format, TICKET, revision, CLAIM_A.payload, receiptsOf(CLAIM_A));
}

/** The document without its receipts: the content of the tree layout's `state` blob. */
function stateOf(document: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "receipts"));
}

function chainMessage(ticket: unknown, revision: unknown): string {
	return `claim ${String(ticket)} revision ${String(revision)}\n`;
}

/** Expected bytes of the primary blob: the whole document for blob, the `state` entry for tree and commit-chain. */
function expectedStateText(format: ClaimStorageFormat, document: ClaimDocument): string {
	return canonicalText(format === "blob" ? document : stateOf(document));
}

function rewriteConfig(target: string, original: string, keys: readonly string[]): string {
	return `[url "${target}"]\n${keys.map((key) => `\t${key} = ${original}\n`).join("")}`;
}

async function chmodDirs(dir: string, mode: number): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) await chmodDirs(join(dir, entry.name), mode);
	}
	await chmod(dir, mode);
}

function probeEnv(overrides: Record<string, string>, removed: readonly string[] = []): Record<string, string> {
	const env = { ...server().env, ...overrides };
	for (const key of removed) delete env[key];
	return env;
}

type LocalState = { refs: string[]; head: string; fetchHead: string };
type TreeEntry = { mode: string; type: string; oid: string };

/**
 * The first pkt-line of `buffered` once it is complete, else undefined. Git writes a pkt-line's four-digit hex length
 * and its payload in two writes, so the first data event may carry the length alone. A flush (`0000`) or a length that
 * is no pkt-line counts as complete, so no connection waits forever.
 */
function firstPacketLine(buffered: Buffer): Buffer | undefined {
	if (buffered.length < 4) return undefined;
	const header = buffered.subarray(0, 4).toString("latin1");
	if (!/^[0-9a-f]{4}$/i.test(header)) return buffered;
	const size = Number.parseInt(header, 16);
	if (size < 4) return buffered.subarray(0, 4);
	return buffered.length < size ? undefined : buffered.subarray(4, size);
}

/**
 * (/), test-local: forwards every connection to the fixture daemon and holds each one whose first
 * pkt-line requests `git-receive-pack` until `release`, before the daemon advertises any ref; reads pass at once. The
 * line is collected across data events before the connection is classified, and every byte read up to then is
 * forwarded in order. Adapted from DropProxy (claim-git-fixture.ts). ReceiveGates cannot hold one of two
 * initializers: both push one OID.
 */
class PushHoldProxy {
	readonly port: number;
	private readonly listener: Server;
	private readonly sockets = new Set<Socket>();
	private readonly held: (() => void)[] = [];
	private readonly started = performance.now();
	private readonly connections: string[] = [];
	private accepted = 0;
	private partial = 0;

	private constructor(listener: Server, port: number) {
		this.listener = listener;
		this.port = port;
	}

	/** Milliseconds since this proxy started, the clock of its connection log. */
	elapsed(): number {
		return Math.round(performance.now() - this.started);
	}

	/** Every connection so far with its service, accept and first-packet time, for failure messages. */
	get connectionLog(): string {
		return `${this.accepted} accepted [${this.connections.join(", ")}]`;
	}

	/** Connections whose first data event carried an incomplete first pkt-line, for the split-packet control. */
	get partialFirstPackets(): number {
		return this.partial;
	}

	static async create(targetPort: number): Promise<PushHoldProxy> {
		const listener = createServer();
		const port = await new Promise<number>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", () => {
				listener.off("error", reject);
				const address = listener.address();
				if (!address || typeof address === "string") reject(new Error("push hold proxy got no loopback port"));
				else resolve(address.port);
			});
		});
		const proxy = new PushHoldProxy(listener, port);
		listener.on("connection", (client) => {
			proxy.track(client);
			proxy.accepted += 1;
			const accepted = proxy.elapsed();
			let buffered = Buffer.alloc(0);
			const classify = (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				const line = firstPacketLine(buffered);
				if (line === undefined) {
					if (buffered.length === chunk.length) proxy.partial += 1;
					return;
				}
				client.off("data", classify);
				client.pause();
				const first = buffered;
				const service = line.includes("git-receive-pack")
					? "receive-pack"
					: line.includes("git-upload-pack")
						? "upload-pack"
						: "other";
				proxy.connections.push(`${service} @${accepted}/${proxy.elapsed()} ms`);
				const forward = () => {
					// A client that left while held (the split control) gets no upstream connection.
					if (client.destroyed) return;
					const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
					proxy.track(upstream);
					upstream.on("error", () => client.destroy());
					upstream.write(first);
					client.pipe(upstream).pipe(client);
					client.resume();
				};
				if (service === "receive-pack") proxy.held.push(forward);
				else forward();
			};
			client.on("data", classify);
		});
		return proxy;
	}

	private track(socket: Socket): void {
		this.sockets.add(socket);
		socket.on("error", () => undefined);
		socket.once("close", () => this.sockets.delete(socket));
	}

	/** Waits, bounded by FIXTURE_WAIT, until `count` push connections are held. */
	async untilHeld(count: number): Promise<void> {
		const deadline = Date.now() + FIXTURE_WAIT;
		while (this.held.length < count) {
			if (Date.now() > deadline) throw new Error(`push hold proxy: ${this.held.length} of ${count} pushes held`);
			await Bun.sleep(10);
		}
	}

	/** Forwards every held connection; later push connections are held again. */
	release(): void {
		for (const forward of this.held.splice(0)) forward();
	}

	async close(): Promise<void> {
		this.held.length = 0;
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => {
			this.listener.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

class AdapterCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	readonly gates: ReceiveGates;
	private readonly cleanups: (() => Promise<void>)[] = [];
	private referenceRepo: string | undefined;

	private constructor(format: ClaimStorageFormat, root: string, url: string, serverRepo: string, label: string) {
		this.format = format;
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.gates = new ReceiveGates(root, label);
	}

	static async create(format: ClaimStorageFormat, caseName: string): Promise<AdapterCase> {
		const root = await mkdtemp(join(tmpdir(), "backlog-claim-adapter-"));
		try {
			const label = `adapter-${format}-${caseName}`;
			const { name, repo } = await server().initRepository(root, label);
			return new AdapterCase(format, root, server().url(name), repo, label);
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** A client repository with local branch, remote-tracking ref, tag and FETCH_HEAD the adapter must not touch. */
	async client(label: string): Promise<string> {
		const path = join(this.root, label);
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		await server().git(path, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
		await server().git(path, ["tag", "seed"]);
		await writeFile(join(path, ".git", "FETCH_HEAD"), FETCH_HEAD_SENTINEL);
		return path;
	}

	options(repository: string): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
	}

	async open(repository: string): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.options(repository)), "open").store;
	}

	/** Writes a descriptor directly into the server repository, bypassing the product initializer. */
	async setDescriptor(descriptor: unknown): Promise<string> {
		return this.setBlob(DESCRIPTOR_REF, `${JSON.stringify(descriptor)}\n`);
	}

	/** Stores raw bytes as a blob in the server repository and points `ref` at it. */
	async setBlob(ref: string, text: string): Promise<string> {
		const oid = (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async setEmptyTree(ref: string): Promise<string> {
		const oid = (await server().git(this.serverRepo, ["mktree"], "")).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async hashOf(text: string): Promise<string> {
		return (await server().git(this.serverRepo, ["hash-object", "--stdin"], text)).out.trim();
	}

	async rawBlob(oid: string): Promise<string> {
		return (await server().git(this.serverRepo, ["cat-file", "blob", oid])).out;
	}

	/** Bytes of the primary blob of a stored root: the root itself for blob, the `state` entry otherwise. */
	async storedStateText(root: string): Promise<string> {
		if (this.format === "blob") return this.rawBlob(root);
		const tree = this.format === "commit-chain" ? (await this.commitHeader(root)).tree : root;
		const state = (await this.treeEntries(tree)).get("state");
		if (state?.type !== "blob") throw new Error(`claim tree ${tree} has no state blob`);
		return this.rawBlob(state.oid);
	}

	/** Decodes a stored root in the agreed layout, independently of the product. */
	async readStored(root: string): Promise<unknown> {
		if (this.format === "blob") return this.readJson(root);
		if (this.format === "tree") return this.readTree(root);
		let document: Record<string, unknown> | undefined;
		const receipts: [string, unknown][] = [];
		let commit: string | undefined = root;
		while (commit) {
			const { tree, parents } = await this.commitHeader(commit);
			const layer = await this.readTree(tree);
			document ??= layer;
			receipts.push(...Object.entries(layer.receipts as Record<string, unknown>));
			commit = parents[0];
		}
		return { ...document, receipts: Object.fromEntries(receipts) };
	}

	private async readTree(tree: string): Promise<Record<string, unknown>> {
		const entries = await this.treeEntries(tree);
		const state = entries.get("state");
		const receipts = entries.get("receipts");
		if (state?.type !== "blob" || receipts?.type !== "tree") throw new Error(`tree ${tree} is not a claim`);
		const decoded: [string, unknown][] = [];
		for (const [name, entry] of await this.treeEntries(receipts.oid)) {
			if (entry.type !== "blob") throw new Error(`receipt ${name} in ${tree} is not a blob`);
			decoded.push([name, await this.readJson(entry.oid)]);
		}
		const document = (await this.readJson(state.oid)) as Record<string, unknown>;
		return { ...document, receipts: Object.fromEntries(decoded) };
	}

	async rawCommit(commit: string): Promise<string> {
		return (await server().git(this.serverRepo, ["cat-file", "commit", commit])).out;
	}

	async commitHeader(commit: string): Promise<{ tree: string; parents: string[] }> {
		const text = await this.rawCommit(commit);
		const lines = text.slice(0, text.indexOf("\n\n")).split("\n");
		const tree = lines.find((line) => line.startsWith("tree "))?.slice("tree ".length);
		if (!tree) throw new Error(`commit ${commit} has no tree`);
		const parents = lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice("parent ".length));
		return { tree, parents };
	}

	async treeEntries(tree: string): Promise<Map<string, TreeEntry>> {
		const out = (await server().git(this.serverRepo, ["ls-tree", "-z", tree])).out;
		const entries = new Map<string, TreeEntry>();
		for (const row of out.split("\0").filter(Boolean)) {
			const tab = row.indexOf("\t");
			const [mode, type, oid] = row.slice(0, tab).split(" ");
			if (tab < 0 || !mode || !type || !oid) throw new Error(`invalid ls-tree row: ${row}`);
			entries.set(row.slice(tab + 1), { mode, type, oid });
		}
		return entries;
	}

	/**
	 * Root object ID the agreed layout yields after `revisions` (oldest first), computed without writing to
	 * the server. Blob and tree depend only on the last revision; commit-chain on the whole receipt sequence.
	 */
	async expectedRoot(...revisions: unknown[]): Promise<string> {
		const current = revisions.at(-1);
		if (this.format === "blob") return this.hashOf(canonicalText(current));
		if (this.format === "tree") return this.encode(await this.reference(), current);
		const repo = await this.reference();
		const seen = new Set<string>();
		let parent: string | undefined;
		for (const revision of revisions) {
			const document = revision as ClaimDocument;
			const delta = Object.entries(document.receipts).filter(([name]) => !seen.has(name));
			for (const [name] of delta) seen.add(name);
			const tree = await this.layoutTree(repo, { ...stateOf(document), receipts: Object.fromEntries(delta) });
			parent = await this.commit(repo, tree, parent ? [parent] : [], chainMessage(document.ticket, document.revision));
		}
		if (!parent) throw new Error("expected at least one revision");
		return parent;
	}

	/** One chain commit for `document` holding exactly the `delta` receipts, on top of `parents`. */
	async chainCommit(
		repo: string,
		document: Record<string, unknown>,
		delta: readonly ClaimChange[],
		parents: readonly string[],
	): Promise<string> {
		const tree = await this.layoutTree(repo, { ...stateOf(document), receipts: receiptsOf(...delta) });
		return this.commit(repo, tree, parents, chainMessage(document.ticket, document.revision));
	}

	/** Writes a commit with the agreed header bytes, independent of Git config and environment. */
	async commit(repo: string, tree: string, parents: readonly string[], message: string): Promise<string> {
		const header = [
			`tree ${tree}`,
			...parents.map((parent) => `parent ${parent}`),
			`author ${CHAIN_IDENTITY}`,
			`committer ${CHAIN_IDENTITY}`,
		];
		const text = `${header.join("\n")}\n\n${message}`;
		return (await server().git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], text)).out.trim();
	}

	/** Stores `value` at `ref` in the agreed layout; `value` may be deliberately malformed. */
	async storeDocument(ref: string, value: unknown): Promise<string> {
		return this.point(ref, await this.encode(this.serverRepo, value));
	}

	/** Stores raw primary-blob bytes (blob: the whole root; tree: `state`) with well-formed receipts. */
	async storeStateText(ref: string, text: string, receipts: Record<string, JsonObject>): Promise<string> {
		if (this.format === "blob") return this.setBlob(ref, text);
		const state = await this.writeBlob(this.serverRepo, text);
		const tree = await this.receiptsTree(this.serverRepo, receipts);
		const root = await this.mktree(this.serverRepo, `100644 blob ${state}\tstate\n040000 tree ${tree}\treceipts\n`);
		if (this.format === "tree") return this.point(ref, root);
		return this.point(ref, await this.commit(this.serverRepo, root, [], chainMessage(TICKET, 1)));
	}

	/** Stores a well-formed document as the wrong root object type for the configured format. */
	async storeWrongRootType(ref: string, document: ClaimDocument): Promise<string> {
		if (this.format === "blob") return this.setEmptyTree(ref);
		if (this.format === "tree") return this.setBlob(ref, canonicalText(document));
		return this.point(ref, await this.layoutTree(this.serverRepo, document));
	}

	async writeBlob(repo: string, text: string): Promise<string> {
		return (await server().git(repo, ["hash-object", "-w", "--stdin"], text)).out.trim();
	}

	async mktree(repo: string, rows: string): Promise<string> {
		return (await server().git(repo, ["mktree"], rows)).out.trim();
	}

	async point(ref: string, oid: string): Promise<string> {
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	/** Wraps `target` in an annotated tag object with fixed header bytes; creates no tag or branch ref. */
	async tagObject(target: string, type: string): Promise<string> {
		const text = `object ${target}\ntype ${type}\ntag claim-wrapper\ntagger Fixture Wrapper <wrapper@example.invalid> 0 +0000\n\nwrapper\n`;
		return (await server().git(this.serverRepo, ["mktag"], text)).out.trim();
	}

	/**
	 * Reference encoder for the agreed layouts; tolerates malformed values so corruption cases can be built.
	 * Commit-chain encodes `value` as a single root commit carrying all of its receipts.
	 */
	private async encode(repo: string, value: unknown): Promise<string> {
		if (this.format === "blob") return this.writeBlob(repo, canonicalText(value));
		const tree = await this.layoutTree(repo, value);
		if (this.format === "tree") return tree;
		const { ticket, revision } = value as Record<string, unknown>;
		return this.commit(repo, tree, [], chainMessage(ticket, revision));
	}

	private async layoutTree(repo: string, value: unknown): Promise<string> {
		const { receipts, ...state } = value as Record<string, unknown>;
		const rows = [`100644 blob ${await this.writeBlob(repo, canonicalText(state))}\tstate\n`];
		if (receipts !== undefined) rows.push(`040000 tree ${await this.receiptsTree(repo, receipts)}\treceipts\n`);
		return this.mktree(repo, rows.join(""));
	}

	private async receiptsTree(repo: string, receipts: unknown): Promise<string> {
		const rows: string[] = [];
		for (const [name, receipt] of Object.entries(receipts as Record<string, unknown>)) {
			rows.push(`100644 blob ${await this.writeBlob(repo, canonicalText(receipt))}\t${name}\n`);
		}
		return this.mktree(repo, rows.join(""));
	}

	/** Bare repository for computing expected roots, so the server's object inventory stays untouched. */
	private async reference(): Promise<string> {
		if (!this.referenceRepo) {
			const path = join(this.root, "reference.git");
			await server().git(this.root, ["init", "--quiet", "--bare", path]);
			this.referenceRepo = path;
		}
		return this.referenceRepo;
	}

	/** A second repository on the same daemon that no configured endpoint may ever reach. */
	async decoy(label = "decoy"): Promise<{ url: string; repo: string }> {
		const { name, repo } = await server().initRepository(this.root, `adapter-${this.format}-${label}`);
		return { url: server().url(name), repo };
	}

	/** The configured endpoint's repository, reached through another loopback port. */
	viaPort(port: number): string {
		return this.url.replace(`127.0.0.1:${server().port}/`, `127.0.0.1:${port}/`);
	}

	async dropProxy(): Promise<DropProxy> {
		const proxy = await DropProxy.create(server().port);
		this.cleanups.push(() => proxy.drop());
		return proxy;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	async pushHoldProxy(): Promise<PushHoldProxy> {
		const proxy = await PushHoldProxy.create(server().port);
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	/** Learns the descriptor object the product writes for `format` by initializing a scratch remote. */
	async descriptorOid(repository: string, format: ClaimStorageFormat): Promise<string> {
		const scratch = await this.decoy(`scratch-${format}`);
		const options = { ...this.options(repository), remote: scratch.url, format };
		expectKind(await initializeClaimStorage(options), "created");
		const oid = (await this.serverRefs(scratch.repo))[DESCRIPTOR_REF];
		if (!oid) throw new Error(`scratch initialization left no ${format} descriptor`);
		return oid;
	}

	/** Pushes raw bytes as a blob with a create-only lease, the way an independent competing writer would. */
	async pushBlob(repository: string, ref: string, text: string): Promise<string> {
		const oid = (await server().git(repository, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(repository, ["push", "--porcelain", `--force-with-lease=${ref}:`, this.url, `${oid}:${ref}`]);
		return oid;
	}

	/** Makes the server decline every further push, as a hosting policy hook would. */
	async rejectPushes(): Promise<void> {
		const hook = join(this.serverRepo, "hooks", "pre-receive");
		await writeFile(hook, "#!/bin/sh\necho fixture-host-policy-reject >&2\nexit 1\n");
		await chmod(hook, 0o755);
	}

	/** Lets the server accept pushes again after `rejectPushes`. */
	async acceptPushes(): Promise<void> {
		const hook = join(this.serverRepo, "hooks", "pre-receive");
		await writeFile(hook, "#!/bin/sh\nexit 0\n");
		await chmod(hook, 0o755);
	}

	/**
	 * Makes the client's object store read-only so local object creation fails before any push; returns
	 * the undo. Throws instead of passing vacuously when writes still succeed (for example as root).
	 */
	async freezeObjects(repository: string): Promise<() => Promise<void>> {
		const objects = join(repository, ".git", "objects");
		const thaw = () => chmodDirs(objects, 0o755);
		this.cleanups.push(thaw);
		await chmodDirs(objects, 0o555);
		const probe = `freeze probe ${Date.now()} ${Math.random()}\n`;
		const written = await server().git(repository, ["hash-object", "-w", "--stdin"], probe, false);
		if (written.rc === 0) throw new Error("object store stayed writable after chmod (running as root?)");
		return thaw;
	}

	async gc(): Promise<void> {
		await server().git(this.serverRepo, ["reflog", "expire", "--expire=now", "--all"]);
		await server().git(this.serverRepo, ["gc", "--quiet", "--prune=now"]);
		await server().git(this.serverRepo, ["fsck", "--full", "--no-reflogs"]);
	}

	/** Runs the product API in a child process so a hostile Git environment cannot leak into this test process. */
	async probe(env: Record<string, string>, input: ProbeInput): Promise<ProbeReport> {
		const child = Bun.spawn([process.execPath, ENV_PROBE, JSON.stringify(input)], {
			cwd: this.root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const result = await finish({ args: ["claim-storage-env-probe"], child }, PROBE_TIMEOUT);
		if (result.rc !== 0) throw new Error(`env probe failed (${result.rc}): ${result.err || result.out}`);
		const report = result.out.trim().split("\n").at(-1);
		if (!report) throw new Error("env probe printed no report");
		return JSON.parse(report) as ProbeReport;
	}

	async serverRefs(repo = this.serverRepo): Promise<Record<string, string>> {
		const result = await server().git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of result.out.split("\n").filter(Boolean)) {
			const [name, oid] = line.split(" ");
			if (!name || !oid) throw new Error(`invalid for-each-ref row: ${line}`);
			refs[name] = oid;
		}
		return refs;
	}

	/** Waits, bounded, until the server's `ref` points at `oid`, so a released winner has landed. */
	async untilServerRef(ref: string, oid: string): Promise<void> {
		const deadline = Date.now() + FIXTURE_WAIT;
		while ((await this.serverRefs())[ref] !== oid) {
			if (Date.now() > deadline) throw new Error(`fixture: ${ref} did not reach ${oid}`);
			await Bun.sleep(10);
		}
	}

	/** Deletes `ref` in the server repository behind every hook, as an operator's `update-ref -d` would. */
	async deleteServerRef(ref: string): Promise<void> {
		await server().git(this.serverRepo, ["update-ref", "-d", ref]);
	}

	async objectType(oid: string): Promise<string> {
		return (await server().git(this.serverRepo, ["cat-file", "-t", oid])).out.trim();
	}

	async objectTypes(repo = this.serverRepo): Promise<string[]> {
		const args = ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"];
		return (await server().git(repo, args)).out.split("\n").filter(Boolean);
	}

	async readJson(oid: string): Promise<unknown> {
		return JSON.parse((await server().git(this.serverRepo, ["cat-file", "blob", oid])).out);
	}

	async localState(path: string): Promise<LocalState> {
		const refs = await server().git(path, [
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/heads",
			"refs/tags",
			"refs/remotes",
		]);
		const head = await server().git(path, ["symbolic-ref", "HEAD"]);
		return {
			refs: refs.out.split("\n").filter(Boolean),
			head: head.out.trim(),
			fetchHead: await Bun.file(join(path, ".git", "FETCH_HEAD")).text(),
		};
	}

	async dispose(): Promise<void> {
		await this.gates.releaseAll();
		await Promise.all(this.cleanups.map((cleanup) => cleanup().catch(() => undefined)));
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: AdapterCase) => Promise<void>,
): Promise<void> {
	const fixture = await AdapterCase.create(format, caseName);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("claim storage format configuration", () => {
	test("accepts exactly the three storage formats and never falls back to a default", () => {
		for (const format of STORAGE_FORMATS) {
			expect(parseClaimStorageFormat(format)).toEqual({ kind: "valid", format });
		}
		const invalid = [
			undefined,
			null,
			"",
			"Blob",
			" blob",
			"blob ",
			"git-blob",
			"commit_chain",
			1,
			["blob"],
			{ format: "blob" },
		];
		for (const raw of invalid) {
			const parsed = parseClaimStorageFormat(raw);
			expect({ raw, kind: parsed.kind }).toEqual({ raw, kind: "invalid" });
			if (parsed.kind === "invalid") expect(parsed.reason.length).toBeGreaterThan(0);
		}
	});
});

for (const format of ADAPTER_FORMATS) {
	describe(`${format} claim storage adapter`, () => {
		test(
			"initializes an empty remote with only a format descriptor blob and is idempotent",
			async () => {
				await withCase(format, "init", async (fixture) => {
					const created = await initializeClaimStorage(fixture.options(await fixture.client("a")));
					expect(created).toEqual({ kind: "created", descriptor: descriptorOf(format) });
					const refs = await fixture.serverRefs();
					expect(Object.keys(refs)).toEqual([DESCRIPTOR_REF]);
					const oid = refs[DESCRIPTOR_REF] ?? "";
					expect(await fixture.objectType(oid)).toBe("blob");
					expect(await fixture.readJson(oid)).toEqual(descriptorOf(format));
					expect(await fixture.objectTypes()).toEqual(["blob"]);

					const again = await initializeClaimStorage(fixture.options(await fixture.client("b")));
					expect(again).toEqual({ kind: "exists", descriptor: descriptorOf(format) });
					expect(await fixture.serverRefs()).toEqual(refs);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a descriptor of another format as conflict without replacing it",
			async () => {
				await withCase(format, "init-conflict", async (fixture) => {
					const foreign = descriptorOf(otherFormat(format));
					const oid = await fixture.setDescriptor(foreign);
					const result = await initializeClaimStorage(fixture.options(await fixture.client("a")));
					expect(result).toEqual({ kind: "conflict", descriptor: foreign });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: oid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"refuses to open without a descriptor of the configured format and never creates one",
			async () => {
				await withCase(format, "preflight", async (fixture) => {
					const client = await fixture.client("a");
					expect(await openClaimStore(fixture.options(client))).toEqual({ kind: "descriptor-missing" });
					expect(await fixture.serverRefs()).toEqual({});

					const foreign = descriptorOf(otherFormat(format));
					const oid = await fixture.setDescriptor(foreign);
					expect(await openClaimStore(fixture.options(client))).toEqual({
						kind: "format-mismatch",
						descriptor: foreign,
					});
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: oid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"opens a matching store and reads a missing ticket as absent without creating it",
			async () => {
				await withCase(format, "absent", async (fixture) => {
					const oid = await fixture.setDescriptor(descriptorOf(format));
					const opened = expectKind(await openClaimStore(fixture.options(await fixture.client("a"))), "open");
					expect(opened.descriptor).toEqual(descriptorOf(format));
					expect(await opened.store.read(TICKET)).toEqual({ kind: "absent", ticket: TICKET });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: oid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			`creates revision 1 as a single ${format} without ${format === "commit-chain" ? "extra commits" : "commits"} or branch refs`,
			async () => {
				await withCase(format, "create", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const base = expectKind(await store.read(TICKET), "absent");
					const result = expectKind(await store.write(base, CLAIM_A), "applied");
					const document = {
						...descriptorOf(format),
						ticket: TICKET,
						revision: 1,
						payload: CLAIM_A.payload,
						receipts: { [CLAIM_A.operationId]: CLAIM_A.receipt },
					};
					expect(result.document).toEqual(document);
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid, [TICKET_REF]: result.root });
					expect(await fixture.objectType(result.root)).toBe(ROOT_OBJECT_TYPE[format]);
					expect(await fixture.readStored(result.root)).toEqual(document);
					expect((await fixture.objectTypes()).sort(byCodeUnits)).toEqual(CREATED_OBJECT_TYPES[format]);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"appends one receipt per update and an independent client always reads the current state",
			async () => {
				await withCase(format, "update", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const writer = await fixture.client("writer");
					const reader = await fixture.client("reader");
					const before = await Promise.all([fixture.localState(writer), fixture.localState(reader)]);
					const writes = await fixture.open(writer);
					const reads = await fixture.open(reader);

					const first = expectKind(
						await writes.write(expectKind(await writes.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					expect(await reads.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: first.root,
						document: first.document,
					});

					const second = expectKind(
						await writes.write(expectKind(await writes.read(TICKET), "present"), RENEW_A),
						"applied",
					);
					expect(second.document).toEqual({
						...first.document,
						revision: 2,
						payload: RENEW_A.payload,
						receipts: { ...first.document.receipts, [RENEW_A.operationId]: RENEW_A.receipt },
					});
					expect(second.root).not.toBe(first.root);
					expect(await fixture.readStored(second.root)).toEqual(second.document);
					expect(await reads.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: second.root,
						document: second.document,
					});
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(second.root);
					expect(await Promise.all([fixture.localState(writer), fixture.localState(reader)])).toEqual(before);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rejects a stale base as stale and leaves the remote unchanged",
			async () => {
				await withCase(format, "stale", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const winner = await fixture.open(await fixture.client("winner"));
					const loser = await fixture.open(await fixture.client("loser"));

					const absent = expectKind(await loser.read(TICKET), "absent");
					const first = expectKind(
						await winner.write(expectKind(await winner.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					expect(await loser.write(absent, CLAIM_B)).toMatchObject({ kind: "rejected", cause: "stale" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(first.root);

					const outdated = expectKind(await loser.read(TICKET), "present");
					const second = expectKind(
						await winner.write(expectKind(await winner.read(TICKET), "present"), RENEW_A),
						"applied",
					);
					expect(await loser.write(outdated, RENEW_B)).toMatchObject({ kind: "rejected", cause: "stale" });
					expect(await winner.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: second.root,
						document: second.document,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"never reuses an earlier root, so a stale base stays rejected after release and reclaim",
			async () => {
				await withCase(format, "tombstone", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const client = await fixture.client("a");
					const before = await fixture.localState(client);
					const store = await fixture.open(client);
					const stale = await fixture.open(await fixture.client("stale"));

					const claimed = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					const outdated = expectKind(await stale.read(TICKET), "present");
					const released = expectKind(
						await store.write(expectKind(await store.read(TICKET), "present"), RELEASE_A),
						"applied",
					);
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(released.root);
					const reclaimed = expectKind(
						await store.write(expectKind(await store.read(TICKET), "present"), RECLAIM_A),
						"applied",
					);
					expect(reclaimed.document.payload).toEqual(claimed.document.payload);
					expect(reclaimed.document.revision).toBe(3);
					expect(new Set([claimed.root, released.root, reclaimed.root]).size).toBe(3);

					expect(await stale.write(outdated, RENEW_B)).toMatchObject({ kind: "rejected", cause: "stale" });
					const refs = await fixture.serverRefs();
					expect(refs[TICKET_REF]).toBe(reclaimed.root);
					expect(Object.keys(refs).filter((ref) => !ref.startsWith("refs/claim"))).toEqual([]);
					expect(await fixture.readStored(reclaimed.root)).toEqual(reclaimed.document);
					expect(await fixture.localState(client)).toEqual(before);
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage input validation`, () => {
		test(
			"accepts only canonical ticket IDs and leaves the remote untouched for all others",
			async () => {
				await withCase(format, "tickets", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					for (const ticket of VALID_TICKETS) {
						expect(await store.read(ticket)).toEqual({ kind: "absent", ticket });
					}
					for (const ticket of INVALID_TICKETS) {
						const read = await store.read(ticket);
						const written = await store.write({ kind: "absent", ticket }, CLAIM_A);
						expect({ ticket, read: read.kind, written: written.kind }).toEqual({
							ticket,
							read: "invalid",
							written: "invalid",
						});
					}
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid });

					const dotted = expectKind(await store.write({ kind: "absent", ticket: "BACK-7.2" }, CLAIM_A), "applied");
					expect((await fixture.serverRefs())["refs/claims/BACK-7.2"]).toBe(dotted.root);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rejects invalid operation IDs, duplicate receipts and non-JSON values without changing the remote",
			async () => {
				await withCase(format, "changes", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const absent = expectKind(await store.read(TICKET), "absent");
					for (const operationId of INVALID_OPERATION_IDS) {
						const result = await store.write(absent, { ...CLAIM_A, operationId });
						expect({ operationId, kind: result.kind }).toEqual({ operationId, kind: "invalid" });
					}
					for (const [label, change] of Object.entries(NON_JSON_CHANGES)) {
						const result = await store.write(absent, change as ClaimChange);
						expect({ label, kind: result.kind }).toEqual({ label, kind: "invalid" });
					}
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid });

					const first = expectKind(await store.write(absent, CLAIM_A), "applied");
					const present = expectKind(await store.read(TICKET), "present");
					const duplicate = await store.write(present, { ...RENEW_A, operationId: CLAIM_A.operationId });
					expect(duplicate).toMatchObject({ kind: "invalid" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(first.root);
				});
			},
			TEST_TIMEOUT,
		);

		// Commit-chain derives the revision from the chain length: a MAX_SAFE_INTEGER revision is only
		// constructible as a truncated chain, which reads as corrupt. The shared guard stays covered by blob/tree.
		test.skipIf(format === "commit-chain")(
			"refuses to write past the largest safe revision",
			async () => {
				await withCase(format, "overflow", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const oid = await fixture.storeDocument(TICKET_REF, documentAfterClaim(format, Number.MAX_SAFE_INTEGER));
					const store = await fixture.open(await fixture.client("a"));
					const base = expectKind(await store.read(TICKET), "present");
					expect(base.document.revision).toBe(Number.MAX_SAFE_INTEGER);
					expect(await store.write(base, RENEW_A)).toMatchObject({ kind: "invalid" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rejects a present base whose snapshot no longer matches its root",
			async () => {
				await withCase(format, "forged-base", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const first = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					const present = expectKind(await store.read(TICKET), "present");
					const document = present.document;
					const forgedReceipts = { [CLAIM_A.operationId]: { action: "forged" } };
					const forgeries: Record<string, ClaimSnapshot> = {
						"receipt removed": { ...present, document: { ...document, receipts: {} } },
						"receipt changed": { ...present, document: { ...document, receipts: forgedReceipts } },
						"revision raised": { ...present, document: { ...document, revision: document.revision + 1 } },
						"payload changed": { ...present, document: { ...document, payload: { state: "free" } } },
						"epoch changed": { ...present, document: { ...document, epoch: document.epoch + 1 } },
						"document ticket changed": { ...present, document: { ...document, ticket: OTHER_TICKET } },
						"snapshot ticket changed": { ...present, ticket: OTHER_TICKET },
					};
					for (const [label, base] of Object.entries(forgeries)) {
						const result = await store.write(base, RENEW_A);
						expect({ label, kind: result.kind }).toEqual({ label, kind: "invalid" });
					}
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid, [TICKET_REF]: first.root });

					const genuine = expectKind(await store.write(present, RENEW_A), "applied");
					expect(genuine.document.revision).toBe(2);
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage document encoding`, () => {
		test(
			"stores canonical JSON bytes so every root is predictable from its document",
			async () => {
				await withCase(format, "canonical", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const first = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), UNSORTED_A),
						"applied",
					);
					const claimed = documentOf(format, TICKET, 1, UNSORTED_A.payload, receiptsOf(UNSORTED_A));
					expect(await fixture.storedStateText(first.root)).toBe(expectedStateText(format, claimed));
					expect(first.root).toBe(await fixture.expectedRoot(claimed));

					const second = expectKind(
						await store.write(expectKind(await store.read(TICKET), "present"), UNSORTED_B),
						"applied",
					);
					const renewed = documentOf(format, TICKET, 2, UNSORTED_B.payload, receiptsOf(UNSORTED_A, UNSORTED_B));
					expect(await fixture.storedStateText(second.root)).toBe(expectedStateText(format, renewed));
					expect(second.root).toBe(await fixture.expectedRoot(claimed, renewed));
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"keeps __proto__ and constructor keys as plain JSON data",
			async () => {
				await withCase(format, "proto-keys", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const result = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), PROTO_CHANGE),
						"applied",
					);
					const expected = documentOf(format, TICKET, 1, PROTO_CHANGE.payload, receiptsOf(PROTO_CHANGE));
					expect(canonicalJson(result.document)).toBe(canonicalJson(expected));
					expect(await fixture.storedStateText(result.root)).toBe(expectedStateText(format, expected));
					expect(result.root).toBe(await fixture.expectedRoot(expected));

					const reader = await fixture.open(await fixture.client("b"));
					const reread = expectKind(await reader.read(TICKET), "present");
					expect(canonicalJson(reread.document)).toBe(canonicalJson(expected));
					expect(Object.hasOwn(reread.document.payload, "__proto__")).toBe(true);
					expect("polluted" in {}).toBe(false);
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage corruption handling`, () => {
		test(
			"classifies unsupported and malformed descriptors without replacing them",
			async () => {
				await withCase(format, "corrupt-descriptor", async (fixture) => {
					const client = await fixture.client("a");
					const unsupported = await fixture.setDescriptor({ ...descriptorOf(format), schema: 2 });
					expect(await openClaimStore(fixture.options(client))).toEqual({ kind: "schema-unsupported" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: unsupported });

					const malformed: Record<string, string> = {
						"not JSON": "not json\n",
						"JSON array": "[]\n",
						"missing epoch": `${JSON.stringify({ schema: 1, format })}\n`,
						"unknown format": `${JSON.stringify({ schema: 1, format: "git-blob", epoch: 1 })}\n`,
					};
					for (const [label, text] of Object.entries(malformed)) {
						const oid = await fixture.setBlob(DESCRIPTOR_REF, text);
						const opened = await openClaimStore(fixture.options(client));
						const initialized = await initializeClaimStorage(fixture.options(client));
						expect({ label, kind: opened.kind }).toEqual({ label, kind: "corrupt" });
						expect({ label, kind: initialized.kind }).toEqual({ label, kind: "corrupt" });
						expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: oid });
					}

					const tree = await fixture.setEmptyTree(DESCRIPTOR_REF);
					expect(await openClaimStore(fixture.options(client))).toMatchObject({ kind: "corrupt" });
					expect(await initializeClaimStorage(fixture.options(client))).toMatchObject({ kind: "corrupt" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: tree });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports malformed or inconsistent ticket documents as corrupt",
			async () => {
				await withCase(format, "corrupt-ticket", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const valid = documentAfterClaim(format, 1);
					const validOid = await fixture.storeDocument(TICKET_REF, valid);
					expect(await store.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: validOid,
						document: valid,
					});

					const receipts = valid.receipts;
					const corruptions: Record<string, () => Promise<string>> = {
						"not JSON": () => fixture.storeStateText(TICKET_REF, "{\n", receipts),
						"JSON array": () => fixture.storeStateText(TICKET_REF, "[]\n", receipts),
						"other ticket": () => fixture.storeDocument(TICKET_REF, { ...valid, ticket: OTHER_TICKET }),
						"other format": () => fixture.storeDocument(TICKET_REF, { ...valid, format: otherFormat(format) }),
						"other epoch": () => fixture.storeDocument(TICKET_REF, { ...valid, epoch: 2 }),
						"other schema": () => fixture.storeDocument(TICKET_REF, { ...valid, schema: 2 }),
						"revision 0": () => fixture.storeDocument(TICKET_REF, { ...valid, revision: 0 }),
						"fractional revision": () => fixture.storeDocument(TICKET_REF, { ...valid, revision: 1.5 }),
						"unsafe revision": () =>
							fixture.storeDocument(TICKET_REF, { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 }),
						"payload array": () => fixture.storeDocument(TICKET_REF, { ...valid, payload: [] }),
						"receipt not an object": () =>
							fixture.storeDocument(TICKET_REF, { ...valid, receipts: { [CLAIM_A.operationId]: "done" } }),
						"receipts missing": () => fixture.storeDocument(TICKET_REF, stateOf(valid)),
					};
					for (const [label, corrupt] of Object.entries(corruptions)) {
						const oid = await corrupt();
						const read = await store.read(TICKET);
						expect({ label, kind: read.kind }).toEqual({ label, kind: "corrupt" });
						expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
					}

					const wrongType = await fixture.storeWrongRootType(TICKET_REF, valid);
					expect(await store.read(TICKET)).toMatchObject({ kind: "corrupt" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(wrongType);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a descriptor wrapped in an annotated tag as corrupt without changing the ref",
			async () => {
				await withCase(format, "descriptor-tag", async (fixture) => {
					const client = await fixture.client("a");
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					expectKind(await openClaimStore(fixture.options(client)), "open");
					const descriptorTag = await fixture.point(DESCRIPTOR_REF, await fixture.tagObject(descriptorOid, "blob"));
					expect(await openClaimStore(fixture.options(client))).toMatchObject({ kind: "corrupt" });
					expect(await initializeClaimStorage(fixture.options(client))).toMatchObject({ kind: "corrupt" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorTag });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a claim root wrapped in an annotated tag as corrupt without changing the ref",
			async () => {
				await withCase(format, "root-tag", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const valid = documentAfterClaim(format, 1);
					const validOid = await fixture.storeDocument(TICKET_REF, valid);
					expect(await store.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: validOid,
						document: valid,
					});
					const rootTag = await fixture.point(TICKET_REF, await fixture.tagObject(validOid, ROOT_OBJECT_TYPE[format]));
					expect(await store.read(TICKET)).toMatchObject({ kind: "corrupt" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid, [TICKET_REF]: rootTag });
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage transport isolation`, () => {
		test(
			"rejects option-shaped, whitespace and named remotes before running git",
			async () => {
				await withCase(format, "remote-injection", async (fixture) => {
					const decoy = await fixture.decoy();
					const client = await fixture.client("a");
					await server().git(client, ["remote", "add", "origin", fixture.url]);
					await server().git(client, ["remote", "set-url", "--add", "--push", "origin", fixture.url]);
					await server().git(client, ["remote", "set-url", "--add", "--push", "origin", decoy.url]);
					const marker = join(fixture.root, "injected");
					const remotes = [
						`--upload-pack=touch ${marker}`,
						`--receive-pack=touch ${marker}`,
						`ext::sh -c touch% ${marker}`,
						"origin",
						`${fixture.url}\n`,
						` ${fixture.url}`,
						`${fixture.url} `,
						"",
					];
					for (const remote of remotes) {
						const options = { ...fixture.options(client), remote };
						const initialized = await initializeClaimStorage(options);
						const opened = await openClaimStore(options);
						expect({ remote, kind: initialized.kind }).toEqual({ remote, kind: "invalid" });
						expect({ remote, kind: opened.kind }).toEqual({ remote, kind: "invalid" });
					}
					expect(await Bun.file(marker).exists()).toBe(false);
					expect(await fixture.serverRefs()).toEqual({});
					expect(await fixture.serverRefs(decoy.repo)).toEqual({});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"fails closed on effective URL rewrites in the repository config but ignores unrelated ones",
			async () => {
				await withCase(format, "local-rewrite", async (fixture) => {
					const decoy = await fixture.decoy();
					for (const key of ["insteadOf", "pushInsteadOf"]) {
						const client = await fixture.client(`rewrite-${key}`);
						await server().git(client, ["config", `url.${decoy.url}.${key}`, fixture.url]);
						const initialized = await initializeClaimStorage(fixture.options(client));
						const opened = await openClaimStore(fixture.options(client));
						expect({ key, kind: initialized.kind }).toEqual({ key, kind: "invalid" });
						expect({ key, kind: opened.kind }).toEqual({ key, kind: "invalid" });
					}
					expect(await fixture.serverRefs()).toEqual({});
					expect(await fixture.serverRefs(decoy.repo)).toEqual({});

					const control = await fixture.client("rewrite-unrelated");
					await server().git(control, ["config", `url.${decoy.url}.insteadOf`, "git://unrelated.invalid/"]);
					const created = await initializeClaimStorage(fixture.options(control));
					expect(created).toEqual({ kind: "created", descriptor: descriptorOf(format) });
					expect(await fixture.serverRefs(decoy.repo)).toEqual({});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ignores inherited Git routing overrides and writes only to the configured endpoint",
			async () => {
				await withCase(format, "hostile-env", async (fixture) => {
					const decoy = await fixture.decoy();
					const decoyClient = await fixture.client("decoy-client");
					const client = await fixture.client("a");
					const home = join(fixture.root, "home-clean");
					await mkdir(home);
					const hostileGlobal = join(fixture.root, "hostile-gitconfig");
					await writeFile(hostileGlobal, rewriteConfig(decoy.url, fixture.url, ["insteadOf", "pushInsteadOf"]));
					const decoyState = await fixture.localState(decoyClient);
					const decoyObjects = await fixture.objectTypes(decoyClient);
					const clientState = await fixture.localState(client);

					const env = probeEnv({
						HOME: home,
						XDG_CONFIG_HOME: join(home, ".config"),
						GIT_CONFIG_GLOBAL: hostileGlobal,
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: `url.${decoy.url}.pushInsteadOf`,
						GIT_CONFIG_VALUE_0: fixture.url,
						GIT_CONFIG_PARAMETERS: `'url.${decoy.url}.insteadof'='${fixture.url}'`,
						GIT_DIR: join(decoyClient, ".git"),
						GIT_WORK_TREE: decoyClient,
						GIT_OBJECT_DIRECTORY: join(decoyClient, ".git", "objects"),
					});
					const report = await fixture.probe(env, { ...fixture.options(client), ticket: TICKET, change: CLAIM_A });
					const refs = await fixture.serverRefs();
					expect(report).toEqual({
						initialized: "created",
						opened: "open",
						read: "absent",
						written: "applied",
						root: refs[TICKET_REF],
					});
					expect(Object.keys(refs)).toEqual([DESCRIPTOR_REF, TICKET_REF]);
					expect(await fixture.serverRefs(decoy.repo)).toEqual({});
					expect(await fixture.localState(decoyClient)).toEqual(decoyState);
					expect(await fixture.objectTypes(decoyClient)).toEqual(decoyObjects);
					expect(await fixture.localState(client)).toEqual(clientState);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"fails closed on an effective URL rewrite in the default global config",
			async () => {
				await withCase(format, "global-rewrite", async (fixture) => {
					const decoy = await fixture.decoy();
					const client = await fixture.client("a");
					const home = join(fixture.root, "home-rewrite");
					await mkdir(home);
					await writeFile(join(home, ".gitconfig"), rewriteConfig(decoy.url, fixture.url, ["insteadOf"]));
					const env = probeEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, ["GIT_CONFIG_GLOBAL"]);
					const report = await fixture.probe(env, { ...fixture.options(client), ticket: TICKET, change: CLAIM_A });
					expect(report).toEqual({ initialized: "invalid", opened: "invalid" });
					expect(await fixture.serverRefs()).toEqual({});
					expect(await fixture.serverRefs(decoy.repo)).toEqual({});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"keeps concurrent reads of different tickets in one repository isolated",
			async () => {
				await withCase(format, "parallel-reads", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const claimed = documentAfterClaim(format, 1);
					const other = documentOf(format, OTHER_TICKET, 1, CLAIM_B.payload, receiptsOf(CLAIM_B));
					const claimedOid = await fixture.storeDocument(TICKET_REF, claimed);
					const otherOid = await fixture.storeDocument(`refs/claims/${OTHER_TICKET}`, other);
					const client = await fixture.client("a");
					const before = await fixture.localState(client);
					const [left, right] = await Promise.all([fixture.open(client), fixture.open(client)]);

					const reads = await Promise.all([
						left.read(TICKET),
						right.read(OTHER_TICKET),
						left.read(OTHER_TICKET),
						right.read(TICKET),
						left.read("BACK-3"),
					]);
					const one: ClaimSnapshot = { kind: "present", ticket: TICKET, root: claimedOid, document: claimed };
					const two: ClaimSnapshot = { kind: "present", ticket: OTHER_TICKET, root: otherOid, document: other };
					expect(reads).toEqual([one, two, two, one, { kind: "absent", ticket: "BACK-3" }]);
					expect(await fixture.localState(client)).toEqual(before);
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage network behaviour`, () => {
		test(
			"lets exactly one of two concurrent same-format initializers create the descriptor",
			async () => {
				await withCase(format, "init-race", async (fixture) => {
					const [left, right] = await Promise.all([fixture.client("left"), fixture.client("right")]);
					const results = await Promise.all([
						initializeClaimStorage(fixture.options(left)),
						initializeClaimStorage(fixture.options(right)),
					]);
					const kinds = results.map((result) => result.kind).sort(byCodeUnits);
					// Positive control (catches: two creators, a lost descriptor, a foreign format): one initializer created.
					expect([
						["created", "exists"],
						["created", "unknown"],
					]).toContainEqual(kinds);
					const refs = await fixture.serverRefs();
					expect(Object.keys(refs)).toEqual([DESCRIPTOR_REF]);
					expect(await fixture.readJson(refs[DESCRIPTOR_REF] ?? "")).toEqual(descriptorOf(format));
					const again = await initializeClaimStorage(fixture.options(left));
					expect(again).toEqual({ kind: "exists", descriptor: descriptorOf(format) });
					// (catches: the same-format loser left `unknown` on the `=` path): RED only when the race
					// lands on `=`, so probabilistic; the deterministic row over PushHoldProxy follows below.
					expect(kinds).toEqual(["created", "exists"]);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports conflict when a foreign descriptor lands while initialization is held in the receive hook",
			async () => {
				await withCase(format, "init-format-race", async (fixture) => {
					const client = await fixture.client("a");
					const rival = await fixture.client("rival");
					const ownOid = await fixture.descriptorOid(client, format);
					const foreign = descriptorOf(otherFormat(format));
					await fixture.gates.arm("pre", ownOid);
					const pending = initializeClaimStorage(fixture.options(client));
					await fixture.gates.entered("pre", ownOid);

					const foreignOid = await fixture.pushBlob(rival, DESCRIPTOR_REF, `${JSON.stringify(foreign)}\n`);
					await fixture.gates.release("pre", ownOid);
					expect(await pending).toEqual({ kind: "conflict", descriptor: foreign });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: foreignOid });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports exists to a same-format initializer whose push finds the identical descriptor already landed",
			async () => {
				await withCase(format, "init-identical", async (fixture) => {
					const proxy = await fixture.pushHoldProxy();
					const [probe, late, early] = await Promise.all([
						fixture.client("probe"),
						fixture.client("late"),
						fixture.client("early"),
					]);
					// Positive control (catches: a proxy that holds nothing or forwards nothing; the loser below would then end
					// `unknown` by its timeout): a raw push to a decoy repository through the proxy is held, then lands.
					const decoy = await fixture.decoy();
					const blob = await fixture.writeBlob(probe, "push hold probe\n");
					const decoyViaProxy = decoy.url.replace(`127.0.0.1:${server().port}/`, `127.0.0.1:${proxy.port}/`);
					const probing = server().git(probe, ["push", "--porcelain", decoyViaProxy, `${blob}:refs/probe/held`]);
					await proxy.untilHeld(1);
					proxy.release();
					await probing;
					expect(await fixture.serverRefs(decoy.repo)).toEqual({ "refs/probe/held": blob });

					// Positive control (catches: a proxy that classifies a connection by its first data event; Git writes a
					// pkt-line's length and payload in two writes): a push request whose length arrives alone is held too.
					const request = "git-receive-pack /split-control.git\0host=127.0.0.1\0";
					const split = createConnection({ host: "127.0.0.1", port: proxy.port });
					split.on("error", () => undefined);
					await new Promise<void>((resolve) => split.once("connect", () => resolve()));
					const partialBefore = proxy.partialFirstPackets;
					split.write((request.length + 4).toString(16).padStart(4, "0"));
					const deadline = Date.now() + FIXTURE_WAIT;
					while (proxy.partialFirstPackets <= partialBefore) {
						if (Date.now() > deadline) throw new Error("push hold proxy: no first packet arrived without its payload");
						await Bun.sleep(10);
					}
					split.write(request);
					await proxy.untilHeld(1);
					split.destroy();
					proxy.release();

					// The late initializer reads the descriptor as absent through the proxy and its push
					// waits there before any ref advertisement; the early one initializes directly. Released, the late push
					// meets the identical descriptor blob, and Git answers `=` before any lease check (ep-g08).
					const lateStarted = proxy.elapsed();
					const pending = initializeClaimStorage({ ...fixture.options(late), remote: fixture.viaPort(proxy.port) });
					let lateEnded: number | undefined;
					void pending
						.finally(() => {
							lateEnded = proxy.elapsed();
						})
						.catch(() => undefined);
					await proxy.untilHeld(1).catch(async (error: unknown) => {
						// Diagnosis: without a held push the late initializer ended, or still hangs, before pushing; its
						// outcome and the proxy's connection log name the step (routing check, descriptor read, blob write).
						const settled = pending.catch((reason: unknown) => ({ rejected: String(reason) }));
						// Short, so that this message still beats TEST_TIMEOUT after an exhausted FIXTURE_WAIT.
						const outcome = await Promise.race([settled, Bun.sleep(1_000).then(() => "still pending")]);
						const late = `started @${lateStarted} ms, ended @${lateEnded ?? "-"} ms with ${JSON.stringify(outcome)}`;
						throw new Error(
							`${error instanceof Error ? error.message : error}; late initializer ${late}; ${proxy.connectionLog}`,
						);
					});
					const created = await initializeClaimStorage(fixture.options(early));
					expect(created).toEqual({ kind: "created", descriptor: descriptorOf(format) });
					const landed = await fixture.serverRefs();
					expect(Object.keys(landed)).toEqual([DESCRIPTOR_REF]);
					proxy.release();
					const result = await pending;
					expect(await fixture.serverRefs()).toEqual(landed);
					// (catches: the same-format loser left `unknown` on the `=` path): after `=` the
					// descriptor is read again, as after a rejected push.
					expect(result).toEqual({ kind: "exists", descriptor: descriptorOf(format) });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"lets exactly one of two gated concurrent writers win and leaves the winner unchanged",
			async () => {
				await withCase(format, "write-race", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const left = await fixture.open(await fixture.client("left"));
					const right = await fixture.open(await fixture.client("right"));
					const leftBase = expectKind(await left.read(TICKET), "absent");
					const rightBase = expectKind(await right.read(TICKET), "absent");
					const leftDocument = documentAfterClaim(format, 1);
					const rightDocument = documentOf(format, TICKET, 1, CLAIM_B.payload, receiptsOf(CLAIM_B));
					const leftOid = await fixture.expectedRoot(leftDocument);
					const rightOid = await fixture.expectedRoot(rightDocument);
					await Promise.all([fixture.gates.arm("pre", leftOid), fixture.gates.arm("pre", rightOid)]);
					const racing = Promise.all([left.write(leftBase, CLAIM_A), right.write(rightBase, CLAIM_B)]);
					await Promise.all([fixture.gates.entered("pre", leftOid), fixture.gates.entered("pre", rightOid)]);
					// Sequential release: both writers passed their client lease check; the left one lands
					// before the right one meets it at the server's old-value check. Released together, the loser may fail at the
					// ref lock and re-read before the winner's commit, where `remote` is correct.
					await fixture.gates.release("pre", leftOid);
					await fixture.untilServerRef(TICKET_REF, leftOid);
					await fixture.gates.release("pre", rightOid);
					const [leftResult, rightResult] = await racing;

					// Positive control (catches: two winners, a lost winner, a loser that overwrote the ref).
					const leftWon = leftResult.kind === "applied";
					const winner = expectKind(leftWon ? leftResult : rightResult, "applied");
					expect((leftWon ? rightResult : leftResult).kind).toBe("rejected");
					expect(winner.root).toBe(leftWon ? leftOid : rightOid);
					const winnerDocument = leftWon ? leftDocument : rightDocument;
					expect(await fixture.storedStateText(winner.root)).toBe(expectedStateText(format, winnerDocument));
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(winner.root);
					expect(await right.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: winner.root,
						document: winner.document,
					});
					// (catches: the overlapping loser read as `remote`, a root or server text in the reason;
					// amended): the refusal is read again and the ref no longer holds the loser's absent base.
					expect(leftWon ? rightResult : leftResult).toEqual(REREAD_STALE);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"rejects a write held in the receive hook while a newer write landed",
			async () => {
				await withCase(format, "delayed", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const late = await fixture.open(await fixture.client("late"));
					const early = await fixture.open(await fixture.client("early"));
					const lateBase = expectKind(await late.read(TICKET), "absent");
					const lateOid = await fixture.expectedRoot(documentAfterClaim(format, 1));
					await fixture.gates.arm("pre", lateOid);
					const pending = late.write(lateBase, CLAIM_A);
					await fixture.gates.entered("pre", lateOid);

					const newer = expectKind(
						await early.write(expectKind(await early.read(TICKET), "absent"), CLAIM_B),
						"applied",
					);
					await fixture.gates.release("pre", lateOid);
					const result = await pending;
					// Positive control (catches: a late write that landed over the newer one, a newer write that got lost).
					expect(result).toMatchObject({ kind: "rejected" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(newer.root);
					expect(await early.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: newer.root,
						document: newer.document,
					});
					// (catches: a create refused after the ref appeared read as `remote`/): the
					// late client's lease check saw the ref absent, the server's old-value check refused after the early write.
					expect(result).toEqual(REREAD_STALE);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports an update refused while the ticket ref moved on or vanished as stale",
			async () => {
				await withCase(format, "moved-vanished", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const late = await fixture.open(await fixture.client("late"));
					const early = await fixture.open(await fixture.client("early"));
					const outcomes: { label: string; result: unknown }[] = [];
					// Late reads the ticket present and its renew waits at the pre-receive gate after its client
					// lease check; meanwhile early renews the ticket (moved) or an operator deletes the ref (vanished).
					for (const [ticket, label] of [
						[TICKET, "moved"],
						[OTHER_TICKET, "vanished"],
					] as const) {
						const ref = `refs/claims/${ticket}`;
						const first = expectKind(await early.write({ kind: "absent", ticket }, CLAIM_A), "applied");
						const lateBase = expectKind(await late.read(ticket), "present");
						const lateDocument = documentOf(format, ticket, 2, RENEW_A.payload, receiptsOf(CLAIM_A, RENEW_A));
						const lateOid = await fixture.expectedRoot(first.document, lateDocument);
						await fixture.gates.arm("pre", lateOid);
						const pending = late.write(lateBase, RENEW_A);
						await fixture.gates.entered("pre", lateOid);

						let after: string | undefined;
						if (label === "moved") {
							const earlyBase = expectKind(await early.read(ticket), "present");
							after = expectKind(await early.write(earlyBase, RENEW_B), "applied").root;
						} else {
							await fixture.deleteServerRef(ref);
						}
						await fixture.gates.release("pre", lateOid);
						const result = await pending;
						// Positive control (catches: a late renew that landed over the move or recreated the deleted ref).
						expect({ label, kind: result.kind, ref: (await fixture.serverRefs())[ref] }).toEqual({
							label,
							kind: "rejected",
							ref: after,
						});
						outcomes.push({ label, result });
					}
					// (catches: an update refused after the ref moved or vanished read as `remote`, a root or server text in
					// the reason).
					expect(outcomes).toEqual([
						{ label: "moved", result: REREAD_STALE },
						{ label: "vanished", result: REREAD_STALE },
					]);
				});
			},
			2 * TEST_TIMEOUT,
		);

		test(
			"reports a repetition refused while the identical write landed as unknown",
			async () => {
				await withCase(format, "own-root", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const late = await fixture.open(await fixture.client("late"));
					const early = await fixture.open(await fixture.client("early"));
					const outcomes: { label: string; result: unknown }[] = [];
					// Late's write passes its client lease check and waits at the pre-receive gate; meanwhile the
					// identical root (same base, same change) lands behind every hook, as the delayed first push of a repeated
					// intent does. The endpoint then refuses late's push although the ref holds exactly its root.
					for (const label of ["created", "updated"] as const) {
						const ticket = label === "created" ? TICKET : OTHER_TICKET;
						const ref = `refs/claims/${ticket}`;
						const first =
							label === "updated"
								? expectKind(await early.write({ kind: "absent", ticket }, CLAIM_A), "applied")
								: undefined;
						const lateBase: ClaimSnapshot = first
							? expectKind(await late.read(ticket), "present")
							: { kind: "absent", ticket };
						const change = first ? RENEW_A : CLAIM_A;
						const lateDocument = first
							? documentOf(format, ticket, 2, RENEW_A.payload, receiptsOf(CLAIM_A, RENEW_A))
							: documentOf(format, ticket, 1, CLAIM_A.payload, receiptsOf(CLAIM_A));
						const lateOid = first
							? await fixture.expectedRoot(first.document, lateDocument)
							: await fixture.expectedRoot(lateDocument);
						await fixture.gates.arm("pre", lateOid);
						const pending = late.write(lateBase, change);
						await fixture.gates.entered("pre", lateOid);

						// The identical root lands behind every hook: the layout encoder for blob and tree, one chain layer on
						// the base root for commit-chain.
						const parents = first ? [first.root] : [];
						const landed =
							format === "commit-chain"
								? await fixture.point(
										ref,
										await fixture.chainCommit(fixture.serverRepo, lateDocument, [change], parents),
									)
								: await fixture.storeDocument(ref, lateDocument);
						await fixture.gates.release("pre", lateOid);
						const result = await pending;
						// Positive control (catches: a landing of another root than late carries, a late write that applied).
						const now = (await fixture.serverRefs())[ref];
						expect({ label, landed, applied: result.kind === "applied", ref: now }).toEqual({
							label,
							landed: lateOid,
							applied: false,
							ref: lateOid,
						});
						outcomes.push({ label, result });
					}
					// (catches: the refused repetition of a landed write read as `stale` or `remote`, a root or server text
					// in the reason): the re-read finds the ref at exactly this write's root.
					expect(outcomes).toEqual([
						{ label: "created", result: REREAD_LANDED },
						{ label: "updated", result: REREAD_LANDED },
					]);
				});
			},
			2 * TEST_TIMEOUT,
		);

		test(
			"reports a write whose reply was lost as unknown and an identical retry as unknown",
			async () => {
				await withCase(format, "lost-reply", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const client = await fixture.client("a");
					const proxy = await fixture.dropProxy();
					const viaProxy = { ...fixture.options(client), remote: fixture.viaPort(proxy.port) };
					const lossy = expectKind(await openClaimStore(viaProxy), "open").store;
					const direct = await fixture.open(client);
					const base = expectKind(await lossy.read(TICKET), "absent");
					const document = documentAfterClaim(format, 1);
					const oid = await fixture.expectedRoot(document);
					await fixture.gates.arm("pre", oid);
					const pending = lossy.write(base, CLAIM_A);
					await fixture.gates.entered("pre", oid);
					proxy.holdReplies();
					await fixture.gates.release("pre", oid);
					await proxy.untilWithheld(`ok ${TICKET_REF}`);
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
					await proxy.drop();
					expect(await pending).toMatchObject({ kind: "unknown" });
					expect(await direct.read(TICKET)).toEqual({ kind: "present", ticket: TICKET, root: oid, document });

					expect(await direct.write(base, CLAIM_A)).toMatchObject({ kind: "unknown" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a server-side rejection as rejected by the remote without any fallback ref",
			async () => {
				await withCase(format, "hook-reject", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					const first = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					const present = expectKind(await store.read(TICKET), "present");
					await fixture.rejectPushes();

					const update = await store.write(present, RENEW_A);
					const create = await store.write({ kind: "absent", ticket: OTHER_TICKET }, CLAIM_B);
					expect(update).toMatchObject({ kind: "rejected", cause: "remote" });
					expect(create).toMatchObject({ kind: "rejected", cause: "remote" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid, [TICKET_REF]: first.root });
					expect(await store.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: first.root,
						document: first.document,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"keeps every receipt readable from a fresh client after server garbage collection",
			async () => {
				await withCase(format, "gc", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const store = await fixture.open(await fixture.client("a"));
					expectKind(await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A), "applied");
					expectKind(await store.write(expectKind(await store.read(TICKET), "present"), RENEW_A), "applied");
					const last = expectKind(
						await store.write(expectKind(await store.read(TICKET), "present"), RENEW_B),
						"applied",
					);
					expect(last.document.receipts).toEqual(receiptsOf(CLAIM_A, RENEW_A, RENEW_B));
					await fixture.gc();

					const reader = await fixture.open(await fixture.client("fresh"));
					expect(await reader.read(TICKET)).toEqual({
						kind: "present",
						ticket: TICKET,
						root: last.root,
						document: last.document,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports never-opened and stalled endpoints as unreachable within a bounded time",
			async () => {
				await withCase(format, "unreachable", async (fixture) => {
					const client = await fixture.client("a");
					const stall = await fixture.stallProxy();
					const endpoints = { "never opened": await unusedLoopbackPort(), stalled: stall.port };
					for (const [label, port] of Object.entries(endpoints)) {
						const options = { ...fixture.options(client), remote: fixture.viaPort(port), timeoutMs: SHORT_TIMEOUT };
						const openStarted = Date.now();
						const opened = await openClaimStore(options);
						const openElapsed = Date.now() - openStarted;
						const initStarted = Date.now();
						const initialized = await initializeClaimStorage(options);
						const initElapsed = Date.now() - initStarted;
						expect({ label, kind: opened.kind }).toEqual({ label, kind: "unreachable" });
						expect({ label, kind: initialized.kind }).toEqual({ label, kind: "unreachable" });
						const overdue = Math.max(openElapsed, initElapsed) >= OVERDUE_BOUND;
						expect({ label, openElapsed, initElapsed, overdue }).toMatchObject({ label, overdue: false });
					}
					expect(await fixture.serverRefs()).toEqual({});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a write held beyond its timeout as unknown and stays consistent with a later read",
			async () => {
				await withCase(format, "write-timeout", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const client = await fixture.client("a");
					const opened = await openClaimStore({ ...fixture.options(client), timeoutMs: SHORT_TIMEOUT });
					const store = expectKind(opened, "open").store;
					const base = expectKind(await store.read(TICKET), "absent");
					const oid = await fixture.expectedRoot(documentAfterClaim(format, 1));
					await fixture.gates.arm("pre", oid);
					const started = Date.now();
					const pending = store.write(base, CLAIM_A);
					await fixture.gates.entered("pre", oid);
					expect(await pending).toMatchObject({ kind: "unknown" });
					expect(Date.now() - started).toBeLessThan(OVERDUE_BOUND);
					await fixture.gates.release("pre", oid);

					const after = await (await fixture.open(await fixture.client("reader"))).read(TICKET);
					const consistent = after.kind === "absent" || (after.kind === "present" && after.root === oid);
					expect({ after, consistent }).toMatchObject({ consistent: true });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"treats a dropped endpoint after earlier success as unreachable for reads and unknown for writes",
			async () => {
				await withCase(format, "dropped", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const client = await fixture.client("a");
					const proxy = await fixture.dropProxy();
					const viaProxy = {
						...fixture.options(client),
						remote: fixture.viaPort(proxy.port),
						timeoutMs: SHORT_TIMEOUT,
					};
					const store = expectKind(await openClaimStore(viaProxy), "open").store;
					const first = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A),
						"applied",
					);
					const present = expectKind(await store.read(TICKET), "present");
					await proxy.drop();

					expect(await store.read(TICKET)).toMatchObject({ kind: "unreachable" });
					expect(await store.write(present, RENEW_A)).toMatchObject({ kind: "unknown" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(first.root);
				});
			},
			TEST_TIMEOUT,
		);
	});

	describe(`${format} claim storage outcome classification`, () => {
		test(
			"reports an initialization that failed locally before any push as not-sent",
			async () => {
				await withCase(format, "init-not-sent", async (fixture) => {
					const client = await fixture.client("a");
					const thaw = await fixture.freezeObjects(client);
					const failed = await initializeClaimStorage(fixture.options(client));
					expect({ ...failed } as Record<string, unknown>).toMatchObject({ kind: "not-sent" });
					expect(await fixture.serverRefs()).toEqual({});

					await thaw();
					const created = await initializeClaimStorage(fixture.options(client));
					expect(created).toEqual({ kind: "created", descriptor: descriptorOf(format) });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a write on an absent base that failed locally before any push as not-sent",
			async () => {
				await withCase(format, "write-absent-not-sent", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const client = await fixture.client("a");
					const store = await fixture.open(client);
					const absent = expectKind(await store.read(TICKET), "absent");
					const thaw = await fixture.freezeObjects(client);
					const failed = await store.write(absent, CLAIM_A);
					expect({ ...failed } as Record<string, unknown>).toMatchObject({ kind: "not-sent" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid });

					await thaw();
					const applied = expectKind(await store.write(absent, CLAIM_A), "applied");
					expect(applied.root).toBe(await fixture.expectedRoot(documentAfterClaim(format, 1)));
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports a write on a present base that failed locally before any push as not-sent",
			async () => {
				await withCase(format, "write-present-not-sent", async (fixture) => {
					const descriptorOid = await fixture.setDescriptor(descriptorOf(format));
					const claimed = documentAfterClaim(format, 1);
					const claimedOid = await fixture.storeDocument(TICKET_REF, claimed);
					const client = await fixture.client("a");
					const store = await fixture.open(client);
					const present = expectKind(await store.read(TICKET), "present");
					const thaw = await fixture.freezeObjects(client);
					const failed = await store.write(present, RENEW_A);
					expect({ ...failed } as Record<string, unknown>).toMatchObject({ kind: "not-sent" });
					expect(await fixture.serverRefs()).toEqual({ [DESCRIPTOR_REF]: descriptorOid, [TICKET_REF]: claimedOid });

					await thaw();
					const applied = expectKind(await store.write(present, RENEW_A), "applied");
					expect(applied.document.revision).toBe(2);
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(applied.root);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"reports an initialization declined by the server with no descriptor appearing as rejected by the remote",
			async () => {
				await withCase(format, "init-rejected", async (fixture) => {
					const client = await fixture.client("a");
					await fixture.rejectPushes();
					const declined = await initializeClaimStorage(fixture.options(client));
					expect({ ...declined } as Record<string, unknown>).toMatchObject({ kind: "rejected", cause: "remote" });
					expect(await fixture.serverRefs()).toEqual({});

					await fixture.acceptPushes();
					const created = await initializeClaimStorage(fixture.options(client));
					expect(created).toEqual({ kind: "created", descriptor: descriptorOf(format) });
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("tree claim storage layout", () => {
	test(
		"stores state and every receipt as real tree entries without a commit wrapper",
		async () => {
			await withCase("tree", "layout", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("tree"));
				const store = await fixture.open(await fixture.client("a"));
				expectKind(await store.write(expectKind(await store.read(TICKET), "absent"), CLAIM_A), "applied");
				const renewed = expectKind(
					await store.write(expectKind(await store.read(TICKET), "present"), RENEW_A),
					"applied",
				);

				const shape = (entries: Map<string, TreeEntry>) =>
					Object.fromEntries([...entries].map(([name, entry]) => [name, `${entry.mode} ${entry.type}`]));
				const entries = await fixture.treeEntries(renewed.root);
				expect(shape(entries)).toEqual({ receipts: "040000 tree", state: "100644 blob" });
				const receipts = await fixture.treeEntries(entries.get("receipts")?.oid ?? "");
				expect(shape(receipts)).toEqual({
					[CLAIM_A.operationId]: "100644 blob",
					[RENEW_A.operationId]: "100644 blob",
				});
				expect(await fixture.readJson(entries.get("state")?.oid ?? "")).toEqual(stateOf(renewed.document));
				expect(renewed.root).toBe(await fixture.expectedRoot(renewed.document));
				expect(await fixture.objectTypes()).not.toContain("commit");
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports structurally broken or commit-wrapped trees as corrupt",
		async () => {
			await withCase("tree", "corrupt-layout", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("tree"));
				const store = await fixture.open(await fixture.client("a"));
				const valid = documentAfterClaim("tree", 1);
				const validOid = await fixture.storeDocument(TICKET_REF, valid);
				expect(await store.read(TICKET)).toEqual({ kind: "present", ticket: TICKET, root: validOid, document: valid });

				const repo = fixture.serverRepo;
				const state = await fixture.writeBlob(repo, canonicalText(stateOf(valid)));
				const receipt = await fixture.writeBlob(repo, canonicalText(CLAIM_A.receipt));
				const notJson = await fixture.writeBlob(repo, "{\n");
				const receipts = await fixture.mktree(repo, `100644 blob ${receipt}\t${CLAIM_A.operationId}\n`);
				const nested = await fixture.mktree(repo, `040000 tree ${receipts}\t${CLAIM_A.operationId}\n`);
				const broken = await fixture.mktree(repo, `100644 blob ${notJson}\t${CLAIM_A.operationId}\n`);
				const layouts: Record<string, string> = {
					"missing state": `040000 tree ${receipts}\treceipts\n`,
					"state is a tree": `040000 tree ${receipts}\tstate\n040000 tree ${receipts}\treceipts\n`,
					"receipts is a blob": `100644 blob ${state}\tstate\n100644 blob ${receipt}\treceipts\n`,
					"receipt is a tree": `100644 blob ${state}\tstate\n040000 tree ${nested}\treceipts\n`,
					"receipt not JSON": `100644 blob ${state}\tstate\n040000 tree ${broken}\treceipts\n`,
				};
				for (const [label, rows] of Object.entries(layouts)) {
					const oid = await fixture.point(TICKET_REF, await fixture.mktree(repo, rows));
					const read = await store.read(TICKET);
					expect({ label, kind: read.kind }).toEqual({ label, kind: "corrupt" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
				}

				const wrapper = (await server().git(repo, ["commit-tree", validOid, "-m", "wrapper"])).out.trim();
				await fixture.point(TICKET_REF, wrapper);
				expect(await store.read(TICKET)).toMatchObject({ kind: "corrupt" });
				expect((await fixture.serverRefs())[TICKET_REF]).toBe(wrapper);
			});
		},
		TEST_TIMEOUT,
	);
});

describe("commit-chain claim storage history", () => {
	test(
		"stores one deterministic commit per revision on a single-parent chain with one receipt delta each",
		async () => {
			await withCase("commit-chain", "chain-layout", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("commit-chain"));
				const store = await fixture.open(await fixture.client("a"));
				const changes = [CLAIM_A, RENEW_A, RELEASE_A, RECLAIM_A];
				const documents: ClaimDocument[] = [];
				const roots: string[] = [];
				let base: ClaimSnapshot = expectKind(await store.read(TICKET), "absent");
				for (const change of changes) {
					const applied = expectKind(await store.write(base, change), "applied");
					documents.push(applied.document);
					roots.push(applied.root);
					base = expectKind(await store.read(TICKET), "present");
				}
				const head = expectKind(base, "present");
				expect(head.root).toBe(await fixture.expectedRoot(...documents));

				for (const [index, root] of roots.entries()) {
					const { tree, parents } = await fixture.commitHeader(root);
					expect({ index, parents }).toEqual({ index, parents: roots.slice(Math.max(0, index - 1), index) });
					const delta = await fixture.treeEntries((await fixture.treeEntries(tree)).get("receipts")?.oid ?? "");
					const added = changes.slice(index, index + 1).map((change) => change.operationId);
					expect({ index, delta: [...delta.keys()] }).toEqual({ index, delta: added });
					const parentLines = parents.map((parent) => `parent ${parent}\n`).join("");
					const header = `tree ${tree}\n${parentLines}author ${CHAIN_IDENTITY}\ncommitter ${CHAIN_IDENTITY}\n`;
					expect(await fixture.rawCommit(root)).toBe(`${header}\n${chainMessage(TICKET, index + 1)}`);
				}
				expect(Object.keys(await fixture.serverRefs()).filter((ref) => !ref.startsWith("refs/claim"))).toEqual([]);

				await fixture.gc();
				const fresh = await fixture.open(await fixture.client("fresh"));
				expect(await fresh.read(TICKET)).toEqual(head);
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"reports merged, truncated or inconsistent chains as corrupt",
		async () => {
			await withCase("commit-chain", "corrupt-chain", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("commit-chain"));
				const store = await fixture.open(await fixture.client("a"));
				const repo = fixture.serverRepo;
				const rev1 = documentAfterClaim("commit-chain", 1);
				const rev2 = documentOf("commit-chain", TICKET, 2, RENEW_A.payload, receiptsOf(CLAIM_A, RENEW_A));
				const rev3 = documentOf("commit-chain", TICKET, 3, RELEASE_A.payload, receiptsOf(CLAIM_A, RENEW_A, RELEASE_A));
				const one = await fixture.chainCommit(repo, rev1, [CLAIM_A], []);
				const valid = await fixture.point(TICKET_REF, await fixture.chainCommit(repo, rev2, [RENEW_A], [one]));
				expect(await store.read(TICKET)).toEqual({ kind: "present", ticket: TICKET, root: valid, document: rev2 });

				const rival = documentOf("commit-chain", TICKET, 1, CLAIM_B.payload, receiptsOf(CLAIM_B));
				const otherRoot = await fixture.chainCommit(repo, rival, [CLAIM_B], []);
				const code = await fixture.commit(repo, await fixture.mktree(repo, ""), [], "code\n");
				const ancestor = (changed: Record<string, unknown>) =>
					fixture.chainCommit(repo, { ...rev1, ...changed }, [CLAIM_A], []);
				const reused = { ...RENEW_A, operationId: CLAIM_A.operationId };
				const chains: Record<string, () => Promise<string>> = {
					"merge commit": () => fixture.chainCommit(repo, rev2, [RENEW_A], [one, otherRoot]),
					"revision 2 without parent": () => fixture.chainCommit(repo, rev2, [RENEW_A], []),
					"revision 1 with a parent": () => fixture.chainCommit(repo, rev1, [CLAIM_A], [otherRoot]),
					"parent revision gap": () => fixture.chainCommit(repo, rev3, [RELEASE_A], [one]),
					"ancestor with other ticket": async () =>
						fixture.chainCommit(repo, rev2, [RENEW_A], [await ancestor({ ticket: OTHER_TICKET })]),
					"ancestor with other format": async () =>
						fixture.chainCommit(repo, rev2, [RENEW_A], [await ancestor({ format: "tree" })]),
					"ancestor with other epoch": async () =>
						fixture.chainCommit(repo, rev2, [RENEW_A], [await ancestor({ epoch: 2 })]),
					"ancestor with other schema": async () =>
						fixture.chainCommit(repo, rev2, [RENEW_A], [await ancestor({ schema: 2 })]),
					"operation ID repeated in the chain": () => fixture.chainCommit(repo, rev2, [reused], [one]),
					"empty delta": () => fixture.chainCommit(repo, rev2, [], [one]),
					"two receipts in one delta": () => fixture.chainCommit(repo, rev2, [RENEW_A, RELEASE_A], [one]),
					"code commit as parent": () => fixture.chainCommit(repo, rev2, [RENEW_A], [code]),
				};
				for (const [label, build] of Object.entries(chains)) {
					const oid = await fixture.point(TICKET_REF, await build());
					const read = await store.read(TICKET);
					expect({ label, kind: read.kind }).toEqual({ label, kind: "corrupt" });
					expect((await fixture.serverRefs())[TICKET_REF]).toBe(oid);
				}
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"writes the agreed commit bytes regardless of signing, encoding and identity configuration",
		async () => {
			await withCase("commit-chain", "deterministic", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("commit-chain"));
				const client = await fixture.client("a");
				const config: Record<string, string> = {
					"commit.gpgSign": "true",
					"gpg.program": "false",
					"i18n.commitEncoding": "ISO-8859-1",
					"user.name": "Local Override",
					"user.email": "local@example.invalid",
				};
				for (const [key, value] of Object.entries(config)) await server().git(client, ["config", key, value]);
				const env = probeEnv({
					GIT_AUTHOR_NAME: "Env Override",
					GIT_AUTHOR_EMAIL: "env@example.invalid",
					GIT_AUTHOR_DATE: "2001-02-03T04:05:06Z",
					GIT_COMMITTER_NAME: "Env Override",
					GIT_COMMITTER_EMAIL: "env@example.invalid",
					GIT_COMMITTER_DATE: "2001-02-03T04:05:06Z",
				});
				const report = await fixture.probe(env, { ...fixture.options(client), ticket: TICKET, change: CLAIM_A });
				expect(report).toEqual({
					initialized: "exists",
					opened: "open",
					read: "absent",
					written: "applied",
					root: await fixture.expectedRoot(documentAfterClaim("commit-chain", 1)),
				});
			});
		},
		TEST_TIMEOUT,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// Broken local refs do not fail a claim read. A read fetches the ticket ref into a temporary ref of its own and drops
// it afterwards; the fetch's connectivity check enumerates every ref of the client repository. A sibling read that
// drops its temporary ref inside that window leaves the ref broken to git (a name without an object), and with git's
// default ref paranoia the check then aborts with "bad object <ref>". A loose ref whose file names no object is the
// deterministic stand-in for that window, inside the claim namespace and outside it. Skipping such a ref only removes
// one `--not` tip from the check, so a fetch that stays short is still refused; the commit-chain row pins that with a
// damaged client object store whose missing objects the server leaves out as common.
// ---------------------------------------------------------------------------------------------------------------

/** The content of a broken loose ref: a file under .git/refs that names no object. */
const BROKEN_REF_TEXT = "not an object id\n";
const READ_REF_PREFIX = "refs/backlog-md/claim-storage/read/";
const CONNECTIVITY_REFUSED = "did not send all necessary objects";

/** Writes a broken loose ref straight into the client repository; git itself refuses to create one. */
async function plantBrokenRef(client: string, ref: string): Promise<string> {
	const path = join(client, ".git", ref);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, BROKEN_REF_TEXT);
	return path;
}

/** The temporary read refs left as loose files in the client repository. */
async function readRefFiles(client: string): Promise<string[]> {
	try {
		return (await readdir(join(client, ".git", READ_REF_PREFIX))).sort(byCodeUnits);
	} catch {
		return [];
	}
}

/** Runs `body` with GIT_REF_PARANOIA set as given (undefined: unset) in the environment the claim git calls inherit. */
async function withAmbientParanoia<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
	const before = process.env.GIT_REF_PARANOIA;
	if (value === undefined) delete process.env.GIT_REF_PARANOIA;
	else process.env.GIT_REF_PARANOIA = value;
	try {
		return await body();
	} finally {
		if (before === undefined) delete process.env.GIT_REF_PARANOIA;
		else process.env.GIT_REF_PARANOIA = before;
	}
}

/** Opens the store and reads TICKET; a failed open is reported in the read's place. */
async function openAndRead(fixture: AdapterCase, client: string): Promise<{ opened: string; read: unknown }> {
	const opened = await openClaimStore(fixture.options(client));
	if (opened.kind !== "open") return { opened: opened.kind, read: opened };
	return { opened: opened.kind, read: await opened.store.read(TICKET) };
}

for (const format of ADAPTER_FORMATS) {
	describe(`${format} claim storage with broken local refs`, () => {
		test(
			"opens and reads in a checkout that holds a broken temporary read ref, and leaves that ref as it was",
			async () => {
				await withCase(format, "broken-read-ref", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const claimed = documentAfterClaim(format, 1);
					const claimedOid = await fixture.storeDocument(TICKET_REF, claimed);
					const client = await fixture.client("a");
					const before = await fixture.localState(client);
					const ref = `${READ_REF_PREFIX}${crypto.randomUUID()}`;
					const path = await plantBrokenRef(client, ref);
					const resolved = await server().git(client, ["rev-parse", "--verify", "--quiet", ref], undefined, false);
					const reads: { ambient: string; opened: string; read: unknown }[] = [];
					for (const ambient of [undefined, "1"]) {
						const result = await withAmbientParanoia(ambient, () => openAndRead(fixture, client));
						reads.push({ ambient: ambient ?? "unset", ...result });
					}
					const view = {
						reads,
						brokenRef: await Bun.file(path).text(),
						readRefsLeft: await readRefFiles(client),
						local: await fixture.localState(client),
					};
					console.log(`BROKEN-REF ${JSON.stringify({ row: "broken-ref-temp-read", format, ...view })}`);
					// Positive control (catches: a row that passes because the planted ref is no broken ref to git — a
					// file git can resolve, a ref written to the wrong place): the file is there and git cannot resolve it.
					expect({ planted: await Bun.file(path).exists(), resolvable: resolved.rc === 0 }).toEqual({
						planted: true,
						resolvable: false,
					});
					// (catches: today's fetch, whose connectivity check aborts at the broken ref with "bad object
					// refs/backlog-md/claim-storage/read/…", so open and read end unreachable; a fix that sets the paranoia
					// only when the environment has none, so an inherited GIT_REF_PARANOIA=1 still aborts; a cleanup that
					// drops a read ref it did not create): open and read succeed with the stored document, also under an
					// inherited GIT_REF_PARANOIA=1; the broken ref is untouched and the only read ref left; branches,
					// tags, tracking refs and FETCH_HEAD are unchanged.
					const present: ClaimSnapshot = { kind: "present", ticket: TICKET, root: claimedOid, document: claimed };
					expect(view).toEqual({
						reads: [
							{ ambient: "unset", opened: "open", read: present },
							{ ambient: "1", opened: "open", read: present },
						],
						brokenRef: BROKEN_REF_TEXT,
						readRefsLeft: [ref.slice(READ_REF_PREFIX.length)],
						local: before,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"opens and reads in a checkout that holds a broken branch ref outside the claim namespace",
			async () => {
				await withCase(format, "broken-branch-ref", async (fixture) => {
					await fixture.setDescriptor(descriptorOf(format));
					const claimed = documentAfterClaim(format, 1);
					const claimedOid = await fixture.storeDocument(TICKET_REF, claimed);
					const client = await fixture.client("a");
					const ref = "refs/heads/broken";
					const path = await plantBrokenRef(client, ref);
					const resolved = await server().git(client, ["rev-parse", "--verify", "--quiet", ref], undefined, false);
					const view = {
						...(await openAndRead(fixture, client)),
						brokenRef: await Bun.file(path).text(),
						readRefsLeft: await readRefFiles(client),
					};
					console.log(`BROKEN-REF ${JSON.stringify({ row: "broken-ref-branch", format, ...view })}`);
					// Positive control (catches: a planted ref git can resolve): the file is there and git cannot resolve it.
					expect({ planted: await Bun.file(path).exists(), resolvable: resolved.rc === 0 }).toEqual({
						planted: true,
						resolvable: false,
					});
					// (catches: today's fetch, which aborts at any broken ref of the checkout — "bad object
					// refs/heads/broken"; a fix narrowed to the claim namespace, which a broken ref of the user's own still
					// defeats): open and read succeed with the stored document, the broken branch ref is untouched, and no
					// read ref is left.
					expect(view).toEqual({
						opened: "open",
						read: { kind: "present", ticket: TICKET, root: claimedOid, document: claimed },
						brokenRef: BROKEN_REF_TEXT,
						readRefsLeft: [],
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}

describe("commit-chain claim storage with broken local refs", () => {
	test(
		"still refuses a short fetch when the read skips a broken ref",
		async () => {
			await withCase("commit-chain", "short-fetch", async (fixture) => {
				await fixture.setDescriptor(descriptorOf("commit-chain"));
				const first = await fixture.storeDocument(TICKET_REF, documentAfterClaim("commit-chain", 1));
				const client = await fixture.client("a");
				const store = await fixture.open(client);
				// The client keeps revision 1 under a branch of its own, so the server treats it as common.
				await server().git(client, ["fetch", "--quiet", fixture.url, `${TICKET_REF}:refs/heads/mirror`]);
				const firstTree = (await fixture.commitHeader(first)).tree;
				const receipts = (await fixture.treeEntries(firstTree)).get("receipts")?.oid ?? "";
				// Revision 2 reuses revision 1's receipts tree object and has revision 1 as its parent: a fetch of it
				// leaves that tree out, because the client announces revision 1.
				const state = await fixture.writeBlob(fixture.serverRepo, '{"note":"revision 2 of the short-fetch row"}\n');
				const tree = await fixture.mktree(
					fixture.serverRepo,
					`100644 blob ${state}\tstate\n040000 tree ${receipts}\treceipts\n`,
				);
				await fixture.point(
					TICKET_REF,
					await fixture.commit(fixture.serverRepo, tree, [first], chainMessage(TICKET, 2)),
				);
				// The client's object store loses revision 1's tree and that receipts tree.
				const loose = (oid: string) => join(client, ".git", "objects", oid.slice(0, 2), oid.slice(2));
				const wereLoose = [await Bun.file(loose(firstTree)).exists(), await Bun.file(loose(receipts)).exists()];
				await rm(loose(firstTree));
				await rm(loose(receipts));
				const lost = await server().git(client, ["cat-file", "-e", receipts], undefined, false);
				const onServer = await server().git(fixture.serverRepo, ["cat-file", "-e", receipts], undefined, false);
				const outcome = (read: unknown) => {
					const value = read as { kind?: string; reason?: string };
					const reason = value.reason ?? "";
					return {
						kind: value.kind,
						refused: reason.includes(CONNECTIVITY_REFUSED),
						namesMissing: reason.includes(receipts),
					};
				};
				const clean = await store.read(TICKET);
				await plantBrokenRef(client, `${READ_REF_PREFIX}${crypto.randomUUID()}`);
				const skipped = await store.read(TICKET);
				const view = { clean: outcome(clean), brokenRefSkipped: outcome(skipped) };
				console.log(
					`BROKEN-REF ${JSON.stringify({ row: "broken-ref-short-fetch", firstTree, receipts, cleanRead: clean, skippedRead: skipped, ...view })}`,
				);
				// Positive control (catches: a row that passes because the fetch was never short — objects that were
				// packed and survived the removal, a server that lost them too): the removed objects were loose in the
				// client, are gone there, and the server still has them.
				expect({ wereLoose, lostOnClient: lost.rc !== 0, onServer: onServer.rc === 0 }).toEqual({
					wereLoose: [true, true],
					lostOnClient: true,
					onServer: true,
				});
				// A skipped ref only removes a `--not` tip from the connectivity check (catches: a fix that skips the
				// check or lets a broken ref count as having everything — the short fetch would pass and the read
				// return a document whose objects are missing; today's check, which aborts at the broken ref before it
				// reaches the missing objects): both reads end unreachable, refused by the connectivity check, which
				// names the receipts tree the fetch left out — with and without the broken ref.
				expect(view).toEqual({
					clean: { kind: "unreachable", refused: true, namesMissing: true },
					brokenRefSkipped: { kind: "unreachable", refused: true, namesMissing: true },
				});
			});
		},
		TEST_TIMEOUT,
	);
});
