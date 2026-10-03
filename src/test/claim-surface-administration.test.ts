/**
 * The claim surface lists its documents from one source: a recorded transfer, resume or change-bounds operation and the
 * four new plan causes end in the same public document kinds as the four base actions, never in `internal` or
 * `record-corrupt`. sad-01 is level G: the surface core in process against the loopback Git daemon of
 * claim-git-fixture.ts, blob only, with a transfer intent that a hand-built `planned` plan put into the source
 * context's journal, because the scaffold never plans a transfer; then `runClaimResolve` and `runClaimRetry` of that
 * record. sad-02 and sad-03 are level P over synthetic executor results. Deviation from "pure, no Git":
 * `claimResolutionDocument` copies the action it is given, so its pure form passes on the scaffold already; the action
 * lists bite only in `runClaimResolve`, `runClaimRetry` and `resendClaimIntent`. Names the scaffold has to provide are
 * marked ASSUMPTION.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { type ClaimExecutionResult, claimOperationIntentOf } from "../claims/execution/index.ts";
import { type ClaimOperationIntent, openClaimIntentJournal } from "../claims/journal/index.ts";
import type { ClaimMutationQueryResult } from "../claims/query/index.ts";
import type { ClaimMutationResolution } from "../claims/resolution/index.ts";
import {
	type ClaimRightEvaluation,
	type ClaimStateV1,
	parseClaimState,
	queryClaimRight,
} from "../claims/rights/index.ts";
import {
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageOptions,
	initializeClaimStorage,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	type ClaimDocument,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimExitCode,
	claimOperationDocument,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import type { ClaimTransitionAction, ClaimTransitionPlan, ClaimTransitionRequest } from "../claims/transition/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";

type Body = Record<string, unknown>;
type ContextHandle = { context: ClaimContext; directory: string };
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type Sentinel = readonly [label: string, value: string];
type Present = Extract<ClaimSnapshot, { kind: "present" }>;
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type Operation = Extract<ClaimExecutionResult, { kind: "operation" }>;
type NotPlanned = Extract<ClaimExecutionResult, { kind: "not-planned" }>;
type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
/** The four plan causes the administration actions add, all without `boundary`. */
type NewCause = "time-box-required" | "requires-time-path" | "lease-required" | "mode-change";
/** Level G: the whole public document with a non-empty message replaced, its exit code and the echoed sentinels. */
type DocumentView = { label: string; exit: number; body: Body; echoed: string[] };
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };
/** Level P: the whole document, exit code, sorted keys, sorted rejection keys and the number of echoed sentinels. */
type MappedView = {
	label: string;
	exit: number;
	keys: string[];
	rejectionKeys: string[] | null;
	body: Body;
	echoed: number;
};

const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms of the configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Appears in the case root, the context parent and the level P inputs; no document may contain it. */
const SENTINEL = "SENTINEL-surface-administration-3e82";
const TICKET = "BACK-1";
const CLAIM_REF = `refs/claims/${TICKET}`;
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-execution-retry.test.ts:82
const ABSENT_REF = "(no ref)";
/** Acquire needs a local task file; the stub knows exactly this one, already canonical. */
const LOCAL_TICKETS: readonly string[] = [TICKET];
/** Display names only; no operation, pause or resolution document may echo either. */
const OWNER = "agent-sentinel-karl";
const RECIPIENT = "agent-sentinel-franz";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock for claim times. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Lease end "10:05" of the acquire at T and its reclaim boundary "10:15"; a transfer at T renews to the same L. */
const L = T + TTL;
const R = L + GRACE;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;
/** Operation IDs; code-unit order ACQUIRE_ID < TRANSFER_ID, so journal listings are written in that order. */
const ACQUIRE_ID = "op-5d0c6f1e-2b7a-4c3d-8e9f-0a1b2c3d4e5f";
const TRANSFER_ID = "op-8e1f2a3b-4c5d-4e6f-9a0b-1c2d3e4f5a6b";
const RENEW_ID = "op-c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** The closed status table, written out so the constant under test is not its own oracle. */
const EXPECTED_EXIT: Record<string, number> = {
	ok: 0,
	applied: 0,
	rejected: 2,
	unknown: 3,
	"unknown-history": 4,
	refused: 5,
	unavailable: 6,
	paused: 7,
	internal: 1,
};

// Level P inputs (adapted from claim-surface.test.ts:107-119): upstream reasons, roots, bindings, paths and endpoints
// carry sentinels, now including the target and recovery bindings.
const OP = "op-7c2e4f10-58d1-4b8e-9a3f-0d6c1e2b3a45";
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const RESUMED = `tb1-${"9d".repeat(32)}`;
const ROOT = "a1".repeat(20);
const SECRET = `secret-${SENTINEL}`;
const CONTEXT_PATH = `/tmp/contexts-${SENTINEL}/context-1`;
const ENDPOINT = `http://127.0.0.1:9/${SENTINEL}/claims.git`;
const REASON = `upstream ${SENTINEL} ${KARL} ${FRANZ} ${RESUMED} ${ROOT}`;
const SENSITIVE = [SENTINEL, KARL, FRANZ, RESUMED, ROOT, SECRET, CONTEXT_PATH, ENDPOINT, OWNER, RECIPIENT];
/** Fields a spread of an upstream object would leak (builders set every field one by one). */
const TAINT = {
	binding: KARL,
	targetBinding: FRANZ,
	recoveryBinding: RESUMED,
	owner: RECIPIENT,
	secret: SECRET,
	contextDirectory: CONTEXT_PATH,
	remote: ENDPOINT,
};

// adapted from claim-surface.test.ts:190
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-surface.test.ts:184
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Level G harness: adapted from claim-surface-git.test.ts:86-395 (SurfaceCase), blob only, without the S2 trace.
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: GitFixtureServer | undefined;

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-git.test.ts:108
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-surface-git.test.ts:113
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** Local lookup of acquire, stubbed: LOCAL_TICKETS exist as task files, nothing else does. */
// adapted from claim-surface-git.test.ts:150
function findLocalTicket(input: string): Promise<LocalTicket> {
	const found: LocalTicket = LOCAL_TICKETS.includes(input) ? { kind: "found", ticket: input } : { kind: "missing" };
	return Promise.resolve(found);
}

/**
 * The mandatory corpus seam, stubbed like findLocalTicket. LOCAL_TICKETS are open tasks without
 * dependencies, so the default strict gate lets their acquire through; a ticket missing here would be
 * dependency-unknown.
 */
// adapted from claim-surface-git.test.ts
function loadLocalTickets(): Promise<LocalTickets> {
	const tasks: Task[] = LOCAL_TICKETS.map((id) => ({
		id,
		title: id,
		status: "To Do",
		assignee: [],
		createdDate: "2026-01-01 00:00",
		labels: [],
		dependencies: [],
	}));
	const corpus = { tasks, completedTasks: [], statuses: ["To Do", "In Progress", "Done"] };
	const loaded: LocalTickets = { kind: "loaded", matched: [], corpus, priorities: [] };
	return Promise.resolve(loaded);
}

/** One server repository, the project repository, a reader client and a private context parent. */
// adapted from claim-surface-git.test.ts:189
class SurfaceCase {
	readonly root: string;
	readonly url: string;
	/** ClaimSurfaceEnv.projectRoot: the client repository of every surface call. */
	readonly project: string;
	/** The initializer's client repository; the test's own store reads run there, never in the project. */
	readonly reader: string;
	/** Private 0700 parent of all contexts of this case, with the sentinel in its name. */
	readonly parent: string;
	private readonly serverRepo: string;

	private constructor(root: string, url: string, serverRepo: string, project: string, reader: string) {
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.project = project;
		this.reader = reader;
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	// adapted from claim-surface-git.test.ts:210
	static async create(caseName: string): Promise<SurfaceCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-surface-administration-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `surface-administration-${caseName}`);
			const project = await initClient(join(root, "project"));
			const reader = await initClient(join(root, "client-initializer"));
			const surfaceCase = new SurfaceCase(root, server().url(name), repo, project, reader);
			await mkdir(surfaceCase.parent);
			await chmod(surfaceCase.parent, 0o700);
			const initialized = await initializeClaimStorage(surfaceCase.storage());
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			return surfaceCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** Storage options of the test's own reads: the reader client, this case's endpoint, blob. */
	storage(): ClaimStorageOptions {
		return { repository: this.reader, remote: this.url, format: "blob", timeoutMs: ADAPTER_TIMEOUT };
	}

	// adapted from claim-surface-git.test.ts:234
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** Configuration keys plus the three surface keys, all explicit; no start value is relied on. */
	// adapted from claim-surface-git.test.ts:241
	claimsYaml(): string {
		return [
			"claims:",
			"  enabled: true",
			`  endpoint: ${JSON.stringify(this.url)}`,
			"  storage_format: blob",
			"  lifetime_mode: lease",
			`  lease_ttl_ms: ${TTL}`,
			`  reclaim_grace_ms: ${GRACE}`,
			`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
			"  attempts: 3",
			`  operation_budget_ms: ${BUDGET_MS}`,
			`  clock_uncertainty_ms: ${EPS}`,
			"  retry_pause_base_ms: 1",
			"  retry_pause_max_ms: 1",
		].join("\n");
	}

	/** The fixed wall clock T, a monotonic clock that never moves, no sleep and exactly the scripted operation IDs. */
	// adapted from claim-surface-git.test.ts:156 (ScriptedSeams) and :260 (env), without the recorded draws and pauses
	env(ids: readonly string[]): ClaimSurfaceEnv {
		const issued = { count: 0 };
		return {
			projectRoot: this.project,
			claimsYaml: this.claimsYaml(),
			taskPrefix: "BACK",
			findLocalTicket,
			loadLocalTickets,
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

	/** The parsed options of one mutating command on TICKET; only acquire names an owner. */
	// adapted from claim-surface-git.test.ts:275
	input(command: ClaimMutationInput["command"], handle: ContextHandle): ClaimMutationInput {
		if (command === "acquire") return { command, ticket: TICKET, owner: OWNER, context: handle.directory };
		return { command, ticket: TICKET, context: handle.directory };
	}

	/** O1. */
	// adapted from claim-surface-git.test.ts:280
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** The stored claim of TICKET with the descriptor; anything but a present claim is a fixture failure. */
	async observe(): Promise<{ descriptor: ClaimStorageDescriptor; snapshot: Present }> {
		const opened = await openClaimStore(this.storage());
		if (opened.kind !== "open") throw new Error(`fixture: claim store cannot be opened (${opened.kind})`);
		const snapshot = await opened.store.read(TICKET);
		if (snapshot.kind !== "present") throw new Error(`fixture: expected a stored claim, got ${snapshot.kind}`);
		return { descriptor: opened.descriptor, snapshot };
	}

	/** Publishes `intent` through the journal API, as an earlier call of this context would have; returns the kind. */
	// adapted from claim-execution-retry.test.ts:1126 (plant)
	async prepare(handle: ContextHandle, intent: ClaimOperationIntent): Promise<string> {
		const opened = await openClaimIntentJournal({ directory: handle.context.journalDirectory });
		if (opened.kind !== "open") return `journal ${opened.kind}`;
		return (await opened.journal.prepare(intent)).kind;
	}

	// adapted from claim-surface-git.test.ts:303
	async journalView(handle: ContextHandle): Promise<JournalView> {
		const names = (await readdir(handle.context.journalDirectory)).sort();
		const record = (name: string) => !name.startsWith(".") && name.endsWith(".json");
		const slot = (name: string) => name.startsWith(".admission-");
		return {
			records: names.filter(record),
			slots: names.filter(slot).length,
			other: names.filter((name) => !record(name) && !slot(name)),
		};
	}

	/** Values no public document may contain: paths, endpoint, owners, bindings, secrets, roots, digests. */
	// adapted from claim-surface-git.test.ts:315
	private async sentinels(handles: readonly ContextHandle[]): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["endpoint", this.url],
			["owner", OWNER],
			["recipient", RECIPIENT],
		];
		for (const [ref, oid] of Object.entries(await this.serverRefs())) found.push([`root of ${ref}`, oid]);
		for (const handle of handles) {
			const { binding, journalDirectory } = handle.context;
			const secret = field(JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8")), "secret");
			found.push(["binding", binding], ["context", handle.directory], ["journal", journalDirectory]);
			found.push(["secret", String(secret)]);
			for (const name of (await this.journalView(handle)).records) {
				const record: unknown = JSON.parse(await readFile(join(journalDirectory, name), "utf8"));
				found.push(["digest", String(field(record, "digest"))]);
				found.push(["parameter digest", String(field(record, "parameterDigest"))]);
			}
		}
		return found;
	}

	// adapted from claim-surface-git.test.ts:357
	async documentView(label: string, document: ClaimDocument, handles: readonly ContextHandle[]): Promise<DocumentView> {
		const body: Body = Object.fromEntries(Object.entries(document));
		if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
		const echoed = echoedIn(JSON.stringify(document), await this.sentinels(handles));
		return { label, exit: claimExitCode(document), body, echoed };
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-surface-git.test.ts:385
async function withCase(caseName: string, body: (fixture: SurfaceCase) => Promise<void>): Promise<void> {
	const fixture = await SurfaceCase.create(caseName);
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	await fixture.dispose();
	if (failure !== undefined) throw failure;
}

/** PlannedDisplay of an ACTIVE lease successor without hard end: never capped. */
function leasePlanned(claimGeneration: number): Body {
	return {
		status: "active",
		claimGeneration,
		timing: { mode: "lease", leaseEnd: L, hardEnd: null, graceMs: GRACE },
		capped: false,
	};
}

/** RightsView at generation `claimGeneration` of a lease ending at L, as seen by the holder or another. */
function rightsView(ownership: "held" | "foreign", claimGeneration: number): Body {
	const workRight = ownership === "held" ? { kind: "live", renewalDue: false } : { kind: "none", cause: "not-holder" };
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership,
		claimGeneration,
		workRight,
		reclaim: { kind: "not-yet", boundary: R },
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Level P helpers: adapted from claim-surface.test.ts:195-273 and :401-424 with the action as a parameter; the
// human renderer view is left out (src/formatters/claim-text.ts is not part of this suite's reference copy).
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-surface.test.ts:195
function echoes(text: string): number {
	return SENSITIVE.filter((value) => text.includes(value)).length;
}

// adapted from claim-surface.test.ts:199
function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

// adapted from claim-surface.test.ts:203
function evaluated(
	ownership: Evaluated["ownership"],
	workRight: Evaluated["workRight"],
	reclaim: Evaluated["reclaim"],
	claimGeneration: number | null = 3,
): ClaimRightEvaluation {
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		observedRoot: ROOT,
		claimGeneration,
		ownership,
		workRight,
		reclaim,
	};
}

/** RightsView: the rights evaluation without observedRoot and reason. */
// adapted from claim-surface.test.ts:221
function publicRights(rights: ClaimRightEvaluation): Body {
	if (rights.kind !== "evaluated") return { kind: rights.kind };
	return {
		kind: "evaluated",
		scope: "observed-state-only",
		ownership: rights.ownership,
		claimGeneration: rights.claimGeneration,
		workRight: rights.workRight,
		reclaim: rights.reclaim,
	};
}

/** ASSUMPTION(scaffold): ClaimTransitionAction carries transfer, resume and change-bounds. */
// adapted from claim-surface.test.ts:233, with the recorded action as a parameter
function operation(
	action: ClaimTransitionAction,
	storage: Operation["storage"],
	outcome: Operation["outcome"]["kind"],
	sends: number,
	rights: ClaimRightEvaluation,
): ClaimExecutionResult {
	const result: Operation = {
		kind: "operation",
		scope: "transition-execution-only",
		action,
		operationId: OP,
		storage: tainted(storage),
		outcome: { kind: outcome },
		rights: tainted(rights),
		sends,
	};
	return tainted(result);
}

// adapted from claim-surface.test.ts:256
function resolvedQuery(resolution: ClaimMutationResolution): ClaimMutationQueryResult {
	return { kind: "resolved", resolution: tainted(resolution) };
}

// adapted from claim-surface.test.ts:260
function notPlanned(plan: NotPlanned["plan"], rights: ClaimRightEvaluation): ClaimExecutionResult {
	const result: NotPlanned = { kind: "not-planned", plan: tainted(plan), rights: tainted(rights) };
	return tainted(result);
}

/** A `claim retry` maps the resent operation with the record's action, never the command's. */
function mapRetry(result: ClaimExecutionResult): ClaimDocument {
	return claimOperationDocument({
		command: "retry",
		ticket: TICKET,
		result,
		planned: null,
		stoppedBy: null,
		operationId: OP,
	});
}

/** A plan rejection carried by renew: until administration no mutating command plans a transition action. */
function mapRenew(result: ClaimExecutionResult): ClaimDocument {
	return claimOperationDocument({ command: "renew", ticket: TICKET, result, planned: null, stoppedBy: null });
}

/** The applied retry document with the fixations; the action is the record's. */
function retryBody(action: string, storage: Body, sends: number, rights: ClaimRightEvaluation): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "applied",
		command: "retry",
		action,
		ticket: TICKET,
		operationId: OP,
		outcome: "applied",
		rejection: null,
		storage,
		sends,
		stoppedBy: null,
		planned: null,
		rights: publicRights(rights),
	};
}

/**
 * Plan rejections persist nothing, so the document carries no operation ID; `rejection` is exactly `stage`
 * and `cause` here, since none of these causes has a boundary.
 */
// adapted from claim-surface.test.ts:312
function planRejectionBody(cause: string, rights: ClaimRightEvaluation): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: "rejected",
		command: "renew",
		action: "renew",
		ticket: TICKET,
		operationId: null,
		outcome: "rejected",
		rejection: { stage: "plan", cause },
		storage: null,
		sends: 0,
		stoppedBy: null,
		planned: null,
		rights: publicRights(rights),
	};
}

function keysOf(value: unknown): string[] | null {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : null;
}

// adapted from claim-surface.test.ts:401
function viewOf(label: string, doc: ClaimDocument): MappedView {
	const body: Body = Object.fromEntries(Object.entries(doc));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return {
		label,
		exit: claimExitCode(doc),
		keys: Object.keys(doc).sort(byCodeUnits),
		rejectionKeys: keysOf(field(doc, "rejection")),
		body,
		echoed: echoes(JSON.stringify(doc)),
	};
}

// adapted from claim-surface.test.ts:414
function expectedView(label: string, body: Body): MappedView {
	return {
		label,
		exit: EXPECTED_EXIT[String(body.status)] ?? -1,
		keys: Object.keys(body).sort(byCodeUnits),
		rejectionKeys: keysOf(body.rejection),
		body,
		echoed: 0,
	};
}

const HELD = evaluated("held", { kind: "live", renewalDue: false }, { kind: "not-yet", boundary: R });
const FOREIGN = evaluated("foreign", { kind: "none", cause: "not-holder" }, { kind: "not-yet", boundary: R });
/** The source's view after its transfer applied: foreign at the successor's generation. */
const SOURCE_AFTER_TRANSFER = evaluated(
	"foreign",
	{ kind: "none", cause: "not-holder" },
	{ kind: "not-yet", boundary: R },
	4,
);
const NEW_CAUSES: readonly NewCause[] = ["time-box-required", "requires-time-path", "lease-required", "mode-change"];

describe("a recorded transition operation through the surface core over real Git (blob)", () => {
	beforeAll(async () => {
		fixtureServer = await GitFixtureServer.create();
	});

	afterAll(async () => {
		await fixtureServer?.close();
	});

	test(
		"sad-01: resolve and retry of a recorded transfer give claim-resolution and claim-operation, never record-corrupt",
		async () => {
			await withCase("sad-01", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const handles = [karl, franz];

				// Positive control (catches: missing wiring of preflight, executor and mappers; a resolve that fails for
				// every record): KARL acquires through the surface core, and resolve reports that record as stored.
				const acquired = await runClaimMutation(fixture.input("acquire", karl), fixture.env([ACQUIRE_ID]));
				const acquireRecord = { operationId: ACQUIRE_ID, context: karl.directory };
				const acquireResolution = await runClaimResolve(acquireRecord, fixture.env([]));
				const acquireLabel = "sad-01 positive control acquire";
				const acquireResolveLabel = "sad-01 positive control resolve of the acquire";
				expect({
					acquire: await fixture.documentView(acquireLabel, acquired, handles),
					resolve: await fixture.documentView(acquireResolveLabel, acquireResolution, handles),
				}).toEqual({
					acquire: {
						label: acquireLabel,
						exit: 0,
						body: {
							schemaVersion: 1,
							kind: "claim-operation",
							status: "applied",
							command: "acquire",
							action: "acquire",
							ticket: TICKET,
							operationId: ACQUIRE_ID,
							outcome: "applied",
							rejection: null,
							storage: { kind: "applied" },
							sends: 1,
							stoppedBy: null,
							planned: leasePlanned(1),
							rights: rightsView("held", 1),
						},
						echoed: [],
					},
					resolve: {
						label: acquireResolveLabel,
						exit: 0,
						body: {
							schemaVersion: 1,
							kind: "claim-resolution",
							status: "applied",
							command: "resolve",
							operationId: ACQUIRE_ID,
							ticket: TICKET,
							action: "acquire",
							outcome: "applied",
							query: { kind: "resolved", resolution: "stored" },
						},
						echoed: [],
					},
				});

				// Setup (catches: a transfer planned against another state or root than the acquire left): the stored
				// claim is KARL's lease at generation 1 in revision 1, at the root the server shows.
				const { descriptor, snapshot } = await fixture.observe();
				const acquiredState: ClaimStateV1 = {
					claimState: 1,
					status: "active",
					claimGeneration: 1,
					bindingGeneration: 1,
					owner: OWNER,
					binding: karl.context.binding,
					timing: { mode: "lease", leaseEnd: L, graceMs: GRACE, hardEnd: null },
				};
				expect({
					root: snapshot.root,
					revision: snapshot.document.revision,
					state: parseClaimState(snapshot.document.payload),
				}).toEqual({
					root: (await fixture.serverRefs())[CLAIM_REF] ?? ABSENT_REF,
					revision: 1,
					state: { kind: "state", state: acquiredState },
				});

				// Setup: the scaffold's planner answers `invalid` for transfer, so the plan is built by hand in exactly the
				// shape the planner prescribes for a pure lease without H, `timeBox null` and the default lease at C = T:
				// ACTIVE to ACTIVE, claimGeneration + 1, bindingGeneration 1, FRANZ's context binding, the new owner and
				// the fresh window C + TTL (= L). ASSUMPTION(scaffold): the extended ClaimTransitionRequest union.
				const request: ClaimTransitionRequest = {
					action: "transfer",
					owner: RECIPIENT,
					timeBox: null,
					lease: { ttlMs: TTL, ttlSource: "default" },
				};
				const next: ClaimStateV1 = {
					claimState: 1,
					status: "active",
					claimGeneration: 2,
					bindingGeneration: 1,
					owner: RECIPIENT,
					binding: franz.context.binding,
					timing: { mode: "lease", leaseEnd: T + TTL, graceMs: GRACE, hardEnd: null },
				};
				const plan: Planned = {
					kind: "planned",
					scope: "state-plan-only",
					action: "transfer",
					expectedRoot: snapshot.root,
					observedClaimGeneration: 1,
					request,
					next,
				};
				const mapped = claimOperationIntentOf({
					operationId: TRANSFER_ID,
					remote: fixture.url,
					descriptor,
					ticket: TICKET,
					plan,
				});
				const prepared = mapped.kind === "intent" ? await fixture.prepare(karl, mapped.intent) : "not mapped";
				const targetBinding = field(field(mapped, "intent"), "targetBinding");
				// catches: a record the journal refuses, which would turn the RED below into a fixture failure.
				expect({ mapped: mapped.kind, targetBinding, prepared }).toEqual({
					mapped: "intent",
					targetBinding: franz.context.binding,
					prepared: "prepared",
				});

				// Characterization (pause/index.ts:86-94): the prepared transfer is KARL's own
				// intent at the observed root, so a further mutating call of KARL pauses before its plan and persists
				// nothing. Retrying this very record is the way out; resolve never pauses.
				const renew = await runClaimMutation(fixture.input("renew", karl), fixture.env([RENEW_ID]));
				const renewLabel = "sad-01 renew while the transfer is open (catches: a record the pause does not see)";
				expect({
					renew: await fixture.documentView(renewLabel, renew, handles),
					journal: await fixture.journalView(karl),
				}).toEqual({
					renew: {
						label: renewLabel,
						exit: 7,
						body: {
							schemaVersion: 1,
							kind: "claim-pause",
							status: "paused",
							command: "renew",
							action: "renew",
							ticket: TICKET,
							operationId: null,
							pause: { kind: "outstanding", operationIds: [TRANSFER_ID] },
							rights: rightsView("held", 1),
						},
						echoed: [],
					},
					journal: { records: [`${ACQUIRE_ID}.json`, `${TRANSFER_ID}.json`], slots: 1, other: [] },
				});

				// sad-01: resolve, then retry of the transfer record. An unsent intent at its unchanged
				// expected root resolves `open` (resolution/index.ts:129), which resolve reports as unknown/3; the retry
				// resends the frozen change once and applies it; the source's rights are foreign at generation 2.
				const transferRecord = { operationId: TRANSFER_ID, context: karl.directory };
				const refsBefore = await fixture.serverRefs();
				const resolved = await runClaimResolve(transferRecord, fixture.env([]));
				const refsAfterResolve = await fixture.serverRefs();
				const retried = await runClaimRetry(transferRecord, fixture.env([]));
				const refsAfterRetry = await fixture.serverRefs();
				const resolveLabel = "sad-01 resolve of the transfer (catches: the four-action list in runClaimResolve)";
				const retryLabel = "sad-01 retry of the transfer (catches: the four-action lists of retry and resend)";
				expect({
					resolve: await fixture.documentView(resolveLabel, resolved, handles),
					refsAfterResolve,
					retry: await fixture.documentView(retryLabel, retried, handles),
					claimMoved: refsAfterRetry[CLAIM_REF] !== refsBefore[CLAIM_REF],
				}).toEqual({
					resolve: {
						label: resolveLabel,
						exit: 3,
						body: {
							schemaVersion: 1,
							kind: "claim-resolution",
							status: "unknown",
							command: "resolve",
							operationId: TRANSFER_ID,
							ticket: TICKET,
							action: "transfer",
							outcome: "unknown",
							query: { kind: "resolved", resolution: "open" },
						},
						echoed: [],
					},
					// catches: a resolve that sends.
					refsAfterResolve: refsBefore,
					retry: {
						label: retryLabel,
						exit: 0,
						body: {
							schemaVersion: 1,
							kind: "claim-operation",
							status: "applied",
							command: "retry",
							action: "transfer",
							ticket: TICKET,
							operationId: TRANSFER_ID,
							outcome: "applied",
							rejection: null,
							storage: { kind: "applied" },
							sends: 1,
							stoppedBy: null,
							planned: leasePlanned(2),
							rights: rightsView("foreign", 2),
						},
						echoed: [],
					},
					claimMoved: true,
				});

				// catches: an applied document whose write did not hand the claim to the target context; a transfer through
				// a free state (revision base + 1, both receipts); a target journal that was opened.
				const after = await fixture.observe();
				const recipient = await queryClaimRight({
					storage: fixture.storage(),
					ticket: TICKET,
					contextDirectory: franz.directory,
					clockSkewMs: EPS,
					clock: () => T,
				});
				expect({
					root: after.snapshot.root,
					revision: after.snapshot.document.revision,
					receipts: Object.keys(after.snapshot.document.receipts).sort(byCodeUnits),
					state: parseClaimState(after.snapshot.document.payload),
					recipient,
					source: await fixture.journalView(karl),
					target: await fixture.journalView(franz),
				}).toEqual({
					root: refsAfterRetry[CLAIM_REF] ?? ABSENT_REF,
					revision: 2,
					receipts: [ACQUIRE_ID, TRANSFER_ID],
					state: { kind: "state", state: next },
					recipient: {
						kind: "evaluated",
						scope: "observed-state-only",
						observedRoot: refsAfterRetry[CLAIM_REF] ?? ABSENT_REF,
						claimGeneration: 2,
						ownership: "held",
						workRight: { kind: "live", renewalDue: false },
						reclaim: { kind: "not-yet", boundary: R },
					},
					source: { records: [`${ACQUIRE_ID}.json`, `${TRANSFER_ID}.json`], slots: 2, other: [] },
					target: { records: [], slots: 0, other: [] },
				});
			});
		},
		TEST_TIMEOUT,
	);
});

describe("claim documents of the transition actions and causes (pure)", () => {
	test("sad-02: a retried transfer, resume or change-bounds operation maps to claim-operation with its action", () => {
		// Scanner positive control: a planted target binding is counted.
		expect(echoes(`planted ${FRANZ}`)).toBe(1);
		// Positive control (catches: no retry mapping; the action taken from the command instead of the record).
		const renew = operation("renew", { kind: "applied", root: ROOT }, "applied", 1, HELD);
		const expectedRenew = retryBody("renew", { kind: "applied" }, 1, HELD);
		expect(viewOf("retried renew", mapRetry(renew))).toEqual(expectedView("retried renew", expectedRenew));

		const stored = resolvedQuery({ kind: "stored", observedRoot: ROOT });
		const storedView: Body = { kind: "resolved", resolution: "stored" };
		const clarified: Body = { kind: "queried", after: "earlier-process", query: storedView };
		const rows = [
			{
				label: "retried transfer applied (catches: the four-action list in the operation mapper, internal/1)",
				result: operation("transfer", { kind: "applied", root: ROOT }, "applied", 1, SOURCE_AFTER_TRANSFER),
				expected: retryBody("transfer", { kind: "applied" }, 1, SOURCE_AFTER_TRANSFER),
			},
			{
				label: "retried transfer the earlier process stored (catches: the list only on the sending path)",
				result: operation(
					"transfer",
					{ kind: "queried", after: "earlier-process", query: stored },
					"applied",
					0,
					SOURCE_AFTER_TRANSFER,
				),
				expected: retryBody("transfer", clarified, 0, SOURCE_AFTER_TRANSFER),
			},
			{
				label: "retried resume applied (catches: a list that gained transfer only)",
				result: operation("resume", { kind: "applied", root: ROOT }, "applied", 1, HELD),
				expected: retryBody("resume", { kind: "applied" }, 1, HELD),
			},
			{
				label: "retried change-bounds applied (catches: a list that gained transfer and resume only)",
				result: operation("change-bounds", { kind: "applied", root: ROOT }, "applied", 1, HELD),
				expected: retryBody("change-bounds", { kind: "applied" }, 1, HELD),
			},
		];
		expect(rows.map((row) => viewOf(row.label, mapRetry(row.result)))).toEqual(
			rows.map((row) => expectedView(row.label, row.expected)),
		);
	});

	test("sad-03: the four new plan causes map to a plan rejection with exit 2 and no boundary, never internal", () => {
		// Positive control (catches: no plan-rejection mapping; an existing cause turned into an error document).
		const notHolder = notPlanned({ kind: "rejected", cause: "not-holder", reason: REASON }, FOREIGN);
		const expectedNotHolder = planRejectionBody("not-holder", FOREIGN);
		expect(viewOf("not-holder", mapRenew(notHolder))).toEqual(expectedView("not-holder", expectedNotHolder));

		// ASSUMPTION(scaffold): ClaimTransitionRejection carries the four causes and BoundedRejection stays the three
		// time verdicts, so the unbounded plan variant types these rows.
		const rows = NEW_CAUSES.map((cause) => ({
			label: `${cause} (catches: PLAN_CAUSES without the transition causes, internal/1; an invented boundary)`,
			result: notPlanned({ kind: "rejected", cause, reason: REASON }, HELD),
			expected: planRejectionBody(cause, HELD),
		}));
		expect(rows.map((row) => viewOf(row.label, mapRenew(row.result)))).toEqual(
			rows.map((row) => expectedView(row.label, row.expected)),
		);
	});
});
