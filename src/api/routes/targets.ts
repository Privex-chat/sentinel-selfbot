import { FastifyInstance } from "fastify";
import { getStmts } from "../../database/queries";
import { getDb } from "../../database/connection";
import { config } from "../../utils/config";
import { isValidTimezone } from "../../utils/timezone";
import { startBackfillForTarget } from "../../backfill/backfill-engine";
import { requestPresenceForUser } from "../../pollers/status-poller";
import { bootstrapTargetNow } from "../../pollers/target-profile-poller";
import { onTargetRemoved, refreshTargetCache, markBootstrapComplete } from "../../target-lifecycle";

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

    app.post<{ Body: { userId: string; label?: string; notes?: string; priority?: number; timezone?: string } }>("/api/targets", async (req, reply) => {
        const { userId, label, notes, priority, timezone } = req.body;
        if (!userId || !/^\d{17,20}$/.test(userId)) {
            return reply.code(400).send({ error: "Invalid userId" });
        }

        // Optional timezone; defaults to UTC at the DB layer. Validated against
        // ICU's IANA tables — accepted form is "Area/City" or "UTC".
        const tz = timezone ?? "UTC";
        if (!isValidTimezone(tz)) {
            return reply.code(400).send({ error: `Invalid timezone "${tz}". Expected an IANA identifier (e.g. America/New_York, Europe/London, UTC).` });
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
        stmts.insertTarget.run(userId, Date.now(), label || null, notes || null, priorityVal, 1, tz);
        refreshTargetCache();

        // Kick off an immediate profile fetch so the target flips from
        // bootstrap → operational within seconds rather than waiting up to
        // PROFILE_POLL_INTERVAL_MS (default 5 min) for the next cycle. While
        // bootstrap is pending, profile/avatar/username events stay suppressed
        // and the alerts engine + anomaly detector early-return for this
        // target — see architecture.md "Target onboarding pipeline".
        bootstrapTargetNow(userId);

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
        Body: { label?: string | null; notes?: string | null; priority?: number; active?: boolean; timezone?: string };
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
        if ("timezone" in body && body.timezone !== undefined) {
            if (!isValidTimezone(body.timezone)) {
                return reply.code(400).send({ error: `Invalid timezone "${body.timezone}". Expected an IANA identifier (e.g. America/New_York, Europe/London, UTC).` });
            }
            setParts.push("timezone = ?");
            params.push(body.timezone);
        }

        if (setParts.length > 0) {
            params.push(userId);
            db.prepare(`UPDATE targets SET ${setParts.join(", ")} WHERE user_id = ?`).run(...params);
            // Refresh on any change that the in-memory cache mirrors: `active`
            // controls cache membership, `timezone` is now read on every analyser
            // call. Other fields don't need a refresh.
            if ("active" in body || "timezone" in body) refreshTargetCache();
        }

        return { success: true };
    });

    /**
     * Operator force-complete for a stuck bootstrap. Idempotent — a target
     * that's already operational returns 200 with the existing timestamp.
     * Useful when the immediate post-add profile fetch failed (target has no
     * mutual guilds and the basic /users endpoint is also failing) and the
     * operator wants alerts to flow now rather than wait for the 30-min sweep.
     */
    app.post<{ Params: { userId: string } }>(
        "/api/targets/:userId/bootstrap/complete",
        async (req, reply) => {
            const { userId } = req.params;
            const stmts = getStmts();
            const target = stmts.getTarget.get(userId) as { user_id: string; bootstrap_completed_at: number | null } | undefined;
            if (!target) {
                return reply.code(404).send({ error: "Target not found" });
            }

            const now = Date.now();
            const flipped = markBootstrapComplete(userId, now);
            const existing = stmts.getBootstrapCompletedAt.get(userId) as { bootstrap_completed_at: number | null } | undefined;
            return {
                success: true,
                bootstrap_completed_at: existing?.bootstrap_completed_at ?? now,
                wasAlreadyComplete: !flipped,
            };
        }
    );
}
