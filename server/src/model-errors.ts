import { HttpError } from "./http.js";

const messages: Record<string, string> = {
    TOKENONE_INVALID_RESPONSE: "模型服务返回的数据格式无效，请联系管理员。",
    ENHANCER_NOT_CONFIGURED: "Enhance 应用接入尚未配置，请联系管理员。",
    ENHANCER_FAILED: "Enhance 查询失败，请联系管理员并提供请求 ID。",
    ENHANCER_INVALID_RESPONSE: "Enhance 返回了无效响应，请联系管理员检查接口版本。",
    UNAUTHORIZED: "Enhance 应用凭证无效、过期或已撤销，请联系管理员更新。",
    APP_DISABLED: "当前应用已停用，请联系管理员。",
    SCOPE_FORBIDDEN: "应用未获得该接口权限，请联系管理员开通。",
    ISSUER_FORBIDDEN: "登录身份源与 Enhance 配置不一致，请联系管理员。",
    KEY_FORBIDDEN: "查询的 Key 不属于当前应用或用户，请检查筛选条件。",
    INVALID_REQUEST: "请求参数无效，请检查字段和查询时间范围。",
    INVALID_OR_EXPIRED_CURSOR: "消耗查询游标已失效，请从第一页重新查询并替换原结果。",
    TOKENONE_USER_INACTIVE: "当前 TokenONE 账号已停用，请联系管理员。",
    IDENTITY_CONFLICT: "模型服务身份关联存在冲突，请联系管理员核验。",
    APP_KEY_BINDING_DISABLED: "应用 Key 绑定已停用，请联系管理员处理。",
    APP_KEY_UNAVAILABLE: "应用 Key 不可用，请联系管理员处理，不要创建替代 Key。",
    APP_KEY_RESULT_AMBIGUOUS: "Key 创建结果尚不确定，请联系管理员核验。",
    APP_SERVICE_NOT_CONFIGURED: "Enhance 应用服务尚未配置，请联系管理员。",
    APP_WRITES_DISABLED: "Enhance 暂未开放 Key 申请，请联系管理员。",
    TOKENONE_DATABASE_NOT_CONFIGURED: "TokenONE 数据库尚未配置，请联系管理员。",
    APP_KEY_ENCRYPTION_NOT_CONFIGURED: "Key 加密服务尚未配置，请联系管理员。",
    APP_KEY_RECOVERY_UNAVAILABLE: "Key 恢复服务不可用，请联系管理员处理。",
    APP_DATABASE_UNAVAILABLE: "Enhance 数据库暂时不可用，请稍后手动重试或联系管理员。",
    APP_SERVICE_UNAVAILABLE: "Enhance 服务暂时不可用，请稍后手动重试或联系管理员。",
    TASK_GROUP_CHANGED: "应用默认分组已变更，暂不能查询原分组的视频任务，请联系管理员处理。",
    TOKENONE_USER_NOT_FOUND: "你的模型服务账号尚未同步，请稍后手动重试；若持续出现，请联系管理员检查 IDONE 同步状态。",
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
    TOKENONE_GROUP_UNAVAILABLE: "应用默认分组不可用，请联系管理员检查 Enhance 分组配置。",
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
