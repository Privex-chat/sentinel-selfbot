import { config } from "../utils/config";
import { createLogger } from "../utils/logger";
import { notifyCriticalError } from "../utils/webhook-notifier";

const log = createLogger("AIProvider");

// HTTP status codes that are transient and worth retrying
const TRANSIENT_HTTP_CODES = new Set([500, 502, 503, 529]);
// Backoff delays per attempt (attempt 1 → 10 s, attempt 2 → 30 s, attempt 3 → 60 s)
const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000];
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface AIProvider {
    complete(systemPrompt: string, userPrompt: string, maxTokens?: number): Promise<string>;
    isAvailable(): boolean;
}

export class NullProvider implements AIProvider {
    isAvailable() { return false; }
    async complete(): Promise<string> {
        throw new Error("No AI provider configured. Set AI_PROVIDER in .env");
    }
}

export class OpenAICompatibleProvider implements AIProvider {
    isAvailable() { return true; }

    async complete(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
        const baseUrl = config.aiBaseUrl.replace(/\/$/, "");
        const body = JSON.stringify({
            model: config.aiModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            max_tokens: maxTokens,
            stream: false,
        });

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${config.aiApiKey}`,
                    },
                    body,
                });
            } catch (fetchErr: any) {
                if (attempt === MAX_RETRIES) throw fetchErr;
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`OpenAI-compatible fetch error (attempt ${attempt}/${MAX_RETRIES}): ${fetchErr.message}, retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "(no body)");
                if (TRANSIENT_HTTP_CODES.has(res.status) && attempt < MAX_RETRIES) {
                    const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                    log.warn(`OpenAI-compatible ${res.status} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`);
            }

            const data = await res.json() as any;
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== "string") {
                throw new Error(`Unexpected response structure: ${JSON.stringify(data)}`);
            }
            const trimmed = content.trim();
            if (!trimmed) {
                if (attempt === MAX_RETRIES) throw new Error("OpenAI-compatible API returned empty response text");
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`OpenAI-compatible empty response (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }
            return trimmed;
        }

        const msg = "OpenAI-compatible API: exhausted all retries on transient errors";
        notifyCriticalError(msg, undefined, "AI Provider");
        throw new Error(msg);
    }
}

export class AnthropicProvider implements AIProvider {
    isAvailable() { return true; }

    async complete(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
        const body = JSON.stringify({
            model: config.aiModel,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
        });

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let res: Response;
            try {
                res = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "x-api-key": config.aiApiKey,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    body,
                });
            } catch (fetchErr: any) {
                if (attempt === MAX_RETRIES) throw fetchErr;
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`Anthropic fetch error (attempt ${attempt}/${MAX_RETRIES}): ${fetchErr.message}, retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }

            if (!res.ok) {
                const text = await res.text().catch(() => "(no body)");
                if (TRANSIENT_HTTP_CODES.has(res.status) && attempt < MAX_RETRIES) {
                    const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                    log.warn(`Anthropic ${res.status} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(`Anthropic API error ${res.status}: ${text}`);
            }

            const data = await res.json() as any;
            const content = data?.content?.[0]?.text;
            if (typeof content !== "string") {
                throw new Error(`Unexpected Anthropic response structure: ${JSON.stringify(data)}`);
            }
            const trimmed = content.trim();
            if (!trimmed) {
                if (attempt === MAX_RETRIES) throw new Error("Anthropic returned empty response text");
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`Anthropic empty response (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }
            return trimmed;
        }

        const msg = "Anthropic API: exhausted all retries on transient errors";
        notifyCriticalError(msg, undefined, "AI Provider");
        throw new Error(msg);
    }
}

// ── Gemini rate limiter ───────────────────────────────────────────────────────
//
// Free tier hard limit: 15 requests per minute.
// We enforce a minimum 4,500 ms gap between requests (~13 RPM) which gives a
// comfortable buffer so bursts never trip the quota.
//
// Concurrent callers (social graph + categorizer + brief generator can all fire
// at the same daily tick) used to race the rate gate: each saw the same
// `geminiLastRequestAt` value and both proceeded, blowing past the 15 RPM cap.
// `geminiInflight` is a promise chain that serialises every Gemini complete()
// call regardless of caller — only one runs at a time, queued in arrival order.

const GEMINI_MIN_GAP_MS = 6_500;
let geminiLastRequestAt = 0;
let geminiInflight: Promise<unknown> = Promise.resolve();

async function geminiRateWait(): Promise<void> {
    const wait = GEMINI_MIN_GAP_MS - (Date.now() - geminiLastRequestAt);
    if (wait > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, wait));
    }
    geminiLastRequestAt = Date.now();
}

/**
 * Serialise a Gemini API call against every other in-flight Gemini call. The
 * returned promise resolves with `work`'s result; the chain swallows rejections
 * internally so one failure doesn't poison subsequent callers.
 */
function geminiSerialize<T>(work: () => Promise<T>): Promise<T> {
    // Wait for the previous call to settle (success OR failure), then run.
    // The `catch(() => undefined)` strips the previous error so a single bad
    // call doesn't reject everyone queued behind it.
    const next = geminiInflight.catch(() => undefined).then(() => work());
    // Replace the chain head with the new promise so the NEXT caller waits on
    // us. Use catch() on the stored ref so an uncaught rejection inside `work`
    // doesn't surface as an unhandledRejection on the chain itself.
    geminiInflight = next.catch(() => undefined);
    return next;
}

/**
 * Parse the retryDelay from a Gemini 429 response body.
 * Gemini returns details like: { "@type": "...RetryInfo", "retryDelay": "36s" }
 * Returns milliseconds to wait (+ 2 s buffer), or 65_000 ms as a safe default.
 */
function parseGeminiRetryDelayMs(body: any): number {
    try {
        const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
        for (const d of details) {
            if (typeof d?.retryDelay === "string") {
                const match = (d.retryDelay as string).match(/^(\d+(?:\.\d+)?)s$/);
                if (match) {
                    return Math.ceil(parseFloat(match[1]) * 1000) + 2_000; // +2 s buffer
                }
            }
        }
    } catch { /* ignore parse errors */ }
    return 65_000; // default: just over one minute
}

/**
 * Native Google Gemini provider using the generateContent REST API.
 *
 * Set in .env:
 *   AI_PROVIDER=gemini
 *   AI_MODEL=gemini-2.0-flash        # or gemini-2.0-flash-lite, gemini-1.5-flash, etc.
 *   AI_API_KEY=<your-google-ai-studio-key>
 *
 * Get a free key at https://aistudio.google.com
 * Free tier (as of 2026): 15 RPM, 1 million tokens/day.
 *
 * Rate limiting is handled automatically inside this class:
 *   - A module-level gate enforces a 4,500 ms minimum between requests (~13 RPM).
 *   - On a 429 response the provider reads Gemini's retryDelay field and
 *     waits exactly that long before retrying (up to 3 attempts total).
 */
export class GeminiProvider implements AIProvider {
    private static readonly MAX_RETRIES = 3;

    isAvailable() { return true; }

    complete(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
        // Serialise all Gemini calls through the module-level chain so concurrent
        // callers can't race the rate gate and burst above 15 RPM.
        return geminiSerialize(() => this.completeInner(systemPrompt, userPrompt, maxTokens));
    }

    private async completeInner(systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
        const model = config.aiModel || "gemini-2.0-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.aiApiKey}`;

        // For thinking models (gemini-2.5-*), disable the internal reasoning
        // budget entirely. These tasks emit short structured JSON — thinking
        // wastes tokens and causes MAX_TOKENS truncation on the actual output.
        const isThinkingModel = model.includes("2.5");
        const body = JSON.stringify({
            system_instruction: {
                parts: [{ text: systemPrompt }],
            },
            contents: [
                {
                    role: "user",
                    parts: [{ text: userPrompt }],
                },
            ],
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0.1,
                ...(isThinkingModel ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
        });

        for (let attempt = 1; attempt <= GeminiProvider.MAX_RETRIES; attempt++) {
            // Enforce the per-minute rate limit before every attempt
            await geminiRateWait();

            let res: Response;
            try {
                res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
            } catch (fetchErr: any) {
                if (attempt === GeminiProvider.MAX_RETRIES) throw fetchErr;
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`Gemini fetch network error (attempt ${attempt}/${GeminiProvider.MAX_RETRIES}): ${fetchErr.message}, retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }

            // ── 429: rate-limited ──────────────────────────────────────────
            if (res.status === 429) {
                let parsed: any = {};
                try { parsed = await res.json(); } catch { /* ignore */ }

                const delayMs = parseGeminiRetryDelayMs(parsed);

                if (attempt === GeminiProvider.MAX_RETRIES) {
                    const msg = `Gemini API rate limit exceeded after ${GeminiProvider.MAX_RETRIES} attempts. Consider increasing AI_ANALYSIS_INTERVAL_MS or reducing AI_CATEGORIZATION_BATCH_SIZE.`;
                    notifyCriticalError(msg, undefined, "AI Provider");
                    throw new Error(msg);
                }

                log.warn(
                    `Gemini 429 rate limit (attempt ${attempt}/${GeminiProvider.MAX_RETRIES}), ` +
                    `waiting ${(delayMs / 1000).toFixed(0)}s before retry…`
                );

                // Advance the rate-limiter window so the next geminiRateWait()
                // correctly accounts for the full delay we are about to sleep.
                geminiLastRequestAt = Date.now() + delayMs;
                await new Promise<void>(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            // ── Transient server errors (503, 502, 500, 529) ──────────────
            if (TRANSIENT_HTTP_CODES.has(res.status)) {
                const text = await res.text().catch(() => "(no body)");
                if (attempt === GeminiProvider.MAX_RETRIES) {
                    throw new Error(`Gemini API error ${res.status}: ${text}`);
                }
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`Gemini ${res.status} transient error (attempt ${attempt}/${GeminiProvider.MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }

            // ── Other HTTP errors ──────────────────────────────────────────
            if (!res.ok) {
                const text = await res.text().catch(() => "(no body)");
                throw new Error(`Gemini API error ${res.status}: ${text}`);
            }

            // ── Success ────────────────────────────────────────────────────
            const data = await res.json() as any;
            const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (typeof content !== "string") {
                // Surface safety/quota block reasons explicitly
                const finishReason: string | undefined = data?.candidates?.[0]?.finishReason;
                if (finishReason && finishReason !== "STOP") {
                    throw new Error(`Gemini response blocked: ${finishReason}`);
                }
                throw new Error(`Unexpected Gemini response structure: ${JSON.stringify(data)}`);
            }

            const finishReason: string | undefined = data?.candidates?.[0]?.finishReason;
            if (finishReason === "MAX_TOKENS") {
                throw new Error(`Gemini response truncated (MAX_TOKENS) — increase maxTokens`);
            }
            
            const trimmed = content.trim();
            if (!trimmed) {
                if (attempt === GeminiProvider.MAX_RETRIES) {
                    throw new Error("Gemini returned empty response text");
                }
                const delayMs = RETRY_BACKOFF_MS[attempt - 1];
                log.warn(`Gemini returned empty response (attempt ${attempt}/${GeminiProvider.MAX_RETRIES}), retrying in ${delayMs / 1000}s…`);
                await sleep(delayMs);
                continue;
            }

            return trimmed;
        }

        const msg = "Gemini API: exhausted all retries on transient errors";
        notifyCriticalError(msg, undefined, "AI Provider");
        throw new Error(msg);
    }
}

export function createAIProvider(): AIProvider {
    switch (config.aiProvider) {
        case "ollama":
        case "openai":
            return new OpenAICompatibleProvider();
        case "anthropic":
            return new AnthropicProvider();
        case "gemini":
            return new GeminiProvider();
        default:
            return new NullProvider();
    }
}

// Mutable singleton so resetAIProvider() can hot-swap the provider without
// breaking existing call sites that hold a reference to `ai`.
let _provider: AIProvider = createAIProvider();

export const ai: AIProvider = {
    complete:    (...args) => _provider.complete(...args),
    isAvailable: ()       => _provider.isAvailable(),
};

export function resetAIProvider(): void {
    _provider = createAIProvider();
    log.info(`AI provider reset: ${config.aiProvider}${config.aiProvider !== "none" ? ` (model: ${config.aiModel})` : ""}`);
}

log.info(`AI provider: ${config.aiProvider}${config.aiProvider !== "none" ? ` (model: ${config.aiModel})` : ""}`);