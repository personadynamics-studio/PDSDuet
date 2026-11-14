import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { projectThreadEvent, type RunStatus, type ThreadEvent, type ThreadMessage, type ThreadRun } from "@openbot/shared/thread-events";
import { defer, from, Observable, Subject, switchMap } from "rxjs";
import { RunStoppedError, type LocalThreadStore } from "./thread-store";

export type LocalRunRequest = {
  threadId:string;userId?:string;agent:AbstractAgent;agentId?:string;input:RunAgentInput;
  persistedInputMessages?:Message[];parentRunId?:string;signal?:AbortSignal;dispose?:()=>void;
};
type Busy=(input:{threadId:string;runId:string;busy:boolean})=>void|Promise<void>;

/** The execution owns its resources. A disconnected observer only leaves the view. */
export class LocalAgentRunner {
  private readonly active=new Map<string,{agent:AbstractAgent}>();
  constructor(readonly threads:LocalThreadStore,private readonly options:{onRunBusy?:Busy}={}) {
    threads.onStop(runId=>this.detach(runId));
  }
  private detach(runId:string) {
    const execution=this.active.get(runId);
    if(execution)void execution.agent.detachActiveRun().catch(error=>console.error({type:"execution-detach-failed",error:String(error)}));
  }
  run(request:LocalRunRequest):Observable<BaseEvent> {
    return defer(()=>from(this.start(request)).pipe(switchMap(events=>events)));
  }
  async start(request:LocalRunRequest):Promise<Observable<BaseEvent>> {
    const {threadId,input}=request;
    const owner=await this.threads.owner(threadId);
    const agentId=request.agentId??request.agent.agentId??owner.agentId;
    const ownsConversation=await this.threads.beginRun({threadId,runId:input.runId,userId:request.userId??owner.userId,agentId,
      parentRunId:request.parentRunId,messages:request.persistedInputMessages??input.messages.filter(message=>message.role!=="system")});
    const events=new Subject<BaseEvent>();
    this.active.set(input.runId,{agent:request.agent});
    void this.execute(request,agentId,events,ownsConversation).catch(error=>events.error(error));
    return events.asObservable();
  }
  private async execute(request:LocalRunRequest,agentId:string,stream:Subject<BaseEvent>,ownsConversation:boolean) {
    const {threadId,agent,input}=request;
    let status:RunStatus="completed";
    let reason:string|undefined;
    let waiting:ThreadRun["waiting"]=[];
    let outcome:unknown;
    let writes=Promise.resolve();
    let writeError:unknown;
    const contextIds=new Set(input.messages.map(message=>message.id));
    const generated=new Set<string>();
    let messages:ThreadMessage[]=[];
    const abort=()=>this.detach(input.runId);
    const cancel=()=>{void this.stop({threadId,runId:input.runId}).catch(error=>{writeError=error;abort();});};
    const busy=async(value:boolean)=>{
      try{await this.options.onRunBusy?.({threadId,runId:input.runId,busy:value});}
      catch(error){console.error({type:"conversation-activity-failed",error:String(error)});}
    };
    let renewing=false;
    const heartbeat=ownsConversation?setInterval(()=>{
      if(renewing)return;renewing=true;
      void this.threads.renewRun(threadId,input.runId).catch(error=>{writeError=error;abort();}).finally(()=>{renewing=false;});
    },30_000):undefined;
    heartbeat?.unref?.();
    request.signal?.addEventListener("abort",cancel,{once:true});
    const persist=async(raw:BaseEvent)=>{
      if(raw.type==="RUN_ERROR"){status=raw.code==="STOPPED"?"stopped":"failed";reason=String(raw.message??"The run failed.");return;}
      if(raw.type==="RUN_FINISHED"){
        outcome=raw.outcome;
        if(raw.outcome?.type==="interrupt"){
          status="waiting";
          waiting=raw.outcome.interrupts.map(interrupt=>{
            const toolCallId=interrupt.toolCallId??interrupt.id;
            const call=messages.flatMap(message=>message.role==="assistant"?message.toolCalls??[]:[]).find(item=>item.id===toolCallId);
            const metadata=interrupt.metadata?.openbotWaiting as Record<string,unknown>|undefined;
            return {toolCallId,toolName:call?.function.name??"",answerable:!metadata||["person_question","computer_handoff","computer_secret"].includes(String(metadata.kind)),...(metadata?{metadata}:{})};
          });
        }
        return;
      }
      let event={...raw,senderBotId:agentId} as ThreadEvent;
      if(event.type==="TOOL_CALL_START"&&typeof event.parentMessageId!=="string")event={...event,parentMessageId:String(event.toolCallId)};
      if(event.type==="TOOL_CALL_RESULT"&&typeof event.messageId!=="string")event={...event,messageId:`tool-result:${String(event.toolCallId)}`};
      let removed:string[]=[];
      if(event.type==="MESSAGES_SNAPSHOT"){
        const output=(event.messages as ThreadMessage[]).filter(message=>!contextIds.has(message.id)&&message.role!=="system"&&message.role!=="user").map(message=>({...message,senderBotId:agentId}));
        const outputIds=new Set(output.map(message=>message.id));
        removed=[...generated].filter(id=>!outputIds.has(id));
        event={...event,messages:[...messages.filter(message=>!generated.has(message.id)),...output]};
        generated.clear();for(const message of output)generated.add(message.id);
      }
      const previous=messages;
      messages=projectThreadEvent(messages,event);
      const changed=messages.filter(message=>!previous.includes(message)).map(message=>({...message,createdAt:message.createdAt??new Date().toISOString()}));
      for(const message of changed)if(!contextIds.has(message.id))generated.add(message.id);
      const state=event.type==="STATE_SNAPSHOT"?event.snapshot:undefined;
      const stored=await this.threads.recordEvent(threadId,input.runId,event,changed,state,removed);
      if(changed.length){const byId=new Map(changed.map(message=>[message.id,message]));messages=messages.map(message=>byId.get(message.id)??message);}
      if(stored.type==="MESSAGES_SNAPSHOT")messages=stored.messages as ThreadMessage[];
      stream.next(stored);
    };
    const enqueue=(event:BaseEvent)=>{
      writes=writes.then(()=>persist(event));
      void writes.catch(error=>{writeError=error;abort();});
      return writes;
    };
    let applying:BaseEvent|undefined;
    try{
      const owner=await this.threads.owner(threadId);
      messages=(await this.threads.getThreadMessages({threadId,userId:request.userId??owner.userId})).messages;
      if(writeError)throw writeError;
      if(request.signal?.aborted||(await this.threads.run(input.runId))?.stopRequested)throw new RunStoppedError("The work was cancelled.");
      void busy(true);
      await agent.runAgent(input,{
        onEvent:({event})=>{
          applying=event;
          if(event.type==="STATE_DELTA"||event.type==="STATE_SNAPSHOT"||event.type==="ACTIVITY_DELTA")return;
          return enqueue(event);
        },
        onStateChanged:({state})=>{
          if(applying?.type!=="STATE_DELTA"&&applying?.type!=="STATE_SNAPSHOT")return;
          applying=undefined;
          void enqueue({type:"STATE_SNAPSHOT",snapshot:structuredClone(state)} as ThreadEvent);
        },
        onMessagesChanged:({messages:updated})=>{
          if(applying?.type!=="ACTIVITY_DELTA")return;
          const id=(applying as ThreadEvent).messageId;
          const activity=updated.find(message=>message.id===id&&message.role==="activity");
          applying=undefined;
          if(activity?.role==="activity")void enqueue({type:"ACTIVITY_SNAPSHOT",messageId:activity.id,activityType:activity.activityType,content:structuredClone(activity.content)} as ThreadEvent);
        },
      });
      await writes;
      if(writeError)throw writeError;
      if(request.signal?.aborted||(await this.threads.run(input.runId))?.stopRequested)throw new RunStoppedError("The work was cancelled.");
    }catch(error){
      try{await writes;}catch(writeFailure){writeError=writeFailure;}
      const stopped=request.signal?.aborted||error instanceof RunStoppedError||(await this.threads.run(input.runId))?.stopRequested;
      status=stopped?"stopped":"failed";
      reason=stopped?"The work was cancelled.":error instanceof Error?error.message:"The run failed.";
    }finally{
      if(heartbeat)clearInterval(heartbeat);
      request.signal?.removeEventListener("abort",cancel);
      this.active.delete(input.runId);
      request.dispose?.();
      try{
        const terminal=await this.threads.finishRun(threadId,input.runId,status,reason,waiting,outcome);
        if(terminal)stream.next(terminal);
        stream.complete();
      }catch(error){stream.error(error);}
      finally{void busy(false);}
    }
  }
  async stop(input:{threadId:string;runId:string}) {
    return this.threads.requestStop(input.threadId,input.runId);
  }
  async isRunning(input:{threadId:string}){return(await this.threads.activeRun(input.threadId))?.status==="running";}
}

