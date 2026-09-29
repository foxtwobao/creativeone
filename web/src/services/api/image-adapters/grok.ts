import { imageModelProfile } from "../../../../../shared/image-models";
import { imageRatioAndResolution } from "./size";

export function grokImageBody(model: string, prompt: string, size: string, quality: string, count: number, images: string[]) {
    const qualities = imageModelProfile(model, "grok").qualities;
    return {
        model, prompt, n: count, response_format: "url",
        ...imageRatioAndResolution(model, size),
        ...(quality !== "auto" && qualities.includes(quality) ? { quality } : {}),
        ...(images.length === 1 ? { image: { type: "image_url", url: images[0] } }
            : images.length ? { images: images.map((url) => ({ type: "image_url", url })) } : {}),
    };
}
