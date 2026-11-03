import type { PresetListItem } from "../../../shared/preset-usage";
import { create } from "zustand";
import { getVideoPresets } from "@/services/api/video-presets";
import type { VideoParameterPreset } from "../../../shared/video-models";

export const useVideoPresetsStore = create<{ presets: PresetListItem<VideoParameterPreset>[]; loading: boolean; error: string; load: () => Promise<void> }>((set) => ({
    presets: [], loading: false, error: "",
    load: async () => {
        set({ loading: true, error: "" });
        try { set({ presets: (await getVideoPresets()).presets }); }
        catch (error) { set({ error: error instanceof Error ? error.message : "预设加载失败" }); }
        finally { set({ loading: false }); }
    },
}));
