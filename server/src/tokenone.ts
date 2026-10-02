import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./config.js";
import { requireAdmin, type User } from "./auth.js";
import { HttpError } from "./http.js";
import { tokenoneError } from "./model-errors.js";
import { imageModelTypes, type ImageModelType } from "../../shared/image-models.js";
import { videoModelTypes, wanModelProfile, type VideoModelType } from "../../shared/video-models.js";

const capabilitySchema = z.enum(["image", "text", "video", "audio"]);
const capabilityNames = { image: "图片", text: "文本", video: "视频", audio: "音频" };
export type Channel = { id: string; capability: z.infer<typeof capabilitySchema>; models: string[]; image_types?: Record<string, ImageModelType>; video_types?: Record<string, VideoModelType>; enabled: boolean };
export const featureModelsSchema = z.object({
    models: z.array(z.string().trim().min(1)), default_model: z.string().trim(), enabled: z.boolean(),
    image_types: z.record(z.string(), z.enum(imageModelTypes)).default({}),
    video_types: z.record(z.string(), z.enum(videoModelTypes)).default({}),
    model_descriptions: z.record(z.string(), z.string().trim()).default({}),
}).strict().refine((value) => value.models.length ? value.models.includes(value.default_model) : !value.enabled && !value.default_model, {
    message: "请选择模型列表中的默认模型；启用时至少配置一个模型",
});
const decimalId = z.string().regex(/^[1-9][0-9]*$/);
const keySchema = z.object({ status: z.literal("ready"), tokenone_user_id: decimalId, api_key: z.object({ id: decimalId, key: z.string().min(1), group_id: decimalId, status: z.literal("active") }) });
// Service addresses identify the binding namespace; credentials may rotate without changing ownership.
export const modelProvider = `reseller:${createHash("sha256").update(JSON.stringify([
    env.ENHANCER_BASE_URL?.replace(/\/+$/, ""), env.TOKENONE_BASE_URL?.replace(/\/+$/, "").replace(/\/v1$/, ""),
])).digest("hex")}`;
const identity = (user: User) => ({ issuer: user.issuer, subject: user.subject });
const enhanceErrors = new Set([
    "INVALID_REQUEST", "INVALID_OR_EXPIRED_CURSOR", "UNAUTHORIZED", "APP_DISABLED", "SCOPE_FORBIDDEN", "ISSUER_FORBIDDEN", "KEY_FORBIDDEN",
    "TOKENONE_USER_INACTIVE", "TOKENONE_GROUP_FORBIDDEN", "IDENTITY_CONFLICT", "TOKENONE_GROUP_UNAVAILABLE", "APP_KEY_BINDING_DISABLED",
    "APP_KEY_UNAVAILABLE", "TOKENONE_KEY_QUOTA_EXHAUSTED", "APP_KEY_RESULT_AMBIGUOUS", "TOKENONE_USER_NOT_FOUND", "APP_SERVICE_NOT_CONFIGURED",
    "APP_WRITES_DISABLED", "TOKENONE_DATABASE_NOT_CONFIGURED", "APP_KEY_ENCRYPTION_NOT_CONFIGURED", "APP_KEY_RECOVERY_UNAVAILABLE",
    "APP_DATABASE_UNAVAILABLE", "APP_SERVICE_UNAVAILABLE", "APP_USER_LOGIN_REQUIRED",
    "APP_USER_AUTHORIZATION_REQUIRED", "IDENTITY_BINDING_CONFLICT", "TOKENONE_USER_DISABLED", "REDIRECT_URI_FORBIDDEN", "AUTHORIZATION_FLOW_INVALID",
]);
export async function enhancer(path: string, requestId: string, body?: unknown) {
    if (!env.ENHANCER_BASE_URL || !env.ENHANCER_APP_CREDENTIAL) throw new HttpError(503, "ENHANCER_NOT_CONFIGURED");
    const response = await fetch(`${env.ENHANCER_BASE_URL.replace(/\/$/, "")}/api/apps${path}`, {
        method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${env.ENHANCER_APP_CREDENTIAL}`, "Content-Type": "application/json", "X-Request-Id": requestId },
        body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
        const code = enhanceErrors.has(result?.error) ? result.error : "ENHANCER_FAILED";
        throw new HttpError(response.status === 401 ? 502 : response.status, code, result?.retryable === true);
    }
    if (!result || typeof result !== "object") throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
    return result;
}
export async function ensureKey(user: User, requestId: string) {
    if (!env.TOKENONE_BASE_URL) throw new HttpError(503, "TOKENONE_NOT_CONFIGURED");
    if (!user.email_verified) throw new HttpError(403, "EMAIL_NOT_VERIFIED");
    const parsed = keySchema.safeParse(await enhancer("/keys/ensure", requestId, { identity: identity(user) }));
    if (!parsed.success) throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
    const result = parsed.data;
    await db.query(`INSERT INTO key_bindings (user_id,group_id,tokenone_user_id,key_id,provider) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,provider,group_id) DO UPDATE SET tokenone_user_id=EXCLUDED.tokenone_user_id,key_id=EXCLUDED.key_id`, [user.id, result.api_key.group_id, result.tokenone_user_id, result.api_key.id, modelProvider]);
    return result.api_key;
}
export function upstreamUrl(path: string) {
    if (!env.TOKENONE_BASE_URL) throw new HttpError(503, "TOKENONE_NOT_CONFIGURED");
    const base = env.TOKENONE_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${base}/${path.startsWith("contents/generations/tasks") ? "doubao/api/v3" : "v1"}/${path}`;
}
export const channelRouter = Router();
channelRouter.get("/channels", async (_req, res) => {
    const { rows } = await db.query("SELECT id,name,capability,models,image_types,video_types,model_descriptions,is_default FROM channels WHERE enabled ORDER BY is_default DESC,name,id");
    res.json({ channels: rows });
});
channelRouter.get("/admin/groups", requireAdmin, async (_req, res) => res.json(await enhancer("/groups", res.locals.requestId)));
channelRouter.get("/admin/models", requireAdmin, async (_req, res) => {
    const apiKey = await ensureKey(res.locals.user, res.locals.requestId);
    const response = await fetch(upstreamUrl("models"), {
        headers: { Authorization: `Bearer ${apiKey.key}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw await tokenoneError(response);
    const result = z.object({ data: z.array(z.object({ id: z.string().trim().min(1) })) }).safeParse(await response.json().catch(() => null));
    if (!result.success) throw new HttpError(502, "TOKENONE_INVALID_RESPONSE");
    res.json({ models: [...new Set(result.data.data.map((model) => model.id))] });
});
channelRouter.get("/admin/channels", requireAdmin, async (_req, res) => {
    const { rows } = await db.query("SELECT id,capability,models,image_types,video_types,model_descriptions,enabled,COALESCE(models->>0,'') AS default_model FROM channels ORDER BY capability");
    res.json({ channels: rows });
});
channelRouter.put("/admin/channels/:capability", requireAdmin, async (req, res) => {
    const capability = capabilitySchema.parse(req.params.capability);
    const config = featureModelsSchema.parse(req.body);
    const models = config.models.length ? [...new Set([config.default_model, ...config.models])] : [];
    if (capability === "image" && models.some((model) => !config.image_types[model])) throw new HttpError(400, "IMAGE_MODEL_TYPE_REQUIRED");
    if (capability === "video" && models.some((model) => !config.video_types[model])) throw new HttpError(400, "VIDEO_MODEL_TYPE_REQUIRED");
    if (capability === "video" && models.some((model) => config.video_types[model] === "wan" && !wanModelProfile(model))) throw new HttpError(400, "INVALID_WAN_MODEL");
    if (Object.keys(config.image_types).some((model) => capability !== "image" || !models.includes(model))) throw new HttpError(400, "INVALID_IMAGE_MODEL_TYPES");
    if (Object.keys(config.video_types).some((model) => capability !== "video" || !models.includes(model))) throw new HttpError(400, "INVALID_VIDEO_MODEL_TYPES");
    if (Object.keys(config.model_descriptions).some((model) => !models.includes(model))) throw new HttpError(400, "INVALID_MODEL_DESCRIPTIONS");
    const { rows } = await db.query(`INSERT INTO channels (id,name,capability,models,image_types,video_types,model_descriptions,enabled,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
        ON CONFLICT (capability) DO UPDATE SET name=EXCLUDED.name,models=EXCLUDED.models,image_types=EXCLUDED.image_types,video_types=EXCLUDED.video_types,model_descriptions=EXCLUDED.model_descriptions,enabled=EXCLUDED.enabled,is_default=true
        RETURNING id,capability,models,image_types,video_types,model_descriptions,enabled,COALESCE(models->>0,'') AS default_model`,
        [randomUUID(), capabilityNames[capability], capability, JSON.stringify(models), JSON.stringify(config.image_types), JSON.stringify(config.video_types), JSON.stringify(config.model_descriptions), config.enabled]);
    res.json({ channel: rows[0] });
});

// Reseller does not implement account or usage APIs; never forward these requests.
for (const path of ["/account/summary", "/usage/query", "/usage/stats"] as const) {
    channelRouter.post(`/tokenone${path}`, (_req, _res) => {
        throw new HttpError(501, "TOKENONE_ACCOUNT_USAGE_UNAVAILABLE");
    });
}
