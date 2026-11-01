import { Dropdown } from "antd";
import { Monitor, Moon, Sun } from "lucide-react";
import { useThemeStore } from "@/stores/use-theme-store";

const options = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "自动", icon: Monitor },
] as const;

export function ThemeModeSwitch() {
    const mode = useThemeStore((state) => state.mode);
    const setTheme = useThemeStore((state) => state.setTheme);
    const current = options.find((option) => option.value === mode)!;
    const Icon = current.icon;
    return <Dropdown trigger={["click"]} placement="bottomRight" menu={{
        selectable: true,
        selectedKeys: [mode],
        items: options.map(({ value, label, icon: ItemIcon }) => ({ key: value, label: value === "system" ? "自动（跟随系统）" : label, icon: <ItemIcon size={15} /> })),
        onClick: ({ key }) => { if (key === "light" || key === "dark" || key === "system") setTheme(key); },
    }}>
        <button type="button" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground" aria-label="主题设置" title={`主题：${current.label}`}><Icon size={17} /></button>
    </Dropdown>;
}
