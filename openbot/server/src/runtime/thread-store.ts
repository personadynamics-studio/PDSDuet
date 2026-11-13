import type { BaseEvent, Message } from "@ag-ui/client";
import type { RunStatus, ThreadEvent, ThreadMessage, ThreadRun } from "@openbot/shared/thread-events";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import { groupMessages } from "../db/schema";
import type { GroupStore } from "../channels/group";

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
      ) select case when exists(select 1 from group_bot_threads where thread_id=${threadId}) then exists(
        select 1 from group_bot_threads g join channel_memberships cm on cm.channel_id=g.channel_id
        join channels c on c.id=g.channel_id where g.thread_id=${threadId} and g.owner_user_id=${userId}
          and cm.user_id=${userId} and c.deleted_at is null
      ) when exists(select 1 from bindings) then exists(
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
      (exists(select 1 from thread_channel_mappings where thread_id=${input.threadId})
       or exists(select 1 from group_bot_threads where thread_id=${input.threadId})) as mapped`);
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
          where id=${thread.runId} and status='running' returning id`);
        await tx.execute(sql`update local_threads set active_run_id=null,lease_until=null where id=${thread.id}`);
        if(changed.length){
          await eventOn(tx,thread.id,thread.runId,{type:"RUN_FINISHED",threadId:thread.id,runId:thread.runId,status:"interrupted",error:"The previous execution ended before completion."} as ThreadEvent);
          await notify(tx,thread.id);
        }
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
      case when r.status='running' and (t.active_run_id is distinct from r.id or t.lease_until<=now()) then 'interrupted' else r.status end as status,
      case when r.status='running' and (t.active_run_id is distinct from r.id or t.lease_until<=now()) then 'The previous execution ended before completion.' else r.error end as error,
      r.waiting,r.stop_requested as "stopRequested" from local_runs r join local_threads t on t.id=r.thread_id
      where r.thread_id=${threadId} order by r.created_at desc limit 1`);
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
      // Lock the source before reading its descendants. New child executions lock this same ancestry.
      const root=await tx.execute<{id:string}>(sql`select id from local_runs where id=${runId} and thread_id=${threadId} for update`);
      if(!root.length)return false;
      const family=await tx.execute<{id:string;threadId:string;status:string}>(sql`with recursive work as (
        select id from local_runs where id=${runId}
        union all select child.id from local_runs child join work parent on child.parent_run_id=parent.id
      ) select r.id,r.thread_id as "threadId",r.status from local_runs r join work on r.id=work.id for update of r`);
      const ids=sql.join(family.map(row=>sql`${row.id}`),sql`,`);
      const questions=await tx.execute<{key:string}>(sql`select key from work_items where kind='person.question' and payload->>'runId' in(${ids})`);
      const questionMatch=questions.length
        ? sql`payload->'questionIds' ?| array[${sql.join(questions.map(row=>sql`${row.key}`),sql`,`)}]::text[]`
        : sql`false`;
      const related=sql`(payload->>'runId' in(${ids}) or payload->'question'->>'runId' in(${ids}) or ${questionMatch})`;
      const hasWork=await tx.execute<{pending:boolean}>(sql`select (
        exists(select 1 from local_runs where id in(${ids}) and status in ('running','waiting'))
        or exists(select 1 from work_items where finished_at is null and ${related})
        or exists(select 1 from approval_requests where run_id in(${ids}) and status in ('pending','approved'))
        or exists(select 1 from responsibility_runs where status in ('waiting','queued') and (
          waiting->'continuation'->>'runId' in(${ids}) or continuation->'waiting'->'continuation'->>'runId' in(${ids})
        ))) as pending`);
      if(!hasWork[0]?.pending)return false;
      await tx.execute(sql`update local_runs set stop_requested=true,
        error=case when status in ('running','waiting') or id=${runId} then 'The work was cancelled.' else error end,
        status=case when status='waiting' then 'stopped' else status end,updated_at=now() where id in(${ids})`);
      const responsibilities=await tx.execute<{id:string}>(sql`update responsibility_runs set status='skipped',error='The work was cancelled.',
        waiting=null,continuation=null,finished_at=now() where status in ('waiting','queued') and (
          waiting->'continuation'->>'runId' in(${ids}) or continuation->'waiting'->'continuation'->>'runId' in(${ids})
        ) returning id`);
      const responsibilityMatch=responsibilities.length
        ? sql`(kind='responsibility.run' and payload->>'runId' in(${sql.join(responsibilities.map(row=>sql`${row.id}`),sql`,`)}))`
        : sql`false`;
      await tx.execute(sql`update work_items set finished_at=now(),last_error='Stopped by the person',claimed_by=null,lease_until=null,updated_at=now()
        where finished_at is null and (${related} or ${responsibilityMatch})`);
      await tx.execute(sql`update approval_requests set status='completed',decision='deny',completed_at=now(),
        result=${JSON.stringify({content:"The work was cancelled.",error:"STOPPED"})}::jsonb
        where run_id in(${ids}) and status in ('pending','approved')`);
      for(const row of family){
        await tx.execute(sql`select pg_notify(${STOPS},${row.id})`);
        if(row.status==="waiting")await eventOn(tx,row.threadId,row.id,{type:"RUN_FINISHED",threadId:row.threadId,runId:row.id,status:"stopped",error:"The work was cancelled."} as ThreadEvent);
        await notify(tx,row.threadId);
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
      await database.execute(sql`update work_items set finished_at=now(),claimed_by=null,lease_until=null,last_error='Retired model relay',updated_at=now()
        where kind='bot.message' and finished_at is null and payload ? 'answerIn'`);
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
      await database.transaction(async tx=>{
        const claimed=await tx.execute<{id:string}>(sql`update local_threads set active_run_id=${input.runId},lease_until=now()+${LEASE_SECONDS}*interval '1 second',updated_at=now()
          where id=${input.threadId} and (active_run_id is null or lease_until<=now()) returning id`);
        if(!claimed.length)throw new ThreadConflictError("This conversation already has a running turn.");
        await tx.execute(sql`update local_runs set status='interrupted',error='The previous execution ended before completion.',updated_at=now()
          where thread_id=${input.threadId} and status='running'`);
        if(input.parentRunId){
          const parents=await tx.execute<{stopped:boolean}>(sql`with recursive lineage as (
            select id,parent_run_id,0 as depth from local_runs where id=${input.parentRunId}
            union all select parent.id,parent.parent_run_id,child.depth+1 from local_runs parent join lineage child on child.parent_run_id=parent.id
          ) select r.stop_requested as stopped from local_runs r join lineage on lineage.id=r.id order by lineage.depth desc for update of r`);
          if(parents.some(parent=>parent.stopped))throw new RunStoppedError("The source work was cancelled.");
          const work=await tx.execute<{finished:boolean}>(sql`select finished_at is not null as finished from work_items where kind='bot.message' and key=${input.runId}`);
          if(work[0]?.finished)throw new RunStoppedError("This delegated work was cancelled.");
        }
        const run=await tx.execute<{id:string}>(sql`insert into local_runs(id,thread_id,user_id,agent_id,status,parent_run_id)
          values(${input.runId},${input.threadId},${input.userId},${input.agentId},'running',${input.parentRunId??null}) on conflict(id) do nothing returning id`);
        if(!run.length)throw new ThreadConflictError("This execution has already been recorded.");
        if(input.parentRunId&&input.messages.some(message=>message.role==="tool"))await tx.execute(sql`update local_runs
          set status='completed',waiting='[]'::jsonb,updated_at=now() where id=${input.parentRunId} and status='waiting' and stop_requested=false`);
        await saveOn(tx,input.threadId,input.messages);
        await notify(tx,input.threadId);
      });
      void scheduleExpiry().catch(error=>console.error({type:"execution-expiry-schedule-failed",error:String(error)}));
    },
    async renewRun(threadId:string,runId:string) {
      const kept=await database.execute<{id:string}>(sql`update local_threads set lease_until=now()+${LEASE_SECONDS}*interval '1 second'
        where id=${threadId} and active_run_id=${runId} and lease_until>now() returning id`);
      if(!kept.length)throw new RunStoppedError("This execution no longer owns its conversation.");
      void scheduleExpiry().catch(error=>console.error({type:"execution-expiry-schedule-failed",error:String(error)}));
    },
    async recordEvent(threadId:string,runId:string,event:ThreadEvent,changed:readonly ThreadMessage[],state?:unknown,removed:string[]=[]) {
      return database.transaction(async tx=>{
        const owned=await tx.execute<{id:string}>(sql`select id from local_threads where id=${threadId} and active_run_id=${runId} and lease_until>now() for update`);
        if(!owned.length)throw new RunStoppedError("This execution no longer owns its conversation.");
        const running=await tx.execute<{id:string}>(sql`select id from local_runs where id=${runId} and status='running' and stop_requested=false for update`);
        if(!running.length)throw new RunStoppedError("The work was cancelled.");
        await saveOn(tx,threadId,changed);
        if(removed.length)await tx.execute(sql`delete from local_messages where thread_id=${threadId} and id in(${sql.join(removed.map(id=>sql`${id}`),sql`,`)})`);
        if(state!==undefined)await tx.execute(sql`update local_threads set state=${JSON.stringify(state)}::jsonb where id=${threadId}`);
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
          case when r.status='running' and (t.active_run_id is distinct from r.id or t.lease_until<=now()) then 'interrupted' else r.status end as status,
          case when r.status='running' and (t.active_run_id is distinct from r.id or t.lease_until<=now()) then 'The previous execution ended before completion.' else r.error end as error,
          r.waiting from local_runs r join local_threads t on t.id=r.thread_id where r.thread_id=${threadId} order by r.created_at desc limit 1`);
        const last=runs[0];
        return {messages:rows.map(row=>row.body),cursor:Number(cursor[0].seq),lastRun:last,...((last?.status==="running"||last?.status==="waiting")?{activeRun:last}:{})};
      });
    },
    async owner(threadId:string){
      const rows=await database.execute<{userId:string;agentId:string}>(sql`select user_id as "userId",agent_id as "agentId" from local_threads where id=${threadId}`);
      if(!rows[0])throw new ThreadAccessError("Conversation not found.");return rows[0];
    },
    async run(runId:string){const rows=await database.execute<ThreadRun&{stopRequested:boolean}>(sql`select id,status,error,waiting,stop_requested as "stopRequested" from local_runs where id=${runId}`);return rows[0];},
    async cursor(threadId:string){const rows=await database.execute<{seq:number}>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`);return Number(rows[0].seq);},
    async completeHandoff(input:{key:string;owner:string;threadId:string;runId:string;message?:ThreadMessage;error?:string;groupMessage?:Parameters<GroupStore["append"]>[0]}){
      return database.transaction(async tx=>{
        const finished=await tx.execute<{key:string}>(sql`update work_items set finished_at=now(),claimed_by=null,lease_until=null,last_error=${input.error??null},updated_at=now()
          where kind='bot.message' and key=${input.key} and claimed_by=${input.owner} and finished_at is null and lease_until>now() returning key`);
        if(!finished.length)return false;
        if(input.groupMessage)await tx.insert(groupMessages).values({status:"completed",...input.groupMessage}).onConflictDoNothing();
        if(input.message){await saveOn(tx,input.threadId,[input.message]);await eventOn(tx,input.threadId,input.runId,{type:"CUSTOM",name:"thread.message",value:input.message} as ThreadEvent);await notify(tx,input.threadId);}
        return true;
      });
    },
  };
}
export type LocalThreadStore=ReturnType<typeof createLocalThreadStore>;


