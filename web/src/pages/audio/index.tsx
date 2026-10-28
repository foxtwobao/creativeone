import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Input } from "antd";
import { FolderOpen, ListTodo, Mic2, Music2, PenLine } from "lucide-react";
import { useAudioPlayback } from "@/hooks/use-audio-playback";
import { useAudioTask } from "@/hooks/use-audio-task";
import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { AudioButtonPrice, AudioPriceHint, useAudioPrice } from "@/components/audio-price-hint";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, modelAudioTypeOf, selectableModelsByCapability } from "@/stores/use-config-store";
import { cloudSession, CloudError } from "@/services/api/cloud";
import { audioSubmission, submitAudio, type AudioSubmission } from "@/services/api/audio";
import { fetchTask } from "@/services/api/tasks";
import { useAssetStore } from "@/stores/use-asset-store";
import { WorkCanvasModal } from "@/pages/assets/work-canvas-modal";
import { AudioWorkCard } from "./audio-work-card";
import { defaultSpeechInput, defaultMusicInput, type SpeechInput, type MusicInput, type AudioModelType } from "../../../../shared/audio";
import { mergeWorks, taskLabels, type Work } from "../../../../shared/works";

export default function AudioPage() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [searchParams, setSearchParams] = useSearchParams();
    const taskId = searchParams.get("task");
    const [selectedModel, setModel] = useState<string>();
    const model = selectedModel ?? config.audioModel;
    const location = useLocation();
    const [reusedType, setReusedType] = useState<AudioModelType>();
    const [speechDraft, setSpeech] = useState<SpeechInput>();
    const speech = speechDraft || { ...defaultSpeechInput, voice: config.audioVoice };
    const [music, setMusic] = useState<MusicInput>(() => structuredClone(defaultMusicInput));
    const [title, setTitle] = useState("");
    const [currentTaskId, setCurrentTaskId] = useState<string>();
    const [canvasWork, setCanvasWork] = useState<Work | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<AudioSubmission | null>(null);
    const [error, setError] = useState("");
    const submissionLocked = useRef(false);
    const onPlay = useAudioPlayback();
    const type = modelAudioTypeOf(config, model);
    const formType = reusedType || type;
    const validSelection = type && (!reusedType || type === reusedType);
    const input = formType === "gemini-tts" ? speech : music;
    const { available } = useAudioPrice(model);
    const { task: currentTask, load, loading, error: taskError } = useAudioTask(currentTaskId);
    const submitted = Boolean(currentTaskId);
    const generating = submitted && (!currentTask || ["pending", "running"].includes(currentTask.status));
    const actionLabel = busy ? "正在提交" : submitted ? taskLabels[currentTask?.status || "pending"] || "生成中" : pending ? "确认原提交" : formType === "gemini-tts" ? "生成配音" : "生成音乐";
    const assets = useAssetStore((state) => state.assets);
    const work = currentTask ? mergeWorks(assets, [currentTask]).find((work) => work.task?.id === currentTask.id) : undefined;
    const choices = selectableModelsByCapability(config, "audio");
    useEffect(() => {
        if (!taskId) return;
        let current = true;
        void fetchTask(taskId).then((task) => {
            if (!current) return;
            const saved = task.request?.audio_input;
            if (task.capability !== "audio" || !saved) throw new Error("此任务没有可复用的音频参数");
            if ("text" in saved) setSpeech(structuredClone(saved)); else setMusic(structuredClone(saved));
            setReusedType(task.request!.audio_type); setModel(`${task.channel_id}::${task.model}`); setTitle(task.title || ""); setCurrentTaskId(undefined); submissionLocked.current = false;
            setError(task.status === "unknown" ? "原任务结果可能尚未确认；再次生成是新任务，可能重复计费。" : "");
        }).catch((error) => { if (current) setError(error.message); });
        return () => { current = false; };
    }, [taskId, location.key]);
    const generate = async () => {
        if (submissionLocked.current) return;
        submissionLocked.current = true; setBusy(true); setError("");
        let submission = pending;
        try {
            if (!submission) {
                submission = { ...audioSubmission(config, model, input, title.trim()), submission_id: crypto.randomUUID() };
                setPending(submission);
            }
            const { canvasTaskId } = await submitAudio(submission, { checkExisting: Boolean(pending) });
            setPending(null); setCurrentTaskId(canvasTaskId);
            message.success("已受理，音频将在后台生成");
        } catch (error) {
            submissionLocked.current = false;
            const definitive = error instanceof CloudError && error.status < 500;
            if (definitive) setPending(null);
            setError(`${error instanceof TypeError ? "网络连接中断，提交结果尚未确认" : error instanceof Error ? error.message : "提交失败"}${submission && !definitive ? "。请点击「确认原提交」，将查询或复用原提交标识，不创建新的生成意图。" : ""}`);
        } finally { setBusy(false); }
    };
    const createSession = () => {
        submissionLocked.current = false;
        setSpeech(undefined); setMusic(structuredClone(defaultMusicInput)); setTitle(""); setError(""); setReusedType(undefined); setCurrentTaskId(undefined);
        setSearchParams({}, { replace: true });
    };
    return <div className="studio-workbench">
        <main className="mx-auto max-w-5xl px-4 py-5 sm:px-7 sm:py-6">
            <header className="flex flex-wrap items-center justify-between gap-3 pl-11 min-[701px]:pl-0">
                <h1 className="!mb-0 text-xl font-semibold">声音创作</h1>
                <div className="flex flex-wrap gap-2"><Link className="studio-chip" to="/assets?kind=audio"><FolderOpen size={14} />我的作品</Link><Link className="studio-chip" to="/assets?view=tasks&kind=audio"><ListTodo size={14} />生成任务</Link><button className="studio-chip" disabled={busy || Boolean(pending)} onClick={createSession}><PenLine size={14} />新建创作</button></div>
            </header>
            <section aria-label="音频创作" className="mt-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
                <div inert={Boolean(pending) || submitted}>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex min-w-0 flex-col gap-1.5"><h2 className="!mb-0 flex items-center gap-2 text-sm font-medium">{formType === "gemini-tts" ? <Mic2 size={15} /> : <Music2 size={15} />}创作模型</h2>
                            <ModelPicker config={config} value={model} capability="audio" fullWidth className="!h-8 !rounded-lg border border-border bg-card !px-3" onChange={(value) => { setModel(value); setReusedType(undefined); updateConfig("audioModel", value); }} />
                            {!choices.length ? <div className="text-xs text-muted-foreground">尚未配置可用音频模型。{cloudSession?.user.admin ? <Link to="/admin/channels">前往模型配置</Link> : "请联系管理员配置。"}</div> : model && !validSelection ? <p className="!mb-0 text-xs text-muted-foreground">原模型已停用、不可用或调用类型已调整，请重新选择后生成。</p> : null}
                        </div>
                        <label className="flex min-w-0 flex-col gap-1.5 text-sm"><span>作品名称 <span className="text-muted-foreground">（可选）</span></span><Input aria-label="作品名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="为这次创作取个名字" /></label>
                    </div>
                </div>
                <div aria-label="生成操作" className="sticky top-0 z-10 -mx-4 my-4 flex flex-col gap-2 border-y border-border bg-card px-4 py-3 sm:-mx-5 sm:px-5">
                    {error ? <Alert type="warning" showIcon title={error} /> : null}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 basis-56"><AudioPriceHint model={model} type={formType} showPrice={false} /></div>
                        <Button type="primary" className="!ml-auto !h-auto !min-h-10 !min-w-48 !max-w-full !px-4 !py-2 sm:!max-w-sm" loading={busy || generating} disabled={busy || submitted || (!pending && (!validSelection || !available))} onClick={() => void generate()}>
                            <span className="flex w-full min-w-0 items-center justify-between gap-6"><span className="shrink-0">{actionLabel}</span><AudioButtonPrice model={model} /></span>
                        </Button>
                    </div>
                    {submitted ? <p role="status" className="!mb-0 text-xs text-muted-foreground">本次任务已提交，继续创作请点「新建创作」。</p> : null}
                </div>
                <div inert={Boolean(pending) || submitted}>
                    {formType ? <AudioSettingsPanel type={formType} input={input} onChange={(next) => {
                        if ("text" in next) { setSpeech(next); if (next.voice !== speech.voice) updateConfig("audioVoice", next.voice); } else setMusic(next);
                    }} /> : null}
                </div>
            </section>
            {currentTaskId ? <section aria-label="本次生成结果" className="mt-6" onPlayCapture={onPlay}>
                <header className="mb-3 flex items-center justify-between"><h2 className="!mb-0 text-sm font-semibold">生成结果</h2><Button type="text" size="small" loading={loading} onClick={() => void load().catch((error) => message.error(error.message))}>刷新</Button></header>
                {taskError ? <Alert className="mb-4" type="warning" title={taskError} /> : null}
                {work ? <AudioWorkCard key={work.id} work={work} onRefresh={load} onCanvas={setCanvasWork} /> : loading ? <p role="status" className="text-sm text-muted-foreground">正在读取生成任务…</p> : null}
            </section> : null}
            <p className="studio-local-note">画布ONE · 创作数据按账号保存到云端</p>
        </main>
        <WorkCanvasModal work={canvasWork} onClose={() => setCanvasWork(null)} />
    </div>;
}
