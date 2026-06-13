import { FastifyInstance, FastifyRequest } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";

// ── SSE replay buffer ────────────────────────────────────────────────────────
//
// Each SSE frame now carries a monotonic id and the last N events are kept in
// memory so a reconnecting client can pass `?since=<id>` to replay anything it
// missed during the disconnect window. Without this, a network blip on a
// "real-time" feed silently drops events.
//
// The buffer is process-local: a restart resets the id counter, and a client
// that survives the restart sees `?since=` no-op (no events match) which is
// correct — the client should treat post-restart state as a fresh stream.
//
// 500 entries × ~1 KB per event ≈ 500 KB worst case, well within budget.

const SSE_BUFFER_SIZE = 500;
let lastEventId = 0;
const eventBuffer: Array<{ id: number; event: any }> = [];

type EventCallback = (id: number, event: any) => void;
const sseClients: Set<{ send: EventCallback; targetFilter?: string }> = new Set();

export function pushSSEEvent(event: any): void {
    lastEventId++;
    const id = lastEventId;

    eventBuffer.push({ id, event });
    if (eventBuffer.length > SSE_BUFFER_SIZE) eventBuffer.shift();

    for (const client of sseClients) {
        if (client.targetFilter && event.target_id !== client.targetFilter) continue;
        try {
            client.send(id, event);
        } catch {
            sseClients.delete(client);
        }
    }
}

/** Test helper: current monotonic SSE event id. */
export function getLastSSEEventId(): number {
    return lastEventId;
}

export function registerEventRoutes(app: FastifyInstance): void {
    app.get<{
        Querystring: {
            targetId?: string;
            type?: string;
            since?: string;
            until?: string;
            limit?: string;
            offset?: string;
            guildId?: string;
            channelId?: string;
            search?: string;
        };
    }>("/api/events", async (req) => {
        const db = getDb();
        const { targetId, type, since, until, limit, offset, guildId, channelId, search } = req.query;

        const limitVal  = Math.min(Math.max(1, parseInt(limit  || "100") || 100), 1000);
        const offsetVal = Math.max(0, parseInt(offset || "0") || 0);

        let sql = "SELECT * FROM events WHERE 1=1";
        const params: any[] = [];

        if (targetId)  { sql += " AND target_id = ?";   params.push(targetId); }
        if (type)      { sql += " AND event_type = ?";  params.push(type); }
        if (since) {
            const sinceVal = parseInt(since);
            if (!isNaN(sinceVal)) { sql += " AND timestamp >= ?"; params.push(sinceVal); }
        }
        if (until) {
            const untilVal = parseInt(until);
            if (!isNaN(untilVal)) { sql += " AND timestamp <= ?"; params.push(untilVal); }
        }
        if (guildId)   { sql += " AND guild_id = ?";    params.push(guildId); }
        if (channelId) { sql += " AND channel_id = ?";  params.push(channelId); }
        if (search)    {
            sql += " AND (data LIKE ? OR event_type LIKE ?)";
            params.push(`%${search}%`, `%${search}%`);
        }

        sql += " ORDER BY timestamp DESC";
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limitVal, offsetVal);

        return db.prepare(sql).all(...params);
    });

    app.get<{ Querystring: { targetId?: string; since?: string } }>("/api/events/stream", async (req, reply) => {
        const targetFilter = req.query.targetId;
        // `?since=<id>` lets a reconnecting client replay events it missed.
        // Defaults to 0 = "from the start of the buffer". Anything older than
        // the buffer's oldest id is silently dropped (client should treat that
        // as "too long disconnected — full refetch").
        const sinceParam = req.query.since ? parseInt(req.query.since, 10) : 0;
        const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;

        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",        // ← disables nginx buffering on Railway
            "Access-Control-Allow-Origin": "*",
            // removed: "Connection: keep-alive"  ← invalid in HTTP/2, causes issues
        });

        // Initial connected frame carries the current high-water id so the
        // client knows where the live stream picks up. Frames use SSE `id:`
        // lines (the same field EventSource exposes as `lastEventId`).
        reply.raw.write(
            `id: ${lastEventId}\ndata: ${JSON.stringify({ type: "connected", lastEventId })}\n\n`
        );

        // Replay buffered events newer than `since` BEFORE we hook up the live
        // sender so order is preserved and the client doesn't see a live event
        // ahead of a replayed one.
        if (since > 0 && since < lastEventId) {
            for (const { id, event } of eventBuffer) {
                if (id <= since) continue;
                if (targetFilter && event.target_id !== targetFilter) continue;
                reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
            }
        }

        const client = {
            targetFilter,
            send: (id: number, event: any) => {
                reply.raw.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
            },
        };

        sseClients.add(client);

        // Send a keepalive comment every 25 s so Railway/nginx proxies don't
        // time out the idle connection and silently drop the live-event stream.
        const keepalive = setInterval(() => {
            try {
                reply.raw.write(":ping\n\n");
            } catch {
                clearInterval(keepalive);
                sseClients.delete(client);
            }
        }, 25_000);

        req.raw.on("close", () => {
            clearInterval(keepalive);
            sseClients.delete(client);
        });
    });
}
