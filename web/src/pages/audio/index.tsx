import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Input, Modal } from "antd";
import { BookOpen, Check, CircleAlert, Headphones, History, LoaderCircle, Mic2, Music2, PenLine, RefreshCw, RotateCcw, Send } from "lucide-react";
import { useAudioPlayback } from "@/hooks/use-audio-playback";
import { useAudioTask } from "@/hooks/use-audio-task";
import { AudioExampleButton, AudioPromptEditor, AudioSettingsPanel } from "@/components/audio-settings-panel";
import { AudioButtonPrice, AudioPriceHint, useAudioPrice } from "@/components/audio-price-hint";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, modelAudioTypeOf, selectableModelsByCapability } from "@/stores/use-config-store";
import { cloudSession, CloudError } from "@/services/api/cloud";
import { audioSubmission, submitAudio, type AudioSubmission } from "@/services/api/audio";
import { fetchTask } from "@/services/api/tasks";
import { useAssetStore } from "@/stores/use-asset-store";
import { WorkCanvasModal } from "@/pages/assets/work-canvas-modal";
import { AudioWorkCard } from "./audio-work-card";
import { AudioHistoryDrawer } from "./audio-history-drawer";
import { defaultSpeechInput, defaultMusicInput, type AudioInput, type SpeechInput, type MusicInput, type AudioModelType } from "../../../../shared/audio";
import { mergeWorks, taskLabels, type Work } from "../../../../shared/works";
import styles from "./audio-workbench.module.css";
import workbenchStyles from "@/layouts/creation-workbench.module.css";

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
    const [historyOpen, setHistoryOpen] = useState(false);
    const [guideOpen, setGuideOpen] = useState(false);
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
    const changeInput = (next: AudioInput) => {
        if ("text" in next) { setSpeech(next); if (next.voice !== speech.voice) updateConfig("audioVoice", next.voice); } else setMusic(next);
    };
    return <div className="studio-workbench" onPlayCapture={onPlay}>
        <main className={`studio-stage ${styles.page} ${submitted ? workbenchStyles.workbench : ""}`}>
            <div className="studio-page-tools"><span>声音创作工作台</span><button className="studio-chip" disabled={busy || Boolean(pending)} onClick={createSession}><PenLine size={14} />新建创作</button></div>
            <section aria-label="音频创作" className="studio-compose-area">
                <h1>{submitted ? "声音创作" : <><span>让灵感发声，</span>故事有了回响</>}</h1>
                <div className="studio-compose-tools">
                    <button className="studio-chip" onClick={() => setHistoryOpen(true)}><History size={14} />历史记录</button>
                    <button className="studio-chip" onClick={() => setGuideOpen(true)}><BookOpen size={14} />写作参考</button>
                </div>
                {error ? <Alert className="mb-3" type="warning" showIcon title={error} /> : null}
                <div className="studio-composer">
                    <div className={`studio-input-row ${styles.inputRow}`}>
                        <div className={styles.editor} inert={Boolean(pending) || submitted}>
                            {formType ? <AudioPromptEditor input={input} onChange={changeInput} compact /> : <p className="text-sm text-muted-foreground">请选择音频模型，开始声音创作。</p>}
                        </div>
                        <button type="button" className={`studio-send ${styles.send}`} aria-label={actionLabel} title={actionLabel} aria-busy={busy || generating} disabled={busy || submitted || (!pending && (!validSelection || !available))} onClick={() => void generate()}>
                            {busy || generating ? <LoaderCircle className="animate-spin" size={18} /> : pending ? <RotateCcw size={18} /> : submitted ? currentTask?.status === "succeeded" ? <Check size={18} /> : <CircleAlert size={18} /> : <Send size={18} />}
                        </button>
                    </div>
                    <div className={styles.modelRow} inert={Boolean(pending) || submitted}>
                        <ModelPicker config={config} value={model} capability="audio" className="max-w-[min(70vw,320px)]" onChange={(value) => { setModel(value); setReusedType(undefined); updateConfig("audioModel", value); }} />
                    </div>
                </div>
                <div className={submitted ? styles.settings : workbenchStyles.quickParameters} inert={Boolean(pending) || submitted}>
                    {!choices.length ? <p className="!mb-3 text-xs text-muted-foreground">尚未配置可用音频模型。{cloudSession?.user.admin ? <Link to="/admin/channels">前往模型配置</Link> : "请联系管理员配置。"}</p> : model && !validSelection ? <p className="!mb-3 text-xs text-muted-foreground">原模型已停用、不可用或调用类型已调整，请重新选择后生成。</p> : null}
                    {submitted && formType ? <h2 className={styles.sectionTitle}>{formType === "gemini-tts" ? <Mic2 size={14} /> : <Music2 size={14} />}{formType === "gemini-tts" ? "配音参数" : "音乐参数"}</h2> : null}
                    <div className={!submitted ? styles.compactSettings : undefined}>
                        {formType ? <AudioSettingsPanel type={formType} input={input} showBody={false} compact={!submitted} onChange={changeInput} /> : null}
                        <label className={styles.nameField}><span>名称</span><Input size="small" variant="borderless" aria-label="作品名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="作品名称（可选）" /></label>
                    </div>
                </div>
                <div className={styles.caption}><div className={styles.price}><span>单价</span><AudioButtonPrice model={model} /></div><span>点击生成 · Enter 换行</span></div>
                {submitted || (pending && !busy) ? <p role="status" className="!mb-0 mt-2 text-xs text-muted-foreground">{submitted ? `${actionLabel}，继续创作请点「新建创作」。` : "提交结果待确认，请点击发送图标确认原提交。"}</p> : null}
                <details className={styles.billing}><summary>计费与输出说明</summary><AudioPriceHint model={model} type={formType} showPrice={false} /></details>
            </section>
            {currentTaskId ? <section aria-label="本次生成结果" className={workbenchStyles.output}>
                <header className="mb-3 flex items-center justify-between"><h2 className={styles.sectionTitle}><Headphones size={16} />本次生成</h2><Button type="text" size="small" icon={<RefreshCw size={13} />} loading={loading} onClick={() => void load().catch((error) => message.error(error.message))}>刷新</Button></header>
                {taskError ? <Alert className="mb-4" type="warning" title={taskError} /> : null}
                {work ? <AudioWorkCard key={work.id} work={work} onRefresh={load} onCanvas={setCanvasWork} /> : loading ? <p role="status" className="text-sm text-muted-foreground">正在读取生成任务…</p> : null}
            </section> : null}
            <p className="studio-local-note">画布ONE · 创作数据按账号保存到云端</p>
        </main>
        {historyOpen ? <AudioHistoryDrawer canEdit={!busy && !pending} onClose={() => setHistoryOpen(false)} onEdit={(id) => { setSearchParams({ task: id }); setHistoryOpen(false); }} /> : null}
        <Modal title={formType === "gemini-tts" ? "配音写作参考" : "音乐写作参考"} open={guideOpen} onCancel={() => setGuideOpen(false)} footer={null}>
            <div className="space-y-3 text-sm leading-6">
                {formType === "gemini-tts" ? <>
                    <p>在同一个输入框中填写完整文案或对话剧本，也可写入语气、情绪和停顿要求。</p>
                    <p>双人配音时，以已配置的角色名和冒号区分台词，剧本标记须与角色名一致。可先在参数栏修改角色名及音色，再填入示例。</p>
                    <p className="text-muted-foreground">朗读指令与角色标记的实际处理由模型决定，请试听生成结果。</p>
                    <AudioExampleButton className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-xs hover:bg-muted disabled:opacity-40" input={speech} disabled={busy || Boolean(pending) || submitted} onChange={(next) => { changeInput(next); setGuideOpen(false); }} />
                </> : <>
                    <p>在同一个输入框中描述曲风、乐器、情绪与节奏；歌曲模式可以直接写入歌词，纯音乐模式用于无人声作品。</p>
                    <p>例如：温暖轻快的民谣，以木吉他和钢琴为主，节奏舒缓，表达出发时的期待。人声自然，副歌逐渐明亮。</p>
                    <p>需要歌词时，可在描述后另起一行写出段落和歌词，例如：[主歌] 清晨的风吹过窗台…… [副歌] 带着微光向前走……</p>
                    <p className="text-muted-foreground">完整描述会一起提交，歌词结构与演唱效果以模型实际生成为准。</p>
                </>}
            </div>
        </Modal>
        <WorkCanvasModal work={canvasWork} onClose={() => setCanvasWork(null)} />
    </div>;
}
