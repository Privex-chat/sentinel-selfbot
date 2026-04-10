import { FastifyInstance, FastifyRequest } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";

type EventCallback = (event: any) => void;
const sseClients: Set<{ send: EventCallback; targetFilter?: string }> = new Set();

export function pushSSEEvent(event: any): void {
    for (const client of sseClients) {
        if (client.targetFilter && event.target_id !== client.targetFilter) continue;
        try {
            client.send(event);
        } catch {
            sseClients.delete(client);
        }
    }
}

export function registerEventRoutes(app: FastifyInstance): void {
    app.get<{ Querystring: { targetId?: string; type?: string; since?: string; until?: string; limit?: string; offset?: string; guildId?: string; channelId?: string } }>("/api/events", async (req) => {
        const db = getDb();
        const { targetId, type, since, until, limit, offset, guildId, channelId } = req.query;

        let sql = "SELECT * FROM events WHERE 1=1";
        const params: any[] = [];

        if (targetId) { sql += " AND target_id = ?"; params.push(targetId); }
        if (type) { sql += " AND event_type = ?"; params.push(type); }
        if (since) { sql += " AND timestamp >= ?"; params.push(parseInt(since)); }
        if (until) { sql += " AND timestamp <= ?"; params.push(parseInt(until)); }
        if (guildId) { sql += " AND guild_id = ?"; params.push(guildId); }
        if (channelId) { sql += " AND channel_id = ?"; params.push(channelId); }

        sql += " ORDER BY timestamp DESC";
        sql += ` LIMIT ? OFFSET ?`;
        params.push(parseInt(limit || "100"), parseInt(offset || "0"));

        return db.prepare(sql).all(...params);
    });

    app.get<{ Querystring: { targetId?: string } }>("/api/events/stream", async (req, reply) => {
        const targetFilter = req.query.targetId;

        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",        // ← disables nginx buffering on Railway
            "Access-Control-Allow-Origin": "*",
            // removed: "Connection: keep-alive"  ← invalid in HTTP/2, causes issues
        });

        reply.raw.write("data: {\"type\":\"connected\"}\n\n");

        const client = {
            targetFilter,
            send: (event: any) => {
                reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            },
        };

        sseClients.add(client);

        req.raw.on("close", () => {
            sseClients.delete(client);
        });
    });
}
