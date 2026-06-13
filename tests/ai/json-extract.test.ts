import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractJsonObject, extractJsonArray } from "../../src/ai/json-extract";

describe("extractJsonObject — happy path", () => {
    it("parses a clean object", () => {
        assert.deepEqual(extractJsonObject('{"a": 1, "b": "x"}'), { a: 1, b: "x" });
    });

    it("parses nested objects", () => {
        assert.deepEqual(
            extractJsonObject('{"outer": {"inner": [1, 2]}}'),
            { outer: { inner: [1, 2] } }
        );
    });
});

describe("extractJsonObject — code fences", () => {
    it("strips ```json fences", () => {
        assert.deepEqual(extractJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
    });

    it("strips bare ``` fences", () => {
        assert.deepEqual(extractJsonObject('```\n{"a": 1}\n```'), { a: 1 });
    });
});

describe("extractJsonObject — leading prose", () => {
    it("ignores text before the object", () => {
        assert.deepEqual(extractJsonObject('Here it is: {"a": 1}'), { a: 1 });
    });

    it("handles preamble + fences combined", () => {
        assert.deepEqual(
            extractJsonObject('Result:\n```json\n{"verdict": "ok"}\n```'),
            { verdict: "ok" }
        );
    });
});

describe("extractJsonObject — common LLM quirks", () => {
    it("repairs trailing comma", () => {
        assert.deepEqual(extractJsonObject('{"a": 1,}'), { a: 1 });
    });

    it("strips // single-line comments", () => {
        assert.deepEqual(extractJsonObject('{"a": 1 // note\n}'), { a: 1 });
    });

    it("strips /* block */ comments", () => {
        assert.deepEqual(extractJsonObject('{"a": 1 /* skip me */}'), { a: 1 });
    });

    it("converts `undefined` value to null", () => {
        assert.deepEqual(extractJsonObject('{"a": undefined}'), { a: null });
    });

    it("trims extra closing brace", () => {
        assert.deepEqual(extractJsonObject('{"a": 1}}'), { a: 1 });
    });

    it("closes truncated object", () => {
        assert.deepEqual(extractJsonObject('{"a": 1, "b": "x"'), { a: 1, b: "x" });
    });

    it("normalises CRLF line endings", () => {
        assert.deepEqual(extractJsonObject('{"a":\r\n1}'), { a: 1 });
    });
});

describe("extractJsonArray", () => {
    it("parses a clean array", () => {
        assert.deepEqual(extractJsonArray("[1, 2, 3]"), [1, 2, 3]);
    });

    it("strips fences around an array", () => {
        assert.deepEqual(extractJsonArray('```json\n[{"x": 1}]\n```'), [{ x: 1 }]);
    });

    it("repairs trailing comma in array", () => {
        assert.deepEqual(extractJsonArray("[1, 2, 3,]"), [1, 2, 3]);
    });

    it("closes truncated array", () => {
        assert.deepEqual(extractJsonArray('[{"a": 1}, {"b": 2}'), [{ a: 1 }, { b: 2 }]);
    });
});
