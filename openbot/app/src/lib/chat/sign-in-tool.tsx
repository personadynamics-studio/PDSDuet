import { IconLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { SignInForm } from "@/components/passwords/sign-in-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pendingSignInRequestsQueryOptions } from "@/lib/passwords/queries";
const POLL_MS = 1500;
type Outcome = {
  ok?: boolean;
  signedIn?: boolean;
  site?: string;
  requestId?: string;
  result?: string;
  reason?: string;
};

export function readSignInOutcome(result: string | undefined): Outcome {
  if (!result) return {};
  try {
    const value = JSON.parse(result) as unknown;
    return value && typeof value === "object" ? (value as Outcome) : {};
  } catch {
    return {};
  }
}

export function SignInCard({
  site,
  toolCallId,
  running,
  outcome,
}: {
  site: string;
  toolCallId?: string;
  running: boolean;
  outcome: Outcome;
}) {
  const [open, setOpen] = useState(false);
  // While the call waits there is no result to carry the id, so the open request that this call
  // asked for is looked up instead, polled until the handler has opened it.
  const lookup = running && !outcome.requestId && Boolean(toolCallId);
  const { data: requests } = useQuery({
    ...pendingSignInRequestsQueryOptions(),
    enabled: lookup,
    refetchInterval: (query) =>
      query.state.data?.some((request) => request.toolCallId === toolCallId)
        ? false
        : POLL_MS,
  });
  const requestId =
    outcome.requestId ??
    (lookup
      ? requests?.find((request) => request.toolCallId === toolCallId)?.id
      : undefined);
  return (
    <div className="flex flex-col gap-2">
      <ToolLine
        label={
          running
            ? "Waiting for you to sign in"
            : outcome.signedIn
              ? "Signed in"
              : "Sign-in did not complete"
        }
        detail={site}
        running={running}
        failed={!running && !outcome.signedIn}
      >
        {!running && (outcome.result ?? outcome.reason) ? (
          <p className="text-muted-foreground text-sm">
            {outcome.result ?? outcome.reason}
          </p>
        ) : undefined}
      </ToolLine>
      {/* Outside the line, so the one thing the person must do is not behind a disclosure. */}
      {running && requestId ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            <IconLock />
            Open private sign-in
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sign in to {site}</DialogTitle>
                <DialogDescription>
                  Goes to your Bot's browser, not into this conversation.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="mt-4 overflow-y-auto">
                <SignInForm requestId={requestId} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </div>
  );
}
