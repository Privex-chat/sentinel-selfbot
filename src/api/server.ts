import Fastify, { FastifyRequest, FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { authMiddleware } from "./middleware/auth";
import { registerTargetRoutes } from "./routes/targets";
import { registerEventRoutes } from "./routes/events";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerInsightRoutes } from "./routes/insights";
import { registerTimelineRoutes } from "./routes/timeline";
import { registerAlertRoutes } from "./routes/alerts";
import { registerExportRoutes } from "./routes/export";
import { registerStatusRoutes } from "./routes/status";
import { registerSocialRoutes } from "./routes/social";
import { registerBackfillRoutes } from "./routes/backfill";
import { registerConfigRoutes } from "./routes/config";

const log = createLogger("API");

// ── Gateway health injection ─────────────────────────────────────────────────
//
// /health is unauthenticated by design so a cloud platform's probe doesn't
// need the API token, but we still want it to reflect whether the Discord
// gateway is actually connected. index.ts injects a getter after the gateway
// client exists; the route reads through it.
let gatewayHealthFn: (() => boolean) | null = null;
export function setGatewayHealthFn(fn: () => boolean): void {
    gatewayHealthFn = fn;
}

// ── CORS allowlist ───────────────────────────────────────────────────────────
//
// `API_CORS_ORIGINS` is a comma-separated list of allowed origins. An explicit
// "*" means "reflect any origin" (useful when self-hosting behind your own
// reverse proxy). Unset falls back to the published web client + common
// localhost dev ports so the hosted UI and local development both work.
const DEFAULT_CORS_ORIGINS = [
    "https://sentinel-web.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
];

function parseCorsOrigins(): string[] | boolean {
    const env = process.env.API_CORS_ORIGINS?.trim();
    if (!env) return DEFAULT_CORS_ORIGINS;
    if (env === "*") return true;
    return env.split(",").map(s => s.trim()).filter(Boolean);
}

export async function startApiServer(): Promise<void> {
    // `requestIdHeader: false` makes Fastify generate its own request id rather
    // than trusting a client header — the id appears in the error-handler
    // response so operators can grep logs for the matching request without
    // letting clients spoof the value.
    const app = Fastify({ logger: false, requestIdHeader: false });

    // ── CORS ──────────────────────────────────────────────────────────────────
    const corsOrigin = parseCorsOrigins();
    await app.register(cors, {
        origin: corsOrigin,
        allowedHeaders: ["Authorization", "Content-Type"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        credentials: false,
    });
    const originSummary = corsOrigin === true ? "* (any)" : (corsOrigin as string[]).join(", ");
    log.info(`CORS origins: ${originSummary}`);

    // ── Rate limiting ─────────────────────────────────────────────────────────
    //
    // 300 req/min/IP is generous enough for an actively-used dashboard (status
    // polling, analytics refreshes, message list paging) without letting a
    // misbehaving client or a leaked token hammer the event loop. /health is
    // allowlisted so health probes never burn the budget.
    //
    // The 429 response includes the Retry-After header so well-behaved clients
    // can back off without operator intervention.
    await app.register(rateLimit, {
        max: 300,
        timeWindow: "1 minute",
        allowList: (req: FastifyRequest) => req.url === "/health",
    });

    // ── Global error handler ──────────────────────────────────────────────────
    //
    // Without this, Fastify returns thrown error messages directly to the
    // client, which can include SQLite error text, file paths, or other
    // internals. We log everything server-side but return a generic message
    // plus the request-id so operators can correlate.
    app.setErrorHandler((err: FastifyError, req, reply) => {
        // Fastify schema validation errors are safe to surface (they describe
        // what the client sent wrong, not what's wrong with the server).
        if (err.validation) {
            return reply.code(400).send({
                error: "Invalid request",
                details: err.message,
                requestId: req.id,
            });
        }

        // Rate-limit responses come through here with a 429 statusCode set —
        // pass them through with the plugin's intended body so clients see
        // the Retry-After header and message Fastify-rate-limit attaches.
        if (err.statusCode === 429) {
            return reply.code(429).send({ error: err.message, requestId: req.id });
        }

        // Anything else: log full detail, return a redacted message.
        log.error(`Unhandled request error on ${req.method} ${req.url} [${req.id}]: ${err.message}`);
        if (err.stack) log.error(err.stack);
        const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
        return reply.code(status).send({
            error: "Internal server error",
            requestId: req.id,
        });
    });

    // ── Auth ──────────────────────────────────────────────────────────────────
    // /health stays unauthenticated so external probes (Railway, Fly, uptime
    // monitors) can check liveness without holding the API token. Every other
    // /api/* route requires Bearer auth.
    app.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith("/api/") && request.method !== "OPTIONS") {
            await authMiddleware(request, reply);
        }
    });

    // ── /health ───────────────────────────────────────────────────────────────
    app.get("/health", async () => ({
        status: "ok",
        uptimeMs: Math.round(process.uptime() * 1000),
        gatewayConnected: gatewayHealthFn ? gatewayHealthFn() : null,
    }));

    // Register all routes
    registerTargetRoutes(app);
    registerEventRoutes(app);
    registerAnalyticsRoutes(app);
    registerInsightRoutes(app);
    registerTimelineRoutes(app);
    registerAlertRoutes(app);
    registerExportRoutes(app);
    registerStatusRoutes(app);
    registerSocialRoutes(app);
    registerBackfillRoutes(app);
    registerConfigRoutes(app);

    try {
        await app.listen({ port: config.apiPort, host: "0.0.0.0" });
        log.info(`API server listening on port ${config.apiPort}`);
    } catch (err) {
        log.error("Failed to start API server", err);
        throw err;
    }
}
