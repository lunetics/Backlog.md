/**
 * The sidebar card with the claim owner of one task, read once when the card opens and again only on the
 * user's refresh. It renders by allowlist: of the claim document only `status`, `code`/`message`, `observedAt`,
 * `claims[0].state`, `owner` and `transition.from`/`to` reach the DOM, owner names through `printable`.
 */

import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ClaimErrorDocument, ClaimListDocument } from "../../claims/surface/index.ts";
import { printable } from "../../formatters/claim-text.ts";
import { apiClient } from "../lib/api";
import StoredDate from "./StoredDate";

export type ClaimOwnerCardProps = {
	taskId: string;
	isOpen: boolean;
	dateFormat?: string;
	/** The modal's section header, so the card shares its heading markup; `right` is the refresh button. */
	renderHeader: (right: ReactNode) => ReactNode;
};

/** A successful read as the card shows it: one line of text and the observed minute. */
type Seen = { label: string; owner: boolean; minute: string | undefined };

type Outcome =
	| { kind: "seen"; seen: Seen }
	| { kind: "refused"; message: string; minute: string | undefined }
	| { kind: "no-answer" }
	| { kind: "hidden" };

const UNKNOWN_NOT_FREE = "Unknown, not free";

/** Epoch milliseconds as the stored-date form `yyyy-mm-dd hh:mm` (UTC) that StoredDate renders. */
function storedMinute(ms: number): string | undefined {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 16).replace("T", " ");
}

function seenOf(document: ClaimListDocument): Seen {
	const minute = storedMinute(document.observedAt);
	const entry = document.claims[0];
	// Unknown is not free: a partial answer or a missing entry never reads as "No claim".
	if (document.status !== "ok" || !entry) return { label: UNKNOWN_NOT_FREE, owner: false, minute };
	if (entry.state === "active" && typeof entry.owner === "string") {
		return { label: printable(entry.owner), owner: true, minute };
	}
	if (entry.state === "free") return { label: "No claim", owner: false, minute };
	if (entry.state === "pending" && entry.transition) {
		const { from, to } = entry.transition;
		return { label: `Transfer pending: ${printable(from)} → ${printable(to)}`, owner: false, minute };
	}
	return { label: UNKNOWN_NOT_FREE, owner: false, minute };
}

function outcomeOf(document: ClaimListDocument | ClaimErrorDocument): Outcome {
	if (document.kind === "claim-list") return { kind: "seen", seen: seenOf(document) };
	if (document.kind === "claim-error") {
		// Claims were switched off after the config was read: the card goes away instead of showing an error.
		if (document.code === "not-configured") return { kind: "hidden" };
		return { kind: "refused", message: document.message, minute: storedMinute(Date.now()) };
	}
	return { kind: "no-answer" };
}

export function ClaimOwnerCard({ taskId, isOpen, dateFormat, renderHeader }: ClaimOwnerCardProps): ReactElement | null {
	const [refreshCount, setRefreshCount] = useState(0);
	const [fetching, setFetching] = useState(true);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [lastSeen, setLastSeen] = useState<Seen | null>(null);

	useEffect(() => {
		if (!isOpen) return;
		// A read that a newer one (refresh, reopen, StrictMode re-run) replaced never writes its answer.
		let active = true;
		apiClient.fetchTaskClaim(taskId).then(
			(document) => {
				if (!active) return;
				const next = outcomeOf(document);
				setOutcome(next);
				if (next.kind === "seen") setLastSeen(next.seen);
				setFetching(false);
			},
			() => {
				if (!active) return;
				setOutcome({ kind: "no-answer" });
				setFetching(false);
			},
		);
		return () => {
			active = false;
		};
	}, [isOpen, taskId, refreshCount]);

	if (outcome?.kind === "hidden") return null;

	const refresh = () => {
		if (fetching) return;
		setFetching(true);
		setRefreshCount((count) => count + 1);
	};

	const refreshButton = (
		<button
			type="button"
			onClick={refresh}
			disabled={fetching}
			aria-label="Refresh claim owner"
			title="Refresh claim owner"
			className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
		>
			<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={2}
					d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
				/>
			</svg>
		</button>
	);

	const stamp = (minute: string | undefined) => (
		<StoredDate value={minute} dateFormat={dateFormat} className="text-gray-700 dark:text-gray-200" />
	);

	const lastSeenLine = lastSeen ? (
		<div className="text-xs text-gray-600 dark:text-gray-300">
			Last seen: {lastSeen.label}, as of {stamp(lastSeen.minute)}
		</div>
	) : null;

	let body: ReactNode;
	if (!outcome) {
		body = fetching ? <div className="text-gray-500 dark:text-gray-400">Checking…</div> : null;
	} else if (outcome.kind === "seen") {
		body = (
			<>
				<div className={outcome.seen.owner ? "font-medium text-gray-900 dark:text-gray-100" : undefined}>
					{outcome.seen.label}
				</div>
				<div className="text-xs text-gray-600 dark:text-gray-300">as of {stamp(outcome.seen.minute)}</div>
			</>
		);
	} else if (outcome.kind === "refused") {
		body = (
			<>
				<div className="font-medium text-amber-700 dark:text-amber-300">Could not check</div>
				<div>{outcome.message}</div>
				<div className="text-xs text-gray-600 dark:text-gray-300">at {stamp(outcome.minute)}</div>
				{lastSeenLine}
			</>
		);
	} else {
		body = (
			<>
				<div className="font-medium text-amber-700 dark:text-amber-300">Could not check</div>
				<div>Backlog server did not answer</div>
				{lastSeenLine}
			</>
		);
	}

	return (
		<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
			{renderHeader(refreshButton)}
			<div className="min-w-0 break-words space-y-1 text-sm text-gray-700 dark:text-gray-200">{body}</div>
		</div>
	);
}
