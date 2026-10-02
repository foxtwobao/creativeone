import { imageSizePresets } from "./image-models.js";

// These fields come from the saved request, never from model names or current preferences.
export function generationRequestPrompt(request?: Record<string, any> | null): string {
    if (!request) return "";
    if (typeof request.prompt === "string") return request.prompt;
    const messages = request.messages || (Array.isArray(request.input) ? request.input : []);
    const content = request.content || messages.findLast((item: any) => item.role === "user")?.content || request.input;
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.filter((item: any) => ["text", "input_text"].includes(item.type)).map((item: any) => item.text).join("\n") : "";
}

export function generationPrompt(request?: Record<string, any> | null): string {
    return typeof request?.user_prompt === "string" ? request.user_prompt : generationRequestPrompt(request);
}

export function generationRequestSettings(capability: string, request: Record<string, any>) {
    const ratio = request.aspect_ratio || request.ratio || "auto";
    // Single-image Grok edits omit ratio; this preset retains resolution while the editor locks ratio to the reference.
    const imageRatio = request.aspect_ratio || (request.image ? "1:1" : "auto");
    return {
        size: capability === "image" ? request.size || imageSizePresets[request.resolution]?.[imageRatio] || request.aspect_ratio || "auto" : "",
        videoSize: capability === "video" ? ratio === "adaptive" ? "auto" : ratio : "",
        quality: request.quality || "auto",
        background: request.background || "",
        count: String(request.n || 1),
        vquality: request.resolution || "",
        videoSeconds: String(request.seconds || request.duration || ""),
        videoGenerateAudio: String(request.generate_audio ?? true),
        videoWatermark: String(request.watermark ?? false),
        videoMode: [...(request.content || []), ...(request.reference_images || [])].some((part: any) => part.role === "reference_image") ? "reference" : "frames",
    };
}
