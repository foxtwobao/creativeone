import { useCloudStore } from "@/stores/use-cloud-store";
import { expect, test } from "bun:test";
import { cloudErrorMessage, needsModelAuthorization, splitErrorMessage } from "./error-message";

test("friendly text and technical details survive string-based history storage", () => {
    const value = cloudErrorMessage({ error: "INSUFFICIENT_BALANCE", message: "余额不足，请充值后重试。", requestId: "request-123" });
    const restored = splitErrorMessage(JSON.parse(JSON.stringify(value)));
    expect(restored.message).toBe("余额不足，请充值后重试。");
    expect(restored.details).toContain("INSUFFICIENT_BALANCE");
    expect(restored.details).toContain("request-123");
});
test("ordinary local-mode errors are unchanged", () => {
    expect(cloudErrorMessage({ error: "ordinary" })).toBe("");
    expect(splitErrorMessage("网络连接失败")).toEqual({ message: "网络连接失败", details: "" });
});

test("authorization errors open the shared prompt without becoming save failures", () => {
    useCloudStore.getState().setModelLoginRequired(false);
    const previousErrors = useCloudStore.getState().errors;
    const message = cloudErrorMessage({ error: "APP_USER_AUTHORIZATION_REQUIRED", message: "请先登录模型服务完成账户关联，完成后回到此页重试。", requestId: "trace" });
    expect(useCloudStore.getState().modelLoginRequired).toBe(true);
    expect(useCloudStore.getState().errors).toBe(previousErrors);
    expect(message).toContain("APP_USER_AUTHORIZATION_REQUIRED");
    useCloudStore.getState().setModelLoginRequired(false);
});

test("legacy login errors do not start an unsupported authorization flow", () => {
    useCloudStore.getState().setModelLoginRequired(false);
    cloudErrorMessage({ error: "APP_USER_LOGIN_REQUIRED", message: "请升级 Reseller", requestId: "trace" });
    expect(useCloudStore.getState().modelLoginRequired).toBe(false);
});

test("saved authorization errors remain actionable without matching ordinary prompt text", () => {
    const error = cloudErrorMessage({ error: "APP_USER_AUTHORIZATION_REQUIRED", message: "需要授权", requestId: "mock" });
    expect(needsModelAuthorization(error)).toBe(true);
    expect(needsModelAuthorization("提示词提到了 APP_USER_AUTHORIZATION_REQUIRED")).toBe(false);
    expect(needsModelAuthorization(cloudErrorMessage({ error: "APP_SERVICE_UNAVAILABLE", message: "服务暂不可用", requestId: "mock" }))).toBe(false);
    useCloudStore.getState().setModelLoginRequired(false);
});

test("verified authorization survives consuming the resume draft and is cleared by a new denial", () => {
    const state = useCloudStore.getState();
    state.setAuthorizationResume({ returnTo: "/studio", draft: { prompt: "keep me" }, result: "authorized", message: "授权完成" });
    expect(useCloudStore.getState().modelAuthorized).toBe(true);
    state.setAuthorizationResume(null);
    expect(useCloudStore.getState().modelAuthorized).toBe(true);
    cloudErrorMessage({ error: "UPSTREAM_BALANCE_INSUFFICIENT", message: "上游余额不足", requestId: "upstream" });
    expect(useCloudStore.getState().modelAuthorized).toBe(true);
    cloudErrorMessage({ error: "APP_USER_AUTHORIZATION_REQUIRED", message: "需要授权", requestId: "expired" });
    expect(useCloudStore.getState().modelAuthorized).toBe(false);
    expect(useCloudStore.getState().modelLoginRequired).toBe(true);
    state.setModelLoginRequired(false);
    expect(useCloudStore.getState().modelAuthorized).toBe(false);
});

test("failed callbacks and explicit revocation do not leave an authorized state", () => {
    const state = useCloudStore.getState();
    state.setModelLoginRequired(true);
    state.setModelAuthorized(true);
    expect(useCloudStore.getState().modelLoginRequired).toBe(false);
    state.setAuthorizationResume({ returnTo: "/video", draft: {}, result: "AUTHORIZATION_FLOW_INVALID", message: "授权失效" });
    expect(useCloudStore.getState().modelAuthorized).toBe(false);
    state.setModelAuthorized(true);
    state.setModelAuthorized(false);
    expect(useCloudStore.getState().modelAuthorized).toBe(false);
    state.setAuthorizationResume(null);
});
