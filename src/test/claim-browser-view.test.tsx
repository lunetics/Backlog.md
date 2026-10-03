/**
 * The claim-owner card in the task details modal: card, fetch rule, states, copy, allowlist, one fetch at a time per
 * card and sentinels (cases view-p01...view-p10). Level P: pure, jsdom, in-process.
 *
 * The card is reached only through `TaskDetailsModal` with `claimsConfigured` and a stub on `apiClient.fetchTaskClaim`
 * whose reads stay open until the test answers or fails them, in the order the test chooses. `ClaimOwnerCard` is never
 * imported: its props are not part of the contract.
 *
 * Boundary: the sentinel checks below cover the rendered DOM of the modal only. `GET /api/config` and
 * `GET /api/status` already send the claims endpoint URL and the project root to the browser today; that exposure
 * lies outside the card and is deliberately not scanned here.
 *
 * Harness adapted from web-app-open-detail-refresh.test.tsx:38-88 (restorable jsdom globals), :128-147 (method stubs
 * on the API singleton), :150-156 (settle) and web-task-details-modal-default-assignee.test.tsx:70-97 (modal render).
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { ClaimErrorDocument, ClaimListDocument, ClaimListEntry } from "../claims/surface/index.ts";
import type { Task } from "../types/index.ts";
import { TaskDetailsModal } from "../web/components/TaskDetailsModal.tsx";
import { TaskIdIndexProvider } from "../web/contexts/TaskIdIndexContext.tsx";
import { ThemeProvider } from "../web/contexts/ThemeContext.tsx";
import { apiClient, ApiError, NetworkError } from "../web/lib/api.ts";
import { formatStoredDateForDisplay } from "../web/utils/date-display.ts";

// The specified copy, character for character; U+2026 and U+2192 are written as escapes on purpose.
const CARD_TITLE = "Claim owner";
const REFRESH_LABEL = "Refresh claim owner";
const CHECKING = "Checking\u2026";
const NO_CLAIM = "No claim";
const UNKNOWN_NOT_FREE = "Unknown, not free";
const COULD_NOT_CHECK = "Could not check";
const NO_ANSWER = "Backlog server did not answer";
const AS_OF = "as of";
const AT = "at";
const LAST_SEEN = "Last seen:";
const TRANSFER_PENDING = "Transfer pending:";
const ARROW = "\u2192";

// The fixed `message` per code, from MESSAGES in base/src/claims/surface/index.ts (:254, :255, :264).
const NOT_CONFIGURED_MESSAGE = "claims are not configured for this project";
const CONFIG_INVALID_MESSAGE = "the claims configuration is invalid; see problems for the affected keys";
const UNREACHABLE_MESSAGE = "the claim coordination endpoint could not be reached";

// Instants and the UTC minute StoredDate puts into `title` for each: seconds and milliseconds are cut, never rounded.
const OBSERVED_AT = Date.UTC(2026, 8, 29, 7, 12, 45, 678);
const OBSERVED_MINUTE = "2026-09-29 07:12";
const REFRESHED_AT = Date.UTC(2026, 8, 29, 7, 31, 59, 999);
const REFRESHED_MINUTE = "2026-09-29 07:31";
/** The client clock for error documents, which carry no observedAt. */
const CLIENT_NOW = new Date("2026-09-29T08:41:50.000Z");
const CLIENT_MINUTE = "2026-09-29 08:41";

// Values of fields the card must never render; noon UTC keeps the calendar date the same in almost every zone.
const LEASE_END = Date.UTC(2031, 4, 17, 12, 0, 0, 0);
const HARD_END = Date.UTC(2032, 1, 29, 12, 0, 0, 0);
const RECLAIM_BOUNDARY = Date.UTC(2033, 2, 3, 12, 0, 0, 0);

const statuses = ["To Do", "In Progress", "Done"];

type ClaimAnswer = ClaimListDocument | ClaimErrorDocument;

/** One `fetchTaskClaim` call, held open until the test answers or fails it. */
type ClaimRead = { id: string; resolve: (answer: ClaimAnswer) => void; reject: (error: unknown) => void };

type ModalProps = { task?: Task; claimsConfigured?: boolean; isDraftMode?: boolean };

let activeRoot: Root | null = null;
let activeDom: JSDOM | null = null;
const restore: Array<() => void> = [];
const reads: ClaimRead[] = [];

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		title: `Task ${id}`,
		status: "To Do",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2026-09-01",
		...overrides,
	};
}

/** Everything planted on the global object is restored afterwards (web-app-open-detail-refresh.test.tsx:33-43). */
function assignGlobals(values: Record<string, unknown>) {
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, globals[key]]));
	Object.assign(globals, values);
	restore.push(() => Object.assign(globals, previous));
}

/** Adapted from web-app-open-detail-refresh.test.tsx:45-88, without the WebSocket stub: the modal opens none. */
function setupDom(): HTMLElement {
	activeDom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
	const jsdomWindow = activeDom.window;
	assignGlobals({
		IS_REACT_ACT_ENVIRONMENT: true,
		window: jsdomWindow,
		document: jsdomWindow.document,
		navigator: jsdomWindow.navigator,
		localStorage: jsdomWindow.localStorage,
		Element: jsdomWindow.Element,
		HTMLElement: jsdomWindow.HTMLElement,
		HTMLInputElement: jsdomWindow.HTMLInputElement,
		HTMLTextAreaElement: jsdomWindow.HTMLTextAreaElement,
		HTMLSelectElement: jsdomWindow.HTMLSelectElement,
		Event: jsdomWindow.Event,
		CustomEvent: jsdomWindow.CustomEvent,
		MouseEvent: jsdomWindow.MouseEvent,
		KeyboardEvent: jsdomWindow.KeyboardEvent,
		Node: jsdomWindow.Node,
		MutationObserver: jsdomWindow.MutationObserver,
		getComputedStyle: jsdomWindow.getComputedStyle.bind(jsdomWindow),
		requestAnimationFrame: (callback: FrameRequestCallback) => jsdomWindow.setTimeout(callback, 0),
		cancelAnimationFrame: (handle: number) => jsdomWindow.clearTimeout(handle),
	});
	window.matchMedia = () =>
		({
			matches: false,
			media: "",
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList;
	const htmlElementPrototype = window.HTMLElement.prototype as unknown as {
		attachEvent?: () => void;
		detachEvent?: () => void;
	};
	htmlElementPrototype.attachEvent ??= () => {};
	htmlElementPrototype.detachEvent ??= () => {};
	return document.getElementById("root") as HTMLElement;
}

/** Method stubs on the API singleton, restored after each test (web-app-open-detail-refresh.test.tsx:128-147). */
function stubApi() {
	const originals = {
		fetchStatuses: apiClient.fetchStatuses.bind(apiClient),
		fetchTaskClaim: apiClient.fetchTaskClaim.bind(apiClient),
	};
	restore.push(() => Object.assign(apiClient, originals));
	// StatusSelect reads the statuses on mount (TaskDetailsModal.tsx:1956); answered here so no request leaves.
	apiClient.fetchStatuses = async () => statuses;
	apiClient.fetchTaskClaim = (id: string) =>
		new Promise<ClaimAnswer>((resolve, reject) => {
			reads.push({ id, resolve, reject });
		});
}

const settle = async (rounds = 4) => {
	for (let round = 0; round < rounds; round += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
};

const wait = async (ms: number) => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
};

/** Adapted from web-task-details-modal-default-assignee.test.tsx:70-89. */
const renderInto = async ({ task, claimsConfigured, isDraftMode }: ModalProps) => {
	await act(async () => {
		activeRoot?.render(
			<MemoryRouter initialEntries={["/"]}>
				<ThemeProvider>
					<TaskIdIndexProvider tasks={task ? [task] : []}>
						<TaskDetailsModal
							task={task}
							isOpen={true}
							onClose={() => {}}
							claimsConfigured={claimsConfigured}
							isDraftMode={isDraftMode}
						/>
					</TaskIdIndexProvider>
				</ThemeProvider>
			</MemoryRouter>,
		);
		await Promise.resolve();
	});
	await settle();
};

function unmountModal() {
	if (activeRoot) {
		act(() => {
			activeRoot?.unmount();
		});
		activeRoot = null;
	}
	activeDom?.window.close();
	activeDom = null;
}

const mountModal = async (props: ModalProps) => {
	unmountModal();
	activeRoot = createRoot(setupDom());
	await renderInto(props);
};

const click = async (element: Element | null | undefined) => {
	await act(async () => {
		element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
		await Promise.resolve();
	});
	await settle();
};

const readIds = (): string[] => reads.map((read) => read.id);

const answerRead = async (index: number, answer: ClaimAnswer) => {
	await act(async () => {
		reads[index]?.resolve(answer);
		await Promise.resolve();
	});
	await settle();
};

const failRead = async (index: number, error: unknown) => {
	await act(async () => {
		reads[index]?.reject(error);
		await Promise.resolve();
	});
	await settle();
};

const listDocument = (claims: ClaimListEntry[], observedAt: number, complete = true): ClaimListDocument => ({
	schemaVersion: 1,
	kind: "claim-list",
	status: complete ? "ok" : "unknown",
	command: "list",
	complete,
	observedAt,
	claims,
});

const activeEntry = (owner: string, ticket = "BACK-1"): ClaimListEntry => ({
	ticket,
	state: "active",
	owner,
	claimGeneration: 3,
	timing: { mode: "none" },
});

const freeEntry = (): ClaimListEntry => ({ ticket: "BACK-1", state: "free", claimGeneration: 2 });

/** Status per CLAIM_ERROR_CODES (base/src/claims/surface/index.ts:186-238), message per MESSAGES (:241-293). */
const errorDocument = (
	code: ClaimErrorDocument["code"],
	status: ClaimErrorDocument["status"],
	message: string,
	problems?: ClaimErrorDocument["problems"],
): ClaimErrorDocument => ({
	schemaVersion: 1,
	kind: "claim-error",
	status,
	command: "list",
	code,
	message,
	ticket: "BACK-1",
	operationId: null,
	...(problems ? { problems } : {}),
});

const normalized = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The card heading; SectionHeader renders an h3 (TaskDetailsModal.tsx:143-150). Null while no card is rendered. */
const claimHeading = (): Element | null =>
	Array.from(document.querySelectorAll("h3")).find((heading) => heading.textContent?.trim() === CARD_TITLE) ?? null;

/** The sidebar column of the modal (TaskDetailsModal.tsx:1727). */
const sidebarColumn = (): Element | null =>
	Array.from(document.querySelectorAll("div")).find((element) => element.classList.contains("md:col-span-1")) ?? null;

/** The direct child of the sidebar column that holds the heading with this title. */
const sidebarCard = (title: string): Element | null => {
	const column = sidebarColumn();
	if (!column) return null;
	return (
		Array.from(column.children).find((child) =>
			Array.from(child.querySelectorAll("h3")).some((heading) => heading.textContent?.trim() === title),
		) ?? null
	);
};

const headingOf = (element: Element | null | undefined): string | null =>
	element?.querySelector("h3")?.textContent?.trim() ?? null;

/** The card around the heading: its sidebar entry, else the heading's own section (view-p10 pins the place). */
const claimCard = (): Element | null => {
	const heading = claimHeading();
	if (!heading) return null;
	return sidebarCard(CARD_TITLE) ?? heading.parentElement?.parentElement ?? heading;
};

const cardText = (): string => normalized(claimCard()?.textContent);

const refreshButton = (): HTMLButtonElement | null =>
	claimCard()?.querySelector<HTMLButtonElement>(`button[aria-label="${REFRESH_LABEL}"]`) ?? null;

/**
 * "<phrase> <StoredDate>" inside the card. StoredDate puts the stored UTC minute plus " (UTC)" into `title`
 * (StoredDate.tsx:22, utc-date-display.ts:133), which is the same in every timezone; its text is the viewer's local
 * time, taken here from the same formatter the component uses.
 */
function expectDated(label: string, phrase: string, minute: string) {
	const title = `${minute} (UTC)`;
	const stamp = Array.from(claimCard()?.querySelectorAll("[title]") ?? []).find(
		(element) => element.getAttribute("title") === title,
	);
	expect(stamp, `${label}: a StoredDate titled "${title}"`).toBeTruthy();
	const local = formatStoredDateForDisplay(minute).text;
	expect(normalized(stamp?.textContent), `${label}: the StoredDate shows local time`).toBe(local);
	expect(cardText(), `${label}: "${phrase}" right before the time`).toMatch(
		new RegExp(`${escapeRegExp(phrase)}\\s*${escapeRegExp(local)}`),
	);
}

beforeEach(() => {
	stubApi();
});

afterEach(() => {
	unmountModal();
	setSystemTime();
	reads.length = 0;
	while (restore.length > 0) restore.pop()?.();
});

describe("claim owner card in the task details modal", () => {
	it("view-p01: opening reads once, shows Checking…, then the owner as of a UTC-titled StoredDate", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that never reads; the scaffold renders null and reads nothing)
		expect(readIds()).toEqual(["BACK-1"]);
		// catches: a missing card or a heading other than "Claim owner"
		expect(claimHeading()).not.toBeNull();
		// catches: loading copy other than "Checking" + U+2026
		expect(cardText()).toContain(CHECKING);
		// catches: a refresh button that is missing or usable while the first read runs
		expect(refreshButton()?.disabled).toBe(true);

		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));

		// catches: an answer that never replaces the loading copy
		expect(cardText()).toContain("alice");
		expect(cardText()).not.toContain(CHECKING);
		// catches: a time that is not the StoredDate of observedAt cut to the minute
		expectDated("active", AS_OF, OBSERVED_MINUTE);
		// catches: a second read on open, e.g. a refetch once the answer lands
		expect(readIds()).toEqual(["BACK-1"]);
		// catches: a button left disabled after the answer
		expect(refreshButton()?.disabled).toBe(false);
	});

	it("view-p02: a new task object of the same id reads nothing, and no timer reads within 100 ms", async () => {
		const task = makeTask("BACK-1");
		await mountModal({ task, claimsConfigured: true });

		// Positive control (catches: a card that never reads, which would make the counts below trivially stable)
		expect(readIds()).toEqual(["BACK-1"]);
		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));

		// App hands the modal a fresh detail object on every data refresh (App.tsx:778-802, keyed on dataVersion).
		await renderInto({ task: { ...task, title: "Retitled by a refresh" }, claimsConfigured: true });
		await renderInto({ task: { ...task, labels: ["refreshed"] }, claimsConfigured: true });
		// catches: an effect keyed on `task` instead of its id, i.e. hidden polling on every WebSocket refresh
		expect(readIds()).toEqual(["BACK-1"]);

		await wait(100);
		// catches: an interval, a scheduled re-read or a refetch on focus
		expect(readIds()).toEqual(["BACK-1"]);
		// catches: a re-render that drops the answer back to the loading copy
		expect(cardText()).toContain("alice");
		expect(cardText()).not.toContain(CHECKING);
	});

	it("view-p03: refresh reads once more, stays disabled until the answer, and nothing reads unasked", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card without the refresh button)
		expect(refreshButton()).not.toBeNull();
		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));
		// catches: a button that stays disabled after the first answer
		expect(refreshButton()?.disabled).toBe(false);

		await click(refreshButton());
		// catches: a refresh that does not read, or reads more than once
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);
		// catches: a button usable while the refresh read runs (one fetch at a time per card)
		expect(refreshButton()?.disabled).toBe(true);
		await click(refreshButton());
		// catches: a second parallel read through a click on the disabled button
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);

		await answerRead(1, listDocument([activeEntry("bob")], REFRESHED_AT));
		// catches: a refresh answer that does not land
		expect(cardText()).toContain("bob");
		expect(cardText()).not.toContain("alice");
		expectDated("refreshed", AS_OF, REFRESHED_MINUTE);
		// catches: a button left disabled after the refresh answer
		expect(refreshButton()?.disabled).toBe(false);

		await wait(100);
		// catches: a third read without a click (no interval, no auto-refresh)
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);
	});

	it("view-p04: the newest read wins when an older read of the same ticket answers after it", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that never reads)
		expect(readIds()).toEqual(["BACK-1"]);

		// The refresh button is disabled while a read runs, so the newer read of the same ticket comes from a round
		// trip through another ticket.
		await renderInto({ task: makeTask("BACK-2"), claimsConfigured: true });
		await renderInto({ task: makeTask("BACK-1"), claimsConfigured: true });
		// catches: an effect that does not follow the task id (keyed on [isOpen, taskId, refreshCount])
		expect(readIds()).toEqual(["BACK-1", "BACK-2", "BACK-1"]);

		await answerRead(2, listDocument([activeEntry("carol")], REFRESHED_AT));
		// catches: the newest read not landing
		expect(cardText()).toContain("carol");

		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));
		await answerRead(1, listDocument([activeEntry("bob", "BACK-2")], OBSERVED_AT));
		// catches: a missing overtaking guard (the App's `active` flag plus cleanup, App.tsx:778-802)
		expect(cardText()).toContain("carol");
		expect(cardText()).not.toContain("alice");
		expect(cardText()).not.toContain("bob");
		expectDated("newest read", AS_OF, REFRESHED_MINUTE);
	});

	it("view-p04: a ticket switch discards the old ticket's owner and its late answer", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that never reads)
		expect(readIds()).toEqual(["BACK-1"]);
		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));
		expect(cardText()).toContain("alice");

		await renderInto({ task: makeTask("BACK-2"), claimsConfigured: true });
		// catches: a switch that does not read the new ticket
		expect(readIds()).toEqual(["BACK-1", "BACK-2"]);
		// catches: BACK-1's owner left on screen while BACK-2 is read
		expect(cardText()).not.toContain("alice");
		expect(cardText()).toContain(CHECKING);

		await renderInto({ task: makeTask("BACK-3"), claimsConfigured: true });
		expect(readIds()).toEqual(["BACK-1", "BACK-2", "BACK-3"]);
		await answerRead(1, listDocument([activeEntry("bob", "BACK-2")], OBSERVED_AT));
		// catches: a late answer for a ticket the modal no longer shows
		expect(cardText()).not.toContain("bob");
		expect(cardText()).toContain(CHECKING);

		await answerRead(2, listDocument([activeEntry("carol", "BACK-3")], REFRESHED_AT));
		// catches: the current ticket's answer not landing after the discarded one
		expect(cardText()).toContain("carol");
	});

	it("view-p05: every answer has its own copy, and none but free reads as No claim", async () => {
		setSystemTime(CLIENT_NOW);
		const probes: Array<{
			label: string;
			settleRead: () => Promise<void>;
			shows: string[];
			dated: { phrase: string; minute: string } | null;
			hides: string[];
		}> = [
			{
				label: "free",
				settleRead: () => answerRead(0, listDocument([freeEntry()], OBSERVED_AT)),
				shows: [NO_CLAIM],
				dated: { phrase: AS_OF, minute: OBSERVED_MINUTE },
				hides: [CHECKING, UNKNOWN_NOT_FREE, COULD_NOT_CHECK, TRANSFER_PENDING],
			},
			{
				label: "pending",
				settleRead: () =>
					answerRead(
						0,
						listDocument(
							[
								{
									ticket: "BACK-1",
									state: "pending",
									claimGeneration: 4,
									transition: { from: "alice", to: "bob" },
									reclaimBoundary: RECLAIM_BOUNDARY,
								},
							],
							OBSERVED_AT,
						),
					),
				shows: [`${TRANSFER_PENDING} alice ${ARROW} bob`],
				dated: { phrase: AS_OF, minute: OBSERVED_MINUTE },
				hides: [CHECKING, NO_CLAIM, UNKNOWN_NOT_FREE, COULD_NOT_CHECK],
			},
			{
				label: "unknown entry",
				settleRead: () => answerRead(0, listDocument([{ ticket: "BACK-1", state: "unknown" }], OBSERVED_AT, false)),
				shows: [UNKNOWN_NOT_FREE],
				dated: { phrase: AS_OF, minute: OBSERVED_MINUTE },
				hides: [CHECKING, NO_CLAIM, COULD_NOT_CHECK],
			},
			{
				label: "unknown status over a free entry",
				settleRead: () => answerRead(0, listDocument([freeEntry()], OBSERVED_AT, false)),
				shows: [UNKNOWN_NOT_FREE],
				dated: { phrase: AS_OF, minute: OBSERVED_MINUTE },
				hides: [CHECKING, NO_CLAIM, COULD_NOT_CHECK],
			},
			{
				label: "claim-error unavailable/unreachable",
				settleRead: () => answerRead(0, errorDocument("unreachable", "unavailable", UNREACHABLE_MESSAGE)),
				shows: [COULD_NOT_CHECK, UNREACHABLE_MESSAGE],
				dated: { phrase: AT, minute: CLIENT_MINUTE },
				hides: [CHECKING, NO_CLAIM, UNKNOWN_NOT_FREE, NO_ANSWER, AS_OF, LAST_SEEN],
			},
			{
				label: "claim-error refused/config-invalid",
				settleRead: () =>
					answerRead(
						0,
						errorDocument("config-invalid", "refused", CONFIG_INVALID_MESSAGE, [
							{ key: "attempt_timeout_ms", problem: "out-of-range" },
						]),
					),
				shows: [COULD_NOT_CHECK, CONFIG_INVALID_MESSAGE],
				dated: { phrase: AT, minute: CLIENT_MINUTE },
				hides: [
					CHECKING,
					NO_CLAIM,
					UNKNOWN_NOT_FREE,
					NO_ANSWER,
					AS_OF,
					LAST_SEEN,
					"attempt_timeout_ms",
					"out-of-range",
				],
			},
			{
				label: "HTTP 500",
				settleRead: () =>
					failRead(0, new ApiError("HTTP 500: Internal Server Error", 500, "Internal Server Error", null)),
				shows: [COULD_NOT_CHECK, NO_ANSWER],
				dated: null,
				hides: [CHECKING, NO_CLAIM, UNKNOWN_NOT_FREE, LAST_SEEN, "HTTP 500", "Internal Server Error"],
			},
			{
				label: "network failure (NetworkError)",
				settleRead: () => failRead(0, new NetworkError("Request failed after 1 attempts: fetch failed")),
				shows: [COULD_NOT_CHECK, NO_ANSWER],
				dated: null,
				hides: [CHECKING, NO_CLAIM, UNKNOWN_NOT_FREE, LAST_SEEN, "Request failed"],
			},
			{
				label: "network failure (TypeError)",
				settleRead: () => failRead(0, new TypeError("fetch failed")),
				shows: [COULD_NOT_CHECK, NO_ANSWER],
				dated: null,
				hides: [CHECKING, NO_CLAIM, UNKNOWN_NOT_FREE, LAST_SEEN, "fetch failed"],
			},
		];

		for (const probe of probes) {
			reads.length = 0;
			await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });
			// Positive control (catches: a card that never reads, which would leave every copy check below empty)
			expect({ probe: probe.label, reads: readIds() }).toEqual({ probe: probe.label, reads: ["BACK-1"] });

			await probe.settleRead();
			const text = cardText();
			// catches: a state rendered with other copy than the specified one
			for (const phrase of probe.shows) expect(text, `${probe.label}: shows "${phrase}"`).toContain(phrase);
			// catches: a non-free state read as "No claim", leftover loading copy, or raw error or config text
			for (const phrase of probe.hides) expect(text, `${probe.label}: hides "${phrase}"`).not.toContain(phrase);
			// catches: "as of" not dated by observedAt, or an error not dated by the client clock
			if (probe.dated) expectDated(probe.label, probe.dated.phrase, probe.dated.minute);
		}
	}, 20_000);

	it("view-p06: a refresh that fails after an answer keeps Last seen with the owner under the error line", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that never reads)
		expect(readIds()).toEqual(["BACK-1"]);
		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));
		expect(cardText()).toContain("alice");

		await click(refreshButton());
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);
		await failRead(1, new NetworkError("Request failed after 1 attempts: fetch failed"));

		const text = cardText();
		// catches: a failure after a success that hides the error copy
		expect(text).toContain(COULD_NOT_CHECK);
		expect(text).toContain(NO_ANSWER);
		// catches: a failure that drops the dated last answer
		expectDated("last seen", `${LAST_SEEN} alice, ${AS_OF}`, OBSERVED_MINUTE);
		// catches: "Last seen" above the error line instead of under it
		expect(text.indexOf(COULD_NOT_CHECK)).toBeLessThan(text.indexOf(LAST_SEEN));
		// catches: a button left disabled after the failure
		expect(refreshButton()?.disabled).toBe(false);

		await wait(100);
		// catches: an automatic retry after the failure (no auto-retry)
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);
	});

	it("view-p06: an error document after a free answer keeps Last seen: No claim, errors at client time", async () => {
		setSystemTime(CLIENT_NOW);
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that never reads)
		expect(readIds()).toEqual(["BACK-1"]);
		await answerRead(0, listDocument([freeEntry()], OBSERVED_AT));
		expect(cardText()).toContain(NO_CLAIM);

		await click(refreshButton());
		expect(readIds()).toEqual(["BACK-1", "BACK-1"]);
		await answerRead(1, errorDocument("unreachable", "unavailable", UNREACHABLE_MESSAGE));

		const text = cardText();
		// catches: an error document after a success rendered without its fixed message
		expect(text).toContain(COULD_NOT_CHECK);
		expect(text).toContain(UNREACHABLE_MESSAGE);
		// catches: an error time that is not the client clock
		expectDated("error time", AT, CLIENT_MINUTE);
		// catches: a lost "Last seen: No claim" line (ASSUMPTION(browser): an error document is a failure too)
		expectDated("last seen", `${LAST_SEEN} ${NO_CLAIM}, ${AS_OF}`, OBSERVED_MINUTE);
		// catches: "Last seen" above the error line instead of under it
		expect(text.indexOf(COULD_NOT_CHECK)).toBeLessThan(text.indexOf(LAST_SEEN));
	});

	it("view-p07: no read and no card unless configured, for a task, outside draft and create mode", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a gate that is always closed, which would let every closed probe below pass)
		expect(readIds()).toEqual(["BACK-1"]);
		expect(claimHeading()).not.toBeNull();

		// Each probe flips exactly one condition of `claimsConfigured && task && !draft mode && !open draft`.
		const closed: Array<{ label: string; props: ModalProps }> = [
			{ label: "claimsConfigured false", props: { task: makeTask("BACK-1"), claimsConfigured: false } },
			{ label: "claimsConfigured absent (config without claimsYaml)", props: { task: makeTask("BACK-1") } },
			{ label: "draft mode", props: { task: makeTask("BACK-1"), claimsConfigured: true, isDraftMode: true } },
			{ label: "open draft", props: { task: makeTask("BACK-1", { status: "Draft" }), claimsConfigured: true } },
			{
				label: "open draft from the drafts page",
				props: { task: makeTask("DRAFT-1", { status: "Draft" }), claimsConfigured: true },
			},
			{ label: "create mode", props: { claimsConfigured: true } },
		];
		for (const probe of closed) {
			reads.length = 0;
			await mountModal(probe.props);
			// catches: a gate that ignores this one condition (a read or a card where the contract allows neither)
			expect({ probe: probe.label, reads: readIds(), card: claimHeading() !== null }).toEqual({
				probe: probe.label,
				reads: [],
				card: false,
			});
		}

		// Tasks of other branches and completed tasks still show the card.
		const open: Array<{ label: string; task: Task }> = [
			{
				label: "task of another branch",
				task: makeTask("BACK-3", { branch: "feature/elsewhere", source: "local-branch" }),
			},
			{ label: "completed task", task: makeTask("BACK-4", { status: "Done", source: "completed" }) },
		];
		for (const probe of open) {
			reads.length = 0;
			await mountModal({ task: probe.task, claimsConfigured: true });
			// catches: a gate that also closes for other-branch or completed tasks
			expect({ probe: probe.label, reads: readIds(), card: claimHeading() !== null }).toEqual({
				probe: probe.label,
				reads: [probe.task.id],
				card: true,
			});
		}
	}, 20_000);

	it("view-p08: a not-configured answer hides the card", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: a card that is never shown, which would make "hidden" trivially true)
		expect(claimHeading()).not.toBeNull();
		expect(readIds()).toEqual(["BACK-1"]);

		await answerRead(0, errorDocument("not-configured", "refused", NOT_CONFIGURED_MESSAGE));
		// catches: not-configured rendered as an ordinary error instead of hiding the card (the race against the config)
		expect(claimHeading()).toBeNull();
		const body = normalized(document.body.textContent);
		expect(body).not.toContain(COULD_NOT_CHECK);
		expect(body).not.toContain(NOT_CONFIGURED_MESSAGE);

		await wait(100);
		// catches: a hidden card that keeps reading
		expect(readIds()).toEqual(["BACK-1"]);
	});

	it("view-p09: the card renders by allowlist: sentinels never reach the DOM, the owner does, as text", async () => {
		const ownerSentinel = "owner-sentinel-4b8d";
		const leakyEntry = {
			ticket: "BACK-1",
			state: "active",
			owner: ownerSentinel,
			claimGeneration: 424_242,
			timing: { mode: "lease", leaseEnd: LEASE_END, hardEnd: HARD_END, graceMs: 31_337 },
			binding: "sentinel-binding-entry-19f3",
			receipt: "sentinel-receipt-entry-6b20",
			path: "/tmp/sentinel-path-entry-a7d4/claim-context",
			rights: { kind: "evaluated", scope: "observed-state-only", ownership: "sentinel-rights-entry-c85e" },
		};
		const leakyDocument = {
			...listDocument([leakyEntry as unknown as ClaimListEntry], OBSERVED_AT),
			binding: "sentinel-binding-top-2e71",
			receipt: "sentinel-receipt-top-90ac",
			path: "/tmp/sentinel-path-top-44b9/claim-context",
			rights: { kind: "sentinel-rights-top-d31f" },
		} as unknown as ClaimListDocument;
		const neverRendered = [
			"sentinel-binding-entry-19f3",
			"sentinel-receipt-entry-6b20",
			"/tmp/sentinel-path-entry-a7d4",
			"sentinel-rights-entry-c85e",
			"sentinel-binding-top-2e71",
			"sentinel-receipt-top-90ac",
			"/tmp/sentinel-path-top-44b9",
			"sentinel-rights-top-d31f",
			"424242",
			"31337",
			String(LEASE_END),
			String(HARD_END),
			"2031-05-17",
			"2032-02-29",
		];

		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });
		await answerRead(0, leakyDocument);

		// Positive control (catches: an allowlist that drops the owner too, which would make the absence check vacuous)
		expect(cardText()).toContain(ownerSentinel);
		// catches: a spread of the document or the entry into the DOM, as text or attribute (allowlist)
		const leakyHtml = document.documentElement.outerHTML;
		expect(neverRendered.filter((sentinel) => leakyHtml.includes(sentinel))).toEqual([]);

		// An owner that looks like markup and carries U+0007; printable replaces C0/C1 with "?" (claim-text.ts:33).
		reads.length = 0;
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });
		await answerRead(0, listDocument([activeEntry("<b>x</b>\u0007")], OBSERVED_AT));
		// catches: an owner rendered without printable, or not rendered at all
		expect(cardText()).toContain("<b>x</b>?");
		// catches: an owner injected as markup
		expect(claimCard()?.querySelector("b") ?? null).toBeNull();
		// catches: the raw control character reaching the DOM, e.g. through a title attribute
		expect(document.documentElement.outerHTML.includes("\u0007")).toBe(false);

		// Transition names pass through printable too; the PENDING extras never render.
		reads.length = 0;
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });
		await answerRead(
			0,
			listDocument(
				[
					{
						ticket: "BACK-1",
						state: "pending",
						claimGeneration: 515_151,
						transition: { from: "src\u0000one", to: "dst\u009btwo" },
						reclaimBoundary: RECLAIM_BOUNDARY,
					},
				],
				OBSERVED_AT,
			),
		);
		// catches: transition names rendered without printable
		expect(cardText()).toContain(`${TRANSFER_PENDING} src?one ${ARROW} dst?two`);
		const pendingHtml = document.documentElement.outerHTML;
		const pendingNeverRendered = ["515151", String(RECLAIM_BOUNDARY), "2033-03-03", "\u0000", "\u009b"];
		// catches: claimGeneration or reclaimBoundary rendered, or raw C0/C1 characters in the DOM
		expect(pendingNeverRendered.filter((value) => pendingHtml.includes(value))).toEqual([]);
	});

	it("view-p10: the card is the sidebar entry right after Assignee, in the md:col-span-1 column", async () => {
		await mountModal({ task: makeTask("BACK-1"), claimsConfigured: true });

		// Positive control (catches: no card at all, which would leave the placement checks nothing to find)
		expect(readIds()).toEqual(["BACK-1"]);

		const expectPlacement = (phase: string) => {
			// catches: a card outside the sidebar column, which then does not stack with it under md
			expect({ phase, inSidebar: sidebarCard(CARD_TITLE) !== null }).toEqual({ phase, inSidebar: true });
			// catches: a card elsewhere in the sidebar or nested inside the Assignee card
			expect({ phase, afterAssignee: headingOf(sidebarCard("Assignee")?.nextElementSibling) }).toEqual({
				phase,
				afterAssignee: CARD_TITLE,
			});
		};
		expectPlacement("reading");
		await answerRead(0, listDocument([activeEntry("alice")], OBSERVED_AT));
		expectPlacement("answered");
	});
});
