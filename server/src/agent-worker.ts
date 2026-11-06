import { initializeDatabase,db } from "./db.js";
import { startAgentWorker } from "./agent/worker.js";

await initializeDatabase();
const stop=startAgentWorker();
// A forced process exit is recovered through the persisted request/receipt journal.
for(const name of ["SIGTERM","SIGINT"] as const)process.once(name,()=>{stop();void db.end().finally(()=>process.exit(0));});
