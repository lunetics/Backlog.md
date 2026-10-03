/**
 * Level E: the real `backlog claim … --json` subprocess and the MCP tool `claim_acquire` over the stdio server of the
 * real CLI (`backlog mcp start`) against an endpoint that carries credentials. Pinned here: `claim setup` refuses a
 * credential URL as `config-invalid`/`unsupported-endpoint`, writes nothing, contacts nothing and prints no part of the
 * credential in JSON or text (ec-01); a configured credential endpoint makes `claim init`, `claim acquire`, `claim
 * list` and `claim_acquire` refuse the same way before any contact with the endpoint (ec-02); `ssh://git@…` passes
 * `claim setup` byte-equal and the preflight, which hands the username to Git's SSH transport (ec-03); the guide as the
 * CLI renders it and CLAIMS.md carry the mandatory sentence, `claim setup --help` both option texts, and no claim help
 * example carries userinfo (ec-04). "No contact" is the connection counter of a stalled endpoint
 * (claim-git-fixture.ts StallProxy) plus no trace2 `start` of a Git command that talks to a remote (the CLI start may
 * run Git for repository detection); setup additionally leaves config.yml byte-equal. ec-01, ec-02 and ec-04 start
 * with a positive control that the product before the credential check (every userinfo accepted, old message and
 * descriptions, no sentence) fails; ec-03 is the control a rule refusing ssh usernames fails, green before and after.
 * 4 test definitions, 4 runs, blob only (the refusals come before any storage format matters). Harness: adapted copies
 * with "adapted from" notes; every existing file stays unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { $ } from "bun";
import { createClaimContext } from "../claims/context/index.ts";
import { CLAIM_EXIT_CODES } from "../claims/surface/index.ts";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { GitFixtureServer, StallProxy } from "./fixtures/claim-git-fixture.ts";
import { getTestCliPath } from "./test-cli.ts";
import { initializeFilesystemTestProject } from "./test-utils.ts";

type CliRun = { exit: number; stdout: string; stderr: string };
type JsonRun = CliRun & { doc: unknown };
type Sentinel = readonly [label: string, value: string];

const CLI_PATH = getTestCliPath();
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TEST_TIMEOUT = 60_000;
/** attempt_timeout_ms against the stalled endpoint (claim-epoch-cli.test.ts:173). */
const STALL_TIMEOUT = 750;
const MINUTE = 60_000;
const BLOCK_TTL = 5 * MINUTE;
const TTL = 2 * MINUTE;
const GRACE = 10 * MINUTE;
const EPS = 2_000;
const OWNER = "agent-owner-endpoint";
const TICKET = "BACK-1";
const TRACE_VARIABLE = "GIT_TRACE2_EVENT";
/** The three parts of a credential endpoint, each distinctive, so a leak names the part it came from. */
const USER = "SENTINEL-k16-user-91e2";
const PASSWORD = "SENTINEL-k16-password-5b07";
const PATH_MARK = "SENTINEL-k16-path-c38d";
/** Git commands that talk to a remote; a refusal before Git starts none of them. */
const NETWORK_COMMANDS = ["ls-remote", "fetch", "push", "send-pack", "upload-pack", "remote-http", "remote-https"];
/**
 * Verbatim, in the guide (as rendered) and in CLAIMS.md; re-pinned in the claims close-out:
 * the sentence names the code `config-invalid` and the problem `unsupported-endpoint` on `claims.endpoint`, as the
 * refusal documents carry them (REFUSED below).
 */
const MANDATORY_SENTENCE = [
	"The endpoint URL never carries credentials: `user:password@` and token-in-URL forms are refused as `config-invalid`",
	"with the problem `unsupported-endpoint` on `claims.endpoint`. Authenticate with SSH keys or a Git credential helper;",
	"both are ordinary Git configuration and pass through unchanged.",
].join(" ");
/**
 * Both `--endpoint` texts of `claim setup --help`, each at its option and normalized — the help
 * schema line (claim.ts:967) and the Commander option line (claim.ts:975).
 */
const ENDPOINT_TEXTS = [
	"--endpoint: Git URL - explicit git://, ssh://, http://, https:// or file:// URL without credentials",
	"--endpoint <url> claim coordination endpoint URL without credentials",
];
/** A URL authority with userinfo, or a bare `user:`: none may appear in a help example. */
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@|\buser:/i;
const CLAIMS_PATH = join(import.meta.dir, "..", "..", "CLAIMS.md");
/** The refusal of every surface: exit 5, `config-invalid`, the endpoint problem. */
const REFUSED = {
	exit: CLAIM_EXIT_CODES.refused,
	kind: "claim-error",
	status: "refused",
	code: "config-invalid",
	problems: [{ key: "claims.endpoint", problem: "unsupported-endpoint" }],
};

let fixtureServer: GitFixtureServer | undefined;
let stall: StallProxy | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
	stall = await StallProxy.create();
});

afterAll(async () => {
	await stall?.close();
	await fixtureServer?.close();
});

// adapted from claim-epoch-cli.test.ts:360-364
function gitServer(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function proxy(): StallProxy {
	if (!stall) throw new Error("stall proxy was not started");
	return stall;
}

// adapted from claim-epoch-cli.test.ts:366-370
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-epoch-cli.test.ts:384-388
function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

// adapted from claim-epoch-cli.test.ts:401-403
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// adapted from claim-epoch-cli.test.ts:405-409
function echoedIn(text: string, sentinels: readonly Sentinel[]): string[] {
	return sentinels.filter(([, value]) => value.length > 0 && text.includes(value)).map(([label]) => label);
}

/** The fixture environment without BACKLOG_CWD plus `extra` (a trace2 file, an SSH command). */
// adapted from claim-epoch-cli.test.ts:411-415
function cliEnv(extra: Record<string, string>): Record<string, string> {
	const base = Object.entries(gitServer().env).filter(([key]) => key !== BACKLOG_CWD_ENV);
	return { ...Object.fromEntries(base), ...extra };
}

// adapted from claim-epoch-cli.test.ts:417-421: an extra environment per call
async function runCli(cwd: string, args: readonly string[], extra: Record<string, string> = {}): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(cliEnv(extra)).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// adapted from claim-epoch-cli.test.ts:429-436
function parseDocument(stdout: string | null): unknown {
	try {
		return JSON.parse(stdout ?? "");
	} catch {
		return { kind: "unparsable" };
	}
}

/** Exit, envelope, code and the problems without their messages (a message is never compared). */
function refusalView(exit: number, doc: unknown): Record<string, unknown> {
	const problems = field(doc, "problems");
	return {
		exit,
		kind: field(doc, "kind") ?? null,
		status: field(doc, "status") ?? null,
		code: field(doc, "code") ?? null,
		problems: Array.isArray(problems)
			? problems.map((item) => ({ key: field(item, "key"), problem: field(item, "problem") }))
			: null,
	};
}

/**
 * The argv of every trace2 `start` event in `tracePath`: every Git process started while the variable pointed there.
 */
// adapted from claim-epoch-git.test.ts:414-433 (gitStartsOf)
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
			continue;
		}
		const argv = field(event, "argv");
		if (field(event, "event") === "start" && Array.isArray(argv)) commands.push(argv.map(String));
	}
	return commands;
}

/** The Git subcommand of a trace2 argv (`git -c k=v ls-remote …` → `ls-remote`), for the network filter. */
function subcommandOf(argv: readonly string[]): string {
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "-c" || arg === "-C") index++;
		else if (!arg.startsWith("-")) return arg;
	}
	return "";
}

function networkStarts(starts: readonly string[][]): string[] {
	return starts.map(subcommandOf).filter((name) => NETWORK_COMMANDS.includes(name));
}

// adapted from claim-mcp-cli.test.ts:155-172 (claimsBlock): the lease block, the attempt timeout of the stalled endpoint
function claimsBlock(endpoint: string): string {
	return [
		"claims:",
		"  enabled: true",
		`  endpoint: ${JSON.stringify(endpoint)}`,
		"  storage_format: blob",
		"  lifetime_mode: lease",
		`  lease_ttl_ms: ${BLOCK_TTL}`,
		`  reclaim_grace_ms: ${GRACE}`,
		`  attempt_timeout_ms: ${STALL_TIMEOUT}`,
		"  attempts: 3",
		"  operation_budget_ms: 30000",
		`  clock_uncertainty_ms: ${EPS}`,
		"  retry_pause_base_ms: 1",
		"  retry_pause_max_ms: 1",
	].join("\n");
}

/** A Backlog project with task prefix BACK, the one ticket, the claims block (or none) and one commit. */
// adapted from claim-mcp-cli.test.ts:174-198 (initProject): the block is optional, for `claim setup`
async function initProject(directory: string, block: string | null): Promise<void> {
	await mkdir(directory);
	const core = new Core(directory);
	await initializeFilesystemTestProject(core, "Claim endpoint CLI");
	const config = await core.filesystem.loadConfig();
	if (!config) throw new Error("the project configuration was not written");
	const prefixes = { ...config.prefixes, task: "BACK" };
	await core.filesystem.saveConfig(
		block === null ? { ...config, prefixes } : { ...config, prefixes, claimsYaml: block },
	);
	const task = {
		id: TICKET,
		title: `Claim target ${TICKET}`,
		status: "To Do",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-30",
		rawContent: "",
	};
	await core.filesystem.saveTask(task);
	await new Core(directory).ensureConfigMigrated();
	await gitServer().git(directory, ["init", "--quiet", "--initial-branch=main"]);
	await gitServer().git(directory, ["add", "-A"]);
	await gitServer().git(directory, ["commit", "--quiet", "-m", "seed"]);
}

/** A private context through the context API, never the CLI under test; its directory. */
// adapted from claim-mcp-cli.test.ts:216-221
async function newContext(parent: string): Promise<string> {
	const created = await createClaimContext({ parent });
	if (created.kind !== "created") throw new Error(`fixture: context creation failed (${created.kind})`);
	return dirname(created.context.journalDirectory);
}

function setupArgs(endpoint: string): string[] {
	return ["claim", "setup", "--endpoint", endpoint, "--storage-format", "blob", "--clock-uncertainty-ms", String(EPS)];
}

function acquireArgs(context: string, operationId: string): string[] {
	const options = ["--ttl-ms", String(TTL), "--operation-id", operationId];
	return ["claim", "acquire", TICKET, "--owner", OWNER, "--context", context, ...options];
}

/** Headings and sections as claim-epoch-cli.test.ts:663-690 reads them; `normalized` as :724-732. */
function normalized(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s*>\s?/, ""))
		.join(" ")
		.replace(/\s+/g, " ");
}

/** The lines of every `Examples:` block of a help text, up to its first empty line. */
function examplesOf(help: string): string[] {
	const lines = help.split("\n");
	const found: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (line.trim() !== "Examples:") continue;
		for (const example of lines.slice(index + 1)) {
			if (example.trim() === "") break;
			found.push(example.trim());
		}
	}
	return found;
}

/** The subcommand names of `backlog claim --help` (Commander's `Commands:` block). */
function subcommandsOf(help: string): string[] {
	const lines = help.split("\n");
	const start = lines.indexOf("Commands:");
	if (start < 0) return [];
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "") break;
		const name = /^ {2}([a-z][a-z-]*)\b/.exec(line)?.[1];
		if (name !== undefined && name !== "help") names.push(name);
	}
	return names;
}

/** One case: a root with a context parent, a trace2 file and the collected outputs for the leak scan. */
class EndpointCase {
	private readonly outputs: { command: string; text: string }[] = [];

	private constructor(
		readonly root: string,
		readonly parent: string,
		readonly tracePath: string,
	) {}

	static async create(label: string): Promise<EndpointCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, `claim-endpoint-cli-${label}-`));
		const parent = join(root, "contexts");
		await mkdir(parent);
		await chmod(parent, 0o700);
		return new EndpointCase(root, parent, join(root, "trace2-events.json"));
	}

	async project(name: string, block: string | null): Promise<string> {
		const directory = join(this.root, name);
		await initProject(directory, block);
		return directory;
	}

	/** One CLI call with the case's trace2 file; `json` adds `--json` and parses stdout. */
	async cli(project: string, args: readonly string[], extra: Record<string, string> = {}): Promise<CliRun> {
		const run = await runCli(project, args, { [TRACE_VARIABLE]: this.tracePath, ...extra });
		this.outputs.push({ command: args.slice(0, 2).join(" "), text: `${run.stdout}${run.stderr}` });
		return run;
	}

	async json(project: string, args: readonly string[], extra: Record<string, string> = {}): Promise<JsonRun> {
		const run = await this.cli(project, [...args, "--json"], extra);
		return { ...run, doc: parseDocument(run.stdout) };
	}

	/**
	 * One tool call over the stdio server of the real CLI on `project`, traced like a CLI call; the text item, the
	 * structured content and the server's stderr go to the leak scan.
	 */
	// adapted from mcp-stdio-exit.test.ts:163-199: the fixture environment, stderr kept, no listTools step
	async mcp(project: string, tool: string, args: Record<string, unknown>): Promise<{ doc: unknown; text: string }> {
		let stderr = "";
		let body = "";
		let structured: unknown = null;
		const transport = new StdioClientTransport({
			command: "bun",
			args: [CLI_PATH, "mcp", "start", "--cwd", project],
			cwd: project,
			env: cliEnv({ [TRACE_VARIABLE]: this.tracePath }),
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const client = new Client({ name: "claim-endpoint-cli", version: "1.0.0" }, { capabilities: {} });
		try {
			await client.connect(transport);
			const result = await client.callTool({ name: tool, arguments: args });
			const items: unknown[] = Array.isArray(result.content) ? result.content : [];
			const text = field(items[0], "text");
			body = typeof text === "string" ? text : "";
			structured = result.structuredContent ?? null;
		} finally {
			await client.close();
			this.outputs.push({ command: tool, text: `${body}${JSON.stringify(structured)}${stderr}` });
		}
		return { doc: parseDocument(body), text: body };
	}

	async gitStarts(): Promise<string[][]> {
		return gitStartsOf(this.tracePath);
	}

	/** Labels of the credential parts and the whole endpoint in every collected output, with the command. */
	leaks(endpoints: readonly string[]): string[] {
		const sentinels: Sentinel[] = [
			["user", USER],
			["password", PASSWORD],
			["path", PATH_MARK],
			...endpoints.map((endpoint, index): Sentinel => [`endpoint ${index + 1}`, endpoint]),
		];
		const found = new Set<string>();
		for (const output of this.outputs) {
			for (const label of echoedIn(output.text, sentinels)) found.add(`${label} in ${output.command}`);
		}
		return [...found].sort(byCodeUnits);
	}

	async dispose(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(label: string, body: (fixture: EndpointCase) => Promise<void>): Promise<void> {
	const fixture = await EndpointCase.create(label);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

describe("credentials in the claim endpoint (CLI and MCP)", () => {
	test(
		"ec-01: setup refuses a credential endpoint as config-invalid, writes nothing, contacts nothing, echoes nothing",
		async () => {
			await withCase("ec01", async (fixture) => {
				const project = await fixture.project("project", null);
				const configPath = join(project, "backlog", "config.yml");
				const pristine = await readFile(configPath, "utf8");
				const authority = `127.0.0.1:${proxy().port}`;
				const quiet = proxy().acceptedConnections;
				const token = `https://${USER}:${PASSWORD}@${authority}/${PATH_MARK}/p.git`;
				const first = await fixture.json(project, setupArgs(token));
				// Positive control (catches: the product before the credential check, which writes the credential endpoint into
				// the project file; a refusal after the write): config-invalid with the endpoint problem, the project file
				// unchanged.
				expect({ first: refusalView(first.exit, first.doc), file: await readFile(configPath, "utf8") }).toEqual({
					first: REFUSED,
					file: pristine,
				});
				const forms = [
					`http://${USER}@${authority}/${PATH_MARK}/p.git`,
					`ssh://${USER}:${PASSWORD}@${authority}/${PATH_MARK}/p.git`,
					`git://${USER}:${PASSWORD}@${authority}/${PATH_MARK}/p.git`,
					`https://${USER}%40x:${PASSWORD}%25@${authority}/${PATH_MARK}/p.git`,
				];
				const others: Record<string, unknown>[] = [];
				for (const form of forms) {
					const run = await fixture.json(project, setupArgs(form));
					others.push(refusalView(run.exit, run.doc));
				}
				const text = await fixture.cli(project, setupArgs(token));
				// (catches: http usernames, ssh passwords, git:// or percent-encoded userinfo
				// let through; a text mode that writes or exits otherwise; a connection or a network Git command for a
				// refusal that only reads the template; the user, the password, the path or the whole URL in a document, a
				// message or the text): every form is refused the same way, the text call exits 5 too, the file stays as it
				// was, the stalled endpoint saw no connection, no network Git command started, and no output carries any
				// part of an endpoint.
				expect({
					others,
					text: text.exit,
					file: await readFile(configPath, "utf8"),
					connections: proxy().acceptedConnections - quiet,
					network: networkStarts(await fixture.gitStarts()),
					leaked: fixture.leaks([token, ...forms]),
				}).toEqual({
					others: forms.map(() => REFUSED),
					text: CLAIM_EXIT_CODES.refused,
					file: pristine,
					connections: 0,
					network: [],
					leaked: [],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ec-02: a configured credential endpoint refuses init, acquire, list and claim_acquire before any contact",
		async () => {
			await withCase("ec02", async (fixture) => {
				const port = proxy().port;
				// git:// keeps the positive control bounded before the credential check: the https form against the stalled
				// endpoint ran into the test timeout there (local RED 2026-09-30); ec-01 carries the https forms.
				const secret = `git://${USER}:${PASSWORD}@127.0.0.1:${port}/${PATH_MARK}.git`;
				const project = await fixture.project("project", claimsBlock(secret));
				const context = await newContext(fixture.parent);
				const quiet = proxy().acceptedConnections;
				const init = await fixture.json(project, ["claim", "init"]);
				// Positive control (catches: the product before the credential check, whose init reaches the stalled endpoint
				// and ends unavailable; a refusal that names the endpoint): init refuses config-invalid with the endpoint
				// problem.
				expect(refusalView(init.exit, init.doc)).toEqual(REFUSED);
				const acquire = await fixture.json(project, acquireArgs(context, "op-ec02-acquire"));
				const list = await fixture.json(project, ["claim", "list"]);
				const listed = await fixture.cli(project, ["claim", "list"]);
				const tool = await fixture.mcp(project, "claim_acquire", {
					ticket: TICKET,
					owner: OWNER,
					context,
					ttlMs: TTL,
					operationId: "op-ec02-mcp",
				});
				// (catches: a command or the MCP tool that resolves the settings after the network, or not
				// at all; a new problem or error code for credentials; any Git process that talks to the endpoint; the
				// credential in a document, the text or the tool result): a mutation, the list in JSON and text and the
				// MCP acquire refuse the same way, the stalled endpoint saw no connection, no network Git command started,
				// and no output carries any part of the endpoint.
				expect({
					acquire: refusalView(acquire.exit, acquire.doc),
					list: refusalView(list.exit, list.doc),
					text: listed.exit,
					tool: refusalView(CLAIM_EXIT_CODES.refused, tool.doc),
					connections: proxy().acceptedConnections - quiet,
					network: networkStarts(await fixture.gitStarts()),
					leaked: fixture.leaks([secret]),
				}).toEqual({
					acquire: REFUSED,
					list: REFUSED,
					text: CLAIM_EXIT_CODES.refused,
					tool: REFUSED,
					connections: 0,
					network: [],
					leaked: [],
				});
				const plain = `git://127.0.0.1:${port}/${PATH_MARK}.git`;
				const control = await fixture.project("control", claimsBlock(plain));
				const before = proxy().acceptedConnections;
				const traced = networkStarts(await fixture.gitStarts()).length;
				const reached = await fixture.json(control, ["claim", "list"]);
				// Counter control (catches: a dead counter; a trace2 file the CLI's Git never writes, which would pass the
				// network criterion vacuously; a refusal that is really a broken fixture): the same endpoint without
				// userinfo reaches the stalled proxy with a traced network Git command and ends unavailable, not
				// config-invalid.
				expect({
					code: field(reached.doc, "code") ?? null,
					connected: proxy().acceptedConnections > before,
					traced: networkStarts(await fixture.gitStarts()).length > traced,
				}).toEqual({ code: "unreachable", connected: true, traced: true });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ec-03: ssh://git@ passes setup byte-equal and the preflight, which hands the username to Git's SSH transport",
		async () => {
			await withCase("ec03", async (fixture) => {
				const project = await fixture.project("project", null);
				const configPath = join(project, "backlog", "config.yml");
				// A stand-in for ssh (GIT_SSH_COMMAND passes through): records its arguments and fails like a host
				// that refuses the connection, so the preflight ends at the transport and never at the rule.
				const argvPath = join(fixture.root, "ssh-argv.txt");
				const ssh = join(fixture.root, "ssh-stub.sh");
				await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}\nexit 255\n`);
				await chmod(ssh, 0o755);
				const port = proxy().port;
				const endpoint = `ssh://git@127.0.0.1:${port}/team/${PATH_MARK}.git`;
				const written = await fixture.json(project, setupArgs(endpoint));
				const configured = await readFile(configPath, "utf8");
				const list = await fixture.json(project, ["claim", "list"], { GIT_SSH_COMMAND: ssh });
				let argv: string[] = [];
				try {
					argv = (await readFile(argvPath, "utf8")).split("\n").filter(Boolean);
				} catch {
					argv = [];
				}
				// (Catches: a rule that refuses ssh usernames, in setup or in the preflight; a
				// setup that rewrites the endpoint; GIT_SSH_COMMAND stripped): setup writes the endpoint byte-equal, the
				// list passes the rule and fails at the transport, and the SSH command ran with the user git.
				expect({
					written: { exit: written.exit, kind: field(written.doc, "kind"), status: field(written.doc, "status") },
					endpoint: configured.includes(`endpoint: ${JSON.stringify(endpoint)}`),
					list: { code: field(list.doc, "code") ?? null, invalid: field(list.doc, "code") === "config-invalid" },
					user: argv.some((arg) => arg === "git@127.0.0.1"),
				}).toEqual({
					written: { exit: 0, kind: "claim-setup", status: "ok" },
					endpoint: true,
					list: { code: "unreachable", invalid: false },
					user: true,
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"ec-04: the rendered guide and CLAIMS.md carry the mandatory sentence; setup describes the rule; no example has userinfo",
		async () => {
			await withCase("ec04", async (fixture) => {
				const project = await fixture.project("project", null);
				const guide = await fixture.cli(project, ["instructions", "claims"]);
				// Positive control (catches: the product before the credential check, whose guide has no such sentence; a
				// sentence only in the source file that the renderer changes): the guide as the CLI prints it carries the
				// mandatory sentence.
				expect({ exit: guide.exit, sentence: normalized(guide.stdout).includes(MANDATORY_SENTENCE) }).toEqual({
					exit: 0,
					sentence: true,
				});
				const claims = normalized(await readFile(CLAIMS_PATH, "utf8"));
				const setup = await fixture.cli(project, ["claim", "setup", "--help"]);
				const top = await fixture.cli(project, ["claim", "--help"]);
				const subcommands = subcommandsOf(top.stdout);
				const examples: string[] = [];
				for (const name of subcommands) {
					const help = await fixture.cli(project, ["claim", name, "--help"]);
					examples.push(...examplesOf(`${help.stdout}${help.stderr}`));
				}
				// (catches: the sentence missing from CLAIMS.md or reworded there; either old
				// `--endpoint` text, the help schema's or the Commander option's; the clause at another option; an example
				// that shows userinfo; an empty command list or no examples read, which would pass the scan vacuously):
				// CLAIMS.md carries the sentence too, setup's help both texts at `--endpoint`, and none of the examples of
				// the claim commands carries userinfo.
				const setupHelp = normalized(`${setup.stdout}${setup.stderr}`);
				expect({
					claims: claims.includes(MANDATORY_SENTENCE),
					missing: ENDPOINT_TEXTS.filter((text) => !setupHelp.includes(text)),
					read: { subcommands: subcommands.length > 0, examples: examples.length > 0 },
					userinfo: examples.filter((example) => USERINFO.test(example)),
				}).toEqual({
					claims: true,
					missing: [],
					read: { subcommands: true, examples: true },
					userinfo: [],
				});
			});
		},
		TEST_TIMEOUT,
	);
});
