// Optional comparison probe; run only against the UUID test database from test-agent.mjs.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { z } from 'zod';
const database=process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith('_test')) throw new Error('Isolated test database required');
Object.assign(process.env,{DATABASE_URL:database,APP_ORIGIN:'http://localhost:3001',APP_ORIGINS:'["http://localhost:3001"]',APP_DOMAIN_SUFFIXES:'',IDONE_ISSUER:'https://idone.test',IDONE_DISCOVERY_URL:'',IDONE_ALLOW_HTTP:'false',IDONE_CLIENT_ID:'test',IDONE_CLIENT_SECRET:'test',ONE_NAVIGATION_CONFIG:'',ADMIN_SUBJECTS:randomUUID(),ENHANCER_BASE_URL:'https://enhancer.test',ENHANCER_APP_CREDENTIAL:'test',TOKENONE_BASE_URL:'https://tokenone.test'});
const root=process.env.MASTRA_EVAL_MODULE_ROOT;
const {Mastra}=await import(pathToFileURL(join(root,'@mastra/core/dist/mastra/index.js')));
const {createWorkflow,createStep}=await import(pathToFileURL(join(root,'@mastra/core/dist/workflows/index.js')));
const {PostgresStore}=await import(pathToFileURL(join(root,'@mastra/pg/dist/index.js')));
const {db,transaction,initializeDatabase}=await import('../src/db.ts');
const {findCanvasProject,applyCanvasCommand}=await import('../src/business.ts');
const {agentDecision}=await import('../src/agent/model.ts');
const {mockAgentModel,modelTool}=await import('../src/fixtures/agent-model.ts');
const mode=process.argv[2],runId=process.argv[3];
const fixture=mockAgentModel([modelTool('create_text_nodes',{nodes:[{title:'测试镜头',text:'小猫回家',sourceNodeIds:[]}]})]);
const data=z.object({user:z.string(),project:z.string(),source:z.string(),decision:z.any().optional(),taskId:z.string().optional()});
const decide=createStep({id:'decide',inputSchema:data,outputSchema:data,retries:0,execute:async ({inputData}) => {
    const project=await findCanvasProject(inputData.user,inputData.project);
    const result=await agentDecision('agent-model','test','Use native tools',[{role:'user',content:JSON.stringify(project.nodes)}],{outputTokens:8000},new AbortController().signal);
    assert.equal(result.decision.valid,true);
    return {...inputData,decision:result.decision};
}});
const approve=createStep({id:'approve',inputSchema:data,outputSchema:data,resumeSchema:z.object({approved:z.boolean()}),suspendSchema:z.object({question:z.string()}),retries:0,execute:async ({inputData,resumeData,suspend}) => resumeData?.approved ? inputData : suspend({question:'确认已保存决定后创建测试节点并受理模拟任务？'})});
const write=createStep({id:'write',inputSchema:data,outputSchema:data,retries:0,execute:async ({inputData}) => {
    const operation=`mastra-probe:${runId}`;
    return transaction(async client => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[inputData.user]);
        const receipt=(await client.query('SELECT result FROM agent_probe_receipts WHERE operation=$1',[operation])).rows[0];
        if (receipt) return receipt.result;
        const project=await findCanvasProject(inputData.user,inputData.project,client,true),nodeId=randomUUID();
        const text=inputData.decision.calls[0].input.nodes[0];
        const saved=await applyCanvasCommand(inputData.user,inputData.project,{operationId:operation,baseRevision:Number(project.content_revision),baseGenerationRevision:Number(project.generation_revision),command:{type:'edit_project',graphEdits:[{type:'put_node',node:{id:nodeId,type:'text',title:text.title,position:{x:400,y:0},width:300,height:200,metadata:{content:text.text}}}]}},client);
        const taskId=randomUUID(),channel=(await client.query("SELECT id FROM channels WHERE capability='image'")).rows[0];
        await client.query("INSERT INTO generation_tasks(id,user_id,channel_id,group_id,model,capability,path,status,provider,request) VALUES($1,$2,$3,'test','image-model','image','images/generations','pending','mock','{}')",[taskId,inputData.user,channel.id]);
        const result={...inputData,taskId,nodeId:saved.nodes.find(node => node.id === nodeId).entityId};
        await client.query('INSERT INTO agent_probe_receipts(operation,result) VALUES($1,$2)',[operation,JSON.stringify(result)]);
        return result;
    });
}});
const wait=createStep({id:'wait',inputSchema:data,outputSchema:data,resumeSchema:z.object({check:z.boolean()}),suspendSchema:z.object({taskId:z.string()}),retries:0,execute:async ({inputData,suspend}) => {
    const task=(await db.query('SELECT status FROM generation_tasks WHERE id=$1',[inputData.taskId])).rows[0];
    return task.status === 'succeeded' ? inputData : suspend({taskId:inputData.taskId});
}});
const workflow=createWorkflow({id:'agent-comparison',inputSchema:data,outputSchema:data,retryConfig:{attempts:0,delay:0}}).then(decide).then(approve).then(write).then(wait).commit();
const storage=new PostgresStore({id:'agent-comparison',connectionString:database,schemaName:'agent_probe',max:2});
const mastra=new Mastra({storage,workflows:{probe:workflow},logger:false});
try {
    await storage.init();
    const run=await mastra.getWorkflow('probe').createRun({runId});
    if (mode === 'start') {
        await initializeDatabase();
        await db.query('CREATE TABLE agent_probe_receipts(operation text PRIMARY KEY,result jsonb NOT NULL)');
        const user=randomUUID(),project=randomUUID(),source=randomUUID();
        await db.query("INSERT INTO users VALUES($1::uuid,'https://idone.test',$1::text,$2,true,'test','test','')",[user,`${user}@example.test`]);
        await db.query("INSERT INTO canvas_projects(id,user_id,title,nodes) VALUES($1,$2,'probe',$3)",[project,user,JSON.stringify([{id:source,type:'text',title:'剧本',position:{x:0,y:0},width:300,height:200,metadata:{content:'小猫回家'}}])]);
        const result=await run.start({inputData:{user,project,source}});assert.equal(result.status,'suspended');assert.equal(fixture.requests.length,1);
    } else if (mode === 'approve') {
        const result=await run.resume({step:'approve',resumeData:{approved:true}});assert.equal(result.status,'suspended');assert.equal(fixture.requests.length,0);assert.equal((await db.query('SELECT count(*) FROM agent_probe_receipts')).rows[0].count,'1');
    } else {
        const receipt=(await db.query('SELECT result FROM agent_probe_receipts')).rows[0].result;
        await db.query("UPDATE generation_tasks SET status='succeeded',result='{\"file\":{\"storageKey\":\"mock\"}}' WHERE id=$1",[receipt.taskId]);
        const result=await run.resume({step:'wait',resumeData:{check:true}});assert.equal(result.status,'success');assert.equal(fixture.requests.length,0);
    }
    console.log(JSON.stringify({candidate:'Mastra 1.80.0 + pg 1.33.0',mode,requests:fixture.requests.length,passed:true}));
} finally {fixture.restore();await storage.close();await db.end();}
