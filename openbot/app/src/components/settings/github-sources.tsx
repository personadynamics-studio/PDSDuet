import { IconBrandGithub, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  createGithubBindingMutationOptions,
  githubBindingsQueryOptions,
  removeGithubBindingMutationOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

/**
 * The repositories whose GitHub events can start this person's responsibilities. One per person, not
 * per Bot: an event reaches every responsibility subscribed to it, whichever Bot holds it.
 *
 * Each repository is a row carrying the webhook address to paste into GitHub. Adding one is two
 * inputs, so it is a dialog opened from the section's action.
 */
export function GithubSources() {
  const bindings = useQuery(githubBindingsQueryOptions());
  const remove = useMutation(removeGithubBindingMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const error = bindings.error ?? remove.error;
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          新增儲存庫
        </Button>
      }
      description="先在這裏新增儲存庫，再於 GitHub 使用下方網址及相同密鑰新增 webhook，即可讓 issues.opened 等事件啟動職責。"
      title="儲存庫"
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {bindings.isPending || !bindings.data ? null : bindings.data.length ===
        0 ? (
        <PageEmpty>
          尚未加入儲存庫，請按「新增儲存庫」。
        </PageEmpty>
      ) : (
        <PageRows>
          {bindings.data.map((binding, index) => (
            <Fragment key={binding.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBrandGithub />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{binding.repository}</ItemTitle>
                  <ItemDescription className="line-clamp-none break-all font-mono text-xs">
                    {window.location.origin}/api/events/github/{binding.id}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(binding.id)}
                    size="sm"
                    variant="outline"
                  >
                    中斷連接
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? <AddRepositoryDialog onClose={() => setAdding(false)} /> : null}
    </PageSection>
  );
}

/**
 * A repository and the webhook secret GitHub will sign its events with.
 */
function AddRepositoryDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation(createGithubBindingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增儲存庫</DialogTitle>
          <DialogDescription>
            在 GitHub 新增 webhook 時，請使用相同密鑰。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                { repository, secret },
                {
                  onSuccess: () => {
                    setSecret("");
                    setRepository("");
                    onClose();
                  },
                },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-repository`}>
                  儲存庫
                </FieldLabel>
                <Input
                  autoFocus
                  id={`${formId}-repository`}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/repository"
                  required
                  value={repository}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-secret`}>
                  Webhook 密鑰
                </FieldLabel>
                <Input
                  autoComplete="new-password"
                  id={`${formId}-secret`}
                  onChange={(event) => setSecret(event.target.value)}
                  required
                  type="password"
                  value={secret}
                />
              </Field>
            </FieldGroup>
          </form>
          {create.error ? (
            <p className="text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
          <Button
            disabled={create.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            連接事件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
