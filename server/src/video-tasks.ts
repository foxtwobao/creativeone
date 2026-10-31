import pg from "pg";
import { env } from "./config.js";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./db.js";
import { HttpError } from "./http.js";
import { readBytes, saveDownloadedMedia } from "./media.js";
import { ensureKey, modelProvider, upstreamUrl } from "./tokenone.js";
import { tokenoneError, modelErrorMessage, upstreamErrorDetails } from "./model-errors.js";
import { VIDEO_WORKER_INTERVAL_MS } from "../../shared/video-tasks.js";
import { attachCanvasTask, finishCanvasTask } from "./canvas-tasks.js";

const active = new Map<string, Promise<void>>();

export function processVideoTask(taskId: string): Promise<void> {
    const existing = active.get(taskId);
    if (existing) return existing;
    const work = poll(taskId).finally(() => { active.delete(taskId); });
    active.set(taskId, work);
    return work;
}

async function poll(taskId: string) {
    const requestId = randomUUID();
    const owner = new pg.Client({ connectionString: env.DATABASE_URL });
    let locked = false, disconnected = false;
    let querying = false;
    owner.on("error", () => { disconnected = true; });
    owner.on("end", () => { disconnected = true; });
    try {
        await owner.connect();
        locked = (await owner.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [taskId])).rows[0].locked;
        if (!locked) return;
        const task = (await db.query("SELECT * FROM generation_tasks WHERE id=$1 AND capability='video' AND provider=$2 AND status='pending' AND upstream_id IS NOT NULL", [taskId, modelProvider])).rows[0];
        if (!task) return;
        const user = (await db.query("SELECT * FROM users WHERE id=$1", [task.user_id])).rows[0];
        const key = await ensureKey(user, requestId);
        if (key.group_id !== task.group_id) throw new HttpError(409, "TASK_GROUP_CHANGED");
        const signal = AbortSignal.timeout(600_000);
        querying = true;
        const response = await fetch(upstreamUrl(`${task.path}/${encodeURIComponent(task.upstream_id)}`), {
            headers: { Authorization: `Bearer ${key.key}` }, redirect: "error", signal,
        });
        if (!response.ok) throw await tokenoneError(response);
        const payload: any = await response.json();
        if (payload?.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new HttpError(502, "INVALID_VIDEO_TASK");
        const video = payload?.data || payload;
        if (typeof video?.status !== "string") throw new HttpError(502, "INVALID_VIDEO_TASK");
        querying = false;
        const status = ["failed", "cancelled", "expired"].includes(video.status) ? "failed" : ["succeeded", "completed"].includes(video.status) ? "succeeded" : "pending";
        const wan = task.path === "videos";
        let media: Parameters<typeof saveDownloadedMedia>[1] | undefined;
        if (status === "succeeded") {
            // Only the session lock is held during transfers; no project/user row locks are held.
            // Use TokenONE's public task ID for every protocol; never authenticate a provider URL.
            const content = await fetch(upstreamUrl(`videos/${encodeURIComponent(task.upstream_id)}/content`), {
                method: "GET", headers: { Authorization: `Bearer ${key.key}` }, redirect: "error", signal,
            });
            const mimeType = (content.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            if (!content.ok) {
                if (mimeType.includes("json")) throw await tokenoneError(content);
                throw new HttpError(502, "MEDIA_DOWNLOAD_FAILED");
            }
            if (!mimeType.startsWith("video/") && mimeType !== "application/octet-stream") throw new HttpError(502, "INVALID_VIDEO_TASK");
            const bytes = await readBytes(content);
            if (!bytes.length) throw new HttpError(502, "EMPTY_UPSTREAM_RESPONSE");
            media = { bytes, mimeType: mimeType === "application/octet-stream" ? "video/mp4" : mimeType };
        }
        if (disconnected) return;
        await owner.query("SELECT 1");
        await transaction(async (client) => {
            await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [task.user_id]);
            const current = (await client.query("SELECT status FROM generation_tasks WHERE id=$1 FOR UPDATE", [taskId])).rows[0];
            if (current.status !== "pending") return;
            const file = media ? await saveDownloadedMedia(task.user_id, media, client) : undefined;
            const result = { id: task.upstream_id, status: video.status, ...(file ? { file, ...(wan ? { metadata: { url: file.url } } : { content: { video_url: file.url } }) } : {}), ...(status === "failed" ? { error: { message: modelErrorMessage(undefined, upstreamErrorDetails(video)) || "视频生成失败，请查看云端任务记录或联系管理员" } } : {}) };
            await client.query("UPDATE generation_tasks SET status=$2,result=$3,error=NULL,upstream_error=$4,updated_at=now() WHERE id=$1", [taskId, status, JSON.stringify(result), status === "failed" ? JSON.stringify(upstreamErrorDetails(video)) : null]);
            await attachCanvasTask(taskId, client);
        }, owner);
    } catch (error) {
        if (disconnected || !locked) return;
        const code = error instanceof HttpError ? error.code : "UPSTREAM_RESULT_UNKNOWN";
        if (querying) {
            await owner.query("UPDATE generation_tasks SET upstream_error=$2,updated_at=now() WHERE id=$1 AND status='pending'", [taskId, error instanceof HttpError ? JSON.stringify(error.upstreamError || { code, message: error.message }) : JSON.stringify({ message: "上游查询网络异常或响应无法读取，后台将继续查询" })]);
            console.warn(JSON.stringify({ taskId, requestId, code, retrying: true }));
            return;
        }
        await owner.query("UPDATE generation_tasks SET status='unknown',error=$2,upstream_error=$3,updated_at=now() WHERE id=$1 AND status='pending'", [taskId, code, error instanceof HttpError ? JSON.stringify(error.upstreamError || null) : null]);
        console.warn(JSON.stringify({ taskId, requestId, code }));
        await finishCanvasTask(taskId);
    } finally {
        if (locked) await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [taskId]).catch(() => undefined);
        await owner.end();
    }
}

export function startVideoWorker() {
    let stopped = false, scanning = false;
    const scan = async () => {
        if (stopped || scanning) return;
        scanning = true;
        try {
            const { rows } = await db.query("SELECT id FROM generation_tasks WHERE capability='video' AND provider=$1 AND status='pending' AND upstream_id IS NOT NULL", [modelProvider]);
            if (!stopped) for (const task of rows) void processVideoTask(task.id).catch(() => console.warn(JSON.stringify({ taskId: task.id, code: "VIDEO_WORKER_DATABASE_ERROR" })));
        } catch { console.warn(JSON.stringify({ code: "VIDEO_WORKER_DATABASE_ERROR" })); }
        finally { scanning = false; }
    };
    const timer = setInterval(() => { void scan(); }, VIDEO_WORKER_INTERVAL_MS);
    void scan();
    return async () => { stopped = true; clearInterval(timer); await Promise.allSettled([...active.values()]); };
}
