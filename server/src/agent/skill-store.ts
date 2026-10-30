import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { HttpError } from "../http.js";
import { skills, skillSnapshot } from "./skills.js";
import type { Client } from "./state.js";

const relativePath=z.string().min(1).refine(path => !path.includes("\\") && !path.includes("\0") && !posix.isAbsolute(path) && !path.split("/").includes("..") && path === posix.normalize(path) && path !== ".","文件路径必须为 Skill 内的相对路径");
export const skillInput=z.object({title:z.string().trim().min(1),description:z.string().default(""),content:z.string().trim().min(1),files:z.record(relativePath,z.string()).default({}),version:z.number().int().positive().optional()}).strict();
const personal=(row:any) => ({id:row.id,title:row.title,description:row.description,version:row.version,source:"personal",hasFiles:Object.keys(row.files || {}).length>0});
export async function listSkills(client:Client,userId:string) {
    const rows=(await client.query("SELECT id,title,description,version,files<>'{}'::jsonb AS has_files FROM agent_skills WHERE user_id=$1 ORDER BY updated_at DESC,id",[userId])).rows;
    return [...Object.entries(skills).map(([id,skill]) => ({id,title:skill.title,description:skill.description,version:skill.version,source:"builtin",hasFiles:false})),...rows.map(row => ({...personal(row),hasFiles:row.has_files}))];
}
export async function readSkill(client:Client,userId:string,id:string) {
    if (Object.hasOwn(skills,id)) {const snapshot=skillSnapshot(id as keyof typeof skills);return {id,title:snapshot.title,description:snapshot.description,content:snapshot.text,files:{},version:snapshot.version,source:"builtin"};}
    if (!z.uuid().safeParse(id).success) throw new HttpError(404,"AGENT_SKILL_NOT_FOUND");
    const row=(await client.query("SELECT * FROM agent_skills WHERE id=$1 AND user_id=$2",[id,userId])).rows[0];
    if (!row) throw new HttpError(404,"AGENT_SKILL_NOT_FOUND");
    return {...personal(row),content:row.content,files:row.files};
}
export async function loadSkill(client:Client,userId:string,id:string) {
    const skill=await readSkill(client,userId,id);return {title:skill.title,description:skill.description,text:skill.content,files:skill.files,version:skill.version};
}
export async function saveSkill(client:Client,userId:string,value:unknown,id?:string) {
    const input=skillInput.parse(value),key=id || randomUUID();
    if (id) {
        const row=(await client.query("SELECT version FROM agent_skills WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId])).rows[0];
        if (!row) throw new HttpError(404,"AGENT_SKILL_NOT_FOUND");
        if (row.version !== input.version) throw new HttpError(409,"AGENT_SKILL_CHANGED");
        await client.query("UPDATE agent_skills SET title=$3,description=$4,content=$5,files=$6,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2",[id,userId,input.title,input.description,input.content,JSON.stringify(input.files)]);
    } else await client.query("INSERT INTO agent_skills(id,user_id,title,description,content,files) VALUES($1,$2,$3,$4,$5,$6)",[key,userId,input.title,input.description,input.content,JSON.stringify(input.files)]);
    return readSkill(client,userId,key);
}
export async function deleteSkill(client:Client,userId:string,id:string,version:number) {
    const row=(await client.query("SELECT version FROM agent_skills WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId])).rows[0];
    if (!row) throw new HttpError(404,"AGENT_SKILL_NOT_FOUND");
    if (row.version !== version) throw new HttpError(409,"AGENT_SKILL_CHANGED");
    await client.query("DELETE FROM agent_skills WHERE id=$1 AND user_id=$2",[id,userId]);
}
export async function readSkillFile(run:{skills:Record<string,any>},id:string,path:string) {
    relativePath.parse(path);const snapshot=run.skills[id];
    if (!snapshot || !Object.hasOwn(snapshot.files || {},path)) throw new HttpError(404,"AGENT_SKILL_FILE_NOT_FOUND");
    return {skillId:id,path,content:snapshot.files[path],version:snapshot.version};
}
