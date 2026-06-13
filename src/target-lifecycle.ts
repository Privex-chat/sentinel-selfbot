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
import { removeTargetState as removeFromPresence } from "./collectors/presence";
import { removeTargetState as removeFromActivity } from "./collectors/activity";
import { removeTargetState as removeFromVoice } from "./collectors/voice";
import { removeTargetState as removeFromTyping } from "./collectors/typing";
import { removeTargetState as removeFromGuildMember } from "./collectors/guild-member";
import { removeTargetState as removeFromMutualServers } from "./pollers/mutual-servers";
import { removeTargetState as removeFromConnectedAccounts } from "./pollers/connected-accounts";
import { removeTargetState as removeFromAlertEngine } from "./alerts/engine";

const log = createLogger("TargetLifecycle");

export function onTargetRemoved(userId: string): void {
    try { removeFromPresence(userId); }          catch (err: any) { log.warn(`presence cleanup: ${err.message}`); }
    try { removeFromActivity(userId); }          catch (err: any) { log.warn(`activity cleanup: ${err.message}`); }
    try { removeFromVoice(userId); }             catch (err: any) { log.warn(`voice cleanup: ${err.message}`); }
    try { removeFromTyping(userId); }            catch (err: any) { log.warn(`typing cleanup: ${err.message}`); }
    try { removeFromGuildMember(userId); }       catch (err: any) { log.warn(`guild-member cleanup: ${err.message}`); }
    try { removeFromMutualServers(userId); }     catch (err: any) { log.warn(`mutual-servers cleanup: ${err.message}`); }
    try { removeFromConnectedAccounts(userId); } catch (err: any) { log.warn(`connected-accounts cleanup: ${err.message}`); }
    try { removeFromAlertEngine(userId); }       catch (err: any) { log.warn(`alert-engine cleanup: ${err.message}`); }
    log.debug(`In-memory state cleared for target ${userId}`);
}
