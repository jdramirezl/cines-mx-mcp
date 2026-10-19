/** Timezone helpers without external dependencies. */

/** Offset in minutes of `tz` at the given instant (e.g. -360 for UTC-6). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Interpret a zone-less local timestamp ("2026-10-21T20:50:00") in `tz`; return ISO with offset. */
export function localToIso(naive: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(naive);
  if (!m) throw new Error(`bad local datetime: ${naive}`);
  const [, y, mo, d, h, mi, s = "00"] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s);
  let off = tzOffsetMinutes(tz, new Date(guess));
  off = tzOffsetMinutes(tz, new Date(guess - off * 60_000));
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${fmtOffset(off)}`;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Local HH:MM of an instant in `tz`. */
export function localTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
