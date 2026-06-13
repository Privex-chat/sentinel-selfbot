import { FastifyInstance, FastifyReply } from "fastify";
import { getDb } from "../../database/connection";
import { createLogger } from "../../utils/logger";

const log = createLogger("Export");

/**
 * Streaming exporter — emits one JSON object per line (NDJSON / JSON-Lines).
 *
 * The previous implementation built one `{ events: [...], messages: [...], ... }`
 * tree in memory before sending. On a multi-year install with millions of
 * events that's gigabytes of allocations + a multi-second event-loop stall
 * during JSON.stringify. The new flow uses `better-sqlite3`'s `.iterate()`
 * cursor — at any moment only one row is materialised in JS, regardless of
 * how large the table is.
 *
 * Output shape (one JSON object per line):
 *
 *   {"_section":"meta","userId":"…","exportedAt":…,"schema_version":7}
 *   {"_section":"events_start","count_hint":null}
 *   {"_section":"events", …row…}
 *   {"_section":"events", …row…}
 *   {"_section":"events_end"}
 *   {"_section":"messages_start", …}
 *   …
 *   {"_section":"complete"}
 *
 * Consumers should treat unknown _section values as opaque and skip them so we
 * can add tables without breaking existing tooling.
 */
const EXPORT_TABLES: Array<{ name: string; orderBy: string }> = [
    { name: "events",            orderBy: "timestamp ASC"  },
    { name: "messages",          orderBy: "created_at ASC" },
    { name: "presence_sessions", orderBy: "start_time ASC" },
    { name: "activity_sessions", orderBy: "start_time ASC" },
    { name: "voice_sessions",    orderBy: "start_time ASC" },
    { name: "profile_snapshots", orderBy: "timestamp ASC"  },
    { name: "reactions",         orderBy: "added_at ASC"   },
    { name: "typing_events",     orderBy: "timestamp ASC"  },
    { name: "daily_summaries",   orderBy: "date ASC"       },
];

function writeLine(reply: FastifyReply, obj: unknown): void {
    reply.raw.write(JSON.stringify(obj) + "\n");
}

export function registerExportRoutes(app: FastifyInstance): void {
    app.get<{ Params: { userId: string } }>("/api/export/:userId", async (req, reply) => {
        const db = getDb();
        const { userId } = req.params;

        reply.raw.writeHead(200, {
            "Content-Type":        "application/x-ndjson",
            "Content-Disposition": `attachment; filename=sentinel_${userId}_export.ndjson`,
            "Cache-Control":       "no-store",
            "X-Accel-Buffering":   "no",
        });

        // reply.hijack() tells Fastify we're managing the response lifecycle
        // ourselves. Without it the framework would try to send a body after
        // we call reply.raw.end(), producing a duplicate-send warning.
        reply.hijack();

        try {
            writeLine(reply, {
                _section: "meta",
                userId,
                exportedAt: Date.now(),
            });

            let totalRows = 0;
            for (const { name, orderBy } of EXPORT_TABLES) {
                writeLine(reply, { _section: `${name}_start` });

                // .iterate() returns a row-by-row generator — only one row in
                // memory at a time. Safe to use against tables of any size.
                const stmt = db.prepare(`SELECT * FROM ${name} WHERE target_id = ? ORDER BY ${orderBy}`);
                let rowsInTable = 0;
                for (const row of stmt.iterate(userId)) {
                    writeLine(reply, { _section: name, ...(row as any) });
                    rowsInTable++;
                }
                totalRows += rowsInTable;

                writeLine(reply, { _section: `${name}_end`, rows: rowsInTable });
            }

            writeLine(reply, { _section: "complete", totalRows });
            reply.raw.end();
            log.info(`Streamed export for ${userId}: ${totalRows} rows`);
        } catch (err: any) {
            log.error(`Export stream error for ${userId}: ${err.message}`);
            // Headers are already sent — can't switch status code. Emit a
            // sentinel error record so the consumer detects the truncation
            // rather than silently treating the partial file as complete.
            try {
                writeLine(reply, { _section: "error", message: err.message });
            } catch { /* socket may already be closed */ }
            reply.raw.end();
        }
    });

    /**
     * CSV export of events only — streamed row-by-row so a target with
     * millions of events doesn't OOM the process. Formula-character prefix
     * defends against spreadsheet-side CSV injection.
     */
    app.get<{ Params: { userId: string } }>("/api/export/:userId/csv", async (req, reply) => {
        const db = getDb();
        const { userId } = req.params;

        reply.raw.writeHead(200, {
            "Content-Type":        "text/csv",
            "Content-Disposition": `attachment; filename=sentinel_${userId}_export.csv`,
            "Cache-Control":       "no-store",
            "X-Accel-Buffering":   "no",
        });
        reply.hijack();

        // Same defensive escape as before: quote-wrap, escape internal quotes,
        // prefix a leading `=+-@\t\r` with a single quote so Excel / Sheets
        // can't interpret the cell as a formula.
        const escCsv = (val: string | null | undefined) => {
            if (val == null || val === "") return '""';
            let safe = String(val);
            if (/^[=+\-@\t\r]/.test(safe)) safe = "'" + safe;
            return '"' + safe.replace(/"/g, '""') + '"';
        };

        try {
            reply.raw.write("id,target_id,event_type,timestamp,data,guild_id,channel_id\n");
            let count = 0;
            const stmt = db.prepare("SELECT * FROM events WHERE target_id = ? ORDER BY timestamp ASC");
            for (const e of stmt.iterate(userId) as Iterable<any>) {
                reply.raw.write(
                    `${e.id},${escCsv(e.target_id)},${escCsv(e.event_type)},${e.timestamp},` +
                    `${escCsv(e.data || "")},${escCsv(e.guild_id || "")},${escCsv(e.channel_id || "")}\n`
                );
                count++;
            }
            reply.raw.end();
            log.info(`Streamed CSV export for ${userId}: ${count} events`);
        } catch (err: any) {
            log.error(`CSV export stream error for ${userId}: ${err.message}`);
            reply.raw.end();
        }
    });
}
