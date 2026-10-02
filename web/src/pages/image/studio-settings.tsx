import { Select, Switch } from "antd";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { imageSettingsForModel, selectImageRatio, selectImageScale } from "@/lib/image-settings";

export function StudioSettings({ referenceImageCount = 0 }: { referenceImageCount?: number }) {
    const config = useEffectiveConfig();
    const update = useConfigStore((state) => state.updateConfig);
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const model = config.imageModel || config.model;
    const settings = imageSettingsForModel(config, model, referenceImageCount);
    const { profile, scale, ratio, qualities, scales, ratios, error, ratioLocked } = settings;
    return <div className="studio-settings">
        <h3>生成设置</h3>
        <div><span>对话模型</span><ModelPicker config={config} value={config.textModel} capability="text" fullWidth onChange={(value) => update("textModel", value)} onMissingConfig={() => openConfig(false)} /></div>
        <div><span>张数</span><Select aria-label="生成张数" value={config.count} options={Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 张` }))} onChange={(value) => update("count", value)} /></div>
        {profile && error ? <p role="alert" className="text-xs text-muted-foreground">{error}</p> : null}
        {!profile ? <p className="text-xs text-muted-foreground">请先在功能模型配置中为此模型选择图片类型。</p> : <>
            {profile.family === "banana" ? <p className="text-xs text-muted-foreground">分辨率由模型决定{profile.fixedResolution ? `（${profile.fixedResolution.toUpperCase()}）` : ""}，更改分辨率请选择对应模型。</p> : null}
            {profile.resolutions.length > 1 ? <div><span>分辨率</span><Select aria-label="分辨率" value={scale} options={scales} onChange={(value) => update("size", selectImageScale(settings, value))} /></div> : null}
            {ratioLocked ? <p className="text-xs text-muted-foreground">单图编辑沿用参考图片比例。</p> : <div><span>宽高比</span><Select aria-label="宽高比" value={ratio} options={ratios} onChange={(value) => update("size", selectImageRatio(settings, value))} /></div>}
            {profile.qualities.length ? <div><span>画质</span><Select aria-label="画质" value={settings.quality} options={qualities} onChange={(value) => update("quality", value)} /></div> : null}
            {profile.pixelSize && settings.size === "auto" ? <p className="text-xs text-muted-foreground">尺寸由模型决定；选择具体比例后使用 1K，可继续调整分辨率。</p> : null}
            {profile.transparent ? <div><span>透明背景</span><Switch aria-label="透明背景" checked={config.background === "transparent"} onChange={(value) => update("background", value ? "transparent" : "")} /></div> : null}
        </>}
    </div>;
}
