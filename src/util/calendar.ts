export const FOLLOW_UP_TIMEZONE = 'Europe/Sofia';

/** Calendar values deliberately do not depend on the server/browser timezone. */
export function sofiaDateTime(value = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: FOLLOW_UP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function sofiaDate(value = new Date()): string { return sofiaDateTime(value).slice(0, 10); }

export function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Convert an explicitly entered local send time, including Sofia DST. */
export function sofiaInstant(local: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Choose a send date and time');
  const target = Date.parse(`${local}:00Z`);
  let instant = target;
  for (let pass = 0; pass < 3; pass += 1) {
    const displayed = Date.parse(`${sofiaDateTime(new Date(instant))}:00Z`);
    instant += target - displayed;
  }
  if (!Number.isFinite(instant) || sofiaDateTime(new Date(instant)) !== local) {
    throw new Error('This Sofia date/time does not exist; choose another time');
  }
  return new Date(instant).toISOString();
}
