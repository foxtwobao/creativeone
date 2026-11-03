import type { VideoProfile } from "../../../shared/video-models";
import { ChevronDown, Info } from "lucide-react";

export function WanReferenceNotice({ profile, showDetails = true }: { profile: VideoProfile; showDetails?: boolean }) {
    return (
        <section aria-label="WAN 参考素材要求" className="text-xs leading-5">
            <p className="flex items-center gap-1.5 font-medium" style={{ margin: 0 }}><Info className="size-3.5 shrink-0" aria-hidden="true" />WAN 参考素材要求</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1" style={{ margin: "6px 0 0" }}>
                <li>图片 <strong className="font-medium">{profile.maxImages === null ? "未设上限" : `≤ ${profile.maxImages} 张`}</strong></li>
                <li>视频 <strong className="font-medium">{profile.maxVideos === null ? "未设上限" : `≤ ${profile.maxVideos} 段`}</strong></li>
                <li>音频 <strong className="font-medium">{profile.maxAudios === null ? "未设上限" : `≤ ${profile.maxAudios} 段`}</strong></li>
            </ul>
            {profile.referenceSeconds !== null ? <p style={{ margin: "4px 0 0" }}>参考视频、音频各自合计时长 ≤ {profile.referenceSeconds} 秒。</p> : null}
            <p className="opacity-80" style={{ margin: "4px 0 0" }}>参考素材不另收费。</p>
            {showDetails ? <details className="group mt-2">
                <summary className="w-fit cursor-pointer list-none rounded-md underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-1">完整要求<ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
                </summary>
                <div className="mt-3 space-y-3">
                    <p>{profile.referenceSeconds !== null ? `参考视频、音频各自合计时长最多 ${profile.referenceSeconds} 秒。` : "参考素材数量以上方限制为准。"}</p>
                    <p>{profile.modes.includes("frames") ? `${profile.framesRequirePair ? "首尾帧必须成对提供" : "首帧、尾帧各最多 1 张，可只用首帧，尾帧必须搭配首帧"}；首尾帧不能与普通参考素材混用。` : "不支持指定首尾帧。"}</p>
                    <p>素材须为服务能够直接下载的 HTTPS 链接，不依赖登录、Cookie 或内网访问。</p>
                    <a href="/pricing" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:opacity-75">查看模型价格</a>
                </div>
            </details> : null}
        </section>
    );
}
