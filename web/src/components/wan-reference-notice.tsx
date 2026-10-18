import { ChevronDown, Info } from "lucide-react";

export function WanReferenceNotice({ showDetails = true }: { showDetails?: boolean }) {
    return (
        <section aria-label="WAN 参考素材要求" className="text-xs leading-5">
            <p className="flex items-center gap-1.5 font-medium" style={{ margin: 0 }}><Info className="size-3.5 shrink-0" aria-hidden="true" />WAN 参考素材要求</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1" style={{ margin: "6px 0 0" }}>
                <li>图片 <strong className="font-medium">≤ 10 张</strong></li>
                <li>视频 <strong className="font-medium">≤ 5 段，合计 ≤ 15 秒</strong></li>
                <li>音频 <strong className="font-medium">≤ 5 段，每段 ≤ 15 秒</strong></li>
            </ul>
            <p className="opacity-80" style={{ margin: "4px 0 0" }}>长音乐请先截取至 15 秒内；参考视频额外计费。</p>
            {showDetails ? <details className="group mt-2">
                <summary className="w-fit cursor-pointer list-none rounded-md underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-1">完整要求与计费说明<ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
                </summary>
                <div className="mt-3 space-y-3">
                    <p className="opacity-75">请按以下要求准备参考素材；实际支持情况与费用以当前模型服务处理结果为准。</p>
                    <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-2">
                        <dt className="font-medium">参考图片</dt>
                        <dd>最多 10 张，建议 JPG、PNG、WebP；文档未明确像素尺寸上限。</dd>
                        <dt className="font-medium">参考视频</dt>
                        <dd>最多 5 段，MP4 / MOV；单段及全部视频合计均 ≤ 15 秒，输入视频总时长 + 输出时长 ≤ 30 秒。</dd>
                        <dt className="font-medium">音频 / 音乐</dt>
                        <dd>最多 5 段，每段 ≤ 15 秒。较长音乐请先截取片段，上游实测会拒绝超长音频。</dd>
                        <dt className="font-medium">首尾帧</dt>
                        <dd>首帧、尾帧各 1 张；可只用首帧，尾帧必须搭配首帧。</dd>
                    </dl>
                    <p>首尾帧模式不能与普通参考图片、视频或音频混用；普通参考模式支持混合素材。</p>
                    <p>视频文件每段 ≤ 64 MiB；含参考视频的混合请求中，每个素材文件均需 ≤ 64 MiB。</p>
                    <p>素材须为供应商可直接下载的 HTTPS 链接，不依赖登录、Cookie 或内网访问。</p>
                    <p>仅参考视频额外计费：按供应商实测输入秒数，与输出采用同模型、同画质秒价。相同视频 URL 重复提交按供应商去重后的实测用量结算；图片、音频及首尾帧不另收费。</p>
                    <a href="/pricing" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-75">查看模型价格</a>
                </div>
            </details> : null}
        </section>
    );
}
