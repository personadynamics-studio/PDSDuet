import {
  IconLoader2,
  IconMessageCircle,
  IconMicrophone,
  IconMicrophoneOff,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { IconWaveform } from "@/components/icons/waveform";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { useVoiceCall } from "@/lib/voice/use-voice-call";
import { queryClient } from "@/query-client";

export function VoiceCallWidget({
  call,
  agentId,
  name,
  avatarSeed,
  taskRunning,
}: {
  call: ReturnType<typeof useVoiceCall>;
  agentId: string;
  name: string;
  avatarSeed: string;
  taskRunning: boolean;
}) {
  const { state, session, minimized, setMinimized } = call;
  const { data: user } = useQuery(currentUserQueryOptions(), queryClient);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials =
    user?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ||
    user?.email.slice(0, 2).toUpperCase() ||
    "?";
  const [captions, setCaptions] = useState(false);
  const reduceMotion = useReducedMotion();
  const hangup = useRef<HTMLButtonElement>(null);
  const visible = state.phase !== "idle";
  useEffect(() => {
    if (visible && !minimized) hangup.current?.focus();
  }, [visible, minimized]);
  if (!visible) return null;
  const connecting = state.phase === "connecting";
  const failed = state.phase === "error";
  const status = failed
    ? "無法通話"
    : connecting
      ? "連接中…"
      : state.speaking
        ? `${name} 正在說話`
        : taskRunning
          ? "正在處理你的要求"
          : state.muted
            ? "你的咪高峰已靜音"
            : state.listening
              ? "正在聆聽"
              : "隨時可以開始";
  const duration = `${Math.floor(state.seconds / 60)}:${String(state.seconds % 60).padStart(2, "0")}`;
  const transition = {
    duration: reduceMotion ? 0 : ENTRANCE_SECONDS,
    ease: EASE_OUT,
  };
  return (
    <motion.section
      aria-label={`與 ${name} 的語音通話`}
      initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="absolute top-4 right-4 z-20 w-[min(22.95rem,calc(100%-2rem))] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-lg dark:border-transparent"
    >
      <div className="mb-3 flex items-center justify-between gap-3 px-1 text-[0.65rem] text-muted-foreground">
        <span className="truncate" role="status" title={status}>
          {status}
        </span>
        <span
          className="shrink-0 tabular-nums"
          role="timer"
          aria-label="通話時間"
        >
          {duration}
        </span>
      </div>
      {minimized ? (
        <div className="flex items-center gap-3">
          <AbstractAvatar
            id={agentId}
            name={name}
            seed={avatarSeed}
            size={32}
          />
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          <Button
            aria-label="展開語音通話"
            title="展開通話"
            variant="ghost"
            size="icon-sm"
            onClick={() => setMinimized(false)}
          >
            <IconWaveform className="size-4" />
          </Button>
          <Button
            aria-label="結束語音通話"
            title="結束通話"
            variant="destructive"
            size="icon-sm"
            className="rounded-full"
            onClick={session.end}
          >
            <IconX className="size-4" />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex h-18 items-center gap-4 rounded-full bg-muted/60 px-4">
            <div
              title={name}
              className={cn(
                "flex size-[40px] shrink-0 items-center justify-center rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-muted transition-shadow motion-reduce:transition-none",
                state.speaking && "ring-primary/40",
              )}
            >
              <AbstractAvatar
                id={agentId}
                name={name}
                seed={avatarSeed}
                size={40}
              />
            </div>
            <div className="min-w-0 flex-1">
              {connecting ? (
                <IconLoader2 className="mx-auto size-4 text-muted-foreground motion-safe:animate-spin" />
              ) : (
                <LiveWaveform
                  stream={
                    state.speaking
                      ? state.output
                      : state.muted
                        ? undefined
                        : state.stream
                  }
                  className="w-full text-muted-foreground"
                  height={28}
                />
              )}
            </div>
            <div
              title={state.muted ? "你 · 咪高峰已靜音" : "你"}
              className={cn(
                "relative flex size-[40px] shrink-0 items-center justify-center rounded-full bg-background ring-2 ring-transparent ring-offset-2 ring-offset-muted transition-shadow motion-reduce:transition-none",
                state.listening && !state.muted && "ring-primary/40",
              )}
            >
              {user?.image && user.image !== failedImage ? (
                <img
                  src={user.image}
                  alt="你"
                  className="size-full rounded-full object-cover"
                  onError={() => setFailedImage(user.image ?? null)}
                />
              ) : (
                <span
                  role="img"
                  aria-label={user?.name ? `${user.name}（你）` : "你"}
                  className="text-sm font-medium text-foreground/70"
                >
                  {initials}
                </span>
              )}
              {state.muted && (
                <span className="absolute -bottom-1 -right-1 rounded-full bg-card p-1">
                  <IconMicrophoneOff className="size-2.5" />
                  <span className="sr-only">你的咪高峰已靜音</span>
                </span>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 px-4">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="通話設定"
                    title="通話設定"
                    variant="secondary"
                    size="icon"
                    className="size-12 rounded-full"
                  />
                }
              >
                <IconSettings className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-48">
                <DropdownMenuCheckboxItem
                  checked={captions}
                  onCheckedChange={setCaptions}
                >
                  顯示即時字幕
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              aria-label="返回對話"
              title="返回對話並繼續通話"
              variant="secondary"
              size="icon"
              className="size-12 rounded-full"
              onClick={() => setMinimized(true)}
            >
              <IconMessageCircle className="size-5" />
            </Button>
            <Button
              aria-label={
                state.muted ? "取消咪高峰靜音" : "將咪高峰靜音"
              }
              aria-pressed={state.muted}
              disabled={connecting || failed}
              title={
                state.muted
                  ? "取消咪高峰靜音"
                  : "將咪高峰靜音，仍可聽到機械人的聲音"
              }
              variant="secondary"
              size="icon"
              className={cn(
                "size-12 rounded-full",
                state.muted && "bg-foreground/15 ring-1 ring-foreground/10",
              )}
              onClick={session.mute}
            >
              {state.muted ? (
                <IconMicrophoneOff className="size-5" />
              ) : (
                <IconMicrophone className="size-5" />
              )}
            </Button>
            <Button
              ref={hangup}
              variant="destructive"
              size="icon"
              className="size-12 rounded-full bg-rose-500 text-white hover:bg-rose-600 dark:bg-rose-500 dark:hover:bg-rose-600"
              onClick={session.end}
              aria-label="結束語音通話"
              title="結束通話"
            >
              <IconX className="size-5" />
            </Button>
          </div>
          <AnimatePresence initial={false}>
            {captions && !failed && (
              <motion.div
                key="captions"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={transition}
                className="overflow-hidden"
              >
                <div className="mt-3 h-16 overflow-y-auto rounded-xl bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
                  {state.reply ||
                    state.transcript ||
                    "準備好後即可說話，這次通話會記錄在這段對話中。"}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {failed && (
            <div className="mt-3 text-xs">
              <p className="text-destructive" role="alert">
                {state.error}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => void session.start()}
              >
                重試
              </Button>
            </div>
          )}
        </>
      )}
    </motion.section>
  );
}
