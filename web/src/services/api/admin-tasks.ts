import { cloudApi } from "./cloud";
import type { AdminTask, AdminTaskDetail, AdminUser } from "../../../../shared/admin-tasks";

export const fetchAdminUsers = (keyword: string, page: number, signal?: AbortSignal) => cloudApi<{ users: AdminUser[]; total: number }>(`/admin/users?${new URLSearchParams({ keyword, page: String(page) })}`, { signal });
export const fetchAdminTasks = (query: URLSearchParams, signal?: AbortSignal) => cloudApi<{ tasks: AdminTask[]; total: number }>(`/admin/tasks?${query}`, { signal });
export const fetchAdminTask = (id: string, signal?: AbortSignal) => cloudApi<{ task: AdminTaskDetail }>(`/admin/tasks/${encodeURIComponent(id)}`, { signal });
