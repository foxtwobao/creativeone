import type { PresetListItem } from "../../../../shared/preset-usage";
import { cloudApi } from "./cloud";
import type { VideoParameterPreset, VideoProfile } from "../../../../shared/video-models";

export const getVideoPresets = () => cloudApi<{ presets: PresetListItem<VideoParameterPreset>[] }>("/admin/video-presets");
export const saveVideoPreset = (input: { label: string; profile: VideoProfile; revision?: number }, id?: string) => cloudApi<{ preset: VideoParameterPreset }>(id ? `/admin/video-presets/${encodeURIComponent(id)}` : "/admin/video-presets", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });
export const deleteVideoPreset = (id: string) => cloudApi<void>(`/admin/video-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
