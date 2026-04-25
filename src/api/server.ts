import Fastify from "fastify";
import cors from "@fastify/cors";
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

const log = createLogger("API");

export async function startApiServer(): Promise<void> {
    const app = Fastify({ logger: false });

    await app.register(cors, {
        origin: true,
        allowedHeaders: ["Authorization", "Content-Type"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        credentials: false,
    });

    // server.ts
    app.addHook("onRequest", async (request, reply) => {
        if (request.url.startsWith("/api/") && request.method !== "OPTIONS") {
            await authMiddleware(request, reply);
        }
    });

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

    try {
        await app.listen({ port: config.apiPort, host: "0.0.0.0" });
        log.info(`API server listening on port ${config.apiPort}`);
    } catch (err) {
        log.error("Failed to start API server", err);
        throw err;
    }
}
