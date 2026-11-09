import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Drawer, Input, Select } from "antd";
import { Bot, Download, FileUp, FolderOpen, LayoutGrid, LoaderCircle, PenLine, Plus, Send, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { cloudApi } from "@/services/api/cloud";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useServerAgentStore } from "@/stores/canvas/use-server-agent-store";
import CanvasServerAgentAttachments from "@/components/canvas/canvas-server-agent-attachments";
import type { AgentAttachment } from "@/services/api/server-agent";
import { useInterfaceStore } from "@/stores/use-interface-store";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const config = useServerAgentStore((state) => state.config);
    const libraryView = useInterfaceStore((state) => state.canvasEntry === "library");
    const setCanvasEntry = useInterfaceStore((state) => state.setCanvasEntry);
    const [prompt, setPrompt] = useState("");
    const [selectedModel, setSelectedModel] = useState("");
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const [uploading, setUploading] = useState(false);
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false);
    const model = config?.models.includes(selectedModel) ? selectedModel : config?.models[0] || "";
    const libraryOpen = searchParams.get("library") === "1";
    const setLibraryOpen = (open: boolean) => setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if (open) next.set("library", "1"); else next.delete("library");
        return next;
    }, { replace: true });
    const switchEntry = () => {
        setCanvasEntry(libraryView ? "assistant" : "library");
        setLibraryOpen(false);
    };

    const enterProject = (id: string) => navigate(`/canvas/${id}`);
    const createAndEnter = async (withGoal = false) => {
        if (creatingRef.current || uploading || !hydrated || withGoal && !prompt.trim()) return;
        creatingRef.current = true; setCreating(true);
        try {
            const goal = prompt.trim();
            if (withGoal) {
                const available = await useServerAgentStore.getState().loadConfig();
                if (!available.enabled || !available.models.includes(model)) throw new Error("全能助手或所选推理模型当前不可用，请重新选择");
                if (available.inputCharacters && goal.length + attachments.reduce((sum, file) => sum + file.title.length + (file.kind === "text" ? file.text.length : 0), 0) > available.inputCharacters) throw new Error(`目标与附件正文合计最多 ${available.inputCharacters.toLocaleString("zh-CN")} 字符，请缩小内容，不会自动截断。`);
            }
            const projectId = await createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
            if (withGoal) useServerAgentStore.setState({ open: true, entryGoal: { projectId, goal, model, attachments: [...attachments] } });
            enterProject(projectId);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布创建失败");
        } finally {
            creatingRef.current = false; setCreating(false);
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("归档缺少画布清单");
            const data = await cloudApi<CanvasExportFile>("/projects/archive/validate", { method: "POST", body: await projectFile.text() });
            for (const project of data.projects) for (const item of project.files) {
                const blob = zip.get(item.path);
                if (!blob || blob.size !== item.bytes) throw new Error("导入素材缺失或已损坏");
            }
            const uploaded = new Map<string, { storageKey: string; url: string }>();
            for (const project of data.projects) {
                for (const item of project.files) {
                    if (uploaded.has(item.storageKey)) continue;
                    const blob = zip.get(item.path)!;
                    const form = new FormData();
                    form.set("file", blob.slice(0, blob.size, item.mimeType), "canvas-media");
                    uploaded.set(item.storageKey, await cloudApi("/files/canvas-import", { method: "POST", body: form }));
                }
            }
            const replace = (value: unknown): unknown => {
                if (typeof value === "string") {
                    if (uploaded.has(value)) return uploaded.get(value)!.storageKey;
                    const match = /^\/api\/files\/(?:image_files|media_files)\/([^/?#]+)$/.exec(value);
                    if (match) return uploaded.get(decodeURIComponent(match[1]))?.url || value;
                    return value;
                }
                if (Array.isArray(value)) return value.map(replace);
                if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
                return value;
            };
            for (const item of data.projects) await importProject(replace(item.project) as CanvasExportFile["projects"][number]["project"]);
            message.success(t("canvas.imported", { count: data.projects.length }));
            if (!libraryView) setLibraryOpen(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        const load = () => { if (!document.hidden) void useCanvasStore.getState().load().catch((error) => message.error(error.message)); };
        load(); window.addEventListener("focus", load);
        return () => window.removeEventListener("focus", load);
    }, [message]);

    const libraryActions = (
        <div className="flex flex-wrap items-center gap-2">
            {selectedIds.length ? (
                <>
                    <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                        {t("canvas.exportSelected")}
                    </Button>
                    <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                        {t("canvas.deleteSelected")}
                    </Button>
                </>
            ) : null}
            {projects.length ? (
                <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                    {t("canvas.deleteAll")}
                </Button>
            ) : null}
            <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                {t("canvas.import")}
            </Button>
            <Button disabled={!hydrated || creating || uploading} icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                {t("canvas.create")}
            </Button>
        </div>
    );
    const libraryContent = (
        !hydrated ? (
            <section className="flex min-h-[360px] items-center justify-center text-sm" style={{ color: theme.node.muted }}>{t("canvas.loading")}</section>
        ) : projects.length ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {projects.map((project) => (
                    <CanvasProjectCard key={project.id} project={project} />
                ))}
            </div>
        ) : (
            <section className="flex min-h-[360px] flex-col items-center justify-center text-center">
                <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                <p className="mt-3 text-sm" style={{ color: theme.node.muted }}>{t("canvas.emptyDescription")}</p>
                <Button disabled={creating || uploading} className="mt-6" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                    {t("canvas.create")}
                </Button>
            </section>
        )
    );

    return (
        <main className="studio-workbench">
            {libraryView ? <div className="min-h-full" style={{ background: theme.canvas.background, color: theme.node.text }}>
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                    <header className="flex flex-wrap items-end justify-between gap-4 max-[700px]:pl-10">
                        <div>
                            <p className="text-xs" style={{ color: theme.node.muted }}>{t("canvas.library")}</p>
                            <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                        </div>
                        <button type="button" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10" onClick={switchEntry}><Sparkles size={16} />切换到创作</button>
                    </header>
                    {libraryActions}
                    {libraryContent}
                </div>
            </div> : <div className="studio-stage">
                <div className="studio-page-tools flex-wrap gap-3">
                    <span>{t("canvas.title")}</span>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <button type="button" className="studio-chip" disabled={creating} onClick={switchEntry}><LayoutGrid size={14} />切换到画布</button>
                        <button type="button" className="studio-chip" disabled={!hydrated || creating || uploading} onClick={() => void createAndEnter()}><PenLine size={14} />空白画布</button>
                    </div>
                </div>
                <section className="studio-compose-area">
                    <h1><span>从一个想法，</span>到无限可能</h1>
                    <div className="studio-compose-tools">
                        <button type="button" className="studio-chip" onClick={() => setLibraryOpen(true)}><FolderOpen size={14} />画布库</button>
                        <button type="button" className="studio-chip" disabled={!hydrated || creating} onClick={() => inputRef.current?.click()}><FileUp size={14} />导入画布</button>
                    </div>
                    <div className="studio-composer">
                        <div className="flex items-start gap-2 px-2 pt-1">
                            <Input.TextArea aria-label="画布创作需求" variant="borderless" autoSize={{ minRows: 2, maxRows: 8 }} value={prompt} disabled={creating} placeholder="一句话，生成图片、视频或音乐；也可以在画布上编写复杂剧本、拆解分镜，让灵感成为完整作品…" onChange={(event) => setPrompt(event.target.value)} />
                            <button type="button" className="studio-send mt-1" aria-label="开始画布创作" title="新建画布并交给助手处理" disabled={!hydrated || !config?.enabled || !model || !prompt.trim() || creating || uploading} onClick={() => void createAndEnter(true)}>{creating ? <LoaderCircle size={18} className="animate-spin" /> : <Send size={18} />}</button>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-1 pt-2">
                            <CanvasServerAgentAttachments value={attachments} onChange={setAttachments} disabled={creating} inputCharacters={config?.inputCharacters} onBusyChange={setUploading} />
                            <Bot size={16} className="ml-1 shrink-0 text-muted-foreground" />
                            <Select aria-label="助手推理模型" variant="borderless" className="w-auto min-w-0 max-w-[min(60vw,320px)] flex-none" placeholder="选择推理模型" value={model || undefined} options={config?.models.map((value) => ({ label: value, value }))} onChange={setSelectedModel} disabled={creating || !config?.enabled} />
                        </div>
                    </div>
                    <div className="studio-composer-caption"><span>助手协同创作 · 生成媒体前逐批确认</span><span>点击发送 · Enter 换行</span></div>
                    {!config?.enabled || !model ? <p className="mt-4 text-center text-xs text-muted-foreground">{!config ? "全能助手配置尚未就绪，可先打开空白画布或使用画布库。" : "全能助手暂不可用，仍可打开空白画布或使用画布库。"}</p> : null}
                </section>
                <p className="studio-local-note">画布ONE · 创作数据按账号保存到云端</p>
            </div>}
            {!libraryView ? <Drawer title={t("canvas.library")} open={libraryOpen} onClose={() => setLibraryOpen(false)} size="min(1100px, 100vw)">
                <div className="flex flex-col gap-6">{libraryActions}{libraryContent}</div>
            </Drawer> : null}

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
