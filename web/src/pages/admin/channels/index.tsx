import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Modal, Select, Switch, Table, Tag } from "antd";
import { cloudApi, cloudSession } from "@/services/api/cloud";

type Channel = { id: string; name: string; capability: string; group_id: number; models: string[]; enabled: boolean; is_default: boolean };
type Group = { id: number; name: string; status: string; description: string };
const capabilities = [{ value: "image", label: "图片生成 / 编辑" }, { value: "text", label: "聊天 / 文本生成" }, { value: "video", label: "视频生成" }, { value: "audio", label: "音频生成" }];

export default function ChannelsPage() {
    const { message } = App.useApp();
    const [channels, setChannels] = useState<Channel[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm();
    const load = async () => {
        try {
            const [c, g] = await Promise.all([cloudApi<{ channels: Channel[] }>("/admin/channels"), cloudApi<{ groups: Group[] }>("/admin/groups")]);
            setChannels(c.channels); setGroups(g.groups); setError("");
        } catch (error) { setError(error instanceof Error ? error.message : "加载失败"); }
    };
    useEffect(() => { if (cloudSession?.user.admin) void load(); }, []);
    if (!cloudSession?.user.admin) return <div className="p-6"><Alert type="error" title="只有管理员可以管理功能渠道" /></div>;
    const edit = (channel?: Channel) => {
        setEditing(channel?.id || "new");
        form.setFieldsValue(channel ? { ...channel, models: channel.models.join("\n") } : { name: "", capability: "image", group_id: undefined, models: "", enabled: true, is_default: false });
    };
    const save = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            await cloudApi(editing === "new" ? "/admin/channels" : `/admin/channels/${editing}`, { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify({ ...values, models: values.models.split(/\n|,/).map((model: string) => model.trim()).filter(Boolean) }) });
            setEditing(null); await load(); message.success("渠道已保存，重新加载页面后生效");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    return <main className="h-full overflow-auto bg-background p-6"><div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">功能渠道管理</h1><Button type="primary" onClick={() => edit()}>新增渠道</Button></div>
        <p className="text-sm text-muted-foreground">每个渠道对应一个功能和一个 TokenONE 分组；同一功能可配置多个渠道。用户首次使用时，系统自动获取该用户在此分组的 Key。</p>
        {error ? <Alert type="error" title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
        <Table rowKey="id" dataSource={channels} pagination={false} scroll={{ x: true }} columns={[
            { title: "名称", dataIndex: "name" }, { title: "功能", dataIndex: "capability", render: (value) => capabilities.find((item) => item.value === value)?.label },
            { title: "分组", dataIndex: "group_id", render: (id) => groups.find((item) => item.id === id)?.name || id },
            { title: "模型", dataIndex: "models", render: (models: string[]) => models.join("、") },
            { title: "状态", render: (_, channel) => <><Tag>{channel.enabled ? "启用" : "停用"}</Tag>{channel.is_default ? <Tag color="blue">默认</Tag> : null}</> },
            { title: "操作", render: (_, channel) => <Button type="link" onClick={() => edit(channel)}>编辑</Button> },
        ]} />
        <Modal title="配置功能渠道" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => void save()} confirmLoading={saving} destroyOnHidden>
            <Form form={form} layout="vertical">
                <Form.Item name="name" label="渠道名称" rules={[{ required: true }]}><Input placeholder="例如：标准生图、深度推理" /></Form.Item>
                <Form.Item name="capability" label="功能" rules={[{ required: true }]}><Select options={capabilities} /></Form.Item>
                <Form.Item name="group_id" label="TokenONE 分组" rules={[{ required: true }]}><Select options={groups.map((group) => ({ value: group.id, label: `${group.name} (${group.id})${group.status !== "active" ? " · 已停用" : ""}`, disabled: group.status !== "active" }))} /></Form.Item>
                <Form.Item name="models" label="允许的模型（每行一个，顺序决定默认模型）" rules={[{ required: true }]}><Input.TextArea rows={5} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                <Form.Item name="is_default" label="该功能默认渠道" valuePropName="checked"><Switch /></Form.Item>
            </Form>
        </Modal>
    </div></main>;
}
