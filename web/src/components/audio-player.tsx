import { useState } from "react";
import { Button } from "antd";
import { Play } from "lucide-react";

export function AudioPlayer({ url }: { url: string }) {
    const [active, setActive] = useState(false);
    const [error, setError] = useState(false);
    return <div className="space-y-2">
        {active ? <audio src={url} controls autoPlay preload="none" className="h-10 w-full" onError={() => setError(true)} /> : <Button type="text" icon={<Play size={15} />} onClick={() => setActive(true)}>试听音频</Button>}
        {error ? <p role="status" className="!mb-0 text-xs text-muted-foreground">浏览器无法播放此音频，可下载原文件使用支持其编码的播放器打开。</p> : null}
    </div>;
}
