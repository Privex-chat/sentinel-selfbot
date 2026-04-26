import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("DMDetection");

export function handleChannelCreate(data: any, isTarget: (userId: string) => boolean): void {
    // type 1 = DM, type 3 = Group DM
    if (data.type !== 1 && data.type !== 3) return;

    const stmts = getStmts();
    const now = Date.now();

    const recipients: any[] = data.recipients || [];
    for (const recipient of recipients) {
        if (isTarget(recipient.id)) {
            const eventPayload = {
                channelId: data.id,
                channelType: data.type === 1 ? "DM" : "GROUP_DM",
                recipients: recipients.map((r: any) => ({ id: r.id, username: r.username })),
            };

            stmts.insertEvent.run(recipient.id, "DM_CHANNEL_OPENED", now, JSON.stringify(eventPayload), null, data.id);
            pushSSEEvent({
                target_id: recipient.id,
                event_type: "DM_CHANNEL_OPENED",
                timestamp: now,
                data: eventPayload,
            });
            log.info(`${recipient.id}: DM channel created (${data.type === 1 ? "DM" : "Group DM"})`);
        }
    }
}