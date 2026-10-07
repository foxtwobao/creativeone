import { Image } from "antd";
import { useState } from "react";
import type { AdminTaskMedia } from "../../../../../../shared/admin-tasks";

export function TaskMedia({ media, index }: { media: AdminTaskMedia; index: number }) {
    const [failed, setFailed] = useState(false);
    const label = `${{ image: "图片", video: "视频", audio: "音频" }[media.kind]} ${index + 1}`;
    return <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        {!media.url || failed ? <p className="py-4 text-sm text-muted-foreground">文件不可用</p>
            : media.kind === "image" ? <Image width="100%" src={media.previewUrl} preview={{ src: media.url }} alt={label} loading="lazy" onError={() => setFailed(true)} className="rounded-lg" />
            : media.kind === "video" ? <video src={media.url} controls preload="none" onError={() => setFailed(true)} className="w-full rounded-lg" />
            : <audio src={media.url} controls preload="none" onError={() => setFailed(true)} className="w-full" />}
    </div>;
}
