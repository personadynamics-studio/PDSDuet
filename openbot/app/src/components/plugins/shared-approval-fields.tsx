import {
  describeApproval,
  type SharedUseApproval,
} from "@/lib/plugins/shared-use";

export function sharedSectionSentence(
  effect: "read" | "write",
  shared: boolean,
): string | null {
  if (!shared) return null;
  return effect === "write"
    ? "所有可使用這個機械人的成員，都可透過共用帳戶執行這項操作。"
    : "所有可使用這個機械人的成員，都可讀取這個帳戶有權讀取的內容。";
}

/**
 * Who may use a shared account through one Bot: the audience the Bot has now, offered as the
 * default, and only ever NARROWED here. Named people are offered only when the Bot is published to
 * named people, because that list is what a `people` approval records.
 */
export function SharedApprovalFields({
  value,
  onChange,
}: {
  value: SharedUseApproval;
  onChange: (next: SharedUseApproval) => void;
}) {
  const named = value.audience === "people" || value.members.length > 0;
  const options: { audience: SharedUseApproval["audience"]; label: string }[] =
    [
      { audience: "owner", label: "僅限擁有者" },
      ...(named
        ? [
            {
              audience: "people" as const,
              label: `指定對象：${describeApproval({ ...value, audience: "people", outsideInput: false })}`,
            },
          ]
        : []),
      { audience: "team", label: "所有成員" },
    ];
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">
        誰可透過這個機械人使用共用帳戶
      </legend>
      {options.map((option) => (
        <label className="flex items-center gap-2" key={option.audience}>
          <input
            checked={value.audience === option.audience}
            name="shared-audience"
            onChange={() =>
              onChange({
                ...value,
                audience: option.audience,
                members: option.audience === "people" ? value.members : [],
              })
            }
            type="radio"
          />
          {option.label}
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input
          checked={value.outsideInput}
          onChange={(event) =>
            onChange({ ...value, outsideInput: event.target.checked })
          }
          type="checkbox"
        />
        允許外部訊息（電郵、Slack、webhook）使用
      </label>
    </fieldset>
  );
}
