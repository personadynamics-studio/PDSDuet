import { MessageSchema } from "@ag-ui/core";
import type { ThreadRun, ThreadMessage } from "@openbot/shared/thread-events";
import type { TurnExecutor } from "@openbot/toolkit/run-turn";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import { LocalAgentRunner } from "./local-runner";
import { type LocalThreadStore,ThreadAccessError,ThreadConflictError } from "./thread-store";

const runBody=z.object({
  agentId:z.string().min(1).optional(),
  messages:z.array(MessageSchema),
  context:z.array(z.object({description:z.string(),value:z.string()})).default([]),
});
export function createLocalRuntime(options:{
  threads:LocalThreadStore;runner:LocalAgentRunner;executor:TurnExecutor;
  identifyActor:(request:Request)=>Promise<AgentActor>;
  onReply?:(input:{actor:AgentActor;agentId:string;threadId:string;runId:string;text:string})=>Promise<void>;
}) {
  const {threads,runner,executor,identifyActor}=options;
  const handler=new Hono<{Variables:{actor:AgentActor}}>();
  handler.use("/api/threads/*",bodyLimit({maxSize:4*1024*1024}),async(context,next)=>{
    let actor:AgentActor;
    try{actor=await identifyActor(context.req.raw);}catch{return context.json({error:"Sign in first."},401);}
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
    if(body.agentId)await threads.getOrCreateThread({threadId,userId:actor.id,agentId:body.agentId});
    else await threads.getThread({threadId,userId:actor.id});
    const {messages:history}=await threads.getThreadMessages({threadId,userId:actor.id});
    const historicIds=new Set(history.map(message=>message.id));
    const added=body.messages.filter(message=>!historicIds.has(message.id)).map((message):ThreadMessage=>({...message,senderUserId:actor.id,createdAt:new Date().toISOString()}));
    if(!added.length)throw new ThreadConflictError("No new message or human response was supplied.");
    let agentId=body.agentId;
    let ownerUserId=actor.id;
    let parentRunId:string|undefined;
    for(const message of added){
      if(message.role==="user")continue;
      if(message.role!=="tool")throw new ThreadConflictError("Only a person or a waiting human response may add a message.");
      const waiting=await threads.waitingRunForTool(threadId,message.toolCallId);
      if(!waiting||(parentRunId&&parentRunId!==waiting.id))throw new ThreadConflictError("The response does not belong to a currently waiting tool.");
      parentRunId=waiting.id;agentId=waiting.agentId;ownerUserId=waiting.userId;
    }
    if(!agentId)throw new ThreadConflictError("Choose a Bot before starting a conversation.");
    const selectedAgentId=agentId;
    const started=await executor.start({
      ownerUserId,agentId:selectedAgentId,threadId,instruction:"",messages:added,context:body.context,parentRunId,
    });
    let status:ThreadRun["status"]|undefined;
    started.events.subscribe({
      next:event=>{if(event.type==="RUN_FINISHED")status=(event as unknown as ThreadRun).status;},
      error:error=>console.error({type:"chat-execution-failed",error:error instanceof Error?error.name:"Error"}),
      complete:()=>{
        if(status!=="completed")return;
        const text=started.agent.messages.filter(message=>message.role==="assistant"&&!started.historicIds.has(message.id)).map(message=>typeof message.content==="string"?message.content:"").filter(Boolean).join("\n\n");
        if(text)void options.onReply?.({actor,agentId:selectedAgentId,threadId,runId:started.runId,text}).catch(error=>console.error({type:"channel-reply-activity-failed",error:String(error)}));
      },
    });
    return context.json({runId:started.runId},202);
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
  return {handler,threads,runner,executor};
}
export type LocalRuntime=ReturnType<typeof createLocalRuntime>;

