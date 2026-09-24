/** "9000.5" → "₦9,000.50". Works on the decimal string; never goes through a float. */
export function naira(amount: string): string {
  const [whole = '0', fraction = ''] = amount.replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount.startsWith('-') ? '−' : ''}₦${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

const toCents = (value: string) => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
};

/** Sum decimal strings exactly. */
export function addAmounts(values: readonly string[]): string {
  const total = values.reduce((sum, value) => sum + toCents(value), 0n);
  return `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
}

/** Compare decimal strings exactly: negative, zero or positive. */
export function compareAmounts(a: string, b: string): number {
  const d = toCents(a) - toCents(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

/** Share of `limit` used, 0..1, from decimal strings. */
export function ratio(used: string, limit: string): number {
  const total = toCents(limit);
  if (total === 0n) return 0;
  return Math.min(1, Number((toCents(used) * 10_000n) / total) / 10_000);
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Lagos' });

export const longDate = (iso: string) => dateFormat.format(new Date(iso));
export const dayMonth = (iso: string) => shortDate.format(new Date(iso));
export const clock = (iso: string) => `${timeFormat.format(new Date(iso))}.${String(new Date(iso).getMilliseconds()).padStart(3, '0')}`;

export function relative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === 'second') return rtf.format(Math.round(seconds / size), unit);
  }
  return '';
}

/** Window in seconds → "10 minutes". */
export function span(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute');
  return plural(seconds, 'second');
}

const plural = (n: number, unit: string) => `${n === 1 ? 'one' : n} ${unit}${n === 1 ? '' : 's'}`;

const ROMAN: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
export function roman(n: number): string {
  let out = '';
  for (const [value, glyph] of ROMAN) while (n >= value) { out += glyph; n -= value; }
  return out;
}

export const maskPhone = (e164: string) => `${e164.slice(0, 7)}····${e164.slice(-3)}`;
