import { imageModelProfile, imageCapabilityError } from "./image-models.js";
import { imageRatioAndResolution } from "./image-size.js";

export function grokImageBody(model: string, prompt: string, size: string, quality: string, count: number, images: string[]) {
    const profile = imageModelProfile(model, "grok");
    const { qualities } = profile;
    const error = imageCapabilityError(profile, { references: images.length, quality: qualities.length ? quality : undefined });
    if (error) throw new Error(error);
    return {
        model, prompt, n: count, response_format: "url",
        ...imageRatioAndResolution(model, size, images.length === 1),
        ...(quality !== "auto" && qualities.includes(quality) ? { quality } : {}),
        ...(images.length === 1 ? { image: { type: "image_url", url: images[0] } }
            : images.length ? { images: images.map((url) => ({ type: "image_url", url })) } : {}),
    };
}
