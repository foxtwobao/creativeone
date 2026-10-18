import type { ModelPrice } from "../../../../shared/account-pricing";

export function ModelPriceQuotes({ paths }: Pick<ModelPrice, "paths">) {
    return paths.map((path, index) => <div key={index} className="flex min-w-0 items-start gap-2">
        {paths.length > 1 ? <span className="shrink-0 text-muted-foreground">报价 {index + 1}</span> : null}
        {path.note ? <p className="!mb-0 text-muted-foreground">{path.note}</p> : <div className="min-w-0 space-y-3">
            {path.quotes.map((quote, quoteIndex) => <div key={quoteIndex} className="space-y-1.5">
                {quote.source === "plugin" ? <p className="!mb-0 font-medium">{quote.pluginName || quote.pluginKey || "未知插件"}</p> : null}
                {quote.note ? <p className="!mb-0 text-muted-foreground">{quote.note}</p> : quote.tiers.map((tier, tierIndex) => {
                    const first = tier.metrics[0];
                    const unit = first && tier.metrics.every((metric) => metric.unit === first.unit && metric.unitLabel === first.unitLabel) ? first.unitLabel : undefined;
                    return <div key={tierIndex} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        {tier.condition ? <span className="text-muted-foreground">{tier.condition}</span> : null}
                        <dl className="!mb-0 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
                            {tier.metrics.map((metric) => <div key={JSON.stringify([metric.metric, metric.usageKey])} className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                                <dt className="text-muted-foreground">{metric.label}</dt>
                                <dd className="!mb-0 break-all font-medium tabular-nums">{metric.amount}{!unit ? <span className="ml-1 font-normal text-muted-foreground">CNY / {metric.unitLabel}</span> : null}</dd>
                            </div>)}
                        </dl>
                        {unit ? <span className="whitespace-nowrap text-muted-foreground">CNY / {unit}</span> : null}
                    </div>;
                })}
            </div>)}
        </div>}
    </div>);
}
