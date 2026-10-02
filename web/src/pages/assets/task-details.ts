const labels: Record<string, string> = {
    size: "尺寸", aspect_ratio: "宽高比", ratio: "宽高比", resolution: "分辨率", quality: "质量", n: "生成数量",
    seconds: "时长", duration: "时长", generate_audio: "生成音频", watermark: "水印", background: "背景",
    response_format: "返回格式", output_format: "图片格式", output_compression: "压缩率", seed: "随机种子", omni_reference_task_type: "视频任务类型",
};
const values: Record<string, Record<string, string>> = {
    quality: { max: "极致", xhigh: "超高", auto: "自动", high: "高", medium: "中", low: "低" },
    omni_reference_task_type: { auto: "自动", reference: "参考生成", edit: "编辑", extend: "延长" },
    background: { auto: "自动", transparent: "透明", opaque: "不透明" },
    size: { auto: "自动" }, aspect_ratio: { adaptive: "自适应" }, ratio: { adaptive: "自适应" },
};
const excluded = new Set(["model", "prompt", "user_prompt", "input", "content", "messages", "images", "image", "image_urls", "image_references", "reference_images", "reference_videos", "reference_audios"]);

export function taskSettings(request: Record<string, any>) {
    const items = Object.entries(request).filter(([key, value]) => !excluded.has(key) && value !== null && value !== "" && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => ({
        key, label: labels[key] || key,
        children: key === "duration" && Number(value) === -1 ? "自动" : typeof value === "boolean" ? value ? "开启" : "关闭" : `${values[key]?.[String(value)] || value}${["seconds", "duration"].includes(key) ? " 秒" : key === "n" ? " 张" : ""}`,
    }));
    const content = Array.isArray(request.content) ? request.content : [];
    const images = request.image_references || request.image_urls || request.images || (request.image ? [request.image] : undefined) || request.reference_images || content.filter((part: any) => part.type === "image_url");
    for (const [key, label, refs] of [
        ["images", "参考图片", images],
        ["videos", "参考视频", request.reference_videos || content.filter((part: any) => part.type === "video_url")],
        ["audios", "参考音频", request.reference_audios || content.filter((part: any) => part.type === "audio_url")],
    ] as const) if (refs?.length) items.push({ key, label, children: `${refs.length} 个` });
    const roles = (request.reference_images || content).map((part: any) => part.role);
    if (roles.includes("reference_image")) items.push({ key: "mode", label: "图片参考方式", children: "参考图" });
    else if (roles.includes("first_frame") || roles.includes("last_frame")) items.push({ key: "mode", label: "图片参考方式", children: roles.includes("last_frame") ? roles.includes("first_frame") ? "首尾帧" : "尾帧" : "首帧" });
    return items;
}
