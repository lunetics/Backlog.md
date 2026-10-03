/**
 * The one mapping of the `task list` filter flags onto `TaskListFilter`:
 * `task list` and the claim commands share it, so a flag can never mean two things. It prints
 * nothing and sets no exit code; each caller renders a refusal in its own form (`task list` its text and exit 1,
 * the claim commands a `claim-error` document). The filter is applied by `Core.queryTasks`, never here.
 */
import type { Core } from "../core/backlog.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { formatValidPriorityValues, resolvePriorityValue } from "../utils/priority-config.ts";
import {
	formatValidProjectValues,
	getProjectValues,
	noProjectsConfiguredMessage,
	resolveProjectValues,
} from "../utils/project-config.ts";
import { formatValidStatuses, getCanonicalStatuses } from "../utils/status.ts";
import { parseClearableStringList, parseDelimitedStringList } from "../utils/task-builders.ts";
import { AmbiguousTaskIdError, isAmbiguousTaskIdError, LOCAL_TASK_LOOKUP_HINT } from "../utils/task-path.ts";
import { formatValidTaskTypeValues, resolveTaskTypeValues } from "../utils/task-type-config.ts";

/** The filter flags as Commander hands them over; the repeatable ones arrive as one string or a list of them. */
export type TaskFilterOptions = {
	status?: string | string[];
	excludeStatus?: string | string[];
	assignee?: string;
	unassigned?: boolean;
	milestone?: string;
	parent?: string;
	priority?: string;
	type?: string | string[];
	project?: string | string[];
	labels?: string | string[];
	search?: string;
};

export type TaskFilterMapping =
	| {
			kind: "mapped";
			filter: TaskListFilter;
			/** `--labels` as parsed; `task list` names them in its interactive title. */
			labels: string[];
			/** `--search`, trimmed; empty when absent. */
			query: string;
			/** `--parent`, trimmed and not yet resolved or put into `filter`; undefined when absent. */
			parent: string | undefined;
			/**
			 * Options given with only blank values (`parseClearableStringList` semantics: absent is not blank). `task
			 * list` ignores them as before, `claim next` refuses them, the batch commands need a scope.
			 */
			blank: string[];
	  }
	| { kind: "invalid"; option: string; message: string };

type Validated = { kind: "valid"; values: string[] } | { kind: "invalid"; option: string; message: string };

const LIST_OPTIONS = ["status", "excludeStatus", "type", "project", "labels"] as const;
const SCALAR_OPTIONS = ["assignee", "milestone", "parent", "priority", "search"] as const;

function blankOptions(options: TaskFilterOptions): string[] {
	const blank: string[] = [];
	for (const name of LIST_OPTIONS) {
		if (parseClearableStringList(options[name])?.length === 0) blank.push(name);
	}
	for (const name of SCALAR_OPTIONS) {
		const value = options[name];
		if (typeof value === "string" && value.trim() === "") blank.push(name);
	}
	return blank;
}

/** `getCanonicalStatuses` against the configured statuses: case- and space-insensitive, the canonical spelling. */
async function canonicalStatuses(core: Core, values: string[], option: string): Promise<Validated> {
	const { values: canonical, invalid, validStatuses } = await getCanonicalStatuses(values, core);
	if (invalid.length === 0) return { kind: "valid", values: canonical };
	const valid = formatValidStatuses(validStatuses);
	return { kind: "invalid", option, message: `Invalid ${option}: ${invalid.join(", ")}. Valid statuses are: ${valid}` };
}

async function canonicalTypes(core: Core, values: string[]): Promise<Validated> {
	const config = await core.filesystem.loadConfig();
	const { values: canonical, invalid } = resolveTaskTypeValues(values, config);
	if (invalid.length === 0) return { kind: "valid", values: canonical };
	const message = `Invalid type: ${invalid.join(", ")}. Valid types are: ${formatValidTaskTypeValues(config)}`;
	return { kind: "invalid", option: "type", message };
}

async function canonicalProjects(core: Core, values: string[]): Promise<Validated> {
	const config = await core.filesystem.loadConfig();
	if (getProjectValues(config).length === 0) {
		const message = noProjectsConfiguredMessage(core.filesystem.configFilePath);
		return { kind: "invalid", option: "project", message };
	}
	const { values: canonical, invalid } = resolveProjectValues(values, config);
	if (invalid.length === 0) return { kind: "valid", values: canonical };
	const message = `Invalid project: ${invalid.join(", ")}. Valid projects are: ${formatValidProjectValues(config)}`;
	return { kind: "invalid", option: "project", message };
}

/**
 * Maps the flags in the order and with the texts `task list` has always used. `validateStatus` is set by the claim
 * commands only: their `--status` is canonicalized and an unknown value refused like `--exclude-status`;
 * `task list` keeps passing `--status` through unvalidated.
 */
export async function mapTaskFilterOptions(
	core: Core,
	options: TaskFilterOptions,
	validation: { validateStatus: boolean },
): Promise<TaskFilterMapping> {
	const blank = blankOptions(options);
	if (options.assignee && options.unassigned) {
		return { kind: "invalid", option: "unassigned", message: "--unassigned cannot be combined with --assignee." };
	}
	const filter: TaskListFilter = {};
	if (validation.validateStatus) {
		const statuses = parseDelimitedStringList(options.status) ?? [];
		if (statuses.length > 0) {
			const checked = await canonicalStatuses(core, statuses, "status");
			if (checked.kind === "invalid") return checked;
			filter.status = checked.values;
		}
	} else if (options.status) {
		filter.status = parseDelimitedStringList(options.status) ?? options.status;
	}
	const excludeStatuses = parseDelimitedStringList(options.excludeStatus) ?? [];
	if (excludeStatuses.length > 0) {
		const checked = await canonicalStatuses(core, excludeStatuses, "exclude-status");
		if (checked.kind === "invalid") return checked;
		filter.excludeStatus = checked.values;
	}
	if (options.assignee) filter.assignee = options.assignee;
	if (options.unassigned) filter.unassigned = true;
	if (options.milestone) filter.milestone = options.milestone;
	if (options.priority) {
		const config = await core.filesystem.loadConfig();
		const value = String(options.priority);
		const priority = resolvePriorityValue(value, config);
		if (!priority) {
			const message = `Invalid priority: ${value}. Valid values are: ${formatValidPriorityValues(config)}`;
			return { kind: "invalid", option: "priority", message };
		}
		filter.priority = priority;
	}
	const types = parseDelimitedStringList(options.type) ?? [];
	if (types.length > 0) {
		const checked = await canonicalTypes(core, types);
		if (checked.kind === "invalid") return checked;
		filter.type = checked.values;
	}
	const projects = parseDelimitedStringList(options.project) ?? [];
	if (projects.length > 0) {
		const checked = await canonicalProjects(core, projects);
		if (checked.kind === "invalid") return checked;
		filter.project = checked.values;
	}
	const labels = parseDelimitedStringList(options.labels) ?? [];
	if (labels.length > 0) {
		// `--labels` is documented as requiring every listed label.
		filter.labels = labels;
		filter.labelMatch = "all";
	}
	const query = typeof options.search === "string" ? options.search.trim() : "";
	const parent = options.parent === undefined ? undefined : String(options.parent).trim();
	return { kind: "mapped", filter, labels, query, parent, blank };
}

/**
 * Resolve a --parent argument to the single task it names, before any child task is read.
 *
 * This is the same working-copy lookup that `task view` and `task create --parent` use, so one ID
 * cannot name a filterable parent for one command and a missing task for another. Identity fails
 * closed exactly as it does for a targeted task ID: a value matching several files must not silently
 * filter on whichever one came first. Returns the resolved canonical ID so filtering never runs on
 * the raw input.
 */
export async function resolveParentFilterId(core: Core, parentId: string, parentDisplayId: string): Promise<string> {
	let parent: Task | null;
	try {
		parent = await core.loadTaskById(parentId, { includeCrossBranch: false });
	} catch (error) {
		// Report the collision under the configured prefix, which a bare numeric argument lacks.
		if (isAmbiguousTaskIdError(error)) throw new AmbiguousTaskIdError(parentDisplayId, error.candidates);
		throw error;
	}
	if (!parent) {
		throw new Error(`Parent task ${parentDisplayId} not found. ${LOCAL_TASK_LOOKUP_HINT}`);
	}
	return parent.id;
}

/**
 * Repeatable filter flags collect every value, both for `task list`/`task create` (cli.ts) and the claim
 * commands (claim.ts) — one Commander option processor shared by both. Tolerant of a `string` previous
 * value (a default set as the fourth `.option()` argument) in addition to the usual `string[]` or `undefined`.
 */
export function createMultiValueAccumulator() {
	return (value: string, previous: string | string[] | undefined) => {
		const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
		return [...soFar, value];
	};
}
