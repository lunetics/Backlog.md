import { canonicalTaskId, isValidTaskId } from "../utils/task-id.ts";

/** A canonical ticket ID: the task-ID rule, already in its canonical form (no re-normalization here). */
export function validTicket(value: unknown): value is string {
	return typeof value === "string" && isValidTaskId(value) && canonicalTaskId(value) === value;
}

/** A safe, non-negative integer (never a float, never `-0` semantics beyond what `>= 0` already covers). */
export function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A safe integer strictly greater than zero. */
export function positive(value: unknown): value is number {
	return nonnegative(value) && value > 0;
}
