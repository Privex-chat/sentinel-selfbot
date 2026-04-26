/**
 * Robust JSON extraction from LLM responses.
 *
 * Handles every quirk observed from local models (Ollama / llama3):
 *   • Markdown code fences          ```json … ```
 *   • Leading / trailing prose
 *   • Extra closing braces/brackets  …]}}  →  …]}
 *   • Wrong closer type              ["x."}}  →  ["x."]}
 *   • Missing closer (truncation)    {"a":1   →  {"a":1}
 *   • Trailing commas                {"a":1,} →  {"a":1}
 *   • JS single-line comments        // …
 *   • JS block comments              /* … *\/
 *   • JS `undefined` as a value      → null
 *   • Windows line endings           \r\n → \n
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripCodeFences(s: string): string {
    return s
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();
}

/**
 * Find the index of the closing bracket/brace that matches the opener at
 * `openPos`, tracking ALL bracket types (so `[` inside `{` is handled).
 *
 * Uses LENIENT popping: any closer pops the stack regardless of type.
 * This means `["text."}}` will return the position of the second `}` —
 * the resulting slice is then fixed by `repairBrackets`.
 *
 * Returns -1 when the opener is never closed (truncated output).
 */
function findMatchingClose(s: string, openPos: number): number {
    const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };
    const stack: string[] = [];
    let inString = false;

    for (let i = openPos; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            if (ch === "\\") { i++; continue; }   // skip escaped char
            if (ch === '"')  inString = false;
            continue;
        }

        if (ch === '"')                { inString = true; continue; }
        if (ch in OPEN_TO_CLOSE)      { stack.push(OPEN_TO_CLOSE[ch]); continue; }
        if (ch === "}" || ch === "]") {
            if (stack.length === 0) continue;  // stray closer — ignore
            stack.pop();                        // lenient: pop regardless of type
            if (stack.length === 0) return i;   // matched the original opener
        }
    }
    return -1;  // never closed → truncated
}

/**
 * Rebuild a JSON string with structurally correct brackets by walking it
 * character-by-character and maintaining a strict nesting stack.
 *
 * When a WRONG closer is encountered (e.g. `}` when `]` is expected):
 *   → emit the CORRECT closer and reprocess the current character.
 *
 * When an EXTRA closer appears (stack empty):
 *   → discard it.
 *
 * When the string ends with UNCLOSED containers:
 *   → append the missing closers.
 *
 * Examples:
 *   ["text."}}   →  ["text."]}      (wrong + extra closer)
 *   {"a":1}}     →  {"a":1}         (extra closer)
 *   {"a":["b"    →  {"a":["b"]}     (truncated)
 */
function repairBrackets(s: string): string {
    const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };
    const CLOSERS = new Set(["}", "]"]);
    const stack: string[] = [];
    let inString = false;
    let result = "";
    let i = 0;

    while (i < s.length) {
        const ch = s[i];

        // ── Inside a string literal ────────────────────────────────────────
        if (inString) {
            if (ch === "\\") {
                // Pass through escape sequence intact
                result += ch;
                if (i + 1 < s.length) result += s[++i];
                i++;
                continue;
            }
            if (ch === '"') inString = false;
            result += ch;
            i++;
            continue;
        }

        // ── String start ───────────────────────────────────────────────────
        if (ch === '"') {
            inString = true;
            result += ch;
            i++;
            continue;
        }

        // ── Opener ─────────────────────────────────────────────────────────
        if (ch in OPEN_TO_CLOSE) {
            stack.push(OPEN_TO_CLOSE[ch]);
            result += ch;
            i++;
            continue;
        }

        // ── Closer ────────────────────────────────────────────────────────
        if (CLOSERS.has(ch)) {
            if (stack.length === 0) {
                // Extra closer with nothing open — discard
                i++;
                continue;
            }
            const expected = stack[stack.length - 1];
            if (ch === expected) {
                // Correct closer
                stack.pop();
                result += ch;
                i++;
            } else {
                // Wrong closer: emit the correct one, do NOT advance `i`
                // so this character is reprocessed in the next iteration.
                result += expected;
                stack.pop();
                // i unchanged — reprocess `ch`
            }
            continue;
        }

        // ── Everything else ────────────────────────────────────────────────
        result += ch;
        i++;
    }

    // Close any string the model left open
    if (inString) result += '"';
    // Close any containers the model left open
    while (stack.length > 0) result += stack.pop()!;

    return result;
}

/**
 * Apply all non-bracket repairs first, then fix bracket structure.
 */
function repair(s: string): string {
    // 1. Normalise line endings
    s = s.replace(/\r\n?/g, "\n");
    // 2. Replace JS `undefined` keyword with JSON null
    s = s.replace(/:\s*undefined\b/g, ": null");
    // 3. Remove JS single-line comments
    s = s.replace(/\/\/[^\n]*/g, "");
    // 4. Remove JS block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    // 5. Remove trailing commas before } or ]
    s = s.replace(/,(\s*[\]}])/g, "$1");
    // 6. Rebuild with correct bracket structure
    s = repairBrackets(s);
    return s;
}

/**
 * Try JSON.parse as-is; if that fails run the repair pipeline and retry.
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
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("{");
    if (start === -1) {
        // No object found — attempt to parse as-is (will produce a useful error)
        return parseWithRepairs(s) as Record<string, unknown>;
    }

    const end = findMatchingClose(s, start);
    // end === -1 means truncated: take from start to end of string
    s = end !== -1 ? s.slice(start, end + 1) : s.slice(start);

    return parseWithRepairs(s) as Record<string, unknown>;
}

/**
 * Extract and parse a JSON array `[…]` from raw LLM output.
 */
export function extractJsonArray(raw: string): unknown[] {
    let s = stripCodeFences(raw.trim());

    const start = s.indexOf("[");
    if (start === -1) {
        return parseWithRepairs(s) as unknown[];
    }

    const end = findMatchingClose(s, start);
    s = end !== -1 ? s.slice(start, end + 1) : s.slice(start);

    return parseWithRepairs(s) as unknown[];
}