import type { PresetListItem } from "../../../../shared/preset-usage";
import { cloudApi } from "./cloud";
import type { ImageParameterPreset, ImageProfile } from "../../../../shared/image-models";

export const getImagePresets = () => cloudApi<{ presets: PresetListItem<ImageParameterPreset>[] }>("/admin/image-presets");
export const saveImagePreset = (input: { label: string; profile: ImageProfile; revision?: number }, id?: string) => cloudApi<{ preset: ImageParameterPreset }>(id ? `/admin/image-presets/${encodeURIComponent(id)}` : "/admin/image-presets", { method: id ? "PUT" : "POST", body: JSON.stringify(input) });
export const deleteImagePreset = (id: string) => cloudApi<void>(`/admin/image-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
