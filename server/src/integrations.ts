import { Router, json, raw, type ErrorRequestHandler } from "express";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { randomUUID, createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";
import { ensureKey, modelProvider } from "./tokenone.js";
import { saveFile, fileUrl, storedFileInfo, assertReferenceImageSize, collectDeletedFiles } from "./storage.js";
import { videoMetadata } from "./media-metadata.js";
import { audioFileType } from "./audio.js";
import { assertVideoDurations } from "./ai.js";
import { requireCreativeUser } from "./creative-user-auth.js";
import { canonical, integrationModels, integrationRequest, integrationPath, type IntegrationSelection } from "./integration-models.js";

const submission = z.object({ kind: z.enum(["image", "video", "music"]), model: z.string().min(1), preset: z.string().min(1).optional(), parameters: z.record(z.string(), z.unknown()).default({}), references: z.array(z.uuid()).default([]), prompt: z.string().refine(v => !!v.trim()) }).strict();
const authorizationCodes = new Set(["APP_USER_LOGIN_REQUIRED", "APP_USER_AUTHORIZATION_REQUIRED", "EMAIL_NOT_VERIFIED"]);
export const integrationsRouter = Router();
integrationsRouter.use(requireCreativeUser);
integrationsRouter.post("/references", raw({ type: () => true, limit: env.MAX_MEDIA_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(422, "invalid_reference_media");
    const type = await fileTypeFromBuffer(req.body).catch(() => undefined);
    let mimeType: string | undefined = type?.mime, kind = mimeType?.split("/")[0];
    // Some audio-only MP4 containers have the same signature as video MP4.
    if (kind === "audio" || mimeType === "video/mp4" && !videoMetadata(req.body).width) {
        const audio = await audioFileType(req.body).catch(() => { throw new HttpError(422, "invalid_reference_media"); });
        mimeType = audio.mimeType;
        kind = "audio";
    }
    if (!["image", "video", "audio"].includes(kind!)) throw new HttpError(415, "unsupported_media");
    if (kind === "image") {
        assertReferenceImageSize(req.body.length);
        const metadata = await sharp(req.body).metadata().catch(() => null);
        if (!metadata?.width || !metadata.height) throw new HttpError(422, "invalid_reference_image");
    }
    const file = await transaction(async client => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [res.locals.user.id]);
        const namespace = kind === "image" ? "image_files" : "media_files";
        const key = `${kind}:creative-reference:${createHash("sha256").update(req.body).digest("hex")}`;
        const url = await saveFile(res.locals.user.id, namespace, key, req.body, mimeType!, client);
        const row = (await client.query("UPDATE files SET delete_requested=false WHERE user_id=$1 AND namespace=$2 AND key=$3 RETURNING disk_id", [res.locals.user.id, namespace, key])).rows[0];
        const info = await storedFileInfo(res.locals.user.id, url, client);
        return { id: row.disk_id, kind, mimeType: info.mimeType, bytes: info.bytes, ...(info.width && info.height ? { width: info.width, height: info.height } : {}), ...("durationMs" in info ? { durationMs: info.durationMs } : {}) };
    });
    res.status(201).json(file);
});
integrationsRouter.delete("/references/:id", async (req, res) => {
    await transaction(async client => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [res.locals.user.id]);
        const changed = await client.query("UPDATE files SET delete_requested=true WHERE user_id=$1 AND namespace IN ('image_files','media_files') AND disk_id=$2 AND key ~ '^(image|video|audio):creative-reference:' RETURNING disk_id", [res.locals.user.id, z.uuid().parse(req.params.id)]);
        if (!changed.rowCount) throw new HttpError(404, "not_found");
    });
    await collectDeletedFiles(res.locals.user.id);
    res.status(204).end();
});
integrationsRouter.use(json({ limit: env.MAX_JSON_BYTES }));
async function referenceUrls(client: Pick<typeof db, "query">, userId: string, ids: string[]) {
    const urls = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    if (!ids.length) return urls;
    const rows = (await client.query("SELECT disk_id,namespace,key,bytes,mime_type FROM files WHERE user_id=$1 AND namespace IN ('image_files','media_files') AND disk_id=ANY($2::uuid[]) AND NOT delete_requested", [userId, ids])).rows;
    for (const id of ids) {
        const file = rows.find(row => row.disk_id === id);
        if (!file) throw new HttpError(404, "not_found");
        const target = file.mime_type.startsWith("image/") ? urls.images : file.mime_type.startsWith("video/") ? urls.videos : file.mime_type.startsWith("audio/") ? urls.audios : undefined;
        if (!target) throw new HttpError(422, "invalid_parameters");
        if (target === urls.images) assertReferenceImageSize(Number(file.bytes));
        if (Number(file.bytes) > env.MAX_MEDIA_BYTES) throw new HttpError(413, "reference_media_too_large");
        const url = fileUrl(file.namespace, file.key);
        const info = await storedFileInfo(userId, url, client);
        if (target === urls.images && (!info.width || !info.height)) throw new HttpError(422, "invalid_reference_image");
        target.push(url);
    }
    return urls;
}
async function findTask(client: Pick<typeof db, "query">, userId: string, operation: string) {
    const task = (await client.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND integration_operation=$2", [userId, z.uuid().parse(operation)])).rows[0];
    if (task && (task.hidden_from_works || task.hidden_from_history)) throw new HttpError(404, "not_found");
    return task;
}
async function outputs(task: any) {
    const result = task.result;
    const files = task.capability === "audio" ? result?.audios?.map((a: any) => a.file) : task.capability === "image" ? result?.data?.map((a: any) => a.file) : [result?.file];
    const found: any[] = [];
    for (const file of files || []) {
        const match = /^\/api\/files\/(image_files|media_files)\/(.+)$/.exec(file?.url || "");
        if (!match) continue;
        const row = (await db.query("SELECT * FROM files WHERE user_id=$1 AND namespace=$2 AND key=$3 AND NOT delete_requested", [task.user_id, match[1], decodeURIComponent(match[2])])).rows[0];
        if (!row) continue;
        try { await access(resolve(env.MEDIA_DIR, row.disk_id)); } catch { continue; }
        found.push({ id: row.disk_id, mimeType: row.mime_type, name: `${row.disk_id}.${row.mime_type.split("/")[1].replace(/[^a-z0-9]/gi, "")}`, path: resolve(env.MEDIA_DIR, row.disk_id) });
    }
    return found;
}
async function publicTask(task: any) {
    const files = await outputs(task);
    const status = task.status === "pending" ? task.upstream_id ? "running" : "queued" : ["cancelled", "expired"].includes(task.status) ? "failed" : task.status;
    let errorCode: string | undefined;
    if (["unknown", "failed"].includes(status) && authorizationCodes.has(task.error)) errorCode = "authorization_required";
    else if (status === "unknown") errorCode = task.capability === "video" && task.upstream_id
        ? task.upstream_error?.stage === "output" ? "output_incomplete" : "task_query_failed"
        : task.upstream_result ? "output_incomplete" : "submission_uncertain";
    else if (status === "failed") errorCode = task.error === "forbidden" ? "forbidden" : ["cancelled", "expired"].includes(task.status) ? task.status : "generation_failed";
    else if (status === "succeeded" && !files.length) errorCode = "output_unavailable";
    return { operationId: task.integration_operation, status, outputs: files.map(({ path, ...file }) => file), ...(errorCode ? { errorCode } : {}) };
}
integrationsRouter.get("/capabilities", async (_req, res) => {
    const user = res.locals.user;
    if (!user.email_verified || !(await db.query("SELECT 1 FROM key_bindings WHERE user_id=$1 AND provider=$2", [user.id, modelProvider])).rowCount) throw new HttpError(403, "authorization_required");
    const models = (await integrationModels()).map(({ id, name, description, kind, parameters, constraints, inputs, presets, defaultPreset }) => ({ id, name, ...(description ? { description } : {}), kind, parameters, constraints, inputs, presets: presets.map(({ id, parameters }) => ({ id, parameters })), defaultPreset }));
    res.json({ models, submission: { presetOnly: false, referenceMedia: true, referenceKinds: ["image", "video", "audio"], maxReferenceMediaBytes: env.MAX_MEDIA_BYTES, maxReferenceImageBytes: Math.min(env.MAX_MEDIA_BYTES, env.MAX_REFERENCE_IMAGE_BYTES) }, defaults: Object.fromEntries(["image", "video", "music"].flatMap(kind => { const model = models.find(m => m.kind === kind); return model ? [[kind, model.id]] : []; })) });
});
integrationsRouter.put("/jobs/:operationId", async (req, res) => {
    const operation = z.uuid().parse(req.params.operationId), input = submission.parse(req.body), user = res.locals.user;
    const task = await transaction(async client => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
        const previous = await findTask(client, user.id, operation);
        if (previous) {
            const saved = previous.integration_request, selection: IntegrationSelection = previous.integration_config;
            if (input.kind !== saved.kind || input.model !== saved.model || input.prompt !== saved.prompt || canonical(input.references) !== canonical(saved.references ?? []) || input.preset !== undefined && input.preset !== saved.preset) throw new HttpError(409, "operation_conflict");
            if (canonical({ ...saved, parameters: saved.parameters ?? {}, references: saved.references ?? [] }) === canonical({ ...input, preset: saved.preset })) return previous;
            try {
                if (canonical(integrationRequest(selection, input.prompt, input.parameters)) !== canonical(previous.request)) throw new Error();
            } catch { throw new HttpError(409, "operation_conflict"); }
            return previous;
        }
        const model = (await integrationModels(client)).find(m => m.id === input.model && m.kind === input.kind);
        const preset = model?.presets.find(p => p.id === (input.preset ?? model.defaultPreset));
        if (!model || !preset) throw new HttpError(422, "selection_unavailable");
        const selection = { ...preset.selection, references: await referenceUrls(client, user.id, input.references) };
        let snapshot;
        try {
            snapshot = integrationRequest(selection, input.prompt, input.parameters);
            if (selection.video) await assertVideoDurations(user.id, model.model, selection.video, selection.references, client);
        } catch { throw new HttpError(422, "invalid_parameters"); }
        const key = await ensureKey(user, res.locals.requestId, { client });
        return (await client.query(`INSERT INTO generation_tasks(id,user_id,channel_id,group_id,model,capability,path,status,provider,request,title,integration_operation,integration_request,integration_config)
            VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$13) RETURNING *`, [randomUUID(), user.id, model.channel.id, key.group_id, model.model, model.channel.capability, integrationPath(selection), modelProvider, JSON.stringify(snapshot), input.prompt, operation, JSON.stringify({ ...input, preset: preset.id }), JSON.stringify(selection)])).rows[0];
    });
    res.status(["pending", "running"].includes(task.status) ? 202 : 200).json(await publicTask(task));
});
integrationsRouter.get("/jobs/:operationId", async (req, res) => {
    const task = await findTask(db, res.locals.user.id, String(req.params.operationId));
    if (!task) throw new HttpError(404, "not_found");
    res.json(await publicTask(task));
});
integrationsRouter.get("/jobs/:operationId/outputs/:id", async (req, res) => {
    const task = await findTask(db, res.locals.user.id, String(req.params.operationId));
    if (!task) throw new HttpError(404, "not_found");
    const file = (await outputs(task)).find(f => f.id === req.params.id);
    if (!file) throw new HttpError(404, "not_found");
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.sendFile(file.path, error => { if (error && !res.headersSent) res.status(404).json({ error: { code: "not_found" } }); else if (error) res.end(); });
});
integrationsRouter.use((_req, _res) => { throw new HttpError(404, "not_found"); });
const errors: ErrorRequestHandler = (error, req, res, _next) => {
    let status = error instanceof HttpError ? error.status : error instanceof ZodError || error.type === "entity.parse.failed" ? 422 : error.type === "entity.too.large" ? 413 : 500;
    let code = error instanceof HttpError && /^[a-z_]+$/.test(error.code) ? error.code : status === 422 ? "invalid_parameters" : status === 413 ? "invalid_parameters" : "service_unavailable";
    if (["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(error.code)) code = "authentication_required";
    if (error.code === "CSRF_FAILED") code = "forbidden";
    if (error.code === "ACCOUNT_CHANGED") code = "account_changed";
    if (error.code === "UNSUPPORTED_MEDIA") code = "unsupported_media";
    if (error.code === "REFERENCE_IMAGE_TOO_LARGE") code = "reference_image_too_large";
    if (error.type === "entity.too.large" && req.path === "/references") code = "reference_media_too_large";
    if (status === 429) code = "rate_limited";
    if (authorizationCodes.has(error.code)) { status = 403; code = "authorization_required"; }
    if (!res.headersSent) res.status(status).json({ error: { code } }); else res.end();
};
integrationsRouter.use(errors);
