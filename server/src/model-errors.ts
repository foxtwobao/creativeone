import { HttpError } from "./http.js";

const messages: Record<string, string> = {
    REFERENCE_IMAGE_TOO_LARGE: "参考图超过本站单张大小限制，请压缩或更换图片。",
    seedance_real_person_asset_required: "参考图可能包含真人，需先完成真人认证。当前暂不支持认证素材，请更换参考图。",
    CANVAS_REFERENCE_NOT_READY: "连接的参考节点为空或仍在生成，请等待完成或断开该引用后再生成",
    REFERENCE_DURATION_EXCEEDED: "参考视频或音频的真实总时长超过当前型号限制，请减少素材",
    MODEL_CAPABILITY_INVALID: "画布已保存参数不适用于当前模型，请检查模型、尺寸和参考素材",
    TASK_NOT_RECOVERABLE: "当前任务没有可恢复的结果，请查看原任务状态",
    INVALID_CANVAS_ARCHIVE: "画布文件格式无效、引用缺失或素材已损坏",
    CANVAS_PLUGINS_DISABLED: "画布第三方插件尚未开放",
    REFERENCE_DURATION_UNKNOWN: "无法读取参考媒体的真实时长，请重新上传可解析的视频或音频后生成",
    INVALID_TEXT_RESPONSE: "模型未返回完整的文本结果，请查看任务后再决定是否重新生成",
    INVALID_IMAGE_RESPONSE: "图片结果尚未完整保存，请查看原任务，勿重复提交",
    PROJECT_NOT_FOUND: "画布不存在、已删除或当前账号无权访问。",
    PROJECT_REVISION_CONFLICT: "画布已在其他页面更新，请先重新加载云端内容，再继续编辑。",
    PROJECT_OPERATION_CONFLICT: "画布操作标识已对应其他内容，请刷新后重试。",
    CANVAS_NODE_NOT_FOUND: "画布节点不存在或已删除，请刷新画布后重试。",
    CANVAS_GENERATION_CHANGED: "画布生成目标已变化，请确认当前节点后再生成。",
    CANVAS_GENERATION_ALREADY_ACCEPTED: "这次生成已受理，请查看原任务，不要重复提交。",
    FILE_NOT_SYNCED: "画布引用了尚未同步完成的文件，请重新选择素材后重试。",
    INVALID_CANVAS_GRAPH: "画布节点或连线结构无效，请刷新后重试。",
    TASK_NOT_REMOVABLE: "任务不存在或尚未结束，暂不能从作品中移除。",
    INVALID_MODEL_DESCRIPTIONS: "模型描述与允许的模型列表不一致，请重新配置。",
    IMAGE_MODEL_TYPE_REQUIRED: "请管理员在功能模型配置中为每个图片模型选择类型。",
    INVALID_IMAGE_MODEL_TYPES: "模型类型配置与图片模型列表不一致，请重新配置。",
    TOKENONE_GENERATION_PERMISSION_DISABLED: "模型服务分组未启用生成权限（服务返回：图片生成未启用）；视频请求也可能受此开关限制，请管理员核查 TokenONE 中对应 Key 所属分组的生成能力配置。",
    TOKENONE_INVALID_RESPONSE: "模型服务返回的数据格式无效，请联系管理员。",
    ENHANCER_NOT_CONFIGURED: "模型服务尚未配置，请联系管理员。",
    ENHANCER_FAILED: "模型服务请求失败，请稍后重试；如持续失败，请联系管理员并提供请求 ID。",
    ENHANCER_INVALID_RESPONSE: "模型服务返回了无效响应，请联系管理员。",
    UNAUTHORIZED: "模型服务接入凭据无效或已撤销，请联系管理员。",
    APP_USER_LOGIN_REQUIRED: "模型服务版本暂不支持当前授权流程，请联系管理员。",
    APP_USER_AUTHORIZATION_REQUIRED: "请完成模型服务授权后继续。",
    IDENTITY_BINDING_CONFLICT: "模型服务账号与当前登录身份不一致，请停止操作并联系管理员核验。",
    TOKENONE_USER_DISABLED: "当前模型服务账号已停用，请联系管理员。",
    REDIRECT_URI_FORBIDDEN: "模型服务授权返回地址未获允许，请联系管理员。",
    AUTHORIZATION_FLOW_INVALID: "授权流程已失效，请重新发起授权。",
    AUTHORIZATION_CREDENTIAL_UNAVAILABLE: "授权配置已更新，请重新发起模型服务授权。",
    AUTHORIZATION_RESULT_UNKNOWN: "授权结果暂时无法确认，编辑内容和任务已保留，请稍后检查授权结果。",
    AUTHORIZATION_PENDING: "授权尚未完成，编辑内容已恢复；请在原授权页面继续，过期后可重新发起。",
    AUTHORIZATION_REVOKE_UNKNOWN: "断开授权的结果暂时无法确认，请稍后再次断开以确认结果。",
    TOKENONE_ACCOUNT_USAGE_UNAVAILABLE: "账户汇总、用量明细和统计暂不可用，不影响模型生成。",
    ACCOUNT_BALANCE_UNAVAILABLE: "余额暂不可用，请稍后手动刷新。",
    ANNOUNCEMENTS_UNAVAILABLE: "公告暂不可用，请稍后手动刷新。",
    ANNOUNCEMENT_NOT_FOUND: "公告已不可用。",
    ANNOUNCEMENT_CHANGED: "公告已更新，请重新打开后阅读。",
    MODEL_PRICING_UNAVAILABLE: "模型价格暂不可用，请稍后手动刷新。",
    APP_PRICING_GROUP_UNAVAILABLE: "应用默认价格分组不可用，请联系管理员检查 Composite 分组配置。",
    APP_PRICING_UNAVAILABLE: "模型价格服务暂不可用，请稍后手动刷新。",
    BALANCE_UNIT_UNSUPPORTED: "模型服务的余额显示单位暂不支持，请联系管理员。",
    TASK_PROVIDER_CHANGED: "模型服务已切换，不能使用当前服务查询历史视频任务，请联系管理员核验原服务。",
    APP_DISABLED: "当前应用已停用，请联系管理员。",
    SCOPE_FORBIDDEN: "应用未获得该接口权限，请联系管理员开通。",
    ISSUER_FORBIDDEN: "登录身份与模型服务配置不一致，请联系管理员。",
    KEY_FORBIDDEN: "模型服务访问凭据不属于当前应用或用户，请检查筛选条件。",
    INVALID_REQUEST: "请求参数无效，请检查字段和查询时间范围。",
    INVALID_OR_EXPIRED_CURSOR: "消耗查询游标已失效，请从第一页重新查询并替换原结果。",
    TOKENONE_USER_INACTIVE: "当前 TokenONE 账号已停用，请联系管理员。",
    IDENTITY_CONFLICT: "模型服务身份关联存在冲突，请联系管理员核验。",
    APP_KEY_BINDING_DISABLED: "当前应用的模型服务访问凭据已停用，请联系管理员。",
    APP_KEY_UNAVAILABLE: "模型服务访问凭据不可用，请联系管理员处理。",
    APP_KEY_RESULT_AMBIGUOUS: "模型服务访问凭据创建结果尚不确定，请联系管理员核验。",
    APP_SERVICE_NOT_CONFIGURED: "模型服务尚未配置，请联系管理员。",
    APP_WRITES_DISABLED: "模型服务暂未开放授权申请，请联系管理员。",
    TOKENONE_DATABASE_NOT_CONFIGURED: "模型服务尚未配置完成，请联系管理员。",
    APP_KEY_ENCRYPTION_NOT_CONFIGURED: "模型服务凭据保护尚未配置，请联系管理员。",
    APP_KEY_RECOVERY_UNAVAILABLE: "模型服务暂时无法取得访问凭据，请稍后重试；如持续失败，请联系管理员。",
    APP_DATABASE_UNAVAILABLE: "模型服务暂时不可用，请稍后重试；如持续失败，请联系管理员。",
    APP_SERVICE_UNAVAILABLE: "模型服务暂时不可用，请稍后重试；如持续失败，请联系管理员。",
    TASK_GROUP_CHANGED: "应用默认分组已变更，暂不能查询原分组的视频任务，请联系管理员处理。",
    VIDEO_MODEL_TYPE_REQUIRED: "请为每个视频模型选择调用类型。",
    INVALID_WAN_MODEL: "WAN 请选择 wan3.0-video 或 wan3.0-video-prime 公共模型。",
    WAN_REFERENCE_VIDEO_UNSUPPORTED: "当前 WAN 图生模型不支持参考视频。",
    WAN_REFERENCE_IMAGE_REQUIRED: "WAN 图生模型需要至少一张参考图片。",
    VIDEO_ENDPOINT_MISMATCH: "视频模型与调用协议不匹配，请检查后台模型类型配置。",
    WAN_PUBLIC_ORIGIN_REQUIRED: "视频参考素材需要公网可访问的 HTTPS 应用地址。",
    MEDIA_LINK_EXPIRED: "参考素材链接已过期，请重新发起任务；请先核查已有任务状态，避免重复计费。",
    TOKENONE_USER_NOT_FOUND: "原生模型服务账号不存在，请联系管理员核验账号及身份绑定。",
    INSUFFICIENT_BALANCE: "账户余额不足，暂时无法使用模型。请前往 TokenONE 充值，完成后手动重试。",
    UPSTREAM_BALANCE_INSUFFICIENT: "该模型的上游服务账户余额不足，请联系管理员处理模型渠道，或切换其他模型后重试。无需重新授权。",
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
    TOKENONE_GROUP_UNAVAILABLE: "模型服务默认分组不可用，请联系管理员。",
    TOKENONE_GROUP_BINDINGS_INVALID: "TokenONE 默认组合分组（Composite）的渠道绑定无效，请管理员在 TokenONE 中核查并修复分组渠道绑定后重试。",
    TOKENONE_COMPOSITE_ENDPOINT_UNSUPPORTED: "TokenONE 当前组合分组（Composite）不支持此接口，请管理员处理组合分组的接口支持或调整应用默认分组后再重试。",
    TOKENONE_KEY_UNAVAILABLE: "当前模型 Key 不可用，请联系管理员检查状态、有效期及额度。",
    TOKENONE_KEY_QUOTA_EXHAUSTED: "当前模型 Key 的额度已用完，请联系管理员调整额度后重试。",
    MODEL_NOT_ALLOWED: "该渠道不支持所选模型，请选择其他模型。",
    CHANNEL_UNAVAILABLE: "当前渠道已停用或不存在，请刷新页面后重新选择。",
    EMAIL_NOT_VERIFIED: "请先在 IDONE 完成邮箱验证，再重新登录。",
    TOKENONE_KEY_SERVICE_NOT_CONFIGURED: "模型 Key 服务尚未配置完成，请联系管理员。",
    TOKENONE_KEY_DATABASE_UNAVAILABLE: "模型 Key 服务暂时不可用，请稍后手动重试或联系管理员。",
    AUDIO_SAVE_INCOMPLETE: "音频已生成，部分文件尚未保存；已保存的版本可试听和下载，请恢复保存缺失项。",
    AUDIO_REQUEST_TIMEOUT: "音频处理已超过 15 分钟，暂时无法确认结果；上游可能仍在生成或已计费，请先核对原任务，勿直接重复生成。",
    INVALID_AUDIO_RESPONSE: "上游未返回约定的音频链接，无法确认结果，请核对任务与账单。",
    INCOMPLETE_AUDIO_RESPONSE: "上游响应未正常结束，无法确认完整结果，请核对任务与账单。",
    INVALID_AUDIO_FILE: "下载内容不是有效的受支持音频文件。",
    MEDIA_HOST_NOT_ALLOWED: "结果下载域名尚未获准，请联系管理员核实域名后恢复保存。",
    UPSTREAM_RESULT_UNKNOWN: "暂时无法确认生成结果，请先查看云端任务，确认后再手动重试，避免重复计费。",
};

export function modelErrorMessage(code: string | null | undefined, upstream?: HttpError["upstreamError"]): string | undefined {
    if (code && Object.hasOwn(messages, code)) return messages[code];
    if (upstream) {
        const detail = upstreamErrorDetails(upstream);
        if (detail.code && Object.hasOwn(messages, detail.code)) return messages[detail.code];
        if (detail.message.trim() && detail.message !== "上游未返回错误说明") return `上游服务返回${detail.code ? `（${detail.code}）` : ""}：${detail.message}`;
    }
    const status = /^TOKENONE_HTTP_(\d{3})$/.exec(code || "")?.[1];
    if (status === "401") return "模型服务认证失败，请联系管理员检查 Key 和渠道配置。";
    if (status === "403") return "模型服务拒绝了本次请求，请联系管理员核查账号权限、分组及 Key 状态。";
    if (status === "429") return "模型服务当前请求过多或触发限额，请稍后手动重试。";
    if (status === "400" || status === "422") return "模型服务未接受生成参数，请检查模型、尺寸或参考图后重试。";
    if (status === "404") return "模型或接口不存在，请联系管理员检查渠道配置。";
    if (status) return "模型服务暂时无法完成请求，请稍后手动重试；如持续失败，请联系管理员。";
    return undefined;
}

export function taskErrorMessage(task: { status: string; error?: string | null; upstream_error?: HttpError["upstreamError"] }): string | undefined {
    if (!["failed", "unknown", "cancelled", "expired"].includes(task.status)) return undefined;
    return modelErrorMessage(task.error, task.upstream_error) || (task.status === "unknown" ? "任务结果尚未确认，请查看生成任务；请勿重复提交。" : "生成失败，请查看生成任务详情。");
}

// Diagnostics are displayed as plain text after credential and URL redaction.
export function upstreamErrorDetails(body: any, status?: number): NonNullable<HttpError["upstreamError"]> {
    let detail = body?.error || body;
    const message = typeof detail?.message === "string" ? detail.message : typeof detail === "string" ? detail : "";
    if (typeof message === "string") {
        try { const parsed = JSON.parse(message.replace(/^status_code=\d{3},\s*/, "")); detail = parsed?.error || parsed || detail; } catch { /* Plain provider message. */ }
    }
    const redact = (value: string) => value
        .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [已隐藏]")
        .replace(/\bsk-[\w-]+/g, "[已隐藏]")
        .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, "$1[已隐藏]")
        .replace(/https?:\/\/[^\s"'<>]+/g, "[链接已隐藏]");
    return { ...(status ? { status } : {}), ...(typeof detail?.code === "string" ? { code: redact(detail.code) } : {}),
        message: redact(typeof detail?.message === "string" ? detail.message : typeof detail === "string" ? detail : message || "上游未返回错误说明") };
}

// Known errors use mapped messages; unknown errors can show redacted upstream details.
export async function tokenoneError(response: Response): Promise<HttpError> {
    const raw = await response.text();
    let body: any;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const failure = (status: number, code: string) => Object.assign(new HttpError(status, code), { upstreamError: upstreamErrorDetails(body, response.status) });
    if (response.status === 403 && body?.error?.type === "permission_error" && body.error.message === "Image generation is not enabled for this group") {
        return failure(403, "TOKENONE_GENERATION_PERMISSION_DISABLED");
    }
    const candidates = [body?.code, body?.error?.code, body?.error?.type, body?.error];
    // Task plugins may put upstream JSON in error.message with a generic outer code.
    for (const message of [body?.message, body?.error?.message]) {
        if (typeof message !== "string") continue;
        try {
            const upstream = JSON.parse(message.replace(/^status_code=\d{3},\s*/, ""));
            candidates.push(upstream?.code, upstream?.error?.code);
        } catch { /* Plain provider text is available through upstreamError. */ }
    }
    const code = candidates.find((value) => typeof value === "string" && Object.hasOwn(messages, value));
    if (!code && response.status === 403 && body?.error?.type === "new_api_error" && typeof body.error.message === "string" && /^composite has invalid channel bindings(?: \(request id: [A-Za-z0-9-]+\))?$/.test(body.error.message)) {
        return failure(403, "TOKENONE_GROUP_BINDINGS_INVALID");
    }
    if (!code && response.status === 403 && body?.error?.type === "new_api_error" && typeof body.error.message === "string" && /^this endpoint does not support composite groups(?: \(request id: [A-Za-z0-9-]+\))?$/.test(body.error.message)) {
        return failure(403, "TOKENONE_COMPOSITE_ENDPOINT_UNSUPPORTED");
    }
    if (!code && response.status === 403 && typeof body?.error?.message === "string" && /^account balance is negative, please recharge first(?: \(request id: [A-Za-z0-9-]+\))?$/.test(body.error.message)) {
        return failure(403, "UPSTREAM_BALANCE_INSUFFICIENT");
    }
    return failure(response.status === 401 ? 502 : response.status, code || `TOKENONE_HTTP_${response.status}`);
}
