export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Serialize JSON recursively with ECMAScript code-unit key ordering. */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => {
				const entry = value[key];
				if (entry === undefined) throw new Error("value is not JSON encodable");
				return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
			})
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("value is not JSON encodable");
	return encoded;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJson(value: unknown, ancestors = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	) {
		return false;
	}
	ancestors.add(value);
	try {
		for (const entry of Array.isArray(value) ? value : Object.values(value)) {
			if (!isJson(entry, ancestors)) return false;
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}

export function isJsonObject(value: unknown): value is JsonObject {
	try {
		return isObject(value) && isJson(value);
	} catch {
		return false;
	}
}
