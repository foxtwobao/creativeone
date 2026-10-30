import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Reuse the configured PostgreSQL server; never start/stop containers or services.
const admin = new pg.Client({connectionString:process.env.DATABASE_URL});
await admin.connect();
const name=`creativeone_agent_${randomUUID().replaceAll('-','')}_test`;
const url=new URL(process.env.DATABASE_URL);url.pathname=`/${name}`;
try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const code=await new Promise((resolve,reject) => {
        const child=spawn(process.execPath,['--import','tsx','--test',...process.argv.slice(2),'src/server-agent.test.ts'],{stdio:'inherit',env:{...process.env,TEST_DATABASE_URL:url.href}});
        child.on('error',reject);child.on('exit',resolve);
    });
    process.exitCode=code || 0;
    if (!code && process.env.MASTRA_EVAL_MODULE_ROOT && process.env.MASTRA_EVAL_NODE) {
        const runId=randomUUID();
        for (const mode of ['start','approve','finish']) {
            const status=await new Promise((resolve,reject) => {
                const child=spawn(process.env.MASTRA_EVAL_NODE,['--import','tsx','scripts/probe-agent-mastra.mjs',mode,runId],{stdio:'inherit',env:{...process.env,TEST_DATABASE_URL:url.href}});
                child.on('error',reject);child.on('exit',resolve);
            });
            if (status) {process.exitCode=status;break;}
        }
    }
} finally {
    // Only this invocation's UUID-named test database is eligible for cleanup.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
}
