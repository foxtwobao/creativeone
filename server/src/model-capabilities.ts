import { z } from "zod";
import { imageModelProfile, imageCapabilityError, type ImageModelType } from "../../shared/image-models.js";
import { videoModelProfile, videoCapabilityError, wanAspectRatios, h3AspectRatios, type VideoModelType } from "../../shared/video-models.js";

const imageParams = z.object({
    quality: z.string().optional(), size: z.string().optional(), aspect_ratio: z.string().optional(), resolution: z.string().optional(),
    image_references: z.array(z.string()).optional(), image_urls: z.array(z.string()).optional(), images: z.array(z.unknown()).optional(),
    image: z.unknown().optional(), image_url: z.unknown().optional(),
}).passthrough();
export function imageRequestCapabilityError(model: string, family: ImageModelType, body: unknown, fileCount = 0) {
    const parsed = imageParams.safeParse(body);
    if (!parsed.success) return "图片请求参数格式不正确。";
    const params = parsed.data;
    const references = fileCount + (params.image_references?.length || 0) + (params.image_urls?.length || 0) + (params.images?.length || 0) + (params.image ? 1 : 0) + (params.image_url ? 1 : 0);
    if (family === "grok" && references === 1 && params.aspect_ratio !== undefined) return "Grok 单图编辑沿用参考图片比例，请省略宽高比参数。";
    return imageCapabilityError(imageModelProfile(model, family), {
        references, quality: params.quality,
        size: family === "openai" ? params.size : undefined,
        ratio: family === "banana" ? params.size || params.aspect_ratio : family === "grok" ? params.aspect_ratio : undefined,
        resolution: family === "grok" ? params.resolution : undefined,
    });
}

const reference = z.object({ role: z.string().optional() }).passthrough();
const wanMedia = z.object({
    type: z.enum(["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"]),
    url: z.union([z.string().regex(/^\/api\/files\/(image_files|media_files)\/[^/?#]+$/), z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
    })]),
}).strict();
const wanMetadata = z.object({ input: z.object({ media: z.array(wanMedia) }).strict() }).strict();
export const wanRequestSchema = z.object({
    model: z.string(), prompt: z.string().refine((value) => value.trim().length > 0), duration: z.number().int(),
    resolution: z.enum(["480P", "720P", "1080P"]), ratio: z.enum(wanAspectRatios),
    metadata: wanMetadata.optional(),
}).strict();
export const h3RequestSchema = wanRequestSchema.extend({
    model: z.literal("MiniMax-H3"), resolution: z.enum(["768P", "2K"]), ratio: z.enum(h3AspectRatios),
    generation_mode: z.enum(["frames", "references"]),
});
const videoParams = z.object({
    duration: z.number().optional(), seconds: z.string().optional(), resolution: z.string().optional(), ratio: z.string().optional(), aspect_ratio: z.string().optional(),
    content: z.array(reference.extend({ type: z.string() })).optional(),
    metadata: wanMetadata.optional(),
    generation_mode: z.enum(["frames", "references"]).optional(),
    omni_reference_task_type: z.enum(["auto", "reference", "edit", "extend"]).optional(),
}).passthrough();
export function videoRequestCapabilityError(model: string, family: VideoModelType, body: unknown) {
    if (family === "wan" && !wanRequestSchema.safeParse(body).success) return "WAN 请求请使用 duration、resolution、ratio 和 metadata.input.media 公共格式。";
    if (family === "h3" && !h3RequestSchema.safeParse(body).success) return "H3 请求请使用 MiniMax-H3、duration、resolution、ratio、generation_mode 和 metadata.input.media 公共格式。";
    const parsed = videoParams.safeParse(body);
    if (!parsed.success) return "视频请求参数格式不正确。";
    const params = parsed.data, profile = videoModelProfile(model, family);
    const media = (params.metadata?.input.media || []).map((item) => ({ role: item.type }));
    const images = family !== "seedance" ? media.filter((item) => ["first_frame", "last_frame", "reference_image"].includes(item.role)) : (params.content || []).filter((item) => item.type === "image_url");
    const videos = family !== "seedance" ? media.filter((item) => item.role === "reference_video") : (params.content || []).filter((item) => item.type === "video_url");
    const audios = family !== "seedance" ? media.filter((item) => item.role === "reference_audio") : (params.content || []).filter((item) => item.type === "audio_url");
    const frames = images.filter((item) => item.role === "first_frame" || item.role === "last_frame" || (family === "seedance" && !item.role));
    if (frames.length && (frames.length !== images.length || frames.length > 2 || images.filter((item) => item.role === "last_frame").length > 1 || images.filter((item) => item.role === "first_frame" || !item.role).length !== 1)) return "首尾帧需要一张首帧和至多一张尾帧，不能混用参考图。";
    if (family === "h3" && (params.generation_mode === "references" && frames.length || params.generation_mode === "frames" && (images.some((item) => item.role === "reference_image") || videos.length || audios.length))) return "H3 生成模式与素材角色不一致，首尾帧和普通参考素材不能混用。";
    const ratio = params.aspect_ratio || params.ratio || "adaptive";
    const seconds = Number(params.duration ?? (profile.duration?.auto ? -1 : 6));
    if (profile.framesAdaptive && ["edit", "extend"].includes(params.omni_reference_task_type || "")) {
        if (!videos.length || ratio !== "adaptive") return "视频编辑或延长需要参考视频，并使用自动宽高比。";
        if (params.omni_reference_task_type === "edit" && seconds !== -1) return "视频编辑必须使用自动时长。";
    }
    return videoCapabilityError(profile, {
        resolution: params.resolution?.replace(/p$/i, "").toLowerCase() || "720",
        ratio: ratio === "adaptive" ? "auto" : ratio, seconds, mode: family === "h3" ? params.generation_mode === "frames" ? "frames" : "reference" : frames.length ? "frames" : "reference",
    }, { images: images.length, videos: videos.length, audios: audios.length });
}

export function videoDurationCapabilityError(model: string, family: VideoModelType, videoSeconds: number, audioSeconds: number) {
    const limit = videoModelProfile(model, family).referenceSeconds;
    return limit !== null && (videoSeconds > limit || audioSeconds > limit) ? `参考视频、参考音频各自总时长不能超过 ${limit} 秒。` : undefined;
}
