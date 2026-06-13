import { config } from "./config";

/**
 * Browser / OS profiles used in both the gateway IDENTIFY payload and Discord
 * REST headers (X-Super-Properties, User-Agent).
 *
 * Discord's undocumented user-account endpoints (e.g. /users/{id}/profile)
 * require these headers to return data. Without them the API returns 404 even
 * when the selfbot shares mutual servers with the target.
 *
 * The active profile is chosen ONCE at process startup so that the same
 * fingerprint is reused on every IDENTIFY, RESUME, and REST call.  Rotating
 * the profile on reconnect causes RESUME to fail with INVALID_SESSION.
 */
// Mid-2026 profile set. Bumped from the original Chrome 131-133 / Feb-2025
// build numbers, which by the audit date (2026-06-13) were >15 months stale —
// stale fingerprints are the single strongest static signal Discord's abuse
// detection uses to flag user-account sessions. Each entry pairs a plausible
// Chrome user-agent with a Discord `client_build_number` in the range Discord
// has been shipping in early-to-mid 2026.
//
// Re-baseline annually: open https://discord.com/login in a real browser,
// inspect the `X-Super-Properties` header in DevTools, decode the base64, and
// copy the current `client_build_number` / `browser_version` into one of the
// slots below. Stable channels lag a few weeks behind Chrome's bleeding edge.
const BROWSER_PROFILES = [
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7287.126 Safari/537.36",
        browser_version: "145.0.7287.126",
        os_version: "10",
        client_build_number: 481250,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7187.107 Safari/537.36",
        browser_version: "144.0.7187.107",
        os_version: "10",
        client_build_number: 477820,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7287.126 Safari/537.36",
        browser_version: "145.0.7287.126",
        os_version: "10.15.7",
        client_build_number: 481250,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.7088.83 Safari/537.36",
        browser_version: "143.0.7088.83",
        os_version: "10",
        client_build_number: 472940,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7187.107 Safari/537.36",
        browser_version: "144.0.7187.107",
        os_version: "10.15.7",
        client_build_number: 477820,
    },
] as const;

/**
 * Chosen once at module load. Never re-evaluate — Discord binds the gateway
 * session to this exact profile, so changing it mid-session invalidates RESUME
 * and produces an INVALID_SESSION. This also means changing `RANDOM_JITTER` at
 * runtime via `PATCH /api/config` will NOT pick a new profile until the
 * process restarts; if you want a fresh fingerprint, restart the bot.
 */
export const chosenProfile = config.randomJitter
    ? BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)]
    : BROWSER_PROFILES[0];

/** Returns the properties object used in gateway IDENTIFY and X-Super-Properties. */
export function getIdentifyProperties() {
    return {
        os:                  chosenProfile.os,
        browser:             chosenProfile.browser,
        device:              "",
        system_locale:       "en-US",
        browser_user_agent:  chosenProfile.browser_user_agent,
        browser_version:     chosenProfile.browser_version,
        os_version:          chosenProfile.os_version,
        referrer:            "",
        referring_domain:    "",
        release_channel:     "stable",
        client_build_number: chosenProfile.client_build_number,
        client_event_source: null,
    };
}

/**
 * Returns the base64-encoded X-Super-Properties header value.
 * Precomputed once — the profile never changes within a process lifetime.
 */
export const superPropertiesHeader: string =
    Buffer.from(JSON.stringify(getIdentifyProperties())).toString("base64");
