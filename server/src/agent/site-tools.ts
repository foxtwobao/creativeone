import { readAgentConfig } from "./config.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { findCanvasProject } from "../business.js";
import { readAccountData } from "../account-data.js";
import { readAssets, storedFileInfo, addTextOrImageAsset, assertReferenceImages } from "../storage.js";
import { assertVideoDurations } from "../ai.js";
import { HttpError } from "../http.js";
import { modelProvider } from "../tokenone.js";
import { imageRequestCapabilityError, videoRequestCapabilityError } from "../model-capabilities.js";
import { canvasRequestBody } from "../../../shared/canvas-request.js";
import { videoTaskPath } from "../../../shared/video-tasks.js";
import { imageModelProfile } from "../../../shared/image-models.js";
import { videoModelProfile } from "../../../shared/video-models.js";
import { searchPrompts } from "../prompts.js";
import { digest, getNode, setState, type Client, type Run } from "./state.js";

const keyword=z.object({keyword:z.string().optional()}).strict();
const generation=z.object({model:z.string().min(1),prompt:z.string().min(1),count:z.number().int().positive().default(1),run:z.boolean().default(true),references:z.array(z.string()).default([]),parameters:z.object({size:z.string().optional(),quality:z.string().optional(),background:z.string().optional(),videoSize:z.string().optional(),vquality:z.string().optional(),seconds:z.string().regex(/^(?:-1|[1-9]\d*)$/).optional(),videoMode:z.enum(["frames","reference"]).optional(),generateAudio:z.enum(["true","false"]).optional(),watermark:z.enum(["true","false"]).optional()}).strict().default({})}).strict();
export const siteToolSchemas={
    site_navigate:z.object({path:z.string().min(1)}).strict(),
    canvas_list_projects:keyword,
    read_project:z.object({projectId:z.uuid()}).strict(),
    prompts_search:keyword.extend({page:z.number().int().positive().optional(),pageSize:z.number().int().positive().optional(),category:z.string().optional()}),
    assets_list:keyword.extend({kind:z.enum(["all","text","image","video","audio"]).default("all")}),
    assets_add:z.object({nodeId:z.string().min(1).optional(),title:z.string().optional(),content:z.string().min(1).optional(),imageUrl:z.string().min(1).optional(),tags:z.array(z.string()).default([])}).strict().refine(input=>[input.nodeId,input.content,input.imageUrl].filter(Boolean).length===1),
    workbench_image_get_config:z.object({}).strict(),workbench_video_get_config:z.object({}).strict(),
    workbench_image_generate:generation.extend({parameters:generation.shape.parameters.removeDefault().pick({size:true,quality:true,background:true}).default({})}),workbench_video_generate:generation.extend({parameters:generation.shape.parameters.removeDefault().omit({size:true,quality:true,background:true}).default({})}),
    select_nodes:z.object({nodeIds:z.array(z.string().min(1))}).strict(),
    set_viewport:z.object({x:z.number().finite(),y:z.number().finite(),k:z.number().finite().positive()}).strict(),
    get_browser_actions:z.object({ids:z.array(z.uuid()).min(1)}).strict(),
};
export const siteToolDescriptions={get_browser_actions:"读取真实浏览器操作的排队、完成或失败回执，只访问当前账号与本次浏览器。不要循环查询；queued 不能声称已经执行。",site_navigate:"打开本站页面或所属画布；仅向本次提交的浏览器发送导航，不代表浏览器已经执行。",canvas_list_projects:"查询账号自己的画布标题、节点数量和更新时间，不读取其他账号。",read_project:"只读账号其他画布的节点正文和连线；修改前先导航到该画布并在其会话发起新目标。",prompts_search:"使用现有提示词库接口搜索账号已启用来源，按需同步缓存，支持原接口分页；不调用模型或下载原始媒体。",assets_list:"搜索账号素材及服务端缩略图；文本返回正文，媒体返回所属文件引用。",assets_add:"将已读取的文本／图片节点，或直接提供的正文／所属图片文件保存为账号素材。nodeId、content、imageUrl 三选一；相同内容与来源复用。",workbench_image_get_config:"读取图片工作台已配置模型的公开能力和账号参数。",workbench_video_get_config:"读取视频工作台已配置模型的公开能力和账号参数。",workbench_image_generate:"在图片工作台准备或生成图片；run=false 只填入表单，run=true 展示准确参数并等待用户确认后受理后台任务。count 为独立请求数，仍遵守媒体批次上限；引用必须为所属账号真实文件。",workbench_video_generate:"在视频工作台准备或生成视频；run=false 只填入表单，run=true 必须等待用户具体确认后受理后台任务，不能自动重发。",select_nodes:"在本次提交的浏览器选择当前画布的真实节点，不修改正文。",set_viewport:"在本次提交的浏览器设置当前画布视口，不移动节点。"};

export async function queueUiAction(client:Client,run:Run,payload:unknown) {
    if (!run.input.clientId) return {browserStatus:"unavailable",message:"本次运行没有关联浏览器，请手动打开目标页面。"};
    const id=randomUUID();await client.query("INSERT INTO agent_ui_actions(id,run_id,user_id,client_id,payload) VALUES($1,$2,$3,$4,$5)",[id,run.id,run.user_id,run.input.clientId,JSON.stringify(payload)]);
    return {uiActionId:id,browserStatus:"queued"};
}
export async function workbenchManifest(client:Client,run:Run,name:string,input:any) {
    const kind=name === "workbench_image_generate" ? "image" : "video";
    if (!run.model_config.limits.verifiedMediaModels.includes(input.model) || !(await readAgentConfig(client)).verifiedMediaModels.includes(input.model)) throw new HttpError(400,"AGENT_MODEL_UNAVAILABLE");
    if (input.count>run.model_config.limits.mediaBatch) throw new HttpError(400,"AGENT_BATCH_LIMIT");
    const channel=(await client.query("SELECT * FROM channels WHERE enabled AND capability=$1 AND models ? $2 ORDER BY id",[kind,input.model])).rows[0];
    if(!channel)throw new HttpError(400,"AGENT_MODEL_UNAVAILABLE");
    const family=kind === "image" ? channel.image_types[input.model] : channel.video_types[input.model] || "seedance";
    if(!family)throw new HttpError(400,"MODEL_CAPABILITY_INVALID");
    if(kind === "video" && !videoModelProfile(input.model,family).audioOptions && (input.parameters.generateAudio!==undefined || input.parameters.watermark!==undefined))throw new HttpError(400,"MODEL_CAPABILITY_INVALID");
    const references={images:[] as string[],videos:[] as string[],audios:[] as string[]};
    for(const url of input.references){const file=await storedFileInfo(run.user_id,url,client);const target=file.mimeType.startsWith("image/")?references.images:file.mimeType.startsWith("video/")?references.videos:file.mimeType.startsWith("audio/")?references.audios:null;if(!target)throw new HttpError(400,"INVALID_FILE_REFERENCE");target.push(file.url);}
    if(kind === "image" && (references.videos.length || references.audios.length))throw new HttpError(400,"MODEL_CAPABILITY_INVALID");
    const request=canvasRequestBody(input.model,kind,family,{...input.parameters,prompt:input.prompt},references);
    const error=kind === "image" ? imageRequestCapabilityError(input.model,family,request) : videoRequestCapabilityError(input.model,family,request);
    if(error)throw new HttpError(400,"MODEL_CAPABILITY_INVALID");
    await assertReferenceImages(run.user_id,request,client);
    if(kind === "video")await assertVideoDurations(run.user_id,input.model,family,references,client);
    const path=kind === "video" ? videoTaskPath(family) : references.images.length && family !== "banana" ? "images/edits" : "images/generations";
    const data={kind,channelId:channel.id,model:input.model,path,request,count:input.count,prompt:input.prompt,references:input.references,parameters:input.parameters};
    return {...data,hash:digest(data)};
}
export async function executeSiteTool(client:Client,run:Run,call:any,external:{groupId?:string;pricing?:unknown}) {
    const name=call.toolName as keyof typeof siteToolSchemas,input:any=siteToolSchemas[name].parse(call.input);
    const project=await findCanvasProject(run.user_id,run.project_id,client);
    if(name === "get_browser_actions")return {actions:(await client.query("SELECT id,acknowledged,error FROM agent_ui_actions WHERE user_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])",[run.user_id,run.input.clientId || null,input.ids])).rows.map(row=>({id:row.id,status:!row.acknowledged ? "queued" : row.error ? "failed" : "completed",error:row.error}))};
    if(name === "canvas_list_projects")return {projects:(await client.query("SELECT id,title,jsonb_array_length(nodes) AS nodes,jsonb_array_length(connections) AS connections,updated_at FROM canvas_projects WHERE user_id=$1 AND deleted_at IS NULL AND title ILIKE $2 ORDER BY updated_at DESC,id",[run.user_id,`%${input.keyword || ""}%`])).rows};
    if(name === "read_project"){const target=await findCanvasProject(run.user_id,input.projectId,client);return {id:target.id,title:target.title,nodes:target.nodes,connections:target.connections,readOnly:target.id !== run.project_id};}
    if(name === "prompts_search")return searchPrompts(run.user_id,input);
    if(name === "assets_list")return {assets:(await readAssets(run.user_id,client)).filter(asset=>(input.kind === "all" || asset.kind === input.kind) && (!input.keyword || `${asset.title} ${asset.tags.join(" ")} ${asset.kind === "text" ? asset.data.content : ""}`.includes(input.keyword)))};
    if(name === "assets_add"){
        const node=input.nodeId ? getNode(project,input.nodeId) : {type:input.imageUrl ? "image" : "text",title:input.title || (input.imageUrl ? "图片素材" : "文本素材"),metadata:{content:input.content || input.imageUrl}};
        if(input.nodeId && run.sources[node.id]!==digest({id:node.id,type:node.type,metadata:node.metadata,title:node.title}))throw new HttpError(409,"AGENT_CANVAS_NOT_READ");
        if(!["text","image"].includes(node.type))throw new HttpError(400,"INVALID_FILE_REFERENCE");
        const data=node.type === "text" ? {content:node.metadata?.content || ""} : await storedFileInfo(run.user_id,node.metadata?.content,client);
        if(node.type === "image" && !(data as any).mimeType.startsWith("image/"))throw new HttpError(400,"INVALID_FILE_REFERENCE");
        const existing=(await readAssets(run.user_id,client)).find(asset=>asset.kind===node.type && (asset.kind === "text" ? asset.data.content===(data as any).content && asset.title===(input.title || node.title) : asset.data.storageKey===(data as any).storageKey));
        if(existing)return {asset:existing,reused:true};
        const asset=await addTextOrImageAsset(run.user_id,{kind:node.type,title:input.title || node.title,tags:input.tags,coverUrl:node.type === "image" ? `${(data as any).url}?preview=1` : "",data:node.type === "text" ? data : {storageKey:(data as any).storageKey,dataUrl:(data as any).url,width:(data as any).width,height:(data as any).height,bytes:(data as any).bytes,mimeType:(data as any).mimeType}},client);return {asset};
    }
    if(name === "select_nodes")return queueUiAction(client,run,{type:name,projectId:run.project_id,nodeIds:input.nodeIds.map((id:string)=>getNode(project,id).id)});
    if(name === "set_viewport")return queueUiAction(client,run,{type:name,projectId:run.project_id,viewport:input});
    if(name === "site_navigate"){
        if(input.path !== "/" && !/^\/(?:studio|image|video|audio|canvas|assets|prompts|config)$/.test(input.path)){
            const match=/^\/canvas\/([a-f\d-]+)$/.exec(input.path);if(!match)throw new HttpError(400,"AGENT_INVALID_TOOL");await findCanvasProject(run.user_id,z.uuid().parse(match[1]),client);
        }
        return queueUiAction(client,run,{type:name,path:input.path});
    }
    if(name.endsWith("_get_config")){
        const kind=name === "workbench_image_get_config" ? "image" : "video",channels=(await client.query("SELECT * FROM channels WHERE enabled AND capability=$1",[kind])).rows;
        const saved=await readAccountData(run.user_id,"infinite-canvas:ai_config_store",{config:{}} as any,"preferences");
        const parameters=Object.fromEntries(["model","quality","size","count","videoModel","videoSize","videoQuality","videoSeconds","videoGenerateAudio","videoWatermark"].filter(key=>key in saved.config).map(key=>[key,saved.config[key]]));
        return {parameters,models:channels.flatMap(channel=>channel.models.map((model:string)=>{const {family,...capabilities}=kind === "image" ? imageModelProfile(model,channel.image_types[model]) : videoModelProfile(model,channel.video_types[model] || "seedance");return {model,capabilities};}))};
    }
    const manifest=await workbenchManifest(client,run,name,input),ui={type:"workbench",submitted:false,kind:manifest.kind,model:input.model,prompt:input.prompt,parameters:input.parameters,count:input.count,references:input.references};
    if(!input.run)return queueUiAction(client,run,ui);
    if(run.wait?.type !== "workbench" || run.wait.callId !== call.toolCallId || !run.wait.approved){await setState(client,run,"waiting_confirmation",{type:"workbench",callId:call.toolCallId,manifest,pricing:external.pricing});return;}
    if(run.wait.manifest.hash !== manifest.hash)throw new HttpError(409,"AGENT_CONFIRMATION_CHANGED");
    if(!external.groupId)throw new HttpError(403,"TOKENONE_KEY_UNAVAILABLE");
    const taskIds=[];
    for(let index=0;index<manifest.count;index++){
        const id=randomUUID();await client.query("INSERT INTO generation_tasks(id,user_id,channel_id,group_id,model,capability,path,status,provider,request,title) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)",[id,run.user_id,manifest.channelId,external.groupId,input.model,manifest.kind,manifest.path,modelProvider,JSON.stringify({...manifest.request,user_prompt:input.prompt}),input.prompt]);taskIds.push(id);
    }
    await client.query("UPDATE agent_runs SET wait=NULL WHERE id=$1",[run.id]);run.wait=null;
    return {taskIds,...await queueUiAction(client,run,{...ui,submitted:true,taskIds})};
}
