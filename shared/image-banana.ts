import { inferMediaRatio, parseAspectRatio } from "./media-size.js";

// https://zhimengapi.pages.dev/gemini/openai-compatible
// Resolution is selected by the model suffix, not by a pixel size or quality.
export function bananaImageBody(model: string, prompt: string, size: string, count: number, images: string[]) {
    const ratio = parseAspectRatio(size) ? size : inferMediaRatio(size);
    return {
        model, prompt, n: count, response_format: "url",
        ...(ratio !== "auto" ? { size: ratio } : {}),
        ...(images.length ? { image_urls: images } : {}),
    };
}
