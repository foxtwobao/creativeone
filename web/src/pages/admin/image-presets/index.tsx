import { PresetSearch, usePresetSearch } from "../components/preset-search";
import { PresetUsage } from "../components/preset-usage";
import type { PresetListItem } from "../../../../../shared/preset-usage";
import { useEffect, useState } from "react";
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Modal, Select, Switch, Table, Tag } from "antd";
import { Plus, Copy, Pencil, Trash2 } from "lucide-react";
import { cloudSession } from "@/services/api/cloud";
import { deleteImagePreset, saveImagePreset } from "@/services/api/image-presets";
import { refreshModelConfiguration } from "@/stores/use-config-store";
import { useImagePresetsStore } from "@/stores/use-image-presets-store";
import { imageModelTypes, imageModelTypeLabels, imageModelProfile, type ImageParameterPreset, type ImageProfile } from "../../../../../shared/image-models";

type SizeRow = { scale: string; ratio: string; size: string };
const required = [{ required: true, message: "请填写或选择" }];
const scales = ["1k", "2k", "4k", "auto"].map(value => ({ value, label: value === "auto" ? "自动" : value.toUpperCase() }));
const flags = [["pixelSize", "允许像素尺寸与自定义宽高"], ["transparent", "允许透明背景"], ["singleReferenceRatioLocked", "单图编辑沿用参考图画幅"], ["omitResponseFormat", "省略 response_format"]] as const;
const bounds = [["step", "宽高对齐倍数"], ["maxEdge", "最长边像素上限"], ["maxRatio", "长短边比例上限"], ["minPixels", "最少总像素"], ["maxPixels", "最多总像素"], ["ratioShortSide", "比例转像素时的默认短边"]] as const;

export default function ImagePresetsPage() {
    const { message, modal } = App.useApp();
    const { presets, loading, error, load } = useImagePresetsStore();
    const { filtered, searchProps } = usePresetSearch(presets);
    const [editing, setEditing] = useState<ImageParameterPreset | null>(null);
    const [open, setOpen] = useState(false), [saving, setSaving] = useState(false);
    const [form] = Form.useForm();
    const profile: Partial<ImageProfile> = Form.useWatch("profile", form) || {};
    useEffect(() => { if (cloudSession?.user.admin) void load(); }, [load]);
    if (!cloudSession?.user.admin) return <main className="p-6"><Alert type="error" title="只有管理员可以维护图片参数预设" /></main>;
    const edit = (preset?: ImageParameterPreset, copy = false) => {
        const source = structuredClone(preset?.profile || presets[0]?.profile || imageModelProfile("", "openai"));
        setEditing(copy ? null : preset || null); form.resetFields();
        form.setFieldsValue({ label: preset ? `${preset.label}${copy ? " 副本" : ""}` : "", profile: source, sizeRows: Object.entries(source.sizePresets).flatMap(([scale, sizes]) => Object.entries(sizes).map(([ratio, size]) => ({ scale, ratio, size }))) });
        setOpen(true);
    };
    const refresh = async () => { await load(); try { await refreshModelConfiguration(); } catch { message.warning("预设已保存，请刷新页面加载最新模型配置"); } };
    const save = async () => {
        if (!await form.validateFields().then(() => true).catch(() => false)) return;
        const values = form.getFieldsValue(true), rows: SizeRow[] = values.sizeRows || [];
        if (new Set(rows.map(row => `${row.scale}/${row.ratio}`)).size !== rows.length) { message.error("同一档位的画幅不能重复"); return; }
        const sizePresets: ImageProfile["sizePresets"] = {};
        for (const row of rows) (sizePresets[row.scale] ||= {})[row.ratio] = row.size;
        const next: ImageProfile = { ...values.profile, maxReferences: values.profile.maxReferences ?? null, sizePresets };
        if (!next.fixedResolution) delete next.fixedResolution;
        setSaving(true);
        try {
            await saveImagePreset({ label: values.label, profile: next, ...(editing ? { revision: editing.revision } : {}) }, editing?.id);
            setOpen(false); await refresh(); message.success("预设已保存，当前页面已更新；其他已打开页面请刷新");
        } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
        finally { setSaving(false); }
    };
    const remove = (preset: ImageParameterPreset) => modal.confirm({ title: `删除「${preset.label}」？`, content: "被模型引用的预设不能删除，请先在功能模型配置中解除引用。", okText: "删除", okButtonProps: { danger: true }, onOk: async () => {
        try { await deleteImagePreset(preset.id); await refresh(); message.success("已删除"); }
        catch (error) { message.error(error instanceof Error ? error.message : "删除失败"); throw error; }
    } });
    return <main className="h-full overflow-auto bg-background p-4 sm:p-6"><div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-xl font-semibold">图片参数预设</h1><p className="mt-2 text-sm text-muted-foreground">维护图片参数、尺寸映射与素材限制，多个模型可共用一份预设。</p></div><Button type="primary" icon={<Plus size={15} />} disabled={loading || Boolean(error)} onClick={() => edit()}>新增预设</Button></div>
        {error ? <Alert type="error" title={error} action={<Button onClick={() => void load()}>重试</Button>} /> : null}
        <PresetSearch kind="image" {...searchProps} />
        <Table<PresetListItem<ImageParameterPreset>> rowKey="id" dataSource={filtered} loading={loading} scroll={{ x: 850 }} pagination={false} columns={[
            { title: "名称", dataIndex: "label" },
            { title: "调用类型", render: (_, row) => <Tag>{imageModelTypeLabels[row.callType]}</Tag> },
            { title: "画质", render: (_, row) => row.profile.qualities.join(" / ") || "不提供选择" },
            { title: "分辨率", render: (_, row) => row.profile.fixedResolution ? `${row.profile.fixedResolution.toUpperCase()} · 固定` : row.profile.resolutions.map(s => s === "auto" ? "自动" : s.toUpperCase()).join(" / ") },
            { title: "参考图", render: (_, row) => row.profile.maxReferences === null ? "未设上限" : `≤ ${row.profile.maxReferences} 张` },
            { title: "使用", width: 64, align: "center", render: (_, row) => <PresetUsage usedBy={row.usedBy} /> },
            { title: "操作", render: (_, row) => <div className="flex gap-1"><Button type="text" icon={<Pencil size={14} />} onClick={() => edit(row)}>编辑</Button><Button type="text" aria-label={`复制 ${row.label}`} icon={<Copy size={14} />} onClick={() => edit(row, true)} /><Button type="text" danger aria-label={`删除 ${row.label}`} icon={<Trash2 size={14} />} onClick={() => remove(row)} /></div> },
        ]} />
        <Modal title={editing ? "编辑图片参数预设" : "新增图片参数预设"} open={open} onCancel={() => { if (!saving) setOpen(false); }} onOk={() => void save()} confirmLoading={saving} width={820} destroyOnHidden>
            <Form form={form} layout="vertical" disabled={saving} className="mt-4">
                <div className="grid gap-x-4 sm:grid-cols-2">
                    <Form.Item name="label" label="预设名称" rules={required}><Input /></Form.Item>
                    <Form.Item name={["profile", "family"]} label="调用类型" rules={required} extra="被模型引用后不能更换类型。"><Select options={imageModelTypes.map(value => ({ value, label: imageModelTypeLabels[value] }))} /></Form.Item>
                    <Form.Item name={["profile", "qualities"]} label="允许的画质" extra="留空时不展示画质选择；输入实际接口值后回车。"><Select mode="tags" options={["auto", "max", "xhigh", "high", "medium", "low"].map(value => ({ value, label: value }))} /></Form.Item>
                    <Form.Item name={["profile", "defaults", "quality"]} label="默认画质" rules={required}><Select showSearch options={(profile.qualities?.length ? profile.qualities : ["auto"]).map(value => ({ value, label: value }))} /></Form.Item>
                    <Form.Item name={["profile", "resolutions"]} label="允许的分辨率" rules={required}><Select mode="multiple" options={scales} /></Form.Item>
                    <Form.Item name={["profile", "fixedResolution"]} label="固定分辨率（可选）" extra="用于由模型决定分辨率的型号，前台展示该值并锁定选择。"><Select allowClear options={scales} /></Form.Item>
                    <Form.Item name={["profile", "ratios"]} label="允许的画幅" rules={required} extra="支持小数比例，例如 19.5:9；自动填写 auto。"><Select mode="tags" options={["1:1", "2:3", "3:2", "4:3", "3:4", "4:5", "16:9", "9:16", "21:9", "9:21", "auto"].map(value => ({ value, label: value }))} /></Form.Item>
                    <Form.Item name={["profile", "maxReferences"]} label="参考图片上限" extra="0 为不支持，留空为未设上限。"><InputNumber min={0} precision={0} className="!w-full" /></Form.Item>
                    <Form.Item name={["profile", "defaults", "size"]} label="默认尺寸 / 画幅" rules={required} extra="填写 auto、1024x1024 或 16:9 等实际值。"><Input /></Form.Item>
                    <Form.Item name={["profile", "defaults", "background"]} label="默认背景"><Select options={[{ value: "", label: "默认背景" }, { value: "transparent", label: "透明" }]} /></Form.Item>
                    {flags.map(([key, label]) => <Form.Item key={key} name={["profile", key]} label={label} valuePropName="checked" extra={key === "omitResponseFormat" ? "GPT Image 等拒绝该字段的模型应开启；响应读取仍支持 URL 与 base64。" : undefined}><Switch /></Form.Item>)}
                </div>
                <Collapse ghost items={[
                    { key: "bounds", label: "像素尺寸边界", forceRender: true, children: <div className="grid gap-x-4 sm:grid-cols-3">{bounds.map(([key, label]) => <Form.Item key={key} name={["profile", "pixelBounds", key]} label={label} rules={required}><InputNumber min={1} precision={key === "maxRatio" ? undefined : 0} className="!w-full" /></Form.Item>)}</div> },
                    { key: "sizes", label: "分辨率与画幅的像素尺寸表", forceRender: true, children: <><p className="mb-3 text-xs text-muted-foreground">用于档位选择、比例转尺寸及历史尺寸识别。像素尺寸模式下，每个允许的档位与画幅组合均需有映射。</p><Form.List name="sizeRows">{(fields, { add, remove }) => <><div className="max-h-80 overflow-auto pr-2">{fields.map(field => <div key={field.key} className="grid grid-cols-2 gap-x-2 sm:grid-cols-[80px_1fr_1fr_60px]"><Form.Item name={[field.name, "scale"]} rules={required}><Select aria-label="尺寸表档位" options={scales.filter(s => s.value !== "auto")} /></Form.Item><Form.Item name={[field.name, "ratio"]} rules={required}><Input aria-label="尺寸表画幅" placeholder="16:9" /></Form.Item><Form.Item name={[field.name, "size"]} rules={required}><Input aria-label="尺寸表像素尺寸" placeholder="1536x864" /></Form.Item><Button type="text" danger onClick={() => remove(field.name)}>移除</Button></div>)}</div><Button type="dashed" onClick={() => add({ scale: "1k" })} icon={<Plus size={14} />}>添加尺寸映射</Button></>}</Form.List></> },
                ]} />
                <p className="mt-4 text-xs text-muted-foreground">保存会影响所有引用此预设的模型及新提交。尺寸边界、默认值和选项必须一致；调用字段及端点按调用类型转换。</p>
            </Form>
        </Modal>
    </div></main>;
}
