import type { videoModelProfile } from "../../../shared/video-models";

export function SeedanceReferenceNotice({ profile }: { profile: ReturnType<typeof videoModelProfile> }) {
    return <section aria-label="Seedance 素材要求" className="text-xs leading-5">
        <div>时长 {profile.duration?.min}–{profile.duration?.max} 秒；参考图最多 {profile.maxImages} 张，视频最多 {profile.maxVideos} 段，音频最多 {profile.maxAudios} 段。</div>
        <div>{profile.framesRequirePair ? "首尾帧必须成对提供，不能与普通参考素材混用。" : !profile.modes.includes("frames") ? "图片使用普通参考模式，不支持指定首尾帧。" : "首尾帧与普通参考素材分开使用。"}</div>
        <div className="opacity-80">素材地址与实际支持情况由模型服务最终校验；不支持时保留参数并显示错误。实际费用以账单为准。</div>
    </section>;
}
