import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
import { config } from "../../utils/config";
import { startBackfillForTarget } from "../../backfill/backfill-engine";
import { requestPresenceForUser } from "../../pollers/status-poller";
import { onTargetRemoved } from "../../target-lifecycle";

// How long to wait after adding a target before kicking off the backfill.
// Adding a target already triggers a profile fetch for mutual guilds — doing
// the full channel sweep immediately on top of that is a burst that Discord's
// abuse detection reliably flags. Waiting 90 seconds lets the profile request
// settle and makes the subsequent backfill look like a delayed user action.
const BACKFILL_START_DELAY_MS = 90_000;

export function registerTargetRoutes(app: FastifyInstance): void {
    app.get("/api/targets", async () => {
        const stmts = getStmts();
        return stmts.getAllTargets.all();
    });

    app.post<{ Body: { userId: string; label?: string; notes?: string; priority?: number } }>("/api/targets", async (req, reply) => {
        const { userId, label, notes, priority } = req.body;
        if (!userId || !/^\d{17,20}$/.test(userId)) {
            return reply.code(400).send({ error: "Invalid userId" });
        }

        const db = getDb();

        // Rate limit: max 1 new target per hour to avoid Discord flagging the account
        const RATE_LIMIT_MS = 15 * 60 * 1000; // 15 minutes
        const recent = db.prepare(
            "SELECT added_at FROM targets ORDER BY added_at DESC LIMIT 1"
        ).get() as { added_at: number } | undefined;

        if (recent) {
            const elapsed = Date.now() - recent.added_at;
            if (elapsed < RATE_LIMIT_MS) {
                const waitMins = Math.ceil((RATE_LIMIT_MS - elapsed) / 60000);
                return reply.code(429).send({
                    error: `Rate limited: adding targets too quickly can flag your Discord account. Wait ${waitMins} more minute${waitMins === 1 ? "" : "s"} before adding another target.`,
                    retryAfterMs: RATE_LIMIT_MS - elapsed,
                });
            }
        }

        const priorityVal = Math.floor(priority ?? 0);
        if (!Number.isFinite(priorityVal) || priorityVal < 0) {
            return reply.code(400).send({ error: "priority must be a non-negative integer" });
        }
        const stmts = getStmts();
        stmts.insertTarget.run(userId, Date.now(), label || null, notes || null, priorityVal, 1);

        if (config.backfillEnabled) {
            // Delay the backfill start so the profile fetch triggered by the
            // presence subscription has time to complete first, and so there
            // is no immediate burst of API calls right after target creation.
            setTimeout(() => {
                startBackfillForTarget(userId).catch(() => { });
            }, BACKFILL_START_DELAY_MS);
        }

        // Subscribe to presence immediately — delay 5 s to let the profile poller
        // fetch mutual_guilds first (profile poller fires ~30 s after startup, but
        // for existing targets mutual_guilds are already in the DB snapshot).
        setTimeout(() => requestPresenceForUser(userId), 5_000);

        return { success: true, userId };
    });

    app.delete<{ Params: { userId: string } }>("/api/targets/:userId", async (req) => {
        const stmts = getStmts();
        stmts.deleteTarget.run(req.params.userId);
        // SQL cascade handles every child row; this clears the in-memory caches
        // (presence, activities, voice, typing pendings, guild-member, pollers,
        // alert composite tracker) that the cascade does not touch.
        onTargetRemoved(req.params.userId);
        return { success: true };
    });

    app.patch<{
        Params: { userId: string };
        Body: { label?: string | null; notes?: string | null; priority?: number; active?: boolean };
    }>("/api/targets/:userId", async (req, reply) => {
        const db = getDb();
        const body = req.body;
        const userId = req.params.userId;

        const setParts: string[] = [];
        const params: any[] = [];

        // Use explicit 'in' check so null values (clearing a field) are applied correctly,
        // unlike COALESCE which treats null as "keep existing".
        if ("label" in body) {
            setParts.push("label = ?");
            params.push(body.label ?? null);
        }
        if ("notes" in body) {
            setParts.push("notes = ?");
            params.push(body.notes ?? null);
        }
        if ("priority" in body && body.priority !== undefined) {
            const p = Math.floor(body.priority);
            if (!Number.isFinite(p) || p < 0) {
                return reply.code(400).send({ error: "priority must be a non-negative integer" });
            }
            setParts.push("priority = ?");
            params.push(p);
        }
        if ("active" in body && body.active !== undefined) {
            setParts.push("active = ?");
            params.push(body.active ? 1 : 0);
        }

        if (setParts.length > 0) {
            params.push(userId);
            db.prepare(`UPDATE targets SET ${setParts.join(", ")} WHERE user_id = ?`).run(...params);
        }

        return { success: true };
    });
}
