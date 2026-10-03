/**
 * Level G of the canonical claim CLI: the surface core `runClaimMutation` in process against the loopback Git daemon of
 * claim-git-fixture.ts, blob only, with the wall clock, monotonic clock, random, sleep and operation ID injected
 * through ClaimSurfaceEnv and the S2 trace2 record of the project repository. bud-04 lets the monotonic clock jump by
 * the whole operation budget once the preflight has contacted the endpoint: the call must end as unavailable
 * `budget-exhausted` with no operation ID, an empty journal and unchanged server refs. The positive control in front, a
 * healthy acquire through the same core, is out of reach for the typed non-functional scaffold (every runClaim*
 * answers `internal`). Points the CLI contract decides are asserted exactly; open points are marked ASSUMPTION. The
 * other level-G rows moved to claim-cli.test.ts (out-07, out-08, cap-01, rsm-02, rsm-03, cfg5-02) or
 * claim-execution-retry.test.ts (unk-05) or are deferred (the stale half of cli-03, eps-02).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClaimContext, createClaimContext } from "../claims/context/index.ts";
import { initializeClaimStorage } from "../claims/storage/index.ts";
import {
	type ClaimMutationInput,
	type ClaimSurfaceEnv,
	claimExitCode,
	runClaimMutation,
} from "../claims/surface/index.ts";
import type { Task } from "../types/index.ts";
import { GitFixtureServer } from "./fixtures/claim-git-fixture.ts";

const TEST_TIMEOUT = 30_000;
/** attempt_timeout_ms of the configuration, far below the 10 s start value so that a hang shows. */
const ADAPTER_TIMEOUT = 3_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
/** Appears in the case root and the context parent; no document may contain it. */
const SENTINEL = "SENTINEL-surface-git-5b19";
const TICKET = "BACK-1";
/** Ticket of the leading positive control, so it never shares a key with the case. */
const CONTROL_TICKET = "BACK-9";
/** Acquire needs a local task file; the stub knows exactly these, already canonical. */
const LOCAL_TICKETS: readonly string[] = [TICKET, CONTROL_TICKET];
/** Display name only (owner appears in list entries alone); no operation document may echo it. */
const OWNER = "agent-sentinel-karl";
const MINUTE = 60_000;
/** "10:00" (2027-01-15T08:00Z), the injected wall clock for claim times. */
const T = 1_800_000_000_000;
const EPS = 2_000;
const TTL = 5 * MINUTE;
const GRACE = 10 * MINUTE;
/** operation_budget_ms of the configuration (the documented start value, written explicitly). */
const BUDGET_MS = 30_000;
/** Arbitrary origin of the injected monotonic clock; only differences to it count. */
const MONO_START = 5_000;
/** Operation IDs are `op-<uuid v4>`; the ID seam hands out exactly these. */
const CONTROL_ID = "op-5d0c6f1e-2b7a-4c3d-8e9f-0a1b2c3d4e5f";
const SPENT_ID = "op-9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
/** Stands for any non-empty message from the fixed table; its wording is not part of the contract. */
const MESSAGE = "<fixed message>";

type ContextHandle = { context: ClaimContext; directory: string };
type MutationDocument = Awaited<ReturnType<typeof runClaimMutation>>;
type LocalTicket = Awaited<ReturnType<ClaimSurfaceEnv["findLocalTicket"]>>;
type LocalTickets = Awaited<ReturnType<ClaimSurfaceEnv["loadLocalTickets"]>>;
type Sentinel = readonly [label: string, value: string];
type Body = Record<string, unknown>;
/** The facts of an operation document that the positive control pins; planned and rights details are not. */
type OperationView = {
	label: string;
	exit: number;
	kind: unknown;
	status: unknown;
	command: unknown;
	action: unknown;
	ticket: unknown;
	operationId: unknown;
	outcome: unknown;
	rejection: unknown;
	storage: unknown;
	sends: unknown;
	stoppedBy: unknown;
	ownership: unknown;
	echoed: string[];
};
/** A whole public document with a non-empty message replaced by MESSAGE, its exit code and the echoed sentinels. */
type DocumentView = { label: string; exit: number; body: Body; echoed: string[] };
/** One context journal by entry class: record names, the number of admission slots and every other name. */
type JournalView = { records: string[]; slots: number; other: string[] };

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

// adapted from claim-execution-pause.test.ts:438
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

/** Labels of the sentinels that occur in `text`. */
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

// adapted from claim-execution-pause.test.ts:1062 (ExecutionCase.initClient)
async function initClient(path: string): Promise<string> {
	await mkdir(path);
	await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
	await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
	return path;
}

/**
 * S2, test-local and synchronous, so the monotonic seam can read it: every trace2 `start` argv of
 * `git -C <repository> ...` without that prefix. Product Git inherits GIT_TRACE2_EVENT (storage/index.ts:180-196).
 */
// adapted from claim-execution-pause.test.ts:892
function gitCommandsOf(tracePath: string, repository: string): string[][] {
	let text: string;
	try {
		text = readFileSync(tracePath, "utf8");
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

/** Local lookup of acquire, stubbed: LOCAL_TICKETS exist as task files, nothing else does. */
function findLocalTicket(input: string): Promise<LocalTicket> {
	const found: LocalTicket = LOCAL_TICKETS.includes(input) ? { kind: "found", ticket: input } : { kind: "missing" };
	return Promise.resolve(found);
}

/**
 * The mandatory corpus seam, stubbed like findLocalTicket. LOCAL_TICKETS are open tasks without
 * dependencies, so the default strict gate lets their acquire through; a ticket missing here would be
 * dependency-unknown.
 */
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

/** The monotonic, random, sleep and operation ID seams, scripted and recorded; nothing sleeps or draws. */
class ScriptedSeams {
	readonly slept: number[] = [];
	draws = 0;
	private issued = 0;
	private readonly now: () => number;
	private readonly ids: readonly string[];

	constructor(now: () => number, ids: readonly string[]) {
		this.now = now;
		this.ids = ids;
	}

	readonly monotonicNow = (): number => this.now();

	readonly random = (): number => {
		this.draws += 1;
		return 0.5;
	};

	readonly sleep = (ms: number): Promise<void> => {
		this.slept.push(ms);
		return Promise.resolve();
	};

	readonly newOperationId = (): string => {
		const id = this.ids[this.issued];
		this.issued += 1;
		if (id === undefined) throw new Error("fixture: more operation IDs requested than scripted");
		return id;
	};
}

/** One server repository with the gate helper hooks, the project repository, a context parent and the S2 trace. */
class SurfaceCase {
	readonly root: string;
	readonly url: string;
	/** ClaimSurfaceEnv.projectRoot: the client repository of every storage call. */
	readonly project: string;
	/** Private 0700 parent of all contexts of this case, with the sentinel in its name. */
	readonly parent: string;
	private readonly serverRepo: string;
	private readonly tracePath: string;
	private previousTrace: string | undefined;
	private tracing = false;

	private constructor(root: string, url: string, serverRepo: string, project: string) {
		this.root = root;
		this.url = url;
		this.serverRepo = serverRepo;
		this.project = project;
		this.parent = join(root, `contexts-${SENTINEL}`);
		this.tracePath = resolve(root, "trace2-events.json");
	}

	static async create(caseName: string): Promise<SurfaceCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-surface-git-${SENTINEL}-`));
		try {
			const { name, repo } = await server().initRepository(root, `surface-${caseName}`);
			const project = await initClient(join(root, "project"));
			const surfaceCase = new SurfaceCase(root, server().url(name), repo, project);
			await mkdir(surfaceCase.parent);
			await chmod(surfaceCase.parent, 0o700);
			const initializer = await initClient(join(root, "client-initializer"));
			const initialized = await initializeClaimStorage({
				repository: initializer,
				remote: surfaceCase.url,
				format: "blob",
				timeoutMs: ADAPTER_TIMEOUT,
			});
			if (initialized.kind !== "created") throw new Error(`fixture: storage init failed (${initialized.kind})`);
			surfaceCase.startTrace();
			return surfaceCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	async context(): Promise<ContextHandle> {
		const created = await createClaimContext({ parent: this.parent });
		if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
		return { context: created.context, directory: dirname(created.context.journalDirectory) };
	}

	/** Configuration keys plus the three surface keys, all explicit; no start value is relied on. */
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

	/** ClaimSurfaceEnv: this project's repository and block (a string), the fixtures' prefix, seams. */
	env(seams: ScriptedSeams): ClaimSurfaceEnv {
		return {
			projectRoot: this.project,
			claimsYaml: this.claimsYaml(),
			taskPrefix: "BACK",
			findLocalTicket,
			loadLocalTickets,
			clock: () => T,
			monotonicNow: seams.monotonicNow,
			random: seams.random,
			sleep: seams.sleep,
			newOperationId: seams.newOperationId,
		};
	}

	/**
	 * ASSUMPTION(surface): ClaimMutationInput is left open by the contract; drafted as the parsed options of one command.
	 */
	input(ticket: string, handle: ContextHandle): ClaimMutationInput {
		return { command: "acquire", ticket, owner: OWNER, context: handle.directory };
	}

	/** O1. */
	async serverRefs(): Promise<Record<string, string>> {
		const listing = await server().git(this.serverRepo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const refs: Record<string, string> = {};
		for (const line of listing.out.split("\n").filter(Boolean)) {
			const [ref, oid] = line.split(" ");
			if (ref && oid) refs[ref] = oid;
		}
		return refs;
	}

	/** S2: the number of Git commands run so far in the project repository. */
	mark(): number {
		return gitCommandsOf(this.tracePath, this.project).length;
	}

	commandsSince(mark: number): string[][] {
		return gitCommandsOf(this.tracePath, this.project).slice(mark);
	}

	pushesSince(mark: number): number {
		return this.commandsSince(mark).filter((args) => args[0] === "push").length;
	}

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

	/** Values no public document may contain: paths, endpoint, owner, bindings, secrets, roots, digests. */
	private async sentinels(handles: ContextHandle[]): Promise<Sentinel[]> {
		const found: Sentinel[] = [
			["sentinel", SENTINEL],
			["case root", this.root],
			["endpoint", this.url],
			["owner", OWNER],
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

	async operationView(label: string, document: MutationDocument, handles: ContextHandle[]): Promise<OperationView> {
		return {
			label,
			exit: claimExitCode(document),
			kind: field(document, "kind"),
			status: field(document, "status"),
			command: field(document, "command"),
			action: field(document, "action"),
			ticket: field(document, "ticket"),
			operationId: field(document, "operationId"),
			outcome: field(document, "outcome"),
			rejection: field(document, "rejection"),
			storage: field(document, "storage"),
			sends: field(document, "sends"),
			stoppedBy: field(document, "stoppedBy"),
			ownership: field(field(document, "rights"), "ownership"),
			echoed: echoedIn(JSON.stringify(document), await this.sentinels(handles)),
		};
	}

	async documentView(label: string, document: MutationDocument, handles: ContextHandle[]): Promise<DocumentView> {
		const body: Body = Object.fromEntries(Object.entries(document));
		if (typeof body.message === "string" && body.message.trim() !== "") body.message = MESSAGE;
		const echoed = echoedIn(JSON.stringify(document), await this.sentinels(handles));
		return { label, exit: claimExitCode(document), body, echoed };
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
		this.stopTrace();
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Runs `body`, then always cleans up; a body failure is never hidden by the cleanup. */
// adapted from claim-execution-pause.test.ts:1360
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

describe("claim surface core over real Git (blob)", () => {
	test(
		"bud-04: a budget spent during the preflight ends the call before any operation ID, intent or send",
		async () => {
			await withCase("bud-04", async (fixture) => {
				const karl = await fixture.context();
				// Positive control (catches: missing wiring of preflight, schedule, executor and mapper): a monotonic
				// clock that never moves; the acquire applies with the seam's ID, one push and one admitted intent.
				const healthy = new ScriptedSeams(() => MONO_START, [CONTROL_ID]);
				const controlMark = fixture.mark();
				const control = await runClaimMutation(fixture.input(CONTROL_TICKET, karl), fixture.env(healthy));
				const controlLabel = "bud-04 positive control";
				expect(await fixture.operationView(controlLabel, control, [karl])).toEqual({
					label: controlLabel,
					exit: 0,
					kind: "claim-operation",
					status: "applied",
					command: "acquire",
					action: "acquire",
					ticket: CONTROL_TICKET,
					operationId: CONTROL_ID,
					outcome: "applied",
					rejection: null,
					storage: { kind: "applied" },
					sends: 1,
					stoppedBy: null,
					ownership: "held",
					echoed: [],
				});
				expect({ pushes: fixture.pushesSince(controlMark), journal: await fixture.journalView(karl) }).toEqual({
					pushes: 1,
					journal: { records: [`${CONTROL_ID}.json`], slots: 1, other: [] },
				});

				// bud-04: startedAt is read before the preflight; the clock jumps by the
				// whole budget once the preflight has contacted the endpoint, so the check after it sees remaining 0.
				const spent = await fixture.context();
				const refs = await fixture.serverRefs();
				const mark = fixture.mark();
				const contacted = () => fixture.commandsSince(mark).some((args) => args[0] === "ls-remote");
				const seams = new ScriptedSeams(() => (contacted() ? MONO_START + BUDGET_MS : MONO_START), [SPENT_ID]);
				const document = await runClaimMutation(fixture.input(TICKET, spent), fixture.env(seams));
				const label = "bud-04 budget spent by the preflight (catches: an intent, an ID or a send without budget)";
				expect({
					document: await fixture.documentView(label, document, [karl, spent]),
					contacted: contacted(),
					pushes: fixture.pushesSince(mark),
					journal: await fixture.journalView(spent),
					refs: await fixture.serverRefs(),
					slept: seams.slept,
					draws: seams.draws,
				}).toEqual({
					document: {
						label,
						exit: 6,
						body: {
							schemaVersion: 1,
							kind: "claim-error",
							status: "unavailable",
							command: "acquire",
							code: "budget-exhausted",
							message: MESSAGE,
							ticket: TICKET,
							operationId: null,
						},
						echoed: [],
					},
					contacted: true,
					pushes: 0,
					journal: { records: [], slots: 0, other: [] },
					refs,
					slept: [],
					draws: 0,
				});
			});
		},
		TEST_TIMEOUT,
	);
});
