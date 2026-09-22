import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Modal, Select, Switch, Table, Tag } from "antd";
import { cloudApi, cloudSession } from "@/services/api/cloud";

type Channel = { id?: string; capability: string; models: string[]; default_model: string; enabled: boolean };
type Group = { id: string; name: string; status: string; is_default: boolean };
const capabilities = [{ value: "image", label: "图片生成 / 编辑" }, { value: "text", label: "聊天 / 文本生成" }, { value: "video", label: "视频生成" }, { value: "audio", label: "音频生成" }];

export default function ChannelsPage() {
    const { message } = App.useApp();
    const [channels, setChannels] = useState<Channel[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [models, setModels] = useState<string[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState("");
    const [editing, setEditing] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    const [form] = Form.useForm();
    const selectedModels: string[] = Form.useWatch("models", form) || [];
    const load = async () => {
        setLoading(true);
        try {
            const [c, g] = await Promise.all([cloudApi<{ channels: Channel[] }>("/admin/channels"), cloudApi<{ groups: Group[] }>("/admin/groups")]);
            setChannels(c.channels); setGroups(g.groups); setError("");
        } catch (error) { setError(error instanceof Error ? error.message : "加载失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { if (cloudSession?.user.admin) void load(); }, []);
    if (!cloudSession?.user.admin) return <div className="p-6"><Alert type="error" title="只有管理员可以配置功能模型" /></div>;
    const loadModels = async () => {
        setModelsLoading(true); setModelsError(""); setModels([]);
        try { setModels((await cloudApi<{ models: string[] }>("/admin/models")).models); }
        catch (error) { setModelsError(error instanceof Error ? error.message : "模型列表加载失败"); }
        finally { setModelsLoading(false); }
    };
    const edit = (channel: Channel) => {
        setEditing(channel.capability);
        form.setFieldsValue({ models: channel.models, default_model: channel.default_model, enabled: channel.enabled });
        if (!modelsLoading) void loadModels();
    };
    const save = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            await cloudApi(`/admin/channels/${editing}`, { method: "PUT", body: JSON.stringify({ ...values, models: [...new Set<string>(values.models.map((model: string) => model.trim()).filter(Boolean))] }) });
            setEditing(null); await load(); message.success("配置已保存，重新加载页面后生效");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    const rows = capabilities.map(({ value }) => channels.find((channel) => channel.capability === value) || { capability: value, models: [], default_model: "", enabled: false });
    return <main className="h-full overflow-auto bg-background p-6"><div className="mx-auto max-w-5xl space-y-5">
        <h1 className="text-xl font-semibold">功能模型配置</h1>
        <p className="text-sm text-muted-foreground">按功能维护可用模型、默认模型和启用状态；所有功能使用 Enhance 管理的应用默认分组。</p>
        <p className="text-sm text-muted-foreground">应用当前分组：{groups.map((group) => `${group.name} (${group.id})${group.is_default ? " · 默认" : ""}${group.status !== "active" ? " · 不可用" : ""}`).join("、") || "暂无"}；分组配置请在 Enhance 管理后台调整。</p>
        {error ? <Alert type="error" title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
        <Table<Channel> rowKey="capability" dataSource={rows} loading={loading} pagination={false} scroll={{ x: true }} columns={[
            { title: "功能", dataIndex: "capability", render: (value) => capabilities.find((item) => item.value === value)?.label },
            { title: "模型", dataIndex: "models", render: (models: string[]) => models.join("、") || "尚未配置" },
            { title: "默认模型", dataIndex: "default_model", render: (value) => value || "—" },
            { title: "状态", render: (_, channel) => <Tag>{channel.enabled ? "启用" : "停用"}</Tag> },
            { title: "操作", render: (_, channel) => <Button type="link" disabled={Boolean(error)} onClick={() => edit(channel)}>编辑</Button> },
        ]} />
        <Modal title={`${capabilities.find((item) => item.value === editing)?.label || "功能"} · 模型配置`} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => void save()} confirmLoading={saving} destroyOnHidden>
            <Form form={form} layout="vertical" onValuesChange={(changed, values) => {
                if (changed.models && !values.models.includes(values.default_model)) form.setFieldValue("default_model", values.models[0] || "");
            }}>
                <Form.Item name="models" label="允许的模型" normalize={(values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]} dependencies={["enabled"]} rules={[({ getFieldValue }) => ({ validator: (_, value) => !getFieldValue("enabled") || value?.length ? Promise.resolve() : Promise.reject(new Error("启用时请至少配置一个模型")) })]} extra="可搜索选择，也可输入模型 ID 后按回车；支持逗号或换行粘贴。列表不区分功能，请按当前功能选择。">
                    <Select mode="tags" showSearch allowClear loading={modelsLoading} tokenSeparators={[",", "，", "\n", "\r"]} options={models.map((model) => ({ value: model, label: model }))} placeholder="搜索模型或输入模型 ID" notFoundContent={modelsLoading ? "正在加载模型…" : "暂无匹配模型，可手动输入"} />
                </Form.Item>
                <div className="mb-4 space-y-2">
                    {modelsError ? <Alert type="warning" title={modelsError} description="仍可手动输入模型 ID，已选模型会保留。" /> : null}
                    <Button type="link" className="!px-0" loading={modelsLoading} onClick={() => void loadModels()}>刷新模型列表</Button>
                    <span className="ml-2 text-xs text-muted-foreground">当前管理员在应用默认分组下可见的模型</span>
                </div>
                <Form.Item name="default_model" label="默认模型" dependencies={["models"]} rules={[({ getFieldValue }) => ({ validator: (_, value) => {
                    const models: string[] = getFieldValue("models") || [];
                    return models.length ? models.includes(value) ? Promise.resolve() : Promise.reject(new Error("请选择已配置的模型")) : Promise.resolve();
                } })]}><Select options={selectedModels.map((model) => ({ value: model, label: model }))} placeholder="从已选模型中指定" disabled={!selectedModels.length} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Form>
        </Modal>
    </div></main>;
}
