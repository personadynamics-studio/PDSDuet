import {
  IconBulb,
  IconChevronRight,
  IconClock,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  changeProactiveSettingMutationOptions,
  createProactiveSettingMutationOptions,
  type ProactiveSetting,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

const intervals = [
  { minutes: 60, label: "每小時" },
  { minutes: 240, label: "每 4 小時" },
  { minutes: 720, label: "每日兩次" },
  { minutes: 1440, label: "每日一次" },
];
/** The label map, so a closed trigger says "每 4 小時" rather than 240. */
const intervalItems = intervals.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));
const intervalLabel = (minutes: number) =>
  intervals.find((interval) => interval.minutes === minutes)?.label ??
  `每 ${minutes} 分鐘`;
/** Next steps a Bot proposed from background research: start one as a task, or dismiss it. */
export function SuggestionsInbox({
  agentId,
}: {
  /** Only this Bot's suggestions, and nothing at all when it has none. */
  agentId?: string;
} = {}) {
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const shown = (suggestions.data ?? []).filter(
    (suggestion) => agentId === undefined || suggestion.agentId === agentId,
  );
  const bots = useQuery(agentListQueryOptions());
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? "你的機械人";
  if (agentId !== undefined && shown.length === 0) return null;
  return (
    <PageSection title="建議的下一步">
      {suggestions.isPending ? null : suggestions.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {suggestions.error.message}
        </p>
      ) : shown.length ? (
        <PageRows>
          {shown.map((suggestion, index) => (
            <Fragment key={suggestion.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBulb />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="line-clamp-none">
                    {suggestion.title}
                  </ItemTitle>
                  {suggestion.detail ? (
                    <ItemDescription className="line-clamp-none whitespace-pre-wrap text-foreground">
                      {suggestion.detail}
                    </ItemDescription>
                  ) : null}
                  <ItemDescription className="line-clamp-none">
                    {botName(suggestion.agentId)} ·{" "}
                    {new Date(suggestion.createdAt).toLocaleString()}
                    {suggestion.sourceApp || suggestion.sourceLink ? (
                      <>
                        {" · "}From {suggestion.sourceApp ?? "a connected app"}
                        {suggestion.sourceLink && (
                          <>
                            {" · "}
                            <a
                              href={suggestion.sourceLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              開啟記錄
                            </a>
                          </>
                        )}
                      </>
                    ) : null}
                  </ItemDescription>
                  {/* A set, so it wraps onto its own line rather than crowding the title. */}
                  <ItemFooter>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({ id: suggestion.id, action: "start" })
                        }
                      >
                        建立任務
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate({ id: suggestion.id, action: "dismiss" })
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  </ItemFooter>
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>
          暫未有建議。開啟背景資料搜尋的機械人會在這裏建議下一步工作。
        </PageEmpty>
      )}
      {act.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {act.error.message}
        </p>
      )}
    </PageSection>
  );
}

/**
 * Opt a Bot in to read-only background research of the apps it can already read.
 *
 * Each opt-in is a row stating its current answer; it opens a dialog to change how often, run it,
 * turn it off or remove it. Opting in is a dialog behind the section's action.
 */
export function ProactiveResearchSettings({
  agentId: fixedBot,
}: {
  /** Only this Bot's research, and a new one is this Bot's without asking. */
  agentId?: string;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [adding, setAdding] = useState(false);
  const shown = (settings.data ?? []).filter(
    (setting) => fixedBot === undefined || setting.agentId === fixedBot,
  );
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          開啟資料搜尋
        </Button>
      }
      description="與這個機械人開始一對一對話後，預設會開啟此功能。它每四小時讀取已獲授權的應用程式，整理記憶供你審閱，並建議下一步。它只能讀取內容，無法傳送訊息、修改應用程式，或操作瀏覽器及電腦。關閉或移除後，不會自行重新開啟。"
      title="背景資料搜尋"
    >
      {settings.isPending ? null : settings.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {settings.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty>背景資料搜尋已關閉。</PageEmpty>
      ) : (
        <PageRows>
          {shown.map((setting, index) => (
            <Fragment key={setting.id}>
              {index > 0 ? <Separator /> : null}
              <SettingRow
                setting={setting}
                botName={
                  bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
                  setting.agentId
                }
              />
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? (
        <TurnOnResearchDialog
          fixedBot={fixedBot}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </PageSection>
  );
}

/** Which Bot, where its suggestions go, how often, and what to look for. */
function TurnOnResearchDialog({
  fixedBot,
  onClose,
}: {
  fixedBot?: string;
  onClose: () => void;
}) {
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(240);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );
  const add = useMutation(createProactiveSettingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>開啟背景資料搜尋</DialogTitle>
          <DialogDescription>
            按排程讀取資料，並將建議傳送至機械人所在的頻道。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={id}
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate(
                { agentId, channelId, focus, intervalMinutes },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              {fixedBot === undefined ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-bot`}>機械人</FieldLabel>
                  <Select
                    items={bots.data?.map((bot) => ({
                      value: bot.id,
                      label: bot.name,
                    }))}
                    onValueChange={(value) => {
                      setAgentId(value ?? "");
                      setChannelId("");
                    }}
                    required
                    value={agentId || null}
                  >
                    <SelectTrigger className="w-full" id={`${id}-bot`}>
                      <SelectValue placeholder="選擇機械人" />
                    </SelectTrigger>
                    <SelectContent>
                      {bots.data?.map((bot) => (
                        <SelectItem key={bot.id} value={bot.id}>
                          {bot.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${id}-channel`}>
                  傳送建議至
                </FieldLabel>
                <Select
                  items={eligibleChannels.map((channel) => ({
                    value: channel.id,
                    label: conversationLabel(channel),
                  }))}
                  onValueChange={(value) => setChannelId(value ?? "")}
                  required
                  value={channelId || null}
                >
                  <SelectTrigger className="w-full" id={`${id}-channel`}>
                    <SelectValue placeholder="選擇頻道" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {conversationLabel(channel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-interval`}>執行頻率</FieldLabel>
                <Select
                  items={intervalItems}
                  onValueChange={(value) => {
                    if (value !== null) setIntervalMinutes(value);
                  }}
                  value={intervalMinutes}
                >
                  <SelectTrigger className="w-full" id={`${id}-interval`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {intervals.map((interval) => (
                      <SelectItem
                        key={interval.minutes}
                        value={interval.minutes}
                      >
                        {interval.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-focus`}>
                  留意事項（選填）
                </FieldLabel>
                <Input
                  id={`${id}-focus`}
                  maxLength={1000}
                  value={focus}
                  onChange={(event) => setFocus(event.target.value)}
                  placeholder="指派給我的未完成問題，以及等待我回覆的提問"
                />
              </Field>
            </FieldGroup>
          </form>
          {add.error && (
            <p role="alert" className="text-destructive text-sm">
              {add.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
          <Button
            disabled={add.isPending || !agentId || !channelId}
            form={id}
            size="sm"
            type="submit"
          >
            開啟背景資料搜尋
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether it is on, and when it runs next. Stated rather than captured, so it follows the query. */
function researchStatus(setting: ProactiveSetting) {
  return !setting.enabled
    ? "已關閉"
    : setting.lastStatus === "running"
      ? "正在搜尋資料"
      : `下次執行：${new Date(setting.nextRunAt).toLocaleString("zh-HK")}`;
}

/**
 * One Bot's research: a summary of its current answer and a chevron, opening a dialog that changes
 * it. The dialog is the row's sibling, not its child, so a click inside it does not bubble back to
 * the row and reopen it.
 */
function SettingRow({
  setting,
  botName,
}: {
  setting: ProactiveSetting;
  botName: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const summary = [
    setting.focus,
    intervalLabel(setting.intervalMinutes),
    researchStatus(setting),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              // Opening starts clean: the last change's failure is not this visit's.
              change.reset();
              setOpen(true);
            }}
            type="button"
          />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconRadar />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{botName}</ItemTitle>
          <ItemDescription>{summary}</ItemDescription>
          {setting.lastError ? (
            <ItemDescription className="text-destructive">
              {setting.lastError}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>背景資料搜尋</DialogTitle>
            <DialogDescription>
              {setting.focus ? `${botName} · ${setting.focus}` : botName}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Item size="sm" variant="muted">
              <ItemMedia variant="icon">
                <IconClock />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{researchStatus(setting)}</ItemTitle>
                {setting.lastRunAt && (
                  <ItemDescription>
                    上次執行：{new Date(setting.lastRunAt).toLocaleString("zh-HK")}
                    {setting.lastStatus === "succeeded"
                      ? ""
                      : ` (${setting.lastStatus})`}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
            {setting.lastError && (
              <p role="alert" className="text-destructive text-sm">
                {setting.lastError}
              </p>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-interval`}>執行頻率</FieldLabel>
              {/* Writes on pick: one value, no draft worth holding. */}
              <Select
                disabled={change.isPending}
                items={intervalItems}
                onValueChange={(minutes) => {
                  if (minutes !== null && minutes !== setting.intervalMinutes)
                    change.mutate({
                      setting,
                      change: { kind: "interval", minutes },
                    });
                }}
                value={setting.intervalMinutes}
              >
                <SelectTrigger className="w-full" id={`${id}-interval`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervals.map((interval) => (
                    <SelectItem key={interval.minutes} value={interval.minutes}>
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {change.error && (
              <p role="alert" className="text-destructive text-sm">
                {change.error.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { setting, change: { kind: "remove" } },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              移除
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate({ setting, change: { kind: "toggle" } })
              }
            >
              {setting.enabled ? "關閉" : "開啟"}
            </Button>
            <Button
              size="sm"
              disabled={!setting.enabled || change.isPending}
              onClick={() =>
                change.mutate({ setting, change: { kind: "run" } })
              }
            >
              立即執行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
