import { ChevronDown, Info } from "lucide-react";
import { type VideoProfile, type h3VideoDefaults } from "../../../shared/video-models";

export function H3ReferenceNotice({ profile, onConfigChange, compact = false, referenceImageCount = 0 }: { profile: VideoProfile; onConfigChange?: (key: keyof typeof h3VideoDefaults, value: string) => void; compact?: boolean; referenceImageCount?: number }) {
    return <section aria-label="H3 参考素材要求" className="text-xs leading-5">
        <div className="flex items-center gap-1.5 font-medium"><Info className="size-3.5 shrink-0" aria-hidden="true" />H3 素材与费用说明</div>
        <div className="mt-1">时长 {profile.duration?.min}–{profile.duration?.max} 秒{Object.entries(profile.durationByResolution || {}).map(([resolution, range]) => `，${resolution.toUpperCase()} 最长 ${range.max} 秒`).join("")}；标准／优先模式可能影响费用。</div>
        <div className="mt-1">参考图 {profile.maxImages === null ? "未设上限" : `≤ ${profile.maxImages} 张`}；视频 {profile.maxVideos === null ? "未设上限" : `≤ ${profile.maxVideos} 段`}；音频 {profile.maxAudios === null ? "未设上限" : `≤ ${profile.maxAudios} 段`}{profile.referenceSeconds !== null ? `；视频、音频各自合计 ≤ ${profile.referenceSeconds} 秒` : ""}。</div>
        <div className="mt-1 opacity-80">参考视频额外计费，先预留 15 秒用量；第 6–9 张参考图按张、按任务加收费用。</div>
        {!compact ? <>
            <div className="mt-1">本次额外参考图：{Math.max(referenceImageCount - 5, 0)} 张，图片附加费不乘生成时长。</div>
            <div className="mt-1 opacity-80">金额预估暂不可用，最终扣费以 TokenONE 账单为准。</div>
            {onConfigChange ? <button type="button" className="mt-2 cursor-pointer underline underline-offset-4 hover:opacity-75" onClick={() => { onConfigChange("videoSeconds", profile.defaults.seconds); onConfigChange("vquality", profile.defaults.resolution); onConfigChange("videoSize", profile.defaults.ratio); }}>使用推荐参数：{profile.defaults.seconds} 秒 · {profile.defaults.resolution.toUpperCase()}{profile.defaults.resolution.endsWith("k") ? "" : "P"} · {profile.defaults.ratio}</button> : null}
            <details className="group mt-2">
                <summary className="w-fit cursor-pointer list-none rounded-md underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"><span className="inline-flex items-center gap-1">完整要求与计费说明<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></span></summary>
                <div className="mt-2 space-y-2">
                    <div>无素材时为文生视频；首帧、尾帧各 1 张，尾帧需搭配首帧。首尾帧不能与普通参考图片、视频或音频混用。</div>
                    <div>参考视频单段 2–15 秒、每段 ≤ 50 MiB，MP4 / MOV、H.264 / H.265；素材需为上游可直接下载的公网 HTTPS 文件。素材要求由上游最终校验。</div>
                    <div>预扣不等于最终扣费，有效账单确认后才按实际参考视频用量结算，无法核验时保留预留用量。</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1"><a href="/pricing" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:opacity-75">查看模型价格</a></div>
                </div>
            </details>
        </> : null}
    </section>;
}
