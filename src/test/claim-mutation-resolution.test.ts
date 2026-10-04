/**
 * Behavioural contract for the single-mutation resolver: pure cases over constructed
 * observations, and real Git cases over loopback TCP for blob, tree and commit-chain. A verdict covers
 * exactly one conditional storage mutation of one persisted intent; `stored` is storage evidence only,
 * never a logical APPLIED, a confirmed transfer, current ownership or a work right.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaimIntentRecord, type ClaimOperationIntent, openClaimIntentJournal } from "../claims/journal/index.ts";
import {
	type ClaimMutationReceipt,
	type ClaimMutationResolution,
	type ClaimMutationSource,
	createClaimMutationReceipt,
	resolveClaimMutation,
} from "../claims/resolution/index.ts";
import {
	type ClaimChange,
	type ClaimDocument,
	type ClaimReadResult,
	type ClaimStorageFormat,
	type ClaimStorageOptions,
	type ClaimStore,
	initializeClaimStorage,
	type JsonObject,
	openClaimStore,
} from "../claims/storage/index.ts";
import { DropProxy, GitFixtureServer, ReceiveGates } from "./fixtures/claim-git-fixture.ts";

const FORMATS = ["blob", "tree", "commit-chain"] as const satisfies readonly ClaimStorageFormat[];
const TEST_TIMEOUT = 15_000;
const ADAPTER_TIMEOUT = 3_000;
const FIXTURE_ROOT = process.env.CLAIM_JOURNAL_TEST_ROOT ?? tmpdir();
const TICKET = "BACK-1";
const OTHER_TICKET = "BACK-2";
const OP = "op-claim-a";
/** Distinctive values that no diagnostic may echo. */
const REMOTE = "git://127.0.0.1:9/sentinel-claims.git";
const BINDING = `tb1-${"5e".repeat(32)}`;
const OTHER_BINDING = `tb1-${"7a".repeat(32)}`;
const HOLDER = "agent-sentinel-holder";
const SOURCE_ERROR = "sentinel-source-error-detail";
const ROOT_0 = "a0".repeat(20);
const ROOT_1 = "b1".repeat(20);
const ROOT_2 = "c2".repeat(20);
const ROOT_64 = "d3".repeat(32);
const CLAIMED: JsonObject = { state: "claimed", holder: HOLDER };
const RENEWED: JsonObject = { state: "claimed", holder: HOLDER, renewed: true };

let fixtureServer: GitFixtureServer | undefined;

beforeAll(async () => {
	fixtureServer = await GitFixtureServer.create();
});

afterAll(async () => {
	await fixtureServer?.close();
});

function server(): GitFixtureServer {
	if (!fixtureServer) throw new Error("Git fixture server was not started");
	return fixtureServer;
}

function byCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Reference canonical JSON: object keys recursively sorted by code units, compact, array order preserved. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => byCodeUnits(left, right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("fixture values must be JSON encodable");
	return encoded;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function intentOf(changes: Partial<ClaimOperationIntent> = {}): ClaimOperationIntent {
	return {
		operationId: OP,
		remote: REMOTE,
		format: "blob",
		epoch: 1,
		ticket: TICKET,
		expectedRoot: ROOT_0,
		targetBinding: BINDING,
		action: "claim",
		parameters: { holder: HOLDER, ttlSeconds: 300 },
		resolved: { leaseEnd: "2026-09-25T00:05:00Z" },
		...changes,
	};
}

/** Reference record: lowercase hex SHA-256 over canonical JSON without a trailing newline. */
function recordOf(intent: ClaimOperationIntent): ClaimIntentRecord {
	return {
		schema: 1,
		intent,
		parameterDigest: sha256Hex(canonicalJson(intent.parameters)),
		digest: sha256Hex(canonicalJson(intent)),
	};
}

/** Reference receipt: exactly the schema and both digests of the record, nothing from the raw intent. */
function receiptOf(record: ClaimIntentRecord): ClaimMutationReceipt {
	return { schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest };
}

function sourceOf(intent: ClaimOperationIntent): ClaimMutationSource {
	return { remote: intent.remote, descriptor: { schema: 1, format: intent.format, epoch: intent.epoch } };
}

/** `count` unrelated receipts named `op-earlier-<n>`, plus any `own` entries. */
function receiptsWith(count: number, own: Record<string, JsonObject> = {}): Record<string, JsonObject> {
	const receipts: Record<string, JsonObject> = {};
	for (let index = 1; index <= count; index++) {
		receipts[`op-earlier-${index}`] = {
			schema: 1,
			intentDigest: sha256Hex(`earlier-intent-${index}`),
			parameterDigest: sha256Hex(`earlier-parameters-${index}`),
		};
	}
	return { ...receipts, ...own };
}

function documentOf(
	revision: number,
	receipts: Record<string, JsonObject>,
	changes: Partial<ClaimDocument> = {},
): ClaimDocument {
	return { schema: 1, format: "blob", epoch: 1, ticket: TICKET, revision, payload: CLAIMED, receipts, ...changes };
}

function present(root: string, document: ClaimDocument): ClaimReadResult {
	return { kind: "present", ticket: document.ticket, root, document };
}

function absent(ticket = TICKET): ClaimReadResult {
	return { kind: "absent", ticket };
}

function resolve(record: ClaimIntentRecord, observed: ClaimReadResult, source?: ClaimMutationSource) {
	return resolveClaimMutation({ record, source: source ?? sourceOf(record.intent), observed });
}

/** Untyped variant for deliberately malformed inputs. */
function resolveRaw(record: unknown, observed: unknown, source: unknown): ClaimMutationResolution {
	return resolveClaimMutation({
		record: record as ClaimIntentRecord,
		source: source as ClaimMutationSource,
		observed: observed as ClaimReadResult,
	});
}

function expectKind<T extends { kind: string }, K extends T["kind"]>(value: T, kind: K): Extract<T, { kind: K }> {
	if (value.kind !== kind) throw new Error(`expected ${kind}, got ${value.kind}`);
	return value as Extract<T, { kind: K }>;
}

/**
 * A failure result carries exactly `kind` and a string `reason` that echoes none of the sentinels or the
 * given record values. Only counts are compared, so a failing run prints no raw values either.
 */
function expectFailure(label: string, result: { kind: string }, kind: string, values: string[] = []): void {
	const reason = (result as { reason?: unknown }).reason;
	const text = typeof reason === "string" ? reason : "";
	const echoed = [REMOTE, BINDING, OTHER_BINDING, HOLDER, SOURCE_ERROR, ...values].filter((value) =>
		text.includes(value),
	).length;
	expect({
		label,
		kind: result.kind,
		keys: Object.keys(result).sort(byCodeUnits),
		reasonType: typeof reason,
		echoed,
	}).toEqual({ label, kind, keys: ["kind", "reason"], reasonType: "string", echoed: 0 });
}

describe("claim mutation receipt and record validation", () => {
	test("builds exactly the reference receipt, deterministically and without raw intent values", () => {
		const record = recordOf(intentOf());
		const created = createClaimMutationReceipt(record);
		expect(created).toEqual({ kind: "receipt", receipt: receiptOf(record) });
		expect(Object.keys(expectKind(created, "receipt").receipt).sort(byCodeUnits)).toEqual([
			"intentDigest",
			"parameterDigest",
			"schema",
		]);
		expect(createClaimMutationReceipt(structuredClone(record))).toEqual(created);

		const text = JSON.stringify(created);
		const echoed = [REMOTE, BINDING, HOLDER, OP, ROOT_0].filter((value) => text.includes(value));
		expect(echoed.length).toBe(0);

		// Differing only in the target binding changes the intent digest, not the parameter digest.
		const rebound = recordOf(intentOf({ targetBinding: OTHER_BINDING }));
		const other = expectKind(createClaimMutationReceipt(rebound), "receipt").receipt;
		expect({
			intentDigestDiffers: other.intentDigest !== record.digest,
			parameterDigestEqual: other.parameterDigest === record.parameterDigest,
		}).toEqual({ intentDigestDiffers: true, parameterDigestEqual: true });
	});

	test("rejects changed fields under old digests and malformed records, and never resolves them as stored", () => {
		const base = recordOf(intentOf());
		const observed = present(ROOT_1, documentOf(2, receiptsWith(1, { [OP]: receiptOf(base) })));
		// Healthy controls: the unmodified record yields its receipt and resolves as stored.
		expect(createClaimMutationReceipt(base)).toEqual({ kind: "receipt", receipt: receiptOf(base) });
		expect(resolve(base, observed)).toEqual({ kind: "stored", observedRoot: ROOT_1 });

		const changed = (changes: Partial<ClaimOperationIntent>) => ({ ...base, intent: { ...base.intent, ...changes } });
		const withoutParameterDigest = { schema: base.schema, intent: base.intent, digest: base.digest };
		const variants: Record<string, unknown> = {
			"target binding changed": changed({ targetBinding: OTHER_BINDING }),
			"resolved times changed": changed({ resolved: { leaseEnd: "2026-09-25T09:00:00Z" } }),
			"parameters changed": changed({ parameters: { holder: HOLDER, ttlSeconds: 3600 } }),
			"expected root changed": changed({ expectedRoot: ROOT_2 }),
			"operation ID changed": changed({ operationId: "op-claim-b" }),
			"action changed": changed({ action: "renew" }),
			"wrong parameter digest": { ...base, parameterDigest: sha256Hex("{}") },
			"wrong digest": { ...base, digest: sha256Hex("{}") },
			"uppercase digest": { ...base, digest: base.digest.toUpperCase() },
			"schema 2": { ...base, schema: 2 },
			"extra record field": { ...base, extra: 1 },
			"missing parameter digest": withoutParameterDigest,
			"extra intent field with matching digests": recordOf({ ...base.intent, extra: 1 } as ClaimOperationIntent),
			"invalid epoch with matching digests": recordOf({ ...base.intent, epoch: 0 }),
			"invalid ticket with matching digests": recordOf({ ...base.intent, ticket: "not a ticket" }),
			"invalid remote with matching digests": recordOf({ ...base.intent, remote: "relative/claims" }),
			"empty binding with matching digests": recordOf({ ...base.intent, targetBinding: "" }),
			"null record": null,
			"string record": "record",
		};
		for (const [label, record] of Object.entries(variants)) {
			expectFailure(`${label} receipt`, createClaimMutationReceipt(record as ClaimIntentRecord), "invalid", [
				base.digest,
			]);
			expectFailure(`${label} resolution`, resolveRaw(record, observed, sourceOf(base.intent)), "invalid", [
				base.digest,
			]);
		}
	});

	test("does not launder non-JSON values into an accepted record", () => {
		const normalized = intentOf({ parameters: { holder: HOLDER, ttlSeconds: 300, note: {} } });
		const withoutNote = intentOf();
		const nulled = intentOf({ parameters: { holder: HOLDER, ttlSeconds: null } });
		const observedFor = (record: ClaimIntentRecord) =>
			present(ROOT_1, documentOf(1, { [record.intent.operationId]: receiptOf(record) }));
		// Control: the JSON form each laundering would produce is itself accepted and stored.
		expect(resolve(recordOf(normalized), observedFor(recordOf(normalized)))).toEqual({
			kind: "stored",
			observedRoot: ROOT_1,
		});

		class Times {
			leaseEnd = "2026-09-25T00:05:00Z";
		}
		const cases: { label: string; raw: unknown; json: ClaimOperationIntent }[] = [
			{
				label: "Date object laundered to {}",
				raw: { ...normalized, parameters: { holder: HOLDER, ttlSeconds: 300, note: new Date(0) } },
				json: normalized,
			},
			{
				label: "undefined member dropped",
				raw: { ...withoutNote, parameters: { holder: HOLDER, ttlSeconds: 300, note: undefined } },
				json: withoutNote,
			},
			{
				label: "NaN laundered to null",
				raw: { ...nulled, parameters: { holder: HOLDER, ttlSeconds: Number.NaN } },
				json: nulled,
			},
			{ label: "class instance in resolved", raw: { ...withoutNote, resolved: new Times() }, json: withoutNote },
		];
		for (const { label, raw, json } of cases) {
			const jsonRecord = recordOf(json);
			const record = { ...jsonRecord, intent: raw };
			expectFailure(`${label} receipt`, createClaimMutationReceipt(record as ClaimIntentRecord), "invalid");
			expectFailure(`${label} resolution`, resolveRaw(record, observedFor(jsonRecord), sourceOf(json)), "invalid");
		}
	});

	test("captures the record once: an accessor changing the operation ID cannot redirect the lookup", () => {
		const base = recordOf(intentOf());
		const observed = present(ROOT_1, documentOf(1, { [OP]: receiptOf(base) }));
		expect(resolve(base, observed)).toEqual({ kind: "stored", observedRoot: ROOT_1 });

		const reads = { count: 0 };
		const intent = { ...base.intent };
		Object.defineProperty(intent, "operationId", {
			enumerable: true,
			get: () => {
				reads.count += 1;
				return reads.count === 1 ? OP : "op-other";
			},
		});
		const result = resolve({ ...base, intent }, observed);
		// A consistent snapshot yields stored (first value) or invalid (digest mismatch); a lookup under a
		// different ID than the validated one would report not-stored, open or conflict.
		const consistent =
			(result.kind === "stored" && result.observedRoot === ROOT_1) ||
			(result.kind === "invalid" && Object.keys(result).length === 2);
		expect({ consulted: reads.count > 0, kind: result.kind, consistent }).toEqual({
			consulted: true,
			kind: result.kind,
			consistent: true,
		});
	});
});

describe("claim mutation resolution over constructed observations", () => {
	test("stores only on the exact own receipt; payload, other operations and later renewals prove nothing", () => {
		const base = recordOf(intentOf());
		const own = receiptOf(base);
		expect(resolve(base, present(ROOT_1, documentOf(2, receiptsWith(1, { [OP]: own }))))).toEqual({
			kind: "stored",
			observedRoot: ROOT_1,
		});

		const notStored: Record<string, ClaimReadResult> = {
			"same payload, other operation": present(ROOT_1, documentOf(1, { "op-claim-b": own })),
			"later renewal of the same holder": present(ROOT_2, documentOf(3, receiptsWith(2, { "op-renew": own }))),
		};
		for (const [label, observed] of Object.entries(notStored)) {
			expect({ label, result: resolve(base, observed) }).toEqual({
				label,
				result: { kind: "not-stored", observedRoot: observed.kind === "present" ? observed.root : "" },
			});
		}

		const withoutParameterDigest = { schema: own.schema, intentDigest: own.intentDigest };
		const conflicts: Record<string, ClaimReadResult> = {
			"different intent digest under the own ID": present(
				ROOT_1,
				documentOf(1, { [OP]: { ...own, intentDigest: sha256Hex("other intent") } }),
			),
			"extra receipt field": present(ROOT_1, documentOf(1, { [OP]: { ...own, outcome: "applied" } })),
			"missing parameter digest": present(ROOT_1, documentOf(1, { [OP]: withoutParameterDigest })),
			"receipt schema 2": present(ROOT_1, documentOf(1, { [OP]: { ...own, schema: 2 } })),
			"exact own receipt already at the expected root": present(ROOT_0, documentOf(1, { [OP]: own })),
		};
		for (const [label, observed] of Object.entries(conflicts)) {
			expectFailure(label, resolve(base, observed), "conflict", [base.digest]);
		}
	});

	test("counts only own receipt properties: inherited names such as constructor are no receipt", () => {
		for (const operationId of ["constructor", "toString"]) {
			const record = recordOf(intentOf({ operationId }));
			// Healthy control: an own receipt under that name is compared like any other.
			const own = present(ROOT_1, documentOf(1, { [operationId]: receiptOf(record) }));
			expect({ operationId, result: resolve(record, own) }).toEqual({
				operationId,
				result: { kind: "stored", observedRoot: ROOT_1 },
			});
			// Plain-object receipts inherit the name from Object.prototype; that is not an own receipt.
			const inherited = present(ROOT_1, documentOf(1, receiptsWith(1)));
			expect({ operationId, result: resolve(record, inherited) }).toEqual({
				operationId,
				result: { kind: "not-stored", observedRoot: ROOT_1 },
			});
			const unchanged = present(ROOT_0, documentOf(1, receiptsWith(1)));
			expect({ operationId, result: resolve(record, unchanged) }).toEqual({
				operationId,
				result: { kind: "open", observedRoot: ROOT_0 },
			});
		}
	});

	test("keeps an unchanged expected root open, including initial absence, until an identical retry is stored", () => {
		const existing = recordOf(intentOf());
		const initial = recordOf(intentOf({ operationId: "op-acquire", expectedRoot: null }));
		const before = { existing: structuredClone(existing), initial: structuredClone(initial) };

		expect(resolve(existing, present(ROOT_0, documentOf(1, receiptsWith(1))))).toEqual({
			kind: "open",
			observedRoot: ROOT_0,
		});
		// Openness does not depend on unrelated receipt completeness.
		expect(resolve(existing, present(ROOT_0, documentOf(4, receiptsWith(1))))).toEqual({
			kind: "open",
			observedRoot: ROOT_0,
		});
		expect(resolve(initial, absent())).toEqual({ kind: "open", observedRoot: null });

		const retried = present(ROOT_1, documentOf(2, receiptsWith(1, { [OP]: receiptOf(existing) })));
		expect(resolve(existing, retried)).toEqual({ kind: "stored", observedRoot: ROOT_1 });
		const acquired = present(ROOT_64, documentOf(1, { "op-acquire": receiptOf(initial) }));
		expect(resolve(initial, acquired)).toEqual({ kind: "stored", observedRoot: ROOT_64 });
		expect({ existing, initial }).toEqual(before);
	});

	test("keeps own positive evidence without complete history, but needs complete counts for not-stored", () => {
		const base = recordOf(intentOf());
		const initial = recordOf(intentOf({ operationId: "op-acquire", expectedRoot: null }));
		expect(resolve(base, present(ROOT_2, documentOf(5, receiptsWith(1, { [OP]: receiptOf(base) }))))).toEqual({
			kind: "stored",
			observedRoot: ROOT_2,
		});
		// Rule 5 also wins over an excess count: more receipts than revisions, own exact receipt among them.
		expect(resolve(base, present(ROOT_2, documentOf(2, receiptsWith(3, { [OP]: receiptOf(base) }))))).toEqual({
			kind: "stored",
			observedRoot: ROOT_2,
		});
		// Complete-history controls: receipt count equals revision.
		expect(resolve(base, present(ROOT_2, documentOf(3, receiptsWith(3))))).toEqual({
			kind: "not-stored",
			observedRoot: ROOT_2,
		});
		expect(resolve(initial, present(ROOT_1, documentOf(1, receiptsWith(1))))).toEqual({
			kind: "not-stored",
			observedRoot: ROOT_1,
		});

		const unknownHistory: Record<string, [ClaimIntentRecord, ClaimReadResult]> = {
			"fewer receipts than revisions": [base, present(ROOT_2, documentOf(4, receiptsWith(3)))],
			"more receipts than revisions": [base, present(ROOT_2, documentOf(2, receiptsWith(3)))],
			"previously present root now absent": [base, absent()],
			"foreign creation with incomplete history": [initial, present(ROOT_1, documentOf(2, receiptsWith(1)))],
		};
		for (const [label, [record, observed]] of Object.entries(unknownHistory)) {
			expectFailure(label, resolve(record, observed), "unknown-history", [record.digest]);
		}
	});

	test("rejects a wrong source, descriptor or ticket scope as invalid before any history verdict", () => {
		const base = recordOf(intentOf());
		const observed = present(ROOT_1, documentOf(1, { [OP]: receiptOf(base) }));
		const source = sourceOf(base.intent);
		expect(resolve(base, observed, source)).toEqual({ kind: "stored", observedRoot: ROOT_1 });

		const sources: Record<string, unknown> = {
			"other repository": { ...source, remote: "git://127.0.0.1:9/other-claims.git" },
			"trailing slash": { ...source, remote: `${REMOTE}/` },
			"host alias": { ...source, remote: "git://localhost:9/sentinel-claims.git" },
			"descriptor format": { ...source, descriptor: { ...source.descriptor, format: "tree" } },
			"descriptor epoch": { ...source, descriptor: { ...source.descriptor, epoch: 2 } },
			"descriptor schema": { ...source, descriptor: { ...source.descriptor, schema: 2 } },
			"descriptor missing": { remote: source.remote },
			"descriptor null": { ...source, descriptor: null },
			"descriptor array": { ...source, descriptor: [] },
		};
		for (const [label, wrong] of Object.entries(sources)) {
			expectFailure(label, resolveRaw(base, observed, wrong), "invalid");
		}

		const document = documentOf(1, { [OP]: receiptOf(base) });
		const observations: Record<string, ClaimReadResult> = {
			"absent for another ticket": absent(OTHER_TICKET),
			"present for another ticket": present(ROOT_1, { ...document, ticket: OTHER_TICKET }),
			"document ticket differs": {
				kind: "present",
				ticket: TICKET,
				root: ROOT_1,
				document: { ...document, ticket: OTHER_TICKET },
			},
			"document format differs": present(ROOT_1, { ...document, format: "tree" }),
			"document epoch differs": present(ROOT_1, { ...document, epoch: 2 }),
		};
		for (const [label, wrong] of Object.entries(observations)) {
			expectFailure(label, resolve(base, wrong, source), "invalid");
		}
	});

	test("reports failed native reads as unknown, never as a negative verdict, without echoing source errors", () => {
		const initial = recordOf(intentOf({ operationId: "op-acquire", expectedRoot: null }));
		expect(resolve(initial, absent())).toEqual({ kind: "open", observedRoot: null });
		const failures: ClaimReadResult[] = [
			{ kind: "unreachable", reason: SOURCE_ERROR },
			{ kind: "corrupt", reason: SOURCE_ERROR },
			{ kind: "invalid", reason: SOURCE_ERROR },
		];
		for (const observed of failures) {
			expectFailure(observed.kind, resolve(initial, observed), "unknown");
		}
	});

	test("fails closed as unknown on structurally malformed observations, with healthy controls", () => {
		const base = recordOf(intentOf());
		const healthy = documentOf(1, { [OP]: receiptOf(base) });
		expect(resolve(base, present(ROOT_1, healthy))).toEqual({ kind: "stored", observedRoot: ROOT_1 });
		expect(resolve(base, present(ROOT_2, documentOf(1, receiptsWith(1))))).toEqual({
			kind: "not-stored",
			observedRoot: ROOT_2,
		});

		const withoutTicket = Object.fromEntries(Object.entries(healthy).filter(([key]) => key !== "ticket"));
		const withDocument = (document: unknown) => ({ kind: "present", ticket: TICKET, root: ROOT_1, document });
		/** The healthy document plus one receipt under a key that is no valid operation ID. */
		const withReceiptKey = (key: string) =>
			withDocument({ ...healthy, receipts: { ...healthy.receipts, [key]: receiptOf(base) } });
		const malformed: Record<string, unknown> = {
			"present without document": { kind: "present", ticket: TICKET, root: ROOT_1 },
			"document null": withDocument(null),
			"receipts array": withDocument({ ...healthy, receipts: [] }),
			"receipts string": withDocument({ ...healthy, receipts: "none" }),
			"own receipt not an object": withDocument({ ...healthy, receipts: { [OP]: "stored" } }),
			"receipt key with a slash": withReceiptKey("a/b"),
			"receipt key dot-dot": withReceiptKey(".."),
			"revision 0": withDocument({ ...healthy, revision: 0 }),
			"fractional revision": withDocument({ ...healthy, revision: 1.5 }),
			"revision as string": withDocument({ ...healthy, revision: "1" }),
			"revision beyond safe integers": withDocument({ ...healthy, revision: Number.MAX_SAFE_INTEGER + 1 }),
			"payload array": withDocument({ ...healthy, payload: [] }),
			"document schema 2": withDocument({ ...healthy, schema: 2 }),
			"document without ticket": withDocument(withoutTicket),
			"uppercase root": { ...withDocument(healthy), root: ROOT_1.toUpperCase() },
			"39-character root": { ...withDocument(healthy), root: ROOT_1.slice(1) },
			"41-character root": { ...withDocument(healthy), root: `${ROOT_1}0` },
			"63-character root": { ...withDocument(healthy), root: ROOT_64.slice(1) },
			"65-character root": { ...withDocument(healthy), root: `${ROOT_64}0` },
			"root with a final newline": { ...withDocument(healthy), root: `${ROOT_1}\n` },
			"root not a string": { ...withDocument(healthy), root: 42 },
			"unknown observation kind": { kind: "maybe", ticket: TICKET },
			"absent without ticket": { kind: "absent" },
			"observation null": null,
		};
		for (const [label, observed] of Object.entries(malformed)) {
			expectFailure(label, resolveRaw(base, observed, sourceOf(base.intent)), "unknown", [base.digest]);
		}
	});

	test("resolves a pending-stage intent only to storage evidence, with exact result fields", () => {
		const stage = recordOf(intentOf({ operationId: "op-transfer-p", action: "transfer-restart-propose" }));
		const result = resolve(stage, present(ROOT_1, documentOf(1, { "op-transfer-p": receiptOf(stage) })));
		expect(result).toEqual({ kind: "stored", observedRoot: ROOT_1 });
		expect(Object.keys(result).sort(byCodeUnits)).toEqual(["kind", "observedRoot"]);
	});
});

function changeOf(record: ClaimIntentRecord, payload: JsonObject): ClaimChange {
	return { operationId: record.intent.operationId, receipt: receiptOf(record), payload };
}

/** One server repository with an initialized descriptor, client repositories and a private journal directory. */
class ResolutionCase {
	readonly format: ClaimStorageFormat;
	readonly root: string;
	readonly label: string;
	readonly url: string;
	/** The client repository that initialized the descriptor. */
	readonly primary: string;
	readonly gates: ReceiveGates;
	private readonly journalDirectory: string;
	private readonly cleanups: (() => Promise<void>)[] = [];
	private scratchNumber = 0;

	private constructor(format: ClaimStorageFormat, root: string, label: string, url: string, primary: string) {
		this.format = format;
		this.root = root;
		this.label = label;
		this.url = url;
		this.primary = primary;
		this.gates = new ReceiveGates(root, label);
		this.journalDirectory = join(root, "journal");
	}

	static async create(format: ClaimStorageFormat, caseName: string): Promise<ResolutionCase> {
		const root = await mkdtemp(join(FIXTURE_ROOT, "claim-resolution-"));
		try {
			const label = `resolution-${format}-${caseName}`;
			const { name } = await server().initRepository(root, label);
			const primary = await ResolutionCase.initClient(join(root, "client-a"));
			const resolutionCase = new ResolutionCase(format, root, label, server().url(name), primary);
			await mkdir(resolutionCase.journalDirectory);
			await chmod(resolutionCase.journalDirectory, 0o700);
			expectKind(await initializeClaimStorage(resolutionCase.options(primary)), "created");
			return resolutionCase;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	private static async initClient(path: string): Promise<string> {
		await mkdir(path);
		await server().git(path, ["init", "--quiet", "--initial-branch=main"]);
		await server().git(path, ["commit", "--quiet", "--allow-empty", "-m", "seed"]);
		return path;
	}

	/** An additional independent client repository, for example a competing writer. */
	async client(label: string): Promise<string> {
		return ResolutionCase.initClient(join(this.root, `client-${label}`));
	}

	options(repository: string, remote = this.url): ClaimStorageOptions {
		return { repository, remote, format: this.format, timeoutMs: ADAPTER_TIMEOUT };
	}

	async store(repository: string, remote = this.url): Promise<ClaimStore> {
		return expectKind(await openClaimStore(this.options(repository, remote)), "open").store;
	}

	source(): ClaimMutationSource {
		return { remote: this.url, descriptor: { schema: 1, format: this.format, epoch: 1 } };
	}

	intent(operationId: string, expectedRoot: string | null, ticket = TICKET, binding = BINDING): ClaimOperationIntent {
		const scope = { remote: this.url, format: this.format, ticket };
		return intentOf({ operationId, expectedRoot, targetBinding: binding, ...scope });
	}

	/** Persists the intent in the private journal and returns the record as loaded back from disk. */
	async persist(intent: ClaimOperationIntent): Promise<ClaimIntentRecord> {
		const journal = expectKind(await openClaimIntentJournal({ directory: this.journalDirectory }), "open").journal;
		expectKind(await journal.prepare(intent), "prepared");
		const record = expectKind(await journal.load(intent.operationId), "loaded").record;
		expect(record).toEqual(recordOf(intent));
		return record;
	}

	/**
	 * Root the first write of `change` to an absent ticket creates, learned by the product writing the same
	 * change to a scratch repository: all three layouts yield deterministic object IDs.
	 */
	async rootOfFirstWrite(repository: string, ticket: string, change: ClaimChange): Promise<string> {
		const { name } = await server().initRepository(this.root, `${this.label}-scratch-${++this.scratchNumber}`);
		const scratch = this.options(repository, server().url(name));
		expectKind(await initializeClaimStorage(scratch), "created");
		const store = expectKind(await openClaimStore(scratch), "open").store;
		return expectKind(await store.write(expectKind(await store.read(ticket), "absent"), change), "applied").root;
	}

	/** The configured endpoint's repository, reached through a connection-dropping proxy. */
	async viaDropProxy(): Promise<{ proxy: DropProxy; remote: string }> {
		const proxy = await DropProxy.create(server().port);
		this.cleanups.push(() => proxy.drop());
		return { proxy, remote: this.url.replace(`127.0.0.1:${server().port}/`, `127.0.0.1:${proxy.port}/`) };
	}

	async dispose(): Promise<void> {
		await this.gates.releaseAll();
		for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withCase(
	format: ClaimStorageFormat,
	caseName: string,
	body: (fixture: ResolutionCase) => Promise<void>,
): Promise<void> {
	const fixture = await ResolutionCase.create(format, caseName);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

for (const format of FORMATS) {
	describe(`claim mutation resolution over real Git (${format})`, () => {
		test(
			"resolves a mutation whose reply was lost as stored, like one with a healthy reply",
			async () => {
				await withCase(format, "lost-reply", async (fixture) => {
					const client = fixture.primary;
					const direct = await fixture.store(client);
					const record = await fixture.persist(fixture.intent("op-lost-reply", null));
					const change = changeOf(record, CLAIMED);
					const oid = await fixture.rootOfFirstWrite(client, TICKET, change);
					const base = expectKind(await direct.read(TICKET), "absent");

					const { proxy, remote } = await fixture.viaDropProxy();
					const lossy = await fixture.store(client, remote);
					await fixture.gates.arm("pre", oid);
					const pending = lossy.write(base, change);
					await fixture.gates.entered("pre", oid);
					proxy.holdReplies();
					await fixture.gates.release("pre", oid);
					await proxy.untilWithheld(`ok refs/claims/${TICKET}`);
					await proxy.drop();
					// Precondition: the reply was really lost after the server applied the mutation.
					expect((await pending).kind).toBe("unknown");
					const afterLoss = await direct.read(TICKET);
					expect(resolveClaimMutation({ record, source: fixture.source(), observed: afterLoss })).toEqual({
						kind: "stored",
						observedRoot: oid,
					});

					// Healthy control: the same kind of mutation with its reply intact.
					const healthy = await fixture.persist(fixture.intent("op-healthy-reply", null, OTHER_TICKET));
					const healthyBase = expectKind(await direct.read(OTHER_TICKET), "absent");
					const applied = expectKind(await direct.write(healthyBase, changeOf(healthy, CLAIMED)), "applied");
					const observed = await direct.read(OTHER_TICKET);
					expect(resolveClaimMutation({ record: healthy, source: fixture.source(), observed })).toEqual({
						kind: "stored",
						observedRoot: applied.root,
					});
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"keeps an unsent intent open, then stored, and keeps an older stored verdict after a later mutation",
			async () => {
				await withCase(format, "later-mutation", async (fixture) => {
					const store = await fixture.store(fixture.primary);
					const first = await fixture.persist(fixture.intent("op-first", null));
					const created = expectKind(
						await store.write(expectKind(await store.read(TICKET), "absent"), changeOf(first, CLAIMED)),
						"applied",
					);

					const later = await fixture.persist(fixture.intent("op-later", created.root, TICKET, OTHER_BINDING));
					const unchanged = structuredClone(later);
					const beforeSend = await store.read(TICKET);
					expect(resolveClaimMutation({ record: later, source: fixture.source(), observed: beforeSend })).toEqual({
						kind: "open",
						observedRoot: created.root,
					});

					const renewed = expectKind(
						await store.write(expectKind(beforeSend, "present"), changeOf(later, RENEWED)),
						"applied",
					);
					const after = await store.read(TICKET);
					expect(resolveClaimMutation({ record: first, source: fixture.source(), observed: after })).toEqual({
						kind: "stored",
						observedRoot: renewed.root,
					});
					expect(resolveClaimMutation({ record: later, source: fixture.source(), observed: after })).toEqual({
						kind: "stored",
						observedRoot: renewed.root,
					});
					expect(later).toEqual(unchanged);
				});
			},
			TEST_TIMEOUT,
		);

		test(
			"resolves intents displaced by a competing writer as not-stored and the winners as stored",
			async () => {
				await withCase(format, "competing-writer", async (fixture) => {
					const ours = await fixture.store(fixture.primary);
					const theirs = await fixture.store(await fixture.client("b"));

					// Initial acquisition: both expect an absent ticket; the competitor wins first.
					const ourBase = expectKind(await ours.read(TICKET), "absent");
					const mine = await fixture.persist(fixture.intent("op-mine", null));
					const competitor = await fixture.persist(fixture.intent("op-theirs", null, TICKET, OTHER_BINDING));
					const won = expectKind(
						await theirs.write(expectKind(await theirs.read(TICKET), "absent"), changeOf(competitor, CLAIMED)),
						"applied",
					);
					expect((await ours.write(ourBase, changeOf(mine, CLAIMED))).kind).toBe("rejected");
					const afterAcquire = await ours.read(TICKET);
					expect(resolveClaimMutation({ record: mine, source: fixture.source(), observed: afterAcquire })).toEqual({
						kind: "not-stored",
						observedRoot: won.root,
					});
					expect(
						resolveClaimMutation({ record: competitor, source: fixture.source(), observed: afterAcquire }),
					).toEqual({ kind: "stored", observedRoot: won.root });

					// Two different intents with the same payload against the same root: the later winner does not
					// prove the displaced one.
					const shared = expectKind(afterAcquire, "present");
					const mineRenew = await fixture.persist(fixture.intent("op-mine-renew", won.root));
					const theirRenew = await fixture.persist(fixture.intent("op-their-renew", won.root, TICKET, OTHER_BINDING));
					const renewed = expectKind(
						await theirs.write(expectKind(await theirs.read(TICKET), "present"), changeOf(theirRenew, RENEWED)),
						"applied",
					);
					expect((await ours.write(shared, changeOf(mineRenew, RENEWED))).kind).toBe("rejected");
					const afterRenew = await ours.read(TICKET);
					expect(resolveClaimMutation({ record: mineRenew, source: fixture.source(), observed: afterRenew })).toEqual({
						kind: "not-stored",
						observedRoot: renewed.root,
					});
					expect(resolveClaimMutation({ record: theirRenew, source: fixture.source(), observed: afterRenew })).toEqual({
						kind: "stored",
						observedRoot: renewed.root,
					});
				});
			},
			TEST_TIMEOUT,
		);
	});
}
