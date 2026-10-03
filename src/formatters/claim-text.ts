/**
 * Human-mode renderer for the canonical claim CLI. Takes only the public document
 * as input, so both output modes share the same allowlist by construction. The first line is always
 * `<status>: <sentence>`; refused, unavailable and internal go to stderr, every other status to stdout. The text is
 * for people and not a machine interface: agents read the `--json` document.
 */
import type {
	ClaimDocument,
	ClaimEmergencyPreviewDocument,
	ClaimEpochDocument,
	ClaimEpochPreviewDocument,
	ClaimErrorDocument,
	ClaimListDocument,
	ClaimNextAttempt,
	ClaimNextDocument,
	ClaimOperationDocument,
	ClaimPauseDocument,
	ClaimReclaimBatchDocument,
	ClaimReclaimPreviewDocument,
	ClaimResolutionDocument,
	ClaimRightsView,
	ClaimStorageView,
	ClaimTimingView,
} from "../claims/surface/index.ts";

const STDERR_STATUSES: readonly string[] = ["refused", "unavailable", "internal"];
/** `toISOString` throws beyond ±8.64e15 ms; such instants print as the raw number (out-08). */
const MAX_DATE_MS = 8_640_000_000_000_000;
const NOT_FREE = "unknown is not free: do not treat the ticket as free or released";

/** Owner names come from other writers; control characters never reach the terminal (out-07). */
export function printable(text: string): string {
	let result = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
	}
	return result;
}

function instant(ms: number): string {
	if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAX_DATE_MS) return String(ms);
	return new Date(ms).toISOString();
}

function timingText(timing: ClaimTimingView): string {
	if (timing.mode === "none") return "no time limit";
	if (timing.mode === "hard") return `hard end ${instant(timing.hardEnd)}, grace ${timing.graceMs} ms`;
	const hardEnd = timing.hardEnd === null ? "" : `, hard end ${instant(timing.hardEnd)}`;
	return `lease end ${instant(timing.leaseEnd)}${hardEnd}, grace ${timing.graceMs} ms`;
}

type EvaluatedRights = Extract<ClaimRightsView, { kind: "evaluated" }>;

function workText(workRight: EvaluatedRights["workRight"]): string {
	if (workRight.kind === "none") return `no work right (${workRight.cause})`;
	return workRight.renewalDue === true ? "work right live, renewal due" : "work right live";
}

function reclaimText(reclaim: EvaluatedRights["reclaim"]): string {
	if (!("boundary" in reclaim)) return `reclaim ${reclaim.kind}`;
	return `reclaim ${reclaim.kind} at ${instant(reclaim.boundary)}`;
}

function rightsText(rights: ClaimRightsView): string {
	if (rights.kind !== "evaluated") return `rights: not evaluated (${rights.kind})`;
	const facts = [rights.ownership, workText(rights.workRight), reclaimText(rights.reclaim)];
	return `rights: ${facts.join(", ")} (observed state only)`;
}

function storageText(storage: ClaimStorageView): string {
	switch (storage.kind) {
		case "applied":
			return "storage: applied";
		case "rejected":
			return `storage: rejected (${storage.cause})`;
		case "queried": {
			const query = storage.query.kind === "resolved" ? `resolved ${storage.query.resolution}` : storage.query.kind;
			return `storage: queried after ${storage.after}, ${query}`;
		}
		case "not-sent":
			return `storage: not sent (${storage.cause})`;
	}
}

function resolveHint(operationId: string): string[] {
	return [
		`  next: backlog claim resolve ${operationId} --context <context>`,
		`  while it stays open: backlog claim retry ${operationId} --context <context>`,
	];
}

/** Plan causes with the way forward, after the first line. */
const PLAN_HINTS: Partial<Record<string, string>> = {
	"time-box-required": "pass --time-box preserve or configure claims.transfer_time_box",
	"lease-required": "pass --ttl-ms with the lease length for the receiver",
	"requires-time-path": "only a later hard end extends a claim, and only with claims enabled: pass it with --hard-end",
	"pending-transition": "an unconfirmed transfer or extension blocks the ticket until it is confirmed or reclaimed",
	"stale-root": "the claim moved since the preview: run --preview again and check the new root",
};

/** The phase of a T call, and for a witnessed one the retry that publishes its confirmation. */
function transitionLines(transition: { phase: string; confirmOperationId: string | null }): string[] {
	const lines = [`  phase: ${transition.phase}`];
	if (transition.phase === "witnessed" && transition.confirmOperationId !== null) {
		lines.push(`  confirm it: backlog claim retry ${transition.confirmOperationId} --context <context>`);
	}
	return lines;
}

/** The two display names of an unresolved transition, without control characters. */
function fromTo(transition: { from: string; to: string }): string {
	return `from ${printable(transition.from)} to ${printable(transition.to)}`;
}

function operationText(document: ClaimOperationDocument): string[] {
	const { action, ticket, operationId } = document;
	const lines: string[] = [];
	switch (document.status) {
		case "applied":
			lines.push(`applied: ${action} of ${ticket} is stored`);
			break;
		case "rejected": {
			const rejection = document.rejection;
			const cause = rejection === null ? "" : ` (${rejection.stage}: ${rejection.cause})`;
			lines.push(`rejected: ${action} of ${ticket} was not applied${cause}`);
			if (rejection?.boundary !== undefined) lines.push(`  boundary: ${instant(rejection.boundary)}`);
			const hint = rejection?.stage === "plan" ? PLAN_HINTS[rejection.cause] : undefined;
			if (hint !== undefined) lines.push(`  ${hint}`);
			break;
		}
		case "unknown":
			lines.push(`unknown: the outcome of ${action} on ${ticket} is unknown; ${NOT_FREE}`);
			break;
		case "unknown-history":
			lines.push(`unknown-history: the outcome of ${action} on ${ticket} cannot be settled from the stored history`);
			break;
		case "unavailable":
			lines.push(`unavailable: ${action} of ${ticket} was not sent`);
			break;
	}
	lines.push(`  operation: ${operationId ?? "none (nothing was recorded)"}`);
	if (document.storage !== null) lines.push(`  ${storageText(document.storage)}`);
	lines.push(`  sends: ${document.sends}${document.stoppedBy === null ? "" : `, stopped by ${document.stoppedBy}`}`);
	const { planned } = document;
	if (planned !== null) {
		const timing = planned.timing === null ? "" : `, ${timingText(planned.timing)}`;
		const capped = planned.capped ? " (capped at the hard end)" : "";
		lines.push(`  planned: ${planned.status}, generation ${planned.claimGeneration}${timing}${capped}`);
	}
	lines.push(`  ${rightsText(document.rights)}`);
	if (document.transition !== undefined) lines.push(...transitionLines(document.transition));
	// A witnessed T call prints the confirm hint and the base hints on P's ID; both hold: retry of P continues the
	// transition, retry of the confirmation ID publishes the recorded witness.
	if (operationId !== null && (document.status === "unknown" || document.status === "unavailable")) {
		lines.push(...resolveHint(operationId));
	}
	return lines;
}

function pauseText(document: ClaimPauseDocument): string[] {
	const { action, ticket, pause } = document;
	const lines = [`paused: ${action} of ${ticket} waits for own earlier operations; nothing was sent`];
	if (pause.kind === "outstanding") {
		lines.push(`  open operations: ${pause.operationIds.join(", ")}`);
		lines.push("  way out: backlog claim retry <operation-id> --context <context> for each (retry never pauses)");
	} else {
		lines.push("  the own journal could not be read completely; resolve or retry the open operations first");
	}
	lines.push(`  ${rightsText(document.rights)}`);
	return lines;
}

function resolutionText(document: ClaimResolutionDocument): string[] {
	const { operationId, action, ticket, query } = document;
	const subject = `operation ${operationId} (${action} of ${ticket})`;
	const sentences: Record<ClaimResolutionDocument["status"], string> = {
		applied: "is stored",
		rejected: "was not applied",
		unknown: `has an unknown outcome; ${NOT_FREE}`,
		"unknown-history": "cannot be settled from the stored history; check the current state with backlog claim list",
	};
	const queried = query.kind === "resolved" ? `resolved ${query.resolution}` : query.kind;
	const lines = [`${document.status}: ${subject} ${sentences[document.status]}`, `  query: ${queried}`];
	if (document.transition !== undefined) lines.push(...transitionLines(document.transition));
	if (query.kind === "resolved" && query.resolution === "open") {
		lines.push(`  retry resends it: backlog claim retry ${operationId} --context <context>`);
	}
	return lines;
}

function listText(document: ClaimListDocument): string[] {
	const count = document.claims.length === 1 ? "1 claim" : `${document.claims.length} claims`;
	const lines = [`ok: ${count} observed at ${instant(document.observedAt)}`];
	if (!document.complete) lines[0] = `unknown: the listing is incomplete (${count}); ${NOT_FREE}`;
	for (const entry of document.claims) {
		const parts = [entry.ticket, entry.state];
		if (entry.owner !== undefined) parts.push(`owner ${printable(entry.owner)}`);
		if (entry.transition !== undefined) parts.push(fromTo(entry.transition));
		if (entry.claimGeneration !== undefined) parts.push(`generation ${entry.claimGeneration}`);
		if (entry.timing !== undefined) parts.push(timingText(entry.timing));
		if (entry.reclaimBoundary !== undefined) parts.push(`reclaim not before ${instant(entry.reclaimBoundary)}`);
		if (entry.rights?.kind === "evaluated") parts.push(entry.rights.ownership);
		lines.push(`  ${parts.join("  ")}`);
	}
	return lines;
}

const ERROR_HINTS: Partial<Record<ClaimErrorDocument["code"], string>> = {
	"not-configured": "set up the block with: backlog claim setup --endpoint <url> --storage-format <format> ...",
	"descriptor-missing": "initialize the area with: backlog claim init",
	"context-required": "create a context with: backlog claim context create --parent <private directory>",
	"operation-id-in-use": "choose another operation ID or omit --operation-id",
	"budget-exhausted": "nothing was sent; run the command again",
	"schema-unsupported": "update Backlog.md",
	"target-context-invalid": "pass --to-context with the absolute path of another agent's loadable context",
	"recovery-missing":
		"create one with: backlog claim context create --parent <private directory> --recover-from <old context>",
	"bounds-required": "pass --mode and the complete target timing; to keep the hard end, pass --hard-end again",
	"dependency-blocked": "finish the prerequisites first, or set claims.acquire_dependency_policy to permissive",
	"dependency-unknown": "fix or remove the prerequisite IDs that do not name exactly one local task",
	"tasks-unavailable": "check that the backlog tasks directory is readable, then run the command again",
	"authority-required": "list the authority ID from backlog claim context show in claims.recovery_authorities",
	"expectation-required": "run with --preview first, then pass the root it shows with --expect-root",
};

function errorText(document: ClaimErrorDocument): string[] {
	const lines = [`${document.status}: ${document.code} - ${document.message}`];
	if (document.operationId !== null) lines.push(`  operation: ${document.operationId}`);
	for (const problem of document.problems ?? []) lines.push(`  ${problem.key}: ${problem.problem}`);
	if (document.configuredFormat !== undefined && document.existingFormat !== undefined) {
		lines.push(`  configured format: ${document.configuredFormat}, existing format: ${document.existingFormat}`);
	}
	if (document.dependencies !== undefined) {
		const { blocking, unknown, unreadable } = document.dependencies;
		if (blocking.length > 0) lines.push(`  unfinished prerequisites: ${blocking.join(", ")}`);
		if (unknown.length > 0) lines.push(`  unresolved prerequisites: ${unknown.join(", ")}`);
		if (unreadable > 0) lines.push(`  prerequisite entries that are no task ID: ${unreadable}`);
	}
	const hint = ERROR_HINTS[document.code];
	if (hint !== undefined) lines.push(`  ${hint}`);
	if (document.status === "unknown") lines.push(`  ${NOT_FREE}`);
	return lines;
}

const NEXT_SENTENCES: Record<ClaimNextDocument["stop"]["kind"], string> = {
	claimed: "claimed the next ready ticket",
	"no-candidates": "no ready ticket matched the filters; nothing was sent",
	exhausted: "every candidate was tried and none could be claimed",
	bound: "the attempt bound was reached before a ticket could be claimed",
	attempt: "claim next stopped at this attempt; no further ticket was reserved",
	"outstanding-acquire": "own acquire operations of this context are still open; no ticket was tried",
	"journal-unknown": "the own journal could not be read completely; no ticket was tried",
};

/** One attempt in one line: ticket, status and the rejection or error code, never more of the document. */
function attemptLine(attempt: ClaimNextAttempt): string {
	if ("code" in attempt) return `  attempt: ${attempt.ticket ?? "-"} ${attempt.status} (${attempt.code})`;
	if ("pause" in attempt) return `  attempt: ${attempt.ticket} paused`;
	const { rejection } = attempt;
	const cause = rejection === null ? "" : ` (${rejection.stage}: ${rejection.cause})`;
	return `  attempt: ${attempt.ticket} ${attempt.status}${cause}`;
}

/** The way out of a stop: resolve for an unknown outcome, retry for open own operations. */
function nextWayOut(document: ClaimNextDocument): string[] {
	const { stop, operationId } = document;
	if ("operationIds" in stop) {
		return [
			`  open operations: ${stop.operationIds.join(", ")}`,
			"  way out: backlog claim retry <operation-id> --context <context> for each (retry never pauses)",
		];
	}
	if (stop.kind === "journal-unknown") {
		return ["  resolve or retry the open operations first: backlog claim resolve <operation-id> --context <context>"];
	}
	if (document.status === "unknown" && operationId !== null) return [`  ${NOT_FREE}`, ...resolveHint(operationId)];
	const last = document.attempts.at(-1);
	if (stop.kind !== "attempt" || last === undefined || !("pause" in last)) return [];
	if (last.pause.kind !== "outstanding") {
		return ["  the own journal could not be read completely; resolve or retry the open operations first"];
	}
	return pauseText(last).slice(1, 3);
}

/** `<status>: <sentence>`, the candidates, what was excluded, every attempt, then the way out. */
function nextText(document: ClaimNextDocument): string[] {
	const { stop, excluded } = document;
	const subject = document.ticket === null ? "" : ` (${document.ticket})`;
	const lines = [`${document.status}: ${NEXT_SENTENCES[stop.kind]}${subject}`];
	lines.push(`  candidates: ${document.candidates.length === 0 ? "none" : document.candidates.join(", ")}`);
	const counts = [
		`${excluded.blocked} blocked`,
		`${excluded.dependencyUnknown} with unknown dependencies`,
		`${excluded.notActionable} not actionable`,
	];
	lines.push(`  excluded: ${counts.join(", ")}`);
	for (const entry of document.diagnostics) {
		lines.push(`  unresolved prerequisites of ${entry.ticket}: ${entry.dependencies.unknown.join(", ") || "-"}`);
	}
	for (const attempt of document.attempts) lines.push(attemptLine(attempt));
	if (stop.kind === "bound") lines.push(`  bound: ${document.maxCandidates} attempts, ${document.untried} untried`);
	if (document.operationId !== null) lines.push(`  operation: ${document.operationId}`);
	lines.push(...nextWayOut(document));
	return lines;
}

const RECLAIM_BATCH_SENTENCES: Record<ClaimReclaimBatchDocument["status"], string> = {
	ok: "every candidate was reclaimed",
	rejected: "some candidates were not reclaimed; read their state again before repeating",
	unknown: `at least one reclaim has an unknown outcome; ${NOT_FREE}`,
	"unknown-history": "at least one reclaim cannot be settled from the stored history",
	internal: "an unexpected error ended at least one reclaim",
	paused: "at least one ticket waits for own earlier operations",
	refused: "at least one reclaim was refused; fix the cause first",
	unavailable: "at least one ticket was not sent or not read; nothing about it is free",
};

/** One entry's details after `<ticket> <result>`: the operation ID, then the rejection, pause or error code. */
function reclaimEntryDetail(document: ClaimReclaimBatchDocument["entries"][number]["document"]): string {
	if (document === null) return "";
	const parts: string[] = document.operationId === null ? [] : [document.operationId];
	if ("code" in document) {
		parts.push(`(${document.code})`);
	} else if ("pause" in document) {
		const { pause } = document;
		parts.push(pause.kind === "outstanding" ? `(open: ${pause.operationIds.join(" ")})` : "(own journal incomplete)");
	} else if (document.rejection !== null) {
		parts.push(`(${document.rejection.stage}: ${document.rejection.cause})`);
	}
	return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * `<status>: <sentence>`, then one line per candidate `<ticket> <result> [<operationId>]`, then the
 * unread tickets, the stop and the ways out. Only entry lines start with a ticket.
 */
function reclaimBatchText(document: ClaimReclaimBatchDocument): string[] {
	const { entries, status } = document;
	const count = entries.length === 1 ? "1 candidate" : `${entries.length} candidates`;
	const sentence =
		entries.length === 0 && status === "ok"
			? "no ticket in the scope was reclaimable; nothing was sent"
			: RECLAIM_BATCH_SENTENCES[status];
	const lines = [`${status}: reclaim batch over ${count}: ${sentence}`];
	for (const entry of entries) lines.push(`  ${entry.ticket} ${entry.result}${reclaimEntryDetail(entry.document)}`);
	if (!document.complete) lines.push("  the selection is incomplete; an unread ticket is not free and was not tried");
	if (document.unreadable.length > 0) lines.push(`  unread: ${document.unreadable.join(", ")}`);
	if (document.stoppedAt !== null) {
		lines.push(`  stopped at ${document.stoppedAt} by a call-wide fault; the later candidates were not tried`);
	}
	const results = entries.map((entry) => entry.result);
	if (results.includes("unknown")) {
		lines.push("  for each unknown entry: backlog claim resolve <operation-id> --context <context>");
	}
	if (results.includes("paused")) {
		lines.push("  for each open operation: backlog claim retry <operation-id> --context <context> (it never pauses)");
	}
	return lines;
}

/** One line per ticket with verdict, boundary and, for ACTIVE, the owner without control characters. */
function reclaimPreviewText(document: ClaimReclaimPreviewDocument): string[] {
	const count = document.entries.length === 1 ? "1 ticket" : `${document.entries.length} tickets`;
	const head =
		document.status === "ok"
			? `reclaim preview of ${count} observed at ${instant(document.observedAt)}; it reserves nothing`
			: `the reclaim preview is incomplete (${count}); ${NOT_FREE}`;
	const lines = [`${document.status}: ${head}`];
	for (const entry of document.entries) {
		const parts: string[] = [entry.ticket, entry.verdict];
		if (entry.boundary !== undefined) parts.push(`boundary ${instant(entry.boundary)}`);
		if (entry.owner !== undefined) parts.push(`owner ${printable(entry.owner)}`);
		if (entry.transition !== undefined) parts.push(fromTo(entry.transition));
		if (entry.claimGeneration !== undefined) parts.push(`generation ${entry.claimGeneration}`);
		if (entry.timing !== undefined) parts.push(timingText(entry.timing));
		const { pause } = entry;
		if (pause?.kind === "outstanding") parts.push(`open operations ${pause.operationIds.join(" ")}`);
		else if (pause?.kind === "unknown") parts.push("own journal incomplete");
		lines.push(`  ${parts.join("  ")}`);
	}
	return lines;
}

/** The preview's fields, the root included; it is the one text that prints a root. */
function emergencyPreviewText(document: ClaimEmergencyPreviewDocument): string[] {
	const lines = [`ok: emergency release preview for ${document.ticket}: ${document.state}`];
	if (document.owner !== undefined) lines.push(`  owner: ${printable(document.owner)}`);
	if (document.transition !== undefined) lines.push(`  transition: ${fromTo(document.transition)}`);
	lines.push(`  generation: ${document.claimGeneration ?? "none"}`, `  epoch: ${document.epoch ?? "none"}`);
	lines.push(`  root: ${document.root ?? "none"}`);
	return lines;
}

/** The run and its ticket lists; `unknown` names the rerun. Never a root or a receipt. */
function epochText(document: ClaimEpochDocument): string[] {
	const move = `epoch ${document.fromEpoch} (${document.previousFormat}) to ${document.epoch} (${document.format})`;
	if (document.status === "rejected") {
		return [`rejected: claim storage ${move}: ${document.cause ?? "rejected"}; nothing was written`];
	}
	const lines = [`${document.status}: claim storage ${move}`];
	const lists: [string, string[]][] = [
		["rewritten", document.rewritten],
		["created", document.created],
		["breached", document.breached],
		["unsettled", document.unsettled],
	];
	for (const [name, tickets] of lists) if (tickets.length > 0) lines.push(`  ${name}: ${tickets.join(" ")}`);
	if (document.status === "unknown") {
		lines.push(`  ${NOT_FREE}`, `  isolate again, then rerun with --expect-epoch ${document.epoch}`);
	}
	return lines;
}

/** What a run would write; the preview writes nothing. */
function epochPreviewText(document: ClaimEpochPreviewDocument): string[] {
	const lines = [`ok: claim storage epoch ${document.epoch} (${document.format}) preview; nothing was written`];
	const lists: [string, string[]][] = [
		["listed", document.listed],
		["to create", document.toCreate],
		["unreadable", document.unreadable],
	];
	for (const [name, tickets] of lists) if (tickets.length > 0) lines.push(`  ${name}: ${tickets.join(" ")}`);
	return lines;
}

function documentLines(document: ClaimDocument): string[] {
	switch (document.kind) {
		case "claim-operation":
			return operationText(document);
		case "claim-pause":
			return pauseText(document);
		case "claim-resolution":
			return resolutionText(document);
		case "claim-list":
			return listText(document);
		case "claim-next":
			return nextText(document);
		case "claim-reclaim-batch":
			return reclaimBatchText(document);
		case "claim-reclaim-preview":
			return reclaimPreviewText(document);
		case "claim-emergency-preview":
			return emergencyPreviewText(document);
		case "claim-setup":
			return [`ok: claims configuration written (${document.keys.join(", ")})`];
		case "claim-init":
			return [`ok: claim coordination area ${document.result} (format ${document.format}, epoch ${document.epoch})`];
		case "claim-context":
			if (document.command === "context-show") {
				const authorityId = document.authorityId ?? "none";
				return ["ok: claim context", `  context id: ${document.contextId}`, `  authority id: ${authorityId}`];
			}
			return [
				"ok: claim context created",
				`  context id: ${document.contextId}`,
				"  pass --context <parent>/<context id> to later claim commands",
			];
		case "claim-epoch":
			return epochText(document);
		case "claim-epoch-preview":
			return epochPreviewText(document);
		case "claim-error":
			return errorText(document);
	}
}

export function formatClaimDocumentText(document: ClaimDocument): { stdout: string; stderr: string } {
	const text = `${documentLines(document).join("\n")}\n`;
	return STDERR_STATUSES.includes(document.status) ? { stdout: "", stderr: text } : { stdout: text, stderr: "" };
}
