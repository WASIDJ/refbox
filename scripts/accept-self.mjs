// Real bootstrapping of Refbox: existing runtime performs the changes, a separate
// verifier reruns frozen host tests, and the accepted commit becomes the next base.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, open, chown, chmod } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const execute=promisify(execFile);
const repo=resolve(process.env.REFBOX_SELF_REPO??resolve(import.meta.dirname,".."));
const node=process.env.REFBOX_SELF_NODE??"/Library/Application Support/refbox/runtime/bin/node";
const runDir=resolve(process.env.REFBOX_SELF_DIR??join(repo,"var","self-"+Date.now()));
const baseline=await execute("git",["-c","safe.directory="+repo,"-C",repo,"rev-parse","HEAD"]).then(r=>r.stdout.trim());
const port=Number(process.env.REFBOX_SELF_PORT??24900);
const url="http://127.0.0.1:"+port;
const children=new Map();
let config, cookie="";
const report={startedAt:new Date().toISOString(),baseline,runDir,goals:[],adoptions:[],status:"running",cleanup:[]};
const goalA="修复 Refbox 自主目标验收：固定检查 passed=false、检查 ID 不匹配或 evidence 为 null 时绝不能把目标标记完成。保留现有回归测试和合法证明通过路径，完成真实源码修复并通过测试和构建。只在分配工作区修改，提交干净 Git 候选，登记实际源码产物，由独立 Agent 验收。";
const goalB="改进 Refbox 自身的构建版本追溯：GET /health 返回运行二进制的实际构建 Git revision，让用户能核对运行的是哪个已验证版本。保留现有 ok/service/version 字段和兼容性；正式 Go 构建须能从 VCS 构建元数据得到版本，缺少版本信息返回 unknown。提供有版本和无版本的行为测试。保持现有测试、依赖及 package.json 不变，完成真实源码改进，通过测试与构建，提交干净 Git 候选并登记实际产物。";
function progress(value){console.log(JSON.stringify({at:new Date().toISOString(),...value}));}
async function save(){await writeFile(join(runDir,"report.json"),JSON.stringify(report,null,2),{mode:0o600});}
async function ownerFolder(path){await mkdir(path,{recursive:true,mode:0o750});if(process.getuid()===0)await chown(path,501,20);}
async function configure(){
  await ownerFolder(runDir);
  for(const name of["goals","go-cache-verifier","go-mod-verifier","proofs"])await ownerFolder(join(runDir,name));
  process.loadEnvFile("/Library/Application Support/refbox/.env");
  const password=randomBytes(24).toString("base64url"),salt=randomBytes(16);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("REFBOX_"))),
    HOME:"/Users/ryou",PATH:dirname(node)+":"+process.env.PATH,
    GIT_AUTHOR_NAME:"Refbox Agent",GIT_AUTHOR_EMAIL:"refbox@localhost",GIT_COMMITTER_NAME:"Refbox Agent",GIT_COMMITTER_EMAIL:"refbox@localhost",
    REFBOX_ENGINE_TOKEN:randomBytes(32).toString("hex"),REFBOX_PLATFORM_TOKEN:randomBytes(32).toString("hex"),REFBOX_VERIFIER_TOKEN:randomBytes(32).toString("hex"),
    REFBOX_PASSWORD_HASH:`pbkdf2-sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync(password,salt,100000,32,"sha256").toString("base64url")}`,
    REFBOX_SECURE_COOKIE:"false",REFBOX_AUTO_REPAIR:"false",REFBOX_PLUGIN_MANIFESTS:"[]",REFBOX_MODEL:"kimi-k3",REFBOX_GOAL_MODEL:"kimi-k3",
    REFBOX_ENGINE_PORT:String(port+1),REFBOX_LISTEN:"127.0.0.1:"+port,REFBOX_ENGINE_URL:url.replace(String(port),String(port+1)),
    REFBOX_PLATFORM_URL:url,REFBOX_VERIFIER_URL:url.replace(String(port),String(port+12)),REFBOX_VERIFIER_PORT:String(port+12),
    REFBOX_DATABASE:join(runDir,"engine.sqlite"),REFBOX_PLATFORM_DATABASE:join(runDir,"platform.sqlite"),REFBOX_VERIFIER_DATABASE:join(runDir,"verifier.sqlite"),
    REFBOX_GOAL_SOURCE_REPOSITORY:repo,REFBOX_GOAL_WORKSPACE_ROOT:join(runDir,"goals"),REFBOX_GOAL_SHARED_DEPENDENCIES_ROOT:repo,REFBOX_GOAL_DEPENDENCIES_DIR:join(repo,"node_modules"),
    REFBOX_GOAL_TRUSTED_BASELINE_REPOSITORY:repo,REFBOX_GOAL_TRUSTED_BASELINE_REVISION:baseline,
    REFBOX_GOAL_PROOF_ROOT:join(runDir,"proofs"),REFBOX_WEB_DIR:join(repo,"apps/web/dist"),REFBOX_WIKI_DIR:"/Users/ryou/workspace/NOTE/03-Resources/wiki",
    GOCACHE:join(runDir,"go-cache-verifier"),GOMODCACHE:process.env.GOMODCACHE??"/Users/ryou/go/pkg/mod",
  };
  config={password,env};
  const text=Object.entries(env).filter(([key,value])=>/^[A-Z_][A-Z0-9_]*$/.test(key)&&typeof value==="string"&&!value.includes("\n")).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join("\n")+"\n";
  const envFile=join(runDir,"private.env");await writeFile(envFile,text,{mode:0o600});if(process.getuid()===0)await chown(envFile,501,20);
  await writeFile(join(runDir,"configuration.private.json"),JSON.stringify(config),{mode:0o600});if(process.getuid()===0)await chown(join(runDir,"configuration.private.json"),501,20);
  const wrapper=`import {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(join(repo,"bin/refbox"))},[],{env:process.env,stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('exit',code=>process.exit(code??1));`;
  await writeFile(join(runDir,"control.mjs"),wrapper,{mode:0o644});
}
async function start(name){
  const module={engine:join(repo,"apps/runtime/dist/main.js"),control:join(runDir,"control.mjs"),verifier:join(repo,"apps/services/prover.mjs")}[name];
  const args=[node,"--env-file="+join(runDir,"private.env"),module];
  const log=await open(join(runDir,name+".log"),"a",0o600);
  const privileged=process.getuid()===0;
  const cmd=privileged&&name!=="engine"?"/usr/bin/sudo":node;
  const argv=privileged&&name!=="engine"?["-u","ryou","-E",...args]:args.slice(1);
  const launchEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("REFBOX_")));
  const child=spawn(cmd,argv,{cwd:repo,env:{...launchEnv,HOME:"/Users/ryou"},stdio:["ignore",log.fd,log.fd]});
  children.set(name,{child,log,exited:false});child.once("exit",()=>{const entry=children.get(name);if(entry)entry.exited=true;});
  progress({started:name,pid:child.pid});
}
async function stop(name){const entry=children.get(name);if(!entry)return;if(!entry.exited){entry.child.kill("SIGTERM");for(let i=0;i<100&&!entry.exited;i++)await new Promise(r=>setTimeout(r,100));if(!entry.exited){entry.child.kill("SIGKILL");for(let i=0;i<30&&!entry.exited;i++)await new Promise(r=>setTimeout(r,100));}}
  assert.ok(entry.exited,name+" shutdown was not confirmed");await entry.log.close();children.delete(name);report.cleanup.push(name);}
async function request(path,input,base=url,token){const headers=token?{Authorization:"Bearer "+token}:{Cookie:cookie,Origin:url,"X-Refbox-Request":"1","Idempotency-Key":"self:"+randomBytes(12).toString("hex")};
  const response=await fetch(base+path,{method:input===undefined?"GET":"POST",headers:{...headers,"Content-Type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw Error(`${path}: HTTP${response.status} ${data.error??''}`);return {data,response};}
async function login(){const {response}=await request("/api/login",{password:config.password});cookie=response.headers.get("set-cookie")?.split(";")[0];assert.ok(cookie);}
async function ready(){for(let i=0;i<90;i++){try{await request("/health");await request("/api/health",undefined,config.env.REFBOX_ENGINE_URL,config.env.REFBOX_ENGINE_TOKEN);const v=await request("/health",undefined,config.env.REFBOX_VERIFIER_URL,config.env.REFBOX_VERIFIER_TOKEN);if(v.data.reviewerAvailable)return;}catch{}await new Promise(r=>setTimeout(r,1000));}throw Error("Real graph failed readiness");}
async function runGoal(goal,index){const {data:created}=await request("/api/platform/goals",{goal});report.goals.push({index,id:created.id,goal,cwd:created.cwd,baseline:created.goalLoop.baselineRevision});await save();progress({created:index,id:created.id,cwd:created.cwd});let last="";
  const deadline=Date.now()+45*60*1000;
  while(Date.now()<deadline){const {data:task}=await request("/api/platform/tasks/"+created.id);const phase=task.goalLoop.phase,stamp=JSON.stringify([phase,task.goalLoop.rounds,task.goalLoop.planningAttempt,task.goalLoop.reason]);if(stamp!==last){progress({index,id:task.id,phase,rounds:task.goalLoop.rounds,reason:task.goalLoop.reason});last=stamp;await writeFile(join(runDir,`goal-${index}.json`),JSON.stringify(task,null,2),{mode:0o600});}
    if(phase==="completed"){const proof=task.goalLoop.reviews.filter(p=>p.candidateId&&p.verdict==="pass").at(-1);assert.ok(proof?.candidateId?.startsWith("git:"));assert.ok(proof.reviewConversationId);assert.ok(proof.checks.every(c=>c.passed));const revision=proof.candidateId.slice(4);const actual=await execute("git",["-c","safe.directory="+created.cwd,"-C",created.cwd,"rev-parse","HEAD"]).then(r=>r.stdout.trim());assert.equal(actual,revision);report.goals.at(-1).candidate=revision;report.goals.at(-1).contractHash=task.goalLoop.contract.hash;report.goals.at(-1).reviewConversationId=proof.reviewConversationId;await save();return {task,revision};}
    if(phase==="blocked"||phase==="paused")throw Error("Goal stopped: "+task.goalLoop.reason);
    await new Promise(r=>setTimeout(r,3000));
  }throw Error("Real autonomous goal exceeded acceptance deadline");}
async function adopt(candidate,index){
  const status=await execute("git",["-c","safe.directory="+repo,"-C",repo,"status","--porcelain"]).then(r=>r.stdout.trim());assert.equal(status,"","Bootstrap checkout changed during autonomous execution");
  await execute("git",["-c","safe.directory="+repo,"-C",repo,"merge","--ff-only",candidate.revision]);
  await execute("go",["build","-o",join(repo,"bin/refbox"),"./cmd/refbox"],{cwd:repo,env:config.env,maxBuffer:1024*1024});
  await stop("control");await start("control");await ready();await login();
  report.adoptions.push({index,revision:candidate.revision,at:new Date().toISOString(),actualNewGoalSource:candidate.revision});await save();progress({adopted:index,revision:candidate.revision});
}
try{
  await configure();for(const name of["engine","control","verifier"])await start(name);await ready();await login();
  progress({graph:url,baseline,engineUID:process.getuid(),model:"engy/kimi-k3"});
  const first=await runGoal(goalA,1);await adopt(first,1);
  const second=await runGoal(goalB,2);assert.equal(second.task.goalLoop.baselineRevision,first.revision);await adopt(second,2);
  report.status="passed";report.completedAt=new Date().toISOString();await save();progress({status:report.status,goals:report.goals.map(({id,candidate,baseline})=>({id,candidate,baseline}))});
}catch(error){report.status="failed";report.error=error.message;await save().catch(()=>{});progress({status:"failed",error:error.message});process.exitCode=1;
}finally{for(const name of["control","verifier","engine"])await stop(name).catch(error=>{report.cleanupError=error.message;process.exitCode=1;});await save().catch(()=>{});}
