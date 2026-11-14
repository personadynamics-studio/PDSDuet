const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat("zh-HK", {
  numeric: "auto",
});

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
export function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  // An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, which
  // answers "NaN weeks ago" or throws depending on ICU. Return the input unchanged instead.
  if (!Number.isFinite(time)) return iso;
  const elapsed = Date.now() - time;
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}

/**
 * How long ago, in the few words a group heading has room for: "just now", "1 min ago", "3 hr ago",
 * "yesterday", "4 days ago", "2 wk ago". An unreadable time, or one in the future, is "just now".
 */
export function agoShort(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  const elapsed = Number.isFinite(time) ? now - time : 0;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return `${Math.floor(days / 7)} 星期前`;
}

const timeFormat = new Intl.DateTimeFormat("zh-HK", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("zh-HK", { month: "short", day: "numeric" });

/** A saved page's local timestamp. */
export function clockTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toDateString() === now.toDateString() ? timeFormat.format(at) : dayFormat.format(at);
}
