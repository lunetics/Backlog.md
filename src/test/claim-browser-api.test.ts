/**
 * The browser's claim-owner read never retries and waits 60 000 ms (case api-p11).
 *
 * Level P: pure, in-process, no DOM.
 *
 * ASSUMPTION(timer): the abort timer of `fetchWithRetry` stays a `setTimeout` (src/web/lib/api.ts:165), so a spy on
 * `setTimeout` sees the timeout the call uses; the backoff between attempts is a `setTimeout` too (:199-200).
 *
 * Harness adapted from web-api-demote.test.ts:1-31 (fetch stub on the global, restored after each test).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ApiClient, ApiError } from "../web/lib/api.ts";

const originalFetch = globalThis.fetch;
const CLAIM_URL = "/api/tasks/BACK-1/claim";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("claim owner read in the web API client", () => {
	// Explicit timeout: the scaffold's default retry path spends 1 s + 2 s + 4 s in backoff, and its RED must stay a
	// count diff instead of a timeout.
	it("api-p11: fetchTaskClaim reads the claim route once on a 500, rejects, and waits 60 000 ms", async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return Response.json({ error: "claim read failed" }, { status: 500 });
		}) as unknown as typeof globalThis.fetch;
		// A client configured with retries and the default timeout proves the call overrides both (lib/api.ts:143-146).
		const client = new ApiClient({ retries: 3, timeout: 10_000 });

		const timers = spyOn(globalThis, "setTimeout");
		let outcome: unknown = null;
		let delays: unknown[] = [];
		try {
			outcome = await client.fetchTaskClaim("BACK-1").then(
				() => "resolved",
				(reason: unknown) => reason,
			);
			delays = timers.mock.calls.map((call) => call[1]);
		} finally {
			timers.mockRestore();
		}

		// Positive control (catches: the default retry path, which reads four times with 1 s, 2 s and 4 s backoff)
		expect(requested).toEqual([CLAIM_URL]);
		// catches: a read that resolves on a 5xx instead of rejecting
		expect(outcome).toBeInstanceOf(ApiError);
		expect(outcome).toMatchObject({ status: 500 });
		// catches: an abort timer other than the 60 000 ms, or more than one
		expect(delays.filter((delay) => delay === 60_000)).toHaveLength(1);
		// catches: the default 10 000 ms timeout (lib/api.ts:145)
		expect(delays).not.toContain(10_000);
		// catches: a backoff timer, i.e. a retry scheduled although no second read followed (lib/api.ts:199)
		expect(delays).not.toContain(1_000);
	}, 15_000);

	// The view tests stub fetchTaskClaim and the G/E cases never pass through lib/api.ts, so this is the only case that
	// pins what the card receives on a 200: the parsed document, not the Response.
	it("api-p11: fetchTaskClaim resolves a 200 with the parsed claim document, reading once with 60 000 ms", async () => {
		const claimDocument = {
			schemaVersion: 1,
			kind: "claim-list",
			status: "ok",
			observedAt: 1_700_000_000_000,
			complete: true,
			claims: [{ ticket: "BACK-1", state: "free" }],
		};
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return Response.json(claimDocument, { status: 200 });
		}) as unknown as typeof globalThis.fetch;
		const client = new ApiClient({ retries: 3, timeout: 10_000 });

		const timers = spyOn(globalThis, "setTimeout");
		let outcome: unknown = null;
		let delays: unknown[] = [];
		try {
			outcome = await client.fetchTaskClaim("BACK-1");
			delays = timers.mock.calls.map((call) => call[1]);
		} finally {
			timers.mockRestore();
		}

		// Positive control (catches: the default retry path of the scaffold, which arms the 10 000 ms abort timer)
		expect(delays.filter((delay) => delay === 60_000)).toHaveLength(1);
		// catches: a second read on success
		expect(requested).toEqual([CLAIM_URL]);
		// catches: the Response or its text handed to the card instead of the parsed document
		expect(outcome).toEqual(claimDocument);
	}, 15_000);
});
