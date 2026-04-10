import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";

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
    const connectedAccountsJson = connectedAccounts ? JSON.stringify(connectedAccounts) : null;
    const mutualGuildsJson = mutualGuilds ? JSON.stringify(mutualGuilds) : null;

    // Get latest snapshot for comparison
    const lastSnapshot = stmts.getLatestSnapshot.get(targetId) as any;

    const changes: string[] = [];
    if (lastSnapshot) {
        if (lastSnapshot.username !== username && username) changes.push(`username: ${lastSnapshot.username} -> ${username}`);
        if (lastSnapshot.global_name !== globalName) changes.push(`displayName: ${lastSnapshot.global_name} -> ${globalName}`);
        if (lastSnapshot.avatar_hash !== avatarHash) changes.push("avatar changed");
        if (lastSnapshot.banner_hash !== bannerHash && bannerHash !== null) changes.push("banner changed");
        if (lastSnapshot.bio !== bio && bio !== null) changes.push("bio changed");
        if (lastSnapshot.pronouns !== pronouns && pronouns !== null) changes.push(`pronouns: ${lastSnapshot.pronouns} -> ${pronouns}`);
        if (lastSnapshot.discriminator !== discriminator && discriminator) changes.push(`discriminator: ${lastSnapshot.discriminator} -> ${discriminator}`);

        // Connected accounts diff
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

            if (changes.some(c => c.includes("avatar"))) {
                stmts.insertEvent.run(targetId, "AVATAR_CHANGE", now, JSON.stringify({ oldHash: lastSnapshot?.avatar_hash, newHash: avatarHash }), null, null);
            }
            if (changes.some(c => c.includes("username"))) {
                stmts.insertEvent.run(targetId, "USERNAME_CHANGE", now, JSON.stringify({ old: lastSnapshot?.username, new: username }), null, null);
            }

            log.info(`${targetId}: profile updated - ${changes.join(", ")}`);
        } else {
            log.debug(`${targetId}: initial profile snapshot stored`);
        }
    }
}
