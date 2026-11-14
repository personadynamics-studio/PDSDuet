import type { BaseEvent, Message } from "@ag-ui/client";
import type { RunStatus, ThreadEvent, ThreadMessage, ThreadRun } from "@openbot/shared/thread-events";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";

export class ThreadAccessError extends Error { readonly status = 404; }
export class ThreadConflictError extends Error { readonly status = 409; }
export class RunStoppedError extends Error { override name = "RunStoppedError"; }
export type { ThreadRun };
export type StoredEvent = ThreadEvent & { seq: number };
const LEASE_SECONDS = 120;
const UPDATES = "local_thread_updated";
const STOPS = "local_run_stopped";

export function createLocalThreadStore(database: Database) {
  const viewers = new Map<string, Set<() => void>>();
  const stopListeners = new Set<(runId: string) => void>();
  let connection: ReturnType<typeof postgres> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduling: Promise<void> | undefined;
  const notify = (tx: Pick<Database, "execute">, threadId: string) => tx.execute(sql`select pg_notify(${UPDATES},${threadId})`);

  async function requireAccess(threadId: string, userId: string) {
    const rows = await database.execute<{ allowed: boolean }>(sql`
      with bindings as (
        select channel_id from thread_channel_mappings where thread_id=${threadId}
      ) select case when exists(select 1 from bindings) then exists(
        select 1 from bindings b join channel_memberships cm on cm.channel_id=b.channel_id
        join channels c on c.id=b.channel_id where cm.user_id=${userId} and c.deleted_at is null
      ) else exists(select 1 from local_threads where id=${threadId} and user_id=${userId}) end as allowed`);
    if (!rows[0]?.allowed) throw new ThreadAccessError("Conversation not found.");
  }
  async function getThread(input: { threadId: string; userId: string }) {
    await requireAccess(input.threadId,input.userId);
    const rows=await database.execute<{id:string;agentId:string;state:Record<string,unknown>|null}>(sql`
      select id,agent_id as "agentId",state from local_threads where id=${input.threadId}`);
    if (!rows[0]) throw new ThreadAccessError("Conversation not found.");
    return rows[0];
  }
  async function getOrCreateThread(input: { threadId: string; userId: string; agentId: string }) {
    const rows=await database.execute<{existing:boolean;mapped:boolean}>(sql`select
      exists(select 1 from local_threads where id=${input.threadId}) as existing,
      exists(select 1 from thread_channel_mappings where thread_id=${input.threadId}) as mapped`);
    if (rows[0]?.existing||rows[0]?.mapped) await requireAccess(input.threadId,input.userId);
    await database.execute(sql`insert into local_threads(id,user_id,agent_id) values(${input.threadId},${input.userId},${input.agentId}) on conflict(id) do nothing`);
    return getThread(input);
  }
  async function saveOn(tx: Pick<Database,"execute">, threadId:string, messages:readonly ThreadMessage[]) {
    for (const message of messages) {
      if (message.role==="system") continue;
      await tx.execute(sql`insert into local_messages(thread_id,id,body) values(${threadId},${message.id},${JSON.stringify(message)}::jsonb)
        on conflict(thread_id,id) do update set body=excluded.body`);
    }
  }
  async function eventOn(tx:Pick<Database,"execute">,threadId:string,runId:string,event:BaseEvent):Promise<StoredEvent> {
    const rows=await tx.execute<{seq:number}>(sql`insert into local_events(thread_id,run_id,body)
      values(${threadId},${runId},${JSON.stringify(event)}::jsonb) returning seq`);
    return {...event,seq:Number(rows[0].seq)} as StoredEvent;
  }
  async function expireRuns() {
    await database.transaction(async tx=>{
      const expired=await tx.execute<{id:string;runId:string}>(sql`select id,active_run_id as "runId" from local_threads where active_run_id is not null and lease_until<=now() for update`);
      for(const thread of expired){
        const changed=await tx.execute<{id:string}>(sql`update local_runs set status='interrupted',error='The previous execution ended before completion.',updated_at=now()
          where thread_id=${thread.id} and status='running' returning id`);
        await tx.execute(sql`update local_threads set active_run_id=null,lease_until=null where id=${thread.id}`);
        for(const run of changed){
          await eventOn(tx,thread.id,run.id,{type:"RUN_FINISHED",threadId:thread.id,runId:run.id,status:"interrupted",error:"The previous execution ended before completion."} as ThreadEvent);
          await tx.execute(sql`select pg_notify(${STOPS},${run.id})`);
        }
        if(changed.length)await notify(tx,thread.id);
      }
    });
  }
  function scheduleExpiry():Promise<void> {
    if(scheduling)return scheduling;
    if(expiryTimer)return Promise.resolve();
    scheduling=(async()=>{
      const rows=await database.execute<{delay:number|null}>(sql`select extract(epoch from(min(lease_until)-now()))*1000 as delay from local_threads where active_run_id is not null`);
      if(rows[0]?.delay===null||rows[0]?.delay===undefined)return;
      expiryTimer=setTimeout(()=>{
        expiryTimer=undefined;
        void expireRuns().then(scheduleExpiry).catch(error=>console.error({type:"execution-expiry-failed",error:String(error)}));
      },Math.max(0,Number(rows[0].delay)));
      expiryTimer.unref?.();
    })().finally(()=>{scheduling=undefined;});
    return scheduling;
  }
  async function getThreadMessages(input:{threadId:string;userId:string}):Promise<{messages:ThreadMessage[]}> {
    await requireAccess(input.threadId,input.userId);
    const rows=await database.execute<{body:ThreadMessage}>(sql`select body from local_messages where thread_id=${input.threadId} order by position`);
    return {messages:rows.map(row=>row.body)};
  }
  async function lastRun(threadId:string) {
    const rows=await database.execute<ThreadRun & {stopRequested:boolean}>(sql`select r.id,
      case when r.status='running' and (t.active_run_id is null or t.lease_until<=now()) then 'interrupted' else r.status end as status,
      case when r.status='running' and (t.active_run_id is null or t.lease_until<=now()) then 'The previous execution ended before completion.' else r.error end as error,
      r.waiting,r.stop_requested as "stopRequested" from local_runs r join local_threads t on t.id=r.thread_id
      where r.thread_id=${threadId} order by (r.id=t.active_run_id) desc nulls last,(r.status='waiting') desc,r.updated_at desc,r.created_at desc limit 1`);
    return rows[0];
  }
  async function activeRun(threadId:string) {
    const run=await lastRun(threadId);
    return run&&["running","waiting"].includes(run.status)?run:undefined;
  }
  async function finishRun(threadId:string,runId:string,status:RunStatus,error?:string,waiting:ThreadRun["waiting"]=[],outcome?:unknown) {
    return database.transaction(async tx=>{
      await tx.execute(sql`select id from local_threads where id=${threadId} for update`);
      const changed=await tx.execute<{id:string;status:RunStatus;error?:string}>(sql`update local_runs
        set status=case when stop_requested then 'stopped' else ${status} end,
        error=case when stop_requested then 'The work was cancelled.' else ${error??null} end,
        waiting=${JSON.stringify(waiting)}::jsonb,updated_at=now()
        where id=${runId} and thread_id=${threadId} and status in ('running','waiting') returning id,status,error`);
      await tx.execute(sql`update local_threads set active_run_id=null,lease_until=null where id=${threadId} and active_run_id=${runId}`);
      if (!changed[0]) return;
      const event=await eventOn(tx,threadId,runId,{type:"RUN_FINISHED",threadId,runId,status:changed[0].status,...(changed[0].error?{error:changed[0].error}:{}),...(changed[0].status==="waiting"&&outcome?{outcome}:{})} as ThreadEvent);
      await notify(tx,threadId);
      return event;
    });
  }
  async function requestStop(threadId:string,runId:string) {
    return database.transaction(async tx=>{
      await tx.execute(sql`select id from local_threads where id=${threadId} for update`);
      const family=await tx.execute<{id:string;threadId:string;status:string}>(sql`with recursive ancestors as (
        select id,parent_run_id from local_runs where id=${runId} and thread_id=${threadId}
        union all select parent.id,parent.parent_run_id from local_runs parent join ancestors child on child.parent_run_id=parent.id
      ), family as (
        select id from ancestors where parent_run_id is null
        union all select child.id from local_runs child join family parent on child.parent_run_id=parent.id
      ) select r.id,r.thread_id as "threadId",r.status from local_runs r join family on r.id=family.id for update of r`);
      if(!family.length)return false;
      for(const run of family){
        await tx.execute(sql`update local_runs set stop_requested=true,
          status=case when status='waiting' then 'stopped' else status end,
          error=case when status in ('running','waiting') then 'The work was cancelled.' else error end,updated_at=now() where id=${run.id}`);
        if(run.status==="running")await tx.execute(sql`select pg_notify(${STOPS},${run.id})`);
        if(run.status==="waiting")await eventOn(tx,run.threadId,run.id,{type:"RUN_FINISHED",threadId:run.threadId,runId:run.id,status:"stopped",error:"The work was cancelled."} as ThreadEvent);
        await notify(tx,run.threadId);
      }
      return true;
    });
  }

  return {
    async initialize() {
      await database.execute(sql`create table if not exists thread_channel_mappings(user_id text not null references users(id) on delete cascade,channel_id text not null references channels(id) on delete cascade,thread_id text not null unique,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(user_id,channel_id))`);
      await database.execute(sql`create table if not exists local_threads(id text primary key,user_id text not null references users(id) on delete cascade,agent_id text not null,state jsonb,active_run_id text,lease_until timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`);
      await database.execute(sql`create table if not exists local_runs(id text primary key,thread_id text not null references local_threads(id) on delete cascade,user_id text not null references users(id) on delete cascade,agent_id text not null,status text not null,stop_requested boolean not null default false,error text,waiting jsonb,parent_run_id text,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`);
      await database.execute(sql`alter table local_runs add column if not exists error text,add column if not exists waiting jsonb,add column if not exists parent_run_id text,drop column if exists executor_token`);
      await database.execute(sql`create index if not exists local_runs_thread_idx on local_runs(thread_id,created_at desc)`);
      await database.execute(sql`create table if not exists local_messages(position bigserial,thread_id text not null references local_threads(id) on delete cascade,id text not null,body jsonb not null,primary key(thread_id,id))`);
      await database.execute(sql`create table if not exists local_events(seq bigserial primary key,thread_id text not null references local_threads(id) on delete cascade,run_id text not null references local_runs(id) on delete cascade,body jsonb not null)`);
      await database.execute(sql`create index if not exists local_events_thread_idx on local_events(thread_id,seq)`);
      await database.transaction(async tx=>{
        const retired=await tx.execute<{id:string;threadId:string}>(sql`update local_runs set status='interrupted',error='The previous runtime did not start this execution.',updated_at=now()
          where status='pending' returning id,thread_id as "threadId"`);
        for(const run of retired){
          await tx.execute(sql`update local_threads set active_run_id=null,lease_until=null where id=${run.threadId} and active_run_id=${run.id}`);
          await eventOn(tx,run.threadId,run.id,{type:"RUN_FINISHED",threadId:run.threadId,runId:run.id,status:"interrupted",error:"The previous runtime did not start this execution."} as ThreadEvent);
          await notify(tx,run.threadId);
        }
      });
      await database.execute(sql`delete from local_messages m using local_threads t,agents a,agent_profiles p
        where m.thread_id=t.id and t.agent_id=a.id and p.agent_id=a.id and p.owner_user_id is null and a.package_id is not null
          and a.id in ('openduet','your-agent','picked-harness') and m.body->>'role'='user'
          and (m.body->>'content' like ${"This is your first conversation with this person: they have just opened the app for the first time and have not written anything yet, so the request below was sent for them.\n%"}
            or m.body->>'content' like ${"Nobody typed this. The person has just opened the app for the first time today, and the app sent the request below for them, so the day's brief is waiting when they look.\n%"})`);
      await database.execute(sql`alter table channels drop column if exists first_day_started_at,drop column if exists morning_brief_on`);
      await database.execute(sql`update group_messages set agent_id=details->>'answeredBy',details=details-'answeredBy'
        where jsonb_typeof(details->'answeredBy')='string' and details->>'answeredBy'<>''`);
    },
    async listen(databaseUrl:string) {
      connection=postgres(databaseUrl,{max:1});
      await connection.listen(UPDATES,threadId=>{for(const changed of viewers.get(threadId)??[])changed();});
      await connection.listen(STOPS,runId=>{for(const stopped of stopListeners)stopped(runId);});
      await expireRuns();
      void scheduleExpiry().catch(error=>console.error({type:"execution-expiry-schedule-failed",error:String(error)}));
    },
    async close(){if(expiryTimer)clearTimeout(expiryTimer);await connection?.end();},
    subscribe(threadId:string,changed:()=>void) {
      const listeners=viewers.get(threadId)??new Set<()=>void>();
      listeners.add(changed);viewers.set(threadId,listeners);
      return ()=>{listeners.delete(changed);if(!listeners.size)viewers.delete(threadId);};
    },
    onStop(stopped:(runId:string)=>void){stopListeners.add(stopped);return()=>{stopListeners.delete(stopped);};},
    getThread,getOrCreateThread,getThreadMessages,requireAccess,activeRun,lastRun,requestStop,finishRun,
    async beginRun(input:{threadId:string;runId:string;userId:string;agentId:string;parentRunId?:string;messages:readonly Message[]}) {
      await getOrCreateThread(input);
      const ownsConversation=await database.transaction(async tx=>{
        const [thread]=await tx.execute<{activeRunId:string|null;live:boolean}>(sql`select active_run_id as "activeRunId",coalesce(lease_until>now(),false) as live from local_threads where id=${input.threadId} for update`);
        let nested=false;
        if(input.parentRunId){
          const [parent]=await tx.execute<{status:string;stopped:boolean}>(sql`select status,stop_requested as stopped from local_runs where id=${input.parentRunId} and thread_id=${input.threadId} and user_id=${input.userId} for update`);
          if(!parent||parent.stopped)throw new RunStoppedError("The source work was cancelled or is unavailable.");
          const ancestors=await tx.execute<{id:string;agentId:string;status:string;stopped:boolean}>(sql`with recursive lineage as (
            select id,parent_run_id,agent_id,status,stop_requested from local_runs where id=${input.parentRunId}
            union all select r.id,r.parent_run_id,r.agent_id,r.status,r.stop_requested from local_runs r join lineage child on child.parent_run_id=r.id
          ) select id,agent_id as "agentId",status,stop_requested as stopped from lineage`);
          if(ancestors.some(parent=>parent.stopped))throw new RunStoppedError("The source work was cancelled.");
          if(ancestors.some(parent=>parent.status==="running"&&parent.agentId===input.agentId))throw new ThreadConflictError("That Bot is already executing in this delegation chain.");
          nested=thread.live&&ancestors.some(parent=>parent.id===thread.activeRunId)&&(parent.status==="running"||parent.status==="waiting");
        }
        if(!nested){
          if(thread.activeRunId&&thread.live)throw new ThreadConflictError("This conversation already has a running turn.");
          await tx.execute(sql`update local_runs set status='interrupted',error='The previous execution ended before completion.',updated_at=now() where thread_id=${input.threadId} and status='running'`);
          await tx.execute(sql`update local_threads set active_run_id=${input.runId},lease_until=now()+${LEASE_SECONDS}*interval '1 second',updated_at=now() where id=${input.threadId}`);
        }
        await tx.execute(sql`insert into local_runs(id,thread_id,user_id,agent_id,status,parent_run_id) values(${input.runId},${input.threadId},${input.userId},${input.agentId},'running',${input.parentRunId??null})`);
        if(input.parentRunId&&input.messages.some(message=>message.role==="tool"))await tx.execute(sql`update local_runs set status='completed',waiting='[]'::jsonb,updated_at=now() where id=${input.parentRunId} and status='waiting'`);
        await saveOn(tx,input.threadId,input.messages);
        for(const message of input.messages)await eventOn(tx,input.threadId,input.runId,{type:"CUSTOM",name:"thread.message",value:message} as ThreadEvent);
        await notify(tx,input.threadId);
        return !nested;
      });
      if(ownsConversation)void scheduleExpiry().catch(error=>console.error({type:"execution-expiry-schedule-failed",error:String(error)}));
      return ownsConversation;
    },
    async renewRun(threadId:string,runId:string) {
      const kept=await database.execute<{id:string}>(sql`update local_threads set lease_until=now()+${LEASE_SECONDS}*interval '1 second'
        where id=${threadId} and active_run_id=${runId} and lease_until>now() returning id`);
      if(!kept.length)throw new RunStoppedError("This execution no longer owns its conversation.");
      void scheduleExpiry().catch(error=>console.error({type:"execution-expiry-schedule-failed",error:String(error)}));
    },
    async recordEvent(threadId:string,runId:string,event:ThreadEvent,changed:readonly ThreadMessage[],state?:unknown,removed:string[]=[]) {
      return database.transaction(async tx=>{
        const owned=await tx.execute<{id:string}>(sql`select id from local_threads where id=${threadId} and active_run_id is not null and lease_until>now() for update`);
        if(!owned.length)throw new RunStoppedError("This execution no longer owns its conversation.");
        const running=await tx.execute<{id:string}>(sql`select id from local_runs where id=${runId} and thread_id=${threadId} and status='running' and stop_requested=false for update`);
        if(!running.length)throw new RunStoppedError("The work was cancelled.");
        await saveOn(tx,threadId,changed);
        if(removed.length)await tx.execute(sql`delete from local_messages where thread_id=${threadId} and id in(${sql.join(removed.map(id=>sql`${id}`),sql`,`)})`);
        if(state!==undefined)await tx.execute(sql`update local_threads set state=${JSON.stringify(state)}::jsonb where id=${threadId}`);
        if(event.type==="MESSAGES_SNAPSHOT"){
          const rows=await tx.execute<{body:ThreadMessage}>(sql`select body from local_messages where thread_id=${threadId} order by position`);
          event={...event,messages:rows.map(row=>row.body)};
        }
        const stored=await eventOn(tx,threadId,runId,event);await notify(tx,threadId);return stored;
      });
    },
    async events(threadId:string,after:number) {
      const rows=await database.execute<{seq:number;body:ThreadEvent}>(sql`select seq,body from local_events where thread_id=${threadId} and seq>${after} order by seq limit 500`);
      return rows.map(row=>({...row.body,seq:Number(row.seq)}));
    },
    async snapshot(threadId:string,userId:string) {
      await requireAccess(threadId,userId);
      return database.transaction(async tx=>{
        await tx.execute(sql`set transaction isolation level repeatable read`);
        const rows=await tx.execute<{body:ThreadMessage}>(sql`select body from local_messages where thread_id=${threadId} order by position`);
        const cursor=await tx.execute<{seq:number}>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`);
        const runs=await tx.execute<ThreadRun>(sql`select r.id,
          case when r.status='running' and (t.active_run_id is null or t.lease_until<=now()) then 'interrupted' else r.status end as status,
          case when r.status='running' and (t.active_run_id is null or t.lease_until<=now()) then 'The previous execution ended before completion.' else r.error end as error,
          r.waiting from local_runs r join local_threads t on t.id=r.thread_id where r.thread_id=${threadId}
          order by (r.id=t.active_run_id) desc nulls last,(r.status='waiting') desc,r.updated_at desc,r.created_at desc limit 1`);
        const pending=await tx.execute<{waiting:ThreadRun["waiting"]}>(sql`select waiting from local_runs where thread_id=${threadId} and status='waiting' and stop_requested=false order by created_at`);
        const last=runs[0];
        if(last&&(last.status==="running"||last.status==="waiting"))last.waiting=pending.flatMap(run=>run.waiting??[]);
        return {messages:rows.map(row=>row.body),cursor:Number(cursor[0].seq),lastRun:last,...((last?.status==="running"||last?.status==="waiting")?{activeRun:last}:{})};
      });
    },
    async owner(threadId:string){
      const rows=await database.execute<{userId:string;agentId:string}>(sql`select user_id as "userId",agent_id as "agentId" from local_threads where id=${threadId}`);
      if(!rows[0])throw new ThreadAccessError("Conversation not found.");return rows[0];
    },
    async run(runId:string){const rows=await database.execute<ThreadRun&{threadId:string;agentId:string;userId:string;stopRequested:boolean}>(sql`select id,thread_id as "threadId",agent_id as "agentId",user_id as "userId",status,error,waiting,stop_requested as "stopRequested" from local_runs where id=${runId}`);return rows[0];},
    async waitingRunForTool(threadId:string,toolCallId:string){
      const rows=await database.execute<ThreadRun&{agentId:string;userId:string}>(sql`select id,agent_id as "agentId",user_id as "userId",status,waiting from local_runs
        where thread_id=${threadId} and status='waiting' and stop_requested=false and waiting @> ${JSON.stringify([{toolCallId,answerable:true}])}::jsonb order by updated_at desc limit 1`);
      return rows[0];
    },
    async cursor(threadId:string){const rows=await database.execute<{seq:number}>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`);return Number(rows[0].seq);},
  };
}
export type LocalThreadStore=ReturnType<typeof createLocalThreadStore>;
