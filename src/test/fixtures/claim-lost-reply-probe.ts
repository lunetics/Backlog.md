/**
 * Test-only diagnostic, started by hand on the test host; it asserts nothing. Pushes a blob with a
 * create-only lease through a proxy and drops the connection while post-receive holds, i.e. after the
 * server has already sent its status report. Prints the raw `git push --porcelain` exit code, stdout and
 * stderr as one JSON line per attempt, with a control push without drop for comparison.
 *
 *   bun src/test/fixtures/claim-lost-reply-probe.ts [iterations]
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DropProxy, finish, GitFixtureServer, ReceiveGates } from "./claim-git-fixture.ts";

const REF = "refs/claims/PROBE";

type Variant = "control" | "lost-reply";
type Attempt = {
	iteration: number;
	variant: Variant;
	oid?: string;
	refAtDrop?: string;
	refAfter?: string;
	rc?: number;
	successRow?: boolean;
	stdout?: string;
	stderr?: string;
	error?: string;
};

async function refValue(server: GitFixtureServer, repo: string, ref: string): Promise<string> {
	return (await server.git(repo, ["for-each-ref", "--format=%(objectname)", ref])).out.trim();
}

async function attempt(server: GitFixtureServer, root: string, iteration: number, variant: Variant): Promise<Attempt> {
	const label = `lost-reply-${variant}-${iteration}`;
	const { name, repo } = await server.initRepository(root, label);
	const client = join(root, label);
	await mkdir(client);
	await server.git(client, ["init", "--quiet"]);
	const content = `${JSON.stringify({ probe: variant, iteration })}\n`;
	const oid = (await server.git(client, ["hash-object", "-w", "--stdin"], content)).out.trim();
	const proxy = await DropProxy.create(server.port);
	const gates = new ReceiveGates(root, label);
	try {
		const url = `git://127.0.0.1:${proxy.port}/${name}.git`;
		if (variant === "lost-reply") await gates.arm("post", oid);
		const live = server.startGit(client, ["push", "--porcelain", `--force-with-lease=${REF}:`, url, `${oid}:${REF}`]);
		let refAtDrop: string | undefined;
		if (variant === "lost-reply") {
			await gates.entered("post", oid);
			refAtDrop = await refValue(server, repo, REF);
			await proxy.drop();
			await gates.release("post", oid);
		}
		const result = await finish(live);
		const successRow = result.out
			.split("\n")
			.some((line) => line.startsWith("*\t") && line.split("\t")[1]?.endsWith(`:${REF}`) === true);
		return {
			iteration,
			variant,
			oid,
			refAtDrop,
			refAfter: await refValue(server, repo, REF),
			rc: result.rc,
			successRow,
			stdout: result.out,
			stderr: result.err,
		};
	} finally {
		await gates.releaseAll();
		await proxy.drop();
	}
}

async function main(): Promise<void> {
	const iterations = Number.parseInt(process.argv[2] ?? "5", 10);
	if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");
	const server = await GitFixtureServer.create();
	const root = await mkdtemp(join(tmpdir(), "backlog-claim-lost-reply-probe-"));
	const attempts: Attempt[] = [];
	try {
		const version = (await server.git(root, ["version"])).out.trim();
		process.stdout.write(`${JSON.stringify({ git: version, bun: Bun.version, iterations })}\n`);
		for (let iteration = 1; iteration <= iterations; iteration++) {
			for (const variant of ["control", "lost-reply"] as const) {
				let record: Attempt;
				try {
					record = await attempt(server, root, iteration, variant);
				} catch (error) {
					record = { iteration, variant, error: error instanceof Error ? error.message : String(error) };
				}
				attempts.push(record);
				process.stdout.write(`${JSON.stringify(record)}\n`);
			}
		}
		const lost = attempts.filter((record) => record.variant === "lost-reply");
		const summary = {
			lostReplyAttempts: lost.length,
			failedToRun: lost.filter((record) => record.error !== undefined).length,
			rcNonZero: lost.filter((record) => record.rc !== undefined && record.rc !== 0).length,
			rcNonZeroWithSuccessRow: lost.filter((record) => record.rc !== 0 && record.successRow === true).length,
		};
		process.stdout.write(`${JSON.stringify({ summary })}\n`);
	} finally {
		await rm(root, { recursive: true, force: true });
		await server.close();
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
