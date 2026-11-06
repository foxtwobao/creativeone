// Optional dependency-contract probe. No application services, database or paid model calls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const root=process.env.PI_EVAL_MODULE_ROOT;
if(!root)throw new Error('Set PI_EVAL_MODULE_ROOT to the isolated installation node_modules directory');
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Network disabled in Pi evaluation');};
after(()=>{globalThis.fetch=originalFetch;});
for(const name of ['pi-agent-core','pi-ai']){
    const pkg=JSON.parse(await readFile(join(root,'@earendil-works',name,'package.json'),'utf8'));
    assert.equal(pkg.version,'1.5.0','The probe requires the evaluated release');
}
const {Agent}=await import(pathToFileURL(join(root,'@earendil-works/pi-agent-core/dist/index.js')));
const {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,validateToolArguments,normalizeContext}=await import(pathToFileURL(join(root,'@earendil-works/pi-ai/dist/index.js')));
const responsesApi=await import(pathToFileURL(join(root,'@earendil-works/pi-ai/dist/api/openai-responses.js')));
const readArgs=z.object({nodeIds:z.array(z.string()).min(1),includeImages:z.boolean().nullable()}).strict();
const copyArgs=z.object({newCopy:z.boolean().nullable()}).strict();
const call=(name,args,id)=>fauxToolCall(name,args,{id});
const decision=(...calls)=>fauxAssistantMessage(calls,{stopReason:'toolUse'});
function fixture(responses,options={}){
    const faux=fauxProvider(),models=createModels(),requests=[],writes=[];
    models.setProvider(faux.provider);faux.setResponses(responses);
    const tools=Object.entries({read_nodes:readArgs,save_fixture:copyArgs}).map(([name,schema])=>({name,label:name,description:name,parameters:z.toJSONSchema(schema),execute:async(id,args)=>{
        writes.push({id,args});return {content:[{type:'text',text:'fixture saved'}],details:{id}};
    }}));
    const agent=new Agent({initialState:{model:faux.getModel(),tools},toolExecution:'sequential',streamFn:(model,context,streamOptions)=>{
        requests.push(structuredClone(context));return models.streamSimple(model,context,streamOptions);
    },...options});
    return {agent,requests,writes,tools};
}
const toolResults=messages=>messages.filter(message=>message.role==='toolResult');
async function capturePayload(method,constrainedSampling){
    let payload;
    const model={id:'fixture',name:'fixture',api:'openai-responses',provider:'fixture',baseUrl:'https://fixture.invalid/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192,compat:{supportsStrictMode:true}};
    const context=normalizeContext({messages:[{role:'user',content:'读取节点',timestamp:0}],tools:[{name:'read_nodes',description:'fixture',parameters:z.toJSONSchema(readArgs),constrainedSampling}]});
    const stream=responsesApi[method](model,context,{apiKey:'fixture-only',maxRetries:0,onPayload:value=>{payload=value;throw new Error('Captured before network');}});
    const result=await stream.result();assert.match(result.errorMessage,/Captured before network/);return payload;
}
function guardWholeDecision(agent){
    let invalid=false;
    agent.subscribe(event=>{
        if(event.type==='message_end'&&event.message.role==='assistant')invalid=event.message.content.filter(part=>part.type==='toolCall').some(part=>!({read_nodes:readArgs,save_fixture:copyArgs}[part.name]?.safeParse(part.arguments).success));
    });
    agent.beforeToolCall=async()=>invalid?{block:true,reason:'The entire decision has invalid raw arguments; no sibling call executed'}:undefined;
}

test('Pi retries production-shaped boolean arrays with one result per call',async()=>{
    const bad=call('read_nodes',{nodeIds:['fixture'],includeImages:[null,null,null,0]},'invalid'),good=call('read_nodes',{nodeIds:['fixture'],includeImages:false},'corrected');
    const ctx=fixture([decision(bad),decision(good),fauxAssistantMessage('完成')]);await ctx.agent.prompt('读取节点');
    assert.equal(ctx.requests.length,3);assert.deepEqual(ctx.writes,[{id:'corrected',args:good.arguments}]);
    for(const request of ctx.requests.slice(1)){
        const results=toolResults(request.messages).filter(message=>message.toolCallId==='invalid');assert.equal(results.length,1);assert.equal(results[0].isError,true);assert.match(results[0].content[0].text,/includeImages/);
    }
});
test('Pi default validation coerces strings and numbers, requiring a raw domain check',()=>{
    const ctx=fixture([]),tool=ctx.tools.find(tool=>tool.name==='save_fixture');
    for(const value of ['true',1]){
        assert.deepEqual(validateToolArguments(tool,call('save_fixture',{newCopy:value},'coercion')),{newCopy:true});
        assert.equal(copyArgs.safeParse({newCopy:value}).success,false);
    }
});
test('Pi default mixed batches can execute a valid sibling before another call fails validation',async()=>{
    const ctx=fixture([decision(call('save_fixture',{newCopy:false},'valid'),call('read_nodes',{nodeIds:['fixture'],includeImages:[null,null,null,0]},'invalid')),fauxAssistantMessage('结束')]);
    await ctx.agent.prompt('混合调用');assert.deepEqual(ctx.writes.map(write=>write.id),['valid']);assert.equal(toolResults(ctx.agent.state.messages).find(message=>message.toolCallId==='invalid').isError,true);
});
test('whole-decision raw validation prevents coercion and valid sibling effects',async()=>{
    const ctx=fixture([decision(call('save_fixture',{newCopy:false},'sibling'),call('save_fixture',{newCopy:'true'},'invalid')),fauxAssistantMessage('结束')]);guardWholeDecision(ctx.agent);
    await ctx.agent.prompt('整轮校验');assert.deepEqual(ctx.writes,[]);assert.equal(toolResults(ctx.agent.state.messages).length,2);assert.ok(toolResults(ctx.agent.state.messages).every(message=>message.isError));
});
test('awaited assistant message_end is a barrier before tool execution',async()=>{
    let release,started;const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{started=resolve;}),ctx=fixture([decision(call('save_fixture',{newCopy:false},'saved')),fauxAssistantMessage('完成')]);
    ctx.agent.subscribe(async event=>{if(event.type==='message_end'&&event.message.role==='assistant'&&event.message.stopReason==='toolUse'){started();await gate;}});
    const work=ctx.agent.prompt('等待保存完整决定');await reached;assert.deepEqual(ctx.writes,[]);release();await work;assert.equal(ctx.writes.length,1);
});
test('failure in the persistence barrier prevents tools and another model request',async()=>{
    const ctx=fixture([decision(call('save_fixture',{newCopy:false},'uncommitted'))]);
    ctx.agent.subscribe(event=>{if(event.type==='message_end'&&event.message.role==='assistant'&&event.message.stopReason==='toolUse')throw new Error('fixture commit failed');});
    await ctx.agent.prompt('保存失败');assert.deepEqual(ctx.writes,[]);assert.equal(ctx.requests.length,1);assert.equal(ctx.agent.state.messages.at(-1).stopReason,'error');
});
test('confirmation pause can stop the loop without executing or requesting again',async()=>{
    const ctx=fixture([decision(call('save_fixture',{newCopy:false},'approval'))],{beforeToolCall:async()=>({block:true,reason:'waiting for application confirmation',terminate:true}),finishTurn:async()=>({action:'end'})});
    await ctx.agent.prompt('先确认');assert.deepEqual(ctx.writes,[]);assert.equal(ctx.requests.length,1);
});
test('truncated decisions stay unexecuted and the host can stop automatic follow-up',async()=>{
    const ctx=fixture([fauxAssistantMessage([call('save_fixture',{newCopy:false},'truncated')],{stopReason:'length'})],{finishTurn:async()=>({action:'end'})});
    await ctx.agent.prompt('截断');assert.deepEqual(ctx.writes,[]);assert.equal(ctx.requests.length,1);assert.equal(toolResults(ctx.agent.state.messages)[0].isError,true);
});
test('restoring an assistant decision requires explicit receipt recovery before continue',async()=>{
    const pending=decision(call('save_fixture',{newCopy:false},'pending')),ctx=fixture([fauxAssistantMessage('根据已保存回执继续')]);
    ctx.agent.state.messages=[{role:'user',content:'继续',timestamp:0},pending];await assert.rejects(()=>ctx.agent.continue(),/Cannot continue from message role: assistant/);assert.equal(ctx.requests.length,0);
    ctx.agent.state.messages.push({role:'toolResult',toolCallId:'pending',toolName:'save_fixture',content:[{type:'text',text:'original durable receipt'}],isError:false,timestamp:0});
    await ctx.agent.continue();assert.equal(ctx.requests.length,1);assert.deepEqual(ctx.writes,[]);
});
test('Responses payload needs explicit constrained sampling to retain strict tool schemas',async()=>{
    const plain=await capturePayload('stream'),strict=await capturePayload('stream',{type:'json_schema',strict:'require'});
    assert.equal(plain.tools[0].strict,false);assert.equal(strict.tools[0].strict,true);assert.deepEqual(strict.tools[0].parameters.properties.includeImages.type,['boolean','null']);assert.equal(strict.tools[0].parameters.additionalProperties,false);assert.equal(strict.store,false);
});
test('streamSimple adds a model output cap while the lower-level Responses stream can omit it',async()=>{
    const simple=await capturePayload('streamSimple'),direct=await capturePayload('stream');assert.equal(simple.max_output_tokens,8192);assert.equal(Object.hasOwn(direct,'max_output_tokens'),false);
});
