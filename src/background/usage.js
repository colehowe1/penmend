// The usage meter: tokens per model for the current month, in chrome.storage.local (extension pages
// only). Costs are computed from these counts with the prices in shared/models.js.

import { costOf } from '../shared/models.js';

let queue = Promise.resolve();
const pad = (n) => String(n).padStart(2, '0');

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function dayKey(d = new Date()) {
  return `${monthKey(d)}-${pad(d.getDate())}`;
}

export function hourKey(d = new Date()) {
  return `${dayKey(d)}T${pad(d.getHours())}`;
}

/** The attempts a response was billed for: each fallback hop has its own model and tokens. */
function attempts(model, usage) {
  const its = Array.isArray(usage?.iterations) ? usage.iterations.filter((i) => i && /message$/.test(i.type)) : [];
  const list = its.length ? its : [usage || {}];
  return list.map((u) => ({
    model: u.model || model,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  }));
}

/** Adds one response's usage. `kind`: 'check' | 'rewrite' | 'style' | 'test'. */
export function recordUsage(model, usage, kind) {
  queue = queue.then(async () => {
    const { usage: stored } = await chrome.storage.local.get('usage');
    const month = monthKey();
    const u = stored && stored.month === month ? stored : { month, models: {}, kinds: {} };
    if (u.day !== dayKey()) Object.assign(u, { day: dayKey(), daySpend: 0 });
    if (u.hour !== hourKey()) Object.assign(u, { hour: hourKey(), hourRequests: 0 });
    u.hourRequests += 1;
    for (const a of attempts(model, usage)) {
      u.daySpend += costOf(a.model, a);
      const m = (u.models[a.model] ||= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      m.requests += 1;
      m.input += a.input;
      m.output += a.output;
      m.cacheRead += a.cacheRead;
      m.cacheWrite += a.cacheWrite;
    }
    u.kinds[kind] = (u.kinds[kind] || 0) + 1;
    await chrome.storage.local.set({ usage: u });
  }).catch(() => {});
  return queue;
}
