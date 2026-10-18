import { useEffect, useState } from "react";
import { Alert, Button } from "antd";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { fetchModelPricing } from "@/services/api/account-pricing";
import { cloudSession } from "@/services/api/cloud";
import type { ModelPricing } from "../../../../shared/account-pricing";
import { ModelPriceTable } from "./model-price-table";

const capabilities = [["image", "图片"], ["text", "文本"], ["video", "视频"], ["audio", "音频"]] as const;

export default function PricingPage() {
    const [pricing, setPricing] = useState<ModelPricing | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const request = new AbortController();
        setLoading(true); setError(""); setPricing(null);
        void fetchModelPricing(request.signal).then((result) => {
            if (!request.signal.aborted) setPricing(result);
        }).catch((reason) => {
            if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "模型价格暂不可用");
        }).finally(() => { if (!request.signal.aborted) setLoading(false); });
        return () => request.abort();
    }, [revision]);
    return <main className="h-full overflow-y-auto bg-background text-foreground">
        <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
            <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold tracking-tight">模型价格</h1>
                    {pricing ? <p className="!mb-0 mt-1 text-xs text-muted-foreground">查询于 {new Date(pricing.queriedAt).toLocaleString("zh-CN")}</p> : null}
                </div>
                <div className="flex items-center gap-4">
                    <Button type="text" icon={<RefreshCw size={14} />} loading={loading} onClick={() => setRevision((value) => value + 1)}>刷新价格</Button>
                    {cloudSession?.modelServiceUrl ? <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={`${cloudSession.modelServiceUrl}/pricing`} target="_blank" rel="noopener noreferrer">TokenONE<ArrowUpRight size={13} /></a> : null}
                </div>
            </header>
            <p className="mb-5 text-xs leading-5 text-muted-foreground">价格以 USD 展示，按各项所示单位计费。价格区间仅供参考，不保证实际请求采用最低价；各项价格不能直接相加作为费用预估，最终扣费以账单为准。</p>
            {loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">正在读取模型价格…</p> : error ? <Alert type="warning" showIcon title="模型价格暂不可用" description={error} /> : pricing ? <>
                {capabilities.map(([capability, title]) => {
                    const models = pricing.models.filter((model) => model.capability === capability);
                    return models.length ? <section key={capability} className="mb-6" aria-label={`${title}模型价格`}>
                        <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">{title}<span className="text-xs font-normal text-muted-foreground">{models.length} 个模型</span></h2>
                        <div className="divide-y divide-border border-y border-border">
                            {models.map((model) => <article key={model.model} className="grid gap-x-6 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
                                <div className="min-w-0"><h3 className="!mb-0 break-all text-[13px] font-medium leading-5">{model.model}</h3>{model.description ? <p title={model.description} className="!mb-0 mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground">{model.description}</p> : null}</div>
                                <div className="min-w-0 space-y-1.5 text-xs leading-5">
                                    <ModelPriceTable model={model} currency={pricing.currency} />
                                </div>
                            </article>)}
                        </div>
                    </section> : null;
                })}
                {!pricing.models.length ? <p className="py-12 text-center text-sm text-muted-foreground">管理员尚未启用模型。</p> : null}
            </> : null}
        </div>
    </main>;
}
