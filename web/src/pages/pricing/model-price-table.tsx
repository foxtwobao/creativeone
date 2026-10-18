import type { ModelPrice, ModelPricing } from "../../../../shared/account-pricing";

export function ModelPriceTable({ model, currency }: { model: ModelPrice; currency: ModelPricing["currency"] }) {
    return <>
        {model.status === "partial" ? <p role="status" className="!mb-0 font-medium">价格信息不完整</p> : null}
        {model.status === "unavailable" ? <div className="text-muted-foreground"><p className="!mb-0">价格暂不可用</p>{model.note ? <p className="!mb-0">{model.note}</p> : null}</div> : model.tiers.map((tier, index) => {
            const first = tier.metrics[0];
            const unit = first && tier.metrics.every((metric) => metric.unit === first.unit && metric.unitLabel === first.unitLabel) ? first.unitLabel : undefined;
            return <div key={index} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {tier.condition ? <span className="text-muted-foreground">{tier.condition}</span> : null}
                <dl className="!mb-0 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
                    {tier.metrics.map((metric) => <div key={JSON.stringify([metric.metric, metric.usageKey, metric.unit])} className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                        <dt className="text-muted-foreground">{metric.label}</dt>
                        <dd className="!mb-0 break-all font-medium tabular-nums">{metric.minAmount === metric.maxAmount ? metric.minAmount : `${metric.minAmount}–${metric.maxAmount}`}{!unit ? <span className="ml-1 font-normal text-muted-foreground">{currency} / {metric.unitLabel}</span> : null}</dd>
                    </div>)}
                </dl>
                {unit ? <span className="whitespace-nowrap text-muted-foreground">{currency} / {unit}</span> : null}
            </div>;
        })}
    </>;
}
