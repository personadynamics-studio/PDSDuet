import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SkillFields } from "@/components/skills/skill-fields";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const createSkill = useMutation(saveSkillMutationOptions(queryClient));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">新增技能</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          以 <code>/</code> 啟動的指示。只有你能看見，並適用於你擁有的機械人。
        </p>
      </header>

      <SkillFields
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onSubmit={async (values) => {
          await createSkill.mutateAsync(values);
          // Panel closed rather than swapped for a detail view: there is nothing more to say about a
          // skill than the form just said, and the new row is already behind it in the list.
          await navigate({ search: {}, to: "/capabilities/skills" });
        }}
        submitLabel="儲存技能"
      />
    </div>
  );
}
