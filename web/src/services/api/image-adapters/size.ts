import { inferMediaRatio, inferMediaScale, parseAspectRatio } from "@/lib/media-size";
import { imageModelProfile } from "../../../../../shared/image-models";

export function imageRatioAndResolution(model: string, size: string) {
    const profile = imageModelProfile(model, "grok");
    const ratio = parseAspectRatio(size) ? size : inferMediaRatio(size);
    const resolution = inferMediaScale(size);
    if (!profile.ratios.includes(ratio)) throw new Error("当前模型不支持所选宽高比，请重新选择。");
    if (profile.resolutions.length > 1 && !profile.resolutions.includes(resolution)) throw new Error("当前模型不支持所选分辨率，请重新选择。");
    return {
        ...(ratio !== "auto" ? { aspect_ratio: ratio } : {}),
        ...(resolution !== "auto" && profile.resolutions.length > 1 ? { resolution } : {}),
    };
}
