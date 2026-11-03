import { withPresetUsage } from "./preset-usage.js";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { requireAdmin } from "./auth.js";
import { HttpError } from "./http.js";
import { videoModelTypes, type VideoProfile, type VideoParameterPreset } from "../../shared/video-models.js";

const duration = z.object({ min: z.number().int().positive(), max: z.number().int().positive(), auto: z.boolean() }).strict().refine(v => v.min <= v.max, "最短时长不能大于最长时长");
const count = z.number().int().nonnegative().nullable();
const mode = z.enum(["frames", "reference"]);
const uniqueStrings = z.array(z.string().min(1)).nonempty().refine(v => new Set(v).size === v.length, "选项不能重复");
export const videoProfileSchema = z.object({
    family: z.enum(videoModelTypes),
    defaults: z.object({ resolution: z.string(), ratio: z.string(), seconds: z.string(), mode, generateAudio: z.boolean(), watermark: z.boolean(), fastMode: z.string() }).strict(),
    resolutions: uniqueStrings.refine(v => v.every(r => ["480", "720", "768", "1080", "2k", "4k"].includes(r)), "请选择已支持的分辨率"),
    ratios: uniqueStrings.refine(v => v.every(r => ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3", "auto"].includes(r)), "请选择已支持的画幅"),
    duration: duration.nullable(), durationByResolution: z.record(z.string(), duration).optional(),
    maxImages: count, maxVideos: count, maxAudios: count, referenceSeconds: z.number().positive().nullable(),
    requireImage: z.boolean(), audioOnly: z.boolean(), audioOptions: z.boolean(), framesAdaptive: z.boolean(), explicitReferenceTask: z.boolean(), durationConfigurable: z.boolean(),
    modes: z.array(mode).nonempty().refine(v => new Set(v).size === v.length),
    framesRequirePair: z.boolean().optional(), fastModeOptions: z.array(z.enum(["", "false", "true"])).nonempty().optional(),
    referenceImages: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((v, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    if (!v.resolutions.includes(v.defaults.resolution) || !v.ratios.includes(v.defaults.ratio) || !v.modes.includes(v.defaults.mode)) error("默认分辨率、画幅和参考模式必须在允许选项内");
    if (v.durationConfigurable) {
        const seconds = Number(v.defaults.seconds);
        for (const resolution of v.resolutions) {
            const range = v.durationByResolution?.[resolution] || v.duration;
            if (range && !((range.auto && seconds === -1) || (Number.isInteger(seconds) && seconds >= range.min && seconds <= range.max))) error("默认时长必须适用于所有分辨率");
        }
        if (!v.defaults.seconds.trim() || !Number.isInteger(seconds) || seconds === -1 && !v.duration?.auto || seconds !== -1 && seconds <= 0) error("默认时长无效");
    }
    if (Object.keys(v.durationByResolution || {}).some(r => !v.resolutions.includes(r))) error("特殊时长必须对应已选分辨率");
    if (v.referenceImages && (v.referenceImages.min > v.referenceImages.max || v.maxImages !== null && v.referenceImages.max > v.maxImages)) error("参考图最小、最大数量与总上限不一致");
    if (v.requireImage && v.maxImages === 0 || v.framesRequirePair && (!v.modes.includes("frames") || v.maxImages !== null && v.maxImages < 2) || v.framesAdaptive && !v.ratios.includes("auto")) error("素材数量、首尾帧规则或自动画幅配置冲突");
    if (v.fastModeOptions && !v.fastModeOptions.includes(v.defaults.fastMode as "" | "false" | "true")) error("默认快速模式必须在允许选项内");
    if (v.family !== "seedance" && (v.audioOptions || v.explicitReferenceTask)) error("当前协议不支持音频开关或原生参考任务参数");
    if (v.family !== "h3" && v.fastModeOptions) error("快速模式仅适用于 H3");
    if (v.family !== "seedance" && (v.duration?.auto || Object.values(v.durationByResolution || {}).some(range => range.auto))) error("当前调用协议不支持自动时长");
    if (v.family !== "seedance" && v.resolutions.includes("4k")) error("当前公共调用协议不支持 4K 分辨率");
    if (!v.fastModeOptions && v.defaults.fastMode !== "") error("启用默认快速模式前请先配置快速模式选项");
    if (v.family === "veo" && v.durationConfigurable) error("Veo 调用协议不发送时长参数");
});
const inputSchema = z.object({ label: z.string().trim().min(1), profile: videoProfileSchema }).strict();
const callType = (profile: VideoProfile) => profile.family === "seedance" ? "seedance" as const : "tokenone" as const;
export async function readVideoPresets(client: Pick<PoolClient, "query"> = db): Promise<VideoParameterPreset[]> {
    return (await client.query("SELECT id,label,profile,revision FROM video_parameter_presets ORDER BY created_at,id")).rows.map(row => ({ ...row, callType: callType(row.profile) }));
}
export async function attachVideoProfiles<T extends { capability: string; video_presets?: Record<string, string> }>(channels: T[], client: Pick<PoolClient, "query"> = db): Promise<(T & { video_profiles: Record<string, VideoProfile> })[]> {
    const presets = channels.some(c => c.capability === "video") ? new Map((await readVideoPresets(client)).map(p => [p.id, p])) : new Map<string, VideoParameterPreset>();
    return channels.map(channel => ({ ...channel, video_profiles: Object.fromEntries(Object.entries(channel.video_presets || {}).flatMap(([model, id]) => presets.has(id) ? [[model, presets.get(id)!.profile]] : [])) }));
}
export async function lockVideoPresets(client: Pick<PoolClient, "query">) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-video-presets'))");
}
const inUse = async (client: Pick<PoolClient, "query">, id: string) => Boolean((await client.query("SELECT 1 FROM channels WHERE EXISTS(SELECT 1 FROM jsonb_each_text(video_presets) p WHERE p.value=$1)", [id])).rowCount);
export const videoPresetsRouter = Router();
videoPresetsRouter.get("/admin/video-presets", requireAdmin, async (_req, res) => res.json({ presets: await withPresetUsage(await readVideoPresets(), "video") }));
videoPresetsRouter.post("/admin/video-presets", requireAdmin, async (req, res) => {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_VIDEO_PRESET", message: parsed.error.issues.map(i => i.message).join("；") });
    const input = parsed.data, id = randomUUID();
    const row = (await db.query("INSERT INTO video_parameter_presets(id,label,profile) VALUES($1,$2,$3) RETURNING id,label,profile,revision", [id, input.label, JSON.stringify(input.profile)])).rows[0];
    res.status(201).json({ preset: { ...row, callType: callType(row.profile) } });
});
videoPresetsRouter.put("/admin/video-presets/:id", requireAdmin, async (req, res) => {
    const parsed = inputSchema.extend({ revision: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_VIDEO_PRESET", message: parsed.error.issues.map(i => i.message).join("；") });
    const input = parsed.data;
    const row = await transaction(async client => {
        await lockVideoPresets(client);
        const current = (await client.query("SELECT profile,revision FROM video_parameter_presets WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
        if (!current) throw new HttpError(404, "VIDEO_PRESET_NOT_FOUND");
        if (current.revision !== input.revision) throw new HttpError(409, "VIDEO_PRESET_CONFLICT");
        if (current.profile.family !== input.profile.family && await inUse(client, req.params.id as string)) throw new HttpError(409, "VIDEO_PRESET_IN_USE");
        return (await client.query("UPDATE video_parameter_presets SET label=$2,profile=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING id,label,profile,revision", [req.params.id, input.label, JSON.stringify(input.profile)])).rows[0];
    });
    res.json({ preset: { ...row, callType: callType(row.profile) } });
});
videoPresetsRouter.delete("/admin/video-presets/:id", requireAdmin, async (req, res) => {
    await transaction(async client => {
        await lockVideoPresets(client);
        if (await inUse(client, req.params.id as string)) throw new HttpError(409, "VIDEO_PRESET_IN_USE");
        if (!(await client.query("DELETE FROM video_parameter_presets WHERE id=$1", [req.params.id])).rowCount) throw new HttpError(404, "VIDEO_PRESET_NOT_FOUND");
    });
    res.sendStatus(204);
});
