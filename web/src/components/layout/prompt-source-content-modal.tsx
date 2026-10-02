import { App, Button, Empty, Modal, Space, Table, Tag } from "antd";
import { Copy, FolderPlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { fetchSourcePrompts, refreshSource, type Prompt } from "@/services/api/prompts";
import type { PromptSource } from "@/services/api/prompt-source-presets";

export function PromptSourceContentModal({ source, onClose }: { source: PromptSource | null; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [items, setItems] = useState<Prompt[]>([]);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [detail, setDetail] = useState<Prompt | null>(null);
    const copyText = useCopyText();
    const addAsset = useAssetStore((state) => state.addAsset);

    const load = useCallback(
        async (force: boolean) => {
            if (!source) return;
            setLoading(true);
            try {
                if (force) await refreshSource(source.id);
                const result = await fetchSourcePrompts(source.id, page, "", 10);
                setItems(result.items); setTotal(result.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("config.promptSources.content.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [source, page, message, t],
    );

    useEffect(() => { setPage(1); }, [source?.id]);
    useEffect(() => {
        if (source) void load(false);
        else setItems([]);
    }, [source, load]);

    const saveAsset = async (item: Prompt) => {
        try {
        await addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
        } catch (error) { message.error(error instanceof Error ? error.message : "素材保存失败"); }
    };

    return (
        <>
            <Modal
                open={Boolean(source)}
                onCancel={onClose}
                width={980}
                footer={null}
                title={
                    <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
                        <div>
                            <div className="text-base font-semibold">{t("config.promptSources.content.title", { name: source?.name || "" })}</div>
                            <div className="mt-0.5 text-xs font-normal text-stone-500">{t("config.promptSources.content.count", { count: total })}</div>
                        </div>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load(true)}>
                            {t("config.promptSources.content.refresh")}
                        </Button>
                    </div>
                }
            >
                <Table<Prompt>
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={items}
                    pagination={{ current: page, total, pageSize: 10, showSizeChanger: false, size: "small", onChange: setPage }}
                    scroll={{ y: "56vh" }}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.promptSources.content.empty")} /> }}
                    columns={[
                        {
                            title: t("config.promptSources.content.cover"),
                            dataIndex: "coverUrl",
                            width: 72,
                            render: (coverUrl: string) => (coverUrl ? <img src={coverUrl} alt="" className="size-12 rounded object-cover" /> : <div className="size-12 rounded bg-stone-100 dark:bg-stone-800" />),
                        },
                        {
                            title: t("config.promptSources.content.titleColumn"),
                            dataIndex: "title",
                            render: (title: string, item) => (
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{title}</div>
                                    <div className="mt-0.5 line-clamp-2 text-xs text-stone-500">{item.prompt}</div>
                                </div>
                            ),
                        },
                        {
                            title: t("config.promptSources.content.tags"),
                            dataIndex: "tags",
                            width: 200,
                            render: (tags: string[]) => (
                                <div className="flex flex-wrap gap-1">
                                    {tags.slice(0, 4).map((tag) => (
                                        <Tag key={tag} className="m-0">
                                            {tag}
                                        </Tag>
                                    ))}
                                </div>
                            ),
                        },
                        {
                            title: t("config.promptSources.content.actions"),
                            width: 210,
                            render: (_, item) => (
                                <Space size={4} wrap>
                                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(item.prompt, t("common.promptCopied"))}>
                                        {t("common.copy")}
                                    </Button>
                                    <Button size="small" type="text" onClick={() => setDetail(item)}>
                                        {t("common.details")}
                                    </Button>
                                    <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => saveAsset(item)}>
                                        {t("common.addToAssets")}
                                    </Button>
                                </Space>
                            ),
                        },
                    ]}
                />
            </Modal>
            <PromptDetailDialog prompt={detail} onClose={() => setDetail(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={saveAsset} />
        </>
    );
}
