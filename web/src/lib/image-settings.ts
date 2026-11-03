import { imageRatioOf, imageScaleOf, imageSizeFor } from "../../../shared/image-size";
import i18n from "@/i18n";
import { IMAGE_DIMENSION_STEP, imageCapabilityError } from "../../../shared/image-models";
import { modelImageProfileOf, type AiConfig } from "@/stores/use-config-store";
import { resolveRequestSize } from "@/services/api/image-adapters/openai";
import { inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parseAspectRatio } from "./media-size";

export const imageQualityOptions = ["auto", "max", "xhigh", "high", "medium", "low"].map((value) => ({ value, get label() { return value === "max" ? "极致" : value === "xhigh" ? "超高" : i18n.t(`settingsPanels.common.${value}`); } }));
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, get label() { return value === "auto" ? i18n.t("settingsPanels.common.auto") : value; } }));
export const alignImageDimension = (value: number, step = IMAGE_DIMENSION_STEP) => Math.ceil(value / step) * step;

export function imageSettingsForModel(config: AiConfig, model: string, referenceCount = 0) {
    const profile = modelImageProfileOf(config, model);
    let size = config.size || profile?.defaults.size || "auto", error = "";
    if (!profile) error = "请先在功能模型配置中为此模型选择图片调用类型和参数预设。";
    else if (profile.pixelSize) {
        try { size = resolveRequestSize(size, profile) || "auto"; }
        catch (cause) { error = cause instanceof Error ? cause.message : "请重新选择图片尺寸。"; }
    }
    const scale = profile ? imageScaleOf(size, profile) : inferMediaScale(size);
    const ratio = profile ? imageRatioOf(size, profile) : inferMediaRatio(size);
    const ratioLocked = Boolean(profile?.singleReferenceRatioLocked && referenceCount === 1);
    if (profile) error ||= imageCapabilityError(profile, {
        references: referenceCount, background: config.background,
        quality: profile.qualities.length ? config.quality || profile.defaults.quality : undefined,
        ratio: !profile.pixelSize && !ratioLocked ? ratio : undefined,
        resolution: profile.pixelSize || profile.resolutions.length > 1 ? scale : undefined,
    });
    const resolutionLocked = Boolean(profile && (profile.fixedResolution || profile.resolutions.length <= 1));
    const resolution = resolutionLocked ? profile?.fixedResolution || profile?.resolutions[0] || "auto" : scale;
    return { profile, size, scale, resolution, resolutionLocked, ratio, quality: config.quality || profile?.defaults.quality || "auto", error, ratioLocked,
        qualities: (profile?.qualities || []).map(value => imageQualityOptions.find(item => item.value === value) || { value, label: value }),
        scales: profile?.fixedResolution ? [{ value: profile.fixedResolution, label: profile.fixedResolution === "auto" ? i18n.t("settingsPanels.common.auto") : profile.fixedResolution.toUpperCase() }] : (profile?.resolutions || []).map(value => imageScaleOptions.find(item => item.value === value) || { value, label: value.toUpperCase() }),
        ratios: (profile?.ratios || []).map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value, ...(parseAspectRatio(value) || { width: 0, height: 0 }) })),
    };
}

export function selectImageScale(settings: ReturnType<typeof imageSettingsForModel>, scale: string) {
    if (settings.profile?.pixelSize && scale === "auto") return "auto";
    if (!settings.profile) return "auto";
    const ratio = settings.ratio === "auto" || !settings.profile.ratios.includes(settings.ratio) ? settings.profile.ratios.find(r => r !== "auto") || "auto" : settings.ratio;
    return imageSizeFor(settings.profile, scale, ratio);
}

export function selectImageRatio(settings: ReturnType<typeof imageSettingsForModel>, ratio: string) {
    const scale = settings.profile?.resolutions.length === 1 ? "auto" : settings.profile?.pixelSize && settings.scale === "auto" ? "1k" : settings.scale;
    if (!settings.profile) return "auto";
    return imageSizeFor(settings.profile, settings.profile.resolutions.includes(scale) ? scale : settings.profile.resolutions.find(r => r !== "auto") || "1k", ratio);
}
