import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

const log = createLogger("DMDetection");

export function handleChannelCreate(data: any, isTarget: (userId: string) => boolean): void {
    // type 1 = DM, type 3 = Group DM
    if (data.type !== 1 && data.type !== 3) return;

    const stmts = getStmts();
    const now = Date.now();

    const recipients: any[] = data.recipients || [];
    for (const recipient of recipients) {
        if (isTarget(recipient.id)) {
            const eventData = JSON.stringify({
                channelId: data.id,
                channelType: data.type === 1 ? "DM" : "GROUP_DM",
                recipients: recipients.map((r: any) => ({ id: r.id, username: r.username })),
            });

            stmts.insertEvent.run(recipient.id, "DM_CHANNEL_OPENED", now, eventData, null, data.id);
            log.info(`${recipient.id}: DM channel created (${data.type === 1 ? "DM" : "Group DM"})`);
        }
    }
}
