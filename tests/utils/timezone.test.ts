// Pure-function tests — no DB or config needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isValidTimezone,
    getPartsInTz,
    getHourInTz,
    getHourFloatInTz,
    getDayOfWeekInTz,
    getDateStrInTz,
} from "../../src/utils/timezone";

describe("isValidTimezone", () => {
    it("accepts UTC", () => {
        assert.equal(isValidTimezone("UTC"), true);
    });
    it("accepts standard IANA name", () => {
        assert.equal(isValidTimezone("America/New_York"), true);
    });
    it("accepts Europe/London", () => {
        assert.equal(isValidTimezone("Europe/London"), true);
    });
    it("rejects empty string", () => {
        assert.equal(isValidTimezone(""), false);
    });
    it("rejects nonsense", () => {
        assert.equal(isValidTimezone("Mars/Phobos"), false);
    });
    it("rejects non-string input", () => {
        // @ts-expect-error — deliberately exercising the runtime guard
        assert.equal(isValidTimezone(null), false);
    });
});

describe("getPartsInTz", () => {
    // 2026-06-13T00:00:00Z = Sat 00:00 UTC = Fri 20:00 EDT (UTC-4 during DST)
    const epoch = Date.UTC(2026, 5, 13, 0, 0, 0); // month index 5 = June

    it("UTC parts match the calendar", () => {
        const p = getPartsInTz(epoch, "UTC");
        assert.equal(p.year, 2026);
        assert.equal(p.month, 6);
        assert.equal(p.day, 13);
        assert.equal(p.hour, 0);
        assert.equal(p.minute, 0);
        assert.equal(p.weekday, 6); // Saturday
    });

    it("America/New_York shifts to previous day during DST", () => {
        const p = getPartsInTz(epoch, "America/New_York");
        assert.equal(p.day, 12);
        assert.equal(p.hour, 20);
        assert.equal(p.weekday, 5); // Friday
    });

    it("invalid tz falls back to UTC", () => {
        const p = getPartsInTz(epoch, "Not/Real");
        assert.equal(p.hour, 0);
        assert.equal(p.day, 13);
    });
});

describe("getHourInTz", () => {
    it("midnight UTC is hour 0", () => {
        assert.equal(getHourInTz(Date.UTC(2026, 0, 1, 0), "UTC"), 0);
    });

    it("noon UTC is hour 12", () => {
        assert.equal(getHourInTz(Date.UTC(2026, 0, 1, 12), "UTC"), 12);
    });

    it("respects tz offset (Tokyo +9)", () => {
        // 03:00 UTC → 12:00 in Tokyo
        assert.equal(getHourInTz(Date.UTC(2026, 0, 1, 3), "Asia/Tokyo"), 12);
    });
});

describe("getHourFloatInTz", () => {
    it("returns fractional hour for 30-minute marks", () => {
        const epoch = Date.UTC(2026, 0, 1, 14, 30);
        assert.equal(getHourFloatInTz(epoch, "UTC"), 14.5);
    });
});

describe("getDayOfWeekInTz", () => {
    it("Sunday returns 0", () => {
        // 2026-01-04 is a Sunday
        assert.equal(getDayOfWeekInTz(Date.UTC(2026, 0, 4, 12), "UTC"), 0);
    });
    it("Saturday returns 6", () => {
        // 2026-01-03 is a Saturday
        assert.equal(getDayOfWeekInTz(Date.UTC(2026, 0, 3, 12), "UTC"), 6);
    });
});

describe("getDateStrInTz", () => {
    it("formats YYYY-MM-DD", () => {
        assert.equal(getDateStrInTz(Date.UTC(2026, 0, 7, 0), "UTC"), "2026-01-07");
    });

    it("respects tz when crossing midnight", () => {
        // 2026-06-13T02:00:00Z is still 2026-06-12 in New York (UTC-4 DST)
        const epoch = Date.UTC(2026, 5, 13, 2, 0, 0);
        assert.equal(getDateStrInTz(epoch, "America/New_York"), "2026-06-12");
    });

    it("zero-pads single-digit month + day", () => {
        assert.equal(getDateStrInTz(Date.UTC(2026, 0, 1, 12), "UTC"), "2026-01-01");
    });
});

describe("DST transition handling", () => {
    // US DST 2026 spring forward: March 8 at 02:00 EST → 03:00 EDT
    it("hour just after spring-forward jumps to 3", () => {
        // 2026-03-08T07:00:00Z = 03:00 EDT (post-jump). Pre-jump would have been 02:00 EST.
        assert.equal(getHourInTz(Date.UTC(2026, 2, 8, 7, 0, 0), "America/New_York"), 3);
    });

    // US DST 2026 fall back: November 1 at 02:00 EDT → 01:00 EST
    it("hour respects fall-back to EST", () => {
        // 2026-11-01T07:00:00Z = 02:00 EST (post-fallback)
        assert.equal(getHourInTz(Date.UTC(2026, 10, 1, 7, 0, 0), "America/New_York"), 2);
    });
});
