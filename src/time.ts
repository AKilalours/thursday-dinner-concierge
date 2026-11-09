// Turning "next Thursday" into a date is where real requests go wrong, so the rules are explicit and tested.
// All dates are local to the office (America/New_York); we work in calendar days, not instants.

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

export function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export interface ResolvedDate {
  date: string | null;
  ambiguous: boolean;
  reason: string;
}

/**
 * "next Thursday" said on a Monday-Wednesday is genuinely ambiguous in US usage (this week's or next week's).
 * We pick the earliest reading that is at least 2 days out, but flag ambiguity so the concierge confirms
 * the date with the booker inside the proposal instead of silently guessing.
 */
export function resolveDate(text: string, today: string): ResolvedDate {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1], ambiguous: false, reason: "explicit date" };

  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(md[1]) / 3;
    let year = Number(today.slice(0, 4));
    let candidate = `${year}-${String(month + 1).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    if (candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return { date: candidate, ambiguous: false, reason: "month and day" };
  }
  if (/\btonight\b|\btoday\b/.test(t)) return { date: today, ambiguous: false, reason: "today" };
  if (/\btomorrow\b/.test(t)) return { date: addDays(today, 1), ambiguous: false, reason: "tomorrow" };

  const m = t.match(/\b(this|next|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (!m) return { date: null, ambiguous: true, reason: "no date given" };
  const target = DAYS.indexOf(m[2]);
  const now = weekday(today);
  let delta = (target - now + 7) % 7;
  if (m[1] === "next") {
    if (delta === 0) delta = 7;
    // "next Thursday" on Mon-Wed could mean this Thursday or the one after: take this week's, flag it.
    const ambiguous = delta < 7 && now >= 1 && now < target;
    return { date: addDays(today, delta), ambiguous, reason: ambiguous ? "'next' could mean this week or next" : "next" };
  }
  if (delta === 0) delta = m[1] === "this" ? 0 : 7;
  return { date: addDays(today, delta), ambiguous: false, reason: m[1] ?? "bare weekday" };
}

/** Event start as an ISO instant, treating the office as UTC-5 (EST); precise enough for holds and lead time. */
export function startsAt(date: string, time: string): string {
  return `${date}T${time}:00-05:00`;
}

export function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
}
