import { PresetSearch, usePresetSearch } from "../components/preset-search";
import { PresetUsage } from "../components/preset-usage";
import type { PresetListItem } from "../../../../../shared/preset-usage";
import { useEffect, useState } from "react";
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag } from "antd";
import { Plus, Copy, Pencil, Trash2 } from "lucide-react";
import { cloudSession } from "@/services/api/cloud";
import { deleteVideoPreset, saveVideoPreset } from "@/services/api/video-presets";
import { refreshModelConfiguration } from "@/stores/use-config-store";
import { useVideoPresetsStore } from "@/stores/use-video-presets-store";
import { videoCallTypeLabels, videoModelTypes, videoModelTypeLabels, videoModelProfile, type VideoParameterPreset, type VideoProfile } from "../../../../../shared/video-models";

const resolutions = ["480", "720", "768", "1080", "2k", "4k"].map(value => ({ value, label: value.endsWith("k") ? value.toUpperCase() : `${value}P` }));
const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3", "auto"].map(value => ({ value, label: value === "auto" ? "自动" : value }));
const modes = [{ value: "frames", label: "首尾帧" }, { value: "reference", label: "全能参考" }];
const required = [{ required: true, message: "请填写或选择" }];
const flags = [
    ["requireImage", "必须提供图片"], ["audioOnly", "允许仅参考音频"], ["framesRequirePair", "首尾帧必须成对"], ["framesAdaptive", "首尾帧仅允许自动画幅"],
    ["audioOptions", "显示生成音频与水印开关"], ["explicitReferenceTask", "发送原生参考任务类型"],
] as const;

export default function VideoPresetsPage() {
    const { message, modal } = App.useApp();
    const { presets, loading, error, load } = useVideoPresetsStore();
    const { filtered, searchProps } = usePresetSearch(presets);
    const [editing, setEditing] = useState<VideoParameterPreset | null>(null);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm();
    const profile: Partial<VideoProfile> = Form.useWatch("profile", form) || {};
    useEffect(() => { if (cloudSession?.user.admin) void load(); }, [load]);
    if (!cloudSession?.user.admin) return <main className="p-6"><Alert type="error" title="只有管理员可以维护参数预设" /></main>;
    const edit = (preset?: VideoParameterPreset, copy = false) => {
        const source = structuredClone(preset?.profile || presets[0]?.profile || videoModelProfile("doubao-seedance-2-0-260128", "seedance"));
        setEditing(copy ? null : preset || null);
        form.resetFields();
        form.setFieldsValue({ label: preset ? `${preset.label}${copy ? " 副本" : ""}` : "", profile: source, durationOverrides: Object.entries(source.durationByResolution || {}).map(([resolution, range]) => ({ resolution, ...range })) });
        setOpen(true);
    };
    const refresh = async () => {
        await load();
        try { await refreshModelConfiguration(); }
        catch { message.warning("预设已保存，请刷新页面加载最新模型配置"); }
    };
    const save = async () => {
        if (!await form.validateFields().then(() => true).catch(() => false)) return;
        const values = form.getFieldsValue(true);
        const p = values.profile;
        const durationByResolution = Object.fromEntries((values.durationOverrides || []).map((row: { resolution: string; min: number; max: number; auto?: boolean }) => [row.resolution, { min: row.min, max: row.max, auto: Boolean(row.auto) }]));
        if (p.durationConfigurable && (p.duration?.min == null) !== (p.duration?.max == null)) { message.error("请同时填写最短和最长时长，或全部留空"); return; }
        if (Object.keys(durationByResolution).length !== (values.durationOverrides || []).length) { message.error("特殊时长的分辨率不能重复"); return; }
        const next: VideoProfile = { ...p, maxImages: p.maxImages ?? null, maxVideos: p.maxVideos ?? null, maxAudios: p.maxAudios ?? null, referenceSeconds: p.referenceSeconds ?? null, duration: p.durationConfigurable && p.duration?.min != null ? { ...p.duration, auto: Boolean(p.duration.auto) } : null, durationByResolution };
        if (p.referenceImages?.min == null && p.referenceImages?.max == null) delete next.referenceImages;
        if (!p.fastModeOptions?.length) delete next.fastModeOptions;
        setSaving(true);
        try {
            await saveVideoPreset({ label: values.label, profile: next, ...(editing ? { revision: editing.revision } : {}) }, editing?.id);
            setOpen(false); await refresh(); message.success("预设已保存，当前页面已更新；其他已打开页面请刷新");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    const remove = (preset: VideoParameterPreset) => modal.confirm({ title: `删除「${preset.label}」？`, content: "被模型引用的预设不能删除，请先在功能模型配置中解除引用。", okText: "删除", okButtonProps: { danger: true }, onOk: async () => {
        try { await deleteVideoPreset(preset.id); await refresh(); message.success("已删除"); }
        catch (error) { message.error(error instanceof Error ? error.message : "删除失败"); throw error; }
    } });
    return <main className="h-full overflow-auto bg-background p-4 sm:p-6"><div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-semibold">视频参数预设</h1><p className="mt-2 text-sm text-muted-foreground">维护允许值、默认值和素材限制，多个模型可共用一份预设。</p></div><Button type="primary" icon={<Plus size={15} />} disabled={loading || Boolean(error)} onClick={() => edit()}>新增预设</Button></div>
        {error ? <Alert type="error" title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
        <PresetSearch kind="video" {...searchProps} />
        <Table<PresetListItem<VideoParameterPreset>> rowKey="id" loading={loading} dataSource={filtered} scroll={{ x: 900 }} pagination={false} columns={[
            { title: "名称", dataIndex: "label", render: (label, row) => <div><div className="font-medium">{label}</div><div className="mt-1 text-xs text-muted-foreground">{videoModelTypeLabels[row.profile.family]}</div></div> },
            { title: "调用类型", render: (_, row) => <Tag>{videoCallTypeLabels[row.callType]}</Tag> },
            { title: "分辨率 / 时长", render: (_, { profile: p }) => <div><div>{p.resolutions.map(r => resolutions.find(o => o.value === r)?.label).join(" / ")}</div><div className="mt-1 text-xs text-muted-foreground">{!p.durationConfigurable ? "模型决定时长" : p.duration ? `${p.duration.min}–${p.duration.max} 秒${p.duration.auto ? " · 可自动" : ""}` : "正整数秒"}</div></div> },
            { title: "参考素材上限", render: (_, { profile: p }) => `图 ${p.maxImages ?? "未设"} / 视频 ${p.maxVideos ?? "未设"} / 音频 ${p.maxAudios ?? "未设"}` },
            { title: "使用", width: 64, align: "center", render: (_, row) => <PresetUsage usedBy={row.usedBy} /> },
            { title: "操作", render: (_, row) => <div className="flex gap-1"><Button type="text" icon={<Pencil size={14} />} onClick={() => edit(row)}>编辑</Button><Button type="text" aria-label={`复制 ${row.label}`} icon={<Copy size={14} />} onClick={() => edit(row, true)} /><Button type="text" danger aria-label={`删除 ${row.label}`} icon={<Trash2 size={14} />} onClick={() => remove(row)} /></div> },
        ]} />
        <Modal title={editing ? "编辑视频参数预设" : "新增视频参数预设"} open={open} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => void save()} confirmLoading={saving} width={800} destroyOnHidden>
            <Form form={form} layout="vertical" disabled={saving} className="mt-4">
                <div className="grid gap-x-4 sm:grid-cols-2">
                    <Form.Item name="label" label="预设名称" rules={required}><Input placeholder="如 WAN 3 标准版" /></Form.Item>
                    <Form.Item name={["profile", "family"]} label="规则类型" rules={required} extra="匹配已接入的协议规则；被引用后不能更换类型。"><Select options={videoModelTypes.map(value => ({ value, label: videoModelTypeLabels[value] }))} /></Form.Item>
                    <Form.Item name={["profile", "resolutions"]} label="允许的分辨率" rules={required}><Select mode="multiple" options={resolutions} /></Form.Item>
                    <Form.Item name={["profile", "defaults", "resolution"]} label="默认分辨率" rules={required}><Select options={resolutions.filter(r => profile.resolutions?.includes(r.value))} /></Form.Item>
                    <Form.Item name={["profile", "ratios"]} label="允许的画幅" rules={required}><Select mode="multiple" options={ratios} /></Form.Item>
                    <Form.Item name={["profile", "defaults", "ratio"]} label="默认画幅" rules={required}><Select options={ratios.filter(r => profile.ratios?.includes(r.value))} /></Form.Item>
                    <Form.Item name={["profile", "modes"]} label="允许的参考模式" rules={required}><Select mode="multiple" options={modes} /></Form.Item>
                    <Form.Item name={["profile", "defaults", "mode"]} label="默认参考模式" rules={required}><Select options={modes.filter(m => profile.modes?.includes(m.value as "frames" | "reference"))} /></Form.Item>
                </div>
                <div className="grid gap-x-4 sm:grid-cols-3">
                    <Form.Item name={["profile", "durationConfigurable"]} label="允许指定时长" valuePropName="checked"><Switch /></Form.Item>
                    <Form.Item name={["profile", "defaults", "seconds"]} label="默认时长（秒）" extra="自动时长填 -1"><Input disabled={!profile.durationConfigurable || saving} /></Form.Item>
                    <Form.Item name={["profile", "duration", "auto"]} label="允许自动时长" valuePropName="checked"><Switch disabled={!profile.durationConfigurable || profile.family !== "seedance" || saving} /></Form.Item>
                    <Form.Item name={["profile", "duration", "min"]} label="最短时长（秒）"><InputNumber min={1} precision={0} disabled={!profile.durationConfigurable || saving} className="!w-full" /></Form.Item>
                    <Form.Item name={["profile", "duration", "max"]} label="最长时长（秒）"><InputNumber min={1} precision={0} disabled={!profile.durationConfigurable || saving} className="!w-full" /></Form.Item>
                </div>
                <div className="grid gap-x-4 sm:grid-cols-3">{[["maxImages", "参考图上限"], ["maxVideos", "参考视频上限"], ["maxAudios", "参考音频上限"]].map(([key, label]) => <Form.Item key={key} name={["profile", key]} label={label} extra="0 为不支持，留空为未设上限"><InputNumber min={0} precision={0} className="!w-full" /></Form.Item>)}</div>
                <Collapse ghost items={[{ key: "rules", forceRender: true, label: "素材组合与其他规则", children: <>
                    <div className="grid gap-x-4 sm:grid-cols-2">{flags.map(([key, label]) => <Form.Item key={key} name={["profile", key]} label={label} valuePropName="checked"><Switch /></Form.Item>)}</div>
                    <div className="grid gap-x-4 sm:grid-cols-3">
                        <Form.Item name={["profile", "referenceSeconds"]} label="参考视频 / 音频各自合计时长上限" extra="秒，留空为未设上限"><InputNumber min={0} className="!w-full" /></Form.Item>
                        <Form.Item name={["profile", "referenceImages", "min"]} label="全能参考模式最少图片数量"><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
                        <Form.Item name={["profile", "referenceImages", "max"]} label="全能参考模式最多图片数量"><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
                        <Form.Item name={["profile", "defaults", "generateAudio"]} label="默认生成音频" valuePropName="checked"><Switch /></Form.Item>
                        <Form.Item name={["profile", "defaults", "watermark"]} label="默认水印" valuePropName="checked"><Switch /></Form.Item>
                        <Form.Item name={["profile", "fastModeOptions"]} label="快速模式选项（H3）"><Select mode="multiple" options={[{ value: "", label: "默认" }, { value: "false", label: "标准" }, { value: "true", label: "优先" }]} /></Form.Item>
                        <Form.Item name={["profile", "defaults", "fastMode"]} label="默认快速模式"><Select options={[{ value: "", label: "默认" }, { value: "false", label: "标准" }, { value: "true", label: "优先" }]} /></Form.Item>
                    </div>
                </> }, { key: "duration", forceRender: true, label: "按分辨率设置特殊时长", children: <Form.List name="durationOverrides">{(fields, { add, remove }) => <div className="space-y-2">{fields.map(field => <div key={field.key} className="grid grid-cols-2 gap-x-2 sm:grid-cols-5"><Form.Item name={[field.name, "resolution"]} rules={required}><Select placeholder="分辨率" options={resolutions.filter(r => profile.resolutions?.includes(r.value))} /></Form.Item><Form.Item name={[field.name, "min"]} rules={required}><InputNumber aria-label="特殊最短时长" min={1} precision={0} placeholder="最短秒数" /></Form.Item><Form.Item name={[field.name, "max"]} rules={required}><InputNumber aria-label="特殊最长时长" min={1} precision={0} placeholder="最长秒数" /></Form.Item><Form.Item name={[field.name, "auto"]} valuePropName="checked"><Switch checkedChildren="可自动" unCheckedChildren="固定" /></Form.Item><Button type="text" danger onClick={() => remove(field.name)}>移除</Button></div>)}<Button type="dashed" onClick={() => add({ auto: false })} icon={<Plus size={14} />}>添加特殊时长</Button></div>}</Form.List> }]} />
                <p className="mt-4 text-xs text-muted-foreground">保存会影响所有引用此预设的模型及新提交；已提交任务保留原请求。默认值必须符合允许范围，费用以模型价格和账单为准。</p>
            </Form>
        </Modal>
    </div></main>;
}
