import type { PresetListItem } from "../../../shared/preset-usage";
import { create } from "zustand";
import { getImagePresets } from "@/services/api/image-presets";
import type { ImageParameterPreset } from "../../../shared/image-models";

export const useImagePresetsStore = create<{ presets: PresetListItem<ImageParameterPreset>[]; loading: boolean; error: string; load: () => Promise<void> }>((set) => ({
    presets: [], loading: false, error: "",
    load: async () => {
        set({ loading: true, error: "" });
        try { set({ presets: (await getImagePresets()).presets }); }
        catch (error) { set({ error: error instanceof Error ? error.message : "预设加载失败" }); }
        finally { set({ loading: false }); }
    },
}));
