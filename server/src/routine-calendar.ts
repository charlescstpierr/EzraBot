/**
 * The civil calendar of a routine: one wall-clock time, on chosen weekdays, in a named IANA zone, until an end date.
 * Pure: every instant comes from the caller. A wall time that does not exist that day is skipped; a wall time that
 * happens twice is taken at its first instant only. Days are walked on the calendar, never by adding 24 hours.
 */

export type Zone = string & { readonly __brand: 'Zone' };
/** `YYYY-MM-DD`, a real Gregorian date. */
export type LocalDate = string & { readonly __brand: 'LocalDate' };
/** `HH:MM`, 00:00 to 23:59. */
export type ClockTime = string & { readonly __brand: 'ClockTime' };
/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Schedule = {
  zone: Zone;
  time: ClockTime;
  weekdays: readonly Weekday[];
  /** The last local date that can have a slot. */
  endsOn: LocalDate;
};

/** One scheduled date and what its wall time resolves to in its zone. */
export type Slot =
  | { kind: 'due'; date: LocalDate; at: number; offsetMinutes: number; repeated: boolean }
  | { kind: 'missing'; date: LocalDate };

const HOUR = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, found);
  }
  return found;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wall(at: number, zone: Zone): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(at)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return { year: parts.year ?? NaN, month: parts.month ?? NaN, day: parts.day ?? NaN, hour: parts.hour ?? NaN, minute: parts.minute ?? NaN, second: parts.second ?? NaN };
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const dateOf = (year: number, month: number, day: number) => `${pad(year, 4)}-${pad(month)}-${pad(day)}` as LocalDate;

/** A named zone the formatter knows, or UTC. Fixed offsets, `Etc/GMT±N` included, are refused: they ignore civil time. */
export function parseZone(raw: string): Zone | null {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return resolved === 'UTC' || Intl.supportedValuesOf('timeZone').includes(resolved) ? resolved as Zone : null;
}

export function parseLocalDate(raw: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? dateOf(year, month, day) : null;
}

export function parseClockTime(raw: string): ClockTime | null {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw as ClockTime : null;
}

const civil = (date: LocalDate) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

export function addDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(civil(date) + days * 24 * HOUR);
  return dateOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function weekdayOf(date: LocalDate): Weekday {
  const day = new Date(civil(date)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function localDateAt(at: number, zone: Zone): LocalDate {
  const { year, month, day } = wall(at, zone);
  return dateOf(year, month, day);
}

/** Minutes east of UTC at this instant. */
export function offsetAt(at: number, zone: Zone): number {
  const seen = wall(at, zone);
  return Math.round((Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - (at - (at % 1000))) / 60_000);
}

/**
 * Every instant whose wall clock in `zone` reads `date` at `time`, earliest first: none in a gap, two in a fold.
 * Offsets stay within ±15 hours and no offset lasts under an hour, so hourly samples over ±15 hours meet every
 * offset an answer can have.
 */
const wallInstant = (date: LocalDate, time: ClockTime) => civil(date) + Number(time.slice(0, 2)) * HOUR + Number(time.slice(3, 5)) * 60_000;

/**
 * Every instant whose wall clock in `zone` reads `date` at `time`, earliest first: none in a gap, two in a fold.
 * Offsets stay within ±15 hours and no offset lasts under an hour, so hourly samples over ±15 hours meet every
 * offset an answer can have.
 */
export function instantsOf(date: LocalDate, time: ClockTime, zone: Zone): number[] {
  const guess = wallInstant(date, time);
  const offsets = new Set<number>();
  for (let hour = -15; hour <= 15; hour++) offsets.add(offsetAt(guess + hour * HOUR, zone));
  const reads = (at: number) => {
    const seen = wall(at, zone);
    return dateOf(seen.year, seen.month, seen.day) === date && pad(seen.hour) + ':' + pad(seen.minute) === time && seen.second === 0;
  };
  return [...new Set([...offsets].map(offset => guess - offset * 60_000))].filter(reads).sort((a, b) => a - b);
}

export function slotOn(date: LocalDate, schedule: Pick<Schedule, 'zone' | 'time'>): Slot {
  const [first, ...later] = instantsOf(date, schedule.time, schedule.zone);
  if (first === undefined) return { kind: 'missing', date };
  return { kind: 'due', date, at: first, offsetMinutes: offsetAt(first, schedule.zone), repeated: later.length > 0 };
}

function* slotsAfter(schedule: Schedule, after: number): Generator<Slot> {
  for (let date = localDateAt(after, schedule.zone); date <= schedule.endsOn; date = addDays(date, 1)) {
    if (!schedule.weekdays.includes(weekdayOf(date))) continue;
    const slot = slotOn(date, schedule);
    // A missing wall time is placed where the offset in force before the jump would have put it.
    const at = slot.kind === 'due' ? slot.at : wallInstant(date, schedule.time) - offsetAt(wallInstant(date, schedule.time) - 15 * HOUR, schedule.zone) * 60_000;
    if (at > after) yield slot;
  }
}

/** The scheduled dates after `after`, in order, up to `count`. A missing wall time is listed, never moved to another hour. */
export function upcoming(schedule: Schedule, after: number, count: number): Slot[] {
  const found: Slot[] = [];
  for (const slot of slotsAfter(schedule, after)) {
    if (found.length === count) break;
    found.push(slot);
  }
  return found;
}

/** The first slot that exists after `after`, or null when the schedule has none left. */
export function nextSlot(schedule: Schedule, after: number): Extract<Slot, { kind: 'due' }> | null {
  for (const slot of slotsAfter(schedule, after)) if (slot.kind === 'due') return slot;
  return null;
}
