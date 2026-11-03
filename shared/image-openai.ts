import { imageSizePresets } from "./media-size.js";
type AiConfig = { model: string; size: string; quality: string; background?: string; imageProfile?: ImageProfile };
import { IMAGE_DIMENSION_STEP, imagePixelSizeError, imageCapabilityError, type ImageProfile } from "./image-models.js";

const sizeErrors: Record<string, string> = { invalidImageSizeFormat: "图片尺寸格式无效", positiveImageRatio: "图片比例必须为正数", imageRatioLimit: "图片长短边比例不能超过 3" };
const apiText = (key: string) => sizeErrors[key] || "图片参数无效";

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    xhigh: 2880,
    max: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_MAX_RATIO = 3;

export function openAiImageParams(config: AiConfig) {
    const profile = config.imageProfile;
    if (!profile) throw new Error("缺少图片参数预设。");
    const error = imageCapabilityError(profile, { quality: profile.qualities.length ? config.quality : undefined, background: config.background });
    if (error) throw new Error(error);
    const quality = normalizeQuality(config.quality, profile);
    const size = resolveRequestSize(config.size, profile);
    const background = normalizeBackground(profile.transparent ? config.background : undefined);
    return {
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(background ? { background } : {}),
        // GPT Image always returns base64 and rejects response_format.
        ...(profile.omitResponseFormat ? {} : { response_format: "b64_json" }),
        output_format: "png",
    };
}

export function normalizeQuality(quality: string, profile?: ImageProfile) {
    const value = quality.trim().toLowerCase();
    if (profile) return profile.qualities.includes(value) ? value : profile.qualities.includes(QUALITY_ALIASES[value]) ? QUALITY_ALIASES[value] : undefined;
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
export function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** A ratio uses the 1K preset; quality never changes output dimensions. */
function resolveSize(ratio: string, profile?: ImageProfile): string {
    const parsedRatio = parseImageRatio(ratio, profile?.pixelBounds.maxRatio);
    const preset = (profile?.sizePresets || imageSizePresets)["1k"]?.[ratio];
    if (preset) {
        const [width, height] = preset.split("x").map(Number);
        validateImageSize(width, height, profile);
        return preset;
    }
    const landscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = landscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const shortSide = profile?.pixelBounds.ratioShortSide || DEFAULT_IMAGE_SHORT_SIDE;
    const step = profile?.pixelBounds.step || IMAGE_DIMENSION_STEP;
    const longSide = Math.round(shortSide * longRatio / step) * step;
    const width = landscape ? longSide : shortSide;
    const height = landscape ? shortSide : longSide;
    validateImageSize(width, height, profile);
    return `${width}x${height}`;
}

export function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

export function parseImageRatio(value: string, maxRatio = IMAGE_MAX_RATIO) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > maxRatio) throw new Error(`图片长短边比例不能超过 ${maxRatio}`);
    return ratio;
}

export function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number, profile?: ImageProfile) {
    const error = imagePixelSizeError(`${width}x${height}`, profile?.pixelBounds);
    if (error) throw new Error(error);
}

export function resolveRequestSize(size: string, profile?: ImageProfile) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height, profile);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(value, profile);
    throw new Error(apiText("invalidImageSizeFormat"));
}
