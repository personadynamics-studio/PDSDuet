const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date in the Date object's local time zone, as YYYY-MM-DD. */
export function localDateOf(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${String(at.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}

/** Midnight UTC for a real YYYY-MM-DD calendar date, or null. */
export function utcMidnightOf(value: string): number | null {
  const parts = LOCAL_DATE.exec(value);
  if (!parts) return null;
  const [year, month, day] = [parts[1], parts[2], parts[3]].map(Number) as [number, number, number];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? at : null;
}
