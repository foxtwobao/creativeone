export type AdminUser = { id: string; username: string; displayName: string; email: string };
export type AdminTask = {
    id: string; user: AdminUser; capability: "image" | "video"; model: string; status: string;
    source: "canvas" | "workbench"; prompt: string; createdAt: string; updatedAt: string;
    hiddenFromWorks: boolean; hiddenFromHistory: boolean;
};
export type AdminTaskMedia = { kind: "image" | "video" | "audio"; url?: string; previewUrl?: string };
export type AdminTaskDetail = AdminTask & {
    upstreamId: string | null; canvasTitle: string | null; sentPrompt: string; error: string | null; errorMessage: string | null;
    settings: { key: string; label: string; children: string }[];
    references: AdminTaskMedia[]; results: AdminTaskMedia[];
};
