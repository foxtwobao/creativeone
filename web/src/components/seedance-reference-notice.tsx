import type { videoModelProfile } from "../../../shared/video-models";

export function SeedanceReferenceNotice({ profile }: { profile: ReturnType<typeof videoModelProfile> }) {
    return <section aria-label="Seedance 素材要求" className="text-xs leading-5">
        <div>{!profile.durationConfigurable ? "时长由模型决定" : profile.duration ? `时长 ${profile.duration.min}–${profile.duration.max} 秒` : "时长为正整数秒"}；参考图 {profile.maxImages === null ? "未设上限" : `≤ ${profile.maxImages} 张`}，视频 {profile.maxVideos === null ? "未设上限" : `≤ ${profile.maxVideos} 段`}，音频 {profile.maxAudios === null ? "未设上限" : `≤ ${profile.maxAudios} 段`}。</div>
        {profile.referenceSeconds !== null ? <div>参考视频、音频各自合计时长 ≤ {profile.referenceSeconds} 秒。</div> : null}
        <div>{profile.framesRequirePair ? "首尾帧必须成对提供，不能与普通参考素材混用。" : !profile.modes.includes("frames") ? "图片使用普通参考模式，不支持指定首尾帧。" : "首尾帧与普通参考素材分开使用。"}</div>
        <div className="opacity-80">素材地址与实际支持情况由模型服务最终校验；不支持时保留参数并显示错误。实际费用以账单为准。</div>
    </section>;
}
