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

  // Regression R33 (found by testing as a real user): "dinner for 4 on 3 Dec" asked which date, and "the 3rd of Jan"
  // booked the next 3rd (Dec 3). Checked before "Dec 3" so "3 Dec 7 pm" isn't read as Dec 7; "for 4 Dec 3" and
  // "party of 6 Dec 3" are headcounts, not days.
  const dm = t.match(/(?<![\d$.:/]|for |of )\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(dm[2].slice(0, 3)) / 3;
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(month + 1).padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
    const date = candidate < today ? `${year + 1}${candidate.slice(4)}` : candidate;
    // "31 Sept" is not a day: ask rather than book a date that doesn't exist.
    if (ymd(new Date(`${date}T12:00:00Z`)) !== date) return { date: null, ambiguous: true, reason: "no such day" };
    return { date, ambiguous: false, reason: "day and month" };
  }
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(md[1]) / 3;
    let year = Number(today.slice(0, 4));
    let candidate = `${year}-${String(month + 1).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    if (candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return { date: candidate, ambiguous: false, reason: "month and day" };
  }
  // Regression R14 (found by testing as a real user): "dinner for 5 on 12/3" and "dinner for 12 on Christmas Eve" asked which date.
  // US month/day (an office in New York), and the two holiday evenings people book dinners for.
  const us = t.match(/(?<![\d$])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/);
  if (us && Number(us[1]) >= 1 && Number(us[1]) <= 12 && Number(us[2]) >= 1 && Number(us[2]) <= 31) {
    const year = us[3] ? (us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3])) : Number(today.slice(0, 4));
    let candidate = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    if (!us[3] && candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return { date: candidate, ambiguous: false, reason: "month/day" };
  }
  const holiday = /christmas eve/.test(t) ? "12-24" : /new year'?s eve/.test(t) ? "12-31" : null;
  if (holiday) {
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${holiday}` < today ? `${year + 1}-${holiday}` : `${year}-${holiday}`;
    return { date: candidate, ambiguous: false, reason: "holiday" };
  }
  if (/\btonight\b|\btoday\b/.test(t)) return { date: today, ambiguous: false, reason: "today" };
  // Regression R18 (found by testing as a real user): "dinner for 4 tmrw at 7" and "lunch for 6 on Wed" asked which date.
  if (/\b(tomorrow|tmrw|tmr|tomorow|2morrow)\b/.test(t)) return { date: addDays(today, 1), ambiguous: false, reason: "tomorrow" };

  // Regression R18: "team dinner for 9 on Thursday the 19th" booked this Thursday (the 12th). The day of month wins;
  // if the weekday said doesn't match it, flag it so the proposal confirms the date.
  const nth = t.match(/\b(?:on the|(sun|mon|tues|wednes|thurs|fri|satur)day,?(?: the)?)\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth && Number(nth[2]) >= 1 && Number(nth[2]) <= 31) {
    const candidate = nextDayOfMonth(Number(nth[2]), today);
    const ambiguous = !!nth[1] && DAYS[weekday(candidate)].slice(0, 3) !== nth[1].slice(0, 3);
    return { date: candidate, ambiguous, reason: ambiguous ? "weekday and day of month disagree" : "day of month" };
  }

  const m = t.match(/\b(this|next|coming)?\s*(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday|s|rs|r)?\b/);
  if (!m) return { date: null, ambiguous: true, reason: "no date given" };
  const target = DAYS.findIndex((d) => d.startsWith(m[2]));
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

/** The next date on or after today that falls on this day of the month (skipping months too short for it). */
function nextDayOfMonth(day: number, today: string): string {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
  for (let k = 0; ; k++) {
    const d = new Date(Date.UTC(y, m + k, day, 12));
    if (d.getUTCDate() === day && ymd(d) >= today) return ymd(d);
  }
}

/** Event start as an ISO instant, treating the office as UTC-5 (EST); precise enough for holds and lead time. */
export function startsAt(date: string, time: string): string {
  return `${date}T${time}:00-05:00`;
}

export function hoursBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
}
