import { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../utils/config";

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({ error: "Missing or invalid authorization header" });
        return;
    }

    const token = authHeader.substring(7);
    if (token !== config.apiAuthToken) {
        reply.code(403).send({ error: "Invalid auth token" });
        return;
    }
}
