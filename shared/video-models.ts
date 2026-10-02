export const videoModelTypes = ["seedance", "wan"] as const;
export type VideoModelType = (typeof videoModelTypes)[number];
export const videoModelTypeLabels: Record<VideoModelType, string> = { seedance: "Seedance", wan: "WAN 3" };

type VideoCapabilities = {
    resolutions: string[]; fixedResolution?: string; ratios: string[];
    duration: { min: number; max: number; auto: boolean } | null;
    maxImages: number | null; maxVideos: number | null; maxAudios: number | null;
    referenceSeconds: number | null; requireImage: boolean; audioOnly: boolean;
    audioOptions: boolean; framesAdaptive: boolean; explicitReferenceTask: boolean;
};
export const videoTypePresets: Record<VideoModelType, VideoCapabilities> = {
    seedance: { resolutions: ["480", "720", "1080"], ratios: ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9", "auto"], duration: null, maxImages: null, maxVideos: null, maxAudios: null, referenceSeconds: null, requireImage: false, audioOnly: false, audioOptions: true, framesAdaptive: false, explicitReferenceTask: false },
    wan: { resolutions: [], ratios: ["16:9", "9:16", "1:1", "auto"], duration: null, maxImages: 10, maxVideos: null, maxAudios: null, referenceSeconds: null, requireImage: false, audioOnly: true, audioOptions: false, framesAdaptive: false, explicitReferenceTask: false },
};
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
// https://doc.tokenone.work/web/#/688394820/172712494
export const videoModelOverrides: Record<VideoModelType, Record<string, Partial<VideoCapabilities>>> = {
    seedance: {
        "doubao-seedance-2-0-260128": { resolutions: ["480", "720", "1080", "4k"], duration: { min: 4, max: 15, auto: true }, maxImages: 9, maxVideos: 3, maxAudios: 3, referenceSeconds: 15 },
        "doubao-seedance-2-5-260628": { duration: { min: 4, max: 30, auto: true }, maxImages: 30, maxVideos: 10, maxAudios: 10, referenceSeconds: 30, audioOnly: true, framesAdaptive: true, explicitReferenceTask: true },
    },
    wan: {
        "wan3.0-video-480p": { fixedResolution: "480" }, "wan3.0-video-720p": { fixedResolution: "720" }, "wan3.0-video-1080p": { fixedResolution: "1080" },
        "wan3.0-video-prime-480p": { fixedResolution: "480" }, "wan3.0-video-prime-720p": { fixedResolution: "720" }, "wan3.0-video-prime-1080p": { fixedResolution: "1080" },
        "wan3.0-image-480p": { fixedResolution: "480", maxVideos: 0, requireImage: true }, "wan3.0-image-720p": { fixedResolution: "720", maxVideos: 0, requireImage: true }, "wan3.0-image-1080p": { fixedResolution: "1080", maxVideos: 0, requireImage: true },
        "wan3.0-image-prime-480p": { fixedResolution: "480", maxVideos: 0, requireImage: true }, "wan3.0-image-prime-720p": { fixedResolution: "720", maxVideos: 0, requireImage: true }, "wan3.0-image-prime-1080p": { fixedResolution: "1080", maxVideos: 0, requireImage: true },
    },
};
export function videoModelProfile(model: string, family: VideoModelType) {
    const name = model.split("::").pop() || "";
    return { family, ...videoTypePresets[family], ...videoModelOverrides[family][name] };
}
export function wanModelProfile(model: string) {
    const profile = videoModelProfile(model, "wan");
    return profile.fixedResolution ? { referenceVideo: profile.maxVideos !== 0, resolution: profile.fixedResolution } : null;
}
export type VideoReferenceCounts = { images: number; videos: number; audios: number; videoSeconds?: number; audioSeconds?: number };
export function videoReferenceError(profile: ReturnType<typeof videoModelProfile>, refs: VideoReferenceCounts) {
    if (profile.maxVideos === 0 && refs.videos) return "当前模型不支持参考视频。";
    if (profile.requireImage && !refs.images) return "图生视频模型需要至少一张参考图片。";
    for (const [count, max, label] of [[refs.images, profile.maxImages, "参考图片"], [refs.videos, profile.maxVideos, "参考视频"], [refs.audios, profile.maxAudios, "参考音频"]] as const) {
        if (max !== null && count > max) return `当前模型最多支持 ${max} 个${label}，请移除多余素材。`;
    }
    if (!profile.audioOnly && refs.audios && !refs.images && !refs.videos) return "当前模型的参考音频需要搭配图片或视频。";
    if (profile.referenceSeconds !== null && ((refs.videoSeconds || 0) > profile.referenceSeconds || (refs.audioSeconds || 0) > profile.referenceSeconds)) return `参考视频、参考音频各自总时长不能超过 ${profile.referenceSeconds} 秒。`;
    return "";
}
export function videoCapabilityError(profile: ReturnType<typeof videoModelProfile>, params: { resolution: string; ratio: string; seconds: number; mode: string }, refs: VideoReferenceCounts) {
    if (profile.family === "wan" && !profile.fixedResolution) return "当前 WAN 型号尚未配置能力。";
    const referenceError = videoReferenceError(profile, refs);
    if (referenceError) return referenceError;
    if (!profile.fixedResolution && !profile.resolutions.includes(params.resolution)) return "当前模型不支持所选分辨率，请重新选择。";
    if (!profile.ratios.includes(params.ratio)) return "当前模型不支持所选宽高比，请重新选择。";
    if (profile.family === "seedance" && params.mode === "frames" && refs.images) {
        if (refs.images > 2 || refs.videos || refs.audios) return "首尾帧模式不能混用多图、视频或音频参考，请切换参考模式。";
        if (profile.framesAdaptive && params.ratio !== "auto") return "当前模型的首尾帧模式只能使用自动宽高比，请重新选择。";
    }
    const duration = profile.duration;
    if (!(duration?.auto && params.seconds === -1) && (!Number.isInteger(params.seconds) || params.seconds <= 0 || (duration && (params.seconds < duration.min || params.seconds > duration.max)))) return duration ? `当前模型时长为 ${duration.min}–${duration.max} 秒${duration.auto ? "，或选择自动" : ""}。` : "视频时长必须为正整数。";
    return "";
}
