/**
 * Robust JSON extraction from LLM responses.
 *
 * Handles the full set of quirks observed from local models (Ollama / llama3):
 *   • Markdown code fences        ```json … ```
 *   • Leading / trailing prose outside the JSON value
 *   • Extra closing braces/brackets after the object  e.g. …]}}
 *   • Trailing commas before ] or }                   e.g. {"a":1,}
 *   • JS single-line comments                         // …
 *   • JS block comments                               /* … *\/
 *   • The JS keyword `undefined` as a value           → replaced with null
 *   • Truncated output (missing closing ] / })
 *   • Windows-style line endings (\r\n)
 */

// ── Boundary finders (depth-aware) ────────────────────────────────────────────

/**
 * Find the index of the closing character that *matches* the opener at
 * `openPos`. Tracks string literals and escaped characters so braces/brackets
 * inside strings don't affect depth. Returns -1 if not found.
 *
 * opener / closer: '{' / '}' or '[' / ']'
 */
function findMatchingClose(
    s: string,
    openPos: number,
    opener: string,
    closer: string
): number {
    let depth = 0;
    let inString = false;

    for (let i = openPos; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            if (ch === "\\") { i++; continue; } // skip escaped character
            if (ch === '"')  inString = false;
            continue;
        }

        if (ch === '"')    { inString = true; continue; }
        if (ch === opener) { depth++;  continue; }
        if (ch === closer) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1; // not found → truncated
}

// ── Repair pipeline ───────────────────────────────────────────────────────────

function stripCodeFences(s: string): string {
    return s
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
}

/**
 * Progressively repair a malformed LLM JSON string so that JSON.parse
 * has a reasonable chance of succeeding.
 */
function repair(s: string): string {
    // 1. Normalise line endings
    s = s.replace(/\r\n?/g, "\n");

    // 2. Replace the JS `undefined` keyword with JSON null
    s = s.replace(/:\s*undefined\b/g, ": null");

    // 3. Remove JS single-line comments
    s = s.replace(/\/\/[^\n]*/g, "");

    // 4. Remove JS block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");

    // 5. Remove trailing commas before } or ]
    s = s.replace(/,(\s*[\]}])/g, "$1");

    // 6. Close unclosed containers caused by truncated output
    s = closeUnclosed(s.trimEnd());

    return s;
}

/**
 * Append whatever closing brackets / braces are missing at the end of a
 * truncated JSON string by walking a nesting stack.
 */
function closeUnclosed(s: string): string {
    const stack: string[] = [];
    let inString = false;

    for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            if (ch === "\\") { i++; continue; }
            if (ch === '"')  inString = false;
            continue;
        }

        if (ch === '"') { inString = true;  continue; }
        if (ch === "{") { stack.push("}"); continue; }
        if (ch === "[") { stack.push("]"); continue; }
        if (ch === "}" || ch === "]") {
            if (stack.length > 0) stack.pop();
        }
    }

    // Close any still-open string first, then containers in reverse
    let suffix = inString ? '"' : "";
    while (stack.length > 0) suffix += stack.pop();
    return s + suffix;
}

/**
 * Try JSON.parse, then retry once after running the full repair pipeline.
 * Re-throws the original error if both attempts fail.
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
 *
 * Uses depth-aware bracket matching so extra trailing `}}` or `]}`
 * produced by the model are discarded before parsing.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("{");
    if (start === -1) {
        // No object found at all — try to parse the whole thing (will likely fail
        // with a useful error message)
        return parseWithRepairs(s) as Record<string, unknown>;
    }

    const end = findMatchingClose(s, start, "{", "}");

    if (end !== -1) {
        // Happy path: well-formed object (possibly with trailing junk after end)
        s = s.slice(start, end + 1);
    } else {
        // Truncated: take from opening brace to end of string and let
        // repair() / closeUnclosed() add the missing closer(s)
        s = s.slice(start);
    }

    return parseWithRepairs(s) as Record<string, unknown>;
}

/**
 * Extract and parse a JSON array `[…]` from raw LLM output.
 *
 * Uses depth-aware bracket matching so extra trailing characters are
 * discarded before parsing.
 */
export function extractJsonArray(raw: string): unknown[] {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("[");
    if (start === -1) {
        return parseWithRepairs(s) as unknown[];
    }

    const end = findMatchingClose(s, start, "[", "]");

    if (end !== -1) {
        s = s.slice(start, end + 1);
    } else {
        s = s.slice(start);
    }

    return parseWithRepairs(s) as unknown[];
}