import {
  IconChevronRight,
  IconEye,
  IconId,
  IconPlugConnected,
  IconShieldCheck,
  IconTag,
  IconTextCaption,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import type { ZodType } from "zod";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
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
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import { queryClient } from "@/query-client";
import { appConfig } from "@/lib/generated/application-config";

type TextField = "name" | "title" | "roleDescription";

const TEXT_FIELDS: {
  field: TextField;
  label: string;
  icon: typeof IconId;
  multiline?: boolean;
}[] = [
  { field: "name", label: "名稱", icon: IconId },
  { field: "title", label: "職稱", icon: IconTag },
  {
    field: "roleDescription",
    // Not "角色": beside "職稱" it read as a second job title, when it is the standing
    // instruction the Bot carries into every channel. The create dialog says the same.
    label: "工作內容",
    icon: IconTextCaption,
    multiline: true,
  },
];

/** Who a Bot is and where it runs. Editable by whoever may manage it; read-only for everyone else. */
export function SetupSections({ agent }: { agent: AgentProfile }) {
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState<TextField | null>(null);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  const open = TEXT_FIELDS.find((entry) => entry.field === editing);

  return (
    <>
      <PageSection title="身分資料">
        <PageRows>
          {TEXT_FIELDS.map(({ field, label, icon: Icon }, index) => (
            <Fragment key={field}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={<button onClick={() => setEditing(field)} type="button" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <ItemDescription>{agent[field]}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          <Separator />
          <VisibilityRow
            agent={agent}
            onSave={(visibility) => save({ visibility })}
          />
          {agent.systemOwned ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>系統擁有</ItemTitle>
                  <ItemDescription>
                    由 {appConfig.brand.productName} 提供，並不屬於個別成員。
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <ConnectionSection agent={agent} />
      {open ? (
        <EditTextDialog
          label={open.label}
          multiline={open.multiline ?? false}
          onClose={() => setEditing(null)}
          onSave={(value) => save({ [open.field]: value })}
          schema={agentFormSchema.shape[open.field]}
          value={agent[open.field]}
        />
      ) : null}
    </>
  );
}

/** Two named choices that write on pick: no draft worth holding, so no dialog. */
function VisibilityRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (visibility: AgentProfile["visibility"]) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconEye />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>可見範圍</ItemTitle>
        <ItemDescription>
          {error ??
            (agent.visibility === "private"
              ? "目前標示為私人。"
              : `${appConfig.brand.productName} 的所有成員都能找到並使用它。`)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
          <Select
            disabled={saving}
            // The label map, so the closed trigger says "私人" rather than the raw value.
            items={{ private: "私人", public: "公開" }}
            onValueChange={async (next) => {
              if (next === agent.visibility) return;
              setError(null);
              setSaving(true);
              try {
                await onSave(next as AgentProfile["visibility"]);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "無法儲存，請重試。",
                );
              } finally {
                setSaving(false);
              }
            }}
            value={agent.visibility}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">私人</SelectItem>
              <SelectItem value="public">公開</SelectItem>
            </SelectContent>
          </Select>
      </ItemActions>
    </Item>
  );
}

/**
 * One text field in a dialog, validated against the same limits the server enforces. Enter saves a
 * single-line field — but not the Enter that confirms a composed character, which would save the
 * value before the person finished typing it.
 */
function EditTextDialog({
  label,
  value,
  multiline,
  schema,
  onSave,
  onClose,
}: {
  label: string;
  value: string;
  multiline: boolean;
  schema: ZodType<string>;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "請修正這個欄位後重試。",
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "無法儲存，請重試。",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-2">
          {multiline ? (
            <Textarea
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              value={draft}
            />
          ) : (
            <Input
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              value={draft}
            />
          )}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={saving}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()} size="sm">
            {saving ? "儲存中…" : "儲存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where it runs. A built-in Bot runs on the deployment's own Bot, whose process already holds the
 * deployment's tool credential, so there is nothing to show but that sentence.
 */
function ConnectionSection({ agent }: { agent: AgentProfile }) {
  const builtIn = !agent.endpoint || agent.builtIn;
  return (
    <PageSection title="連接">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{builtIn ? "內置" : "代理程式網址"}</ItemTitle>
            <ItemDescription
              className={
                builtIn ? undefined : "line-clamp-none break-all font-mono"
              }
            >
              {builtIn
                ? `直接在 ${appConfig.brand.productName} 內運作，毋須另行連接。`
                : agent.endpoint}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
      {!builtIn ? (
        <CallbackTokenPanel
          agentId={agent.id}
          hasToken={agent.hasCallbackToken}
        />
      ) : null}
    </PageSection>
  );
}
