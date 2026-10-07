import { App, Modal, Select } from "antd";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCanvasStore, flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import { useCloudStore } from "@/stores/use-cloud-store";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType } from "@/types/canvas";
import { assetMedia, taskMedia, type Work, type WorkMedia } from "./works";

export function WorkCanvasModal({ work, onClose }: { work: Work | null; onClose: () => void }) {
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [target, setTarget] = useState("");
    const [saving, setSaving] = useState(false);
    const { message } = App.useApp();
    const navigate = useNavigate();
    useEffect(() => { if (work) void useCanvasStore.getState().load().catch((error) => message.error(error.message)); }, [work, message]);
    const insert = async () => {
        if (!work || !hydrated) return;
        setSaving(true);
        try {
            const title = work.asset?.title || work.assets[0]?.title || work.task!.model;
            const type = { image: CanvasNodeType.Image, video: CanvasNodeType.Video, audio: CanvasNodeType.Audio, text: CanvasNodeType.Text }[work.kind];
            const media = work.task ? taskMedia(work.task) : assetMedia(work.asset!);
            const text = work.asset?.kind === "text" ? work.asset.data.content : work.task?.result?.text;
            const entries: WorkMedia[] = work.kind === "text" ? [{ url: text || "" }] : media;
            const nodes = await Promise.all(entries.map(async (item, index) => {
                const size = item;
                const node = createCanvasNode(type, { x: 360 + index * 700, y: 300 }, { content: item.url, storageKey: "storageKey" in item ? item.storageKey : undefined, status: "success", naturalWidth: "width" in size ? size.width : undefined, naturalHeight: "height" in size ? size.height : undefined });
                return { ...node, title, ...("width" in size && "height" in size && size.width && size.height ? fitNodeSize(size.width, size.height) : {}) };
            }));
            const store = useCanvasStore.getState();
            const existing = target ? await store.refreshProject(target) : undefined;
            if (target && !existing) throw new Error("画布已不存在，请重新选择");
            const id = existing?.id || await store.createProject(title);
            const right = existing?.nodes.length ? Math.max(...existing.nodes.map((node) => node.position.x + node.width)) + 80 : 0;
            store.updateProject(id, { nodes: [...(existing?.nodes || []), ...nodes.map((node) => ({ ...node, position: { ...node.position, x: node.position.x + right } }))] });
            await flushCanvasPersistence();
            if (Object.keys(useCloudStore.getState().errors).length) throw new Error("画布尚未保存成功，请先处理同步提示");
            onClose();
            navigate(`/canvas/${id}`);
        } catch (error) { message.error(error instanceof Error ? error.message : "添加失败"); }
        finally { setSaving(false); }
    };
    return <Modal title="添加到画布" open={Boolean(work)} onCancel={onClose} onOk={() => void insert()} confirmLoading={saving} okButtonProps={{ disabled: !hydrated }} okText="添加并打开" cancelText="取消">
        <Select aria-label="选择画布" className="w-full" value={target} onChange={setTarget} options={[{ value: "", label: "新建画布" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} />
    </Modal>;
}
