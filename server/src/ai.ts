import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createParser } from "eventsource-parser";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { ensureKey, upstreamUrl, modelProvider, type Channel } from "./tokenone.js";
import { HttpError, requireUuid } from "./http.js";
import { saveFile, storedFileInfo, inlineStoredFile, mediaReferenceForUser, fileReferences, collectDeletedFiles } from "./storage.js";
import { readBytes } from "./media.js";
import { tokenoneError, modelErrorMessage } from "./model-errors.js";
import { imageRequestCapabilityError, videoRequestCapabilityError, videoDurationCapabilityError } from "./model-capabilities.js";
import { videoModelProfile, wanModelProfile } from "../../shared/video-models.js";
import { executeMediaTask, persistImages } from "./generation-executor.js";
import { readAccountData } from "./account-data.js";
import { canvasGraphView } from "./canvas-graph.js";
import { canvasRequestBody } from "../../shared/canvas-request.js";
import { attachCanvasTask, finishCanvasTask } from "./canvas-tasks.js";

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
const canvasContextSchema = z.object({
    projectId: z.uuid(),
    nodeId: z.string().trim().min(1),
    outputIndex: z.number().int().nonnegative().optional(),
    generationId: z.string().trim().min(1),
    outputId: z.string().trim().min(1).optional(),
}).strict();

async function assertVideoDurations(userId: string, model: string, family: "seedance" | "wan", references: { videos: string[]; audios: string[] }, client: Pick<typeof db, "query"> = db) {
    if (videoModelProfile(model, family).referenceSeconds === null) return;
    const duration = async (urls: string[]) => {
        let seconds = 0;
        for (const url of urls) {
            const file = await storedFileInfo(userId, url, client);
            if (!(typeof file.durationMs === "number") || file.durationMs <= 0) throw new HttpError(400, "REFERENCE_DURATION_UNKNOWN");
            seconds += file.durationMs / 1000;
        }
        return seconds;
    };
    if (videoDurationCapabilityError(model, family, await duration(references.videos), await duration(references.audios))) throw new HttpError(400, "REFERENCE_DURATION_EXCEEDED");
}

export const aiRouter = Router();
aiRouter.post("/tasks/status", async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.uuid()) }).strict().parse(req.body);
    const { rows } = await db.query("SELECT id,status FROM generation_tasks WHERE user_id=$1 AND id=ANY($2::uuid[]) AND NOT hidden_from_works", [res.locals.user.id, ids]);
    res.json({ tasks: rows });
});
aiRouter.post("/tasks/:id/resume-result", async (req, res) => {
    const id = requireUuid(req.params.id), userId = res.locals.user.id;
    await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
        const changed = await client.query("UPDATE generation_tasks SET status='pending',error=NULL,canvas_attached=false WHERE id=$1 AND user_id=$2 AND capability='image' AND status='unknown' AND upstream_result IS NOT NULL RETURNING id", [id, userId]);
        if (!changed.rowCount) throw new HttpError(409, "TASK_NOT_RECOVERABLE");
        await attachCanvasTask(id, client);
    });
    res.status(202).json({ canvasTaskId: id });
});
aiRouter.get("/tasks/:id", async (req, res) => {
    const task = (await db.query("SELECT id,status,result,error,upstream_id,(upstream_result IS NOT NULL) AS result_available FROM generation_tasks WHERE id=$1 AND user_id=$2", [requireUuid(req.params.id), res.locals.user.id])).rows[0];
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
    res.json({ ...task, error_message: task.error ? modelErrorMessage(task.error) : undefined });
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
    const canvasContext = req.body?.canvas_context === undefined ? undefined : canvasContextSchema.parse(req.body.canvas_context);
    if (req.body) delete req.body.canvas_context;
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
            await transaction(async (client) => {
                await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
                await client.query("UPDATE generation_tasks SET status='pending',error=NULL,canvas_attached=false,updated_at=now() WHERE id=$1 AND status='unknown'", [task.id]);
                await attachCanvasTask(task.id, client);
            });
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
    if (canvasContext && !["image", "video"].includes(channel.capability)) throw new HttpError(403, "ENDPOINT_NOT_ALLOWED");
    if (canvasContext && req.is("multipart/form-data")) throw new HttpError(400, "INVALID_REQUEST");
    let requestSnapshot: Record<string, any> = { ...structuredClone(req.body || {}), ...(userPrompt === undefined ? {} : { user_prompt: userPrompt }) };
    if (!canvasContext && path === "videos") for (const field of ["reference_images", "reference_videos", "reference_audios"]) {
        for (const ref of req.body[field] || []) {
            if (!ref.url.startsWith("/api/files/")) continue;
            const match = /^\/api\/files\/(image_files|media_files)\/([^/?#]+)$/.exec(ref.url)!;
            ref.url = await mediaReferenceForUser(user.id, match[1], decodeURIComponent(match[2]), Date.now()+30*60_000);
        }
    }
    if (!canvasContext && path === "contents/generations/tasks") for (const part of req.body.content || []) {
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
    const canvasSettings = canvasContext && channel.capability === "image" ? (await readAccountData(user.id, "infinite-canvas:ai_config_store", { config: {} }, "preferences")).config : {};
    const submission = structuredClone(requestSnapshot);
    const existingTask = await transaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
        if (canvasContext) {
            const project = (await client.query("SELECT nodes,connections,content_revision FROM canvas_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE", [canvasContext.projectId, user.id])).rows[0];
            if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND");
            const node = project.nodes.find((node: { id?: string; clientId?: string }) => node.id === canvasContext.nodeId || node.clientId === canvasContext.nodeId);
            const output = canvasContext.outputId ? node?.metadata?.images?.find((image: { id: string; clientId?: string }) => image.id === canvasContext.outputId || image.clientId === canvasContext.outputId) : node?.metadata;
            if (!output || output.generationId !== canvasContext.generationId) throw new HttpError(409, "CANVAS_GENERATION_CHANGED");
            canvasContext.nodeId = node.id;
            if (canvasContext.outputId) canvasContext.outputId = output.id;
            if (node.type !== channel.capability) throw new HttpError(400, "INVALID_CANVAS_GRAPH");
            const previous = (await client.query("SELECT * FROM generation_tasks WHERE user_id=$1 AND canvas_project_id=$2 AND canvas_generation_id=$3", [user.id, canvasContext.projectId, canvasContext.generationId])).rows[0];
            if (previous) {
                if (previous.channel_id !== channelId || previous.path !== path || previous.canvas_node_id !== node.id || previous.canvas_output_id !== (canvasContext.outputId ? output.id : null) || !isDeepStrictEqual(previous.request.canvas_submission, submission)) throw new HttpError(409, "PROJECT_OPERATION_CONFLICT");
                return previous;
            }
            const savedMetadata = canvasGraphView(project.nodes, project.connections).nodes.find((item) => item.id === (node.clientId || node.id))!.metadata!;
            if (savedMetadata?.model !== `${channelId}::${req.body.model}` || typeof savedMetadata?.prompt !== "string" || userPrompt !== undefined && userPrompt !== savedMetadata.prompt) throw new HttpError(409, "CANVAS_GENERATION_CHANGED");
            const references = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
            for (const reference of node.metadata.references || []) {
                const match = /^\/api\/files\/(?:image_files|media_files)\/([^/?#]+)$/.exec(reference);
                const file = (await client.query("SELECT namespace,key,mime_type FROM files WHERE user_id=$1 AND key=$2", [user.id, match ? decodeURIComponent(match[1]) : reference])).rows[0];
                if (!file) throw new HttpError(409, "FILE_NOT_SYNCED");
                const target = file.mime_type.startsWith("image/") ? references.images : file.mime_type.startsWith("video/") ? references.videos : file.mime_type.startsWith("audio/") ? references.audios : undefined;
                if (!target) throw new HttpError(400, "INVALID_FILE_REFERENCE");
                target.push(`/api/files/${file.namespace}/${encodeURIComponent(file.key)}`);
            }
            const visited = new Set<string>();
            const assertReady = (source: any) => {
                if (!source || source.id === node.id || visited.has(source.id)) return;
                visited.add(source.id);
                if (source.type === "config") {
                    const mentions = [...(source.metadata?.composerContent || "").matchAll(/@\[node:([^\]]+)\]/g)].map((match: any) => match[1]);
                    for (const edge of project.connections.filter((edge: any) => edge.toNodeId === source.id && (!mentions.length || mentions.includes(edge.fromNodeId)))) assertReady(project.nodes.find((node: any) => node.id === edge.fromNodeId));
                } else if (source.type === "group") for (const child of project.nodes.filter((node: any) => node.metadata?.groupId === source.id)) assertReady(child);
                else if (["image", "video", "audio"].includes(source.type) && (!source.metadata?.storageKey || source.metadata?.status === "loading" && source.metadata?.generationId)) throw new HttpError(409, "CANVAS_REFERENCE_NOT_READY");
                else if (source.type === "text" && !source.metadata?.content?.trim()) throw new HttpError(409, "CANVAS_REFERENCE_NOT_READY");
            };
            for (const edge of project.connections.filter((edge: any) => edge.toNodeId === node.id)) assertReady(project.nodes.find((source: any) => source.id === edge.fromNodeId));
            const family = channel.capability === "image" ? channel.image_types![req.body.model] : channel.video_types?.[req.body.model] || "seedance";
            try { requestSnapshot = canvasRequestBody(req.body.model, channel.capability as "image" | "video", family, savedMetadata, references, canvasSettings.systemPrompt || ""); }
            catch { throw new HttpError(400, "MODEL_CAPABILITY_INVALID"); }
            const capabilityError = channel.capability === "image" ? imageRequestCapabilityError(req.body.model, family as any, requestSnapshot) : videoRequestCapabilityError(req.body.model, family as any, requestSnapshot);
            if (capabilityError) throw new HttpError(400, "MODEL_CAPABILITY_INVALID");
            if (channel.capability === "video") await assertVideoDurations(user.id, req.body.model, family as "seedance" | "wan", references, client);
            const expectedPath = channel.capability === "video" ? family === "wan" ? "videos" : "contents/generations/tasks" : references.images.length && family !== "banana" ? "images/edits" : "images/generations";
            if (path !== expectedPath) throw new HttpError(409, "CANVAS_GENERATION_CHANGED");
            requestSnapshot = { ...requestSnapshot, user_prompt: savedMetadata.prompt, canvas_source: { node, contentRevision: project.content_revision }, canvas_submission: submission };
        }
        for (const key of fileReferences(requestSnapshot)) if (!(await client.query("SELECT 1 FROM files WHERE user_id=$1 AND key=$2", [user.id, key])).rowCount) throw new HttpError(404, "FILE_NOT_FOUND");
        await client.query("INSERT INTO generation_tasks (id,user_id,channel_id,group_id,model,capability,path,status,provider,request,canvas_project_id,canvas_node_id,canvas_output_index,canvas_generation_id,canvas_output_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$15,$8,$9,$10,$11,$12,$13,$14)", [taskId, user.id, channelId, apiKey.group_id, req.body.model, channel.capability, path, modelProvider, JSON.stringify(requestSnapshot), canvasContext?.projectId || null, canvasContext?.nodeId || null, canvasContext?.outputIndex ?? null, canvasContext?.generationId || null, canvasContext?.outputId || null, canvasContext ? "pending" : "running"]);
        if (canvasContext) await attachCanvasTask(taskId, client);
    });
    if (canvasContext) { res.setHeader("X-Generation-Task-Id", existingTask?.id || taskId); return res.status(202).json({ canvasTaskId: existingTask?.id || taskId }); }
    if (existingTask) {
        res.setHeader("X-Generation-Task-Id", existingTask.id);
        if (["succeeded", "pending"].includes(existingTask.status) && existingTask.result) return res.json(existingTask.result);
        throw new HttpError(409, "CANVAS_GENERATION_ALREADY_ACCEPTED");
    }
    if (["image", "video"].includes(channel.capability) && !req.is("multipart/form-data")) {
        await executeMediaTask(taskId);
        const task = (await db.query("SELECT * FROM generation_tasks WHERE id=$1", [taskId])).rows[0];
        if (task.result) return res.json(task.result);
        throw new HttpError(task.status === "failed" ? 422 : 502, task.error || "UPSTREAM_RESULT_UNKNOWN");
    }
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
        await transaction(async (client) => {
            await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
            await client.query("SELECT id FROM generation_tasks WHERE id=$1 FOR UPDATE", [taskId]);
            await client.query("UPDATE generation_tasks SET status=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1", [taskId, status, JSON.stringify(result)]);
            await attachCanvasTask(taskId, client);
        });
        if (!res.destroyed) res.json(result);
    } catch (error) {
        // A transport failure does not prove that a billable upstream call failed.
        if (!(error instanceof HttpError)) await db.query("UPDATE generation_tasks SET status='unknown',error='UPSTREAM_RESULT_UNKNOWN',updated_at=now() WHERE id=$1 AND status NOT IN ('succeeded','failed')", [taskId]);
        else if (error.status < 500) await db.query("UPDATE generation_tasks SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='running'", [taskId, error.code]);
        else if (error.status === 502 || error.status === 413) await db.query("UPDATE generation_tasks SET status='unknown',error=$2,updated_at=now() WHERE id=$1 AND status='running'", [taskId, error.code]);
        if (res.headersSent) { res.end(); return; }
        throw error;
    } finally {
        if (canvasContext) await finishCanvasTask(taskId);
    }
});
