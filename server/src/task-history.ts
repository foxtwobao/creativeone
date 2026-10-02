import { z } from "zod";
import { Router } from "express";
import { fileReferences, collectDeletedFiles } from "./storage.js";
import { db } from "./db.js";
import { modelErrorMessage } from "./model-errors.js";
import { requireUuid } from "./http.js";
import { generationPrompt, generationRequestSettings } from "../../shared/generation-request.js";

export const historyRouter = Router();
export function taskHistory(task: any) {
    const request = task.request || {}, model = `${task.channel_id}::${task.model}`;
    const prompt = generationPrompt(request);
    const config = { model, imageModel: model, videoModel: model, ...generationRequestSettings(task.capability, request) };
    const images = (task.result?.data || []).map?.((image: any, index: number) => ({ id: `${task.id}:${index}`, dataUrl: image.url, sourceUrl: image.url, ...image.file, durationMs: 0 })) || [];
    const video = task.result?.file || task.result?.data?.file;
    const status = task.status === "succeeded" ? "success" : ["pending", "running", "unknown"].includes(task.status) ? "pending" : "failed";
    const refs: any[] = (request.image_references || []).map((url: string, index: number) => ({ id: String(index), name: `参考图 ${index+1}`, dataUrl: url, url }));
    for (const part of request.content || []) if (part.type === "image_url") refs.push({ id: String(refs.length), name: `参考图 ${refs.length+1}`, dataUrl: part.image_url.url, url: part.image_url.url });
    for (const ref of request.reference_images || []) refs.push({ id: String(refs.length), name: `参考图 ${refs.length+1}`, dataUrl: ref.url, url: ref.url });
    for (const kind of ["video", "audio"]) for (const part of request.content || []) if (part.type === `${kind}_url`) {
        (request[`reference_${kind}s`] ||= []).push({ url: part[`${kind}_url`].url });
    }
    for (const ref of refs) { const match = /^\/api\/files\/image_files\/(.+)$/.exec(ref.dataUrl); if (match) ref.storageKey = decodeURIComponent(match[1]); }
    return { id: task.id, createdAt: Date.parse(task.created_at), title: prompt.slice(0,12) || task.model, prompt, time: task.created_at, model, config, references: refs, referenceVideos: (request.reference_videos || []).map((ref: any,index: number) => ({ id: String(index), name: `参考视频 ${index+1}`, url: ref.url })), referenceAudios: (request.reference_audios || []).map((ref: any,index: number) => ({ id: String(index), name: `参考音频 ${index+1}`, url: ref.url })), durationMs: Date.parse(task.updated_at)-Date.parse(task.created_at), status, size: task.capability === "video" ? config.videoSize : config.size, quality: config.quality, resolution: config.vquality, seconds: config.videoSeconds, images, imageCount: images.length, successCount: images.length, failCount: status === "failed" ? 1 : 0, video: video ? { id: task.id, ...video } : undefined, task: task.upstream_id ? { id: task.upstream_id, provider: task.path === "videos" ? "wan" : "seedance", model } : undefined, error: task.error ? modelErrorMessage(task.error) || "任务暂时无法完成" : undefined };
}
historyRouter.get("/history/:capability", async (req, res) => {
    const { page, keyword, upstreamId } = z.object({ page: z.coerce.number().int().positive().default(1), keyword: z.string().default(""), upstreamId: z.string().optional() }).parse(req.query);
    const where = "user_id=$1 AND capability=$2 AND NOT hidden_from_history AND ($3='' OR request::text ILIKE '%'||$3||'%' OR model ILIKE '%'||$3||'%') AND ($4::text IS NULL OR upstream_id=$4)";
    const params = [res.locals.user.id, z.enum(["image", "video"]).parse(req.params.capability), keyword, upstreamId || null];
    const { rows } = await db.query(`SELECT * FROM generation_tasks WHERE ${where} ORDER BY created_at DESC LIMIT 10 OFFSET $5`, [...params, (page-1)*10]);
    const count = await db.query(`SELECT count(*) FROM generation_tasks WHERE ${where}`, params);
    res.json({ logs: rows.map(taskHistory), total: Number(count.rows[0].count) });
});
historyRouter.delete("/history/:id", async (req, res) => {
    const { rows } = await db.query("UPDATE generation_tasks SET hidden_from_history=true WHERE user_id=$1 AND id=$2 RETURNING request,result", [res.locals.user.id, requireUuid(req.params.id)]);
    if (rows[0]) await collectDeletedFiles(res.locals.user.id, [...fileReferences(rows[0])]);
    res.status(204).end();
});
