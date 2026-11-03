import { imageScaleOf } from "../../shared/image-size.js";
import { z } from "zod";
import { imageConfiguredProfile, imageCapabilityError, type ImageModelConfig } from "../../shared/image-models.js";
import { videoCapabilityError, veoPromptError, videoConfiguredProfile, type VideoModelConfig } from "../../shared/video-models.js";

const imageParams = z.object({
    background: z.string().optional(), quality: z.string().optional(), size: z.string().optional(), aspect_ratio: z.string().optional(), resolution: z.string().optional(),
    image_references: z.array(z.string()).optional(), image_urls: z.array(z.string()).optional(), images: z.array(z.unknown()).optional(),
    image: z.unknown().optional(), image_url: z.unknown().optional(),
}).passthrough();
export function imageRequestCapabilityError(model: string, config: ImageModelConfig, body: unknown, fileCount = 0) {
    const profile = imageConfiguredProfile(config), family = config.callType;
    const parsed = imageParams.safeParse(body);
    if (!parsed.success) return "图片请求参数格式不正确。";
    const params = parsed.data;
    const references = fileCount + (params.image_references?.length || 0) + (params.image_urls?.length || 0) + (params.images?.length || 0) + (params.image ? 1 : 0) + (params.image_url ? 1 : 0);
    if (profile.singleReferenceRatioLocked && references === 1 && params.aspect_ratio !== undefined) return "Grok 单图编辑沿用参考图片比例，请省略宽高比参数。";
    return imageCapabilityError(profile, {
        references, background: params.background, quality: params.quality,
        size: family === "openai" ? params.size : undefined,
        ratio: family === "banana" ? params.size || params.aspect_ratio : family === "grok" ? params.aspect_ratio : undefined,
        resolution: family === "grok" ? params.resolution : profile.pixelSize ? imageScaleOf(params.size || "auto", profile) : undefined,
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
const videoMetadata = z.object({
    input: z.object({ media: z.array(wanMedia).optional() }).strict().optional(),
    parameters: z.object({ audio: z.boolean().optional(), watermark: z.boolean().optional(), fast_mode: z.boolean().optional(), seed: z.number().int().min(-1).max(2147483647).optional() }).strict().optional(),
}).strict();
export const publicVideoRequestSchema = z.object({
    model: z.string().min(1), prompt: z.string().refine((value) => value.trim().length > 0), duration: z.number().int().positive().optional(),
    resolution: z.enum(["480P", "720P", "768P", "1080P", "2K"]), ratio: z.string(), metadata: videoMetadata.optional(),
}).strict();
export const veoRequestSchema = publicVideoRequestSchema.omit({ duration: true });
const videoParams = z.object({
    model: z.string().optional(), generate_audio: z.boolean().optional(), watermark: z.boolean().optional(),
    duration: z.number().optional(), resolution: z.string().optional(), ratio: z.string().optional(),
    content: z.array(reference.extend({ type: z.string() })).optional(),
    omni_reference_task_type: z.enum(["auto", "reference", "edit", "extend"]).optional(),
}).strict();
export function videoRequestCapabilityError(model: string, config: VideoModelConfig, body: unknown) {
    const family = videoConfiguredProfile(config).family;
    if (family !== "seedance") return publicVideoCapabilityError(model, config, body);
    const parsed = videoParams.safeParse(body);
    if (!parsed.success) return "视频请求参数格式不正确。";
    const params = parsed.data, profile = videoConfiguredProfile(config);
    const images = (params.content || []).filter((item) => item.type === "image_url");
    const videos = (params.content || []).filter((item) => item.type === "video_url");
    const audios = (params.content || []).filter((item) => item.type === "audio_url");
    const frames = images.filter((item) => item.role === "first_frame" || item.role === "last_frame" || (family === "seedance" && !item.role));
    if (frames.length && (frames.length !== images.length || frames.length > 2 || images.filter((item) => item.role === "last_frame").length > 1 || images.filter((item) => item.role === "first_frame" || !item.role).length !== 1)) return "首尾帧需要一张首帧和至多一张尾帧，不能混用参考图。";
    const ratio = params.ratio || "adaptive";
    const seconds = Number(params.duration ?? (profile.duration?.auto ? -1 : 6));
    if (profile.framesAdaptive && ["edit", "extend"].includes(params.omni_reference_task_type || "")) {
        if (!videos.length || ratio !== "adaptive") return "视频编辑或延长需要参考视频，并使用自动宽高比。";
        if (params.omni_reference_task_type === "edit" && seconds !== -1) return "视频编辑必须使用自动时长。";
    }
    return videoCapabilityError(profile, {
        resolution: params.resolution?.replace(/p$/i, "").toLowerCase() || "720",
        ratio: ratio === "adaptive" ? "auto" : ratio, seconds, mode: frames.length ? "frames" : "reference",
    }, { images: images.length, videos: videos.length, audios: audios.length });
}

function publicVideoCapabilityError(model: string, config: VideoModelConfig, body: unknown) {
    const family = videoConfiguredProfile(config).family;
    const parsed = (family === "veo" ? veoRequestSchema : publicVideoRequestSchema).safeParse(body);
    if (!parsed.success) return "视频请求请使用 model、prompt、duration（可控时长型号）、resolution、ratio 和 metadata 公共格式。";
    const params = parsed.data;
    if (params.model !== model) return "视频请求模型不一致。";
    if (family === "veo" && veoPromptError(params.prompt)) return veoPromptError(params.prompt);
    const media = params.metadata?.input?.media || [];
    const first = media.filter((item) => item.type === "first_frame"), last = media.filter((item) => item.type === "last_frame");
    const images = media.filter((item) => ["first_frame", "last_frame", "reference_image"].includes(item.type));
    const videos = media.filter((item) => item.type === "reference_video"), audios = media.filter((item) => item.type === "reference_audio");
    if (first.length > 1 || last.length > 1 || last.length && !first.length) return "首尾帧需要一张首帧和至多一张尾帧。";
    if (first.length && (images.length !== first.length + last.length || videos.length || audios.length)) return "首尾帧不能混用普通参考素材。";
    const parameters = params.metadata?.parameters;
    if (family !== "h3" && parameters?.fast_mode !== undefined || family !== "wan" && (parameters?.audio !== undefined || parameters?.watermark !== undefined || parameters?.seed !== undefined)) return "当前模型未开放所选扩展参数。";
    return videoCapabilityError(videoConfiguredProfile(config), {
        resolution: params.resolution.replace(/P$/, "").toLowerCase(), ratio: params.ratio === "adaptive" ? "auto" : params.ratio,
        seconds: "duration" in params ? params.duration ?? NaN : NaN, mode: first.length ? "frames" : "reference",
    }, { images: images.length, videos: videos.length, audios: audios.length });
}

export function videoDurationCapabilityError(model: string, config: VideoModelConfig, videoSeconds: number, audioSeconds: number) {
    const limit = (videoConfiguredProfile(config)).referenceSeconds;
    return limit !== null && (videoSeconds > limit || audioSeconds > limit) ? `参考视频、参考音频各自总时长不能超过 ${limit} 秒。` : undefined;
}
