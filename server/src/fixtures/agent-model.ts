import { randomUUID } from "node:crypto";
export const modelText=(text:string) => ({id:`resp_${randomUUID()}`,object:"response",created_at:1,model:"agent-model",status:"completed",output:[{id:`msg_${randomUUID()}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]}],usage:{input_tokens:12,output_tokens:13,total_tokens:25}});
export const modelTool=(name:string,input:unknown,callId=randomUUID()) => ({...modelText(""),output:[{type:"function_call",id:`fc_${randomUUID()}`,status:"completed",call_id:callId,name,arguments:JSON.stringify(input)}]});
export function modelStream(body:any) {
    const events:any[]=[{type:"response.created",response:{...body,output:[]}}];
    for(const [index,item] of (body.output || []).entries()){
        events.push({type:"response.output_item.added",output_index:index,item:{...item,...item.type === "function_call" ? {arguments:""} : {content:[]}}});
        if(item.type === "function_call")events.push({type:"response.function_call_arguments.delta",item_id:item.id,output_index:index,delta:item.arguments});
        else for(const [partIndex,part] of (item.content || []).entries()){
            events.push({type:"response.content_part.added",item_id:item.id,output_index:index,content_index:partIndex,part:{...part,text:""}});
            if(part.type === "output_text")for(const text of Array.from(part.text as string))events.push({type:"response.output_text.delta",item_id:item.id,output_index:index,content_index:partIndex,delta:text});
        }
        events.push({type:"response.output_item.done",output_index:index,item});
    }
    events.push({type:body.status === "incomplete" ? "response.incomplete" : "response.completed",response:body});
    return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"Content-Type":"text/event-stream"}});
}
export function mockAgentModel(responses:any[]) {
    const original=globalThis.fetch,requests:any[]=[],ensureRequests:string[]=[];let denied=false,unavailable=false;
    globalThis.fetch=async (input,init) => {
        const url=String(input);
        if (url === "https://enhancer.test/api/apps/keys/ensure") ensureRequests.push(url);
        if (url === "https://enhancer.test/api/apps/keys/ensure" && unavailable) return Response.json({error:"APP_SERVICE_UNAVAILABLE"},{status:503});
        if (url === "https://enhancer.test/api/apps/keys/ensure" && denied) return Response.json({error:"APP_USER_AUTHORIZATION_REQUIRED"},{status:403});
        if (url === "https://enhancer.test/api/apps/keys/ensure") return Response.json({status:"ready",tokenone_user_id:"42",api_key:{id:"701",key:"sk-test-only",group_id:"8",status:"active"}});
        if (url === "https://enhancer.test/api/apps/pricing") return Response.json({app_id:"creativeone",currency:"USD",queried_at:new Date().toISOString(),models:[]});
        if (url === "https://tokenone.test/v1/responses") {
            requests.push(JSON.parse(String(init?.body)));
            const next=responses.shift();
            if (typeof next === "function") {
                const response=await next();
                return requests.at(-1).stream && response instanceof Response && response.ok && response.headers.get("Content-Type")?.includes("application/json") ? modelStream(await response.json()) : response;
            }
            if (next instanceof Error) throw next;
            if (next?.httpStatus) return Response.json(next.body || {error:{message:"rejected"}},{status:next.httpStatus});
            if (!next) throw new Error("No fixture response remaining");
            return requests.at(-1).stream ? modelStream(next) : Response.json(next);
        }
        throw new Error("Unexpected external request in Agent fixture");
    };
    return {requests,ensureRequests,setDenied:(value:boolean) => {denied=value;},setUnavailable:(value:boolean) => {unavailable=value;},restore:() => {globalThis.fetch=original;}};
}
