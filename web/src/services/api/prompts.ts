import { cloudApi, CloudError } from "./cloud";
import type { RawPrompt } from "../../../../shared/prompt-items";
export type Prompt = RawPrompt & {
    sourceId: string;
    category: string;
    githubUrl: string;
};

export const ALL_PROMPTS_OPTION = "all";

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    total: number;
};

export type PromptSourceStatus = {
    sourceId: string;
    count: number;
    lastSuccessAt: string;
    lastError: string;
};

export type PromptSourceRefreshResult = PromptSourceStatus & {
    sourceName: string;
    success: boolean;
};

export type PromptSourceRefreshSummary = {
    results: PromptSourceRefreshResult[];
    total: number;
    successCount: number;
    failureCount: number;
};


export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    const query = new URLSearchParams({ keyword, category, page: String(page), pageSize: String(pageSize) });
    tag.forEach((item) => query.append("tag", item));
    return cloudApi<PromptListResponse>(`/prompts?${query}`);
}
export async function fetchSourcePrompts(sourceId: string, page = 1, keyword = "", pageSize = 20) {
    return cloudApi<PromptListResponse>(`/prompts?${new URLSearchParams({ sourceId, page: String(page), keyword, pageSize: String(pageSize) })}`);
}
export const fetchPromptSourceStatuses = () => cloudApi<Record<string, PromptSourceStatus>>("/prompt-source-statuses");
export const refreshAllSources = () => cloudApi<PromptSourceRefreshSummary>("/prompt-sources/refresh", { method: "POST", body: "{}" });
export async function refreshSource(sourceId: string) {
    const result = await cloudApi<PromptSourceRefreshSummary>("/prompt-sources/refresh", { method: "POST", body: JSON.stringify({ sourceId }) });
    const source = result.results[0];
    if (!source?.success) throw new CloudError(502, source?.lastError || "PROMPT_SOURCE_FETCH_FAILED");
    return source;
}

export function formatPromptDate(value: string, locale?: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
