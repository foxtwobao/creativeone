import { cloudApi } from "./cloud";
import type { AnnouncementDetail, AnnouncementPage } from "../../../../shared/announcements";

export const fetchAnnouncements = (offset: number, signal: AbortSignal) => cloudApi<AnnouncementPage>(`/announcements?limit=50&offset=${offset}`, { signal });
export const fetchAnnouncement = (id: string, signal: AbortSignal) => cloudApi<AnnouncementDetail>(`/announcements/${encodeURIComponent(id)}`, { signal });
export const markAnnouncementRead = (id: string, revision: string, signal: AbortSignal) => cloudApi<void>(`/announcements/${encodeURIComponent(id)}/read`, { method: "PUT", body: JSON.stringify({ revision }), signal });
