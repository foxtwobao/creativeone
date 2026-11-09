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
    await read.execute("call-1",{nodeIds:["node-1"]},undefined,undefined,{} as any);
    assert.deepEqual(calls,[{toolCallId:"call-1",toolName:"read_nodes",input:{nodeIds:["node-1"]}}]);
    const message=fauxAssistantMessage([fauxToolCall("read_nodes",{nodeIds:["node-1"],includeImages:[null,null,null,0]},{id:"bad"})],{stopReason:"toolUse"});
    assert.match(validateCreativePiDecision(message,tools)!,/includeImages/);
});
test("Pi normalizes read node IDs while write modes still require their original types",()=>{
    const tools=creativePiTools(async()=>({content:[]}));
    const read=fauxAssistantMessage([fauxToolCall("read_nodes",{nodeIds:"node-1"},{id:"read"})],{stopReason:"toolUse"});
    assert.equal(validateCreativePiDecision(read,tools),undefined);
    assert.equal((read.content[0] as any).arguments.nodeIds,"node-1");
    const write=fauxAssistantMessage([fauxToolCall("create_text_nodes",{nodes:[{title:"额外副本",text:"正文",sourceNodeIds:[],copyMode:["new_copy"]}]},{id:"write"})],{stopReason:"toolUse"});
    assert.match(validateCreativePiDecision(write,tools)!,/copyMode/);
});

test("Pi rejects raw action coercion and removed flags for every affected write tool",()=>{
    const tools=creativePiTools(async()=>({content:[]}));
    const text={title:"正文",text:"正文",sourceNodeIds:[]},media={title:"图片",kind:"image",model:"image-model",prompt:"小猫",sourceNodeIds:[],referenceNodeIds:[],parameters:{}},{kind,...generation}=media;
    for(const [name,node] of [["create_text_nodes",text],["prepare_media_nodes",media],["prepare_text_generation",generation]] as const){
        for(const copyMode of ["reuse","new_copy"]){const valid=fauxAssistantMessage([fauxToolCall(name,{nodes:[{...node,copyMode}]})],{stopReason:"toolUse"});assert.equal(validateCreativePiDecision(valid,tools),undefined);}
        for(const patch of [{newCopy:false},{newCopy:true},...[null,true,false,0,1,"true","false",["reuse"],["new_copy"],[null,null,null,1]].map(copyMode=>({copyMode}))]){
            const input={nodes:[{...node,...patch}]},message=fauxAssistantMessage([fauxToolCall(name,input)],{stopReason:"toolUse"}),original=JSON.stringify(message);
            assert.match(validateCreativePiDecision(message,tools)!,/copyMode|newCopy/);assert.equal(JSON.stringify(message),original);
        }
    }
    for(const name of ["workbench_image_generate","workbench_video_generate"]){
        for(const action of ["fill_form","request_generation"]){const valid=fauxAssistantMessage([fauxToolCall(name,{model:"model",prompt:"小猫",action})],{stopReason:"toolUse"});assert.equal(validateCreativePiDecision(valid,tools),undefined);}
        for(const patch of [{run:false},{run:true},...[null,true,false,0,1,"true","false",["fill_form"],["request_generation"],[null,null,null,1]].map(action=>({action}))]){
            const message=fauxAssistantMessage([fauxToolCall(name,{model:"model",prompt:"小猫",...patch})],{stopReason:"toolUse"}),original=JSON.stringify(message);
            assert.match(validateCreativePiDecision(message,tools)!,/action|run/);assert.equal(JSON.stringify(message),original);
        }
    }
});
