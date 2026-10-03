/**
 * Behavioural contract for the native claim configuration: the pure resolver over the raw `claims:` block and the
 * embedding of that block in the project configuration (parse, save, startup migration, watcher). No Git process,
 * network or clock is used. Diagnostics are compared as views: kind, exact keys and problem codes; messages only
 * structurally (nonempty, name the key, echo no sentinel). Every table row names the deliberately wrong implementation
 * it catches.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAIM_START_VALUES,
	type ClaimConfigProblemCode,
	type ClaimSettings,
	type ClaimSettingsResult,
	resolveClaimSettings,
} from "../claims/config/index.ts";
import { type ClaimStorageFormat, openClaimStore } from "../claims/storage/index.ts";
import { Core } from "../core/backlog.ts";
import { migrateConfig, needsMigration } from "../core/config-migration.ts";
import { FileSystem } from "../file-system/operations.ts";
import type { BacklogConfig } from "../types/index.ts";
import { watchConfigFile } from "../utils/config-watcher.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const MODES = ["lease", "hard", "none"] as const;
/** Distinctive text that no message or reason may echo. */
const SENTINEL = "SENTINEL-claims-7f3a";
const ENDPOINT = "git://git.example.org/team/project.git";
/** Accepted endpoint with a path marker, no userinfo: kept byte-equal as data, never echoed by a diagnostic. */
const SECRET_ENDPOINT = `https://git.example.org/${SENTINEL}/project.git`;
const MAX_TIMER = 2_147_483_647;
const WATCH_TIMEOUT = 5_000;

type Mode = (typeof MODES)[number];
type Entry = [key: string, raw: string];
type ProblemView = { key: string; problem: ClaimConfigProblemCode };
type ConfigView = {
	label: string;
	kind: string;
	keys: string[];
	reasonType: string;
	reasonEmpty: boolean;
	echoed: number;
	problems: ProblemView[] | undefined;
	/** Keys of problems whose message is empty, does not name the key, or echoes a sentinel. */
	faultyMessages: string[];
};
type InvalidRow = { label: string; catches: string; yaml: string; problems: ProblemView[] };
type ConfiguredRow = { label: string; catches: string; yaml: string; settings: ClaimSettings };

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** ASSUMPTION(config): one column-0 `claims:` block, snake_case keys with the unit in the name. */
function block(entries: readonly Entry[]): string {
	return `claims:\n${entries.map(([key, raw]) => (raw === "" ? `  ${key}:\n` : `  ${key}: ${raw}\n`)).join("")}`;
}

/** The confirmed start-value template for one format and mode. */
function template(
	format: ClaimStorageFormat = "blob",
	mode: Mode = "lease",
	enabled = true,
	endpoint = ENDPOINT,
): Entry[] {
	return [
		["enabled", String(enabled)],
		["endpoint", JSON.stringify(endpoint)],
		["storage_format", format],
		["lifetime_mode", mode],
		...(mode === "lease" ? [["lease_ttl_ms", "300000"] as Entry] : []),
		...(mode === "none" ? [] : [["reclaim_grace_ms", "600000"] as Entry]),
		["attempt_timeout_ms", "10000"],
		["attempts", "3"],
		["operation_budget_ms", "30000"],
	];
}

/** Replaces `key` in place, removes it for `undefined`, or appends it when absent. */
function replaced(entries: readonly Entry[], key: string, raw?: string): Entry[] {
	const kept = entries.filter(([name]) => name !== key);
	if (raw === undefined) return kept;
	const index = entries.findIndex(([name]) => name === key);
	if (index < 0) return [...kept, [key, raw]];
	kept.splice(index, 0, [key, raw]);
	return kept;
}

function settingsOf(
	format: ClaimStorageFormat = "blob",
	mode: Mode = "lease",
	enabled = true,
	endpoint = ENDPOINT,
): ClaimSettings {
	const lifetime: ClaimSettings["lifetime"] =
		mode === "lease"
			? { mode: "lease", leaseTtlMs: 300_000, reclaimGraceMs: 600_000 }
			: mode === "hard"
				? { mode: "hard", reclaimGraceMs: 600_000 }
				: { mode: "none" };
	return {
		enabled,
		endpoint,
		storageFormat: format,
		lifetime,
		attemptTimeoutMs: 10_000,
		attempts: 3,
		operationBudgetMs: 30_000,
	};
}

function problem(key: string, code: ClaimConfigProblemCode): ProblemView {
	return { key: key === "claims" ? "claims" : `claims.${key}`, problem: code };
}

function viewOf(label: string, result: ClaimSettingsResult, values: readonly string[] = []): ConfigView {
	const view = result as { kind: string; reason?: unknown; problems?: unknown };
	const reason = typeof view.reason === "string" ? view.reason : "";
	const sensitive = [SENTINEL, ...values].filter((value) => value !== "");
	const problems = Array.isArray(view.problems)
		? (view.problems as { key?: unknown; problem?: unknown; message?: unknown }[])
		: undefined;
	return {
		label,
		kind: view.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof view.reason,
		reasonEmpty: reason.length === 0,
		echoed: sensitive.filter((value) => reason.includes(value)).length,
		problems: problems?.map((entry) => ({ key: String(entry.key), problem: entry.problem as ClaimConfigProblemCode })),
		faultyMessages: (problems ?? [])
			.filter(
				({ key, message }) =>
					typeof message !== "string" ||
					message.length === 0 ||
					!message.includes(String(key)) ||
					sensitive.some((value) => message.includes(value)),
			)
			.map(({ key }) => String(key)),
	};
}

function invalidView(label: string, problems: ProblemView[]): ConfigView {
	return {
		label,
		kind: "config-invalid",
		keys: ["kind", "problems", "reason"],
		reasonType: "string",
		reasonEmpty: false,
		echoed: 0,
		problems,
		faultyMessages: [],
	};
}

function notConfiguredView(label: string): ConfigView {
	return {
		label,
		kind: "not-configured",
		keys: ["kind"],
		reasonType: "undefined",
		reasonEmpty: true,
		echoed: 0,
		problems: undefined,
		faultyMessages: [],
	};
}

function checkInvalid(rows: InvalidRow[], values: readonly string[] = []): void {
	for (const { label, catches, yaml, problems } of rows) {
		const tagged = `${label} (catches: ${catches})`;
		expect(viewOf(tagged, resolveClaimSettings(yaml), values)).toStrictEqual(invalidView(tagged, problems));
	}
}

function checkConfigured(rows: ConfiguredRow[]): void {
	for (const { label, catches, yaml, settings } of rows) {
		const tagged = `${label} (catches: ${catches})`;
		expect({ label: tagged, result: resolveClaimSettings(yaml) }).toStrictEqual({
			label: tagged,
			result: { kind: "configured", settings },
		});
	}
}

/** ASSUMPTION(config): the raw block may or may not keep one final newline; that byte is not pinned here. */
function blockOf(text: string | undefined): string | undefined {
	return text?.endsWith("\n") ? text.slice(0, -1) : text;
}

const VALID_BLOCK = block(template()).trimEnd();
const BASE_LINES = [
	'project_name: "Claims Project"',
	'statuses: ["To Do", "In Progress", "Done"]',
	'labels: ["api", "web"]',
	"date_format: yyyy-mm-dd",
	"default_port: 6420",
	"auto_open_browser: false",
	"remote_operations: false",
	"auto_commit: true",
	"check_active_branches: false",
	"active_branch_days: 14",
	'task_prefix: "back"',
];
const BASE_TEXT = `${BASE_LINES.join("\n")}\n`;

/** The base configuration with `claims` inserted in the middle, directly followed by a column-0 key. */
function fileWith(claims: string): string {
	return `${[...BASE_LINES.slice(0, 2), blockOf(claims) ?? "", ...BASE_LINES.slice(2)].join("\n")}\n`;
}

const projects: string[] = [];

afterEach(async () => {
	for (const root of projects.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(content: string): Promise<{ root: string; configPath: string; fs: FileSystem }> {
	const root = await mkdtemp(join(tmpdir(), "claim-config-"));
	projects.push(root);
	await mkdir(join(root, "backlog"));
	const configPath = join(root, "backlog", "config.yml");
	await writeFile(configPath, content);
	return { root, configPath, fs: new FileSystem(root) };
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), WATCH_TIMEOUT);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** The first configuration the watcher publishes for a filesystem that has not loaded its config yet. */
async function firstPublished(filesystem: FileSystem): Promise<BacklogConfig | null> {
	let resolvePublished: (config: BacklogConfig | null) => void = () => undefined;
	const published = new Promise<BacklogConfig | null>((resolve) => {
		resolvePublished = resolve;
	});
	const watcher = watchConfigFile(filesystem, { onConfigChanged: (config) => resolvePublished(config) });
	try {
		return await withDeadline(published, "config watcher publication");
	} finally {
		watcher.stop();
	}
}

async function saveOutcome(filesystem: FileSystem, config: BacklogConfig): Promise<string> {
	try {
		await filesystem.saveConfig(config);
		return "saved";
	} catch {
		return "threw";
	}
}

describe("claim configuration resolver (pure)", () => {
	test("cfg-01 resolves the start-value template for every format, mode and enabled flag exactly", () => {
		const rows: ConfiguredRow[] = [];
		for (const format of FORMATS) {
			for (const mode of MODES) {
				for (const enabled of [true, false]) {
					rows.push({
						label: `${format} ${mode} enabled=${enabled}`,
						catches: "field swap, unit conversion or fields of another mode",
						yaml: block(template(format, mode, enabled)),
						settings: settingsOf(format, mode, enabled),
					});
				}
			}
		}
		rows.push(
			{
				label: "reversed key order",
				catches: "positional instead of keyed parsing",
				yaml: block([...template("tree", "lease")].reverse()),
				settings: settingsOf("tree", "lease"),
			},
			{
				label: "path marker in the endpoint",
				catches: "endpoint rewritten or stripped",
				yaml: block(template("blob", "lease", true, SECRET_ENDPOINT)),
				settings: settingsOf("blob", "lease", true, SECRET_ENDPOINT),
			},
			{
				label: "distinct non-template values",
				catches: "start values substituted for configured ones",
				yaml: block([
					["enabled", "true"],
					["endpoint", JSON.stringify(ENDPOINT)],
					["storage_format", "blob"],
					["lifetime_mode", "lease"],
					["lease_ttl_ms", "1234"],
					["reclaim_grace_ms", "5678"],
					["attempt_timeout_ms", "91"],
					["attempts", "7"],
					["operation_budget_ms", "92"],
				]),
				settings: {
					enabled: true,
					endpoint: ENDPOINT,
					storageFormat: "blob",
					lifetime: { mode: "lease", leaseTtlMs: 1234, reclaimGraceMs: 5678 },
					attemptTimeoutMs: 91,
					attempts: 7,
					operationBudgetMs: 92,
				},
			},
		);
		checkConfigured(rows);
	});

	test("cfg-02 is not-configured without a column-0 block, never through a phantom or nested block", async () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		expect(viewOf("undefined", resolveClaimSettings(undefined))).toStrictEqual(notConfiguredView("undefined"));
		const { fs } = await project(BASE_TEXT);
		const nested = block(template())
			.split("\n")
			.map((line) => (line ? `  ${line}` : line))
			.join("\n");
		const files = [
			{ label: "no block", catches: "phantom configuration", file: BASE_TEXT },
			{ label: "commented block", catches: "comment read as key", file: `${BASE_TEXT}# claims:\n#   enabled: true\n` },
			// ASSUMPTION(config): no fallback to an indented look-alike (unlike operations.ts extractConfigKeyYaml).
			{ label: "nested under another key", catches: "indented look-alike", file: `${BASE_TEXT}meta_thing:\n${nested}` },
		];
		for (const { label, catches, file } of files) {
			const tagged = `${label} (catches: ${catches})`;
			const resolved = resolveClaimSettings(fs.parseConfig(file).claimsYaml);
			expect(viewOf(tagged, resolved)).toStrictEqual(notConfiguredView(tagged));
		}
	});

	test("cfg-03 reports each missing, empty or null required key of every mode and never substitutes a start value", () => {
		checkConfigured(
			MODES.map((mode) => ({
				label: `${mode} control`,
				catches: "-",
				yaml: block(template("blob", mode)),
				settings: settingsOf("blob", mode),
			})),
		);
		const rows: InvalidRow[] = [];
		for (const mode of MODES) {
			for (const [key] of template("blob", mode)) {
				// ASSUMPTION(config): a missing lifetime_mode makes no mode-dependent key required or not-applicable.
				for (const [variant, raw] of [
					["removed", undefined],
					["empty", ""],
					["null", "null"],
				] as const) {
					rows.push({
						label: `${mode}: ${key} ${variant}`,
						catches: "start value used as fallback",
						yaml: block(replaced(template("blob", mode), key, raw)),
						problems: [problem(key, "missing")],
					});
				}
			}
		}
		checkInvalid(rows);
	});

	test("cfg-04 treats an empty or partial block as invalid, never as disabled or not configured", () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		const always = ["enabled", "endpoint", "storage_format", "lifetime_mode", "attempt_timeout_ms", "attempts"];
		// ASSUMPTION(config): without lifetime_mode only the always-required keys are reported.
		checkInvalid([
			{
				label: "empty block",
				catches: "empty block read as not configured",
				yaml: "claims:\n",
				problems: [...always, "operation_budget_ms"].map((key) => problem(key, "missing")),
			},
			{
				label: "only enabled: false",
				catches: "partial block read as switched off",
				yaml: "claims:\n  enabled: false\n",
				problems: [...always.slice(1), "operation_budget_ms"].map((key) => problem(key, "missing")),
			},
		]);
	});

	test("cfg-05 accepts only the exact format and mode names", () => {
		checkConfigured([
			{ label: "control", catches: "-", yaml: block(template("commit-chain")), settings: settingsOf("commit-chain") },
		]);
		const rows: InvalidRow[] = [];
		const formats: [string, ClaimConfigProblemCode][] = [
			["Blob", "unsupported-value"],
			["git-blob", "unsupported-value"],
			["commit_chain", "unsupported-value"],
			["1", "wrong-type"],
			["[blob]", "wrong-type"],
		];
		for (const [raw, code] of formats) {
			rows.push({
				label: `storage_format ${raw}`,
				catches: "case folding, alias or a default format",
				yaml: block(replaced(template(), "storage_format", raw)),
				problems: [problem("storage_format", code)],
			});
		}
		const modes: [string, ClaimConfigProblemCode][] = [
			["Lease", "unsupported-value"],
			["soft", "unsupported-value"],
			["timeout", "unsupported-value"],
			['""', "unsupported-value"],
			["0", "wrong-type"],
		];
		for (const [raw, code] of modes) {
			// ASSUMPTION(config): an unusable mode suppresses the mode-dependent checks of lease_ttl_ms and grace.
			rows.push({
				label: `lifetime_mode ${raw}`,
				catches: "case folding or a default mode",
				yaml: block(replaced(template(), "lifetime_mode", raw)),
				problems: [problem("lifetime_mode", code)],
			});
		}
		checkInvalid(rows);
	});

	test("cfg-06 keeps accepted endpoints byte-equal and rejects what the storage endpoint rule rejects", async () => {
		const accepted = [
			"git://git.example.org/team/project.git",
			"ssh://git@git.example.org:2222/team/project.git",
			"http://git.example.org/team/project.git",
			SECRET_ENDPOINT,
			"https://Git.Example.ORG/Team/Project.git/",
			"file:///srv/git/project.git",
			"git://[::1]:9418/project.git",
		];
		checkConfigured(
			accepted.map((endpoint) => ({
				label: `accepted ${endpoint.replaceAll(SENTINEL, "S")}`,
				catches: "normalization or a narrower scheme list",
				yaml: block(template("blob", "lease", true, endpoint)),
				settings: settingsOf("blob", "lease", true, endpoint),
			})),
		);
		const rejected = [
			"origin",
			"git@git.example.org:team/project.git",
			"ftp://git.example.org/project.git",
			`ftp://user-${SENTINEL}@git.example.org/${SENTINEL}.git`,
			"https://",
			"git:///project.git",
			"--upload-pack=touch /tmp/x",
			"ext::sh -c touch% /tmp/x",
			"ext::sh",
			"https://git.example.org/team project.git",
			"https://git.example.org/team\tproject.git",
			"https://git.example.org/team\u0001project.git",
			"https://git.example.org/x.git\nfile:///etc",
			"../project.git",
		];
		checkInvalid(
			rejected.map((endpoint, index) => ({
				label: `rejected #${index}`,
				catches: "remote names, scp style, option injection or a rule other than the storage one",
				yaml: block(replaced(template(), "endpoint", JSON.stringify(endpoint))),
				problems: [problem("endpoint", "unsupported-endpoint")],
			})),
		);
		checkInvalid([
			{
				label: "number",
				catches: "coercion",
				yaml: block(replaced(template(), "endpoint", "42")),
				problems: [problem("endpoint", "wrong-type")],
			},
			{
				label: "list",
				catches: "coercion",
				yaml: block(replaced(template(), "endpoint", "[a]")),
				problems: [problem("endpoint", "wrong-type")],
			},
		]);
		// Agreement with the storage rule; optionsError rejects these before any Git process.
		for (const [index, remote] of rejected.entries()) {
			const opened = await openClaimStore({ repository: "/nonexistent-claim-config-repo", remote, format: "blob" });
			expect({ index, kind: opened.kind }).toEqual({ index, kind: "invalid" });
		}
	});

	test("cfg-07 validates numbers as strict safe integers within their ranges", () => {
		// ASSUMPTION(config): attempt_timeout_ms and operation_budget_ms are capped at 2147483647; TTL and grace are not.
		const valid: [string, string, Partial<ClaimSettings>][] = [
			["attempt_timeout_ms", String(MAX_TIMER), { attemptTimeoutMs: MAX_TIMER }],
			["attempt_timeout_ms", "1", { attemptTimeoutMs: 1 }],
			["operation_budget_ms", String(MAX_TIMER), { operationBudgetMs: MAX_TIMER }],
			["attempts", "1", { attempts: 1 }],
		];
		const rows: ConfiguredRow[] = valid.map(([key, raw, changes]) => ({
			label: `${key}: ${raw}`,
			catches: "boundary rejected",
			yaml: block(replaced(template(), key, raw)),
			settings: { ...settingsOf(), ...changes },
		}));
		rows.push(
			{
				label: "reclaim_grace_ms: 0",
				catches: "grace forced above zero",
				yaml: block(replaced(template(), "reclaim_grace_ms", "0")),
				settings: { ...settingsOf(), lifetime: { mode: "lease", leaseTtlMs: 300_000, reclaimGraceMs: 0 } },
			},
			{
				label: "lease_ttl_ms beyond the timer cap",
				catches: "timer cap applied to the TTL",
				yaml: block(replaced(template(), "lease_ttl_ms", "2147483648")),
				settings: { ...settingsOf(), lifetime: { mode: "lease", leaseTtlMs: 2_147_483_648, reclaimGraceMs: 600_000 } },
			},
		);
		checkConfigured(rows);
		const keys = ["lease_ttl_ms", "reclaim_grace_ms", "attempt_timeout_ms", "attempts", "operation_budget_ms"];
		const invalid: InvalidRow[] = [];
		for (const key of keys) {
			const values: [string, ClaimConfigProblemCode][] = [
				["-1", "out-of-range"],
				["1.5", "wrong-type"],
				['"300000"', "wrong-type"],
				["5m", "wrong-type"],
				["true", "wrong-type"],
				["9007199254740992", "out-of-range"],
			];
			if (key !== "reclaim_grace_ms") values.push(["0", "out-of-range"]);
			if (key === "attempt_timeout_ms" || key === "operation_budget_ms") values.push(["2147483648", "out-of-range"]);
			for (const [raw, code] of values) {
				invalid.push({
					label: `${key}: ${raw}`,
					catches: "lax parseInt, string coercion or timer overflow",
					yaml: block(replaced(template(), key, raw)),
					problems: [problem(key, code)],
				});
			}
		}
		checkInvalid(invalid);
	});

	test("cfg-08 requires the keys of the chosen mode and rejects keys of another mode", () => {
		checkConfigured(
			MODES.map((mode) => ({
				label: `${mode} control`,
				catches: "-",
				yaml: block(template("blob", mode)),
				settings: settingsOf("blob", mode),
			})),
		);
		// ASSUMPTION(config): keys foreign to the mode are an error, not silently ignored.
		checkInvalid([
			{
				label: "lease without TTL",
				catches: "TTL start value as fallback",
				yaml: block(replaced(template("blob", "lease"), "lease_ttl_ms")),
				problems: [problem("lease_ttl_ms", "missing")],
			},
			{
				label: "lease without grace",
				catches: "grace start value as fallback",
				yaml: block(replaced(template("blob", "lease"), "reclaim_grace_ms")),
				problems: [problem("reclaim_grace_ms", "missing")],
			},
			{
				label: "hard with TTL",
				catches: "TTL silently ignored",
				yaml: block(replaced(template("blob", "hard"), "lease_ttl_ms", "300000")),
				problems: [problem("lease_ttl_ms", "not-applicable")],
			},
			{
				label: "hard without grace",
				catches: "grace start value as fallback",
				yaml: block(replaced(template("blob", "hard"), "reclaim_grace_ms")),
				problems: [problem("reclaim_grace_ms", "missing")],
			},
			{
				label: "none with TTL",
				catches: "TTL silently ignored",
				yaml: block(replaced(template("blob", "none"), "lease_ttl_ms", "300000")),
				problems: [problem("lease_ttl_ms", "not-applicable")],
			},
			{
				label: "none with grace",
				catches: "grace silently ignored",
				yaml: block(replaced(template("blob", "none"), "reclaim_grace_ms", "600000")),
				problems: [problem("reclaim_grace_ms", "not-applicable")],
			},
			{
				label: "none with both",
				catches: "only the first foreign key reported",
				yaml: block([...template("blob", "none"), ["reclaim_grace_ms", "1"], ["lease_ttl_ms", "1"]]),
				problems: [problem("lease_ttl_ms", "not-applicable"), problem("reclaim_grace_ms", "not-applicable")],
			},
		]);
	});

	test("cfg-09 accepts only YAML booleans for enabled", () => {
		checkConfigured([
			{
				label: "true",
				catches: "-",
				yaml: block(template("blob", "lease", true)),
				settings: settingsOf("blob", "lease", true),
			},
			{
				label: "false",
				catches: "-",
				yaml: block(template("blob", "lease", false)),
				settings: settingsOf("blob", "lease", false),
			},
		]);
		const rows: InvalidRow[] = ["yes", "on", "1", '"true"'].map((raw) => ({
			label: `enabled: ${raw}`,
			catches: "truthy interpretation (operations.ts toLowerCase)",
			yaml: block(replaced(template(), "enabled", raw)),
			problems: [problem("enabled", "wrong-type")],
		}));
		rows.push({
			label: "enabled missing",
			catches: "implicit on",
			yaml: block(replaced(template(), "enabled")),
			problems: [problem("enabled", "missing")],
		});
		checkInvalid(rows);
	});

	test("cfg-10 rejects unknown keys, including every attempt to configure a context default", () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		const extras: Entry[] = [
			["lease_ttl", "300000"],
			["context_directory", JSON.stringify(`/home/${SENTINEL}/context`)],
			["default_context", JSON.stringify(SENTINEL)],
			["context", JSON.stringify(`/srv/${SENTINEL}`)],
		];
		const rows: InvalidRow[] = extras.map(([key, raw]) => ({
			label: `unknown ${key}`,
			catches: "ignored typo or a context default through the configuration",
			yaml: block([...template(), [key, raw]]),
			problems: [problem(key, "unknown-key")],
		}));
		rows.push({
			label: "all four in document order",
			catches: "unknown keys sorted or truncated",
			yaml: block([...template(), ...extras]),
			problems: extras.map(([key]) => problem(key, "unknown-key")),
		});
		checkInvalid(rows);
	});

	test("cfg-11 rejects duplicate keys and a second column-0 block instead of letting the last one win", async () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		checkInvalid([
			{
				label: "attempts twice",
				catches: "last wins",
				yaml: block([...template(), ["attempts", "3"]]),
				problems: [problem("attempts", "duplicate")],
			},
			{
				label: "enabled twice",
				catches: "last wins toggles the gate",
				yaml: block([...template(), ["enabled", "false"]]),
				problems: [problem("enabled", "duplicate")],
			},
			{
				label: "two blocks",
				catches: "last block wins",
				yaml: `${block(template())}${block(template())}`,
				problems: [problem("claims", "duplicate")],
			},
			{
				label: "second block disables",
				catches: "last block wins",
				yaml: `${block(template())}claims:\n  enabled: false\n`,
				problems: [problem("claims", "duplicate")],
			},
		]);
		// ASSUMPTION(config): the raw block handed to the resolver lets it see a second column-0 block in the file.
		const { fs } = await project(BASE_TEXT);
		const file = `${BASE_TEXT}${block(template())}labels: ["x"]\n${block(replaced(template(), "enabled", "false"))}`;
		const label = "second block in the file (catches: silent last-block-wins at file level)";
		expect(viewOf(label, resolveClaimSettings(fs.parseConfig(file).claimsYaml))).toStrictEqual(
			invalidView(label, [problem("claims", "duplicate")]),
		);
	});

	test("cfg-12 reports unreadable YAML and a non-mapping block without echoing parser text", () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		checkInvalid([
			{
				label: "unterminated quote",
				catches: "parser message with values copied into the diagnostic",
				yaml:
					`claims:\n  enabled: true\n  endpoint: "https://user-${SENTINEL}@git.example.org/${SENTINEL}.git\n` +
					"  attempts: 3\n",
				problems: [problem("claims", "unreadable")],
			},
			{
				label: "unterminated flow sequence",
				catches: "parser message with values copied into the diagnostic",
				yaml: `claims:\n  enabled: [true\n  endpoint: ${SENTINEL}\n`,
				problems: [problem("claims", "unreadable")],
			},
			{
				label: "claims: true",
				catches: "scalar read as switch",
				yaml: "claims: true\n",
				problems: [problem("claims", "wrong-type")],
			},
			{
				label: "claims: [a]",
				catches: "list accepted",
				yaml: "claims: [a]\n",
				problems: [problem("claims", "wrong-type")],
			},
			{
				label: "sentinel scalar",
				catches: "scalar echoed",
				yaml: `claims: "${SENTINEL}"\n`,
				problems: [problem("claims", "wrong-type")],
			},
			{
				label: "sequence of mappings",
				catches: "first element used",
				yaml: "claims:\n  - enabled: true\n",
				problems: [problem("claims", "wrong-type")],
			},
		]);
	});

	test("cfg-13 lists every problem in schema order, then unknown keys in document order", () => {
		checkConfigured([{ label: "control", catches: "-", yaml: block(template()), settings: settingsOf() }]);
		checkInvalid([
			{
				label: "eight problems",
				catches: "first error only, document order or sorted unknown keys",
				yaml: block([
					["zeta_unknown", "1"],
					["operation_budget_ms", "0"],
					["storage_format", "Blob"],
					["lease_ttl_ms", '"300000"'],
					["alpha_unknown", "2"],
					["lifetime_mode", "lease"],
					["endpoint", "origin"],
					["attempts", "1.5"],
				]),
				problems: [
					problem("enabled", "missing"),
					problem("endpoint", "unsupported-endpoint"),
					problem("storage_format", "unsupported-value"),
					problem("lease_ttl_ms", "wrong-type"),
					problem("reclaim_grace_ms", "missing"),
					problem("attempt_timeout_ms", "missing"),
					problem("attempts", "wrong-type"),
					problem("operation_budget_ms", "out-of-range"),
					problem("zeta_unknown", "unknown-key"),
					problem("alpha_unknown", "unknown-key"),
				],
			},
			{
				label: "timeless mode with foreign keys",
				catches: "not-applicable ordered before a type error",
				yaml: block([
					["lease_ttl_ms", "1"],
					...replaced(template("blob", "none"), "enabled", "yes"),
					["reclaim_grace_ms", "1"],
				]),
				problems: [
					problem("enabled", "wrong-type"),
					problem("lease_ttl_ms", "not-applicable"),
					problem("reclaim_grace_ms", "not-applicable"),
				],
			},
		]);
	});

	test("cfg-14 keeps every message and the fixed reason free of values and credentials", () => {
		checkConfigured([
			{
				label: "endpoint stays data",
				catches: "-",
				yaml: block(template("blob", "lease", true, SECRET_ENDPOINT)),
				settings: settingsOf("blob", "lease", true, SECRET_ENDPOINT),
			},
		]);
		const quoted = JSON.stringify(SENTINEL);
		const rows: InvalidRow[] = [
			{
				label: "enabled",
				catches: "value echo",
				yaml: block(replaced(template(), "enabled", quoted)),
				problems: [problem("enabled", "wrong-type")],
			},
			{
				label: "endpoint word",
				catches: "value echo",
				yaml: block(replaced(template(), "endpoint", quoted)),
				problems: [problem("endpoint", "unsupported-endpoint")],
			},
			{
				label: "endpoint credentials",
				catches: "credential echo",
				yaml: block(replaced(template(), "endpoint", JSON.stringify(`ftp://u:${SENTINEL}@h.example/${SENTINEL}.git`))),
				problems: [problem("endpoint", "unsupported-endpoint")],
			},
			{
				label: "storage_format",
				catches: "value echo",
				yaml: block(replaced(template(), "storage_format", SENTINEL)),
				problems: [problem("storage_format", "unsupported-value")],
			},
			{
				label: "lifetime_mode",
				catches: "value echo",
				yaml: block(replaced(template(), "lifetime_mode", SENTINEL)),
				problems: [problem("lifetime_mode", "unsupported-value")],
			},
			{
				label: "unknown key value",
				catches: "value echo",
				yaml: block([...template(), ["mystery", quoted]]),
				problems: [problem("mystery", "unknown-key")],
			},
		];
		for (const key of ["lease_ttl_ms", "reclaim_grace_ms", "attempt_timeout_ms", "attempts", "operation_budget_ms"]) {
			rows.push({
				label: key,
				catches: "value echo",
				yaml: block(replaced(template(), key, quoted)),
				problems: [problem(key, "wrong-type")],
			});
		}
		checkInvalid(rows, [SECRET_ENDPOINT]);
		const reasons = [...rows.map(({ yaml }) => yaml), "claims: true\n", "claims:\n"].map((yaml) => {
			const result = resolveClaimSettings(yaml) as { reason?: unknown };
			return String(result.reason);
		});
		expect({ distinctReasons: new Set(reasons).size }).toEqual({ distinctReasons: 1 });
	});

	test("cfg-15 returns fresh results that share nothing with earlier calls", () => {
		const yaml = block(template("tree", "hard"));
		const expected: ClaimSettingsResult = { kind: "configured", settings: settingsOf("tree", "hard") };
		const first = resolveClaimSettings(yaml);
		expect(first).toStrictEqual(expected);
		const second = resolveClaimSettings(yaml);
		if (first.kind === "configured") {
			first.settings.endpoint = "mutated";
			first.settings.attempts = 99;
			if (first.settings.lifetime.mode === "hard") first.settings.lifetime.reclaimGraceMs = 1;
		}
		expect({ second, third: resolveClaimSettings(yaml) }).toStrictEqual({ second: expected, third: expected });

		const bad = block(replaced(replaced(template(), "attempts", "0"), "enabled"));
		const problems = [problem("enabled", "missing"), problem("attempts", "out-of-range")];
		const firstBad = resolveClaimSettings(bad);
		expect(viewOf("bad first", firstBad)).toStrictEqual(invalidView("bad first", problems));
		if (firstBad.kind === "config-invalid") {
			firstBad.problems.push({ key: "claims.x", problem: "missing", message: "claims.x" });
			const head = firstBad.problems[0];
			if (head) head.key = "claims.mutated";
		}
		expect(viewOf("bad again", resolveClaimSettings(bad))).toStrictEqual(invalidView("bad again", problems));
	});

	test("cfg-16 pins the confirmed start values used only for templates and messages", () => {
		expect(CLAIM_START_VALUES).toStrictEqual({
			leaseTtlMs: 300_000,
			reclaimGraceMs: 600_000,
			attemptTimeoutMs: 10_000,
			attempts: 3,
			operationBudgetMs: 30_000,
		});
	});
});

describe("claim block in the project configuration", () => {
	test("rt-01 captures the column-0 block byte-equal, with its comment and blank line", async () => {
		const commented = [
			"claims:",
			"  # coordination endpoint; never put credentials here",
			`  endpoint: ${JSON.stringify(ENDPOINT)}`,
			"  enabled: true",
			"",
			"  storage_format: commit-chain",
			"  lifetime_mode: hard",
			"  reclaim_grace_ms: 0",
			`  attempt_timeout_ms: ${MAX_TIMER}`,
			"  attempts: 1",
			"  operation_budget_ms: 30000",
		].join("\n");
		const { fs } = await project(fileWith(commented));
		const config = await fs.loadConfig();
		expect({ statuses: config?.statuses, block: blockOf(config?.claimsYaml) }).toEqual({
			statuses: ["To Do", "In Progress", "Done"],
			block: commented,
		});
		expect(resolveClaimSettings(config?.claimsYaml)).toStrictEqual({
			kind: "configured",
			settings: {
				...settingsOf("commit-chain", "hard"),
				lifetime: { mode: "hard", reclaimGraceMs: 0 },
				attemptTimeoutMs: MAX_TIMER,
				attempts: 1,
			},
		});
	});

	test("rt-02 leaves every other field, and the watcher, unaffected by the block", async () => {
		const { fs } = await project(BASE_TEXT);
		const { claimsYaml: _plainBlock, ...plain } = fs.parseConfig(BASE_TEXT);
		expect({ project: plain.projectName, prefix: plain.prefixes?.task }).toEqual({
			project: "Claims Project",
			prefix: "back",
		});
		const { claimsYaml: _block, ...rest } = fs.parseConfig(fileWith(VALID_BLOCK));
		expect({ label: "parser", rest }).toEqual({ label: "parser", rest: plain });
		for (const [label, content] of [
			["watcher without block", BASE_TEXT],
			["watcher with block", fileWith(VALID_BLOCK)],
		]) {
			const watched = await project(content ?? "");
			const published = await firstPublished(watched.fs);
			const { claimsYaml: _watched, ...fields } = published ?? { claimsYaml: undefined };
			expect({ label, fields }).toEqual({ label, fields: plain });
		}
	});

	test("rt-03 keeps the block unchanged at the end through load and save, also with invalid values", async () => {
		const raw = [
			"claims:",
			"  enabled: maybe",
			'  endpoint: "origin"',
			"  storage_format: zip",
			"  lifetime_mode: lease",
			'  lease_ttl_ms: "5m"',
			"  mystery_key: 1",
			"  # keep this comment",
		].join("\n");
		const { root, configPath, fs } = await project(fileWith(raw));
		const config = await fs.loadConfig();
		expect({ captured: blockOf(config?.claimsYaml) }).toEqual({ captured: raw });
		if (!config) throw new Error("config did not load");
		await fs.saveConfig(config);
		const saved = await readFile(configPath, "utf8");
		const reloaded = await new FileSystem(root).loadConfig();
		if (!reloaded) throw new Error("saved config did not load");
		await new FileSystem(root).saveConfig(reloaded);
		const again = await readFile(configPath, "utf8");
		expect({
			atEnd: blockOf(saved)?.endsWith(`\n${raw}`),
			reparsed: blockOf(reloaded.claimsYaml),
			labels: reloaded.labels,
			autoCommit: reloaded.autoCommit,
			idempotent: again === saved,
		}).toEqual({ atEnd: true, reparsed: raw, labels: ["api", "web"], autoCommit: true, idempotent: true });
	});

	test("rt-04 survives the startup migration that rewrites a minimal configuration", async () => {
		const minimalBase = [
			'project_name: "Minimal"',
			'statuses: ["To Do", "Done"]',
			"labels: []",
			"date_format: yyyy-mm-dd",
		];
		const minimal = `${minimalBase.join("\n")}\n${VALID_BLOCK}\n`;
		const { root, configPath } = await project(minimal);
		await new Core(root).ensureConfigMigrated();
		const reloaded = await new FileSystem(root).loadConfig();
		expect({ prefixes: reloaded?.prefixes, defaultPort: reloaded?.defaultPort }).toEqual({
			prefixes: { task: "task" },
			defaultPort: 6420,
		});
		const text = await readFile(configPath, "utf8");
		expect({ block: blockOf(reloaded?.claimsYaml), atEnd: blockOf(text)?.endsWith(`\n${VALID_BLOCK}`) }).toEqual({
			block: VALID_BLOCK,
			atEnd: true,
		});
	});

	test("rt-05 adds no claim block or default to a project without one", async () => {
		const { configPath, fs } = await project(BASE_TEXT);
		const loaded = await fs.loadConfig();
		await fs.saveConfig({ projectName: "P", statuses: ["To Do", "Done"], labels: [], dateFormat: "yyyy-mm-dd" });
		const saved = await readFile(configPath, "utf8");
		const migrated = migrateConfig({});
		const minimal = await project(
			`${['project_name: "Minimal"', "labels: []", "date_format: yyyy-mm-dd"].join("\n")}\n`,
		);
		await new Core(minimal.root).ensureConfigMigrated();
		const migratedText = await readFile(minimal.configPath, "utf8");
		expect({
			claimsYaml: loaded?.claimsYaml,
			saved,
			claimKeys: Object.keys(migrated).filter((key) => /claim/i.test(key)),
			needsMigration: needsMigration(migrated),
			migratedHasBlock: /^claims\s*:/m.test(migratedText),
		}).toEqual({
			claimsYaml: undefined,
			saved: 'project_name: "P"\nstatuses: ["To Do", "Done"]\nlabels: []\ndate_format: yyyy-mm-dd\n',
			claimKeys: [],
			needsMigration: false,
			migratedHasBlock: false,
		});
	});

	test("rt-06 never validates the block while loading, while broken list keys still stop the start", async () => {
		const { fs } = await project(BASE_TEXT);
		expect(() => fs.parseConfig('project_name: "P"\nstatuses: ["To Do]\n')).toThrow("Backlog could not start because");
		const { claimsYaml: _none, ...plain } = fs.parseConfig(BASE_TEXT);
		// ASSUMPTION(config): claim validation is lazy; a bad block must not block normal operation or the MCP root.
		const rows = [
			{
				label: "semantically invalid",
				catches: "claim validation in the start path",
				yaml: "claims:\n  enabled: maybe\n  attempts: 0\n  bogus: 1\n",
			},
			{
				label: "unreadable YAML",
				catches: "YAML error of the block thrown at start",
				yaml: `claims:\n  endpoint: "https://${SENTINEL}@git.example.org/r.git\n  enabled: [true\n`,
			},
		];
		for (const { label, catches, yaml } of rows) {
			const tagged = `${label} (catches: ${catches})`;
			let outcome: { threw: boolean; rest: unknown };
			try {
				const { claimsYaml: _claims, ...rest } = fs.parseConfig(fileWith(yaml));
				outcome = { threw: false, rest };
			} catch {
				outcome = { threw: true, rest: undefined };
			}
			const loaded = await (await project(fileWith(yaml))).fs.loadConfig().then(
				(config) => config !== null,
				() => false,
			);
			expect({ label: tagged, ...outcome, loaded }).toEqual({ label: tagged, threw: false, rest: plain, loaded: true });
		}
	});

	test("rt-07 refuses to save a block without its column-0 header or with column-0 lines, leaving the file", async () => {
		const { configPath, fs } = await project(BASE_TEXT);
		const config = await fs.loadConfig();
		if (!config) throw new Error("config did not load");
		const accepted = await saveOutcome(fs, { ...config, claimsYaml: VALID_BLOCK });
		const written = await readFile(configPath, "utf8");
		expect({ accepted, atEnd: blockOf(written)?.endsWith(`\n${VALID_BLOCK}`) }).toEqual({
			accepted: "saved",
			atEnd: true,
		});
		const rows = [
			{ label: "no header", catches: "body saved without its key", claimsYaml: "  enabled: true\n  attempts: 3\n" },
			{
				label: "indented header",
				catches: "nested block saved as top level",
				claimsYaml: "  claims:\n    enabled: true\n",
			},
			{ label: "other header", catches: "prefix match on the header", claimsYaml: "claims_backup:\n  enabled: true\n" },
			{
				label: "column-0 key",
				catches: "auto_commit injected through browser JSON",
				claimsYaml: `${VALID_BLOCK}\nauto_commit: true\n`,
			},
			{
				label: "key after a blank line",
				catches: "project_name injected",
				claimsYaml: `${VALID_BLOCK}\n\nproject_name: "Hijacked"\n`,
			},
			{ label: "column-0 list item", catches: "unindented continuation", claimsYaml: `${VALID_BLOCK}\n- injected\n` },
		];
		for (const { label, catches, claimsYaml } of rows) {
			const tagged = `${label} (catches: ${catches})`;
			const outcome = await saveOutcome(fs, { ...config, claimsYaml });
			const unchanged = (await readFile(configPath, "utf8")) === written;
			expect({ label: tagged, outcome, unchanged }).toEqual({ label: tagged, outcome: "threw", unchanged: true });
		}
	});

	test("rt-08 refuses to save a block with any carriage return, leaving the file", async () => {
		const { configPath, fs } = await project(BASE_TEXT);
		const config = await fs.loadConfig();
		if (!config) throw new Error("config did not load");
		// Positive control: the same block without carriage returns saves at the end of the file.
		const accepted = await saveOutcome(fs, { ...config, claimsYaml: VALID_BLOCK });
		const written = await readFile(configPath, "utf8");
		expect({ accepted, atEnd: blockOf(written)?.endsWith(`\n${VALID_BLOCK}`) }).toEqual({
			accepted: "saved",
			atEnd: true,
		});
		// Other YAML readers break lines at a bare CR, so a CR could smuggle a column-0 key past
		// a guard that splits at LF only; the guard fails closed on every CR (operations.ts claimsBlockError).
		const rows = [
			{
				label: "bare CR before a column-0 key",
				catches: "auto_commit injected behind a CR",
				claimsYaml: `${VALID_BLOCK}\rauto_commit: true\n`,
			},
			{
				label: "CRLF line endings",
				catches: "a CR accepted when paired with LF",
				claimsYaml: `${VALID_BLOCK.replaceAll("\n", "\r\n")}\r\n`,
			},
			{ label: "trailing bare CR", catches: "a CR accepted at the end of the block", claimsYaml: `${VALID_BLOCK}\r` },
		];
		for (const { label, catches, claimsYaml } of rows) {
			const tagged = `${label} (catches: ${catches})`;
			const outcome = await saveOutcome(fs, { ...config, claimsYaml });
			const unchanged = (await readFile(configPath, "utf8")) === written;
			expect({ label: tagged, outcome, unchanged }).toEqual({ label: tagged, outcome: "threw", unchanged: true });
		}
	});
});
