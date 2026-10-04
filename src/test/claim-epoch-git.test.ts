/**
 * Level G of the epoch swap: `backlog claim install-epoch` through the surface core with the environment of
 * `claimProjectEnv(projectRoot, command, seams)` as claim-emergency-git.test.ts builds it, against the loopback Git
 * daemon of claim-git-fixture.ts, beside `runClaimMutation`, `runClaimRetry`, `runClaimResolve`, `runClaimList`,
 * `runClaimInit` and, for clients that opened the store before the maintenance, the storage boundary itself. Every case
 * runs on blob, tree and commit-chain (the formats diverge), 11 cases, 33 runs. One project per run holds three
 * contexts: the holder of the claims, the operator whose authority ID (recomputed here, never read from the product)
 * is listed in `claims.recovery_authorities`, and another context. The local task corpus is BACK-1 to BACK-3; BACK-7
 * and BACK-8 are no local tasks. A test-local S1 pre-receive script counts pushes, declines one on request, records its
 * exit code and serves the gate directory protocol of `ReceiveGates` (claim-git-fixture.ts:347-390) with a 15 s hold
 * bound instead of the helper's 5 s. An old client's write is made by the product against a twin repository of the
 * server, which reveals its root, and then pushed to the server in the product's own form, held by `ReceiveGates` at
 * that root (ep-g03 to ep-g05). S2 is the trace2 record of this process's Git commands, the observable of "no Git
 * call". Every run opens with a positive control that the typed scaffold (a command with no maintenance behind it)
 * fails behaviourally: a document, a counter or a ref state differs, never a type. The names and shapes the contract
 * leaves to the scaffold are used in exactly one helper each at the top of the file, marked ASSUMPTION(scaffold); open
 * observations are marked [?]. claim-git-fixture.ts and every existing test file stay unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import {
	type ClaimStorageFormat,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import {
	CLAIM_EXIT_CODES,
	type ClaimCommand,
	type ClaimDocument,
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimErrorDocument,
	runClaimInit,
	runClaimInstallEpoch,
	runClaimList,
	runClaimMutation,
	runClaimResolve,
	runClaimRetry,
} from "../claims/surface/index.ts";
import { Core } from "../core/backlog.ts";
import { type ClaimEnvSeams, claimProjectEnv, isClaimDocument } from "../core/claim-env.ts";
import type { Task } from "../types/index.ts";
import { compareTaskIds } from "../utils/task-sorting.ts";
import { finish, GitFixtureServer, type LiveCommand, ReceiveGates } from "./fixtures/claim-git-fixture.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type Body = Record<string, unknown>;
type ContextHandle = { context: ClaimContext; directory: string };
/** The holder of the claims, the operator listed in `claims.recovery_authorities`, and one more context. */
type Parties = { holder: ContextHandle; operator: ContextHandle; other: ContextHandle };
type HookAction = "pass" | "reject";
type Mode = "none" | "hard";
/** The claims block keys a case varies; everything else is fixed in claimsBlock. `null` omits the list key. */
type BlockOptions = { mode: Mode; format: ClaimStorageFormat; authorities: readonly string[] | null };
type OperationInput = { operationId: string; context: string };
type Tracked<V> = { promise: Promise<V>; settled: () => boolean };
/** Server refs and the pre-receive count: what a refusal or an aborted run may not move. */
type Snapshot = { refs: Record<string, string>; pushes: number };
/** A claim read through a fresh reader store; receipts as [id, receipt] pairs, a maintenance ID by its shape. */
type StoredView = { revision: number | null; epoch: unknown; format: unknown; payload: unknown; receipts: unknown[] };
/** The top layer of a root: its object type, the receipt names it carries itself (by shape) and its parents. */
type LayerView = { type: string; receipts: string[]; parents: string[] };
/** An old client's write on its way in: the ticket's ref, the root it pushes and the held push. */
type LateWrite = { ref: string; root: string; push: LiveCommand };
/** How a late push ended by its porcelain row, and the exit code S1 recorded for its pre-receive. */
type LateOutcome = { push: Body; hookRc: unknown };
type InstallOptions = {
	expectEpoch: number;
	confirmed?: boolean;
	storageFormat?: ClaimStorageFormat;
	tickets?: string[];
	seams?: EpochSeams;
};
/** One refusal row of ep-g07: the flag, the list in the block and the code the contract names for it. */
type RefusalRow = { label: string; catches: string; confirmed: boolean; authorities: readonly string[]; code: string };
type OperationFields = {
	status: string;
	command: string;
	ticket: string;
	operationId: string | null;
	outcome: string;
	storage?: Body;
	sends: number;
	planned?: Body;
	rights: Body;
};

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
/**
 * ep-g09: the target of a migration from each format. The contract names blob → commit-chain; the rotation makes every
 * format a source and a target exactly once, so each decoder reads a store another encoder left behind.
 */
const MIGRATION_TARGET: Record<ClaimStorageFormat, ClaimStorageFormat> = {
	blob: "commit-chain",
	tree: "blob",
	"commit-chain": "tree",
};
/** The object a ticket ref names in each format (storage/index.ts:543-548, :559-622). */
const OBJECT_TYPE: Record<ClaimStorageFormat, string> = { blob: "blob", tree: "tree", "commit-chain": "commit" };
/** Runs of up to about fifteen surface calls and two maintenance runs (claim-emergency-git.test.ts:102-103). */
const TEST_TIMEOUT = 60_000;
/** Cases with a held receive or three to five maintenance runs (claim-emergency-git.test.ts:104-105). */
const LONG_TEST_TIMEOUT = 90_000;
/** attempt_timeout_ms of the block, far below the 10 s start value so that a hang shows (claim-emergency-git:107). */
const ADAPTER_TIMEOUT = 3_000;
/** Bound for waiting on hook entries, seams and settling calls (claim-emergency-git.test.ts:110-111). */
const EVENT_TIMEOUT = 10_000;
/** Bound for a whole maintenance run started in the background (ep-g08). */
const RUN_TIMEOUT = 30_000;
/** A gate hold ends by itself after HOLD_POLLS polls of 50 ms and then declines (claim-emergency-git.test.ts:113). */
const HOLD_POLLS = 300;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
/** The local task corpus, from which the creation set M takes every ID without a ref. */
const TICKET = "BACK-1";
const SECOND_TICKET = "BACK-2";
const THIRD_TICKET = "BACK-3";
const TASK_IDS: readonly string[] = [TICKET, SECOND_TICKET, THIRD_TICKET];
/** ep-g05: no local task and never named by `--ticket`, so no run of this file creates its ref. */
const FOREIGN_TICKET = "BACK-7";
/** ep-g05: no local task, named by `--ticket` in the rerun. */
const NAMED_TICKET = "BACK-8";
/** ep-g12: names under refs/claims/* that are no canonical ticket ID; the lister counts them as skipped. */
const STANDING_REF = "refs/claims/back-2";
const LATE_REF = "refs/claims/back-1";
/** `attempts` of the block (claim-emergency-git.test.ts:124-125). */
const ATTEMPTS = 3;
/** Placeholder for a key a document does not have; no document value ever equals it. */
const ABSENT = "(absent)";
/** Placeholder for a ref the server does not have. */
const ABSENT_REF = "(no ref)";
/**
 * [?] A push against a moved ref fails at the server's ref update ("remote") or at the client's lease check ("stale");
 * both are the lease, never pinned alone under concurrency (claim-time-path-git.test.ts:110-114).
 */
const LEASE_CAUSE = "stale-or-remote";
/** Display names: the holder, the other context, and the target of ep-g01's restart. */
const OWNER = "agent-sentinel-karl";
const OTHER_OWNER = "agent-sentinel-franz";
const TARGET_OWNER = "agent-sentinel-lena";
/** operation_budget_ms of the block (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; it never moves, so no budget ever runs out. */
const MONO_START = 5_000;
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock of every call unless a call scripts its reads. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const GRACE = 10 * MINUTE;
/** ep-g01: the hard end of every acquire and the restart's new hard end (claim-emergency-git.test.ts:150-153). */
const H = T + 60 * MINUTE;
const H2 = H + 60 * MINUTE;
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";
/** The authority domain, NUL-terminated like the binding's (context/index.ts:131). */
const AUTHORITY_DOMAIN = "backlog.md/claim-authority/v1\0";
/** The key of the maintenance receipt, `m-<uuid v4>`. */
const MAINTENANCE_ID = /^m-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Stands for any key of that form in a view; its value is random per run. */
const MAINTENANCE_KEY = "m-<uuid v4>";

// ---------------------------------------------------------------------------------------------------------------
// The epoch names and shapes this file depends on, each in exactly one place: a scaffold that settles an ASSUMPTION
// otherwise changes one helper here and nothing below.
// ---------------------------------------------------------------------------------------------------------------

/** The `command` of every install-epoch document, error documents included. */
const INSTALL_EPOCH: ClaimCommand = "install-epoch";

/** The raw options of `claim install-epoch` as the CLI hands them to the core. */
type EpochInput = {
	context: string;
	expectEpoch: number;
	isolationConfirmed: boolean;
	storageFormat?: string;
	tickets?: string[];
	preview?: boolean;
};

/**
 * ASSUMPTION(scaffold): the surface entry `runClaimInstallEpoch(input, env)` in src/claims/surface beside
 * `runClaimMutation`, with the input above, answering `claim-epoch`, `claim-epoch-preview` or `claim-error` in the
 * envelope `{schemaVersion: 1, kind, status, command: "install-epoch"}`. Its only call site; the cast keeps tsc
 * independent of how the scaffold types the input (for example a `ClaimStorageFormat` instead of a raw string).
 */
function installEpoch(input: EpochInput, env: ClaimSurfaceEnv): Promise<unknown> {
	const run = runClaimInstallEpoch as unknown as (input: EpochInput, env: ClaimSurfaceEnv) => Promise<unknown>;
	return run(input, env);
}

/** A run, applied or unknown. */
type DoneExpectation = {
	status: "applied" | "unknown";
	fromEpoch: number;
	epoch: number;
	format: ClaimStorageFormat;
	previousFormat: ClaimStorageFormat;
	rewritten: readonly string[];
	created: readonly string[];
	breached?: readonly string[];
	unsettled?: readonly string[];
};
/**
 * A rejected run; `causes` lists the causes the contract allows at that point, folded into one value when several do.
 */
type EpochExpectation = { status: "rejected"; causes: readonly string[] } | DoneExpectation;

/**
 * ASSUMPTION(scaffold): `claim-epoch` is the envelope plus exactly the fields: `rewritten`,
 * `created`, `breached` and `unsettled` as ticket lists sorted like `claim list`; a rejection carries `cause` at
 * the top level (and empty lists), of which only kind, status, cause and the exit code are pinned. The rerun hint of
 * Is `epoch` itself, the value a rerun passes to `--expect-epoch`, with no field of its own. Maps a run's
 * document and its expectation onto one comparable pair, so another shape changes this helper only.
 */
function epochPair(document: unknown, expected: EpochExpectation): [Body, Body] {
	if (expected.status === "rejected") {
		const accepted = expected.causes.join(" | ");
		const cause = entryOf(document, "cause");
		const folded = typeof cause === "string" && expected.causes.includes(cause) ? accepted : cause;
		const seen = { exit: exitOf(document), kind: entryOf(document, "kind"), status: statusOf(document), cause: folded };
		const wanted = { exit: CLAIM_EXIT_CODES.rejected, kind: "claim-epoch", status: "rejected", cause: accepted };
		return [seen, wanted];
	}
	const sorted = (tickets: readonly string[] = []) => [...tickets].sort(compareTaskIds);
	const body: Body = {
		schemaVersion: 1,
		kind: "claim-epoch",
		status: expected.status,
		command: INSTALL_EPOCH,
		fromEpoch: expected.fromEpoch,
		epoch: expected.epoch,
		format: expected.format,
		previousFormat: expected.previousFormat,
		rewritten: sorted(expected.rewritten),
		created: sorted(expected.created),
		breached: sorted(expected.breached),
		unsettled: sorted(expected.unsettled),
		isolation: "attested",
	};
	return [
		{ exit: exitOf(document), document: masked(document) },
		{ exit: CLAIM_EXIT_CODES[expected.status], document: body },
	];
}

/** The two points of a run a test acts at: right after the first listing L1 and right after a won descriptor CAS. */
type EpochSeams = { afterFirstListing?: () => Promise<void>; afterDescriptorSwap?: () => Promise<void> };

/**
 * ASSUMPTION(scaffold): an optional environment seam `ClaimSurfaceEnv.installEpochSeams`, which a run awaits right
 * after L1 and right after its descriptor CAS (step 5). A throw after the CAS is
 * caught by the run, which answers claim-epoch unknown/3 with epoch N+1; a throw after L1 ends in claim-error internal.
 * Either way the throw stands for a crash at that point. Chosen over a child probe with file gates
 * (fixtures/claim-time-path-probe.ts). Its only call site.
 */
function withEpochSeams(env: ClaimSurfaceEnv, seams: EpochSeams): ClaimSurfaceEnv {
	return { ...env, installEpochSeams: seams } as ClaimSurfaceEnv;
}

/** A `claim-list` entry this file expects: a readable FREE claim with its epoch, or an unknown one. */
type ExpectedEntry = { state: "free"; claimGeneration: number; epoch: number } | { state: "unknown" };

/**
 * ASSUMPTION(scaffold): the optional `epoch` on `claim-list` entries goes
 * with `claimGeneration`: an entry read from a stored document carries the epoch of the store it was read from, an
 * `unknown` entry and the free entry of a ticket without a ref none. Every list entry this file expects is built here.
 */
function listEntry(ticket: string, expected: ExpectedEntry): Body {
	if (expected.state === "unknown") return { ticket, state: "unknown" };
	return { ticket, state: "free", claimGeneration: expected.claimGeneration, epoch: expected.epoch };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------------------------------------------

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

// adapted from claim-emergency-git.test.ts:225-228
function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

// adapted from claim-emergency-git.test.ts:231-234
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-emergency-git.test.ts:237-239
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// adapted from claim-emergency-git.test.ts:242-244
function refOf(ticket: string): string {
	return `refs/claims/${ticket}`;
}

/** `--hard-end` rule: ISO-8601 with a zone (claim-emergency-git.test.ts:257-259). */
function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// adapted from claim-emergency-git.test.ts:262-265
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

/** The value under `key`, or ABSENT when there is no such own key (claim-emergency-git.test.ts:268-271). */
function entryOf(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return ABSENT;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-emergency-git.test.ts:274-276
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" ? Object.keys(value).sort(byCodeUnits) : [];
}

// adapted from claim-emergency-git.test.ts:279-281
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh plain JSON copy, so null-prototype receipt maps compare like plain objects. */
function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** Shape `op-<uuid v4>`: the n-th operation ID the seam hands out (claim-emergency-git.test.ts:289-291). */
function seamId(n: number): string {
	return `op-5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A receipt name as a view shows it: a maintenance ID by its shape, every other name as it is. */
function idShape(id: string): string {
	return MAINTENANCE_ID.test(id) ? MAINTENANCE_KEY : id;
}

/** Receipts as [id, receipt] pairs sorted by the raw ID (storage keys). */
function receiptPairs(receipts: unknown): unknown[] {
	if (!isRecord(receipts)) return [];
	return Object.keys(receipts)
		.sort(byCodeUnits)
		.map((id) => [idShape(id), plain(receipts[id])]);
}

/** The refs under `prefix`, keyed by the rest of their name. */
function prefixed(refs: Record<string, string>, prefix: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const [ref, oid] of Object.entries(refs)) if (ref.startsWith(prefix)) found[ref.slice(prefix.length)] = oid;
	return found;
}

// adapted from claim-emergency-git.test.ts:294-301
function tracked<V>(promise: Promise<V>): Tracked<V> {
	const state = { settled: false };
	const settle = () => {
		state.settled = true;
	};
	void promise.then(settle, settle);
	return { promise, settled: () => state.settled };
}

/** Waits, bounded, until `pending` settled (claim-emergency-git.test.ts:321-328, with the bound as a parameter). */
async function settleWithin<V>(label: string, pending: Tracked<V>, timeoutMs: number): Promise<V> {
	const deadline = Date.now() + timeoutMs;
	while (!pending.settled()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
	return pending.promise;
}

/** Waits, bounded, until `condition` holds; a seam that waits here fails its run instead of hanging it. */
async function until(label: string, condition: () => boolean): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

/**
 * S2, test-local: the argv of every trace2 `start` event, i.e. of every Git process this test process started with the
 * case's trace variable (storage/index.ts:181-196 keeps it; the fixture's own Git runs without any GIT_ variable,
 * claim-git-fixture.ts:136-140).
 */
// adapted from claim-emergency-git.test.ts:337-357
async function gitStartsOf(tracePath: string): Promise<string[][]> {
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
		if (field(event, "event") === "start" && Array.isArray(argv)) commands.push(argv.map(String));
	}
	return commands;
}

/**
 * The S1 pre-receive script: numbers each invocation atomically (mkdir) and logs its stdin; then, for every command
 * whose new object ID has an armed `ReceiveGates` gate, writes `entered.json` and waits for `release` (the protocol of
 * fixtures/claim-git-primitives/helper.ts:13-38, bounded by HOLD_POLLS polls of 50 ms instead of its 5 s); declines on
 * request or after an unreleased hold, and records its exit code.
 */
// adapted from claim-emergency-git.test.ts:361-383 and fixtures/claim-git-primitives/helper.ts:13-38
function preReceiveHook(control: string, gates: string): string {
	return [
		"#!/bin/sh",
		`dir=${shellQuote(control)}`,
		`gates=${shellQuote(gates)}`,
		"n=1",
		'while ! mkdir "$dir/pre-$n" 2>/dev/null; do n=$((n + 1)); done',
		'cat > "$dir/pre-$n/stdin"',
		"action=pass",
		'if [ -f "$dir/pre-action-$n" ]; then action=$(cat "$dir/pre-action-$n")',
		'elif [ -f "$dir/pre-action-rest" ]; then action=$(cat "$dir/pre-action-rest"); fi',
		"rc=0",
		"while read -r old new ref; do",
		'\tgate="$gates/pre-$new"',
		'\t[ -f "$gate/armed" ] || continue',
		'\tprintf \'["%s %s %s"]\' "$old" "$new" "$ref" > "$gate/entered.json"',
		"\ti=0",
		`\twhile [ ! -f "$gate/release" ] && [ "$i" -lt ${HOLD_POLLS} ]; do sleep 0.05; i=$((i + 1)); done`,
		'\t[ -f "$gate/release" ] || rc=1',
		'done < "$dir/pre-$n/stdin"',
		'if [ "$action" = reject ]; then rc=1; fi',
		'echo "$rc" > "$dir/pre-$n/rc"',
		'if [ "$rc" -ne 0 ]; then echo fixture-hook-declined >&2; fi',
		'exit "$rc"',
		"",
	].join("\n");
}

/** The post-receive of every case: consumes its input and passes, so no fixture helper process starts per push. */
const POST_RECEIVE = ["#!/bin/sh", "cat > /dev/null", "exit 0", ""].join("\n");

/** S1, test-local: the scripted receive hooks of one server repository. */
// adapted from claim-emergency-git.test.ts:387-446 (pre-receive only; holds are the gates' protocol)
class ReceiveScript {
	private readonly serverRepo: string;
	private readonly control: string;
	private readonly gates: string;

	constructor(serverRepo: string, control: string, gates: string) {
		this.serverRepo = serverRepo;
		this.control = control;
		this.gates = gates;
	}

	async install(): Promise<void> {
		await mkdir(this.control, { recursive: true });
		const scripts = [
			["pre-receive", preReceiveHook(this.control, this.gates)],
			["post-receive", POST_RECEIVE],
		] as const;
		for (const [name, script] of scripts) {
			const hook = join(this.serverRepo, "hooks", name);
			await writeFile(hook, script);
			await chmod(hook, 0o755);
		}
	}

	/** Number of pre-receive invocations so far: one per push that reached the server with commands. */
	async count(): Promise<number> {
		return (await readdir(this.control)).filter((name) => /^pre-\d+$/.test(name)).length;
	}

	/** Actions for the next invocations, then `rest` for every later one. */
	async plan(actions: HookAction[], rest: HookAction): Promise<void> {
		const started = await this.count();
		for (const name of await readdir(this.control)) {
			if (/^pre-action-\d+$/.test(name)) await rm(join(this.control, name), { force: true });
		}
		for (const [index, action] of actions.entries()) {
			await writeFile(join(this.control, `pre-action-${started + index + 1}`), action);
		}
		await writeFile(join(this.control, "pre-action-rest"), rest);
	}

	/** The exit code S1 recorded for the push whose command's new value is `oid`, or ABSENT (bounded wait). */
	async rcOf(oid: string): Promise<unknown> {
		const deadline = Date.now() + EVENT_TIMEOUT;
		for (;;) {
			for (const name of (await readdir(this.control)).filter((entry) => /^pre-\d+$/.test(entry))) {
				const stdin = await readFile(join(this.control, name, "stdin"), "utf8").catch(() => "");
				if (!stdin.split("\n").some((line) => line.split(" ")[1] === oid)) continue;
				const rc = await readFile(join(this.control, name, "rc"), "utf8").catch(() => undefined);
				if (rc !== undefined) return Number(rc.trim());
			}
			if (Date.now() >= deadline) return ABSENT;
			await Bun.sleep(10);
		}
	}
}

// adapted from claim-emergency-git.test.ts:449-454
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

// adapted from claim-emergency-git.test.ts:457-468
function taskOf(id: string): Task {
	return {
		id,
		title: `Claim target ${id}`,
		status: "To Do",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-29",
		rawContent: "",
	};
}

/**
 * Configuration keys plus the three surface keys, all explicit, and the recovery authorities list as a YAML flow
 * sequence; `storage_format` is the case's (ep-g09 changes it after the migration).
 */
// adapted from claim-emergency-git.test.ts:476-495
function claimsBlock(url: string, options: BlockOptions): string {
	const lines = [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(url)}`,
		`  storage_format: ${options.format}`,
		`  lifetime_mode: ${options.mode}`,
	];
	if (options.mode === "hard") lines.push(`  reclaim_grace_ms: ${GRACE}`);
	lines.push(
		`  attempt_timeout_ms: ${ADAPTER_TIMEOUT}`,
		`  attempts: ${ATTEMPTS}`,
		`  operation_budget_ms: ${BUDGET_MS}`,
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	);
	if (options.authorities !== null) lines.push(`  recovery_authorities: ${JSON.stringify(options.authorities)}`);
	return lines.join("\n");
}

/** A Backlog project with task prefix BACK, the TASK_IDS files, the claims block and one committed repository. */
// adapted from claim-emergency-git.test.ts:499-511
async function initProject(directory: string, block: string): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim epoch");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	await core.filesystem.saveConfig({ ...config, prefixes: { ...config.prefixes, task: "BACK" }, claimsYaml: block });
	for (const id of TASK_IDS) await core.filesystem.saveTask(taskOf(id));
	await new Core(directory).ensureConfigMigrated();
	await server().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(directory, ["add", "-A"]);
	await server().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/**
 * Recomputed without `claimContextAuthority`: `ta1-` and the lowercase hex SHA-256 over the domain and the
 * secret bytes (claim-emergency-git.test.ts:205-208; context/index.ts:129-134).
 */
function authorityIdOf(secretHex: string): string {
	const digest = createHash("sha256").update(AUTHORITY_DOMAIN, "utf8").update(Buffer.from(secretHex, "hex"));
	return `ta1-${digest.digest("hex")}`;
}

/**
 * The porcelain row of `ref` read as storage/index.ts:634-646 reads it; `stale` and `remote` fold into LEASE_CAUSE, the
 * S1 exit code tells a declining hook from a refused ref update.
 */
function pushOutcome(out: string, ref: string): Body {
	const row = out
		.split("\n")
		.map((line) => line.split("\t"))
		.find((fields) => fields.length >= 2 && fields[1]?.endsWith(`:${ref}`));
	const status = row?.[0];
	const summary = row?.slice(2).join("\t") ?? "";
	if (status === "*" || status === "+" || status === " ") return { kind: "applied" };
	if (status === "!" && (summary.includes("stale info") || summary.includes("remote rejected"))) {
		return { kind: "rejected", cause: LEASE_CAUSE };
	}
	return { kind: "unknown", status: status ?? ABSENT };
}

/** The labels of every sentinel some document echoes (CLI allowlist). */
function leaks(documents: readonly unknown[], sentinels: readonly (readonly [string, string])[]): string[] {
	const text = JSON.stringify(documents);
	return sentinels.filter(([, value]) => value !== "" && text.includes(value)).map(([label]) => label);
}

/**
 * One run of a case on one format: a server repository with the S1 script and `ReceiveGates`, a Backlog project that
 * is also the surface's repository, contexts below a private 0700 parent, the S2 trace of this process's Git commands,
 * and on demand a reader client, clients opened before a maintenance and twins for late writes.
 */
// adapted from claim-emergency-git.test.ts:520-909 (EmergencyCase, without probes and MCP)
class EpochCase {
	readonly hooks: ReceiveScript;
	readonly gates: ReceiveGates;
	readonly parent: string;
	private readonly tracePath: string;
	private readonly pendings: Tracked<unknown>[] = [];
	private readonly lates: LiveCommand[] = [];
	private options: BlockOptions;
	private readerClient: string | undefined;
	private previousTrace: string | undefined;
	private tracing = false;
	private issued = 0;

	private constructor(
		readonly format: ClaimStorageFormat,
		readonly root: string,
		readonly url: string,
		readonly serverRepo: string,
		readonly project: string,
		label: string,
		options: BlockOptions,
	) {
		this.options = options;
		this.hooks = new ReceiveScript(serverRepo, join(root, "receive"), join(root, "gates"));
		// The same root the fixture gave the server repository (claim-git-fixture.ts:211-224): `<root>/gates`.
		this.gates = new ReceiveGates(root, label);
		this.parent = join(root, "contexts");
		this.tracePath = resolve(root, "trace2-events.json");
	}

	// adapted from claim-emergency-git.test.ts:550-578
	static async create(format: ClaimStorageFormat, caseId: string, block: Partial<BlockOptions>): Promise<EpochCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-epoch-git-${format}-`));
		try {
			const label = `${caseId}-${format}`;
			const repository = await server().initRepository(root, label);
			const url = server().url(repository.name);
			// The list is written by `parties` once the operator's context exists.
			const options: BlockOptions = { mode: "none", format, authorities: null, ...block };
			const project = join(root, "project");
			await initProject(project, claimsBlock(url, options));
			const created = new EpochCase(format, root, url, repository.repo, project, label, options);
			await created.hooks.install();
			await mkdir(created.parent);
			await chmod(created.parent, 0o700);
			const initializer = await initClient(join(root, "client-initializer"));
			const storage = { repository: initializer, remote: url, format, timeoutMs: ADAPTER_TIMEOUT };
			const initialized = await initializeClaimStorage(storage);
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			created.startTrace();
			return created;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	// adapted from claim-emergency-git.test.ts:581-585
	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** The holder, the operator and another context; the operator's authority ID becomes the only list entry. */
	async parties(): Promise<Parties> {
		const holder = await this.context();
		const operator = await this.context();
		const other = await this.context();
		await this.authorize(operator);
		return { holder, operator, other };
	}

	/** Lists exactly the authority IDs of `handles` in `claims.recovery_authorities`. */
	async authorize(...handles: ContextHandle[]): Promise<void> {
		const authorities: string[] = [];
		for (const handle of handles) authorities.push(authorityIdOf(await this.secretOf(handle)));
		await this.writeBlock({ authorities });
	}

	async authorityOf(handle: ContextHandle): Promise<string> {
		return authorityIdOf(await this.secretOf(handle));
	}

	/** The 64 hex characters of the private record's secret (claim-emergency-git.test.ts:598-603). */
	async secretOf(handle: ContextHandle): Promise<string> {
		const record: unknown = JSON.parse(await readFile(join(handle.directory, "context.json"), "utf8"));
		const secret = field(record, "secret");
		if (typeof secret !== "string") throw new Error("fixture: the private record has no string secret");
		return secret;
	}

	/** Rewrites the claims block through saveConfig; every call reads it fresh (claim-emergency-git:606-612). */
	async writeBlock(changes: Partial<BlockOptions>): Promise<void> {
		const core = new Core(this.project);
		const config = await core.filesystem.loadConfig();
		if (!config) throw new Error("fixture: the project configuration is missing");
		this.options = { ...this.options, ...changes };
		await core.filesystem.saveConfig({ ...config, claimsYaml: claimsBlock(this.url, this.options) });
	}

	/** The raw bytes of the checkout's config.yml (the tool never changes the file). */
	async configBytes(): Promise<Buffer> {
		return readFile(new Core(this.project).filesystem.configFilePath);
	}

	/** The seams of one call (claim-emergency-git.test.ts:618-630): its own clock, a steady monotonic clock, seam IDs. */
	seams(reads: readonly number[] = []): ClaimEnvSeams {
		const queue = [...reads];
		return {
			clock: () => queue.shift() ?? T,
			monotonicNow: () => MONO_START,
			random: () => 0.5,
			sleep: () => Promise.resolve(),
			newOperationId: () => {
				this.issued += 1;
				return seamId(this.issued);
			},
		};
	}

	/** The CLI side as claim.ts builds it: `claimProjectEnv`, then the core (claim-emergency-git.test.ts:633-644). */
	async call<D>(
		command: ClaimCommand,
		produce: (env: ClaimSurfaceEnv) => Promise<D>,
		reads: readonly number[] = [],
	): Promise<D | ClaimDocument> {
		try {
			const env = await claimProjectEnv(this.project, command, this.seams(reads));
			return isClaimDocument(env) ? env : await produce(env);
		} catch {
			return claimErrorDocument({ command, code: "internal" });
		}
	}

	/** acquire as claim.ts builds it; the hard mode needs `--hard-end` (claim-emergency-git.test.ts:647-651). */
	acquire(handle: ContextHandle, ticket: string, operationId: string, owner = OWNER): Promise<unknown> {
		const input: ClaimMutationInput = { command: "acquire", ticket, context: handle.directory, owner, operationId };
		if (this.options.mode === "hard") input.hardEnd = iso(H);
		return this.call("acquire", (env) => runClaimMutation(input, env));
	}

	/** The holder's own release (transition/index.ts:470). */
	release(handle: ContextHandle, ticket: string, operationId: string): Promise<unknown> {
		const input: ClaimMutationInput = { command: "release", ticket, context: handle.directory, operationId };
		return this.call("release", (env) => runClaimMutation(input, env));
	}

	/** A planned write in the timeless mode: change-bounds to the same `{mode: "none"}` (claim-emergency-git:658-662). */
	touch(handle: ContextHandle, ticket: string, operationId: string): Promise<unknown> {
		const context = handle.directory;
		const input: ClaimMutationInput = { command: "change-bounds", ticket, context, mode: "none", operationId };
		return this.call("change-bounds", (env) => runClaimMutation(input, env));
	}

	/** (ii): a transfer restart to `receiver` with the new hard end H2 (claim-emergency-git:674-692). */
	transferRestart(
		handle: ContextHandle,
		ticket: string,
		operationId: string,
		receiver: ContextHandle,
		reads: readonly number[] = [],
	): Promise<unknown> {
		const input: ClaimMutationInput = {
			command: "transfer",
			ticket,
			context: handle.directory,
			toContext: receiver.directory,
			owner: TARGET_OWNER,
			timeBox: "restart",
			hardEnd: iso(H2),
			operationId,
		};
		return this.call("transfer", (env) => runClaimMutation(input, env), reads);
	}

	/** `claim install-epoch` as claim.ts would build it: `claimProjectEnv`, the run's seams, then the core. */
	install(handle: ContextHandle, options: InstallOptions): Promise<unknown> {
		const input: EpochInput = {
			context: handle.directory,
			expectEpoch: options.expectEpoch,
			isolationConfirmed: options.confirmed ?? true,
		};
		if (options.storageFormat !== undefined) input.storageFormat = options.storageFormat;
		if (options.tickets !== undefined) input.tickets = options.tickets;
		const { seams } = options;
		return this.call(INSTALL_EPOCH, (env) => installEpoch(input, seams ? withEpochSeams(env, seams) : env));
	}

	/** commands/claim.ts:774 today: two arguments (claim-emergency-git.test.ts:711-714). */
	retry(handle: ContextHandle, operationId: string): Promise<unknown> {
		const input: OperationInput = { operationId, context: handle.directory };
		return this.call("retry", (env) => runClaimRetry(input, env));
	}

	/** commands/claim.ts:757: `{operationId, context}` (claim-emergency-git.test.ts:705-708). */
	resolve(handle: ContextHandle, operationId: string): Promise<unknown> {
		const input: OperationInput = { operationId, context: handle.directory };
		return this.call("resolve", (env) => runClaimResolve(input, env));
	}

	/** commands/claim.ts:795: every ticket, without a context (claim-emergency-git.test.ts:722-725). */
	list(): Promise<unknown> {
		return this.call("list", (env) => runClaimList({}, env));
	}

	/** `claim init` (surface/index.ts:3286-3293): `exists` with the descriptor's format and epoch. */
	init(): Promise<unknown> {
		return this.call("init", (env) => runClaimInit(env));
	}

	/** Starts `promise` without awaiting it; dispose settles it if the test does not. */
	start<V>(promise: Promise<V>): Tracked<V> {
		const pending = tracked(promise);
		this.pendings.push(pending);
		return pending;
	}

	// adapted from claim-emergency-git.test.ts:752-760
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** Ticket → root of every `refs/claims/*` ref at the server. */
	async claimRoots(): Promise<Record<string, string>> {
		return prefixed(await this.serverRefs(), "refs/claims/");
	}

	/** `<epoch>/<ticket>` → root of every `refs/claim-archive/*` ref at the server. */
	async archiveRefs(): Promise<Record<string, string>> {
		return prefixed(await this.serverRefs(), "refs/claim-archive/");
	}

	async ticketRoot(ticket: string): Promise<string> {
		return (await this.serverRefs())[refOf(ticket)] ?? ABSENT_REF;
	}

	/** The descriptor blob at the server, decoded without the product (storage/index.ts:68, :198-211). */
	async descriptor(): Promise<unknown> {
		const read = await server().git(this.serverRepo, ["cat-file", "blob", "refs/claim-meta/format"], undefined, false);
		return read.rc === 0 ? JSON.parse(read.out) : ABSENT_REF;
	}

	/** Pushes that reached the server with commands: one pre-receive invocation each. */
	pushes(): Promise<number> {
		return this.hooks.count();
	}

	async snapshot(): Promise<Snapshot> {
		return { refs: await this.serverRefs(), pushes: await this.pushes() };
	}

	/** S2: the Git processes this run's calls started so far (see `gitStartsOf`). */
	async gitCalls(): Promise<number> {
		return (await gitStartsOf(this.tracePath)).length;
	}

	/** A claim through an independent reader client whose store is opened now, so it takes the current descriptor. */
	async stored(ticket: string, format: ClaimStorageFormat = this.options.format): Promise<StoredView> {
		this.readerClient ??= await initClient(join(this.root, "client-reader"));
		const storage = { repository: this.readerClient, remote: this.url, format, timeoutMs: ADAPTER_TIMEOUT };
		const unread = { revision: null, epoch: ABSENT, format: ABSENT, receipts: [] };
		const opened = await openClaimStore(storage);
		if (opened.kind !== "open") return { ...unread, payload: `store ${opened.kind}` };
		const observed = await opened.store.read(ticket);
		if (observed.kind !== "present") return { ...unread, payload: observed.kind };
		const { document } = observed;
		return {
			revision: document.revision,
			epoch: document.epoch,
			format: document.format,
			payload: plain(document.payload),
			receipts: receiptPairs(document.receipts),
		};
	}

	/** Status and generation of the stored payloads of `tickets`, in order. */
	async shapes(tickets: readonly string[]): Promise<Body[]> {
		const shapes: Body[] = [];
		for (const ticket of tickets) {
			const { payload } = await this.stored(ticket);
			shapes.push({ status: field(payload, "status"), claimGeneration: field(payload, "claimGeneration") });
		}
		return shapes;
	}

	/** The stored payload of a ticket, for a late write that needs a valid ACTIVE state (rights/index.ts:19-27). */
	async payloadOf(ticket: string): Promise<JsonObject> {
		const { payload } = await this.stored(ticket);
		if (!isRecord(payload)) throw new Error(`fixture: ${ticket} has no stored payload`);
		return payload as JsonObject;
	}

	/** The raw receipt IDs the current document of `ticket` carries, for the sentinel scan. */
	async receiptIds(ticket: string): Promise<string[]> {
		this.readerClient ??= await initClient(join(this.root, "client-reader"));
		const storage = { repository: this.readerClient, remote: this.url, format: this.options.format };
		const opened = await openClaimStore({ ...storage, timeoutMs: ADAPTER_TIMEOUT });
		if (opened.kind !== "open") return [];
		const observed = await opened.store.read(ticket);
		return observed.kind === "present" ? Object.keys(observed.document.receipts) : [];
	}

	/**
	 * The top layer of `root` in the server repository, read as `format` (storage/index.ts:505-540, :567-622): its type,
	 * the receipts it carries itself and its parents. A root of another type shows only that type.
	 */
	// adapted from claim-emergency-git.test.ts:808-825
	async layer(root: string, format: ClaimStorageFormat): Promise<LayerView> {
		const git = (args: string[]) => server().git(this.serverRepo, args, undefined, false);
		const type = (await git(["cat-file", "-t", root])).out.trim();
		if (type !== OBJECT_TYPE[format]) return { type, receipts: [], parents: [] };
		if (format === "blob") {
			const document: unknown = JSON.parse((await git(["cat-file", "blob", root])).out);
			return { type, receipts: keysOf(field(document, "receipts")).map(idShape), parents: [] };
		}
		let tree = root;
		const parents: string[] = [];
		if (format === "commit-chain") {
			const headers = (await git(["cat-file", "commit", root])).out.split("\n\n", 1)[0] ?? "";
			for (const line of headers.split("\n")) {
				if (line.startsWith("tree ")) tree = line.slice(5);
				if (line.startsWith("parent ")) parents.push(line.slice(7));
			}
		}
		const listed = await git(["ls-tree", "--name-only", `${tree}:receipts`]);
		return { type, receipts: listed.out.split("\n").filter(Boolean).sort(byCodeUnits).map(idShape), parents };
	}

	/**
	 * Every receipt `root` carries, decoded raw from the server repository as `format`: blob and tree inline, the chain
	 * over its parents (storage/README.md:18-22). A missing object is named instead of thrown.
	 */
	async receiptsAt(root: string, format: ClaimStorageFormat): Promise<unknown> {
		const git = (args: string[]) => server().git(this.serverRepo, args, undefined, false);
		const receipts: Record<string, unknown> = {};
		let current: string | undefined = root;
		while (current !== undefined) {
			if ((await git(["cat-file", "-e", current])).rc !== 0) return `unreadable ${current}`;
			if (format === "blob") {
				const blob = await git(["cat-file", "blob", current]);
				return receiptPairs(field(JSON.parse(blob.out), "receipts"));
			}
			let tree: string = current;
			let parent: string | undefined;
			if (format === "commit-chain") {
				const headers = (await git(["cat-file", "commit", current])).out.split("\n\n", 1)[0] ?? "";
				for (const line of headers.split("\n")) {
					if (line.startsWith("tree ")) tree = line.slice(5);
					if (line.startsWith("parent ")) parent = line.slice(7);
				}
			}
			const listed = await git(["ls-tree", `${tree}:receipts`]);
			if (listed.rc !== 0) return `unreadable ${tree}`;
			for (const row of listed.out.split("\n").filter(Boolean)) {
				const [meta = "", name = ""] = row.split("\t");
				const blob = await git(["cat-file", "blob", meta.split(" ")[2] ?? ""]);
				if (blob.rc !== 0) return `unreadable receipt ${name}`;
				receipts[name] = JSON.parse(blob.out);
			}
			current = parent;
		}
		return receiptPairs(receipts);
	}

	/** A store opened now on a fresh client: an old client once a maintenance has run (storage/index.ts:784-799). */
	async openClient(label: string): Promise<ClaimStore> {
		return this.openStore(await initClient(join(this.root, `client-${label}`)), this.url);
	}

	private async openStore(repository: string, remote: string): Promise<ClaimStore> {
		const opened = await openClaimStore({ repository, remote, format: this.format, timeoutMs: ADAPTER_TIMEOUT });
		if (opened.kind !== "open") throw new Error(`fixture: store open failed (${opened.kind})`);
		return opened.store;
	}

	/**
	 * An old client's write that is on its way in when the maintenance starts: the product writes it
	 * against a twin of the server (a bare copy of every claim ref, over file://), which reveals its root without
	 * touching the server; then the client pushes that root to the server exactly as storage/index.ts:624-631 pushes,
	 * `--force-with-lease=<ref>:<root it read>` (empty for a creation), and `ReceiveGates` holds it in pre-receive. An
	 * update keeps the stored payload; a creation takes `payload`.
	 */
	async startLateWrite(ticket: string, operationId: string, payload?: JsonObject): Promise<LateWrite> {
		const twin = join(this.root, `twin-${operationId}.git`);
		await server().git(this.root, ["init", "--quiet", "--bare", twin]);
		const refspecs = ["+refs/claims/*:refs/claims/*", "+refs/claim-meta/*:refs/claim-meta/*"];
		await server().git(twin, ["fetch", "--quiet", this.url, ...refspecs]);
		const repository = await initClient(join(this.root, `client-${operationId}`));
		const store = await this.openStore(repository, pathToFileURL(twin).href);
		const base = await store.read(ticket);
		if (base.kind !== "absent" && base.kind !== "present") throw new Error(`fixture: late read failed (${base.kind})`);
		const content = payload ?? (base.kind === "present" ? base.document.payload : undefined);
		if (content === undefined) throw new Error("fixture: a late creation needs a payload");
		const change = { operationId, receipt: { schema: 1, late: operationId }, payload: content };
		const written = await store.write(base, change);
		if (written.kind !== "applied") throw new Error(`fixture: the late write missed the twin (${written.kind})`);
		const ref = refOf(ticket);
		const lease = base.kind === "present" ? base.root : "";
		await this.gates.arm("pre", written.root);
		const args = ["push", "--porcelain", `--force-with-lease=${ref}:${lease}`, this.url, `${written.root}:${ref}`];
		const push = server().startGit(repository, args);
		this.lates.push(push);
		await this.gates.entered("pre", written.root);
		return { ref, root: written.root, push };
	}

	/** Releases a late write's gate, waits for its push and reads how it ended. */
	async finishLateWrite(late: LateWrite): Promise<LateOutcome> {
		await this.gates.release("pre", late.root);
		const result = await finish(late.push, EVENT_TIMEOUT);
		return { push: pushOutcome(result.out, late.ref), hookRc: await this.hooks.rcOf(late.root) };
	}

	/** An object no ref reaches, written straight into the server repository (the control of ep-g10's gc). */
	async writeUnreachable(text: string): Promise<string> {
		return (await server().git(this.serverRepo, ["hash-object", "-w", "--stdin"], text)).out.trim();
	}

	/** A blob ref written straight into the server repository, past the receive hooks and the push count (ep-g12). */
	async writeServerRef(ref: string, text: string): Promise<string> {
		const oid = await this.writeUnreachable(text);
		await server().git(this.serverRepo, ["update-ref", ref, oid]);
		return oid;
	}

	async hasObject(oid: string): Promise<boolean> {
		return (await server().git(this.serverRepo, ["cat-file", "-e", oid], undefined, false)).rc === 0;
	}

	/** `git gc --prune=now` on the server (ep-g10). */
	async gc(): Promise<void> {
		await server().git(this.serverRepo, ["gc", "--quiet", "--prune=now"]);
	}

	/** Values no document may echo: endpoint, paths, and each context's directory, binding and secret. */
	async sentinels(handles: readonly ContextHandle[]): Promise<[string, string][]> {
		const values: [string, string][] = [
			["endpoint", this.url],
			["server repository", this.serverRepo],
			["project", this.project],
			["context parent", this.parent],
		];
		for (const [index, handle] of handles.entries()) {
			values.push([`context ${index + 1}`, handle.directory]);
			values.push([`binding ${index + 1}`, handle.context.binding]);
			values.push([`secret ${index + 1}`, await this.secretOf(handle)]);
		}
		return values;
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

	/** Releases every gate, settles every started call, waits for every late push, removes the root. */
	// adapted from claim-emergency-git.test.ts:892-908
	async dispose(): Promise<string[]> {
		const problems: string[] = [];
		try {
			await this.gates.releaseAll();
			for (const pending of this.pendings) {
				await settleWithin("a started call", pending, RUN_TIMEOUT).catch(() => {
					problems.push("a started call did not settle");
				});
			}
			for (const push of this.lates) {
				const ended = await Promise.race([
					push.child.exited.then(() => true),
					Bun.sleep(EVENT_TIMEOUT).then(() => false),
				]);
				if (!ended) {
					problems.push("a late push did not end");
					push.child.kill();
				}
			}
		} finally {
			this.stopTrace();
			await rm(this.root, { recursive: true, force: true });
		}
		return problems;
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup, a cleanup problem is shown. */
// adapted from claim-emergency-git.test.ts:913-929
async function withCase(
	format: ClaimStorageFormat,
	caseId: string,
	block: Partial<BlockOptions>,
	body: (c: EpochCase) => Promise<void>,
): Promise<void> {
	const run = await EpochCase.create(format, caseId, block);
	let failure: unknown;
	try {
		await body(run);
	} catch (error) {
		failure = error;
	}
	const problems = await run.dispose();
	if (failure !== undefined) throw failure;
	expect({ caseId, cleanupProblems: problems }).toEqual({ caseId, cleanupProblems: [] });
}

// ---------------------------------------------------------------------------------------------------------------
// Views and expected documents (shapes as claim-emergency-git.test.ts:936-1188). A message only as MESSAGE.
// ---------------------------------------------------------------------------------------------------------------

/** The whole document with a non-empty message replaced by MESSAGE (claim-emergency-git.test.ts:937-942). */
function masked(document: unknown): unknown {
	if (!isRecord(document)) return document;
	const body: Body = { ...document };
	if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
	return body;
}

function statusOf(document: unknown): unknown {
	return entryOf(document, "status");
}

/** The exit code of a document's status, -1 for anything outside the table. */
function exitOf(document: unknown): number {
	const status = field(document, "status");
	for (const [name, code] of Object.entries(CLAIM_EXIT_CODES)) if (name === status) return code;
	return -1;
}

/** An applied or unknown run in these terms; `previousFormat` is the format the run found. */
function applied(
	fromEpoch: number,
	format: ClaimStorageFormat,
	rewritten: readonly string[],
	created: readonly string[],
	previousFormat = format,
): DoneExpectation {
	return { status: "applied", fromEpoch, epoch: fromEpoch + 1, format, previousFormat, rewritten, created };
}

function rejected(...causes: string[]): EpochExpectation {
	return { status: "rejected", causes };
}

/** The maintenance receipt, the operator's statement recorded remotely. */
function maintenanceReceipt(fromEpoch: number): Body {
	return { schema: 1, kind: "epoch", fromEpoch, epoch: fromEpoch + 1, isolation: "attested" };
}

/** The FREE tombstone payload (rights/index.ts:28; claim-emergency-git.test.ts:1244). */
function freePayload(claimGeneration: number): Body {
	return { claimState: 1, status: "free", claimGeneration };
}

/**
 * The document every run writes per ticket, `{schema 1, format f', epoch N+1, ticket, revision 1,
 * payload: FREE tombstone, receipts: {<m-id>: maintenance receipt}}`, as a reader of that epoch decodes it.
 */
function tombstoneView(epoch: number, format: ClaimStorageFormat, claimGeneration: number): StoredView {
	const receipts = [[MAINTENANCE_KEY, maintenanceReceipt(epoch - 1)]];
	return { revision: 1, epoch, format, payload: freePayload(claimGeneration), receipts };
}

/** A new root carries its one maintenance receipt itself; the chain's commit has no parent. */
function freshLayer(format: ClaimStorageFormat): LayerView {
	return { type: OBJECT_TYPE[format], receipts: [MAINTENANCE_KEY], parents: [] };
}

function freeEntry(ticket: string, claimGeneration: number, epoch: number): Body {
	return listEntry(ticket, { state: "free", claimGeneration, epoch });
}

function unknownEntry(ticket: string): Body {
	return listEntry(ticket, { state: "unknown" });
}

/** A list observed at T; an unknown entry makes it incomplete, unknown/3 (surface/index.ts:3191-3202). */
function listBody(claims: Body[], complete = true): Body {
	const status = complete ? "ok" : "unknown";
	return { schemaVersion: 1, kind: "claim-list", status, command: "list", complete, observedAt: T, claims };
}

// adapted from claim-emergency-git.test.ts:1133-1141
function errorBody(command: string, status: string, code: string, ticket: string | null): Body {
	return { schemaVersion: 1, kind: "claim-error", status, command, code, message: MESSAGE, ticket, operationId: null };
}

/** The timeless mode never becomes reclaimable (rights/index.ts:238-241, :337-338). */
const NEVER: Body = { kind: "never" };

/** RightsView: the rights evaluation without observedRoot and reason (rights/index.ts:328-361). */
function heldNone(claimGeneration: number): Body {
	const workRight = { kind: "live", renewalDue: null };
	const ownership = "held";
	return { kind: "evaluated", scope: "observed-state-only", ownership, claimGeneration, workRight, reclaim: NEVER };
}

/** PlannedDisplay of a timeless ACTIVE successor. */
function nonePlanned(claimGeneration: number): Body {
	return { status: "active", claimGeneration, timing: { mode: "none" }, capped: false };
}

/** The claim-operation document with every key (claim-emergency-git.test.ts:1070-1087). */
function operationBody(fields: OperationFields): Body {
	return {
		schemaVersion: 1,
		kind: "claim-operation",
		status: fields.status,
		command: fields.command,
		action: fields.command,
		ticket: fields.ticket,
		operationId: fields.operationId,
		outcome: fields.outcome,
		rejection: null,
		storage: fields.storage ?? null,
		sends: fields.sends,
		stoppedBy: null,
		planned: fields.planned ?? null,
		rights: fields.rights,
	};
}

/** A timeless acquire that applied with one send (claim-emergency-git.test.ts:1090-1110). */
function acquiredBody(ticket: string, operationId: string, claimGeneration: number): Body {
	return operationBody({
		status: "applied",
		command: "acquire",
		ticket,
		operationId,
		outcome: "applied",
		storage: { kind: "applied" },
		sends: 1,
		planned: nonePlanned(claimGeneration),
		rights: heldNone(claimGeneration),
	});
}

/**
 * The fields a retry of an old-epoch intent is pinned by. The document is a `claim-operation`, the only
 * kind with `sends` and the status `unknown-history` (surface/index.ts:421-448; `claim-error` has neither,
 * surface/index.ts:199). Storage, rights and planned display stay open [?].
 */
function retryView(document: unknown): Body {
	return {
		kind: entryOf(document, "kind"),
		status: statusOf(document),
		exit: exitOf(document),
		command: entryOf(document, "command"),
		action: entryOf(document, "action"),
		ticket: entryOf(document, "ticket"),
		operationId: entryOf(document, "operationId"),
		outcome: entryOf(document, "outcome"),
		sends: entryOf(document, "sends"),
	};
}

/**
 * The positive control of ep-g06 to ep-g08 (catches: the typed scaffold, whose command installs nothing; a listed
 * operator refused; a run that reports applied without the descriptor CAS): the holder acquires BACK-1 and the listed
 * operator installs epoch 2 over it, BACK-1 rewritten and BACK-2 and BACK-3 created from the corpus; the server's
 * descriptor names epoch 2.
 */
async function epochControl(c: EpochCase, parties: Parties, caseId: string): Promise<void> {
	const acquired = await c.acquire(parties.holder, TICKET, `op-${caseId}-control-acquire`);
	const run = await c.install(parties.operator, { expectEpoch: 1 });
	const [seen, expected] = epochPair(run, applied(1, c.format, [TICKET], [SECOND_TICKET, THIRD_TICKET]));
	const label = `${caseId} positive control (catches: a scaffold run that installs nothing, a refused listed operator)`;
	expect({ label, acquired: statusOf(acquired), run: seen, descriptor: await c.descriptor() }).toEqual({
		label,
		acquired: "applied",
		run: expected,
		descriptor: { schema: 1, format: c.format, epoch: 2 },
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The cases, each on blob, tree and commit-chain. No mutation below meets an own open intent at an unchanged root
// (pause/index.ts:96-104, which compares the epoch too); ep-g02's open release is only retried and resolved.
// ---------------------------------------------------------------------------------------------------------------

for (const format of FORMATS) {
	describe(`claim install-epoch through the surface core over real Git (${format})`, () => {
		test(
			"ep-g01: rotates ACTIVE, FREE and PENDING into FREE tombstones of epoch 2 on fresh roots; init shows epoch 2",
			async () => {
				// PENDING needs finite hard ends, so this case runs in the hard mode.
				await withCase(format, "ep-g01", { mode: "hard" }, async (c) => {
					const { holder, operator, other } = await c.parties();
					// A = BACK-1 ACTIVE; B = BACK-2 FREE (acquired, released); C = BACK-3 PENDING at p, a restart whose
					// observation reads H − EPS, too late for a witness (claim-emergency-git:1555-1560).
					await c.acquire(holder, TICKET, "op-ep-g01-a");
					await c.acquire(holder, SECOND_TICKET, "op-ep-g01-b");
					await c.release(holder, SECOND_TICKET, "op-ep-g01-b-release");
					await c.acquire(holder, THIRD_TICKET, "op-ep-g01-c");
					await c.transferRestart(holder, THIRD_TICKET, "op-ep-g01-c-restart", other, [T, H - EPS, H - EPS]);
					const old = await c.claimRoots();
					const before = await c.shapes(TASK_IDS);
					const run = await c.install(operator, { expectEpoch: 1 });
					const [seen, expected] = epochPair(run, applied(1, format, TASK_IDS, []));

					// Positive control (catches: the scaffold's command, which installs nothing; a run that reports applied
					// without the descriptor CAS): A, B and C are ACTIVE, FREE and PENDING in epoch 1, the
					// listed operator's run applies over all three, and the server's descriptor names epoch 2, same format.
					expect({ before, run: seen, descriptor: await c.descriptor() }).toEqual({
						before: [
							{ status: "active", claimGeneration: 1 },
							{ status: "free", claimGeneration: 1 },
							{ status: "pending", claimGeneration: 2 },
						],
						run: expected,
						descriptor: { schema: 1, format, epoch: 2 },
					});

					const fresh = await c.claimRoots();
					const stored: StoredView[] = [];
					const layers: LayerView[] = [];
					for (const ticket of TASK_IDS) {
						stored.push(await c.stored(ticket));
						layers.push(await c.layer(fresh[ticket] ?? ABSENT_REF, format));
					}
					const oldRoots = Object.values(old);
					// (catches: a tombstone that keeps the old epoch, revision or receipts; a
					// generation not raised by exactly one, or C raised from the source's 1 instead of the target's 2; a
					// maintenance receipt of another key or shape; a chain commit with a parent; an old root written again, 3A).
					expect({
						tickets: Object.keys(fresh).sort(byCodeUnits),
						stored,
						layers,
						reused: Object.values(fresh).filter((root) => oldRoots.includes(root)),
					}).toEqual({
						tickets: [...TASK_IDS],
						stored: [tombstoneView(2, format, 2), tombstoneView(2, format, 2), tombstoneView(2, format, 3)],
						layers: TASK_IDS.map(() => freshLayer(format)),
						reused: [],
					});

					const listed = await c.list();
					const initialized = await c.init();
					const sentinels = await c.sentinels([holder, operator, other]);
					for (const [index, root] of [...oldRoots, ...Object.values(fresh)].entries()) {
						sentinels.push([`root ${index + 1}`, root]);
					}
					for (const ticket of TASK_IDS) {
						for (const id of await c.receiptIds(ticket)) sentinels.push([`receipt ID of ${ticket}`, id]);
					}
					// With `claim init` (catches: a list entry without its epoch, so generations compare
					// across the cut; init still at epoch 1 or refusing epoch 2; a root, path, endpoint, binding, secret or
					// receipt ID in any document, the allowlist).
					expect({
						listed: masked(listed),
						initialized: masked(initialized),
						leaked: leaks([run, listed, initialized], sentinels),
					}).toEqual({
						listed: listBody([freeEntry(TICKET, 2, 2), freeEntry(SECOND_TICKET, 2, 2), freeEntry(THIRD_TICKET, 3, 2)]),
						initialized: {
							schemaVersion: 1,
							kind: "claim-init",
							status: "ok",
							command: "init",
							result: "exists",
							format,
							epoch: 2,
						},
						leaked: [],
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g02: an old client's snapshot write is rejected stale; an open old intent retries as unknown-history, unsent",
			async () => {
				await withCase(format, "ep-g02", {}, async (c) => {
					const { holder, operator } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g02-acquire");
					const root = await c.ticketRoot(TICKET);
					// The old client: a store opened before the maintenance and its snapshot of BACK-1 at r.
					const old = await c.openClient("old");
					const snapshot = await old.read(TICKET);
					// The endpoint declines the holder's release once (claim-emergency-git.test.ts:1709-1715): the record stays
					// open at r (resolution/index.ts:147), so before the maintenance a retry would send it.
					await c.hooks.plan(["reject"], "pass");
					const declined = await c.release(holder, TICKET, "op-ep-g02-release");
					await c.hooks.plan([], "pass");
					const run = await c.install(operator, { expectEpoch: 1 });
					const [seen, expected] = epochPair(run, applied(1, format, [TICKET], [SECOND_TICKET, THIRD_TICKET]));
					const tombstone = await c.ticketRoot(TICKET);

					// Positive control (catches: the scaffold; a maintenance that skips a ticket with an open intent): the old
					// snapshot and the open release exist, the run applies, BACK-1 names a new root and the descriptor epoch 2.
					expect({
						snapshot: snapshot.kind,
						declined: statusOf(declined),
						run: seen,
						moved: tombstone !== root,
						descriptor: await c.descriptor(),
					}).toEqual({
						snapshot: "present",
						declined: "rejected",
						run: expected,
						moved: true,
						descriptor: { schema: 1, format, epoch: 2 },
					});

					if (snapshot.kind !== "present") throw new Error("fixture: the old snapshot is not present");
					const refs = await c.serverRefs();
					const change = { operationId: "op-ep-g02-old", receipt: { schema: 1 }, payload: snapshot.document.payload };
					const written = await old.write(snapshot, change);
					const reread = await old.read(TICKET);
					// (catches: an old snapshot written over the new epoch, a lease other than the snapshot's root;
					// a store that checks documents against epoch 1 or none at all, so the old client reads the new tombstone
					// as a claim): the lease meets the tombstone and the client reports stale info (storage/index.ts:642-643);
					// the old store reads the new document as corrupt; no ref moved.
					expect({
						written: { kind: written.kind, cause: entryOf(written, "cause") },
						reread: reread.kind,
						refs: await c.serverRefs(),
					}).toEqual({ written: { kind: "rejected", cause: "stale" }, reread: "corrupt", refs });

					const quiet = await c.snapshot();
					const retried = await c.retry(holder, "op-ep-g02-release");
					const resolved = await c.resolve(holder, "op-ep-g02-release");
					const sentinels = await c.sentinels([holder, operator]);
					sentinels.push(["old root", root], ["new root", tombstone]);
					// (Catches: a resend into the new epoch; `scope-mismatch` for an epoch change; `unknown`/3
					// from resolving against a foreign epoch, on execution/index.ts:1004-1009; a root, path,
					// endpoint, binding or secret in the fields retryView and the masked message leave out, the allowlist):
					// retry answers unknown-history/4 and sends nothing; resolve stays unknown-history/4
					// (query/index.ts:121-123).
					expect({
						retried: retryView(retried),
						resolved: masked(resolved),
						leaked: leaks([retried, resolved], sentinels),
						after: await c.snapshot(),
					}).toEqual({
						retried: {
							kind: "claim-operation",
							status: "unknown-history",
							exit: 4,
							command: "retry",
							action: "release",
							ticket: TICKET,
							operationId: "op-ep-g02-release",
							outcome: "unknown-history",
							sends: 0,
						},
						resolved: {
							schemaVersion: 1,
							kind: "claim-resolution",
							status: "unknown-history",
							command: "resolve",
							operationId: "op-ep-g02-release",
							ticket: TICKET,
							action: "release",
							outcome: "unknown-history",
							query: { kind: "unknown-history" },
						},
						leaked: [],
						after: quiet,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g03: an old client's update held in pre-receive fails at the ref update; the ref keeps the new tombstone",
			async () => {
				await withCase(format, "ep-g03", {}, async (c) => {
					const { holder, operator } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g03-acquire");
					const root = await c.ticketRoot(TICKET);
					// An old client writes revision 2 of its epoch-1 snapshot at r; ReceiveGates hold the push in pre-receive.
					const late = await c.startLateWrite(TICKET, "op-ep-g03-late");
					const run = await c.install(operator, { expectEpoch: 1 });
					const [seen, expected] = epochPair(run, applied(1, format, [TICKET], [SECOND_TICKET, THIRD_TICKET]));
					const tombstone = await c.ticketRoot(TICKET);
					const moved = [tombstone !== root, tombstone !== late.root];

					// Positive control (catches: the scaffold; a run that waits for, or stumbles over, a receive nobody can
					// list; "a missing contradiction is no proof"): while the old update waits in pre-receive the
					// run applies, and BACK-1 names a root that is neither r nor the waiting one.
					expect({ run: seen, descriptor: await c.descriptor(), moved }).toEqual({
						run: expected,
						descriptor: { schema: 1, format, epoch: 2 },
						moved: [true, true],
					});

					const outcome = await c.finishLateWrite(late);
					// The [ASSUMED] Git behaviour measured (catches: a receive-pack that checks the old value
					// only before pre-receive, so the held update lands over the new epoch; a hook that declined instead,
					// which would prove nothing, hence hookRc): pre-receive passed, the ref update refused r, and BACK-1
					// keeps the tombstone, FREE generation 2 of epoch 2.
					expect({ outcome, root: await c.ticketRoot(TICKET), stored: await c.stored(TICKET) }).toEqual({
						outcome: { push: { kind: "rejected", cause: LEASE_CAUSE }, hookRc: 0 },
						root: tombstone,
						stored: tombstoneView(2, format, 2),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ep-g04: an old client's creation of a missing corpus ref, held in pre-receive, fails because the run created it",
			async () => {
				await withCase(format, "ep-g04", {}, async (c) => {
					const { holder, operator } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g04-acquire");
					// An old client creates BACK-3, a local task without a ref, with a valid ACTIVE state; its push waits
					// in pre-receive with the empty lease of a creation.
					const late = await c.startLateWrite(THIRD_TICKET, "op-ep-g04-late", await c.payloadOf(TICKET));
					const run = await c.install(operator, { expectEpoch: 1 });
					const [seen, expected] = epochPair(run, applied(1, format, [TICKET], [SECOND_TICKET, THIRD_TICKET]));
					const created = await c.ticketRoot(THIRD_TICKET);

					// Positive control (catches: the scaffold; a creation set without the corpus, which leaves BACK-3 to
					// the late creation): the run applies and creates BACK-3 itself, on a root that is not the waiting one.
					expect({ run: seen, descriptor: await c.descriptor(), created: created !== late.root }).toEqual({
						run: expected,
						descriptor: { schema: 1, format, epoch: 2 },
						created: true,
					});

					const outcome = await c.finishLateWrite(late);
					// Measured (catches: a ref update that lets a creation with an empty lease pass
					// over an existing ref; a hook that declined instead): pre-receive passed, the ref update refused the
					// creation, and BACK-3 keeps the run's tombstone, FREE generation 1 of epoch 2 (no old document).
					expect({ outcome, root: await c.ticketRoot(THIRD_TICKET), stored: await c.stored(THIRD_TICKET) }).toEqual({
						outcome: { push: { kind: "rejected", cause: LEASE_CAUSE }, hookRc: 0 },
						root: created,
						stored: tombstoneView(2, format, 1),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ep-g05: a creation outside corpus and --ticket lands after the swap; L3 reports it breached, the list unknown",
			async () => {
				await withCase(format, "ep-g05", {}, async (c) => {
					const { holder, operator, other } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g05-acquire");
					// The negative control to ep-g04: the same held creation, for BACK-7, which is no local task and not named
					// by --ticket. Released right after the descriptor CAS, it lands before the final listing L3.
					const late = await c.startLateWrite(FOREIGN_TICKET, "op-ep-g05-late", await c.payloadOf(TICKET));
					const landing: { outcome?: LateOutcome } = {};
					const seams: EpochSeams = {
						afterDescriptorSwap: async () => {
							landing.outcome = await c.finishLateWrite(late);
						},
					};
					const run = await c.install(operator, { expectEpoch: 1, seams });
					const [seen, expected] = epochPair(run, {
						...applied(1, format, [TICKET], [SECOND_TICKET, THIRD_TICKET]),
						status: "unknown",
						breached: [FOREIGN_TICKET],
					});

					// Positive control (catches: the scaffold; a creation set larger than corpus plus --ticket, which would
					// have created BACK-7 and turned the landing into ep-g04's failure; a skipped L3, or one that compares only
					// the run's own refs): the creation lands, and the run ends unknown/3 with BACK-7 breached.
					const foreign = await c.ticketRoot(FOREIGN_TICKET);
					expect({ landed: landing.outcome ?? ABSENT, run: seen, foreign }).toEqual({
						landed: { push: { kind: "applied" }, hookRc: 0 },
						run: expected,
						foreign: late.root,
					});

					const listed = await c.list();
					const sentinels = await c.sentinels([holder, operator, other]);
					sentinels.push(["breaching root", late.root]);
					// Fail closed (catches: an epoch-1 document read as free or active in epoch 2; a
					// list that drops the unknown ticket; the breaching root or any path in a document): BACK-7 is unknown,
					// never free, and the list is incomplete, unknown/3.
					expect({ listed: masked(listed), exit: exitOf(listed), leaked: leaks([run, listed], sentinels) }).toEqual({
						listed: listBody(
							[
								freeEntry(TICKET, 2, 2),
								freeEntry(SECOND_TICKET, 1, 2),
								freeEntry(THIRD_TICKET, 1, 2),
								unknownEntry(FOREIGN_TICKET),
							],
							false,
						),
						exit: 3,
						leaked: [],
					});

					// The rerun the hint names: `--expect-epoch` = the reported epoch, with BACK-8 named by --ticket.
					const rerun = await c.install(operator, { expectEpoch: 2, tickets: [NAMED_TICKET] });
					const allListed = [TICKET, SECOND_TICKET, THIRD_TICKET, FOREIGN_TICKET];
					const [again, expectedAgain] = epochPair(rerun, applied(2, format, allListed, [NAMED_TICKET]));
					// (catches: a hint that names another epoch; a breach that blocks the next run; --ticket
					// ignored): the rerun applies over every listed ref and creates BACK-8; BACK-7 restarts at generation 1,
					// its epoch-1 document being unreadable in epoch 2 ([?]).
					expect({ again, relisted: masked(await c.list()) }).toEqual({
						again: expectedAgain,
						relisted: listBody([
							freeEntry(TICKET, 3, 3),
							freeEntry(SECOND_TICKET, 2, 3),
							freeEntry(THIRD_TICKET, 2, 3),
							freeEntry(FOREIGN_TICKET, 1, 3),
							freeEntry(NAMED_TICKET, 1, 3),
						]),
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			"ep-g06: a write between the first and the second listing ends the run rejected writes-observed, nothing written",
			async () => {
				await withCase(format, "ep-g06", {}, async (c) => {
					const parties = await c.parties();
					const { operator, other } = parties;

					// Positive control (catches: the scaffold; a listed operator refused).
					await epochControl(c, parties, "ep-g06");

					const before = await c.snapshot();
					const between: { acquired?: unknown; root?: string } = {};
					const seams: EpochSeams = {
						afterFirstListing: async () => {
							between.acquired = await c.acquire(other, SECOND_TICKET, "op-ep-g06-between", OTHER_OWNER);
							between.root = await c.ticketRoot(SECOND_TICKET);
						},
					};
					const run = await c.install(operator, { expectEpoch: 2, seams });
					const [seen, expected] = epochPair(run, rejected("writes-observed"));
					// (catches: a second listing that is skipped or compared by names only, so the moved
					// BACK-2 root passes; a run that swaps the descriptor or writes an archive or ticket ref before comparing):
					// the acquire between L1 and L2 applies, the run is rejected writes-observed, and the only change at the
					// server is that acquire's one push; the descriptor still names epoch 2.
					expect({
						acquired: statusOf(between.acquired),
						run: seen,
						after: await c.snapshot(),
						descriptor: await c.descriptor(),
					}).toEqual({
						acquired: "applied",
						run: expected,
						after: {
							refs: { ...before.refs, [refOf(SECOND_TICKET)]: between.root ?? ABSENT_REF },
							pushes: before.pushes + 1,
						},
						descriptor: { schema: 1, format, epoch: 2 },
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g07: refuses without --isolation-confirmed or authority, before any Git call, writing nothing",
			async () => {
				await withCase(format, "ep-g07", {}, async (c) => {
					const parties = await c.parties();
					const { holder, operator } = parties;
					const traceMark = await c.gitCalls();

					// Positive control (catches: the scaffold; an S2 trace that never records, so that zero Git calls below
					// would prove nothing).
					await epochControl(c, parties, "ep-g07");
					expect({ traced: (await c.gitCalls()) > traceMark }).toEqual({ traced: true });

					const listed = [await c.authorityOf(operator)];
					const rows: RefusalRow[] = [
						{
							label: "ep-g07 without --isolation-confirmed",
							catches: "the statement flag optional, or checked after the descriptor read or a push",
							confirmed: false,
							authorities: listed,
							code: "isolation-unconfirmed",
						},
						{
							label: "ep-g07 an operator outside claims.recovery_authorities",
							catches: "install-epoch without the emergency release authorisation, or checked after a Git call",
							confirmed: true,
							authorities: [await c.authorityOf(holder)],
							code: "authority-required",
						},
					];
					for (const row of rows) {
						await c.writeBlock({ authorities: row.authorities });
						const before = await c.snapshot();
						const mark = await c.gitCalls();
						const document = await c.install(operator, { expectEpoch: 2, confirmed: row.confirmed });
						const label = `${row.label} (catches: ${row.catches})`;
						// Refused/5 locally, nothing read but local files, nothing pushed, every ref as
						// before.
						expect({
							label,
							document: masked(document),
							exit: exitOf(document),
							gitCalls: (await c.gitCalls()) - mark,
							after: await c.snapshot(),
						}).toEqual({
							label,
							document: errorBody(INSTALL_EPOCH, "refused", row.code, null),
							exit: 5,
							gitCalls: 0,
							after: before,
						});
					}
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g08: a stale --expect-epoch is rejected epoch-changed; of two parallel runs exactly one applies",
			async () => {
				await withCase(format, "ep-g08", {}, async (c) => {
					const parties = await c.parties();
					const { operator, other } = parties;
					// Two listed operators, so the parallel runs share no context.
					await c.authorize(operator, other);

					// Positive control (catches: the scaffold; a listed operator refused).
					await epochControl(c, parties, "ep-g08");

					const quiet = await c.snapshot();
					const stale = await c.install(operator, { expectEpoch: 1 });
					const [staleSeen, staleExpected] = epochPair(stale, rejected("epoch-changed"));
					// (catches: a run that trusts the flag over the descriptor; a rejection that still writes):
					// `--expect-epoch 1` at descriptor 2 is rejected epoch-changed/2 with nothing pushed.
					expect({ stale: staleSeen, after: await c.snapshot() }).toEqual({ stale: staleExpected, after: quiet });

					// Interleaved: both runs pass step 2 and L1; the winner swaps first, the loser swaps from the old descriptor.
					const gate = { winnerListed: false, loserListed: false, swapped: false };
					const box: { loser?: Tracked<unknown> } = {};
					const winnerSeams: EpochSeams = {
						afterFirstListing: async () => {
							gate.winnerListed = true;
							await until("ep-g08 the loser's first listing", () => gate.loserListed);
						},
						afterDescriptorSwap: async () => {
							gate.swapped = true;
							if (box.loser !== undefined) await settleWithin("ep-g08 the loser", box.loser, RUN_TIMEOUT);
						},
					};
					const loserSeams: EpochSeams = {
						afterFirstListing: async () => {
							gate.loserListed = true;
							await until("ep-g08 the winner's descriptor swap", () => gate.swapped);
						},
					};
					const winner = c.start(c.install(operator, { expectEpoch: 2, seams: winnerSeams }));
					const loser = c.start(c.install(other, { expectEpoch: 2, seams: loserSeams }));
					box.loser = loser;
					const won = await settleWithin("ep-g08 the winner", winner, RUN_TIMEOUT);
					const lost = await settleWithin("ep-g08 the loser", loser, RUN_TIMEOUT);
					const [wonSeen, wonExpected] = epochPair(won, applied(2, format, TASK_IDS, []));
					const [lostSeen, lostExpected] = epochPair(lost, rejected("epoch-changed"));
					// (catches: a descriptor CAS without the lease on the descriptor read in step 2, so the
					// loser's swap overwrote the winner's epoch; a lost CAS reported unknown or applied): the winner applies
					// epoch 3, the loser, whose two listings agree, loses the CAS and is rejected epoch-changed.
					expect({ gate, won: wonSeen, lost: lostSeen, descriptor: await c.descriptor() }).toEqual({
						gate: { winnerListed: true, loserListed: true, swapped: true },
						won: wonExpected,
						lost: lostExpected,
						descriptor: { schema: 1, format, epoch: 3 },
					});

					// Free race: both runs expect epoch 3 and nothing orders them.
					const first = c.start(c.install(operator, { expectEpoch: 3 }));
					const second = c.start(c.install(other, { expectEpoch: 3 }));
					const results = [
						await settleWithin("ep-g08 the first racer", first, RUN_TIMEOUT),
						await settleWithin("ep-g08 the second racer", second, RUN_TIMEOUT),
					];
					// The applied one first, whichever racer it was.
					const [one, two] = statusOf(results[1]) === "applied" ? [results[1], results[0]] : results;
					const [appliedSeen, appliedExpected] = epochPair(one, applied(3, format, TASK_IDS, []));
					// [?] The loser may lose the CAS or see the winner's rewrites between its listings.
					const loserCauses = rejected("epoch-changed", "writes-observed");
					const [rejectedSeen, rejectedExpected] = epochPair(two, loserCauses);
					// ep-g08 (catches: two runs that both apply, two epochs installed at once): exactly one
					// applies epoch 4, the other is rejected.
					expect({ applied: appliedSeen, rejected: rejectedSeen, descriptor: await c.descriptor() }).toEqual({
						applied: appliedExpected,
						rejected: rejectedExpected,
						descriptor: { schema: 1, format, epoch: 4 },
					});
				});
			},
			LONG_TEST_TIMEOUT,
		);

		test(
			`ep-g09: migrates ${format} to ${MIGRATION_TARGET[format]}; an old-configuration checkout gets format-mismatch`,
			async () => {
				const target = MIGRATION_TARGET[format];
				await withCase(format, "ep-g09", {}, async (c) => {
					const { holder, operator, other } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g09-acquire");
					const config = await c.configBytes();
					const run = await c.install(operator, { expectEpoch: 1, storageFormat: target });
					const created = [SECOND_TICKET, THIRD_TICKET];
					const [seen, expected] = epochPair(run, applied(1, target, [TICKET], created, format));

					// Positive control (catches: the scaffold; a migration that keeps the old format in the descriptor; a tool
					// that rewrites config.yml): the run applies, the descriptor names the target format and epoch 2, and
					// the checkout's config.yml is byte-identical.
					expect({
						run: seen,
						descriptor: await c.descriptor(),
						config: (await c.configBytes()).equals(config),
					}).toEqual({
						run: expected,
						descriptor: { schema: 1, format: target, epoch: 2 },
						config: true,
					});

					const fresh = await c.claimRoots();
					const stored: StoredView[] = [];
					const layers: LayerView[] = [];
					for (const ticket of TASK_IDS) {
						stored.push(await c.stored(ticket, target));
						layers.push(await c.layer(fresh[ticket] ?? ABSENT_REF, target));
					}
					// (catches: a document left in the old format, an ACTIVE state carried over the cut, a chain
					// commit that continues the old chain): every ref names a target-format root of revision 1 without parents.
					expect({ stored, layers }).toEqual({
						stored: [tombstoneView(2, target, 2), tombstoneView(2, target, 1), tombstoneView(2, target, 1)],
						layers: TASK_IDS.map(() => freshLayer(target)),
					});

					const mismatched = await c.acquire(other, SECOND_TICKET, "op-ep-g09-old-config", OTHER_OWNER);
					await c.writeBlock({ format: target });
					const acquired = await c.acquire(other, SECOND_TICKET, "op-ep-g09-new-config", OTHER_OWNER);
					const createdRoot = fresh[SECOND_TICKET] ?? ABSENT_REF;
					const acquiredLayer: LayerView =
						target === "commit-chain"
							? { type: "commit", receipts: ["op-ep-g09-new-config"], parents: [createdRoot] }
							: { type: OBJECT_TYPE[target], receipts: [MAINTENANCE_KEY, "op-ep-g09-new-config"], parents: [] };
					// Fail closed (catches: a checkout that writes into a store of another format; an acquire
					// that fails in the new epoch or format): with the old block acquire is format-mismatch/5 before any
					// record; once the block names the target format it applies with generation 2 on the tombstone.
					expect({
						mismatched: masked(mismatched),
						acquired: masked(acquired),
						layer: await c.layer(await c.ticketRoot(SECOND_TICKET), target),
					}).toEqual({
						mismatched: {
							...errorBody("acquire", "refused", "format-mismatch", SECOND_TICKET),
							configuredFormat: format,
							existingFormat: target,
						},
						acquired: acquiredBody(SECOND_TICKET, "op-ep-g09-new-config", 2),
						layer: acquiredLayer,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g10: archives every old root under its epoch; after git gc --prune=now every old receipt reads back",
			async () => {
				await withCase(format, "ep-g10", {}, async (c) => {
					const { holder, operator } = await c.parties();
					// Two revisions each: BACK-1 acquired and touched, BACK-2 acquired and released.
					await c.acquire(holder, TICKET, "op-ep-g10-acquire-1");
					await c.touch(holder, TICKET, "op-ep-g10-touch-1");
					await c.acquire(holder, SECOND_TICKET, "op-ep-g10-acquire-2");
					await c.release(holder, SECOND_TICKET, "op-ep-g10-release-2");
					const old = await c.claimRoots();
					const receipts = {
						first: (await c.stored(TICKET)).receipts,
						second: (await c.stored(SECOND_TICKET)).receipts,
					};
					const refsBefore = await c.serverRefs();
					const run = await c.install(operator, { expectEpoch: 1 });
					const [seen, expected] = epochPair(run, applied(1, format, [TICKET, SECOND_TICKET], [THIRD_TICKET]));

					// Positive control (catches: the scaffold; a fixture whose old roots hold fewer than two receipts each).
					expect({ receipts: [receipts.first.length, receipts.second.length], run: seen }).toEqual({
						receipts: [2, 2],
						run: expected,
					});

					const archive = await c.archiveRefs();
					const refsAfter = await c.serverRefs();
					// (Catches: an archive ref missing, pointing at another root or made for a created
					// ticket; a ref deleted; "no ref is deleted"): exactly the two rewritten tickets are archived
					// under epoch 1 at their old roots.
					expect({ archive, lost: Object.keys(refsBefore).filter((ref) => !(ref in refsAfter)) }).toEqual({
						archive: {
							[`1/${TICKET}`]: old[TICKET] ?? ABSENT_REF,
							[`1/${SECOND_TICKET}`]: old[SECOND_TICKET] ?? ABSENT_REF,
						},
						lost: [],
					});

					const probe = await c.writeUnreachable(`ep-g10 unreachable probe ${format}\n`);
					await c.gc();
					// With the rule "no automatic deletion" (catches: old receipts only reachable from refs the run
					// moved, which the server's gc drops): the gc pruned an unreachable object, and every old receipt still
					// decodes from the archived roots, value for value.
					expect({
						pruned: !(await c.hasObject(probe)),
						first: await c.receiptsAt(archive[`1/${TICKET}`] ?? ABSENT_REF, format),
						second: await c.receiptsAt(archive[`1/${SECOND_TICKET}`] ?? ABSENT_REF, format),
					}).toEqual({ pruned: true, first: receipts.first, second: receipts.second });
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g11: a crash right after the descriptor CAS leaves every ticket unknown; a rerun at epoch 2 installs epoch 3",
			async () => {
				await withCase(format, "ep-g11", {}, async (c) => {
					const { holder, operator } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g11-acquire-1");
					await c.acquire(holder, SECOND_TICKET, "op-ep-g11-acquire-2");
					const old = await c.claimRoots();
					const calls = { swapped: 0 };
					const seams: EpochSeams = {
						afterDescriptorSwap: async () => {
							calls.swapped += 1;
							throw new Error("ep-g11: the run dies right after the descriptor CAS");
						},
					};
					const crashed = await c.install(operator, { expectEpoch: 1, seams });

					// Positive control (catches: the scaffold, which never swaps the descriptor; a seam at another step; a run
					// that goes on after the throw, or lets it escape as internal): the seam ran once, the run
					// answers claim-epoch unknown/3 with epoch 2 as the rerun hint, the descriptor names epoch 2, and no ticket
					// or archive ref moved.
					expect({
						reported: {
							kind: entryOf(crashed, "kind"),
							status: statusOf(crashed),
							exit: exitOf(crashed),
							epoch: entryOf(crashed, "epoch"),
						},
						swaps: calls.swapped,
						descriptor: await c.descriptor(),
						roots: await c.claimRoots(),
						archive: await c.archiveRefs(),
					}).toEqual({
						reported: { kind: "claim-epoch", status: "unknown", exit: 3, epoch: 2 },
						swaps: 1,
						descriptor: { schema: 1, format, epoch: 2 },
						roots: old,
						archive: {},
					});

					const listed = await c.list();
					// Fail closed (catches: an epoch-1 document read as free or active under descriptor 2):
					// every listed ticket is unknown, the list incomplete, unknown/3.
					expect({ listed: masked(listed), exit: exitOf(listed) }).toEqual({
						listed: listBody([unknownEntry(TICKET), unknownEntry(SECOND_TICKET)], false),
						exit: 3,
					});

					const rerun = await c.install(operator, { expectEpoch: 2 });
					const [seen, expected] = epochPair(rerun, applied(2, format, [TICKET, SECOND_TICKET], [THIRD_TICKET]));
					// [?] (catches: a rerun that needs a resume state; a crash that blocks the
					// next epoch; archive refs of the aborted epoch): the rerun applies epoch 3, archives the epoch-1 roots
					// under epoch 2, and lists every ticket FREE at generation 1, the old documents being unreadable in epoch 2.
					expect({ rerun: seen, relisted: masked(await c.list()), archive: await c.archiveRefs() }).toEqual({
						rerun: expected,
						relisted: listBody([
							freeEntry(TICKET, 1, 3),
							freeEntry(SECOND_TICKET, 1, 3),
							freeEntry(THIRD_TICKET, 1, 3),
						]),
						archive: {
							[`2/${TICKET}`]: old[TICKET] ?? ABSENT_REF,
							[`2/${SECOND_TICKET}`]: old[SECOND_TICKET] ?? ABSENT_REF,
						},
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"ep-g12: a non-canonical ref made after the swap ends the run unknown; one standing before L1 leaves it applied",
			async () => {
				await withCase(format, "ep-g12", {}, async (c) => {
					const { holder, operator } = await c.parties();
					await c.acquire(holder, TICKET, "op-ep-g12-acquire");
					const standing = await c.writeServerRef(STANDING_REF, "ep-g12 standing");
					const first = await c.install(operator, { expectEpoch: 1 });
					const created = [SECOND_TICKET, THIRD_TICKET];
					const [firstSeen, firstExpected] = epochPair(first, applied(1, format, [TICKET], created));
					// Positive control (catches: the scaffold; a run that counts every name the lister skips as a breach,
					// although the contract names only a ref the run did not write): a non-canonical ref that stood
					// before L1 and stands unchanged in all three listings leaves the run applied and is not touched.
					expect({ run: firstSeen, standing: (await c.serverRefs())[STANDING_REF] ?? ABSENT_REF }).toEqual({
						run: firstExpected,
						standing,
					});

					const old = await c.claimRoots();
					const late: { root?: string } = {};
					const seams: EpochSeams = {
						afterDescriptorSwap: async () => {
							late.root = await c.writeServerRef(LATE_REF, "ep-g12 late");
						},
					};
					const run = await c.install(operator, { expectEpoch: 2, seams });
					const [seen, expected] = epochPair(run, { ...applied(2, format, TASK_IDS, []), status: "unknown" });
					const refs = await c.serverRefs();
					// Mandatory sentence 2 (catches: an L3 that compares only the
					// canonical ticket refs, so a name the lister skips passes and the run reports applied/0): the name created
					// after the swap ends the run unknown/3 with epoch 3 as the rerun hint; being no ticket it is neither
					// breached nor unsettled; every L2 ticket is rewritten and its epoch-2 root archived; both names stay.
					expect({
						run: seen,
						archive: prefixed(await c.archiveRefs(), "2/"),
						late: refs[LATE_REF] ?? ABSENT_REF,
						standing: refs[STANDING_REF] ?? ABSENT_REF,
					}).toEqual({
						run: expected,
						archive: {
							[TICKET]: old[TICKET] ?? ABSENT_REF,
							[SECOND_TICKET]: old[SECOND_TICKET] ?? ABSENT_REF,
							[THIRD_TICKET]: old[THIRD_TICKET] ?? ABSENT_REF,
						},
						late: late.root ?? ABSENT,
						standing,
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}

// ---------------------------------------------------------------------------------------------------------------
// The re-read after the endpoint refused the
// descriptor swap of step 5. Only a descriptor found at another root is evidence that the epoch changed; an
// unreachable, corrupt or absent re-read leaves a refusal with an open question: refused remote-rejected (exit 5) with
// the fixed text, nothing written. The trigger is fixture-only (no product seam): the descriptor is a
// content-addressed blob in every format, so the held push's new root is the server's descriptor text with the next
// epoch; the S1 gate holds that push in pre-receive, the test changes the server while it is held, the hook refuses
// the push after the release, and the store re-reads only after the change. The combined reason of the store's
// `declined` is internal and not pinned.
// ---------------------------------------------------------------------------------------------------------------

/** What the test does at the server while the descriptor push is held. */
type RereadChange = "unreachable" | "corrupt" | "moved" | "unchanged" | "absent";
type RereadRow = { id: string; change: RereadChange; outcome: "remote-rejected" | "epoch-changed"; title: string };

const DESCRIPTOR_REF = "refs/claim-meta/format";
const CORRUPT_DESCRIPTOR = "not a descriptor\n";
/** The fixed text of `remote-rejected` (surface/index.ts:307); the reason of the store's refusal never replaces it. */
const REMOTE_REJECTED_TEXT = "the claim coordination endpoint refused to write the descriptor";

const REREAD_ROWS: readonly RereadRow[] = [
	{
		id: "k22-a",
		change: "unreachable",
		outcome: "remote-rejected",
		title: "a refused swap whose re-read cannot reach the endpoint ends refused remote-rejected, nothing written",
	},
	{
		id: "k22-b",
		change: "corrupt",
		outcome: "remote-rejected",
		title: "a refused swap that re-reads a corrupt descriptor ends refused remote-rejected, not epoch-changed",
	},
	{
		id: "k22-c",
		change: "moved",
		outcome: "epoch-changed",
		title: "control: a refused swap whose descriptor another writer moved ends rejected epoch-changed",
	},
	{
		id: "k22-d",
		change: "unchanged",
		outcome: "remote-rejected",
		title: "control: a refused swap with the descriptor unchanged ends refused remote-rejected",
	},
	{
		id: "k22-e",
		change: "absent",
		outcome: "remote-rejected",
		title: "a refused swap that re-reads no descriptor ref ends refused remote-rejected, nothing written",
	},
];

/** The raw descriptor bytes at the server, readable even when they are no descriptor; ABSENT_REF without the ref. */
async function descriptorText(c: EpochCase): Promise<string> {
	const read = await server().git(c.serverRepo, ["cat-file", "blob", DESCRIPTOR_REF], undefined, false);
	return read.rc === 0 ? read.out : ABSENT_REF;
}

/**
 * Applies `change` at the server while the descriptor push is held and returns the descriptor ref it leaves (ABSENT_REF
 * once removed) with the bytes a later read finds there. `unreachable` turns off upload-pack for new connections only:
 * the held receive-pack goes on, the store's re-read cannot fetch (the caller restores it).
 */
async function changeDescriptor(
	c: EpochCase,
	change: RereadChange,
	leased: string,
	current: string,
	nextText: string,
): Promise<{ ref: string; text: string }> {
	const repo = c.serverRepo;
	if (change === "unreachable") await server().git(repo, ["config", "daemon.uploadpack", "false"]);
	if (change === "corrupt" || change === "moved") {
		const text = change === "corrupt" ? CORRUPT_DESCRIPTOR : nextText;
		const blob = (await server().git(repo, ["hash-object", "-w", "--stdin"], text)).out.trim();
		await server().git(repo, ["update-ref", DESCRIPTOR_REF, blob]);
		return { ref: blob, text };
	}
	if (change === "absent") {
		await server().git(repo, ["update-ref", "-d", DESCRIPTOR_REF]);
		return { ref: ABSENT_REF, text: ABSENT_REF };
	}
	return { ref: leased, text: current };
}

for (const format of FORMATS) {
	describe(`claim install-epoch: the re-read after a refused descriptor swap (${format})`, () => {
		for (const row of REREAD_ROWS) {
			test(
				`${row.id}: ${row.title}`,
				async () => {
					await withCase(format, row.id, {}, async (c) => {
						const parties = await c.parties();
						// Positive control (catches: the scaffold; a listed operator refused): epoch 2 is installed.
						await epochControl(c, parties, row.id);

						const repo = c.serverRepo;
						const current = await descriptorText(c);
						const leased = (await server().git(repo, ["rev-parse", DESCRIPTOR_REF])).out.trim();
						const nextText = current.replace(/"epoch":(\d+)/, (_match, n: string) => `"epoch":${Number(n) + 1}`);
						const nextRoot = (await server().git(repo, ["hash-object", "--stdin"], nextText)).out.trim();
						const before = await c.snapshot();
						await c.gates.arm("pre", nextRoot);
						await c.hooks.plan([], "reject");
						const pending = c.start(c.install(parties.operator, { expectEpoch: 2 }));
						let entered: unknown;
						let left = { ref: leased, text: current };
						let document: unknown;
						try {
							entered = await c.gates.entered("pre", nextRoot).catch((error: unknown) => String(error));
							left = await changeDescriptor(c, row.change, leased, current, nextText);
							await c.gates.release("pre", nextRoot);
							document = await settleWithin(`${row.id} the refused run`, pending, RUN_TIMEOUT);
						} finally {
							if (row.change === "unreachable") {
								await server().git(repo, ["config", "--unset", "daemon.uploadpack"], undefined, false);
							}
							await c.hooks.plan([], "pass");
						}

						const { [DESCRIPTOR_REF]: _leasedRef, ...others } = before.refs;
						const refs = left.ref === ABSENT_REF ? others : { ...others, [DESCRIPTOR_REF]: left.ref };
						const [run, expectedRun] =
							row.outcome === "epoch-changed"
								? epochPair(document, rejected("epoch-changed"))
								: [
										{ exit: exitOf(document), document: masked(document), message: field(document, "message") },
										{
											exit: CLAIM_EXIT_CODES.refused,
											document: errorBody(INSTALL_EPOCH, "refused", "remote-rejected", null),
											message: REMOTE_REJECTED_TEXT,
										},
									];
						// (catches: a swap that reads every re-read other than the leased root as a
						// moved descriptor, so an unreachable, corrupt or absent re-read ends rejected epoch-changed; a refusal
						// that writes a ticket or archive ref or pushes again; a refusal whose reason replaces the fixed text).
						// Positive control of the trigger: the gate held exactly the descriptor CAS from the leased root to the
						// predicted next root, and that held push is the only one the server saw.
						expect({
							label: row.id,
							entered,
							run,
							after: await c.snapshot(),
							descriptor: await descriptorText(c),
						}).toEqual({
							label: row.id,
							entered: [`${leased} ${nextRoot} ${DESCRIPTOR_REF}`],
							run: expectedRun,
							after: { refs, pushes: before.pushes + 1 },
							descriptor: left.text,
						});
					});
				},
				TEST_TIMEOUT,
			);
		}
	});
}
