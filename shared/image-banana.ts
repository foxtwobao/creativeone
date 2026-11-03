import { imageRatioOf } from "./image-size.js";
import type { ImageProfile } from "./image-models.js";

// https://zhimengapi.pages.dev/gemini/openai-compatible
// Resolution is selected by the model suffix, not by a pixel size or quality.
export function bananaImageBody(model: string, prompt: string, size: string, count: number, images: string[], profile: ImageProfile) {
    const ratio = imageRatioOf(size, profile);
    return {
        model, prompt, n: count, ...(profile.omitResponseFormat ? {} : { response_format: "url" }),
        ...(ratio !== "auto" ? { size: ratio } : {}),
        ...(images.length ? { images } : {}),
    };
}
