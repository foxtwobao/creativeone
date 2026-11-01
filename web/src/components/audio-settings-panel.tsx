import { useId } from "react";
import { App, Input, Radio, Select } from "antd";
import { Check, Mic2, Music2, UserRound, UsersRound, WandSparkles } from "lucide-react";
import { audioVoices, type AudioInput, type AudioModelType, type SpeechInput } from "../../../shared/audio";
import workbenchStyles from "@/layouts/creation-workbench.module.css";
import styles from "./audio-settings-panel.module.css";

// 风格译自 https://ai.google.dev/gemini-api/docs/speech-generation#voice-options，音色 ID 沿用接入清单。
const voiceDescriptions: Record<string, string> = {
    Zephyr: "明亮", Puck: "活泼", Charon: "讲解型", Kore: "坚定", Fenrir: "激昂", Leda: "年轻", Orus: "坚定", Aoede: "轻快",
    Callirrhoe: "随和", Autonoe: "明亮", Enceladus: "气声", Iapetus: "清晰", Umbriel: "随和", Algieba: "顺滑", Despina: "顺滑",
    Erinome: "清晰", Algenib: "沙哑", Rasalgethi: "讲解型", Laomedeia: "活泼", Achernar: "柔和", Alnilam: "坚定", Schedar: "平稳",
    Gacrux: "成熟", Pulcherrima: "直率", Achird: "友善", Zubenelgenubi: "随性", Vindemiatrix: "温柔",
};
const voiceOptions = audioVoices.map((voice) => ({ value: voice, label: `${voice} · ${voiceDescriptions[voice]}` }));
const modeClassName = "[&_.ant-radio-button-wrapper]:!h-auto [&_.ant-radio-button-wrapper]:!px-3 [&_.ant-radio-button-wrapper]:!py-2 [&_.ant-radio-button-wrapper]:!leading-5";

const speechExampleFor = (input: SpeechInput) => input.mode === "duo" ? `${input.speakers[0]?.name || "角色一"}: 你好，今天有什么计划？\n${input.speakers[1]?.name || "角色二"}: 我准备录制一段自然的双人对话。` : "请用温柔自然的语气朗读：在每一个平凡的日子里，总有值得被记住的声音。";

export function AudioExampleButton({ input, onChange, disabled = false, className = "inline-flex items-center gap-1.5 text-xs" }: { input: SpeechInput; onChange: (input: SpeechInput) => void; disabled?: boolean; className?: string }) {
    const { modal } = App.useApp();
    const fillSpeechExample = () => {
        const speechExample = speechExampleFor(input);
        const fill = () => onChange({ ...input, text: speechExample });
        if (input.text.trim() && input.text !== speechExample) modal.confirm({ title: "替换为配音示例？", content: "将替换当前文案，保留已选音色和角色配置。", okText: "替换文案", cancelText: "取消", onOk: fill });
        else fill();
    };
    return <button type="button" className={className} disabled={disabled} onClick={fillSpeechExample}><WandSparkles size={14} />灵感示例</button>;
}

export function AudioPromptEditor({ input, onChange, compact = false }: { input: AudioInput; onChange: (input: AudioInput) => void; compact?: boolean }) {
    const speechTextId = useId();
    return <div className="flex min-w-0 flex-col gap-1.5">
        {!compact ? <div className="flex items-center justify-between gap-2"><label htmlFor={speechTextId}>{"text" in input ? input.mode === "duo" ? "对话剧本" : "配音文案" : "音乐描述"}</label>{"text" in input ? <AudioExampleButton input={input} onChange={onChange} /> : null}</div> : null}
        <Input.TextArea id={speechTextId} aria-label={"text" in input ? "配音文案或剧本" : "音乐描述"} variant={compact ? "borderless" : "outlined"} autoSize={{ minRows: compact ? 1 : "text" in input ? 5 : 4 }} placeholder={"text" in input ? compact ? "填写配音文案或对话剧本，也可写入语气、情绪和停顿要求…" : speechExampleFor(input) : "描述曲风、乐器、情绪，也可以写入歌词…"} value={"text" in input ? input.text : input.description} onChange={(event) => onChange("text" in input ? { ...input, text: event.target.value } : { ...input, description: event.target.value })} />
    </div>;
}

export function AudioSettingsPanel({ input, onChange, type, showBody = true, compact = false }: { input: AudioInput; onChange: (input: AudioInput) => void; type: AudioModelType; showBody?: boolean; compact?: boolean }) {
    if (compact) return <div>
        <div className={workbenchStyles.quickFields}>
            {type === "gemini-tts" && "text" in input ? <>
                <div className="flex items-center gap-2"><span className="text-[11px] text-muted-foreground">模式</span><div role="group" aria-label="配音模式" className={styles.modeOptions}>
                    {([{ value: "single", label: "单人配音" }, { value: "duo", label: "双人配音" }] as const).map((option) => <button key={option.value} type="button" aria-pressed={input.mode === option.value} className={styles.modeOption} onClick={() => onChange({ ...input, mode: option.value })}><span>{option.label}</span><Check size={12} className={input.mode === option.value ? "" : "invisible"} /></button>)}
                </div></div>
                {input.mode === "single" ? <label><span>音色</span><Select aria-label="预置音色" variant="borderless" showSearch={{ optionFilterProp: "label" }} value={input.voice} options={voiceOptions} onChange={(voice) => onChange({ ...input, voice })} /></label> : null}
            </> : "description" in input ? <div className="flex items-center gap-2"><span className="text-[11px] text-muted-foreground">模式</span><div role="group" aria-label="音乐模式" className={styles.modeOptions}>
                {([{ value: "song", label: "歌曲", note: "含人声" }, { value: "instrumental", label: "纯音乐", note: "无人声" }] as const).map((option) => <button key={option.value} type="button" aria-pressed={input.mode === option.value} className={styles.modeOption} onClick={() => onChange({ ...input, mode: option.value })}><span>{option.label}</span><span className={styles.modeNote}>{option.note}</span><Check size={12} className={input.mode === option.value ? "" : "invisible"} /></button>)}
            </div></div> : null}
        </div>
        {"text" in input && input.mode === "duo" ? <div className="mt-3 space-y-2">
            {input.speakers.map((speaker, index) => <div key={index} className={workbenchStyles.quickFields}>
                <label><span>角色 {index + 1}</span><Input size="small" variant="borderless" className="!w-24" aria-label={`角色 ${index + 1} 名称`} value={speaker.name} onChange={(event) => onChange({ ...input, speakers: input.speakers.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></label>
                <label><span>音色</span><Select aria-label={`角色 ${index + 1} 音色`} variant="borderless" showSearch={{ optionFilterProp: "label" }} value={speaker.voice} options={voiceOptions} onChange={(voice) => onChange({ ...input, speakers: input.speakers.map((item, i) => i === index ? { ...item, voice } : item) })} /></label>
            </div>)}
            <p className="!mb-0 text-xs text-muted-foreground">剧本以角色名和冒号区分台词，标记须与角色名一致。</p>
        </div> : null}
    </div>;
    return <div className="@container"><div className="grid gap-3 text-sm @xl:grid-cols-2">
        {type === "gemini-tts" && "text" in input ? <>
            <div className="flex min-w-0 flex-col gap-1.5 self-start"><span>配音模式</span><Radio.Group block aria-label="配音模式" optionType="button" buttonStyle="solid" value={input.mode} onChange={(event) => onChange({ ...input, mode: event.target.value })} className={modeClassName} options={[
                { value: "single", label: <span className="flex items-center gap-2"><UserRound size={16} /><span>单人配音</span><Check size={15} className={`ml-auto ${input.mode === "single" ? "" : "invisible"}`} /></span> },
                { value: "duo", label: <span className="flex items-center gap-2"><UsersRound size={16} /><span>双人配音</span><Check size={15} className={`ml-auto ${input.mode === "duo" ? "" : "invisible"}`} /></span> },
            ]} /></div>
            {input.mode === "single" ? <label className="flex min-w-0 flex-col gap-1.5"><span className="flex items-center justify-between"><span>预置音色</span><span className="text-xs text-muted-foreground">{voiceOptions.length} 种音色</span></span><Select className="w-full" aria-label="预置音色" showSearch={{ optionFilterProp: "label" }} value={input.voice} options={voiceOptions} onChange={(voice) => onChange({ ...input, voice })} /></label> : <>
                <p className="!mb-0 self-end text-xs leading-5 text-muted-foreground">剧本每句以角色名和冒号标记，例如「{input.speakers[0]?.name || "角色一"}：你好」。标记须与上方角色名一致。</p>
                <div className="grid gap-3 @xl:col-span-2 @xl:grid-cols-2">{input.speakers.map((speaker, index) => <div key={index} className="grid grid-cols-2 gap-3">
                    <label className="flex min-w-0 flex-col gap-1.5"><span>角色 {index + 1}</span><Input aria-label={`角色 ${index + 1} 名称`} value={speaker.name} onChange={(event) => onChange({ ...input, speakers: input.speakers.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></label>
                    <label className="flex min-w-0 flex-col gap-1.5"><span>音色</span><Select className="w-full" aria-label={`角色 ${index + 1} 音色`} showSearch={{ optionFilterProp: "label" }} value={speaker.voice} options={voiceOptions} onChange={(voice) => onChange({ ...input, speakers: input.speakers.map((item, i) => i === index ? { ...item, voice } : item) })} /></label>
                </div>)}</div>
            </>}
            <p className="!mb-0 text-xs text-muted-foreground @xl:col-span-2">中文说明为音色风格参考，实际效果以试听为准。</p>
            {showBody ? <div className="@xl:col-span-2"><AudioPromptEditor input={input} onChange={onChange} /></div> : null}
            <p className="!mb-0 text-xs leading-5 text-muted-foreground @xl:col-span-2">语气、情绪和停顿要求可直接写进文案，例如「请用温柔自然的语气朗读：……」。实际效果以试听为准。</p>
        </> : "description" in input ? <>
            <Radio.Group block aria-label="音乐模式" optionType="button" buttonStyle="solid" value={input.mode} onChange={(event) => onChange({ ...input, mode: event.target.value })} className={`@xl:col-span-2 ${modeClassName}`} options={[
                { value: "song", label: <span className="flex items-center gap-2"><Mic2 size={16} /><span className="text-left"><span className="block">歌曲</span><span className="block text-xs opacity-75">含人声</span></span><Check size={15} className={`ml-auto ${input.mode === "song" ? "" : "invisible"}`} /></span> },
                { value: "instrumental", label: <span className="flex items-center gap-2"><Music2 size={16} /><span className="text-left"><span className="block">纯音乐</span><span className="block text-xs opacity-75">无人声</span></span><Check size={15} className={`ml-auto ${input.mode === "instrumental" ? "" : "invisible"}`} /></span> },
            ]} />
            {showBody ? <div className="@xl:col-span-2"><AudioPromptEditor input={input} onChange={onChange} /></div> : null}
        </> : null}
    </div></div>;
}
