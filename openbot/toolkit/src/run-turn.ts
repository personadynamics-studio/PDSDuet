import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { NOT_SHOWN } from "@openbot/shared/component-markers";
import { frameFiring } from "@openbot/shared/routine-firing";
import type { ApprovalContinuation } from "./continuation";
import { HeadlessToolsMiddleware, HeadlessToolSuspension, OPENBOT_WAITING_METADATA, type HeadlessTool, type HeadlessWaiting } from "./headless-tools";
import { mergeContinuationHistory, sanitizeSeededHistory } from "./history-sanitize";
import type { AuditInitiator } from "./initiator";
import { ThreadLockBusyError } from "./lease";
import type { ComponentCatalog, TurnAdmission } from "./ports";
export { frameFiring, sanitizeSeededHistory };

export type TurnRunner = (input: {
  ownerUserId: string; // the actor the run asserts — grants and connections resolve to them
  routineId: string; // what the trail names as having started this turn, rather than the owner
  agentId: string;
  threadId: string; // the owner's thread for the routine's channel
  instruction: string; // the user message of this turn
  initiator?: AuditInitiator;
  signal?: AbortSignal;
  continuation?: {
    snapshot: ApprovalContinuation;
    result: { content: string; error?: string };
    messageId: string;
  };
  userMessage?: Message;
  /** Trusted server-resolved skills, persisted as rows and included in this turn's model context. */
  systemMessages?: Extract<Message, { role: "system" }>[];
  /** Durable inbound delivery id; reused by lock, runner and emitted events. */
  runId?: string;
  parentRunId?: string;
  /** How deep in a Bot-to-Bot chain this turn is. Absent is a person's own turn, depth zero. */
  depth?: number;
  /** The reply so far, each time more of it arrives, for a surface that shows a turn in progress. */
  onText?: (text: string) => void;
}) => Promise<{
  replyText: string;
  components?: DrawnComponent[];
  replyChips?: boolean;
}>;

/** A display component the Bot drew in a turn and the server allowed, with the props it drew. */
export type DrawnComponent = { name: string; args: Record<string, unknown> };


export type ThreadStoreLike = {
  getOrCreateThread(input:{threadId:string;userId:string;agentId:string}):Promise<unknown>;
  getThreadMessages(input:{threadId:string;userId:string}):Promise<{messages:Message[]}>;
};
export type RunnerLike = {
  run(input:{threadId:string;agent:AbstractAgent;agentId?:string;input:RunAgentInput;persistedInputMessages?:Message[];parentRunId?:string;signal?:AbortSignal}):{subscribe(observer:{next:(event:BaseEvent)=>void;error:(error:unknown)=>void;complete:()=>void}):unknown};
  stop(input:{threadId:string;runId:string}):Promise<boolean|undefined>;
};
export function drawnComponents(
  messages: Message[],
  componentNames: ReadonlySet<string>,
): DrawnComponent[] {
  const results = new Map<string, string>();
  for (const message of messages)
    if (message.role === "tool" && typeof message.content === "string")
      results.set(message.toolCallId, message.content);
  const drawn: DrawnComponent[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!componentNames.has(call.function.name)) continue;
      const result = results.get(call.id);
      if (result === undefined || result.startsWith(NOT_SHOWN)) continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (args && typeof args === "object" && !Array.isArray(args))
          drawn.push({ name: call.function.name, args });
      } catch {
        // A call whose arguments are not JSON was refused by the schema check, so nothing was drawn.
      }
    }
  }
  return drawn;
}


/** Browser, schedule, approval and handoff turns all execute through the same server runner. */
export function createTurnRunner(options:{
  threads:ThreadStoreLike;runner:RunnerLike;admission:TurnAdmission;
  buildAgentFor:(input:{ownerUserId:string;agentId:string;initiator:AuditInitiator;depth?:number})=>Promise<AbstractAgent>;
  toolsForTurn?:(input:{ownerUserId:string;agentId:string;initiator:AuditInitiator;threadId:string;runId:string})=>Promise<HeadlessTool[]>;
  components?:ComponentCatalog;turnTimeoutMs?:number;
}):TurnRunner {
  return async(request)=>{
    const {ownerUserId,agentId,threadId,continuation,systemMessages=[]}=request;
    const admitted=await options.admission({ownerUserId,agentId,signal:request.signal});
    const {signal}=admitted;
    try {
    signal.throwIfAborted();
    if(continuation&&continuation.snapshot.threadId!==threadId)throw new Error('The continuation belongs to another conversation.');
    const initiator=request.initiator??{kind:'routine' as const,id:request.routineId};
    const runId=request.runId??crypto.randomUUID();
    await options.threads.getOrCreateThread({threadId,userId:ownerUserId,agentId});
    const history=(await options.threads.getThreadMessages({threadId,userId:ownerUserId})).messages;
    const historicIds=new Set(history.map((message)=>message.id));
    const messages:Message[]=continuation?sanitizeSeededHistory(mergeContinuationHistory(history, continuation.snapshot.messages, [
      {id:continuation.messageId,role:'tool',toolCallId:continuation.snapshot.toolCallId,content:continuation.result.content},
    ])):[
      ...sanitizeSeededHistory(history),...systemMessages,
      request.userMessage??{id:crypto.randomUUID(),role:'user',content:frameFiring(request.instruction)},
    ];
    const agent=await options.buildAgentFor({ownerUserId,agentId,initiator,depth:request.depth});
    agent.threadId=threadId;agent.setMessages(messages);
    if(continuation)agent.setState(continuation.snapshot.state);
    const tools=[...(await options.toolsForTurn?.({ownerUserId,agentId,initiator,threadId,runId})??[]),...(await options.components?.toolsForTurn({ownerUserId,agentId,initiator})??[])];
    if(tools.length)agent.use(new HeadlessToolsMiddleware(tools,initiator));
    const input:RunAgentInput={
      threadId,runId,messages,state:agent.state,
      tools:tools.filter((tool)=>!tool.hidden).map((tool)=>tool.definition),
      context:continuation?.snapshot.context??systemMessages.map((message,index)=>({description:`Selected skill ${index+1}`,value:message.content})),
      forwardedProps:continuation?.snapshot.forwardedProps,
      ...(continuation?{resume:[{interruptId:continuation.snapshot.toolCallId,status:'resolved' as const,payload:continuation.result.content}]}:{}),
    };
    let waiting:HeadlessToolSuspension|undefined;
    let stopped=false;
    let terminal:Error|undefined;
    const text:string[]=[];
    const stop=()=>{stopped=true;void options.runner.stop({threadId,runId});};
    const deadline=setTimeout(stop,options.turnTimeoutMs??180_000);deadline.unref?.();
    try{
      signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        options.runner.run({threadId,agent,agentId,input,signal,parentRunId:request.parentRunId??continuation?.snapshot.runId,persistedInputMessages:messages.filter((message)=>!historicIds.has(message.id))}).subscribe({
          next:(event)=>{
            if(event.type==='TEXT_MESSAGE_CONTENT'){text.push(String(event.delta??''));request.onText?.(text.join(''));}
            if(event.type==='CUSTOM'&&event.name==='openbot.headless.waiting'){const value=event.value as HeadlessWaiting&{message?:string};waiting=new HeadlessToolSuspension(value.message??'The turn is waiting for human input.',value);}
            if(event.type==='RUN_FINISHED'&&event.outcome?.type==='interrupt'){
              const interrupt=event.outcome.interrupts.find((item)=>item.metadata?.[OPENBOT_WAITING_METADATA]);
              if(interrupt){const value=interrupt.metadata?.[OPENBOT_WAITING_METADATA] as HeadlessWaiting&{message?:string};waiting=new HeadlessToolSuspension(value.message??'The turn is waiting for human input.',value);}
            }
            if(event.type==='RUN_ERROR')terminal=new Error(String(event.message??'The turn failed.'));
            if(event.type==='RUN_FINISHED'&&(event as BaseEvent&{status?:string}).status==='stopped'){
              terminal=new Error('The work was cancelled.');terminal.name='RunStoppedError';
            }
            if(event.type==='RUN_FINISHED'&&['failed','interrupted'].includes((event as BaseEvent&{status?:string}).status??''))
              terminal=new Error((event as BaseEvent&{error?:string}).error??'The turn did not complete.');
          },error:reject,complete:resolve,
        });
      });
      if(waiting)throw waiting;
      if(stopped)throw new Error('The turn was stopped.');
      if(terminal)throw terminal;
      const added=agent.messages.filter((message)=>!historicIds.has(message.id));
      const replyText=added.filter((message)=>message.role==='assistant').map((message)=>typeof message.content==='string'?message.content:'').filter(Boolean).join('\n\n')||text.join('');
      return {replyText,components:drawnComponents(added,options.components?.names??new Set()),...(added.some((message)=>message.role==='tool'&&String(message.content).startsWith('The buttons are'))?{replyChips:true}:{})};
    }catch(error){
      if(error&&typeof error==='object'&&'status' in error&&error.status===409)throw new ThreadLockBusyError(error);
      throw error;
    }finally{clearTimeout(deadline);}
    } finally { admitted.dispose(); }
  };
}
