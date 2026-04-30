import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";

const log = createLogger("Profile");

export function handleProfileUpdate(targetId: string, userData: any, profileData?: any, connectedAccounts?: any[], mutualGuilds?: any[]): void {
    const stmts = getStmts();
    const now = Date.now();

    const username = userData.username || null;
    const globalName = userData.global_name || userData.globalName || null;
    const discriminator = userData.discriminator || null;
    const avatarHash = userData.avatar || null;
    const bannerHash = userData.banner || profileData?.banner || null;
    const bio = profileData?.bio || userData.bio || null;
    const pronouns = profileData?.pronouns || null;
    const accentColor = userData.accent_color ?? profileData?.accent_color ?? null;
    // Fetch last snapshot early so we can preserve fields not included in this
    // update (e.g. when the caller used the basic /users/{id} endpoint because
    // the full profile endpoint returned 404 due to no mutual servers).
    const lastSnapshot = stmts.getLatestSnapshot.get(targetId) as any;

    // Use `!== undefined` (not truthiness) so an explicit empty array is
    // written as-is, while `undefined` means "not provided — keep last value".
    const connectedAccountsJson = connectedAccounts !== undefined
        ? JSON.stringify(connectedAccounts)
        : (lastSnapshot?.connected_accounts ?? null);
    const mutualGuildsJson = mutualGuilds !== undefined
        ? JSON.stringify(mutualGuilds)
        : (lastSnapshot?.mutual_guilds ?? null);

    const changes: string[] = [];
    if (lastSnapshot) {
        if (lastSnapshot.username !== username && username) changes.push(`username: ${lastSnapshot.username} -> ${username}`);
        if (lastSnapshot.global_name !== globalName) changes.push(`displayName: ${lastSnapshot.global_name} -> ${globalName}`);
        if (lastSnapshot.avatar_hash !== avatarHash) changes.push("avatar changed");
        if (lastSnapshot.banner_hash !== bannerHash && bannerHash !== null) changes.push("banner changed");
        if (lastSnapshot.bio !== bio && bio !== null) changes.push("bio changed");
        if (lastSnapshot.pronouns !== pronouns && pronouns !== null) changes.push(`pronouns: ${lastSnapshot.pronouns} -> ${pronouns}`);
        if (lastSnapshot.discriminator !== discriminator && discriminator) changes.push(`discriminator: ${lastSnapshot.discriminator} -> ${discriminator}`);

        if (connectedAccountsJson && lastSnapshot.connected_accounts) {
            try {
                const oldAccounts = JSON.parse(lastSnapshot.connected_accounts);
                const newAccounts = connectedAccounts || [];
                const oldTypes = new Set(oldAccounts.map((a: any) => a.type));
                const newTypes = new Set(newAccounts.map((a: any) => a.type));
                for (const t of newTypes) {
                    if (!oldTypes.has(t)) changes.push(`connected: ${t}`);
                }
                for (const t of oldTypes) {
                    if (!newTypes.has(t)) changes.push(`disconnected: ${t}`);
                }
            } catch { }
        }
    }

    const hasChanges = changes.length > 0 || !lastSnapshot;

    if (hasChanges) {
        stmts.insertSnapshot.run(
            targetId, now, username, globalName, discriminator,
            avatarHash, bannerHash, bio, pronouns, accentColor,
            connectedAccountsJson, mutualGuildsJson
        );

        if (changes.length > 0) {
            const eventData = JSON.stringify({ changes });
            stmts.insertEvent.run(targetId, "PROFILE_UPDATE", now, eventData, null, null);
            evaluateEvent("PROFILE_UPDATE", targetId, eventData, now);
            pushSSEEvent({
                target_id: targetId,
                event_type: "PROFILE_UPDATE",
                timestamp: now,
                data: { changes },
            });

            if (changes.some(c => c.includes("avatar"))) {
                const avatarData = JSON.stringify({ oldHash: lastSnapshot?.avatar_hash, newHash: avatarHash });
                stmts.insertEvent.run(targetId, "AVATAR_CHANGE", now, avatarData, null, null);
                evaluateEvent("AVATAR_CHANGE", targetId, avatarData, now);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "AVATAR_CHANGE",
                    timestamp: now,
                    data: { oldHash: lastSnapshot?.avatar_hash, newHash: avatarHash },
                });
            }
            if (changes.some(c => c.includes("username"))) {
                const usernameData = JSON.stringify({ old: lastSnapshot?.username, new: username });
                stmts.insertEvent.run(targetId, "USERNAME_CHANGE", now, usernameData, null, null);
                evaluateEvent("USERNAME_CHANGE", targetId, usernameData, now);
                pushSSEEvent({
                    target_id: targetId,
                    event_type: "USERNAME_CHANGE",
                    timestamp: now,
                    data: { old: lastSnapshot?.username, new: username },
                });
            }

            log.info(`${targetId}: profile updated - ${changes.join(", ")}`);
        } else {
            log.debug(`${targetId}: initial profile snapshot stored`);
        }
    }
}