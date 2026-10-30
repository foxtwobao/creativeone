import type { AgentThread } from "@/services/api/server-agent";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export const agentToolErrorMessage=(result:any)=>result.error==="AGENT_IMAGE_UNSUPPORTED"?"该次读取时，推理模型未启用图片理解，未提供画面内容。":result.message||"此步未完成，请检查当前输入。";

export const nodeLabels:Record<string,string>={group:"分组",config:"配置",video:"视频",image:"图片",audio:"音频",text:"文本"};
export const actions:Record<string,string>={read_connections:"读取连线关系",rename_nodes:"修改标题",delete_nodes:"删除节点",delete_connections:"移除连线",create_group:"创建分组",ungroup_nodes:"取消分组",arrange_nodes:"整理布局",set_agent_state:"保存创作进度",read_agent_state:"读取创作进度",read_skill_file:"读取规则附属文件",load_skill:"加载创作规则",read_canvas:"读取画布",find_nodes:"查找节点",read_nodes:"读取节点",get_model_capabilities:"读取模型能力",create_text_nodes:"保存文本节点",prepare_media_nodes:"准备媒体节点",prepare_text_generation:"准备文本生成",connect_nodes:"建立连线",submit_generation:"提交生成任务",read_task_results:"读取任务结果",wait_for_tasks:"等待生成任务",request_user_input:"等待用户补充"};
Object.assign(actions,{get_browser_actions:"读取浏览器回执",canvas_export_snapshot:"读取布局快照",create_asset_nodes:"添加素材节点",create_primary_script_node:"保存主剧本",create_attachment_nodes:"添加附件节点",update_text_node:"修改已有正文",move_nodes:"移动节点",resize_node:"调整节点尺寸",select_nodes:"选择节点",set_viewport:"调整画布视口",site_navigate:"打开页面",canvas_list_projects:"查找画布",read_project:"读取画布",prompts_search:"搜索提示词",assets_list:"查找素材",assets_add:"保存素材",workbench_image_get_config:"读取图片工作台",workbench_video_get_config:"读取视频工作台",workbench_image_generate:"图片工作台创作",workbench_video_generate:"视频工作台创作"});
export type AgentEntry=AgentThread["items"][number];
type TimelineEntry={type:"message";item:AgentEntry}|{type:"tools";items:AgentEntry[]};
export type CanvasReference={label:string;nodeId:string;description?:string};
const uuid=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function agentTimeline(items:AgentEntry[]) {
    const timeline:TimelineEntry[]=[];
    for(const item of items) {
        if(item.role==="assistant"&&!item.text.trim())continue;
        const previous=timeline.at(-1);
        if(item.role==="tool") {
            if(previous?.type==="tools"&&previous.items[0].threadId===item.threadId&&previous.items[0].turnId===item.turnId)previous.items.push(item);
            else timeline.push({type:"tools",items:[item]});
        } else timeline.push({type:"message",item});
    }
    return timeline;
}
export function toolAction(item:AgentEntry) {
    if(item.text==="submit_generation")return item.detail?.result?.declined?"已拒绝本批生成":item.detail?.result?.taskIds?.length?(item.detail.result.reusedTaskIds?.length===item.detail.result.taskIds.length?"复用已有生成任务":"已受理生成任务"):"请求生成确认";
    return actions[item.text]||"工具操作";
}
export function canvasReferences(items:AgentEntry[],nodes:CanvasNodeData[],connections:CanvasConnection[]) {
    const references=new Map<string,CanvasReference>();
    const add=(node:any)=>{if(!node?.id)return;const reference={label:`${nodeLabels[node.type]||"节点"} · ${node.title||"未命名"}`,nodeId:node.id};for(const id of [node.id,node.entityId].filter(Boolean))references.set(id.toLowerCase(),reference);};
    for(const entry of items)for(const node of entry.detail?.result?.nodes||[])add(node);
    for(const node of nodes)add(node);
    const addConnection=(edge:any)=>{const from=references.get(edge.fromNodeId?.toLowerCase()),to=references.get(edge.toNodeId?.toLowerCase());if(!edge.id||!from||!to)return;for(const id of [edge.id,edge.entityId].filter(Boolean))references.set(id.toLowerCase(),{label:"查看连接目标",nodeId:to.nodeId,description:`${from.label} → ${to.label}`});};
    for(const entry of items)for(const edge of entry.detail?.result?.connections||[])addConnection(edge);
    for(const edge of connections)addConnection(edge);
    return references;
}
export const hasCanvasReferences=(text:string,references:Map<string,CanvasReference>)=>Array.from(text.matchAll(uuid)).some(match=>references.has(match[0].toLowerCase()));

// Domain references are transformed after Markdown parsing; links and code blocks stay intact.
export function canvasReferencePlugin(references:Map<string,CanvasReference>) {
    return ()=> (tree:any)=>{
        const replace=(node:any):any[]=>{
            if(["link","linkReference","code"].includes(node.type))return [node];
            if(!["text","inlineCode"].includes(node.type)) {
                if(node.children)node.children=node.children.flatMap(replace);
                return [node];
            }
            if(node.type==="inlineCode"&&!references.has(node.value.toLowerCase()))return [node];
            const parts:any[]=[];let offset=0;
            for(const match of node.value.matchAll(uuid)) {
                const reference=references.get(match[0].toLowerCase());if(!reference)continue;
                if(match.index>offset)parts.push({type:"text",value:node.value.slice(offset,match.index)});
                parts.push({type:"link",url:`#canvas-node=${encodeURIComponent(reference.nodeId)}`,title:reference.description||"定位画布节点",children:[{type:"text",value:reference.label}]});offset=match.index+match[0].length;
            }
            if(!parts.length)return [node];
            if(offset<node.value.length)parts.push({type:"text",value:node.value.slice(offset)});
            return parts;
        };
        tree.children=tree.children.flatMap(replace);
    };
}
