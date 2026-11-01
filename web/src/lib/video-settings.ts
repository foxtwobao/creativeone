import i18n from "@/i18n";
import { modelVideoProfileOf, modelVideoTypeOf, type AiConfig } from "@/stores/use-config-store";
import { inferVideoRatio, parseVideoResolution, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, videoRatioOptions } from "./media-size";
import { videoSwitchSettings, videoDurationRange, videoCapabilityError, videoReferenceMode } from "../../../shared/video-models";

export const videoResolutionOptions = ["480", "720", "1080"].map((value) => ({ value, label: `${value}p` }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };
export const videoModeOptions = ["frames", "reference"].map((value) => ({ value, get label() { return i18n.t(`settingsPanels.video.modes.${value}`); } }));
export const resolveVideoMode = (mode: string | undefined, imageCount: number, autoReference = true) => mode === "reference" || autoReference && imageCount > 2 ? "reference" : "frames";

export const videoResolutionLabel = (value: string) => /^(2|4)k$/i.test(value) ? value.toUpperCase() : `${parseVideoResolution(value)}p`;
export const videoSecondsLabel = (value: string) => value === "-1" ? "自动时长" : value ? `${value}s` : "未设置";
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
    const profile = modelVideoProfileOf(config, model);
    const wan = kind === "wan" ? profile : null;
    const h3 = kind === "h3";
    const veo = kind === "veo";
    const ratio = config.videoSize || profile.defaults.ratio;
    const resolution = parseVideoResolution(config.vquality || profile.defaults.resolution);
    const mode = videoReferenceMode(profile, config.videoMode, imageCount);
    const seconds = config.videoSeconds ?? profile.defaults.seconds;
    const refs = { images: imageCount, videos: media.videos?.length || 0, audios: media.audios?.length || 0,
        videoSeconds: media.videos?.reduce((sum, item) => sum + (item.durationMs || 0) / 1000, 0),
        audioSeconds: media.audios?.reduce((sum, item) => sum + (item.durationMs || 0) / 1000, 0) };
    const error = !profile.resolutions.length ? "请在管理后台配置视频调用类型和参数预设。" : videoCapabilityError(profile, { ratio, resolution, seconds: Number(seconds), mode }, refs);
    const framesAdaptive = profile.framesAdaptive && mode === "frames" && imageCount > 0;
    return {
        profile, wan, h3, veo, ratio, resolution, mode, error, seconds, framesAdaptive,
        modes: videoModeOptions.filter((item) => profile.modes.includes(item.value as "frames" | "reference")),
        durationConfigurable: profile.durationConfigurable,
        durationLabel: profile.durationConfigurable ? videoSecondsLabel(seconds) : "模型决定时长",
        modeLabel: veo && !imageCount ? "文生视频" : videoModeLabel(mode),
        ratios: videoRatioOptions.filter((item) => profile.ratios.includes(item.value) && (!framesAdaptive || item.value === "auto")),
        resolutions: profile.resolutions.map((value) => ({ value, label: videoResolutionLabel(value) })),
        secondsRange: videoDurationRange(profile, resolution) || videoSecondsRange,
        autoSeconds: profile.duration?.auto || false,
        automaticDuration: profile.duration?.auto === true && seconds === "-1",
        ...videoSwitchSettings(profile, { generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark, fastMode: config.videoFastMode }),
        audioOptions: profile.audioOptions,
        forcedReference: profile.family === "seedance" && profile.modes.includes("reference") && imageCount > 2,
    };
}
