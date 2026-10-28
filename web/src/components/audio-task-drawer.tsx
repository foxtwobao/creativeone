import { useAudioPlayback } from "@/hooks/use-audio-playback";
import { useState } from "react";
import { Alert, Drawer } from "antd";
import { useAudioTask } from "@/hooks/use-audio-task";
import { AudioWorkCard } from "@/pages/audio/audio-work-card";
import { WorkCanvasModal } from "@/pages/assets/work-canvas-modal";
import { mergeWorks, type Work } from "../../../shared/works";

export function AudioTaskDrawer({ taskId, onClose }: { taskId?: string; onClose: () => void }) {
    const onPlay = useAudioPlayback();
    const [canvasWork, setCanvasWork] = useState<Work | null>(null);
    const { task, error, load } = useAudioTask(taskId);
    const work = task ? mergeWorks([], [task])[0] : undefined;
    return <><Drawer title="音频任务 · 全部版本" open={Boolean(taskId)} onClose={onClose} size="large">
        <div onPlayCapture={onPlay}>{error ? <Alert className="mb-4" type="warning" title={error} /> : null}{work ? <AudioWorkCard work={work} onRefresh={load} onCanvas={setCanvasWork} /> : <p>正在读取任务…</p>}</div>
    </Drawer><WorkCanvasModal work={canvasWork} onClose={() => setCanvasWork(null)} /></>;
}
