import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeLikePattern } from "../../src/utils/like-escape";

describe("escapeLikePattern", () => {
    it("returns plain text unchanged", () => {
        assert.equal(escapeLikePattern("hello world"), "hello world");
    });

    it("escapes a percent sign", () => {
        assert.equal(escapeLikePattern("100%"), "100\\%");
    });

    it("escapes an underscore", () => {
        assert.equal(escapeLikePattern("a_b"), "a\\_b");
    });

    it("escapes backslash itself", () => {
        assert.equal(escapeLikePattern("a\\b"), "a\\\\b");
    });

    it("escapes multiple special chars in mixed order", () => {
        assert.equal(escapeLikePattern("%_\\"), "\\%\\_\\\\");
    });

    it("handles empty string", () => {
        assert.equal(escapeLikePattern(""), "");
    });

    it("leaves non-LIKE special chars alone", () => {
        assert.equal(escapeLikePattern("foo*bar?baz[qux]"), "foo*bar?baz[qux]");
    });
});
