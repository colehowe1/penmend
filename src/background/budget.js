// Spending limits, kept here in the service worker (where the key is) so no page can get around
// them: a daily dollar limit (Settings, default $2) and a cap on requests per hour. The counts come
// from the usage meter (usage.js), which every Claude response updates.
import { FriendlyError } from './claude.js';
import { dayKey, hourKey } from './usage.js';

export const DEFAULT_DAILY_DOLLARS = 2;
const HOURLY_REQUESTS = 240;

/** Throws a FriendlyError (code 'budget') if a new Claude request would go over a limit. */
export async function guard() {
  const { usage, budget } = await chrome.storage.local.get(['usage', 'budget']);
  const daily = Number(budget?.dailyDollars ?? DEFAULT_DAILY_DOLLARS);
  const spent = usage?.day === dayKey() ? usage.daySpend || 0 : 0;
  if (Number.isFinite(daily) && spent >= daily) {
    throw new FriendlyError(`Today's Claude limit ($${daily.toFixed(2)}) is used up. Raise it in Penmend settings, or wait until tomorrow.`, 'budget');
  }
  const requests = usage?.hour === hourKey() ? usage.hourRequests || 0 : 0;
  if (requests >= HOURLY_REQUESTS) {
    throw new FriendlyError('Claude is paused for the rest of this hour after a lot of requests.', 'budget');
  }
}
