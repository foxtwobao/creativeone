import { Tooltip, theme } from "antd";
import type { PresetModelUsage } from "../../../../../shared/preset-usage";

export const presetUsageLabel = (usedBy: PresetModelUsage[]) => usedBy.some(item => item.enabled) ? "使用中" : usedBy.length ? "已引用（停用）" : "未使用";
export function PresetUsage({ usedBy }: { usedBy: PresetModelUsage[] }) {
    const { token } = theme.useToken();
    const active = usedBy.some(item => item.enabled), label = presetUsageLabel(usedBy);
    return <Tooltip trigger={["hover", "focus"]} title={<div>{label}{usedBy.map(item => <div key={item.model}>{item.model}{item.enabled ? "" : "（功能已停用）"}</div>)}</div>}>
        <span role="img" aria-label={label} tabIndex={0} className="inline-block size-2 rounded-full" style={{ background: active ? token.colorSuccess : token.colorError }} />
    </Tooltip>;
}
