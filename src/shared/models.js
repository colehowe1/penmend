// The Claude models Settings offers, with list prices in US$ per million tokens (prompts up to
// 100K tokens; a grammar check is far below that). Cache writes are 1.25x input on 5-minute caching.
// `fallbacks`: whether the model takes the API's server-side refusal fallback (Haiku 5.5 doesn't).

export const MODELS = [
  {
    id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', blurb: 'Fastest and cheapest. Plenty for spelling and grammar.',
    input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125, fallbacks: false,
  },
  {
    id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', blurb: 'Smarter suggestions and rewrites, a little slower.',
    input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.5, fallbacks: true,
  },
  {
    id: 'claude-opus-5-5', name: 'Claude Opus 5.5', blurb: 'Most capable; slowest and priciest.',
    input: 4, output: 20, cacheRead: 0.20, cacheWrite: 5, fallbacks: true,
  },
];

export function modelInfo(id) {
  return MODELS.find((m) => m.id === id) || null;
}

// Any other model (a fallback hop, say) is priced like the dearest Opus, never as free.
const UNKNOWN = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

/** Dollars for one usage record { input, output, cacheRead, cacheWrite } (token counts). */
export function costOf(id, u) {
  const m = modelInfo(id) || UNKNOWN;
  if (!u) return 0;
  return ((u.input || 0) * m.input + (u.output || 0) * m.output
    + (u.cacheRead || 0) * m.cacheRead + (u.cacheWrite || 0) * m.cacheWrite) / 1e6;
}

// A typical workday for the estimate in Settings: 60 Claude checks (a cached ~800-token instruction
// block, ~250 tokens of your text, ~200 tokens back) and 10 rewrites (~700 in, ~300 out), 22 days.
const CHECK = { input: 250, output: 200, cacheRead: 800, cacheWrite: 0 };
const REWRITE = { input: 700, output: 300, cacheRead: 0, cacheWrite: 0 };
export const ESTIMATE_BASIS = 'about 60 checks and 10 rewrites a workday';

/** checkModel/rewriteModel: a model id, or '' for "not used". */
export function monthlyEstimate(checkModel, rewriteModel) {
  const checks = checkModel ? 60 * costOf(checkModel, CHECK) : 0;
  const rewrites = rewriteModel ? 10 * costOf(rewriteModel, REWRITE) : 0;
  return 22 * (checks + rewrites);
}

export function formatDollars(x) {
  if (x === 0) return '$0.00';
  if (x < 0.01) return '<$0.01';
  return `$${x.toFixed(2)}`;
}
