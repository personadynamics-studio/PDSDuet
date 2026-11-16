import { EventType, type RunAgentInput } from "@ag-ui/client";
import { projectThreadEvent, type ThreadEvent, type ThreadMessage, type ThreadRun } from "@openbot/shared/thread-events";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { AgentActor } from "../agents/profile-types";
import { announceChannelActivity } from "../channels/notifications";
import type { Database } from "../db/client";
import type { ExecutionInput, ExecutionOutcome, ExecutionRecord, ExecutionResult, PreparedExecution, SettlementWriter } from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Pick<Database, "execute">;
export type StoredEvent = ThreadEvent & { seq: number };
export class ConversationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}
const UPDATES = "local_thread_updated";
// Bun's raw-query adapter drops row generics; this projection supplies ExecutionRecord rows.
const fields = sql`id,thread_id as "threadId",user_id as "userId",bot_ids as "botIds",bot_index as "botIndex",
  parent_run_id as "parentRunId",instruction,initiator,status,error,waiting,stop_requested as "stopRequested",model_states as "modelStates"`;
const humanWaiting = (waiting: ThreadRun["waiting"]) => (waiting ?? []).filter(item =>
  item.answerable !== false && item.metadata?.kind !== "bot_wait");

/** The sole writer of conversation output, execution outcomes and their replayable events. */
export function createSettlement(database: Database, options: { actorFor(id: string): Promise<AgentActor> }) {
  const viewers = new Map<string, Set<() => void>>();
  let connection: ReturnType<typeof postgres> | undefined;

  async function access(threadId: string, userId: string, allowNew = false) {
    const [row] = await database.execute<{ exists: boolean; mapped: boolean; allowed: boolean }>(sql`with binding as (
      select channel_id from thread_channel_mappings where thread_id=${threadId}
    ) select exists(select 1 from local_threads where id=${threadId}) as exists,
      exists(select 1 from binding) as mapped,
      case when exists(select 1 from binding) then exists(
        select 1 from binding b join channel_memberships m on m.channel_id=b.channel_id
        join channels c on c.id=b.channel_id where m.user_id=${userId} and c.deleted_at is null
      ) else exists(select 1 from local_threads where id=${threadId} and user_id=${userId}) end as allowed`);
    if (!row.allowed && (!allowNew || row.exists || row.mapped)) throw new ConversationError("Conversation not found.", 404);
    return row;
  }
  async function requireAccess(threadId: string, userId: string) { await access(threadId, userId); }
  async function context(threadId: string, executor: Executor = database, ownRunId?: string) {
    const rows = await executor.execute<{ body: ThreadMessage; runId: string | null }>(sql`
      select m.body,m.run_id as "runId" from local_messages m left join local_runs r on r.id=m.run_id
      where m.thread_id=${threadId} and (m.run_id is null or (r.id is not null and r.parent_run_id is null)
        or m.body->>'role'='user' or m.run_id=${ownRunId ?? null}) order by m.position`);
    return { messages: rows.map(row => row.body) };
  }
  async function run(runId: string): Promise<ExecutionRecord | undefined> {
    const rows = await database.execute(sql`select ${fields} from local_runs where id=${runId}`) as ExecutionRecord[];
    return rows[0];
  }
  const notify = (tx: Executor, threadId: string) => tx.execute(sql`select pg_notify(${UPDATES},${threadId})`);
  async function event(tx: Executor, threadId: string, runId: string, body: ThreadEvent): Promise<StoredEvent> {
    // Model snapshots/state are private execution records, not public transcript replacements.
    if (["MESSAGES_SNAPSHOT", "STATE_SNAPSHOT", "STATE_DELTA"].includes(body.type) ||
      (body.type === "CUSTOM" && body.name === "openbot.headless.waiting" && (body.value as { kind?: string })?.kind === "bot_wait"))
      body = { ...body, internal: true };
    const [row] = await tx.execute<{ seq: number }>(sql`insert into local_events(thread_id,run_id,body)
      values(${threadId},${runId},${JSON.stringify(body)}::text::jsonb) returning seq`);
    return { ...body, seq: Number(row.seq) };
  }
  async function save(tx: Executor, record: ExecutionRecord, messages: readonly ThreadMessage[]) {
    for (const message of messages) await tx.execute(sql`insert into local_messages(thread_id,id,run_id,body)
      values(${record.threadId},${message.id},${record.id},${JSON.stringify(message)}::text::jsonb)
      on conflict(thread_id,id) do update set body=excluded.body,run_id=excluded.run_id`);
  }
  async function announce(tx: Transaction, threadId: string, message?: ThreadMessage, needsInput = false) {
    const text = message && typeof message.content === "string" ? Array.from(message.content).slice(0, 200).join("") : undefined;
    const changed = await tx.execute<{ id: string; lastMessage: string | null; lastMessageAt: Date | string | null; lastMessageAgentId: string | null }>(sql`
      update channels set last_message=case when ${text !== undefined} then ${text ?? null} else last_message end,
        last_message_at=case when ${text !== undefined} then now() else last_message_at end,
        last_message_agent_id=case when ${text !== undefined} then ${message?.senderBotId ?? null} else last_message_agent_id end,
        last_message_needs_input=${needsInput},updated_at=now()
      where id in(select channel_id from thread_channel_mappings where thread_id=${threadId})
      returning id,last_message as "lastMessage",last_message_at as "lastMessageAt",last_message_agent_id as "lastMessageAgentId"`);
    for (const channel of changed) {
      const members = await tx.execute<{ id: string }>(sql`select user_id as id from channel_memberships where channel_id=${channel.id}`);
      await announceChannelActivity(tx, { channelId: channel.id, memberIds: members.map(member => member.id),
        lastMessage: channel.lastMessage, lastMessageAt: channel.lastMessageAt ? new Date(channel.lastMessageAt).toISOString() : null,
        lastMessageAgentId: channel.lastMessageAgentId,
        busy: (await tx.execute<{busy:boolean}>(sql`select exists(select 1 from local_runs where thread_id=${threadId} and status in('running','waiting')) as busy`))[0].busy });
    }
  }

  async function prepare(input: ExecutionInput): Promise<PreparedExecution> {
    const permission = await access(input.threadId, input.actor.id, true);
    if (!permission.exists) {
      const inserted = await database.execute<{ id: string }>(sql`insert into local_threads(id,user_id) values(${input.threadId},${input.actor.id}) on conflict(id) do nothing returning id`);
      if (!inserted.length && !permission.mapped) throw new ConversationError("The conversation was created by another request.", 409);
    }
    const stored = await context(input.threadId);
    const historic = new Set(stored.messages.map(message => message.id));
    let added = (input.messages ?? []).filter(message => !historic.has(message.id)).map(message => ({
      ...message, senderUserId: input.actor.id, createdAt: new Date().toISOString(),
    } as ThreadMessage));
    let resumed: ExecutionRecord | undefined;
    if (input.childResultRunId) {
      const child = await run(input.childResultRunId);
      if (!child || child.threadId !== input.threadId || child.userId !== input.actor.id || !child.parentRunId || !["completed", "failed", "stopped", "interrupted"].includes(child.status))
        throw new ConversationError("No completed child result belongs to this execution.", 409);
      resumed = await run(child.parentRunId);
      const call = resumed?.status === "waiting" && !resumed.stopRequested
        ? resumed.waiting?.find(item => item.metadata?.kind === "bot_wait" && item.metadata.childRunId === child.id) : undefined;
      if (!resumed || !call) throw new ConversationError("The parent is not waiting for this child result.", 409);
      const output = await database.execute<{ body: ThreadMessage }>(sql`select body from local_messages where run_id=${child.id} and body->>'role'='assistant' order by position`);
      added = [{ id: `tool-result:${call.toolCallId}`, role: "tool", toolCallId: call.toolCallId,
        content: JSON.stringify({ requesterBotId: resumed.botIds[resumed.botIndex], botId: child.botIds[child.botIndex], runId: child.id, status: child.status, answer: output.map(row => typeof row.body.content === "string" ? row.body.content : "").filter(Boolean).join("\n\n"), ...(child.error ? { error: child.error } : {}) }),
        createdAt: new Date().toISOString() }];
    } else {
      for (const message of added) {
        if (message.role === "user") continue;
        if (message.role !== "tool") throw new ConversationError("Only human messages and actual waiting answers may be submitted.", 400);
        const matches = await database.execute(sql`select ${fields} from local_runs where thread_id=${input.threadId}
          and status='waiting' and stop_requested=false and waiting @> ${JSON.stringify([{ toolCallId: message.toolCallId, answerable: true }])}::text::jsonb`) as ExecutionRecord[];
        if (matches.length !== 1 || (resumed && resumed.id !== matches[0].id)) throw new ConversationError("The answer does not identify one waiting execution.", 409);
        resumed = matches[0];
      }
    }
    if (!added.length && !input.instruction && !resumed) throw new ConversationError("Supply a message or an execution instruction.", 400);
    const actor = resumed && resumed.userId !== input.actor.id ? await options.actorFor(resumed.userId) : input.actor;
    if (actor.id !== input.actor.id) await requireAccess(input.threadId, actor.id);
    const record: ExecutionRecord = resumed ?? {
      id: input.runId ?? crypto.randomUUID(), threadId: input.threadId, userId: actor.id,
      botIds: input.botIds ?? [], botIndex: 0, status: "running", stopRequested: false,
      parentRunId: input.parentRunId, instruction: input.instruction, initiator: input.initiator ?? { kind: "person" },
      modelStates: {},
    };
    if (!Array.isArray(record.botIds) || !record.botIds.length || record.botIds.some(id => !id)) throw new ConversationError("Choose an explicit Bot before starting.", 400);
    if (record.stopRequested) throw new ConversationError("This execution was cancelled.", 409);
    const resume: RunAgentInput["resume"] = added.flatMap(message => message.role === "tool" ? [{ interruptId: message.toolCallId, status: "resolved" as const, payload: message.content }] : []);
    const ancestors=record.parentRunId?await database.execute<{id:string}>(sql`with recursive lineage as (
      select id,parent_run_id,0 as depth from local_runs where id=${record.parentRunId} and thread_id=${record.threadId}
      union all select p.id,p.parent_run_id,c.depth+1 from local_runs p join lineage c on c.parent_run_id=p.id
    ) select id from lineage order by depth desc`):[];
    return { run: record, actor, history: stored.messages, added, state: record.modelStates?.[record.botIds[record.botIndex]] ?? null, resume, ancestors:ancestors.map(parent=>parent.id) };
  }

  async function begin(prepared: PreparedExecution) {
    const record = prepared.run;
    await database.transaction(async tx => {
      if (record.parentRunId) {
        const [parent] = await tx.execute<{ stopped: boolean }>(sql`select stop_requested as stopped from local_runs
          where id=${record.parentRunId} and thread_id=${record.threadId} and user_id=${record.userId} for update`);
        if (!parent || parent.stopped) throw new ConversationError("The parent execution was cancelled or is unavailable.", 409);
      }
      if (record.status === "waiting") {
        const changed = await tx.execute<{ id: string }>(sql`update local_runs set status='running',waiting='[]'::jsonb,updated_at=now()
          where id=${record.id} and status='waiting' and stop_requested=false returning id`);
        if (!changed.length) throw new ConversationError("The waiting execution has already changed.", 409);
      } else await tx.execute(sql`insert into local_runs(id,thread_id,user_id,bot_ids,bot_index,status,parent_run_id,instruction,initiator)
        values(${record.id},${record.threadId},${record.userId},${JSON.stringify(record.botIds)}::text::jsonb,0,'running',${record.parentRunId ?? null},${record.instruction ?? null},${JSON.stringify(record.initiator ?? { kind: "person" })}::text::jsonb)`);
      await save(tx, record, prepared.added);
      for (const message of prepared.added) await event(tx, record.threadId, record.id, { type: "CUSTOM", name: "thread.message", value: message } as ThreadEvent);
      await event(tx, record.threadId, record.id, { type: "RUN_STARTED", threadId: record.threadId, runId: record.id } as ThreadEvent);
      if (record.parentRunId) await event(tx, record.threadId, prepared.ancestors[0]!, { type: EventType.CUSTOM, name: "thread.updated", value: null });
      if (!record.parentRunId) await announce(tx, record.threadId, prepared.added.findLast(message => message.role === "user"));
      await notify(tx, record.threadId);
    });
  }

  function writer(prepared: PreparedExecution): SettlementWriter {
    const record = prepared.run;
    let rows: ThreadMessage[] = [];
    let inputIds = new Set<string>();
    let phaseIds = new Set<string>();
    const output = new Map<string, ThreadMessage>();
    let state = prepared.state;
    return {
      get outputs() { return [...output.values()]; },
      get state() { return state; },
      async phase(botIndex, modelInput) {
        record.botIndex = botIndex;
        state = record.modelStates?.[record.botIds[botIndex]] ?? null;
        inputIds = new Set(modelInput.map(message => message.id)); rows = []; phaseIds = new Set();
        await database.execute(sql`update local_runs set bot_index=${botIndex},updated_at=now() where id=${record.id}`);
      },
      context: async botIndex => ({...(await context(record.threadId, database, record.id)),state:record.modelStates?.[record.botIds[botIndex]]??null}),
      async record(raw) {
        if (raw.type === "RUN_STARTED" || raw.type === "RUN_FINISHED" || raw.type === "RUN_ERROR") return;
        if (raw.type === "CUSTOM" && typeof raw.name === "string" && ["thread.message", "thread.updated"].includes(raw.name)) { console.warn("An agent emitted a reserved transcript event.", record.id); return; }
        const botId = record.botIds[record.botIndex];
        let body = { ...raw, senderBotId: botId } as ThreadEvent;
        if (body.type === "TOOL_CALL_START" && typeof body.parentMessageId !== "string") body = { ...body, parentMessageId: String(body.toolCallId) };
        if (body.type === "TOOL_CALL_RESULT" && typeof body.messageId !== "string") body = { ...body, messageId: `tool-result:${String(body.toolCallId)}` };
        let removed: string[] = [];
        if (body.type === "MESSAGES_SNAPSHOT") {
          const messages = (body.messages as ThreadMessage[]).filter(message => !inputIds.has(message.id) && (message.role === "assistant" || message.role === "tool" || message.role === "activity"))
            .map(message => ({ ...message, senderBotId: botId }));
          const ids = new Set(messages.map(message => message.id)); removed = [...phaseIds].filter(id => !ids.has(id));
          body = { ...body, messages };
        }
        const previous = rows; rows = projectThreadEvent(rows, body);
        const changed = rows.filter(message => !previous.includes(message)).map(message => ({ ...message, senderBotId: botId, createdAt: message.createdAt ?? new Date().toISOString() }));
        for (const message of changed) { output.set(message.id, message); phaseIds.add(message.id); }
        for (const id of removed) { output.delete(id); phaseIds.delete(id); }
        const byId = new Map(changed.map(message => [message.id, message])); rows = rows.map(message => byId.get(message.id) ?? message);
        if (body.type === "STATE_SNAPSHOT") { state = body.snapshot; record.modelStates = {...record.modelStates,[botId]:state}; }
        await database.transaction(async tx => {
          await save(tx, record, changed);
          if (removed.length) await tx.execute(sql`delete from local_messages where thread_id=${record.threadId} and run_id=${record.id} and id in(${sql.join(removed.map(id => sql`${id}`), sql`,`)})`);
          if (body.type === "STATE_SNAPSHOT") await tx.execute(sql`update local_runs set model_states=${JSON.stringify(record.modelStates)}::text::jsonb where id=${record.id}`);
          if (body.type === "MESSAGES_SNAPSHOT") body = { ...body, messages: (await context(record.threadId, tx, record.id)).messages };
          const written = await event(tx, record.threadId, record.id, body);
          if (!record.parentRunId && written.internal !== true) await notify(tx, record.threadId);
        });
      },
    };
  }

  async function settle(prepared: PreparedExecution, output: SettlementWriter, outcome: ExecutionOutcome): Promise<ExecutionResult> {
    const record = prepared.run;
    const terminal = await database.transaction(async tx => {
      await save(tx, record, output.outputs);
      const [saved] = await tx.execute(sql`update local_runs set
        status=case when stop_requested then 'stopped' else ${outcome.status} end,
        error=case when stop_requested then 'The work was cancelled.' else ${outcome.error ?? null} end,
        waiting=case when stop_requested then '[]'::jsonb else ${JSON.stringify(outcome.waiting ?? [])}::text::jsonb end,
        bot_index=${record.botIndex},model_states=${JSON.stringify(record.modelStates)}::text::jsonb,updated_at=now() where id=${record.id} returning ${fields}`) as ExecutionRecord[];
      if (!saved) throw new ConversationError("The execution is unavailable for settlement.", 409);
      await tx.execute(sql`update local_threads set updated_at=now() where id=${record.threadId}`);
      await event(tx, record.threadId, record.id, { type: "RUN_FINISHED", threadId: record.threadId, runId: record.id,
        status: saved.status, ...(saved.error ? { error: saved.error } : {}) } as ThreadEvent);
      if (record.parentRunId) await event(tx, record.threadId, prepared.ancestors[0]!, { type: EventType.CUSTOM, name: "thread.updated", value: null });
      if (!record.parentRunId) await announce(tx, record.threadId, output.outputs.findLast(message => message.role === "assistant" && typeof message.content === "string" && message.content.length > 0), saved.status === "waiting");
      await notify(tx, record.threadId); return saved;
    });
    return { runId: record.id, status: terminal.status, messages: output.outputs,
      replyText: output.outputs.filter(message => message.role === "assistant" && typeof message.content === "string").map(message => message.content).join("\n\n"),
      ...(terminal.error ? { error: terminal.error } : {}), ...(terminal.status === "waiting" ? { waiting: terminal.waiting ?? [] } : {}) };
  }

  async function cancel(threadId: string, runId: string, activeRunIds: readonly string[]) {
    return database.transaction(async tx => {
      const family = await tx.execute(sql`with recursive ancestors as (
        select id,parent_run_id from local_runs where id=${runId} and thread_id=${threadId}
        union all select p.id,p.parent_run_id from local_runs p join ancestors c on c.parent_run_id=p.id
      ), family as (select id from ancestors where parent_run_id is null
        union all select c.id from local_runs c join family p on c.parent_run_id=p.id)
      select ${fields} from local_runs where id in(select id from family) for update`) as ExecutionRecord[];
      for (const record of family) {
        const ended=record.status==="waiting"||(record.status==="running"&&!activeRunIds.includes(record.id));
        await tx.execute(sql`update local_runs set stop_requested=true,status=case when ${ended} then 'stopped' else status end,
          error=case when status in('running','waiting') then 'The work was cancelled.' else error end,
          waiting=case when ${ended} then '[]'::jsonb else waiting end,updated_at=now() where id=${record.id}`);
        if (ended) await event(tx, record.threadId, record.id, { type: "RUN_FINISHED", threadId: record.threadId, runId: record.id, status: "stopped", error: "The work was cancelled." } as ThreadEvent);
      }
      if (family.length) { await announce(tx, threadId); await notify(tx, threadId); }
      return family.map(record => record.id);
    });
  }
  async function ready(changedRunId: string): Promise<string[]> {
    const rows = await database.execute<{ id: string }>(sql`select child.id from local_runs child join local_runs parent on child.parent_run_id=parent.id
      where (child.id=${changedRunId} or parent.id=${changedRunId}) and child.status in('completed','failed','stopped','interrupted')
        and parent.status='waiting' and parent.stop_requested=false and exists(select 1 from jsonb_array_elements(coalesce(parent.waiting,'[]'::jsonb)) w
          where w->'metadata'->>'kind'='bot_wait' and w->'metadata'->>'childRunId'=child.id)`);
    return rows.map(row => row.id);
  }
  const publicRun = (record: ExecutionRecord): ThreadRun => ({ id: record.id, status: record.status,
    ...(record.error ? { error: record.error } : {}), waiting: humanWaiting(record.waiting) });
  async function snapshot(threadId: string, userId: string) {
    await requireAccess(threadId, userId);
    return database.transaction(async tx => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const stored = await context(threadId, tx);
      const [cursor] = await tx.execute<{ seq: number }>(sql`select coalesce(max(seq),0) as seq from local_events where thread_id=${threadId}`);
      const records = await tx.execute(sql`select ${fields} from local_runs where thread_id=${threadId} and parent_run_id is null
        order by case status when 'running' then 0 when 'waiting' then 1 else 2 end,updated_at desc,created_at desc`) as ExecutionRecord[];
      const last = records[0];
      const family = last && (last.status === "running" || last.status === "waiting")
        ? await tx.execute<{ waiting: ThreadRun["waiting"] }>(sql`with recursive family as (
            select id,status,waiting from local_runs where id=${last.id}
            union all select c.id,c.status,c.waiting from local_runs c join family p on c.parent_run_id=p.id where c.thread_id=${threadId}
          ) select waiting from family where status='waiting'`)
        : [];
      const waiting = family.flatMap(record => humanWaiting(record.waiting));
      return { messages: stored.messages, cursor: Number(cursor.seq), ...(last ? { lastRun: publicRun(last) } : {}),
        ...(last && (last.status === "running" || last.status === "waiting") ? { activeRun: { ...publicRun(last), waiting } } : {}) };
    });
  }

  return {
    prepare, begin, writer, settle, cancel, ready, snapshot, run, requireAccess,
    async events(threadId: string, after: number): Promise<StoredEvent[]> {
      const rows = await database.execute<{ seq: number; body: ThreadEvent }>(sql`
        select e.seq,e.body from local_events e join local_runs r on r.id=e.run_id
        where e.thread_id=${threadId} and e.seq>${after} and r.parent_run_id is null
          and e.body->>'internal' is distinct from 'true' order by e.seq limit 500`);
      return rows.map(row => ({ ...row.body, seq: Number(row.seq) }));
    },
    subscribe(threadId: string, changed: () => void) {
      const listeners = viewers.get(threadId) ?? new Set(); listeners.add(changed); viewers.set(threadId, listeners);
      return () => { listeners.delete(changed); if (!listeners.size) viewers.delete(threadId); };
    },
    async listen(databaseUrl: string) {
      connection = postgres(databaseUrl, { max: 1 });
      await connection.listen(UPDATES, threadId => { for (const changed of viewers.get(threadId) ?? []) changed(); });
    },
    async close() { viewers.clear(); await connection?.end(); },
    async recoverInterruptedRuns() {
      await database.transaction(async tx => {
        const interrupted = await tx.execute<{ id: string; threadId: string }>(sql`update local_runs set status='interrupted',error='The previous process ended before settlement.',updated_at=now()
          where status in('pending','running') returning id,thread_id as "threadId"`);
        for (const record of interrupted) {
          await event(tx, record.threadId, record.id, { type: "RUN_FINISHED", threadId: record.threadId, runId: record.id, status: "interrupted", error: "The previous process ended before settlement." } as ThreadEvent);
          await notify(tx, record.threadId);
        }
      });
    },
  };
}
export type Settlement = ReturnType<typeof createSettlement>;
