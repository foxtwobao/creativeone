import { test } from "node:test";
import assert from "node:assert/strict";
import { modelErrorMessage, tokenoneError } from "./model-errors.js";

test("balance failures preserve the specific reason without exposing provider text", async () => {
    const error = await tokenoneError(Response.json({ code: "INSUFFICIENT_BALANCE", message: "secret provider details" }, { status: 403 }));
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.match(modelErrorMessage(error.code)!, /余额不足/);
    assert.doesNotMatch(modelErrorMessage(error.code)!, /secret/);
});
test("nested key and subscription errors remain distinct", async () => {
    for (const code of ["API_KEY_DISABLED", "API_KEY_EXPIRED", "TOKENONE_GROUP_FORBIDDEN", "SUBSCRIPTION_NOT_FOUND"]) {
        assert.equal((await tokenoneError(Response.json({ error: { code, message: "private" } }, { status: 403 }))).code, code);
        assert.ok(modelErrorMessage(code));
    }
});
test("unknown 403 is not misreported as insufficient balance", async () => {
    const error = await tokenoneError(Response.json({ code: "sk-private", message: "secret" }, { status: 403 }));
    assert.equal(error.code, "TOKENONE_HTTP_403");
    assert.doesNotMatch(modelErrorMessage(error.code)!, /余额不足|sk-private|secret/);
});
test("HTML, malformed JSON and missing bodies use safe status messages", async () => {
    for (const body of ["<html>internal secret</html>", "{", ""]) {
        const error = await tokenoneError(new Response(body, { status: 503 }));
        assert.equal(error.code, "TOKENONE_HTTP_503");
        assert.ok(modelErrorMessage(error.code));
    }
});
test("upstream authentication failures are not mistaken for an expired app session", async () => {
    const error = await tokenoneError(Response.json({ code: "API_KEY_DISABLED" }, { status: 401 }));
    assert.equal(error.status, 502);
    assert.equal(error.code, "API_KEY_DISABLED");
});
