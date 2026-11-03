import { audioRequestSnapshot, type AudioModelType } from "./audio.js";
import { bananaImageBody } from "./image-banana.js";
import { grokImageBody } from "./image-grok.js";
import { openAiImageParams } from "./image-openai.js";
import { parseVideoResolution } from "./media-size.js";
import { videoSwitchSettings, videoReferenceMode, videoConfiguredProfile, type VideoModelConfig, type VideoModelType } from "./video-models.js";
import { videoRequestBody } from "./video-request.js";
import { imageConfiguredProfile, imageCapabilityError, type ImageModelConfig, type ImageModelType } from "./image-models.js";
import type { CanvasNodeMetadata } from "../web/src/types/canvas.js";

export const canvasImageReferencePrompt = (prompt: string, count: number) => count ? `参考图片编号：${Array.from({ length: count }, (_, index) => `图片${index + 1}`).join("、")}。请按这些编号理解提示词中的图片引用。\n\n${prompt.trim()}` : prompt;
export function canvasRequestBody(model: string, capability: "image" | "video" | "audio" | "text", family: ImageModelType | VideoModelType | AudioModelType | undefined, metadata: CanvasNodeMetadata, references: { images: string[]; videos: string[]; audios: string[] }, systemPrompt = "", audioContext = "", videoConfig?: VideoModelConfig, imageConfig?: ImageModelConfig) {
    const scene = metadata.prompt || "";
    if (capability === "text") return { model, stream: false, input: [
        ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
        { role: "user", content: [{ type: "input_text", text: scene }, ...references.images.map((image_url) => ({ type: "input_image", image_url }))] },
    ], ...(metadata.reasoningEffort && metadata.reasoningEffort !== "auto" ? { reasoning: { effort: metadata.reasoningEffort } } : {}) };
    if (capability === "audio") {
        if (!metadata.audioInput) throw new Error("缺少音频创作参数");
        const input = "text" in metadata.audioInput ? { ...metadata.audioInput, text: scene } : { ...metadata.audioInput, description: scene };
        return audioRequestSnapshot(model, family as AudioModelType, input, audioContext);
    }
    if (capability === "image") {
        if (!imageConfig) throw new Error("缺少图片调用类型和参数预设。");
        const imageProfile = imageConfiguredProfile(imageConfig);
        family = imageConfig.callType;
        const text = canvasImageReferencePrompt(scene, references.images.length), prompt = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${text}` : text;
        const config = { model, size: metadata.size || imageProfile.defaults.size, quality: metadata.quality || imageProfile.defaults.quality, background: metadata.background ?? imageProfile.defaults.background, imageProfile };
        const imageError = imageCapabilityError(imageProfile, { references: references.images.length, quality: imageProfile.qualities.length ? config.quality : undefined, background: config.background });
        if (imageError) throw new Error(imageError);
        if (family === "banana") return bananaImageBody(model, prompt, config.size, 1, references.images, imageProfile);
        if (family === "grok") return grokImageBody(model, prompt, config.size, config.quality, 1, references.images, imageProfile);
        return { model, prompt, n: 1, ...openAiImageParams(config), ...(references.images.length ? { image_references: references.images } : {}) };
    }
    if (!videoConfig) throw new Error("缺少视频调用类型和参数预设。");
    const profile = videoConfiguredProfile(videoConfig);
    family = profile.family;
    return videoRequestBody(model, videoConfig, scene, references, {
        ratio: metadata.videoSize || profile.defaults.ratio, resolution: parseVideoResolution(metadata.vquality || profile.defaults.resolution), seconds: metadata.seconds ?? profile.defaults.seconds,
        mode: videoReferenceMode(profile, metadata.videoMode, references.images.length),
        ...videoSwitchSettings(profile, metadata),
    });
}
