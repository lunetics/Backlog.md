/**
 * Emergency release, level P: the eighth transition action and its authorisation. Pinned here: the exact request and
 * the planner order (em-p01 to em-p05); the optional key `claims.recovery_authorities` (em-p06); the authority
 * derivation (em-p07); the local authorisation before any Git call and any record (em-p08); the input codes (em-p09);
 * the retry lock (em-p10); the codes and the plan cause (em-p11); the preview allowlist (em-p12). em-p01 to em-p06 and
 * em-p11 are pure; em-p07 to em-p09 run in process over private temp contexts, with a project root no Git command can
 * use (em-p08 counts every `git` subprocess through a spy on Bun.spawn); em-p10 and em-p12 need a ready preflight and
 * run against the loopback Git daemon of claim-git-fixture.ts, blob only, with explicit timeouts (a deviation from
 * "pure"). Every test starts with a positive control that fails on the scaffold; table rows name the deliberately
 * wrong implementation they catch. Contract names are used directly; the two shapes the contract leaves open (the
 * signature of `claimContextAuthority`, the input form of the preview) each go through exactly one helper. Harness:
 * adapted copies with "adapted from" notes, no shared fixture module.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveClaimSettings } from "../claims/config/index.ts";
// claimContextAuthority lives in context/ (the scaffold answers {kind: "derived", authorityId: ""}); its
// only call site is authorityOf below.
import {
	type ClaimContext,
	claimContextAuthority,
	claimContextIO,
	createClaimContext,
	loadClaimContext,
} from "../claims/context/index.ts";
import { type ClaimExecutionResult, claimOperationIntentOf } from "../claims/execution/index.ts";
import { type ClaimOperationIntent, claimJournalIO, openClaimIntentJournal } from "../claims/journal/index.ts";
import {
	type ActiveClaimState,
	type ClaimRightEvaluation,
	type ClaimTiming,
	type FreeClaimState,
	type PendingClaimState,
	parseClaimState,
} from "../claims/rights/index.ts";
import {
	type ClaimReadResult,
	type ClaimSnapshot,
	type ClaimStorageDescriptor,
	type ClaimStorageOptions,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
	type ClaimDocument as StoredClaimDocument,
} from "../claims/storage/index.ts";
// Scaffold: `emergency-release` in ClaimCommand/ClaimMutationCommand, `expectRoot` on
// ClaimMutationInput (the field COMMAND_FIELDS["emergency-release"] names), the three codes and the third parameter
// `{administrative: true}` of runClaimRetry.
import {
	CLAIM_ERROR_CODES,
	type ClaimDocument,
	type ClaimErrorCode,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	claimExitCode,
	claimOperationDocument,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
// Scaffold: the action literal in the request union and ACTION_KEYS, the exact request
// `{action: "emergency-release", expectedRoot}` and the plan cause `stale-root`.
import {
	CLAIM_TRANSITION_ACTIONS,
	type ClaimTransitionPlan,
	type ClaimTransitionRequest,
	type PlanClaimTransitionOptions,
	parseClaimTransitionRequest,
	planClaimTransition,
} from "../claims/transition/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";

type Body = Record<string, unknown>;
type Sentinel = readonly [label: string, value: string];
type ContextHandle = { context: ClaimContext; directory: string };
type Planned = Extract<ClaimTransitionPlan, { kind: "planned" }>;
type NotPlanned = Extract<ClaimExecutionResult, { kind: "not-planned" }>;
type Evaluated = Extract<ClaimRightEvaluation, { kind: "evaluated" }>;
type Present = Extract<ClaimSnapshot, { kind: "present" }>;
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type ContextSeam = typeof claimContextIO;
type JournalSeam = typeof claimJournalIO;
type SeamEntry = (...args: unknown[]) => Promise<unknown>;
/** Every option of a mutating command besides command, ticket and context; all optional. */
type Options = Omit<ClaimMutationInput, "command" | "ticket" | "context">;
/** Kind, cause, boundary and exact keys of a plan; the reason only as type, emptiness and echoed sentinels. */
type Verdict = {
	label: string;
	kind: string;
	cause: unknown;
	boundary: unknown;
	keys: string[];
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
};
type PlanRow = {
	label: string;
	catches: string;
	observed: ClaimReadResult;
	request?: ClaimTransitionRequest;
	changes?: Partial<PlanClaimTransitionOptions>;
};
type PlannedRow = PlanRow & { expected: Planned };
/** `expected` is the cause of a rejection or the kind of a failure, depending on the table. */
type VerdictRow = PlanRow & { expected: string };
type RequestRow = { label: string; catches: string; request: unknown };
type ProblemView = { key: string; problem: string };
type ConfigView = { label: string; kind: string; problems: ProblemView[]; echoed: number };
/** Either a configured block (no `problems`) or the problems it is refused with. */
type ConfigRow = { label: string; catches: string; yaml: string; problems?: ProblemView[] };
/** The whole public document with a non-empty message replaced by MESSAGE, and its exit code. */
type DocumentView = { label: string; exit: number; body: Body };
/** em-p08: plus whether any `git` subprocess started and every context journal's entries afterwards. */
type GuardView = DocumentView & { gitCalled: boolean; journals: string[][] };
type GuardRow = {
	label: string;
	catches: string;
	yaml: string;
	run: (env: ClaimSurfaceEnv) => Promise<unknown>;
	expected: Body;
	gitCalled: boolean;
};
/** em-p09: plus every seam call (context and journal IO, clock, sleep, operation ID, local tickets). */
type InputView = DocumentView & { calls: string[] };
type InputRow = { label: string; catches: string; run: (env: ClaimSurfaceEnv) => Promise<unknown>; code: string };
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };
type PreviewView = {
	label: string;
	exit: number;
	keys: string[];
	body: Body;
	/** Occurrences of the shown root in the whole JSON text. */
	roots: number;
	/** Whether the shown root occurs in the JSON text of every field but `root`. */
	rootOutside: boolean;
	echoed: string[];
};

/** Private temp contexts or a subprocess: an explicit third argument (the Testbox runs --timeout=10000). */
const LOCAL_TIMEOUT = 30_000;
/** Loopback Git cases, sized like sad-01 (claim-surface-administration.test.ts:73). */
const GIT_TIMEOUT = 60_000;
/** attempt_timeout_ms of the loopback configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
/** Appears in case roots, context parents, paths and the endpoint; no public document may contain it. */
const SENTINEL = "SENTINEL-claim-emergency-5d19";
const TICKET = "BACK-1";
const CLAIM_REF = `refs/claims/${TICKET}`;
/** Placeholder for a ticket ref the server does not have; never equals an object name. */
// adapted from claim-surface-administration.test.ts:80
const ABSENT_REF = "(no ref)";
/** acquire needs a local task file; the stub knows exactly this one, already canonical. */
const LOCAL_TICKETS: readonly string[] = [TICKET];

// Planner constants adapted from claim-transition-administration.test.ts:38-70.
const ROOT = "a1".repeat(20);
const ROOT_64 = "b2".repeat(32);
/** One character away from ROOT: a prefix or length comparison takes it for ROOT. */
const NEAR_ROOT = `${"a1".repeat(19)}a2`;
const DESCRIPTOR: ClaimStorageDescriptor = { schema: 1, format: "blob", epoch: 1 };
const KARL = `tb1-${"4b".repeat(32)}`;
const FRANZ = `tb1-${"6f".repeat(32)}`;
const SECOND = `tb1-${"7a".repeat(32)}`;
const RESUMED = `tb1-${"9d".repeat(32)}`;
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const PLAN_SENTINELS = [KARL, FRANZ, SECOND, RESUMED, OWNER, OTHER_OWNER, ROOT, ROOT_64, NEAR_ROOT];
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
/** The hull of pendingState(): max(R(source), R(target)) = the target's hard end plus grace. */
const HULL = H + DAY + GRACE;
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;
const RECEIPTS: Record<string, JsonObject> = {
	"op-first": { schema: 1, intentDigest: "c3".repeat(32), parameterDigest: "d4".repeat(32) },
};

/** Operation IDs. */
const ACQUIRE_ID = "op-5d0c6f1e-2b7a-4c3d-8e9f-0a1b2c3d4e5f";
const RELEASE_ID = "op-9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const HOLDER_RELEASE_ID = "op-c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
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
/** The three new codes, all refused/5. */
const NEW_CODES: readonly ClaimErrorCode[] = ["authority-required", "expectation-required", "isolation-unconfirmed"];

/** `ta1-` + SHA-256 over this UTF-8 domain with its trailing NUL, then the secret bytes. */
const AUTHORITY_PREFIX = "ta1-";
const AUTHORITY_DOMAIN = "backlog.md/claim-authority/v1\0";
/** The binding's derivation (context/index.ts:129-134), for the oracle check and as a wrong domain. */
const BINDING_PREFIX = "tb1-";
const BINDING_DOMAIN = "backlog.md/claim-context/v1\0";
const HEX64 = /^[0-9a-f]{64}$/;
/** PRECHECK: the exact public context and on-disk record fields (claim-context.test.ts:38-39). */
const PUBLIC_FIELDS = ["binding", "contextId", "journalDirectory", "recovery"];
const RECORD_FIELDS = ["binding", "contextId", "recovery", "schema", "secret"];

/** Relative on purpose (em-p09): a preflight fails its option check on it (config/index.ts:528) before any Git. */
const PROJECT_ROOT = `project-${SENTINEL}`;
/** Context paths of the local-check rows; never read, so a row that touches one shows up in `calls`. */
const CONTEXT_PATH = `/tmp/contexts-${SENTINEL}/context-1`;
const TARGET_PATH = `/tmp/contexts-${SENTINEL}/context-2`;
const CFG_ENDPOINT = `git://127.0.0.1:9/${SENTINEL}/claims.git`;
/** A valid ISO-8601 instant with zone, so that an instant option reaches the applicability check. */
const LATER = "2027-01-15T09:00:00Z";
const LEASE: readonly string[] = ["  lifetime_mode: lease", "  lease_ttl_ms: 300000", "  reclaim_grace_ms: 600000"];
const HARD: readonly string[] = ["  lifetime_mode: hard", "  reclaim_grace_ms: 600000"];
const NONE: readonly string[] = ["  lifetime_mode: none"];
const SURFACE: readonly string[] = [
	"  clock_uncertainty_ms: 2000",
	"  retry_pause_base_ms: 1000",
	"  retry_pause_max_ms: 5000",
];
const AUTHORITY_KEY = "claims.recovery_authorities";
/** Well-formed authority IDs that belong to no context of this file. */
const VALID_ID = `ta1-${"5c".repeat(32)}`;
const OTHER_ID = `ta1-${"e7".repeat(32)}`;
const NOBODY_ID = `ta1-${"0".repeat(64)}`;

// Level P mapping inputs (adapted from claim-surface-administration.test.ts:115-134): upstream reasons, roots,
// bindings, paths and endpoints carry sentinels.
const REASON_TEXT = `upstream ${SENTINEL} ${KARL} ${FRANZ} ${ROOT}`;
const SENSITIVE = [SENTINEL, KARL, FRANZ, ROOT, CONTEXT_PATH, CFG_ENDPOINT];
/** Fields a spread of an upstream object would leak (built field by field). */
const TAINT = { binding: KARL, targetBinding: FRANZ, contextDirectory: CONTEXT_PATH, remote: CFG_ENDPOINT, root: ROOT };

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-transition-administration.test.ts:96
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-surface-administration.test.ts:147
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

function rowLabel(row: { label: string; catches: string }): string {
	return `${row.label} (catches: ${row.catches})`;
}

/** Labels of the sentinels that occur in `text`. */
// adapted from claim-surface-administration.test.ts:171
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-surface-administration.test.ts:436
function echoes(text: string): number {
	return SENSITIVE.filter((value) => text.includes(value)).length;
}

// adapted from claim-surface-administration.test.ts:441
function tainted<V extends object>(value: V): V {
	return Object.assign({}, value, TAINT);
}

/** The document with a non-empty message replaced (the wording is not part of the contract). */
function bodyOf(document: unknown): Body {
	const body: Body = Object.fromEntries(Object.entries(document as object));
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return body;
}

// adapted from claim-administration-commands.test.ts:369 (viewOf), without keys and echoes
function documentView(label: string, document: unknown): DocumentView {
	return { label, exit: claimExitCode(document as ClaimDocument), body: bodyOf(document) };
}

function pick(document: unknown, keys: readonly string[]): Body {
	return Object.fromEntries(keys.map((key) => [key, field(document, key)]));
}

/** A claim-error document; `ticket` is the canonical ticket the mutation core echoes (surface :2192). */
// adapted from claim-administration-commands.test.ts:348
function errorBody(
	command: string,
	code: string,
	status = "refused",
	ticket: string | null = TICKET,
	operationId: string | null = null,
): Body {
	return { schemaVersion: 1, kind: "claim-error", status, command, code, message: MESSAGE, ticket, operationId };
}

/** The 32 secret bytes the module derives from: the hex text of `secret` in context.json, decoded (context :132). */
async function secretOf(directory: string): Promise<Buffer> {
	const record: unknown = JSON.parse(await readFile(join(directory, "context.json"), "utf8"));
	const secret = field(record, "secret");
	if (typeof secret !== "string" || !HEX64.test(secret)) throw new Error("fixture: unreadable context secret");
	return Buffer.from(secret, "hex");
}

/** The independent oracle: prefix + SHA-256(domain as UTF-8, then the secret bytes) as hex. */
function derived(prefix: string, domain: string, secret: Buffer): string {
	return `${prefix}${createHash("sha256").update(domain, "utf8").update(secret).digest("hex")}`;
}

/**
 * `claimContextAuthority` takes the options of `loadClaimContext` and reads the secret itself, answering
 * `{kind: "derived", authorityId}` or the context failure of `loadClaimContext` (the scaffold:
 * `{kind: "derived", authorityId: ""}`). The contract fixes only the name, the module and that the secret never leaves
 * it. A failure comes back whole, so the comparison with the expected ID names it. The one call site.
 */
async function authorityOf(directory: string): Promise<unknown> {
	const result = await claimContextAuthority({ directory });
	return result.kind === "derived" ? result.authorityId : result;
}

/**
 * The preview is the mutation input of `emergency-release` with `preview: true` (
 * `ClaimMutationInput.preview?: boolean`; the contract leaves the input form open). The one call site of every preview
 * in this file.
 */
function runPreview(input: ClaimMutationInput, env: ClaimSurfaceEnv): Promise<unknown> {
	const withPreview: ClaimMutationInput = { ...input, preview: true };
	return runClaimMutation(withPreview, env);
}

/** One `claim emergency-release` call on TICKET from `context`; `options` holds only optional fields. */
function bareInput(context: string, options: Options = {}): ClaimMutationInput {
	return { command: "emergency-release", ticket: TICKET, context, ...options };
}

/** A well-formed release against ROOT. */
function releaseInput(context: string): ClaimMutationInput {
	return bareInput(context, { expectRoot: ROOT });
}

// ---------------------------------------------------------------------------------------------------------------
// Planner harness: adapted from claim-transition-administration.test.ts:101-395 (the frozen suite exports nothing).
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-transition-administration.test.ts:101
function lease(leaseEnd = L, hardEnd: number | null = null): ClaimTiming {
	return { mode: "lease", leaseEnd, graceMs: GRACE, hardEnd };
}

// adapted from claim-transition-administration.test.ts:105
function hard(hardEnd = H): ClaimTiming {
	return { mode: "hard", hardEnd, graceMs: GRACE };
}

const TIMELESS: ClaimTiming = { mode: "none" };

// adapted from claim-transition-administration.test.ts:111
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

/** FRANZ holds; KARL, the default caller of plan(), is the operator. */
// adapted from claim-transition-administration.test.ts:124
function foreign(timing: ClaimTiming = lease(), changes: Partial<ActiveClaimState> = {}): ActiveClaimState {
	return active(timing, { binding: FRANZ, owner: OTHER_OWNER, ...changes });
}

// adapted from claim-transition-administration.test.ts:128
function tombstone(claimGeneration: number): FreeClaimState {
	return { claimState: 1, status: "free", claimGeneration };
}

/**
 * Transfer form: KARL's hard-mode source at generation 3, FRANZ's target at generation 4 with binding
 * generation 1 and a later hard end; the state carries the target's generation (rights/index.ts validPending).
 */
function pendingState(): PendingClaimState {
	const source = active(hard(H), { claimGeneration: 3 });
	const target = active(hard(H + DAY), {
		claimGeneration: 4,
		bindingGeneration: 1,
		owner: OTHER_OWNER,
		binding: FRANZ,
	});
	return { claimState: 1, status: "pending", claimGeneration: 4, source, target };
}

// adapted from claim-transition-administration.test.ts:148
function withAccessor<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { get: () => result, enumerable: true, configurable: true });
	return copy;
}

// adapted from claim-transition-administration.test.ts:155
function withHidden<V extends object>(value: V, key: string, result: unknown): V {
	const copy = { ...value };
	Object.defineProperty(copy, key, { value: result, enumerable: false, configurable: true, writable: true });
	return copy;
}

// adapted from claim-transition-administration.test.ts:161
function documentOf(payload: unknown): StoredClaimDocument {
	return {
		schema: 1,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		revision: 2,
		payload,
		receipts: structuredClone(RECEIPTS),
	} as unknown as StoredClaimDocument;
}

// adapted from claim-transition-administration.test.ts:174
function present(payload: unknown, root = ROOT): ClaimReadResult {
	return { kind: "present", ticket: TICKET, root, document: documentOf(payload) };
}

// adapted from claim-transition-administration.test.ts:178-180
const ABSENT: ClaimReadResult = { kind: "absent", ticket: TICKET };
const UNREACHABLE: ClaimReadResult = { kind: "unreachable", reason: `upstream ${OWNER} ${KARL} ${FRANZ} ${ROOT}` };
const CORRUPT_PAYLOAD: ClaimReadResult = present({ state: "claimed" });
/** claimState 2 is unsupported, never corrupt (rights/index.ts parseClaimState). */
const UNSUPPORTED_PAYLOAD: ClaimReadResult = present({ claimState: 2, status: "active" });

/** The eighth action's request, exactly `action` and `expectedRoot`. */
function emergency(expectedRoot = ROOT): ClaimTransitionRequest {
	return { action: "emergency-release", expectedRoot };
}

/** Deliberately malformed data for invalid-request rows. */
function asRequest(value: unknown): ClaimTransitionRequest {
	return value as ClaimTransitionRequest;
}

// adapted from claim-transition-administration.test.ts:255 (optionsOf) and :272 (plan); the request defaults to a
// release against ROOT, the caller is KARL
function plan(
	observed: ClaimReadResult,
	request: ClaimTransitionRequest = emergency(),
	changes: Partial<PlanClaimTransitionOptions> = {},
): ClaimTransitionPlan {
	return planClaimTransition({
		ticket: TICKET,
		descriptor: { ...DESCRIPTOR },
		observed,
		binding: KARL,
		request,
		now: T,
		clockSkewMs: EPS,
		...changes,
	});
}

/**
 * (4): the FREE tombstone with the observed generation, `expectedRoot` the observed root (transition
 * :434), the request copied. The surface never passes `expectedClaimGeneration` for this action
 * (option-not-applicable).
 */
// adapted from claim-transition-administration.test.ts:280 (plannedFor)
function releasedAt(root: string, claimGeneration: number): Planned {
	return {
		kind: "planned",
		scope: "state-plan-only",
		action: "emergency-release",
		expectedRoot: root,
		observedClaimGeneration: claimGeneration,
		request: emergency(root),
		next: tombstone(claimGeneration),
	};
}

// adapted from claim-transition-administration.test.ts:307
function verdictOf(label: string, result: ClaimTransitionPlan): Verdict {
	const view = result as { kind: string; cause?: unknown; boundary?: unknown; reason?: unknown };
	const text = typeof view.reason === "string" ? view.reason : "";
	return {
		label,
		kind: view.kind,
		cause: view.cause,
		boundary: view.boundary,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof view.reason,
		reasonEmpty: text.length === 0,
		echoed: PLAN_SENTINELS.filter((value) => text.includes(value)).length,
	};
}

/** A rejection without boundary: exactly kind, cause and reason (adapted from :323, expectRejected). */
function rejectedVerdict(label: string, cause: string): Verdict {
	return {
		label,
		kind: "rejected",
		cause,
		boundary: undefined,
		keys: ["cause", "kind", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
}

/** A failure: exactly kind and reason (adapted from :343, expectFailure). */
function failureVerdict(label: string, kind: string): Verdict {
	return {
		label,
		kind,
		cause: undefined,
		boundary: undefined,
		keys: ["kind", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
	};
}

// adapted from claim-transition-administration.test.ts:387
function parses(value: unknown): boolean {
	try {
		parseClaimTransitionRequest(value);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration harness: adapted from claim-next.test.ts:314-331 and :1032-1058.
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-next.test.ts:314
function cfgBlock(extra: readonly string[] = [], lifetime: readonly string[] = LEASE): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(CFG_ENDPOINT)}`,
		"  storage_format: blob",
		...lifetime,
		"  attempt_timeout_ms: 10000",
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		...SURFACE,
		...extra,
	].join("\n");
}

// adapted from claim-next.test.ts:1056
function authoritiesLine(value: string): string {
	return `  recovery_authorities:${value === "" ? "" : ` ${value}`}`;
}

/** The key as a YAML flow list; JSON strings are valid YAML scalars. */
function listed(ids: readonly string[]): string {
	return authoritiesLine(JSON.stringify(ids));
}

// adapted from claim-next.test.ts:1032
function configView(label: string, yaml: string): ConfigView {
	const result = resolveClaimSettings(yaml);
	const problems = result.kind === "config-invalid" ? result.problems : [];
	return {
		label,
		kind: result.kind,
		problems: problems.map(({ key, problem }) => ({ key, problem })),
		echoed: problems.filter((entry) => entry.message.includes(SENTINEL)).length,
	};
}

function configExpected(label: string, problems?: ProblemView[]): ConfigView {
	if (problems === undefined) return { label, kind: "configured", problems: [], echoed: 0 };
	return { label, kind: "config-invalid", problems, echoed: 0 };
}

function problem(key: string, code: string): ProblemView {
	return { key, problem: code };
}

// ---------------------------------------------------------------------------------------------------------------
// Local surface harness (em-p07 to em-p09): private temp contexts, no Git server.
// ---------------------------------------------------------------------------------------------------------------

/** One recorded seam entry: notes `<label> <first argument>` in `calls`, then does the real IO. */
// adapted from claim-administration-commands.test.ts:489
function recorded(calls: string[], label: string, real: unknown): SeamEntry {
	const forward = real as SeamEntry;
	return async (...args: unknown[]) => {
		calls.push(`${label} ${String(args[0])}`);
		return forward(...args);
	};
}

// adapted from claim-administration-commands.test.ts:499, without the injected lstat failure
function contextSeam(calls: string[]): ContextSeam {
	const seam = {
		open: recorded(calls, "context.open", claimContextIO.open),
		lstat: recorded(calls, "context.lstat", claimContextIO.lstat),
		mkdir: recorded(calls, "context.mkdir", claimContextIO.mkdir),
		link: recorded(calls, "context.link", claimContextIO.link),
		unlink: recorded(calls, "context.unlink", claimContextIO.unlink),
	};
	return seam as unknown as ContextSeam;
}

// adapted from claim-administration-commands.test.ts:519
function journalSeam(calls: string[]): JournalSeam {
	const seam = {
		open: recorded(calls, "journal.open", claimJournalIO.open),
		lstat: recorded(calls, "journal.lstat", claimJournalIO.lstat),
		link: recorded(calls, "journal.link", claimJournalIO.link),
		unlink: recorded(calls, "journal.unlink", claimJournalIO.unlink),
		readdir: recorded(calls, "journal.readdir", claimJournalIO.readdir),
	};
	return seam as unknown as JournalSeam;
}

/**
 * The env of the local surface calls: the fixed wall clock T, a monotonic clock that never moves, no sleep. With
 * `calls`, every seam notes its use there (context and journal IO recorded, then real); without, the IO is real.
 */
// adapted from claim-administration-commands.test.ts:535 (recordingEnv)
function surfaceEnv(projectRoot: string, claimsYaml: string, calls?: string[]): ClaimSurfaceEnv {
	const note = (entry: string) => {
		calls?.push(entry);
	};
	const seams = calls === undefined ? {} : { contextIO: contextSeam(calls), journalIO: journalSeam(calls) };
	return {
		projectRoot,
		claimsYaml,
		taskPrefix: "BACK",
		findLocalTicket: (ticket: string) => {
			note("findLocalTicket");
			const found: LocalTicket = { kind: "found", ticket };
			return Promise.resolve(found);
		},
		loadLocalTickets: () => {
			note("loadLocalTickets");
			const unavailable: LocalTickets = { kind: "unavailable" };
			return Promise.resolve(unavailable);
		},
		clock: () => {
			note("clock");
			return T;
		},
		monotonicNow: () => MONO_START,
		random: () => 0.5,
		sleep: () => {
			note("sleep");
			return Promise.resolve();
		},
		newOperationId: () => {
			note("newOperationId");
			return RELEASE_ID;
		},
		...seams,
	};
}

/** Whether a Bun.spawn call starts `git` (array form, or the options form with `cmd`). */
function isGitCall(args: readonly unknown[]): boolean {
	const first = args[0];
	const command = Array.isArray(first) ? first : field(first, "cmd");
	return Array.isArray(command) && command[0] === "git";
}

/**
 * Counts the `git` subprocesses `run` starts. Every Git call of the claims code goes through Bun.spawn: the
 * repository check (git/operations.ts:1266) and the storage runner (storage/index.ts:226). The spy forwards.
 */
async function countingGit<V>(run: () => Promise<V>): Promise<{ result: V; gitCalls: number }> {
	const spy = spyOn(Bun, "spawn");
	try {
		const result = await run();
		const gitCalls = spy.mock.calls.filter((call) => isGitCall(call as unknown[])).length;
		return { result, gitCalls };
	} finally {
		spy.mockRestore();
	}
}

async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 });
	await chmod(path, 0o700);
}

async function journalNames(handle: ContextHandle): Promise<string[]> {
	return (await readdir(handle.context.journalDirectory)).sort(byCodeUnits);
}

/** A private case root with a 0700 context parent; no Git repository, no server. */
// adapted from claim-surface-administration.test.ts:213-262 (SurfaceCase) without the Git repositories
class LocalCase {
	readonly root: string;
	readonly parent: string;

	private constructor(root: string) {
		this.root = root;
		this.parent = join(root, `contexts-${SENTINEL}`);
	}

	static async create(caseName: string): Promise<LocalCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-emergency-${caseName}-${SENTINEL}-`));
		try {
			const local = new LocalCase(root);
			await privateDirectory(local.parent);
			return local;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	/** An absolute project root that does not exist: its repository check fails (git/operations.ts:1264-1277). */
	missingProject(): string {
		return join(this.root, `no-project-${SENTINEL}`);
	}

	// adapted from claim-surface-administration.test.ts:258, with --recover-from
	async context(recoverFrom?: ContextHandle): Promise<ContextHandle> {
		const source = recoverFrom === undefined ? {} : { recoverFrom: recoverFrom.directory };
		const created = await createClaimContext({ parent: this.parent, ...source });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** A byte-equal copy of `handle`'s context under another private parent: same secret, same ID, another path. */
	async copy(handle: ContextHandle): Promise<string> {
		const parent = join(this.root, `copy-${SENTINEL}`);
		const directory = join(parent, handle.context.contextId);
		await privateDirectory(parent);
		await privateDirectory(directory);
		await privateDirectory(join(directory, "journal"));
		const record = join(directory, "context.json");
		await writeFile(record, await readFile(join(handle.directory, "context.json")), { mode: 0o600 });
		await chmod(record, 0o600);
		return directory;
	}

	/** em-p08: one surface call against the missing project root, with the Git count and every journal after it. */
	async guarded(
		label: string,
		claimsYaml: string,
		run: (env: ClaimSurfaceEnv) => Promise<unknown>,
		handles: readonly ContextHandle[],
	): Promise<GuardView> {
		const env = surfaceEnv(this.missingProject(), claimsYaml);
		const { result, gitCalls } = await countingGit(() => run(env));
		const journals: string[][] = [];
		for (const handle of handles) journals.push(await journalNames(handle));
		return { ...documentView(label, result), gitCalled: gitCalls > 0, journals };
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-surface-administration.test.ts:395
async function withLocal(caseName: string, body: (local: LocalCase) => Promise<void>): Promise<void> {
	const local = await LocalCase.create(caseName);
	let failure: unknown;
	try {
		await body(local);
	} catch (error) {
		failure = error;
	}
	await local.dispose();
	if (failure !== undefined) throw failure;
}

/** em-p09: one local-check call with every seam recorded, against the relative project root. */
async function inputView(label: string, run: (env: ClaimSurfaceEnv) => Promise<unknown>): Promise<InputView> {
	const calls: string[] = [];
	const document = await run(surfaceEnv(PROJECT_ROOT, cfgBlock(), calls));
	return { ...documentView(label, document), calls };
}

function inputExpected(label: string, body: Body): InputView {
	return { label, exit: EXPECTED_EXIT[String(body.status)] ?? -1, body, calls: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping harness (em-p11): adapted from claim-surface-administration.test.ts:446-510.
// ---------------------------------------------------------------------------------------------------------------

// adapted from claim-surface-administration.test.ts:446
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
// adapted from claim-surface-administration.test.ts:465
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

/** A plan rejection with `cause` as the executor reports it (not-planned), tainted like an upstream object. */
// adapted from claim-surface-administration.test.ts:505
function notPlanned(cause: string, rights: ClaimRightEvaluation): ClaimExecutionResult {
	const rejection = { kind: "rejected" as const, cause, reason: REASON_TEXT } as NotPlanned["plan"];
	const result: NotPlanned = { kind: "not-planned", plan: tainted(rejection), rights: tainted(rights) };
	return tainted(result);
}

/** A fixed message is non-empty and names no path, no binding and no sentinel. */
// adapted from claim-administration-commands.test.ts:393
function messageFlaws(document: ClaimDocument): string[] {
	const message = field(document, "message");
	if (typeof message !== "string" || message.trim() === "") return ["empty"];
	const flaws: string[] = [];
	if (message.includes("/")) flaws.push("path separator");
	if (message.includes("tb1-") || message.includes(AUTHORITY_PREFIX)) flaws.push("binding or authority prefix");
	if (echoes(message) > 0) flaws.push("sentinel");
	return flaws;
}

// ---------------------------------------------------------------------------------------------------------------
// Loopback Git harness (em-p10, em-p12): adapted from claim-surface-administration.test.ts:163-403, blob only.
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: GitFixtureServer | undefined;

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-surface-administration.test.ts:176
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/** Local lookup of acquire, stubbed: LOCAL_TICKETS exist as task files, nothing else does. */
// adapted from claim-surface-administration.test.ts:185
function findLocalTicket(input: string): Promise<LocalTicket> {
	const found: LocalTicket = LOCAL_TICKETS.includes(input) ? { kind: "found", ticket: input } : { kind: "missing" };
	return Promise.resolve(found);
}

/** The mandatory corpus seam; LOCAL_TICKETS are open tasks without dependencies. */
// adapted from claim-surface-administration.test.ts:196
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
// adapted from claim-surface-administration.test.ts:213 (SurfaceCase)
class GitCase {
	readonly root: string;
	readonly url: string;
	/** ClaimSurfaceEnv.projectRoot: the client repository of every surface call. */
	readonly project: string;
	/** The initializer's client repository; the test's own store reads run there, never in the project. */
	readonly reader: string;
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

	// adapted from claim-surface-administration.test.ts:234
	static async create(caseName: string): Promise<GitCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-emergency-${caseName}-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `emergency-${caseName}`);
			const project = await initClient(join(root, "project"));
			const reader = await initClient(join(root, "client-initializer"));
			const gitCase = new GitCase(root, server().url(name), repo, project, reader);
			await privateDirectory(gitCase.parent);
			const initialized = await initializeClaimStorage(gitCase.storage());
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			return gitCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-surface-administration.test.ts:253
	storage(): ClaimStorageOptions {
		return { repository: this.reader, remote: this.url, format: "blob", timeoutMs: ADAPTER_TIMEOUT };
	}

	// adapted from claim-surface-administration.test.ts:258
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** All keys explicit; `authorities` become `claims.recovery_authorities` when there is at least one. */
	// adapted from claim-surface-administration.test.ts:266
	claimsYaml(authorities: readonly string[]): string {
		const recovery = authorities.length === 0 ? [] : [listed(authorities)];
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
			...recovery,
		].join("\n");
	}

	/** The fixed wall clock T, a monotonic clock that never moves, no sleep and exactly the scripted operation IDs. */
	// adapted from claim-surface-administration.test.ts:286
	env(ids: readonly string[], authorities: readonly string[] = []): ClaimSurfaceEnv {
		const issued = { count: 0 };
		return {
			projectRoot: this.project,
			claimsYaml: this.claimsYaml(authorities),
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

	// adapted from claim-surface-administration.test.ts:316
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	async ticketRoot(): Promise<string> {
		return (await this.serverRefs())[CLAIM_REF] ?? ABSENT_REF;
	}

	// adapted from claim-surface-administration.test.ts:327
	async observe(): Promise<{ descriptor: ClaimStorageDescriptor; snapshot: Present }> {
		const opened = await openClaimStore(this.storage());
		if (opened.kind !== "open") throw new Error(`fixture: claim store cannot be opened (${opened.kind})`);
		const snapshot = await opened.store.read(TICKET);
		if (snapshot.kind !== "present") throw new Error(`fixture: expected a stored claim, got ${snapshot.kind}`);
		return { descriptor: opened.descriptor, snapshot };
	}

	/** Publishes `intent` through the journal API, as an earlier call of this context would have; returns the kind. */
	// adapted from claim-surface-administration.test.ts:337
	async prepare(handle: ContextHandle, intent: ClaimOperationIntent): Promise<string> {
		const opened = await openClaimIntentJournal({ directory: handle.context.journalDirectory });
		if (opened.kind !== "open") return `journal ${opened.kind}`;
		return (await opened.journal.prepare(intent)).kind;
	}

	// adapted from claim-surface-administration.test.ts:344
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

	/**
	 * Values no preview may contain: paths, the endpoint, bindings, secrets, authority IDs,
	 * journal digests, receipts and their operation IDs, every server OID but `shown` and every `earlier` root.
	 */
	// adapted from claim-surface-administration.test.ts:357
	async sentinels(
		handles: readonly ContextHandle[],
		authorities: readonly string[],
		shown: string,
		earlier: readonly string[],
	): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["endpoint", this.url],
		];
		for (const [ref, oid] of Object.entries(await this.serverRefs())) {
			if (oid !== shown) found.push([`object of ${ref}`, oid]);
		}
		for (const oid of earlier) {
			if (oid !== shown) found.push(["earlier root", oid]);
		}
		for (const id of authorities) found.push(["authority ID", id]);
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
		const { snapshot } = await this.observe();
		for (const [id, receipt] of Object.entries(snapshot.document.receipts)) {
			found.push(["receipt operation ID", id]);
			found.push(["receipt intent digest", String(field(receipt, "intentDigest"))]);
			found.push(["receipt parameter digest", String(field(receipt, "parameterDigest"))]);
		}
		return found;
	}

	// adapted from claim-surface-administration.test.ts:388
	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

// adapted from claim-surface-administration.test.ts:395
async function withGitCase(caseName: string, body: (fixture: GitCase) => Promise<void>): Promise<void> {
	const fixture = await GitCase.create(caseName);
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

function statusOf(document: unknown): Body {
	return pick(document, ["kind", "status"]);
}

/** em-p12: the whole preview, its keys, where the shown root occurs and which sentinels it echoes. */
function previewView(label: string, document: unknown, sentinels: readonly Sentinel[], root: string): PreviewView {
	const text = JSON.stringify(document);
	const rest = Object.fromEntries(Object.entries(document as object).filter(([key]) => key !== "root"));
	return {
		label,
		exit: claimExitCode(document as ClaimDocument),
		keys: Object.keys(document as object).sort(byCodeUnits),
		body: bodyOf(document),
		roots: text.split(root).length - 1,
		rootOutside: JSON.stringify(rest).includes(root),
		echoed: echoedIn(text, sentinels),
	};
}

/**
 * `claim-emergency-preview {ticket, state, owner | transition, claimGeneration, epoch, root}` in the
 * envelope `{schemaVersion: 1, kind, status, command}`, with status `ok` for every state
 * and command `emergency-release` (`ClaimEmergencyPreviewDocument`).
 */
function previewExpected(label: string, fields: Body): PreviewView {
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-emergency-preview",
		status: "ok",
		command: "emergency-release",
		ticket: TICKET,
		...fields,
	};
	return { label, exit: 0, keys: Object.keys(body).sort(byCodeUnits), body, roots: 1, rootOutside: false, echoed: [] };
}

// ===============================================================================================================

describe("emergency release in the pure planner", () => {
	test("em-p01: the request is exactly {action, expectedRoot} with a 40 or 64 hex root, else invalid", () => {
		// Positive control (catches: the exact request refused, altered or left unplanned; the scaffold's fixed rejection).
		expect({ parsed: parseClaimTransitionRequest(emergency()), result: plan(present(foreign())) }).toStrictEqual({
			parsed: emergency(),
			result: releasedAt(ROOT, 3),
		});
		const request = emergency(ROOT_64);
		// catches: the parser handing the caller's object through instead of a fresh copy (transition :199)
		expect(parseClaimTransitionRequest(request) === request).toBe(false);
		// The invalid path the planner takes today for a foreign request field (transition :398-403 with INVALID :104):
		// a release carrying a binding. Characterization, green on the scaffold.
		const foreignField = plan(present(foreign()), asRequest({ action: "release", binding: FRANZ }));
		expect(verdictOf("a release carrying a binding", foreignField)).toStrictEqual(
			failureVerdict("a release carrying a binding", "invalid"),
		);
		const rows: RequestRow[] = [
			{
				label: "an owner beside the root",
				catches: "an acquire field accepted (exact fields)",
				request: { ...emergency(), owner: OWNER },
			},
			{
				label: "a binding beside the root",
				catches: "a request carrying a binding (no request carries one)",
				request: { ...emergency(), binding: FRANZ },
			},
			{
				label: "a generation beside the root",
				catches: "the generation expectation smuggled into the request",
				request: { ...emergency(), expectedClaimGeneration: 3 },
			},
			{
				label: "no root",
				catches: "a release without the exact root, i.e. a self-set force flag",
				request: { action: "emergency-release" },
			},
			{ label: "39 hex digits", catches: "any length accepted", request: emergency("a".repeat(39)) },
			{ label: "41 hex digits", catches: "only a minimum length", request: emergency("a".repeat(41)) },
			{
				label: "63 hex digits",
				catches: "a range from 40 to 64 instead of the two lengths",
				request: emergency("b".repeat(63)),
			},
			{ label: "65 hex digits", catches: "only a maximum length", request: emergency("b".repeat(65)) },
			{
				label: "a non-hex digit",
				catches: "the length checked, the alphabet not",
				request: emergency(`${"a1".repeat(19)}g1`),
			},
			{
				label: "upper-case hex",
				catches: "the one lower-case OID rule of the code base bent (rights/index.ts:302-307)",
				request: emergency(ROOT.toUpperCase()),
			},
			{
				label: "an empty root",
				catches: "an empty string read as an expectation that matches absent",
				request: emergency(""),
			},
			{
				label: "a number",
				catches: "a non-string root coerced",
				request: { action: "emergency-release", expectedRoot: 40 },
			},
			{
				label: "a list of roots",
				catches: "several acceptable roots",
				request: { action: "emergency-release", expectedRoot: [ROOT] },
			},
			{
				label: "the root as accessor",
				catches: "an accessor read instead of a data property (dataObject)",
				request: withAccessor(emergency(), "expectedRoot", ROOT),
			},
			{
				label: "the root not enumerable",
				catches: "a hidden property read",
				request: withHidden(emergency(), "expectedRoot", ROOT),
			},
			{
				label: "Emergency-Release",
				catches: "a case-insensitive action",
				request: { action: "Emergency-Release", expectedRoot: ROOT },
			},
			{
				label: "emergency_release",
				catches: "a normalized action name",
				request: { action: "emergency_release", expectedRoot: ROOT },
			},
		];
		// catches: each row's label; every malformed request takes the one invalid path and never parses
		expect(
			rows.map((row) => ({
				label: rowLabel(row),
				parses: parses(row.request),
				result: plan(present(foreign()), asRequest(row.request)),
			})),
		).toStrictEqual(rows.map((row) => ({ label: rowLabel(row), parses: false, result: foreignField })));
	});

	test("em-p02: ACTIVE plans the FREE tombstone with its own generation, for any holder, mode and time", () => {
		// Positive control (catches: not-holder for a foreign holder; the generation raised (a reassignment) or reset).
		expect(plan(present(foreign()))).toStrictEqual(releasedAt(ROOT, 3));
		const rows: PlannedRow[] = [
			{
				label: "the holder itself",
				catches: "`held`, or a rule that only another binding may release",
				observed: present(active()),
				expected: releasedAt(ROOT, 3),
			},
			{
				label: "a third binding",
				catches: "a binding check of any kind (the contract allows none)",
				observed: present(foreign()),
				changes: { binding: SECOND },
				expected: releasedAt(ROOT, 3),
			},
			{
				label: "timeless at generation 7 under a 64-hex root",
				catches: "`never` from the timeless mode, the core case; the generation reset or raised",
				observed: present(foreign(TIMELESS, { claimGeneration: 7 }), ROOT_64),
				request: emergency(ROOT_64),
				expected: releasedAt(ROOT_64, 7),
			},
			{
				label: "hard, a day past its end",
				catches: "a time verdict (hard-expired) or the reclaim boundary",
				observed: present(foreign(hard())),
				changes: { now: H + DAY },
				expected: releasedAt(ROOT, 3),
			},
			{
				label: "a lease before its reclaim boundary",
				catches: "the reclaim rule (`not-yet`) instead of the emergency rule",
				observed: present(foreign(lease(L, H))),
				expected: releasedAt(ROOT, 3),
			},
			{
				label: "the time path switched on",
				catches: "a mode check through the time-path option",
				observed: present(foreign(hard())),
				changes: { timePath: true },
				expected: releasedAt(ROOT, 3),
			},
			{
				label: "binding generation 5",
				catches: "the binding generation taken for the claim generation",
				observed: present(foreign(lease(), { bindingGeneration: 5 })),
				expected: releasedAt(ROOT, 3),
			},
		];
		// catches: each row's label; the whole plan is compared, so a raised or reset generation shows in `next`
		expect(
			rows.map((row) => ({ label: rowLabel(row), result: plan(row.observed, row.request, row.changes) })),
		).toStrictEqual(rows.map((row) => ({ label: rowLabel(row), result: row.expected })));
		// catches: a tombstone over a state nobody can read (state-corrupt and state-unsupported stay;
		// the repair is) or over an unread observation
		const failures: VerdictRow[] = [
			{
				label: "a corrupt payload at the expected root",
				catches: "the FREE tombstone written over a corrupt state",
				observed: CORRUPT_PAYLOAD,
				expected: "corrupt",
			},
			{
				label: "an unsupported claim state",
				catches: "an unsupported state read as releasable",
				observed: UNSUPPORTED_PAYLOAD,
				expected: "unsupported",
			},
			{
				label: "an unreachable read",
				catches: "an unread ticket read as releasable",
				observed: UNREACHABLE,
				expected: "unknown",
			},
		];
		expect(failures.map((row) => verdictOf(rowLabel(row), plan(row.observed, row.request, row.changes)))).toStrictEqual(
			failures.map((row) => failureVerdict(rowLabel(row), row.expected)),
		);
	});

	test("em-p03: PENDING plans the FREE tombstone with the target's generation, never pending-transition", () => {
		// Positive control (catches: 's pending-transition kept for this action; the source's generation 3).
		expect(plan(present(pendingState()))).toStrictEqual(releasedAt(ROOT, 4));
		const rows: PlannedRow[] = [
			{
				label: "called from the target's binding",
				catches: "the target treated as holder (`held`)",
				observed: present(pendingState()),
				changes: { binding: FRANZ },
				expected: releasedAt(ROOT, 4),
			},
			{
				label: "called from a third binding",
				catches: "a binding check on PENDING",
				observed: present(pendingState()),
				changes: { binding: SECOND },
				expected: releasedAt(ROOT, 4),
			},
			{
				label: "past the hull",
				catches: "a time dependence: the hull decides only reclaim",
				observed: present(pendingState()),
				changes: { now: HULL + MINUTE },
				expected: releasedAt(ROOT, 4),
			},
			{
				label: "under a 64-hex root",
				catches: "the planned expectedRoot not the observed root",
				observed: present(pendingState(), ROOT_64),
				request: emergency(ROOT_64),
				expected: releasedAt(ROOT_64, 4),
			},
		];
		// catches: each row's label; generation 4 is the target's, 3 would be the source's
		expect(
			rows.map((row) => ({ label: rowLabel(row), result: plan(row.observed, row.request, row.changes) })),
		).toStrictEqual(rows.map((row) => ({ label: rowLabel(row), result: row.expected })));
	});

	test("em-p04: stale-root comes before absent, free and PENDING; a matching root reaches the state rules", () => {
		// Positive control (catches: no root comparison before the state rules, which answers `free` for a stale root; or
		// a comparison that refuses a matching root too). Two rows, so no single fixed rejection of the scaffold passes.
		expect([
			verdictOf("FREE under another root", plan(present(tombstone(3), ROOT_64), emergency(ROOT))),
			verdictOf("FREE under the expected root", plan(present(tombstone(3)), emergency(ROOT))),
		]).toStrictEqual([
			rejectedVerdict("FREE under another root", "stale-root"),
			rejectedVerdict("FREE under the expected root", "free"),
		]);
		const rows: VerdictRow[] = [
			{
				label: "ACTIVE under another root",
				catches: "a release planned against a root the operator never saw",
				observed: present(foreign(), ROOT_64),
				expected: "stale-root",
			},
			{
				label: "ACTIVE one character away",
				catches: "a prefix or length comparison of the roots",
				observed: present(foreign()),
				request: emergency(NEAR_ROOT),
				expected: "stale-root",
			},
			{
				label: "ACTIVE, the caller holds it",
				catches: "the holder exempted from the root check",
				observed: present(active(), ROOT_64),
				expected: "stale-root",
			},
			{
				label: "PENDING under another root",
				catches: "pending-transition or a plan before the root check",
				observed: present(pendingState(), ROOT_64),
				expected: "stale-root",
			},
			{
				label: "PENDING under another root past the hull",
				catches: "the root check skipped once reclaim would be eligible",
				observed: present(pendingState(), ROOT_64),
				changes: { now: HULL + MINUTE },
				expected: "stale-root",
			},
			{
				label: "absent, a 40-hex expectation",
				catches: "`absent` before the root check (stale-root also for absent)",
				observed: ABSENT,
				expected: "stale-root",
			},
			{
				label: "absent, a 64-hex expectation",
				catches: "the root check tied to one OID length",
				observed: ABSENT,
				request: emergency(ROOT_64),
				expected: "stale-root",
			},
			{
				label: "FREE under the expected 64-hex root",
				catches: "`free` lost for a matching 64-hex root",
				observed: present(tombstone(5), ROOT_64),
				request: emergency(ROOT_64),
				expected: "free",
			},
		];
		// catches in every row: a boundary on these causes, or a reason echoing a root, a binding or an owner name
		expect(rows.map((row) => verdictOf(rowLabel(row), plan(row.observed, row.request, row.changes)))).toStrictEqual(
			rows.map((row) => rejectedVerdict(rowLabel(row), row.expected)),
		);
		// [?] "absent under a matching root" (em-p04) cannot be built: an absent read has observedRoot null
		// (rights/index.ts:290-300) and a valid request always carries an OID.
	});

	test("em-p05: the eighth action is in the one action list and takes neither a target nor a recovery binding", () => {
		// Positive control (catches: a role binding required for this action; the scaffold's fixed rejection).
		expect(plan(present(foreign()))).toStrictEqual(releasedAt(ROOT, 3));
		// catches: the action missing from the list every consumer derives from (transition :37-47); the exact
		// eight-entry pin act-01 is the author's, so only the membership is checked here.
		expect((CLAIM_TRANSITION_ACTIONS as readonly string[]).includes("emergency-release")).toBe(true);
		const roles: { label: string; catches: string; changes: Partial<PlanClaimTransitionOptions> }[] = [
			{
				label: "a target binding",
				catches: "the transfer role accepted (validRoles, transition :269-278)",
				changes: { targetBinding: FRANZ },
			},
			{ label: "a recovery binding", catches: "the resume role accepted", changes: { recoveryBinding: RESUMED } },
			{
				label: "both roles",
				catches: "only one role checked",
				changes: { targetBinding: FRANZ, recoveryBinding: RESUMED },
			},
			{
				label: "the caller as target",
				catches: "a role equal to the caller ignored",
				changes: { targetBinding: KARL },
			},
			{
				label: "the caller as recovery proof",
				catches: "a proof equal to the caller ignored",
				changes: { recoveryBinding: KARL },
			},
		];
		const observations: [string, ClaimReadResult][] = [
			["plannable", present(foreign())],
			["unreachable", UNREACHABLE],
			["corrupt", CORRUPT_PAYLOAD],
		];
		// catches: the roles checked after the observation (invalid only on a plannable read)
		const cases = roles.flatMap((row) =>
			observations.map(([where, observed]) => ({ label: `${rowLabel(row)} on the ${where} read`, observed, row })),
		);
		expect(
			cases.map((entry) => verdictOf(entry.label, plan(entry.observed, emergency(), entry.row.changes))),
		).toStrictEqual(cases.map((entry) => failureVerdict(entry.label, "invalid")));
	});
});

describe("the key claims.recovery_authorities", () => {
	test("em-p06: the key is optional, a list of ta1 IDs when named and last in schema order", () => {
		// Positive control (catches: the key reported as unknown-key, or accepted without validation by a stub).
		expect(configView("one ID, not a list", cfgBlock([authoritiesLine(VALID_ID)]))).toEqual(
			configExpected("one ID, not a list", [problem(AUTHORITY_KEY, "wrong-type")]),
		);
		const rows: ConfigRow[] = [
			{ label: "no key", catches: "the key made required", yaml: cfgBlock() },
			{ label: "one ID", catches: "the key reported as unknown-key", yaml: cfgBlock([listed([VALID_ID])]) },
			{ label: "two IDs", catches: "a single-entry rule", yaml: cfgBlock([listed([VALID_ID, OTHER_ID])]) },
			{
				label: "block style",
				catches: "only flow lists read; list lines counted as keys",
				yaml: cfgBlock([authoritiesLine(""), `    - ${VALID_ID}`]),
			},
			{
				label: "in lifetime mode none",
				catches: "the key made mode-dependent (not-applicable)",
				yaml: cfgBlock([listed([VALID_ID])], NONE),
			},
			{
				label: "in lifetime mode hard",
				catches: "the key tied to the lease mode",
				yaml: cfgBlock([listed([VALID_ID])], HARD),
			},
			{
				label: "a number",
				catches: "a scalar coerced into a list",
				yaml: cfgBlock([authoritiesLine("5")]),
				problems: [problem(AUTHORITY_KEY, "wrong-type")],
			},
			{
				label: "a boolean",
				catches: "true read as everyone",
				yaml: cfgBlock([authoritiesLine("true")]),
				problems: [problem(AUTHORITY_KEY, "wrong-type")],
			},
			{
				label: "a mapping",
				catches: "a mapping read as the list of its keys",
				yaml: cfgBlock([authoritiesLine(`{${JSON.stringify(VALID_ID)}: 1}`)]),
				problems: [problem(AUTHORITY_KEY, "wrong-type")],
			},
			{
				label: "a binding as entry",
				catches: "a binding accepted as authority (never a binding; a binding list is rejected)",
				yaml: cfgBlock([listed([`tb1-${"5c".repeat(32)}`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "63 hex digits",
				catches: "any digest length",
				yaml: cfgBlock([listed([`ta1-${"5".repeat(63)}`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "65 hex digits",
				catches: "only a minimum length",
				yaml: cfgBlock([listed([`ta1-${"5".repeat(65)}`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "a non-hex digit",
				catches: "the alphabet unchecked",
				yaml: cfgBlock([listed([`ta1-${"5c".repeat(31)}5g`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "upper-case hex",
				catches: "the lower-case digest form of the binding rule not mirrored (rights/index.ts:140-143)",
				yaml: cfgBlock([listed([`ta1-${"5C".repeat(32)}`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "no prefix",
				catches: "a bare digest accepted",
				yaml: cfgBlock([listed(["5c".repeat(32)])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "a number entry",
				catches: "a non-string entry coerced to text or skipped (an entry not of the form)",
				yaml: cfgBlock([authoritiesLine("[5]")]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "a valid and a malformed entry",
				catches: "only the first entry checked; one problem per entry instead of per key",
				yaml: cfgBlock([listed([VALID_ID, `ta1-${SENTINEL}`, `ta1-${SENTINEL}-2`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "a sentinel entry",
				catches: "the value repeated in the problem message",
				yaml: cfgBlock([listed([`ta1-${SENTINEL}`])]),
				problems: [problem(AUTHORITY_KEY, "unsupported-value")],
			},
			{
				label: "named twice",
				catches: "the key outside the resolver's duplicate detector",
				yaml: cfgBlock([listed([VALID_ID]), listed([OTHER_ID])]),
				problems: [problem(AUTHORITY_KEY, "duplicate")],
			},
			{
				// config/index.ts:341-442 per key in SCHEMA_KEYS order, :444-455 the cross-key rule, :457-461 unknown keys in
				// document order. The key comes first in the document, so document order cannot produce the expected order.
				label: "problem order",
				catches: "the key inserted elsewhere in SCHEMA_KEYS, checked after the cross-key rule or in document order",
				yaml: [
					"claims:",
					authoritiesLine("5"),
					"  acquire_dependency_check: true",
					"  acquire_dependency_policy: lenient",
					"  transfer_time_box: keep",
					"  enabled: true",
					`  endpoint: ${JSON.stringify(CFG_ENDPOINT)}`,
					"  storage_format: blob",
					...LEASE,
					"  attempt_timeout_ms: 10000",
					"  attempts: 3",
					"  operation_budget_ms: 30000",
					"  clock_uncertainty_ms: 2000",
					"  retry_pause_base_ms: 3000",
					"  retry_pause_max_ms: 2000",
				].join("\n"),
				problems: [
					problem("claims.transfer_time_box", "unsupported-value"),
					problem("claims.acquire_dependency_policy", "unsupported-value"),
					problem(AUTHORITY_KEY, "wrong-type"),
					problem("claims.retry_pause_max_ms", "out-of-range"),
					problem("claims.acquire_dependency_check", "unknown-key"),
				],
			},
		];
		// catches: each row's label; `echoed` counts problem messages that repeat the sentinel
		expect(rows.map((row) => configView(rowLabel(row), row.yaml))).toEqual(
			rows.map((row) => configExpected(rowLabel(row), row.problems)),
		);
	});
});

describe("authority, authorisation and inputs over private contexts", () => {
	test(
		"em-p07: the authority ID is ta1- plus SHA-256 over its own domain and the secret bytes, never the binding",
		async () => {
			await withLocal("em-p07", async (local) => {
				const operator = await local.context();
				const other = await local.context();
				const recovered = await local.context(operator);
				const secret = await secretOf(operator.directory);
				const expected = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, secret);
				const recordBefore = await readFile(join(operator.directory, "context.json"), "utf8");
				// Setup (catches: an oracle that reads the secret bytes differently from the module): the same bytes under
				// the binding domain give the module's binding (context/index.ts:129-134).
				expect(derived(BINDING_PREFIX, BINDING_DOMAIN, secret)).toBe(operator.context.binding);

				// Positive control (catches: the scaffold's ""; another hash, domain or prefix).
				const actual = await authorityOf(operator.directory);
				expect(actual).toBe(expected);
				const copy = await local.copy(operator);
				expect({
					again: await authorityOf(operator.directory),
					copy: await authorityOf(copy),
					recovered: await authorityOf(recovered.directory),
					other: await authorityOf(other.directory),
				}).toEqual({
					// catches: a random salt or a clock in the derivation
					again: expected,
					// catches: the path or the directory identity in the derivation: the same secret bytes give the same ID
					copy: expected,
					// catches: the recovery proof's secret (the source's) used instead of the context's own
					recovered: derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(recovered.directory)),
					// catches: one ID for every context
					other: derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(other.directory)),
				});
				// catches: the ID being the binding, the binding re-prefixed (its domain), a domain without its NUL, or the
				// secret's hex text hashed instead of its bytes
				const hexText = createHash("sha256")
					.update(AUTHORITY_DOMAIN, "utf8")
					.update(secret.toString("hex"), "utf8")
					.digest("hex");
				expect({
					binding: actual === operator.context.binding,
					bindingDomain: actual === derived(AUTHORITY_PREFIX, BINDING_DOMAIN, secret),
					withoutNul: actual === derived(AUTHORITY_PREFIX, "backlog.md/claim-authority/v1", secret),
					hexText: actual === `${AUTHORITY_PREFIX}${hexText}`,
				}).toEqual({ binding: false, bindingDomain: false, withoutNul: false, hexText: false });

				// Guard (catches: the ID stored in or exposed through the context; claim-context.test.ts:38-39
				// pins both field sets exactly): the loaded context and context.json keep their fields and bytes.
				const loaded = await loadClaimContext({ directory: operator.directory });
				const recordAfter = await readFile(join(operator.directory, "context.json"), "utf8");
				expect({
					publicKeys: loaded.kind === "loaded" ? Object.keys(loaded.context).sort(byCodeUnits) : loaded.kind,
					recordKeys: Object.keys(JSON.parse(recordAfter) as object).sort(byCodeUnits),
					unchanged: recordAfter === recordBefore,
				}).toEqual({ publicKeys: PUBLIC_FIELDS, recordKeys: RECORD_FIELDS, unchanged: true });
			});
		},
		LOCAL_TIMEOUT,
	);

	test(
		"em-p08: a missing key, an unlisted ID or a foreign list ends authority-required before any Git call and record",
		async () => {
			await withLocal("em-p08", async (local) => {
				const operator = await local.context();
				const other = await local.context();
				const recovered = await local.context(operator);
				const handles = [operator, other, recovered];
				const operatorSecret = await secretOf(operator.directory);
				const own = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, operatorSecret);
				const foreignId = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(other.directory));
				const bindingShaped = derived(AUTHORITY_PREFIX, BINDING_DOMAIN, operatorSecret);
				const releaseOf = (handle: ContextHandle) => (env: ClaimSurfaceEnv) =>
					runClaimMutation(releaseInput(handle.directory), env);
				const previewOf = (handle: ContextHandle) => (env: ClaimSurfaceEnv) =>
					runPreview(bareInput(handle.directory), env);
				const refused = errorBody("emergency-release", "authority-required");
				const reached = errorBody("emergency-release", "preflight-invalid");
				const expectedOf = (label: string, body: Body, gitCalled: boolean): GuardView => ({
					label,
					exit: EXPECTED_EXIT[String(body.status)] ?? -1,
					body,
					gitCalled,
					journals: handles.map(() => []),
				});

				// Positive control (catches: a release without a listed authority sent or prepared; the check after the
				// preflight, whose repository check is the first Git command (config/index.ts:561); a record written first).
				const missing = await local.guarded("key missing, release", cfgBlock(), releaseOf(operator), handles);
				expect(missing).toEqual(expectedOf("key missing, release", refused, false));

				const rows: GuardRow[] = [
					{
						label: "key missing, preview",
						catches: "the preview exempted from the authorisation",
						yaml: cfgBlock(),
						run: previewOf(operator),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "an ID nobody has",
						catches: "a non-empty list taken as permission",
						yaml: cfgBlock([listed([NOBODY_ID])]),
						run: releaseOf(operator),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "a foreign list",
						catches: "any listed context authorised, or the list compared with another context's ID",
						yaml: cfgBlock([listed([foreignId])]),
						run: releaseOf(operator),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "a foreign list, preview",
						catches: "the preview compared with a weaker rule",
						yaml: cfgBlock([listed([foreignId])]),
						run: previewOf(operator),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "the recovery source listed",
						catches: "the ID taken from the recovery proof: a context made with --recover-from inherits the right",
						yaml: cfgBlock([listed([own])]),
						run: releaseOf(recovered),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "the binding-domain hash listed",
						catches: "the ID computed with the binding's domain, i.e. the binding re-prefixed",
						yaml: cfgBlock([listed([bindingShaped])]),
						run: releaseOf(operator),
						expected: refused,
						gitCalled: false,
					},
					{
						label: "listed, release",
						catches: "a Git counter that could never move; every ID refused (the call reaches the preflight)",
						yaml: cfgBlock([listed([own])]),
						run: releaseOf(operator),
						expected: reached,
						gitCalled: true,
					},
					{
						label: "listed, preview",
						catches: "the preview refused for a listed ID",
						yaml: cfgBlock([listed([own])]),
						run: previewOf(operator),
						expected: reached,
						gitCalled: true,
					},
					{
						label: "listed second",
						catches: "only the first entry compared",
						yaml: cfgBlock([listed([foreignId, own])]),
						run: releaseOf(operator),
						expected: reached,
						gitCalled: true,
					},
				];
				const views: GuardView[] = [];
				for (const row of rows) views.push(await local.guarded(rowLabel(row), row.yaml, row.run, handles));
				// catches in every row: a record or an admission slot in any journal (no record)
				expect(views).toEqual(rows.map((row) => expectedOf(rowLabel(row), row.expected, row.gitCalled)));
			});
		},
		LOCAL_TIMEOUT,
	);

	test(
		"em-p09: expectation-required, invalid-option and option-not-applicable end before any IO",
		async () => {
			// Positive control (catches: a release without --expect-root sent, previewed or refused only after IO).
			expect(await inputView("no root, no preview", (env) => runClaimMutation(bareInput(CONTEXT_PATH), env))).toEqual(
				inputExpected("no root, no preview", errorBody("emergency-release", "expectation-required")),
			);
			const release = (options: Options) => (env: ClaimSurfaceEnv) =>
				runClaimMutation(bareInput(CONTEXT_PATH, options), env);
			const preview = (options: Options) => (env: ClaimSurfaceEnv) => runPreview(bareInput(CONTEXT_PATH, options), env);
			const rows: InputRow[] = [
				{
					label: "a preview with a root",
					catches: "--preview and --expect-root together accepted",
					run: preview({ expectRoot: ROOT }),
					code: "expectation-required",
				},
				{
					label: "39 hex digits",
					catches: "any length",
					run: release({ expectRoot: "a".repeat(39) }),
					code: "invalid-option",
				},
				{
					label: "41 hex digits",
					catches: "only a minimum length",
					run: release({ expectRoot: "a".repeat(41) }),
					code: "invalid-option",
				},
				{
					label: "63 hex digits",
					catches: "a range 40 to 64",
					run: release({ expectRoot: "b".repeat(63) }),
					code: "invalid-option",
				},
				{
					label: "65 hex digits",
					catches: "only a maximum length",
					run: release({ expectRoot: "b".repeat(65) }),
					code: "invalid-option",
				},
				{
					label: "a non-hex digit",
					catches: "the alphabet unchecked",
					run: release({ expectRoot: `${"a1".repeat(19)}g1` }),
					code: "invalid-option",
				},
				{
					label: "not an OID at all",
					catches: "the value handed to the planner, which refuses it later as request-invalid",
					run: release({ expectRoot: `root-${SENTINEL}` }),
					code: "invalid-option",
				},
				{
					label: "--owner",
					catches: "a display name read as a reassignment",
					run: release({ expectRoot: ROOT, owner: OWNER }),
					code: "option-not-applicable",
				},
				{
					label: "--ttl-ms",
					catches: "a base field silently ignored",
					run: release({ expectRoot: ROOT, ttlMs: TTL }),
					code: "option-not-applicable",
				},
				{
					label: "--expect-generation",
					catches: "the generation offered beside the root (not an OptionField today, surface :1840)",
					run: release({ expectRoot: ROOT, expectGeneration: 3 }),
					code: "option-not-applicable",
				},
				{
					label: "--hard-end",
					catches: "a lifetime option accepted",
					run: release({ expectRoot: ROOT, hardEnd: LATER }),
					code: "option-not-applicable",
				},
				{
					label: "--to-context",
					catches: "a transfer target accepted",
					run: release({ expectRoot: ROOT, toContext: TARGET_PATH }),
					code: "option-not-applicable",
				},
				{
					label: "--time-box",
					catches: "a transfer field accepted",
					run: release({ expectRoot: ROOT, timeBox: "preserve" }),
					code: "option-not-applicable",
				},
				{
					label: "--mode",
					catches: "a bound field accepted",
					run: release({ expectRoot: ROOT, mode: "none" }),
					code: "option-not-applicable",
				},
				{
					label: "--lease-end",
					catches: "a bound field accepted",
					run: release({ expectRoot: ROOT, leaseEnd: LATER }),
					code: "option-not-applicable",
				},
				{
					label: "--grace-ms",
					catches: "a bound field accepted",
					run: release({ expectRoot: ROOT, graceMs: 0 }),
					code: "option-not-applicable",
				},
				{
					label: "a preview with --owner",
					catches: "the preview exempted from the applicability check",
					run: preview({ owner: OWNER }),
					code: "option-not-applicable",
				},
				{
					label: "a preview with --expect-generation",
					catches: "the generation accepted as the preview's expectation",
					run: preview({ expectGeneration: 3 }),
					code: "option-not-applicable",
				},
				{
					label: "a preview with --operation-id",
					catches: "an operation ID the preview ignores silently (surface :2319 checks only its form)",
					run: preview({ operationId: RELEASE_ID }),
					code: "option-not-applicable",
				},
			];
			const views: InputView[] = [];
			for (const row of rows) views.push(await inputView(rowLabel(row), row.run));
			// catches in every row: a context load, a journal access, a clock read or an operation ID before the check
			expect(views).toEqual(rows.map((row) => inputExpected(rowLabel(row), errorBody("emergency-release", row.code))));

			// catches: every emergency-release input refused; only 40-hex roots accepted: well-formed inputs of a listed
			// operator pass every local check and the authorisation and end at the preflight option check (config :528).
			await withLocal("em-p09", async (local) => {
				const operator = await local.context();
				const own = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(operator.directory));
				const env = surfaceEnv(PROJECT_ROOT, cfgBlock([listed([own])]));
				const reached = [
					documentView("a 40-hex root", await runClaimMutation(releaseInput(operator.directory), env)),
					documentView(
						"a 64-hex root with an operation ID",
						await runClaimMutation(
							bareInput(operator.directory, { expectRoot: ROOT_64, operationId: RELEASE_ID }),
							env,
						),
					),
					documentView("a preview", await runPreview(bareInput(operator.directory), env)),
				];
				const labels = ["a 40-hex root", "a 64-hex root with an operation ID", "a preview"];
				expect(reached).toEqual(
					labels.map((label) => ({ label, exit: 5, body: errorBody("emergency-release", "preflight-invalid") })),
				);
			});
		},
		LOCAL_TIMEOUT,
	);
});

describe("codes and the plan cause in the surface tables", () => {
	test("em-p11: three refused codes with fixed messages; stale-root is rejected/2 at stage plan, no record", () => {
		// Positive control (catches: the scaffold's empty MESSAGES text; a message naming a path, a prefix or a value).
		expect(
			NEW_CODES.map((code) => ({
				code,
				flaws: messageFlaws(claimErrorDocument({ command: "emergency-release", code, ticket: TICKET })),
			})),
		).toEqual(NEW_CODES.map((code) => ({ code, flaws: [] })));
		// catches: a code missing from CLAIM_ERROR_CODES or mapped to another status or exit than refused/5
		expect(
			NEW_CODES.map((code) => ({
				code,
				status: CLAIM_ERROR_CODES[code],
				exit: claimExitCode(claimErrorDocument({ command: "emergency-release", code })),
			})),
		).toEqual(NEW_CODES.map((code) => ({ code, status: "refused", exit: 5 })));
		// catches: stale-root missing from PLAN_CAUSES (surface :1264-1281), which maps the rejection to internal
		// (:1636-1637); an operation ID, a storage fact or a boundary on a plan rejection; a leaked root
		const rights = evaluated("foreign", { kind: "none", cause: "not-holder" }, { kind: "never" });
		const mapped = claimOperationDocument({
			command: "emergency-release",
			ticket: TICKET,
			result: notPlanned("stale-root", rights),
			planned: null,
			stoppedBy: null,
		});
		expect({ exit: claimExitCode(mapped), body: bodyOf(mapped), echoed: echoes(JSON.stringify(mapped)) }).toEqual({
			exit: 2,
			body: {
				schemaVersion: 1,
				kind: "claim-operation",
				status: "rejected",
				command: "emergency-release",
				action: "emergency-release",
				ticket: TICKET,
				operationId: null,
				outcome: "rejected",
				rejection: { stage: "plan", cause: "stale-root" },
				storage: null,
				sends: 0,
				stoppedBy: null,
				planned: null,
				rights: publicRights(rights),
			},
			echoed: 0,
		});
	});
});

describe("retry lock and preview over real Git (blob)", () => {
	beforeAll(async () => {
		fixtureServer = await GitFixtureServer.create();
	});

	afterAll(async () => {
		await fixtureServer?.close();
	});

	test(
		"em-p10: a release record resends only with {administrative: true}; without it authority-required, nothing sent",
		async () => {
			await withGitCase("em-p10", async (c) => {
				const karl = await c.context();
				const operator = await c.context();
				const listedIds = [derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(operator.directory))];
				// Setup (catches: a fixture without a stored claim): KARL acquires TICKET through the surface core.
				const acquired = await runClaimMutation(acquireInput(karl), c.env([ACQUIRE_ID]));
				expect(statusOf(acquired)).toEqual({ kind: "claim-operation", status: "applied" });
				const { descriptor, snapshot } = await c.observe();

				// Setup: the scaffold's planner rejects the action, so the operator's release record is built by hand in the
				// shape the release prescribes: the FREE tombstone with the observed generation at the observed root.
				const request: ClaimTransitionRequest = { action: "emergency-release", expectedRoot: snapshot.root };
				const releasePlan: Planned = {
					kind: "planned",
					scope: "state-plan-only",
					action: "emergency-release",
					expectedRoot: snapshot.root,
					observedClaimGeneration: 1,
					request,
					next: tombstone(1),
				};
				const mapped = claimOperationIntentOf({
					operationId: RELEASE_ID,
					remote: c.url,
					descriptor,
					ticket: TICKET,
					plan: releasePlan,
				});
				const prepared = mapped.kind === "intent" ? await c.prepare(operator, mapped.intent) : "not mapped";
				// catches: a record the journal refuses, which would turn the RED below into a fixture failure
				expect({ mapped: mapped.kind, prepared }).toEqual({ mapped: "intent", prepared: "prepared" });
				const record = { operationId: RELEASE_ID, context: operator.directory };
				const refs = await c.serverRefs();
				const recordOnly: JournalView = { records: [`${RELEASE_ID}.json`], slots: 0, other: [] };

				// Positive control (catches: a release record resent with two arguments, the way claim_retry calls over MCP;
				// a lock that only checks the list, which names the operator here; a slot admitted before the lock).
				const locked = await runClaimRetry(record, c.env([], listedIds));
				expect({
					exit: claimExitCode(locked),
					body: bodyOf(locked),
					refs: await c.serverRefs(),
					journal: await c.journalView(operator),
				}).toEqual({
					exit: 5,
					body: errorBody("retry", "authority-required", "refused", TICKET, RELEASE_ID),
					refs,
					journal: recordOnly,
				});

				// catches: the lock turning away `claim resolve`, a read; the record is still open
				const resolved = await runClaimResolve(record, c.env([], listedIds));
				expect(
					pick(resolved, ["kind", "status", "command", "operationId", "ticket", "action", "outcome", "query"]),
				).toEqual({
					kind: "claim-resolution",
					status: "unknown",
					command: "resolve",
					operationId: RELEASE_ID,
					ticket: TICKET,
					action: "emergency-release",
					outcome: "unknown",
					query: { kind: "resolved", resolution: "open" },
				});

				// catches: a lock that blocks every retry of the record, the flag ignored
				const resent = await runClaimRetry(record, c.env([], listedIds), { administrative: true });
				const after = await c.observe();
				expect({
					document: pick(resent, [
						"kind",
						"status",
						"command",
						"action",
						"ticket",
						"operationId",
						"outcome",
						"storage",
						"sends",
					]),
					state: parseClaimState(after.snapshot.document.payload),
					moved: after.snapshot.root !== snapshot.root,
					journal: await c.journalView(operator),
				}).toEqual({
					document: {
						kind: "claim-operation",
						status: "applied",
						command: "retry",
						action: "emergency-release",
						ticket: TICKET,
						operationId: RELEASE_ID,
						outcome: "applied",
						storage: { kind: "applied" },
						sends: 1,
					},
					state: { kind: "state", state: tombstone(1) },
					moved: true,
					journal: { ...recordOnly, slots: 1 },
				});
			});
		},
		GIT_TIMEOUT,
	);

	test(
		"em-p12: the preview has exactly its keys, shows the root only in `root` and writes nothing",
		async () => {
			await withGitCase("em-p12", async (c) => {
				const karl = await c.context();
				const operator = await c.context();
				const operatorId = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(operator.directory));
				const karlId = derived(AUTHORITY_PREFIX, AUTHORITY_DOMAIN, await secretOf(karl.directory));
				const authorities = [operatorId, karlId];
				// Setup (catches: a fixture without an ACTIVE claim to preview).
				const acquired = await runClaimMutation(acquireInput(karl), c.env([ACQUIRE_ID]));
				expect(statusOf(acquired)).toEqual({ kind: "claim-operation", status: "applied" });
				const activeRoot = await c.ticketRoot();
				const refs = await c.serverRefs();
				const journals = { karl: await c.journalView(karl), operator: await c.journalView(operator) };

				const activePreview = await runPreview(bareInput(operator.directory), c.env([], [operatorId]));
				const activeSentinels = await c.sentinels([karl, operator], authorities, activeRoot, []);
				// Positive control (catches: no preview document (the scaffold); a spread of the stored claim, its rights view
				// or its receipts; the root missing, abbreviated or repeated in another field).
				expect(previewView("ACTIVE", activePreview, activeSentinels, activeRoot)).toEqual(
					previewExpected("ACTIVE", { state: "active", owner: OWNER, claimGeneration: 1, epoch: 1, root: activeRoot }),
				);
				// catches: a preview that sends, records, admits or pauses (it sends and writes nothing)
				expect({
					refs: await c.serverRefs(),
					karl: await c.journalView(karl),
					operator: await c.journalView(operator),
				}).toEqual({ refs, ...journals });

				// FREE: KARL releases regularly; the preview then names no owner and shows the new root, never the earlier.
				const released = await runClaimMutation(
					{ command: "release", ticket: TICKET, context: karl.directory },
					c.env([HOLDER_RELEASE_ID]),
				);
				expect(statusOf(released)).toEqual({ kind: "claim-operation", status: "applied" });
				const freeRoot = await c.ticketRoot();
				const freePreview = await runPreview(bareInput(operator.directory), c.env([], [operatorId]));
				const freeSentinels = await c.sentinels([karl, operator], authorities, freeRoot, [activeRoot]);
				// catches: an owner kept in the FREE preview; the earlier root shown; a generation raised by the preview
				expect(previewView("FREE", freePreview, freeSentinels, freeRoot)).toEqual(
					previewExpected("FREE", { state: "free", claimGeneration: 1, epoch: 1, root: freeRoot }),
				);
			});
		},
		GIT_TIMEOUT,
	);
});
