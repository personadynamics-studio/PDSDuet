import { useMutation } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { clearTeamBotConsentsMutationOptions } from "@/lib/team-bots";

/**
 * A Bot someone shared with you uses its owner's connected apps unless you let it use yours on the
 * card it shows you. This forgets every one of those answers, so each such Bot asks again.
 *
 * On Approvals rather than Connections because it is an answer to "may this Bot use my apps",
 * which is the question every other row on Approvals answers, not a connection of its own.
 */
export function TeamBotConsents() {
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  return (
    <PageSection
      description="共用機械人會使用擁有者的應用程式。只有你在對話中同意後，它才會使用你的應用程式。"
      title="共用機械人"
    >
      {clear.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {clear.error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>你已授權共用機械人使用的應用程式</ItemTitle>
            <ItemDescription>
              {clear.isSuccess
                ? "已重設。每個共用機械人都會重新詢問。"
                : "清除所有授權回覆，讓每個共用機械人重新詢問。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              size="sm"
              variant="outline"
            >
              重設
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
