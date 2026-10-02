import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Search, X } from "lucide-react";
import { Popover } from "radix-ui";

import { cn } from "@/lib/utils";
import { imageModelTypeLabels } from "../../../shared/image-models";
import { videoModelTypeLabels } from "../../../shared/video-models";
import { encodeChannelModel, modelOptionLabel, modelOptionName, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value = "", onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const pickerId = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [family, setFamily] = useState<string | null>(null);
    const models = useMemo(() => config.channels.flatMap((channel) => channel.models.filter((model) => !capability || model.capability === capability).map((model) => ({
        value: encodeChannelModel(channel.id, model.name), id: model.name, description: model.description,
        family: model.capability === "image" && model.imageType ? imageModelTypeLabels[model.imageType] : model.capability === "video" && model.videoType ? videoModelTypeLabels[model.videoType] : "",
    }))), [config.channels, capability]);
    const families = [...new Set(models.map((model) => model.family || ""))];
    const search = query.trim().toLocaleLowerCase();
    const visibleModels = models.filter((model) => (family === null || model.family === family) && [model.id, model.description, model.family].join(" ").toLocaleLowerCase().includes(search));
    const label = value ? modelOptionLabel(config, value) : placeholder;
    const select = (model: string) => { onChange(model); setOpen(false); };

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return <Popover.Root open={open} onOpenChange={(nextOpen) => {
        if (nextOpen && !models.length && onMissingConfig) { onMissingConfig(); return; }
        if (nextOpen) {
            window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
            setQuery(""); setFamily(null);
        }
        setOpen(nextOpen);
    }}>
        <Popover.Trigger asChild>
            <button type="button" aria-label={`选择模型：${label}`} title={value ? modelOptionName(value) : placeholder}
                className={cn("canvas-composer-model-picker inline-flex h-8 max-w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 !text-sm !text-foreground hover:bg-accent", fullWidth ? "w-full min-w-0" : "w-fit min-w-0", className)}
                onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <Cpu className="size-4 shrink-0 opacity-60" />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{label}</span><ChevronDown className="size-3.5 shrink-0 opacity-60" />
            </button>
        </Popover.Trigger>
        <Popover.Portal>
            <Popover.Content data-canvas-no-zoom aria-label="模型选择" side="bottom" align="start" sideOffset={8} collisionPadding={12}
                className="z-[1200] flex max-h-[var(--radix-popover-content-available-height)] w-[440px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
                onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}
                onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                <div className="mb-3 flex shrink-0 items-center justify-between gap-2"><span className="font-medium">选择{capability === "image" ? "图片" : capability === "video" ? "视频" : ""}模型</span><Popover.Close aria-label="关闭模型选择" className="rounded p-1 !text-muted-foreground hover:bg-accent"><X className="size-4" /></Popover.Close></div>
                <label className="flex shrink-0 items-center gap-2 border-b border-border pb-3 text-muted-foreground"><Search className="size-4 shrink-0" /><input ref={searchRef} aria-label="搜索模型" placeholder="搜索模型 ID 或描述" value={query} onChange={(event) => { setQuery(event.target.value); setFamily(null); }} className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none" /></label>
                {families.length > 1 || families[0] ? <div className="my-3 flex shrink-0 flex-wrap gap-1" aria-label="模型类型">
                    {[null, ...families].map((item) => <button type="button" key={item === null ? "all" : `family:${item}`} aria-pressed={family === item} onClick={() => setFamily(item)} className={cn("rounded-md px-3 py-1.5 !text-xs transition-colors", family === item ? "bg-accent !text-accent-foreground" : "!text-muted-foreground hover:bg-accent")}>{item === null ? "全部" : item || "未分类"}</button>)}
                </div> : null}
                <div className="min-h-0 max-h-[min(50vh,440px)] space-y-1 overflow-y-auto overscroll-contain py-1">
                    {visibleModels.map((model) => <button type="button" key={model.value} title={model.id} aria-pressed={value === model.value} onClick={() => select(model.value)} className={cn("flex w-full items-start gap-2 rounded-xl p-3 text-left", value === model.value ? "bg-accent/60" : "hover:bg-accent/40")}>
                        <span className="min-w-0 flex-1"><span className="block break-all text-sm font-medium">{model.id}</span>{model.description ? <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-muted-foreground">{model.description}</span> : null}</span>
                        {value === model.value ? <Check aria-label="已选择" className="mt-0.5 size-4 shrink-0" /> : null}
                    </button>)}
                    {!visibleModels.length ? <div className="py-8 text-center text-sm text-muted-foreground">{models.length ? "没有匹配的模型，试试其他 ID 或描述" : "尚未配置可用模型"}</div> : null}
                </div>
                {value ? <details className="mt-3 shrink-0 border-t border-border pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">当前模型 · 完整 ID</summary><p className="mt-2 break-all font-mono text-foreground">{modelOptionName(value)}</p></details> : null}
            </Popover.Content>
        </Popover.Portal>
    </Popover.Root>;
}
