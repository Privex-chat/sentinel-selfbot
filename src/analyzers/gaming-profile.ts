import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("GamingProfile");

export interface GameStats {
    name: string;
    totalPlaytimeMs: number;
    sessionCount: number;
    avgSessionMs: number;
    firstPlayed: number;
    lastPlayed: number;
    peakHour: number;
    peakDay: number;
}

export interface GamingProfileData {
    games: GameStats[];
    totalGamingMs: number;
    peakGamingHour: number;
    recentlyStarted: string[];
    abandoned: string[];
}

export function analyzeGamingProfile(targetId: string, days: number = 90): GamingProfileData {
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;
    const sessions = stmts.getActivitySessions.all(targetId, since, 10000) as any[];

    // Filter to gaming only (type 0 = Playing)
    const gameSessions = sessions.filter((s: any) => s.activity_type === 0);
    const gameMap: Map<string, { sessions: any[]; hours: number[]; days: number[] }> = new Map();

    for (const s of gameSessions) {
        const name = s.activity_name;
        if (!gameMap.has(name)) {
            gameMap.set(name, { sessions: [], hours: [], days: [] });
        }
        const g = gameMap.get(name)!;
        g.sessions.push(s);
        g.hours.push(new Date(s.start_time).getHours());
        g.days.push(new Date(s.start_time).getDay());
    }

    const games: GameStats[] = [];
    const hourCounts = new Array(24).fill(0);

    for (const [name, data] of gameMap) {
        const totalMs = data.sessions.reduce((sum: number, s: any) => sum + (s.duration_ms || 0), 0);
        const first = Math.min(...data.sessions.map((s: any) => s.start_time));
        const last = Math.max(...data.sessions.map((s: any) => s.start_time));

        // Peak hour for this game
        const hCounts = new Array(24).fill(0);
        data.hours.forEach(h => { hCounts[h]++; hourCounts[h]++; });
        const peakHour = hCounts.indexOf(Math.max(...hCounts));

        const dCounts = new Array(7).fill(0);
        data.days.forEach(d => dCounts[d]++);
        const peakDay = dCounts.indexOf(Math.max(...dCounts));

        games.push({
            name,
            totalPlaytimeMs: totalMs,
            sessionCount: data.sessions.length,
            avgSessionMs: data.sessions.length > 0 ? Math.round(totalMs / data.sessions.length) : 0,
            firstPlayed: first,
            lastPlayed: last,
            peakHour,
            peakDay,
        });
    }

    games.sort((a, b) => b.totalPlaytimeMs - a.totalPlaytimeMs);

    // Recently started games (first played within last 7 days)
    const weekAgo = Date.now() - 7 * 86400000;
    const recentlyStarted = games.filter(g => g.firstPlayed >= weekAgo).map(g => g.name);

    // Abandoned games (not played in last 14 days but played before)
    const twoWeeksAgo = Date.now() - 14 * 86400000;
    const abandoned = games.filter(g => g.lastPlayed < twoWeeksAgo && g.sessionCount > 2).map(g => g.name);

    return {
        games,
        totalGamingMs: games.reduce((sum, g) => sum + g.totalPlaytimeMs, 0),
        peakGamingHour: hourCounts.indexOf(Math.max(...hourCounts)),
        recentlyStarted,
        abandoned,
    };
}
