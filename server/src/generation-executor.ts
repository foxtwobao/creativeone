import pg from "pg";
import sharp from "sharp";
import { env } from "./config.js";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./db.js";
import { ensureKey, upstreamUrl, modelProvider, type Channel } from "./tokenone.js";
import { HttpError } from "./http.js";
import { saveFile, storedFileInfo, inlineStoredFile, mediaReferenceForUser, signWanMedia } from "./storage.js";
import { downloadRemoteMedia } from "./media.js";
import { tokenoneError, modelErrorMessage, upstreamErrorDetails } from "./model-errors.js";
import { audioRequestBody, type AudioResult } from "../../shared/audio.js";
import { audioSources, audioFileType, audioDispatcher, AUDIO_REQUEST_TIMEOUT_MS } from "./audio.js";
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
    if (channel.capability === "audio") return { body: JSON.stringify(audioRequestBody(snapshot.model, snapshot.audio_type, snapshot.audio_input, snapshot.audio_context)), headers: { "Content-Type": "application/json" } };
    const input = structuredClone(snapshot);
    delete input.user_prompt;
    delete input.canvas_source;
    delete input.canvas_submission;
    if (path === "videos") await signWanMedia(userId, input.metadata?.input.media || []);
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
        if (task.status === "running" && task.execution_token && !(["audio", "text"].includes(task.capability) && task.upstream_result)) {
            const video = task.capability === "video" ? task.upstream_result?.data || task.upstream_result : undefined;
            const upstreamId = video?.id || video?.task_id;
            const knownVideo = typeof upstreamId === "string" && /^[\w-]+$/.test(upstreamId);
            await owner.query("UPDATE generation_tasks SET status=$3,error=$4,upstream_id=$5,result=CASE WHEN $5::text IS NOT NULL THEN $6::jsonb ELSE result END,execution_token=NULL,updated_at=now() WHERE id=$1 AND execution_token=$2", [taskId, task.execution_token, knownVideo ? "pending" : "unknown", knownVideo ? null : "UPSTREAM_RESULT_UNKNOWN", knownVideo ? upstreamId : null, JSON.stringify({ id: upstreamId, status: "queued" })]);
            await finishCanvasTask(taskId);
            return;
        }
        if (["audio", "text"].includes(task.capability) && task.upstream_result && task.execution_token) await owner.query("UPDATE generation_tasks SET execution_token=NULL WHERE id=$1", [taskId]);
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
                const changed = await client.query("UPDATE generation_tasks SET status=$3,result=$4,error=$5,upstream_id=$6,execution_token=NULL,upstream_result=CASE WHEN $3='succeeded' AND capability<>'audio' THEN NULL ELSE upstream_result END,updated_at=now() WHERE id=$1 AND execution_token=$2 RETURNING id", [taskId, token, status, JSON.stringify(value), error, upstreamId]);
                if (changed.rowCount) await attachCanvasTask(taskId, client);
            }, owner);
        };
        let dispatched = false;
        const saveError = (detail: unknown) => owner.query("UPDATE generation_tasks SET upstream_error=$3 WHERE id=$1 AND execution_token=$2", [taskId, token, JSON.stringify(detail)]);
        const signal = AbortSignal.timeout(task.capability === "audio" ? AUDIO_REQUEST_TIMEOUT_MS : 600_000);
        try {
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
                const upstream = await fetch(upstreamUrl(task.path), { method: "POST", headers: { ...request.headers, Authorization: `Bearer ${key.key}` }, body: request.body, redirect: "error", signal, ...(task.capability === "audio" ? { dispatcher: audioDispatcher } : {}) });
                if (!upstream.ok) { const error = await tokenoneError(upstream); await saveError(error.upstreamError); await publish("failed", null, error.code); return; }
                result = await upstream.json();
                if (result?.error) { await saveError(upstreamErrorDetails(result)); await publish("failed", null, "TOKENONE_GENERATION_FAILED"); return; }
                await db.query("UPDATE generation_tasks SET upstream_result=$3 WHERE id=$1 AND execution_token=$2", [taskId, token, JSON.stringify(result)]);
            } else dispatched = true;
            if (task.capability === "text") {
                const text = result.output_text || result.output?.filter((item: any) => item.type === "message").flatMap((item: any) => item.content || []).filter((item: any) => item.type === "output_text").map((item: any) => item.text || "").join("");
                if (result.status !== "completed" || typeof text !== "string" || !text.trim()) { await publish("failed", null, "INVALID_TEXT_RESPONSE"); return; }
                await publish("succeeded", { text }, null);
            } else if (task.capability === "image") {
                const images = await imageBytes(result, signal);
                await publish("succeeded", (client: Pick<typeof db, "query">) => storeImages(task.user_id, result, images, client), null);
            } else if (task.capability === "audio") {
                const sources = audioSources(result, task.request.audio_type);
                let saved: AudioResult = task.result || { audios: sources.map(() => ({})) };
                for (let index = 0; index < sources.length; index++) {
                    if (saved.audios[index]?.file) continue;
                    try {
                        const remote = await downloadRemoteMedia(sources[index], signal);
                        const info = await audioFileType(remote.bytes);
                        saved = await transaction(async (client) => {
                            const next = structuredClone(saved);
                            await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [task.user_id]);
                            if (!(await client.query("SELECT id FROM generation_tasks WHERE id=$1 AND execution_token=$2 FOR UPDATE", [taskId, token])).rowCount) throw new HttpError(409, "TASK_EXECUTION_CHANGED");
                            const url = await saveFile(task.user_id, "media_files", `audio:${taskId}:${index}`, remote.bytes, info.mimeType, client);
                            next.audios[index] = { file: { ...await storedFileInfo(task.user_id, url, client), ...info } };
                            next.defaultIndex ??= index;
                            await client.query("UPDATE generation_tasks SET result=$3,updated_at=now() WHERE id=$1 AND execution_token=$2", [taskId, token, JSON.stringify(next)]);
                            await attachCanvasTask(taskId, client);
                            return next;
                        }, owner);
                    } catch (error) {
                        if (disconnected) return;
                        saved.audios[index] = { error: error instanceof HttpError ? error.code : "MEDIA_DOWNLOAD_FAILED" };
                        await owner.query("UPDATE generation_tasks SET result=$3,updated_at=now() WHERE id=$1 AND execution_token=$2", [taskId, token, JSON.stringify(saved)]);
                    }
                }
                const incomplete = saved.audios.some((item) => !item.file);
                await publish(incomplete ? "unknown" : "succeeded", saved, incomplete ? "AUDIO_SAVE_INCOMPLETE" : null);
            } else {
                const video = result.data || result, id = video.id || video.task_id;
                if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new HttpError(502, "INVALID_VIDEO_TASK");
                const failed = ["failed", "cancelled", "expired"].includes(video.status);
                if (failed) await saveError(upstreamErrorDetails(video));
                await publish(failed ? "failed" : "pending", failed ? { id, status: video.status, error: { message: modelErrorMessage(undefined, upstreamErrorDetails(video)) || "视频生成失败" } } : { id, status: "queued" }, failed ? "TOKENONE_GENERATION_FAILED" : null, id);
            }
        } catch (error) {
            if (error instanceof HttpError && error.upstreamError) await saveError(error.upstreamError);
            else if (task.capability === "audio" && error instanceof Error) await saveError(upstreamErrorDetails({ message: error.message, code: (error.cause as { code?: string })?.code }));
            await publish(error instanceof HttpError && error.code === "TOKENONE_GENERATION_FAILED" ? "failed" : dispatched ? "unknown" : "failed", task.capability === "audio" ? (await owner.query("SELECT result FROM generation_tasks WHERE id=$1", [taskId])).rows[0]?.result : null, task.capability === "audio" && signal.aborted ? "AUDIO_REQUEST_TIMEOUT" : error instanceof HttpError ? error.code : "UPSTREAM_RESULT_UNKNOWN");
        }
    } finally {
        if (locked) await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [taskId]).catch(() => undefined);
        await owner.end();
    }
}

export function startGenerationWorker() {
    const active = new Set<string>();
    const tick = async () => {
        const { rows } = await db.query("SELECT id FROM generation_tasks WHERE (capability IN ('image','video','audio') OR capability='text' AND canvas_project_id IS NOT NULL) AND upstream_id IS NULL AND (status='pending' OR (status='running' AND execution_token IS NOT NULL)) ORDER BY created_at");
        for (const { id } of rows) if (!active.has(id)) {
            active.add(id);
            void executeMediaTask(id).catch(() => console.error(JSON.stringify({ taskId: id, code: "GENERATION_WORKER_FAILED" }))).finally(() => active.delete(id));
        }
    };
    void tick().catch(() => undefined);
    return setInterval(() => void tick().catch(() => undefined), 5000);
}
