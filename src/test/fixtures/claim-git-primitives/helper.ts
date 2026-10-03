import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const phase = process.argv[2];
	const fixturePath = process.argv[3];
	if ((phase !== "pre" && phase !== "post") || !fixturePath) {
		throw new Error("expected receive phase and fixture path");
	}

	const commands = (await Bun.stdin.text()).trim().split("\n").filter(Boolean);
	for (const command of commands) {
		const fields = command.split(/\s+/);
		const next = fields[1];
		if (!next) continue;

		const gate = join(fixturePath, "gates", `${phase}-${next}`);
		if (!(await exists(join(gate, "armed")))) continue;

		await writeFile(join(gate, "entered.json"), JSON.stringify(commands));
		const deadline = Date.now() + 5_000;
		while (!(await exists(join(gate, "release")))) {
			if (Date.now() >= deadline) {
				throw new Error(`test gate timed out: ${phase} ${next}`);
			}
			await Bun.sleep(10);
		}
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
