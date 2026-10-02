export const imageModelTypes = ["openai", "banana", "grok"] as const;
export type ImageModelType = (typeof imageModelTypes)[number];
export const IMAGE_DIMENSION_STEP = 16;
export const imageModelTypeLabels: Record<ImageModelType, string> = { openai: "GPT Image / OpenAI Images", banana: "Banana", grok: "Grok" };

export function imageModelProfile(model: string, family: ImageModelType) {
    const name = model.toLowerCase().split("::").pop() || "";
    return {
        family,
        fixedResolution: family === "banana" ? /-(1k|2k|4k)$/.exec(name)?.[1] : undefined,
        pixelSize: family === "openai",
        transparent: family === "openai",
        qualities: family === "openai" ? ["auto", "high", "medium", "low"] : family === "grok" && name.includes("grok-imagine-image-2.0") ? ["auto", "medium", "low"] : [],
        resolutions: family === "grok" ? ["1k", "2k", "auto"] : family === "banana" ? ["auto"] : ["1k", "2k", "4k", "auto"],
        ratios: family === "openai" ? ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21", "auto"]
            : ["1:1", "2:3", "3:2", "4:3", "3:4", ...(family === "banana" ? ["4:5"] : []), "16:9", "9:16", ...(family === "banana" || name.includes("grok-imagine-image-2.0") ? ["21:9"] : []), "auto"],
    };
}

export const imageSizePresets: Record<string, Record<string, string>> = {
    "1k": { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "4:3": "1024x768", "3:4": "768x1024", "16:9": "1536x864", "9:16": "864x1536", "21:9": "2016x864", "9:21": "864x2016" },
    "2k": { "1:1": "2048x2048", "2:3": "1360x2048", "3:2": "2048x1360", "4:3": "2048x1536", "3:4": "1536x2048", "16:9": "2048x1152", "9:16": "1152x2048", "21:9": "2688x1152", "9:21": "1152x2688" },
    "4k": { "1:1": "2880x2880", "2:3": "2336x3520", "3:2": "3520x2336", "4:3": "3312x2480", "3:4": "2480x3312", "16:9": "3840x2160", "9:16": "2160x3840", "21:9": "3840x1648", "9:21": "1648x3840" },
};
