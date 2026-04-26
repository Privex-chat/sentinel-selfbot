/**
 * Robust JSON extraction from LLM responses.
 * Handles markdown code fences, trailing prose, and common LLM formatting artifacts.
 */

function stripCodeFences(s: string): string {
    return s
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
}

/**
 * Extract and parse a JSON object `{...}` from raw LLM output.
 * Trims leading/trailing prose and code fences.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("{");
    const end   = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
        s = s.slice(start, end + 1);
    }

    return JSON.parse(s) as Record<string, unknown>;
}

/**
 * Extract and parse a JSON array `[...]` from raw LLM output.
 * Trims leading/trailing prose and code fences.
 */
export function extractJsonArray(raw: string): unknown[] {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("[");
    const end   = s.lastIndexOf("]");
    if (start !== -1 && end > start) {
        s = s.slice(start, end + 1);
    }

    return JSON.parse(s) as unknown[];
}
