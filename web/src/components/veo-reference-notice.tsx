import type { VideoProfile } from "../../../shared/video-models";

export function VeoReferenceNotice({ profile }: { profile: VideoProfile }) {
    return <div aria-label="视频素材要求" className="text-xs leading-5">
        <p>参考图片 {profile.maxImages === null ? "未设数量上限" : `最多 ${profile.maxImages} 张`}；视频 {profile.maxVideos === null ? "未设数量上限" : `最多 ${profile.maxVideos} 段`}；音频 {profile.maxAudios === null ? "未设数量上限" : `最多 ${profile.maxAudios} 段`}。</p>
        <p>{profile.modes.includes("frames") ? profile.framesRequirePair ? "首尾帧必须成对。" : "可使用首帧或首尾帧。" : "不支持指定首尾帧。"}{profile.referenceImages ? `普通参考图模式需要 ${profile.referenceImages.min}–${profile.referenceImages.max} 张图片。` : ""}</p>
        <p className="mt-1 opacity-80">{profile.resolutions.join(" / ")} · {profile.ratios.map(r => r === "auto" ? "自动" : r).join(" / ")}；时长由模型决定。参考图需可通过公网 HTTPS 访问，实际费用以账单为准。</p>
    </div>;
}
