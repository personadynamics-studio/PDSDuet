import type { BaseEvent, Message } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

export class ThreadAccessError extends Error { readonly status = 404; }
export class ThreadConflictError extends Error { readonly status = 409; }
export type ThreadRun = { id: string; status: "pending" | "running" | "waiting" | "completed" | "failed" | "stopped" | "interrupted"; stopRequested: boolean };
export type StoredEvent = BaseEvent & { seq: number };
const LEASE_SECONDS = 120;

export function createLocalThreadStore(database: Database) {
  async function accessible(threadId: string, userId: string): Promise<boolean> {
    const rows = await database.execute<{ allowed: boolean }>(sql`
      with bindings as (
        select channel_id from thread_channel_mappings where thread_id=${threadId}
        union select channel_id from group_bot_threads where thread_id=${threadId}
      )
      select case when exists(select 1 from bindings) then exists(
        select 1 from bindings b join channel_memberships cm on cm.channel_id=b.channel_id
        join channels c on c.id=b.channel_id where cm.user_id=${userId} and c.deleted_at is null
      ) else exists(select 1 from local_threads t where t.id=${threadId} and t.user_id=${userId}) end as allowed`);
    return rows[0]?.allowed === true;
  }
  async function requireAccess(threadId: string, userId: string) {
    if (!(await accessible(threadId, userId))) throw new ThreadAccessError("Conversation not found.");
  }
  async function getThread(input: { threadId: string; userId: string }) {
    await requireAccess(input.threadId, input.userId);
    const rows = await database.execute<{ id: string; agentId: string; state: Record<string, unknown> | null }>(sql`
      select id, agent_id as "agentId", state from local_threads where id=${input.threadId}`);
    if (!rows[0]) throw new ThreadAccessError("Conversation not found.");
    return rows[0];
  }
  async function getOrCreateThread(input: { threadId: string; userId: string; agentId: string }) {
    const existing = await database.execute<{ id: string }>(sql`select id from local_threads where id=${input.threadId}`);
    const mapped = await database.execute<{ present: boolean }>(sql`select exists(select 1 from thread_channel_mappings where thread_id=${input.threadId}) or exists(select 1 from group_bot_threads where thread_id=${input.threadId}) as present`);
    if (existing.length || mapped[0]?.present) await requireAccess(input.threadId, input.userId);
    await database.execute(sql`insert into local_threads(id,user_id,agent_id) values(${input.threadId},${input.userId},${input.agentId}) on conflict(id) do nothing`);
    const thread = await getThread(input);
    if (thread.agentId !== input.agentId) throw new ThreadConflictError("This conversation belongs to another Bot.");
    return thread;
  }
  async function acquireLock(input: { threadId: string; runId: string; userId: string; agentId: string; ttlSeconds?: number }) {
    await getOrCreateThread(input);
    return database.transaction(async (tx) => {
      const prior=await tx.execute<{threadId:string;status:string}>(sql`select thread_id as "threadId",status from local_runs where id=${input.runId} for update`);
      if(prior[0]&&(prior[0].threadId!==input.threadId||prior[0].status!=='pending'))throw new ThreadConflictError('This run has already started or finished.');
      const claimed = await tx.execute<{ id: string }>(sql`update local_threads set active_run_id=${input.runId}, lease_until=now()+${input.ttlSeconds ?? LEASE_SECONDS}*interval '1 second', updated_at=now()
        where id=${input.threadId} and (active_run_id is null or lease_until <= now() or active_run_id=${input.runId}) returning id`);
      if (!claimed.length) throw new ThreadConflictError("This conversation already has a running turn.");
      await tx.execute(sql`update local_runs set status='interrupted', updated_at=now() where thread_id=${input.threadId} and id<>${input.runId} and status in ('pending','running')`);
      await tx.execute(sql`insert into local_runs(id,thread_id,user_id,agent_id,status) values(${input.runId},${input.threadId},${input.userId},${input.agentId},'pending') on conflict(id) do nothing`);
      return { runId: input.runId };
    });
  }
  async function renewLock(input: { threadId: string; runId: string; ttlSeconds?: number }) {
    const rows = await database.execute<{ id: string }>(sql`update local_threads set lease_until=now()+${input.ttlSeconds ?? LEASE_SECONDS}*interval '1 second'
      where id=${input.threadId} and active_run_id=${input.runId} and lease_until>now() returning id`);
    if (!rows.length) throw new ThreadConflictError("The conversation's execution lease was lost.");
  }
  async function releaseLock(input: { threadId: string; runId: string }) {
    await database.execute(sql`update local_threads set active_run_id=null, lease_until=null where id=${input.threadId} and active_run_id=${input.runId}`);
  }
  async function saveMessagesOn(tx: Pick<Database, 'execute'>, threadId: string, messages: readonly Message[], state?: unknown) {
    for (const message of messages) {
      if (message.role === 'system') continue;
      await tx.execute(sql`insert into local_messages(thread_id,id,body) values(${threadId},${message.id},${JSON.stringify(message)}::jsonb) on conflict(thread_id,id) do update set body=excluded.body`);
    }
    if(state!==undefined)await tx.execute(sql`update local_threads set state=${JSON.stringify(state)}::jsonb,updated_at=now() where id=${threadId}`);
  }
  async function assertWriter(tx:Pick<Database,'execute'>,threadId:string,runId:string){
    const rows=await tx.execute<{id:string}>(sql`select id from local_threads where id=${threadId} and active_run_id=${runId} and lease_until>now() for update`);
    if(!rows.length)throw new ThreadConflictError('This run no longer owns the conversation.');
  }
  async function saveMessages(threadId: string, messages: readonly Message[], state:unknown, runId:string) {
    await database.transaction(async(tx)=>{await assertWriter(tx,threadId,runId);await saveMessagesOn(tx,threadId,messages,state);});
  }
  async function getThreadMessages(input: { threadId: string; userId: string }): Promise<{ messages: Message[] }> {
    await requireAccess(input.threadId, input.userId);
    const rows = await database.execute<{ body: Message }>(sql`select body from local_messages where thread_id=${input.threadId} order by position`);
    return { messages: rows.map((row) => row.body) };
  }
  async function appendEvent(threadId: string, runId: string, event: BaseEvent): Promise<StoredEvent> {
    return database.transaction(async(tx)=>{
      await assertWriter(tx,threadId,runId);
      const rows=await tx.execute<{seq:number}>(sql`insert into local_events(thread_id,run_id,body) values(${threadId},${runId},${JSON.stringify(event)}::jsonb) returning seq`);
      return {...event,seq:Number(rows[0]?.seq)};
    });
  }
  async function events(threadId: string, after: number, userId: string) {
    await requireAccess(threadId, userId);
    const rows = await database.execute<{ seq: number; body: BaseEvent }>(sql`select seq,body from local_events where thread_id=${threadId} and seq>${after} order by seq limit 500`);
    return rows.map((row) => ({ ...row.body, seq: Number(row.seq) }));
  }
  async function activeRun(threadId: string): Promise<ThreadRun | undefined> {
    await database.execute(sql`update local_runs r set status='interrupted', updated_at=now() from local_threads t where r.thread_id=t.id and t.id=${threadId} and r.id=t.active_run_id and t.lease_until<=now() and r.status in ('pending','running')`);
    const rows = await database.execute<ThreadRun>(sql`select r.id,r.status,r.stop_requested as "stopRequested" from local_runs r join local_threads t on t.id=r.thread_id
      where r.thread_id=${threadId} order by r.created_at desc limit 1`);
    return rows[0] && ['pending','running','waiting'].includes(rows[0].status) ? rows[0] : undefined;
  }
  return {
    async initialize() {
      await database.execute(sql`create table if not exists thread_channel_mappings(user_id text not null references users(id) on delete cascade,channel_id text not null references channels(id) on delete cascade,thread_id text not null unique,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(user_id,channel_id))`);
      await database.execute(sql`create table if not exists local_threads(id text primary key,user_id text not null references users(id) on delete cascade,agent_id text not null,state jsonb,active_run_id text,lease_until timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`);
      await database.execute(sql`create table if not exists local_runs(id text primary key,thread_id text not null references local_threads(id) on delete cascade,user_id text not null references users(id) on delete cascade,agent_id text not null,status text not null,stop_requested boolean not null default false,executor_token text,created_at timestamptz not null default now(),updated_at timestamptz not null default now())`);
      await database.execute(sql`create index if not exists local_runs_thread_idx on local_runs(thread_id,created_at desc)`);
      await database.execute(sql`create table if not exists local_messages(position bigserial,thread_id text not null references local_threads(id) on delete cascade,id text not null,body jsonb not null,primary key(thread_id,id))`);
      await database.execute(sql`create table if not exists local_events(seq bigserial primary key,thread_id text not null references local_threads(id) on delete cascade,run_id text not null references local_runs(id) on delete cascade,body jsonb not null)`);
      await database.execute(sql`create index if not exists local_events_thread_idx on local_events(thread_id,seq)`);
    },
    getThread, getOrCreateThread, getThreadMessages, requireAccess, acquireLock, renewLock, releaseLock, saveMessages, appendEvent, events, activeRun,
    async recordEvent(threadId:string,runId:string,event:BaseEvent,messages:Message[],state:unknown):Promise<StoredEvent>{
      return database.transaction(async(tx)=>{
        await assertWriter(tx,threadId,runId);
        const rows=await tx.execute<{seq:number}>(sql`insert into local_events(thread_id,run_id,body) values(${threadId},${runId},${JSON.stringify(event)}::jsonb) returning seq`);
        await saveMessagesOn(tx,threadId,messages,state);
        return {...event,seq:Number(rows[0]?.seq)};
      });
    },
    async snapshot(threadId:string,userId:string){
      await requireAccess(threadId,userId);
      return database.transaction(async(tx)=>{
        await tx.execute(sql`set transaction isolation level repeatable read`);
        const rows=await tx.execute<{body:Message}>(sql`select body from local_messages where thread_id=${threadId} order by position`);
        const cursor=await tx.execute<{seq:number}>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`);
        return {messages:rows.map((row)=>row.body),cursor:Number(cursor[0]?.seq??0)};
      });
    },
    async owner(threadId: string) { const rows = await database.execute<{ userId: string; agentId: string }>(sql`select user_id as "userId", agent_id as "agentId" from local_threads where id=${threadId}`); if (!rows[0]) throw new ThreadAccessError("Conversation not found."); return rows[0]; },
    async cursor(threadId: string) { const rows = await database.execute<{ seq: number }>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`); return Number(rows[0]?.seq ?? 0); },
    async claimExecution(runId: string) { const token=crypto.randomUUID(); const rows=await database.execute<{ id: string }>(sql`update local_runs set status='running',executor_token=${token},updated_at=now() where id=${runId} and status='pending' and stop_requested=false returning id`); if (!rows.length) throw new ThreadConflictError("This run has already started or stopped."); return token; },
    async stopRequested(runId: string) { const rows=await database.execute<{ stop: boolean }>(sql`select stop_requested as stop from local_runs where id=${runId}`); return rows[0]?.stop !== false; },
    async requestStop(threadId:string,runId:string){
      return database.transaction(async(tx)=>{
        const rows=await tx.execute<{id:string;status:string}>(sql`update local_runs set stop_requested=true,status=case when status='pending' then 'stopped' else status end,updated_at=now() where thread_id=${threadId} and id=${runId} and status in ('pending','running') returning id,status`);
        if(rows[0]?.status==='stopped')await tx.execute(sql`update local_threads set active_run_id=null,lease_until=null where id=${threadId} and active_run_id=${runId}`);
        return rows.length>0;
      });
    },
    async finish(runId: string, token: string, status: ThreadRun['status']) { await database.execute(sql`update local_runs set status=${status},updated_at=now() where id=${runId} and executor_token=${token}`); },
  };
}
export type LocalThreadStore = ReturnType<typeof createLocalThreadStore>;
