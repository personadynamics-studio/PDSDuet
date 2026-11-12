import { IconRoute } from "@tabler/icons-react";
import { appConfig } from "@/lib/generated/application-config";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { deliveryQueryOptions } from "@/lib/delivery";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "進度",
    description: "你離開期間完成工作的回覆及結果。",
  },
  decision: {
    title: "待決定事項",
    description: "機械人採取行動前所需的審批。",
  },
  question: {
    title: "問題",
    description: "機械人提出並等待你回覆的問題。",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "推送通知" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "短訊" },
];

/**
 * Which channels each kind of update may use, for every one of the person's Bots at once. How much
 * a given Bot sends is that Bot's own Notifications setting, on its page.
 */
export function UpdateRoutingSection() {
  const routing = useQuery(updateRoutingQueryOptions());
  const reach = useQuery(deliveryQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  /*
   * A channel this deployment has not set up can carry nothing, so its switch is off and disabled
   * whatever the stored preference says, rather than on beside a channel that delivers nothing. The
   * preference itself is left alone: an administrator who configures Slack later finds it as the
   * person last set it. When the deployment's channels could not be read, the preference is shown
   * as it is rather than every channel claimed unavailable.
   */
  const configured = (transport: UpdateTransport) =>
    reach.data ? reach.data.available[transport] : true;
  return (
    <PageSection
      description={`設定你離開時各類通知的接收方式。${appConfig.brand.productName} 網頁版會顯示所有更新。`}
      title="通知接收方式"
    >
      {routing.isPending || reach.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          無法載入通知接收方式，請重新整理頁面。
        </p>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                    <ItemDescription>
                      {KIND_LABEL[kind].description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="flex-wrap justify-start gap-x-6 gap-y-3 pl-8">
                    {TRANSPORTS.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={`透過 ${transport.label} 接收${KIND_LABEL[kind].title}`}
                          checked={
                            configured(transport.id) && allowed(transport.id)
                          }
                          disabled={save.isPending || !configured(transport.id)}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        <span className="flex flex-col leading-tight whitespace-nowrap">
                          {transport.label}
                          {configured(transport.id) ? null : (
                            <span className="text-muted-foreground text-xs">
                              尚未設定
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}
