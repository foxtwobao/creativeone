import { useQuery } from "@tanstack/react-query";
import { cloudSession } from "@/services/api/cloud";
import { fetchModelPricing } from "@/services/api/account-pricing";
import { modelOptionName } from "@/stores/use-config-store";
import { ModelPriceTable } from "@/pages/pricing/model-price-table";
import type { AudioModelType } from "../../../shared/audio";

export function useAudioPrice(model: string) {
    const query = useQuery({ queryKey: ["audio-pricing", cloudSession?.user.id], queryFn: ({ signal }) => fetchModelPricing(signal) });
    const price = query.data?.models.find((item) => item.capability === "audio" && item.model === modelOptionName(model));
    return { ...query, price, available: Boolean(price && price.status !== "unavailable" && price.tiers.some((tier) => tier.metrics.length)) };
}
export function AudioButtonPrice({ model }: { model: string }) {
    const { price, data, available, isPending } = useAudioPrice(model);
    if (!available || !price || !data) return <span>{isPending ? "正在读取价格…" : "报价暂不可用"}</span>;
    return <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal break-words text-right text-xs font-normal leading-5">
        {price.status === "partial" ? <span>价格信息不完整</span> : null}
        {price.tiers.map((tier, index) => <span key={index}>
            {tier.condition ? <span className="block">{tier.condition}</span> : null}
            {tier.metrics.map((metric) => <span key={JSON.stringify([metric.metric, metric.usageKey, metric.unit])} className="block">
                {price.tiers.length > 1 || tier.metrics.length > 1 ? `${metric.label} ` : ""}{data.currency} {metric.minAmount === metric.maxAmount ? metric.minAmount : `${metric.minAmount}–${metric.maxAmount}`} / {metric.unitLabel}
            </span>)}
        </span>)}
    </span>;
}
export function AudioPriceHint({ model, type, showPrice = true }: { model: string; type?: AudioModelType; showPrice?: boolean }) {
    const { price, data, isPending } = useAudioPrice(model);
    return <div className="space-y-2 text-xs leading-5 text-muted-foreground">
        <p className="!mb-0">{type === "gemini-tts" ? "输出 WAV" : type === "lyria" ? "输出 MP3" : type === "suno" ? "按实际响应保存 M4A" : "请选择音频模型"} · 版本数量、时长以实际结果为准。</p>
        {showPrice ? price && data ? <ModelPriceTable model={price} currency={data.currency} /> : <p className="!mb-0">{isPending ? "正在读取价格…" : "报价暂不可用，暂时无法生成。"}</p> : null}
        <p className="!mb-0">按所示单位计费，单价区间不代表本次总价；最终扣费以账单为准。关闭页面后已受理任务继续处理。</p>
    </div>;
}
