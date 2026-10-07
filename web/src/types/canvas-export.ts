import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasExportFile = {
    app: "infinite-canvas";
    version: 4;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

export type CanvasProjectExportItem = {
    project: Pick<CanvasProject, "title" | "nodes" | "connections" | "backgroundMode" | "showImageInfo" | "viewport">;
    files: CanvasExportAsset[];
};

export type CanvasExportAsset = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};
