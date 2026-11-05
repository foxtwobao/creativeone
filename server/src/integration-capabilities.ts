import { z } from "zod";
import type { ImageModelConfig } from "../../shared/image-models.js";
import { imageConfiguredProfile } from "../../shared/image-models.js";
import { videoConfiguredProfile, type VideoModelConfig } from "../../shared/video-models.js";
import { publicVideoRequestSchema } from "./model-capabilities.js";

const choices = (values: string[], title: string) => z.enum(values as [string, ...string[]]).meta({ title });
const schema = (fields: Record<string, z.ZodType>) => z.object(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.optional()]))).strict();
const duration = (range: { min: number; max: number; auto: boolean } | null) => {
    const seconds = range ? z.int().min(range.min).max(range.max) : z.int().positive();
    return range?.auto ? z.union([seconds, z.literal(-1)]) : seconds;
};

// Only public capability data is projected; protocol family, paths and preset identities stay internal.
export function imageIntegrationCapabilities(config: ImageModelConfig) {
    const p = imageConfiguredProfile(config);
    const fields: Record<string, z.ZodType> = {};
    if (p.pixelSize) fields.size = z.string().min(1).meta({ title: "尺寸或画幅", format: "image-size", description: "auto、宽x高或正数宽高比；同时满足像素组合约束" });
    else fields[config.callType === "grok" ? "aspect_ratio" : "size"] = choices(p.ratios, "画幅");
    if (config.callType === "grok" && p.resolutions.length > 1) fields.resolution = choices(p.resolutions, "分辨率");
    if (p.qualities.length) fields.quality = choices(p.qualities, "画质");
    if (p.transparent) fields.background = choices(["", "transparent"], "默认或透明背景");
    const parameterSchema = schema(fields);
    return {
        parameterSchema, parameters: z.toJSONSchema(parameterSchema),
        constraints: {
            pixelSize: p.pixelSize, resolutions: p.resolutions, ratios: p.ratios,
            ...(p.fixedResolution ? { fixedResolution: p.fixedResolution } : {}),
            ...(p.pixelSize ? { pixelBounds: p.pixelBounds } : {}),
            sizePresets: Object.fromEntries(Object.entries(p.sizePresets).filter(([r]) => (p.fixedResolution ? [p.fixedResolution] : p.resolutions).includes(r)).map(([r, sizes]) => [r, Object.fromEntries(Object.entries(sizes).filter(([ratio]) => p.ratios.includes(ratio)))])),
            maxReferences: p.maxReferences, singleReferenceRatioLocked: p.singleReferenceRatioLocked,
        },
    };
}

export function videoIntegrationCapabilities(config: VideoModelConfig) {
    const p = videoConfiguredProfile(config);
    const resolution = (value: string) => config.callType === "seedance" ? value === "4k" ? value : `${value}p` : value.endsWith("k") ? value.toUpperCase() : `${value}P`;
    const fields: Record<string, z.ZodType> = { mode: choices(p.modes, "首尾帧或全能参考"), resolution: choices(p.resolutions.map(resolution), "分辨率"), ratio: choices(p.ratios.map(r => r === "auto" ? "adaptive" : r), "画幅") };
    if (p.durationConfigurable) fields.seconds = (p.durationByResolution ? z.union([duration(p.duration), ...Object.values(p.durationByResolution).map(duration)] as [z.ZodType, z.ZodType, ...z.ZodType[]]) : duration(p.duration)).meta({ title: "时长（秒）" });
    if (p.audioOptions) {
        fields.generateAudio = z.boolean().meta({ title: "生成音频" });
        fields.watermark = z.boolean().meta({ title: "水印" });
    }
    const fastModes = p.fastModeOptions?.filter(value => value !== "").map(value => value === "true");
    if (fastModes?.length) fields.fastMode = z.literal(fastModes as [boolean, ...boolean[]]).meta({ title: "快速模式", description: "省略时使用原默认行为" });
    if (p.family === "wan") fields.seed = publicVideoRequestSchema.shape.metadata.unwrap().shape.parameters.unwrap().shape.seed.unwrap().meta({ title: "随机种子" });
    const parameterSchema = schema(fields);
    const parameters = z.toJSONSchema(parameterSchema);
    const ranges = Object.fromEntries(p.resolutions.map(r => [resolution(r), p.durationByResolution?.[r] || p.duration]));
    if (p.durationConfigurable && p.durationByResolution) Object.assign(parameters, {
        allOf: Object.entries(ranges).map(([r, range]) => ({ if: { properties: { resolution: { const: r } }, required: ["resolution"] }, then: { properties: { seconds: z.toJSONSchema(duration(range)) } } })),
    });
    return {
        parameterSchema, parameters,
        constraints: {
            durationConfigurable: p.durationConfigurable,
            ...(p.durationConfigurable ? { duration: p.duration, durationByResolution: ranges } : {}),
            modes: p.modes, defaultMode: p.defaults.mode, maxImages: p.maxImages, maxVideos: p.maxVideos, maxAudios: p.maxAudios,
            requireImage: p.requireImage, audioOnly: p.audioOnly, referenceSeconds: p.referenceSeconds,
            ...(p.referenceImages ? { referenceImages: p.referenceImages } : {}),
            frames: { maxImages: 2, maxFirstFrames: 1, maxLastFrames: 1, lastRequiresFirst: true, mixedReferences: false, requirePair: !!p.framesRequirePair, adaptiveRatio: p.framesAdaptive },
            framesWithoutImagesDisallowOtherMedia: p.family === "h3",
            ...(p.family === "veo" ? { prompt: { maxCharacters: 10_000, maxUtf8Bytes: 16 * 1024 } } : {}),
        },
    };
}

export function musicIntegrationCapabilities() {
    const parameterSchema = schema({ mode: choices(["song", "instrumental"], "歌曲或纯音乐") });
    return { parameterSchema, parameters: z.toJSONSchema(parameterSchema), constraints: {} };
}
