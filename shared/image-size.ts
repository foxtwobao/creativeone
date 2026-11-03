import { inferMediaRatio, inferMediaScale, parseAspectRatio } from "./media-size.js";
import { resolveRequestSize } from "./image-openai.js";
import type { ImageProfile } from "./image-models.js";

export function imageScaleOf(size: string, profile: ImageProfile) {
    return Object.keys(profile.sizePresets).find(scale => Object.values(profile.sizePresets[scale]).includes(size)) || inferMediaScale(size);
}
export function imageRatioOf(size: string, profile: ImageProfile) {
    if (!size || size === "auto") return "auto";
    if (parseAspectRatio(size)) return size;
    for (const sizes of Object.values(profile.sizePresets)) {
        const ratio = Object.keys(sizes).find(ratio => sizes[ratio] === size);
        if (ratio) return ratio;
    }
    return inferMediaRatio(size);
}
export function imageSizeFor(profile: ImageProfile, scale: string, ratio: string) {
    if (ratio === "auto") return "auto";
    return profile.sizePresets[scale]?.[ratio] || ratio;
}
export function imageRatioAndResolution(profile: ImageProfile, size: string, omitRatio = false) {
    const ratio = imageRatioOf(size, profile), resolution = imageScaleOf(size, profile);
    if (!omitRatio && !profile.ratios.includes(ratio)) throw new Error("当前模型不支持所选宽高比，请重新选择。");
    if ((profile.pixelSize || profile.resolutions.length > 1) && !profile.resolutions.includes(resolution)) throw new Error("当前模型不支持所选分辨率，请重新选择。");
    return {
        ...(!omitRatio && ratio !== "auto" ? { aspect_ratio: ratio } : {}),
        ...(resolution !== "auto" && profile.resolutions.length > 1 ? { resolution } : {}),
    };
}

export function imageParameterPatch(profile: ImageProfile, values: { size: string; quality: string; background: string }) {
    const patch: Partial<typeof values> = {};
    if (profile.qualities.length && !profile.qualities.includes(values.quality)) patch.quality = profile.defaults.quality;
    if (values.background === "transparent" && !profile.transparent) patch.background = profile.defaults.background;
    let size = values.size;
    if (profile.pixelSize) { try { size = resolveRequestSize(size, profile) || "auto"; } catch { patch.size = profile.defaults.size; } }
    const resolution = imageScaleOf(size, profile), ratio = imageRatioOf(size, profile);
    if (!values.size || !profile.pixelSize && !profile.ratios.includes(ratio) || (profile.pixelSize || profile.resolutions.length > 1) && !profile.resolutions.includes(resolution)) patch.size = profile.defaults.size;
    return patch;
}
