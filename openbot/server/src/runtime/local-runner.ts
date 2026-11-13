import type { AbstractAgent, BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { Observable, ReplaySubject } from "rxjs";
import type { LocalThreadStore, ThreadRun } from "./thread-store";

export type LocalRunRequest = { threadId: string; agent: AbstractAgent; input: RunAgentInput; persistedInputMessages?: Message[] };
type Busy = (input: { threadId: string; runId: string; busy: boolean }) => void | Promise<void>;

/** Work belongs to the server; disconnecting a subscriber only detaches its view. */
export class LocalAgentRunner {
  private readonly active = new Map<string, { agent: AbstractAgent; events: ReplaySubject<BaseEvent> }>();
  constructor(readonly threads: LocalThreadStore, private readonly options: { onRunBusy?: Busy } = {}) {}
  run(request: LocalRunRequest): Observable<BaseEvent> {
    const { runId } = request.input;
    return new Observable((subscriber) => {
      let current = this.active.get(runId);
      if (!current) {
        current = { agent: request.agent, events: new ReplaySubject<BaseEvent>() };
        this.active.set(runId, current);
        void this.execute(request, current.events).catch((error)=>current?.events.error(error));
      }
      const attached = current.events.subscribe(subscriber);
      return () => attached.unsubscribe();
    });
  }
  private async execute(request: LocalRunRequest, stream: ReplaySubject<BaseEvent>) {
    const { threadId, agent, input } = request;
    let token: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let writes = Promise.resolve();
    let status: ThreadRun['status'] = 'completed';
    let terminal = false;
    let stopped = false;
    const rows = new Map(input.messages.map((message) => [message.id, structuredClone(message)]));
    let state = input.state;
    const project = (event: BaseEvent) => {
      const e = event as BaseEvent & Record<string, any>;
      if (e.type === 'MESSAGES_SNAPSHOT') { rows.clear(); for (const row of e.messages) rows.set(row.id, structuredClone(row)); }
      if (e.type === 'STATE_SNAPSHOT') state = e.snapshot;
      if (e.type === 'TEXT_MESSAGE_START' && !rows.has(e.messageId)) rows.set(e.messageId, { id: e.messageId, role: 'assistant', content: '' });
      if (e.type === 'TEXT_MESSAGE_CONTENT') { const row=rows.get(e.messageId); if (row && row.role==='assistant') row.content=String(row.content ?? '')+String(e.delta ?? ''); }
      if (e.type === 'TOOL_CALL_START') {
        const id=e.parentMessageId || `tools:${input.runId}`;
        let row=rows.get(id);
        if (!row || row.role!=='assistant') { row={id,role:'assistant',content:'',toolCalls:[]}; rows.set(id,row); }
        if (row.role==='assistant') { row.toolCalls ??=[]; if (!row.toolCalls.some((call)=>call.id===e.toolCallId)) row.toolCalls.push({id:e.toolCallId,type:'function',function:{name:e.toolCallName,arguments:''}}); }
      }
      if (e.type === 'TOOL_CALL_ARGS') for (const row of rows.values()) if (row.role==='assistant') { const call=row.toolCalls?.find((call)=>call.id===e.toolCallId); if(call) call.function.arguments+=String(e.delta ?? ''); }
      if (e.type === 'TOOL_CALL_RESULT') { const id=e.messageId||crypto.randomUUID(); rows.set(id,{id,role:'tool',toolCallId:e.toolCallId,content:String(e.content??'')}); }
      if (e.type==='RUN_ERROR') { status='failed'; terminal=true; }
      if (e.type==='RUN_FINISHED') { terminal=true; if(e.outcome?.type==='interrupt') status='waiting'; }
    };
    const emit = (event: BaseEvent) => {
      project(event);
      const messages=structuredClone([...rows.values()]);
      const snapshot=structuredClone(state);
      writes=writes.then(async()=>{
        const stored=await this.threads.recordEvent(threadId,input.runId,event,messages,snapshot);
        stream.next(stored);
      });
      // Attach a rejection handler immediately; the authoritative await below still fails the run.
      void writes.catch(()=>{ try { agent.abortRun(); } catch {} });
    };
    try {
      const owner=await this.threads.owner(threadId);
      await this.threads.acquireLock({threadId,runId:input.runId,userId:owner.userId,agentId:owner.agentId});
      token=await this.threads.claimExecution(input.runId);
      await this.threads.saveMessages(threadId,request.persistedInputMessages ?? input.messages,undefined,input.runId);
      await this.options.onRunBusy?.({threadId,runId:input.runId,busy:true});
      let renewing=false;
      timer=setInterval(()=>{
        if(renewing) return;
        renewing=true;
        void (async()=>{
          await this.threads.renewLock({threadId,runId:input.runId});
          if(await this.threads.stopRequested(input.runId)){ stopped=true; agent.abortRun(); }
        })().catch(()=>{stopped=true;agent.abortRun();}).finally(()=>{renewing=false;});
      },1000);
      timer.unref?.();
      await agent.runAgent(input,{onEvent:({event})=>emit(event)});
      await writes;
      await this.threads.saveMessages(threadId,agent.messages,agent.state,input.runId);
      if(await this.threads.stopRequested(input.runId))stopped=true;
      if(stopped)throw new Error('The run was stopped.');
      if(!terminal) emit({type:'RUN_FINISHED',threadId,runId:input.runId} as BaseEvent);
      await writes;
    } catch(error) {
      try{await writes;}catch{}
      if(token)try{stopped=stopped||await this.threads.stopRequested(input.runId);}catch{}
      status=stopped?'stopped':'failed';
      if(token){
        const event={type:'RUN_ERROR',message:stopped?'The run was stopped.':error instanceof Error?error.message:'The run failed.',code:stopped?'STOPPED':'RUN_FAILED'} as BaseEvent;
        try { const stored=await this.threads.appendEvent(threadId,input.runId,event); stream.next(stored); } catch {}
      }
      stream.error(error);
    } finally {
      if(timer) clearInterval(timer);
      if(token){
        try{await this.threads.finish(input.runId,token,status);}finally{await this.threads.releaseLock({threadId,runId:input.runId});}
      }
      try{await this.options.onRunBusy?.({threadId,runId:input.runId,busy:false});}catch{}
      this.active.delete(input.runId);
      if(!stream.closed) stream.complete();
    }
  }
  async stop(input:{threadId:string;runId:string}) {
    const stopped=await this.threads.requestStop(input.threadId,input.runId);
    if(stopped) this.active.get(input.runId)?.agent.abortRun();
    return stopped;
  }
  async isRunning(input:{threadId:string}) { const run=await this.threads.activeRun(input.threadId); return run?.status==='running'||run?.status==='pending'; }
}
