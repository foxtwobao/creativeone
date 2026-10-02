import { z } from "zod";
import { imageModelProfile, imageCapabilityError, type ImageModelType } from "../../shared/image-models.js";
import { videoModelProfile, videoCapabilityError, type VideoModelType } from "../../shared/video-models.js";

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
const videoParams = z.object({
    duration: z.number().optional(), seconds: z.string().optional(), resolution: z.string().optional(), ratio: z.string().optional(), aspect_ratio: z.string().optional(),
    content: z.array(reference.extend({ type: z.string() })).optional(),
    reference_images: z.array(reference).optional(), reference_videos: z.array(reference).optional(), reference_audios: z.array(reference).optional(),
    omni_reference_task_type: z.enum(["auto", "reference", "edit", "extend"]).optional(),
}).passthrough();
export function videoRequestCapabilityError(model: string, family: VideoModelType, body: unknown) {
    const parsed = videoParams.safeParse(body);
    if (!parsed.success) return "视频请求参数格式不正确。";
    const params = parsed.data, profile = videoModelProfile(model, family);
    const images = family === "wan" ? params.reference_images || [] : (params.content || []).filter((item) => item.type === "image_url");
    const videos = family === "wan" ? params.reference_videos || [] : (params.content || []).filter((item) => item.type === "video_url");
    const audios = family === "wan" ? params.reference_audios || [] : (params.content || []).filter((item) => item.type === "audio_url");
    const frames = images.filter((item) => item.role === "first_frame" || item.role === "last_frame" || (family === "seedance" && !item.role));
    if (frames.length && (frames.length !== images.length || frames.length > 2 || images.filter((item) => item.role === "last_frame").length > 1 || images.filter((item) => item.role === "first_frame" || !item.role).length !== 1)) return "首尾帧需要一张首帧和至多一张尾帧，不能混用参考图。";
    const ratio = params.aspect_ratio || params.ratio || "adaptive";
    const seconds = Number(family === "wan" ? params.seconds : params.duration ?? (profile.duration?.auto ? -1 : 6));
    if (profile.framesAdaptive && ["edit", "extend"].includes(params.omni_reference_task_type || "")) {
        if (!videos.length || ratio !== "adaptive") return "视频编辑或延长需要参考视频，并使用自动宽高比。";
        if (params.omni_reference_task_type === "edit" && seconds !== -1) return "视频编辑必须使用自动时长。";
    }
    return videoCapabilityError(profile, {
        resolution: profile.fixedResolution || params.resolution?.replace(/p$/, "") || "720",
        ratio: ratio === "adaptive" ? "auto" : ratio, seconds, mode: frames.length ? "frames" : "reference",
    }, { images: images.length, videos: videos.length, audios: audios.length });
}
