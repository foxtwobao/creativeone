import pg from "pg";
import sharp from "sharp";
import { env } from "./config.js";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./db.js";
import { ensureKey, upstreamUrl, modelProvider, type Channel } from "./tokenone.js";
import { HttpError } from "./http.js";
import { saveFile, storedFileInfo, inlineStoredFile, mediaReferenceForUser } from "./storage.js";
import { downloadRemoteMedia } from "./media.js";
import { tokenoneError } from "./model-errors.js";
import { attachCanvasTask, finishCanvasTask } from "./canvas-tasks.js";

async function imageBytes(payload: any, signal: AbortSignal) {
    if (!Array.isArray(payload?.data) || !payload.data.length) throw new HttpError(502, "INVALID_IMAGE_RESPONSE");
    return Promise.all(payload.data.map(async (image: any) => {
        const file = typeof image.b64_json === "string" && image.b64_json ? { bytes: Buffer.from(image.b64_json, "base64"), mimeType: "image/png" }
            : typeof image.url === "string" ? await downloadRemoteMedia(image.url, signal) : undefined;
        if (!file || !file.mimeType.startsWith("image/")) throw new HttpError(502, "INVALID_IMAGE_RESPONSE");
        const metadata = await sharp(file.bytes).metadata().catch(() => null);
        if (!metadata?.width || !metadata.height) throw new HttpError(502, "INVALID_IMAGE_RESPONSE");
        return { ...file, mimeType: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}` };
    }));
}
async function storeImages(userId: string, payload: any, images: Awaited<ReturnType<typeof imageBytes>>, client: Pick<typeof db, "query">) {
    for (let index = 0; index < images.length; index++) {
        const image = payload.data[index], file = images[index];
        image.url = await saveFile(userId, "image_files", `image:${randomUUID()}`, file.bytes, file.mimeType, client);
        delete image.b64_json;
        image.file = await storedFileInfo(userId, image.url, client);
    }
    return payload;
}
export async function persistImages(userId: string, payload: any, signal: AbortSignal) {
    return storeImages(userId, payload, await imageBytes(payload, signal), db);
}

async function mediaBody(userId: string, path: string, channel: Channel, snapshot: any) {
    const input = structuredClone(snapshot);
    delete input.user_prompt;
    delete input.canvas_source;
    delete input.canvas_submission;
    if (path === "videos") for (const field of ["reference_images", "reference_videos", "reference_audios"]) {
        for (const ref of input[field] || []) if (ref.url.startsWith("/api/files/")) {
            const match = /^\/api\/files\/(image_files|media_files)\/([^/?#]+)$/.exec(ref.url);
            if (!match) throw new HttpError(400, "INVALID_FILE_REFERENCE");
            ref.url = await mediaReferenceForUser(userId, match[1], decodeURIComponent(match[2]), Date.now() + 30 * 60_000);
        }
    }
    if (path === "contents/generations/tasks") for (const part of input.content || []) {
        const url = part.video_url?.url || part.audio_url?.url;
        if (typeof url === "string" && url.startsWith("/api/files/media_files/")) {
            (part.video_url || part.audio_url).url = await mediaReferenceForUser(userId, "media_files", decodeURIComponent(url.slice("/api/files/media_files/".length)), Date.now() + 30 * 60_000);
        }
    }
    const expand = async (value: any): Promise<any> => {
        if (typeof value === "string" && value.startsWith("/api/files/")) return inlineStoredFile(userId, value);
        if (Array.isArray(value)) return Promise.all(value.map(expand));
        if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await expand(item)])));
        return value;
    };
    const expanded = await expand(input);
    if (path === "images/edits" && channel.image_types?.[input.model] === "openai" && expanded.image_references) {
        const form = new FormData(), images = expanded.image_references;
        delete expanded.image_references;
        for (const [name, value] of Object.entries(expanded)) form.set(name, String(value));
        for (const image of images) {
            const [prefix, data] = image.split(","), mime = /^data:([^;]+)/.exec(prefix)?.[1];
            if (!mime || !data) throw new HttpError(400, "INVALID_FILE_REFERENCE");
            form.append(images.length > 1 ? "image[]" : "image", new Blob([Buffer.from(data, "base64")], { type: mime }), "reference.png");
        }
        return { body: form, headers: {} };
    }
    return { body: JSON.stringify(expanded), headers: { "Content-Type": "application/json" } };
}

// The session lock lasts through the upstream request, without holding project/user row locks.
// A lost session cannot publish a result after another instance has recovered its task.
export async function executeMediaTask(taskId: string) {
    const owner = new pg.Client({ connectionString: env.DATABASE_URL });
    let disconnected = false;
    owner.on("error", () => { disconnected = true; });
    owner.on("end", () => { disconnected = true; });
    const token = randomUUID();
    let locked = false;
    try {
        await owner.connect();
        locked = (await owner.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [taskId])).rows[0].locked;
        if (!locked) return;
        const task = (await owner.query("SELECT * FROM generation_tasks WHERE id=$1", [taskId])).rows[0];
        if (!task || task.upstream_id || !["pending", "running"].includes(task.status)) return;
        if (task.status === "running" && task.execution_token) {
            const video = task.capability === "video" ? task.upstream_result?.data || task.upstream_result : undefined;
            const upstreamId = video?.id || video?.task_id;
            const knownVideo = typeof upstreamId === "string" && /^[\w-]+$/.test(upstreamId);
            await owner.query("UPDATE generation_tasks SET status=$3,error=$4,upstream_id=$5,result=CASE WHEN $5::text IS NOT NULL THEN $6::jsonb ELSE result END,execution_token=NULL,updated_at=now() WHERE id=$1 AND execution_token=$2", [taskId, task.execution_token, knownVideo ? "pending" : "unknown", knownVideo ? null : "UPSTREAM_RESULT_UNKNOWN", knownVideo ? upstreamId : null, JSON.stringify({ id: upstreamId, status: "queued" })]);
            await finishCanvasTask(taskId);
            return;
        }
        const claimed = await owner.query("UPDATE generation_tasks SET status='running',execution_token=$2,updated_at=now() WHERE id=$1 AND execution_token IS NULL AND status IN ('pending','running') RETURNING *", [taskId, token]);
        if (!claimed.rowCount) return;
        const publish = async (status: string, result: any, error: string | null, upstreamId: string | null = null) => {
            if (disconnected) return;
            await owner.query("SELECT 1");
            return transaction(async (client) => {
                await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [task.user_id]);
                const current = await client.query("SELECT id FROM generation_tasks WHERE id=$1 AND execution_token=$2 FOR UPDATE", [taskId, token]);
                if (!current.rowCount) return;
                const value = typeof result === "function" ? await result(client) : result;
                const changed = await client.query("UPDATE generation_tasks SET status=$3,result=$4,error=$5,upstream_id=$6,execution_token=NULL,upstream_result=CASE WHEN $3='succeeded' THEN NULL ELSE upstream_result END,updated_at=now() WHERE id=$1 AND execution_token=$2 RETURNING id", [taskId, token, status, JSON.stringify(value), error, upstreamId]);
                if (changed.rowCount) await attachCanvasTask(taskId, client);
            }, owner);
        };
        let dispatched = false;
        try {
            const signal = AbortSignal.timeout(600_000);
            let result = task.upstream_result;
            if (!result) {
                if (task.provider !== modelProvider) throw new HttpError(409, "TASK_PROVIDER_CHANGED");
                const channel: Channel = (await db.query("SELECT * FROM channels WHERE id=$1 AND enabled", [task.channel_id])).rows[0];
                if (!channel || !channel.models.includes(task.model)) throw new HttpError(403, "CHANNEL_UNAVAILABLE");
                const user = (await db.query("SELECT * FROM users WHERE id=$1", [task.user_id])).rows[0];
                const key = await ensureKey(user, taskId);
                if (key.group_id !== task.group_id) throw new HttpError(409, "TASK_PROVIDER_CHANGED");
                const request = await mediaBody(task.user_id, task.path, channel, task.request);
                if (disconnected) return;
                await owner.query("SELECT 1");
                dispatched = true;
                const upstream = await fetch(upstreamUrl(task.path), { method: "POST", headers: { ...request.headers, Authorization: `Bearer ${key.key}` }, body: request.body, redirect: "error", signal });
                if (!upstream.ok) { const error = await tokenoneError(upstream); await publish("failed", null, error.code); return; }
                result = await upstream.json();
                if (result?.error) { await publish("failed", null, "TOKENONE_GENERATION_FAILED"); return; }
                await db.query("UPDATE generation_tasks SET upstream_result=$3 WHERE id=$1 AND execution_token=$2", [taskId, token, JSON.stringify(result)]);
            } else dispatched = true;
            if (task.capability === "image") {
                const images = await imageBytes(result, signal);
                await publish("succeeded", (client: Pick<typeof db, "query">) => storeImages(task.user_id, result, images, client), null);
            } else {
                const video = result.data || result, id = video.id || video.task_id;
                if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new HttpError(502, "INVALID_VIDEO_TASK");
                const failed = ["failed", "cancelled", "expired"].includes(video.status);
                await publish(failed ? "failed" : "pending", failed ? { id, status: video.status, error: { message: "视频生成失败" } } : { id, status: "queued" }, failed ? "TOKENONE_GENERATION_FAILED" : null, id);
            }
        } catch (error) {
            await publish(dispatched ? "unknown" : "failed", null, error instanceof HttpError ? error.code : "UPSTREAM_RESULT_UNKNOWN");
        }
    } finally {
        if (locked) await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [taskId]).catch(() => undefined);
        await owner.end();
    }
}

export function startGenerationWorker() {
    const active = new Set<string>();
    const tick = async () => {
        const { rows } = await db.query("SELECT id FROM generation_tasks WHERE capability IN ('image','video') AND upstream_id IS NULL AND (status='pending' OR (status='running' AND execution_token IS NOT NULL)) ORDER BY created_at");
        for (const { id } of rows) if (!active.has(id)) {
            active.add(id);
            void executeMediaTask(id).catch(() => console.error(JSON.stringify({ taskId: id, code: "GENERATION_WORKER_FAILED" }))).finally(() => active.delete(id));
        }
    };
    void tick().catch(() => undefined);
    return setInterval(() => void tick().catch(() => undefined), 5000);
}
