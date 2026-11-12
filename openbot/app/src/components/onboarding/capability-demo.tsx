import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { DuetCard } from "@/components/duet/kit";
import { MicOrb } from "@/components/duet/mic-orb";
import { MorningBriefCard } from "@/components/duet/morning-brief-card";
import { TaskRow } from "@/components/duet/task-card";
import type { ApprovalRequest } from "@/lib/approvals";
import { IllustrationFrame } from "./illustration-frame";

export type CapabilityDemoKind = "brief" | "approval" | "task" | "search";
export const DEMO_BEAT_MS = 2400;

const APPROVAL: ApprovalRequest = {
  id: "onboarding-example",
  status: "pending",
  createdAt: "2026-10-23T09:00:00Z",
  action: {
    botId: "openduet",
    threadId: "onboarding-example",
    toolRef: "openbot/share_private_information",
    effect: "share_private",
    scope: "external:ana@example.com",
    args: {
      audience: "google-workspace: ana@example.com",
      preview: "Ana，你好，星期五可以。我會帶同樣本。",
    },
    target: {},
  },
};

const LABELS: Record<CapabilityDemoKind, string> = {
  brief:
    "示例：早晨摘要列出待確認的送貨安排及今天的工作室探訪",
  search:
    "示例：機械人搜尋你的電郵後，整理早晨摘要",
  approval:
    "示例：機械人傳送電郵前先詢問，並提供「拒絕」及「只允許一次」",
  task: "示例：任務由「處理中」轉為「等待你審閱」",
};

/**
 * The brief's date line: today, as the real brief writes its own (`morning-brief-tool.tsx`).
 *
 * It was a fixed "Friday, October 23", which was right on the day it was written and wrong, with
 * a weekday that no longer matched, on every day after. The rows under it name a day ("Friday")
 * and never a date, so today is the one date the card can always show truthfully.
 */
export function demoDate(now: Date = new Date()): string {
  return now.toLocaleDateString("zh-HK", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Real cards, isolated from input. A hidden/offscreen demo stops its clock and orb. */
export function CapabilityDemo({ kind }: { kind: CapabilityDemoKind }) {
  const reduced = useReducedMotion() === true;
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const element = container.current;
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry?.isIntersecting ?? false;
            update();
          });
    if (element) observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    if (reduced || !visible) return;
    const timer = setInterval(
      () => setBeat((value) => (value + 1) % 3),
      DEMO_BEAT_MS,
    );
    return () => clearInterval(timer);
  }, [reduced, visible]);
  const phase = reduced ? 2 : beat;
  const done = phase === 2;
  const approval = kind === "approval";
  const task = kind === "task";
  const caption = approval
    ? done
      ? "經你同意後才執行"
      : "由你決定傳送內容"
    : task
      ? done
        ? "隨時可供審閱"
        : "正在處理"
      : done
        ? "今天等待你處理的事項"
        : "正在搜尋你的電郵";

  return (
    <div
      className="w-full min-w-0"
      data-capability-demo={kind}
      data-demo-phase={phase}
      ref={container}
    >
      <IllustrationFrame
        className="min-w-0 space-y-5 p-4 sm:p-6"
        label={LABELS[kind]}
      >
        <div className="flex min-w-0 items-center gap-4 px-2 py-3">
          <MicOrb
            size={48}
            state={done ? "done" : "thinking"}
            still={reduced || !visible}
          />
          <p className="type-sub min-w-0 text-duet-ink-2">{caption}</p>
        </div>
        <motion.div
          animate={{
            opacity: phase === 0 && !approval ? 0.55 : 1,
            y: phase === 0 && !reduced ? 8 : 0,
          }}
          initial={false}
          // Slower than any token on purpose: this is a demo the person watches, one beat
          // (DEMO_BEAT_MS) at a time, not a control answering a press.
          transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {approval ? (
            <ApprovalCard
              onDecide={() => {}}
              request={
                done
                  ? {
                      ...APPROVAL,
                      status: "completed",
                      decision: "allow_once",
                      decidedAt: "2026-10-23T09:00:00Z",
                    }
                  : APPROVAL
              }
            />
          ) : task ? (
            <DuetCard>
              <TaskRow
                status={done ? "ready_for_review" : "working"}
                title="確認星期五的送貨安排"
              />
            </DuetCard>
          ) : (
            <MorningBriefCard
              canWait={[]}
              date={demoDate()}
              greeting="今天安排，一目了然。"
              needsYou={[
                {
                  id: "delivery",
                  title: "確認送貨安排",
                  why: "Ana 等待你確認星期五的安排。",
                },
              ]}
              today={[
                {
                  id: "visit",
                  title: "下午 2 時探訪工作室",
                  why: "樣本已準備好。",
                },
              ]}
            />
          )}
        </motion.div>
      </IllustrationFrame>
    </div>
  );
}
