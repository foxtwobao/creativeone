import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { ensureKey, upstreamUrl, modelProvider, type Channel } from "./tokenone.js";
import { HttpError, requireUuid } from "./http.js";
import { saveFile, storedFileInfo, inlineStoredFile, mediaReferenceForUser, fileReferences, collectDeletedFiles } from "./storage.js";
import { persistRemoteMedia, readBytes } from "./media.js";
import { tokenoneError, modelErrorMessage } from "./model-errors.js";
import { imageRequestCapabilityError, videoRequestCapabilityError } from "./model-capabilities.js";
import { wanModelProfile } from "../../shared/video-models.js";

const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_MEDIA_BYTES, fieldSize: env.MAX_JSON_BYTES } }).any();
const endpoints: Record<string, string> = { "images/generations": "image", "images/edits": "image", "responses": "text", "chat/completions": "text", "audio/speech": "audio", "contents/generations/tasks": "video", videos: "video" };
const referenceUrl = z.union([z.string().regex(/^\/api\/files\/(image_files|media_files)\/[^/?#]+$/), z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
})]);
const wanRequest = z.object({
    model: z.string(), prompt: z.string().trim().min(1), seconds: z.string().regex(/^[1-9]\d*$/),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "adaptive"]),
    reference_images: z.array(z.object({ url: referenceUrl, role: z.enum(["reference_image", "first_frame", "last_frame"]).optional() }).strict()).max(10).default([]),
    reference_videos: z.array(z.object({ url: referenceUrl }).strict()).default([]),
    reference_audios: z.array(z.object({ url: referenceUrl }).strict()).default([]),
}).strict();
async function persistImages(userId: string, payload: any, signal: AbortSignal) {
    // OpenAI image responses contain either inline bytes or an expiring URL.
    if (!Array.isArray(payload?.data)) return payload;
    for (const image of payload.data) {
        if (typeof image.b64_json === "string" && image.b64_json) {
            image.url = await saveFile(userId, "image_files", `image:${randomUUID()}`, Buffer.from(image.b64_json, "base64"), "image/png");
            delete image.b64_json;
        } else if (typeof image.url === "string") image.url = (await persistRemoteMedia(userId, image.url, signal)).url;
    }
    for (const image of payload.data) if (image.url) image.file = await storedFileInfo(userId, image.url);
    return payload;
}

export const aiRouter = Router();
aiRouter.post("/tasks/status", async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.uuid()) }).strict().parse(req.body);
    const { rows } = await db.query("SELECT id,status FROM generation_tasks WHERE user_id=$1 AND id=ANY($2::uuid[]) AND NOT hidden_from_works", [res.locals.user.id, ids]);
    res.json({ tasks: rows });
});
aiRouter.get("/tasks", async (_req, res) => {
    const { rows } = await db.query("SELECT id,channel_id,upstream_id,model,capability,path,status,result,error,request,created_at,updated_at FROM generation_tasks WHERE user_id=$1 AND NOT hidden_from_works ORDER BY created_at DESC", [res.locals.user.id]);
    res.json({ tasks: rows.map((task) => ({ ...task, error_message: task.error ? modelErrorMessage(task.error) || "任务暂时无法完成，请查看错误详情或联系管理员。" : undefined })) });
});
aiRouter.delete("/tasks/:id", async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rowCount, rows } = await db.query("UPDATE generation_tasks SET hidden_from_works=true WHERE id=$1 AND user_id=$2 AND status IN ('succeeded','failed','cancelled','expired') RETURNING request,result", [id, res.locals.user.id]);
    if (!rowCount) throw new HttpError(409, "TASK_NOT_REMOVABLE");
    await collectDeletedFiles(res.locals.user.id, [...fileReferences(rows[0])]);
    res.json({ ok: true });
});
aiRouter.all("/ai/:channel/v1/*path", async (req, res, next) => {
    if (req.is("multipart/form-data")) return multipart(req, res, next);
    next();
}, async (req, res) => {
    const channelId = requireUuid(req.params.channel);
    const path = (Array.isArray(req.params.path) ? req.params.path : [req.params.path]).join("/");
    const userPrompt = req.body?.user_prompt === undefined ? undefined : z.string().parse(req.body.user_prompt);
    if (req.body) delete req.body.user_prompt;
    const videoMatch = /^(contents\/generations\/tasks|videos)\/([\w-]+)(\/resume)?$/.exec(path);
    const user = res.locals.user;
    let channel: Channel;
    if (videoMatch && ((req.method === "GET" && !videoMatch[3]) || (req.method === "POST" && videoMatch[3]))) {
        const { rows } = await db.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND channel_id=$2 AND upstream_id=$3 AND path=$4 AND capability='video'", [user.id, channelId, videoMatch[2], videoMatch[1]]);
        if (rows.length > 1) throw new HttpError(409, "TASK_PROVIDER_CHANGED");
        const task = rows[0];
        if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
        if (["succeeded", "failed"].includes(task.status) && task.result) return res.json(task.result);
        if (task.provider !== modelProvider) throw new HttpError(409, "TASK_PROVIDER_CHANGED");
        if (req.method === "POST") {
            await db.query("UPDATE generation_tasks SET status='pending',error=NULL,updated_at=now() WHERE id=$1 AND status='unknown'", [task.id]);
            return res.json({ id: task.upstream_id, status: "queued" });
        }
        return res.json(task.status === "unknown"
            ? { id: task.upstream_id, status: "paused", error: { message: modelErrorMessage(task.error) || "后台查询或保存暂时失败，任务已暂停，可手动恢复" } }
            : { id: task.upstream_id, status: "queued" });
    } else {
        channel = (await db.query("SELECT * FROM channels WHERE id=$1 AND enabled", [channelId])).rows[0];
        if (!channel) throw new HttpError(403, "CHANNEL_UNAVAILABLE");
        if (!(req.method === "GET" && path === "models") && !(req.method === "POST" && endpoints[path] === channel.capability)) throw new HttpError(403, "ENDPOINT_NOT_ALLOWED");
        if (req.method === "POST" && (!req.body || typeof req.body.model !== "string" || !channel.models.includes(req.body.model))) throw new HttpError(403, "MODEL_NOT_ALLOWED");
        if (req.method === "POST" && channel.capability === "image" && !channel.image_types?.[req.body.model]) throw new HttpError(400, "IMAGE_MODEL_TYPE_REQUIRED");
        if (req.method === "POST" && channel.capability === "video") {
            const kind = channel.video_types?.[req.body.model] || "seedance";
            if (path !== (kind === "wan" ? "videos" : "contents/generations/tasks")) throw new HttpError(403, "VIDEO_ENDPOINT_MISMATCH");
            if (kind === "wan") {
                req.body = wanRequest.parse(req.body);
                const profile = wanModelProfile(req.body.model);
                if (!profile) throw new HttpError(400, "INVALID_WAN_MODEL");
                if (!profile.referenceVideo && req.body.reference_videos?.length) throw new HttpError(400, "WAN_REFERENCE_VIDEO_UNSUPPORTED");
                if (!profile.referenceVideo && !req.body.reference_images?.length) throw new HttpError(400, "WAN_REFERENCE_IMAGE_REQUIRED");
            }
        }
    }
    if (req.method === "POST" && ["image", "video"].includes(channel.capability)) {
        const error = channel.capability === "image"
            ? imageRequestCapabilityError(req.body.model, channel.image_types![req.body.model], req.body, (req.files as Express.Multer.File[] || []).filter((file) => file.fieldname !== "mask").length)
            : videoRequestCapabilityError(req.body.model, channel.video_types?.[req.body.model] || "seedance", req.body);
        if (error) return res.status(400).json({ error: "MODEL_CAPABILITY_INVALID", message: error, retryable: false, requestId: res.locals.requestId });
    }
    const requestSnapshot = { ...structuredClone(req.body || {}), ...(userPrompt === undefined ? {} : { user_prompt: userPrompt }) };
    if (path === "videos") for (const field of ["reference_images", "reference_videos", "reference_audios"]) {
        for (const ref of req.body[field] || []) {
            if (!ref.url.startsWith("/api/files/")) continue;
            const match = /^\/api\/files\/(image_files|media_files)\/([^/?#]+)$/.exec(ref.url)!;
            ref.url = await mediaReferenceForUser(user.id, match[1], decodeURIComponent(match[2]), Date.now()+30*60_000);
        }
    }
    if (path === "contents/generations/tasks") for (const part of req.body.content || []) {
        const url = part.type === "video_url" ? part.video_url?.url : undefined;
        if (typeof url !== "string" || !url.startsWith("/api/files/media_files/")) continue;
        part.video_url.url = await mediaReferenceForUser(user.id, "media_files", decodeURIComponent(url.slice("/api/files/media_files/".length)), Date.now()+30*60_000);
    }
    const apiKey = await ensureKey(user, res.locals.requestId);
    const key = apiKey.key;
    if (path === "models") {
        // Administrator-curated model metadata, filtered by this channel’s model allowlist.
        const response = await fetch(upstreamUrl("models"), { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw await tokenoneError(response);
        const data = await response.json() as { data?: { id: string }[] };
        return res.json({ data: (data.data || []).filter((item) => channel.models.includes(item.id)) });
    }
    const taskId = randomUUID();
    res.setHeader("X-Generation-Task-Id", taskId);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    let body: BodyInit | undefined;
    if (req.method === "POST") {
        if (req.is("multipart/form-data")) {
            const form = new FormData();
            for (const [name, value] of Object.entries(req.body)) {
                for (const item of Array.isArray(value) ? value : [value]) {
                    if (typeof item !== "string") throw new HttpError(400, "INVALID_FORM_FIELD");
                    form.append(Array.isArray(value) ? `${name}[]` : name, item);
                }
            }
            for (const file of req.files as Express.Multer.File[]) form.append(file.fieldname, new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
            body = form;
        } else { headers["Content-Type"] = "application/json"; body = JSON.stringify(req.body); }
    }
    await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
        for (const key of fileReferences(requestSnapshot)) if (!(await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [user.id, key])).rowCount) throw new HttpError(404, "FILE_NOT_FOUND");
        await client.query("INSERT INTO generation_tasks (id,user_id,channel_id,group_id,model,capability,path,status,provider,request) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9)", [taskId, user.id, channelId, apiKey.group_id, req.body.model, channel.capability, path, modelProvider, JSON.stringify(requestSnapshot)]);
    });
    const signal = AbortSignal.timeout(600_000);
    try {
        const expandFiles = async (value: any): Promise<any> => {
            if (typeof value === "string" && value.startsWith("/api/files/")) return inlineStoredFile(user.id, value);
            if (Array.isArray(value)) return Promise.all(value.map(expandFiles));
            if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await expandFiles(item)])));
            return value;
        };
        if (req.method === "POST" && !req.is("multipart/form-data")) {
            const expanded = await expandFiles(req.body);
            if (path === "images/edits" && channel!.image_types?.[req.body.model] === "openai" && expanded.image_references) {
                const form = new FormData();
                const images = expanded.image_references;
                delete expanded.image_references;
                for (const [name, value] of Object.entries(expanded)) form.set(name, String(value));
                for (const image of images) {
                    const [prefix, data] = image.split(",");
                    const mime = /^data:([^;]+)/.exec(prefix)?.[1];
                    if (!mime || !data) throw new HttpError(400, "INVALID_FILE_REFERENCE");
                    form.append(images.length > 1 ? "image[]" : "image", new Blob([Buffer.from(data, "base64")], { type: mime }), "reference.png");
                }
                delete headers["Content-Type"]; body = form;
            } else body = JSON.stringify(expanded);
        }
        const upstream = await fetch(upstreamUrl(path), { method: req.method, headers, body, redirect: "error", signal });
        if (!upstream.ok) {
            const error = await tokenoneError(upstream);
            await db.query("UPDATE generation_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1", [taskId, error.code]);
            throw error;
        }
        const contentType = upstream.headers.get("content-type") || "application/json";
        if (channel.capability === "video" && !contentType.includes("json")) throw new HttpError(502, "INVALID_VIDEO_TASK");
        if (contentType.includes("text/event-stream") && upstream.body) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders();
            let text = "", failed = false, completed = false;
            const parser = createParser({ onEvent(event) {
                if (event.data === "[DONE]") { completed = true; return; }
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "error" || data.type === "response.failed" || data.error) failed = true;
                    if (data.type === "response.completed") completed = true;
                    if (data.type === "response.incomplete") failed = true;
                    if (data.type === "response.output_text.delta") text += data.delta || "";
                    for (const choice of data.choices || []) text += choice.delta?.content || "";
                } catch { /* Non-JSON keepalives do not carry message content. */ }
            } });
            const decoder = new TextDecoder();
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
                parser.feed(decoder.decode(chunk, { stream: true }));
                if (!res.destroyed) res.write(chunk);
            }
            parser.feed(decoder.decode());
            await db.query("UPDATE generation_tasks SET status=$2,result=$3,updated_at=now() WHERE id=$1", [taskId, failed ? "failed" : completed ? "succeeded" : "unknown", JSON.stringify({ text })]);
            return res.end();
        }
        if (!contentType.includes("json")) {
            const bytes = await readBytes(upstream);
            const url = await saveFile(user.id, "media_files", `file:${randomUUID()}`, bytes, contentType.split(";")[0]);
            await db.query("UPDATE generation_tasks SET status='succeeded',result=$2,updated_at=now() WHERE id=$1", [taskId, JSON.stringify({ url })]);
            if (!res.destroyed) res.type(contentType).send(bytes);
            return;
        }
        let result: any = await upstream.json();
        if (result?.error && channel.capability !== "video") {
            await db.query("UPDATE generation_tasks SET status='failed',error='TOKENONE_GENERATION_FAILED',updated_at=now() WHERE id=$1", [taskId]);
            throw new HttpError(422, "TOKENONE_GENERATION_FAILED");
        }
        if (channel.capability === "text") {
            const text = result.output_text || result.choices?.[0]?.message?.content || result.output?.flatMap((item: any) => item.content || []).map((item: any) => item.text || "").join("");
            if (typeof text === "string") result.text = text;
        }
        if (channel.capability === "image") result = await persistImages(user.id, result, signal);
        let status = "succeeded";
        if (channel.capability === "video") {
            const video = result.data || result;
            const upstreamId = video.id || video.task_id;
            if (typeof upstreamId !== "string" || !/^[\w-]+$/.test(upstreamId)) throw new HttpError(502, "INVALID_VIDEO_TASK");
            status = ["failed", "cancelled", "expired"].includes(video.status) ? "failed" : "pending";
            // Persist the billable task before responding; the worker owns all subsequent processing.
            result = status === "failed" ? { id: upstreamId, status: video.status, error: { message: "视频生成失败" } } : { id: upstreamId, status: "queued" };
            await db.query("UPDATE generation_tasks SET upstream_id=$2,status=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1", [taskId, upstreamId, status, JSON.stringify(result)]);
            if (!res.destroyed) res.json(result);
            return;
        }
        await db.query("UPDATE generation_tasks SET status=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1", [taskId, status, JSON.stringify(result)]);
        if (!res.destroyed) res.json(result);
    } catch (error) {
        // A transport failure does not prove that a billable upstream call failed.
        if (!(error instanceof HttpError)) await db.query("UPDATE generation_tasks SET status='unknown',error='UPSTREAM_RESULT_UNKNOWN',updated_at=now() WHERE id=$1 AND status NOT IN ('succeeded','failed')", [taskId]);
        else if (error.status < 500) await db.query("UPDATE generation_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='running'", [taskId, error.code]);
        else if (error.status === 502 || error.status === 413) await db.query("UPDATE generation_tasks SET status='unknown',error=$2,updated_at=now() WHERE id=$1 AND status='running'", [taskId, error.code]);
        if (res.headersSent) { res.end(); return; }
        throw error;
    }
});
