import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import { db } from "./db.js";
import { env } from "./config.js";
import { ensureKey, upstreamUrl, type Channel } from "./tokenone.js";
import { HttpError, requireUuid } from "./http.js";
import { saveFile } from "./storage.js";
import { tokenoneError, modelErrorMessage } from "./model-errors.js";

const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_MEDIA_BYTES, fieldSize: env.MAX_JSON_BYTES } }).any();
const endpoints: Record<string, string> = { "images/generations": "image", "images/edits": "image", "responses": "text", "chat/completions": "text", "audio/speech": "audio", "videos": "video" };
const allowedMediaHosts = new Set([...(env.TOKENONE_BASE_URL ? [new URL(env.TOKENONE_BASE_URL).host] : []), ...env.MEDIA_DOWNLOAD_HOSTS.split(",").map((item) => item.trim()).filter(Boolean)]);

async function readBytes(response: Response) {
    if (!response.body) throw new HttpError(502, "EMPTY_UPSTREAM_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > env.MAX_MEDIA_BYTES) throw new HttpError(413, "FILE_TOO_LARGE");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
async function persistRemoteMedia(userId: string, url: string, signal: AbortSignal) {
    const parsed = new URL(url);
    // Only administrator-trusted result hosts; redirects cannot escape the allowlist.
    if (!allowedMediaHosts.has(parsed.host) || parsed.username || parsed.password || parsed.protocol !== "https:") throw new HttpError(502, "MEDIA_HOST_NOT_ALLOWED");
    const response = await fetch(parsed, { redirect: "error", signal });
    if (!response.ok) throw new HttpError(502, "MEDIA_DOWNLOAD_FAILED");
    const mime = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const ns = mime.startsWith("image/") ? "image_files" : "media_files";
    return saveFile(userId, ns, `${mime.startsWith("image/") ? "image" : "file"}:${randomUUID()}`, await readBytes(response), mime);
}
async function persistImages(userId: string, payload: any, signal: AbortSignal) {
    // OpenAI image responses contain either inline bytes or an expiring URL.
    if (!Array.isArray(payload?.data)) return payload;
    for (const image of payload.data) {
        if (typeof image.b64_json === "string") {
            image.url = await saveFile(userId, "image_files", `image:${randomUUID()}`, Buffer.from(image.b64_json, "base64"), "image/png");
            delete image.b64_json;
        } else if (typeof image.url === "string") image.url = await persistRemoteMedia(userId, image.url, signal);
    }
    return payload;
}

export const aiRouter = Router();
aiRouter.get("/tasks", async (_req, res) => {
    const { rows } = await db.query("SELECT id,channel_id,upstream_id,model,capability,status,result,error,created_at,updated_at FROM generation_tasks WHERE user_id=$1 ORDER BY created_at DESC", [res.locals.user.id]);
    res.json({ tasks: rows.map((task) => ({ ...task, error_message: task.error ? modelErrorMessage(task.error) || "任务暂时无法完成，请查看错误详情或联系管理员。" : undefined })) });
});
aiRouter.all("/ai/:channel/v1/*path", async (req, res, next) => {
    if (req.is("multipart/form-data")) return multipart(req, res, next);
    next();
}, async (req, res) => {
    const channelId = requireUuid(req.params.channel);
    const path = (Array.isArray(req.params.path) ? req.params.path : [req.params.path]).join("/");
    const videoMatch = /^videos\/([\w-]+)(\/content)?$/.exec(path);
    const user = res.locals.user;
    let task: any;
    let channel: Channel;
    if (req.method === "GET" && videoMatch) {
        task = (await db.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND channel_id=$2 AND upstream_id=$3 AND capability='video'", [user.id, channelId, videoMatch[1]])).rows[0];
        if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
        channel = { id: channelId, capability: "video", models: [task.model], enabled: true };
    } else {
        channel = (await db.query("SELECT * FROM channels WHERE id=$1 AND enabled", [channelId])).rows[0];
        if (!channel) throw new HttpError(403, "CHANNEL_UNAVAILABLE");
        if (!(req.method === "GET" && path === "models") && !(req.method === "POST" && endpoints[path] === channel.capability)) throw new HttpError(403, "ENDPOINT_NOT_ALLOWED");
        if (req.method === "POST" && (!req.body || typeof req.body.model !== "string" || !channel.models.includes(req.body.model))) throw new HttpError(403, "MODEL_NOT_ALLOWED");
    }
    const apiKey = await ensureKey(user, res.locals.requestId);
    if (task && task.group_id !== apiKey.group_id) throw new HttpError(409, "TASK_GROUP_CHANGED");
    const key = apiKey.key;
    if (path === "models") {
        // Administrator-curated model metadata, filtered by this channel’s model allowlist.
        const response = await fetch(upstreamUrl("models"), { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw await tokenoneError(response);
        const data = await response.json() as { data?: { id: string }[] };
        return res.json({ data: (data.data || []).filter((item) => channel.models.includes(item.id)) });
    }
    const taskId = task?.id || randomUUID();
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
    const signal = AbortSignal.timeout(600_000);
    if (!task) await db.query("INSERT INTO generation_tasks (id,user_id,channel_id,group_id,model,capability,path,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'running')", [taskId, user.id, channelId, apiKey.group_id, req.body.model, channel.capability, path]);
    try {
        const upstream = await fetch(upstreamUrl(path), { method: req.method, headers, body, redirect: "error", signal });
        if (!upstream.ok) {
            const error = await tokenoneError(upstream);
            await db.query("UPDATE generation_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1", [taskId, error.code]);
            throw error;
        }
        const contentType = upstream.headers.get("content-type") || "application/json";
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
        if (result?.error) {
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
            if (!task && (typeof upstreamId !== "string" || !/^[\w-]+$/.test(upstreamId))) throw new HttpError(502, "INVALID_VIDEO_TASK");
            status = ["failed", "error", "cancelled"].includes(video.status) ? "failed" : ["completed", "succeeded", "success"].includes(video.status) ? "succeeded" : "pending";
            if (typeof video.url === "string" && status === "succeeded") video.url = await persistRemoteMedia(user.id, video.url, signal);
            await db.query("UPDATE generation_tasks SET upstream_id=COALESCE(upstream_id,$2) WHERE id=$1", [taskId, upstreamId || videoMatch?.[1]]);
        }
        await db.query("UPDATE generation_tasks SET status=$2,result=$3,updated_at=now() WHERE id=$1", [taskId, status, JSON.stringify(result)]);
        if (!res.destroyed) res.json(result);
    } catch (error) {
        // A transport failure does not prove that a billable upstream call failed.
        if (!(error instanceof HttpError)) await db.query("UPDATE generation_tasks SET status='unknown',error='UPSTREAM_RESULT_UNKNOWN',updated_at=now() WHERE id=$1", [taskId]);
        else if (error.status === 502 || error.status === 413) await db.query("UPDATE generation_tasks SET status='unknown',error=$2,updated_at=now() WHERE id=$1 AND status='running'", [taskId, error.code]);
        if (res.headersSent) { res.end(); return; }
        throw error;
    }
});
