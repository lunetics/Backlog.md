/**
 * Behavioural contract for the single claim transition executor. One call runs acquire, renew, release or reclaim from
 * one fresh read through plan, intent mapping, durable journal intent and one conditional store write; after a lost
 * reply it asks the mutation query and resends the frozen change byte-identically only while the intent is open. An
 * `operation` result carries three separate facts: the storage verdict, the logical outcome and a fresh rights
 * evaluation. Git cases run for blob, tree and commit-chain against the real loopback daemon with two test-local seams,
 * scripted receive hooks (S1) and a trace2 record of the executor's own Git processes (S2); the shared fixture stays
 * unchanged. Every test starts with a positive control that a non-functional executor cannot satisfy. Nothing here is
 * execution admission, proof that no own operation is outstanding, fencing or a retry budget. Tables name the
 * deliberately wrong executor each row catches; expectations beyond the written contract are marked
 * ASSUMPTION(executor).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, claimContextIO, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimExecutionResult,
	claimOperationIntentOf,
	type ExecuteClaimTransitionOptions,
	executeClaimTransition,
} from "../claims/execution/index.ts";
import {
	type ClaimIntentRecord,
	type ClaimOperationIntent,
	claimJournalIO,
	openClaimIntentJournal,
} from "../claims/journal/index.ts";
import {
	type ClaimMutationReceipt,
	type ClaimMutationSource,
	createClaimMutationReceipt,
	resolveClaimMutation,
} from "../claims/resolution/index.ts";
import type {
	ActiveClaimState,
	ClaimRightEvaluation,
	ClaimStateV1,
	ClaimTiming,
	FreeClaimState,
} from "../claims/rights/index.ts";
import {
	type ClaimChange,
	type ClaimDocument,
	type ClaimReadResult,
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	type ClaimTimingRequest,
	type ClaimTransitionAction,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	type PlanClaimTransitionOptions,
	planClaimTransition,
} from "../claims/transition/index.ts";
import { GitFixtureServer, type ReceivePhase, StallProxy, unusedLoopbackPort } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 20_000;
const LONG_TEST_TIMEOUT = 40_000;
const ADAPTER_TIMEOUT = 3_000;
/** Per-Git-command timeout for executions that must contact the stalled endpoint. */
const STALL_TIMEOUT = 750;
/** Per-Git-command timeout in lost-reply cases; every scripted hold outlasts it. */
const LOSS_TIMEOUT = 2_000;
/** Margin for any stray asynchronous accept before a zero count is read; the zero itself is the proof. */
const SETTLE_MS = 200;
/** Bound for waiting on hook entries, landings and hook drains. */
const EVENT_TIMEOUT = 10_000;
/** A scripted hold ends by itself after HOLD_POLLS polls of 50 ms, so no hook outlives a failed case for long. */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
const THIRD_TICKET = "BACK-3";
const TICKET_REF = `refs/claims/${TICKET}`;
const DESCRIPTOR_REF = "refs/claim-meta/format";
/** Sends allowed per call unless a case says otherwise; a healthy call must still send exactly once. */
const ATTEMPTS = 3;
/** Placeholder for a ticket ref the server does not have. */
const ABSENT_REF = "(no ref)";
/** Placeholder for the `after` of ret-08, which is fixed only after the RED observation. */
const OBSERVED_AFTER = "remote-or-unknown";
/** Distinctive owner names that no result or diagnostic may echo. */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";

const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), far from the wall clock; every other instant is derived from it. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** Stored lease end "10:05", its reclaim boundary "10:15" and a hard work limit "11:00". */
const L = T + 5 * MINUTE;
const R = L + GRACE;
const H = T + 60 * MINUTE;

/** Distinctive bindings, endpoint, root and operation ID of the pure mapping cases. */
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const REMOTE = "git://127.0.0.1:9/sentinel-claims.git";
const ROOT = "a1".repeat(20);
const OP = "op-sentinel-map";
/** Tree and epoch 2, so a mapper that takes format or epoch from anywhere but the descriptor is visible. */
const MAP_DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "tree", epoch: 2 };
const BLOB_DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
const MAP_SENTINELS = [KARL, FRANZ, OWNER, OTHER_OWNER, REMOTE, ROOT, OP];

const OPERATION_KEYS = ["action", "kind", "operationId", "outcome", "rights", "scope", "sends", "storage"];
const NOT_PLANNED_KEYS = ["kind", "plan", "rights"];
const FAILURE_KEYS = ["kind", "reason"];
const EVALUATED_KEYS = ["claimGeneration", "kind", "observedRoot", "ownership", "reclaim", "scope", "workRight"];

type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type WorkRight = Evaluated["workRight"];
type Reclaim = Evaluated["reclaim"];
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type MappedIntent = ReturnType<typeof claimOperationIntentOf>;
type FailureKind = Exclude<ClaimExecutionResult["kind"], "operation" | "not-planned">;
type Outcome = "applied" | "rejected" | "unknown" | "unknown-history" | "not-sent";
type DescriptorSetup = "same" | "other" | "none";
type ContextHandle = { context: ClaimContext; directory: string };
type SequenceClock = { clock: () => number; calls: () => number };
type HookAction = "pass" | "reject" | "hold" | "hold-reject";
type Invocation = { n: number; lines: string[]; ppid: string };
type Run = { result: ClaimExecutionResult; gitCalls: number; pushes: string[][] };
type Sentinels = { anywhere: string[]; inReasons: string[] };
type StoredView = { revision: number; payload: string; receipt: string | null };
type IntentSpec = {
	operationId: string;
	ticket?: string;
	expectedRoot: string | null;
	request: ClaimTransitionRequest;
	next: ClaimStateV1;
};
type StorageView = {
	kind: string | null;
	keys: string[];
	root: string | null;
	cause: string | null;
	after: string | null;
	query: string | null;
	resolution: string | null;
	observedRoot: string | null;
};
type RightsView = {
	kind: string | null;
	keys: string[];
	ownership: string | null;
	workRight: unknown;
	reclaim: unknown;
	observedRoot: string | null;
	claimGeneration: number | null;
};
type PlanView = { kind: string | null; cause: string | null; boundary: number | null };
/** Kinds, keys, facts and counts only; reasons appear as type, emptiness and a count of echoed sentinels. */
type ExecutionView = {
	label: string;
	kind: string | null;
	keys: string[];
	scope: string | null;
	action: string | null;
	operationId: string | null;
	storage: StorageView | null;
	outcome: string | null;
	outcomeKeys: string[];
	rights: RightsView | null;
	plan: PlanView | null;
	sends: number | null;
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
};
type OperationExpectation = {
	action: ClaimTransitionAction;
	operationId: string;
	storage: StorageView;
	outcome: Outcome;
	rights: RightsView;
	sends: number;
};
type PayloadCase = { label: string; catches: string; payload: JsonObject; kind: "corrupt" | "unsupported" };
type UnpublishedCase = {
	label: string;
	catches: string;
	operationId: string;
	journalIO: typeof claimJournalIO;
	cause: string;
	published: boolean;
};
type EarlySetup = { changes: Partial<ExecuteClaimTransitionOptions>; extra: string[] };
type EarlyCase = {
	label: string;
	catches: string;
	descriptor: DescriptorSetup;
	kind: FailureKind;
	setup: (fixture: ExecutionCase) => Promise<EarlySetup>;
};
type NotPlannedCase = {
	label: string;
	catches: string;
	operationId: string;
	request: ClaimTransitionRequest;
	plan: PlanView;
	rights: RightsView;
	now?: number;
	changes?: Partial<ExecuteClaimTransitionOptions>;
};
type OpenCase = {
	label: string;
	catches: string;
	ticket: string;
	attempts: number;
	actions: HookAction[];
	rest: HookAction;
	after: "unknown" | "remote";
	sends: number;
};

const NO_SENTINELS: Sentinels = { anywhere: [], inReasons: [] };
const NOT_RUN: ClaimExecutionResult = { kind: "unavailable", reason: "the nested execution never ran" };

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

// adapted from claim-rights-query.test.ts:71
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
// adapted from claim-mutation-resolution.test.ts:74
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

// adapted from claim-rights-query.test.ts:76
function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** A fresh plain JSON copy of fixture data. */
function json(value: unknown): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** A shallow copy of `value` without `key`, built without `delete`. */
// adapted from claim-transition.test.ts:116
function without(value: object, key: string): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** A copy whose `key` is an enumerable getter instead of a data property. */
// adapted from claim-transition.test.ts:121
function withAccessor<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

// adapted from claim-rights-query.test.ts:84
function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

// adapted from claim-rights-query.test.ts:80
function otherFormat(format: ClaimStorageFormat): ClaimStorageFormat {
	return format === "blob" ? "tree" : "blob";
}

// adapted from claim-git-fixture.ts:20 (not exported)
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

// adapted from claim-rights-query.test.ts:188
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

// adapted from claim-rights-query.test.ts:181
function kindOf(info: Stats): string {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "dir";
	if (info.isFile()) return "file";
	return "other";
}

/** Type, mode, inode, size, mtime and content digest of `root` and everything below it. */
// adapted from claim-rights-query.test.ts:198
async function snapshot(root: string) {
	const entries: { path: string; kind: string; mode: number; ino: number; size: number; mtimeMs: number }[] = [];
	const digests: Record<string, string> = {};
	const visit = async (relative: string): Promise<void> => {
		const path = join(root, relative);
		const info = await lstat(path);
		const kind = kindOf(info);
		const mode = info.mode & 0o7777;
		entries.push({ path: relative, kind, mode, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
		if (kind === "file") digests[relative] = sha256Hex(await readFile(path));
		if (kind === "dir") {
			for (const name of (await readdir(path)).sort(byCodeUnits)) await visit(join(relative, name));
		}
	};
	await visit(".");
	return { entries, digests };
}

function lease(leaseEnd: number, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

function hard(hardEnd = H): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

function active(
	binding: string,
	timing: ClaimTiming = lease(L),
	changes: Partial<ActiveClaimState> = {},
): ActiveClaimState {
	return {
		claimState: 1,
		status: "active",
		claimGeneration: 3,
		bindingGeneration: 1,
		owner: OWNER,
		binding,
		timing,
		...changes,
	};
}

function tombstone(claimGeneration: number): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

function leaseRequest(): ClaimTimingRequest {
	return { mode: "lease", ttlMs: TTL, ttlSource: "default", graceMs: GRACE, hardEnd: null };
}

function acquire(owner = OWNER): ClaimTransitionRequest {
	return { action: "acquire", owner, timing: leaseRequest() };
}

function renew(): ClaimTransitionRequest {
	return { action: "renew", ttlMs: TTL, ttlSource: "default" };
}

function release(): ClaimTransitionRequest {
	return { action: "release" };
}

function reclaim(): ClaimTransitionRequest {
	return { action: "reclaim" };
}

/** The reference intent, built from constants, never from the plan under test. */
function referenceIntent(remote: string, descriptor: ClaimStorageDescriptor, spec: IntentSpec): ClaimOperationIntent {
	return {
		operationId: spec.operationId,
		remote,
		format: descriptor.format,
		epoch: descriptor.epoch,
		ticket: spec.ticket ?? TICKET,
		expectedRoot: spec.expectedRoot,
		// ASSUMPTION(executor): the binding of an ACTIVE successor, null for a FREE one (release, reclaim).
		targetBinding: spec.next.status === "active" ? spec.next.binding : null,
		action: spec.request.action,
		parameters: json(spec.request),
		resolved: { next: json(spec.next) },
	};
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
// adapted from claim-mutation-resolution.test.ts:108
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference receipt: exactly the schema and both digests of the record. */
// adapted from claim-mutation-resolution.test.ts:118
function receiptOf(record: ClaimIntentRecord): ClaimMutationReceipt {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

/** O2: the digest of the exact on-disk bytes of one final record, so no private bytes are printed. */
function recordFile(intent: ClaimOperationIntent): Record<string, string> {
	return { [`${intent.operationId}.json`]: sha256Hex(`${canonicalJson(recordOf(intent))}\n`) };
}

/** O3: the stored payload is the frozen next state and the receipt belongs to the reference record. */
function storedView(next: ClaimStateV1, intent: ClaimOperationIntent, revision: number): StoredView {
	const receipt = receiptOf(recordOf(intent));
	return { revision, payload: sha256Hex(canonicalJson(next)), receipt: sha256Hex(canonicalJson(receipt)) };
}

/** A receive-hook stdin line `<old> <new> <ref>`; an all-zero old ID (creation) is shown as null. */
function receiveOf(line: string): { from: string | null; to: string; ref: string } {
	const [from = "", to = "", ref = ""] = line.split(" ");
	return { from: /^0+$/.test(from) ? null : from, to, ref };
}

/** Number of distinct push argument lists; a byte-identical retry repeats exactly one. */
function distinct(pushes: string[][]): number {
	return new Set(pushes.map((args) => JSON.stringify(args))).size;
}

/**
 * A clock that serves `reads` in order and counts its calls; a call beyond them throws. ASSUMPTION(executor): 0 calls
 * after a failed open or read, 1 without a send, 2 with at least one send.
 */
// adapted from claim-rights-query.test.ts:147 (countingClock)
function sequenceClock(...reads: (number | (() => number))[]): SequenceClock {
	const state = { count: 0 };
	return {
		clock: () => {
			state.count += 1;
			const read = reads[state.count - 1];
			if (read === undefined) throw new Error("clock called more often than the contract allows");
			return typeof read === "number" ? read : read();
		},
		calls: () => state.count,
	};
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

function reasonsOf(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, entry]) =>
		key === "reason" && typeof entry === "string" ? [entry] : reasonsOf(entry),
	);
}

function storageViewOf(value: unknown): StorageView {
	const query = field(value, "query");
	const resolution = field(query, "resolution");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		root: textOf(field(value, "root")),
		cause: textOf(field(value, "cause")),
		after: textOf(field(value, "after")),
		query: textOf(field(query, "kind")),
		resolution: textOf(field(resolution, "kind")),
		observedRoot: textOf(field(resolution, "observedRoot")),
	};
}

function rightsViewOf(value: unknown): RightsView {
	const generation = field(value, "claimGeneration");
	return {
		kind: textOf(field(value, "kind")),
		keys: keysOf(value),
		ownership: textOf(field(value, "ownership")),
		workRight: field(value, "workRight") ?? null,
		reclaim: field(value, "reclaim") ?? null,
		observedRoot: textOf(field(value, "observedRoot")),
		claimGeneration: typeof generation === "number" ? generation : null,
	};
}

function planViewOf(value: unknown): PlanView {
	const boundary = field(value, "boundary");
	return {
		kind: textOf(field(value, "kind")),
		cause: textOf(field(value, "cause")),
		boundary: typeof boundary === "number" ? boundary : null,
	};
}

/**
 * The verdict view of one result. `anywhere` values (secrets, bindings, paths, endpoint, owners) may appear nowhere
 * in the result; `inReasons` values (operation IDs, roots) may appear in no reason text at any depth.
 */
// adapted from claim-transition.test.ts:244 (verdictOf) and claim-rights-query.test.ts:162 (expectFailure)
function viewOf(label: string, result: unknown, sentinels: Sentinels): ExecutionView {
	const reason = field(result, "reason");
	const serialized = String(JSON.stringify(result));
	const reasons = reasonsOf(result).join("\n");
	const echoed =
		sentinels.anywhere.filter((value) => value !== "" && serialized.includes(value)).length +
		sentinels.inReasons.filter((value) => value !== "" && reasons.includes(value)).length;
	const storage = field(result, "storage");
	const outcome = field(result, "outcome");
	const rights = field(result, "rights");
	const plan = field(result, "plan");
	const sends = field(result, "sends");
	return {
		label,
		kind: textOf(field(result, "kind")),
		keys: keysOf(result),
		scope: textOf(field(result, "scope")),
		action: textOf(field(result, "action")),
		operationId: textOf(field(result, "operationId")),
		storage: storage === undefined ? null : storageViewOf(storage),
		outcome: textOf(field(outcome, "kind")),
		outcomeKeys: keysOf(outcome),
		rights: rights === undefined ? null : rightsViewOf(rights),
		plan: plan === undefined ? null : planViewOf(plan),
		sends: typeof sends === "number" ? sends : null,
		reasonType: typeof reason,
		reasonEmpty: typeof reason !== "string" || reason.length === 0,
		echoed,
	};
}

/** An `operation` result with exactly the documented keys and the scope marker (exe-12 in every call). */
function operationView(label: string, expected: OperationExpectation): ExecutionView {
	return {
		label,
		kind: "operation",
		keys: OPERATION_KEYS,
		scope: "transition-execution-only",
		action: expected.action,
		operationId: expected.operationId,
		storage: expected.storage,
		outcome: expected.outcome,
		outcomeKeys: ["kind"],
		rights: expected.rights,
		plan: null,
		sends: expected.sends,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

function notPlannedView(label: string, plan: PlanView, rights: RightsView): ExecutionView {
	return {
		label,
		kind: "not-planned",
		keys: NOT_PLANNED_KEYS,
		scope: null,
		action: null,
		operationId: null,
		storage: null,
		outcome: null,
		outcomeKeys: [],
		rights,
		plan,
		sends: null,
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
	};
}

function failureView(label: string, kind: FailureKind): ExecutionView {
	return {
		label,
		kind,
		keys: FAILURE_KEYS,
		scope: null,
		action: null,
		operationId: null,
		storage: null,
		outcome: null,
		outcomeKeys: [],
		rights: null,
		plan: null,
		sends: null,
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
}

/** `applied` carries the root only, never the written document. */
function appliedStorage(root: string): StorageView {
	return {
		kind: "applied",
		keys: ["kind", "root"],
		root,
		cause: null,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
	};
}

/** Stale and remote rejections carry exactly kind and cause: no root, document, owner or binding. */
function rejectedStorage(cause: "stale" | "remote"): StorageView {
	return {
		kind: "rejected",
		keys: ["cause", "kind"],
		root: null,
		cause,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
	};
}

function queriedStorage(
	after: string,
	query: string,
	resolution: string | null = null,
	observedRoot: string | null = null,
): StorageView {
	return {
		kind: "queried",
		keys: ["after", "kind", "query"],
		root: null,
		cause: null,
		after,
		query,
		resolution,
		observedRoot,
	};
}

function notSentStorage(cause: string): StorageView {
	return {
		kind: "not-sent",
		keys: ["cause", "kind"],
		root: null,
		cause,
		after: null,
		query: null,
		resolution: null,
		observedRoot: null,
	};
}

function live(renewalDue: boolean | null): WorkRight {
	return { kind: "live", renewalDue };
}

function noRight(cause: Extract<WorkRight, { kind: "none" }>["cause"]): WorkRight {
	return { kind: "none", cause };
}

function notYet(boundary: number): Reclaim {
	return { kind: "not-yet", boundary };
}

const NOT_APPLICABLE: Reclaim = { kind: "not-applicable" };

function evaluatedRights(
	ownership: Evaluated["ownership"],
	workRight: WorkRight,
	reclaimState: Reclaim,
	observedRoot: string | null,
	claimGeneration: number | null,
): RightsView {
	return {
		kind: "evaluated",
		keys: EVALUATED_KEYS,
		ownership,
		workRight,
		reclaim: reclaimState,
		observedRoot,
		claimGeneration,
	};
}

function heldRights(root: string, reclaimState: Reclaim, workRight: WorkRight = live(false), generation = 3) {
	return evaluatedRights("held", workRight, reclaimState, root, generation);
}

function foreignRights(root: string, reclaimState: Reclaim, generation = 3): RightsView {
	return evaluatedRights("foreign", noRight("not-holder"), reclaimState, root, generation);
}

function freeRights(root: string, generation = 3): RightsView {
	return evaluatedRights("free", noRight("free"), NOT_APPLICABLE, root, generation);
}

const ABSENT_RIGHTS: RightsView = evaluatedRights("absent", noRight("absent"), NOT_APPLICABLE, null, null);

function failedRights(kind: string): RightsView {
	return {
		kind,
		keys: FAILURE_KEYS,
		ownership: null,
		workRight: null,
		reclaim: null,
		observedRoot: null,
		claimGeneration: null,
	};
}

function rejectedPlan(cause: string, boundary: number | null = null): PlanView {
	return { kind: "rejected", cause, boundary };
}

function failedPlan(kind: string): PlanView {
	return { kind, cause: null, boundary: null };
}

/** Context IO that fails the `lstat` of exactly `target` with EIO; everything else is real. */
// adapted from claim-rights-query.test.ts:217
function failingContextLstat(target: string): typeof claimContextIO {
	const lstatTarget = async (...args: Parameters<typeof claimContextIO.lstat>) => {
		if (String(args[0]) === target) {
			throw Object.assign(new Error("injected context lstat failure"), { code: "EIO" });
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatTarget as unknown as typeof claimContextIO.lstat };
}

/**
 * Context IO that runs `action` once, at the first `lstat` of `<directory>/context.json` for which `ready` holds.
 * The executor loads its context before planning and queryClaimRight loads it again before the final read
 * (rights/index.ts:337); ASSUMPTION(executor): the executor hands its contextIO to that query.
 */
function contextLstatWhen(
	directory: string,
	ready: () => Promise<boolean>,
	action: () => Promise<void>,
): typeof claimContextIO {
	const target = join(directory, "context.json");
	const state = { fired: false };
	const lstatWhen = async (...args: Parameters<typeof claimContextIO.lstat>) => {
		if (!state.fired && String(args[0]) === target && (await ready())) {
			state.fired = true;
			await action();
		}
		return claimContextIO.lstat(...args);
	};
	return { ...claimContextIO, lstat: lstatWhen as unknown as typeof claimContextIO.lstat };
}

/** Journal IO that fails the `lstat` of the journal directory itself with EIO; everything else is real. */
// adapted from claim-mutation-query.test.ts:185
function failingDirectoryLstat(directory: string): typeof claimJournalIO {
	const lstatDirectory = async (...args: Parameters<typeof claimJournalIO.lstat>) => {
		if (String(args[0]) === directory) {
			throw Object.assign(new Error("injected journal directory lstat failure"), { code: "EIO" });
		}
		return claimJournalIO.lstat(...args);
	};
	return { ...claimJournalIO, lstat: lstatDirectory as unknown as typeof claimJournalIO.lstat };
}

/** Journal IO whose only `link` (journal/index.ts:295) fails with EIO, so no intent is published. */
function failingLink(): typeof claimJournalIO {
	const linkFailure = async (...args: Parameters<typeof claimJournalIO.link>) => {
		throw Object.assign(new Error(`injected journal link failure (${args.length})`), { code: "EIO" });
	};
	return { ...claimJournalIO, link: linkFailure as unknown as typeof claimJournalIO.link };
}

/** Journal IO whose `link` publishes the record and then reports EEXIST, as a parallel identical publish would. */
function racedLink(): typeof claimJournalIO {
	const publishTwice = async (...args: Parameters<typeof claimJournalIO.link>) => {
		await claimJournalIO.link(...args);
		throw Object.assign(new Error("injected concurrent publish"), { code: "EEXIST" });
	};
	return { ...claimJournalIO, link: publishTwice as unknown as typeof claimJournalIO.link };
}

/** Journal IO that runs `action` once, right after the only `link` of `prepare`: between plan and first send. */
function afterLink(action: () => Promise<void>): typeof claimJournalIO {
	const state = { fired: false };
	const linkThenAct = async (...args: Parameters<typeof claimJournalIO.link>) => {
		await claimJournalIO.link(...args);
		if (state.fired) return;
		state.fired = true;
		await action();
	};
	return { ...claimJournalIO, link: linkThenAct as unknown as typeof claimJournalIO.link };
}

/**
 * Journal IO for the first `lstat` of `<operationId>.json` after `link` published it and once `ready` holds: the
 * record load of the query after a lost reply. ASSUMPTION(executor): the executor asks queryClaimMutation with its own
 * journal IO. `effect` either runs once, or fails that and every later such `lstat` with EIO.
 */
// adapted from claim-mutation-query.test.ts:174 (failingRecordLstat)
function recordLstatWhen(
	operationId: string,
	ready: () => Promise<boolean>,
	effect: "fail" | (() => Promise<void>),
): typeof claimJournalIO {
	const state = { linked: false, fired: false };
	const publish = async (...args: Parameters<typeof claimJournalIO.link>) => {
		await claimJournalIO.link(...args);
		state.linked = true;
	};
	const lstatWhen = async (...args: Parameters<typeof claimJournalIO.lstat>) => {
		if (state.linked && String(args[0]).endsWith(`/${operationId}.json`) && (state.fired || (await ready()))) {
			const first = !state.fired;
			state.fired = true;
			if (effect === "fail") throw Object.assign(new Error("injected record lstat failure"), { code: "EIO" });
			if (first) await effect();
		}
		return claimJournalIO.lstat(...args);
	};
	return {
		...claimJournalIO,
		link: publish as unknown as typeof claimJournalIO.link,
		lstat: lstatWhen as unknown as typeof claimJournalIO.lstat,
	};
}

/** Tracks whether `promise` has settled, without consuming its result. */
function tracked<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Polls `condition` until it holds (true) or `pending` settled first (false); fails after EVENT_TIMEOUT. */
// adapted from claim-process-crash.test.ts:124 (waitUntil)
async function whilePending(
	label: string,
	pending: { settled: () => boolean },
	condition: () => Promise<boolean>,
): Promise<boolean> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	for (;;) {
		if (await condition()) return true;
		if (pending.settled()) return false;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * S2, test-local: every trace2 `start` argv of `git -C <repository> ...`, without that prefix.
 * Product Git inherits GIT_TRACE2_EVENT through gitEnvironment (storage/index.ts:176-191), including a client-only
 * `=` push the server never sees; the fixture's own Git keeps the environment it copied at start and stays untraced
 * (claim-git-fixture.ts:136-148). The event format is checked by the positive control of each test.
 */
async function gitCommandsOf(tracePath: string, repository: string): Promise<string[][]> {
	let text: string;
	try {
		text = await readFile(tracePath, "utf8");
	} catch {
		return [];
	}
	const commands: string[][] = [];
	for (const line of text.split("\n")) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// An empty or partially written last line.
			continue;
		}
		const argv = field(event, "argv");
		if (field(event, "event") !== "start" || !Array.isArray(argv)) continue;
		const args = argv.map(String);
		if (args[1] === "-C" && args[2] === repository) commands.push(args.slice(3));
	}
	return commands;
}

/** The S1 hook script: numbers each invocation atomically, logs it, then passes, rejects or holds. */
function receiveHook(control: string, phase: ReceivePhase): string {
	return [
		"#!/bin/sh",
		`dir=${shellQuote(control)}`,
		`phase=${phase}`,
		"n=1",
		'while ! mkdir "$dir/$phase-$n" 2>/dev/null; do n=$((n + 1)); done',
		'cat > "$dir/$phase-$n/stdin"',
		'echo "$PPID" > "$dir/$phase-$n/ppid"',
		"action=pass",
		'if [ -f "$dir/$phase-action-$n" ]; then action=$(cat "$dir/$phase-action-$n")',
		'elif [ -f "$dir/$phase-action-rest" ]; then action=$(cat "$dir/$phase-action-rest"); fi',
		': > "$dir/$phase-$n/entered"',
		'case "$action" in hold*)',
		`\ti=0; while [ ! -f "$dir/$phase-$n/release" ] && [ "$i" -lt ${HOLD_POLLS} ]; do`,
		"\t\tsleep 0.05; i=$((i + 1))",
		"\tdone ;;",
		"esac",
		': > "$dir/$phase-$n/done"',
		'case "$action" in *reject) echo fixture-scripted-reject >&2; exit 1 ;; esac',
		"exit 0",
		"",
	].join("\n");
}

/**
 * S1, test-local: replaces both receive hooks of one server repository, like `rejectPushes`
 * (claim-storage-adapters.test.ts:549), with a script that records each invocation's stdin lines and receive-pack
 * PID under `<control>/<phase>-<n>/` and then passes, rejects, or holds until released and passes or rejects. Unlike
 * the OID-keyed ReceiveGates it separates an original push from its byte-identical retry.
 */
class ReceiveScript {
	private readonly serverRepo: string;
	private readonly control: string;

	constructor(serverRepo: string, control: string) {
		this.serverRepo = serverRepo;
		this.control = control;
	}

	async install(): Promise<void> {
		await mkdir(this.control, { recursive: true });
		for (const phase of ["pre", "post"] as const) {
			const hook = join(this.serverRepo, "hooks", `${phase}-receive`);
			await writeFile(hook, receiveHook(this.control, phase));
			await chmod(hook, 0o755);
		}
	}

	/** Number of invocations of `phase` so far, entered or not. */
	async count(phase: ReceivePhase): Promise<number> {
		const pattern = new RegExp(`^${phase}-\\d+$`);
		return (await readdir(this.control)).filter((name) => pattern.test(name)).length;
	}

	/** Actions for the next invocations of `phase`, then `rest` for every later one. */
	async plan(phase: ReceivePhase, actions: HookAction[], rest: HookAction = "pass"): Promise<void> {
		const started = await this.count(phase);
		const numbered = new RegExp(`^${phase}-action-\\d+$`);
		for (const name of await readdir(this.control)) {
			if (numbered.test(name)) await rm(join(this.control, name), { force: true });
		}
		for (const [index, action] of actions.entries()) {
			await writeFile(join(this.control, `${phase}-action-${started + index + 1}`), action);
		}
		await writeFile(join(this.control, `${phase}-action-rest`), rest);
	}

	hasEntered(phase: ReceivePhase, n: number): Promise<boolean> {
		return exists(join(this.control, `${phase}-${n}`, "entered"));
	}

	/** Whether invocation `n` of `phase` has left its hold; `done` is written once and never removed. */
	hasFinished(phase: ReceivePhase, n: number): Promise<boolean> {
		return exists(join(this.control, `${phase}-${n}`, "done"));
	}

	async release(phase: ReceivePhase, n: number): Promise<void> {
		await writeFile(join(this.control, `${phase}-${n}`, "release"), "");
	}

	/** Entered invocations of `phase` numbered above `since`, in order. */
	async invocations(phase: ReceivePhase, since = 0): Promise<Invocation[]> {
		const pattern = new RegExp(`^${phase}-(\\d+)$`);
		const numbers = (await readdir(this.control))
			.map((name) => Number(pattern.exec(name)?.[1] ?? Number.NaN))
			.filter((n) => Number.isSafeInteger(n) && n > since)
			.sort((left, right) => left - right);
		const invocations: Invocation[] = [];
		for (const n of numbers) {
			const path = join(this.control, `${phase}-${n}`);
			if (!(await exists(join(path, "entered")))) continue;
			const lines = (await readFile(join(path, "stdin"), "utf8")).split("\n").filter(Boolean);
			invocations.push({ n, lines, ppid: (await readFile(join(path, "ppid"), "utf8")).trim() });
		}
		return invocations;
	}

	/** Releases every hold and waits, bounded, until each invocation has finished. */
	async releaseAll(): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.control)).filter((name) => /^(?:pre|post)-\d+$/.test(name));
		} catch {
			return;
		}
		await Promise.all(names.map((name) => writeFile(join(this.control, name, "release"), "").catch(() => undefined)));
		const deadline = Date.now() + EVENT_TIMEOUT;
		for (const name of names) {
			while (!(await exists(join(this.control, name, "done"))) && Date.now() < deadline) await Bun.sleep(10);
		}
	}
}

/** One server repository with S1 hooks, the executor's client, independent clients, contexts and the S2 trace. */
class ExecutionCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly url: string;
	readonly serverRepo: string;
	/** The executor's client repository; ticket objects appear here only through the executor's own reads. */
	readonly primary: string;
	/** Private 0700 parent of all contexts of this case. */
	readonly parent: string;
	readonly hooks: ReceiveScript;
	private readonly tracePath: string;
	private readonly cleanups: (() => Promise<void>)[] = [];
	/** Operation IDs handed to the executor; no diagnostic may echo them. */
	private readonly guarded = new Set<string>();
	private readonly secrets = new Map<string, string>();
	private previousTrace: string | undefined;
	private tracing = false;
	private writerStore: ClaimStore | undefined;
	private readerStore: ClaimStore | undefined;
	private writes = 0;

	private constructor(format: ClaimStorageFormat, root: string, url: string, serverRepo: string, primary: string) {
		this.format = format;
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.primary = primary;
		this.parent = join(root, "contexts");
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"));
		this.tracePath = resolve(root, "trace2-events.json");
	}

	/** `descriptor`: initialize with the case format, with the other format, or not at all. */
	static async create(
		format: ClaimStorageFormat,
		caseName: string,
		descriptor: DescriptorSetup,
	): Promise<ExecutionCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-execution-"));
		try {
			const { name, repo } = await server().initRepository(root, `execution-${format}-${caseName}`);
			const primary = await ExecutionCase.initClient(join(root, "client-executor"));
			const executionCase = new ExecutionCase(format, root, server().url(name), repo, primary);
			await executionCase.hooks.install();
			await mkdir(executionCase.parent);
			await chmod(executionCase.parent, 0o700);
			if (descriptor !== "none") {
				const initializer = await executionCase.client("initializer");
				const changes = descriptor === "other" ? { format: otherFormat(format) } : {};
				expectKind(await initializeClaimStorage(executionCase.storage(initializer, changes)), "created");
			}
			executionCase.startTrace();
			return executionCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-rights-query.test.ts:276
	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An independent client repository; objects it writes are not in the executor's repository. */
	async client(label: string): Promise<string> {
		return ExecutionCase.initClient(join(this.root, `client-${label}`));
	}

	storage(repository = this.primary, changes: Partial<ClaimStorageOptions> = {}): ClaimStorageOptions {
		return { repository, remote: this.url, format: this.format, timeoutMs: ADAPTER_TIMEOUT, ...changes };
	}

	private async store(repository: string): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.storage(repository)), "open").store;
	}

	/** Creates a context through the API below the private parent, optionally recovering from `recoverFrom`. */
	// adapted from claim-rights-query.test.ts:297
	async context(recoverFrom?: string): Promise<ContextHandle> {
		const created = await createClaimContext(
			recoverFrom === undefined ? { parent: this.parent } : { parent: this.parent, recoverFrom },
		);
		const context = expectKind(created, "created").context;
		return { context, directory: dirname(context.journalDirectory) };
	}

	/** Reads the private secret directly; only tests may do this, and only to prove it is never echoed. */
	// adapted from claim-rights-query.test.ts:306
	private async secretOf(handle: ContextHandle): Promise<string> {
		const cached = this.secrets.get(handle.directory);
		if (cached !== undefined) return cached;
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = (record as { secret?: unknown }).secret;
		if (typeof secret !== "string") throw new Error("the private record has no string secret");
		this.secrets.set(handle.directory, secret);
		return secret;
	}

	async view(label: string, result: ClaimExecutionResult, handles: ContextHandle[], extra: string[] = []) {
		const anywhere = [this.root, this.parent, this.url, OWNER, OTHER_OWNER, ...extra];
		for (const handle of handles) {
			anywhere.push(await this.secretOf(handle), handle.context.binding, handle.directory);
			if (handle.context.recovery) anywhere.push(handle.context.recovery.binding);
		}
		const inReasons = [...this.guarded, ...Object.values(await this.serverRefs())];
		return viewOf(label, result, { anywhere, inReasons });
	}

	async expectView(
		result: ClaimExecutionResult,
		expected: ExecutionView,
		handles: ContextHandle[],
		extra: string[] = [],
	): Promise<void> {
		expect(await this.view(expected.label, result, handles, extra)).toStrictEqual(expected);
	}

	/**
	 * Executor options. ASSUMPTION(executor): the caller assigns the operation ID. ASSUMPTION(executor): `attempts` is a
	 * mandatory input. The executor opens the store itself from explicit ClaimStorageOptions.
	 */
	options(
		handle: ContextHandle,
		operationId: string,
		request: ClaimTransitionRequest,
		clock: SequenceClock,
		changes: Partial<ExecuteClaimTransitionOptions> = {},
	): ExecuteClaimTransitionOptions {
		for (const id of [operationId, changes.operationId]) {
			if (typeof id === "string" && id.length >= 6) this.guarded.add(id);
		}
		return {
			storage: this.storage(),
			ticket: TICKET,
			contextDirectory: handle.directory,
			operationId,
			request,
			clockSkewMs: EPS,
			clock: clock.clock,
			attempts: ATTEMPTS,
			...changes,
		};
	}

	intent(spec: IntentSpec): ClaimOperationIntent {
		return referenceIntent(this.url, { schema: 1, format: this.format, epoch: 1 }, spec);
	}

	/** Writes one change through the independent writer client and returns the applied root. */
	// adapted from claim-rights-query.test.ts:319
	async writeChange(ticket: string, change: ClaimChange): Promise<string> {
		this.writerStore ??= await this.store(await this.client("writer"));
		const base = await this.writerStore.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`writer read failed: ${base.kind}`);
		return expectKind(await this.writerStore.write(base, change), "applied").root;
	}

	async writeState(payload: JsonObject, ticket = TICKET): Promise<string> {
		this.writes += 1;
		const operationId = `writer-op-${this.writes}`;
		const receipt = { schema: 1, intentDigest: sha256Hex(operationId), parameterDigest: sha256Hex("parameters") };
		return this.writeChange(ticket, { operationId, receipt, payload });
	}

	/** O3 through an independent reader client. */
	async stored(ticket: string, operationId: string): Promise<StoredView> {
		this.readerStore ??= await this.store(await this.client("reader"));
		const observed = await this.readerStore.read(ticket);
		if (observed.kind !== "present") return { revision: 0, payload: observed.kind, receipt: null };
		const receipt = observed.document.receipts[operationId];
		return {
			revision: observed.document.revision,
			payload: sha256Hex(canonicalJson(observed.document.payload)),
			receipt: receipt === undefined ? null : sha256Hex(canonicalJson(receipt)),
		};
	}

	/** O2: digests of the final records; temporary `.intent-*.tmp` names are ignored (journal/index.ts:276). */
	async records(handle: ContextHandle): Promise<Record<string, string>> {
		const records: Record<string, string> = {};
		for (const name of (await readdir(handle.context.journalDirectory)).sort(byCodeUnits)) {
			if (name.startsWith(".") || !name.endsWith(".json")) continue;
			records[name] = sha256Hex(await readFile(join(handle.context.journalDirectory, name)));
		}
		return records;
	}

	/** O1. */
	// adapted from claim-rights-query.test.ts:351 and claim-storage-adapters.test.ts:599
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	async ticketRoot(ticket = TICKET): Promise<string> {
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** Writes raw bytes as a blob directly in the server repository and points `ref` at it. */
	// adapted from claim-rights-query.test.ts:345
	async setServerBlob(ref: string, text: string): Promise<string> {
		const oid = (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async deleteServerRef(ref: string): Promise<void> {
		await server().git(this.serverRepo, ["update-ref", "-d", ref]);
	}

	// adapted from claim-rights-query.test.ts:361
	async hasObject(repository: string, oid: string): Promise<boolean> {
		return (await server().git(repository, ["cat-file", "-e", oid], undefined, false)).rc === 0;
	}

	/** Synchronous object check for use inside a clock callback. */
	// adapted from claim-rights-query.test.ts:366
	hasObjectNow(repository: string, oid: string): boolean {
		const result = Bun.spawnSync(["git", "-C", repository, "cat-file", "-e", oid], {
			env: server().env,
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	}

	async stallProxy(): Promise<StallProxy> {
		const proxy = await StallProxy.create();
		this.cleanups.push(() => proxy.close());
		return proxy;
	}

	async gitCommands(repository = this.primary): Promise<string[][]> {
		return gitCommandsOf(this.tracePath, repository);
	}

	async mark(repository = this.primary): Promise<number> {
		return (await this.gitCommands(repository)).length;
	}

	/** O4: the Git commands and pushes one execution ran in `repository`, from the S2 trace. */
	async finish(pending: Promise<ClaimExecutionResult>, mark: number, repository = this.primary): Promise<Run> {
		const result = await pending;
		const commands = (await this.gitCommands(repository)).slice(mark);
		return { result, gitCalls: commands.length, pushes: commands.filter((args) => args[0] === "push") };
	}

	async run(options: ExecuteClaimTransitionOptions, repository = this.primary): Promise<Run> {
		const mark = await this.mark(repository);
		return this.finish(executeClaimTransition(options), mark, repository);
	}

	private startTrace(): void {
		this.previousTrace = process.env[TRACE_VARIABLE];
		process.env[TRACE_VARIABLE] = this.tracePath;
		this.tracing = true;
	}

	private stopTrace(): void {
		if (!this.tracing) return;
		this.tracing = false;
		if (this.previousTrace === undefined) Reflect.deleteProperty(process.env, TRACE_VARIABLE);
		else process.env[TRACE_VARIABLE] = this.previousTrace;
	}

	async dispose(): Promise<void> {
		try {
			await this.hooks.releaseAll();
			for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: ExecutionCase) => Promise<void>,
	descriptor: DescriptorSetup = "same",
): Promise<void> {
	const fixture = await ExecutionCase.create(format, caseName, descriptor);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

const ABSENT: ClaimReadResult = { kind: "absent", ticket: TICKET };
const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: `upstream ${OWNER} ${KARL} ${ROOT}` };

function present(payload: unknown, descriptor = MAP_DESCRIPTOR, changes: Partial<ClaimDocument> = {}): ClaimReadResult {
	const document = {
		schema: 1,
		format: descriptor.format,
		epoch: descriptor.epoch,
		ticket: TICKET,
		revision: 2,
		payload,
		receipts: {},
		...changes,
	} as unknown as ClaimDocument;
	return { kind: "present", ticket: TICKET, root: ROOT, document };
}

function planOptions(
	observed: ClaimReadResult,
	request: ClaimTransitionRequest,
	changes: Partial<PlanClaimTransitionOptions> = {},
): PlanClaimTransitionOptions {
	return {
		ticket: TICKET,
		descriptor: { ...MAP_DESCRIPTOR },
		observed,
		binding: KARL,
		request,
		now: T,
		clockSkewMs: EPS,
		...changes,
	};
}

function plannedOf(label: string, plan: ClaimTransitionPlan): Planned {
	if (plan.kind !== "planned") throw new Error(`${label}: expected planned, got ${plan.kind}`);
	return plan;
}

function mapPlan(plan: Planned): MappedIntent {
	return claimOperationIntentOf({
		operationId: OP,
		remote: REMOTE,
		descriptor: { ...MAP_DESCRIPTOR },
		ticket: TICKET,
		plan,
	});
}

function expectMapped(label: string, actual: MappedIntent, intent: ClaimOperationIntent): void {
	const expected: MappedIntent = { kind: "intent", intent };
	expect({ label, result: actual }).toStrictEqual({ label, result: expected });
}

function expectMapFailure(label: string, result: MappedIntent): void {
	const reason = field(result, "reason");
	const text = typeof reason === "string" ? reason : "";
	expect({
		label,
		kind: result.kind,
		keys: keysOf(result),
		reasonType: typeof reason,
		reasonEmpty: text.length === 0,
		echoed: MAP_SENTINELS.filter((value) => text.includes(value)).length,
	}).toEqual({ label, kind: "invalid", keys: FAILURE_KEYS, reasonType: "string", reasonEmpty: false, echoed: 0 });
}

describe("claim operation intent mapping (pure, no Git)", () => {
	test("map-01: maps planned acquire and renew into exactly the reference intent, as a fresh unaliased copy", () => {
		const acquirePlan = plannedOf("acquire from absent", planClaimTransition(planOptions(ABSENT, acquire())));
		const acquireIntent = referenceIntent(REMOTE, MAP_DESCRIPTOR, {
			operationId: OP,
			expectedRoot: null,
			request: acquire(),
			next: active(KARL, lease(T + TTL), { claimGeneration: 1 }),
		});
		const mapped = mapPlan(acquirePlan);
		// catches: targetBinding from owner or request, a normalized remote, format or epoch not from the descriptor,
		// `resolved` recomputed or carrying clock fields.
		expectMapped("acquire from absent", mapped, acquireIntent);

		const renewPlan = plannedOf("renew own lease", planClaimTransition(planOptions(present(active(KARL)), renew())));
		const renewIntent = referenceIntent(REMOTE, MAP_DESCRIPTOR, {
			operationId: OP,
			expectedRoot: ROOT,
			request: renew(),
			next: active(KARL, lease(T + TTL)),
		});
		expectMapped("renew own lease", mapPlan(renewPlan), renewIntent);

		// Fresh copy: neither request nor next state is shared, and later plan mutation changes nothing.
		const intent = expectKind(mapped, "intent").intent;
		expect({
			parametersShared: Object.is(intent.parameters, acquirePlan.request),
			nextShared: Object.is(intent.resolved.next, acquirePlan.next),
		}).toEqual({ parametersShared: false, nextShared: false });
		acquirePlan.next.claimGeneration = 99;
		(acquirePlan.request as { owner: string }).owner = OTHER_OWNER;
		expectMapped("acquire after the plan was mutated", mapped, acquireIntent);
	});

	test("map-02: maps release and reclaim to a null target binding and never to a holder binding", () => {
		const releasePlan = plannedOf("release", planClaimTransition(planOptions(present(active(KARL)), release())));
		const foreignLease = present(active(FRANZ, lease(L), { owner: OTHER_OWNER }));
		const reclaimPlan = plannedOf(
			"reclaim",
			planClaimTransition(planOptions(foreignLease, reclaim(), { now: R + EPS })),
		);
		const cases = [
			{ label: "release", catches: "FREE successor mapped to the initiator", plan: releasePlan, request: release() },
			{
				label: "reclaim",
				catches: "FREE successor mapped to the displaced holder or to a sentinel string",
				plan: reclaimPlan,
				request: reclaim(),
			},
		];
		for (const { label, catches, plan, request } of cases) {
			// ASSUMPTION(executor): targetBinding is null for a FREE successor.
			const intent = referenceIntent(REMOTE, MAP_DESCRIPTOR, {
				operationId: OP,
				expectedRoot: ROOT,
				request,
				next: tombstone(3),
			});
			const mapped = mapPlan(plan);
			expectMapped(`${label} (catches: ${catches})`, mapped, intent);
			const serialized = JSON.stringify(mapped);
			const bindingsEchoed = [KARL, FRANZ].filter((binding) => serialized.includes(binding)).length;
			expect({ label, bindingsEchoed }).toEqual({ label, bindingsEchoed: 0 });
		}
	});

	test("map-03: the journal, receipt and resolver accept exactly null as a free target binding, never an empty string", async () => {
		const directory = await mkdtemp(join(FIXTURE_ROOT, "claim-execution-journal-"));
		try {
			await chmod(directory, 0o700);
			const journal = expectKind(await openClaimIntentJournal({ directory }), "open").journal;
			// ASSUMPTION(executor): validIntent additionally accepts null; digests stay SHA-256 over canonical JSON.
			const intent = referenceIntent(REMOTE, BLOB_DESCRIPTOR, {
				operationId: OP,
				expectedRoot: null,
				request: reclaim(),
				next: tombstone(1),
			});
			const record = recordOf(intent);
			expect(await journal.prepare(intent)).toEqual({ kind: "prepared", record });
			expect({ nullBinding: canonicalJson(intent).includes('"targetBinding":null') }).toEqual({ nullBinding: true });

			const variants: { label: string; catches: string; value: unknown }[] = [
				{
					label: "empty target binding",
					catches: "a schema made too lax",
					value: { ...intent, operationId: "op-empty", targetBinding: "" },
				},
				{
					label: "numeric target binding",
					catches: "any falsy value accepted as free",
					value: { ...intent, operationId: "op-numeric", targetBinding: 0 },
				},
				{
					label: "missing target binding",
					catches: "an optional field instead of an explicit null",
					value: without({ ...intent, operationId: "op-missing" }, "targetBinding"),
				},
			];
			for (const { label, catches, value } of variants) {
				const result = await journal.prepare(value as ClaimOperationIntent);
				expect({ label, catches, kind: result.kind }).toEqual({ label, catches, kind: "invalid" });
			}
			expect(await readdir(directory)).toEqual([`${OP}.json`]);

			expect(createClaimMutationReceipt(record)).toEqual({ kind: "receipt", receipt: receiptOf(record) });
			const source: ClaimMutationSource = { remote: REMOTE, descriptor: BLOB_DESCRIPTOR };
			expect(resolveClaimMutation({ record, source, observed: { kind: "absent", ticket: TICKET } })).toEqual({
				kind: "open",
				observedRoot: null,
			});
			const observed = present(tombstone(1), BLOB_DESCRIPTOR, { revision: 1, receipts: { [OP]: receiptOf(record) } });
			expect(resolveClaimMutation({ record, source, observed })).toEqual({ kind: "stored", observedRoot: ROOT });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("map-04: maps nothing but a planned plan; every other plan result is invalid", () => {
		const control = plannedOf("control", planClaimTransition(planOptions(ABSENT, acquire())));
		const controlIntent = referenceIntent(REMOTE, MAP_DESCRIPTOR, {
			operationId: OP,
			expectedRoot: null,
			request: acquire(),
			next: active(KARL, lease(T + TTL), { claimGeneration: 1 }),
		});
		expectMapped("positive control", mapPlan(control), controlIntent);

		const cases: { label: string; catches: string; plan: ClaimTransitionPlan; kind: ClaimTransitionPlan["kind"] }[] = [
			{
				label: "rejected not-free",
				catches: "an intent from a rejected plan",
				plan: planClaimTransition(planOptions(present(active(FRANZ)), acquire())),
				kind: "rejected",
			},
			{
				label: "unknown observation",
				catches: "an intent without a fresh observation",
				plan: planClaimTransition(planOptions(UNREACHABLE, renew())),
				kind: "unknown",
			},
			{
				label: "corrupt payload",
				catches: "an intent over an unclassified legacy claim",
				plan: planClaimTransition(planOptions(present({ state: "claimed", holder: OWNER }), renew())),
				kind: "corrupt",
			},
			{
				label: "unsupported claim state",
				catches: "an intent over a newer state version",
				plan: planClaimTransition(planOptions(present({ ...active(KARL), claimState: 2 }), renew())),
				kind: "unsupported",
			},
			{
				label: "invalid request",
				catches: "an intent from an unparsed request",
				plan: planClaimTransition(planOptions(ABSENT, { action: "transfer" } as unknown as ClaimTransitionRequest)),
				kind: "invalid",
			},
		];
		for (const { label, catches, plan, kind } of cases) {
			expect({ label, planKind: plan.kind }).toEqual({ label, planKind: kind });
			expectMapFailure(`${label} (catches: ${catches})`, mapPlan(plan as Planned));
		}
	});
});

describe("claim transition execution before the network (blob)", () => {
	test(
		"loc-01: rejects every malformed request as invalid before context, journal, clock or network, three ways",
		async () => {
			await withCase("blob", "requests", async (fixture) => {
				const karl = await fixture.context();
				await fixture.writeState(active(karl.context.binding));
				// Positive control: a healthy renew applies, which also proves that S2 records the executor's Git.
				const controlClock = sequenceClock(T, T);
				const control = await fixture.run(fixture.options(karl, "op-loc-01-control", renew(), controlClock));
				const controlRoot = await fixture.ticketRoot(TICKET);
				const controlExpected = operationView("loc-01 positive control", {
					action: "renew",
					operationId: "op-loc-01-control",
					storage: appliedStorage(controlRoot),
					outcome: "applied",
					rights: heldRights(controlRoot, notYet(T + TTL + GRACE)),
					sends: 1,
				});
				await fixture.expectView(control.result, controlExpected, [karl]);
				expect({
					gitCallsSeen: control.gitCalls > 0,
					pushes: control.pushes.length,
					clockCalls: controlClock.calls(),
				}).toEqual({ gitCallsSeen: true, pushes: 1, clockCalls: 2 });

				await fixture.writeState({ state: "claimed", holder: OWNER }, SECOND_TICKET);
				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, { remote: stalledUrl, timeoutMs: STALL_TIMEOUT });
				const refsBefore = await fixture.serverRefs();
				const contextsBefore = await snapshot(fixture.parent);
				const clock = sequenceClock();
				class RenewRequest {
					action = "renew";
					ttlMs = TTL;
					ttlSource = "default";
				}
				// ASSUMPTION(executor): the request is checked by the exported request parser before the first await.
				const requests: { label: string; catches: string; request: unknown }[] = [
					{ label: "null request", catches: "a request read lazily after IO", request: null },
					{ label: "array request", catches: "a first element taken as the request", request: [renew()] },
					{ label: "unknown action transfer", catches: "admin actions leaking in", request: { action: "transfer" } },
					{
						label: "renew with an extra owner field",
						catches: "a second, laxer parser",
						request: { ...renew(), owner: OWNER },
					},
					{
						label: "renew ttl zero",
						catches: "a default TTL substituted",
						request: { action: "renew", ttlMs: 0, ttlSource: "default" },
					},
					{
						label: "request accessor",
						catches: "a getter read after the first await",
						request: withAccessor(renew(), "ttlMs", TTL),
					},
					{ label: "request class instance", catches: "non-plain data accepted", request: new RenewRequest() },
				];
				const settings: { where: string; changes: Partial<ExecuteClaimTransitionOptions> }[] = [
					{ where: "a plannable claim", changes: {} },
					{ where: "a stalled endpoint", changes: { storage: stalled } },
					{ where: "a corrupt payload", changes: { ticket: SECOND_TICKET } },
				];
				for (const [index, { label, catches, request }] of requests.entries()) {
					for (const [position, { where, changes }] of settings.entries()) {
						const operationId = `op-loc-01-${index + 1}-${position + 1}`;
						const options = fixture.options(karl, operationId, request as ClaimTransitionRequest, clock, changes);
						const run = await fixture.run(options);
						const expected = failureView(`${label} on ${where} (catches: ${catches})`, "invalid");
						await fixture.expectView(run.result, expected, [karl], [stalledUrl]);
						expect({ label, where, gitCalls: run.gitCalls }).toEqual({ label, where, gitCalls: 0 });
					}
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					contexts: await snapshot(fixture.parent),
				}).toEqual({ connections: 0, clockCalls: 0, refs: refsBefore, contexts: contextsBefore });

				// Positive control at the end: the same valid options reach the stalled listener, still without a clock.
				const stalledOptions = fixture.options(karl, "op-loc-01-stalled", renew(), clock, { storage: stalled });
				const stalledRun = await fixture.run(stalledOptions);
				await fixture.expectView(stalledRun.result, failureView("stalled endpoint", "unknown"), [karl], [stalledUrl]);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"loc-02: rejects malformed options as invalid before the journal and the network, and accepts 128 characters",
		async () => {
			await withCase("blob", "options", async (fixture) => {
				const karl = await fixture.context();
				// Positive control at the boundaries: a 128-character operation ID and a single attempt apply.
				const longId = `op-${"8".repeat(125)}`;
				const controlClock = sequenceClock(T, T);
				const control = await fixture.run(fixture.options(karl, longId, acquire(), controlClock, { attempts: 1 }));
				const root = await fixture.ticketRoot(TICKET);
				const controlExpected = operationView("loc-02 positive control", {
					action: "acquire",
					operationId: longId,
					storage: appliedStorage(root),
					outcome: "applied",
					rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
					sends: 1,
				});
				await fixture.expectView(control.result, controlExpected, [karl]);

				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, { remote: stalledUrl, timeoutMs: STALL_TIMEOUT });
				const refsBefore = await fixture.serverRefs();
				const contextsBefore = await snapshot(fixture.parent);
				const clock = sequenceClock();
				const rows: { label: string; catches: string; changes: Partial<ExecuteClaimTransitionOptions> }[] = [
					{ label: "non-canonical ticket", catches: "ticket normalization", changes: { ticket: "back-1" } },
					{ label: "empty operation ID", catches: "a generated fallback ID", changes: { operationId: "" } },
					{ label: "operation ID with a leading dash", catches: "the storage ID rule", changes: { operationId: "-x" } },
					{ label: "operation ID with a slash", catches: "a path escape", changes: { operationId: "a/b" } },
					{
						label: "operation ID of 129 characters",
						catches: "the journal length limit ignored",
						changes: { operationId: `op-${"9".repeat(126)}` },
					},
					{ label: "zero attempts", catches: "a send without an attempt", changes: { attempts: 0 } },
					{ label: "fractional attempts", catches: "a rounded attempt count", changes: { attempts: 1.5 } },
					{ label: "negative attempts", catches: "an unbounded attempt count", changes: { attempts: -1 } },
					{
						label: "attempts as a string",
						catches: "a coerced attempt count",
						changes: { attempts: "3" as unknown as number },
					},
					{
						// ASSUMPTION(executor): attempts is mandatory and has no default.
						label: "missing attempts",
						catches: "a default attempt count",
						changes: { attempts: undefined as unknown as number },
					},
					{ label: "negative epsilon", catches: "a lax skew check", changes: { clockSkewMs: -1 } },
					{
						label: "clock that is not a function",
						catches: "an implicit wall clock",
						changes: { clock: 42 as unknown as () => number },
					},
					{ label: "expected generation zero", catches: "a lax generation", changes: { expectedClaimGeneration: 0 } },
					{
						label: "remote name instead of an endpoint",
						catches: "remote-name routing",
						changes: { storage: { ...stalled, remote: "origin" } },
					},
					{
						label: "zero storage timeout",
						catches: "an unbounded Git command",
						changes: { storage: { ...stalled, timeoutMs: 0 } },
					},
					{ label: "relative context directory", catches: "an implicit context", changes: { contextDirectory: "ctx" } },
					{
						label: "storage that is not an object",
						catches: "default storage options",
						changes: { storage: null as unknown as ClaimStorageOptions },
					},
				];
				for (const [index, { label, catches, changes }] of rows.entries()) {
					const options = fixture.options(karl, `op-loc-02-${index + 1}`, acquire(), clock, {
						storage: stalled,
						...changes,
					});
					const run = await fixture.run(options);
					await fixture.expectView(
						run.result,
						failureView(`${label} (catches: ${catches})`, "invalid"),
						[karl],
						[stalledUrl],
					);
					expect({ label, gitCalls: run.gitCalls }).toEqual({ label, gitCalls: 0 });
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					contexts: await snapshot(fixture.parent),
				}).toEqual({ connections: 0, clockCalls: 0, refs: refsBefore, contexts: contextsBefore });

				const stalledOptions = fixture.options(karl, "op-loc-02-stalled", acquire(), clock, { storage: stalled });
				const stalledRun = await fixture.run(stalledOptions);
				await fixture.expectView(stalledRun.result, failureView("stalled endpoint", "unknown"), [karl], [stalledUrl]);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"loc-03: ends context and journal failures and an occupied operation ID before any network contact",
		async () => {
			await withCase("blob", "local", async (fixture) => {
				const karl = await fixture.context();
				// Positive control: an acquire applies and leaves its record, which the last row reuses.
				const controlClock = sequenceClock(T, T);
				const control = await fixture.run(fixture.options(karl, "op-loc-03-taken", acquire(), controlClock));
				const root = await fixture.ticketRoot(TICKET);
				const controlExpected = operationView("loc-03 positive control", {
					action: "acquire",
					operationId: "op-loc-03-taken",
					storage: appliedStorage(root),
					outcome: "applied",
					rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
					sends: 1,
				});
				await fixture.expectView(control.result, controlExpected, [karl]);

				const broken = await fixture.context();
				await chmod(join(broken.directory, "context.json"), 0o644);
				const missing = join(fixture.parent, "00000000-0000-4000-8000-000000000000");
				const stall = await fixture.stallProxy();
				const stalledUrl = `git://127.0.0.1:${stall.port}/stalled.git`;
				const stalled = fixture.storage(fixture.primary, { remote: stalledUrl, timeoutMs: STALL_TIMEOUT });
				const refsBefore = await fixture.serverRefs();
				const contextsBefore = await snapshot(fixture.parent);
				const clock = sequenceClock();
				const rows: {
					label: string;
					catches: string;
					operationId: string;
					changes: Partial<ExecuteClaimTransitionOptions>;
					kind: FailureKind;
				}[] = [
					{
						label: "missing context",
						catches: "an implicitly created context",
						operationId: "op-loc-03-1",
						changes: { contextDirectory: missing },
						kind: "invalid",
					},
					{
						label: "corrupt context",
						catches: "network before a local failure",
						operationId: "op-loc-03-2",
						changes: { contextDirectory: broken.directory },
						kind: "corrupt",
					},
					{
						label: "context IO failure",
						catches: "an IO failure read as a missing context",
						operationId: "op-loc-03-3",
						changes: { contextIO: failingContextLstat(join(karl.directory, "context.json")) },
						kind: "unavailable",
					},
					{
						label: "journal directory IO failure",
						catches: "a send without a readable journal",
						operationId: "op-loc-03-4",
						changes: { journalIO: failingDirectoryLstat(karl.context.journalDirectory) },
						kind: "unavailable",
					},
					{
						label: "operation ID already in the journal",
						catches: "reuse of an occupied operation ID",
						operationId: "op-loc-03-taken",
						changes: {},
						kind: "invalid",
					},
				];
				for (const row of rows) {
					const options = fixture.options(karl, row.operationId, acquire(), clock, {
						storage: stalled,
						...row.changes,
					});
					const run = await fixture.run(options);
					const expected = failureView(`${row.label} (catches: ${row.catches})`, row.kind);
					await fixture.expectView(run.result, expected, [karl, broken], [stalledUrl, missing]);
					expect({ label: row.label, gitCalls: run.gitCalls }).toEqual({ label: row.label, gitCalls: 0 });
				}
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					clockCalls: clock.calls(),
					refs: await fixture.serverRefs(),
					contexts: await snapshot(fixture.parent),
					missingCreated: await exists(missing),
				}).toEqual({
					connections: 0,
					clockCalls: 0,
					refs: refsBefore,
					contexts: contextsBefore,
					missingCreated: false,
				});

				const stalledOptions = fixture.options(karl, "op-loc-03-stalled", acquire(), clock, { storage: stalled });
				const stalledRun = await fixture.run(stalledOptions);
				await fixture.expectView(stalledRun.result, failureView("stalled endpoint", "unknown"), [karl], [stalledUrl]);
				expect({ connectionsSeen: stall.acceptedConnections > 0, clockCalls: clock.calls() }).toEqual({
					connectionsSeen: true,
					clockCalls: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"loc-04: captures options, request, clock and IO before the first await, so later mutation redirects nothing",
		async () => {
			await withCase("blob", "captured", async (fixture) => {
				const karl = await fixture.context();
				const franz = await fixture.context();
				const base = await fixture.writeState(active(karl.context.binding));
				const stall = await fixture.stallProxy();
				const other = await fixture.client("other");
				const storage = fixture.storage();
				const request = { action: "renew" as const, ttlMs: TTL, ttlSource: "default" as const };
				const io: typeof claimJournalIO = { ...claimJournalIO };
				const original = sequenceClock(T, T);
				const replacement = sequenceClock(H, H);
				const options = fixture.options(karl, "op-loc-04", request, original, { storage, journalIO: io });
				const mark = await fixture.mark();
				const pending = executeClaimTransition(options);
				storage.remote = `git://127.0.0.1:${stall.port}/redirected.git`;
				storage.repository = other;
				storage.format = "tree";
				storage.timeoutMs = 1;
				request.ttlMs = 30 * MINUTE;
				io.link = failingLink().link;
				options.request = acquire();
				options.operationId = "op-loc-04-redirected";
				options.ticket = SECOND_TICKET;
				options.contextDirectory = franz.directory;
				options.clock = replacement.clock;
				options.attempts = 0;
				options.storage = { ...storage };
				const run = await fixture.finish(pending, mark);
				const root = await fixture.ticketRoot(TICKET);
				const expected = operationView("loc-04 mutated after the call", {
					action: "renew",
					operationId: "op-loc-04",
					storage: appliedStorage(root),
					outcome: "applied",
					rights: heldRights(root, notYet(T + TTL + GRACE)),
					sends: 1,
				});
				await fixture.expectView(run.result, expected, [karl, franz]);
				const next = active(karl.context.binding, lease(T + TTL));
				const intent = fixture.intent({ operationId: "op-loc-04", expectedRoot: base, request: renew(), next });
				await Bun.sleep(SETTLE_MS);
				expect({
					connections: stall.acceptedConnections,
					originalClockCalls: original.calls(),
					replacementClockCalls: replacement.calls(),
					records: await fixture.records(karl),
					franzRecords: await fixture.records(franz),
					otherTicket: await fixture.ticketRoot(SECOND_TICKET),
					pushes: run.pushes.length,
				}).toEqual({
					connections: 0,
					originalClockCalls: 2,
					replacementClockCalls: 0,
					records: recordFile(intent),
					franzRecords: {},
					otherTicket: ABSENT_REF,
					pushes: 1,
				});
			});
		},
		TEST_TIMEOUT,
	);
});

for (const format of FORMATS) {
	describe(`claim transition execution over real Git (${format})`, () => {
		test(
			"exe-01 exe-02: acquires from absent and from a tombstone with the reference record, receipt and payload",
			async () => {
				await withCase(format, "acquire", async (fixture) => {
					const karl = await fixture.context();
					const binding = karl.context.binding;

					// exe-01 (catches: no journal or receipt, a recomputed payload, rights taken from the write result).
					const clock = sequenceClock(T, T);
					const run = await fixture.run(fixture.options(karl, "op-exe-01", acquire(), clock));
					const root = await fixture.ticketRoot(TICKET);
					const expected = operationView("exe-01 acquire from absent", {
						action: "acquire",
						operationId: "op-exe-01",
						storage: appliedStorage(root),
						outcome: "applied",
						rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(run.result, expected, [karl]);
					const next = active(binding, lease(T + TTL), { claimGeneration: 1 });
					const intent = fixture.intent({ operationId: "op-exe-01", expectedRoot: null, request: acquire(), next });
					expect({
						records: await fixture.records(karl),
						stored: await fixture.stored(TICKET, "op-exe-01"),
						pushes: run.pushes.length,
						clockCalls: clock.calls(),
					}).toEqual({ records: recordFile(intent), stored: storedView(next, intent, 1), pushes: 1, clockCalls: 2 });

					// exe-02 (catches: planning or a clock read before the fresh read; the caller's generation in the rights
					// evaluation).
					const tomb = await fixture.writeState(tombstone(4), SECOND_TICKET);
					expect(await fixture.hasObject(fixture.primary, tomb)).toBe(false);
					const presentAtClock: boolean[] = [];
					const tombClock = sequenceClock(() => {
						presentAtClock.push(fixture.hasObjectNow(fixture.primary, tomb));
						return T;
					}, T);
					// ASSUMPTION(executor): the final rights read expects next.claimGeneration (5), not the caller's 4.
					const changes = { ticket: SECOND_TICKET, expectedClaimGeneration: 4 };
					const second = await fixture.run(fixture.options(karl, "op-exe-02", acquire(), tombClock, changes));
					const secondRoot = await fixture.ticketRoot(SECOND_TICKET);
					const secondExpected = operationView("exe-02 acquire on a tombstone of generation 4", {
						action: "acquire",
						operationId: "op-exe-02",
						storage: appliedStorage(secondRoot),
						outcome: "applied",
						rights: heldRights(secondRoot, notYet(T + TTL + GRACE), live(false), 5),
						sends: 1,
					});
					await fixture.expectView(second.result, secondExpected, [karl]);
					const secondNext = active(binding, lease(T + TTL), { claimGeneration: 5 });
					const secondIntent = fixture.intent({
						operationId: "op-exe-02",
						ticket: SECOND_TICKET,
						expectedRoot: tomb,
						request: acquire(),
						next: secondNext,
					});
					expect({
						records: await fixture.records(karl),
						stored: await fixture.stored(SECOND_TICKET, "op-exe-02"),
						presentAtClock,
						clockCalls: tombClock.calls(),
					}).toEqual({
						records: { ...recordFile(intent), ...recordFile(secondIntent) },
						stored: storedView(secondNext, secondIntent, 2),
						presentAtClock: [true],
						clockCalls: 2,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-03: renews the own lease after L and after R and caps a default TTL at the stored H",
			async () => {
				await withCase(format, "renew", async (fixture) => {
					const karl = await fixture.context();
					const binding = karl.context.binding;
					const cases: {
						label: string;
						catches: string;
						ticket: string;
						now: number;
						stored: ClaimTiming;
						renewed: ClaimTiming;
						boundary: number;
					}[] = [
						{
							label: "renew after L",
							catches: "the lease end treated as a lock",
							ticket: TICKET,
							now: L + MINUTE,
							stored: lease(L),
							renewed: lease(L + MINUTE + TTL),
							boundary: L + MINUTE + TTL + GRACE,
						},
						{
							label: "renew after R",
							catches: "the reclaim boundary treated as the end of renewal",
							ticket: SECOND_TICKET,
							now: R + MINUTE,
							stored: lease(L),
							renewed: lease(R + MINUTE + TTL),
							boundary: R + MINUTE + TTL + GRACE,
						},
						{
							label: "renew capped at the stored H",
							catches: "a default TTL not capped at the hard end",
							ticket: THIRD_TICKET,
							now: H - 2 * MINUTE,
							stored: lease(L, H),
							renewed: lease(H, H),
							boundary: H + GRACE,
						},
					];
					const journal: Record<string, string> = {};
					for (const [index, entry] of cases.entries()) {
						const base = await fixture.writeState(active(binding, entry.stored), entry.ticket);
						const operationId = `op-exe-03-${index + 1}`;
						const clock = sequenceClock(entry.now, entry.now);
						const options = fixture.options(karl, operationId, renew(), clock, { ticket: entry.ticket });
						const run = await fixture.run(options);
						const root = await fixture.ticketRoot(entry.ticket);
						const expected = operationView(`exe-03 ${entry.label} (catches: ${entry.catches})`, {
							action: "renew",
							operationId,
							storage: appliedStorage(root),
							outcome: "applied",
							rights: heldRights(root, notYet(entry.boundary)),
							sends: 1,
						});
						await fixture.expectView(run.result, expected, [karl]);
						const next = active(binding, entry.renewed);
						const intent = fixture.intent({
							operationId,
							ticket: entry.ticket,
							expectedRoot: base,
							request: renew(),
							next,
						});
						Object.assign(journal, recordFile(intent));
						expect({
							label: entry.label,
							records: await fixture.records(karl),
							stored: await fixture.stored(entry.ticket, operationId),
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
						}).toEqual({
							label: entry.label,
							records: journal,
							stored: storedView(next, intent, 2),
							pushes: 1,
							clockCalls: 2,
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-04 exe-05: releases after H and reclaims foreign and own leases, each with a null target binding",
			async () => {
				await withCase(format, "free-successor", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const cases = [
						{
							label: "exe-04 release of the own claim after H (1A)",
							catches: "release bound to a work right, or the initiator stored as target binding",
							ticket: TICKET,
							request: release(),
							holder: karl,
							owner: OWNER,
							stored: lease(L, H),
							now: H + MINUTE,
						},
						{
							label: "exe-05 reclaim of a foreign lease at C-EPS=R",
							catches: "reclaim bound to the holder binding, or the displaced holder stored",
							ticket: SECOND_TICKET,
							request: reclaim(),
							holder: franz,
							owner: OTHER_OWNER,
							stored: lease(L),
							now: R + EPS,
						},
						{
							label: "exe-05 reclaim of the own reclaimable lease",
							catches: "reclaim refused for the holder's own binding",
							ticket: THIRD_TICKET,
							request: reclaim(),
							holder: karl,
							owner: OWNER,
							stored: lease(L),
							now: R + EPS,
						},
					];
					const journal: Record<string, string> = {};
					for (const [index, entry] of cases.entries()) {
						const state = active(entry.holder.context.binding, entry.stored, { owner: entry.owner });
						const base = await fixture.writeState(state, entry.ticket);
						const operationId = `op-free-${index + 1}`;
						const clock = sequenceClock(entry.now, entry.now);
						const options = fixture.options(karl, operationId, entry.request, clock, { ticket: entry.ticket });
						const run = await fixture.run(options);
						const root = await fixture.ticketRoot(entry.ticket);
						const expected = operationView(`${entry.label} (catches: ${entry.catches})`, {
							action: entry.request.action,
							operationId,
							storage: appliedStorage(root),
							outcome: "applied",
							rights: freeRights(root, 3),
							sends: 1,
						});
						await fixture.expectView(run.result, expected, [karl, franz]);
						// ASSUMPTION(executor): the reference record of a FREE successor carries targetBinding null.
						const intent = fixture.intent({
							operationId,
							ticket: entry.ticket,
							expectedRoot: base,
							request: entry.request,
							next: tombstone(3),
						});
						Object.assign(journal, recordFile(intent));
						expect({
							label: entry.label,
							records: await fixture.records(karl),
							stored: await fixture.stored(entry.ticket, operationId),
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
						}).toEqual({
							label: entry.label,
							records: journal,
							stored: storedView(tombstone(3), intent, 2),
							pushes: 1,
							clockCalls: 2,
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-06: persists and sends nothing for unplannable requests and reports the rights evaluation of the same read",
			async () => {
				await withCase(format, "not-planned", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const binding = karl.context.binding;
					// Positive control: an acquire on the second ticket applies.
					const controlOptions = fixture.options(karl, "op-exe-06-control", acquire(), sequenceClock(T, T), {
						ticket: SECOND_TICKET,
					});
					const control = await fixture.run(controlOptions);
					const controlRoot = await fixture.ticketRoot(SECOND_TICKET);
					const controlExpected = operationView("exe-06 positive control", {
						action: "acquire",
						operationId: "op-exe-06-control",
						storage: appliedStorage(controlRoot),
						outcome: "applied",
						rights: heldRights(controlRoot, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(control.result, controlExpected, [karl, franz]);
					const journal = await fixture.records(karl);

					const check = async (cases: NotPlannedCase[]) => {
						for (const entry of cases) {
							const root = await fixture.ticketRoot(TICKET);
							const now = entry.now ?? T;
							const clock = sequenceClock(now, now);
							const options = fixture.options(karl, entry.operationId, entry.request, clock, entry.changes);
							const run = await fixture.run(options);
							const label = `exe-06 ${entry.label} (catches: ${entry.catches})`;
							await fixture.expectView(run.result, notPlannedView(label, entry.plan, entry.rights), [karl, franz]);
							expect({
								label: entry.label,
								pushes: run.pushes.length,
								clockCalls: clock.calls(),
								root: await fixture.ticketRoot(TICKET),
								records: await fixture.records(karl),
							}).toEqual({ label: entry.label, pushes: 0, clockCalls: 1, root, records: journal });
						}
					};

					const foreignRoot = await fixture.writeState(active(franz.context.binding, lease(L), { owner: OTHER_OWNER }));
					const foreign = foreignRights(foreignRoot, notYet(R));
					await check([
						{
							label: "acquire on a foreign claim",
							catches: "a journal record or send before the plan is accepted",
							operationId: "op-exe-06-1",
							request: acquire(),
							plan: rejectedPlan("not-free"),
							rights: foreign,
						},
						{
							label: "renew of a foreign claim",
							catches: "renew bound to the owner name",
							operationId: "op-exe-06-2",
							request: renew(),
							plan: rejectedPlan("not-holder"),
							rights: foreign,
						},
						{
							label: "reclaim one millisecond before the boundary",
							catches: "an off-by-one reclaim boundary",
							operationId: "op-exe-06-3",
							request: reclaim(),
							now: R - 1 + EPS,
							plan: rejectedPlan("not-yet", R),
							rights: foreign,
						},
					]);
					const hardRoot = await fixture.writeState(active(binding, hard()));
					await check([
						{
							label: "renew in hard mode",
							catches: "a hard deadline extended like a lease",
							operationId: "op-exe-06-4",
							request: renew(),
							plan: rejectedPlan("not-renewable"),
							rights: heldRights(hardRoot, notYet(H + GRACE), live(null)),
						},
					]);
					const leaseRoot = await fixture.writeState(active(binding));
					await check([
						{
							label: "renew with a different expected generation",
							catches: "the caller's generation ignored",
							operationId: "op-exe-06-5",
							request: renew(),
							changes: { expectedClaimGeneration: 2 },
							plan: rejectedPlan("generation-changed"),
							rights: heldRights(leaseRoot, notYet(R), noRight("generation-changed")),
						},
					]);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-07: reports rights from the fresh final read, never from the storage verdict, also beyond H",
			async () => {
				await withCase(format, "rights-fact", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const binding = karl.context.binding;

					// (a) A competitor lands between the applied renew and the final read (catches: rights derived from
					// the storage verdict or the logical outcome).
					const base = await fixture.writeState(active(binding));
					const observed = { applied: ABSENT_REF, intruder: ABSENT_REF };
					const landed = async () => (await fixture.ticketRoot(TICKET)) !== base;
					const contextIO = contextLstatWhen(karl.directory, landed, async () => {
						observed.applied = await fixture.ticketRoot(TICKET);
						const intruder = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 4 });
						observed.intruder = await fixture.writeState(intruder);
					});
					const clock = sequenceClock(T, T);
					const run = await fixture.run(fixture.options(karl, "op-exe-07-a", renew(), clock, { contextIO }));
					const expected = operationView("exe-07a competitor before the final read", {
						action: "renew",
						operationId: "op-exe-07-a",
						storage: appliedStorage(observed.applied),
						outcome: "applied",
						rights: foreignRights(observed.intruder, notYet(R), 4),
						sends: 1,
					});
					await fixture.expectView(run.result, expected, [karl, franz]);
					expect({
						intruderDiffers: observed.intruder !== observed.applied,
						ref: await fixture.ticketRoot(TICKET),
						clockCalls: clock.calls(),
					}).toEqual({ intruderDiffers: true, ref: observed.intruder, clockCalls: 2 });

					// (b) Renew with H planned at H-EPS-1, final read at H+1 (catches: a work right beyond H).
					const capped = await fixture.writeState(active(binding, lease(L, H)), SECOND_TICKET);
					const lateClock = sequenceClock(H - EPS - 1, H + 1);
					const lateOptions = fixture.options(karl, "op-exe-07-b", renew(), lateClock, { ticket: SECOND_TICKET });
					const late = await fixture.run(lateOptions);
					const lateRoot = await fixture.ticketRoot(SECOND_TICKET);
					const lateExpected = operationView("exe-07b applied but hard-expired at the final read", {
						action: "renew",
						operationId: "op-exe-07-b",
						storage: appliedStorage(lateRoot),
						outcome: "applied",
						rights: heldRights(lateRoot, notYet(H + GRACE), noRight("hard-expired")),
						sends: 1,
					});
					await fixture.expectView(late.result, lateExpected, [karl, franz]);
					const lateNext = active(binding, lease(H, H));
					const lateIntent = fixture.intent({
						operationId: "op-exe-07-b",
						ticket: SECOND_TICKET,
						expectedRoot: capped,
						request: renew(),
						next: lateNext,
					});
					expect({ stored: await fixture.stored(SECOND_TICKET, "op-exe-07-b"), clockCalls: lateClock.calls() }).toEqual(
						{
							stored: storedView(lateNext, lateIntent, 2),
							clockCalls: 2,
						},
					);

					// (c) ASSUMPTION(executor): a clock failing at the final read turns only `rights` invalid.
					const brokenClock = sequenceClock(T, () => {
						throw new Error(`clock failure ${OWNER} ${karl.directory}`);
					});
					const broken = await fixture.run(
						fixture.options(karl, "op-exe-07-c", acquire(), brokenClock, { ticket: THIRD_TICKET }),
					);
					const brokenRoot = await fixture.ticketRoot(THIRD_TICKET);
					const brokenExpected = operationView("exe-07c final clock failure", {
						action: "acquire",
						operationId: "op-exe-07-c",
						storage: appliedStorage(brokenRoot),
						outcome: "applied",
						rights: failedRights("invalid"),
						sends: 1,
					});
					await fixture.expectView(broken.result, brokenExpected, [karl, franz]);
					expect({ clockCalls: brokenClock.calls() }).toEqual({ clockCalls: 2 });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-08: binds only through the loaded context binding, never through its recovery binding",
			async () => {
				await withCase(format, "recovery", async (fixture) => {
					const karl = await fixture.context();
					const resumed = await fixture.context(karl.directory);
					const clock = sequenceClock(T, T);
					const run = await fixture.run(fixture.options(resumed, "op-exe-08-acquire", acquire(), clock));
					const root = await fixture.ticketRoot(TICKET);
					const expected = operationView("exe-08 acquire in a resumed context", {
						action: "acquire",
						operationId: "op-exe-08-acquire",
						storage: appliedStorage(root),
						outcome: "applied",
						rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(run.result, expected, [karl, resumed]);
					const next = active(resumed.context.binding, lease(T + TTL), { claimGeneration: 1 });
					const intent = fixture.intent({
						operationId: "op-exe-08-acquire",
						expectedRoot: null,
						request: acquire(),
						next,
					});
					// catches: recovery.binding used as the caller binding.
					expect({
						recovery: resumed.context.recovery,
						freshBinding: resumed.context.binding !== karl.context.binding,
						stored: await fixture.stored(TICKET, "op-exe-08-acquire"),
						records: await fixture.records(resumed),
					}).toEqual({
						recovery: { binding: karl.context.binding },
						freshBinding: true,
						stored: storedView(next, intent, 1),
						records: recordFile(intent),
					});

					const recovered = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const renewOptions = fixture.options(resumed, "op-exe-08-renew", renew(), sequenceClock(T, T), {
						ticket: SECOND_TICKET,
					});
					const refused = await fixture.run(renewOptions);
					const refusedExpected = notPlannedView(
						"exe-08 renew of a claim the recovery binding holds",
						rejectedPlan("not-holder"),
						foreignRights(recovered, notYet(R)),
					);
					await fixture.expectView(refused.result, refusedExpected, [karl, resumed]);
					expect({
						pushes: refused.pushes.length,
						ref: await fixture.ticketRoot(SECOND_TICKET),
						records: await fixture.records(resumed),
					}).toEqual({ pushes: 0, ref: recovered, records: recordFile(intent) });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-09: reports descriptor, ticket and endpoint failures as unknown or unsupported, without init or clock",
			async () => {
				await withCase(format, "early-control", async (fixture) => {
					const karl = await fixture.context();
					const run = await fixture.run(fixture.options(karl, "op-exe-09-control", acquire(), sequenceClock(T, T)));
					const root = await fixture.ticketRoot(TICKET);
					const expected = operationView("exe-09 positive control", {
						action: "acquire",
						operationId: "op-exe-09-control",
						storage: appliedStorage(root),
						outcome: "applied",
						rights: heldRights(root, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(run.result, expected, [karl]);
				});

				const noChanges = async (): Promise<EarlySetup> => ({ changes: {}, extra: [] });
				const rows: EarlyCase[] = [
					{
						label: "missing descriptor",
						catches: "initialization or a format fallback",
						descriptor: "none",
						kind: "unknown",
						setup: async (fixture) => {
							await fixture.setServerBlob(TICKET_REF, `raw ticket ${format}\n`);
							return { changes: {}, extra: [] };
						},
					},
					{
						label: "descriptor of the other format",
						catches: "a format fallback",
						descriptor: "other",
						kind: "unknown",
						setup: noChanges,
					},
					{
						label: "descriptor schema 2",
						catches: "an unsupported schema read as missing",
						descriptor: "none",
						kind: "unsupported",
						setup: async (fixture) => {
							await fixture.setServerBlob(DESCRIPTOR_REF, `{"epoch":1,"format":"${format}","schema":2}\n`);
							return { changes: {}, extra: [] };
						},
					},
					{
						label: "ticket ref without a claim document",
						catches: "a clock call or a plan after a failed read",
						descriptor: "same",
						kind: "unknown",
						setup: async (fixture) => {
							await fixture.setServerBlob(TICKET_REF, `not a claim document ${format}\n`);
							return { changes: {}, extra: [] };
						},
					},
					{
						label: "unused loopback port",
						catches: "a failed open read as absent",
						descriptor: "same",
						kind: "unknown",
						setup: async (fixture) => {
							const refused = `git://127.0.0.1:${await unusedLoopbackPort()}/refused.git`;
							return { changes: { storage: fixture.storage(fixture.primary, { remote: refused }) }, extra: [refused] };
						},
					},
				];
				for (const [index, row] of rows.entries()) {
					await withCase(
						format,
						`early-${index + 1}`,
						async (fixture) => {
							const { changes, extra } = await row.setup(fixture);
							const karl = await fixture.context();
							const refsBefore = await fixture.serverRefs();
							const clock = sequenceClock(T, T);
							const run = await fixture.run(fixture.options(karl, `op-exe-09-${index + 1}`, acquire(), clock, changes));
							const expected = failureView(`exe-09 ${row.label} (catches: ${row.catches})`, row.kind);
							await fixture.expectView(run.result, expected, [karl], extra);
							expect({
								label: row.label,
								clockCalls: clock.calls(),
								pushes: run.pushes.length,
								records: await fixture.records(karl),
								refs: await fixture.serverRefs(),
							}).toEqual({ label: row.label, clockCalls: 0, pushes: 0, records: {}, refs: refsBefore });
						},
						row.descriptor,
					);
				}
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"exe-10 exe-11 exe-13: persists or sends nothing beyond the failed step, with the rights of the planning read",
			async () => {
				await withCase(format, "nothing-sent", async (fixture) => {
					const karl = await fixture.context();
					const binding = karl.context.binding;
					// Positive control: an acquire on the third ticket applies with one push and two clock calls.
					const controlClock = sequenceClock(T, T);
					const controlOptions = fixture.options(karl, "op-exe-10-control", acquire(), controlClock, {
						ticket: THIRD_TICKET,
					});
					const control = await fixture.run(controlOptions);
					const controlRoot = await fixture.ticketRoot(THIRD_TICKET);
					const controlExpected = operationView("exe-10 positive control", {
						action: "acquire",
						operationId: "op-exe-10-control",
						storage: appliedStorage(controlRoot),
						outcome: "applied",
						rights: heldRights(controlRoot, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(control.result, controlExpected, [karl]);
					expect({ pushes: control.pushes.length, clockCalls: controlClock.calls() }).toEqual({
						pushes: 1,
						clockCalls: 2,
					});
					const journal = await fixture.records(karl);

					// exe-10: payloads the planner cannot plan.
					const payloads: PayloadCase[] = [
						{
							label: "legacy name-based payload",
							catches: "a plan on an unclassified legacy claim",
							payload: { state: "claimed", holder: OWNER },
							kind: "corrupt",
						},
						{
							label: "pending payload",
							catches: "a plan on a PENDING claim",
							payload: { ...active(binding), status: "pending" },
							// The holder's own fields break the v1 PENDING schema.
							kind: "corrupt",
						},
						{
							label: "claim state version 2",
							catches: "a plan on a newer state version",
							payload: { ...active(binding), claimState: 2 },
							kind: "unsupported",
						},
					];
					for (const [index, entry] of payloads.entries()) {
						const root = await fixture.writeState(entry.payload);
						const operationId = `op-exe-10-${index + 1}`;
						const clock = sequenceClock(T, T);
						const run = await fixture.run(fixture.options(karl, operationId, renew(), clock));
						const label = `exe-10 ${entry.label} (catches: ${entry.catches})`;
						const expected = notPlannedView(label, failedPlan(entry.kind), failedRights(entry.kind));
						await fixture.expectView(run.result, expected, [karl]);
						expect({
							label: entry.label,
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							ref: await fixture.ticketRoot(TICKET),
							records: await fixture.records(karl),
						}).toEqual({ label: entry.label, pushes: 0, clockCalls: 1, ref: root, records: journal });
					}

					// exe-11 (catches: a dead intent persisted, or a write with a duplicate operation ID).
					const receipt = { schema: 1, intentDigest: sha256Hex("taken"), parameterDigest: sha256Hex("taken") };
					const taken = await fixture.writeChange(TICKET, {
						operationId: "op-exe-11",
						receipt,
						payload: active(binding),
					});
					const takenClock = sequenceClock(T, T);
					const reused = await fixture.run(fixture.options(karl, "op-exe-11", renew(), takenClock));
					const reusedExpected = failureView("exe-11 operation ID already stored as a receipt", "invalid");
					await fixture.expectView(reused.result, reusedExpected, [karl]);
					expect({
						pushes: reused.pushes.length,
						clockCallsAtMostOne: takenClock.calls() <= 1,
						ref: await fixture.ticketRoot(TICKET),
						records: await fixture.records(karl),
					}).toEqual({ pushes: 0, clockCallsAtMostOne: true, ref: taken, records: journal });

					// exe-13: nothing is sent without a freshly prepared intent (journal/README.md:19-21).
					const unpublished: UnpublishedCase[] = [
						{
							label: "exe-13 journal link failure",
							catches: "a send without a durable intent",
							operationId: "op-exe-13-eio",
							journalIO: failingLink(),
							cause: "journal-unavailable",
							published: false,
						},
						{
							// ASSUMPTION(executor): an identical intent published concurrently is not-sent/journal-loaded.
							label: "exe-13 identical intent published concurrently",
							catches: "a send for an intent this call did not prepare",
							operationId: "op-exe-13-loaded",
							journalIO: racedLink(),
							cause: "journal-loaded",
							published: true,
						},
					];
					const expectedRecords = { ...journal };
					for (const entry of unpublished) {
						const clock = sequenceClock(T, T);
						const changes = { ticket: SECOND_TICKET, journalIO: entry.journalIO };
						const run = await fixture.run(fixture.options(karl, entry.operationId, acquire(), clock, changes));
						const expected = operationView(`${entry.label} (catches: ${entry.catches})`, {
							action: "acquire",
							operationId: entry.operationId,
							storage: notSentStorage(entry.cause),
							outcome: "not-sent",
							rights: ABSENT_RIGHTS,
							sends: 0,
						});
						await fixture.expectView(run.result, expected, [karl]);
						const next = active(binding, lease(T + TTL), { claimGeneration: 1 });
						const intent = fixture.intent({
							operationId: entry.operationId,
							ticket: SECOND_TICKET,
							expectedRoot: null,
							request: acquire(),
							next,
						});
						if (entry.published) Object.assign(expectedRecords, recordFile(intent));
						expect({
							label: entry.label,
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							ref: await fixture.ticketRoot(SECOND_TICKET),
							records: await fixture.records(karl),
						}).toEqual({
							label: entry.label,
							pushes: 0,
							clockCalls: 1,
							ref: ABSENT_REF,
							records: expectedRecords,
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"exe-14: reports a first send that never left the client as not-sent, with rights from the final read",
			async () => {
				await withCase(format, "unsent", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const binding = karl.context.binding;
					// Positive control: an acquire on the first ticket applies with one push and two clock calls.
					const controlClock = sequenceClock(T, T);
					const control = await fixture.run(fixture.options(karl, "op-exe-14-control", acquire(), controlClock));
					const controlRoot = await fixture.ticketRoot(TICKET);
					const controlExpected = operationView("exe-14 positive control", {
						action: "acquire",
						operationId: "op-exe-14-control",
						storage: appliedStorage(controlRoot),
						outcome: "applied",
						rights: heldRights(controlRoot, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(control.result, controlExpected, [karl]);
					expect({ pushes: control.pushes.length, clockCalls: controlClock.calls() }).toEqual({
						pushes: 1,
						clockCalls: 2,
					});

					// The client refuses the prepared change before any push, and
					// the call ends not-sent without a query or a second send. The fault is set after the journal link and
					// repaired at the context load of the final queryClaimRight, where a competitor also lands, so the
					// rights can only come from that fresh read (catches: rights from the planning read).
					const objectsPath = (await server().git(fixture.primary, ["rev-parse", "--git-path", "objects"])).out;
					const objects = resolve(fixture.primary, objectsPath.trim());
					const rewrite = "url.file:///exe-14-rewrite/.insteadOf";
					const frozenModes = new Map<string, number>();
					const freezeObjects = async () => {
						const names = (await readdir(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name));
						for (const path of [objects, ...names.map((name) => join(objects, name))]) {
							frozenModes.set(path, (await lstat(path)).mode & 0o7777);
							await chmod(path, 0o555);
						}
					};
					const thawObjects = async () => {
						for (const [path, mode] of frozenModes) await chmod(path, mode);
						frozenModes.clear();
					};
					const rows = [
						{
							label: "exe-14 endpoint rewrite after the journal link",
							catches: "a refused write reported as sent, queried or retried",
							ticket: SECOND_TICKET,
							operationId: "op-exe-14-invalid",
							cause: "write-invalid",
							fault: async () => {
								await server().git(fixture.primary, ["config", rewrite, fixture.url]);
							},
							repair: async () => {
								await server().git(fixture.primary, ["config", "--unset-all", rewrite], undefined, false);
							},
						},
						{
							label: "exe-14 unwritable object store after the journal link",
							catches: "an unencodable change reported as sent, queried or retried",
							ticket: THIRD_TICKET,
							operationId: "op-exe-14-not-sent",
							cause: "write-not-sent",
							fault: freezeObjects,
							repair: thawObjects,
						},
					];
					const expectedRecords = await fixture.records(karl);
					for (const row of rows) {
						const observed = { faulted: false, blocked: false, repaired: false, intruder: ABSENT_REF };
						const journalIO = afterLink(async () => {
							await row.fault();
							observed.faulted = true;
							// Seam check: a fresh object cannot be written now (false when run as root or on a failed fault).
							const probe = ["hash-object", "-w", "--stdin"];
							const probed = await server().git(fixture.primary, probe, `${row.operationId}\n`, false);
							observed.blocked = row.cause !== "write-not-sent" || probed.rc !== 0;
						});
						const contextIO = contextLstatWhen(
							karl.directory,
							async () => observed.faulted,
							async () => {
								await row.repair();
								observed.repaired = true;
								const intruder = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 4 });
								observed.intruder = await fixture.writeState(intruder, row.ticket);
							},
						);
						const clock = sequenceClock(T, T);
						const changes = { ticket: row.ticket, journalIO, contextIO };
						// Repaired again whatever happens, so a failed call cannot leave the case directory unremovable.
						const pending = fixture.run(fixture.options(karl, row.operationId, acquire(), clock, changes));
						const run = await pending.finally(() => row.repair());
						const expected = operationView(`${row.label} (catches: ${row.catches})`, {
							action: "acquire",
							operationId: row.operationId,
							storage: notSentStorage(row.cause),
							outcome: "not-sent",
							rights: foreignRights(observed.intruder, notYet(R), 4),
							sends: 1,
						});
						await fixture.expectView(run.result, expected, [karl, franz]);
						// The prepared intent stays open in the journal.
						const next = active(binding, lease(T + TTL), { claimGeneration: 1 });
						const intent = fixture.intent({
							operationId: row.operationId,
							ticket: row.ticket,
							expectedRoot: null,
							request: acquire(),
							next,
						});
						Object.assign(expectedRecords, recordFile(intent));
						expect({
							label: row.label,
							seam: { faulted: observed.faulted, blocked: observed.blocked, repaired: observed.repaired },
							pushes: run.pushes.length,
							clockCalls: clock.calls(),
							ref: await fixture.ticketRoot(row.ticket),
							records: await fixture.records(karl),
						}).toEqual({
							label: row.label,
							seam: { faulted: true, blocked: true, repaired: true },
							pushes: 0,
							clockCalls: 2,
							ref: observed.intruder,
							records: expectedRecords,
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ret-01 ret-02: resolves a lost reply as stored without resending and resends an open intent identically",
			async () => {
				await withCase(format, "retry", async (fixture) => {
					const karl = await fixture.context();
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });

					// ret-01: the push lands, post-receive holds the reply past the client timeout; attempts 3 (catches:
					// a `=` re-push after stored, replanning after unknown, unknown despite stored).
					const pre1 = await fixture.hooks.count("pre");
					const post1 = await fixture.hooks.count("post");
					await fixture.hooks.plan("post", ["hold"]);
					const clock1 = sequenceClock(T, T);
					const lost = await fixture.run(fixture.options(karl, "op-ret-01", acquire(), clock1, { storage: loss }));
					const landed = await fixture.ticketRoot(TICKET);
					const lostExpected = operationView("ret-01 lost reply after landing", {
						action: "acquire",
						operationId: "op-ret-01",
						storage: queriedStorage("unknown", "resolved", "stored", landed),
						outcome: "applied",
						rights: heldRights(landed, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(lost.result, lostExpected, [karl]);
					const next = active(karl.context.binding, lease(T + TTL), { claimGeneration: 1 });
					const intent = fixture.intent({ operationId: "op-ret-01", expectedRoot: null, request: acquire(), next });
					expect({
						pushes: lost.pushes.length,
						preReceives: (await fixture.hooks.invocations("pre", pre1)).length,
						postReceives: (await fixture.hooks.invocations("post", post1)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(karl),
						stored: await fixture.stored(TICKET, "op-ret-01"),
						clockCalls: clock1.calls(),
					}).toEqual({
						pushes: 1,
						preReceives: 1,
						postReceives: [[{ from: null, to: landed, ref: TICKET_REF }]],
						records: recordFile(intent),
						stored: storedView(next, intent, 1),
						clockCalls: 2,
					});

					// ret-02: pre-receive holds the first push and declines it late; the open intent is resent (catches: a
					// retry with a new ID, new times, a new plan or a fresh base; a retry without a query).
					const base = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const pre2 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject", "pass"]);
					const clock2 = sequenceClock(T, T);
					const retryOptions = fixture.options(karl, "op-ret-02", renew(), clock2, {
						ticket: SECOND_TICKET,
						storage: loss,
						attempts: 2,
					});
					const retried = await fixture.run(retryOptions);
					const renewed = await fixture.ticketRoot(SECOND_TICKET);
					const retriedExpected = operationView("ret-02 identical retry of an open intent", {
						action: "renew",
						operationId: "op-ret-02",
						storage: appliedStorage(renewed),
						outcome: "applied",
						rights: heldRights(renewed, notYet(T + TTL + GRACE)),
						sends: 2,
					});
					await fixture.expectView(retried.result, retriedExpected, [karl]);
					const renewNext = active(karl.context.binding, lease(T + TTL));
					const renewIntent = fixture.intent({
						operationId: "op-ret-02",
						ticket: SECOND_TICKET,
						expectedRoot: base,
						request: renew(),
						next: renewNext,
					});
					// ASSUMPTION(executor): both sends use the original read as base, so both receive lines are identical.
					const line = { from: base, to: renewed, ref: refOf(SECOND_TICKET) };
					expect({
						pushes: retried.pushes.length,
						distinctPushes: distinct(retried.pushes),
						receives: (await fixture.hooks.invocations("pre", pre2)).map((call) => call.lines.map(receiveOf)),
						records: await fixture.records(karl),
						stored: await fixture.stored(SECOND_TICKET, "op-ret-02"),
						clockCalls: clock2.calls(),
					}).toEqual({
						pushes: 2,
						distinctPushes: 1,
						receives: [[line], [line]],
						records: { ...recordFile(intent), ...recordFile(renewIntent) },
						stored: storedView(renewNext, renewIntent, 2),
						clockCalls: 2,
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ret-03 rej-04: stops at the attempt limit or at a declined repetition and reports the open intent unknown",
			async () => {
				await withCase(format, "open", async (fixture) => {
					const karl = await fixture.context();
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });
					const cases: OpenCase[] = [
						{
							label: "ret-03a one attempt, the push held and declined late",
							catches: "a retry beyond the limit, or open read as rejected or applied",
							ticket: TICKET,
							attempts: 1,
							actions: ["hold-reject"],
							rest: "pass",
							after: "unknown",
							sends: 1,
						},
						{
							label: "ret-03b two attempts, both pushes held and declined late",
							catches: "unbounded retries",
							ticket: SECOND_TICKET,
							attempts: 2,
							actions: ["hold-reject", "hold-reject"],
							rest: "pass",
							after: "unknown",
							sends: 2,
						},
						{
							label: "rej-04 a repetition declined after a lost first reply",
							catches: "a declined repetition read as final, or a third send",
							ticket: THIRD_TICKET,
							attempts: 3,
							actions: ["hold-reject", "reject"],
							rest: "reject",
							after: "remote",
							sends: 2,
						},
					];
					const journal: Record<string, string> = {};
					for (const [index, entry] of cases.entries()) {
						const operationId = `op-open-${index + 1}`;
						const pre = await fixture.hooks.count("pre");
						await fixture.hooks.plan("pre", entry.actions, entry.rest);
						const clock = sequenceClock(T, T);
						const options = fixture.options(karl, operationId, acquire(), clock, {
							ticket: entry.ticket,
							storage: loss,
							attempts: entry.attempts,
						});
						const run = await fixture.run(options);
						const expected = operationView(`${entry.label} (catches: ${entry.catches})`, {
							action: "acquire",
							operationId,
							storage: queriedStorage(entry.after, "resolved", "open", null),
							outcome: "unknown",
							rights: ABSENT_RIGHTS,
							sends: entry.sends,
						});
						await fixture.expectView(run.result, expected, [karl]);
						const next = active(karl.context.binding, lease(T + TTL), { claimGeneration: 1 });
						const intent = fixture.intent({
							operationId,
							ticket: entry.ticket,
							expectedRoot: null,
							request: acquire(),
							next,
						});
						Object.assign(journal, recordFile(intent));
						expect({
							label: entry.label,
							pushes: run.pushes.length,
							distinctPushes: distinct(run.pushes),
							preReceives: (await fixture.hooks.invocations("pre", pre)).length,
							ref: await fixture.ticketRoot(entry.ticket),
							records: await fixture.records(karl),
							clockCalls: clock.calls(),
						}).toEqual({
							label: entry.label,
							pushes: entry.sends,
							distinctPushes: 1,
							preReceives: entry.sends,
							ref: ABSENT_REF,
							records: journal,
							clockCalls: 2,
						});
					}
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ret-04 ret-05 ret-06: never resends or replans after not-stored, a contradicting receipt or lost history",
			async () => {
				await withCase(format, "settled", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });
					const foreign = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 1 });
					const acquired = active(karl.context.binding, lease(T + TTL), { claimGeneration: 1 });
					const renewBase = await fixture.writeState(active(karl.context.binding), THIRD_TICKET);
					const landed = { competitor: ABSENT_REF, contradicting: ABSENT_REF };
					const journal: Record<string, string> = {};

					// ret-04: a competitor lands while the first push is held (catches: replanning against the newer
					// root, or a retry after not-stored).
					const pre4 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const held4 = () => fixture.hooks.hasEntered("pre", pre4 + 1);
					const io4 = recordLstatWhen("op-ret-04", held4, async () => {
						landed.competitor = await fixture.writeState(foreign, TICKET);
					});
					const clock4 = sequenceClock(T, T);
					const options4 = fixture.options(karl, "op-ret-04", acquire(), clock4, { storage: loss, journalIO: io4 });
					const run4 = await fixture.run(options4);
					const expected4 = operationView("ret-04 competitor landed while held", {
						action: "acquire",
						operationId: "op-ret-04",
						storage: queriedStorage("unknown", "resolved", "not-stored", landed.competitor),
						outcome: "rejected",
						rights: foreignRights(landed.competitor, notYet(R), 1),
						sends: 1,
					});
					await fixture.expectView(run4.result, expected4, handles);
					const intent4 = fixture.intent({
						operationId: "op-ret-04",
						expectedRoot: null,
						request: acquire(),
						next: acquired,
					});
					Object.assign(journal, recordFile(intent4));
					expect({
						pushes: run4.pushes.length,
						ref: await fixture.ticketRoot(TICKET),
						records: await fixture.records(karl),
						clockCalls: clock4.calls(),
					}).toEqual({ pushes: 1, ref: landed.competitor, records: journal, clockCalls: 2 });

					// ret-05: the competitor lands a different receipt under our operation ID (catches: a retry or a
					// success on contradicting evidence). ASSUMPTION(executor): conflict maps to unknown-history.
					const pre5 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const held5 = () => fixture.hooks.hasEntered("pre", pre5 + 1);
					const contradicting = {
						schema: 1,
						intentDigest: sha256Hex("contradicting intent"),
						parameterDigest: sha256Hex("contradicting parameters"),
					};
					const io5 = recordLstatWhen("op-ret-05", held5, async () => {
						const change = { operationId: "op-ret-05", receipt: contradicting, payload: foreign };
						landed.contradicting = await fixture.writeChange(SECOND_TICKET, change);
					});
					const clock5 = sequenceClock(T, T);
					const options5 = fixture.options(karl, "op-ret-05", acquire(), clock5, {
						ticket: SECOND_TICKET,
						storage: loss,
						journalIO: io5,
					});
					const run5 = await fixture.run(options5);
					const expected5 = operationView("ret-05 contradicting receipt under the own ID", {
						action: "acquire",
						operationId: "op-ret-05",
						storage: queriedStorage("unknown", "resolved", "conflict", null),
						outcome: "unknown-history",
						rights: foreignRights(landed.contradicting, notYet(R), 1),
						sends: 1,
					});
					await fixture.expectView(run5.result, expected5, handles);
					const intent5 = fixture.intent({
						operationId: "op-ret-05",
						ticket: SECOND_TICKET,
						expectedRoot: null,
						request: acquire(),
						next: acquired,
					});
					Object.assign(journal, recordFile(intent5));
					expect({
						pushes: run5.pushes.length,
						ref: await fixture.ticketRoot(SECOND_TICKET),
						records: await fixture.records(karl),
						clockCalls: clock5.calls(),
					}).toEqual({ pushes: 1, ref: landed.contradicting, records: journal, clockCalls: 2 });

					// ret-06: the ticket ref vanishes while the renew is held (catches: missing history read as
					// not-stored or open).
					const pre6 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold-reject"], "pass");
					const held6 = () => fixture.hooks.hasEntered("pre", pre6 + 1);
					const io6 = recordLstatWhen("op-ret-06", held6, async () => {
						await fixture.deleteServerRef(refOf(THIRD_TICKET));
					});
					const clock6 = sequenceClock(T, T);
					const options6 = fixture.options(karl, "op-ret-06", renew(), clock6, {
						ticket: THIRD_TICKET,
						storage: loss,
						journalIO: io6,
					});
					const run6 = await fixture.run(options6);
					const expected6 = operationView("ret-06 ticket history deleted while held", {
						action: "renew",
						operationId: "op-ret-06",
						storage: queriedStorage("unknown", "resolved", "unknown-history", null),
						outcome: "unknown-history",
						rights: ABSENT_RIGHTS,
						sends: 1,
					});
					await fixture.expectView(run6.result, expected6, handles);
					const intent6 = fixture.intent({
						operationId: "op-ret-06",
						ticket: THIRD_TICKET,
						expectedRoot: renewBase,
						request: renew(),
						next: active(karl.context.binding, lease(T + TTL)),
					});
					Object.assign(journal, recordFile(intent6));
					expect({
						pushes: run6.pushes.length,
						ref: await fixture.ticketRoot(THIRD_TICKET),
						records: await fixture.records(karl),
						clockCalls: clock6.calls(),
					}).toEqual({ pushes: 1, ref: ABSENT_REF, records: journal, clockCalls: 2 });
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ret-07 ret-08: reports an unreadable query as unknown and a delayed first landing as applied",
			async () => {
				await withCase(format, "delayed", async (fixture) => {
					const karl = await fixture.context();
					const loss = fixture.storage(fixture.primary, { timeoutMs: LOSS_TIMEOUT });

					// ret-07: the push lands, its reply is lost and the query cannot read the record (catches: success
					// guessed, or a retry without query evidence).
					const post7 = await fixture.hooks.count("post");
					await fixture.hooks.plan("post", ["hold"]);
					const journalIO = recordLstatWhen("op-ret-07", () => fixture.hooks.hasEntered("post", post7 + 1), "fail");
					const clock7 = sequenceClock(T, T);
					const options7 = fixture.options(karl, "op-ret-07", acquire(), clock7, { storage: loss, journalIO });
					const run7 = await fixture.run(options7);
					const landed7 = await fixture.ticketRoot(TICKET);
					const expected7 = operationView("ret-07 query unavailable after a landed push", {
						action: "acquire",
						operationId: "op-ret-07",
						storage: queriedStorage("unknown", "unavailable"),
						outcome: "unknown",
						rights: heldRights(landed7, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(run7.result, expected7, [karl]);
					expect({ pushes: run7.pushes.length, clockCalls: clock7.calls() }).toEqual({ pushes: 1, clockCalls: 2 });

					// ret-08: the delayed first push lands while its identical repetition is in flight (catches: a
					// declined repetition read as a final rejection).
					const pre8 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", ["hold", "hold"], "pass");
					const clock8 = sequenceClock(T, T);
					const options8 = fixture.options(karl, "op-ret-08", acquire(), clock8, {
						ticket: SECOND_TICKET,
						storage: loss,
						attempts: 2,
					});
					const pending = tracked(fixture.run(options8));
					// Orchestrate only while the executor runs; a call that settles early goes straight to the verdict.
					const repeated = await whilePending("the repetition in pre-receive", pending, () =>
						fixture.hooks.hasEntered("pre", pre8 + 2),
					);
					let repetitionHeldAtLanding = false;
					if (repeated) {
						await fixture.hooks.release("pre", pre8 + 1);
						const firstLanded = async () => (await fixture.ticketRoot(SECOND_TICKET)) !== ABSENT_REF;
						const landedWhilePending = await whilePending("the delayed first push to land", pending, firstLanded);
						// Still unfinished after the ref moved means unfinished when it moved: the repetition did not land it.
						repetitionHeldAtLanding = landedWhilePending && !(await fixture.hooks.hasFinished("pre", pre8 + 2));
						await fixture.hooks.release("pre", pre8 + 2);
					}
					const run8 = await pending.promise;
					const landed8 = await fixture.ticketRoot(SECOND_TICKET);
					const actual = await fixture.view("ret-08 delayed first landing", run8.result, [karl]);
					// [?] ret-08: the repetition reads as remote or unknown; both are
					// accepted until the RED observation fixes `after`.
					const after = actual.storage?.after ?? null;
					const settledAfter = after === "remote" || after === "unknown" ? OBSERVED_AFTER : after;
					const normalized = {
						...actual,
						storage: actual.storage === null ? null : { ...actual.storage, after: settledAfter },
					};
					const expected8 = operationView("ret-08 delayed first landing", {
						action: "acquire",
						operationId: "op-ret-08",
						storage: queriedStorage(OBSERVED_AFTER, "resolved", "stored", landed8),
						outcome: "applied",
						rights: heldRights(landed8, notYet(T + TTL + GRACE), live(false), 1),
						sends: 2,
					});
					expect(normalized).toStrictEqual(expected8);
					// Fixture precondition: the landing came from the first push's receive-pack, not from the repetition. The
					// receive-pack of a timed-out client ran no post-receive in k3a-green1, so the proof is that the second of
					// two distinct receive-packs was still holding in pre-receive when the ref moved.
					const receives = await fixture.hooks.invocations("pre", pre8);
					expect({
						pushes: run8.pushes.length,
						receivePacks: new Set(receives.map((call) => call.ppid)).size,
						repetitionHeldAtLanding,
						clockCalls: clock8.calls(),
					}).toEqual({ pushes: 2, receivePacks: 2, repetitionHeldAtLanding: true, clockCalls: 2 });
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"rej-01 rej-02 rej-03: reports stale and remote rejections as distinct verdicts without ownership or retry",
			async () => {
				await withCase(format, "rejections", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					// Positive control: an acquire applies with exactly one push (S2) and one receive (S1).
					const pre0 = await fixture.hooks.count("pre");
					const controlOptions = fixture.options(karl, "op-rej-control", acquire(), sequenceClock(T, T), {
						ticket: SECOND_TICKET,
					});
					const control = await fixture.run(controlOptions);
					const controlRoot = await fixture.ticketRoot(SECOND_TICKET);
					const controlExpected = operationView("rej positive control", {
						action: "acquire",
						operationId: "op-rej-control",
						storage: appliedStorage(controlRoot),
						outcome: "applied",
						rights: heldRights(controlRoot, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(control.result, controlExpected, handles);
					expect({
						pushes: control.pushes.length,
						receives: (await fixture.hooks.invocations("pre", pre0)).length,
					}).toEqual({ pushes: 1, receives: 1 });
					const controlIntent = fixture.intent({
						operationId: "op-rej-control",
						ticket: SECOND_TICKET,
						expectedRoot: null,
						request: acquire(),
						next: active(karl.context.binding, lease(T + TTL), { claimGeneration: 1 }),
					});
					const renewed = active(karl.context.binding, lease(T + TTL));

					// rej-01: a newer root lands between plan and send; the lease fails at the client (catches: retry or
					// replanning against the newer root, stale reported as unknown or remote, an ownership claim).
					const staleBase = await fixture.writeState(active(karl.context.binding));
					const newer = { root: ABSENT_REF };
					const pre1 = await fixture.hooks.count("pre");
					const staleClock = sequenceClock(T, T);
					const staleIO = afterLink(async () => {
						const intruder = active(franz.context.binding, lease(L), { owner: OTHER_OWNER, claimGeneration: 4 });
						newer.root = await fixture.writeState(intruder);
					});
					const stale = await fixture.run(
						fixture.options(karl, "op-rej-01", renew(), staleClock, { journalIO: staleIO }),
					);
					const staleExpected = operationView("rej-01 stale", {
						action: "renew",
						operationId: "op-rej-01",
						storage: rejectedStorage("stale"),
						outcome: "rejected",
						rights: foreignRights(newer.root, notYet(R), 4),
						sends: 1,
					});
					await fixture.expectView(stale.result, staleExpected, handles);
					const staleIntent = fixture.intent({
						operationId: "op-rej-01",
						expectedRoot: staleBase,
						request: renew(),
						next: renewed,
					});
					expect({
						pushes: stale.pushes.length,
						receives: (await fixture.hooks.invocations("pre", pre1)).map((call) => call.lines.map(receiveOf)),
						ref: await fixture.ticketRoot(TICKET),
						records: await fixture.records(karl),
						clockCalls: staleClock.calls(),
					}).toEqual({
						pushes: 1,
						receives: [[{ from: staleBase, to: newer.root, ref: TICKET_REF }]],
						ref: newer.root,
						records: { ...recordFile(controlIntent), ...recordFile(staleIntent) },
						clockCalls: 2,
					});

					// rej-02: the server declines the push; nothing is resent although three attempts are allowed
					// (catches: remote reported as stale or unknown, a retry after remote).
					const remoteBase = await fixture.writeState(active(karl.context.binding), THIRD_TICKET);
					const pre2 = await fixture.hooks.count("pre");
					await fixture.hooks.plan("pre", [], "reject");
					const remoteClock = sequenceClock(T, T);
					const remoteOptions = fixture.options(karl, "op-rej-02", renew(), remoteClock, { ticket: THIRD_TICKET });
					const declined = await fixture.run(remoteOptions);
					const remoteExpected = operationView("rej-02 remote", {
						action: "renew",
						operationId: "op-rej-02",
						storage: rejectedStorage("remote"),
						outcome: "rejected",
						rights: heldRights(remoteBase, notYet(R)),
						sends: 1,
					});
					await fixture.expectView(declined.result, remoteExpected, handles);
					const receives = (await fixture.hooks.invocations("pre", pre2)).map((call) => call.lines.map(receiveOf));
					const pushedTo = receives[0]?.[0]?.to ?? ABSENT_REF;
					const remoteIntent = fixture.intent({
						operationId: "op-rej-02",
						ticket: THIRD_TICKET,
						expectedRoot: remoteBase,
						request: renew(),
						next: renewed,
					});
					expect({
						pushes: declined.pushes.length,
						receives,
						newObjectPushed: pushedTo !== remoteBase && pushedTo !== ABSENT_REF,
						ref: await fixture.ticketRoot(THIRD_TICKET),
						stored: await fixture.stored(THIRD_TICKET, "op-rej-02"),
						clockCalls: remoteClock.calls(),
					}).toEqual({
						pushes: 1,
						receives: [[{ from: remoteBase, to: pushedTo, ref: refOf(THIRD_TICKET) }]],
						newObjectPushed: true,
						ref: remoteBase,
						stored: { ...storedView(active(karl.context.binding), remoteIntent, 1), receipt: null },
						clockCalls: 2,
					});
					await fixture.hooks.plan("pre", [], "pass");

					// rej-03: both verdicts differ only in storage.cause; ownership lives in rights alone.
					const verdictOnly = (view: ExecutionView): ExecutionView => ({
						...view,
						label: "",
						operationId: null,
						rights: null,
						storage: view.storage === null ? null : { ...view.storage, cause: null },
					});
					const staleView = viewOf("", stale.result, NO_SENTINELS);
					const remoteView = viewOf("", declined.result, NO_SENTINELS);
					expect(verdictOnly(staleView)).toStrictEqual(verdictOnly(remoteView));
					expect([staleView.storage?.cause ?? null, remoteView.storage?.cause ?? null]).toEqual(["stale", "remote"]);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"cmp-01 cmp-02: lets exactly one of two racing executors win; the loser is stale, rights show the winner",
			async () => {
				await withCase(format, "races", async (fixture) => {
					const karl = await fixture.context();
					const franz = await fixture.context();
					const handles = [karl, franz];
					const other = await fixture.client("franz");
					const franzStorage = fixture.storage(other);

					// cmp-01: Karl's link starts Franz's executor; both acquire from absent (catches: double
					// acquisition).
					const nested: { run?: Run } = {};
					const franzAcquire = fixture.options(franz, "op-cmp-01-franz", acquire(OTHER_OWNER), sequenceClock(T, T), {
						storage: franzStorage,
					});
					const karlAcquire = fixture.options(karl, "op-cmp-01-karl", acquire(), sequenceClock(T, T), {
						journalIO: afterLink(async () => {
							nested.run = await fixture.run(franzAcquire, other);
						}),
					});
					const karlRun = await fixture.run(karlAcquire);
					const winner = await fixture.ticketRoot(TICKET);
					const karlExpected = operationView("cmp-01 Karl loses the acquire race", {
						action: "acquire",
						operationId: "op-cmp-01-karl",
						storage: rejectedStorage("stale"),
						outcome: "rejected",
						rights: foreignRights(winner, notYet(T + TTL + GRACE), 1),
						sends: 1,
					});
					await fixture.expectView(karlRun.result, karlExpected, handles);
					const franzExpected = operationView("cmp-01 Franz wins the acquire race", {
						action: "acquire",
						operationId: "op-cmp-01-franz",
						storage: appliedStorage(winner),
						outcome: "applied",
						rights: heldRights(winner, notYet(T + TTL + GRACE), live(false), 1),
						sends: 1,
					});
					await fixture.expectView(nested.run?.result ?? NOT_RUN, franzExpected, handles);
					const franzNext = active(franz.context.binding, lease(T + TTL), { owner: OTHER_OWNER, claimGeneration: 1 });
					const franzIntent = fixture.intent({
						operationId: "op-cmp-01-franz",
						expectedRoot: null,
						request: acquire(OTHER_OWNER),
						next: franzNext,
					});
					expect({
						stored: await fixture.stored(TICKET, "op-cmp-01-franz"),
						pushes: [karlRun.pushes.length, nested.run?.pushes.length ?? 0],
					}).toEqual({ stored: storedView(franzNext, franzIntent, 1), pushes: [1, 1] });

					// cmp-02: Karl renews while Franz reclaims, both at C-EPS=R, in both orders.
					const C = R + EPS;
					const renewedReclaim = notYet(C + TTL + GRACE);

					// Order 1: Franz's reclaim lands inside Karl's renew (catches: renew reviving a lost claim).
					const firstBase = await fixture.writeState(active(karl.context.binding), SECOND_TICKET);
					const innerReclaim: { run?: Run } = {};
					const franzReclaim = fixture.options(franz, "op-cmp-02-reclaim", reclaim(), sequenceClock(C, C), {
						ticket: SECOND_TICKET,
						storage: franzStorage,
					});
					const karlRenew = fixture.options(karl, "op-cmp-02-renew-late", renew(), sequenceClock(C, C), {
						ticket: SECOND_TICKET,
						journalIO: afterLink(async () => {
							innerReclaim.run = await fixture.run(franzReclaim, other);
						}),
					});
					const lateRenew = await fixture.run(karlRenew);
					const freed = await fixture.ticketRoot(SECOND_TICKET);
					const lateRenewExpected = operationView("cmp-02 renew loses to reclaim", {
						action: "renew",
						operationId: "op-cmp-02-renew-late",
						storage: rejectedStorage("stale"),
						outcome: "rejected",
						rights: freeRights(freed, 3),
						sends: 1,
					});
					await fixture.expectView(lateRenew.result, lateRenewExpected, handles);
					const reclaimExpected = operationView("cmp-02 reclaim wins", {
						action: "reclaim",
						operationId: "op-cmp-02-reclaim",
						storage: appliedStorage(freed),
						outcome: "applied",
						rights: freeRights(freed, 3),
						sends: 1,
					});
					await fixture.expectView(innerReclaim.run?.result ?? NOT_RUN, reclaimExpected, handles);
					const reclaimIntent = fixture.intent({
						operationId: "op-cmp-02-reclaim",
						ticket: SECOND_TICKET,
						expectedRoot: firstBase,
						request: reclaim(),
						next: tombstone(3),
					});
					expect(await fixture.stored(SECOND_TICKET, "op-cmp-02-reclaim")).toEqual(
						storedView(tombstone(3), reclaimIntent, 2),
					);

					// Order 2: Karl's renew lands inside Franz's reclaim (catches: reclaim after an unobserved renewal).
					const secondBase = await fixture.writeState(active(karl.context.binding), THIRD_TICKET);
					const innerRenew: { run?: Run } = {};
					const karlFirst = fixture.options(karl, "op-cmp-02-renew", renew(), sequenceClock(C, C), {
						ticket: THIRD_TICKET,
					});
					const franzLate = fixture.options(franz, "op-cmp-02-reclaim-late", reclaim(), sequenceClock(C, C), {
						ticket: THIRD_TICKET,
						storage: franzStorage,
						journalIO: afterLink(async () => {
							innerRenew.run = await fixture.run(karlFirst);
						}),
					});
					const lateReclaim = await fixture.run(franzLate, other);
					const renewedRoot = await fixture.ticketRoot(THIRD_TICKET);
					const lateReclaimExpected = operationView("cmp-02 reclaim loses to renew", {
						action: "reclaim",
						operationId: "op-cmp-02-reclaim-late",
						storage: rejectedStorage("stale"),
						outcome: "rejected",
						rights: foreignRights(renewedRoot, renewedReclaim),
						sends: 1,
					});
					await fixture.expectView(lateReclaim.result, lateReclaimExpected, handles);
					const renewExpected = operationView("cmp-02 renew wins", {
						action: "renew",
						operationId: "op-cmp-02-renew",
						storage: appliedStorage(renewedRoot),
						outcome: "applied",
						rights: heldRights(renewedRoot, renewedReclaim),
						sends: 1,
					});
					await fixture.expectView(innerRenew.run?.result ?? NOT_RUN, renewExpected, handles);
					const renewNext = active(karl.context.binding, lease(C + TTL));
					const renewIntent = fixture.intent({
						operationId: "op-cmp-02-renew",
						ticket: THIRD_TICKET,
						expectedRoot: secondBase,
						request: renew(),
						next: renewNext,
					});
					expect(await fixture.stored(THIRD_TICKET, "op-cmp-02-renew")).toEqual(storedView(renewNext, renewIntent, 2));
				});
			},
			TEST_TIMEOUT,
		);
	});
}
