import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { readConnectPrompt, SHOW_APP_ACCESS_TOOL } from "@openbot/shared/connect-prompt";
import { DuetIcon } from "@/components/duet/icons";
import { Seen, TypingDots } from "@/components/duet/kit";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { MessageContent, Message as MessageRow } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { useBotNames } from "@/lib/agents/bot-names";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { attachmentUrl } from "@/lib/channels/attachments";
import { useConversationSession } from "@/lib/chat/active-bot";
import { drawsTool, ToolCard } from "@/lib/chat/tool-cards";
import { readFiring } from "@/lib/channels/routine-firing";
import { markdownComponents } from "@/lib/markdown";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { personToolLabel, readToolName } from "@/lib/plugins/tool-name";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  toolResultDeclined,
  toolResultFailed,
} from "@/lib/plugins/tool-result";
import { readTeamBotConsent } from "@/lib/team-bots";
import { cn } from "@/lib/utils";
import { AppAccessCard } from "./app-access-card";
import {
  repliesLast,
  type SentAttachment,
  toVisibleChatItems,
} from "./chat-messages";
import { splitChatOrigin } from "./chat-origin";
import { ReplyHoldProvider } from "./reply-hold";
import { TeamBotConsentCard } from "./team-bot-consent";
import {
  groupToolSteps,
  ToolActivity,
  type TranscriptItem,
  useDrawnTool,
} from "./tool-activity";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
  /** Comma-separated `/` command names, used to tell a skill chip from a leading slash. */
  commandNames?: string;
  messages: ReadonlyArray<Readonly<Message>>;
  speakerNames?: ReadonlyMap<string, string>;
  /** History has been asked for and has not arrived. Drawn only when there is nothing else to draw. */
  restoring?: boolean;
  /**
   * Why the last turn ended without an answer, if it did.
   *
   * A sentence rather than a flag, because the reasons are not interchangeable: a Bot that refused,
   * a Bot whose endpoint is down and a Bot that simply stopped talking are three different things to
   * be told, and only the thing that ended the turn knows which one happened.
   */
  stopped?: string;
  /** Drawn above the first message, such as the topic the conversation is about. */
  lead?: ReactNode;
  /** Extra classes on the scrolling column, such as room for a header floating over it. */
  contentClassName?: string;
};

/**
 * The film's message bubbles (launch-film/film/src/duet/app.tsx `Bubble`), on the visual system's
 * scale: body text, and one radius on every corner with no tail (parity-spec 2.3, 2.4).
 */
const BUBBLE_CONTENT =
  "duet-face type-body rounded-[var(--duet-radius-bubble)] px-4 py-3 text-duet-ink [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";
/** Streamdown's prose, tightened to a bubble: closer paragraphs, bullets hung outside the text. */
const AGENT_PROSE =
  "[&>div]:space-y-2.5 [&_ol]:list-outside [&_ol]:pl-5 [&_ul]:list-outside [&_ul]:pl-5 [&_li]:py-0.5";
const AGENT_BUBBLE =
  "max-w-[82%] *:data-[slot=bubble-content]:bg-duet-bubble *:data-[slot=bubble-content]:text-duet-ink";
const USER_BUBBLE = "max-w-[85%] *:data-[slot=bubble-content]:bg-duet-user";

/**
 * Split a person's message into the skill they invoked and the rest of what they typed.
 *
 * ONLY A KNOWN COMMAND COUNTS. "/etc/hosts is broken" is a sentence, not a skill, and drawing a chip
 * around it would invent a thing that never happened. The names come from the same list the `/` menu
 * was built from, so this stays true as skills are granted and revoked.
 *
 * The trigger only opens at the start of a line, so the chip is the first token or there is none.
 */
function splitSkillChip(
  text: string,
  commandNames: string,
): { chip: string; rest: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(\s|$)/.exec(text);
  if (!match) {
    return null;
  }
  const known = commandNames.split(",").filter(Boolean);
  if (!known.includes(match[1])) {
    return null;
  }
  return { chip: match[1], rest: text.slice(match[0].length) };
}

/**
 * The shape of a conversation, while it is still being fetched. Shaped like what is coming rather
 * than like a loading widget, on the same line pitch so the column does not jump when words land.
 */
const RESTORING_ANSWER_LINES = [
  { id: "line-1", width: "w-full" },
  { id: "line-2", width: "w-11/12" },
  { id: "line-3", width: "w-full" },
  { id: "line-4", width: "w-10/12" },
  { id: "line-5", width: "w-11/12" },
  { id: "line-6", width: "w-full" },
  { id: "line-7", width: "w-11/12" },
  { id: "line-8", width: "w-2/3" },
] as const;

function RestoringTranscript() {
  return (
    // One announcement, with every bar hidden from it: nine empty shapes read aloud is worse.
    <div aria-label="載入對話中" role="status">
      <div aria-hidden="true" className="flex justify-end pb-7">
        <Skeleton className="h-10 w-64 rounded-xl bg-muted/40 motion-reduce:animate-none" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {RESTORING_ANSWER_LINES.map((line) => (
          <Skeleton
            className={`h-4 bg-muted/40 motion-reduce:animate-none ${line.width}`}
            key={line.id}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Bot has the turn and has produced nothing yet.
 *
 * THE GAP THIS FILLS IS THE WORST ONE IN THE CONVERSATION. Between pressing send and the first token
 * there was `aria-busy` and nothing else: announced to a screen reader, invisible to everybody else.
 * A person who has just asked something watches their own message sit there, and a Bot that is
 * thinking is indistinguishable from a Bot that failed silently — which this app has shipped before.
 *
 * It borrows the shimmer a running tool line uses, so "working on it" reads the same whether the
 * work is a tool call or a model that has not spoken yet.
 */
function Thinking() {
  // The film's three dots in a grey bubble. The word stays for screen readers, in a `status`.
  return <TypingDots label="思考中" />;
}

/**
 * The turn ended and no answer came.
 *
 * In the same slot as `Thinking`, and for the same reason it is there: the person is looking at the
 * bottom of the transcript, immediately under their own message, because that is where the answer
 * was going to appear. Saying so above the composer put the explanation in a different part of the
 * screen from the gap it explains, and left the last thing in the conversation looking unfinished.
 *
 * NOT A MESSAGE, deliberately. It has no id, is never anchored, and is gone the moment the next turn
 * starts. Making it a transcript row would put a sentence into the conversation that nobody said,
 * and the conversation is sent back to the model on the next turn, so the Bot would then read its
 * own obituary as something it had written.
 */
function Stopped({ reason }: { reason: string }) {
  return (
    <p
      className="text-destructive text-sm"
      data-testid="transcript-stopped"
      role="alert"
    >
      {reason}
    </p>
  );
}

/**
 * How many of the newest turns cascade when a channel is opened, and how far apart.
 *
 * The tail rather than the head: opening a channel lands you at the bottom, so these are the ones
 * actually on screen. Staggering from the top of a long history would spend the whole budget on
 * messages nobody can see and leave the visible ones arriving last.
 *
 * Twelve at 40ms is 440ms of cascade before the last one starts. Past roughly half a second this
 * stops reading as settling and starts reading as waiting.
 */
const FIRST_PAINT_STAGGER_COUNT = 12;
const FIRST_PAINT_STAGGER_SECONDS = 0.04;

/**
 * Decide, once per message, whether it waits its turn.
 *
 * FROZEN PER ID ON PURPOSE. `delay` is a prop on a memoised component, so a value that changed
 * between renders would break the memo that makes the streaming path cheap — and worse, a message
 * whose delay changed could replay its entrance mid-stream. Each id is decided the first time it is
 * seen and never revisited.
 *
 * `settled` flips after the first render that has any items, which is NOT the first render: history
 * is restored asynchronously, so a channel's transcript is empty for a beat. Anything appearing
 * after that is a live turn and is given no delay at all.
 */
function createFirstPaintDelays() {
  const decided = new Map<string, number>();
  let settled = false;

  return {
    settle() {
      settled = true;
    },
    delayFor(id: string, index: number, total: number): number {
      const known = decided.get(id);
      if (known !== undefined) {
        return known;
      }
      const offset = total - FIRST_PAINT_STAGGER_COUNT;
      const place = index - Math.max(0, offset);
      const delay =
        settled || place < 0 ? 0 : place * FIRST_PAINT_STAGGER_SECONDS;
      decided.set(id, delay);
      return delay;
    },
  };
}

/**
 * A turn arriving in the transcript.
 *
 * WHY IT ANIMATES AT ALL: a message currently pops into existence at full opacity, and the eye has
 * nothing to follow from the composer to the transcript. This bridges that, and nothing more — it
 * is not decoration on something the reader is trying to read.
 *
 * IT RUNS ONCE, ON MOUNT. `initial`/`animate` fire when the element mounts, and the memoised parents
 * mean a streaming answer re-renders without remounting — so the fade plays when the message first
 * appears and never again while its text is still arriving. Animating per chunk would strobe.
 *
 * TRANSFORM AND OPACITY ONLY, so the scroller can still measure. `MessageScroller` sizes items and
 * places its anchor and spacer from layout; a transform is composited and changes no layout box, so
 * a message can fade in without moving the thing the scroller just measured.
 *
 * The full transform string rather than motion's `y` shorthand: the shorthand is not hardware
 * accelerated and drops frames exactly when the main thread is busy, which here is while a reply is
 * streaming.
 *
 * STAGGERED ONLY ON THE FIRST PAINT OF A CHANNEL. A turn sent mid-conversation arrives alone and
 * must not wait behind anything, so `delay` is zero for it. Opening a channel is the one moment the
 * whole history mounts at once, and cascading the last few reads as the conversation settling
 * rather than as a page appearing all at once. `createFirstPaintDelays` decides which is which.
 */
function Arriving({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      /*
       * `data-slot` IS LOAD-BEARING, NOT DECORATION. `MessageContent` right-aligns a person's own
       * message with `group-data-[align=end]/message:*:data-slot:self-end` — a selector that reaches
       * DIRECT CHILDREN CARRYING A data-slot. Wrapping the bubble in a plain div made this the direct
       * child, the selector matched nothing, and every message a person sent quietly moved to the
       * left column and read as though the Bot had said it.
       */
      data-slot="message-arriving"
      /*
       * FULL WIDTH, AND A FLEX COLUMN, because that is what it displaced. `Bubble` is
       * `w-fit max-w-[80%]` and aligns itself with `group-data-[align=end]/message:self-end`. Both
       * need the parent this wrapper replaced: against a shrink-to-fit box the 80% resolves against
       * the bubble's own width and short messages wrap for no reason, and `self-end` does nothing at
       * all outside a flex container.
       */
      className="flex w-full flex-col"
      initial={{
        opacity: 0,
        // Reduced motion keeps the fade and drops the movement: gentler, not absent.
        transform: shouldReduceMotion ? "none" : "translateY(8px)",
      }}
      transition={{
        // Reduced motion gets the fade with no queue: a cascade is movement too, just spread over
        // time, and somebody who asked for less of it should not wait for their history to arrive.
        delay: shouldReduceMotion ? 0 : delay,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A turn a schedule asked for, drawn as the event it is.
 *
 * The frame around a firing is addressed to the model — see `shared/routine-firing.ts` — and it
 * reached the transcript wearing `role: "user"`, which drew it as a muted bubble on the right, in
 * the exact style of something the person typed. Somebody reading back through a channel found
 * three sentences of instructions to a model in their own voice, telling their Bot what it may not
 * do. For a product whose whole claim is that a Bot is a coworker you can hold to account, a record
 * that misattributes who said what is the one thing it cannot afford.
 *
 * So: start-aligned and muted, because this is not the person speaking; the clock, because that is
 * what a routine already is everywhere else in the app; and the instruction ALONE, because that is
 * the part a person wrote and the only part addressed to them.
 */
function RoutineFiring({ instruction }: { instruction: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-muted-foreground text-sm">
      <DuetIcon className="shrink-0 translate-y-0.5" name="clock" size={16} />
      <span className="min-w-0">
        <span className="font-medium">已執行例行工作。</span>{" "}
        <span className="whitespace-pre-wrap">{instruction}</span>
      </span>
    </div>
  );
}

/**
 * One drawn message, and it is memoised on PRIMITIVES ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. Passing role and text means an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 */
const TranscriptMessage = memo(function TranscriptMessage({
  commandNames = "",
  delay,
  role,
  senderName,
  mine,
  text,
  seen = false,
  streaming = false,
}: {
  commandNames?: string;
  delay: number;
  role: "user" | "assistant";
  senderName?: string;
  mine?: boolean;
  text: string;
  /** The person's newest message, which the Bot has picked up and not yet answered in words. */
  seen?: boolean;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  /*
   * Checked before anything else a person's message gets. A firing is not a person's message: the
   * chip split, the end alignment and the bubble are all wrong for it, and each one of them would
   * have to learn about firings separately if this branched any later.
   */
  const firing = isUser ? readFiring(text) : null;
  if (firing !== null) {
    return (
      <MessageRow align="start">
        <MessageContent>
          <Arriving delay={delay}>
            <RoutineFiring instruction={firing} />
          </Arriving>
        </MessageContent>
      </MessageRow>
    );
  }
  const align = isUser && mine !== false ? "end" : "start";
  // Slack/Teams turns carry a model-facing participant line; show a marker instead of the line.
  const origin = isUser ? splitChatOrigin(text) : null;
  const said = origin ? origin.text : text;
  const invoked = isUser ? splitSkillChip(said, commandNames) : null;

  return (
    <MessageRow align={align}>
      <MessageContent>
        <Arriving delay={delay}>
          {senderName && (!isUser || mine === false) ? <p className="mb-1 text-xs font-medium text-muted-foreground">{senderName}</p> : null}
          {/*
            The film's bubbles: the Bot's in light grey and the person's in the accent tint,
            right-aligned, both rounded on every corner. Each Bot reply stays in one bubble,
            with its paragraphs, headings and tables rendered by Markdown inside it.
          */}
          {isUser ? (
            <Bubble align={align} className={USER_BUBBLE} variant="muted">
              <BubbleContent className={BUBBLE_CONTENT}>
                {/*
                 * A person's own message is shown exactly as they typed it. Rendering it as
                 * markdown would silently reformat what they said, and an asterisk in a sentence
                 * is not emphasis. The chip is the one exception, and it is not reformatting: it is
                 * drawing the thing that was already a chip in the composer as a chip here too, so
                 * the transcript shows a skill was used rather than a slash that was typed.
                 */}
                <span className="whitespace-pre-wrap">
                  {origin && (
                    <span className="mr-1.5 inline-flex items-center rounded bg-foreground/10 px-1.5 py-0.5 align-middle text-foreground/70 text-xs">
                      via {origin.via}
                    </span>
                  )}
                  {invoked ? (
                    <>
                      {/*
                       * The same icon the sidebar uses for Skills, so the badge says WHAT KIND of
                       * thing was invoked before it says which one. `inline-flex` with
                       * `align-middle` rather than a block: this sits mid-sentence, and a badge that
                       * breaks the line it is in reads as a separate message.
                       */}
                      <span className="mr-1 inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 align-middle font-mono text-foreground/80 text-xs">
                        <DuetIcon className="shrink-0" name="box" size={12} />/
                        {invoked.chip}
                      </span>
                      {invoked.rest}
                    </>
                  ) : (
                    said
                  )}
                </span>
              </BubbleContent>
            </Bubble>
          ) : (
            <Bubble
              align={align}
              className={AGENT_BUBBLE}
              variant="secondary"
            >
              <BubbleContent className={cn(BUBBLE_CONTENT, AGENT_PROSE)}>
                <Streamdown
                  components={markdownComponents}
                  mode={streaming ? "streaming" : "static"}
                  isAnimating={streaming}
                >
                  {text}
                </Streamdown>
              </BubbleContent>
            </Bubble>
          )}
          {seen ? <Seen /> : null}
        </Arriving>
      </MessageContent>
    </MessageRow>
  );
});

/**
 * Which of the person's messages reads "Seen" (parity-spec 2.13), or null for none.
 *
 * Only their newest, and only while the Bot has not answered it in words: a message in the thread
 * has reached the Bot, so it is seen from then until a reply sits under it. Read off the thread
 * alone, so a reload mid-turn draws it again. The transcript waits for it to settle before drawing
 * it (`useSettled`), so history replaying in does not flash it under older messages.
 */
export function seenMessageId(items: readonly TranscriptItem[]): string | null {
  const newest = items.findLastIndex(
    (item) =>
      item.kind === "text" &&
      isPersonSentMessage(item.role, item.text),
  );
  if (newest === -1) return null;
  const answered = items
    .slice(newest + 1)
    .some((item) => item.kind === "text" && item.role === "assistant");
  return answered ? null : (items[newest]?.id ?? null);
}

/** How long "Seen" waits for the thread to hold still before it is drawn. */
const SEEN_SETTLE_MS = 400;

/** The value once it has held for `ms`; null at once when it becomes null. */
function useSettled(value: string | null, ms: number): string | null {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return value !== null && settled === value ? value : null;
}

/**
 * The one shape an attachment url is allowed to have, taken from the helper that builds it rather
 * than written out again, so the check cannot drift from the route that serves the file.
 */
const ATTACHMENT_URL_PREFIX = attachmentUrl("");

/**
 * THE FILES A PERSON ATTACHED TO ONE TURN, drawn as a row where their own message would be.
 *
 * ALWAYS THE PERSON'S OWN, so it aligns end like their bubble does — `toVisibleChatItems` only ever
 * produces this kind from a user turn's content, and there is no assistant equivalent to confuse it
 * with. `justify-end` is what actually puts a short row against the right edge; `align="end"` gets
 * the row there, not the tiles inside it.
 *
 * SQUARE, AND ALL THE SAME SIZE. Three photos of different shapes drawn at their own aspect ratios
 * make a ragged row whose only signal is which camera took what, and a single tall screenshot drawn
 * at its own aspect pushed the rest of the turn off the screen. A grid of equal tiles says "three
 * files" at a glance, which is the thing worth saying here; the picture itself is one click away.
 */
type AttachmentRowProps = {
  attachments: readonly SentAttachment[];
  delay: number;
};

/**
 * Whether two renders of this row are the same row, compared BY VALUE because identity says no
 * every time.
 *
 * `toVisibleChatItems` runs on every render of the transcript — deliberately, and the comment on
 * that call says why: the agent hands back the same array and mutates it, so a `useMemo` over it
 * never invalidates and a reply never appears. The price is that `attachments` is a fresh array of
 * fresh objects on every chunk of a streaming answer, and `memo`'s default `Object.is` on two
 * different arrays is false however identical they are. So this memo missed EVERY time, and every
 * tile in a channel's history — each one carrying an image `Dialog` — re-rendered on every token
 * of an answer being typed further down. The memoised message rows above it were paying for this
 * one's misses.
 *
 * Field by field, because the fields are what the tiles draw: a row whose files have the same ids,
 * urls, names and kinds in the same order draws exactly the same pixels.
 *
 * Exported so it can be checked without mounting anything, the same reason `isPersonSentMessage`
 * is.
 */
export function sameAttachmentRow(
  previous: AttachmentRowProps,
  next: AttachmentRowProps,
): boolean {
  if (previous.delay !== next.delay) {
    return false;
  }
  if (previous.attachments.length !== next.attachments.length) {
    return false;
  }

  return previous.attachments.every((attachment, index) => {
    const other = next.attachments[index];
    return (
      other !== undefined &&
      attachment.id === other.id &&
      attachment.attachmentId === other.attachmentId &&
      attachment.url === other.url &&
      attachment.filename === other.filename &&
      attachment.modality === other.modality
    );
  });
}

export const TranscriptAttachments = memo(function TranscriptAttachments({
  attachments,
  delay,
}: AttachmentRowProps) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Arriving delay={delay}>
          <AttachmentTiles attachments={attachments} />
        </Arriving>
      </MessageContent>
    </MessageRow>
  );
}, sameAttachmentRow);

/**
 * The tiles themselves, as one row.
 *
 * Its own component because the QUEUE draws this row too, faded, for a message parked mid-turn —
 * and two copies of a list of tiles is two places for the alignment below to be got right.
 *
 * `self-end` because `align="end"` does not reach this far on its own: both callers put this
 * inside a `flex w-full flex-col` — `Arriving` for a sent turn, `MessageContent` for a parked one —
 * so a block child stretches to the transcript's full width and its contents draw hard against the
 * LEFT edge, under the person's own right-aligned bubble, reading as though the Bot had sent them.
 * `Bubble` escapes this because it carries its own `group-data-[align=end]/message:self-end`.
 */
function AttachmentTiles({
  attachments,
  className,
}: {
  attachments: readonly SentAttachment[];
  className?: string;
}) {
  return (
    <ul
      className={cn(
        "flex w-fit flex-wrap items-start justify-end gap-2 self-end",
        className,
      )}
    >
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <SentAttachmentTile attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One tile in that row, and all three shapes are the same size on purpose.
 *
 * A document used to draw as a `ToolLine`, which was the right call while an attachment was a row
 * of its own: that component is one line for one thing a Bot did, and a filename beside a label is
 * exactly that shape. It is the wrong thing inside a ROW. `ToolLine` has no width of its own, so
 * two documents and a photo came out as a pair of bare sentences stretched across the empty half of
 * the line with the picture stranded at the end — the same tiles, laid out as if they were prose.
 *
 * So a document gets a card the height of a thumbnail instead. What the row is saying is "these
 * files came with this message", and it can only say it if every tile in it reads as a file.
 *
 * A BROKEN-IMAGE GLYPH SAYS NOTHING TO THE READER — the browser's placeholder tells them a box
 * failed to load, not that a file is gone. `onError` catches that and swaps it for a sentence in the
 * file's own name, in the same destructive vocabulary `Stopped` already uses for "the thing that was
 * supposed to be here isn't." It borrows the LOOK and not the urgency: see the missing tile below
 * for why the same absence is a note here and an alert there.
 */
/**
 * The probes currently outstanding, so that two tiles asking the same question ask it once.
 *
 * ONE TURN CAN CARRY THE SAME FILE TWICE — `toVisibleChatItems` keys tiles on the PART index
 * precisely so that it can — and a message parked mid-turn draws its files a second time beside the
 * sent row while the queue holds it. Each of those tiles mounts its own effect, and each one used
 * to send its own request for an answer that is the same by construction.
 *
 * WHAT THAT SHARING IS WORTH, CORRECTED. This comment used to say a duplicate probe was "a
 * duplicate megabyte read, not a duplicate status line", because at the time a HEAD reached a
 * handler whose single statement selected `attachments.bytes`. It does not any more: the route
 * grew a branch that answers a HEAD from `name, mimeType, sizeBytes` and never touches the bytes.
 * A duplicate probe is now exactly the duplicate status line this once said it was not.
 *
 * IT STILL EARNS ITS KEEP, FOR A REASON THAT DOES NOT DEPEND ON THE OLD COST. Nothing else in the
 * stack will coalesce these: the route serves `private, no-cache`, so the browser's HTTP cache is
 * required to revalidate every probe rather than answer one from the other, and two tiles for one
 * file are two components with two effects and no knowledge of each other. Without this map the
 * same question goes over the wire once per tile, every time the transcript mounts. It is a dozen
 * lines to ask it once, and cheap-per-answer is not the same as free-per-answer.
 *
 * IN FLIGHT ONLY, AND DELIBERATELY NOT A CACHE OF THE ANSWERS — and THIS is the half the old cost
 * model was never holding up. Holding onto "this file is still there" across remounts is exactly
 * the lie this hook exists to stop: a file deleted while the reader has the app open would go on
 * drawing as an intact card for as long as the tab lived, which is the "worse of the two lies" the
 * comment below names. That was the argument then and it is the whole argument now. Holding onto
 * "this file is GONE" is sound, deletion being terminal, but it buys nothing worth the branch.
 */
const probesInFlight = new Map<string, Promise<boolean>>();

/**
 * Asks the route whether this file is missing, and answers the SAME question only once at a time.
 *
 * Resolves true for 404 and false for every other answer; a fetch that never arrives rejects, and
 * the caller declines to draw a conclusion from it.
 */
function probeDocument(url: string): Promise<boolean> {
  const existing = probesInFlight.get(url);
  if (existing) return existing;

  const probe = fetch(url, { method: "HEAD", credentials: "include" })
    .then((response) => response.status === 404)
    .finally(() => {
      // Cleared however it settled, so the next mount asks again rather than inheriting an answer
      // that has had time to stop being true.
      probesInFlight.delete(url);
    });

  probesInFlight.set(url, probe);
  return probe;
}

/**
 * Whether the row behind a document has been deleted, asked of the server that serves it.
 *
 * A DOCUMENT HAS NO OTHER WAY TO FIND OUT. The picture beside it learns its file is gone by
 * fetching it: the `<img>` requests the url, the route answers 404, and `onError` fires. A document
 * tile is a filename and a label — it requests nothing, so no event about the file can ever reach
 * it — and `failedToLoad` was the only thing feeding the absent branch. A deleted document
 * therefore kept drawing as an intact card naming a file the server was answering 404 for, which
 * is the worse of the two lies: a broken picture at least looks broken.
 *
 * `HEAD` because the question is whether the row exists and the status line is the whole answer, so
 * the reader is not made to download a PDF to learn it is still there. AND IT IS NOW CHEAP ON THE
 * SERVER TOO, WHICH IT ONCE WAS NOT AND WHICH THIS COMMENT WENT ON ASSERTING AFTER IT STOPPED BEING
 * TRUE. The old paragraph was right about the mechanism — Hono does answer a HEAD by dispatching
 * the GET handler in full and dropping the body at the last step — and it concluded that the server
 * therefore still read the whole file out of Postgres, and that a route which could answer "is it
 * there" without the bytes "is not this file's to write". Somebody wrote it. The attachment route
 * now branches on the method INSIDE the handler Hono actually dispatches, selects `sizeBytes`
 * instead of `bytes`, and sets `Content-Length` by hand; the access join, the statuses and the
 * revalidation are the GET's exactly, so a probe still learns nothing a fetch would not tell you.
 *
 * That is recorded here rather than quietly deleted because this file spent two review rounds being
 * read as evidence that the cheap probe did not exist. A comment describing a path as broken, about
 * a path that works, costs more than no comment at all.
 *
 * A REQUEST THAT NEVER ARRIVED IS NOT A DELETED FILE, so a rejected fetch — offline, a dropped
 * connection, a proxy in the way — leaves the card alone rather than accusing the server of having
 * lost somebody's file.
 *
 * AND NEITHER IS A REQUEST THE SERVER REFUSED, which is the same rule and was the bug. This asked
 * `!response.ok`, which is every status outside 200-299, when exactly one of them means what the
 * tile then says. The route collapses "no such row", "channel deleted" and "not a channel of
 * yours" into 404 precisely so that probing ids learns nothing — that is the one status that means
 * "there is no file here for you". Everything else is a fact about the request:
 *
 *   - 401 is a session that expired while the channel sat open, and it turned EVERY document tile
 *     in the transcript into a red card asserting, in each file's own name, that somebody's files
 *     had been deleted. Nothing had been; they need to sign in again.
 *   - 500 is a bad moment on the server, and it stuck: the deps below are stable, so nothing asks
 *     again and the accusation stands until the component remounts.
 *   - 304 is the strongest proof of PRESENCE this route can give — the row was found AND the
 *     membership join passed — and `Response.ok` is false for it.
 *
 * That is the same lie this hook exists to stop, pointing the other way, and it is the louder one:
 * drawn in the destructive vocabulary, naming the file. So absence is claimed on 404 alone, which
 * also puts a document back in step with the picture beside it — an `<img>` handed a 401 shows a
 * broken image, not a sentence swearing the file was deleted.
 */
function useDocumentIsGone(url: string, ask: boolean): boolean {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!ask) {
      return;
    }
    // A tile reused at the same position for a different file starts the question over rather than
    // inheriting the previous file's answer.
    setGone(false);

    let cancelled = false;
    void probeDocument(url)
      .then((missing) => {
        if (!cancelled && missing) {
          setGone(true);
        }
      })
      .catch(() => {
        // Deliberately nothing: see above. Not knowing is not the same as knowing it is gone.
      });

    return () => {
      cancelled = true;
    };
  }, [ask, url]);

  return gone;
}

function SentAttachmentTile({ attachment }: { attachment: SentAttachment }) {
  const [failedToLoad, setFailedToLoad] = useState(false);
  const { filename, modality, url } = attachment;
  /*
   * An off-site url is treated as a missing file, whatever kind of file it says it is.
   *
   * `toVisibleChatItems` passes on whatever a `url` source carried, and nothing between here and
   * the wire narrows it. A sent message only ever carries the relative form — `shared/attachments.ts`
   * says the url "is never fetched by a provider", and `copilot.ts` swaps the source for the bytes
   * as the run is built — so an absolute url arriving here did not come from this app's composer,
   * and putting it in `src` would have the reader's browser fetch a third party the instant the
   * transcript drew, announcing to whoever owns it that this person opened this channel.
   */
  const servable = url.startsWith(ATTACHMENT_URL_PREFIX);
  /*
   * ONLY OURS IS EVER ASKED ABOUT, and that is the same rule as the line above rather than a second
   * one: a probe is a request like any other, so asking a third party whether a file is still there
   * announces the reader exactly as fetching it would. An off-site url is already unavailable
   * without anybody being asked.
   */
  const gone = useDocumentIsGone(url, servable && modality === "document");
  const unavailable = failedToLoad || gone || !servable;

  /*
   * ABSENCE IS DECIDED BEFORE MODALITY IS, and that ordering is the whole point of this block
   * sitting above the document card rather than below it. A document whose url is not ours to
   * serve, or whose row `useDocumentIsGone` found deleted, drew as an intact card naming a file
   * that is not there. A missing picture at least looked missing; a missing document looked
   * present. Whether the file can be shown at all is the first question either kind asks.
   */
  if (unavailable) {
    return (
      /*
       * `note`, NOT `alert`, AND THE DIFFERENCE IS WHO IS INTERRUPTED. An alert is an assertive
       * live region: it cuts across whatever a screen reader is saying the moment it appears. That
       * is right for `Stopped`, which reports something that just happened in answer to what
       * somebody did, and wrong for every one of these — a transcript with three deleted files
       * fired three interruptions on mount, before the reader had heard a word of the conversation,
       * to report absences that predate their opening the channel.
       *
       * `note` is not a live region at all, so nothing is announced over anything; it still marks
       * the tile as a thing to stop on, and the sentence inside it — unchanged, in the file's own
       * name — is what says the file is gone when the reader reaches it.
       */
      <div
        className="flex h-32 w-44 flex-col justify-center gap-2 rounded-xl border border-destructive border-dashed p-3 text-destructive"
        role="note"
      >
        <DuetIcon name="alert" size={24} />
        <p className="text-sm">{unavailableSentence(filename)}</p>
      </div>
    );
  }

  if (modality === "document") {
    return (
      <div className="flex h-32 w-44 flex-col justify-between rounded-xl border border-border bg-muted/40 p-3">
        <DuetIcon className="text-muted-foreground" name="file" size={24} />
        <div className="min-w-0">
          {/* `title` because the tile is fixed-width and a long name is cut, not wrapped. */}
          <p className="truncate font-medium text-sm" title={filename}>
            {filename ?? "未命名檔案"}
          </p>
          <p className="text-muted-foreground text-xs">附件</p>
        </div>
      </div>
    );
  }

  return (
    <AttachmentLightbox filename={filename} url={url}>
      <img
        alt={filename ? `附件：${filename}` : "附件"}
        className="size-32 rounded-xl object-cover"
        onError={() => setFailedToLoad(true)}
        src={url}
      />
    </AttachmentLightbox>
  );
}

/**
 * What an absent file is called, in one place, because two surfaces now say it.
 *
 * The tile said it and the lightbox behind the tile said nothing at all. Sharing the wording rather
 * than writing it twice is what keeps them from drifting into two different accounts of the same
 * absence — the tile naming the file and the dialog saying something vaguer, or worse, later.
 *
 * A file with no name still gets a sentence rather than a blank: the reader clicked on something,
 * and "this attachment" is the honest way to refer to a thing whose name we never had.
 */
function unavailableSentence(filename?: string): string {
  return filename
    ? `無法使用 ${filename}。`
    : "這個附件無法使用。";
}

/**
 * The full-size picture inside the lightbox, and what it draws when the file will not load.
 *
 * IT NEEDED A FAILURE STATE AND HAD NONE. The tile in front of it has had one from the start — an
 * `onError` swapping the broken-image box for a sentence, with a comment above it about why the
 * browser's own placeholder "says nothing to the reader" — and this `<img>`, the one drawn at full
 * size against a dark backdrop with the reader's whole attention on it, had no `onError` at all. A
 * file deleted between the tile painting and the reader clicking it opened a dialog containing
 * exactly the placeholder the tile path exists to avoid.
 *
 * THE TILE CANNOT COVER THIS ONE. Its own `<img>` has already loaded by the time there is anything
 * to click, and a loaded image does not fire `error` again because the file behind it went away; the
 * request that finds out is this one. Nor can the probe beside it: `useDocumentIsGone` deliberately
 * never asks about a picture, because a picture's own load is supposed to be the answer — and this
 * is the load it meant.
 *
 * IT STAYS OPEN AND SAYS SO, rather than closing itself. The reader opened this deliberately, and a
 * dialog that vanishes on its own leaves them looking at the transcript with no idea what happened
 * and their focus wherever the close put it. The sentence in place answers the question they
 * actually asked. Escape and the close button still work, and the state resets when the popup
 * unmounts, so reopening genuinely tries again rather than remembering a failure.
 *
 * ITS OWN COMPONENT, AND EXPORTED, SO THE FAILURE CAN BE TESTED AT ALL: Base UI portals this popup
 * and under happy-dom the portal never mounts — checked, and recorded in the test named "a thumbnail
 * is a crop" — so there is no way to reach this `<img>` through the trigger. Same reason
 * `sameAttachmentRow` is exported: the behaviour is worth pinning and the thing it lives inside
 * cannot be mounted here.
 */
export function LightboxPicture({
  filename,
  url,
}: {
  filename?: string;
  url: string;
}) {
  const [failedToLoad, setFailedToLoad] = useState(false);

  if (failedToLoad) {
    return (
      /*
       * `note` rather than `alert`, for the reason the tile's own missing card gives at length: an
       * assertive live region cuts across whatever a screen reader is saying, and this is an answer
       * to something the reader just did rather than an emergency. Light-on-dark because it is
       * drawn against the lightbox's own backdrop, where `text-destructive` is unreadable.
       */
      <div
        className="flex flex-col items-center gap-3 p-8 text-center text-white"
        role="note"
      >
        <DuetIcon name="alert" size={32} />
        <p className="text-sm">{unavailableSentence(filename)}</p>
      </div>
    );
  }

  return (
    <img
      alt={filename ?? "附件"}
      className="max-h-[88svh] max-w-[92vw] rounded-lg object-contain"
      onError={() => setFailedToLoad(true)}
      src={url}
    />
  );
}

/**
 * The square, opened.
 *
 * The tile is a crop — that is the price of a tidy row — so there has to be a way to see the whole
 * picture, and it used to be `target="_blank"`. A new tab is a worse answer than it looks: it drops
 * the reader out of the conversation they were reading, the browser shows the raw file against its
 * own chrome with no way back but the back button, and on a phone it is a context switch away from
 * the channel entirely. A dialog closes on Escape and puts them back exactly where they were.
 *
 * Built on the app's `Dialog` so focus trapping, scroll locking and Escape behave the way they do
 * everywhere else, but with its card stripped off: `max-w-none border-0 bg-transparent p-0
 * shadow-none` leaves the picture as the only lit thing against a dark backdrop.
 *
 * THE CLOSE BUTTON IS FIXED TO THE VIEWPORT, not to the popup, which is why `showCloseButton` is
 * off and this draws its own. Pinned to the popup it would sit on the picture — invisible over a
 * pale one, and moving with every image's shape.
 */
function AttachmentLightbox({
  children,
  filename,
  url,
}: {
  children: React.ReactNode;
  filename?: string;
  url: string;
}) {
  const label = filename ?? "附件";
  /*
   * Controlled only so that clicking the dark space around the picture closes it, the way every
   * lightbox a reader has used does. The popup covers the viewport (see below), so it — not the
   * backdrop underneath — is what receives that click, and Base UI's own dismiss never fires.
   */
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        // A button, not a link: it opens something on this page, and a middle-click offering a new
        // tab to a raw image file is not the promise this makes. `block` so the tile is not sitting
        // on a text baseline with a stray gap under it.
        className="block cursor-zoom-in overflow-hidden rounded-xl"
        render={<button aria-label={`開啟 ${label}`} type="button" />}
      >
        {children}
      </DialogTrigger>
      <DialogContent
        /*
         * THE CARD IS STRIPPED OFF AND THE POPUP IS MADE FULL-SCREEN, and the second half is not
         * cosmetic. `DialogContent` centres itself with `-translate-x-1/2 -translate-y-1/2`, and a
         * transform on an ancestor is what `position: fixed` resolves against — so a close button
         * "fixed to the viewport" inside it landed 72px down and 30px in from the corner instead of
         * at it. Measured, not guessed. A popup that already IS the viewport has no transform, and
         * `absolute` in it means the corner it looks like it means.
         *
         * Centring by flex rather than by width also lets the picture keep its own shape: as a
         * stretched flex child it was drawn 1012px wide for a 644px image, letterboxed inside a box
         * far bigger than itself.
         */
        className="inset-0 top-0 left-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 items-center justify-center rounded-none border-0 bg-transparent p-0 shadow-none"
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        overlayClassName="bg-black/80 supports-backdrop-filter:backdrop-blur-sm"
        showCloseButton={false}
      >
        {/* Named for a screen reader; the picture carries the same name in its alt text. */}
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <LightboxPicture filename={filename} url={url} />
        <DialogClose
          render={
            <button
              aria-label="關閉"
              className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
              type="button"
            />
          }
        >
          <DuetIcon name="x" size={20} />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

const TranscriptToolCall = memo(function TranscriptToolCall({
  delay,
  toolCallId,
  name,
  args,
  result,
}: {
  delay: number;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
}) {
  const session = useConversationSession();
  const waitingOnPerson = session?.activeRun?.waiting?.some((item) => item.toolCallId === toolCallId) ?? false;
  const drawn = drawsTool(name) ? <ToolCard id={toolCallId} name={name} args={args} result={result} /> : null;

  return (
    <Arriving delay={delay}>
      <ToolRenderBoundary name={name}>
        {drawn ?? (
          <>
            <ServerToolLine
              name={name}
              result={result}
              waiting={waitingOnPerson}
            />
          </>
        )}
      </ToolRenderBoundary>
    </Arriving>
  );
});


export function ServerToolLine({
  name,
  result,
  waiting = false,
}: {
  name: string;
  result?: string;
  /** Held on its approval card for the person's answer, so it is not running yet. */
  waiting?: boolean;
}) {
  const running = result === undefined && !waiting;
  // Said no on its card: nothing was done, and the line says so rather than naming it as done.
  const declined = toolResultDeclined(result);
  /*
   * A refusal is not a result, and must not read like one.
   *
   * The server says which it is rather than the browser inferring it from the wording, because the
   * wording is a policy message an administrator can rewrite and the first rephrasing would break
   * any guess made here. See REFUSAL_MARKER in server/src/plugins/tools.ts.
   */
  const answer = result === undefined ? undefined : asText(result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  const failed = !refused && !declined && toolResultFailed(result);
  // A refused, declined or failed call is named plainly ("Send your email"), never as done; one
  // waiting on its card says that it waits ("Waiting for your OK to send your email").
  const named = readToolName(
    name,
    refused || failed || declined ? "plain" : running,
  );
  const label =
    waiting && result === undefined
      ? (personToolLabel(name, "waiting") ?? named.label)
      : named.label;
  const detail = named.detail;
  /*
   * The marker is for this component, not for the reader. Left in, a refusal reads "Blocked" in the
   * label and then "Refused." again in the first two words of the body, which is the same fact three
   * times over by the end of the sentence. Stripped here rather than on the server, because the
   * server's copy is what the model is told and "Refused." in front of a reason is right for it.
   */
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;
  // A Team Bot asking to use this person's own account draws its consent card, not the sentence.
  const consent = refused ? readTeamBotConsent(body) : null;
  if (consent) return <TeamBotConsentCard {...consent} />;
  /*
   * An app this call could not use draws a card with the step that fixes it, not the name of a
   * screen: a refusal carrying the marker, or the answer of the one tool whose whole job is to put
   * that card on screen. Only that tool's ordinary answer is read for a marker — any other result
   * is somebody else's text, and a card must not be conjured out of it.
   */
  const card = refused
    ? readConnectPrompt(body)
    : name === SHOW_APP_ACCESS_TOOL
      ? readConnectPrompt(answer)
      : null;
  if (card) return <AppAccessCard prompt={card} />;
  /*
   * THAT TOOL'S OTHER ANSWERS ARE FOR THE MODEL. An app nobody can name comes back as plain text
   * telling the Bot to say so plainly and not to browse to it — an instruction, which read by the
   * person looks like the Bot being told off in front of them. The line still says the check
   * happened; the Bot's own reply says what it found.
   */
  const shown = name === SHOW_APP_ACCESS_TOOL ? undefined : body;
  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      label={label}
      refused={refused}
      failed={failed}
      declined={declined}
      running={running}
    >
      {shown ? (
        <Streamdown components={markdownComponents}>
          {forDisplay(shown)}
        </Streamdown>
      ) : null}
    </ToolLine>
  );
}

/**
 * Whether a text item is the person actually sending something, as opposed to a routine firing that
 * merely arrived wearing `role: "user"`.
 *
 * A FIRING IS NOT THE PERSON SPEAKING — `TranscriptMessage` already knows that and draws it as
 * `RoutineFiring` rather than as their bubble, via the same `readFiring` check used here. The scroll
 * machinery below was the one place left that had not caught up: it smooth-scrolled and anchored on
 * `role === "user"` alone, so a routine firing while somebody was reading back through the channel
 * yanked their viewport to the bottom as though they had just typed and sent something. They hadn't;
 * the schedule had. Exported so this can be checked without mounting anything.
 */
export function isPersonSentMessage(
  role: "user" | "assistant",
  text: string,
): boolean {
  return (
    role === "user" &&
    readFiring(text) === null
  );
}

/**
 * The turn a row belongs to.
 *
 * The attachments row is identified as `${messageId}:attachments` by `toVisibleChatItems`, so that
 * it and the caption beneath it can be told apart while still belonging to one turn. The id of the
 * message they were sent in is the part before the last colon.
 */
function turnOf(item: TranscriptItem): string {
  if (item.kind !== "attachments") {
    return item.id;
  }
  const separator = item.id.lastIndexOf(":");
  return separator === -1 ? item.id : item.id.slice(0, separator);
}

/**
 * Which rows the scroller may lift to the top of the viewport: THE FIRST ROW OF EACH TURN THE
 * PERSON SENT, and only that one.
 *
 * The scroller reads `data-scroll-anchor` off the rows appended in one go, takes the first it finds
 * and scrolls it to the top with a peek of the answer above it — but finding MORE THAN ONE among
 * that same batch it gives up on the ambiguity and jumps to the end instead. One turn is very often
 * several rows: a caption and its screenshot, or three files pasted together, all arrive at once.
 * So "every row a person sent" is not the rule; "the first row of every turn a person sent" is, and
 * the difference between them is the whole anchoring behaviour of an ordinary captioned message.
 *
 * A Bot's prose is never an anchor — the anchor exists to hold the QUESTION at the top while the
 * answer streams in underneath it — and neither is a routine firing, which arrived wearing
 * `role: "user"` without anybody having typed anything.
 *
 * Order is `toVisibleChatItems`' order, which puts a turn's attachments before its caption, so a
 * turn carrying a file is anchored on the first file and a plain one on its text. That is the right
 * end to hold: the picture is the top of what the person sent, and anchoring on the caption
 * underneath it would scroll the picture off the top of the pane.
 */
function anchorRowIds(items: readonly TranscriptItem[]): Set<string> {
  const anchors = new Set<string>();
  const claimed = new Set<string>();
  for (const item of items) {
    const sent = item.kind === "attachments" || (item.kind === "text" && isPersonSentMessage(item.role, item.text));
    if (!sent) continue;
    const turn = turnOf(item);
    if (claimed.has(turn)) continue;
    claimed.add(turn);
    anchors.add(item.id);
  }
  return anchors;
}
const SEND_SCROLL_MS = 700;

function useSmoothSendScroll(
  viewport: React.RefObject<HTMLDivElement | null>,
  newestUserMessageId: string | null,
) {
  const reducedMotion = useReducedMotion();
  const seenRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = viewport.current;
    const previous = seenRef.current;
    seenRef.current = newestUserMessageId;

    if (
      element === null ||
      newestUserMessageId === null ||
      previous === null ||
      previous === newestUserMessageId ||
      reducedMotion
    ) {
      return;
    }

    element.style.scrollBehavior = "smooth";
    const timer = window.setTimeout(() => {
      element.style.scrollBehavior = "";
    }, SEND_SCROLL_MS);

    return () => {
      window.clearTimeout(timer);
      element.style.scrollBehavior = "";
    };
  }, [newestUserMessageId, reducedMotion, viewport]);
}

export function ChatTranscript({
  busy = false,
  commandNames = "",
  messages,
  restoring = false,
  stopped,
  lead,
  contentClassName,
  speakerNames,
}: ChatTranscriptProps) {
  const isDrawn = useDrawnTool();
  const botName = useBotNames();
  const { data: me } = useQuery(currentUserQueryOptions());
  /*
   * NOT MEMOISED, AND THAT IS DELIBERATE. `useMemo` keyed on `messages` looks obviously right and
   * silently broke the transcript: the agent hands back the SAME array and mutates it, so the
   * dependency never changed, the cached items were kept forever and a reply never appeared. A Bot
   * that answered looked like a Bot that had not.
   *
   * It was never the expensive part either. Rebuilding this list is a flatMap over messages; the
   * cost was markdown parsing and chart SVGs, and those are skipped by the memoised children below,
   * which is where the 25x came from. This runs per render and is not worth guarding.
   */
  const thread = groupToolSteps(repliesLast(toVisibleChatItems(messages)), isDrawn);
  const items = thread;
  /*
   * ONLY WHILE THERE IS NOTHING ELSE TO LOOK AT. Once a reply starts streaming, or a tool line
   * appears, the transcript is already saying the Bot is working — a second indicator under a
   * half-written answer would claim it had stopped and started again.
   *
   * So: the turn is in flight AND the last thing in the conversation is still the person's own
   * message. A tool call that is running shimmers on its own line and needs nothing from here.
   */
  const lastItem = items.at(-1);
  const waitingOnFirstToken =
    busy &&
    ((lastItem?.kind === "text" && lastItem.role === "user") ||
      /*
       * A screenshot pasted with no caption is still a person sending something, and they are
       * watching the same spot under it for the Bot's answer as they would under a typed question.
       * `toVisibleChatItems` only ever produces an `attachment` item from a user turn, so seeing one
       * last means the person went last — without this an attachment-only turn silently swallowed
       * the Thinking indicator.
       */
      lastItem?.kind === "attachments");

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const newestUserMessageId =
    items.findLast(
      (item) =>
        (item.kind === "text" &&
          isPersonSentMessage(item.role, item.text)) ||
        /*
         * Same reasoning as `waitingOnFirstToken` above: an attachment is always the person's own,
         * so a turn that is only a file still counts as them sending something. This id decides
         * nothing but whether the viewport scrolls smoothly for a beat; where it lands is
         * `anchoredTurns` below.
         */
        item.kind === "attachments",
    )?.id ?? null;
  useSmoothSendScroll(viewportRef, newestUserMessageId);
  /*
   * Where the turn being written starts: rows after it wait for the Bot's words while `busy`
   * (reply-hold.tsx), so a card made before its line enters under the finished line, not above it.
   */
  const turnStart = newestUserMessageId
    ? items.findIndex((item) => item.id === newestUserMessageId)
    : -1;
  const streamingMessageId = busy
    ? items
        .slice(turnStart + 1)
        .findLast((item) => item.kind === "text" && item.role === "assistant")?.id
    : undefined;

  /* One rule for both kinds of row — see `anchorRowIds`, which is where it is written down. */
  const anchorRows = anchorRowIds(items);
  const seenId = useSettled(seenMessageId(items), SEEN_SETTLE_MS);

  /*
   * One decider per mounted transcript, so opening a different channel starts the cascade over and
   * a message never inherits a delay from a conversation it was not in.
   */
  const delaysRef = useRef<ReturnType<typeof createFirstPaintDelays> | null>(
    null,
  );
  if (delaysRef.current === null) {
    delaysRef.current = createFirstPaintDelays();
  }
  const delays = delaysRef.current;

  /*
   * Settled AFTER the render that first had items, not on mount: history arrives asynchronously, so
   * on mount there is nothing to stagger yet and marking it settled then would mean the history
   * cascade never happens.
   */
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems) {
      delays.settle();
    }
  }, [hasItems, delays]);

  return (
    <MessageScrollerProvider
      autoScroll
      scrollPreviousItemPeek={48}
    >
      <MessageScroller>
        <MessageScrollerViewport ref={viewportRef}>
          <MessageScrollerContent
            aria-busy={busy}
            className={cn(
              "mx-auto w-full max-w-2xl px-4 py-6",
              contentClassName,
            )}
            spacerClassName="order-2"
          >
            <div className="contents [&>*]:order-1">
              {stopped ? (
                <Stopped reason={stopped} />
              ) : waitingOnFirstToken ? (
                <Thinking />
              ) : null}
            </div>
            {/*
             * Always in the DOM, empty or not, and before the rows: the scroller counts rows by
             * position (see above), so a slot that came and went would shift every row it finds.
             */}
            <div
              aria-hidden={lead ? undefined : true}
              className="order-first empty:hidden"
            >
              {lead}
            </div>
            {items.length === 0 && restoring ? (
              <RestoringTranscript />
            ) : null}
            {items.map((item, index) =>
              item.kind === "tools" ? (
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={anchorRows.has(item.id)}
                >
                  <Arriving
                    delay={delays.delayFor(item.id, index, items.length)}
                  >
                    <ToolActivity
                      group={item}
                      active={busy && index === items.length - 1}
                    />
                  </Arriving>
                </MessageScrollerItem>
              ) : item.kind === "tool" ? (
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={anchorRows.has(item.id)}
                >
                  <ReplyHoldProvider value={busy && index > turnStart}>
                    <TranscriptToolCall
                      args={item.toolCall.function.arguments}
                      delay={delays.delayFor(item.id, index, items.length)}
                      name={item.toolCall.function.name}
                      result={item.result}
                      toolCallId={item.toolCall.id}
                    />
                  </ReplyHoldProvider>
                </MessageScrollerItem>
              ) : item.kind === "text" ? (
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={anchorRows.has(item.id)}
                >
                  <TranscriptMessage
                    commandNames={commandNames}
                    delay={delays.delayFor(item.id, index, items.length)}
                    role={item.role}
                    senderName={item.senderBotId ? speakerNames?.get(item.senderBotId) ?? botName(item.senderBotId) : item.senderUserId && item.senderUserId !== me?.id ? speakerNames?.get(item.senderUserId) ?? item.senderUserId : undefined}
                    mine={!item.senderUserId || item.senderUserId === me?.id}
                    seen={item.id === seenId}
                    streaming={item.id === streamingMessageId}
                    text={item.text}
                  />
                </MessageScrollerItem>
              ) : (
                <MessageScrollerItem
                  key={item.id}
                  messageId={item.id}
                  scrollAnchor={anchorRows.has(item.id)}
                >
                  <TranscriptAttachments
                    attachments={item.attachments}
                    delay={delays.delayFor(item.id, index, items.length)}
                  />
                </MessageScrollerItem>
              ),
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        {/* A floating disc, like the shell's own controls. */}
        <MessageScrollerButton className="size-11 rounded-full border-0 bg-duet-card text-duet-ink shadow-duet-float hover:bg-duet-card hover:text-duet-ink data-[direction=end]:bottom-[calc(var(--duet-dock,0px)+16px)]" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
