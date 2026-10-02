import i18n from "@/i18n";
import { boolConfig, modelOptionName, modelVideoTypeOf, type AiConfig } from "@/stores/use-config-store";
import { clampVideoSeconds, inferVideoRatio, parseVideoResolution, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, videoRatioOptions } from "./media-size";
import { wanModelProfile } from "../../../shared/video-models";

export const videoResolutionOptions = ["480", "720", "1080"].map((value) => ({ value, label: `${value}p` }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };
export const videoModeOptions = ["frames", "reference"].map((value) => ({ value, get label() { return i18n.t(`settingsPanels.video.modes.${value}`); } }));
export const resolveVideoMode = (mode: string | undefined, imageCount: number) => mode === "reference" || imageCount > 2 ? "reference" : "frames";

export const videoResolutionLabel = (value: string) => `${parseVideoResolution(value)}p`;
export const videoSecondsLabel = (value: string) => `${value || "6"}s`;
export const normalizeVideoModeValue = (value: string | undefined) => value === "reference" ? "reference" : "frames";
export const normalizeVideoSizeValue = inferVideoRatio;
export const normalizeVideoResolutionValue = parseVideoResolution;
export const videoModeLabel = (value: string) => i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSettingsForModel(config: AiConfig, model: string, imageCount = 0) {
    const kind = modelVideoTypeOf(config, model);
    const wan = kind === "wan" ? wanModelProfile(modelOptionName(model)) : null;
    const ratios = videoRatioOptions.filter((item) => kind !== "wan" || ["16:9", "9:16", "1:1", "auto"].includes(item.value));
    const ratio = config.videoSize || "auto";
    const resolution = wan?.resolution || parseVideoResolution(config.vquality);
    const mode = resolveVideoMode(config.videoMode, imageCount);
    const error = kind === "wan" && !wan ? "WAN 模型名需包含有效的分辨率后缀" : !ratios.some((item) => item.value === ratio) ? "当前模型不支持所选宽高比，请重新选择。" : "";
    return {
        wan, ratios, ratio, resolution, mode, error,
        seconds: clampVideoSeconds(config.videoSeconds),
        generateAudio: kind !== "wan" && boolConfig(config.videoGenerateAudio, true),
        watermark: kind !== "wan" && boolConfig(config.videoWatermark, false),
        audioOptions: kind !== "wan",
        forcedReference: imageCount > 2,
    };
}
