/**
 * Centralised hook for "a target has been removed."
 *
 * Every module that keeps per-target state in memory (collectors, pollers,
 * alert composite tracker) exports its own `removeTargetState(userId)`.
 * This file wires them together so callers — the DELETE /api/targets route,
 * the `$remove` self-command — only need to invoke `onTargetRemoved(userId)`
 * once. New stateful modules should add themselves to this list rather than
 * relying on every caller remembering to clear them.
 *
 * Database rows are still cascade-deleted at the SQL layer
 * (`ON DELETE CASCADE` on every child table's FK to `targets.user_id`).
 * This file deals only with the in-memory caches that the DB cascade does
 * not touch.
 */

import { createLogger } from "./utils/logger";
import { getStmts } from "./database/queries";
import { removeTargetState as removeFromPresence } from "./collectors/presence";
import { removeTargetState as removeFromActivity } from "./collectors/activity";
import { removeTargetState as removeFromVoice } from "./collectors/voice";
import { removeTargetState as removeFromTyping } from "./collectors/typing";
import { removeTargetState as removeFromGuildMember } from "./collectors/guild-member";
import { removeTargetState as removeFromTargetProfilePoller } from "./pollers/target-profile-poller";
import { removeTargetState as removeFromAlertEngine } from "./alerts/engine";
import { invalidateSocialGraphCache } from "./analyzers/social-graph";
import { cancelBackfill } from "./backfill/backfill-engine";

const log = createLogger("TargetLifecycle");

// ── Active-target cache ──────────────────────────────────────────────────────
//
// The gateway dispatch handler calls `isTarget(userId)` on every PRESENCE_UPDATE
// / MESSAGE_CREATE / VOICE_STATE_UPDATE / TYPING_START / etc. The previous
// implementation hit SQLite (`getTarget.get`) per event. better-sqlite3 is fast
// but on a busy guild that's still hundreds of synchronous queries per second
// blocking the event loop. The cache lets the hot path be a Set lookup; the
// cost is having to refresh after every target mutation (add / pause / resume /
// remove), which is rare.
//
// Refresh policy: every mutation site below calls `refreshTargetCache()` after
// the SQL change commits. Worst case if a site forgets: a one-event-cycle stale
// read until the next refresh — non-fatal, just temporarily wrong.

const activeTargetSet = new Set<string>();

// Per-target IANA timezone, cached alongside the active set. Hot-path analysers
// (alerts/engine.ts:UNUSUAL_HOUR, sleep-schedule, routine-detector, baseline
// DOW computation, brief day labels) read this on every event. The cache
// includes paused targets too — analytics on a paused target should still use
// the operator-set timezone.
const targetTimezones = new Map<string, string>();

// Per-target bootstrap completion timestamp. Mirrors targets.bootstrap_completed_at.
//   null  = still bootstrapping (alerts + anomalies suppressed)
//   number = operational since that epoch ms
//
// Read by alerts/engine.ts:evaluateEvent (early-return when bootstrapping),
// collectors/profile.ts:handleProfileUpdate (suppress events when bootstrapping),
// analyzers/anomaly-detector.ts (clamp `since` to this value).
// Refreshed by refreshTargetCache + writes via markBootstrapComplete.
const targetBootstrapAt = new Map<string, number | null>();

export function refreshTargetCache(): void {
    try {
        // SELECT both active + paused: timezone applies to analytics regardless of active state.
        const activeRows = getStmts().getActiveTargets.all() as Array<{ user_id: string; timezone?: string; bootstrap_completed_at?: number | null }>;
        const allRows    = getStmts().getAllTargets.all()    as Array<{ user_id: string; timezone?: string; bootstrap_completed_at?: number | null }>;

        activeTargetSet.clear();
        for (const row of activeRows) activeTargetSet.add(row.user_id);

        targetTimezones.clear();
        targetBootstrapAt.clear();
        for (const row of allRows) {
            targetTimezones.set(row.user_id, row.timezone || "UTC");
            // SQLite stores NULL → JS undefined; normalise to null so the
            // isBootstrapping check has a stable falsy sentinel.
            targetBootstrapAt.set(
                row.user_id,
                row.bootstrap_completed_at == null ? null : row.bootstrap_completed_at,
            );
        }

        const bootstrapping = [...targetBootstrapAt.values()].filter(v => v == null).length;
        log.debug(`Target cache refreshed (${activeTargetSet.size} active, ${targetTimezones.size} total, ${bootstrapping} bootstrapping)`);
    } catch (err: any) {
        log.warn(`Target cache refresh failed: ${err.message}`);
    }
}

export function isTargetCached(userId: string): boolean {
    return activeTargetSet.has(userId);
}

export function getActiveTargetCount(): number {
    return activeTargetSet.size;
}

/** IANA timezone for a target. Returns "UTC" for unknown targets so analysers
 *  never blow up on a missing row mid-removal. */
export function getTargetTimezone(targetId: string): string {
    return targetTimezones.get(targetId) ?? "UTC";
}

/** Epoch ms when the target finished its onboarding bootstrap, or null when
 *  bootstrap is still pending. Unknown targets get `null` (treated as
 *  bootstrapping) so a race between target-removal and a tail event suppresses
 *  rather than fires alerts. */
export function getBootstrapCompletedAt(targetId: string): number | null {
    return targetBootstrapAt.get(targetId) ?? null;
}

/** True when the target's onboarding bootstrap is still in progress (or the
 *  target isn't in the cache at all). While true:
 *    • PROFILE_UPDATE / AVATAR_CHANGE / USERNAME_CHANGE events are suppressed
 *    • alerts/engine.ts:evaluateEvent early-returns
 *    • analyzers/anomaly-detector.ts returns an empty array
 *  See architecture.md "Target onboarding pipeline". */
export function isBootstrapping(targetId: string): boolean {
    return targetBootstrapAt.get(targetId) == null;
}

/** Persist bootstrap completion + update the in-memory cache atomically.
 *  Idempotent — re-marking an already-operational target is a no-op (the SQL
 *  guard `AND bootstrap_completed_at IS NULL` keeps the original timestamp).
 *  Returns true when this call actually flipped the target, false when it was
 *  already operational. */
export function markBootstrapComplete(targetId: string, timestamp = Date.now()): boolean {
    const result = getStmts().completeBootstrap.run(timestamp, targetId);
    if (result.changes === 0) {
        // Already operational. Make sure the cache reflects whatever the DB
        // currently holds (defensive against split-brain after a manual SQL
        // edit) — and report no change so callers don't double-log.
        const row = getStmts().getBootstrapCompletedAt.get(targetId) as { bootstrap_completed_at: number | null } | undefined;
        if (row && row.bootstrap_completed_at != null) {
            targetBootstrapAt.set(targetId, row.bootstrap_completed_at);
        }
        return false;
    }
    targetBootstrapAt.set(targetId, timestamp);
    log.info(`Target ${targetId} bootstrap complete — alerts + anomalies now active`);
    return true;
}

// ── Lifecycle cleanup ────────────────────────────────────────────────────────

export function onTargetRemoved(userId: string): void {
    // Cancel backfill FIRST so the in-flight loop sees the flag before the
    // collectors lose their state. If we cleared collectors first, the next
    // backfill page would call handleMessageCreate, the FK-cascade would have
    // already nuked the targets row, and the insert would silently fail.
    try { cancelBackfill(userId); }              catch (err: any) { log.warn(`backfill cancel: ${err.message}`); }
    try { removeFromPresence(userId); }          catch (err: any) { log.warn(`presence cleanup: ${err.message}`); }
    try { removeFromActivity(userId); }          catch (err: any) { log.warn(`activity cleanup: ${err.message}`); }
    try { removeFromVoice(userId); }             catch (err: any) { log.warn(`voice cleanup: ${err.message}`); }
    try { removeFromTyping(userId); }            catch (err: any) { log.warn(`typing cleanup: ${err.message}`); }
    try { removeFromGuildMember(userId); }       catch (err: any) { log.warn(`guild-member cleanup: ${err.message}`); }
    try { removeFromTargetProfilePoller(userId); } catch (err: any) { log.warn(`target-profile poller cleanup: ${err.message}`); }
    try { removeFromAlertEngine(userId); }       catch (err: any) { log.warn(`alert-engine cleanup: ${err.message}`); }
    try { invalidateSocialGraphCache(userId); }  catch (err: any) { log.warn(`social-graph cache cleanup: ${err.message}`); }
    // Drop from the active-target cache too — caller already removed the SQL
    // row, but we don't refresh from the DB here to avoid an extra round-trip
    // when several deletes land in close succession.
    activeTargetSet.delete(userId);
    targetTimezones.delete(userId);
    targetBootstrapAt.delete(userId);
    log.debug(`In-memory state cleared for target ${userId}`);
}
