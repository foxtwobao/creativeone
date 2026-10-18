import { videoModelProfile, type VideoModelType } from "./video-models.js";

export function videoRequestBody(model: string, family: VideoModelType, prompt: string, references: { images: string[]; videos: string[]; audios: string[] }, params: { seconds: string; ratio: string; resolution: string; mode: string; generateAudio: boolean; watermark: boolean }) {
    const { images, videos, audios } = references;
    const { seconds, ratio, resolution, mode, generateAudio, watermark } = params;
    if (family !== "seedance") {
        const media = [
            ...images.map((url, index) => ({ type: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame", url })),
            ...videos.map((url) => ({ type: "reference_video", url })), ...audios.map((url) => ({ type: "reference_audio", url })),
        ];
        return { model, prompt, duration: Number(seconds), resolution: resolution === "2k" ? "2K" : `${resolution}P`, ratio: ratio === "auto" ? "adaptive" : ratio,
            ...(family === "h3" ? { generation_mode: media.length && mode === "reference" ? "references" : "frames" } : {}),
            ...(media.length ? { metadata: { input: { media } } } : {}) };
    }
    const duration = seconds === "-1" ? {} : { duration: Number(seconds) };
    return { model, content: [{ type: "text", text: prompt },
        ...images.map((url, index) => ({ type: "image_url", image_url: { url }, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" })),
        ...videos.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
        ...audios.map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" }))],
        ...(videoModelProfile(model, family).explicitReferenceTask && (mode === "reference" || videos.length || audios.length) ? { omni_reference_task_type: "reference" } : {}),
        ...duration, resolution: resolution === "4k" ? "4k" : `${resolution}p`, ratio: ratio === "auto" ? "adaptive" : ratio, generate_audio: generateAudio, watermark };
}
