import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
const name=`creativeone_pi_runtime_${randomUUID().replaceAll('-','')}_test`;
const url=new URL(process.env.DATABASE_URL);url.pathname=`/${name}`;
let created=false;
try{
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    process.exitCode=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['--import','tsx','--test','src/pi-session.test.ts','src/pi-session-store.test.ts','src/pi-tools.test.ts'],{stdio:'inherit',env:{...process.env,TEST_DATABASE_URL:url.href}});
        child.on('error',reject);child.on('exit',(code,signal)=>resolve(signal?1:code??1));
    });
}finally{if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
