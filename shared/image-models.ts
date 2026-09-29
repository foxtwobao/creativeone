export const imageModelTypes = ["openai", "banana", "grok"] as const;
export type ImageModelType = (typeof imageModelTypes)[number];
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
