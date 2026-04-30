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
const BROWSER_PROFILES = [
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        browser_version: "133.0.0.0",
        os_version: "10",
        client_build_number: 368849,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        browser_version: "132.0.0.0",
        os_version: "10",
        client_build_number: 367905,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        browser_version: "133.0.0.0",
        os_version: "10.15.7",
        client_build_number: 368849,
    },
    {
        os: "Windows",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        browser_version: "131.0.0.0",
        os_version: "10",
        client_build_number: 366994,
    },
    {
        os: "Mac OS X",
        browser: "Chrome",
        browser_user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        browser_version: "132.0.0.0",
        os_version: "10.15.7",
        client_build_number: 367905,
    },
] as const;

/** Chosen once per process. Never re-evaluate — Discord ties sessions to this fingerprint. */
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
