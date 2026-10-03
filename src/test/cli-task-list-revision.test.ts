/**
 * Level E: the opt-in `revision` of `backlog task list --json --revision` through the real CLI subprocess — its form
 * against the SHA-256 of the task file bytes on disk (computed here with node:crypto, the file found by its name), the
 * unchanged default output of `task list`, `task view` and `search`, a body hand-edit, an edit of another task, the
 * usage error, a `filesystemOnly` project outside any Git work tree, the documentation pins and the combination with
 * `--watch`. Every test starts with a positive control that the scaffold (`--revision` registered with an empty help
 * text and ignored, no documentation change) cannot satisfy. Not covered: the `null` revision of a file that vanishes
 * between the query and the hash, a race a subprocess cannot provoke deterministically.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { BACKLOG_CWD_ENV } from "../utils/runtime-cwd.ts";
import { getTestCliPath } from "./test-cli.ts";
import {
	createUniqueTestDir,
	initializeFilesystemTestProject,
	initializeTestProject,
	safeCleanup,
	waitUntil,
} from "./test-utils.ts";

type CliRun = { exit: number; stdout: string; stderr: string };
/** `git`: a Git work tree with every seeded task committed; `filesystem`: `filesystemOnly` outside any work tree. */
type Mode = "git" | "filesystem";
type Seed = {
	id: string;
	title: string;
	status?: string;
	description?: string;
	updatedDate?: string;
	dependencies?: string[];
};
/** The judged facts of a usage error: no wording beyond the two flag names. */
type Usage = { exit: number; stdout: string; namesRevision: boolean; namesJson: boolean };
// adapted from cli-json-watch.test.ts:50-55 (follow)
type Watch = {
	child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	snapshots: string[];
	stderr: Promise<string>;
	reading: Promise<void>;
};

const CLI_PATH = getTestCliPath();
/** Git setup plus up to five CLI starts of ≈0.5–1.5 s each; the harness default of 10 s is too tight for that. */
const TEST_TIMEOUT = 30_000;
/** The wait for one watch value (cli-json-watch.test.ts:113, 5 s there; doubled for the slower Testbox start). */
const WATCH_WAIT = 10_000;
const LIST = ["task", "list", "--json"];
const LIST_REVISION = ["task", "list", "--json", "--revision"];
/** `sha256:` plus 64 hex digits, lowercase as node:crypto prints them. */
const REVISION_FORM = /^sha256:[0-9a-f]{64}$/;
/** A key the entry does not carry; distinct from null, which is allowed for a vanished file. */
const ABSENT = "<absent>";
const ORIGINAL_BODY = "Original body of the revision target";
const EDITED_BODY = "Hand-edited body of the revision target";
const UPDATED = "2026-09-20 10:00";
/** normalizePublicDate of UPDATED (json-output.ts:118-122). */
const UPDATED_AT = "2026-09-20T10:00:00Z";
/** Verbatim: the mandatory sentence of overview.md, claims.md and CLAIMS.md. */
const MANDATORY_SENTENCE = [
	"`--revision` reports what this working copy holds.",
	"It is not a watch engine and does not capture every foreign change:",
	"edits on other branches or remotes appear only once they reach this working copy,",
	"and `--watch` may coalesce intermediate edits.",
].join(" ");
/** A help schema field line (help-schema.ts:30-35, `  - <name>: <type>`), bare like `watch` (cli.ts:2861). */
const SCHEMA_FIELD = /^ {2}- (?:--)?revision: /m;
const USAGE: Usage = { exit: 1, stdout: "", namesRevision: true, namesJson: true };
const E01_SEEDS: readonly Seed[] = [
	{ id: "TASK-1", title: "Revision form one", description: "Plain ASCII body" },
	{ id: "TASK-2", title: "Revision form two", description: "Nicht-ASCII: Größe ✓ — äöü" },
	{ id: "TASK-3", title: "Revision form three" },
];
const E02_SEEDS: readonly Seed[] = [
	{ id: "TASK-1", title: "Unchanged output one" },
	{ id: "TASK-2", title: "Unchanged output two" },
];

/** The runner's environment without Git overrides and BACKLOG_CWD: the working directory alone selects the project. */
// adapted from claim-cli.test.ts:294-297 and claim-git-fixture.ts:136-140
function hermeticEnv(): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key !== BACKLOG_CWD_ENV && !key.startsWith("GIT_")),
	);
}

// adapted from cli-json-output.test.ts:13-15
async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
	const result = await $`bun ${[CLI_PATH, ...args]}`.cwd(cwd).env(hermeticEnv()).nothrow().quiet();
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await $`git ${[...args]}`.cwd(cwd).env(hermeticEnv()).quiet();
}

// adapted from claim-cli.test.ts:252-255
function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

// adapted from claim-cli.test.ts:263-266
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return (value as Record<string, unknown>)[key];
}

// adapted from claim-cli.test.ts:339-341
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value under `key`, or ABSENT when the object does not carry the key at all (null stays null). */
function own(value: unknown, key: string): unknown {
	return isRecord(value) && key in value ? value[key] : ABSENT;
}

function arrayField(value: unknown, key: string): unknown[] {
	const items = field(value, key);
	return Array.isArray(items) ? items : [];
}

// adapted from claim-cli.test.ts:316-322
function parseDocument(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { kind: "unparsable" };
	}
}

// adapted from claim-cli.test.ts:285-292
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

function tasksOf(doc: unknown): unknown[] {
	return arrayField(doc, "tasks");
}

/** The entry of `id` in a task-list document, or undefined. */
function entryOf(doc: unknown, id: string): unknown {
	return tasksOf(doc).find((task) => field(task, "id") === id);
}

function revisionOf(doc: unknown, id: string): unknown {
	return own(entryOf(doc, id), "revision");
}

function idsOf(entries: readonly unknown[]): string[] {
	const ids = entries.map((entry) => String(field(entry, "id")));
	return ids.sort(byCodeUnits);
}

/** Ids of the entries that carry a `revision` key, whatever its value (null included). */
function keyedIds(entries: readonly unknown[]): string[] {
	return idsOf(entries.filter((entry) => own(entry, "revision") !== ABSENT));
}

/** One entry without its `revision` key; the order of every other key is kept. */
function withoutRevision(entry: unknown): unknown {
	if (!isRecord(entry)) return entry;
	return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "revision"));
}

/** The task-list document with every entry's `revision` key removed; envelope and key order stay as printed. */
function withoutRevisions(doc: unknown): unknown {
	if (!isRecord(doc) || !Array.isArray(doc.tasks)) return doc;
	return { ...doc, tasks: doc.tasks.map((entry: unknown) => withoutRevision(entry)) };
}

/** formatJson (json-output.ts:280-282). */
function printed(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** `sha256:` plus the SHA-256 of the bytes, computed here with node:crypto. */
function revisionOfBytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The task file of `id` in `project`, found by its file name (`<id> - <title>.md`), independent of the product. */
async function taskFile(project: string, id: string): Promise<string> {
	const directory = join(project, "backlog", "tasks");
	const prefix = `${id.toLowerCase()} - `;
	const matches = (await readdir(directory)).filter((name) => name.toLowerCase().startsWith(prefix));
	const [match] = matches;
	if (matches.length !== 1 || match === undefined) throw new Error(`expected one task file for ${id}`);
	return join(directory, match);
}

async function fileRevision(project: string, id: string): Promise<string> {
	return revisionOfBytes(await readFile(await taskFile(project, id)));
}

/** The end of the frontmatter block (`---` … `---`) of a task file; -1 when the file has none. */
function frontmatterEnd(text: string): number {
	return text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

/** Exit 1, no stdout, stderr naming `--revision` and `--json` — nothing more. */
function usage(run: CliRun): Usage {
	return {
		exit: run.exit,
		stdout: run.stdout,
		namesRevision: run.stderr.includes("--revision"),
		namesJson: run.stderr.includes("--json"),
	};
}

/** Whitespace-insensitive text: guides may wrap the sentence anywhere. */
function normalized(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** The lines of the help schema's Examples block (help-schema.ts:72-74). */
function exampleLines(help: string): string[] {
	const lines = help.split("\n");
	const start = lines.indexOf("Examples:");
	return start === -1 ? [] : lines.slice(start + 1);
}

/** A complete Task record for the product's own create path (cli-json-output.test.ts:24-56). */
function taskOf(seed: Seed): Parameters<Core["createTask"]>[0] {
	return {
		id: seed.id,
		title: seed.title,
		status: seed.status ?? "To Do",
		assignee: [],
		labels: [],
		dependencies: seed.dependencies ?? [],
		createdDate: "2026-09-19 09:00",
		...(seed.description === undefined ? {} : { description: seed.description }),
		...(seed.updatedDate === undefined ? {} : { updatedDate: seed.updatedDate }),
	};
}

/** Refuses a filesystem fixture inside a Git work tree, where the no-Git case would be vacuous. */
// adapted from claim-preflight.test.ts:516-522 (plainDirectory)
async function assertOutsideGit(directory: string): Promise<void> {
	const probe = await $`git rev-parse --is-inside-work-tree`.cwd(directory).env(hermeticEnv()).nothrow().quiet();
	if (probe.exitCode === 0) throw new Error("the fixture lies inside a Git work tree; the no-Git case is vacuous");
}

/** git: under tmp/ of the checkout like the sibling suites (test-utils.ts:21-26); filesystem: under the OS tmpdir. */
async function projectDirectory(mode: Mode): Promise<string> {
	if (mode === "filesystem") return mkdtemp(join(tmpdir(), "cli-task-list-revision-"));
	const directory = createUniqueTestDir("cli-task-list-revision");
	await mkdir(directory, { recursive: true });
	return directory;
}

async function seedProject(mode: Mode, project: string, seeds: readonly Seed[]): Promise<void> {
	const core = new Core(project);
	if (mode === "git") {
		// adapted from cli-task-list.test.ts:25-28, without the init commit: everything is committed once below
		await git(project, ["init", "-b", "main"]);
		await initializeTestProject(core, "Revision Test");
	} else {
		await assertOutsideGit(project);
		// test-utils.ts:294-300: the shared init path with filesystemOnly: true
		await initializeFilesystemTestProject(core, "Revision Filesystem Test");
	}
	for (const seed of seeds) await core.createTask(taskOf(seed), false);
	if (mode === "git") {
		// HEAD holds the seeded bytes, so a later hand edit leaves the working copy ahead of HEAD (no Git hash).
		const identity = ["-c", "user.name=revision", "-c", "user.email=revision@example.invalid"];
		await git(project, ["add", "-A"]);
		await git(project, [...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
	}
}

async function withProject(
	mode: Mode,
	seeds: readonly Seed[],
	body: (project: string) => Promise<void>,
): Promise<void> {
	const project = await projectDirectory(mode);
	try {
		await seedProject(mode, project, seeds);
		await body(project);
	} finally {
		await safeCleanup(project);
	}
}

// adapted from cli-json-watch.test.ts:24-33 and :50-75 (startWatch, follow): values end at an unindented `}` line
function startWatch(cwd: string): Watch {
	const child = Bun.spawn(["bun", CLI_PATH, ...LIST_REVISION, "--watch"], {
		cwd,
		env: hermeticEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const snapshots: string[] = [];
	const stderr = new Response(child.stderr).text();
	const reading = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let end = buffer.indexOf("\n}\n");
			while (end !== -1) {
				snapshots.push(buffer.slice(0, end + 3));
				buffer = buffer.slice(end + 3);
				end = buffer.indexOf("\n}\n");
			}
		}
	})();
	return { child, snapshots, stderr, reading };
}

// adapted from cli-json-watch.test.ts:125-130
async function stopWatch(watch: Watch): Promise<void> {
	watch.child.kill();
	await watch.child.exited;
	await watch.reading;
}

function latestRevision(watch: Watch, id: string): unknown {
	return revisionOf(parseDocument(watch.snapshots.at(-1) ?? ""), id);
}

describe("task list --json --revision", () => {
	test(
		"rev-e01: revision is sha256: plus the SHA-256 of the task file bytes on disk, per task",
		async () => {
			await withProject("git", E01_SEEDS, async (project) => {
				// A run of trailing blank lines no serializer writes: the bytes on disk count, not a re-serialized task.
				const padded = await taskFile(project, "TASK-3");
				await writeFile(padded, `${await readFile(padded, "utf8")}\n\n\n`);
				const run = await runCli(project, LIST_REVISION);
				const doc = parseDocument(run.stdout);
				const first = await fileRevision(project, "TASK-1");
				const second = await fileRevision(project, "TASK-2");
				const third = await fileRevision(project, "TASK-3");
				// Positive control (catches: an ignored flag — the scaffold —, a hash of the parsed or re-serialized task,
				// of the committed blob or of the path, the revision of another task's file).
				expect({
					"TASK-1": revisionOf(doc, "TASK-1"),
					"TASK-2": revisionOf(doc, "TASK-2"),
					"TASK-3": revisionOf(doc, "TASK-3"),
				}).toEqual({ "TASK-1": first, "TASK-2": second, "TASK-3": third });
				// catches: another form than `sha256:<64 hex>` (a Git blob OID, uppercase hex, a missing prefix), even if the
				// local SHA-256 above were taken over the wrong bytes.
				const forms = tasksOf(doc).map((task) => REVISION_FORM.test(String(own(task, "revision"))));
				expect(forms).toEqual([true, true, true]);
				// catches: an exit code or stderr text beside the JSON.
				expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e02: without the flag nothing changes — no revision key in task list, task view or search",
		async () => {
			await withProject("git", E02_SEEDS, async (project) => {
				const flagged = await runCli(project, LIST_REVISION);
				const first = await runCli(project, LIST);
				const second = await runCli(project, LIST);
				const detail = await runCli(project, ["task", "view", "TASK-1", "--json"]);
				const search = await runCli(project, ["search", "Unchanged", "--type", "task", "--json"]);
				const detailTask = field(parseDocument(detail.stdout), "task");
				const results = arrayField(parseDocument(search.stdout), "results").map((result) => field(result, "data"));
				// Positive control (catches: an ignored flag — the scaffold; without it the negatives below prove nothing).
				expect({ exit: flagged.exit, keyed: keyedIds(tasksOf(parseDocument(flagged.stdout))) }).toEqual({
					exit: 0,
					keyed: ["TASK-1", "TASK-2"],
				});
				// catches: a default `revision: null` or an always-on revision (either breaks the exact envelope pin
				// cli-json-output.test.ts:92-120), an unstable default output.
				expect({
					exit: [first.exit, second.exit],
					stderr: [first.stderr, second.stderr],
					keyed: keyedIds(tasksOf(parseDocument(first.stdout))),
					repeatable: second.stdout === first.stdout,
				}).toEqual({ exit: [0, 0], stderr: ["", ""], keyed: [], repeatable: true });
				// catches: --revision changing anything but the added key: another field, order, envelope or formatting.
				expect(printed(withoutRevisions(parseDocument(flagged.stdout)))).toBe(first.stdout);
				// catches: revision added in the shared toTaskSummaryJson (json-output.ts:128), which also feeds task view
				// (:173) and search (:268) — "not in task view --json".
				expect({
					detail: [detail.exit, field(detailTask, "id"), own(detailTask, "revision")],
					search: [search.exit, idsOf(results), keyedIds(results)],
				}).toEqual({ detail: [0, "TASK-1", ABSENT], search: [0, ["TASK-1", "TASK-2"], []] });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e03: a body hand-edit changes revision to the new bytes and leaves updatedAt alone",
		async () => {
			const seeds = [{ id: "TASK-1", title: "Hand edit target", description: ORIGINAL_BODY, updatedDate: UPDATED }];
			await withProject("git", seeds, async (project) => {
				const path = await taskFile(project, "TASK-1");
				const bytesBefore = await readFile(path);
				const before = parseDocument((await runCli(project, LIST_REVISION)).stdout);
				const text = bytesBefore.toString("utf8");
				const edited = text.replace(ORIGINAL_BODY, EDITED_BODY);
				await writeFile(path, edited);
				const run = await runCli(project, LIST_REVISION);
				const after = parseDocument(run.stdout);
				const editedRevision = await fileRevision(project, "TASK-1");
				const end = frontmatterEnd(text);
				// Positive control (catches: an ignored flag — the scaffold).
				expect(revisionOf(before, "TASK-1")).toBe(revisionOfBytes(bytesBefore));
				// catches: a vacuous fixture — the edit must change body bytes only, never the frontmatter.
				expect({
					once: occurrences(text, ORIGINAL_BODY),
					inBody: end !== -1 && text.indexOf(ORIGINAL_BODY) > end,
					frontmatter: edited.slice(0, end) === text.slice(0, end),
					changed: editedRevision !== revisionOfBytes(bytesBefore),
				}).toEqual({ once: 1, inBody: true, frontmatter: true, changed: true });
				// catches: a revision from metadata, from updatedAt, from the committed blob at HEAD or from a cache — the
				// working-copy bytes changed, updated_date did not (json-output.ts:148).
				expect({
					revision: revisionOf(after, "TASK-1"),
					updatedAt: [field(entryOf(before, "TASK-1"), "updatedAt"), field(entryOf(after, "TASK-1"), "updatedAt")],
				}).toEqual({ revision: editedRevision, updatedAt: [UPDATED_AT, UPDATED_AT] });
				// catches: another summary field that sees the body edit — then revision would not be needed.
				expect(withoutRevision(entryOf(after, "TASK-1"))).toEqual(withoutRevision(entryOf(before, "TASK-1")));
				expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e04: an edit of another task leaves the revision of this one unchanged",
		async () => {
			const seeds = [
				{ id: "TASK-1", title: "Dependent task", dependencies: ["TASK-2"] },
				{ id: "TASK-2", title: "Dependency task" },
			];
			await withProject("git", seeds, async (project) => {
				const dependentFile = await taskFile(project, "TASK-1");
				const dependentBefore = revisionOfBytes(await readFile(dependentFile));
				const dependencyBefore = await fileRevision(project, "TASK-2");
				const before = parseDocument((await runCli(project, LIST_REVISION)).stdout);
				const edit = await runCli(project, ["task", "edit", "TASK-2", "-s", "Done", "--plain"]);
				const after = parseDocument((await runCli(project, LIST_REVISION)).stdout);
				const dependentAfter = revisionOfBytes(await readFile(dependentFile));
				const dependencyAfter = await fileRevision(project, "TASK-2");
				// Positive control (catches: an ignored flag — the scaffold).
				expect({ dependent: revisionOf(before, "TASK-1"), dependency: revisionOf(before, "TASK-2") }).toEqual({
					dependent: dependentBefore,
					dependency: dependencyBefore,
				});
				// catches: a vacuous fixture — the edit ran, rewrote the dependency and left the dependent's bytes alone.
				expect({
					edit: edit.exit,
					dependentKept: dependentAfter === dependentBefore,
					dependencyKept: dependencyAfter === dependencyBefore,
				}).toEqual({ edit: 0, dependentKept: true, dependencyKept: false });
				// catches: a revision derived from the dependency state or readiness (isReady flips, the bytes do not), or
				// one hash over the whole list.
				expect({
					dependent: revisionOf(after, "TASK-1"),
					ready: [field(entryOf(before, "TASK-1"), "isReady"), field(entryOf(after, "TASK-1"), "isReady")],
					dependency: revisionOf(after, "TASK-2"),
				}).toEqual({ dependent: dependentBefore, ready: [false, true], dependency: dependencyAfter });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e05: --revision without --json or with --plain is a usage error like --watch",
		async () => {
			await withProject("git", [{ id: "TASK-1", title: "Usage target" }], async (project) => {
				const textMode = await runCli(project, ["task", "list", "--revision"]);
				const plain = await runCli(project, ["task", "list", "--revision", "--plain"]);
				const both = await runCli(project, ["task", "list", "--json", "--revision", "--plain"]);
				const valid = await runCli(project, LIST_REVISION);
				// Positive control (catches: --revision without --json accepted and ignored — the scaffold prints the
				// text list with exit 0).
				expect(usage(textMode)).toEqual(USAGE);
				// catches: --plain slipping through, a list printed before the guard, a stderr that does not name
				// --revision (the scaffold's "--json cannot be combined with --plain.", read-output-mode.ts:11).
				expect([usage(plain), usage(both)]).toEqual([USAGE, USAGE]);
				// catches: a guard that refuses every --revision.
				expect({ exit: valid.exit, keyed: keyedIds(tasksOf(parseDocument(valid.stdout))) }).toEqual({
					exit: 0,
					keyed: ["TASK-1"],
				});
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e06: a filesystemOnly project outside any Git work tree gets a revision",
		async () => {
			await withProject("filesystem", [{ id: "TASK-1", title: "Filesystem target" }], async (project) => {
				const run = await runCli(project, LIST_REVISION);
				const config = await new Core(project).filesystem.loadConfig();
				const expected = await fileRevision(project, "TASK-1");
				// Positive control (catches: an ignored flag — the scaffold —, a Git-based hash: hashFile answers null
				// under filesystemOnly, git/operations.ts:929-933).
				expect(revisionOf(parseDocument(run.stdout), "TASK-1")).toBe(expected);
				// catches: a vacuous fixture (a Git directory, a project that is not filesystemOnly; an enclosing work tree
				// is already refused by assertOutsideGit), a Git warning or failure on stderr.
				expect({
					filesystemOnly: config?.filesystemOnly ?? null,
					dotGit: await exists(join(project, ".git")),
					exit: run.exit,
					stderr: run.stderr,
				}).toEqual({ filesystemOnly: true, dotGit: false, exit: 0, stderr: "" });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e07: overview, claims guide and CLAIMS.md carry the mandatory sentence; task list --help names --revision",
		async () => {
			await withProject("filesystem", [], async (project) => {
				const overview = await runCli(project, ["instructions", "overview"]);
				const claims = await runCli(project, ["instructions", "claims"]);
				const help = await runCli(project, ["task", "list", "--help"]);
				const sentence = normalized(MANDATORY_SENTENCE);
				// Positive control (catches: the missing sentence — the scaffold changes no documentation).
				expect(normalized(overview.stdout)).toContain(sentence);
				// catches: the claims guide without the sentence (its section "Owner and ticket changes").
				expect(normalized(claims.stdout)).toContain(sentence);
				// catches: the join recipe without its own section or without the quoted rule; the rule may
				// open a sentence, so its case is not judged.
				expect({
					section: /^#{2,3} Owner and ticket changes$/m.test(claims.stdout),
					rule: normalized(claims.stdout).toLowerCase().includes("compare revisions; never infer fields from them"),
				}).toEqual({ section: true, rule: true });
				// catches: the third place of the mandatory sentence, the "No watch engine" bullet of CLAIMS.md.
				const guide = await readFile(join(import.meta.dir, "..", "..", "CLAIMS.md"), "utf8");
				expect(normalized(guide)).toContain(sentence);
				// catches: a help schema without the field or without the example ("gains the field and one
				// example"); the bare Commander option line alone is already there in the scaffold.
				expect({
					exits: [overview.exit, claims.exit, help.exit],
					option: help.stdout.includes("--revision"),
					field: SCHEMA_FIELD.test(help.stdout),
					example: exampleLines(help.stdout).some((line) => line.includes("--json") && line.includes("--revision")),
				}).toEqual({ exits: [0, 0, 0], option: true, field: true, example: true });
			});
		},
		TEST_TIMEOUT,
	);

	test(
		"rev-e08: --json --watch --revision emits a new value with the new revision after a body edit",
		async () => {
			const seeds = [{ id: "TASK-1", title: "Watched target", description: ORIGINAL_BODY }];
			await withProject("filesystem", seeds, async (project) => {
				const path = await taskFile(project, "TASK-1");
				const initialRevision = await fileRevision(project, "TASK-1");
				const watch = startWatch(project);
				try {
					await waitUntil(() => watch.snapshots.length > 0, "the initial watch value", WATCH_WAIT);
					const initial = parseDocument(watch.snapshots[0] ?? "");
					// Positive control (catches: --revision ignored or dropped on the watch path — the scaffold).
					expect(revisionOf(initial, "TASK-1")).toBe(initialRevision);
					// adapted from cli-json-watch.test.ts:147-149: an atomic replace, as editors write
					const edited = (await readFile(path, "utf8")).replace(ORIGINAL_BODY, EDITED_BODY);
					await writeFile(`${path}.tmp`, edited);
					await rename(`${path}.tmp`, path);
					const editedRevision = await fileRevision(project, "TASK-1");
					const reached = () => latestRevision(watch, "TASK-1") === editedRevision;
					await waitUntil(reached, "the watch value after the body edit", WATCH_WAIT);
					const latest = watch.snapshots.at(-1) ?? "";
					const oneShot = await runCli(project, LIST_REVISION);
					// catches: a watch value that differs beyond the revision (the body edit reaches no other field), or one
					// formatted otherwise than the one-shot list (cli-json-watch.test.ts:111-115).
					expect({ rest: withoutRevisions(parseDocument(latest)), bytes: latest }).toEqual({
						rest: withoutRevisions(initial),
						bytes: oneShot.stdout,
					});
				} finally {
					await stopWatch(watch);
				}
				// catches: stderr output of the watch (cli-json-watch.test.ts:161-163).
				expect(await watch.stderr).toBe("");
			});
		},
		TEST_TIMEOUT,
	);
});
