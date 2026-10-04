/** Internal claim storage boundary; not a public library API. */
import { randomUUID } from "node:crypto";
import { canonicalJson, isJsonObject, isObject, type JsonObject, type JsonValue } from "../json.ts";
import { validTicket } from "../validate.ts";

export type { JsonObject, JsonValue } from "../json.ts";
export type ClaimStorageFormat = "blob" | "tree" | "commit-chain";
export type ClaimStorageDescriptor = { schema: 1; format: ClaimStorageFormat; epoch: number };

/** A test-only hook, never reachable from a configuration. */
type ClaimGitSeams = { beforeStdinWrite?: (child: ReturnType<typeof Bun.spawn>) => void };

export interface ClaimStorageOptions {
	repository: string;
	remote: string;
	format: ClaimStorageFormat;
	timeoutMs?: number;
	seams?: ClaimGitSeams;
}

export type ClaimDocument = {
	schema: 1;
	format: ClaimStorageFormat;
	epoch: number;
	ticket: string;
	revision: number;
	payload: JsonObject;
	receipts: Record<string, JsonObject>;
};

export type ClaimReadResult =
	| { kind: "absent"; ticket: string }
	| { kind: "present"; ticket: string; root: string; document: ClaimDocument }
	| { kind: "unreachable"; reason: string }
	| { kind: "corrupt"; reason: string }
	| { kind: "invalid"; reason: string };

export type ClaimSnapshot = Extract<ClaimReadResult, { kind: "absent" | "present" }>;
export type ClaimChange = { operationId: string; receipt: JsonObject; payload: JsonObject };
export type ClaimWriteResult =
	| { kind: "applied"; root: string; document: ClaimDocument }
	| { kind: "rejected"; cause: "stale" | "remote"; reason: string }
	| { kind: "invalid"; reason: string }
	| { kind: "not-sent"; reason: string }
	| { kind: "unknown"; reason: string };

export interface ClaimStore {
	read(ticket: string): Promise<ClaimReadResult>;
	write(base: ClaimSnapshot, change: ClaimChange): Promise<ClaimWriteResult>;
}

type ClaimInitializeResult =
	| { kind: "created"; descriptor: ClaimStorageDescriptor }
	| { kind: "exists"; descriptor: ClaimStorageDescriptor }
	| { kind: "conflict"; descriptor: ClaimStorageDescriptor }
	| { kind: "invalid"; reason: string }
	| { kind: "unreachable"; reason: string }
	| { kind: "corrupt"; reason: string }
	| { kind: "not-sent"; reason: string }
	| { kind: "rejected"; cause: "remote"; reason: string }
	| { kind: "unknown"; reason: string };

export type ClaimOpenResult =
	| { kind: "open"; store: ClaimStore; descriptor: ClaimStorageDescriptor }
	| { kind: "descriptor-missing" }
	| { kind: "format-mismatch"; descriptor: ClaimStorageDescriptor }
	| { kind: "schema-unsupported" }
	| { kind: "corrupt"; reason: string }
	| { kind: "unreachable"; reason: string }
	| { kind: "invalid"; reason: string };

const DESCRIPTOR_REF = "refs/claim-meta/format";
const DEFAULT_TIMEOUT_MS = 3_000;
/** The bound of the pipe reads after the group kill or after Git ended; a normal EOF never waits for it. */
const TRANSPORT_SETTLE_MS = 250;

type GitResult = {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
};

type RemoteBlob =
	| { kind: "found"; root: string; source: string }
	| { kind: "absent" }
	| { kind: "corrupt"; reason: string }
	| { kind: "failure"; reason: string };

type RemoteObject = { kind: "found"; root: string } | { kind: "absent" } | { kind: "failure"; reason: string };

type TreeEntry = { mode: string; type: string; root: string; name: string };
type ClaimLayout = { state: Record<string, unknown>; receipts: Record<string, JsonObject> };
type TreeEntries =
	| { kind: "found"; entries: TreeEntry[] }
	| { kind: "corrupt"; reason: string }
	| { kind: "failure"; reason: string };

/** The descriptor CAS of `claim install-epoch`. */
type ClaimEpochSwapResult =
	| { kind: "swapped"; descriptor: ClaimStorageDescriptor }
	/** The lease met another descriptor: another run or writer moved it since this store opened. */
	| { kind: "epoch-changed" }
	/**
	 * The endpoint refused the update and the descriptor stayed at the leased root, or the re-read after the refusal
	 * failed, named in the reason.
	 */
	| { kind: "declined"; reason: string }
	| { kind: "invalid" | "not-sent" | "unknown"; reason: string };

/**
 * One ticket of a maintenance run and its free payload; `root` is the ticket's root in
 * the second listing, the lease of its rewrite, or "" when the run creates the ref.
 */
export type ClaimEpochTicket = { ticket: string; root: string; payload: JsonObject };

/** The swapped descriptor (the epoch and format to write) and every ticket the run writes. */
type ClaimEpochPlan = { descriptor: ClaimStorageDescriptor; tickets: readonly ClaimEpochTicket[] };

/** `roots`: the new root of every ticket written; `unsettled`: every ticket whose archive or rewrite did not apply. */
type ClaimEpochInstallResult =
	| { kind: "written"; roots: Record<string, string>; unsettled: string[] }
	| { kind: "invalid"; reason: string };

type DescriptorRead =
	| { kind: "found"; descriptor: ClaimStorageDescriptor; root: string }
	| { kind: "absent" }
	| { kind: "schema-unsupported" }
	| { kind: "corrupt"; reason: string }
	| { kind: "unreachable"; reason: string };

function errorReason(result: GitResult): string {
	if (result.timedOut) return "git command timed out";
	if (result.error) return result.error;
	return result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.code}`;
}

/**
 * Reads a pipe to EOF, or until `stop` settles; a read cancelled at the settle bound still
 * returns what was read so far instead of losing it (unlike a plain `Response(stream).text()`).
 */
async function boundedText(
	stream: ReadableStream<Uint8Array> | number | null | undefined,
	stop: Promise<void>,
): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	void stop.then(() => reader.cancel().catch(() => undefined));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} catch {
		// a cancel at the settle bound surfaces as `done`; this catches an errored stream: keep what was read
	}
	return text + decoder.decode();
}

function validOperationId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function validObjectId(value: unknown): value is string {
	return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function stateOf(document: ClaimDocument): JsonObject {
	return Object.fromEntries(Object.entries(document).filter(([key]) => key !== "receipts")) as JsonObject;
}

/** Scope-free content checks shared with mutation resolution; not an epoch or endpoint compatibility check. */
export function isClaimDocumentContent(
	value: unknown,
): value is Record<string, unknown> & Pick<ClaimDocument, "schema" | "revision" | "payload" | "receipts"> {
	return (
		isObject(value) &&
		value.schema === 1 &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision > 0 &&
		isJsonObject(value.payload) &&
		isObject(value.receipts) &&
		Object.entries(value.receipts).every(([id, receipt]) => validOperationId(id) && isJsonObject(receipt))
	);
}

/** A document of any other epoch than the opened store's is corrupt, never free. */
function validDocument(
	value: unknown,
	ticket: string,
	format: ClaimStorageFormat,
	epoch: number,
): value is ClaimDocument {
	return (
		isObject(value) &&
		value.format === format &&
		value.epoch === epoch &&
		value.ticket === ticket &&
		isClaimDocumentContent(value)
	);
}

/** The one reason for every credential refusal; never echoes the input. */
const CREDENTIAL_ENDPOINT_REASON =
	"credentials are not allowed in the claim endpoint; use SSH keys or a Git credential helper";

/** The fixed reason of a re-read `stale`; never echoes the server text. */
const REREAD_STALE_REASON = "the ticket ref moved since the snapshot; the endpoint refused the update";
/** The re-read shows the ref at this write's own root — the `=` case, no lease was checked. */
const REREAD_LANDED_REASON = "the ticket ref already holds this write; the endpoint refused the repetition";

/** The storage endpoint rule, shared with the claim configuration resolver; never normalizes its input. */
export function claimEndpointError(remote: unknown): string | undefined {
	if (typeof remote !== "string" || /\s|\p{Cc}/u.test(remote)) return "invalid claim endpoint";
	try {
		const url = new URL(remote);
		if (
			!["git:", "https:", "http:", "ssh:", "file:"].includes(url.protocol) ||
			(url.protocol !== "file:" && !url.hostname)
		)
			return "an explicit Git endpoint URL is required";
		// A password is refused on every scheme; a username is refused on every scheme
		// but ssh, whose only URL form of hosting names an account, not a secret.
		if (url.password !== "" || (url.username !== "" && url.protocol !== "ssh:")) return CREDENTIAL_ENDPOINT_REASON;
	} catch {
		return "an explicit Git endpoint URL is required; remote names are not supported";
	}
	return undefined;
}

function optionsError(options: ClaimStorageOptions): string | undefined {
	if (typeof options.repository !== "string" || !options.repository || options.repository.includes("\0")) {
		return "an explicit repository is required";
	}
	if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
		return "timeoutMs must be a positive safe integer";
	}
	return claimEndpointError(options.remote);
}

/** Keep ordinary authentication configuration, but never inherit repository/config routing overrides. */
function gitEnvironment(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG(?:_.*)?|REPLACE_REF_BASE)$/.test(
				key,
			)
		) {
			delete env[key];
		}
	}
	env.LC_ALL = "C";
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_NO_REPLACE_OBJECTS = "1";
	return env;
}

/** The epoch is any positive safe integer; the schema is checked first. */
function decodeDescriptor(source: string, root: string): DescriptorRead {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return { kind: "corrupt", reason: "format descriptor is not JSON" };
	}
	if (!isObject(value)) return { kind: "corrupt", reason: "format descriptor is not an object" };
	if (value.schema !== 1) return { kind: "schema-unsupported" };
	const parsedFormat = parseClaimStorageFormat(value.format);
	if (parsedFormat.kind === "invalid") return { kind: "corrupt", reason: "format descriptor has an invalid format" };
	const epoch = value.epoch;
	if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) {
		return { kind: "corrupt", reason: "format descriptor has an unsupported epoch" };
	}
	return { kind: "found", descriptor: { schema: 1, format: parsedFormat.format, epoch }, root };
}

function decodeDocument(
	source: string,
	ticket: string,
	format: ClaimStorageFormat,
	epoch: number,
): ClaimDocument | undefined {
	try {
		const value: unknown = JSON.parse(source);
		return validDocument(value, ticket, format, epoch) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The three signals a claim Git call forwards; win32 has no process groups but still forwards
 * to the direct child. */
const TERMINAL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type TerminalSignal = (typeof TERMINAL_SIGNALS)[number];

/** pid → the spawned git, for every claim Git call currently in flight. */
const inFlightGroups = new Map<number, ReturnType<typeof Bun.spawn>>();
/** The teardown of the currently installed forwarder, one entry per signal, only while a call is in flight. */
const installedForwarders = new Map<TerminalSignal, () => void>();

/**
 * Sends `signal` to every in-flight call's process group, as the terminal would have delivered it before the group
 * kill; falls back to the direct child when the group cannot be signalled (no such group, or a platform without
 * process groups, e.g. win32). Never SIGKILLs this path — the timeout killer below is untouched.
 */
function forwardSignal(signal: TerminalSignal): void {
	for (const [pid, child] of inFlightGroups) {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// the group and the direct child are already gone
			}
		}
	}
}

/**
 * Installs one forwarding listener for
 * `signal`, idempotent while any call is in flight. At install the module keeps the OTHER listeners already
 * registered for this signal — never their count. When the signal arrives, the module forwards first, then
 * re-raises on itself (removing its own listener, so the default action applies) unless one of those kept listeners
 * is gone by now: a `process.once` surface handler (the MCP server, the browser server) has already run and owns
 * the shutdown, so the module only forwards. A listener that stays registered (signal-exit's, loaded with
 * proper-lockfile) is not ownership: the re-raise reaches it as the only listener left and it ends the process by
 * the signal.
 */
function installForwarder(signal: TerminalSignal): void {
	if (installedForwarders.has(signal)) return;
	const owners = process.listeners(signal).slice();
	const forward = () => {
		forwardSignal(signal);
		const surfaceOwns = owners.some((listener) => !process.listeners(signal).includes(listener));
		if (surfaceOwns) return;
		process.off(signal, forward);
		installedForwarders.delete(signal);
		process.kill(process.pid, signal);
	};
	process.on(signal, forward);
	installedForwarders.set(signal, () => process.off(signal, forward));
}

function teardownForwarder(signal: TerminalSignal): void {
	installedForwarders.get(signal)?.();
	installedForwarders.delete(signal);
}

/** Registers `child`'s group while its claim Git call is in flight; installs the forwarders on the first in-flight
 * call. Never registers pid 0 or a negative pid. */
function registerGitGroup(child: ReturnType<typeof Bun.spawn>): void {
	if (child.pid <= 0) return;
	const wasEmpty = inFlightGroups.size === 0;
	inFlightGroups.set(child.pid, child);
	if (wasEmpty) for (const signal of TERMINAL_SIGNALS) installForwarder(signal);
}

/** Removes `child`'s group once its call returned; tears the forwarders down once no call is left in flight, so
 * outside a claim Git call the process carries no listener of this module (claim-interrupt.test.ts, interrupt-listener-baseline). */
function unregisterGitGroup(child: ReturnType<typeof Bun.spawn>): void {
	if (child.pid <= 0) return;
	inFlightGroups.delete(child.pid);
	if (inFlightGroups.size === 0) for (const signal of TERMINAL_SIGNALS) teardownForwarder(signal);
}

/**
 * Spawns one Git command with the shared sandboxed environment and a hard per-command timeout. The call is registered
 * and its killer armed right after the spawn, before any write to stdin. A feed that throws or whose promise rejects
 * first gives the child the settle window to end on its own: a child that ended with an exit code returns git's own
 * result (the feed's message only fills an empty `stderr`); one still alive after the window, or ended by a signal,
 * has its group ended like the timeout does and returns `code -1` with the error. A child that ends on its own gives the
 * pipes the same window to reach EOF; if a helper of its group still holds one afterwards, the group is ended and the
 * call returns Git's own result without a timeout.
 */
async function runGit(
	repository: string,
	timeoutMs: number,
	args: string[],
	input?: string,
	seams?: ClaimGitSeams,
	environment?: Record<string, string>,
): Promise<GitResult> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		// Git leads its own session and process group, so every transport helper it starts
		// (git remote-http(s), a GIT_SSH_COMMAND process, …) shares the group and can be killed together with it.
		child = Bun.spawn(["git", "-C", repository, ...args], {
			cwd: repository,
			env: { ...gitEnvironment(), ...environment },
			stdin: input === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (error) {
		return {
			code: -1,
			stdout: "",
			stderr: "",
			timedOut: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	// Register this group while the call is in flight, so a terminal signal forwards to it.
	registerGitGroup(child);

	let timedOut = false;
	let finished = false;
	let feedError: string | undefined;
	let settle: () => void = () => undefined;
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let feedWindowTimer: ReturnType<typeof setTimeout> | undefined;
	let exitWindowTimer: ReturnType<typeof setTimeout> | undefined;
	/** Kills the whole group first; falls back to the direct child as before when the
	 * group cannot be signalled (no such group, or a platform without process groups, e.g. win32). The group id is not
	 * reused while a member lives, so the signal reaches only this call's processes; a feed failure whose git ended on
	 * its own never gets here. Then gives the pipes until the settle bound to reach EOF on their own before they are cut. */
	const endGroup = () => {
		let signalledGroup = false;
		if (child.pid > 0) {
			try {
				process.kill(-child.pid, "SIGKILL");
				signalledGroup = true;
			} catch {
				// fall through to the direct-child kill below
			}
		}
		if (!signalledGroup) {
			try {
				child.kill("SIGKILL");
			} catch {
				child.kill();
			}
		}
		settleTimer ??= setTimeout(settle, TRANSPORT_SETTLE_MS);
	};
	const killer = setTimeout(() => {
		timedOut = true;
		endGroup();
	}, timeoutMs);
	// Git ended on its own: the killer is no longer needed, and a helper of its group that still holds a pipe after the
	// settle window is cut off together with the group, so the call returns Git's own result instead of waiting for
	// the timeout. A timeout or a feed failure that already ended the group owns the settle bound itself.
	void child.exited.then(() => {
		if (finished || timedOut || settleTimer !== undefined) return;
		clearTimeout(killer);
		exitWindowTimer = setTimeout(() => {
			if (finished || settleTimer !== undefined) return;
			endGroup();
			settle();
		}, TRANSPORT_SETTLE_MS);
	});
	// A failed feed (a git that ended on its own before reading its input is the natural source of an EPIPE) waits for
	// the child's own ending or the settle window, whichever comes first, and the killer stays armed while git runs. Only a
	// child that is still running afterwards, or that ended by a signal, has its group ended; one that ended with an
	// exit code is left alone and the call returns its own result. A failure that arrives after the call returned,
	// or after the timeout already ended the group, is only absorbed (never kill a reused group id).
	const feedFailed = (error: unknown) => {
		if (finished || timedOut || feedError !== undefined) return;
		feedError = error instanceof Error ? error.message : String(error);
		void new Promise<void>((resolve) => {
			feedWindowTimer = setTimeout(resolve, TRANSPORT_SETTLE_MS);
			void child.exited.then(() => resolve());
		}).then(() => {
			if (finished || timedOut || child.exitCode !== null) return;
			clearTimeout(killer);
			endGroup();
		});
	};
	// `write` and `end` may return a promise that rejects (EPIPE) or an Error value, depending on the Bun version.
	const watchFeed = (result: unknown) => {
		void Promise.resolve(result).then((value) => {
			if (value instanceof Error) feedFailed(value);
		}, feedFailed);
	};
	try {
		if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
			try {
				seams?.beforeStdinWrite?.(child);
				watchFeed(child.stdin.write(input));
				watchFeed(child.stdin.end());
			} catch (error) {
				feedFailed(error);
			}
		}
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			boundedText(child.stdout, settled),
			boundedText(child.stderr, settled),
		]);
		if (feedError !== undefined && !timedOut) {
			// Git ended on its own with an exit code: its result stands, the feed's message only fills a silent stderr.
			if (child.exitCode !== null) {
				return { code, stdout, stderr, timedOut: false, ...(stderr.trim() === "" ? { error: feedError } : {}) };
			}
			return { code: -1, stdout: "", stderr: "", timedOut: false, error: feedError };
		}
		return { code, stdout, stderr, timedOut };
	} finally {
		finished = true;
		clearTimeout(killer);
		clearTimeout(feedWindowTimer);
		clearTimeout(exitWindowTimer);
		clearTimeout(settleTimer);
		unregisterGitGroup(child);
	}
}

/** Read-only, best-effort probe for ticket refs; racy, since the descriptor is not a multi-ref lock. */
export async function probeClaimRefs(
	options: ClaimStorageOptions,
): Promise<{ kind: "found" } | { kind: "absent" } | { kind: "failure"; reason: string }> {
	const invalid = optionsError(options);
	if (invalid) return { kind: "failure", reason: invalid };
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await runGit(options.repository, timeoutMs, ["ls-remote", "--refs", options.remote, "refs/claims/*"]);
	if (result.code !== 0 || result.timedOut) return { kind: "failure", reason: errorReason(result) };
	return result.stdout.trim().length > 0 ? { kind: "found" } : { kind: "absent" };
}

/**
 * `claim list`, additive and read-only: the ticket names under `refs/claims/*`, from the same single
 * `ls-remote` as `probeClaimRefs`, with the same racy snapshot semantics. Names that are not canonical ticket IDs are
 * counted as `skipped`, never guessed; nothing is fetched and no ref is written. It also returns `roots`, the object
 * name each listed ticket ref points to, for the acquisition stop of `claim next`.
 */
export async function listClaimRefs(
	options: ClaimStorageOptions,
): Promise<
	| { kind: "listed"; tickets: string[]; skipped: number; roots: Record<string, string> }
	| { kind: "failure"; reason: string }
> {
	const invalid = optionsError(options);
	if (invalid) return { kind: "failure", reason: invalid };
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await runGit(options.repository, timeoutMs, ["ls-remote", "--refs", options.remote, "refs/claims/*"]);
	if (result.code !== 0 || result.timedOut) return { kind: "failure", reason: errorReason(result) };
	const tickets: string[] = [];
	// Each listed ticket's root from the same one ls-remote, as Git printed it (like
	// `remoteRef`); the acquisition stop of `claim next` validates it before use.
	const roots: Record<string, string> = {};
	let skipped = 0;
	for (const line of result.stdout.split("\n")) {
		if (line.trim() === "") continue;
		const [root = "", ref = ""] = line.split("\t");
		const ticket = ref.startsWith("refs/claims/") ? ref.slice("refs/claims/".length) : "";
		if (!validTicket(ticket)) {
			skipped += 1;
		} else if (!tickets.includes(ticket)) {
			tickets.push(ticket);
			roots[ticket] = root;
		}
	}
	return { kind: "listed", tickets, skipped, roots };
}

/**
 * The descriptor a store was opened at, its epoch and the root a descriptor CAS leases on.
 * A store that has not read a descriptor (initialization, the descriptor read itself) is `UNOPENED`.
 */
type StoreScope = { epoch: number; descriptorRoot: string };
const UNOPENED: StoreScope = { epoch: 1, descriptorRoot: "" };

function validEpochTicket(entry: ClaimEpochTicket): boolean {
	return (
		isObject(entry) &&
		validTicket(entry.ticket) &&
		(entry.root === "" || validObjectId(entry.root)) &&
		isJsonObject(entry.payload)
	);
}

class ClaimGitStore implements ClaimStore {
	private readonly timeoutMs: number;

	constructor(
		private readonly repository: string,
		private readonly remote: string,
		private readonly format: ClaimStorageFormat,
		timeoutMs: number | undefined,
		private readonly scope: StoreScope,
		private readonly seams?: ClaimGitSeams,
	) {
		this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	private git(args: string[], input?: string, environment?: Record<string, string>): Promise<GitResult> {
		return runGit(this.repository, this.timeoutMs, args, input, this.seams, environment);
	}

	async routingError(): Promise<string | undefined> {
		const result = await this.git(["config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"]);
		if (result.code === 1 && !result.timedOut) return undefined;
		if (result.code !== 0 || result.timedOut) return "could not validate Git endpoint configuration";
		for (const entry of result.stdout.split("\0").filter(Boolean)) {
			const separator = entry.indexOf("\n");
			if (separator < 0) return "invalid Git URL rewrite configuration";
			const prefix = entry.slice(separator + 1);
			if (this.remote.startsWith(prefix)) return "Git URL rewrites must not redirect the claim endpoint";
		}
		return undefined;
	}

	private async remoteRef(
		ref: string,
	): Promise<{ kind: "found"; root: string } | { kind: "absent" } | { kind: "failure"; reason: string }> {
		const result = await this.git(["ls-remote", "--exit-code", "--refs", this.remote, ref]);
		if (result.code === 2 && !result.timedOut) return { kind: "absent" };
		if (result.code !== 0 || result.timedOut) return { kind: "failure", reason: errorReason(result) };
		const row = result.stdout.split("\n").find((line) => line.endsWith(`\t${ref}`));
		const root = row?.split("\t", 1)[0];
		if (!root) return { kind: "failure", reason: `git did not return ${ref}` };
		return { kind: "found", root };
	}

	private temporaryRef(): string {
		return `refs/backlog-md/claim-storage/read/${randomUUID()}`;
	}

	private async readObject(ref: string): Promise<RemoteObject> {
		const remote = await this.remoteRef(ref);
		if (remote.kind === "absent") return remote;
		if (remote.kind === "failure") return remote;

		const temporaryRef = this.temporaryRef();
		try {
			// The fetch's connectivity check enumerates every local ref; a concurrent read of this checkout drops its
			// own temporary ref inside that window, and git's default ref paranoia then turns the vanished ref into a
			// broken one that aborts the check. Skipping broken refs here only takes a `--not` tip away from the check,
			// so it verifies more, never less; the explicit value also beats an inherited GIT_REF_PARANOIA.
			const fetched = await this.git(
				[
					"fetch",
					"--no-write-fetch-head",
					"--no-tags",
					"--no-auto-maintenance",
					"--refmap=",
					"--no-recurse-submodules",
					this.remote,
					`${ref}:${temporaryRef}`,
				],
				undefined,
				{ GIT_REF_PARANOIA: "0" },
			);
			if (fetched.code !== 0 || fetched.timedOut) return { kind: "failure", reason: errorReason(fetched) };

			const resolved = await this.git(["rev-parse", "--verify", `${temporaryRef}^{object}`]);
			if (resolved.code !== 0 || resolved.timedOut) return { kind: "failure", reason: errorReason(resolved) };
			const root = resolved.stdout.trim();
			if (!root) return { kind: "failure", reason: "git did not return a claim object ID" };
			return { kind: "found", root };
		} finally {
			await this.git(["update-ref", "-d", temporaryRef]);
		}
	}

	private async blob(root: string): Promise<Extract<RemoteBlob, { kind: "found" | "corrupt" | "failure" }>> {
		const type = await this.git(["cat-file", "-t", root]);
		if (type.timedOut || type.error) return { kind: "failure", reason: errorReason(type) };
		if (type.code !== 0 || type.stdout.trim() !== "blob") {
			return { kind: "corrupt", reason: "expected a blob at the claim ref" };
		}
		const blob = await this.git(["cat-file", "blob", root]);
		if (blob.timedOut || blob.error) return { kind: "failure", reason: errorReason(blob) };
		if (blob.code !== 0) return { kind: "corrupt", reason: "expected a blob at the claim ref" };
		return { kind: "found", root, source: blob.stdout };
	}

	private async readBlob(ref: string): Promise<RemoteBlob> {
		const object = await this.readObject(ref);
		if (object.kind !== "found") return object;
		return this.blob(object.root);
	}

	private async readTree(ref: string): Promise<RemoteObject | { kind: "corrupt"; reason: string }> {
		const object = await this.readObject(ref);
		if (object.kind !== "found") return object;
		const type = await this.git(["cat-file", "-t", object.root]);
		if (type.timedOut || type.error) return { kind: "failure", reason: errorReason(type) };
		if (type.code !== 0 || type.stdout.trim() !== "tree") {
			return { kind: "corrupt", reason: "expected a tree at the claim ref" };
		}
		return object;
	}

	private async treeEntries(root: string): Promise<TreeEntries> {
		const type = await this.git(["cat-file", "-t", root]);
		if (type.timedOut || type.error) return { kind: "failure", reason: errorReason(type) };
		if (type.code !== 0 || type.stdout.trim() !== "tree") {
			return { kind: "corrupt", reason: "expected a tree at the claim ref" };
		}
		const listed = await this.git(["ls-tree", "-z", root]);
		if (listed.timedOut || listed.error) return { kind: "failure", reason: errorReason(listed) };
		if (listed.code !== 0) return { kind: "corrupt", reason: "could not read claim tree" };
		const entries: TreeEntry[] = [];
		for (const row of listed.stdout.split("\0").filter(Boolean)) {
			const tab = row.indexOf("\t");
			const fields = tab < 0 ? [] : row.slice(0, tab).split(" ");
			const [mode, typeName, object] = fields;
			if (fields.length !== 3 || !mode || !typeName || !object) {
				return { kind: "corrupt", reason: "claim tree has an invalid entry" };
			}
			entries.push({ mode, type: typeName, root: object, name: row.slice(tab + 1) });
		}
		return { kind: "found", entries };
	}

	private async decodeLayout(root: string): Promise<ClaimLayout | undefined> {
		const tree = await this.treeEntries(root);
		if (tree.kind !== "found" || tree.entries.length !== 2) return undefined;
		const byName = new Map(tree.entries.map((entry) => [entry.name, entry]));
		if (byName.size !== 2) return undefined;
		const state = byName.get("state");
		const receiptsTree = byName.get("receipts");
		if (
			state?.mode !== "100644" ||
			state.type !== "blob" ||
			receiptsTree?.mode !== "040000" ||
			receiptsTree.type !== "tree"
		) {
			return undefined;
		}
		const stateBlob = await this.blob(state.root);
		if (stateBlob.kind !== "found") return undefined;
		let stateValue: unknown;
		try {
			stateValue = JSON.parse(stateBlob.source);
		} catch {
			return undefined;
		}
		if (!isObject(stateValue) || Object.hasOwn(stateValue, "receipts")) return undefined;

		const receiptEntries = await this.treeEntries(receiptsTree.root);
		if (receiptEntries.kind !== "found") return undefined;
		const receipts = Object.create(null) as Record<string, JsonObject>;
		for (const entry of receiptEntries.entries) {
			if (!validOperationId(entry.name) || entry.mode !== "100644" || entry.type !== "blob") return undefined;
			const receiptBlob = await this.blob(entry.root);
			if (receiptBlob.kind !== "found") return undefined;
			let receipt: unknown;
			try {
				receipt = JSON.parse(receiptBlob.source);
			} catch {
				return undefined;
			}
			if (!isJsonObject(receipt) || Object.hasOwn(receipts, entry.name)) return undefined;
			receipts[entry.name] = receipt;
		}
		return { state: stateValue, receipts };
	}

	private async decodeTree(root: string, ticket: string): Promise<ClaimDocument | undefined> {
		const layout = await this.decodeLayout(root);
		if (!layout) return undefined;
		const document = { ...layout.state, receipts: layout.receipts };
		return validDocument(document, ticket, "tree", this.scope.epoch) ? document : undefined;
	}

	private async commitHeader(root: string): Promise<{ tree: string; parents: string[] } | undefined> {
		const type = await this.git(["cat-file", "-t", root]);
		if (type.code !== 0 || type.timedOut || type.error || type.stdout.trim() !== "commit") return undefined;
		const commit = await this.git(["cat-file", "commit", root]);
		if (commit.code !== 0 || commit.timedOut || commit.error) return undefined;
		const separator = commit.stdout.indexOf("\n\n");
		if (separator < 0) return undefined;
		const headers = commit.stdout.slice(0, separator).split("\n");
		const trees = headers.filter((header) => header.startsWith("tree ")).map((header) => header.slice(5));
		const parents = headers.filter((header) => header.startsWith("parent ")).map((header) => header.slice(7));
		if (trees.length !== 1 || !validObjectId(trees[0]) || !parents.every(validObjectId)) return undefined;
		return { tree: trees[0], parents };
	}

	private async decodeChain(root: string, ticket: string): Promise<ClaimDocument | undefined> {
		const receipts = Object.create(null) as Record<string, JsonObject>;
		const visited = new Set<string>();
		let current: string | undefined = root;
		let headState: Record<string, unknown> | undefined;
		let nextRevision: number | undefined;
		while (current) {
			if (visited.has(current)) return undefined;
			visited.add(current);
			const commit = await this.commitHeader(current);
			if (!commit) return undefined;
			const layout = await this.decodeLayout(commit.tree);
			if (!layout) return undefined;
			const delta = Object.entries(layout.receipts);
			if (delta.length !== 1) return undefined;
			const layer = { ...layout.state, receipts: layout.receipts };
			if (!validDocument(layer, ticket, "commit-chain", this.scope.epoch)) return undefined;
			if (nextRevision !== undefined && layer.revision !== nextRevision) return undefined;
			headState ??= layout.state;
			const first = delta[0];
			if (!first) return undefined;
			const [operationId, receipt] = first;
			if (Object.hasOwn(receipts, operationId)) return undefined;
			receipts[operationId] = receipt;
			if (layer.revision === 1) {
				if (commit.parents.length !== 0) return undefined;
				break;
			}
			if (commit.parents.length !== 1) return undefined;
			nextRevision = layer.revision - 1;
			current = commit.parents[0];
		}
		if (!headState) return undefined;
		const document = { ...headState, receipts };
		return validDocument(document, ticket, "commit-chain", this.scope.epoch) ? document : undefined;
	}

	private async decodeRoot(root: string, ticket: string): Promise<ClaimDocument | undefined> {
		if (this.format === "blob") {
			const blob = await this.blob(root);
			return blob.kind === "found" ? decodeDocument(blob.source, ticket, "blob", this.scope.epoch) : undefined;
		}
		return this.format === "tree" ? this.decodeTree(root, ticket) : this.decodeChain(root, ticket);
	}

	async descriptor(): Promise<DescriptorRead> {
		const blob = await this.readBlob(DESCRIPTOR_REF);
		if (blob.kind === "absent") return blob;
		if (blob.kind === "corrupt") return blob;
		if (blob.kind === "failure") return { kind: "unreachable", reason: blob.reason };
		return decodeDescriptor(blob.source, blob.root);
	}

	async writeBlob(value: JsonValue): Promise<{ kind: "written"; root: string } | { kind: "failure"; reason: string }> {
		const result = await this.git(["hash-object", "-w", "--stdin"], `${canonicalJson(value)}\n`);
		if (result.code !== 0 || result.timedOut) return { kind: "failure", reason: errorReason(result) };
		const root = result.stdout.trim();
		if (!root) return { kind: "failure", reason: "git did not return a blob object ID" };
		return { kind: "written", root };
	}

	private async writeLayout(
		state: JsonObject,
		receipts: Record<string, JsonObject>,
	): Promise<{ kind: "written"; root: string } | { kind: "failure"; reason: string }> {
		const stateBlob = await this.writeBlob(state);
		if (stateBlob.kind === "failure") return stateBlob;
		const receiptRows: string[] = [];
		for (const [operationId, receipt] of Object.entries(receipts).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		)) {
			const receiptBlob = await this.writeBlob(receipt);
			if (receiptBlob.kind === "failure") return receiptBlob;
			receiptRows.push(`100644 blob ${receiptBlob.root}\t${operationId}\n`);
		}
		const receiptTree = await this.git(["mktree"], receiptRows.join(""));
		if (receiptTree.code !== 0 || receiptTree.timedOut) return { kind: "failure", reason: errorReason(receiptTree) };
		const receiptRoot = receiptTree.stdout.trim();
		if (!receiptRoot) return { kind: "failure", reason: "git did not return a receipt tree object ID" };
		const rootTree = await this.git(
			["mktree"],
			`100644 blob ${stateBlob.root}\tstate\n040000 tree ${receiptRoot}\treceipts\n`,
		);
		if (rootTree.code !== 0 || rootTree.timedOut) return { kind: "failure", reason: errorReason(rootTree) };
		const root = rootTree.stdout.trim();
		if (!root) return { kind: "failure", reason: "git did not return a claim tree object ID" };
		return { kind: "written", root };
	}

	private async writeTree(
		document: ClaimDocument,
	): Promise<{ kind: "written"; root: string } | { kind: "failure"; reason: string }> {
		return this.writeLayout(stateOf(document), document.receipts);
	}

	private async writeChain(
		document: ClaimDocument,
		change: ClaimChange,
		parent: string | undefined,
	): Promise<{ kind: "written"; root: string } | { kind: "failure"; reason: string }> {
		const tree = await this.writeLayout(stateOf(document), { [change.operationId]: change.receipt });
		if (tree.kind === "failure") return tree;
		const headers = [
			`tree ${tree.root}`,
			...(parent ? [`parent ${parent}`] : []),
			"author Backlog.md Claims <claims@backlog.invalid> 0 +0000",
			"committer Backlog.md Claims <claims@backlog.invalid> 0 +0000",
		];
		const result = await this.git(
			["hash-object", "-t", "commit", "-w", "--stdin"],
			`${headers.join("\n")}\n\nclaim ${document.ticket} revision ${document.revision}\n`,
		);
		if (result.code !== 0 || result.timedOut) return { kind: "failure", reason: errorReason(result) };
		const root = result.stdout.trim();
		if (!root) return { kind: "failure", reason: "git did not return a claim commit object ID" };
		return { kind: "written", root };
	}

	/**
	 * Porcelain `=` (up to date: the ref already holds `root`) is reported apart, since Git checks no lease then. A
	 * claim write treats it as an unknown outcome as before; the descriptor swap reads it as a lost CAS (ep-g08).
	 */
	async push(
		ref: string,
		expectedRoot: string,
		root: string,
	): Promise<ClaimWriteResult | { kind: "applied" } | { kind: "up-to-date"; reason: string }> {
		const result = await this.git([
			"push",
			"--porcelain",
			`--force-with-lease=${ref}:${expectedRoot}`,
			this.remote,
			`${root}:${ref}`,
		]);
		if (result.timedOut || result.error) return { kind: "unknown", reason: errorReason(result) };

		const row = result.stdout
			.split("\n")
			.map((line) => line.split("\t"))
			.find((fields) => fields.length >= 2 && fields[1]?.endsWith(`:${ref}`));
		if (!row?.[0]) return { kind: "unknown", reason: errorReason(result) };
		const status = row[0];
		const summary = row.slice(2).join("\t");
		if (status === "*" || status === "+" || status === " ") return { kind: "applied" };
		if (status === "=") return { kind: "up-to-date", reason: summary };
		if (status === "!") {
			if (summary.includes("stale info")) return { kind: "rejected", cause: "stale", reason: summary };
			if (summary.includes("remote rejected")) return { kind: "rejected", cause: "remote", reason: summary };
		}
		return { kind: "unknown", reason: summary || errorReason(result) };
	}

	async read(ticket: string): Promise<ClaimReadResult> {
		if (!validTicket(ticket)) return { kind: "invalid", reason: "ticket ID must already be canonical" };
		const routing = await this.routingError();
		if (routing) return { kind: "invalid", reason: routing };
		if (this.format === "blob") {
			const blob = await this.readBlob(`refs/claims/${ticket}`);
			if (blob.kind === "absent") return { kind: "absent", ticket };
			if (blob.kind === "corrupt") return blob;
			if (blob.kind === "failure") return { kind: "unreachable", reason: blob.reason };
			const document = decodeDocument(blob.source, ticket, "blob", this.scope.epoch);
			if (!document) return { kind: "corrupt", reason: "claim blob has an invalid document" };
			return { kind: "present", ticket, root: blob.root, document };
		}
		if (this.format === "tree") {
			const tree = await this.readTree(`refs/claims/${ticket}`);
			if (tree.kind === "absent") return { kind: "absent", ticket };
			if (tree.kind === "corrupt") return tree;
			if (tree.kind === "failure") return { kind: "unreachable", reason: tree.reason };
			const document = await this.decodeTree(tree.root, ticket);
			if (!document) return { kind: "corrupt", reason: "claim tree has an invalid document" };
			return { kind: "present", ticket, root: tree.root, document };
		}
		const commit = await this.readObject(`refs/claims/${ticket}`);
		if (commit.kind === "absent") return { kind: "absent", ticket };
		if (commit.kind === "failure") return { kind: "unreachable", reason: commit.reason };
		const document = await this.decodeChain(commit.root, ticket);
		if (!document) return { kind: "corrupt", reason: "claim commit chain has an invalid document" };
		return { kind: "present", ticket, root: commit.root, document };
	}

	async write(base: ClaimSnapshot, change: ClaimChange): Promise<ClaimWriteResult> {
		if (!base || !validTicket(base.ticket) || (base.kind !== "absent" && base.kind !== "present")) {
			return { kind: "invalid", reason: "invalid claim snapshot or noncanonical ticket ID" };
		}
		if (
			!change ||
			!validOperationId(change.operationId) ||
			!isJsonObject(change.receipt) ||
			!isJsonObject(change.payload)
		) {
			return { kind: "invalid", reason: "operation ID, receipt and payload must be valid JSON claim inputs" };
		}
		if (base.kind === "present") {
			if (
				!validObjectId(base.root) ||
				!validDocument(base.document, base.ticket, this.format, this.scope.epoch) ||
				base.document.revision === Number.MAX_SAFE_INTEGER ||
				Object.hasOwn(base.document.receipts, change.operationId)
			) {
				return { kind: "invalid", reason: "invalid snapshot, exhausted revision or duplicate operation ID" };
			}
			const original = await this.decodeRoot(base.root, base.ticket);
			if (!original || canonicalJson(original) !== canonicalJson(base.document)) {
				return { kind: "invalid", reason: "snapshot document does not match its root" };
			}
		}
		const routing = await this.routingError();
		if (routing) return { kind: "invalid", reason: routing };
		const ticket = base.ticket;
		const document: ClaimDocument =
			base.kind === "absent"
				? {
						schema: 1,
						format: this.format,
						epoch: this.scope.epoch,
						ticket,
						revision: 1,
						payload: change.payload,
						receipts: { [change.operationId]: change.receipt },
					}
				: {
						...base.document,
						revision: base.document.revision + 1,
						payload: change.payload,
						receipts: { ...base.document.receipts, [change.operationId]: change.receipt },
					};
		const encoded = await this.encode(document, change, base.kind === "present" ? base.root : undefined);
		if (encoded.kind === "failure") return { kind: "not-sent", reason: encoded.reason };
		const ref = `refs/claims/${ticket}`;
		const pushed = await this.push(ref, base.kind === "present" ? base.root : "", encoded.root);
		if (pushed.kind === "up-to-date") return { kind: "unknown", reason: pushed.reason };
		if (pushed.kind === "rejected" && pushed.cause === "remote") {
			// The endpoint's refusal proves nothing about the ref by
			// itself. Re-reading tells apart an overlapping loser (the ref moved or appeared) from a refusal at an
			// unchanged ref (a hook policy, a permission, a lock); a failed re-read proves nothing either way.
			const reread = await this.remoteRef(ref);
			if (reread.kind === "found" && reread.root === encoded.root) {
				return { kind: "unknown", reason: REREAD_LANDED_REASON };
			}
			const stale =
				reread.kind === "found"
					? base.kind === "absent" || reread.root !== base.root
					: reread.kind === "absent" && base.kind === "present";
			if (stale) return { kind: "rejected", cause: "stale", reason: REREAD_STALE_REASON };
		}
		if (pushed.kind !== "applied") return pushed;
		return { kind: "applied", root: encoded.root, document };
	}

	/** The one encoder of `write` and `installEpoch`: the document in this store's format, a chain layer on `parent`. */
	private encode(
		document: ClaimDocument,
		change: ClaimChange,
		parent: string | undefined,
	): Promise<{ kind: "written"; root: string } | { kind: "failure"; reason: string }> {
		if (this.format === "blob") return this.writeBlob(document);
		return this.format === "tree" ? this.writeTree(document) : this.writeChain(document, change, parent);
	}

	/**
	 * The descriptor CAS to the next epoch, leased on the descriptor this store opened.
	 * A remote refusal is read again like initialization does: a descriptor found at another root means the epoch
	 * changed; one still at the leased root was declined by the endpoint. A re-read that finds nothing usable (the
	 * endpoint is unreachable, the descriptor is corrupt, absent or of an unsupported schema) is no evidence that the
	 * descriptor moved: the refusal is declined, and its reason names both facts.
	 */
	async swapEpoch(format: ClaimStorageFormat): Promise<ClaimEpochSwapResult> {
		const { epoch, descriptorRoot } = this.scope;
		const parsedFormat = parseClaimStorageFormat(format);
		if (parsedFormat.kind === "invalid") return parsedFormat;
		if (!validObjectId(descriptorRoot) || !Number.isSafeInteger(epoch + 1)) {
			return { kind: "invalid", reason: "the claim store was not opened at a descriptor" };
		}
		const routing = await this.routingError();
		if (routing) return { kind: "invalid", reason: routing };
		const next: ClaimStorageDescriptor = { schema: 1, format: parsedFormat.format, epoch: epoch + 1 };
		const encoded = await this.writeBlob(next);
		if (encoded.kind === "failure") return { kind: "not-sent", reason: encoded.reason };
		const pushed = await this.push(DESCRIPTOR_REF, descriptorRoot, encoded.root);
		if (pushed.kind === "applied") return { kind: "swapped", descriptor: next };
		// The next descriptor is content-addressed: `up-to-date` means another run already set this very descriptor,
		// so the leased root is gone and this run lost the CAS without writing anything (ep-g08).
		if (pushed.kind === "up-to-date") return { kind: "epoch-changed" };
		if (pushed.kind !== "rejected") return { kind: "unknown", reason: pushed.reason };
		if (pushed.cause === "remote") {
			const current = await this.descriptor();
			if (current.kind === "found" && current.root !== descriptorRoot) return { kind: "epoch-changed" };
			if (current.kind === "found") return { kind: "declined", reason: pushed.reason };
			const unread =
				current.kind === "absent"
					? "the descriptor is absent"
					: current.kind === "schema-unsupported"
						? "the descriptor schema is unsupported"
						: current.reason;
			return { kind: "declined", reason: `${pushed.reason}; the descriptor could not be read afterwards: ${unread}` };
		}
		return { kind: "epoch-changed" };
	}

	/**
	 * Per ticket, first the old root under
	 * `refs/claim-archive/<old epoch>/<TICKET>` (created, empty lease), then the ticket ref, leased on that root or
	 * created, set to a fresh document of the swapped epoch: revision 1, the given payload and one maintenance receipt
	 * under one `m-<uuid v4>` per run; a chain layer has no parent. Every root is new, since its content names the new
	 * epoch; no ref is deleted. A ticket whose archive or rewrite did not apply is `unsettled` and left as it is.
	 */
	async installEpoch(plan: ClaimEpochPlan): Promise<ClaimEpochInstallResult> {
		const { descriptor, tickets } = plan;
		const parsedFormat = parseClaimStorageFormat(descriptor.format);
		if (
			parsedFormat.kind === "invalid" ||
			descriptor.epoch !== this.scope.epoch + 1 ||
			!tickets.every(validEpochTicket)
		) {
			return { kind: "invalid", reason: "invalid claim maintenance plan" };
		}
		const scope = { epoch: descriptor.epoch, descriptorRoot: "" };
		const target = new ClaimGitStore(
			this.repository,
			this.remote,
			parsedFormat.format,
			this.timeoutMs,
			scope,
			this.seams,
		);
		const receiptId = `m-${randomUUID()}`;
		const receipt: JsonObject = {
			schema: 1,
			kind: "epoch",
			fromEpoch: this.scope.epoch,
			epoch: descriptor.epoch,
			isolation: "attested",
		};
		const roots: Record<string, string> = {};
		const unsettled: string[] = [];
		for (const { ticket, root, payload } of tickets) {
			if (root !== "") {
				const archived = await this.push(`refs/claim-archive/${this.scope.epoch}/${ticket}`, "", root);
				if (archived.kind !== "applied") {
					unsettled.push(ticket);
					continue;
				}
			}
			const document: ClaimDocument = {
				schema: 1,
				format: parsedFormat.format,
				epoch: descriptor.epoch,
				ticket,
				revision: 1,
				payload,
				receipts: { [receiptId]: receipt },
			};
			const encoded = await target.encode(document, { operationId: receiptId, receipt, payload }, undefined);
			if (encoded.kind === "written") {
				const pushed = await this.push(`refs/claims/${ticket}`, root, encoded.root);
				if (pushed.kind === "applied") {
					roots[ticket] = encoded.root;
					continue;
				}
			}
			unsettled.push(ticket);
		}
		return { kind: "written", roots, unsettled };
	}
}

const NOT_A_GIT_STORE = "the claim store is not a Git claim store";

/** For `claim install-epoch` only; not a public API. See `swapEpoch`. */
export function swapClaimEpoch(store: ClaimStore, format: ClaimStorageFormat): Promise<ClaimEpochSwapResult> {
	if (!(store instanceof ClaimGitStore)) return Promise.resolve({ kind: "invalid", reason: NOT_A_GIT_STORE });
	return store.swapEpoch(format);
}

/**
 * For `claim install-epoch` only; not a public API. `store` is the store the
 * run opened at the old epoch; see `installEpoch`.
 */
export function installClaimEpoch(store: ClaimStore, plan: ClaimEpochPlan): Promise<ClaimEpochInstallResult> {
	if (!(store instanceof ClaimGitStore)) return Promise.resolve({ kind: "invalid", reason: NOT_A_GIT_STORE });
	return store.installEpoch(plan);
}

export function parseClaimStorageFormat(
	raw: unknown,
): { kind: "valid"; format: ClaimStorageFormat } | { kind: "invalid"; reason: string } {
	if (raw === "blob" || raw === "tree" || raw === "commit-chain") return { kind: "valid", format: raw };
	return { kind: "invalid", reason: "claim storage format must be blob, tree, or commit-chain" };
}

export async function initializeClaimStorage(options: ClaimStorageOptions): Promise<ClaimInitializeResult> {
	const invalid = optionsError(options);
	if (invalid) return { kind: "invalid", reason: invalid };
	const parsedFormat = parseClaimStorageFormat(options.format);
	if (parsedFormat.kind === "invalid") return parsedFormat;
	const store = new ClaimGitStore(
		options.repository,
		options.remote,
		parsedFormat.format,
		options.timeoutMs,
		UNOPENED,
		options.seams,
	);
	const routing = await store.routingError();
	if (routing) return { kind: "invalid", reason: routing };
	const descriptor = await store.descriptor();
	if (descriptor.kind === "found") {
		return descriptor.descriptor.format === parsedFormat.format
			? { kind: "exists", descriptor: descriptor.descriptor }
			: { kind: "conflict", descriptor: descriptor.descriptor };
	}
	if (descriptor.kind === "schema-unsupported")
		return { kind: "corrupt", reason: "format descriptor schema is unsupported" };
	if (descriptor.kind === "corrupt" || descriptor.kind === "unreachable") return descriptor;

	const expected = { schema: 1, format: parsedFormat.format, epoch: 1 } as const;
	const encoded = await store.writeBlob(expected);
	if (encoded.kind === "failure") return { kind: "not-sent", reason: encoded.reason };
	const pushed = await store.push(DESCRIPTOR_REF, "", encoded.root);
	if (pushed.kind === "applied") return { kind: "created", descriptor: expected };
	// A same-format loser's descriptor blob is byte-identical to the
	// winner's, so Git answers `=` (`up-to-date`) before any lease check (ep-g08) — that race ends here too,
	// read again exactly like a `rejected` push.
	if (pushed.kind !== "rejected" && pushed.kind !== "up-to-date") return { kind: "unknown", reason: pushed.reason };

	const afterRace = await store.descriptor();
	if (afterRace.kind === "found") {
		return afterRace.descriptor.format === parsedFormat.format
			? { kind: "exists", descriptor: afterRace.descriptor }
			: { kind: "conflict", descriptor: afterRace.descriptor };
	}
	if (afterRace.kind === "schema-unsupported")
		return { kind: "corrupt", reason: "format descriptor schema is unsupported" };
	if (afterRace.kind === "corrupt" || afterRace.kind === "unreachable") return afterRace;
	if (afterRace.kind === "absent" && pushed.kind === "rejected" && pushed.cause === "remote")
		return { kind: "rejected", cause: "remote", reason: pushed.reason };
	return { kind: "unknown", reason: "format descriptor is absent after an unapplied initialization" };
}

export async function openClaimStore(options: ClaimStorageOptions): Promise<ClaimOpenResult> {
	const invalid = optionsError(options);
	if (invalid) return { kind: "invalid", reason: invalid };
	const parsedFormat = parseClaimStorageFormat(options.format);
	if (parsedFormat.kind === "invalid") return parsedFormat;
	const { repository, remote, timeoutMs, seams } = options;
	const reader = new ClaimGitStore(repository, remote, parsedFormat.format, timeoutMs, UNOPENED, seams);
	const routing = await reader.routingError();
	if (routing) return { kind: "invalid", reason: routing };
	const descriptor = await reader.descriptor();
	if (descriptor.kind === "absent") return { kind: "descriptor-missing" };
	if (descriptor.kind === "schema-unsupported") return descriptor;
	if (descriptor.kind === "corrupt" || descriptor.kind === "unreachable") return descriptor;
	if (descriptor.descriptor.format !== parsedFormat.format)
		return { kind: "format-mismatch", descriptor: descriptor.descriptor };
	// The store reads and writes documents of the descriptor's epoch and leases a swap on its root.
	const scope = { epoch: descriptor.descriptor.epoch, descriptorRoot: descriptor.root };
	const store = new ClaimGitStore(repository, remote, parsedFormat.format, timeoutMs, scope, seams);
	return { kind: "open", store, descriptor: descriptor.descriptor };
}
