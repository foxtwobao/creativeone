import { useId } from "react";
import { App, Button, Input, Radio, Select } from "antd";
import { Check, Mic2, Music2, UserRound, UsersRound, WandSparkles } from "lucide-react";
import { audioVoices, type AudioInput, type AudioModelType } from "../../../shared/audio";

// 风格译自 https://ai.google.dev/gemini-api/docs/speech-generation#voice-options，音色 ID 沿用接入清单。
const voiceDescriptions: Record<string, string> = {
    Zephyr: "明亮", Puck: "活泼", Charon: "讲解型", Kore: "坚定", Fenrir: "激昂", Leda: "年轻", Orus: "坚定", Aoede: "轻快",
    Callirrhoe: "随和", Autonoe: "明亮", Enceladus: "气声", Iapetus: "清晰", Umbriel: "随和", Algieba: "顺滑", Despina: "顺滑",
    Erinome: "清晰", Algenib: "沙哑", Rasalgethi: "讲解型", Laomedeia: "活泼", Achernar: "柔和", Alnilam: "坚定", Schedar: "平稳",
    Gacrux: "成熟", Pulcherrima: "直率", Achird: "友善", Zubenelgenubi: "随性", Vindemiatrix: "温柔",
};
const voiceOptions = audioVoices.map((voice) => ({ value: voice, label: `${voice} · ${voiceDescriptions[voice]}` }));
const modeClassName = "[&_.ant-radio-button-wrapper]:!h-auto [&_.ant-radio-button-wrapper]:!px-3 [&_.ant-radio-button-wrapper]:!py-2 [&_.ant-radio-button-wrapper]:!leading-5";

export function AudioSettingsPanel({ input, onChange, type, showBody = true }: { input: AudioInput; onChange: (input: AudioInput) => void; type: AudioModelType; showBody?: boolean }) {
    const { modal } = App.useApp();
    const speechTextId = useId();
    const speechExample = "text" in input && input.mode === "duo" ? `${input.speakers[0]?.name || "角色一"}: 你好，今天有什么计划？\n${input.speakers[1]?.name || "角色二"}: 我准备录制一段自然的双人对话。` : "请用温柔自然的语气朗读：在每一个平凡的日子里，总有值得被记住的声音。";
    const fillSpeechExample = () => {
        if (!("text" in input)) return;
        const fill = () => onChange({ ...input, text: speechExample });
        if (input.text.trim() && input.text !== speechExample) modal.confirm({ title: "替换为配音示例？", content: "将替换当前文案，保留已选音色和角色配置。", okText: "替换文案", cancelText: "取消", onOk: fill });
        else fill();
    };
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
            {showBody ? <div className="flex min-w-0 flex-col gap-1.5 @xl:col-span-2"><div className="flex items-center justify-between gap-2"><label htmlFor={speechTextId}>{input.mode === "duo" ? "对话剧本" : "配音文案"}</label><Button type="text" size="small" icon={<WandSparkles size={14} />} onClick={fillSpeechExample}>灵感示例</Button></div><Input.TextArea id={speechTextId} aria-label="配音文案或剧本" autoSize={{ minRows: 5 }} placeholder={speechExample} value={input.text} onChange={(event) => onChange({ ...input, text: event.target.value })} /></div> : null}
            <p className="!mb-0 text-xs leading-5 text-muted-foreground @xl:col-span-2">{showBody ? "语气、情绪和停顿要求可直接写进文案，例如「请用温柔自然的语气朗读：……」。" : "请在画布的配音文案中填写完整朗读要求，例如「请用温柔自然的语气朗读：……」。"}实际效果以试听为准。</p>
        </> : "description" in input ? <>
            <Radio.Group block aria-label="音乐模式" optionType="button" buttonStyle="solid" value={input.mode} onChange={(event) => onChange({ ...input, mode: event.target.value })} className={`@xl:col-span-2 ${modeClassName}`} options={[
                { value: "song", label: <span className="flex items-center gap-2"><Mic2 size={16} /><span className="text-left"><span className="block">歌曲</span><span className="block text-xs opacity-75">含人声</span></span><Check size={15} className={`ml-auto ${input.mode === "song" ? "" : "invisible"}`} /></span> },
                { value: "instrumental", label: <span className="flex items-center gap-2"><Music2 size={16} /><span className="text-left"><span className="block">纯音乐</span><span className="block text-xs opacity-75">无人声</span></span><Check size={15} className={`ml-auto ${input.mode === "instrumental" ? "" : "invisible"}`} /></span> },
            ]} />
            {showBody ? <label className={`flex min-w-0 flex-col gap-1.5 ${input.mode === "instrumental" ? "@xl:col-span-2" : ""}`}><span>音乐描述</span><Input.TextArea aria-label="音乐描述" autoSize={{ minRows: 4 }} placeholder="描述曲风、乐器、情绪与用途，让灵感成为旋律…" value={input.description} onChange={(event) => onChange({ ...input, description: event.target.value })} /></label> : null}
            {input.mode === "song" ? <label className={`flex min-w-0 flex-col gap-1.5 ${!showBody ? "@xl:col-span-2" : ""}`}><span>歌词 <span className="text-muted-foreground">（可选）</span></span><Input.TextArea aria-label="歌词" autoSize={{ minRows: 4 }} placeholder="可使用 [Verse]、[Chorus] 分段，不保证逐字演唱" value={input.lyrics} onChange={(event) => onChange({ ...input, lyrics: event.target.value })} /></label> : <p className="!mb-0 text-xs text-muted-foreground @xl:col-span-2">请求不含人声；保留的歌词不会随纯音乐请求发送。</p>}
        </> : null}
    </div></div>;
}
