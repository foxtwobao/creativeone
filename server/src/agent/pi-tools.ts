import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { validateToolCall } from "@earendil-works/pi-ai";
import { descriptions, toolSchemas, toolArgumentErrors } from "./tools.js";
import { toolJsonSchema } from "./schema.js";

export const piReadOnlyTools=new Set(["read_agent_state","read_skill_file","load_skill","read_canvas","canvas_export_snapshot","find_nodes","read_nodes","read_node_images","get_model_capabilities","read_task_results","read_connections","get_browser_actions","canvas_list_projects","read_project","prompts_search","assets_list","workbench_image_get_config","workbench_video_get_config"]);
type CreativeCall={toolCallId:string;toolName:string;input:unknown;argumentsError?:string};
export function creativePiInput(call:CreativeCall,tools:ToolDefinition<any>[]) {
    return piReadOnlyTools.has(call.toolName)?validateToolCall(tools,{type:"toolCall",id:call.toolCallId,name:call.toolName,arguments:call.input as any,argumentsError:call.argumentsError}):call.input;
}
export function creativePiArgumentErrors(calls:CreativeCall[],tools:ToolDefinition<any>[]) {
    return calls.flatMap(call=>{
        try{return toolArgumentErrors([{...call,input:creativePiInput(call,tools)}]);}
        catch(error){const errors=toolArgumentErrors([call]);return errors.length?errors:[{callId:call.toolCallId,toolName:call.toolName,problems:[{field:"arguments",message:error instanceof Error?error.message:String(error)}]}];}
    });
}

export function creativePiTools(execute:(call:{toolCallId:string;toolName:string;input:unknown},signal?:AbortSignal)=>ReturnType<ToolDefinition<any>["execute"]>):ToolDefinition<any>[] {
    return Object.entries(toolSchemas).map(([name,schema])=>({
        name,label:name,description:descriptions[name as keyof typeof descriptions],parameters:toolJsonSchema(schema,false),
        constrainedSampling:false,executionMode:"sequential",
        execute:(id,input,signal)=>execute({toolCallId:id,toolName:name,input},signal),
    }));
}
export function validateCreativePiDecision(message:AgentMessage,tools:ToolDefinition<any>[]){
    if(message.role!=="assistant")return;
    const calls=message.content.filter(part=>part.type==="toolCall").map(part=>({toolCallId:part.id,toolName:part.name,input:part.arguments,argumentsError:part.argumentsError}));
    if(new Set(calls.map(call=>call.toolCallId)).size!==calls.length)return "工具调用 ID 重复，本次决定全部未执行，请重新规划。";
    const errors=creativePiArgumentErrors(calls,tools);
    if(errors.length)return `本次决定全部未执行，请依据同一份工具定义修正参数：${JSON.stringify(errors)}`;
}
