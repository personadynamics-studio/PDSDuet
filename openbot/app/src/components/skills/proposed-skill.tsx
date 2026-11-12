import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Badge, GalleryFrame } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import type { SkillFormValues } from "@/lib/skills/form";
import {
  checkProposal,
  type ProposedSkill,
  skillCardAnswer,
  wasSaved,
} from "@/lib/skills/proposal";

/**
 * The skill a Bot has written, put in front of the person before it is saved.
 *
 * WHY THERE IS A CARD AT ALL, when a skill adds no capability and anybody signed in may write one.
 * Two reasons, and neither is about permission. The first is authorship: this is a named thing that
 * will appear in everybody's `/` menu with somebody's name on it, and a person should read the
 * instruction their Bot drafted before it starts running on their behalf. The second is the slug:
 * saving is how an edit is spelled, so an unattended save can replace a skill somebody is using.
 *
 * So the whole tool is this card. There is no handler behind it — the run suspends here, and nothing
 * is written until a button is pressed.
 */

export type ProposedSkillCardProps = {
  /** Partial while the model is still streaming the arguments. */
  args: Partial<ProposedSkill>;
  /**
   * What this slug already names here, when it names something.
   *
   * Drives the wording rather than the outcome — "Replace" instead of "建立", and whose it is.
   * The server decides whether the replacement is allowed and says so in its own words.
   */
  replaces?: { title: string; ownership: string };
  /** Answering resumes the Bot. Absent while streaming, and once this card has been answered. */
  respond?: (result: unknown) => Promise<void>;
  /** The recorded answer, once there is one. Completed cards show it instead of controls. */
  result?: string;
  save: (values: SkillFormValues) => Promise<void>;
};

export function ProposedSkillCard({
  args,
  replaces,
  respond,
  result,
  save,
}: ProposedSkillCardProps) {
  const [sending, setSending] = useState<"save" | "decline" | null>(null);
  /**
   * A refusal from the server, kept on the card rather than answered with.
   *
   * The run stays suspended, because the two things worth doing next both need it to be — pressing
   * Create again after connecting the connector the refusal named, or declining. Answering the tool
   * with the error would end the turn and leave the person re-typing their request.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  if (result !== undefined) {
    return (
      <GalleryFrame
        action={<Badge tone="neutral">完成</Badge>}
        title={titleFor(args.slug, replaces)}
      >
        <p className="text-sm">{result}</p>
        {args.slug && wasSaved(result) ? (
          <PutItOnABot slug={args.slug} />
        ) : null}
      </GalleryFrame>
    );
  }

  if (!respond) {
    return (
      <GalleryFrame title={titleFor(args.slug, replaces)}>
        <p className="text-sm text-muted-foreground">正在編寫技能…</p>
      </GalleryFrame>
    );
  }

  const checked = checkProposal(args);
  if (!checked.ok) {
    return <Unwritable problems={checked.problems} respond={respond} />;
  }
  const values = checked.values;

  const create = async () => {
    setSending("save");
    setRefusal(null);
    try {
      await save(values);
    } catch (cause) {
      // Left on the card with the buttons still live. See `refusal` above.
      setSending(null);
      setRefusal(
        cause instanceof Error ? cause.message : "無法儲存技能。",
      );
      return;
    }
    await answer(respond, skillCardAnswer.saved(values.slug));
  };

  const decline = async () => {
    setSending("decline");
    await answer(respond, skillCardAnswer.declined());
  };

  return (
    <GalleryFrame
      action={<Badge tone="caution">等待你處理</Badge>}
      caption={
        replaces
          ? `這會取代「${replaces.title}」（${replaces.ownership === "yours" ? "由你擁有" : replaces.ownership === "the deployment's" ? "由系統提供" : "由其他人擁有"}）。`
          : "經你同意後才會儲存。"
      }
      title={titleFor(values.slug, replaces)}
    >
      <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="truncate text-muted-foreground">指令</dt>
        <dd className="min-w-0 break-words font-mono">/{values.slug}</dd>
        <dt className="truncate text-muted-foreground">標題</dt>
        <dd className="min-w-0 break-words">{values.title}</dd>
        {values.summary ? (
          <>
            <dt className="truncate text-muted-foreground">簡介</dt>
            <dd className="min-w-0 break-words">{values.summary}</dd>
          </>
        ) : null}
        {values.tools.length > 0 ? (
          <>
            <dt className="truncate text-muted-foreground">所需工具</dt>
            <dd className="min-w-0 break-words font-mono text-xs">
              {values.tools.join(", ")}
            </dd>
          </>
        ) : null}
      </dl>

      <p className="mt-3 text-muted-foreground text-xs">指示</p>
      {/* Scrolled rather than clamped: this is the part worth reading before agreeing to it. */}
      <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        {values.instructions}
      </p>

      {values.tools.length > 0 ? (
        <p className="mt-2 text-muted-foreground text-xs">
          列出工具名稱不會授予權限，機械人只能使用原已獲授權的工具。
        </p>
      ) : null}

      {refusal ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {refusal}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={Boolean(sending)}
          onClick={() => void create()}
          size="sm"
        >
          {sending === "save"
            ? "儲存中…"
            : replaces
              ? "取代"
              : "建立"}
        </Button>
        <Button
          disabled={Boolean(sending)}
          onClick={() => void decline()}
          size="sm"
          variant="outline"
        >
          {sending === "decline" ? "…" : "不要儲存"}
        </Button>
      </div>
    </GalleryFrame>
  );
}

function titleFor(
  slug: string | undefined,
  replaces: { title: string } | undefined,
): string {
  const name = slug ? `/${slug}` : "a new skill";
  return replaces ? `取代 ${name}` : `建立 ${name}`;
}

/** Where the remaining step happens. A skill on no Bot is inert, and saying so beats implying done. */
function PutItOnABot({ slug }: { slug: string }) {
  return (
    <Link
      className="mt-2 inline-block text-sm underline underline-offset-4"
      search={{ edit: slug }}
      to="/capabilities/skills"
    >
      為機械人啟用
    </Link>
  );
}

/**
 * A proposal that cannot be saved as written.
 *
 * Answered rather than shown as a question, because there is nothing for the person to decide: the
 * fields are wrong in a way the model can fix, and the problems name their field so it can. The card
 * still appears, so the transcript does not have a silent gap where a skill was nearly written.
 */
function Unwritable({
  problems,
  respond,
}: {
  problems: string[];
  respond: (result: unknown) => Promise<void>;
}) {
  /**
   * Answered once, guarded by a ref rather than by the dependency list.
   *
   * `problems` is rebuilt from the arguments on every render and the grant queries behind this card
   * poll, so a value-equal array arrives as a new identity every few seconds. Left to the deps, this
   * would answer the same tool call again on each of them.
   */
  const answered = useRef(false);
  useEffect(() => {
    if (answered.current) return;
    answered.current = true;
    void answer(respond, skillCardAnswer.unwritable(problems));
  }, [problems, respond]);

  return (
    <GalleryFrame
      action={<Badge tone="negative">未有儲存</Badge>}
      title="技能"
    >
      <p className="text-sm">
        機械人的草稿未符合技能要求，未有儲存。機械人已收到需要修正的項目。
      </p>
    </GalleryFrame>
  );
}

/** Resuming a run that is no longer there is not a failure worth reporting: nothing is left to answer. */
function answer(
  respond: (result: unknown) => Promise<void>,
  sentence: string,
): Promise<void> {
  return respond(sentence).catch(() => {});
}
