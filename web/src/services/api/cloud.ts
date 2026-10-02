import { useCloudStore } from "@/stores/use-cloud-store";
import type { ImageModelType } from "../../../../shared/image-models";
import type { VideoModelType } from "../../../../shared/video-models";

export type CloudUser = { id: string; username: string; displayName: string; avatarUrl: string; email: string; emailVerified: boolean; admin: boolean };
export type CloudChannel = { id: string; name: string; capability: "image" | "text" | "video" | "audio"; models: string[]; image_types: Record<string, ImageModelType>; video_types: Record<string, VideoModelType>; model_descriptions: Record<string, string>; is_default: boolean };
export let cloudSession: { user: CloudUser; csrf: string; modelServiceUrl?: string; channels: CloudChannel[] } | null = null;
const errors: Record<string, string> = {
    ENHANCER_NOT_CONFIGURED: "尚未配置模型服务，当前仅启用登录和数据同步", TOKENONE_NOT_CONFIGURED: "尚未配置 TokenONE 模型服务",
    APP_USER_LOGIN_REQUIRED: "模型服务版本暂不支持当前授权流程，请联系管理员。",
    APP_USER_AUTHORIZATION_REQUIRED: "请完成模型服务授权后继续。",
    LOGIN_REQUIRED: "请先登录", SESSION_EXPIRED: "登录已过期，请重新登录", CSRF_FAILED: "登录状态已变化，请重新打开页面",
    ASSET_NOT_FOUND: "素材已被删除，请刷新列表", ASSET_API_REQUIRED: "素材保存接口已更新，请刷新页面后重试",
    RESOURCE_API_REQUIRED: "保存接口已更新，请刷新页面后重试",
    PROJECT_NOT_FOUND: "画布已被删除，请刷新列表", FILE_NOT_FOUND: "文件已不存在，请重新选择",
    PROMPT_SOURCE_HOST_NOT_ALLOWED: "提示词来源须使用 HTTPS，且域名须由管理员允许",
    PROMPT_SOURCE_FETCH_FAILED: "提示词来源暂时无法读取，已保留此前缓存，可手动重试",
    PROMPT_SOURCE_INVALID_JSON: "提示词来源格式不正确，应提供 JSON 数组",
    FILE_TOO_LARGE: "文件或请求内容超过允许大小", EMAIL_NOT_VERIFIED: "请先在 IDONE 验证邮箱",
    TOKENONE_GROUP_FORBIDDEN: "当前账号没有该渠道的分组授权或有效订阅", TOKENONE_KEY_UNAVAILABLE: "该渠道的模型服务访问凭据已停用、过期或额度不足",
    TOKENONE_GROUP_UNAVAILABLE: "该渠道的分组不可用，请联系管理员", CHANNEL_UNAVAILABLE: "渠道已停用，请重新选择",
    MODEL_NOT_ALLOWED: "所选模型不在该渠道允许范围内", LOCAL_BLOB_NOT_SYNCABLE: "内容包含尚未上传的本地文件，无法同步",
};
export class CloudError extends Error {
    constructor(public status: number, public code: string, message?: string, public requestId?: string) { super(message || errors[code] || `云端请求失败：${code}`); }
}
export async function cloudApi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api${path}`, {
        ...init, credentials: "same-origin", cache: "no-store",
        headers: { ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), "X-CSRF-Token": cloudSession?.csrf || "", "X-Expected-User": cloudSession?.user.id || "", ...init.headers },
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new CloudError(response.status, body.error || `HTTP_${response.status}`, body.message, body.requestId);
        if (response.status === 401 || body.error === "CSRF_FAILED" || body.error === "ACCOUNT_CHANGED") useCloudStore.getState().setError("session", "登录状态已变化，请先导出未保存修改，再重新加载页面登录");
        if (body.error === "APP_USER_AUTHORIZATION_REQUIRED") useCloudStore.getState().setModelLoginRequired(true);
        throw error;
    }
    return response.status === 204 ? undefined as T : response.json();
}
export async function initializeCloud() {
    const session = await cloudApi<{ user: CloudUser; csrf: string; modelServiceUrl?: string }>("/auth/me");
    cloudSession = { ...session, channels: [] };
    cloudSession.channels = (await cloudApi<{ channels: CloudChannel[] }>("/channels")).channels;
    useCloudStore.getState().setAuthorizationResume(await cloudApi("/model-authorization"));
}
export const cloudFileUrl = (namespace: string, key: string) => `/api/files/${namespace}/${encodeURIComponent(key)}`;
export async function logoutCloud() {
    await cloudApi("/auth/logout", { method: "POST" });
    window.location.assign("/");
}
