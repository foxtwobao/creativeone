import i18n from "@/i18n";
import { IMAGE_DIMENSION_STEP, imageModelProfile } from "../../../shared/image-models";
import { modelImageTypeOf, type AiConfig } from "@/stores/use-config-store";
import { resolveRequestSize } from "@/services/api/image-adapters/openai";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parseAspectRatio } from "./media-size";

export const imageQualityOptions = ["auto", "high", "medium", "low"].map((value) => ({ value, get label() { return i18n.t(`settingsPanels.common.${value}`); } }));
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, get label() { return value === "auto" ? i18n.t("settingsPanels.common.auto") : value; } }));
export const alignImageDimension = (value: number) => Math.ceil(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;

export function imageSettingsForModel(config: AiConfig, model: string) {
    const family = modelImageTypeOf(config, model);
    const profile = family ? imageModelProfile(model, family) : undefined;
    let size = config.size || "auto", error = "";
    if (!profile) error = "请先在功能模型配置中为此模型选择图片类型。";
    else if (profile.pixelSize) {
        try { size = resolveRequestSize(size) || "auto"; }
        catch (cause) { error = cause instanceof Error ? cause.message : "请重新选择图片尺寸。"; }
    }
    const scale = inferMediaScale(size);
    const ratio = parseAspectRatio(size) ? size : inferMediaRatio(size);
    if (profile && !profile.pixelSize && !profile.ratios.includes(ratio)) error = "当前模型不支持所选宽高比，请重新选择。";
    if (profile && profile.resolutions.length > 1 && !profile.resolutions.includes(scale)) error = "当前模型不支持所选分辨率，请重新选择。";
    if (profile?.qualities.length && !profile.qualities.includes(config.quality)) error = "当前模型不支持所选画质，请重新选择。";
    return { profile, size, scale, ratio, quality: config.quality, error,
        qualities: imageQualityOptions.filter((item) => profile?.qualities.includes(item.value)),
        scales: imageScaleOptions.filter((item) => profile?.resolutions.includes(item.value)),
        ratios: (profile?.ratios || []).map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value, ...(parseAspectRatio(value) || { width: 0, height: 0 }) })),
    };
}

export function selectImageScale(settings: ReturnType<typeof imageSettingsForModel>, scale: string) {
    if (settings.profile?.pixelSize && scale === "auto") return "auto";
    return computeMediaSize(scale, settings.ratio === "auto" || !settings.profile?.ratios.includes(settings.ratio) ? "1:1" : settings.ratio);
}

export function selectImageRatio(settings: ReturnType<typeof imageSettingsForModel>, ratio: string) {
    const scale = settings.profile?.resolutions.length === 1 ? "auto" : settings.profile?.pixelSize && settings.scale === "auto" ? "1k" : settings.scale;
    return computeMediaSize(settings.profile?.resolutions.includes(scale) ? scale : "1k", ratio);
}
