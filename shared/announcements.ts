export type AnnouncementSummary = {
    id: string; title: string; publishedAt: string; updatedAt: string; revision: string; read: boolean;
};
export type AnnouncementDetail = AnnouncementSummary & { body: string };
export type AnnouncementPage = { items: AnnouncementSummary[]; hasMore: boolean; nextOffset: number };
