import i18n from "@/i18n";
import { imageSizePresets } from "@/lib/media-size";
import type { AiConfig } from "@/stores/use-config-store";
import { IMAGE_DIMENSION_STEP } from "../../../../../shared/image-models";

const apiText = (key: string) => i18n.t(`apiErrors.${key}`);

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export function openAiImageParams(config: AiConfig) {
    const quality = normalizeQuality(config.quality);
    const size = resolveRequestSize(config.size);
    const background = normalizeBackground(config.background);
    return {
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(background ? { background } : {}),
        // GPT Image always returns base64 and rejects response_format.
        ...(/gpt-image/.test(config.model) ? {} : { response_format: "b64_json" }),
        output_format: "png",
    };
}

export function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
export function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** A ratio uses the 1K preset; quality never changes output dimensions. */
function resolveSize(ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const preset = imageSizePresets["1k"][ratio];
    if (preset) return preset;
    const landscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = landscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const shortSide = DEFAULT_IMAGE_SHORT_SIDE;
    const longSide = Math.round(shortSide * longRatio / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
    const width = landscape ? longSide : shortSide;
    const height = landscape ? shortSide : longSide;
    validateImageSize(width, height);
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

export function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

export function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_DIMENSION_STEP !== 0 || height % IMAGE_DIMENSION_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

export function resolveRequestSize(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(value);
    throw new Error(apiText("invalidImageSizeFormat"));
}
