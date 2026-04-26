/**
 * Robust JSON extraction from LLM responses.
 *
 * Handles the full set of quirks observed from local models (Ollama / llama3):
 *   • Markdown code fences  (```json … ```)
 *   • Leading / trailing prose outside the JSON object or array
 *   • Trailing commas before ] or }          e.g. {"a":1,}
 *   • JS-style single-line comments          // …
 *   • JS-style block comments               /* … *\/
 *   • The literal keyword `undefined`        → replaced with null
 *   • Truncated output (missing closing      ] / })
 *   • Windows-style line endings (\r\n)
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

function stripCodeFences(s: string): string {
    return s
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
}

/**
 * Apply a series of progressively aggressive repairs to coerce a malformed
 * LLM JSON string into something JSON.parse can accept.
 */
function repair(s: string): string {
    // 1. Normalise line endings
    s = s.replace(/\r\n?/g, "\n");

    // 2. Replace the JS `undefined` keyword with JSON null.
    //    Matches: :undefined and : undefined (with any whitespace)
    s = s.replace(/:\s*undefined\b/g, ": null");

    // 3. Remove JS single-line comments
    s = s.replace(/\/\/[^\n]*/g, "");

    // 4. Remove JS block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");

    // 5. Remove trailing commas before } or ]
    s = s.replace(/,(\s*[\]}])/g, "$1");

    // 6. Close any unclosed arrays / objects caused by truncated output.
    //    Walk the string counting openers vs closers and append what's missing.
    s = closeUnclosed(s.trimEnd());

    return s;
}

/**
 * Append missing closing brackets / braces to a truncated JSON string.
 *
 * Strategy: scan character-by-character tracking the nesting stack and
 * whether we are inside a string (including escaped quotes). Whatever
 * openers remain open at the end get closed in reverse order.
 */
function closeUnclosed(s: string): string {
    const stack: string[] = [];
    let inString = false;
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        if (inString) {
            if (ch === "\\") {
                i += 2; // skip escaped character
                continue;
            }
            if (ch === '"') inString = false;
        } else {
            if (ch === '"') {
                inString = true;
            } else if (ch === "{") {
                stack.push("}");
            } else if (ch === "[") {
                stack.push("]");
            } else if (ch === "}" || ch === "]") {
                if (stack.length > 0) stack.pop();
            }
        }
        i++;
    }

    // If we ended inside a string, close it first
    let suffix = inString ? '"' : "";

    // Then close any open containers in reverse order
    while (stack.length > 0) {
        suffix += stack.pop();
    }

    return s + suffix;
}

/**
 * Try JSON.parse, then retry once after running the full repair pipeline.
 * Throws the original parse error if both attempts fail.
 */
function parseWithRepairs(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch (firstErr) {
        try {
            return JSON.parse(repair(s));
        } catch {
            throw firstErr;
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract and parse a JSON object `{…}` from raw LLM output.
 * Strips leading/trailing prose and code fences, then applies progressive
 * repairs before parsing.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("{");
    const end   = s.lastIndexOf("}");

    if (start !== -1 && end > start) {
        // Both braces present — slice between them
        s = s.slice(start, end + 1);
    } else if (start !== -1) {
        // Truncated: opening brace found but no closing brace.
        // Take from opening brace to end and let closeUnclosed() add the rest.
        s = s.slice(start);
    }

    return parseWithRepairs(s) as Record<string, unknown>;
}

/**
 * Extract and parse a JSON array `[…]` from raw LLM output.
 * Strips leading/trailing prose and code fences, then applies progressive
 * repairs before parsing.
 */
export function extractJsonArray(raw: string): unknown[] {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("[");
    const end   = s.lastIndexOf("]");

    if (start !== -1 && end > start) {
        s = s.slice(start, end + 1);
    } else if (start !== -1) {
        s = s.slice(start);
    }

    return parseWithRepairs(s) as unknown[];
}