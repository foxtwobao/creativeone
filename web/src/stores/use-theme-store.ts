import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeName = "light" | "dark";
export type ThemeMode = ThemeName | "system";

const resolveTheme = (mode: ThemeMode): ThemeName => mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;

type ThemeStore = {
    theme: ThemeName;
    mode: ThemeMode;
    setTheme: (mode: ThemeMode) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: resolveTheme("system"),
            mode: "system",
            setTheme: (mode) => set({ mode, theme: resolveTheme(mode) }),
        }),
        {
            name: "infinite-canvas:theme_store",
            partialize: ({ mode }) => ({ mode }),
            merge: (persisted, current) => {
                const saved = (persisted as { mode?: ThemeMode } | undefined)?.mode;
                const mode = saved === "light" || saved === "dark" ? saved : "system";
                return { ...current, mode, theme: resolveTheme(mode) };
            },
        },
    ),
);
