import { useCloudStore } from "@/stores/use-cloud-store";
import { expect, test } from "bun:test";
import { cloudErrorMessage, splitErrorMessage } from "./error-message";

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

test("portal login errors open the shared prompt without becoming save failures", () => {
    useCloudStore.getState().setModelLoginRequired(false);
    const message = cloudErrorMessage({ error: "APP_USER_LOGIN_REQUIRED", message: "请先登录模型服务完成账户关联，完成后回到此页重试。", requestId: "trace" });
    expect(useCloudStore.getState().modelLoginRequired).toBe(true);
    expect(useCloudStore.getState().errors).toEqual({});
    expect(message).toContain("APP_USER_LOGIN_REQUIRED");
    useCloudStore.getState().setModelLoginRequired(false);
});
