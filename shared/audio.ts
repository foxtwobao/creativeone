export const audioModelTypes = ["gemini-tts", "lyria", "suno"] as const;
export type AudioModelType = (typeof audioModelTypes)[number];
export const audioModelTypeLabels: Record<AudioModelType, string> = { "gemini-tts": "Gemini TTS", lyria: "Lyria", suno: "Suno" };
export const audioVoices = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix"];
export type SpeechInput = { mode: "single" | "duo"; text: string; voice: string; speakers: { name: string; voice: string }[] };
export type MusicInput = { mode: "song" | "instrumental"; description: string; lyrics: string };
export type AudioInput = SpeechInput | MusicInput;
export const defaultSpeechInput: SpeechInput = { mode: "single", text: "", voice: "Kore", speakers: [{ name: "角色一", voice: "Puck" }, { name: "角色二", voice: "Kore" }] };
export const defaultMusicInput: MusicInput = { mode: "song", description: "", lyrics: "" };
export function defaultAudioInput(type?: AudioModelType): AudioInput {
    return structuredClone(type === "gemini-tts" ? defaultSpeechInput : defaultMusicInput);
}
export function audioInputError(type: AudioModelType, input: AudioInput, textContext = ""): string | undefined {
    if (type === "gemini-tts") {
        if (!["single", "duo"].includes(input?.mode) || !("text" in input)) return "请选择单人或双人配音。";
        if (!input.text?.trim() && !textContext.trim()) return "请输入配音文案或剧本。";
        if (input.mode === "single" && !audioVoices.includes(input.voice)) return "请选择预置音色。";
        if (input.mode === "duo") {
            if (input.speakers?.length !== 2 || input.speakers.some((speaker) => !speaker.name?.trim() || !audioVoices.includes(speaker.voice))) return "请填写两个角色名并选择各自音色。";
            if (input.speakers[0].name.trim() === input.speakers[1].name.trim()) return "两个角色名不能相同。";
        }
    } else {
        if (!["song", "instrumental"].includes(input?.mode) || !("description" in input)) return "请选择歌曲或纯音乐。";
        if (!input.description?.trim() && !textContext.trim()) return "请输入音乐描述。";
    }
}
export function audioPrompt(input: AudioInput) {
    return "text" in input ? input.text : input.description;
}
// Build an allowlisted upstream body from immutable business inputs; never forward the snapshot itself.
export function audioRequestBody(model: string, type: AudioModelType, input: AudioInput, textContext = "") {
    const error = audioInputError(type, input, textContext);
    if (error) throw new Error(error);
    const content = "text" in input ? [input.text.trim(), textContext].filter(Boolean).join("\n\n")
        : [input.description.trim(), textContext, input.mode === "instrumental" ? "纯音乐，不要人声。" : "", input.mode === "song" && input.lyrics.trim() ? `歌词：\n${input.lyrics.trim()}` : ""].filter(Boolean).join("\n\n");
    return { model, messages: [{ role: "user", content }], stream: false,
        ...(type !== "suno" ? { output_format: "url" } : input.mode === "instrumental" ? { instrumental: true } : {}),
        ...(type === "gemini-tts" && "text" in input ? { audio: { format: "wav", ...(input.mode === "single" ? { voice: input.voice } : {}) }, ...(input.mode === "duo" ? { speakers: input.speakers.map(({ name, voice }) => ({ name: name.trim(), voice })) } : {}) } : {}),
    };
}
export function audioRequestSnapshot(model: string, type: AudioModelType, input: AudioInput, textContext = "") {
    return { ...audioRequestBody(model, type, input, textContext), ...(textContext ? { audio_context: textContext } : {}), audio_type: type, audio_input: structuredClone(input) };
}
export type AudioFile = { url: string; storageKey: string; bytes: number; mimeType: string; durationMs?: number; width: number; height: number; format: string };
export type AudioResult = { audios: { file?: AudioFile; error?: string }[]; defaultIndex?: number };
