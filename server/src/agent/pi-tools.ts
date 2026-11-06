import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { descriptions, toolSchemas, toolArgumentErrors } from "./tools.js";
import { toolJsonSchema } from "./schema.js";

export function creativePiTools(execute:(call:{toolCallId:string;toolName:string;input:unknown},signal?:AbortSignal)=>ReturnType<ToolDefinition<any>["execute"]>):ToolDefinition<any>[] {
    return Object.entries(toolSchemas).map(([name,schema])=>({
        name,label:name,description:descriptions[name as keyof typeof descriptions],parameters:toolJsonSchema(schema,false),
        constrainedSampling:false,executionMode:"sequential",
        execute:(id,input,signal)=>execute({toolCallId:id,toolName:name,input},signal),
    }));
}
export function validateCreativePiDecision(message:AgentMessage){
    if(message.role!=="assistant")return;
    const calls=message.content.filter(part=>part.type==="toolCall").map(part=>({toolCallId:part.id,toolName:part.name,input:part.arguments,argumentsError:part.argumentsError}));
    if(new Set(calls.map(call=>call.toolCallId)).size!==calls.length)return "工具调用 ID 重复，本次决定全部未执行，请重新规划。";
    const errors=toolArgumentErrors(calls);
    if(errors.length)return `本次决定全部未执行，请依据同一份工具定义修正参数：${JSON.stringify(errors)}`;
}
