import { mockAgentModel } from "./agent-model.js";
const fixture=mockAgentModel(JSON.parse(process.env.TEST_AGENT_RESPONSES || "[]"));
const { executeAgentRun }=await import("../agent/worker.js");
const { db }=await import("../db.js");
await executeAgentRun(process.argv[2]);
await db.end();
console.log(JSON.stringify({requests:fixture.requests.length}));
