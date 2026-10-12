import { test } from "node:test";
import assert from "node:assert/strict";
import { modelErrorMessage, taskErrorMessage, tokenoneError, upstreamErrorDetails } from "./model-errors.js";

test("unmapped errors expose upstream reasons without exposing credentials", async () => {
    const error = await tokenoneError(Response.json({ error: { code: "invalid_request", message: JSON.stringify({ error: { code: "InvalidSize", message: "width must be 512; api_key=private-key Bearer private-token https://user:pass@host/path?token=secret sk-example" } }) } }, { status: 400 }));
    assert.equal(error.code, "TOKENONE_HTTP_400");
    assert.equal(error.upstreamError?.code, "InvalidSize");
    assert.equal(error.upstreamError?.status, 400);
    assert.match(error.upstreamError!.message, /width must be 512/);
    assert.doesNotMatch(error.upstreamError!.message, /private-key|private-token|user:pass|token=secret|sk-example/);
    assert.match(modelErrorMessage(error.code, error.upstreamError)!, /InvalidSize.*width must be 512/);
    assert.doesNotMatch(modelErrorMessage(error.code, error.upstreamError)!, /private-key|private-token|user:pass|token=secret|sk-example/);
    const plain = await tokenoneError(new Response("provider unavailable", { status: 503 }));
    assert.equal(modelErrorMessage(plain.code, plain.upstreamError), "上游服务返回：provider unavailable");
    assert.equal(upstreamErrorDetails({ error: { code: "VideoRejected", message: "audio duration invalid" } }).message, "audio duration invalid");
});

test("New API task wrappers expose only known structured upstream codes", async () => {
    const code = "seedance_real_person_asset_required";
    for (const upstream of [{ code, message: "private" }, { error: { code, message: "private" } }]) {
        const error = await tokenoneError(Response.json({ code: "fail_to_fetch_task", message: JSON.stringify(upstream) }, { status: 400 }));
        assert.equal(error.code, code);
        assert.match(modelErrorMessage(error.code, error.upstreamError)!, /真人认证/);
        assert.doesNotMatch(modelErrorMessage(error.code, error.upstreamError)!, /private/);
    }
    const prefixed = await tokenoneError(Response.json({ code: "fail_to_fetch_task", message: `status_code=400, ${JSON.stringify({ code, error: { code } })}` }, { status: 400 }));
    assert.equal(prefixed.code, code);
    const plugin = await tokenoneError(Response.json({ error: { code: "invalid_request", message: JSON.stringify({ code, error: { code, message: "private" } }) } }, { status: 400 }));
    assert.equal(plugin.code, code);
    assert.doesNotMatch(modelErrorMessage(plugin.code)!, /private/);
    for (const message of ["{", "null", code, JSON.stringify({ code: "private", message: code })]) {
        assert.equal((await tokenoneError(Response.json({ code: "fail_to_fetch_task", message }, { status: 400 }))).code, "TOKENONE_HTTP_400");
    }
});

test("Seedance real-person asset rejection preserves the reason and hides provider text", async () => {
    const code = "seedance_real_person_asset_required";
    for (const body of [{ code, message: "private provider details" }, { error: { code, message: "private provider details" } }]) {
        const error = await tokenoneError(Response.json(body, { status: 400 }));
        assert.equal(error.code, code);
        assert.equal(error.status, 400);
        assert.match(modelErrorMessage(error.code, error.upstreamError)!, /真人认证/);
        assert.match(modelErrorMessage(error.code)!, /暂不支持认证素材/);
        assert.doesNotMatch(modelErrorMessage(error.code)!, /private provider|尺寸/);
    }
    const unknown = await tokenoneError(Response.json({ error: { message: code } }, { status: 400 }));
    assert.equal(unknown.code, "TOKENONE_HTTP_400");
});

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
test("known upstream balance rejection stays distinct from the user's balance", async () => {
    for (const suffix of ["", " (request id: upstream-123)"]) {
        const error = await tokenoneError(Response.json({ error: { message: `account balance is negative, please recharge first${suffix}` } }, { status: 403 }));
        assert.equal(error.code, "UPSTREAM_BALANCE_INSUFFICIENT");
        assert.match(modelErrorMessage(error.code)!, /上游服务账户余额不足/);
        assert.doesNotMatch(modelErrorMessage(error.code)!, /upstream-123|前往 TokenONE 充值/);
    }
    const unknown = await tokenoneError(Response.json({ error: { message: "private account balance is negative, please recharge first" } }, { status: 403 }));
    assert.equal(unknown.code, "TOKENONE_HTTP_403");
    const explicit = await tokenoneError(Response.json({ code: "INSUFFICIENT_BALANCE", error: { message: "account balance is negative, please recharge first" } }, { status: 403 }));
    assert.equal(explicit.code, "INSUFFICIENT_BALANCE");
});
test("invalid composite bindings have a precise message without exposing provider details", async () => {
    for (const suffix of ["", " (request id: trace-123)"]) {
        const error = await tokenoneError(Response.json({ error: { type: "new_api_error", message: `composite has invalid channel bindings${suffix}` } }, { status: 403 }));
        assert.equal(error.code, "TOKENONE_GROUP_BINDINGS_INVALID");
        assert.match(modelErrorMessage(error.code)!, /渠道绑定无效/);
        assert.doesNotMatch(modelErrorMessage(error.code)!, /trace-123/);
    }
    const unknown = await tokenoneError(Response.json({ error: { type: "new_api_error", message: "composite has invalid channel bindings: private details" } }, { status: 403 }));
    assert.equal(unknown.code, "TOKENONE_HTTP_403");
});
test("HTML, malformed JSON and missing bodies use safe status messages", async () => {
    for (const body of ["<html>internal secret</html>", "{", ""]) {
        const error = await tokenoneError(new Response(body, { status: 503 }));
        assert.equal(error.code, "TOKENONE_HTTP_503");
        assert.ok(modelErrorMessage(error.code));
    }
});
test("unsupported composite endpoints are distinct from account permissions", async () => {
    for (const suffix of ["", " (request id: trace-123)"]) {
        const error = await tokenoneError(Response.json({ error: { type: "new_api_error", message: `this endpoint does not support composite groups${suffix}` } }, { status: 403 }));
        assert.equal(error.code, "TOKENONE_COMPOSITE_ENDPOINT_UNSUPPORTED");
        assert.match(modelErrorMessage(error.code)!, /组合分组.*不支持此接口/);
        assert.doesNotMatch(modelErrorMessage(error.code)!, /trace-123|Key 状态/);
    }
    const unknown = await tokenoneError(Response.json({ error: { type: "new_api_error", message: "this endpoint does not support composite groups: private" } }, { status: 403 }));
    assert.equal(unknown.code, "TOKENONE_HTTP_403");
    const explicit = await tokenoneError(Response.json({ code: "API_KEY_DISABLED", error: { type: "new_api_error", message: "this endpoint does not support composite groups" } }, { status: 403 }));
    assert.equal(explicit.code, "API_KEY_DISABLED");
});
test("upstream authentication failures are not mistaken for an expired app session", async () => {
    const error = await tokenoneError(Response.json({ code: "API_KEY_DISABLED" }, { status: 401 }));
    assert.equal(error.status, 502);
    assert.equal(error.code, "API_KEY_DISABLED");
});

test("disabled generation permission is mapped and unknown provider text is returned", async () => {
    const error = await tokenoneError(Response.json({ error: { type: "permission_error", message: "Image generation is not enabled for this group" } }, { status: 403 }));
    assert.equal(error.code, "TOKENONE_GENERATION_PERMISSION_DISABLED");
    assert.match(modelErrorMessage(error.code)!, /分组未启用生成权限/);
    const unknown = await tokenoneError(Response.json({ error: { type: "permission_error", message: "private upstream details" } }, { status: 403 }));
    assert.equal(unknown.code, "TOKENONE_HTTP_403");
    assert.match(modelErrorMessage(unknown.code, unknown.upstreamError)!, /private upstream details/);
});


test("failed tasks expose stored reasons even without an error code, active tasks do not", () => {
    const upstream_error = { code: "VideoRejected", message: "audio duration invalid; api_key=private-key" };
    for (const status of ["failed", "unknown", "cancelled", "expired"]) {
        assert.match(taskErrorMessage({ status, error: null, upstream_error })!, /VideoRejected.*audio duration invalid/);
        assert.doesNotMatch(taskErrorMessage({ status, upstream_error })!, /private-key/);
    }
    for (const status of ["pending", "running", "succeeded"]) assert.equal(taskErrorMessage({ status, upstream_error }), undefined);
    assert.match(taskErrorMessage({ status: "failed", error: "TOKENONE_HTTP_400" })!, /参数/);
    assert.match(taskErrorMessage({ status: "unknown", error: "UPSTREAM_RESULT_UNKNOWN", upstream_error })!, /避免重复计费/);
    assert.match(taskErrorMessage({ status: "failed", upstream_error: { code: "seedance_real_person_asset_required", message: "private" } })!, /真人认证/);
    assert.match(modelErrorMessage("TOKENONE_HTTP_500", { message: "" })!, /暂时无法完成/);
});
