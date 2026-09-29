import { Select, Switch } from "antd";
import { ModelPicker } from "@/components/model-picker";
import { modelImageTypeOf, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { computeMediaSize, inferMediaRatio, inferMediaScale, parseAspectRatio } from "@/lib/media-size";
import { imageQualityOptions } from "@/components/image-settings-panel";
import { imageModelProfile } from "../../../../shared/image-models";

export function StudioSettings() {
    const config = useEffectiveConfig();
    const update = useConfigStore((state) => state.updateConfig);
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const scale = inferMediaScale(config.size);
    const ratio = parseAspectRatio(config.size) ? config.size : inferMediaRatio(config.size);
    const model = config.imageModel || config.model;
    const imageType = modelImageTypeOf(config, model);
    const profile = imageType ? imageModelProfile(model, imageType) : undefined;
    return <div className="studio-settings">
        <h3>生成设置</h3>
        <div><span>对话模型</span><ModelPicker config={config} value={config.textModel} capability="text" fullWidth onChange={(value) => update("textModel", value)} onMissingConfig={() => openConfig(false)} /></div>
        <div><span>图片模型</span><ModelPicker config={config} value={config.imageModel || config.model} capability="image" fullWidth onChange={(value) => update("imageModel", value)} onMissingConfig={() => openConfig(false)} /></div>
        <div><span>张数</span><Select aria-label="生成张数" value={config.count} options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 张` }))} onChange={(value) => update("count", value)} /></div>
        {!profile ? <p className="text-xs text-muted-foreground">请先在功能模型配置中为此模型选择图片类型。</p> : <>
            {profile.family === "banana" ? <p className="text-xs text-muted-foreground">分辨率由模型决定{profile.fixedResolution ? `（${profile.fixedResolution.toUpperCase()}）` : ""}，更改分辨率请选择对应模型。</p> : null}
            {profile.resolutions.length > 1 ? <div><span>分辨率</span><Select aria-label="分辨率" value={scale} options={profile.resolutions.map((value) => ({ value, label: value === "auto" ? "自动" : value.toUpperCase() }))} onChange={(value) => update("size", computeMediaSize(value, ratio === "auto" || !profile.ratios.includes(ratio) ? "1:1" : ratio))} /></div> : null}
            <div><span>宽高比</span><Select aria-label="宽高比" value={ratio} options={profile.ratios.map((value) => ({ value, label: value === "auto" ? "auto · 自动" : value }))} onChange={(value) => update("size", computeMediaSize(profile.resolutions.length === 1 ? "auto" : scale, value))} /></div>
            {profile.qualities.length ? <div><span>画质</span><Select aria-label="画质" value={profile.qualities.includes(config.quality) ? config.quality : "auto"} options={imageQualityOptions.filter((item) => profile.qualities.includes(item.value))} onChange={(value) => update("quality", value)} /></div> : null}
            {profile.transparent ? <div><span>透明背景</span><Switch aria-label="透明背景" checked={config.background === "transparent"} onChange={(value) => update("background", value ? "transparent" : "")} /></div> : null}
        </>}
    </div>;
}
