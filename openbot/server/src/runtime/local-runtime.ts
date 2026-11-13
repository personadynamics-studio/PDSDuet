import { type AbstractAgent, type Message, type RunAgentInput } from "@ag-ui/client";
import { MessageSchema } from "@ag-ui/core";
import { HeadlessToolsMiddleware, type HeadlessTool } from "@openbot/toolkit/headless-tools";
import type { ThreadLock, TurnAdmission } from "@openbot/toolkit/ports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import { LocalAgentRunner } from "./local-runner";
import { type LocalThreadStore, ThreadAccessError, ThreadConflictError } from "./thread-store";

const runBody=z.object({
  agentId:z.string().min(1).max(200),
  messages:z.array(MessageSchema).max(2000).default([]),
  tools:z.array(z.object({name:z.string().min(1),description:z.string(),parameters:z.record(z.string(),z.unknown())})).max(500).default([]),
  context:z.array(z.object({description:z.string(),value:z.string()})).max(500).default([]),
  state:z.unknown().optional(),forwardedProps:z.record(z.string(),z.unknown()).optional(),
  resume:z.array(z.object({interruptId:z.string(),status:z.enum(['resolved','rejected']),payload:z.unknown().optional()})).optional(),
});

export function createLocalRuntime(options:{
  threads:LocalThreadStore;
  runner:LocalAgentRunner;
  resolver:ActorAgentResolver;
  identifyActor:(request:Request)=>Promise<AgentActor>;
  admission:TurnAdmission;
  onReply?:(input:{actor:AgentActor;agentId:string;threadId:string;runId:string;text:string})=>Promise<void>;
  toolsForTurn?:(input:{actor:AgentActor;agentId:string;threadId:string;runId:string})=>Promise<HeadlessTool[]>;
}) {
  const {threads,runner,resolver,identifyActor}=options;
  const handler=new Hono<{Variables:{actor:AgentActor}}>();
  handler.use('/api/threads/*',bodyLimit({maxSize:4*1024*1024}),async(context,next)=>{
    const actor=await identifyActor(context.req.raw);
    if(!actor.id.trim())return context.json({error:'Authentication required.'},401);
    context.set('actor',actor); await next();
  });
  handler.onError((error,context)=>{
    if(error instanceof ThreadAccessError)return context.json({error:error.message},404);
    if(error instanceof ThreadConflictError)return context.json({error:error.message},409);
    if(error instanceof z.ZodError)return context.json({error:'Invalid run input.'},400);
    console.error({type:'local-runtime-error',error:error.name});
    return context.json({error:'The conversation could not be processed.'},500);
  });
  handler.get('/api/threads/:threadId',async(context)=>{
    try {await threads.getThread({threadId:context.req.param('threadId'),userId:context.var.actor.id});return context.json({known:true});}
    catch(error){if(error instanceof ThreadAccessError)return context.json({known:false});throw error;}
  });
  handler.get('/api/threads/:threadId/messages',async(context)=>{
    const threadId=context.req.param('threadId');
    await threads.requireAccess(threadId,context.var.actor.id);
    const snapshot=await threads.snapshot(threadId,context.var.actor.id);
    return context.json({...snapshot,activeRun:await threads.activeRun(threadId)});
  });
  handler.post('/api/threads/:threadId/runs',async(context)=>{
    const body=runBody.parse(await context.req.json());
    const actor=context.var.actor;
    const threadId=context.req.param('threadId');
    const admitted=await options.admission({ownerUserId:actor.id,agentId:body.agentId});
    if(admitted.aborted)throw new ThreadConflictError('The Bot was paused.');
    const agent=await resolver.resolveAgentForActor(actor,body.agentId);
    const thread=await threads.getOrCreateThread({threadId,userId:actor.id,agentId:body.agentId});
    const {messages:history}=await threads.getThreadMessages({threadId,userId:actor.id});
    const historicIds=new Set(history.map((message)=>message.id));
    const answered=new Set(history.flatMap((message)=>message.role==='tool'?[message.toolCallId]:[]));
    const pending=new Set(history.flatMap((message)=>message.role==='assistant'?(message.toolCalls??[]).map((call)=>call.id):[]).filter((id)=>!answered.has(id)));
    const added=body.messages.filter((message)=>!historicIds.has(message.id));
    if(added.some((message)=>message.role!=='user'&&(message.role!=='tool'||!pending.has(message.toolCallId))))return context.json({error:'Only new user messages and pending tool answers may be submitted.'},400);
    for(const message of added)if(message.role==='tool'){if(answered.has(message.toolCallId))return context.json({error:'This tool call has already been answered.'},409);answered.add(message.toolCallId);}
    if(body.resume?.some((entry)=>!pending.has(entry.interruptId)))return context.json({error:'The requested continuation does not belong to this conversation.'},400);
    if(!added.length&&!body.resume?.length)return context.json({error:'No new message or tool answer was supplied.'},409);
    const runId=crypto.randomUUID();
    await threads.acquireLock({threadId,runId,userId:actor.id,agentId:body.agentId});
    try {
      const tools=await options.toolsForTurn?.({actor,agentId:body.agentId,threadId,runId});
      if(tools?.length)agent.use(new HeadlessToolsMiddleware(tools));
      const input:RunAgentInput={threadId,runId,messages:[...history,...added] as Message[],tools:body.tools,context:body.context,state:thread.state??null,forwardedProps:body.forwardedProps??{},...(body.resume?{resume:body.resume}: {})};
      agent.threadId=threadId; agent.setMessages(input.messages); agent.setState(input.state);
      await threads.saveMessages(threadId,added,undefined,runId);
      const stop=()=>{void runner.stop({threadId,runId});};
      admitted.addEventListener('abort',stop,{once:true});
      const detach=()=>admitted.removeEventListener('abort',stop);
      let failed=false;
      runner.run({threadId,agent,input,persistedInputMessages:added as Message[]}).subscribe({
        next:(event)=>{if(event.type==='RUN_ERROR')failed=true;},
        error:detach,
        complete:()=>{
          detach();
          if(failed)return;
          const text=agent.messages.filter((message)=>message.role==='assistant'&&!historicIds.has(message.id)).map((message)=>typeof message.content==='string'?message.content:'').filter(Boolean).join('\n\n');
          if(text)void options.onReply?.({actor,agentId:body.agentId,threadId,runId,text}).catch(()=>console.error({type:'channel-reply-activity-failed'}));
        },
      });
      if(admitted.aborted)stop();
    } catch(error){await threads.releaseLock({threadId,runId});throw error;}
    return context.json({runId},202);
  });
  handler.post('/api/threads/:threadId/runs/:runId/stop',async(context)=>{
    const threadId=context.req.param('threadId');await threads.requireAccess(threadId,context.var.actor.id);
    return context.json({stopped:await runner.stop({threadId,runId:context.req.param('runId')})});
  });
  handler.get('/api/threads/:threadId/events',async(context)=>{
    const threadId=context.req.param('threadId'); const userId=context.var.actor.id;
    await threads.requireAccess(threadId,userId);
    const after=Number(context.req.query('after')??context.req.header('Last-Event-ID')??0);
    if(!Number.isSafeInteger(after)||after<0)return context.json({error:'Invalid event cursor.'},400);
    return streamSSE(context,async(stream)=>{
      let cursor=after; let cancelled=false;
      stream.onAbort(()=>{cancelled=true;});
      while(!cancelled){
        const events=await threads.events(threadId,cursor,userId);
        for(const event of events){await stream.writeSSE({id:String(event.seq),data:JSON.stringify(event)});cursor=event.seq;}
        if(events.length===500)continue;
        const active=await threads.activeRun(threadId);
        if(!active||active.status==='waiting')break;
        await stream.sleep(250);
      }
    });
  });
  const threadLock:ThreadLock={
    acquire:async(input)=>{try{return await threads.acquireLock(input);}catch(error){if(error instanceof ThreadConflictError)return null;throw error;}},
    renew:(input)=>threads.renewLock(input),release:(input)=>threads.releaseLock(input),
  };
  const agentFor=async(input:{actor:AgentActor;botId:string;initiator?:AuditInitiator}):Promise<AbstractAgent|null>=>resolver.resolveAgentForActor(input.actor,input.botId,{initiator:input.initiator});
  return {handler,threads,runner,threadLock,agentFor,history:async(input:{threadId:string;actorId:string})=>(await threads.getThreadMessages({threadId:input.threadId,userId:input.actorId})).messages};
}
export type LocalRuntime=ReturnType<typeof createLocalRuntime>;
