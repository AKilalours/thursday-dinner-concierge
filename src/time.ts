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

// Regression R34 (found by testing as a real user): "dinner for 4 on Sept 31", "Feb 30" and "2/30" booked dates
// that don't exist (2027-09-31). A day the calendar doesn't have is asked about, never booked.
const NO_SUCH_DAY: ResolvedDate = { date: null, ambiguous: true, reason: "no such day" };

function realDay(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && ymd(d) === date;
}

/**
 * "next Thursday" said on a Monday-Wednesday is genuinely ambiguous in US usage (this week's or next week's).
 * We pick the earliest reading that is at least 2 days out, but flag ambiguity so the concierge confirms
 * the date with the booker inside the proposal instead of silently guessing.
 */
export function resolveDate(text: string, today: string): ResolvedDate {
  const t = text.toLowerCase();
  const offset = relativeDate(t, today);
  if (offset) return offset;
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return realDay(iso[1]) ? { date: iso[1], ambiguous: false, reason: "explicit date" } : NO_SUCH_DAY;

  // Regression R33 (found by testing as a real user): "dinner for 4 on 3 Dec" asked which date, and "the 3rd of Jan"
  // booked the next 3rd (Dec 3). Checked before "Dec 3" so "3 Dec 7 pm" isn't read as Dec 7; "for 4 Dec 3" and
  // "party of 6 Dec 3" are headcounts, not days.
  const dm = t.match(/(?<![\d$.:/]|for |of )\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(dm[2].slice(0, 3)) / 3;
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(month + 1).padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
    const date = candidate < today ? `${year + 1}${candidate.slice(4)}` : candidate;
    if (!realDay(date)) return NO_SUCH_DAY;
    return { date, ambiguous: false, reason: "day and month" };
  }
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = "janfebmaraprmayjunjulaugsepoctnovdec".indexOf(md[1]) / 3;
    let year = Number(today.slice(0, 4));
    let candidate = `${year}-${String(month + 1).padStart(2, "0")}-${md[2].padStart(2, "0")}`;
    if (candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return realDay(candidate) ? { date: candidate, ambiguous: false, reason: "month and day" } : NO_SUCH_DAY;
  }
  // Regression R14 (found by testing as a real user): "dinner for 5 on 12/3" and "dinner for 12 on Christmas Eve" asked which date.
  // US month/day (an office in New York), and the two holiday evenings people book dinners for.
  const us = t.match(/(?<![\d$])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/);
  if (us && Number(us[1]) >= 1 && Number(us[1]) <= 12 && Number(us[2]) >= 1 && Number(us[2]) <= 31) {
    const year = us[3] ? (us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3])) : Number(today.slice(0, 4));
    let candidate = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    if (!us[3] && candidate < today) candidate = `${year + 1}${candidate.slice(4)}`;
    return realDay(candidate) ? { date: candidate, ambiguous: false, reason: "month/day" } : NO_SUCH_DAY;
  }
  const holiday = /christmas eve/.test(t) ? "12-24" : /new year'?s eve/.test(t) ? "12-31" : null;
  if (holiday) {
    const year = Number(today.slice(0, 4));
    const candidate = `${year}-${holiday}` < today ? `${year + 1}-${holiday}` : `${year}-${holiday}`;
    return { date: candidate, ambiguous: false, reason: "holiday" };
  }
  if (/\btonight\b|\btoday\b/.test(t)) return { date: today, ambiguous: false, reason: "today" };
  // Regression R18 (found by testing as a real user): "dinner for 4 tmrw at 7" and "lunch for 6 on Wed" asked which date.
  // Regression R35 (found by testing as a real user): "dinner for 6 the day after tomorrow" booked tomorrow.
  if (/\bday after (tomorrow|tmrw|tmr|tomorow|2morrow)\b/.test(t)) return { date: addDays(today, 2), ambiguous: false, reason: "day after tomorrow" };
  if (/\b(tomorrow|tmrw|tmr|tomorow|2morrow)\b/.test(t)) return { date: addDays(today, 1), ambiguous: false, reason: "tomorrow" };

  // Regression R18: "team dinner for 9 on Thursday the 19th" booked this Thursday (the 12th). The day of month wins;
  // if the weekday said doesn't match it, flag it so the proposal confirms the date.
  const nth = t.match(/\b(?:on the|(sun|mon|tues|wednes|thurs|fri|satur)day,?(?: the)?)\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth && Number(nth[2]) >= 1 && Number(nth[2]) <= 31) {
    const candidate = nextDayOfMonth(Number(nth[2]), today);
    const ambiguous = !!nth[1] && DAYS[weekday(candidate)].slice(0, 3) !== nth[1].slice(0, 3);
    return { date: candidate, ambiguous, reason: ambiguous ? "weekday and day of month disagree" : "day of month" };
  }

  const nextWeek = weekdayOfNextWeek(t, today);
  if (nextWeek) return nextWeek;
  const m = t.match(new RegExp(`\\b(this|next|coming)?\\s*${WEEKDAY}`));
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

const WEEKDAY = "(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday|s|rs|r)?\\b";

// Regression R44 (found by testing as a real user): "dinner for 3 next week Thursday" said on a Wednesday booked
// tomorrow, because "next week" was skipped and the bare weekday won. Weeks start on Monday (as the calendar does),
// so "Thursday next week" is the Thursday after the coming Monday, never this week's, and needs no confirming.
function weekdayOfNextWeek(t: string, today: string): ResolvedDate | null {
  const m = t.match(new RegExp(`\\bnext week,?\\s+(?:on\\s+)?${WEEKDAY}`)) ?? t.match(new RegExp(`\\b${WEEKDAY},?\\s+(?:of\\s+)?next week\\b`));
  if (!m) return null;
  const toMonday = (8 - weekday(today)) % 7 || 7;
  const fromMonday = (DAYS.findIndex((d) => d.startsWith(m[1])) + 6) % 7;
  return { date: addDays(today, toMonday + fromMonday), ambiguous: false, reason: "weekday of next week" };
}

const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = `(${Object.keys(COUNTS).join("|")}|\\d{1,2})`;

// Regression R36 (found by testing as a real user): "dinner for 4 a week from today" was read as today and escalated,
// and "lunch for 3 in 3 days" asked which date. An offset counts from its anchor ("today", "Friday", "Dec 3"),
// and inherits the anchor's ambiguity so a shaky "next Thursday" still gets confirmed.
function relativeDate(t: string, today: string): ResolvedDate | null {
  const days = (n: string, unit: string) => (COUNTS[n] ?? Number(n)) * (unit === "week" ? 7 : 1);
  const from = t.match(new RegExp(`\\b${COUNT}\\s+(day|week)s?\\s+from\\s+(.+)$`));
  if (from) {
    const anchor = /^(today|tonight|now)\b/.test(from[3]) ? { date: today, ambiguous: false } : resolveDate(from[3], today);
    if (!anchor.date) return { date: null, ambiguous: true, reason: "offset from an unclear date" };
    return { date: addDays(anchor.date, days(from[1], from[2])), ambiguous: anchor.ambiguous, reason: "offset from a date" };
  }
  const inN = t.match(new RegExp(`\\bin\\s+${COUNT}\\s+(day|week)s?\\b`));
  return inN ? { date: addDays(today, days(inN[1], inN[2])), ambiguous: false, reason: "in N days" } : null;
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
