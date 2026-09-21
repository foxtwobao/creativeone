import { Select, Switch } from "antd";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions } from "@/lib/media-size";
import { imageQualityOptions } from "@/components/image-settings-panel";

export function StudioSettings() {
    const config = useEffectiveConfig();
    const update = useConfigStore((state) => state.updateConfig);
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const scale = inferMediaScale(config.size);
    const ratio = inferMediaRatio(config.size);
    return <div className="studio-settings">
        <h3>生成设置</h3>
        <div><span>对话模型</span><ModelPicker config={config} value={config.textModel} capability="text" fullWidth onChange={(value) => update("textModel", value)} onMissingConfig={() => openConfig(false)} /></div>
        <div><span>图片模型</span><ModelPicker config={config} value={config.imageModel || config.model} capability="image" fullWidth onChange={(value) => update("imageModel", value)} onMissingConfig={() => openConfig(false)} /></div>
        <div><span>张数</span><Select aria-label="生成张数" value={config.count} options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 张` }))} onChange={(value) => update("count", value)} /></div>
        <div><span>分辨率</span><Select aria-label="分辨率" value={scale} options={mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? "自动" : value.toUpperCase() }))} onChange={(value) => update("size", computeMediaSize(value, ratio === "auto" ? "1:1" : ratio))} /></div>
        <div><span>宽高比</span><Select aria-label="宽高比" value={ratio} options={mediaRatioOptions.map(({ value }) => ({ value, label: value === "auto" ? "auto · 自动" : value }))} onChange={(value) => update("size", computeMediaSize(scale, value))} /></div>
        <div><span>画质</span><Select aria-label="画质" value={config.quality || "auto"} options={imageQualityOptions} onChange={(value) => update("quality", value)} /></div>
        <div><span>透明背景</span><Switch aria-label="透明背景" checked={config.background === "transparent"} onChange={(value) => update("background", value ? "transparent" : "")} /></div>
    </div>;
}
