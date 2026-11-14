import {
  IconChevronRight,
  IconCopy,
  IconEyeOff,
  IconPin,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and — for whoever may manage it — delete it.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const error = setPinned.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <PageSection title="管理">
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPin />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>已置頂</ItemTitle>
            <ItemDescription>
              {assigned
                ? "管理員已將它指派給你，會固定顯示在機械人清單頂部。"
                : agent.pinned
                  ? "已置於機械人清單頂部，只影響你的清單。"
                  : "將它置於機械人清單頂部，只影響你的清單。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="已置頂"
              checked={agent.pinned || assigned}
              disabled={assigned || setPinned.isPending}
              onCheckedChange={(pinned) =>
                setPinned.mutate({ agentId: agent.id, pinned })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconEyeOff />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>已隱藏</ItemTitle>
            <ItemDescription>
              {assigned
                ? "管理員已將它指派給你，無法隱藏。"
                : agent.hidden
                  ? "已移至機械人清單的「已隱藏」部分，只影響你的清單。"
                  : "從機械人清單隱藏，只影響你的清單。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label="已隱藏"
              checked={agent.hidden}
              disabled={assigned || setHidden.isPending}
              onCheckedChange={async (hidden) => {
                await setHidden.mutateAsync({ agentId: agent.id, hidden });
                if (hidden) onHidden();
              }}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={
            <button
              disabled={duplicate.isPending}
              onClick={async () =>
                onDuplicated((await duplicate.mutateAsync(agent.id)).id)
              }
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconCopy />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>建立副本</ItemTitle>
            <ItemDescription>
              建立你自己的副本，對話及金鑰不會複製。
            </ItemDescription>
          </ItemContent>
        </Item>
          <>
            <Separator />
            <Item
              render={
                <button onClick={() => setDeleteOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>刪除</ItemTitle>
                <ItemDescription>
                  對所有人刪除，操作無法復原。
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </>
      </PageRows>
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除 {agent.name}？</DialogTitle>
            <DialogDescription>
              會對所有人刪除，操作無法復原。
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setDeleteOpen(false)}
              size="sm"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(agent.id);
                onDeleted();
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "刪除中…" : "刪除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
