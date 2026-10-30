import { useEffect,useState } from "react";
import { Alert,App,Button,Collapse,Form,InputNumber,Spin,Switch } from "antd";
import { Bot,RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { cloudSession } from "@/services/api/cloud";
import { getAdminAgentSettings,saveAdminAgentSettings } from "@/services/api/admin-agent";
import { useServerAgentStore } from "@/stores/canvas/use-server-agent-store";
import { agentSettingsDefaults,type AgentSettings,type AgentSettingsRecord } from "../../../../../shared/agent-settings";

const fields:Array<{key:Exclude<keyof AgentSettings,"enabled">;label:string;help:string}>=[
    {key:"globalConcurrency",label:"全局执行并发",help:"同时执行的助手运行数量；降低后等待已有运行完成或暂停，不中断在途请求。"},
    {key:"accountConcurrency",label:"单账号执行并发",help:"同一账号可同时执行的助手运行数量，不能超过全局并发。"},
    {key:"decisionBudget",label:"每段模型调用次数",help:"达到此次数时暂停询问继续，摘要调用也计数；累计 token 只统计，不触发暂停。"},
    {key:"modelRetries",label:"文本推理最大重试次数",help:"每次推理或摘要请求分别应用此上限，临时 HTTP 错误与断流共用额度；0 关闭。重试计入调用预算，可能计费；2 秒起退避，总等待期限不增加。"},
    {key:"contextTokens",label:"压缩触发量（token）",help:"估算输入达到此值时压缩历史；它不是模型窗口大小声明。"},
    {key:"recentContextTokens",label:"近期保留预算（token）",help:"保留近期完整轮次与工具回执，原始历史始终保留。"},
    {key:"summaryTokens",label:"摘要预算（token）",help:"限制摘要长度；近期保留量与摘要预算之和必须小于压缩触发量。"},
    {key:"inputCharacters",label:"目标与文本附件上限（字符）",help:"超过时提示缩小输入，不自动截断。"},
    {key:"outputTokens",label:"单次输出上限（token）",help:"留空遵循上游默认额度，包含思考、回复及工具参数；截断时不执行不完整工具，不自动重试。"},
    {key:"nodeBatch",label:"单次工具节点上限",help:"配置和输出分别计数；超过时拒绝整批，要求缩小。"},
    {key:"mediaBatch",label:"单批生成请求上限",help:"覆盖独立文本及媒体生成，每批仍须用户确认，超出不自动拆批生成。"},
    {key:"requestTimeoutMs",label:"决策与摘要等待（毫秒）",help:"仅助手推理及其全部重试的总期限；超出后停止，结果不明记为 unknown。不改变独立生成任务的超时。"},
    {key:"scanIntervalMs",label:"后台扫描间隔（毫秒）",help:"下次扫描循环生效；网页关闭后后台仍可执行，结果未知的请求不会重发。"},
    {key:"pollIntervalMs",label:"前台活动查询间隔（毫秒）",help:"仅有活动任务时查询，页面隐藏时暂停；现有页面刷新配置后生效。"},
];
const labels:Record<string,string>=Object.fromEntries(fields.map(field=>[field.key,field.label]));
const display=(value:unknown)=>value===null?"上游默认":typeof value==="boolean"?value?"开启":"关闭":Number(value).toLocaleString("zh-CN");

export default function AdminAgentPage(){
    const {message,modal}=App.useApp(),[form]=Form.useForm<AgentSettings>();
    const [saved,setSaved]=useState<AgentSettingsRecord>(),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
    const load=async()=>{setLoading(true);try{const {settings}=await getAdminAgentSettings();setSaved(settings);form.setFieldsValue(settings);setError("");}catch(error){setError((error as Error).message);}finally{setLoading(false);}};
    useEffect(()=>{if(cloudSession?.user.admin)void load();},[]);
    if(!cloudSession?.user.admin)return <div className="p-6"><Alert type="error" title="只有管理员可以配置创作助手"/></div>;
    const submit=async()=>{
        const values=await form.validateFields().catch(()=>null);if(!values||!saved)return;
        const next={...values,outputTokens:values.outputTokens??null},changed=(Object.keys(agentSettingsDefaults) as Array<keyof AgentSettings>).filter(key=>next[key]!==saved[key]);
        if(!changed.length){message.info("没有需要保存的修改");return;}
        modal.confirm({title:"保存创作助手配置？",okText:"确认保存",cancelText:"继续编辑",content:<div className="space-y-3 text-sm"><ul className="space-y-1">{changed.map(key=><li key={key}>{labels[key]||"开放创作助手"}：{display(saved[key])} → {display(next[key])}</li>)}</ul><p>并发调整影响后续调度；降低并发不会中断在途请求。预算、输入和等待边界由新运行采用，已有运行保留快照。关闭助手停止后续步骤，已受理生成任务继续；已有等待仍需原用户处理。</p></div>,onOk:async()=>{
            setSaving(true);try{const {settings}=await saveAdminAgentSettings({...next,revision:saved.revision});setSaved(settings);form.setFieldsValue(settings);setError("");message.success("助手配置已保存");void useServerAgentStore.getState().loadConfig().catch(()=>message.warning("配置已保存，请刷新页面更新助手入口。"));}catch(error){setError((error as Error).message);message.error((error as Error).message);throw error;}finally{setSaving(false);}
        }});
    };
    const controls=(items:typeof fields)=><div className="grid gap-x-8 sm:grid-cols-2">{items.map(field=><Form.Item key={field.key} name={field.key} label={field.label} extra={<span>{field.help} 默认：{display(agentSettingsDefaults[field.key])}。</span>} dependencies={field.key==="accountConcurrency"?["globalConcurrency"]:field.key==="contextTokens"?["recentContextTokens","summaryTokens"]:[]} rules={[{required:field.key!=="outputTokens",type:"number",min:field.key==="modelRetries"?0:1,message:field.key==="modelRetries"?"请填写大于等于 0 的整数":"请填写大于 0 的整数"},({getFieldValue})=>({validator:(_,value)=>field.key==="accountConcurrency"&&value>getFieldValue("globalConcurrency")?Promise.reject(new Error("单账号并发不能超过全局并发")):field.key==="contextTokens"&&value<=getFieldValue("recentContextTokens")+getFieldValue("summaryTokens")?Promise.reject(new Error("触发量必须大于近期保留量与摘要预算之和")):Promise.resolve()})]}><InputNumber className="!w-full" aria-label={field.label} min={field.key==="modelRetries"?0:1} precision={0} placeholder={field.key==="outputTokens"?"上游默认":undefined}/></Form.Item>)}</div>;
    return <main className="h-full overflow-auto bg-background p-4 text-foreground sm:p-6"><div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-start justify-between gap-4"><div><h1 className="flex items-center gap-2 text-xl font-semibold"><Bot size={22}/>创作助手配置</h1><p className="mt-2 text-sm text-muted-foreground">统一管理开放范围与执行预算，按账号授权调用模型。</p></div><Button type="text" icon={<RefreshCw size={15}/>} disabled={saving} loading={loading} onClick={()=>void load()}>重新加载</Button></header>
        {error?<Alert type="error" title={error} description="未保存的表单内容保留；配置冲突时请重新加载后再修改。"/>:null}
        {loading&&!saved?<Spin/>:<Form form={form} layout="vertical" disabled={saving||loading||!saved}>
            <section className="border-b border-border pb-4"><h2 className="mb-4 text-base font-medium">启用与模型</h2><Form.Item name="enabled" label="开放创作助手" valuePropName="checked" extra="关闭后不再启动助手新步骤；在途请求可完成保存，已受理的独立生成任务继续。"><Switch aria-label="开放创作助手"/></Form.Item><p className="text-sm leading-6 text-muted-foreground">在 <Link className="underline underline-offset-4" to="/admin/channels">功能模型配置</Link> 中逐个标记“允许创作助手调用”，文本模型另行配置图片理解。仅启用已验收的能力，不按型号名称推断，也不会自动发起模型探测。</p></section>
            <section className="border-b border-border pt-5"><h2 className="mb-4 text-base font-medium">执行并发</h2>{controls(fields.slice(0,2))}</section>
            <section className="pt-5"><h2 className="mb-4 text-base font-medium">调用与上下文预算</h2>{controls(fields.slice(2,7))}</section>
            <Collapse className="mt-2" items={[{key:"advanced",label:"其他运行边界",forceRender:true,children:controls(fields.slice(7))}]}/>
            <footer className="sticky bottom-0 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-4"><p className="text-xs leading-5 text-muted-foreground">保存前确认具体变更。历史、已生成作品和既有运行快照保留。</p><Button type="primary" loading={saving} disabled={!saved||loading} onClick={()=>void submit()}>保存配置</Button></footer>
        </Form>}
    </div></main>;
}
