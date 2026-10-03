/**
 * Epoch swap, level P: the epoch-aware storage and the two epoch rules of `install-epoch` that no Git race is needed
 * for. Pinned here: descriptor decoding with any positive safe integer as epoch (ep-p01); documents checked against the
 * epoch of the opened store on read, on write and for every chain ancestor, and the `epoch` of `claim-list` entries
 * (ep-p02); the epoch comparison of `resendClaimIntent` and `claim retry` before any resolution or send (ep-p03); the
 * generation rule and the fresh FREE documents of a restore (ep-p04). No pure decoder is exported, so every case runs
 * in process against the loopback Git daemon of claim-git-fixture.ts, like em-p10 and em-p12 of
 * claim-emergency.test.ts; the states under test are hand-built with Git plumbing in the server repository and decoded
 * back by an independent reader; ep-p05 checks the malformed inputs before the preflight. ep-p02 runs on blob, tree and
 * commit-chain, the other cases on blob: 5 test definitions, 7 runs. Every test starts with a positive control that the
 * scaffold (a descriptor epoch other than 1 still corrupt, documents still compared with 1, `runClaimInstallEpoch`
 * writing nothing) fails behaviourally, at a document, a counter or the ref state; every further expectation names what
 * it catches. The shapes the contract leaves open (surface entry, the two documents, `epoch` in `claim-list`, access to
 * the decoder) each go through exactly one helper at the top of the file, marked ASSUMPTION(scaffold). Harness: adapted
 * copies with "adapted from" notes, no shared fixture module; claim-git-fixture.ts and every existing test file stay
 * unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { claimOperationIntentOf, resendClaimIntent } from "../claims/execution/index.ts";
import { openClaimIntentJournal } from "../claims/journal/index.ts";
import type { ActiveClaimState, ClaimTiming, FreeClaimState, PendingClaimState } from "../claims/rights/index.ts";
import {
	type ClaimChange,
	type ClaimOpenResult,
	type ClaimReadResult,
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	type ClaimWriteResult,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
	type ClaimDocument as StoredClaimDocument,
} from "../claims/storage/index.ts";
// ASSUMPTION(epoch): `runClaimInstallEpoch` exists from the epoch scaffold on; its only call site
// is installEpoch below.
import {
	type ClaimDocument,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimExitCode,
	runClaimInstallEpoch,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import { planClaimTransition } from "../claims/transition/index.ts";
import type { Task } from "../types/index.ts";
import { compareTaskIds } from "../utils/task-sorting.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";

type Body = Record<string, unknown>;
type Sentinel = readonly [label: string, value: string];
type ContextHandle = { context: ClaimContext; directory: string };
type Refs = Record<string, string>;
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type Present = Extract<ClaimReadResult, { kind: "present" }>;
/** A store's descriptor and one present read of TICKET, both through the one decoder access. */
type Observed = { descriptor: ClaimStorageDescriptor; snapshot: Present };
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };
type EnvOptions = { ids?: readonly string[]; authorities?: readonly string[]; corpus?: readonly string[] };
/** The input of the surface entry of `claim install-epoch`; `preview` selects claim-epoch-preview. */
type InstallEpochInput = {
	context: string;
	expectEpoch: number;
	isolationConfirmed: boolean;
	storageFormat?: string;
	tickets?: string[];
	preview?: boolean;
};
type InstallEpochEntry = (input: InstallEpochInput, env: ClaimSurfaceEnv) => Promise<unknown>;
/** ep-p01: the kind of an open result and, where it has one, the decoded descriptor; never the reason. */
type DescriptorVerdict = { kind: string; descriptor?: ClaimStorageDescriptor };
type DescriptorRow = { label: string; catches: string; text: string; expected: DescriptorVerdict };
type ReadRow = { label: string; catches: string; ticket: string; expected: unknown };
/** ep-p05: one malformed install-epoch input and the code decided for it. */
type InputRow = { label: string; catches: string; input: Body; code: string };
/** ep-p04: one ticket's state before the run and the generation its fresh FREE document must carry. */
type GenerationRow = {
	label: string;
	catches: string;
	ticket: string;
	/** A document of epoch `epoch` (default 1) with this payload, raw bytes at the ticket ref, or no ref at all. */
	before: { payload: object; epoch?: number } | { raw: string } | null;
	generation: number;
};

/** Loopback Git cases, sized like em-p10 and em-p12 (claim-emergency.test.ts:153). */
const GIT_TIMEOUT = 60_000;
/** ep-p04: ten tickets, a preview and a run with two pushes per rewritten ticket (claim-emergency-git.test.ts:105). */
const LONG_GIT_TIMEOUT = 90_000;
/** attempt_timeout_ms of the loopback configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Appears in case roots, context parents and one raw ticket blob; no public document may contain it. */
const SENTINEL = "SENTINEL-claim-epoch-3e8a";
const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const DESCRIPTOR_REF = "refs/claim-meta/format";
const CLAIMS_PREFIX = "refs/claims/";
/** `refs/claim-archive/<N>/<TICKET>`, N the epoch the run leaves. */
const ARCHIVE_PREFIX = "refs/claim-archive/";
/** Agreed commit identity of the chain layout (claim-storage-adapters.test.ts:50; storage/index.ts:611-612). */
const CHAIN_IDENTITY = "Backlog.md Claims <claims@backlog.invalid> 0 +0000";
const TICKET = "BACK-1";
/** ep-p05: relative on purpose; the preflight refuses it before any IO (config/index.ts:555), as em-p09 does. */
const RELATIVE_ROOT = `project-${SENTINEL}`;
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-emergency.test.ts:164
const ABSENT_REF = "(no ref)";
/** ep-p02: one ticket per observation, so no read depends on an earlier write. */
const OLD_TICKET = "BACK-1";
const NEW_TICKET = "BACK-2";
const ABSENT_TICKET = "BACK-3";
const MIXED_TICKET = "BACK-4";
const DEEP_TICKET = "BACK-5";
const GUARD_TICKET = "BACK-6";
/** ep-p04: the local task corpus; BACK-8 comes only through --ticket, BACK-9 and BACK-10 only through refs. */
const CORPUS: readonly string[] = ["BACK-1", "BACK-2", "BACK-3", "BACK-4", "BACK-5", "BACK-6", "BACK-7"];
const EXTRA_TICKET = "BACK-8";

// Planner constants adapted from claim-emergency.test.ts:169-195.
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** "10:00" (2027-01-15T08:00Z); every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05" and a hard work limit "11:00". */
const L = T + TTL;
const H = T + 60 * MINUTE;
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;

/** An executor receipt of an earlier operation (executor shape); storage treats its content as opaque. */
const OLD_RECEIPT = { schema: 1, intentDigest: "c3".repeat(32), parameterDigest: "d4".repeat(32) };
const WRITE_RECEIPT = { schema: 1, intentDigest: "e5".repeat(32), parameterDigest: "f6".repeat(32) };
/** A fixed maintenance receipt ID of the contract form, for the documents this file builds by hand. */
const M_ID = "m-4f1c2e3d-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
/** `m-<uuid v4>` (RFC 9562 version 4, variant 10), lower-case like `randomUUID`. */
const M_ID_FORM = /^m-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Stands for any receipt ID of that form in a decoded document; the UUID is random per run. */
const M_ID_LABEL = "m-<uuid v4>";

/** Operation IDs. */
const ACQUIRE_ID = "op-5d0c6f1e-2b7a-4c3d-8e9f-0a1b2c3d4e5f";
const RELEASE_ID = "op-9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const FORMAT_ID = "op-1c2d3e4f-5a6b-4c7d-9e8f-a0b1c2d3e4f5";
const ACQUIRE2_ID = "op-2e3f4a5b-6c7d-4e8f-a9b0-c1d2e3f4a5b6";
const RELEASE2_ID = "op-3f4a5b6c-7d8e-4f9a-b0c1-d2e3f4a5b6c7";
/** ep-p04: IDs the surface may draw; the contract does not say whether install-epoch draws one [?]. */
const SPARE_IDS: readonly string[] = Array.from(
	{ length: 32 },
	(_, n) => `op-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
);
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";

/** `ta1-` + SHA-256 over this UTF-8 domain with its trailing NUL, then the secret bytes. */
const AUTHORITY_PREFIX = "ta1-";
const AUTHORITY_DOMAIN = "backlog.md/claim-authority/v1\0";
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------------------------
// ASSUMPTION(scaffold) helpers: the contract leaves these shapes open; another decision changes only its helper.
// ---------------------------------------------------------------------------------------------------------------

/** The `command` of every install-epoch document (used by the two document helpers). */
const EPOCH_COMMAND = "install-epoch";

/**
 * ASSUMPTION(scaffold): the surface entry of `claim install-epoch` is `runClaimInstallEpoch(input, env)` in
 * src/claims/surface with the input {context, expectEpoch, isolationConfirmed, storageFormat?, tickets?, preview?},
 * answering `claim-epoch`, `claim-epoch-preview` or `claim-error` in the envelope {schemaVersion: 1, kind, status,
 * command: "install-epoch"} (fixes only the CLI form). The one call site of the command in this file; a
 * throw comes back as a value, so a stub that throws fails at the positive control like one that writes nothing.
 */
async function installEpoch(input: InstallEpochInput, env: ClaimSurfaceEnv): Promise<unknown> {
	const run = runClaimInstallEpoch as unknown as InstallEpochEntry;
	try {
		return await run(input, env);
	} catch (error) {
		return { kind: "thrown", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * ASSUMPTION(scaffold): `claim-epoch` carries exactly the fields: `rewritten`, `created`, `breached`
 * and `unsettled` as ticket lists sorted like `claim list`; a `rejected` one adds `cause` and keeps the lists
 * empty (not used at level P). The one place the document is spelled out.
 */
function epochDocument(status: string, fields: Body): Body {
	return { schemaVersion: 1, kind: "claim-epoch", status, command: EPOCH_COMMAND, ...fields };
}

/**
 * ASSUMPTION(scaffold): `claim-epoch-preview` has status `ok` (a read-only answer, like claim-emergency-preview) and
 * the fields: `epoch` is the epoch a run WOULD install (N+1), `format` the target format, `listed` and
 * `toCreate` sorted ticket lists, `unreadable` the sorted tickets whose old document gives no generation.
 */
function epochPreviewDocument(fields: Body): Body {
	return { schemaVersion: 1, kind: "claim-epoch-preview", status: "ok", command: EPOCH_COMMAND, ...fields };
}

/**
 * ASSUMPTION(scaffold): the optional `epoch` of `claim-list` goes with
 * `claimGeneration`: an entry read from a stored document (active, free, pending) carries the epoch of the store, an
 * `unknown` entry and the free entry of a ticket without a ref carry none. Every list entry this file expects goes
 * through here; the frozen list pins carry `epoch: 1` since the epoch swap.
 */
function listEntry(entry: Body, storeEpoch: number): Body {
	return "claimGeneration" in entry ? { ...entry, epoch: storeEpoch } : entry;
}

/**
 * ASSUMPTION(scaffold): `decodeDescriptor` and `validDocument` stay internal (storage/index.ts:198, :144), so this file
 * reaches them only through the store `openClaimStore` opens: its descriptor is the decoded one, its `read` and `write`
 * check documents against its epoch. The one call site of `openClaimStore`.
 */
function openStore(options: ClaimStorageOptions): Promise<ClaimOpenResult> {
	return openClaimStore(options);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-emergency.test.ts:266
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-emergency.test.ts:272
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function rowLabel(row: { label: string; catches: string }): string {
	return `${row.label} (catches: ${row.catches})`;
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-emergency.test.ts:283
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** The document with a non-empty message replaced (the wording is not part of the contract). */
// adapted from claim-emergency.test.ts:298
function bodyOf(document: unknown): Body {
	const body: Body = Object.fromEntries(Object.entries(document as object));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return body;
}

// adapted from claim-emergency.test.ts:309
function pick(document: unknown, keys: readonly string[]): Body {
	return Object.fromEntries(keys.map((key) => [key, field(document, key)]));
}

/** A refused claim-error document with the record's ticket and the requested operation ID, if any. */
// adapted from claim-emergency.test.ts:315
function errorBody(command: string, code: string, ticket: string | null, operationId: string | null): Body {
	return {
		schemaVersion: 1,
		kind: "claim-error",
		status: "refused",
		command,
		code,
		message: MESSAGE,
		ticket,
		operationId,
	};
}

function exitOf(document: unknown): number {
	return claimExitCode(document as ClaimDocument);
}

function claimRef(ticket: string): string {
	return `${CLAIMS_PREFIX}${ticket}`;
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort(byCodeUnits);
}

/** The ticket lists of `claim-epoch` and its preview come in the order of `claim list`. */
function ticketList(tickets: readonly string[]): string[] {
	return [...tickets].sort(compareTaskIds);
}

/** Agreed document encoding: recursively code-unit-sorted keys, no whitespace. */
// adapted from claim-storage-adapters.test.ts:176-191
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

// adapted from claim-storage-adapters.test.ts:216
function chainMessage(ticket: string, revision: number): string {
	return `claim ${ticket} revision ${revision}\n`;
}

/** ep-p01: a blob descriptor whose epoch is exactly `epoch`, as JSON. */
function descriptorText(epoch: unknown): string {
	return canonicalText({ schema: 1, format: "blob", epoch });
}

function openedAt(epoch: number, format: ClaimStorageFormat = "blob"): DescriptorVerdict {
	return { kind: "open", descriptor: { schema: 1, format, epoch } };
}

const CORRUPT: DescriptorVerdict = { kind: "corrupt" };

function descriptorVerdict(opened: ClaimOpenResult): DescriptorVerdict {
	if (opened.kind === "open" || opened.kind === "format-mismatch") {
		return { kind: opened.kind, descriptor: opened.descriptor };
	}
	return { kind: opened.kind };
}

/** The store of an open result; called only after a positive control has shown that the store opens. */
function storeOf(opened: ClaimOpenResult): ClaimStore {
	if (opened.kind !== "open") throw new Error(`claim store cannot be opened (${opened.kind})`);
	return opened.store;
}

/** A read's kind; a present read with its root and document (the reason of a failure is never compared). */
function readView(read: ClaimReadResult): Body {
	if (read.kind === "present") return { kind: "present", root: read.root, document: read.document };
	return { kind: read.kind };
}

function present(document: StoredClaimDocument, root: string): Body {
	return { kind: "present", root, document };
}

/** A stored claim document; payload and receipts may be any object (corruption rows). */
function docOf(
	format: ClaimStorageFormat,
	epoch: number,
	ticket: string,
	revision: number,
	payload: object,
	receipts: Record<string, object>,
): StoredClaimDocument {
	return {
		schema: 1,
		format,
		epoch,
		ticket,
		revision,
		payload: payload as JsonObject,
		receipts: receipts as Record<string, JsonObject>,
	};
}

/** The maintenance receipt of a run from `fromEpoch` to the next epoch. */
function maintenance(fromEpoch: number): Body {
	return { schema: 1, kind: "epoch", fromEpoch, epoch: fromEpoch + 1, isolation: "attested" };
}

function change(operationId: string, payload: object): ClaimChange {
	return { operationId, receipt: WRITE_RECEIPT, payload: payload as JsonObject };
}

/** A decoded document with its receipts as sorted [id, receipt] pairs, every ID of the m-<uuid v4> form as label. */
function documentView(value: unknown): unknown {
	const receipts = field(value, "receipts");
	if (receipts === null || typeof receipts !== "object") return value;
	const pairs = Object.entries(receipts).map(([id, receipt]): [string, unknown] => [
		M_ID_FORM.test(id) ? M_ID_LABEL : id,
		receipt,
	]);
	return { ...(value as Body), receipts: pairs.sort(([left], [right]) => byCodeUnits(left, right)) };
}

/** The receipt IDs of a documentView, in its order. */
function receiptLabels(view: unknown): string[] {
	const receipts = field(view, "receipts");
	if (!Array.isArray(receipts)) return [];
	return receipts.map((entry: unknown) => (Array.isArray(entry) ? String(entry[0]) : "(no pair)"));
}

/**
 * The only document a restore from epoch 1 writes for `ticket` (blob): revision 1, the FREE
 * tombstone, exactly one maintenance receipt; receipts as documentView shows them.
 */
function freshDocument(ticket: string, generation: number): Body {
	return {
		schema: 1,
		format: "blob",
		epoch: 2,
		ticket,
		revision: 1,
		payload: tombstone(generation),
		receipts: [[M_ID_LABEL, maintenance(1)]],
	};
}

/** Server refs by kind: archive refs with their objects, ticket ref names, every other ref name. */
function refShape(refs: Refs): Body {
	const archive: Refs = {};
	const tickets: string[] = [];
	const other: string[] = [];
	for (const [ref, oid] of Object.entries(refs)) {
		if (ref.startsWith(ARCHIVE_PREFIX)) archive[ref] = oid;
		else if (ref.startsWith(CLAIMS_PREFIX)) tickets.push(ref);
		else other.push(ref);
	}
	return { archive, tickets: sorted(tickets), other: sorted(other) };
}

/** The secret's hex text in context.json (context/index.ts:132 decodes it to the 32 bytes). */
// adapted from claim-emergency.test.ts:326
async function secretOf(directory: string): Promise<string> {
	const record: unknown = JSON.parse(await readFile(join(directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	if (typeof secret !== "string" || !HEX64.test(secret)) throw new Error("fixture: unreadable context secret");
	return secret;
}

/** The independent oracle, recomputed here and never read from the product. */
// adapted from claim-emergency.test.ts:334
function authorityOf(secretHex: string): string {
	const hash = createHash("sha256").update(AUTHORITY_DOMAIN, "utf8").update(Buffer.from(secretHex, "hex"));
	return `${AUTHORITY_PREFIX}${hash.digest("hex")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Claim states: adapted from claim-emergency.test.ts:374-423 (planner harness), which exports nothing.
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-emergency.test.ts:374
function lease(leaseEnd = L, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

// adapted from claim-emergency.test.ts:379
function hard(hardEnd = H): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

const TIMELESS: ClaimTiming = { mode: "none" };

// adapted from claim-emergency.test.ts:386
function active(timing: ClaimTiming = lease(), changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 3,
		bindingGeneration: 1,
		owner: OWNER,
		binding: KARL,
		timing,
		...changes,
	};
}

// adapted from claim-emergency.test.ts:406
function tombstone(claimGeneration: number): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/**
 * Transfer form: KARL's hard-mode source at generation 3, FRANZ's target at generation 4 with binding
 * generation 1 and a later hard end; the state carries the target's generation (rights/index.ts:29-39, :201).
 */
// adapted from claim-emergency.test.ts:414
function pendingState(): PendingClaimState {
	const source = active(hard(H), { claimGeneration: 3 });
	const target = active(hard(H + DAY), { claimGeneration: 4, owner: OTHER_OWNER, binding: FRANZ });
	return { claimState: 1, status: "pending", claimGeneration: 4, source, target };
}

// ---------------------------------------------------------------------------------------------------------------
// Loopback Git harness: adapted from claim-emergency.test.ts:880-1119 (GitCase) and
// claim-storage-adapters.test.ts:245-657 (AdapterCase, its reference encoder and reader).
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: GitFixtureServer | undefined;

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-emergency.test.ts:888
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

// adapted from claim-emergency.test.ts:718
async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 });
	await chmod(path, 0o700);
}

/** The mandatory corpus seam; `ids` are open tasks without dependencies. */
// adapted from claim-emergency.test.ts:904
function corpusOf(ids: readonly string[]): LocalTickets {
	const tasks: Task[] = ids.map((id) => ({
		id,
		title: id,
		status: "To Do",
		assignee: [],
		createdDate: "2026-01-01 00:00",
		labels: [],
		dependencies: [],
	}));
	const corpus = { tasks, completedTasks: [], statuses: ["To Do", "In Progress", "Done"] };
	return { kind: "loaded", matched: [], corpus, priorities: [] };
}

/** One server repository in one storage format, the project repository, a reader client, a private context parent. */
class EpochCase {
	readonly root: string;
	readonly url: string;
	readonly format: ClaimStorageFormat;
	/** ClaimSurfaceEnv.projectRoot: the client repository of every surface call and of the direct resends. */
	readonly project: string;
	/** The client repository of the test's own store reads; never the project. */
	readonly reader: string;
	readonly parent: string;
	private readonly serverRepo: string;

	private constructor(
		root: string,
		url: string,
		format: ClaimStorageFormat,
		serverRepo: string,
		project: string,
		reader: string,
	) {
		this.root = root;
		this.url = url;
		this.format = format;
		this.serverRepo = serverRepo;
		this.project = project;
		this.reader = reader;
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	// adapted from claim-emergency.test.ts:941
	static async create(caseName: string, format: ClaimStorageFormat): Promise<EpochCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-epoch-${caseName}-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `epoch-${caseName}`);
			const project = await initClient(join(root, "project"));
			const reader = await initClient(join(root, "client-reader"));
			const epochCase = new EpochCase(root, server().url(name), format, repo, project, reader);
			await privateDirectory(epochCase.parent);
			return epochCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-emergency.test.ts:959
	storage(repository = this.reader): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
	}

	// adapted from claim-emergency.test.ts:964
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** All keys explicit; `authorities` become `claims.recovery_authorities` when there is at least one. */
	// adapted from claim-emergency.test.ts:972
	claimsYaml(authorities: readonly string[]): string {
		const recovery = authorities.length === 0 ? [] : [`  recovery_authorities: ${JSON.stringify(authorities)}`];
		return [
			"claims:",
			"  enabled: true",
			`  endpoint: ${JSON.stringify(this.url)}`,
			`  storage_format: ${this.format}`,
			"  lifetime_mode: lease",
			`  lease_ttl_ms: ${TTL}`,
			`  reclaim_grace_ms: ${GRACE}`,
			`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
			"  attempts: 3",
			`  operation_budget_ms: ${BUDGET_MS}`,
			`  clock_uncertainty_ms: ${EPS}`,
			"  retry_pause_base_ms: 1",
			"  retry_pause_max_ms: 1",
			...recovery,
		].join("\n");
	}

	/**
	 * The fixed wall clock T, a monotonic clock that never moves, no sleep, exactly the scripted operation IDs and
	 * `corpus` (default TICKET) as the local tasks: found by findLocalTicket and loaded by loadLocalTickets.
	 */
	// adapted from claim-emergency.test.ts:994
	env(options: EnvOptions = {}): ClaimSurfaceEnv {
		const ids = options.ids ?? [];
		const corpus = options.corpus ?? [TICKET];
		const issued = { count: 0 };
		return {
			projectRoot: this.project,
			claimsYaml: this.claimsYaml(options.authorities ?? []),
			taskPrefix: "BACK",
			findLocalTicket: (input: string) => {
				const found: LocalTicket = corpus.includes(input) ? { kind: "found", ticket: input } : { kind: "missing" };
				return Promise.resolve(found);
			},
			loadLocalTickets: () => Promise.resolve(corpusOf(corpus)),
			clock: () => T,
			monotonicNow: () => MONO_START,
			random: () => 0.5,
			sleep: () => Promise.resolve(),
			newOperationId: () => {
				const id = ids[issued.count];
				issued.count += 1;
				if (id === undefined) throw new Error("fixture: more operation IDs requested than scripted");
				return id;
			},
		};
	}

	/** Initializes the descriptor through the product at epoch 1 (unchanged by the epoch scaffold). */
	async initialize(): Promise<void> {
		const initialized = await initializeClaimStorage(this.storage());
		if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
	}

	// adapted from claim-emergency.test.ts:1016
	async serverRefs(): Promise<Refs> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Refs = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** Stores raw bytes as a blob in the server repository and points `ref` at it, bypassing the product. */
	// adapted from claim-storage-adapters.test.ts:300
	async setBlob(ref: string, text: string): Promise<string> {
		return this.point(ref, await this.writeObject(text));
	}

	// adapted from claim-storage-adapters.test.ts:460
	async point(ref: string, oid: string): Promise<string> {
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	/** Writes the descriptor of this case's format at `epoch` directly into the server repository. */
	async setDescriptor(epoch: number): Promise<string> {
		return this.setBlob(DESCRIPTOR_REF, canonicalText({ schema: 1, format: this.format, epoch }));
	}

	/** Stores `document` at `ref` in the agreed layout; commit-chain as one root commit (one receipt per document). */
	// adapted from claim-storage-adapters.test.ts:431
	async storeDocument(ref: string, document: StoredClaimDocument): Promise<string> {
		return this.point(ref, await this.encode(document, []));
	}

	/** Stores a commit chain, oldest layer first; each layer carries exactly its own receipt (storage/index.ts:519). */
	async storeChain(ref: string, layers: readonly StoredClaimDocument[]): Promise<string> {
		let head: string | undefined;
		for (const layer of layers) head = await this.encode(layer, head === undefined ? [] : [head]);
		if (head === undefined) throw new Error("fixture: a chain needs at least one layer");
		return this.point(ref, head);
	}

	/** Decodes a stored root in the agreed layout, independently of the product. */
	// adapted from claim-storage-adapters.test.ts:330
	async readStored(root: string): Promise<unknown> {
		if (this.format === "blob") return this.readJson(root);
		if (this.format === "tree") return this.readLayout(root);
		let document: Body | undefined;
		const receipts: [string, unknown][] = [];
		let commit: string | undefined = root;
		while (commit) {
			const { tree, parents } = await this.commitHeader(commit);
			const layer = await this.readLayout(tree);
			document ??= layer;
			receipts.push(...Object.entries(layer.receipts as Body));
			commit = parents[0];
		}
		return { ...document, receipts: Object.fromEntries(receipts) };
	}

	/** documentView of the object at `ref`; ABSENT_REF without a ref, "(undecodable)" for bytes of no layout. */
	async documentAt(ref: string): Promise<unknown> {
		const root = (await this.serverRefs())[ref];
		if (root === undefined) return ABSENT_REF;
		try {
			return documentView(await this.readStored(root));
		} catch {
			return "(undecodable)";
		}
	}

	/** The receipt IDs of every decodable document at `refs`, as stored. */
	async receiptIds(refs: readonly string[]): Promise<string[]> {
		const ids: string[] = [];
		const current = await this.serverRefs();
		for (const ref of refs) {
			const root = current[ref];
			if (root === undefined) continue;
			try {
				const receipts = field(await this.readStored(root), "receipts");
				if (receipts !== null && typeof receipts === "object") ids.push(...Object.keys(receipts));
			} catch {
				// Bytes of no layout carry no receipt.
			}
		}
		return ids;
	}

	/** The descriptor blob as stored, parsed without the product's decoder. */
	async descriptorAt(): Promise<unknown> {
		const root = (await this.serverRefs())[DESCRIPTOR_REF];
		return root === undefined ? ABSENT_REF : this.readJson(root);
	}

	/** A write's kind; when applied, its document and the root decoded independently. */
	async writeView(written: ClaimWriteResult): Promise<Body> {
		if (written.kind !== "applied") return { kind: written.kind };
		return { kind: "applied", document: written.document, stored: await this.readStored(written.root) };
	}

	/** The descriptor and a present read of TICKET through the one decoder access. */
	// adapted from claim-emergency.test.ts:1031
	async observe(): Promise<Observed> {
		const opened = await openStore(this.storage());
		if (opened.kind !== "open") throw new Error(`fixture: claim store cannot be opened (${opened.kind})`);
		const snapshot = await opened.store.read(TICKET);
		if (snapshot.kind !== "present") throw new Error(`fixture: expected a stored claim, got ${snapshot.kind}`);
		return { descriptor: opened.descriptor, snapshot };
	}

	/**
	 * An open release record of `handle` for the observed claim, planned by the product planner and prepared in the
	 * journal, as a `claim release` with a lost reply leaves it; `format` overrides the recorded storage format, as a
	 * record from before a migration carries the old one.
	 */
	// adapted from claim-emergency.test.ts:2040-2061 (em-p10), with the plan from the planner instead of by hand
	async prepareRelease(
		handle: ContextHandle,
		operationId: string,
		observed: Observed,
		format: ClaimStorageFormat = observed.descriptor.format,
	): Promise<void> {
		const plan = planClaimTransition({
			ticket: TICKET,
			descriptor: observed.descriptor,
			observed: observed.snapshot,
			binding: handle.context.binding,
			request: { action: "release" },
			now: T,
			clockSkewMs: EPS,
		});
		if (plan.kind !== "planned") throw new Error(`fixture: the release is not planned (${plan.kind})`);
		const descriptor = { ...observed.descriptor, format };
		const mapped = claimOperationIntentOf({ operationId, remote: this.url, descriptor, ticket: TICKET, plan });
		if (mapped.kind !== "intent") throw new Error("fixture: the release plan maps to no intent");
		const opened = await openClaimIntentJournal({ directory: handle.context.journalDirectory });
		if (opened.kind !== "open") throw new Error(`fixture: the journal cannot be opened (${opened.kind})`);
		const prepared = await opened.journal.prepare(mapped.intent);
		if (prepared.kind !== "prepared") throw new Error(`fixture: the record was not prepared (${prepared.kind})`);
	}

	// adapted from claim-emergency.test.ts:1048
	async journalView(handle: ContextHandle): Promise<JournalView> {
		const names = (await readdir(handle.context.journalDirectory)).sort(byCodeUnits);
		const record = (name: string) => !name.startsWith(".") && name.endsWith(".json");
		const slot = (name: string) => name.startsWith(".admission-");
		return {
			records: names.filter(record),
			slots: names.filter(slot).length,
			other: names.filter((name) => !record(name) && !slot(name)),
		};
	}

	// adapted from claim-emergency.test.ts:1103
	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}

	private async writeObject(text: string): Promise<string> {
		return (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
	}

	// adapted from claim-storage-adapters.test.ts:456
	private async mktree(rows: string): Promise<string> {
		return (await server().git(this.serverRepo, ["mktree"], rows)).out.trim();
	}

	/** Writes a commit with the agreed header bytes, independent of Git config and environment. */
	// adapted from claim-storage-adapters.test.ts:419
	private async commit(tree: string, parents: readonly string[], message: string): Promise<string> {
		const header = [
			`tree ${tree}`,
			...parents.map((parent) => `parent ${parent}`),
			`author ${CHAIN_IDENTITY}`,
			`committer ${CHAIN_IDENTITY}`,
		];
		const text = `${header.join("\n")}\n\n${message}`;
		return (await server().git(this.serverRepo, ["hash-object", "-t", "commit", "-w", "--stdin"], text)).out.trim();
	}

	/** The tree layout: a `state` blob (the document without receipts) and a `receipts` tree, one blob per ID. */
	// adapted from claim-storage-adapters.test.ts:483-496
	private async layoutTree(document: StoredClaimDocument): Promise<string> {
		const { receipts, ...state } = document;
		const rows: string[] = [];
		for (const [id, receipt] of Object.entries(receipts)) {
			rows.push(`100644 blob ${await this.writeObject(canonicalText(receipt))}\t${id}\n`);
		}
		const receiptTree = await this.mktree(rows.join(""));
		const stateBlob = await this.writeObject(canonicalText(state));
		return this.mktree(`100644 blob ${stateBlob}\tstate\n040000 tree ${receiptTree}\treceipts\n`);
	}

	/** Reference encoder of the agreed layouts; the chain as one commit on `parents` holding this layer's receipts. */
	// adapted from claim-storage-adapters.test.ts:475
	private async encode(document: StoredClaimDocument, parents: readonly string[]): Promise<string> {
		if (this.format === "blob") return this.writeObject(canonicalText(document));
		const tree = await this.layoutTree(document);
		if (this.format === "tree") return tree;
		return this.commit(tree, parents, chainMessage(document.ticket, document.revision));
	}

	// adapted from claim-storage-adapters.test.ts:619
	private async readJson(oid: string): Promise<unknown> {
		return JSON.parse((await server().git(this.serverRepo, ["cat-file", "blob", oid])).out);
	}

	// adapted from claim-storage-adapters.test.ts:346
	private async readLayout(tree: string): Promise<Body> {
		const entries = await this.treeEntries(tree);
		const state = entries.get("state");
		const receipts = entries.get("receipts");
		if (state?.type !== "blob" || receipts?.type !== "tree") throw new Error(`tree ${tree} is not a claim`);
		const decoded: [string, unknown][] = [];
		for (const [id, entry] of await this.treeEntries(receipts.oid)) {
			if (entry.type !== "blob") throw new Error(`receipt ${id} in ${tree} is not a blob`);
			decoded.push([id, await this.readJson(entry.oid)]);
		}
		const document = (await this.readJson(state.oid)) as Body;
		return { ...document, receipts: Object.fromEntries(decoded) };
	}

	// adapted from claim-storage-adapters.test.ts:364
	private async commitHeader(commit: string): Promise<{ tree: string; parents: string[] }> {
		const text = (await server().git(this.serverRepo, ["cat-file", "commit", commit])).out;
		const lines = text.slice(0, text.indexOf("\n\n")).split("\n");
		const tree = lines.find((line) => line.startsWith("tree "))?.slice("tree ".length);
		if (!tree) throw new Error(`commit ${commit} has no tree`);
		const parents = lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice("parent ".length));
		return { tree, parents };
	}

	// adapted from claim-storage-adapters.test.ts:373
	private async treeEntries(tree: string): Promise<Map<string, { type: string; oid: string }>> {
		const out = (await server().git(this.serverRepo, ["ls-tree", "-z", tree])).out;
		const entries = new Map<string, { type: string; oid: string }>();
		for (const row of out.split("\0").filter(Boolean)) {
			const tab = row.indexOf("\t");
			const [, type, oid] = row.slice(0, tab).split(" ");
			if (tab < 0 || !type || !oid) throw new Error(`invalid ls-tree row: ${row}`);
			entries.set(row.slice(tab + 1), { type, oid });
		}
		return entries;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-emergency.test.ts:1109
async function withCase(
	caseName: string,
	format: ClaimStorageFormat,
	body: (fixture: EpochCase) => Promise<void>,
): Promise<void> {
	const fixture = await EpochCase.create(caseName, format);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

function acquireInput(handle: ContextHandle): ClaimMutationInput {
	return { command: "acquire", ticket: TICKET, owner: OWNER, context: handle.directory };
}

// ===============================================================================================================

describe("epoch-aware storage and the epoch rules of install-epoch over real Git", () => {
	beforeAll(async () => {
		fixtureServer = await GitFixtureServer.create();
	});

	afterAll(async () => {
		await fixtureServer?.close();
	});

	test(
		"ep-p01: the descriptor carries any positive safe integer as its epoch; every other epoch value is corrupt",
		async () => {
			await withCase("ep-p01", "blob", async (c) => {
				const decode = async (text: string): Promise<DescriptorVerdict> => {
					await c.setBlob(DESCRIPTOR_REF, text);
					return descriptorVerdict(await openStore(c.storage()));
				};
				// Positive control (catches: the scaffold's rule `epoch !== 1` → corrupt (storage/index.ts:209); the epoch
				// rebuilt as the constant 1 (:210) instead of carried into the result).
				expect(await decode(descriptorText(2))).toStrictEqual(openedAt(2));
				const rows: DescriptorRow[] = [
					{
						label: "epoch 3",
						catches: "an allow-list of the epochs 1 and 2 instead of the rule",
						text: descriptorText(3),
						expected: openedAt(3),
					},
					{
						label: "the largest safe integer",
						catches: "an upper bound below Number.MAX_SAFE_INTEGER",
						text: descriptorText(Number.MAX_SAFE_INTEGER),
						expected: openedAt(Number.MAX_SAFE_INTEGER),
					},
					{
						label: "epoch 1",
						catches: "the first epoch lost while the rule opens up",
						text: descriptorText(1),
						expected: openedAt(1),
					},
					{
						label: "a tree descriptor at epoch 2 opened as blob",
						catches: "a migrated descriptor read as corrupt instead of format-mismatch",
						text: canonicalText({ schema: 1, format: "tree", epoch: 2 }),
						expected: { kind: "format-mismatch", descriptor: { schema: 1, format: "tree", epoch: 2 } },
					},
					{
						label: "schema 2 with epoch 0",
						catches: "the epoch checked before the schema (storage/index.ts:206-209)",
						text: canonicalText({ schema: 2, format: "blob", epoch: 0 }),
						expected: { kind: "schema-unsupported" },
					},
					{ label: "epoch 0", catches: "zero taken for a positive epoch", text: descriptorText(0), expected: CORRUPT },
					{ label: "epoch -1", catches: "only zero refused", text: descriptorText(-1), expected: CORRUPT },
					{
						label: "epoch 1.5",
						catches: "a number check without the integer rule",
						text: descriptorText(1.5),
						expected: CORRUPT,
					},
					{
						label: "no epoch",
						catches: "a missing epoch defaulted to 1",
						text: canonicalText({ schema: 1, format: "blob" }),
						expected: CORRUPT,
					},
					{
						label: "the epoch as a string",
						catches: "a numeric string coerced",
						text: descriptorText("2"),
						expected: CORRUPT,
					},
					{
						label: "Number.MAX_SAFE_INTEGER + 1",
						catches: "Number.isInteger instead of Number.isSafeInteger",
						text: descriptorText(Number.MAX_SAFE_INTEGER + 1),
						expected: CORRUPT,
					},
					{ label: "null", catches: "null read as missing, defaulted", text: descriptorText(null), expected: CORRUPT },
					{ label: "true", catches: "a truthiness check", text: descriptorText(true), expected: CORRUPT },
					{
						label: "a one-element list",
						catches: "a list unwrapped or coerced",
						text: descriptorText([2]),
						expected: CORRUPT,
					},
				];
				const views: { label: string; verdict: DescriptorVerdict }[] = [];
				for (const row of rows) views.push({ label: rowLabel(row), verdict: await decode(row.text) });
				// catches: each row's label; only kinds and descriptors are compared, never a reason text
				expect(views).toStrictEqual(rows.map((row) => ({ label: rowLabel(row), verdict: row.expected })));
			});
		},
		GIT_TIMEOUT,
	);

	for (const format of FORMATS) {
		test(
			`ep-p02: documents are checked against the epoch of the opened store on read, write and list (${format})`,
			async () => {
				await withCase(`ep-p02-${format}`, format, async (c) => {
					const chain = format === "commit-chain";
					// Setup by Git plumbing only: descriptor 2, a document of epoch 1, one of epoch 2 and, for the chain, one
					// whose ancestor is of epoch 1 and one of epoch 2 throughout.
					await c.setDescriptor(2);
					const oldDocument = docOf(format, 1, OLD_TICKET, 1, tombstone(3), { "op-old": OLD_RECEIPT });
					const oldRoot = await c.storeDocument(claimRef(OLD_TICKET), oldDocument);
					const newDocument = docOf(format, 2, NEW_TICKET, 1, tombstone(4), { [M_ID]: maintenance(1) });
					const newRoot = await c.storeDocument(claimRef(NEW_TICKET), newDocument);
					const deepDocument = docOf(format, 2, DEEP_TICKET, 2, tombstone(6), {
						[M_ID]: maintenance(1),
						"op-deep": OLD_RECEIPT,
					});
					let deepRoot = ABSENT_REF;
					if (chain) {
						await c.storeChain(claimRef(MIXED_TICKET), [
							docOf(format, 1, MIXED_TICKET, 1, tombstone(2), { "op-mixed": OLD_RECEIPT }),
							docOf(format, 2, MIXED_TICKET, 2, tombstone(3), { [M_ID]: maintenance(1) }),
						]);
						deepRoot = await c.storeChain(claimRef(DEEP_TICKET), [
							docOf(format, 2, DEEP_TICKET, 1, tombstone(5), { [M_ID]: maintenance(1) }),
							docOf(format, 2, DEEP_TICKET, 2, tombstone(6), { "op-deep": OLD_RECEIPT }),
						]);
					}
					// toEqual wherever the product decodes a document: tree and chain reads carry receipts in a null-prototype
					// object (storage/index.ts:468, :507), which toStrictEqual would tell apart from a literal.
					const opened = await openStore(c.storage());
					const first = opened.kind === "open" ? readView(await opened.store.read(NEW_TICKET)) : opened.kind;
					// Positive control (catches: descriptor 2 still corrupt, the scaffold (storage/index.ts:209); a store that
					// opens but still compares documents with the constant 1 (:148) and so reads the epoch-2 document corrupt).
					expect({ descriptor: descriptorVerdict(opened), read: first }).toEqual({
						descriptor: openedAt(2, format),
						read: present(newDocument, newRoot),
					});
					const store = storeOf(opened);

					const reads: ReadRow[] = [
						{
							label: "a document of epoch 1",
							catches: "the old document read as present under the new descriptor (unknown, never free)",
							ticket: OLD_TICKET,
							expected: { kind: "corrupt" },
						},
						{
							label: "no ref",
							catches: "an absent ticket reported corrupt by the new rule",
							ticket: ABSENT_TICKET,
							expected: { kind: "absent" },
						},
					];
					if (chain) {
						reads.push(
							{
								label: "a chain whose ancestor is of epoch 1",
								catches: "only the head layer compared with the store epoch (storage/index.ts:522)",
								ticket: MIXED_TICKET,
								expected: { kind: "corrupt" },
							},
							{
								label: "a chain of epoch 2 throughout",
								catches: "an ancestor compared with the constant 1 (every check against the store epoch)",
								ticket: DEEP_TICKET,
								expected: present(deepDocument, deepRoot),
							},
						);
					}
					const readViews: Body[] = [];
					for (const row of reads) {
						readViews.push({ label: rowLabel(row), read: readView(await store.read(row.ticket)) });
					}
					// catches: each row's label
					expect(readViews).toEqual(reads.map((row) => ({ label: rowLabel(row), read: row.expected })));

					const listed = await runClaimList({}, c.env());
					const chainEntries = chain
						? [
								listEntry({ ticket: MIXED_TICKET, state: "unknown" }, 2),
								listEntry({ ticket: DEEP_TICKET, state: "free", claimGeneration: 6 }, 2),
							]
						: [];
					// catches: an old document listed free or with a generation (unknown, never free); a
					// readable entry without the epoch of the store; status ok beside an unknown entry
					expect(bodyOf(listed)).toStrictEqual({
						schemaVersion: 1,
						kind: "claim-list",
						status: "unknown",
						command: "list",
						complete: false,
						observedAt: T,
						claims: [
							listEntry({ ticket: OLD_TICKET, state: "unknown" }, 2),
							listEntry({ ticket: NEW_TICKET, state: "free", claimGeneration: 4 }, 2),
							...chainEntries,
						],
					});

					const created = await store.write(
						{ kind: "absent", ticket: ABSENT_TICKET },
						change("op-epoch-write-3", tombstone(1)),
					);
					const base = await store.read(NEW_TICKET);
					const extended =
						base.kind === "present"
							? await c.writeView(await store.write(base, change("op-epoch-write-2", tombstone(5))))
							: { kind: base.kind };
					const reread = await store.read(NEW_TICKET);
					const createdDocument = docOf(format, 2, ABSENT_TICKET, 1, tombstone(1), {
						"op-epoch-write-3": WRITE_RECEIPT,
					});
					const extendedDocument = docOf(format, 2, NEW_TICKET, 2, tombstone(5), {
						[M_ID]: maintenance(1),
						"op-epoch-write-2": WRITE_RECEIPT,
					});
					expect({
						created: await c.writeView(created),
						extended,
						reread: reread.kind === "present" ? reread.document : reread.kind,
					}).toEqual({
						// catches: a new document stamped with the constant 1 (storage/index.ts:713)
						created: { kind: "applied", document: createdDocument, stored: createdDocument },
						// catches: a follow-up write losing or resetting its base's epoch (the spread of :719-724)
						extended: { kind: "applied", document: extendedDocument, stored: extendedDocument },
						// catches: the store refusing its own write on the next read (chain: an ancestor checked against 1)
						reread: extendedDocument,
					});

					const refs = await c.serverRefs();
					const stale = await store.write(
						{ kind: "present", ticket: OLD_TICKET, root: oldRoot, document: oldDocument },
						change("op-epoch-write-1", tombstone(4)),
					);
					// catches: a document of the old epoch accepted as the base of a write in the new epoch (storage/index.ts
					// :694): its root would be the lease of a claim write again and an epoch-1 document would land
					expect({ kind: stale.kind, refs: await c.serverRefs() }).toStrictEqual({ kind: "invalid", refs });

					await c.setDescriptor(1);
					const reopened = await openStore(c.storage());
					const earlier = storeOf(reopened);
					const guardWrite = await earlier.write(
						{ kind: "absent", ticket: GUARD_TICKET },
						change("op-epoch-write-6", tombstone(1)),
					);
					const guardDocument = docOf(format, 1, GUARD_TICKET, 1, tombstone(1), {
						"op-epoch-write-6": WRITE_RECEIPT,
					});
					// Guard, green on the scaffold as well: under descriptor 1 every rule stays as it is today.
					expect({
						descriptor: descriptorVerdict(reopened),
						old: readView(await earlier.read(OLD_TICKET)),
						later: readView(await earlier.read(NEW_TICKET)),
						created: await c.writeView(guardWrite),
					}).toEqual({
						descriptor: openedAt(1, format),
						// catches: the store epoch taken from a document instead of the descriptor
						old: present(oldDocument, oldRoot),
						// catches: a document of a later epoch accepted by a store of an earlier one
						later: { kind: "corrupt" },
						// catches: a new document stamped with the highest epoch seen instead of the store's
						created: { kind: "applied", document: guardDocument, stored: guardDocument },
					});
				});
			},
			GIT_TIMEOUT,
		);
	}

	test(
		"ep-p03: an intent of epoch 1 against descriptor 2 is never sent: resend and retry end unknown-history",
		async () => {
			await withCase("ep-p03", "blob", async (c) => {
				await c.initialize();
				const karl = await c.context();
				// Setup at epoch 1 through the product: Karl acquires, then holds an open release record (as a lost reply
				// leaves it) and a record of the same release in the tree format (as a migration from tree strands it).
				const acquired = await runClaimMutation(acquireInput(karl), c.env({ ids: [ACQUIRE_ID] }));
				if (field(acquired, "status") !== "applied") throw new Error("fixture: the acquire at epoch 1 failed");
				const before = await c.observe();
				await c.prepareRelease(karl, RELEASE_ID, before);
				await c.prepareRelease(karl, FORMAT_ID, before, "tree");
				// The restore by hand: the archive ref on the old root, a fresh FREE document of epoch 2 with
				// generation 1 + 1, then the descriptor. Plumbing only, so no setup step needs the change under test.
				await c.point(`${ARCHIVE_PREFIX}1/${TICKET}`, before.snapshot.root);
				await c.storeDocument(claimRef(TICKET), docOf("blob", 2, TICKET, 1, tombstone(2), { [M_ID]: maintenance(1) }));
				await c.setDescriptor(2);
				const refs = await c.serverRefs();
				const journal = await c.journalView(karl);
				const record = { operationId: RELEASE_ID, context: karl.directory };
				const resend = (operationId: string) =>
					resendClaimIntent({
						storage: c.storage(c.project),
						contextDirectory: karl.directory,
						operationId,
						clockSkewMs: EPS,
						clock: () => T,
						attempts: 3,
					});

				const resent = await resend(RELEASE_ID);
				// Positive control (catches: the scaffold's store that cannot open descriptor 2 (`unknown`); today's path,
				// where the resolution maps the epoch difference to `invalid` and so to `unknown`/3 (resolution/index.ts
				// :89-97, execution/index.ts:215-223, :1004-1010), an answer that invites a retry which never sends;
				// any send, admission slot or ref move).
				expect({
					result: pick(resent, ["kind", "action", "operationId", "outcome", "sends"]),
					refs: await c.serverRefs(),
					journal: await c.journalView(karl),
				}).toStrictEqual({
					result: {
						kind: "operation",
						action: "release",
						operationId: RELEASE_ID,
						outcome: { kind: "unknown-history" },
						sends: 0,
					},
					refs,
					journal,
				});

				const retried = await runClaimRetry(record, c.env());
				// catches: the epoch difference refused as scope-mismatch/5 by the scope check (surface/index.ts:2937-2939);
				// a send or an admission slot. `claim-operation`, because unknown-history is no error status (surface :199)
				// and the code list is closed.
				expect({
					exit: exitOf(retried),
					document: pick(retried, ["kind", "status", "command", "action", "ticket", "operationId", "outcome", "sends"]),
					refs: await c.serverRefs(),
					journal: await c.journalView(karl),
				}).toStrictEqual({
					exit: 4,
					document: {
						kind: "claim-operation",
						status: "unknown-history",
						command: "retry",
						action: "release",
						ticket: TICKET,
						operationId: RELEASE_ID,
						outcome: "unknown-history",
						sends: 0,
					},
					refs,
					journal,
				});

				const resolved = await runClaimResolve(record, c.env());
				const resolutionKeys = ["kind", "status", "command", "operationId", "ticket", "action", "outcome", "query"];
				// catches: resolve losing its answer once descriptor 2 opens (query/index.ts:122-123 → surface :1826)
				expect({ exit: exitOf(resolved), document: pick(resolved, resolutionKeys) }).toStrictEqual({
					exit: 4,
					document: {
						kind: "claim-resolution",
						status: "unknown-history",
						command: "resolve",
						operationId: RELEASE_ID,
						ticket: TICKET,
						action: "release",
						outcome: "unknown-history",
						query: { kind: "unknown-history" },
					},
				});

				const migrated = await runClaimRetry({ operationId: FORMAT_ID, context: karl.directory }, c.env());
				// Guard (catches: the epoch compared before the format, so that a record of the old format answers
				// unknown-history after a migration instead of scope-mismatch/5)
				expect({ exit: exitOf(migrated), body: bodyOf(migrated), refs: await c.serverRefs() }).toStrictEqual({
					exit: 5,
					body: errorBody("retry", "scope-mismatch", TICKET, FORMAT_ID),
					refs,
				});

				// The current epoch still resends: Karl acquires anew at epoch 2, then a release record of epoch 2 is resent.
				const reacquired = await runClaimMutation(acquireInput(karl), c.env({ ids: [ACQUIRE2_ID] }));
				// catches: an acquire refused or paused at epoch 2 (a record of epoch 1 pauses nothing, pause/index.ts:96-104)
				expect(pick(reacquired, ["kind", "status"])).toStrictEqual({ kind: "claim-operation", status: "applied" });
				await c.prepareRelease(karl, RELEASE2_ID, await c.observe());
				const resentNew = await resend(RELEASE2_ID);
				const stored = await c.documentAt(claimRef(TICKET));
				// catches: every resend refused after a swap (the intent epoch compared with the constant 1, or every record
				// refused once the store has a later epoch)
				expect({
					result: pick(resentNew, ["kind", "action", "operationId", "outcome", "sends"]),
					stored: pick(stored, ["epoch", "revision", "payload"]),
					receipts: receiptLabels(stored),
				}).toStrictEqual({
					result: {
						kind: "operation",
						action: "release",
						operationId: RELEASE2_ID,
						outcome: { kind: "applied" },
						sends: 1,
					},
					stored: { epoch: 2, revision: 3, payload: tombstone(3) },
					receipts: sorted([ACQUIRE2_ID, M_ID_LABEL, RELEASE2_ID]),
				});
			});
		},
		GIT_TIMEOUT,
	);

	test(
		"ep-p04: a restore writes FREE documents of epoch 2, generation + 1 for a readable state, else 1, all roots new",
		async () => {
			await withCase("ep-p04", "blob", async (c) => {
				const rows: GenerationRow[] = [
					{
						label: "ACTIVE at generation 3",
						catches: "the generation kept, like a regular release (the contract rejects it), or reset to 1",
						ticket: "BACK-1",
						before: { payload: active(lease(), { claimGeneration: 3 }) },
						generation: 4,
					},
					{
						label: "FREE at generation 5",
						catches: "a FREE tombstone counted as unreadable",
						ticket: "BACK-2",
						before: { payload: tombstone(5) },
						generation: 6,
					},
					{
						label: "PENDING at the target's generation 4",
						catches: "the source's generation 3 taken; PENDING counted as unreadable (the contract names it readable)",
						ticket: "BACK-3",
						before: { payload: pendingState() },
						generation: 5,
					},
					{
						label: "a corrupt payload that names generation 7",
						catches: "a generation taken from a state the rights layer calls corrupt (would give 8)",
						ticket: "BACK-4",
						before: { payload: { state: "claimed", claimGeneration: 7 } },
						generation: 1,
					},
					{
						label: "an unsupported claim state at generation 7",
						catches: "a generation taken from a state this version cannot parse (would give 8)",
						ticket: "BACK-5",
						before: { payload: { claimState: 2, status: "active", claimGeneration: 7 } },
						generation: 1,
					},
					{
						label: "bytes that are no document",
						catches: "an unreadable ref skipped instead of rewritten",
						ticket: "BACK-6",
						before: { raw: `not a claim ${SENTINEL}\n` },
						generation: 1,
					},
					{
						label: "a corpus task without a ref",
						catches: "the creation set left out (a delayed creation would land)",
						ticket: "BACK-7",
						before: null,
						generation: 1,
					},
					{
						label: "--ticket without a task file or ref",
						catches: "--ticket ignored, or refused for want of a local task",
						ticket: EXTRA_TICKET,
						before: null,
						generation: 1,
					},
					{
						label: "a timeless ACTIVE at generation 9 without a task file",
						catches: "only corpus tickets rewritten; the timeless mode skipped",
						ticket: "BACK-9",
						before: { payload: active(TIMELESS, { claimGeneration: 9, owner: OTHER_OWNER, binding: FRANZ }) },
						generation: 10,
					},
					{
						label: "a FREE document of epoch 2 under descriptor 1",
						catches: "the generation read from the payload without the store's epoch check (would give 8)",
						ticket: "BACK-10",
						before: { payload: tombstone(7), epoch: 2 },
						generation: 1,
					},
				];
				// Setup by Git plumbing only: descriptor 1 and the old states of the rows (revision 2, one old receipt).
				await c.setDescriptor(1);
				const oldRoots: Refs = {};
				for (const row of rows) {
					if (row.before === null) continue;
					const ref = claimRef(row.ticket);
					oldRoots[row.ticket] =
						"raw" in row.before
							? await c.setBlob(ref, row.before.raw)
							: await c.storeDocument(
									ref,
									docOf("blob", row.before.epoch ?? 1, row.ticket, 2, row.before.payload, { "op-old": OLD_RECEIPT }),
								);
				}
				const withRef = rows.filter((row) => row.before !== null);
				const rewritten = ticketList(withRef.map((row) => row.ticket));
				const created = ticketList(rows.filter((row) => row.before === null).map((row) => row.ticket));
				const unreadable = ticketList(withRef.filter((row) => row.generation === 1).map((row) => row.ticket));
				const operator = await c.context();
				const secret = await secretOf(operator.directory);
				const operatorId = authorityOf(secret);
				const env = c.env({ ids: SPARE_IDS, authorities: [operatorId], corpus: CORPUS });
				const input: InstallEpochInput = {
					context: operator.directory,
					expectEpoch: 1,
					isolationConfirmed: true,
					tickets: [EXTRA_TICKET],
				};
				const refsBefore = await c.serverRefs();
				const preview = await installEpoch({ ...input, preview: true }, env);
				const refsAfterPreview = await c.serverRefs();
				const result = await installEpoch(input, env);
				const refsAfter = await c.serverRefs();

				// Positive control (catches: the scaffold writing nothing; the ACTIVE state kept; its generation kept, like
				// a regular release, or reset to 1 instead of 3 + 1; another epoch, revision or receipt set).
				expect(await c.documentAt(claimRef("BACK-1"))).toStrictEqual(freshDocument("BACK-1", 4));

				const documents: Body[] = [];
				for (const row of rows) {
					documents.push({ label: rowLabel(row), document: await c.documentAt(claimRef(row.ticket)) });
				}
				// catches: each row's label; the whole document is compared, so a kept state (every ticket FREE), an old
				// epoch, a revision other than 1, a receipt carried over or a second receipt shows
				expect(documents).toStrictEqual(
					rows.map((row) => ({ label: rowLabel(row), document: freshDocument(row.ticket, row.generation) })),
				);

				const newRoots = rows.map((row) => refsAfter[claimRef(row.ticket)] ?? ABSENT_REF);
				const oldList = Object.values(oldRoots);
				// catches: an old root written again (3A: fresh roots, never a reused root ID); two tickets at one
				// root
				expect({
					reused: newRoots.filter((root) => oldList.includes(root)),
					distinct: new Set(newRoots).size,
				}).toStrictEqual({ reused: [], distinct: rows.length });

				const archived = Object.fromEntries(
					rewritten.map((ticket) => [`${ARCHIVE_PREFIX}1/${ticket}`, oldRoots[ticket] ?? ABSENT_REF]),
				);
				// catches: an old root dropped instead of archived; an archive ref for a created ticket
				// or under the new epoch's number; a ticket ref missing, deleted or added
				expect(refShape(refsAfter)).toStrictEqual({
					archive: archived,
					tickets: sorted(rows.map((row) => claimRef(row.ticket))),
					other: [DESCRIPTOR_REF],
				});
				// catches: the descriptor not swapped, or swapped to another format without --storage-format
				expect(await c.descriptorAt()).toStrictEqual({ epoch: 2, format: "blob", schema: 1 });

				const sentinels: Sentinel[] = [
					["sentinel", SENTINEL],
					["case root", c.root],
					["endpoint", c.url],
					["binding", operator.context.binding],
					["context", operator.directory],
					["journal", operator.context.journalDirectory],
					["authority ID", operatorId],
					["secret", secret],
					["old binding", KARL],
					["old binding", FRANZ],
					["old owner", OWNER],
					["old owner", OTHER_OWNER],
				];
				for (const [ref, oid] of Object.entries(refsBefore)) sentinels.push([`old object of ${ref}`, oid]);
				for (const [ref, oid] of Object.entries(refsAfter)) sentinels.push([`object of ${ref}`, oid]);
				for (const id of await c.receiptIds(rows.map((row) => claimRef(row.ticket)))) {
					sentinels.push(["receipt ID", id]);
				}
				// catches: a partial run or a breach reported applied; counts instead of ticket lists, or unsorted lists
				// ; a root, a path, a binding, an authority ID or a receipt ID in the document (allowlist)
				expect({
					exit: exitOf(result),
					body: bodyOf(result),
					echoed: echoedIn(JSON.stringify(result), sentinels),
				}).toStrictEqual({
					exit: 0,
					body: epochDocument("applied", {
						fromEpoch: 1,
						epoch: 2,
						format: "blob",
						previousFormat: "blob",
						rewritten,
						created,
						breached: [],
						unsettled: [],
						isolation: "attested",
					}),
					echoed: [],
				});
				// catches: a preview that writes (nothing written); readable and unreadable old documents mixed
				// up; the epoch of the store shown instead of the one a run would install
				expect({
					exit: exitOf(preview),
					body: bodyOf(preview),
					echoed: echoedIn(JSON.stringify(preview), sentinels),
					refs: refsAfterPreview,
				}).toStrictEqual({
					exit: 0,
					body: epochPreviewDocument({ epoch: 2, format: "blob", listed: rewritten, toCreate: created, unreadable }),
					echoed: [],
					refs: refsBefore,
				});
			});
		},
		LONG_GIT_TIMEOUT,
	);

	test(
		"ep-p05: a malformed input ends refused/5 with its code before the preflight, so before any Git call",
		async () => {
			await withCase("ep-p05", "blob", async (c) => {
				const operator = await c.context();
				const env: ClaimSurfaceEnv = {
					...c.env({ authorities: [authorityOf(await secretOf(operator.directory))] }),
					projectRoot: RELATIVE_ROOT,
				};
				const context = operator.directory;
				const valid: Body = { context, expectEpoch: 1, isolationConfirmed: true };
				const view = async (input: Body): Promise<Body> => {
					const document = await installEpoch(input as unknown as InstallEpochInput, env);
					return { exit: exitOf(document), body: bodyOf(document) };
				};
				const refusal = (code: string): Body => ({ exit: 5, body: errorBody(EPOCH_COMMAND, code, null, null) });
				// Positive control (catches: the scaffold, whose run reaches no preflight; a well-formed input of a listed
				// operator refused by a local check): the valid input passes every local check and the authority and ends at
				// the preflight's option check on the relative project root (config/index.ts:555), before any Git.
				expect(await view(valid)).toStrictEqual(refusal("preflight-invalid"));
				const rows: InputRow[] = [
					{
						label: "no --expect-epoch",
						catches: "a missing expectation read as the store's epoch (the contract requires it)",
						input: { context, isolationConfirmed: true },
						code: "invalid-option",
					},
					{
						label: "--expect-epoch 0",
						catches: "zero taken for an epoch (epochs start at 1)",
						input: { ...valid, expectEpoch: 0 },
						code: "invalid-option",
					},
					{
						label: "--expect-epoch -1",
						catches: "only zero refused",
						input: { ...valid, expectEpoch: -1 },
						code: "invalid-option",
					},
					{
						label: "--expect-epoch 1.5",
						catches: "a number check without the integer rule",
						input: { ...valid, expectEpoch: 1.5 },
						code: "invalid-option",
					},
					{
						label: "--expect-epoch abc",
						catches:
							"the NaN claim.ts passes for it (claim.ts:278) compared with the store's epoch: rejected epoch-changed",
						input: { ...valid, expectEpoch: Number.NaN },
						code: "invalid-option",
					},
					{
						label: "--expect-epoch past the largest safe integer",
						catches: "Number.isInteger instead of Number.isSafeInteger",
						input: { ...valid, expectEpoch: Number.MAX_SAFE_INTEGER + 1 },
						code: "invalid-option",
					},
					{
						label: "--storage-format zip",
						catches: "an unknown format handed to the storage",
						input: { ...valid, storageFormat: "zip" },
						code: "invalid-option",
					},
					{
						label: "an empty --storage-format",
						catches: "an empty format read as no format",
						input: { ...valid, storageFormat: "" },
						code: "invalid-option",
					},
					{
						label: "no --context",
						catches: "a context derived instead of required",
						input: { expectEpoch: 1, isolationConfirmed: true },
						code: "context-required",
					},
					{
						label: "a relative --context",
						catches: "a relative path resolved against the working directory",
						input: { ...valid, context: `contexts-${SENTINEL}/operator` },
						code: "context-invalid",
					},
					{
						label: "--ticket not a ticket",
						catches: "a malformed ID planted as a ref",
						input: { ...valid, tickets: ["not a ticket"] },
						code: "invalid-ticket",
					},
					{
						label: "a malformed second --ticket",
						catches: "only the first ticket checked",
						input: { ...valid, tickets: [TICKET, "not a ticket"] },
						code: "invalid-ticket",
					},
				];
				const views: Body[] = [];
				for (const row of rows) views.push({ label: rowLabel(row), ...(await view(row.input)) });
				// catches in every row: the input checked after the preflight or not at all (every
				// input code refused/5 before any Git call; past the local checks this root ends preflight-invalid)
				expect(views).toStrictEqual(rows.map((row) => ({ label: rowLabel(row), ...refusal(row.code) })));
			});
		},
		GIT_TIMEOUT,
	);
});
