import { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "../../utils/config";

/**
 * Constant-time token equality. Uses `crypto.timingSafeEqual` so partial-prefix
 * matches don't leak via early-exit timing. Different lengths are rejected
 * without ever calling `timingSafeEqual` (which throws on length mismatch);
 * that branch is itself fast and constant for any given expected-length value.
 */
function safeTokenEqual(submitted: string, expected: string): boolean {
    const sb = Buffer.from(submitted);
    const eb = Buffer.from(expected);
    if (sb.length !== eb.length) return false;
    return timingSafeEqual(sb, eb);
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({ error: "Missing or invalid authorization header" });
        return;
    }

    const token = authHeader.substring(7);
    // Guard against empty token (e.g. "Bearer " with nothing after the space)
    // and against an accidentally-blank API_AUTH_TOKEN matching an empty submission.
    if (!token || !config.apiAuthToken || !safeTokenEqual(token, config.apiAuthToken)) {
        reply.code(403).send({ error: "Invalid auth token" });
        return;
    }
}
