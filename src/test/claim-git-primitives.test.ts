/**
 * Test-only qualification of proposed Git claim storage primitives. This is not a
 * product claim API or an acceptance test for a future CLI/MCP surface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CommandResult,
	commandFailure,
	DropProxy,
	finish,
	GitFixtureServer,
	type LiveCommand,
	ReceiveGates,
} from "./fixtures/claim-git-fixture.ts";

const CLAIM_REF = "refs/claims/ABC";
const TEST_TIMEOUT = 10_000;
const FORMATS = ["blob", "tree", "commit-chain"] as const;

type Format = (typeof FORMATS)[number];
type Receipt = Record<string, unknown>;
type Receipts = Record<string, Receipt>;
type Decoded = { state: Record<string, unknown>; receipts: Receipts };

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

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("fixture values must be JSON encodable");
	return encoded;
}

class ClaimFixture {
	readonly format: Format;
	readonly caseName: string;
	readonly root: string;
	readonly name: string;
	readonly url: string;
	readonly a: string;
	readonly b: string;
	readonly initial: string;
	private readonly live = new Set<LiveCommand>();
	private readonly gates: ReceiveGates;

	private constructor(
		format: Format,
		caseName: string,
		root: string,
		name: string,
		url: string,
		a: string,
		b: string,
		initial: string,
	) {
		this.format = format;
		this.caseName = caseName;
		this.root = root;
		this.name = name;
		this.url = url;
		this.a = a;
		this.b = b;
		this.initial = initial;
		this.gates = new ReceiveGates(root, caseName);
	}

	static async create(format: Format, caseName: string): Promise<ClaimFixture> {
		const root = await mkdtemp(join(tmpdir(), "backlog-claim-case-"));
		try {
			await mkdir(join(root, "gates"));
			const { name } = await server().initRepository(root, `${format}-${caseName}`);
			const url = server().url(name);
			const a = await ClaimFixture.clone(root, url, "a");
			const b = await ClaimFixture.clone(root, url, "b");
			const initial = await ClaimFixture.encode(a, format, "free-0", "", {}, "");
			const fixture = new ClaimFixture(format, caseName, root, name, url, a, b, initial);
			const seeded = await fixture.push(a, url, "", initial);
			expect(seeded.rc).toBe(0);
			await fixture.fetch(b);
			return fixture;
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	private static async clone(root: string, url: string, label: string): Promise<string> {
		const path = join(root, label);
		const result = await server().git(root, ["clone", "--no-checkout", url, path]);
		if (result.rc !== 0) throw commandFailure(result);
		return path;
	}

	private static async encode(
		path: string,
		format: Format,
		revision: string,
		owner: string,
		receipts: Receipts,
		parent: string,
	): Promise<string> {
		const state = { schema: 1, storage: format, ticket: "ABC", revision, owner };
		if (format === "blob") return ClaimFixture.blob(path, { state, receipts });

		const receiptEntries = await Promise.all(
			Object.entries(receipts).map(async ([key, receipt]) => [key, await ClaimFixture.blob(path, receipt)] as const),
		);
		const receiptTree = await ClaimFixture.tree(
			path,
			receiptEntries.map(([name, oid]) => [name, "100644", "blob", oid] as const),
		);
		const root = await ClaimFixture.tree(path, [
			["state", "100644", "blob", await ClaimFixture.blob(path, state)],
			["operations", "040000", "tree", receiptTree],
		]);
		if (format === "tree") return root;
		const args = ["commit-tree", root];
		if (parent) args.push("-p", parent);
		return ClaimFixture.value(path, args, `${revision}\n`);
	}

	static async blob(path: string, value: unknown): Promise<string> {
		return ClaimFixture.value(path, ["hash-object", "-w", "--stdin"], `${stableJson(value)}\n`);
	}

	private static async tree(
		path: string,
		entries: readonly (readonly [string, string, string, string])[],
	): Promise<string> {
		const input = [...entries]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, mode, kind, oid]) => `${mode} ${kind} ${oid}\t${name}\n`)
			.join("");
		return ClaimFixture.value(path, ["mktree"], input);
	}

	private static async value(path: string, args: string[], input?: string): Promise<string> {
		const result = await server().git(path, args, input);
		return result.out.trim();
	}

	async make(
		path: string,
		revision: string,
		owner: string,
		receipts: Receipts,
		parent = this.initial,
	): Promise<string> {
		return ClaimFixture.encode(path, this.format, revision, owner, receipts, parent);
	}

	async fetch(path: string): Promise<string> {
		await server().git(path, ["fetch", "--no-tags", this.url, CLAIM_REF]);
		return this.remote(path);
	}

	async remote(path: string, url = this.url, ref = CLAIM_REF): Promise<string> {
		const result = await server().git(path, ["ls-remote", url, ref]);
		const first = result.out.trim().split("\n").find(Boolean);
		return first?.split(/\s+/)[0] ?? "";
	}

	async readFresh(): Promise<{ oid: string; document: Decoded }> {
		const path = await ClaimFixture.clone(
			this.root,
			this.url,
			`fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const oid = await this.fetch(path);
		return { oid, document: await this.decode(path, oid) };
	}

	async decode(path: string, oid: string): Promise<Decoded> {
		if (this.format === "blob") {
			const source = await ClaimFixture.value(path, ["cat-file", "blob", oid]);
			return JSON.parse(source) as Decoded;
		}
		const state = JSON.parse(await ClaimFixture.value(path, ["show", `${oid}:state`])) as Record<string, unknown>;
		const history =
			this.format === "tree" ? [oid] : (await ClaimFixture.value(path, ["rev-list", oid])).split("\n").filter(Boolean);
		const receipts: Receipts = {};
		for (const current of history) {
			const output = await ClaimFixture.value(path, ["ls-tree", `${current}:operations`]);
			for (const line of output.split("\n").filter(Boolean)) {
				const tab = line.indexOf("\t");
				if (tab < 0) throw new Error(`invalid ls-tree row: ${line}`);
				const metadata = line.slice(0, tab).split(" ");
				const objectId = metadata[2];
				const name = line.slice(tab + 1);
				if (!objectId || !name) throw new Error(`invalid ls-tree row: ${line}`);
				if (!receipts[name]) {
					receipts[name] = JSON.parse(await ClaimFixture.value(path, ["cat-file", "blob", objectId])) as Receipt;
				}
			}
		}
		return { state, receipts };
	}

	async arm(phase: "pre" | "post", oid: string): Promise<void> {
		await this.gates.arm(phase, oid);
	}

	async entered(phase: "pre" | "post", oid: string): Promise<string[]> {
		return this.gates.entered(phase, oid);
	}

	async release(phase: "pre" | "post", oid: string): Promise<void> {
		await this.gates.release(phase, oid);
	}

	startPush(path: string, url: string, expected: string, target: string, ref = CLAIM_REF): LiveCommand {
		if (!(ref.startsWith("refs/claims/") || ref === "refs/claim-meta/format")) {
			throw new Error(`unexpected fixture ref: ${ref}`);
		}
		return this.startGit(path, [
			"push",
			"--porcelain",
			`--force-with-lease=${ref}:${expected}`,
			url,
			`${target}:${ref}`,
		]);
	}

	startGit(path: string, args: string[]): LiveCommand {
		const live = server().startGit(path, args);
		this.live.add(live);
		return live;
	}

	async finishPush(live: LiveCommand): Promise<CommandResult> {
		return this.finishGit(live);
	}

	async finishGit(live: LiveCommand): Promise<CommandResult> {
		try {
			return await finish(live);
		} finally {
			this.live.delete(live);
		}
	}

	async push(path: string, url: string, expected: string, target: string, ref = CLAIM_REF): Promise<CommandResult> {
		return this.finishPush(this.startPush(path, url, expected, target, ref));
	}

	async gc(): Promise<{ gc: CommandResult; fsck: CommandResult }> {
		const repo = join(server().repos, `${this.name}.git`);
		await server().git(repo, ["reflog", "expire", "--expire=now", "--all"]);
		const gc = await server().git(repo, ["gc", "--prune=now"]);
		const fsck = await server().git(repo, ["fsck", "--full", "--no-reflogs"]);
		return { gc, fsck };
	}

	async reject(): Promise<void> {
		const hook = join(server().repos, `${this.name}.git`, "hooks", "pre-receive");
		await writeFile(hook, "#!/bin/sh\necho fixture-host-policy-reject >&2\nexit 1\n");
		await chmod(hook, 0o755);
	}

	async objectType(oid: string): Promise<string> {
		const repo = join(server().repos, `${this.name}.git`);
		return ClaimFixture.value(repo, ["cat-file", "-t", oid]);
	}

	async objectTypes(): Promise<string[]> {
		const repo = join(server().repos, `${this.name}.git`);
		return (await ClaimFixture.value(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]))
			.split("\n")
			.filter(Boolean);
	}

	async refNames(): Promise<string[]> {
		const repo = join(server().repos, `${this.name}.git`);
		const result = await server().git(repo, ["show-ref"]);
		return result.out.split("\n").filter(Boolean);
	}

	async dispose(): Promise<void> {
		await this.gates.releaseAll();
		for (const process of this.live) {
			try {
				process.child.kill("SIGKILL");
			} catch {
				process.child.kill();
			}
		}
		await Promise.all([...this.live].map((process) => finish(process).catch(() => undefined)));
		this.live.clear();
		await rm(this.root, { recursive: true, force: true });
	}
}

async function withFixture(
	format: Format,
	caseName: string,
	body: (fixture: ClaimFixture) => Promise<void>,
): Promise<void> {
	const fixture = await ClaimFixture.create(format, caseName);
	try {
		await body(fixture);
	} finally {
		await fixture.dispose();
	}
}

async function expectRace(format: Format): Promise<void> {
	await withFixture(format, "race", async (fixture) => {
		const a = await fixture.make(fixture.a, "claim-karl", "agent-karl/inst-01", { "op-a": { result: "stored" } });
		const b = await fixture.make(fixture.b, "claim-franz", "agent-franz/inst-07", { "op-b": { result: "stored" } });
		await Promise.all([fixture.arm("pre", a), fixture.arm("pre", b)]);
		const left = fixture.startPush(fixture.a, fixture.url, fixture.initial, a);
		const right = fixture.startPush(fixture.b, fixture.url, fixture.initial, b);
		const markers = await Promise.all([fixture.entered("pre", a), fixture.entered("pre", b)]);
		await Promise.all([fixture.release("pre", a), fixture.release("pre", b)]);
		const results = await Promise.all([fixture.finishPush(left), fixture.finishPush(right)]);
		expect(results.filter((result) => result.rc === 0)).toHaveLength(1);
		const winner = results[0]?.rc === 0 ? a : b;
		const expected =
			results[0]?.rc === 0
				? { owner: "agent-karl/inst-01", receipt: "op-a" }
				: { owner: "agent-franz/inst-07", receipt: "op-b" };
		const fresh = await fixture.readFresh();
		expect(fresh.oid).toBe(winner);
		expect(fresh.document.state.owner).toBe(expected.owner);
		expect(Object.keys(fresh.document.receipts)).toEqual([expected.receipt]);
		expect(markers).toHaveLength(2);
		expect(await fixture.objectType(fresh.oid)).toBe(format === "commit-chain" ? "commit" : format);
		if (format !== "commit-chain") expect(await fixture.objectTypes()).not.toContain("commit");
		expect((await fixture.refNames()).some((ref) => ref.includes("refs/heads/"))).toBe(false);
	});
}

async function expectDelayed(format: Format): Promise<void> {
	await withFixture(format, "delayed", async (fixture) => {
		const old = await fixture.make(fixture.a, "old", "agent-karl", { old: {} });
		const replacement = await fixture.make(fixture.b, "new", "agent-franz", { new: {} });
		await fixture.arm("pre", old);
		const delayed = fixture.startPush(fixture.a, fixture.url, fixture.initial, old);
		await fixture.entered("pre", old);
		expect((await fixture.push(fixture.b, fixture.url, fixture.initial, replacement)).rc).toBe(0);
		await fixture.release("pre", old);
		expect((await fixture.finishPush(delayed)).rc).not.toBe(0);
		expect(await fixture.remote(fixture.b)).toBe(replacement);
	});
}

async function expectLostReply(format: Format): Promise<void> {
	await withFixture(format, "lost", async (fixture) => {
		const target = await fixture.make(fixture.a, "claim", "agent-karl", {
			"claim-op": { expected: fixture.initial, result: "stored" },
		});
		await fixture.arm("post", target);
		const proxy = await DropProxy.create(server().port);
		let dropped = false;
		try {
			const lost = fixture.startPush(
				fixture.a,
				`git://127.0.0.1:${proxy.port}/${fixture.name}.git`,
				fixture.initial,
				target,
			);
			await fixture.entered("post", target);
			expect(await fixture.remote(fixture.b)).toBe(target);
			await proxy.drop();
			dropped = true;
			expect((await fixture.finishPush(lost)).rc).not.toBe(0);
		} finally {
			if (!dropped) await proxy.drop().catch(() => undefined);
			await fixture.release("post", target);
		}
		const fresh = await fixture.readFresh();
		expect(fresh.oid).toBe(target);
		expect(fresh.document.receipts).toHaveProperty("claim-op");
		expect((await fixture.push(fixture.a, fixture.url, fixture.initial, target)).rc).toBe(0);
		expect((await fixture.push(fixture.a, fixture.url, "1".repeat(40), target)).rc).toBe(0);
		expect(await fixture.remote(fixture.b)).toBe(target);
	});
}

async function expectTombstone(format: Format): Promise<void> {
	await withFixture(format, "aba", async (fixture) => {
		const delayed = await fixture.make(fixture.b, "delayed-acquire", "agent-franz", { delayed: {} });
		const claim = await fixture.make(fixture.a, "claim", "agent-karl", { claim: {} });
		expect((await fixture.push(fixture.a, fixture.url, fixture.initial, claim)).rc).toBe(0);
		const free = await fixture.make(fixture.a, "free-1", "", { claim: {}, release: {} }, claim);
		expect((await fixture.push(fixture.a, fixture.url, claim, free)).rc).toBe(0);
		expect(free).not.toBe(fixture.initial);
		expect((await fixture.push(fixture.b, fixture.url, fixture.initial, delayed)).rc).not.toBe(0);
		expect(await fixture.remote(fixture.a)).toBe(free);
		// Deliberately reuse the old root, without weakening the CAS with --force.
		expect((await fixture.push(fixture.a, fixture.url, free, fixture.initial)).rc).toBe(0);
		expect((await fixture.push(fixture.b, fixture.url, fixture.initial, delayed)).rc).toBe(0);
		expect(await fixture.remote(fixture.a)).toBe(delayed);
	});
}

async function expectReceiptGc(format: Format): Promise<void> {
	await withFixture(format, "gc", async (fixture) => {
		let parent = fixture.initial;
		const receipts: Receipts = {};
		for (let index = 0; index < 3; index++) {
			const key = `op-${index}`;
			const receipt = { revision: index, expected: parent };
			receipts[key] = receipt;
			const stored = format === "commit-chain" ? { [key]: receipt } : receipts;
			const target = await fixture.make(fixture.a, `rev-${index}`, "agent-karl", stored, parent);
			expect((await fixture.push(fixture.a, fixture.url, parent, target)).rc).toBe(0);
			parent = target;
		}
		const gc = await fixture.gc();
		expect(gc.gc.rc).toBe(0);
		expect(gc.fsck.rc).toBe(0);
		const fresh = await fixture.readFresh();
		expect(fresh.oid).toBe(parent);
		expect(fresh.document.receipts).toEqual(receipts);
	});
}

async function expectForceOverride(format: Format): Promise<void> {
	await withFixture(format, "force", async (fixture) => {
		const good = await fixture.make(fixture.b, "good", "agent-franz", { good: {} });
		const bad = await fixture.make(fixture.a, "bad", "agent-karl", { bad: {} });
		expect((await fixture.push(fixture.b, fixture.url, fixture.initial, good)).rc).toBe(0);
		expect((await fixture.push(fixture.a, fixture.url, fixture.initial, bad)).rc).not.toBe(0);
		const unsafe = await server().git(fixture.a, [
			"push",
			"--porcelain",
			`--force-with-lease=${CLAIM_REF}:${fixture.initial}`,
			"--force",
			fixture.url,
			`${bad}:${CLAIM_REF}`,
		]);
		expect(unsafe.rc).toBe(0);
		expect(await fixture.remote(fixture.b)).toBe(bad);
	});
}

async function expectNoopGuard(format: Format): Promise<void> {
	await withFixture(format, "guard", async (fixture) => {
		const manifest = "refs/claim-meta/format";
		const g0 = await ClaimFixture.blob(fixture.a, { format, epoch: 0 });
		expect((await fixture.push(fixture.a, fixture.url, "", g0, manifest)).rc).toBe(0);
		await server().git(fixture.b, ["fetch", fixture.url, manifest]);
		const g1 = await ClaimFixture.blob(fixture.b, { format, epoch: 1 });
		const target = await fixture.make(fixture.a, "fresh-ticket", "agent-karl", { guard: {} });
		const newRef = "refs/claims/PREVIOUSLY-ABSENT";
		await fixture.arm("pre", target);
		const atomic = fixture.startGit(fixture.a, [
			"push",
			"--porcelain",
			"--atomic",
			`--force-with-lease=${manifest}:${g0}`,
			`--force-with-lease=${newRef}:`,
			fixture.url,
			`${g0}:${manifest}`,
			`${target}:${newRef}`,
		]);
		const marker = await fixture.entered("pre", target);
		expect((await fixture.push(fixture.b, fixture.url, g0, g1, manifest)).rc).toBe(0);
		await fixture.release("pre", target);
		expect((await fixture.finishGit(atomic)).rc).toBe(0);
		expect(await fixture.remote(fixture.b, fixture.url, newRef)).toBe(target);
		expect(await fixture.remote(fixture.b, fixture.url, manifest)).toBe(g1);
		expect(marker.every((row) => !row.includes(manifest))).toBe(true);
	});
}

async function expectRejectPolicy(format: Format): Promise<void> {
	await withFixture(format, "reject", async (fixture) => {
		const target = await fixture.make(fixture.a, "denied", "agent-karl", { denied: {} });
		await fixture.reject();
		expect((await fixture.push(fixture.a, fixture.url, fixture.initial, target)).rc).not.toBe(0);
		expect(await fixture.remote(fixture.b)).toBe(fixture.initial);
		const refs = await server().git(fixture.b, ["ls-remote", fixture.url]);
		expect(refs.out.trim().split("\n").filter(Boolean)).toHaveLength(1);
	});
}

for (const format of FORMATS) {
	describe(`${format} storage primitive`, () => {
		test("races two independent clones and retains exactly the winner receipt", () => expectRace(format), TEST_TIMEOUT);
		test("rejects a delayed stale compare-and-swap", () => expectDelayed(format), TEST_TIMEOUT);
		test("retains a receipt after an applied push loses its response", () => expectLostReply(format), TEST_TIMEOUT);
		test("shows the tombstone ABA negative control", () => expectTombstone(format), TEST_TIMEOUT);
		test("retains reachable receipts after garbage collection", () => expectReceiptGc(format), TEST_TIMEOUT);
		test("shows the unsafe force override negative control", () => expectForceOverride(format), TEST_TIMEOUT);
		test(
			"shows that an unchanged manifest is not an atomic mutation guard",
			() => expectNoopGuard(format),
			TEST_TIMEOUT,
		);
		test(
			"keeps a rejected host policy from falling back to another ref",
			() => expectRejectPolicy(format),
			TEST_TIMEOUT,
		);
	});
}

test(
	"OID text alone does not retain an old object after garbage collection",
	async () => {
		await withFixture("blob", "string-gc", async (fixture) => {
			const target = await ClaimFixture.blob(fixture.a, { old_oid_only: fixture.initial });
			expect((await fixture.push(fixture.a, fixture.url, fixture.initial, target)).rc).toBe(0);
			const gc = await fixture.gc();
			expect(gc.gc.rc).toBe(0);
			const repo = join(server().repos, `${fixture.name}.git`);
			const oldObject = await server().git(repo, ["cat-file", "-t", fixture.initial], undefined, false);
			expect(oldObject.rc).not.toBe(0);
		});
	},
	TEST_TIMEOUT,
);
