import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("MusicProfile");

export interface MusicProfileData {
    topArtists: { name: string; listens: number; totalMs: number }[];
    topSongs: { name: string; artist: string; listens: number }[];
    totalListeningMs: number;
    listeningByHour: number[];
    sessionCount: number;
    avgSessionMs: number;
    recentTrack: { song: string; artist: string; album: string } | null;
}

export function analyzeMusicProfile(targetId: string, days: number = 30): MusicProfileData {
    const stmts = getStmts();
    const since = Date.now() - days * 86400000;

    const sessions = stmts.getActivitySessions.all(targetId, since, 10000) as any[];
    const spotifySessions = sessions.filter((s: any) => s.activity_type === 2);

    const artists: Map<string, { listens: number; totalMs: number }> = new Map();
    const songs: Map<string, { artist: string; listens: number }> = new Map();
    const byHour = new Array(24).fill(0);
    let totalMs = 0;

    for (const s of spotifySessions) {
        const artist = s.state || "Unknown Artist";
        const song = s.details || "Unknown Song";
        const duration = s.duration_ms || 0;
        totalMs += duration;

        const hour = new Date(s.start_time).getHours();
        byHour[hour]++;

        const a = artists.get(artist) || { listens: 0, totalMs: 0 };
        a.listens++;
        a.totalMs += duration;
        artists.set(artist, a);

        const songKey = `${song}::${artist}`;
        const sg = songs.get(songKey) || { artist, listens: 0 };
        sg.listens++;
        songs.set(songKey, sg);
    }

    const topArtists = [...artists.entries()]
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.listens - a.listens)
        .slice(0, 20);

    const topSongs = [...songs.entries()]
        .map(([key, data]) => ({ name: key.split("::")[0], ...data }))
        .sort((a, b) => b.listens - a.listens)
        .slice(0, 20);

    let recentTrack = null;
    if (spotifySessions.length > 0) {
        const latest = spotifySessions[0];
        let album = "";
        try {
            const meta = JSON.parse(latest.metadata || "{}");
            album = meta.assets?.large_text || "";
        } catch { }
        recentTrack = {
            song: latest.details || "Unknown",
            artist: latest.state || "Unknown",
            album,
        };
    }

    return {
        topArtists,
        topSongs,
        totalListeningMs: totalMs,
        listeningByHour: byHour,
        sessionCount: spotifySessions.length,
        avgSessionMs: spotifySessions.length > 0 ? Math.round(totalMs / spotifySessions.length) : 0,
        recentTrack,
    };
}
