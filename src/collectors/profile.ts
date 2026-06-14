import { createLogger } from "../utils/logger";
import { getStmts } from "../database/queries";
import { evaluateEvent } from "../alerts/engine";
import { pushSSEEvent } from "../api/routes/events";
import { isBootstrapping } from "../target-lifecycle";

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

    // Every field comparison requires BOTH the old and the new value to be
    // non-null before it counts as a change. A `null → value` transition is
    // the signature of an incomplete first observation (GUILD_MEMBERS_CHUNK
    // gives us the basic user object without bio/pronouns/banner; the full
    // /users/{id}/profile fills those in on the next poll). Treating that as
    // a real change produced phantom PROFILE_UPDATE events on every onboarding
    // and after every snapshot DB restore — closed permanently here. The
    // bootstrap suppression in handleProfileUpdate is belt-and-suspenders.
    const changes: string[] = [];
    if (lastSnapshot) {
        if (lastSnapshot.username && username && lastSnapshot.username !== username) {
            changes.push(`username: ${lastSnapshot.username} -> ${username}`);
        }
        if (lastSnapshot.global_name && globalName && lastSnapshot.global_name !== globalName) {
            changes.push(`displayName: ${lastSnapshot.global_name} -> ${globalName}`);
        }
        if (lastSnapshot.avatar_hash && avatarHash && lastSnapshot.avatar_hash !== avatarHash) {
            changes.push("avatar changed");
        }
        if (lastSnapshot.banner_hash && bannerHash && lastSnapshot.banner_hash !== bannerHash) {
            changes.push("banner changed");
        }
        if (lastSnapshot.bio && bio && lastSnapshot.bio !== bio) {
            changes.push("bio changed");
        }
        if (lastSnapshot.pronouns && pronouns && lastSnapshot.pronouns !== pronouns) {
            changes.push(`pronouns: ${lastSnapshot.pronouns} -> ${pronouns}`);
        }
        if (lastSnapshot.discriminator && discriminator && lastSnapshot.discriminator !== discriminator) {
            changes.push(`discriminator: ${lastSnapshot.discriminator} -> ${discriminator}`);
        }

        // Only diff connected accounts when this update actually provided them.
        // `undefined` means the caller (GUILD_MEMBERS_CHUNK, basic /users/{id})
        // didn't include connected accounts — skip the diff entirely.
        // `[]` means Discord explicitly said "no connected accounts" — diff normally.
        if (connectedAccounts !== undefined && lastSnapshot.connected_accounts) {
            try {
                const oldAccounts = JSON.parse(lastSnapshot.connected_accounts);
                const newAccounts = connectedAccounts;
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

        // During the onboarding bootstrap phase, snapshots are still recorded
        // but no PROFILE_UPDATE / AVATAR_CHANGE / USERNAME_CHANGE events get
        // emitted — the first observations of bio/banner/pronouns/etc. arrive
        // in stages from different fetch paths and any "change" they generate
        // is an artefact of incomplete data, not a real user action. Once the
        // first successful profile poll lands, markBootstrapComplete() flips
        // isBootstrapping(targetId) to false and subsequent runs emit normally.
        if (isBootstrapping(targetId)) {
            log.debug(`${targetId}: snapshot stored during bootstrap (events suppressed)`);
            return;
        }

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