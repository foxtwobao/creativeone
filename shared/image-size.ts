import { inferMediaRatio, inferMediaScale, parseAspectRatio } from "./media-size.js";
import { imageModelProfile } from "./image-models.js";

export function imageRatioAndResolution(model: string, size: string, omitRatio = false) {
    const profile = imageModelProfile(model, "grok");
    const ratio = parseAspectRatio(size) ? size : inferMediaRatio(size);
    const resolution = inferMediaScale(size);
    if (!omitRatio && !profile.ratios.includes(ratio)) throw new Error("当前模型不支持所选宽高比，请重新选择。");
    if (profile.resolutions.length > 1 && !profile.resolutions.includes(resolution)) throw new Error("当前模型不支持所选分辨率，请重新选择。");
    return {
        ...(!omitRatio && ratio !== "auto" ? { aspect_ratio: ratio } : {}),
        ...(resolution !== "auto" && profile.resolutions.length > 1 ? { resolution } : {}),
    };
}
