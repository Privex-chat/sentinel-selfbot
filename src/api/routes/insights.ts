import { FastifyInstance } from "fastify";
import { analyzeSleepSchedule } from "../../analyzers/sleep-schedule";
import { detectRoutine } from "../../analyzers/routine-detector";
import { predictAvailability } from "../../analyzers/availability";
import { detectAnomalies } from "../../analyzers/anomaly-detector";

export function registerInsightRoutes(app: FastifyInstance): void {
    app.get<{ Params: { userId: string } }>("/api/targets/:userId/insights", async (req) => {
        const { userId } = req.params;
        const sleep = analyzeSleepSchedule(userId);
        const routine = detectRoutine(userId);
        const availability = predictAvailability(userId);
        const anomalies = detectAnomalies(userId);
        return { sleep, routine: routine.summary, availability, anomalies: anomalies.slice(0, 10) };
    });

    app.get<{ Params: { userId: string }; Querystring: { days?: string } }>("/api/targets/:userId/insights/sleep", async (req) => {
        const days = parseInt(req.query.days || "14");
        return analyzeSleepSchedule(req.params.userId, days);
    });

    app.get<{ Params: { userId: string }; Querystring: { weeks?: string } }>("/api/targets/:userId/insights/routine", async (req) => {
        const weeks = parseInt(req.query.weeks || "4");
        return detectRoutine(req.params.userId, weeks);
    });

    app.get<{ Params: { userId: string }; Querystring: { weeks?: string } }>("/api/targets/:userId/insights/availability", async (req) => {
        const weeks = parseInt(req.query.weeks || "4");
        return predictAvailability(req.params.userId, weeks);
    });

    app.get<{ Params: { userId: string }; Querystring: { days?: string } }>("/api/targets/:userId/insights/anomalies", async (req) => {
        const days = parseInt(req.query.days || "7");
        return detectAnomalies(req.params.userId, days);
    });
}
