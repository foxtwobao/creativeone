import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, DatePicker, Descriptions, Drawer, Empty, Form, Image, Input, Pagination, Select, Table, Tag } from "antd";
import type { Dayjs } from "dayjs";
import { cloudSession } from "@/services/api/cloud";
import { fetchAdminTask, fetchAdminTasks, fetchAdminUsers } from "@/services/api/admin-tasks";
import type { AdminTask } from "../../../../../shared/admin-tasks";
import { taskLabels } from "../../../../../shared/works";
import { TaskMedia } from "./components/task-media";

const statuses: Record<string, string> = { ...taskLabels, pending: "等待生成", running: "生成中", unknown: "结果未知" };
const statusTag = (status: string) => <Tag color={status === "failed" ? "error" : status === "unknown" ? "warning" : ["pending", "running"].includes(status) ? "processing" : "default"}>{statuses[status] || status}</Tag>;
const formatTime = (value: string) => new Date(value).toLocaleString("zh-CN");
type Filters = { user?: { value: string }; range?: [Dayjs, Dayjs]; status?: string; capability?: string; taskId?: string };

export default function AdminTasksPage() {
    const [form] = Form.useForm<Filters>();
    const [filters, setFilters] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [userKeyword, setUserKeyword] = useState("");
    const [userPage, setUserPage] = useState(1);
    const [usersOpen, setUsersOpen] = useState(false);
    const [taskId, setTaskId] = useState<string>();
    const accountId = cloudSession?.user.id;
    const admin = Boolean(cloudSession?.user.admin);
    const users = useQuery({ queryKey: ["admin-users", accountId, userKeyword, userPage], enabled: admin && usersOpen,
        queryFn: ({ signal }) => fetchAdminUsers(userKeyword, userPage, signal) });
    const tasks = useQuery({ queryKey: ["admin-tasks", accountId, filters, page, pageSize], enabled: admin,
        queryFn: ({ signal }) => fetchAdminTasks(new URLSearchParams(`${filters}&page=${page}&pageSize=${pageSize}`), signal), refetchOnMount: "always" });
    const detail = useQuery({ queryKey: ["admin-task", accountId, taskId], enabled: admin && Boolean(taskId),
        queryFn: ({ signal }) => fetchAdminTask(taskId!, signal), refetchOnMount: "always" });
    const task = detail.data?.task;
    const applyFilters = (values: Filters) => {
        const query = new URLSearchParams();
        if (values.user) query.set("userId", values.user.value);
        if (values.status) query.set("status", values.status);
        if (values.capability) query.set("capability", values.capability);
        if (values.taskId?.trim()) query.set("taskId", values.taskId.trim());
        if (values.range?.[0] && values.range[1]) {
            query.set("from", values.range[0].startOf("day").toISOString());
            query.set("to", values.range[1].add(1, "day").startOf("day").toISOString());
        }
        setFilters(query.toString()); setPage(1);
    };
    if (!admin) return <div className="p-6"><Alert type="error" title="只有管理员可以查询用户任务" /></div>;
    return <main className="h-full overflow-auto bg-background p-4 sm:p-6"><div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="text-xl font-semibold">用户任务</h1><p className="mt-1 text-sm text-muted-foreground">查询工作台与画布的图片、视频任务，查看生成成果与失败原因。</p></div>
            <Button loading={tasks.isFetching} onClick={() => void tasks.refetch()}>刷新列表</Button>
        </div>
        <Form form={form} layout="vertical" onFinish={applyFilters}>
            <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
                <Form.Item name="user" label="用户">
                    <Select labelInValue showSearch allowClear filterOption={false} placeholder="搜索用户名、邮箱或用户 ID" loading={users.isFetching}
                        onOpenChange={setUsersOpen} onSearch={(keyword) => { setUserKeyword(keyword); setUserPage(1); }}
                        options={(users.data?.users || []).map((user) => ({ value: user.id, label: `${user.displayName || user.username} · ${user.email}` }))}
                        notFoundContent={users.isFetching ? "正在加载…" : users.error ? "用户查询失败" : "暂无匹配用户"}
                        popupRender={(menu) => <>{menu}{users.error ? <div className="p-2"><Button size="small" onClick={() => void users.refetch()}>重试查询用户</Button></div> : null}
                            {(users.data?.total || 0) > 10 ? <div className="p-2" onMouseDown={(event) => event.preventDefault()}><Pagination size="small" simple current={userPage} pageSize={10} total={users.data?.total} onChange={setUserPage} /></div> : null}</>} />
                </Form.Item>
                <Form.Item name="range" label="创建时间"><DatePicker.RangePicker className="w-full" placeholder={["开始日期", "结束日期"]} /></Form.Item>
                <Form.Item name="taskId" label="任务 ID"><Input allowClear placeholder="本地任务 ID 或上游任务 ID（精确匹配）" /></Form.Item>
                <Form.Item name="capability" label="类型"><Select allowClear placeholder="全部类型" options={[{ value: "image", label: "图片" }, { value: "video", label: "视频" }]} /></Form.Item>
                <Form.Item name="status" label="状态"><Select allowClear placeholder="全部状态" options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} /></Form.Item>
                <div className="flex items-end gap-2 pb-6"><Button type="primary" htmlType="submit">查询</Button><Button onClick={() => { form.resetFields(); setFilters(""); setPage(1); setUserKeyword(""); setUserPage(1); }}>重置</Button></div>
            </div>
        </Form>
        {tasks.error ? <Alert type="error" title={tasks.error.message} action={<Button onClick={() => void tasks.refetch()}>重试</Button>} /> : null}
        <Table<AdminTask> rowKey="id" dataSource={tasks.data?.tasks || []} loading={tasks.isFetching} scroll={{ x: 1100 }}
            pagination={{ current: page, pageSize, total: tasks.data?.total || 0, showSizeChanger: true, showTotal: (total) => `共 ${total} 个任务`, onChange: (nextPage, size) => { setPage(size === pageSize ? nextPage : 1); setPageSize(size); } }}
            locale={{ emptyText: "暂无符合条件的任务" }} columns={[
                { title: "创建时间", width: 180, render: (_, row) => formatTime(row.createdAt) },
                { title: "用户", width: 220, render: (_, row) => <div><p>{row.user.displayName || row.user.username}</p><p className="break-all text-xs text-muted-foreground">{row.user.email}</p></div> },
                { title: "来源", width: 85, render: (_, row) => row.source === "canvas" ? "画布" : "工作台" },
                { title: "类型", width: 70, render: (_, row) => row.capability === "image" ? "图片" : "视频" },
                { title: "模型", dataIndex: "model", width: 180 },
                { title: "提示词", width: 250, render: (_, row) => <p className="line-clamp-2 whitespace-pre-wrap break-words">{row.prompt || "未记录提示词"}</p> },
                { title: "状态", width: 150, render: (_, row) => <div className="space-y-1">{statusTag(row.status)}{row.hiddenFromWorks || row.hiddenFromHistory ? <p className="text-xs text-muted-foreground">用户已移除记录</p> : null}</div> },
                { title: "操作", width: 100, fixed: "right", render: (_, row) => <Button type="link" onClick={() => setTaskId(row.id)}>查看详情</Button> },
            ]} />
        <Drawer title="任务详情" size="large" open={Boolean(taskId)} onClose={() => setTaskId(undefined)} destroyOnHidden loading={detail.isFetching}
            extra={<Button loading={detail.isFetching} onClick={() => void detail.refetch()}>刷新详情</Button>}>
            {detail.error ? <Alert type="error" title={detail.error.message} action={<Button onClick={() => void detail.refetch()}>重试</Button>} /> : task ? <div className="space-y-6">
                <Descriptions size="small" column={1} items={[
                    { key: "user", label: "所属用户", children: `${task.user.displayName || task.user.username} · ${task.user.email}` },
                    { key: "userId", label: "用户 ID", children: task.user.id },
                    { key: "status", label: "状态", children: statusTag(task.status) },
                    { key: "model", label: "模型", children: task.model },
                    { key: "source", label: "来源", children: task.source === "canvas" ? `画布 · ${task.canvasTitle || "画布已删除"}` : "工作台" },
                    { key: "createdAt", label: "创建时间", children: formatTime(task.createdAt) },
                    { key: "updatedAt", label: "更新时间", children: formatTime(task.updatedAt) },
                    { key: "id", label: "本地任务 ID", children: <span className="break-all">{task.id}</span> },
                    { key: "upstreamId", label: "上游任务 ID", children: <span className="break-all">{task.upstreamId || "未取得"}</span> },
                    { key: "visibility", label: "用户移除记录", children: [task.hiddenFromWorks ? "作品列表" : "", task.hiddenFromHistory ? "生成历史" : ""].filter(Boolean).join("、") || "未移除" },
                ]} />
                {task.error ? <Alert type="error" title={task.errorMessage} description={`错误码：${task.error}`} /> : null}
                <section><h2 className="mb-2 font-medium">生成提示词</h2><p className="whitespace-pre-wrap break-words text-sm">{task.prompt || "此任务未记录提示词"}</p></section>
                {task.sentPrompt && task.sentPrompt !== task.prompt ? <details className="text-sm"><summary>实际发送的提示词</summary><p className="mt-2 whitespace-pre-wrap break-words">{task.sentPrompt}</p></details> : null}
                <section><h2 className="mb-2 font-medium">生成参数</h2>{task.settings.length ? <Descriptions size="small" column={2} items={task.settings} /> : <p className="text-sm text-muted-foreground">未记录其他参数</p>}</section>
                {task.references.length ? <section><h2 className="mb-3 font-medium">参考素材</h2><Image.PreviewGroup><div className="grid gap-4 sm:grid-cols-2">{task.references.map((media, index) => <TaskMedia key={`${task.id}:ref:${index}:${media.url}`} media={media} index={index} />)}</div></Image.PreviewGroup></section> : null}
                <section><h2 className="mb-3 font-medium">生成成果{task.results.length ? ` · ${task.results.length}` : ""}</h2>
                    {task.results.length ? <Image.PreviewGroup><div className={task.capability === "image" ? "grid gap-4 sm:grid-cols-2" : "space-y-4"}>{task.results.map((media, index) => <TaskMedia key={`${task.id}:result:${index}:${media.url}`} media={media} index={index} />)}</div></Image.PreviewGroup> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无生成成果" />}
                </section>
            </div> : null}
        </Drawer>
    </div></main>;
}
