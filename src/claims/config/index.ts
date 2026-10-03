/** Internal claim configuration, preflight and initialization; a ready verdict reserves nothing. */
import { isAbsolute } from "node:path";
import { isGitRepository } from "../../git/operations.ts";
import { type ClaimContext, claimContextIO, loadClaimContext } from "../context/index.ts";
import { isObject } from "../json.ts";
import {
	type ClaimStorageDescriptor,
	type ClaimStorageFormat,
	type ClaimStore,
	claimEndpointError,
	initializeClaimStorage,
	openClaimStore,
	probeClaimRefs,
} from "../storage/index.ts";

/** Confirmed start values for an explicitly written template and for messages; never a fallback. */
export const CLAIM_START_VALUES = {
	leaseTtlMs: 300_000,
	reclaimGraceMs: 600_000,
	attemptTimeoutMs: 10_000,
	attempts: 3,
	operationBudgetMs: 30_000,
} as const;

type ClaimLifetimeSettings =
	| { mode: "lease"; leaseTtlMs: number; reclaimGraceMs: number }
	| { mode: "hard"; reclaimGraceMs: number }
	| { mode: "none" };

/** The time-box action of a transfer under a hard end; absent means require-explicit. */
type ClaimTransferTimeBoxPolicy = "require-explicit" | "preserve" | "restart";

/** The dependency gate of a direct acquire; absent means strict. */
type ClaimAcquireDependencyPolicy = "strict" | "permissive";

export type ClaimSettings = {
	enabled: boolean;
	endpoint: string;
	storageFormat: ClaimStorageFormat;
	lifetime: ClaimLifetimeSettings;
	attemptTimeoutMs: number;
	attempts: number;
	operationBudgetMs: number;
	/** Set only when the block names `clock_uncertainty_ms`; the resolver never supplies a value. */
	clockUncertaintyMs?: number;
	/** Set only when the block names `retry_pause_base_ms`. */
	retryPauseBaseMs?: number;
	/** Set only when the block names `retry_pause_max_ms`. */
	retryPauseMaxMs?: number;
	/**
	 * Set only when the block names `transfer_time_box`; the resolver never supplies a
	 * value and the surface never requires the key, because its absence means require-explicit.
	 */
	transferTimeBox?: ClaimTransferTimeBoxPolicy;
	/**
	 * Set only when the block names `acquire_dependency_policy`; the resolver never
	 * supplies a value. The surface reads an absent key as `strict`, the one documented exception to "no defaults".
	 */
	acquireDependencyPolicy?: ClaimAcquireDependencyPolicy;
	/**
	 * The authority IDs allowed to run every operator command that consults the
	 * list, today `emergency-release` (and a retry of its record) and `install-epoch`; set only when the block names
	 * `recovery_authorities`. An absent key authorises nobody.
	 */
	recoveryAuthorities?: string[];
};

export type ClaimConfigProblemCode =
	| "missing"
	| "duplicate"
	| "unknown-key"
	| "unreadable"
	| "wrong-type"
	| "out-of-range"
	| "unsupported-value"
	| "unsupported-endpoint"
	| "not-applicable";

export type ClaimConfigProblem = { key: string; problem: ClaimConfigProblemCode; message: string };

export type ClaimSettingsResult =
	| { kind: "not-configured" }
	| { kind: "configured"; settings: ClaimSettings }
	| { kind: "config-invalid"; reason: string; problems: ClaimConfigProblem[] };

export type ClaimPreflightPurpose = "observe" | "maintain" | "acquire";

export type ClaimPreflightOptions = {
	claimsYaml: string | undefined;
	repository: string;
	purpose: ClaimPreflightPurpose;
	contextDirectory?: string;
	contextIO?: typeof claimContextIO;
};

type Failure<K extends string> = { kind: K; reason: string };

export type ClaimPreflightResult =
	| {
			kind: "ready";
			scope: "preflight-only";
			settings: ClaimSettings;
			descriptor: ClaimStorageDescriptor;
			store: ClaimStore;
			context: ClaimContext | null;
	  }
	| { kind: "config-invalid"; reason: string; problems: ClaimConfigProblem[] }
	| { kind: "format-mismatch"; reason: string; configured: ClaimStorageFormat; descriptor: ClaimStorageDescriptor }
	| Failure<
			| "not-configured"
			| "claims-disabled"
			| "context-invalid"
			| "context-corrupt"
			| "context-unavailable"
			| "descriptor-missing"
			| "schema-unsupported"
			| "corrupt"
			| "unreachable"
			| "invalid"
			| "unknown"
	  >;

type ClaimCoordinationInitOptions = { claimsYaml: string | undefined; repository: string };

export type ClaimCoordinationInitResult =
	| { kind: "created" | "exists"; descriptor: ClaimStorageDescriptor }
	| { kind: "conflict"; reason: string; configured: ClaimStorageFormat; descriptor: ClaimStorageDescriptor }
	| { kind: "config-invalid"; reason: string; problems: ClaimConfigProblem[] }
	| Failure<
			| "not-configured"
			| "not-empty"
			| "schema-unsupported"
			| "corrupt"
			| "unreachable"
			| "invalid"
			| "not-sent"
			| "rejected"
			| "unknown"
	  >;

// ---------------------------------------------------------------------------------------------------------------
// Fixed reasons: never Git stderr, never a configured value, always the same text
// for the same kind so a caller cannot fingerprint a configuration through its wording.
// ---------------------------------------------------------------------------------------------------------------

/** Single fixed reason for every config-invalid result; the `problems` list carries the specific detail. */
const CONFIG_INVALID_REASON = "the claims configuration is invalid; see problems for the affected keys";

const REASON = {
	invalid: "the claim coordination options are invalid",
	notConfigured: "claims are not configured for this project",
	claimsDisabled: "claims are disabled in the project configuration; existing claims are not released",
	contextInvalid: "the private claim context could not be found",
	contextCorrupt: "the private claim context is corrupt",
	contextUnavailable: "the private claim context is unavailable",
	descriptorMissing: "the claim coordination area is not initialized",
	formatMismatch: "the claim coordination area uses a different storage format",
	schemaUnsupported: "the claim coordination area needs a newer version of Backlog.md",
	corrupt: "the claim coordination descriptor is unreadable",
	unreachable: "the claim coordination endpoint could not be reached",
	unknown: "the claim storage outcome is unknown",
	conflict: "the claim coordination area was already initialized with a different storage format",
	notEmpty: "the claim coordination area already has ticket references without a descriptor",
	notSent: "the claim coordination request could not be sent",
	rejected: "the claim coordination request was rejected",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Resolver: pure, no defaults, complete schema-ordered problems.
// ---------------------------------------------------------------------------------------------------------------

const SCHEMA_KEYS = [
	"enabled",
	"endpoint",
	"storage_format",
	"lifetime_mode",
	"lease_ttl_ms",
	"reclaim_grace_ms",
	"attempt_timeout_ms",
	"attempts",
	"operation_budget_ms",
	"clock_uncertainty_ms",
	"retry_pause_base_ms",
	"retry_pause_max_ms",
	// Appended last, so the order of every existing problem list stays unchanged.
	"transfer_time_box",
	// Appended after the `transfer_time_box` key for the same reason.
	"acquire_dependency_policy",
	// Appended last, so the order of every existing problem list stays unchanged.
	"recovery_authorities",
] as const;
type SchemaKey = (typeof SCHEMA_KEYS)[number];
const SCHEMA_KEY_SET: ReadonlySet<string> = new Set(SCHEMA_KEYS);

type NumericKey = "lease_ttl_ms" | "reclaim_grace_ms" | "attempt_timeout_ms" | "attempts" | "operation_budget_ms";
/** Optional in the resolver, validated fully when present, never defaulted. */
type SurfaceKey = "clock_uncertainty_ms" | "retry_pause_base_ms" | "retry_pause_max_ms";
const SURFACE_KEYS: ReadonlySet<string> = new Set<SurfaceKey>([
	"clock_uncertainty_ms",
	"retry_pause_base_ms",
	"retry_pause_max_ms",
]);
const TRANSFER_TIME_BOX_POLICIES: readonly ClaimTransferTimeBoxPolicy[] = ["require-explicit", "preserve", "restart"];
const ACQUIRE_DEPENDENCY_POLICIES: readonly ClaimAcquireDependencyPolicy[] = ["strict", "permissive"];
/** Optional keys whose value is one string of a closed list, valid in every lifetime mode and never required here. */
const POLICY_KEYS: Readonly<Record<string, readonly string[]>> = {
	transfer_time_box: TRANSFER_TIME_BOX_POLICIES,
	acquire_dependency_policy: ACQUIRE_DEPENDENCY_POLICIES,
};
/** The form of an authority ID, `ta1-` plus a lowercase SHA-256 hex digest; never a binding. */
const AUTHORITY_ID = /^ta1-[0-9a-f]{64}$/;
const MAX_TIMER = 2_147_483_647;
const SURFACE_RULE = { min: 0, max: MAX_TIMER };
const NUMERIC_RULES: Record<NumericKey, { min: number; max?: number }> = {
	lease_ttl_ms: { min: 1 },
	reclaim_grace_ms: { min: 0 },
	attempt_timeout_ms: { min: 1, max: MAX_TIMER },
	attempts: { min: 1 },
	operation_budget_ms: { min: 1, max: MAX_TIMER },
};

/** The confirmed start value named in a `missing` message; never substituted as a fallback. */
const START_VALUE_TEXT: Partial<Record<SchemaKey, string>> = {
	lease_ttl_ms: "300000 (5 minutes)",
	reclaim_grace_ms: "600000 (10 minutes)",
	attempt_timeout_ms: "10000 (10 seconds)",
	attempts: "3",
	operation_budget_ms: "30000 (30 seconds)",
	retry_pause_base_ms: "1000 (1 second)",
	retry_pause_max_ms: "5000 (5 seconds)",
};

/** A generic column-0-or-deeper mapping key line, mirroring operations.ts CONFIG_KEY_LINE_PATTERN. */
const KEY_LINE_PATTERN = /^\s*(?!-\s)[^\s#][^:]*:/;
const CLAIMS_HEADER_PATTERN = /^claims\s*:/;

function messageFor(fullKey: string, key: string, code: ClaimConfigProblemCode): string {
	switch (code) {
		case "missing": {
			const start = START_VALUE_TEXT[key as SchemaKey];
			const startNote = start ? ` The confirmed start value is ${start}.` : "";
			return `${fullKey} is missing. Claims use no defaults; set it explicitly.${startNote}`;
		}
		case "duplicate":
			return key === "claims"
				? `${fullKey} appears more than once in the project configuration; remove the extra claims: block.`
				: `${fullKey} is set more than once in the claims block; remove the duplicate.`;
		case "unknown-key":
			return `${fullKey} is not a recognized claims setting; remove it or fix the typo.`;
		case "unreadable":
			return `${fullKey} is not valid YAML.`;
		case "wrong-type":
			return `${fullKey} has the wrong type.`;
		case "out-of-range":
			return `${fullKey} is outside its allowed range.`;
		case "unsupported-value":
			return `${fullKey} has an unsupported value.`;
		case "unsupported-endpoint":
			return (
				`${fullKey} must be an explicit git://, ssh://, http://, https:// or file:// URL without credentials; ` +
				"remote names, scp-style addresses and user:password@ forms are not supported."
			);
		case "not-applicable":
			return `${fullKey} does not apply to the configured lifetime_mode; remove it or change the mode.`;
		default:
			return `${fullKey} is invalid.`;
	}
}

function makeProblem(key: string, code: ClaimConfigProblemCode): ClaimConfigProblem {
	const fullKey = key === "claims" ? "claims" : `claims.${key}`;
	return { key: fullKey, problem: code, message: messageFor(fullKey, key, code) };
}

/**
 * Top-level sub-keys of one already-isolated claims block, by first-occurrence document order and occurrence
 * count. Comments and blank lines are skipped; a line belongs to the mapping's own level only when its
 * indentation matches the first key line found, so a nested continuation never counts as a sibling key. This is
 * the resolver's own duplicate detector: whatever Bun.YAML does with a repeated key
 * is not relied upon.
 */
function scanTopLevelKeys(bodyLines: readonly string[]): { order: string[]; counts: Map<string, number> } {
	const order: string[] = [];
	const counts = new Map<string, number>();
	let baseIndent: number | undefined;
	for (const line of bodyLines) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (!KEY_LINE_PATTERN.test(line)) continue;
		const indent = line.length - line.trimStart().length;
		if (baseIndent === undefined) baseIndent = indent;
		if (indent !== baseIndent) continue;
		const colonIndex = trimmed.indexOf(":");
		const key = trimmed.slice(0, colonIndex).trim();
		if (!key) continue;
		if (!counts.has(key)) order.push(key);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return { order, counts };
}

/** Strict safe-integer check; a float, a non-numeric type or an unsafe magnitude are distinguished. */
function numericProblem(value: unknown, rule: { min: number; max?: number }): ClaimConfigProblemCode | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return "wrong-type";
	if (!Number.isSafeInteger(value)) return "out-of-range";
	if (value < rule.min) return "out-of-range";
	if (rule.max !== undefined && value > rule.max) return "out-of-range";
	return undefined;
}

/**
 * Resolves the raw `claims:` block into settings or a complete list of problems. Pure: no IO, no clock, no
 * defaults ever substituted. `claimsYaml` is the byte-identical block `parseConfig`
 * captures, header included; `undefined` means the project has no block at all.
 */
export function resolveClaimSettings(claimsYaml: string | undefined): ClaimSettingsResult {
	if (claimsYaml === undefined) return { kind: "not-configured" };

	const lines = claimsYaml.split(/\r?\n/);
	const headerIndices: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (CLAIMS_HEADER_PATTERN.test(lines[index] ?? "")) headerIndices.push(index);
	}
	if (headerIndices.length > 1) {
		return { kind: "config-invalid", reason: CONFIG_INVALID_REASON, problems: [makeProblem("claims", "duplicate")] };
	}
	const headerIndex = headerIndices[0] ?? 0;
	const documentText = lines.slice(headerIndex).join("\n");

	let parsedDocument: unknown;
	try {
		parsedDocument = Bun.YAML.parse(documentText);
	} catch {
		return { kind: "config-invalid", reason: CONFIG_INVALID_REASON, problems: [makeProblem("claims", "unreadable")] };
	}

	const claimsValue = isObject(parsedDocument) ? parsedDocument.claims : undefined;
	let values: Record<string, unknown>;
	if (claimsValue === null || claimsValue === undefined) {
		values = {};
	} else if (isObject(claimsValue)) {
		values = claimsValue;
	} else {
		return { kind: "config-invalid", reason: CONFIG_INVALID_REASON, problems: [makeProblem("claims", "wrong-type")] };
	}

	const { order, counts } = scanTopLevelKeys(lines.slice(headerIndex + 1));
	const problems: ClaimConfigProblem[] = [];
	let resolvedMode: "lease" | "hard" | "none" | undefined;

	for (const key of SCHEMA_KEYS) {
		const count = counts.get(key) ?? 0;
		if (count > 1) {
			problems.push(makeProblem(key, "duplicate"));
			continue;
		}
		const present = count === 1;
		const rawValue = present ? values[key] : undefined;

		if (key === "lifetime_mode") {
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
			} else if (typeof rawValue !== "string") {
				problems.push(makeProblem(key, "wrong-type"));
			} else if (rawValue !== "lease" && rawValue !== "hard" && rawValue !== "none") {
				problems.push(makeProblem(key, "unsupported-value"));
			} else {
				resolvedMode = rawValue;
			}
			continue;
		}

		if (key === "lease_ttl_ms" || key === "reclaim_grace_ms") {
			// An unresolved lifetime_mode makes this key neither required nor forbidden.
			if (resolvedMode === undefined) continue;
			const applicable = key === "lease_ttl_ms" ? resolvedMode === "lease" : resolvedMode !== "none";
			if (!applicable) {
				if (present) problems.push(makeProblem(key, "not-applicable"));
				continue;
			}
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
				continue;
			}
			const numeric = numericProblem(rawValue, NUMERIC_RULES[key]);
			if (numeric) problems.push(makeProblem(key, numeric));
			continue;
		}

		if (SURFACE_KEYS.has(key)) {
			// An absent key stays absent; a named key without a value is missing, never defaulted.
			if (!present) continue;
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
				continue;
			}
			const numeric = numericProblem(rawValue, SURFACE_RULE);
			if (numeric) problems.push(makeProblem(key, numeric));
			continue;
		}

		const policies = POLICY_KEYS[key];
		if (policies !== undefined) {
			// Valid in every lifetime mode; an absent key stays absent, a named one is
			// checked fully, and any other string (case included) is unsupported.
			if (!present) continue;
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
			} else if (typeof rawValue !== "string") {
				problems.push(makeProblem(key, "wrong-type"));
			} else if (!policies.includes(rawValue)) {
				problems.push(makeProblem(key, "unsupported-value"));
			}
			continue;
		}

		if (key === "enabled") {
			if (rawValue === null || rawValue === undefined) problems.push(makeProblem(key, "missing"));
			else if (typeof rawValue !== "boolean") problems.push(makeProblem(key, "wrong-type"));
			continue;
		}

		if (key === "endpoint") {
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
			} else if (typeof rawValue !== "string") {
				problems.push(makeProblem(key, "wrong-type"));
			} else if (claimEndpointError(rawValue)) {
				problems.push(makeProblem(key, "unsupported-endpoint"));
			}
			continue;
		}

		if (key === "storage_format") {
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
			} else if (typeof rawValue !== "string") {
				problems.push(makeProblem(key, "wrong-type"));
			} else if (rawValue !== "blob" && rawValue !== "tree" && rawValue !== "commit-chain") {
				problems.push(makeProblem(key, "unsupported-value"));
			}
			continue;
		}

		if (key === "recovery_authorities") {
			// Optional in every lifetime mode; a named key is a list of authority IDs, and one
			// malformed entry is one problem for the whole key, never a value in its message.
			if (!present) continue;
			if (rawValue === null || rawValue === undefined) {
				problems.push(makeProblem(key, "missing"));
			} else if (!Array.isArray(rawValue)) {
				problems.push(makeProblem(key, "wrong-type"));
			} else if (!rawValue.every((entry) => typeof entry === "string" && AUTHORITY_ID.test(entry))) {
				problems.push(makeProblem(key, "unsupported-value"));
			}
			continue;
		}

		// attempt_timeout_ms, attempts, operation_budget_ms: always required, never mode-dependent.
		if (rawValue === null || rawValue === undefined) {
			problems.push(makeProblem(key, "missing"));
			continue;
		}
		const numeric = numericProblem(rawValue, NUMERIC_RULES[key as NumericKey]);
		if (numeric) problems.push(makeProblem(key, numeric));
	}

	// The pause maximum may not undercut the base; reported against the maximum, only when both are valid.
	const pauseBase = values.retry_pause_base_ms;
	const pauseMax = values.retry_pause_max_ms;
	if (
		counts.get("retry_pause_base_ms") === 1 &&
		counts.get("retry_pause_max_ms") === 1 &&
		numericProblem(pauseBase, SURFACE_RULE) === undefined &&
		numericProblem(pauseMax, SURFACE_RULE) === undefined &&
		(pauseMax as number) < (pauseBase as number)
	) {
		problems.push(makeProblem("retry_pause_max_ms", "out-of-range"));
	}

	for (const key of order) {
		if (SCHEMA_KEY_SET.has(key)) continue;
		const count = counts.get(key) ?? 0;
		problems.push(makeProblem(key, count > 1 ? "duplicate" : "unknown-key"));
	}

	if (problems.length > 0) return { kind: "config-invalid", reason: CONFIG_INVALID_REASON, problems };

	const lifetime: ClaimLifetimeSettings =
		resolvedMode === "lease"
			? { mode: "lease", leaseTtlMs: values.lease_ttl_ms as number, reclaimGraceMs: values.reclaim_grace_ms as number }
			: resolvedMode === "hard"
				? { mode: "hard", reclaimGraceMs: values.reclaim_grace_ms as number }
				: { mode: "none" };

	const settings: ClaimSettings = {
		enabled: values.enabled as boolean,
		endpoint: values.endpoint as string,
		storageFormat: values.storage_format as ClaimStorageFormat,
		lifetime,
		attemptTimeoutMs: values.attempt_timeout_ms as number,
		attempts: values.attempts as number,
		operationBudgetMs: values.operation_budget_ms as number,
	};
	// Only keys the block names appear; the surface requires them per command.
	if (counts.get("clock_uncertainty_ms") === 1) settings.clockUncertaintyMs = values.clock_uncertainty_ms as number;
	if (counts.get("retry_pause_base_ms") === 1) settings.retryPauseBaseMs = values.retry_pause_base_ms as number;
	if (counts.get("retry_pause_max_ms") === 1) settings.retryPauseMaxMs = values.retry_pause_max_ms as number;
	// Named only; an absent key is require-explicit by definition and is never written in here.
	if (counts.get("transfer_time_box") === 1) {
		settings.transferTimeBox = values.transfer_time_box as ClaimTransferTimeBoxPolicy;
	}
	// Named only; the surface reads an absent key as strict and the resolver never writes that in.
	if (counts.get("acquire_dependency_policy") === 1) {
		settings.acquireDependencyPolicy = values.acquire_dependency_policy as ClaimAcquireDependencyPolicy;
	}
	// Named only, as a copy; an absent key authorises nobody and is never written in here.
	if (counts.get("recovery_authorities") === 1) {
		settings.recoveryAuthorities = [...(values.recovery_authorities as string[])];
	}
	return { kind: "configured", settings };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared option shape checks: pure, synchronous, no IO.
// ---------------------------------------------------------------------------------------------------------------

function isPlainAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

function isClaimContextIOShape(io: unknown): io is typeof claimContextIO {
	if (!isObject(io)) return false;
	return (["open", "lstat", "mkdir", "link", "unlink"] as const).every((name) => typeof io[name] === "function");
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight: read-only, one attempt, reserves nothing.
// ---------------------------------------------------------------------------------------------------------------

type CapturedPreflightOptions = {
	claimsYaml: string | undefined;
	repository: string;
	purpose: ClaimPreflightPurpose;
	contextDirectory: string | undefined;
	contextIO: typeof claimContextIO;
};

export async function preflightClaimStorage(options: ClaimPreflightOptions): Promise<ClaimPreflightResult> {
	const invalid = { kind: "invalid", reason: REASON.invalid } as const;
	let captured: CapturedPreflightOptions;
	try {
		if (!isObject(options)) return invalid;
		const { claimsYaml, repository, purpose, contextDirectory, contextIO } = options as ClaimPreflightOptions;
		if (purpose !== "observe" && purpose !== "maintain" && purpose !== "acquire") return invalid;
		if (!isPlainAbsolutePath(repository)) return invalid;
		if (contextDirectory !== undefined && !isPlainAbsolutePath(contextDirectory)) return invalid;
		const source = contextIO === undefined ? claimContextIO : contextIO;
		// Copy the seam entries so that later mutation of the caller's object cannot redirect the context load.
		const io = {
			open: source.open,
			lstat: source.lstat,
			mkdir: source.mkdir,
			link: source.link,
			unlink: source.unlink,
		};
		if (Object.values(io).some((entry) => typeof entry !== "function")) return invalid;
		if (!isClaimContextIOShape(io)) return invalid;
		captured = { claimsYaml, repository, purpose, contextDirectory, contextIO: io };
	} catch {
		return invalid;
	}

	const resolved = resolveClaimSettings(captured.claimsYaml);
	if (resolved.kind === "not-configured") return { kind: "not-configured", reason: REASON.notConfigured };
	if (resolved.kind === "config-invalid") {
		return { kind: "config-invalid", reason: resolved.reason, problems: resolved.problems };
	}
	const settings = resolved.settings;

	if (captured.purpose === "acquire" && !settings.enabled) {
		return { kind: "claims-disabled", reason: REASON.claimsDisabled };
	}
	if ((captured.purpose === "maintain" || captured.purpose === "acquire") && captured.contextDirectory === undefined) {
		return invalid;
	}

	try {
		if (!(await isGitRepository(captured.repository))) return invalid;

		let context: ClaimContext | null = null;
		if (captured.contextDirectory !== undefined) {
			const loaded = await loadClaimContext({ directory: captured.contextDirectory, io: captured.contextIO });
			if (loaded.kind !== "loaded") {
				if (loaded.kind === "invalid") return { kind: "context-invalid", reason: REASON.contextInvalid };
				if (loaded.kind === "corrupt") return { kind: "context-corrupt", reason: REASON.contextCorrupt };
				return { kind: "context-unavailable", reason: REASON.contextUnavailable };
			}
			context = loaded.context;
		}

		const opened = await openClaimStore({
			repository: captured.repository,
			remote: settings.endpoint,
			format: settings.storageFormat,
			timeoutMs: settings.attemptTimeoutMs,
		});
		switch (opened.kind) {
			case "open":
				return {
					kind: "ready",
					scope: "preflight-only",
					settings,
					descriptor: opened.descriptor,
					store: opened.store,
					context,
				};
			case "descriptor-missing":
				return { kind: "descriptor-missing", reason: REASON.descriptorMissing };
			case "format-mismatch":
				return {
					kind: "format-mismatch",
					reason: REASON.formatMismatch,
					configured: settings.storageFormat,
					descriptor: opened.descriptor,
				};
			case "schema-unsupported":
				return { kind: "schema-unsupported", reason: REASON.schemaUnsupported };
			case "corrupt":
				return { kind: "corrupt", reason: REASON.corrupt };
			case "unreachable":
				return { kind: "unreachable", reason: REASON.unreachable };
			default:
				return invalid;
		}
	} catch {
		return { kind: "unknown", reason: REASON.unknown };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Initialization: allowed while disabled, since it creates no claim.
// ---------------------------------------------------------------------------------------------------------------

export async function initializeClaimCoordination(
	options: ClaimCoordinationInitOptions,
): Promise<ClaimCoordinationInitResult> {
	const invalid = { kind: "invalid", reason: REASON.invalid } as const;
	let captured: { claimsYaml: string | undefined; repository: string };
	try {
		if (!isObject(options)) return invalid;
		const { claimsYaml, repository } = options as ClaimCoordinationInitOptions;
		if (!isPlainAbsolutePath(repository)) return invalid;
		captured = { claimsYaml, repository };
	} catch {
		return invalid;
	}

	const resolved = resolveClaimSettings(captured.claimsYaml);
	if (resolved.kind === "not-configured") return { kind: "not-configured", reason: REASON.notConfigured };
	if (resolved.kind === "config-invalid") {
		return { kind: "config-invalid", reason: resolved.reason, problems: resolved.problems };
	}
	const settings = resolved.settings;

	try {
		if (!(await isGitRepository(captured.repository))) return invalid;

		const storageOptions = {
			repository: captured.repository,
			remote: settings.endpoint,
			format: settings.storageFormat,
			timeoutMs: settings.attemptTimeoutMs,
		};

		// Pre-open so an unsupported schema is reported exactly, never folded into corrupt.
		const opened = await openClaimStore(storageOptions);
		switch (opened.kind) {
			case "open":
				return { kind: "exists", descriptor: opened.descriptor };
			case "format-mismatch":
				return {
					kind: "conflict",
					reason: REASON.conflict,
					configured: settings.storageFormat,
					descriptor: opened.descriptor,
				};
			case "schema-unsupported":
				return { kind: "schema-unsupported", reason: REASON.schemaUnsupported };
			case "corrupt":
				return { kind: "corrupt", reason: REASON.corrupt };
			case "unreachable":
				return { kind: "unreachable", reason: REASON.unreachable };
			case "invalid":
				return invalid;
			case "descriptor-missing":
				break;
			default:
				return invalid;
		}

		// Refuse to lay a descriptor over ticket refs that already exist without one; racy, read-only.
		const probe = await probeClaimRefs(storageOptions);
		if (probe.kind === "found") return { kind: "not-empty", reason: REASON.notEmpty };
		// A failed probe cannot establish emptiness; fail closed instead of laying a descriptor over unknown refs.
		if (probe.kind !== "absent") return { kind: "unknown", reason: REASON.unknown };

		const created = await initializeClaimStorage(storageOptions);
		switch (created.kind) {
			case "created":
				return { kind: "created", descriptor: created.descriptor };
			case "exists":
				return { kind: "exists", descriptor: created.descriptor };
			case "conflict":
				return {
					kind: "conflict",
					reason: REASON.conflict,
					configured: settings.storageFormat,
					descriptor: created.descriptor,
				};
			case "invalid":
				return invalid;
			case "unreachable":
				return { kind: "unreachable", reason: REASON.unreachable };
			case "corrupt":
				return { kind: "corrupt", reason: REASON.corrupt };
			case "not-sent":
				return { kind: "not-sent", reason: REASON.notSent };
			case "rejected":
				return { kind: "rejected", reason: REASON.rejected };
			default:
				// An unknown push outcome passes through unchanged; never reinterpreted as created or exists.
				return { kind: "unknown", reason: REASON.unknown };
		}
	} catch {
		return { kind: "unknown", reason: REASON.unknown };
	}
}
