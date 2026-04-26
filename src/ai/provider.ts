import { config } from "../utils/config";
import { createLogger } from "../utils/logger";

const log = createLogger("AIProvider");

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
        // Strip trailing slash to avoid double-slash in URL construction
        const baseUrl = config.aiBaseUrl.replace(/\/$/, "");

        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.aiApiKey}`,
            },
            body: JSON.stringify({
                model: config.aiModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                max_tokens: maxTokens,
                stream: false,
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "(no body)");
            throw new Error(`OpenAI-compatible API error ${res.status}: ${text}`);
        }

        const data = await res.json() as any;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
            throw new Error(`Unexpected response structure: ${JSON.stringify(data)}`);
        }
        return content.trim();
    }
}

export class AnthropicProvider implements AIProvider {
    isAvailable() { return true; }

    async complete(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "x-api-key": config.aiApiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.aiModel,
                max_tokens: maxTokens,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "(no body)");
            throw new Error(`Anthropic API error ${res.status}: ${text}`);
        }

        const data = await res.json() as any;
        const content = data?.content?.[0]?.text;
        if (typeof content !== "string") {
            throw new Error(`Unexpected Anthropic response structure: ${JSON.stringify(data)}`);
        }
        return content.trim();
    }
}

// ── Gemini rate limiter ───────────────────────────────────────────────────────
//
// Free tier hard limit: 15 requests per minute.
// We enforce a minimum 4,500 ms gap between requests (~13 RPM) which gives a
// comfortable buffer so bursts never trip the quota.
//
// This is a module-level singleton so it is shared across every call site
// (social graph analyzer, categorizer, brief generator) regardless of which
// code path invoked complete().

const GEMINI_MIN_GAP_MS = 6_500;
let geminiLastRequestAt = 0;

async function geminiRateWait(): Promise<void> {
    const wait = GEMINI_MIN_GAP_MS - (Date.now() - geminiLastRequestAt);
    if (wait > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, wait));
    }
    geminiLastRequestAt = Date.now();
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

    async complete(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
        const model = config.aiModel || "gemini-2.0-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.aiApiKey}`;

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
            },
        });

        for (let attempt = 1; attempt <= GeminiProvider.MAX_RETRIES; attempt++) {
            // Enforce the per-minute rate limit before every attempt
            await geminiRateWait();

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });

            // ── 429: rate-limited ──────────────────────────────────────────
            if (res.status === 429) {
                let parsed: any = {};
                try { parsed = await res.json(); } catch { /* ignore */ }

                const delayMs = parseGeminiRetryDelayMs(parsed);

                if (attempt === GeminiProvider.MAX_RETRIES) {
                    throw new Error(
                        `Gemini API rate limit exceeded after ${GeminiProvider.MAX_RETRIES} attempts. ` +
                        `Consider increasing AI_ANALYSIS_INTERVAL_MS or reducing AI_CATEGORIZATION_BATCH_SIZE.`
                    );
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

            return content.trim();
        }

        // TypeScript requires an explicit throw after the loop
        throw new Error("Gemini: exhausted all retries");
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

export const ai = createAIProvider();

log.info(`AI provider: ${config.aiProvider}${config.aiProvider !== "none" ? ` (model: ${config.aiModel})` : ""}`);