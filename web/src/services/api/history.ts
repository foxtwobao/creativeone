import { cloudApi } from "./cloud";
export const fetchGenerationHistory = <T>(capability: string, page = 1, keyword = "", upstreamId?: string) => cloudApi<{ logs: T[]; total: number }>(`/history/${capability}?${new URLSearchParams({ page: String(page), keyword, ...(upstreamId ? { upstreamId } : {}) })}`);
export const removeGenerationHistory = (id: string) => cloudApi<void>(`/history/${encodeURIComponent(id)}`, { method: "DELETE" });
