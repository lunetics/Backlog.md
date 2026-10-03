/**
 * Test-only Git network fixture shared by the claim storage suites: a loopback git daemon with
 * gated receive hooks, a connection-dropping proxy and the gate directory protocol. Each test file
 * owns its own server lifecycle; this module starts nothing on import.
 */
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMAND_TIMEOUT = 4_000;

const GATE_HELPER = fileURLToPath(new URL("./claim-git-primitives/helper.ts", import.meta.url));

export type CommandResult = { args: string[]; rc: number; out: string; err: string };
export type LiveCommand = { args: string[]; child: ReturnType<typeof Bun.spawn> };
export type ReceivePhase = "pre" | "post";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandFailure(result: CommandResult): Error {
	return new Error(`git ${result.args.join(" ")} failed (${result.rc}): ${result.err || result.out}`);
}

async function streamText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream).text();
}

export async function finish(command: LiveCommand, timeout = COMMAND_TIMEOUT): Promise<CommandResult> {
	let timedOut = false;
	const killer = setTimeout(() => {
		timedOut = true;
		try {
			command.child.kill("SIGKILL");
		} catch {
			command.child.kill();
		}
	}, timeout);
	try {
		const [rc, out, err] = await Promise.all([
			command.child.exited,
			streamText(command.child.stdout),
			streamText(command.child.stderr),
		]);
		if (timedOut) throw new Error(`git command timed out: ${command.args.join(" ")}`);
		return { args: command.args, rc, out, err };
	} finally {
		clearTimeout(killer);
	}
}

async function closeServer(listener: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		listener.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

/** A loopback port that nothing listens on: connections to it are refused, it was never a Git endpoint. */
export async function unusedLoopbackPort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => {
			listener.off("error", reject);
			resolve();
		});
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("could not allocate a loopback port");
	await closeServer(listener);
	return address.port;
}

async function waitForLoopback(port: number, isExited: () => number | undefined): Promise<void> {
	const deadline = Date.now() + COMMAND_TIMEOUT;
	while (Date.now() < deadline) {
		const exitCode = isExited();
		if (exitCode !== undefined) throw new Error(`git daemon exited before readiness (${exitCode})`);
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = createConnection({ host: "127.0.0.1", port });
				socket.once("connect", () => {
					socket.end();
					resolve();
				});
				socket.once("error", reject);
			});
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("git daemon did not become ready before its deadline");
}

export class GitFixtureServer {
	readonly root: string;
	readonly repos: string;
	readonly port: number;
	readonly env: Record<string, string>;
	private readonly daemon: ReturnType<typeof Bun.spawn>;
	private daemonExitCode: number | undefined;
	private repoNumber = 0;

	private constructor(root: string, port: number, env: Record<string, string>, daemon: ReturnType<typeof Bun.spawn>) {
		this.root = root;
		this.repos = join(root, "repos");
		this.port = port;
		this.env = env;
		this.daemon = daemon;
		void daemon.exited.then((code) => {
			this.daemonExitCode = code;
		});
	}

	static async create(): Promise<GitFixtureServer> {
		const root = await mkdtemp(join(tmpdir(), "backlog-claim-git-"));
		try {
			const repos = join(root, "repos");
			const globalConfig = join(root, "gitconfig");
			await Promise.all([
				mkdir(repos),
				writeFile(globalConfig, "[user]\nname = fixture\nemail = fixture@example.invalid\n"),
			]);

			const env = { ...process.env } as Record<string, string>;
			// Inherited Git overrides must never redirect fixture writes to a real repository.
			for (const key of Object.keys(env)) {
				if (key.startsWith("GIT_")) delete env[key];
			}
			env.GIT_CONFIG_NOSYSTEM = "1";
			env.GIT_CONFIG_GLOBAL = globalConfig;
			env.GIT_AUTHOR_NAME = "fixture";
			env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
			env.GIT_COMMITTER_NAME = "fixture";
			env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";
			env.GIT_AUTHOR_DATE = "2000-01-01T00:00:00Z";
			env.GIT_COMMITTER_DATE = "2000-01-01T00:00:00Z";

			const port = await unusedLoopbackPort();
			const daemon = Bun.spawn(
				[
					"git",
					"daemon",
					"--reuseaddr",
					"--export-all",
					"--enable=receive-pack",
					"--listen=127.0.0.1",
					`--port=${port}`,
					`--base-path=${repos}`,
					repos,
				],
				{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			void streamText(daemon.stdout);
			void streamText(daemon.stderr);
			const result = new GitFixtureServer(root, port, env, daemon);
			try {
				await waitForLoopback(port, () => result.daemonExitCode);
				return result;
			} catch (error) {
				await result.close();
				throw error;
			}
		} catch (error) {
			await rm(root, { recursive: true, force: true });
			throw error;
		}
	}

	url(repoName: string): string {
		return `git://127.0.0.1:${this.port}/${repoName}.git`;
	}

	assertRunning(): void {
		if (this.daemonExitCode !== undefined) throw new Error(`git daemon exited (${this.daemonExitCode})`);
	}

	startGit(cwd: string, args: string[], input?: string): LiveCommand {
		this.assertRunning();
		const child = Bun.spawn(["git", "-C", cwd, ...args], {
			cwd,
			env: this.env,
			stdin: input === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (input !== undefined && child.stdin) {
			child.stdin.write(input);
			void child.stdin.end();
		}
		return { args, child };
	}

	async git(cwd: string, args: string[], input?: string, expectSuccess = true): Promise<CommandResult> {
		const result = await finish(this.startGit(cwd, args, input));
		if (expectSuccess && result.rc !== 0) throw commandFailure(result);
		return result;
	}

	async initRepository(fixturePath: string, prefix: string): Promise<{ name: string; repo: string }> {
		const name = `${prefix}-${++this.repoNumber}`;
		const repo = join(this.repos, `${name}.git`);
		await mkdir(repo);
		await this.git(repo, ["init", "--bare"]);
		await this.git(repo, ["config", "daemon.receivepack", "true"]);
		await this.git(repo, ["config", "gc.auto", "0"]);
		await this.git(repo, ["config", "core.logAllRefUpdates", "false"]);
		for (const phase of ["pre", "post"] as const) {
			const hook = join(repo, "hooks", `${phase}-receive`);
			await writeFile(
				hook,
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(GATE_HELPER)} ${shellQuote(phase)} ${shellQuote(fixturePath)}\n`,
			);
			await chmod(hook, 0o755);
			const preflight = await finish({
				args: [hook],
				child: Bun.spawn([hook], { cwd: repo, env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
			});
			if (preflight.rc !== 0) throw new Error(`fixture hook is not executable: ${preflight.err || preflight.out}`);
		}
		return { name, repo };
	}

	async close(): Promise<void> {
		try {
			if (this.daemonExitCode === undefined) this.daemon.kill("SIGTERM");
			await Promise.race([this.daemon.exited, Bun.sleep(COMMAND_TIMEOUT)]);
			if (this.daemonExitCode === undefined) {
				this.daemon.kill("SIGKILL");
				await this.daemon.exited;
			}
		} finally {
			await rm(this.root, { recursive: true, force: true });
		}
	}
}

export class DropProxy {
	readonly port: number;
	private readonly listener: Server;
	private readonly sockets = new Set<Socket>();
	private dropPromise: Promise<void> | undefined;

	private constructor(listener: Server, port: number) {
		this.listener = listener;
		this.port = port;
	}

	static async create(targetPort: number): Promise<DropProxy> {
		const listener = createServer();
		const proxy = await new Promise<DropProxy>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", () => {
				listener.off("error", reject);
				const address = listener.address();
				if (!address || typeof address === "string") {
					reject(new Error("proxy did not receive a loopback port"));
					return;
				}
				resolve(new DropProxy(listener, address.port));
			});
		});
		listener.on("connection", (client) => {
			proxy.sockets.add(client);
			const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
			proxy.sockets.add(upstream);
			client.on("error", () => undefined);
			upstream.on("error", () => client.destroy());
			client.pipe(upstream).pipe(client);
			const forget = (socket: Socket) => () => proxy.sockets.delete(socket);
			client.once("close", forget(client));
			upstream.once("close", forget(upstream));
		});
		return proxy;
	}

	async drop(): Promise<void> {
		this.dropPromise ??= (async () => {
			for (const socket of this.sockets) socket.destroy();
			await closeServer(this.listener);
		})();
		await this.dropPromise;
	}
}

/** Accepts loopback connections and never answers, so a client can only leave through its own timeout. */
export class StallProxy {
	readonly port: number;
	private readonly listener: Server;
	private readonly sockets = new Set<Socket>();
	private closePromise: Promise<void> | undefined;
	private accepted = 0;

	private constructor(listener: Server, port: number) {
		this.listener = listener;
		this.port = port;
	}

	/** Monotonic count of accepted connections, for deterministic "no network contact" assertions. */
	get acceptedConnections(): number {
		return this.accepted;
	}

	static async create(): Promise<StallProxy> {
		const listener = createServer();
		const proxy = await new Promise<StallProxy>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(0, "127.0.0.1", () => {
				listener.off("error", reject);
				const address = listener.address();
				if (!address || typeof address === "string") {
					reject(new Error("stall proxy did not receive a loopback port"));
					return;
				}
				resolve(new StallProxy(listener, address.port));
			});
		});
		listener.on("connection", (socket) => {
			proxy.accepted += 1;
			proxy.sockets.add(socket);
			socket.on("error", () => undefined);
			socket.once("close", () => proxy.sockets.delete(socket));
		});
		return proxy;
	}

	async close(): Promise<void> {
		this.closePromise ??= (async () => {
			for (const socket of this.sockets) socket.destroy();
			await closeServer(this.listener);
		})();
		await this.closePromise;
	}
}

/** Gate directories read by the receive hook helper under `<root>/gates/<phase>-<oid>`. */
export class ReceiveGates {
	private readonly root: string;
	private readonly label: string;
	private readonly armed = new Set<string>();

	constructor(root: string, label: string) {
		this.root = root;
		this.label = label;
	}

	private path(phase: ReceivePhase, oid: string): string {
		return join(this.root, "gates", `${phase}-${oid}`);
	}

	async arm(phase: ReceivePhase, oid: string): Promise<void> {
		const gate = this.path(phase, oid);
		await mkdir(gate, { recursive: true });
		await writeFile(join(gate, "armed"), "");
		this.armed.add(gate);
	}

	async entered(phase: ReceivePhase, oid: string): Promise<string[]> {
		const gate = this.path(phase, oid);
		const deadline = Date.now() + COMMAND_TIMEOUT;
		while (Date.now() < deadline) {
			try {
				await access(join(gate, "entered.json"));
				return JSON.parse(await Bun.file(join(gate, "entered.json")).text()) as string[];
			} catch {
				await Bun.sleep(10);
			}
		}
		throw new Error(`gate was not entered: ${this.label} ${phase} ${oid}`);
	}

	async release(phase: ReceivePhase, oid: string): Promise<void> {
		await writeFile(join(this.path(phase, oid), "release"), "");
	}

	async releaseAll(): Promise<void> {
		await Promise.all([...this.armed].map(async (gate) => writeFile(join(gate, "release"), "").catch(() => undefined)));
	}
}
