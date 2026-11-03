import { withPresetUsage } from "./preset-usage.js";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { requireAdmin } from "./auth.js";
import { HttpError } from "./http.js";
import { imageModelTypes, imageCapabilityError, imagePixelSizeError, type ImageProfile, type ImageParameterPreset } from "../../shared/image-models.js";
import { imageRatioOf, imageScaleOf } from "../../shared/image-size.js";
import { resolveRequestSize } from "../../shared/image-openai.js";

const positive = z.number().int().positive();
const options = z.array(z.string().trim().min(1)).refine(v => new Set(v).size === v.length, "选项不能重复");
const ratio = z.string().refine(v => v === "auto" || /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(v) && v.split(":").every(n => Number(n) > 0), "画幅应为正数比例或 auto");
export const imageProfileSchema = z.object({
    family: z.enum(imageModelTypes), pixelSize: z.boolean(), transparent: z.boolean(),
    qualities: options, resolutions: options.refine(v => v.length > 0 && v.every(r => ["1k", "2k", "4k", "auto"].includes(r)), "请选择已支持的分辨率"),
    ratios: z.array(ratio).nonempty().refine(v => new Set(v).size === v.length), fixedResolution: z.enum(["1k", "2k", "4k", "auto"]).optional(),
    maxReferences: z.number().int().nonnegative().nullable(), omitResponseFormat: z.boolean(), singleReferenceRatioLocked: z.boolean(),
    defaults: z.object({ size: z.string().min(1), quality: z.string().min(1), background: z.enum(["", "transparent"]) }).strict(),
    pixelBounds: z.object({ step: positive, maxEdge: positive, maxRatio: z.number().min(1), minPixels: positive, maxPixels: positive, ratioShortSide: positive }).strict(),
    sizePresets: z.partialRecord(z.enum(["1k", "2k", "4k"]), z.record(ratio, z.string().regex(/^[1-9]\d*x[1-9]\d*$/))).refine(v => Object.keys(v).length > 0, "请填写档位尺寸表"),
}).strict().superRefine((p, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    if (p.pixelBounds.minPixels > p.pixelBounds.maxPixels || p.pixelBounds.ratioShortSide > p.pixelBounds.maxEdge) error("像素边界或默认短边配置冲突");
    if (p.family !== "openai" && (p.transparent || p.pixelSize)) error("当前调用协议不支持像素尺寸或透明背景参数");
    if (p.family !== "grok" && p.singleReferenceRatioLocked) error("单图编辑锁定画幅仅适用于 Grok 协议");
    if (p.pixelSize && p.fixedResolution && p.resolutions[0] !== p.fixedResolution) error("像素模式的固定分辨率须与允许的分辨率一致");
    if (p.fixedResolution && p.resolutions.length > 1) error("固定分辨率不能与多个可选分辨率同时配置");
    const profile = p as ImageProfile;
    if (p.qualities.length && !p.qualities.includes(p.defaults.quality)) error("默认画质必须属于允许选项");
    if (p.defaults.background === "transparent" && !p.transparent) error("当前预设不支持默认透明背景");
    for (const [scale, sizes] of Object.entries(profile.sizePresets)) for (const [r, size] of Object.entries(sizes)) {
        if (r === "auto") error("自动画幅不应配置固定像素尺寸");
        if (p.pixelSize && imagePixelSizeError(size, p.pixelBounds)) error(`${scale} / ${r}：${imagePixelSizeError(size, p.pixelBounds)}`);
    }
    let defaultSize = p.defaults.size;
    if (p.pixelSize) {
        for (const scale of p.resolutions.filter(s => s !== "auto")) for (const r of p.ratios.filter(r => r !== "auto")) if (!profile.sizePresets[scale]?.[r]) error(`缺少 ${scale} / ${r} 的尺寸映射`);
        try { defaultSize = resolveRequestSize(p.defaults.size, profile) || "auto"; } catch (cause) { error(cause instanceof Error ? cause.message : "默认尺寸无效"); }
    }
    const ratioValue = imageRatioOf(defaultSize, profile), scaleValue = imageScaleOf(defaultSize, profile);
    const invalid = imageCapabilityError(profile, { quality: p.qualities.length ? p.defaults.quality : undefined, ratio: p.pixelSize ? undefined : ratioValue, resolution: p.pixelSize || p.resolutions.length > 1 ? scaleValue : undefined, background: p.defaults.background });
    if (invalid) error(`默认参数：${invalid}`);
});
const inputSchema = z.object({ label: z.string().trim().min(1), profile: imageProfileSchema }).strict();
export const lockImagePresets = async (client: Pick<PoolClient, "query">) => { await client.query("SELECT pg_advisory_xact_lock(hashtext('creativeone-image-presets'))"); };
export async function readImagePresets(client: Pick<PoolClient, "query"> = db): Promise<ImageParameterPreset[]> {
    return (await client.query("SELECT id,label,profile,revision FROM image_parameter_presets ORDER BY created_at,id")).rows.map(row => ({ ...row, callType: row.profile.family }));
}
export async function attachImageProfiles<T extends { capability: string; image_presets?: Record<string, string> }>(channels: T[], client: Pick<PoolClient, "query"> = db): Promise<(T & { image_profiles: Record<string, ImageProfile> })[]> {
    const presets = channels.some(c => c.capability === "image") ? new Map((await readImagePresets(client)).map(p => [p.id, p])) : new Map<string, ImageParameterPreset>();
    return channels.map(channel => ({ ...channel, image_profiles: Object.fromEntries(Object.entries(channel.image_presets || {}).flatMap(([model, id]) => presets.has(id) ? [[model, presets.get(id)!.profile]] : [])) }));
}
const inUse = async (client: Pick<PoolClient, "query">, id: string) => Boolean((await client.query("SELECT 1 FROM channels WHERE EXISTS(SELECT 1 FROM jsonb_each_text(image_presets) p WHERE p.value=$1)", [id])).rowCount);
export const imagePresetsRouter = Router();
imagePresetsRouter.get("/admin/image-presets", requireAdmin, async (_req, res) => res.json({ presets: await withPresetUsage(await readImagePresets(), "image") }));
imagePresetsRouter.post("/admin/image-presets", requireAdmin, async (req, res) => {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_IMAGE_PRESET", message: parsed.error.issues.map(i => i.message).join("；") });
    const { label, profile } = parsed.data;
    const row = (await db.query("INSERT INTO image_parameter_presets(id,label,profile) VALUES($1,$2,$3) RETURNING id,label,profile,revision", [randomUUID(), label, JSON.stringify(profile)])).rows[0];
    res.status(201).json({ preset: { ...row, callType: row.profile.family } });
});
imagePresetsRouter.put("/admin/image-presets/:id", requireAdmin, async (req, res) => {
    const parsed = inputSchema.extend({ revision: positive }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_IMAGE_PRESET", message: parsed.error.issues.map(i => i.message).join("；") });
    const input = parsed.data;
    const row = await transaction(async client => {
        await lockImagePresets(client);
        const current = (await client.query("SELECT profile,revision FROM image_parameter_presets WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
        if (!current) throw new HttpError(404, "IMAGE_PRESET_NOT_FOUND");
        if (current.revision !== input.revision) throw new HttpError(409, "IMAGE_PRESET_CONFLICT");
        if (current.profile.family !== input.profile.family && await inUse(client, req.params.id as string)) throw new HttpError(409, "IMAGE_PRESET_IN_USE");
        return (await client.query("UPDATE image_parameter_presets SET label=$2,profile=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING id,label,profile,revision", [req.params.id, input.label, JSON.stringify(input.profile)])).rows[0];
    });
    res.json({ preset: { ...row, callType: row.profile.family } });
});
imagePresetsRouter.delete("/admin/image-presets/:id", requireAdmin, async (req, res) => {
    await transaction(async client => {
        await lockImagePresets(client);
        if (await inUse(client, req.params.id as string)) throw new HttpError(409, "IMAGE_PRESET_IN_USE");
        if (!(await client.query("DELETE FROM image_parameter_presets WHERE id=$1", [req.params.id])).rowCount) throw new HttpError(404, "IMAGE_PRESET_NOT_FOUND");
    });
    res.sendStatus(204);
});
