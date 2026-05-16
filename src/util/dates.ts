/** Convert a Stripe `created` epoch (seconds) to a UTC ISO date `YYYY-MM-DD`. */
export function epochToUtcDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) {
    throw new RangeError(`Invalid epoch: ${String(epochSeconds)}`);
  }
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Add `months` to an ISO date string. Clamps to the last day of the target
 * month when the input day doesn't exist there (e.g. Jan 31 + 1 month = Feb 28).
 */
export function addMonths(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`Invalid ISO date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const totalMonths = month - 1 + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1; // 1-12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear)}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}
