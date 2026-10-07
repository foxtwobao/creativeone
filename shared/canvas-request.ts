import { bananaImageBody } from "./image-banana.js";
import { grokImageBody } from "./image-grok.js";
import { openAiImageParams } from "./image-openai.js";
import { parseVideoResolution } from "./media-size.js";
import { videoModelProfile, type VideoModelType } from "./video-models.js";
import { videoRequestBody } from "./video-request.js";
import type { ImageModelType } from "./image-models.js";
import type { CanvasNodeMetadata } from "../web/src/types/canvas.js";

export const canvasImageReferencePrompt = (prompt: string, count: number) => count ? `参考图片编号：${Array.from({ length: count }, (_, index) => `图片${index + 1}`).join("、")}。请按这些编号理解提示词中的图片引用。\n\n${prompt.trim()}` : prompt;
export function canvasRequestBody(model: string, capability: "image" | "video", family: ImageModelType | VideoModelType, metadata: CanvasNodeMetadata, references: { images: string[]; videos: string[]; audios: string[] }, systemPrompt = "") {
    const scene = metadata.prompt || "";
    if (capability === "image") {
        const text = canvasImageReferencePrompt(scene, references.images.length), prompt = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${text}` : text;
        const config = { model, size: metadata.size || "auto", quality: metadata.quality || "auto", background: metadata.background };
        if (family === "banana") return bananaImageBody(model, prompt, config.size, 1, references.images);
        if (family === "grok") return grokImageBody(model, prompt, config.size, config.quality, 1, references.images);
        return { model, prompt, n: 1, ...openAiImageParams(config), ...(references.images.length ? { image_references: references.images } : {}) };
    }
    const profile = videoModelProfile(model, family as VideoModelType);
    return videoRequestBody(model, family as VideoModelType, scene, references, {
        ratio: metadata.videoSize || "auto", resolution: profile.fixedResolution || parseVideoResolution(metadata.vquality || "720"), seconds: metadata.seconds || "6",
        mode: metadata.videoMode === "reference" || references.images.length > 2 ? "reference" : "frames",
        generateAudio: profile.audioOptions && metadata.generateAudio !== "false", watermark: profile.audioOptions && metadata.watermark === "true",
    });
}
