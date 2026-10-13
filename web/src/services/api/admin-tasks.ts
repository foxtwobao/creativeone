import { cloudApi } from "./cloud";
import type { AdminTask, AdminTaskDetail, AdminUser, AdminTaskStats } from "../../../../shared/admin-tasks";

export const fetchAdminUsers = (keyword: string, page: number, signal?: AbortSignal) => cloudApi<{ users: AdminUser[]; total: number }>(`/admin/users?${new URLSearchParams({ keyword, page: String(page) })}`, { signal });
export const fetchAdminTasks = (query: URLSearchParams, signal?: AbortSignal) => cloudApi<{ tasks: AdminTask[]; total: number }>(`/admin/tasks?${query}`, { signal });
export const fetchAdminTask = (id: string, signal?: AbortSignal) => cloudApi<{ task: AdminTaskDetail }>(`/admin/tasks/${encodeURIComponent(id)}`, { signal });

export const fetchAdminTaskStats = (query: URLSearchParams, signal?: AbortSignal) => cloudApi<{ stats: AdminTaskStats[] }>(`/admin/tasks/stats?${query}`, { signal });
