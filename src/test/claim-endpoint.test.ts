/**
 * Level P: the shared endpoint rule `claimEndpointError` and its report through `resolveClaimSettings`. Pinned here:
 * every URL with a non-empty `username` or `password` is refused with one fixed reason, except an `ssh:` URL with a
 * username and no password (p-01); ssh usernames, userinfo-free URLs, `file:` URLs and an `@` outside the authority
 * stay accepted (p-02); the earlier refusals keep their order and never turn into the credential reason (p-03); the
 * resolver reports the rule as `unsupported-endpoint` with the new fixed message and echoes no part of the input
 * (p-04). No Git process, network or clock. The forms were measured with Bun 1.3.14's `URL`. p-01 and p-04 start with
 * a positive control that the product before the credential check (no credential check, the old message) fails; p-02
 * and p-03 are the controls that a rule refusing too much or in the wrong order fails, green before and after. 4 test
 * definitions, 4 runs.
 */
import { describe, expect, test } from "bun:test";
import { type ClaimConfigProblemCode, resolveClaimSettings } from "../claims/config/index.ts";
import { claimEndpointError } from "../claims/storage/index.ts";

type Entry = [key: string, raw: string];
type Row = { label: string; catches: string; endpoint: string };

/** Distinctive text that no reason or message may echo. */
const SENTINEL = "SENTINEL-endpoint-4c1d";
/** Verbatim: the one reason of every credential refusal. */
const CREDENTIAL_REASON = "credentials are not allowed in the claim endpoint; use SSH keys or a Git credential helper";
/** Verbatim with the key the resolver names (config/index.ts makeProblem). */
const ENDPOINT_MESSAGE =
	"claims.endpoint must be an explicit git://, ssh://, http://, https:// or file:// URL without credentials; " +
	"remote names, scp-style addresses and user:password@ forms are not supported.";

// adapted from claim-config.test.ts:59-61
function block(entries: readonly Entry[]): string {
	return `claims:\n${entries.map(([key, raw]) => `  ${key}: ${raw}\n`).join("")}`;
}

/** A complete lease block of claim-config.test.ts:64-82 with `endpoint` as the only varying value. */
function template(endpoint: string): Entry[] {
	return [
		["enabled", "true"],
		["endpoint", JSON.stringify(endpoint)],
		["storage_format", "blob"],
		["lifetime_mode", "lease"],
		["lease_ttl_ms", "300000"],
		["reclaim_grace_ms", "600000"],
		["attempt_timeout_ms", "10000"],
		["attempts", "3"],
		["operation_budget_ms", "30000"],
	];
}

/** A row's reason and whether it echoes the sentinel, so a table compares as one value. */
function reasonView(row: Row): { label: string; reason: string | undefined; echoed: boolean } {
	const reason = claimEndpointError(row.endpoint);
	return { label: `${row.label} (catches: ${row.catches})`, reason, echoed: (reason ?? "").includes(SENTINEL) };
}

/** A refusal that must keep its earlier reason: refused, not with the credential reason, no echo. */
function earlierView(row: Row): { label: string; refused: boolean; credential: boolean; echoed: boolean } {
	const reason = claimEndpointError(row.endpoint);
	return {
		label: `${row.label} (catches: ${row.catches})`,
		refused: typeof reason === "string" && reason !== "",
		credential: reason === CREDENTIAL_REASON,
		echoed: (reason ?? "").includes(SENTINEL),
	};
}

function problemView(key: string, problem: ClaimConfigProblemCode, message: string) {
	return { key, problem, message };
}

const S = SENTINEL;

describe("endpoint rule (claimEndpointError, resolveClaimSettings)", () => {
	test("p-01 refuses userinfo on every scheme and a password on ssh, with one fixed reason and no echo", () => {
		// Positive control (catches: the product before the credential check, which accepts every userinfo; a reason that
		// names the input): the plain user:password form of https is refused with the fixed reason.
		expect(
			reasonView({ label: "https user:password", catches: "-", endpoint: `https://u-${S}:pw-${S}@h.example/p` }),
		).toEqual({ label: "https user:password (catches: -)", reason: CREDENTIAL_REASON, echoed: false });

		const refused: Row[] = [
			{ label: "http user", catches: "a password-only check", endpoint: `http://user-${S}@h.example/p` },
			{ label: "http user:password", catches: "http left out", endpoint: `http://user-${S}:pw-${S}@h.example/p` },
			{ label: "https token", catches: "a token as username let through", endpoint: `https://${S}@h.example/p` },
			{ label: "git user", catches: "git:// left out", endpoint: `git://u-${S}@h.example/p` },
			{ label: "git user:password", catches: "git:// left out", endpoint: `git://u-${S}:pw-${S}@h.example/p` },
			{
				label: "ssh user:password",
				catches: "the ssh exception extended to passwords",
				endpoint: `ssh://u-${S}:pw-${S}@h.example/p`,
			},
			{ label: "ssh password only", catches: "a username-only check", endpoint: `ssh://:pw-${S}@h.example/p` },
			{
				label: "percent-encoded userinfo",
				catches: "a raw-string search for plain user:password",
				endpoint: `https://u%40${S}:p%25${S}@h.example/p`,
			},
			{
				label: "upper-case scheme",
				catches: "a case-sensitive scheme test",
				endpoint: `HTTPS://u-${S}:pw-${S}@h.example/p`,
			},
			{
				label: "IPv6 host",
				catches: "userinfo read only before a DNS name",
				endpoint: `https://u-${S}:pw-${S}@[::1]:8443/p`,
			},
		];
		// (catches: see each row): every form of the refused list is refused with exactly the fixed
		// reason, which echoes nothing of the input.
		expect(refused.map(reasonView)).toEqual(
			refused.map((row) => ({
				label: `${row.label} (catches: ${row.catches})`,
				reason: CREDENTIAL_REASON,
				echoed: false,
			})),
		);
	});

	test("p-02 accepts ssh usernames, userinfo-free and file URLs, and an @ outside the authority", () => {
		const accepted: Row[] = [
			{ label: "ssh git@", catches: "the ssh exception missing", endpoint: "ssh://git@h.example/team/p.git" },
			{
				label: "ssh git@ with port",
				catches: "a port read as a password",
				endpoint: "ssh://git@h.example:2222/team/p.git",
			},
			{
				label: "ssh percent-encoded username",
				catches: "decoding before the test",
				endpoint: "ssh://git%40x@h.example/p",
			},
			{ label: "ssh without user", catches: "ssh refused as a whole", endpoint: "ssh://h.example/p" },
			{ label: "https", catches: "a scheme dropped", endpoint: "https://h.example/p" },
			{ label: "http", catches: "a scheme dropped", endpoint: "http://h.example/p" },
			{ label: "git", catches: "a scheme dropped", endpoint: "git://h.example/p" },
			{ label: "file absolute", catches: "file URLs checked for userinfo", endpoint: "file:///abs/p" },
			{ label: "file localhost", catches: "file URLs checked for userinfo", endpoint: "file://localhost/p" },
			// An @ in the path leaves username and password empty; the rule reads the properties.
			{ label: "@ in the path", catches: "a raw-string search for @", endpoint: "https://h.example/team/pro@ject.git" },
			// [?]: empty userinfo leaves both properties empty, so the property rule accepts it.
			{ label: "empty userinfo", catches: "a raw-string search for @", endpoint: "https://@h.example/p" },
			{ label: "empty user and password", catches: "a raw-string search for :@", endpoint: "https://:@h.example/p" },
			{
				label: "ssh git with empty password",
				catches: "a raw-string search for :@",
				endpoint: "ssh://git:@h.example/p",
			},
		];
		// (catches: see each row): every accepted form passes the rule unchanged.
		expect(accepted.map(reasonView)).toEqual(
			accepted.map((row) => ({ label: `${row.label} (catches: ${row.catches})`, reason: undefined, echoed: false })),
		);
	});

	test("p-03 keeps the earlier refusals first: no control character, scheme or file URL gets the credential reason", () => {
		const earlier: Row[] = [
			{
				label: "ftp with userinfo",
				catches: "the credential check before the scheme check",
				endpoint: `ftp://u-${S}:pw-${S}@h.example/p`,
			},
			{
				label: "space after userinfo",
				catches: "the credential check before the character check",
				endpoint: `https://u-${S}:pw@h.example/p q`,
			},
			{
				label: "file with a user",
				catches: "file URLs given the credential reason",
				endpoint: `file://u-${S}@h.example/p`,
			},
			{
				label: "file with userinfo on localhost",
				catches: "file URLs given the credential reason",
				endpoint: `file://u:pw-${S}@localhost/p`,
			},
			{
				label: "scp style with a user",
				catches: "an scp address read as userinfo",
				endpoint: `git-${S}@h.example:team/p.git`,
			},
		];
		// (catches: see each row): each form stays refused by the check that refused it before the credential check; none
		// gets the credential reason, none echoes the input.
		expect(earlier.map(earlierView)).toEqual(
			earlier.map((row) => ({
				label: `${row.label} (catches: ${row.catches})`,
				refused: true,
				credential: false,
				echoed: false,
			})),
		);
	});

	test("p-04 reports a credential endpoint as unsupported-endpoint with the fixed message and echoes nothing", () => {
		const credential = resolveClaimSettings(block(template(`https://u-${S}:pw-${S}@git.example.org/${S}/p.git`)));
		// Positive control (catches: the product before the credential check, which configures the credential endpoint; the
		// old message without the credential clause; a message that quotes the value): config-invalid with the one endpoint
		// problem and the new fixed message.
		expect(credential).toEqual({
			kind: "config-invalid",
			reason: (credential as { reason: string }).reason,
			problems: [problemView("claims.endpoint", "unsupported-endpoint", ENDPOINT_MESSAGE)],
		});
		const refusals = [
			credential,
			resolveClaimSettings(block(template(`ssh://u-${S}:pw-${S}@git.example.org/${S}/p.git`))),
			resolveClaimSettings(block(template("origin"))),
		];
		// (Catches: a new problem code for credentials; a second message for them, so the old
		// forms keep the old text; any part of the input in the reason, a message or a key): the credential forms and a
		// remote name share the problem and its one message; no document contains the sentinel.
		expect({
			problems: refusals.map((result) => (result as { problems?: unknown }).problems),
			echoed: refusals.filter((result) => JSON.stringify(result).includes(SENTINEL)).length,
		}).toEqual({
			problems: refusals.map(() => [problemView("claims.endpoint", "unsupported-endpoint", ENDPOINT_MESSAGE)]),
			echoed: 0,
		});
		const ssh = resolveClaimSettings(block(template("ssh://git@git.example.org/team/p.git")));
		// (catches: the resolver refusing what the rule accepts): an ssh username configures, the
		// endpoint kept byte-equal.
		expect({ kind: ssh.kind, endpoint: (ssh as { settings?: { endpoint?: unknown } }).settings?.endpoint }).toEqual({
			kind: "configured",
			endpoint: "ssh://git@git.example.org/team/p.git",
		});
	});
});
