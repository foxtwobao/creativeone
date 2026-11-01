import { SeedanceReferenceNotice } from "@/components/seedance-reference-notice";
import { type ReactNode } from "react";
import { Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { WanReferenceNotice } from "@/components/wan-reference-notice";
import { H3ReferenceNotice } from "@/components/h3-reference-notice";
import { VeoReferenceNotice } from "@/components/veo-reference-notice";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { type AiConfig } from "@/stores/use-config-store";
import { videoSettingsForModel } from "@/lib/video-settings";

export { videoResolutionOptions, videoSizeOptions, videoSecondsRange } from "@/lib/video-settings";
export { videoResolutionLabel, videoSizeLabel, videoSecondsLabel, videoModeLabel, normalizeVideoModeValue, normalizeVideoSizeValue, normalizeVideoResolutionValue } from "@/lib/video-settings";

type VideoSettingsPanelProps = {
    config: AiConfig;
    referenceImageCount?: number;
    referenceMedia?: Parameters<typeof videoSettingsForModel>[3];
    onConfigChange: (key: "vquality" | "videoSize" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoFastMode" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, referenceImageCount = 0, referenceMedia, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const model = config.model || config.videoModel;
    const { profile, wan, h3, veo, modes, durationConfigurable, ratios, resolution, ratio: selectedRatio, seconds, mode: videoMode, forcedReference, generateAudio, watermark, audioOptions, error, resolutions, secondsRange, autoSeconds, automaticDuration, framesAdaptive } = videoSettingsForModel(config, model, referenceImageCount, referenceMedia);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {error ? <p role="alert" className="text-xs" style={{ color: theme.node.muted }}>{error}</p> : null}
                {wan ? <WanReferenceNotice /> : null}
                {h3 ? <H3ReferenceNotice onConfigChange={onConfigChange} referenceImageCount={videoMode === "reference" ? referenceImageCount : 0} /> : null}
                {profile.family === "seedance_public" ? <SeedanceReferenceNotice profile={profile} /> : null}
                {veo ? <VeoReferenceNotice profile={profile} /> : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {resolutions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {ratios.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("videoSize", item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                {durationConfigurable ? <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={secondsRange.min} max={secondsRange.max} disabled={automaticDuration} step={1} value={automaticDuration ? secondsRange.min : Number(seconds)} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput min={secondsRange.min} max={secondsRange.max} disabled={automaticDuration} value={automaticDuration ? secondsRange.min : Number(seconds)} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                    </div>
                </SettingGroup> : null}
                {autoSeconds ? <div className="flex items-center justify-between"><span className="text-xs font-medium" style={{ color: theme.node.muted }}>自动时长</span><Switch aria-label="自动时长" checked={seconds === "-1"} onChange={(checked) => onConfigChange("videoSeconds", checked ? "-1" : profile.defaults.seconds)} /></div> : null}
                {framesAdaptive ? <p className="text-xs" style={{ color: theme.node.muted }}>首尾帧生成沿用首帧比例，请选择自动宽高比。</p> : null}
                {profile.maxImages !== 0 ? <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        {modes.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} disabled={forcedReference && item.value === "frames"} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup> : null}
                {forcedReference && referenceImageCount > 2 ? <p className="text-xs" style={{ color: theme.node.muted }}>超过两张图片，已使用参考图模式。</p> : null}
                {profile.fastModeOptions ? <SettingGroup title="处理模式（影响计费）" color={theme.node.muted}>
                    <div className="flex gap-2">{[["", "默认"], ["false", "标准"], ["true", "优先"]].map(([value, label]) => <OptionPill key={value} selected={(config.videoFastMode || "") === value} theme={theme} onClick={() => onConfigChange("videoFastMode", value)}>{label}</OptionPill>)}</div>
                </SettingGroup> : null}
                {audioOptions ? <>
                    <div className="flex items-center justify-between"><span className="text-xs font-medium" style={{ color: theme.node.muted }}>生成音频</span><Switch aria-label="生成音频" checked={generateAudio} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} /></div>
                    <div className="flex items-center justify-between"><span className="text-xs font-medium" style={{ color: theme.node.muted }}>视频水印</span><Switch aria-label="视频水印" checked={watermark} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} /></div>
                </> : null}
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function SecondsInput({ value, min, max, disabled, theme, onCommit }: { value: number; min: number; max: number; disabled: boolean; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Number(input.value);
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={min}
                max={max}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
