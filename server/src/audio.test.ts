import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { audioSources, audioFileType } from "./audio.js";
import { audioRequestBody, defaultSpeechInput, defaultMusicInput, audioInputError } from "../../shared/audio.js";

const chat = (content: string, data?: any) => ({ choices: [{ finish_reason: "stop", message: { content } }], ...(data ? { data } : {}) });
test("speech sends only supported Chat fields and duo roles", () => {
    const input = { ...structuredClone(defaultSpeechInput), text: "请用温柔自然的语气朗读：你好。" };
    assert.deepEqual(audioRequestBody("tts", "gemini-tts", input), { model: "tts", messages: [{ role: "user", content: input.text }], stream: false, output_format: "url", audio: { format: "wav", voice: "Kore" } });
    const script = "角色一：你好。\n角色二: 欢迎。";
    const duo = audioRequestBody("tts", "gemini-tts", { ...input, mode: "duo", text: script });
    assert.equal(duo.messages[0].content, script);
    assert.deepEqual(duo.audio, { format: "wav" });
    assert.deepEqual(duo.speakers, input.speakers);
    assert.ok(audioInputError("gemini-tts", { ...input, mode: "duo", speakers: [{ name: "相同", voice: "Kore" }, { name: " 相同 ", voice: "Puck" }] }));
});
test("music branches omit incompatible parameters and retain original lyrics", () => {
    const input = { ...defaultMusicInput, description: "钢琴", lyrics: "春天" };
    const lyria = audioRequestBody("music", "lyria", input);
    assert.equal(lyria.messages[0].content, "钢琴\n\n歌词：\n春天");
    assert.equal(lyria.output_format, "url");
    const suno = audioRequestBody("music", "suno", { ...input, mode: "instrumental" });
    assert.equal(suno.instrumental, true);
    assert.equal(suno.output_format, undefined);
    assert.equal(suno.messages[0].content, "钢琴\n\n纯音乐，不要人声。");
    assert.equal(audioRequestBody("music", "suno", input).instrumental, undefined);
    assert.equal(input.lyrics, "春天");
});
test("HTML parsing decodes attributes and preserves full signed URLs", () => {
    assert.deepEqual(audioSources(chat('<audio controls src="https://media.test/a.wav?a=1&amp;b=2"></audio><audio><source src="https://media.test/a.wav?a=1&amp;b=2"></audio>'), "gemini-tts"), ["https://media.test/a.wav?a=1&b=2"]);
});
test("HTML audio keeps remote versions and ignores accompanying inline audio", () => {
    const content = '<audio src="data:audio/mpeg;base64,AAAA"></audio><audio src="https://media.test/a.mp3?a=1&amp;b=2"></audio><audio><source src=" DATA:audio/mpeg;base64,BBBB "></audio><audio src="https://media.test/b.mp3"></audio><audio src="https://media.test/a.mp3?a=1&amp;b=2"></audio>';
    for (const type of ["lyria", "gemini-tts"] as const) {
        assert.deepEqual(audioSources(chat(content), type), ["https://media.test/a.mp3?a=1&b=2", "https://media.test/b.mp3"]);
        assert.throws(() => audioSources(chat('<audio src="data:audio/mpeg;base64,AAAA"></audio>'), type));
        assert.throws(() => audioSources(chat(content + '<audio src="javascript:alert(1)"></audio>'), type));
    }
});
test("Suno uses every data item and falls back to parsed Markdown only without data", () => {
    assert.deepEqual(audioSources(chat("[重复](https://media.test/a.m4a)", [{ url: "https://media.test/a.m4a" }, { url: "https://media.test/b.m4a?q=1" }, { url: "https://media.test/a.m4a" }]), "suno"), ["https://media.test/a.m4a", "https://media.test/b.m4a?q=1"]);
    assert.deepEqual(audioSources(chat("[音频](https://media.test/a.m4a)\n[另一条](https://media.test/b.m4a)"), "suno"), ["https://media.test/a.m4a", "https://media.test/b.m4a"]);
});
test("incomplete, error, inline audio and malformed lists never succeed", () => {
    for (const response of [chat("错误：生成失败"), chat('<audio src="data:audio/wav;base64,AAAA"></audio>'), chat('<audio src="https://user:password@media.test/a.wav"></audio>'), { choices: [{ finish_reason: "length", message: { content: '<audio src="https://media.test/a.wav"></audio>' } }] }]) assert.throws(() => audioSources(response, "gemini-tts"));
    assert.throws(() => audioSources(chat("[音频](https://media.test/a.m4a)", [{ url: "https://media.test/a.m4a" }, {}]), "suno"));
});
test("actual audio bytes determine the format and duration", async () => {
    assert.deepEqual(await audioFileType(await readFile(new URL("./fixtures/audio.wav", import.meta.url))), { format: "wav", mimeType: "audio/wav", durationMs: 10 });
    await assert.rejects(audioFileType(Buffer.from("<html>not audio</html>")));
});
test("Opus audio in an ISO MP4 container is saved as M4A", async () => {
    const file = await audioFileType(await readFile(new URL("./fixtures/audio-opus.mp4", import.meta.url)));
    assert.equal(file.format, "m4a");
    assert.equal(file.mimeType, "audio/mp4");
    assert.ok(file.durationMs && file.durationMs > 0);
});
