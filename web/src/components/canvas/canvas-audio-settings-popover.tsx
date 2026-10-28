import { Button, Popover } from "antd";
import { Settings2 } from "lucide-react";
import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioInputForConfig } from "@/lib/audio-generation";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { modelAudioTypeOf, type AiConfig } from "@/stores/use-config-store";
import type { AudioInput } from "../../../../shared/audio";

export function CanvasAudioSettingsPopover({ config, onChange, buttonClassName }: { config: AiConfig; onChange: (input: AudioInput) => void; buttonClassName?: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const type = modelAudioTypeOf(config, config.model);
    const input = audioInputForConfig(config);
    if (!type) return null;
    return <ImageSettingsTheme theme={theme}><Popover trigger="click" placement="topLeft" content={<div className="max-h-[60vh] w-[320px] max-w-[calc(100vw-64px)] overflow-y-auto p-2" onPointerDown={(event) => event.stopPropagation()}>
        <AudioSettingsPanel type={type} input={input} onChange={onChange} showBody={false} />
    </div>}><Button type="text" className={buttonClassName} style={{ color: theme.node.text }} icon={<Settings2 size={15} />}>{({ single: "单人配音", duo: "双人配音", song: "歌曲", instrumental: "纯音乐" })[input.mode]}</Button></Popover></ImageSettingsTheme>;
}
