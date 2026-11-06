import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { creativePiTools, validateCreativePiDecision } from "./agent/pi-tools.js";
import { agentTools } from "./agent/tools.js";
import { toolJsonSchema } from "./agent/schema.js";
import { toolSchemas } from "./agent/tools.js";

test("all Pi tools use the shared schema and sequential execution",async()=>{
    const tools=creativePiTools(async()=>({content:[{type:"text",text:"fixture"}]}));
    assert.equal(tools.length,Object.keys(agentTools).length);
    for(const tool of tools){
        assert.deepEqual(tool.parameters,toolJsonSchema(toolSchemas[tool.name as keyof typeof toolSchemas],false));
        assert.equal(tool.constrainedSampling,false);
        assert.equal(tool.executionMode,"sequential");
    }
});
test("Pi tools preserve call identity and reject raw production-shaped array parameters",async()=>{
    const calls:unknown[]=[],tools=creativePiTools(async call=>{calls.push(call);return {content:[{type:"text",text:"fixture"}]};});
    const read=tools.find(tool=>tool.name==="read_nodes")!;
    await read.execute("call-1",{nodeIds:["node-1"],includeImages:false},undefined,undefined,{} as any);
    assert.deepEqual(calls,[{toolCallId:"call-1",toolName:"read_nodes",input:{nodeIds:["node-1"],includeImages:false}}]);
    const message=fauxAssistantMessage([fauxToolCall("read_nodes",{nodeIds:["node-1"],includeImages:[null,null,null,0]},{id:"bad"})],{stopReason:"toolUse"});
    assert.match(validateCreativePiDecision(message,tools)!,/includeImages/);
});
test("Pi normalizes read options while write flags still require their original types",()=>{
    const tools=creativePiTools(async()=>({content:[]}));
    const read=fauxAssistantMessage([fauxToolCall("read_nodes",{nodeIds:["node-1"],includeImages:"false"},{id:"read"})],{stopReason:"toolUse"});
    assert.equal(validateCreativePiDecision(read,tools),undefined);
    assert.equal((read.content[0] as any).arguments.includeImages,"false");
    const write=fauxAssistantMessage([fauxToolCall("create_text_nodes",{nodes:[{title:"额外副本",text:"正文",sourceNodeIds:[],newCopy:"true"}]},{id:"write"})],{stopReason:"toolUse"});
    assert.match(validateCreativePiDecision(write,tools)!,/newCopy/);
});
