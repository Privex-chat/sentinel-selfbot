import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("Baseline");

export interface TargetConfigDefaults {
    social_weight_messages: number;
    social_weight_reactions: number;
    social_weight_voice_hours: number;
    social_weight_mentions: number;
    anomaly_z_threshold: number;
}

const DEFAULT_CONFIG: TargetConfigDefaults = {
    social_weight_messages: 3.0,
    social_weight_reactions: 1.0,
    social_weight_voice_hours: 5.0,
    social_weight_mentions: 2.0,
    anomaly_z_threshold: 2.0,
};

// ── Target config helper ──────────────────────────────────────────────────────

export function getTargetConfig(targetId: string): TargetConfigDefaults {
    const stmts = getStmts();
    const row = stmts.getTargetConfig.get(targetId) as any;
    if (!row) return { ...DEFAULT_CONFIG };
    return {
        social_weight_messages: row.social_weight_messages ?? DEFAULT_CONFIG.social_weight_messages,
        social_weight_reactions: row.social_weight_reactions ?? DEFAULT_CONFIG.social_weight_reactions,
        social_weight_voice_hours: row.social_weight_voice_hours ?? DEFAULT_CONFIG.social_weight_voice_hours,
        social_weight_mentions: row.social_weight_mentions ?? DEFAULT_CONFIG.social_weight_mentions,
        anomaly_z_threshold: row.anomaly_z_threshold ?? DEFAULT_CONFIG.anomaly_z_threshold,
    };
}

// ── Statistics helpers ────────────────────────────────────────────────────────

function mean(values: number[]): number {
    if (!values.length) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

function populationStdDev(values: number[], avg: number): number {
    if (values.length < 3) return 0;
    const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

// ── Z-score functions ─────────────────────────────────────────────────────────

export function computeZScore(
    targetId: string,
    metricName: string,
    observedValue: number
): number {
    const stmts = getStmts();
    const row = stmts.getBaselineMetric.get(targetId, metricName) as any;
    if (!row || row.std_deviation === 0) return 0;
    return (observedValue - row.baseline_value) / row.std_deviation;
}

export function isAnomaly(
    targetId: string,
    metricName: string,
    observedValue: number
): boolean {
    const cfg = getTargetConfig(targetId);
    return Math.abs(computeZScore(targetId, metricName, observedValue)) > cfg.anomaly_z_threshold;
}

// ── Baseline computation ──────────────────────────────────────────────────────

export function computeBaselinesForTarget(
    targetId: string,
    windowDays: number = 30
): void {
    const stmts = getStmts();
    const now = Date.now();

    const summaries = stmts.getDailySummaries.all(targetId, windowDays) as any[];
    if (!summaries.length) return;

    const metrics: Record<string, number[]> = {
        daily_online_minutes: [],
        daily_idle_minutes: [],
        daily_dnd_minutes: [],
        daily_active_minutes: [],
        daily_message_count: [],
        daily_voice_minutes: [],
        daily_ghost_type_count: [],
        daily_reaction_count: [],
    };

    // Per-DOW metrics: dow_0_active_minutes through dow_6_active_minutes
    const dowMetrics: Record<string, number[]> = {};
    for (let i = 0; i < 7; i++) dowMetrics[`dow_${i}_active_minutes`] = [];

    for (const s of summaries) {
        const active = (s.online_minutes || 0) + (s.idle_minutes || 0) + (s.dnd_minutes || 0);
        metrics.daily_online_minutes.push(s.online_minutes || 0);
        metrics.daily_idle_minutes.push(s.idle_minutes || 0);
        metrics.daily_dnd_minutes.push(s.dnd_minutes || 0);
        metrics.daily_active_minutes.push(active);
        metrics.daily_message_count.push(s.message_count || 0);
        metrics.daily_voice_minutes.push(s.voice_minutes || 0);
        metrics.daily_ghost_type_count.push(s.ghost_type_count || 0);
        metrics.daily_reaction_count.push(s.reaction_count || 0);

        // Day of week for seasonality
        const dow = new Date(s.date + "T12:00:00").getDay();
        dowMetrics[`dow_${dow}_active_minutes`].push(active);
    }

    const allMetrics = { ...metrics, ...dowMetrics };

    for (const [metricName, values] of Object.entries(allMetrics)) {
        if (!values.length) continue;
        const avg = mean(values);
        const std = populationStdDev(values, avg);
        stmts.upsertBaselineMetric.run(
            targetId, metricName, avg, std, now, windowDays
        );
    }

    log.debug(`Baselines computed for ${targetId} (${summaries.length} days)`);
}

export function runAllBaselineComputation(): void {
    const stmts = getStmts();
    const targets = stmts.getActiveTargets.all() as any[];
    log.info(`Computing behavioral baselines for ${targets.length} targets`);

    for (const target of targets) {
        try {
            computeBaselinesForTarget(target.user_id);
        } catch (err: any) {
            log.error(`Baseline computation error for ${target.user_id}: ${err.message}`);
        }
    }

    log.info("Baseline computation complete");
}
