import i18n from "@/i18n";
import { boolConfig, modelOptionName, modelVideoTypeOf, type AiConfig } from "@/stores/use-config-store";
import { inferVideoRatio, parseVideoResolution, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, videoRatioOptions } from "./media-size";
import { wanModelProfile, videoModelProfile, videoCapabilityError } from "../../../shared/video-models";

export const videoResolutionOptions = ["480", "720", "1080"].map((value) => ({ value, label: `${value}p` }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };
export const videoModeOptions = ["frames", "reference"].map((value) => ({ value, get label() { return i18n.t(`settingsPanels.video.modes.${value}`); } }));
export const resolveVideoMode = (mode: string | undefined, imageCount: number) => mode === "reference" || imageCount > 2 ? "reference" : "frames";

export const videoResolutionLabel = (value: string) => value === "4k" ? "4K" : `${parseVideoResolution(value)}p`;
export const videoSecondsLabel = (value: string) => value === "-1" ? "自动时长" : `${value || "6"}s`;
export const normalizeVideoModeValue = (value: string | undefined) => value === "reference" ? "reference" : "frames";
export const normalizeVideoSizeValue = inferVideoRatio;
export const normalizeVideoResolutionValue = parseVideoResolution;
export const videoModeLabel = (value: string) => i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

type ReferenceMedia = { videos?: { durationMs?: number }[]; audios?: { durationMs?: number }[] };
export function videoSettingsForModel(config: AiConfig, model: string, imageCount = 0, media: ReferenceMedia = {}) {
    const kind = modelVideoTypeOf(config, model);
    const profile = videoModelProfile(modelOptionName(model), kind);
    const wan = kind === "wan" ? wanModelProfile(modelOptionName(model)) : null;
    const ratio = config.videoSize || "auto";
    const resolution = profile.fixedResolution || parseVideoResolution(config.vquality);
    const mode = resolveVideoMode(config.videoMode, imageCount);
    const seconds = config.videoSeconds || "6";
    const refs = { images: imageCount, videos: media.videos?.length || 0, audios: media.audios?.length || 0,
        videoSeconds: media.videos?.reduce((sum, item) => sum + (item.durationMs || 0) / 1000, 0),
        audioSeconds: media.audios?.reduce((sum, item) => sum + (item.durationMs || 0) / 1000, 0) };
    const error = videoCapabilityError(profile, { ratio, resolution, seconds: Number(seconds), mode }, refs);
    const framesAdaptive = profile.framesAdaptive && mode === "frames" && imageCount > 0;
    return {
        profile, wan, ratio, resolution, mode, error, seconds, framesAdaptive,
        ratios: videoRatioOptions.filter((item) => profile.ratios.includes(item.value) && (!framesAdaptive || item.value === "auto")),
        resolutions: profile.resolutions.map((value) => ({ value, label: videoResolutionLabel(value) })),
        // WAN's documented duration limits remain unknown; retain the existing editor range.
        secondsRange: profile.duration || videoSecondsRange,
        autoSeconds: profile.duration?.auto || false,
        generateAudio: profile.audioOptions && boolConfig(config.videoGenerateAudio, true),
        watermark: profile.audioOptions && boolConfig(config.videoWatermark, false),
        audioOptions: profile.audioOptions,
        forcedReference: imageCount > 2,
    };
}
