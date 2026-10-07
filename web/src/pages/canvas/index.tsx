import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";
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

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const inputRef = useRef<HTMLInputElement>(null);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const enterProject = (id: string) => navigate(`/canvas/${id}`);
    const createAndEnter = async () => { try { enterProject(await createProject(t("canvas.defaultTitle", { count: projects.length + 1 }))); } catch (error) { message.error(error instanceof Error ? error.message : "画布创建失败"); } };
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

    return (
        <main className="h-full overflow-auto" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-6" style={{ borderColor: theme.toolbar.border }}>
                    <div>
                        <p className="text-xs" style={{ color: theme.node.muted }}>{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
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
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y text-sm" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y text-center" style={{ borderColor: theme.toolbar.border }}>
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm" style={{ color: theme.node.muted }}>{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
