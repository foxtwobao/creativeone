import { expect, test } from "bun:test";
import { mergeWorks, taskMedia, workSearchText } from "./works";
import { generationPrompt, generationRequestPrompt } from "../../../../shared/generation-request";
import { taskSettings } from "./task-details";
import type { Asset } from "@/stores/use-asset-store";
import type { Task } from "@/services/api/tasks";
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, model: "model", channel_id: "channel", capability: "video", path: "videos", status: "succeeded", created_at: "2026-01-01", ...patch });
const asset = (id: string, url: string): Asset => ({ id, kind: "video", title: "作品", coverUrl: "", tags: [], createdAt: "2026-01-02", updatedAt: "2026-01-02", data: { url, width: 100, height: 100, bytes: 1, mimeType: "video/mp4" } });
test("tasks and saved copies share a card; unrelated uploads remain separate", () => {
    const works = mergeWorks([asset("a", "/video"), asset("b", "/video"), asset("c", "/other")], [task("t", { result: { metadata: { url: "/video" } } })]);
    expect(works).toHaveLength(2);
    expect(works.find((work) => work.task)?.assets.map((item) => item.id)).toEqual(["a", "b"]);
    expect(works[0].source).toBe("uploaded");
});
test("explicit source survives file copies and multiple outputs remain together", () => {
    const copied = { ...asset("copied", "/copy"), metadata: { sourceUrl: "/original" } };
    const works = mergeWorks([copied, asset("unrelated", "/unrelated")], [task("image", { capability: "image", result: { data: [{ url: "/original" }, { url: "/second" }] } })]);
    expect(works).toHaveLength(2);
    expect(works.find((work) => work.task)?.assets[0].id).toBe("copied");
    expect(taskMedia(works.find((work) => work.task)!.task!)).toHaveLength(2);
});
test("pending completes with the same identity and paused tasks need attention", () => {
    const before = mergeWorks([], [task("t", { status: "pending" }), task("paused", { status: "unknown" })]);
    const after = mergeWorks([], [task("t"), task("paused", { status: "unknown" })]);
    expect(before[0].id).toBe(after[0].id);
    expect(before[0].state).toBe("processing");
    expect(after[0].state).toBe("completed");
    expect(after[1].state).toBe("attention");
});
test("media descriptors cover audio and video without fetching files", () => {
    expect(taskMedia(task("audio", { capability: "audio", result: { url: "/audio" } }))).toEqual([{ url: "/audio" }]);
    expect(taskMedia(task("video", { result: { file: { url: "/video", width: 960, height: 540 } } }))[0].width).toBe(960);
});
test("task prompts use the saved user input and search Seedance content without inventing missing history", () => {
    const request = { user_prompt: "用户输入", prompt: "系统指令\n参考图说明\n用户输入" };
    expect(generationPrompt(request)).toBe("用户输入");
    expect(generationRequestPrompt(request)).toBe(request.prompt);
    expect(generationPrompt(null)).toBe("");
    const works = mergeWorks([], [task("seedance", {request: {content: [{type: "text", text: "海边日落"}]}})]);
    expect(workSearchText(works[0])).toContain("海边日落");
    expect(generationPrompt({input: [{role: "system", content: "指令"}, {role: "user", content: [{type: "input_text", text: "用户问题"}]}]})).toBe("用户问题");
});
test("task settings retain false and zero, describe actual references and never infer resolution from a model ID", () => {
    const settings = taskSettings({model: "wan3.0-video-1080p", prompt: "用户输入", seconds: "4", aspect_ratio: "1:1", generate_audio: false, seed: 0, reference_images: [{url: "/ref", role: "first_frame"}], reference_audios: [{url: "/audio"}]});
    const values = Object.fromEntries(settings.map((item) => [item.label, item.children]));
    expect(values).toMatchObject({"时长": "4 秒", "宽高比": "1:1", "生成音频": "关闭", "随机种子": "0", "参考图片": "1 个", "参考音频": "1 个", "图片参考方式": "首帧"});
    expect(values["分辨率"]).toBeUndefined();
    expect(taskSettings({model: "banana", images: ["/a", "/b"]}).find((item) => item.key === "images")?.children).toBe("2 个");
});
