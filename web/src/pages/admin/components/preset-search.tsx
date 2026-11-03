import { useState } from "react";
import { Button, Input, InputNumber, Select } from "antd";
import { Search } from "lucide-react";
import { imageModelTypes, imageModelTypeLabels } from "../../../../../shared/image-models";
import { videoModelTypes, videoModelTypeLabels } from "../../../../../shared/video-models";
import type { PresetModelUsage } from "../../../../../shared/preset-usage";

type PresetFilters = { query: string; family?: string; usage?: "active" | "inactive"; resolution?: string; seconds?: number | null };
type Duration = { min: number; max: number };
type SearchablePreset = {
    label: string; usedBy: PresetModelUsage[];
    profile: { family: string; resolutions: string[]; fixedResolution?: string; durationConfigurable?: boolean; duration?: Duration | null; durationByResolution?: Record<string, Duration> };
};
const availableResolutions = (preset: SearchablePreset) => preset.profile.fixedResolution ? [preset.profile.fixedResolution] : preset.profile.resolutions;
const resolutionLabel = (value: string) => value === "auto" ? "自动" : value.endsWith("k") ? value.toUpperCase() : `${value}P`;

export function usePresetSearch<T extends SearchablePreset>(items: T[]) {
    const [filters, setFilters] = useState<PresetFilters>({ query: "" });
    const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = items.filter(item => {
        const text = [item.label, ...item.usedBy.map(entry => entry.model)].join(" ").toLowerCase();
        if (!terms.every(term => text.includes(term))) return false;
        if (filters.family && item.profile.family !== filters.family) return false;
        const active = item.usedBy.some(entry => entry.enabled);
        if (filters.usage && active !== (filters.usage === "active")) return false;
        if (filters.resolution && !availableResolutions(item).includes(filters.resolution)) return false;
        if (filters.seconds != null) {
            if (!item.profile.durationConfigurable) return false;
            const resolutions = filters.resolution ? [filters.resolution] : item.profile.resolutions;
            if (!resolutions.some(resolution => {
                const range = item.profile.durationByResolution?.[resolution] || item.profile.duration;
                return !range || filters.seconds! >= range.min && filters.seconds! <= range.max;
            })) return false;
        }
        return true;
    });
    const resolutions = [...new Set(items.flatMap(availableResolutions))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { filtered, searchProps: { filters, resolutions, onChange: (patch: Partial<PresetFilters>) => setFilters(current => ({ ...current, ...patch })) } };
}

export function PresetSearch({ kind, filters, resolutions, onChange }: {
    kind: "image" | "video"; filters: PresetFilters; resolutions: string[]; onChange: (patch: Partial<PresetFilters>) => void;
}) {
    const types = kind === "image" ? imageModelTypes.map(value => ({ value, label: imageModelTypeLabels[value] })) : videoModelTypes.map(value => ({ value, label: videoModelTypeLabels[value] }));
    return <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-center">
        <Input aria-label="搜索名称或模型名" value={filters.query} onChange={event => onChange({ query: event.target.value })} allowClear prefix={<Search size={15} className="text-muted-foreground" />} placeholder="名称 / 模型名" className="col-span-2 lg:!w-64" />
        <Select aria-label="筛选预设类型" placeholder="类型" allowClear value={filters.family} onChange={family => onChange({ family })} options={types} className="w-full lg:w-44" />
        <Select aria-label="筛选使用状态" placeholder="使用状态" allowClear value={filters.usage} onChange={usage => onChange({ usage })} options={[{ value: "active", label: "使用中" }, { value: "inactive", label: "未使用 / 停用" }]} className="w-full lg:w-36" />
        <Select aria-label="筛选分辨率" placeholder="分辨率" allowClear value={filters.resolution} onChange={resolution => onChange({ resolution })} options={resolutions.map(value => ({ value, label: resolutionLabel(value) }))} className="w-full lg:w-32" />
        {kind === "video" ? <InputNumber aria-label="筛选支持时长（秒）" placeholder="支持时长（秒）" min={1} precision={0} controls={false} value={filters.seconds} onChange={seconds => onChange({ seconds })} className="!w-full lg:!w-36" /> : null}
        <Button type="text" onClick={() => onChange({ query: "", family: undefined, usage: undefined, resolution: undefined, seconds: null })}>重置</Button>
    </div>;
}
