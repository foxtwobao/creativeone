export const imageModelTypes = ["openai", "banana", "grok"] as const;
export type ImageModelType = (typeof imageModelTypes)[number];
export const IMAGE_DIMENSION_STEP = 16;
export const imageModelTypeLabels: Record<ImageModelType, string> = { openai: "GPT Image / OpenAI Images", banana: "Banana", grok: "Grok" };

type ImageCapabilities = {
    pixelSize: boolean; transparent: boolean; qualities: string[]; resolutions: string[]; ratios: string[];
    fixedResolution?: string; maxReferences: number | null; omitResponseFormat: boolean;
};
const commonRatios = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16"];
export const imageTypePresets: Record<ImageModelType, ImageCapabilities> = {
    openai: { pixelSize: true, transparent: true, qualities: ["auto", "high", "medium", "low"], resolutions: ["1k", "2k", "4k", "auto"], ratios: [...commonRatios, "21:9", "9:21", "auto"], maxReferences: null, omitResponseFormat: false },
    banana: { pixelSize: false, transparent: false, qualities: [], resolutions: ["auto"], ratios: [...commonRatios, "4:5", "21:9", "auto"], maxReferences: null, omitResponseFormat: false },
    grok: { pixelSize: false, transparent: false, qualities: [], resolutions: ["1k", "2k", "auto"], ratios: [...commonRatios, "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2", "auto"], maxReferences: null, omitResponseFormat: false },
};
// TokenONE pages 172712485/486/488/491/492. Exact IDs only; null means unconfirmed, not unlimited.
const gpt = { maxReferences: 16, omitResponseFormat: true };
const gpt25 = { ...gpt, qualities: ["auto", "max", "xhigh", "high", "medium", "low"] };
export const imageModelOverrides: Record<ImageModelType, Record<string, Partial<ImageCapabilities>>> = {
    openai: {
        "gpt-image-2": gpt, "gpt-image-2-2k": gpt, "gpt-image-2-4k": gpt,
        "gpt-image-2.5-flare": gpt25, "gpt-image-2.5-flare-2k": gpt25, "gpt-image-2.5-flare-4k": gpt25,
        "gpt-image-2.5-sunburst": gpt25, "gpt-image-2.5-sunburst-2k": gpt25, "gpt-image-2.5-sunburst-4k": gpt25,
    },
    banana: {
        "banana2-1k": { fixedResolution: "1k" }, "banana2-2k": { fixedResolution: "2k" }, "banana2-4k": { fixedResolution: "4k" },
        "banana-pro-1k": { fixedResolution: "1k" }, "banana-pro-2k": { fixedResolution: "2k" }, "banana-pro-4k": { fixedResolution: "4k" },
    },
    grok: { "grok-imagine-image": { maxReferences: 1 }, "grok-imagine-image-2.0": { maxReferences: 5, qualities: ["auto", "medium", "low"] } },
};
export function imageModelProfile(model: string, family: ImageModelType) {
    const name = model.split("::").pop() || "";
    return { family, ...imageTypePresets[family], ...imageModelOverrides[family][name] };
}

export function imageCapabilityError(profile: ReturnType<typeof imageModelProfile>, params: { quality?: string; ratio?: string; resolution?: string; references?: number; size?: string }) {
    if (profile.maxReferences !== null && (params.references || 0) > profile.maxReferences) return `当前模型最多支持 ${profile.maxReferences} 张参考图，请移除多余图片。`;
    if (params.quality && !profile.qualities.includes(params.quality)) return "当前模型不支持所选画质，请重新选择。";
    if (params.ratio && !profile.ratios.includes(params.ratio)) return "当前模型不支持所选宽高比，请重新选择。";
    if (params.resolution && !profile.resolutions.includes(params.resolution)) return "当前模型不支持所选分辨率，请重新选择。";
    if (profile.pixelSize && params.size && params.size !== "auto") return imagePixelSizeError(params.size);
    return "";
}

// Existing GPT size boundaries, shared by the editor and server submission guard.
export function imagePixelSizeError(size: string) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return "图片尺寸应为宽x高。";
    const width = Number(match[1]), height = Number(match[2]);
    if (!width || !height || width % IMAGE_DIMENSION_STEP || height % IMAGE_DIMENSION_STEP) return "图片宽高必须是正数且为 16 的倍数。";
    if (Math.max(width, height) > 3840) return "图片最长边不能超过 3840 像素。";
    if (Math.max(width, height) / Math.min(width, height) > 3) return "图片宽高比必须在 1:3 到 3:1 之间。";
    if (width * height < 655360 || width * height > 8294400) return "图片总像素数必须在 655360 到 8294400 之间。";
    return "";
}

export const imageSizePresets: Record<string, Record<string, string>> = {
    "1k": { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "4:3": "1024x768", "3:4": "768x1024", "16:9": "1536x864", "9:16": "864x1536", "21:9": "2016x864", "9:21": "864x2016" },
    "2k": { "1:1": "2048x2048", "2:3": "1360x2048", "3:2": "2048x1360", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "2688x1152", "9:21": "1152x2688" },
    "4k": { "1:1": "2880x2880", "2:3": "2336x3520", "3:2": "3520x2336", "4:3": "3312x2480", "3:4": "2480x3312", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1648", "9:21": "1648x3840" },
};

// Extra ratio presets encode the existing UI size preference; Grok sends ratio/resolution separately.
for (const scale of ["1k", "2k"]) for (const ratio of imageTypePresets.grok.ratios) {
    if (ratio === "auto" || imageSizePresets[scale][ratio]) continue;
    const [w, h] = ratio.split(":").map(Number);
    const edge = scale === "1k" ? 1536 : 2048;
    const width = Math.round(edge * w / Math.max(w, h) / 16) * 16;
    const height = Math.round(edge * h / Math.max(w, h) / 16) * 16;
    imageSizePresets[scale][ratio] = `${width}x${height}`;
}
