import { InputNumber, Select, Switch } from "antd";
import { ParameterOptions } from "@/components/workbench-parameter-options";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { alignImageDimension, imageSettingsForModel, selectImageRatio, selectImageScale } from "@/lib/image-settings";
import { readMediaDimensions } from "@/lib/media-size";
import styles from "@/layouts/creation-workbench.module.css";

export function StudioSettings({ referenceImageCount = 0, compact = false }: { referenceImageCount?: number; compact?: boolean }) {
    const config = useEffectiveConfig();
    const update = useConfigStore((state) => state.updateConfig);
    const settings = imageSettingsForModel(config, config.imageModel || config.model, referenceImageCount);
    const { profile, scale, resolution, resolutionLocked, ratio, qualities, scales, ratios, error, ratioLocked } = settings;
    const dimensions = readMediaDimensions(settings.size, scale, ratio);
    const updateDimension = (key: "width" | "height", value: number | null) => {
        if (value === null) return;
        const next = { ...dimensions, [key]: alignImageDimension(Math.max(1, Math.floor(value)), profile?.pixelBounds.step) };
        update("size", `${next.width}x${next.height}`);
    };
    if (compact) return <section aria-label="图片生成参数" className={styles.quickParameters}>
        <div className={styles.quickFields}>
            <label><span>张数</span><Select aria-label="生成张数" variant="borderless" value={config.count} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 张` }))} onChange={(value) => update("count", value)} /></label>
            {profile ? <label><span>分辨率</span><Select aria-label="分辨率" disabled={resolutionLocked} variant="borderless" value={resolution} options={scales} onChange={(value) => update("size", selectImageScale(settings, value))} /></label> : null}
            {profile ? <label><span>画幅</span><Select aria-label="宽高比" variant="borderless" disabled={ratioLocked} value={ratio} options={ratios} onChange={(value) => update("size", selectImageRatio(settings, value))} /></label> : null}
            {qualities.length ? <label><span>画质</span><Select aria-label="画质" variant="borderless" value={settings.quality} options={qualities} onChange={(value) => update("quality", value)} /></label> : null}
            {profile?.transparent ? <label><span>透明背景</span><Switch aria-label="透明背景" size="small" checked={config.background === "transparent"} onChange={(value) => update("background", value ? "transparent" : "")} /></label> : null}
        </div>
        {profile?.pixelSize ? <details className="mt-2 text-xs text-muted-foreground"><summary className="w-fit cursor-pointer">自定义尺寸</summary><div className="mt-2 flex items-center gap-2"><InputNumber aria-label="图片宽度" min={1} precision={0} disabled={settings.size === "auto"} value={dimensions.width} onChange={(value) => updateDimension("width", value)} /><span>×</span><InputNumber aria-label="图片高度" min={1} precision={0} disabled={settings.size === "auto"} value={dimensions.height} onChange={(value) => updateDimension("height", value)} /><span>对齐至 {profile.pixelBounds.step} 倍数</span></div></details> : null}
        {ratioLocked ? <p className="mt-2 text-xs text-muted-foreground">单图编辑沿用参考图片比例。</p> : null}
        {error ? <p role="alert" className="mt-2 text-xs text-muted-foreground">{error}</p> : null}
    </section>;
    return <section className={`${styles.formSection} ${styles.parameters}`} aria-label="图片生成参数">
        <h2 className={styles.sectionTitle}>生成参数</h2>
        <label className={styles.switchRow}>生成张数<InputNumber aria-label="生成张数" min={1} max={10} precision={0} value={Number(config.count) || 1} onChange={(value) => { if (value !== null) update("count", String(value)); }} /></label>
        {error ? <p role="alert" className="text-xs text-muted-foreground">{error}</p> : null}
        {profile ? <>
            <ParameterOptions label="分辨率" value={resolution} options={scales.map((item) => ({ ...item, disabled: resolutionLocked }))} onChange={(value) => update("size", selectImageScale(settings, value))} />
            {ratioLocked ? <p className="text-xs text-muted-foreground">单图编辑沿用参考图片比例。</p> : <ParameterOptions label="宽高比" value={ratio} options={ratios} onChange={(value) => update("size", selectImageRatio(settings, value))} />}
            {profile.pixelSize ? <div className={styles.duration}>
                <div className="mb-2 text-xs font-medium">自定义尺寸 · 对齐至 {profile.pixelBounds.step} 倍数</div>
                <div className="flex items-center gap-2"><InputNumber className="!w-full" aria-label="图片宽度" min={1} precision={0} disabled={settings.size === "auto"} value={dimensions.width} onChange={(value) => updateDimension("width", value)} /><span className="text-xs text-muted-foreground">×</span><InputNumber className="!w-full" aria-label="图片高度" min={1} precision={0} disabled={settings.size === "auto"} value={dimensions.height} onChange={(value) => updateDimension("height", value)} /></div>
            </div> : null}
            {profile.qualities.length ? <ParameterOptions label="画质" value={settings.quality} options={qualities} onChange={(value) => update("quality", value)} /> : null}
            {profile.pixelSize && settings.size === "auto" ? <p className="text-xs text-muted-foreground">尺寸由模型决定；选择具体比例后可继续调整分辨率和尺寸。</p> : null}
            {profile.transparent ? <label className={styles.switchRow}>透明背景<Switch aria-label="透明背景" checked={config.background === "transparent"} onChange={(value) => update("background", value ? "transparent" : "")} /></label> : null}
        </> : null}
    </section>;
}
