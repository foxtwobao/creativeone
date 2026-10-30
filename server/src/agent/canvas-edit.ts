import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import dagre from "@dagrejs/dagre";
import { z } from "zod";
import { findCanvasProject } from "../business.js";
import { HttpError } from "../http.js";
import { applyGroupSelection, applyUngroupSelection, collectGroupMemberNodes, getGroupWrapRect, nodeBounds } from "../../../shared/canvas-groups.js";
import { command, digest, getNode, setState, sourceHash, type Client, type Run } from "./state.js";

const ids=z.array(z.string().min(1)).min(1);
export const canvasToolSchemas={
    read_connections:z.object({nodeIds:ids,direction:z.enum(["upstream","downstream","both"]).default("both")}).strict(),
    rename_nodes:z.object({nodes:z.array(z.object({nodeId:z.string().min(1),title:z.string().trim().min(1)}).strict()).min(1)}).strict(),
    delete_nodes:z.object({nodeIds:ids}).strict(),
    delete_connections:z.object({connectionIds:ids}).strict(),
    create_group:z.object({nodeIds:ids,title:z.string().trim().min(1)}).strict(),
    ungroup_nodes:z.object({nodeIds:ids}).strict(),
    arrange_nodes:z.object({nodeIds:ids.optional()}).strict(),
    move_nodes:z.object({nodes:z.array(z.object({nodeId:z.string().min(1),x:z.number().finite(),y:z.number().finite()}).strict()).min(1)}).strict(),
    resize_node:z.object({nodeId:z.string().min(1),width:z.number().finite().positive(),height:z.number().finite().positive(),freeResize:z.boolean().optional()}).strict(),
    update_text_node:z.object({nodeId:z.string().min(1),title:z.string().trim().min(1).optional(),content:z.string().min(1)}).strict(),
};
export const canvasToolDescriptions={read_connections:"读取节点的直接上游、下游及真实连线 ID。",rename_nodes:"只修改已读取节点的标题，不覆盖正文或作品。",delete_nodes:"预览删除指定节点和相关连线，等待用户确认；删除分组只释放成员，不删除成员或后台任务。",delete_connections:"预览删除真实连线并等待用户确认，不删除节点。",create_group:"按现有画布分组规则包装指定节点，复用已有相同成员分组；不生成内容。",ungroup_nodes:"取消指定分组或释放指定成员，保留正文与作品。",arrange_nodes:"预览指定节点布局；省略范围时排列顶层节点，分组和成员整体移动，等待用户确认。不改变尺寸、内容、连线或任务。",move_nodes:"按指定绝对坐标移动已读取节点；分组连同成员移动，预览后确认。",resize_node:"调整已读取节点尺寸，图片默认保持原比例，自由变形必须明确传 freeResize=true；预览后确认。",update_text_node:"专门修改用户已有普通文本或剧本，必须先读取当前正文；展示修改前后全文并等待用户确认。不能覆盖已提交任务、生成作品或正在生成的文本。助手自己的未提交草稿优先使用 create_text_nodes.nodeId 原位修改。"};
const graphHash=(project:any) => digest({nodes:project.nodes,connections:project.connections});

const nodeSummary=(node:any) => ({id:node.entityId || node.id,type:node.type,title:node.title});
const edgeSummary=(project:any,edge:any) => ({id:edge.entityId || edge.id,fromTitle:getNode(project,edge.fromNodeId).title,toTitle:getNode(project,edge.toNodeId).title,fromNodeId:nodeSummary(getNode(project,edge.fromNodeId)).id,toNodeId:nodeSummary(getNode(project,edge.toNodeId)).id});
const key=(entity:any) => entity.entityId || entity.id;
function delta(project:any,nodes:any[],connections=project.connections) {
    return [
        ...nodes.filter(node => !isDeepStrictEqual(node,project.nodes.find((old:any) => old.id === node.id))).map(node => ({type:"put_node",node})),
        ...project.nodes.filter((node:any) => !nodes.some(next => next.id === node.id)).map((node:any) => ({type:"delete_node",id:node.id})),
        ...project.connections.filter((edge:any) => !connections.some((next:any) => next.id === edge.id)).map((edge:any) => ({type:"delete_connection",id:edge.id})),
    ];
}
function groupSubset(project:any,ids:Set<string>) {
    const related=new Set([...ids,...project.nodes.filter((node:any) => ids.has(node.id)).map((node:any) => node.metadata?.groupId).filter(Boolean)]);
    return project.nodes.filter((node:any) => related.has(node.id) || related.has(node.metadata?.groupId));
}
export async function canvasEditManifest(client:Client,run:Run,name:string,input:any) {
    const project=await findCanvasProject(run.user_id,run.project_id,client,true);
    let edits:any[]=[],reused:any[]=[];
    if (name === "rename_nodes") edits=input.nodes.map((entry:any) => ({type:"put_node",node:{...getNode(project,entry.nodeId),title:entry.title}}));
    if (name === "update_text_node") {
        const node=getNode(project,input.nodeId),metadata=node.metadata || {};
        if (node.type !== "text" || metadata.generationId || metadata.generationTaskId || metadata.storageKey || metadata.texts?.some((text:any)=>text.generationId || text.generationTaskId)) throw new HttpError(409,"AGENT_NODE_NOT_EDITABLE");
        edits=[{type:"put_node",node:{...node,title:input.title || node.title,metadata:{...metadata,content:input.content,prompt:input.content}}}];
    }
    if (name === "move_nodes") {
        const moves=new Map(input.nodes.map((entry:any)=>{const node=getNode(project,entry.nodeId);return [node.id,{x:entry.x-node.position.x,y:entry.y-node.position.y}];}));
        edits=project.nodes.flatMap((node:any)=>{
            let current=node,offset:any=moves.get(node.id);const visited=new Set();
            while (current.metadata?.groupId) {if (visited.has(current.id)) throw new HttpError(409,"INVALID_CANVAS_GRAPH");visited.add(current.id);current=getNode(project,current.metadata.groupId);if(moves.has(current.id)){if(offset)throw new HttpError(400,"AGENT_GROUP_INVALID");offset=moves.get(current.id);}}
            return offset ? [{type:"put_node",node:{...node,position:{x:node.position.x+offset.x,y:node.position.y+offset.y}}}] : [];
        });
    }
    if (name === "resize_node") {
        const node=getNode(project,input.nodeId),ratio=(node.metadata?.naturalWidth || node.width)/(node.metadata?.naturalHeight || node.height);
        if (node.type === "group") throw new HttpError(400,"AGENT_GROUP_INVALID");
        edits=[{type:"put_node",node:{...node,width:input.width,height:node.type === "image" && !input.freeResize ? input.width/ratio : input.height,metadata:{...node.metadata,...node.type === "image" ? {freeResize:Boolean(input.freeResize)} : {}}}}];
    }
    if (["move_nodes","resize_node"].includes(name)) {
        const next=structuredClone(project.nodes).map((node:any)=>edits.find(edit=>edit.node?.id===node.id)?.node || node);
        for (let pass=0;pass<next.length;pass++) {
            let changed=false;
            for (const group of next.filter((node:any)=>node.type === "group")) {
                const members=next.filter((node:any)=>node.metadata?.groupId === group.id);if(!members.length)continue;
                const bounds=getGroupWrapRect(members),replacement={...group,position:{x:bounds.x,y:bounds.y},width:bounds.width,height:bounds.height};
                if(isDeepStrictEqual(group,replacement))continue;
                Object.assign(group,replacement);edits=edits.filter(edit=>edit.node?.id!==group.id).concat({type:"put_node",node:replacement});changed=true;
            }
            if(!changed)break;
        }
    }
    if (name === "delete_nodes") {
        const removed=new Set(input.nodeIds.map((id:string) => getNode(project,id).id));
        edits=delta(project,project.nodes.filter((node:any) => !removed.has(node.id)).map((node:any) => removed.has(node.metadata?.groupId) ? {...node,metadata:{...node.metadata,groupId:undefined}} : node),project.connections.filter((edge:any) => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)));
    }
    if (name === "delete_connections") edits=[...new Set(input.connectionIds)].map(id => {const edge=project.connections.find((edge:any) => edge.id === id || edge.entityId === id);if (!edge) throw new HttpError(404,"AGENT_CONNECTION_NOT_FOUND");return {type:"delete_connection",id:edge.id};});
    if (["create_group","ungroup_nodes"].includes(name)) {
        const selected=new Set<string>(input.nodeIds.map((id:string) => getNode(project,id).id)),subset=groupSubset(project,selected);
        if (name === "create_group") {
            const members=collectGroupMemberNodes(selected,subset);
            if (!members.length || members.length === 1) throw new HttpError(400,"AGENT_GROUP_INVALID");
            const parent=members[0].metadata?.groupId;
            if (parent && members.every(node => node.metadata?.groupId === parent) && project.nodes.filter((node:any) => node.metadata?.groupId === parent).length === members.length) reused=[getNode(project,parent)];
            else {
                const rect=getGroupWrapRect(members),group={id:randomUUID(),type:"group",title:input.title,position:{x:rect.x,y:rect.y},width:rect.width,height:rect.height,metadata:{}};
                const result=applyGroupSelection(selected,subset,project.connections,group as any)!;
                edits=delta(project,[...project.nodes.filter((node:any) => !subset.includes(node)),...result.nodes],result.connections);
            }
        } else {
            const result=applyUngroupSelection(selected,subset,project.connections);
            if (result) edits=delta(project,[...project.nodes.filter((node:any) => !subset.includes(node)),...result.nodes],result.connections);
        }
    }
    if (name === "arrange_nodes") {
        const root=(node:any):any => {const seen=new Set<string>();while (node.metadata?.groupId) {if (seen.has(node.id)) throw new HttpError(409,"INVALID_CANVAS_GRAPH");seen.add(node.id);node=getNode(project,node.metadata.groupId);}return node;};
        const targets=input.nodeIds ? input.nodeIds.map((id:string) => root(getNode(project,id))) : project.nodes.filter((node:any) => !node.metadata?.groupId);
        const roots=[...new Map<string,any>(targets.map((node:any) => [node.id,node])).values()];
        if (roots.length) {
            const graph=new dagre.graphlib.Graph().setGraph({rankdir:"LR"}).setDefaultEdgeLabel(() => ({}));
            for (const node of roots) graph.setNode(node.id,{width:node.width,height:node.height});
            for (const edge of project.connections) {const from=root(getNode(project,edge.fromNodeId)).id,to=root(getNode(project,edge.toNodeId)).id;if (from !== to && graph.hasNode(from) && graph.hasNode(to)) graph.setEdge(from,to);}
            dagre.layout(graph);const bounds=nodeBounds(roots);
            const offsets=new Map(roots.map(node => {const point=graph.node(node.id);return [node.id,{x:bounds.left+point.x-node.width/2-node.position.x,y:bounds.top+point.y-node.height/2-node.position.y}];}));
            edits=project.nodes.flatMap((node:any) => {const offset=offsets.get(root(node).id);return offset ? [{type:"put_node",node:{...node,position:{x:node.position.x+offset.x,y:node.position.y+offset.y}}}] : [];});
        }
    }
    // Layouts and graph edits cannot implicitly refresh an unread or changed target.
    const existing=project.nodes.filter((node:any) => edits.some(edit => edit.type === "put_node" ? edit.node.id === node.id : edit.type === "delete_node" && edit.id === node.id));
    if (existing.some((node:any) => run.sources[node.id] !== sourceHash(node))) throw new HttpError(409,"AGENT_CANVAS_NOT_READ");
    edits=edits.filter(edit => edit.type !== "put_node" || !isDeepStrictEqual(edit.node,project.nodes.find((node:any) => node.id === edit.node.id)));
    const removed=edits.filter(edit => edit.type === "delete_node").map(edit => getNode(project,edit.id));
    return {action:name,beforeHash:graphHash(project),edits,createdIds:edits.filter(edit => edit.type === "put_node" && !project.nodes.some((node:any) => node.id === edit.node.id)).map(edit => edit.node.id),nodes:existing.map((node:any) => ({...nodeSummary(node),change:removed.includes(node) ? "删除" : name === "rename_nodes" ? "改名" : ["arrange_nodes","move_nodes"].includes(name) ? "移动" : name === "resize_node" ? "调整尺寸" : name === "update_text_node" ? "修改正文" : "调整分组",nextTitle:edits.find(edit => edit.node?.id === node.id)?.node.title,position:node.position,nextPosition:edits.find(edit => edit.node?.id === node.id)?.node.position,...name === "update_text_node" ? {beforeContent:node.metadata?.content || "",nextContent:input.content} : {},...name === "resize_node" ? {beforeSize:{width:node.width,height:node.height},nextSize:{width:edits[0]?.node.width,height:edits[0]?.node.height}} : {}})),connections:edits.filter(edit => edit.type === "delete_connection").map(edit => edgeSummary(project,project.connections.find((edge:any) => edge.id === edit.id))),reusedNodeIds:reused.map(key)};
}
export async function assertCanvasManifest(client:Client,run:Run,manifest:any) {
    if (graphHash(await findCanvasProject(run.user_id,run.project_id,client,true)) !== manifest.beforeHash) throw new HttpError(409,"AGENT_CONFIRMATION_CHANGED");
}
export async function executeCanvasTool(client:Client,run:Run,call:any) {
    const input=canvasToolSchemas[call.toolName as keyof typeof canvasToolSchemas].parse(call.input);
    if (call.toolName === "read_connections") {
        const project=await findCanvasProject(run.user_id,run.project_id,client),selection=new Set((input as any).nodeIds.map((id:string) => getNode(project,id).id));
        const connections=project.connections.filter((edge:any) => ((input as any).direction !== "downstream" && selection.has(edge.toNodeId)) || ((input as any).direction !== "upstream" && selection.has(edge.fromNodeId)));
        return {connections:connections.map((edge:any) => edgeSummary(project,edge)),nodes:project.nodes.filter((node:any) => connections.some((edge:any) => edge.fromNodeId === node.id || edge.toNodeId === node.id)).map(nodeSummary)};
    }
    const approved=run.wait?.type === "canvas_edit" && run.wait.callId === call.toolCallId && run.wait.approved;
    const manifest=approved ? run.wait.manifest : await canvasEditManifest(client,run,call.toolName,input);
    if (!approved && ["delete_nodes","delete_connections","arrange_nodes","move_nodes","resize_node","update_text_node"].includes(call.toolName) && manifest.edits.length) {await setState(client,run,"waiting_confirmation",{type:"canvas_edit",callId:call.toolCallId,manifest});return undefined;}
    if (approved) await assertCanvasManifest(client,run,manifest);
    const project=manifest.edits.length ? await command(client,run,call.toolCallId,manifest.edits) : await findCanvasProject(run.user_id,run.project_id,client);
    const touched=manifest.edits.filter((edit:any) => edit.type === "put_node").map((edit:any) => getNode(project,edit.node.id));
    const remaining=Object.fromEntries(Object.entries(run.sources).filter(([id]) => project.nodes.some((node:any) => node.id === id)));
    const sources={...remaining,...Object.fromEntries(touched.filter((node:any) => run.sources[node.id]).map((node:any) => [node.id,sourceHash(node)]))};
    await client.query("UPDATE agent_runs SET sources=$2,wait=NULL WHERE id=$1",[run.id,JSON.stringify(sources)]);
    const createdNodeIds=manifest.createdIds.map((id:string) => key(getNode(project,id)));
    return {nodes:[...touched,...manifest.reusedNodeIds.map((id:string) => getNode(project,id))].map(nodeSummary),createdNodeIds,deletedNodeIds:manifest.nodes.filter((node:any) => node.change === "删除").map((node:any) => node.id),reusedNodeIds:manifest.reusedNodeIds,updatedNodeIds:touched.map(key).filter((id:string) => !createdNodeIds.includes(id)),connections:manifest.connections};
}
