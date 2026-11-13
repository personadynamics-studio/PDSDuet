import { type AbstractAgent, type Message, type RunAgentInput } from "@ag-ui/client";
import { MessageSchema } from "@ag-ui/core";
import type { ThreadRun } from "@openbot/shared/thread-events";
import { HeadlessToolsMiddleware,type HeadlessTool } from "@openbot/toolkit/headless-tools";
import type { TurnAdmission } from "@openbot/toolkit/ports";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import { LocalAgentRunner } from "./local-runner";
import { type LocalThreadStore,ThreadAccessError,ThreadConflictError } from "./thread-store";

const runBody=z.object({
  agentId:z.string().min(1),
  messages:z.array(MessageSchema),
  context:z.array(z.object({description:z.string(),value:z.string()})).default([]),
});
export function createLocalRuntime(options:{
  threads:LocalThreadStore;runner:LocalAgentRunner;resolver:ActorAgentResolver;
  identifyActor:(request:Request)=>Promise<AgentActor>;admission:TurnAdmission;
  onReply?:(input:{actor:AgentActor;agentId:string;threadId:string;runId:string;text:string})=>Promise<void>;
  toolsForTurn?:(input:{actor:AgentActor;agentId:string;threadId:string;runId:string})=>Promise<HeadlessTool[]>;
}) {
  const {threads,runner,resolver,identifyActor}=options;
  const handler=new Hono<{Variables:{actor:AgentActor}}>();
  handler.use("/api/threads/*",bodyLimit({maxSize:4*1024*1024}),async(context,next)=>{
    const actor=await identifyActor(context.req.raw);
    context.set("actor",actor);await next();
  });
  handler.onError((error,context)=>{
    if(error instanceof ThreadAccessError)return context.json({error:error.message},404);
    if(error instanceof ThreadConflictError)return context.json({error:error.message},409);
    if(error instanceof z.ZodError)return context.json({error:"Invalid run input."},400);
    console.error({type:"local-runtime-error",error:error.name});
    return context.json({error:"The conversation could not be processed."},500);
  });
  handler.get("/api/threads/:threadId",async(context)=>{
    try{await threads.getThread({threadId:context.req.param("threadId"),userId:context.var.actor.id});return context.json({known:true});}
    catch(error){if(error instanceof ThreadAccessError)return context.json({known:false});throw error;}
  });
  handler.get("/api/threads/:threadId/messages",async(context)=>context.json(await threads.snapshot(context.req.param("threadId"),context.var.actor.id)));
  handler.post("/api/threads/:threadId/runs",async(context)=>{
    const body=runBody.parse(await context.req.json());
    const actor=context.var.actor;
    const threadId=context.req.param("threadId");
    const thread=await threads.getOrCreateThread({threadId,userId:actor.id,agentId:body.agentId});
    const {messages:history}=await threads.getThreadMessages({threadId,userId:actor.id});
    const historicIds=new Set(history.map(message=>message.id));
    const added=body.messages.filter(message=>!historicIds.has(message.id));
    const last=await threads.lastRun(threadId);
    const humanAnswers=new Map((last?.status==="waiting"?last.waiting??[]:[])
      .filter(item=>(item as {answerable?:boolean}).answerable===true).map(item=>[item.toolCallId,item]));
    for(const message of added){
      if(message.role==="user")continue;
      if(message.role!=="tool"||!humanAnswers.delete(message.toolCallId))throw new ThreadConflictError("Only a currently waiting human response may answer this tool.");
    }
    if(!added.length)throw new ThreadConflictError("No new message or human response was supplied.");
    const scope=await options.admission({ownerUserId:actor.id,agentId:body.agentId});
    try{
      scope.signal.throwIfAborted();
      const agent=await resolver.resolveAgentForActor(actor,body.agentId);
      const runId=crypto.randomUUID();
      const tools=await options.toolsForTurn?.({actor,agentId:body.agentId,threadId,runId})??[];
      if(tools.length)agent.use(new HeadlessToolsMiddleware(tools));
      const input:RunAgentInput={threadId,runId,messages:[...history,...added] as Message[],tools:[],context:body.context,state:thread.state??null};
      agent.threadId=threadId;agent.setMessages(input.messages);agent.setState(input.state);
      const events=await runner.start({threadId,agent,agentId:body.agentId,input,persistedInputMessages:added,parentRunId:added.some(message=>message.role==="tool")?last?.id:undefined,signal:scope.signal,dispose:scope.dispose});
      let failed=false;
      events.subscribe({
        next:event=>{if(event.type==="RUN_FINISHED"&&(event as unknown as ThreadRun).status!=="completed")failed=true;},
        error:error=>console.error({type:"chat-execution-failed",error:error instanceof Error?error.name:"Error"}),
        complete:()=>{
          if(failed)return;
          const text=agent.messages.filter(message=>message.role==="assistant"&&!historicIds.has(message.id)).map(message=>typeof message.content==="string"?message.content:"").filter(Boolean).join("\n\n");
          if(text)void options.onReply?.({actor,agentId:body.agentId,threadId,runId,text}).catch(error=>console.error({type:"channel-reply-activity-failed",error:error instanceof Error?error.name:"Error"}));
        },
      });
      return context.json({runId},202);
    }catch(error){scope.dispose();throw error;}
  });
  handler.post("/api/threads/:threadId/runs/:runId/stop",async(context)=>{
    const threadId=context.req.param("threadId");
    await threads.requireAccess(threadId,context.var.actor.id);
    return context.json({stopped:await runner.stop({threadId,runId:context.req.param("runId")})});
  });
  handler.get("/api/threads/:threadId/events",async(context)=>{
    const threadId=context.req.param("threadId");
    await threads.requireAccess(threadId,context.var.actor.id);
    let cursor=Number(context.req.header("Last-Event-ID")??context.req.query("after")??0);
    if(!Number.isSafeInteger(cursor)||cursor<0)return context.json({error:"Invalid event cursor."},400);
    return streamSSE(context,async(stream)=>{
      let closed=false;
      let changed=true;
      let wake:(()=>void)|undefined;
      const unsubscribe=threads.subscribe(threadId,()=>{changed=true;wake?.();});
      stream.onAbort(()=>{closed=true;wake?.();});
      try{
        while(!closed){
          changed=false;
          const events=await threads.events(threadId,cursor);
          for(const event of events){await stream.writeSSE({id:String(event.seq),data:JSON.stringify(event)});cursor=event.seq;}
          if(events.length===500||changed)continue;
          await new Promise<void>(resolve=>{wake=resolve;if(changed||closed)resolve();});
          wake=undefined;
        }
      }finally{unsubscribe();}
    });
  });
  const agentFor=(input:{actor:AgentActor;botId:string;initiator?:AuditInitiator}):Promise<AbstractAgent>=>resolver.resolveAgentForActor(input.actor,input.botId,{initiator:input.initiator});
  return {handler,threads,runner,agentFor,history:async(input:{threadId:string;actorId:string})=>(await threads.getThreadMessages({threadId:input.threadId,userId:input.actorId})).messages};
}
export type LocalRuntime=ReturnType<typeof createLocalRuntime>;

