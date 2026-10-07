import { videoModelProfile, type VideoModelType } from "./video-models.js";

export function videoRequestBody(model: string, family: VideoModelType, prompt: string, references: { images: string[]; videos: string[]; audios: string[] }, params: { seconds: string; ratio: string; resolution: string; mode: string; generateAudio: boolean; watermark: boolean }) {
    const { images, videos, audios } = references;
    const { seconds, ratio, resolution, mode, generateAudio, watermark } = params;
    if (family === "wan") return { model, prompt, seconds, aspect_ratio: ratio === "auto" ? "adaptive" : ratio,
        reference_images: images.map((url, index) => ({ url, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" })),
        reference_videos: videos.map((url) => ({ url })), reference_audios: audios.map((url) => ({ url })) };
    return { model, content: [{ type: "text", text: prompt },
        ...images.map((url, index) => ({ type: "image_url", image_url: { url }, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" })),
        ...videos.map((url) => ({ type: "video_url", video_url: { url }, role: "reference_video" })),
        ...audios.map((url) => ({ type: "audio_url", audio_url: { url }, role: "reference_audio" }))],
        ...(videoModelProfile(model, family).explicitReferenceTask && (mode === "reference" || videos.length || audios.length) ? { omni_reference_task_type: "reference" } : {}),
        duration: Number(seconds), resolution: resolution === "4k" ? "4k" : `${resolution}p`, ratio: ratio === "auto" ? "adaptive" : ratio, generate_audio: generateAudio, watermark };
}
