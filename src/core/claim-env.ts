/**
 * The environment builders the CLI's `claim.ts` used to keep module-private
 * — `readLocalTickets`, `baseEnv` and the body of `projectEnv` — moved here unchanged so the MCP claim tools reuse
 * exactly the same core, never a duplicate. The CLI resolves the project root itself and calls `claimProjectEnv`;
 * MCP resolves it from `server.filesystem.rootDir` per call and passes test seams through `seams`.
 */
import { randomUUID } from "node:crypto";
import {
	type ClaimCommand,
	type ClaimDocument,
	type ClaimLocalTickets,
	type ClaimSurfaceEnv,
	type ClaimTicketSelection,
	claimErrorDocument,
} from "../claims/surface/index.ts";
import { FileSystem, isConfigValueError } from "../file-system/operations.ts";
import type { Task } from "../types/index.ts";
import { canonicalTaskId, resolveTaskById } from "../utils/task-id.ts";
import { Core } from "./backlog.ts";
import { loadTaskCorpus } from "./task-detail.ts";

/** The seams a caller may inject over the freshly built environment; the identity fields stay fixed per call. */
export type ClaimEnvSeams = Partial<Omit<ClaimSurfaceEnv, "projectRoot" | "claimsYaml" | "taskPrefix">>;

/**
 * The mandatory seam over the same calls as `task list --ready` (cli.ts `runTaskList`,
 * core/task-detail.ts `loadTaskListItems`): the working-copy query with the shared filter and search, and readiness
 * over the whole local corpus with the completed records. `null` loads the corpus alone for the acquire gate. A read
 * that fails is `unavailable`, never an empty corpus.
 */
async function readLocalTickets(
	projectRoot: string,
	selection: ClaimTicketSelection | null,
): Promise<ClaimLocalTickets> {
	const core = new Core(projectRoot);
	try {
		let matched: Task[] = [];
		if (selection !== null) {
			const { filter, query } = selection;
			matched = await core.queryTasks({
				query: query || undefined,
				filters: Object.keys(filter).length > 0 ? filter : undefined,
				includeCrossBranch: false,
			});
		}
		const corpus = await loadTaskCorpus(core);
		const config = await core.filesystem.loadConfig();
		return { kind: "loaded", matched, corpus, priorities: config?.priorities ?? [] };
	} catch {
		return { kind: "unavailable" };
	} finally {
		core.disposeSearchService();
		core.disposeContentStore();
	}
}

/** Seams shared by every environment: wall clock, monotonic clock, random, sleep and `op-<uuid v4>`. */
export function baseEnv(projectRoot: string, claimsYaml: string | undefined, taskPrefix: string): ClaimSurfaceEnv {
	return {
		projectRoot,
		claimsYaml,
		taskPrefix,
		findLocalTicket: async () => ({ kind: "missing" }),
		clock: () => Date.now(),
		monotonicNow: () => performance.now(),
		random: () => Math.random(),
		sleep: (ms: number) => Bun.sleep(ms),
		newOperationId: () => `op-${randomUUID()}`,
		loadLocalTickets: (selection: ClaimTicketSelection | null) => readLocalTickets(projectRoot, selection),
	};
}

/**
 * The project at `projectRoot` with its configuration read fresh for this call; a missing project or an unreadable
 * configuration is a refused document, never text on stderr. `seams` overrides the built environment last,
 * so tests can pin the clock, random, ids or IO without touching the identity fields.
 */
export async function claimProjectEnv(
	projectRoot: string,
	command: ClaimCommand,
	seams?: ClaimEnvSeams,
): Promise<ClaimSurfaceEnv | ClaimDocument> {
	const filesystem = new FileSystem(projectRoot);
	let config: Awaited<ReturnType<FileSystem["loadConfig"]>>;
	try {
		config = await filesystem.loadConfig();
	} catch (error) {
		const code = isConfigValueError(error) ? "project-config-unreadable" : "internal";
		return claimErrorDocument({ command, code });
	}
	if (config === null) return claimErrorDocument({ command, code: "project-not-found" });
	const env = baseEnv(projectRoot, config.claimsYaml, config.prefixes?.task ?? "task");
	env.findLocalTicket = async (input: string) => {
		const found = resolveTaskById(await filesystem.listTasks(), input);
		if (found.status === "found") return { kind: "found", ticket: canonicalTaskId(found.task.id) };
		return { kind: found.status === "ambiguous" ? "ambiguous" : "missing" };
	};
	env.writeClaimsYaml = async (claimsYaml: string) => {
		// A fresh file system, so a block written since the load above is seen and never overwritten.
		const fresh = new FileSystem(projectRoot);
		const current = await fresh.loadConfig();
		if (current === null) throw new Error("the project configuration is missing");
		if (current.claimsYaml !== undefined) return "exists";
		await fresh.saveConfig({ ...current, claimsYaml });
		return "written";
	};
	return seams ? { ...env, ...seams } : env;
}

/** The former `isDocument` of claim.ts: distinguishes a built environment from an early refusal document. */
export function isClaimDocument(value: ClaimSurfaceEnv | ClaimDocument): value is ClaimDocument {
	return "schemaVersion" in value;
}
