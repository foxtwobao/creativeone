import { ChevronDown, Info } from "lucide-react";
import { h3VideoDefaults } from "../../../shared/video-models";

export function H3ReferenceNotice({ onConfigChange, compact = false, referenceImageCount = 0 }: { onConfigChange?: (key: keyof typeof h3VideoDefaults, value: string) => void; compact?: boolean; referenceImageCount?: number }) {
    return <section aria-label="H3 参考素材要求" className="text-xs leading-5">
        <div className="flex items-center gap-1.5 font-medium"><Info className="size-3.5 shrink-0" aria-hidden="true" />H3 素材与费用说明<span className="font-normal opacity-60">· 知梦</span></div>
        <div className="mt-1">参考图 ≤ 9 张；视频 ≤ 3 段、合计 ≤ 15 秒；音频 ≤ 3 段、建议合计 ≤ 15 秒。</div>
        <div className="mt-1 opacity-80">参考视频额外计费，先预留 15 秒用量；第 6–9 张参考图按张、按任务加收费用。</div>
        {!compact ? <>
            <div className="mt-1">本次额外参考图：{Math.max(referenceImageCount - 5, 0)} 张，图片附加费不乘生成时长。</div>
            <div className="mt-1 opacity-80">金额预估暂不可用，最终扣费以 TokenONE 账单为准。</div>
            {onConfigChange ? <button type="button" className="mt-2 cursor-pointer underline underline-offset-4 hover:opacity-75" onClick={() => { for (const key of ["videoSeconds", "vquality", "videoSize"] as const) onConfigChange(key, h3VideoDefaults[key]); }}>使用推荐参数：4 秒 · 768P · 16:9</button> : null}
            <details className="group mt-2">
                <summary className="w-fit cursor-pointer list-none rounded-md underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"><span className="inline-flex items-center gap-1">完整要求与计费说明<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></span></summary>
                <div className="mt-2 space-y-2">
                    <div>无素材时为文生视频；首帧、尾帧各 1 张，尾帧需搭配首帧。首尾帧不能与普通参考图片、视频或音频混用。</div>
                    <div>参考视频单段 2–15 秒、每段 ≤ 50 MiB，MP4 / MOV、H.264 / H.265；素材需为上游可直接下载的公网 HTTPS 文件。素材要求由上游最终校验。</div>
                    <div>预扣不等于最终扣费，有效账单确认后才按实际参考视频用量结算，无法核验时保留预留用量。</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1"><a href="/pricing" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:opacity-75">查看模型价格</a><a href="https://zhimengapi.pages.dev/video/minimax-h3" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:opacity-75">知梦 H3 文档</a></div>
                </div>
            </details>
        </> : null}
    </section>;
}
