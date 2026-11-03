export const videoModelTypes = ["seedance", "seedance_public", "wan", "h3", "veo"] as const;
export type VideoModelType = (typeof videoModelTypes)[number];
export const videoModelTypeLabels: Record<VideoModelType, string> = { seedance: "Seedance", seedance_public: "Seedance（统一视频）", wan: "WAN 3", h3: "MiniMax H3", veo: "Veo / Omni" };
export const veoModels = ["veo-3.1-lite", "veo-3.1-fast", "veo-3.1", "veo-3.1-fast-1080p", "veo-3.1-1080p", "omni-flash-video"] as const;
export const wanAspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"] as const;
export const h3AspectRatios = [...wanAspectRatios, "21:9"] as const;
export const h3VideoDefaults = { videoSeconds: "4", vquality: "768", videoSize: "16:9" } as const;

export type VideoCapabilities = {
    defaults: { resolution: string; ratio: string; seconds: string; mode: "frames" | "reference"; generateAudio: boolean; watermark: boolean; fastMode: string };
    fastModeOptions?: string[];
    durationByResolution?: Record<string, { min: number; max: number; auto: boolean }>;
    resolutions: string[]; ratios: string[];
    duration: { min: number; max: number; auto: boolean } | null;
    maxImages: number | null; maxVideos: number | null; maxAudios: number | null;
    referenceSeconds: number | null; requireImage: boolean; audioOnly: boolean;
    audioOptions: boolean; framesAdaptive: boolean; explicitReferenceTask: boolean;
    durationConfigurable: boolean; modes: ("frames" | "reference")[];
    framesRequirePair?: boolean;
    referenceImages?: { min: number; max: number };
};
export const videoTypePresets: Record<VideoModelType, VideoCapabilities> = {
    seedance: { defaults: { resolution: "720", ratio: "16:9", seconds: "6", mode: "frames", generateAudio: true, watermark: false, fastMode: "" }, resolutions: ["480", "720", "1080"], ratios: ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9", "auto"], duration: null, maxImages: null, maxVideos: null, maxAudios: null, referenceSeconds: null, requireImage: false, audioOnly: false, audioOptions: true, framesAdaptive: false, explicitReferenceTask: false, durationConfigurable: true, modes: ["frames", "reference"] },
    seedance_public: { defaults: { resolution: "720", ratio: "16:9", seconds: "6", mode: "frames", generateAudio: true, watermark: false, fastMode: "" }, resolutions: [], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], duration: { min: 4, max: 30, auto: false }, maxImages: null, maxVideos: null, maxAudios: null, referenceSeconds: null, requireImage: false, audioOnly: false, audioOptions: false, framesAdaptive: false, explicitReferenceTask: false, durationConfigurable: true, modes: ["frames", "reference"] },
    wan: { defaults: { resolution: "720", ratio: "1:1", seconds: "6", mode: "frames", generateAudio: true, watermark: false, fastMode: "" }, resolutions: [], ratios: wanAspectRatios.map((ratio) => ratio === "adaptive" ? "auto" : ratio), duration: { min: 2, max: 30, auto: false }, maxImages: 10, maxVideos: 5, maxAudios: 5, referenceSeconds: null, requireImage: false, audioOnly: true, audioOptions: false, framesAdaptive: false, explicitReferenceTask: false, durationConfigurable: true, modes: ["frames", "reference"] },
    h3: { fastModeOptions: ["", "false", "true"], defaults: { resolution: "768", ratio: "16:9", seconds: "4", mode: "frames", generateAudio: true, watermark: false, fastMode: "" }, durationByResolution: { "2k": { min: 4, max: 15, auto: false } }, resolutions: [], ratios: h3AspectRatios.map((ratio) => ratio === "adaptive" ? "auto" : ratio), duration: { min: 4, max: 30, auto: false }, maxImages: 9, maxVideos: 3, maxAudios: 3, referenceSeconds: null, requireImage: false, audioOnly: true, audioOptions: false, framesAdaptive: false, explicitReferenceTask: false, durationConfigurable: true, modes: ["frames", "reference"] },
    veo: { defaults: { resolution: "720", ratio: "16:9", seconds: "6", mode: "frames", generateAudio: true, watermark: false, fastMode: "" }, resolutions: [], ratios: ["16:9", "9:16"], duration: null, maxImages: 2, maxVideos: 0, maxAudios: 0, referenceSeconds: null, requireImage: false, audioOnly: false, audioOptions: false, framesAdaptive: false, explicitReferenceTask: false, durationConfigurable: false, modes: ["frames"] },
};
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
// https://doc.tokenone.work/web/#/688394820/172712494
// https://doc.tokenone.work/web/#/688394820/172712500
export const videoModelOverrides: Record<VideoModelType, Record<string, Partial<VideoCapabilities>>> = {
    seedance: {
        "doubao-seedance-2-0-260128": { resolutions: ["480", "720", "1080", "4k"], duration: { min: 4, max: 15, auto: true }, maxImages: 9, maxVideos: 3, maxAudios: 3, referenceSeconds: 15 },
        "doubao-seedance-2-5-260628": { duration: { min: 4, max: 30, auto: true }, maxImages: 30, maxVideos: 10, maxAudios: 10, referenceSeconds: 30, audioOnly: true, framesAdaptive: true, explicitReferenceTask: true },
    },
    seedance_public: {
        "sd-2.0-ch1": { resolutions: ["720"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"], duration: { min: 4, max: 15, auto: false }, modes: ["reference"], maxImages: 9, maxVideos: 3, maxAudios: 3 },
        "sd-2.5-ch1": { resolutions: ["720"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"], framesRequirePair: true, maxImages: 30, maxVideos: 10, maxAudios: 10 },
        "sd-2.5-ch2": { resolutions: ["720"], ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"], framesRequirePair: true, maxImages: 10, maxVideos: 10, maxAudios: 10 },
        "sd-2.5-ch3": { resolutions: ["720"], framesRequirePair: true, maxImages: 9, maxVideos: 0, maxAudios: 0 },
        "sd-2-c4": { resolutions: ["720"], ratios: ["16:9", "9:16", "1:1"], duration: { min: 4, max: 15, auto: false }, maxImages: 9, maxVideos: 3, maxAudios: 3 },
        "sd-2-c5": { resolutions: ["720"], duration: { min: 4, max: 15, auto: false }, maxImages: 9, maxVideos: 3, maxAudios: 3 },
        "sd2.5-官链-满参考-受排队影响": { resolutions: ["720"], modes: ["reference"], maxImages: 30, maxVideos: 10, maxAudios: 10 },
        "sd2.5-官转-30图10音频-火山词元": { resolutions: ["720"], modes: ["reference"], maxImages: 30, maxVideos: 0, maxAudios: 10 },
    },
    wan: {
        "wan3-standard": { resolutions: ["480", "720", "1080"], ratios: [...wanAspectRatios.slice(0, -1), "21:9", "auto"] },
        "wan3-p": { resolutions: ["480", "720", "1080"], ratios: ["16:9", "9:16", "1:1", "auto"], duration: { min: 5, max: 30, auto: false } },
        "wan3-prime-fast": { resolutions: ["720", "1080"], ratios: [...wanAspectRatios.slice(0, -1), "21:9", "auto"], duration: { min: 15, max: 30, auto: false }, defaults: { ...videoTypePresets.wan.defaults, seconds: "15" } },
    },
    h3: { "MiniMax-H3": { resolutions: ["480", "768", "1080", "2k"] } },
    veo: {
        "veo-3.1-lite": { resolutions: ["720"] },
        "veo-3.1-fast": { resolutions: ["720"], maxImages: 3, modes: ["frames", "reference"], referenceImages: { min: 3, max: 3 } },
        "veo-3.1": { resolutions: ["720"] },
        "veo-3.1-fast-1080p": { resolutions: ["1080"], maxImages: 0 },
        "veo-3.1-1080p": { resolutions: ["1080"] },
        "omni-flash-video": { resolutions: ["720"], maxImages: 3, modes: ["reference"], referenceImages: { min: 1, max: 3 } },
    },
};
export function videoModelProfile(model: string, family: VideoModelType) {
    const name = model.split("::").pop() || "";
    const profile = { family, ...videoTypePresets[family], ...videoModelOverrides[family][name] };
    return { ...profile, defaults: { ...profile.defaults,
        resolution: profile.resolutions.includes(profile.defaults.resolution) ? profile.defaults.resolution : profile.resolutions[0],
        mode: profile.modes.includes(profile.defaults.mode) ? profile.defaults.mode : profile.modes[0],
    } };
}
export function videoDurationRange(profile: ReturnType<typeof videoModelProfile>, resolution: string) {
    return profile.durationByResolution?.[resolution] || profile.duration;
}
export function videoParameterPatch(profile: ReturnType<typeof videoModelProfile>, values: { resolution: string; ratio: string; seconds: string; mode: string }) {
    const patch: Partial<typeof values> = {};
    if (!profile.resolutions.length) return patch;
    if (!profile.resolutions.includes(values.resolution)) patch.resolution = profile.defaults.resolution;
    if (!profile.ratios.includes(values.ratio)) patch.ratio = profile.defaults.ratio;
    if (!profile.modes.includes(values.mode as "frames" | "reference")) patch.mode = profile.defaults.mode;
    const duration = videoDurationRange(profile, patch.resolution || values.resolution), seconds = Number(values.seconds);
    if (profile.durationConfigurable && !(duration?.auto && seconds === -1) && (!values.seconds.trim() || !Number.isInteger(seconds) || seconds <= 0 || duration && (seconds < duration.min || seconds > duration.max))) patch.seconds = profile.defaults.seconds;
    return patch;
}
export function videoSwitchSettings(profile: ReturnType<typeof videoModelProfile>, values: { generateAudio?: string; watermark?: string; fastMode?: string }) {
    const booleanValue = (value: string | undefined, fallback: boolean) => value === "true" ? true : value === "false" ? false : fallback;
    const fastMode = profile.fastModeOptions?.includes(values.fastMode ?? "") ? values.fastMode ?? profile.defaults.fastMode : profile.defaults.fastMode;
    return { generateAudio: profile.audioOptions && booleanValue(values.generateAudio, profile.defaults.generateAudio), watermark: profile.audioOptions && booleanValue(values.watermark, profile.defaults.watermark), fastMode: fastMode === "" ? undefined : fastMode === "true" };
}
export function videoReferenceMode(profile: ReturnType<typeof videoModelProfile>, mode: string | undefined, imageCount: number) {
    if (profile.family !== "seedance") return mode || profile.defaults.mode;
    if (!profile.modes.includes("frames")) return "reference";
    return mode === "reference" || profile.family !== "h3" && profile.modes.includes("reference") && imageCount > 2 ? "reference" : "frames";
}
export function veoPromptError(prompt: string) {
    return !prompt.trim() ? "请输入视频提示词。" : Array.from(prompt).length > 10_000 || new TextEncoder().encode(prompt).length > 16 * 1024 ? "视频提示词最多 10,000 个字符，且 UTF-8 编码不能超过 16 KiB。" : "";
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
    if (profile.family === "seedance_public" && !profile.resolutions.length) return "请选择已公布的统一视频 Seedance 公共型号。";
    if (profile.family === "wan" && !profile.resolutions.length) return "请在管理后台配置 WAN 3 参数预设。";
    if (profile.family === "h3" && !profile.resolutions.length) return "请选择 MiniMax-H3 公共模型。";
    if (profile.family === "veo" && !profile.resolutions.length) return "请选择支持的 Veo / Omni 公共模型。";
    const referenceError = videoReferenceError(profile, refs);
    if (referenceError) return referenceError;
    if (!profile.resolutions.includes(params.resolution)) return "当前模型不支持所选分辨率，请重新选择。";
    if (!profile.ratios.includes(params.ratio)) return "当前模型不支持所选宽高比，请重新选择。";
    if (refs.images && !profile.modes.includes(params.mode as "frames" | "reference")) return "当前模型不支持所选图片参考模式，请重新选择。";
    if (refs.images && params.mode === "reference" && profile.referenceImages && (refs.images < profile.referenceImages.min || refs.images > profile.referenceImages.max)) return profile.referenceImages.min === profile.referenceImages.max ? `当前模型的参考图模式需要恰好 ${profile.referenceImages.min} 张图片。` : `当前模型的参考图模式需要 ${profile.referenceImages.min}–${profile.referenceImages.max} 张图片。`;
    if (profile.family === "h3" && params.mode === "frames" && (refs.videos || refs.audios)) return "首尾帧模式不能混用视频或音频参考，请切换参考模式。";
    if (params.mode === "frames" && refs.images) {
        if (profile.framesRequirePair && refs.images !== 2) return "当前模型需要成对的首尾帧，请同时提供两张图片。";
        if (refs.images > 2 || refs.videos || refs.audios) return "首尾帧模式不能混用多图、视频或音频参考，请切换参考模式。";
        if (profile.framesAdaptive && params.ratio !== "auto") return "当前模型的首尾帧模式只能使用自动宽高比，请重新选择。";
    }
    if (!profile.durationConfigurable) return "";
    const duration = videoDurationRange(profile, params.resolution);
    if (!(duration?.auto && params.seconds === -1) && (!Number.isInteger(params.seconds) || params.seconds <= 0 || (duration && (params.seconds < duration.min || params.seconds > duration.max)))) return duration ? `当前模型时长为 ${duration.min}–${duration.max} 秒${duration.auto ? "，或选择自动" : ""}。` : "视频时长必须为正整数。";
    return "";
}

export const videoCallTypes = ["tokenone", "seedance"] as const;
export type VideoCallType = (typeof videoCallTypes)[number];
export const videoCallTypeLabels: Record<VideoCallType, string> = { tokenone: "TokenONE 统一视频", seedance: "Seedance 原生" };
export type VideoProfile = VideoCapabilities & { family: VideoModelType };
export type VideoParameterPreset = { id: string; label: string; callType: VideoCallType; profile: VideoProfile; revision: number };
export const defaultVideoParameterPresets = Object.fromEntries(videoModelTypes.flatMap(family => Object.keys(videoModelOverrides[family]).map(model => [model, { label: ({ "wan3-standard": "WAN 3 标准版", "wan3-p": "WAN 3 P", "wan3-prime-fast": "WAN 3 Prime 高速版" } as Record<string, string>)[model] || model, profile: videoModelProfile(model, family), callType: family === "seedance" ? "seedance" as const : "tokenone" as const }])));
export type VideoModelConfig = { callType: VideoCallType; preset: string; profile?: VideoProfile };
export function videoConfiguredProfile(config: VideoModelConfig) {
    const profile = config.profile;
    if (!profile || (profile.family === "seedance" ? "seedance" : "tokenone") !== config.callType) throw new Error("请在管理后台配置匹配的视频调用类型和参数预设。");
    return profile;
}
export function channelVideoConfig(channel: { video_types?: Record<string, VideoCallType>; video_presets?: Record<string, string>; video_profiles?: Record<string, VideoProfile> }, model: string): VideoModelConfig {
    const config = { callType: channel.video_types?.[model], preset: channel.video_presets?.[model], profile: channel.video_profiles?.[model] };
    if (!config.callType || !config.preset) throw new Error("请在管理后台配置视频调用类型和参数预设。");
    videoConfiguredProfile(config as VideoModelConfig);
    return config as VideoModelConfig;
}
export function channelVideoProfile(channel: Parameters<typeof channelVideoConfig>[0], model: string) {
    return videoConfiguredProfile(channelVideoConfig(channel, model));
}
