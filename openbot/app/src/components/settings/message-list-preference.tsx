import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

export function MessageListPreference() {
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <PageRows>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>訊息清單重點</ItemTitle>
          <ItemDescription>
            選擇側欄要突出顯示的內容。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger aria-label="訊息清單重點">
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
                    ? "機械人名稱"
                    : "對話標題"
                  : "載入中…"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">對話標題</SelectItem>
              <SelectItem value="agent">機械人名稱</SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            重試
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          儲存中…
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label="訊息清單預覽"
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name="通用助理"
              title="下星期計劃"
              lastMessageAt="2 小時前"
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
