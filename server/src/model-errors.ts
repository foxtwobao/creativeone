import { HttpError } from "./http.js";

const messages: Record<string, string> = {
    INSUFFICIENT_BALANCE: "账户余额不足，暂时无法使用模型。请前往 TokenONE 充值，完成后手动重试。",
    API_KEY_DISABLED: "当前模型 Key 已停用，请联系管理员处理后重试。",
    API_KEY_EXPIRED: "当前模型 Key 已过期，请联系管理员处理后重试。",
    INVALID_API_KEY: "模型 Key 无效，请联系管理员检查渠道配置。",
    API_KEY_QUOTA_EXHAUSTED: "当前模型 Key 的额度已用完，请联系管理员调整额度后重试。",
    GROUP_DISABLED: "当前渠道分组已停用，请切换渠道或联系管理员。",
    GROUP_DELETED: "当前渠道分组已删除，请切换渠道或联系管理员。",
    SUBSCRIPTION_NOT_FOUND: "当前渠道需要有效订阅，请在 TokenONE 开通订阅或联系管理员。",
    SUBSCRIPTION_INVALID: "当前渠道的订阅已失效，请在 TokenONE 更新订阅后重试。",
    USER_INACTIVE: "当前 TokenONE 账号已停用，请联系管理员。",
    USAGE_LIMIT_EXCEEDED: "当前账号已达到用量限制，请等待额度恢复或联系管理员。",
    TOKENONE_GROUP_FORBIDDEN: "你尚未获得该渠道的分组授权或有效订阅，请联系管理员。",
    TOKENONE_GROUP_UNAVAILABLE: "当前渠道分组不可用，请切换渠道或联系管理员。",
    TOKENONE_KEY_UNAVAILABLE: "当前模型 Key 不可用，请联系管理员检查状态、有效期及额度。",
    TOKENONE_KEY_QUOTA_EXHAUSTED: "当前模型 Key 的额度已用完，请联系管理员调整额度后重试。",
    MODEL_NOT_ALLOWED: "该渠道不支持所选模型，请选择其他模型。",
    CHANNEL_UNAVAILABLE: "当前渠道已停用或不存在，请刷新页面后重新选择。",
    EMAIL_NOT_VERIFIED: "请先在 IDONE 完成邮箱验证，再重新登录。",
    TOKENONE_KEY_SERVICE_NOT_CONFIGURED: "模型 Key 服务尚未配置完成，请联系管理员。",
    TOKENONE_KEY_DATABASE_UNAVAILABLE: "模型 Key 服务暂时不可用，请稍后手动重试或联系管理员。",
    UPSTREAM_RESULT_UNKNOWN: "暂时无法确认生成结果，请先查看云端任务，确认后再手动重试，避免重复计费。",
};

export function modelErrorMessage(code: string): string | undefined {
    if (Object.hasOwn(messages, code)) return messages[code];
    const status = /^TOKENONE_HTTP_(\d{3})$/.exec(code)?.[1];
    if (status === "401") return "模型服务认证失败，请联系管理员检查 Key 和渠道配置。";
    if (status === "403") return "模型服务拒绝了本次请求，请联系管理员核查账号权限、分组及 Key 状态。";
    if (status === "429") return "模型服务当前请求过多或触发限额，请稍后手动重试。";
    if (status === "400" || status === "422") return "模型服务未接受生成参数，请检查模型、尺寸或参考图后重试。";
    if (status === "404") return "模型或接口不存在，请联系管理员检查渠道配置。";
    if (status) return "模型服务暂时无法完成请求，请稍后手动重试；如持续失败，请联系管理员。";
    return undefined;
}

// Only known codes leave the backend. Provider messages may contain credentials,
// internal URLs, HTML or prompts and must not be forwarded or logged verbatim.
export async function tokenoneError(response: Response): Promise<HttpError> {
    const body = await response.json().catch(() => null);
    const candidates = [body?.code, body?.error?.code, body?.error?.type, body?.error];
    const code = candidates.find((value) => typeof value === "string" && Object.hasOwn(messages, value));
    return new HttpError(response.status === 401 ? 502 : response.status, code || `TOKENONE_HTTP_${response.status}`);
}
