import { videoCapabilityError, veoPromptError, videoConfiguredProfile, type VideoModelConfig } from "./video-models.js";

export function videoRequestBody(model: string, config: VideoModelConfig, prompt: string, references: { images: string[]; videos: string[]; audios: string[] }, params: { seconds: string; ratio: string; resolution: string; mode: string; generateAudio?: boolean; watermark?: boolean; fastMode?: boolean; seed?: number }) {
    const { images, videos, audios } = references;
    const { seconds, ratio, resolution, mode } = params;
    const profile = videoConfiguredProfile(config), family = profile.family;
    if (config.callType === "seedance") {
        const { generateAudio, watermark } = params;
        const duration = seconds === "-1" ? {} : { duration: Number(seconds) };
        return { model, content: [{ type: "text", text: prompt },
            ...images.map((url, index) => ({ type: "image_url", image_url: { url }, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" })),
            ...videos.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
            ...audios.map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" }))],
            ...(profile.explicitReferenceTask && (mode === "reference" || videos.length || audios.length) ? { omni_reference_task_type: "reference" } : {}),
            ...duration, resolution: resolution === "4k" ? "4k" : `${resolution}p`, ratio: ratio === "auto" ? "adaptive" : ratio, generate_audio: generateAudio, watermark };
    }
    const error = (family === "veo" ? veoPromptError(prompt) : !prompt.trim() ? "请输入视频提示词。" : "") || videoCapabilityError(profile, { resolution, ratio, mode, seconds: seconds.trim() ? Number(seconds) : NaN }, { images: images.length, videos: videos.length, audios: audios.length });
    if (error) throw new Error(error);
    const media = [
        ...images.map((url, index) => ({ type: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame", url })),
        ...videos.map((url) => ({ type: "reference_video", url })), ...audios.map((url) => ({ type: "reference_audio", url })),
    ];
    const parameters = {
        ...(profile.audioOptions && params.generateAudio !== undefined ? { audio: params.generateAudio } : {}),
        ...(profile.audioOptions && params.watermark !== undefined ? { watermark: params.watermark } : {}),
        ...(family === "h3" && params.fastMode !== undefined ? { fast_mode: params.fastMode } : {}),
        ...(family === "wan" && params.seed !== undefined ? { seed: params.seed } : {}),
    };
    return { model: model.split("::").pop()!, prompt,
        ...(profile.durationConfigurable ? { duration: Number(seconds) } : {}),
        resolution: resolution.toLowerCase().endsWith("k") ? resolution.toUpperCase() : `${resolution}P`, ratio: ratio === "auto" ? "adaptive" : ratio,
        ...(media.length || Object.keys(parameters).length ? { metadata: { ...(media.length ? { input: { media } } : {}), ...(Object.keys(parameters).length ? { parameters } : {}) } } : {}) };
}
