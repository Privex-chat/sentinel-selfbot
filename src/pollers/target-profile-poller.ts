/**
 * Consolidated target-profile poller.
 *
 * Replaces three independent pollers (profile, mutual-servers, connected-accounts)
 * that each fetched the SAME Discord endpoint (`/users/{id}/profile?with_mutual_guilds=true`)
 * on different cadences. Result: ~3× wasted requests against a single endpoint,
 * with the highest request density falling on `/users/{id}/profile` — exactly
 * the path where sustained throughput most reliably trips Discord's automation
 * heuristics.
 *
 * New flow: one fetch per target per cycle, then three in-process diffs run
 * against the same payload:
 *   1. Profile snapshot (username / avatar / bio / pronouns / etc.) — emits
 *      PROFILE_UPDATE / AVATAR_CHANGE / USERNAME_CHANGE events.
 *   2. Mutual guild list — emits SERVER_JOIN / SERVER_LEAVE events.
 *   3. Connected accounts list — emits ACCOUNT_CONNECTED / ACCOUNT_DISCONNECTED.
 *
 * Failure handling: a single endpoint shared by three diffs is also a single
 * point of failure. To keep the operator informed:
 *   - Per-target consecutive-failure counter.
 *   - After FAILURE_THRESHOLD strikes, the target enters a per-target backoff
 *     (next poll is skipped for one full interval — effectively half cadence)
 *     and a critical webhook fires ONCE per streak.
 *   - First successful poll clears the streak, releases the backoff, and posts
 *     a recovery notice if the operator was previously alerted.
 *
 * The consolidated poller runs at config.profilePollIntervalMs (default 5 min).
 * Guild- and account-diff cadences therefore TIGHTEN from 30 min to 5 min,
 * which means faster detection of joins / leaves / connections — at zero
 * extra Discord cost because the call was already happening.
 */

import { createLogger } from "../utils/logger";
import { config } from "../utils/config";
import { withJitter } from "../utils/jitter";
import { discordFetch } from "../utils/rate-limiter";
import { getStmts } from "../database/queries";
import { handleProfileUpdate } from "../collectors/profile";
import { pushSSEEvent } from "../api/routes/events";
import { notifyCriticalError } from "../utils/webhook-notifier";
import { isBootstrapping, markBootstrapComplete } from "../target-lifecycle";

const log = createLogger("TargetProfilePoller");

// Per-target consecutive-failure tolerance before we alert and back off.
// Streaks under this are treated as transient — Discord 5xx / network blips
// happen and a chatty webhook is worse than no webhook.
const FAILURE_THRESHOLD = 5;

// 3 s base inter-target stagger inside a single cycle, matching the cadence
// used by the previous three pollers. Lower values bunch the requests close
// together which is exactly the burst pattern abuse-detection flags.
const INTER_TARGET_STAGGER_MS = 3_000;

let intervalHandle:    NodeJS.Timeout | null = null;
let firstPollTimeout:  NodeJS.Timeout | null = null;

// ── Per-target diff state ────────────────────────────────────────────────────
const lastKnownGuildIds: Map<string, Set<string>>          = new Map();
const lastKnownAccounts: Map<string, Map<string, any>>     = new Map();

// ── Failure tracking ─────────────────────────────────────────────────────────
const consecutiveFailures:    Map<string, number> = new Map();
const nextEligibleAt:         Map<string, number> = new Map();
const failureNotifiedTargets: Set<string>         = new Set();

function shouldPoll(targetId: string): boolean {
    const next = nextEligibleAt.get(targetId);
    return next === undefined || Date.now() >= next;
}

function recordSuccess(targetId: string): void {
    const wasFailing = (consecutiveFailures.get(targetId) ?? 0) >= FAILURE_THRESHOLD;
    consecutiveFailures.delete(targetId);
    nextEligibleAt.delete(targetId);

    if (failureNotifiedTargets.has(targetId)) {
        failureNotifiedTargets.delete(targetId);
        log.info(`Target ${targetId} profile poll recovered after a failing streak`);
        // Quiet recovery notice so the operator who got the critical alert
        // knows the issue self-resolved. Routed through the critical webhook
        // for symmetry with the failure path.
        notifyCriticalError(
            `Profile poll recovered for target ${targetId}. Stream resumed.`,
            undefined,
            "Profile Poller Recovery"
        );
    } else if (wasFailing) {
        // Crossed the streak threshold but the notification flag was somehow
        // missing (e.g. process restart mid-streak). Reset quietly.
        log.info(`Target ${targetId} profile poll recovered`);
    }
}

function recordFailure(targetId: string, reason: string): void {
    const n = (consecutiveFailures.get(targetId) ?? 0) + 1;
    consecutiveFailures.set(targetId, n);

    if (n < FAILURE_THRESHOLD) {
        log.warn(`Profile poll failure ${n}/${FAILURE_THRESHOLD} for ${targetId}: ${reason}`);
        return;
    }

    // Per-target back-off: skip one full interval so the next cycle doesn't
    // re-poll this target while it's broken. Halves the call rate against
    // the broken target without affecting any healthy ones.
    nextEligibleAt.set(targetId, Date.now() + config.profilePollIntervalMs);

    if (!failureNotifiedTargets.has(targetId)) {
        failureNotifiedTargets.add(targetId);
        notifyCriticalError(
            `Profile poll has failed ${n} consecutive times for target ${targetId}. ` +
            `Latest reason: ${reason}. Backing off to half cadence until a poll succeeds.`,
            undefined,
            "Profile Poller"
        );
        log.error(
            `Target ${targetId} crossed failure threshold (${n} consecutive). ` +
            `Critical webhook fired, half-cadence backoff engaged.`
        );
    } else {
        log.warn(`Target ${targetId} still failing (${n} consecutive): ${reason}`);
    }
}

// ── Diffs ────────────────────────────────────────────────────────────────────

/** Profile-snapshot diff. handleProfileUpdate is the existing collector; pass
 *  the full payload so it can compute its own diff against the latest snapshot. */
function runProfileSnapshot(targetId: string, data: any): void {
    handleProfileUpdate(
        targetId,
        data.user,
        data.user_profile,
        data.connected_accounts,
        data.mutual_guilds
    );
}

/** Mutual-server diff. Emits SERVER_JOIN / SERVER_LEAVE. Seeds the in-memory
 *  guild set from the latest snapshot on first sight so a restart doesn't
 *  spuriously re-emit JOIN for every existing guild. */
function runGuildDiff(targetId: string, data: any): void {
    const stmts = getStmts();
    const now = Date.now();
    const newGuilds: { id: string; nick?: string }[] = data.mutual_guilds || [];

    if (!lastKnownGuildIds.has(targetId)) {
        const snap = stmts.getLatestSnapshot.get(targetId) as any;
        let seed: { id: string }[] = [];
        if (snap?.mutual_guilds) {
            try { seed = JSON.parse(snap.mutual_guilds); } catch { /* malformed — start empty */ }
        }
        lastKnownGuildIds.set(targetId, new Set(seed.map(g => g.id)));
    }

    const oldIds = lastKnownGuildIds.get(targetId)!;
    const newIds = new Set(newGuilds.map(g => g.id));

    for (const guild of newGuilds) {
        if (!oldIds.has(guild.id)) {
            const payload = { guildId: guild.id };
            stmts.insertEvent.run(targetId, "SERVER_JOIN", now, JSON.stringify(payload), guild.id, null);
            stmts.insertGuildMemberEvent.run(targetId, guild.id, "SERVER_JOIN", now, null, null);
            pushSSEEvent({
                target_id:  targetId,
                event_type: "SERVER_JOIN",
                timestamp:  now,
                data:       payload,
            });
            log.info(`${targetId}: joined server ${guild.id}`);
        }
    }

    for (const id of oldIds) {
        if (!newIds.has(id)) {
            const payload = { guildId: id };
            stmts.insertEvent.run(targetId, "SERVER_LEAVE", now, JSON.stringify(payload), id, null);
            stmts.insertGuildMemberEvent.run(targetId, id, "SERVER_LEAVE", now, null, null);
            pushSSEEvent({
                target_id:  targetId,
                event_type: "SERVER_LEAVE",
                timestamp:  now,
                data:       payload,
            });
            log.info(`${targetId}: left server ${id}`);
        }
    }

    lastKnownGuildIds.set(targetId, newIds);
}

/** Connected-accounts diff. Emits ACCOUNT_CONNECTED / ACCOUNT_DISCONNECTED.
 *  Keyed by `type:id-or-name` because some platforms (e.g. Steam) reuse names. */
function runConnectedAccountsDiff(targetId: string, data: any): void {
    const stmts = getStmts();
    const now = Date.now();
    const newAccounts: any[] = data.connected_accounts || [];

    if (!lastKnownAccounts.has(targetId)) {
        const snap = stmts.getLatestSnapshot.get(targetId) as any;
        let seed: any[] = [];
        if (snap?.connected_accounts) {
            try { seed = JSON.parse(snap.connected_accounts); } catch { /* malformed */ }
        }
        lastKnownAccounts.set(targetId, new Map(seed.map((a: any) => [`${a.type}:${a.id || a.name}`, a])));
    }

    const oldKeyed = lastKnownAccounts.get(targetId)!;
    const newKeyed = new Map(newAccounts.map((a: any) => [`${a.type}:${a.id || a.name}`, a]));

    for (const [key, account] of newKeyed) {
        if (!oldKeyed.has(key)) {
            const payload = {
                type:       account.type,
                name:       account.name,
                id:         account.id,
                verified:   account.verified,
                visibility: account.visibility,
            };
            stmts.insertEvent.run(targetId, "ACCOUNT_CONNECTED", now, JSON.stringify(payload), null, null);
            pushSSEEvent({
                target_id:  targetId,
                event_type: "ACCOUNT_CONNECTED",
                timestamp:  now,
                data:       payload,
            });
            log.info(`${targetId}: connected ${account.type} account "${account.name}"`);
        }
    }

    for (const [key, account] of oldKeyed) {
        if (!newKeyed.has(key)) {
            const payload = { type: account.type, name: account.name, id: account.id };
            stmts.insertEvent.run(targetId, "ACCOUNT_DISCONNECTED", now, JSON.stringify(payload), null, null);
            pushSSEEvent({
                target_id:  targetId,
                event_type: "ACCOUNT_DISCONNECTED",
                timestamp:  now,
                data:       payload,
            });
            log.info(`${targetId}: disconnected ${account.type} account "${account.name}"`);
        }
    }

    lastKnownAccounts.set(targetId, newKeyed);
}

// ── Single-target poll ────────────────────────────────────────────────────────

/**
 * Run the per-target profile poll. `skipFailureBackoff` is used by the
 * immediate post-`$add` `bootstrapTargetNow()` path so a brand-new target
 * doesn't accidentally inherit a cooldown from a previous tenant of the
 * same userId — outside that path the regular backoff still applies.
 *
 * Side effect on success: if the target is still in the onboarding
 * bootstrap phase, flips them to operational via markBootstrapComplete().
 * That unsuppresses alerts + anomalies for the next event.
 */
async function pollTarget(targetId: string, opts: { skipFailureBackoff?: boolean } = {}): Promise<void> {
    if (!opts.skipFailureBackoff && !shouldPoll(targetId)) {
        log.debug(`${targetId}: in failure backoff — skipping this cycle`);
        return;
    }

    try {
        const res = await discordFetch(
            `/users/${targetId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`,
            config.discordToken
        );

        if (res.status === 404) {
            // No mutual servers with this target — full profile endpoint refuses.
            // Fall back to basic /users/{id} so username/avatar still flow. The
            // guild and account diffs simply don't run this cycle (no fresh data).
            log.debug(`${targetId}: profile 404 — falling back to basic /users endpoint`);
            const basicRes = await discordFetch(`/users/${targetId}`, config.discordToken);
            if (!basicRes.ok) {
                recordFailure(targetId, `basic users endpoint returned ${basicRes.status}`);
                return;
            }
            const userData = await basicRes.json() as any;
            // undefined for the optional fields → handleProfileUpdate preserves
            // the existing snapshot's connected_accounts and mutual_guilds.
            handleProfileUpdate(targetId, userData, undefined, undefined, undefined);
            recordSuccess(targetId);
            completeBootstrapIfPending(targetId, "basic /users fallback");
            return;
        }

        if (!res.ok) {
            recordFailure(targetId, `HTTP ${res.status}`);
            return;
        }

        const data = await res.json() as any;

        // Order matters slightly: snapshot first so handleProfileUpdate stores
        // the fresh mutual_guilds / connected_accounts BEFORE the diffs read
        // their previous values. Diffs then use their in-memory caches (which
        // pre-date this fetch) to detect deltas.
        runProfileSnapshot(targetId, data);
        runGuildDiff(targetId, data);
        runConnectedAccountsDiff(targetId, data);

        recordSuccess(targetId);
        completeBootstrapIfPending(targetId, "full profile fetch");
    } catch (err: any) {
        recordFailure(targetId, err.message);
    }
}

/** Promote the target from bootstrap → operational once a profile fetch
 *  (full or basic-fallback) has actually landed. Idempotent. */
function completeBootstrapIfPending(targetId: string, source: string): void {
    if (!isBootstrapping(targetId)) return;
    const flipped = markBootstrapComplete(targetId);
    if (flipped) {
        log.info(`${targetId}: onboarding bootstrap complete via ${source}`);
    }
}

// ── All-targets cycle ────────────────────────────────────────────────────────

async function pollAllTargets(): Promise<void> {
    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as { user_id: string }[];

    log.debug(`Polling profile data for ${targets.length} target(s)`);

    for (const target of targets) {
        await pollTarget(target.user_id);
        // Inter-target stagger with ±20% jitter. Matches the cadence of the
        // previous three pollers individually — Discord-side request rate is
        // unchanged at one request per target per stagger window, except now
        // it covers all three signals at once instead of producing three
        // independent bursts at different intervals.
        await new Promise(resolve => setTimeout(resolve, withJitter(INTER_TARGET_STAGGER_MS)));
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function startTargetProfilePoller(): void {
    log.info(
        `Starting consolidated target-profile poller (interval: ${config.profilePollIntervalMs}ms). ` +
        `One Discord fetch per target per cycle drives profile + guild + account diffs.`
    );

    const scheduleNext = () => {
        intervalHandle = setTimeout(async () => {
            await pollAllTargets();
            scheduleNext();
        }, withJitter(config.profilePollIntervalMs));
    };

    // Initial poll after 30 s so mutual_guilds are available before the status
    // poller's first cycle at 90 s.
    firstPollTimeout = setTimeout(async () => {
        firstPollTimeout = null;
        await pollAllTargets();
        scheduleNext();
    }, 30_000);
}

export function stopTargetProfilePoller(): void {
    if (firstPollTimeout) {
        clearTimeout(firstPollTimeout);
        firstPollTimeout = null;
    }
    if (intervalHandle) {
        clearTimeout(intervalHandle);
        intervalHandle = null;
    }
    log.info("Target-profile poller stopped");
}

/**
 * Run one immediate profile fetch for a newly-added target, outside the regular
 * cycle. Used by `POST /api/targets` and `$add` so a fresh target lands in
 * operational mode within seconds rather than waiting up to PROFILE_POLL_INTERVAL_MS
 * for the next cycle to complete its bootstrap.
 *
 * Fire-and-forget — the caller doesn't await. Errors are swallowed and logged
 * (the recurring poll plus the 30-min stuck-bootstrap sweep will still
 * complete the target eventually if this immediate attempt fails).
 *
 * Failure backoff is skipped because a brand-new target can't be in backoff
 * yet from this process — and if the userId was previously tracked + removed
 * + re-added, the previous run's failure counter shouldn't gate the new add.
 */
export function bootstrapTargetNow(targetId: string): void {
    log.info(`${targetId}: running immediate bootstrap profile fetch`);
    pollTarget(targetId, { skipFailureBackoff: true }).catch(err => {
        log.warn(`Immediate bootstrap profile fetch failed for ${targetId}: ${err?.message ?? err}`);
    });
}

/** Drop every per-target cache and failure-tracking entry for this target.
 *  Wired into target-lifecycle.onTargetRemoved. */
export function removeTargetState(targetId: string): void {
    lastKnownGuildIds.delete(targetId);
    lastKnownAccounts.delete(targetId);
    consecutiveFailures.delete(targetId);
    nextEligibleAt.delete(targetId);
    failureNotifiedTargets.delete(targetId);
}

/** Snapshot of per-target poller health. Surfaced for the future /api/status
 *  endpoint and useful in tests; safe to call at any time. */
export function getPollerHealth(): {
    activeFailures: number;
    notifiedTargets: number;
    backedOffTargets: number;
} {
    return {
        activeFailures:    consecutiveFailures.size,
        notifiedTargets:   failureNotifiedTargets.size,
        backedOffTargets:  nextEligibleAt.size,
    };
}
