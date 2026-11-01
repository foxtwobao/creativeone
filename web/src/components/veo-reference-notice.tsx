import { videoModelProfile } from "../../../shared/video-models";

export function VeoReferenceNotice({ profile }: { profile: ReturnType<typeof videoModelProfile> }) {
    const images = profile.maxImages === 0 ? "仅支持文生视频，请勿添加参考图片。" : profile.modes.length === 1 && profile.modes[0] === "reference" ? "支持文生视频或 1–3 张参考图；图片不作为首尾帧。" : `支持文生视频、1 张首帧或 2 张首尾帧${profile.referenceImages ? "；普通参考图模式需要恰好 3 张图片" : "；不支持普通参考图"}。`;
    return <div aria-label="视频素材要求" className="text-xs leading-5">
        <p>{images}</p>
        <p className="mt-1 opacity-80">{profile.resolutions[0]}p · 16:9 / 9:16；不支持参考视频或音频。时长由模型决定，无法指定；参考图需可通过公网 HTTPS 访问。实际费用以账单为准。</p>
    </div>;
}
