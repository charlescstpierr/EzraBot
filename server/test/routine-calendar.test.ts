import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  instantsOf, localDateAt, nextSlot, parseClockTime, parseLocalDate, parseZone, slotOn, upcoming,
  type ClockTime, type LocalDate, type Schedule, type Weekday, type Zone,
} from '../src/routine-calendar.js';

const zone = (raw: string): Zone => {
  const parsed = parseZone(raw);
  assert(parsed, `zone ${raw} accepted`);
  return parsed;
};
const date = (raw: string): LocalDate => {
  const parsed = parseLocalDate(raw);
  assert(parsed, `date ${raw} accepted`);
  return parsed;
};
const time = (raw: string): ClockTime => {
  const parsed = parseClockTime(raw);
  assert(parsed, `time ${raw} accepted`);
  return parsed;
};
const iso = (instants: readonly number[]) => instants.map(at => new Date(at).toISOString());
const at = (raw: string) => Date.parse(raw);
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const schedule = (raw: { zone: string; time: string; endsOn: string; weekdays?: Weekday[] }): Schedule =>
  ({ zone: zone(raw.zone), time: time(raw.time), endsOn: date(raw.endsOn), weekdays: raw.weekdays ?? ALL_DAYS });

test('a named zone or UTC is accepted under its formatter identity; fixed offsets and unknown names are refused', () => {
  assert.equal(parseZone('america/toronto'), 'America/Toronto');
  assert.equal(parseZone('US/Eastern'), 'America/New_York');
  assert.equal(parseZone('UTC'), 'UTC');
  assert.equal(parseZone('Etc/UTC'), 'UTC');
  for (const refused of ['Etc/GMT+5', 'Etc/GMT-14', '+05:00', '-0330', 'Nope/Zone', '', 'America/Toronto ']) {
    assert.equal(parseZone(refused), null, `${JSON.stringify(refused)} refused`);
  }
});

test('dates and times are real calendar values', () => {
  assert.equal(parseLocalDate('2026-02-30'), null);
  assert.equal(parseLocalDate('2026-2-3'), null);
  assert.equal(parseLocalDate('2028-02-29'), '2028-02-29');
  assert.equal(parseClockTime('24:00'), null);
  assert.equal(parseClockTime('7:30'), null);
  assert.equal(parseClockTime('23:59'), '23:59');
});

test('Toronto in March: 02:30 does not exist and is skipped, never moved to 03:30', () => {
  const toronto = zone('America/Toronto');
  assert.deepEqual(instantsOf(date('2026-03-08'), time('02:30'), toronto), []);
  assert.deepEqual(slotOn(date('2026-03-08'), { zone: toronto, time: time('02:30') }), { kind: 'missing', date: '2026-03-08' });
  assert.deepEqual(iso(instantsOf(date('2026-03-08'), time('01:30'), toronto)), ['2026-03-08T06:30:00.000Z']);
  assert.deepEqual(iso(instantsOf(date('2026-03-08'), time('03:30'), toronto)), ['2026-03-08T07:30:00.000Z']);

});

test('Toronto in March: the day with the gap is listed as skipped in the preview and the next slot is the 9th', () => {
  const daily = schedule({ zone: 'America/Toronto', time: '02:30', endsOn: '2026-03-31' });
  const preview = upcoming(daily, at('2026-03-07T08:00:00Z'), 3);
  assert.deepEqual(preview.map(slot => [slot.date, slot.kind]), [['2026-03-08', 'missing'], ['2026-03-09', 'due'], ['2026-03-10', 'due']]);
  const next = nextSlot(daily, at('2026-03-07T08:00:00Z'));
  assert.equal(next?.date, '2026-03-09');
  assert.equal(next && new Date(next.at).toISOString(), '2026-03-09T06:30:00.000Z');
});

test('Toronto in November: 01:30 happens twice and only its first instant is a slot', () => {
  const toronto = zone('America/Toronto');
  assert.deepEqual(iso(instantsOf(date('2026-11-01'), time('01:30'), toronto)), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  const daily = schedule({ zone: 'America/Toronto', time: '01:30', endsOn: '2026-11-30' });
  const first = nextSlot(daily, at('2026-11-01T05:00:00Z'));
  assert.deepEqual(first && { date: first.date, at: new Date(first.at).toISOString(), offset: first.offsetMinutes, repeated: first.repeated },
    { date: '2026-11-01', at: '2026-11-01T05:30:00.000Z', offset: -240, repeated: true });
  const after = nextSlot(daily, at('2026-11-01T05:31:00Z'));
  assert.equal(after?.date, '2026-11-02', 'the second 01:30 is never a slot');
  assert.equal(after && new Date(after.at).toISOString(), '2026-11-02T06:30:00.000Z');
});

test('a daily 08:30 follows the civil clock across the March change: 23 real hours apart, not 24', () => {
  const daily = schedule({ zone: 'America/Toronto', time: '08:30', endsOn: '2026-12-31' });
  const saturday = nextSlot(daily, at('2026-03-07T00:00:00Z'));
  assert(saturday);
  assert.equal(new Date(saturday.at).toISOString(), '2026-03-07T13:30:00.000Z');
  const sunday = nextSlot(daily, saturday.at);
  assert(sunday);
  assert.equal(new Date(sunday.at).toISOString(), '2026-03-08T12:30:00.000Z');
  assert.equal(sunday.at - saturday.at, 23 * 3_600_000);
});

test('Lord Howe moves by half an hour: its gap and its fold are found', () => {
  const lordHowe = zone('Australia/Lord_Howe');
  assert.deepEqual(instantsOf(date('2026-10-04'), time('02:15'), lordHowe), []);
  assert.deepEqual(iso(instantsOf(date('2026-10-04'), time('02:30'), lordHowe)), ['2026-10-03T15:30:00.000Z']);
  assert.deepEqual(iso(instantsOf(date('2026-04-05'), time('01:45'), lordHowe)), ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z']);
  const slot = slotOn(date('2026-04-05'), { zone: lordHowe, time: time('01:45') });
  assert.deepEqual(slot.kind === 'due' && [slot.offsetMinutes, slot.repeated], [660, true]);
});

test('Apia skipped a whole civil day: every time of 2011-12-30 is missing', () => {
  const apia = zone('Pacific/Apia');
  for (const clock of ['00:00', '12:00', '23:59']) assert.deepEqual(instantsOf(date('2011-12-30'), time(clock), apia), [], clock);
  const daily = schedule({ zone: 'Pacific/Apia', time: '12:00', endsOn: '2012-01-05' });
  const next = nextSlot(daily, at('2011-12-29T22:00:00Z'));
  assert.equal(next?.date, '2011-12-31');
  assert.equal(next && new Date(next.at).toISOString(), '2011-12-30T22:00:00.000Z');
});

test('extreme offsets and UTC resolve to the right instant and local date', () => {
  assert.deepEqual(iso(instantsOf(date('2026-11-14'), time('00:30'), zone('Pacific/Kiritimati'))), ['2026-11-13T10:30:00.000Z']);
  assert.deepEqual(iso(instantsOf(date('2026-11-14'), time('23:30'), zone('Pacific/Pago_Pago'))), ['2026-11-15T10:30:00.000Z']);
  assert.deepEqual(iso(instantsOf(date('2026-11-14'), time('08:30'), zone('UTC'))), ['2026-11-14T08:30:00.000Z']);
  assert.equal(localDateAt(at('2026-11-13T10:30:00Z'), zone('Pacific/Kiritimati')), '2026-11-14');
  assert.equal(localDateAt(at('2026-11-15T10:30:00Z'), zone('Pacific/Pago_Pago')), '2026-11-14');
});

test('a clock set back across midnight never gives the previous date a second slot', () => {
  const daily = schedule({ zone: 'America/Santiago', time: '23:30', endsOn: '2026-04-30' });
  const first = nextSlot(daily, at('2026-04-05T00:00:00Z'));
  assert.deepEqual(first && [first.date, new Date(first.at).toISOString()], ['2026-04-04', '2026-04-05T02:30:00.000Z']);
  const next = nextSlot(daily, at('2026-04-05T02:31:00Z'));
  assert.deepEqual(next && [next.date, new Date(next.at).toISOString()], ['2026-04-05', '2026-04-06T03:30:00.000Z']);
  assert.deepEqual(instantsOf(date('2026-09-06'), time('00:30'), zone('America/Santiago')), [], 'midnight gap');
});

test('weekdays, end date and a long absence: the next slot is the first future one, nothing before it', () => {
  const weekdays = schedule({ zone: 'America/Toronto', time: '08:30', endsOn: '2026-12-31', weekdays: [1, 2, 3, 4, 5] });
  const afterFriday = nextSlot(weekdays, at('2026-11-13T13:31:00Z'));
  assert.equal(afterFriday?.date, '2026-11-16', 'Friday then Monday');
  const tenDaysLater = nextSlot(weekdays, at('2026-11-26T15:00:00Z'));
  assert.equal(tenDaysLater?.date, '2026-11-27');
  const ending = schedule({ zone: 'UTC', time: '08:30', endsOn: '2026-11-14' });
  assert.equal(nextSlot(ending, at('2026-11-14T08:30:00Z')), null, 'no slot after the end date');
  assert.equal(upcoming(ending, at('2026-11-13T09:00:00Z'), 5).length, 1);
});
