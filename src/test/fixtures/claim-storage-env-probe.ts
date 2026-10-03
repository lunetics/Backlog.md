/**
 * Test-only child process for the claim storage isolation tests: runs initialize, open, read and
 * write under the environment chosen by the parent test and prints one JSON report line.
 */
import {
	type ClaimChange,
	type ClaimStorageOptions,
	initializeClaimStorage,
	openClaimStore,
} from "../../claims/storage/index.ts";

export type ProbeInput = ClaimStorageOptions & { ticket: string; change: ClaimChange };
export type ProbeReport = { initialized: string; opened: string; read?: string; written?: string; root?: string };

async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("expected the probe input as a JSON argument");
	const { ticket, change, ...options } = JSON.parse(raw) as ProbeInput;
	const initialized = await initializeClaimStorage(options);
	const opened = await openClaimStore(options);
	const report: ProbeReport = { initialized: initialized.kind, opened: opened.kind };
	if (opened.kind === "open") {
		const base = await opened.store.read(ticket);
		report.read = base.kind;
		if (base.kind === "absent" || base.kind === "present") {
			const written = await opened.store.write(base, change);
			report.written = written.kind;
			if (written.kind === "applied") report.root = written.root;
		}
	}
	process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
