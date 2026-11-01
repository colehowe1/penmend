// Claude, through the official SDK, with the user's own API key (Settings). Every call reads the key
// from chrome.storage.local, which only the service worker and extension pages can see.
//
// Sonnet 5.5 and Opus 5.5 requests opt into the API's server-side refusal fallback ("default"
// routing): if a safety classifier declines a request (benign security wording can trip it), the
// API retries it on a fallback model inside the same call. Haiku 5.5 has no fallback; a refusal
// there just shows as "Claude declined to check this".
import Anthropic from '@anthropic-ai/sdk';
import { modelInfo } from '../shared/models.js';
import { locateEdits, locateRewrites } from '../shared/locate.js';
import { withoutAvoidedMarks } from '../shared/text.js';
import {
  CHECK_INSTRUCTIONS, CHECK_SCHEMA, authorContext, checkUserMessage,
  REWRITE_INSTRUCTIONS, REWRITE_MODES, rewriteUserMessage, STYLE_INSTRUCTIONS,
} from './prompts.js';
import { recordUsage } from './usage.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Only the end-to-end test build (npm run e2e) may point the client at a local mock of the API.
const TEST_BUILD = typeof __PM_TEST__ !== 'undefined' && __PM_TEST__;

export class FriendlyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function client(timeout, apiKeyOverride) {
  const { apiKey, apiBase } = await chrome.storage.local.get(['apiKey', 'apiBase']);
  const key = apiKeyOverride || apiKey;
  if (!key) throw new FriendlyError('Add your Claude API key in Penmend settings first.', 'no-key');
  return new Anthropic({
    apiKey: key,
    baseURL: (TEST_BUILD && apiBase) || undefined,
    dangerouslyAllowBrowser: true, // a service worker counts as a browser; the key never reaches a web page
    maxRetries: 1,
    timeout,
  });
}

/** A model this extension offers (settings sync, so they're checked before use). */
function knownModel(model, what) {
  if (!modelInfo(model)) throw new FriendlyError(`Choose a Claude model for ${what} in Penmend settings.`, 'no-model');
  return model;
}

/** The Messages API surface and request fields for a model: beta + fallbacks where supported. */
function route(anthropic, model, params) {
  if (modelInfo(model)?.fallbacks) {
    return { api: anthropic.beta.messages, params: { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' } };
  }
  return { api: anthropic.messages, params };
}

/** A sentence for the user from any SDK or network error. */
export function explainError(e) {
  if (e instanceof FriendlyError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new FriendlyError('Cancelled.', 'aborted');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new FriendlyError('Claude took too long to answer. Try again.', 'timeout');
  if (e instanceof Anthropic.APIConnectionError) return new FriendlyError("Couldn't reach Claude. Check your internet connection.", 'offline');
  if (e instanceof Anthropic.APIError) {
    const type = e.type || e.error?.error?.type || '';
    const detail = e.error?.error?.message || '';
    if (type === 'authentication_error' || e.status === 401) return new FriendlyError('Claude rejected the API key. Check it in Penmend settings.', 'auth');
    if (type === 'permission_error' || e.status === 403) return new FriendlyError(`This API key isn't allowed to use that model.${detail ? ` (${detail})` : ''}`, 'permission');
    if (type === 'not_found_error' || e.status === 404) return new FriendlyError('That Claude model isn\'t available to this API key. Pick another in settings.', 'model');
    if (type === 'billing_error' || e.status === 402 || /credit balance/i.test(detail)) return new FriendlyError('Your Anthropic account is out of credit. Add credit at console.anthropic.com.', 'billing');
    if (type === 'rate_limit_error' || e.status === 429) return new FriendlyError('Claude is rate-limiting this key. Try again in a minute.', 'rate');
    if (type === 'overloaded_error' || e.status === 529 || e.status >= 500) return new FriendlyError('Claude is busy right now. Try again shortly.', 'busy');
    if (/max_tokens|too long|prompt is too long/i.test(detail)) return new FriendlyError('This text is too long for Claude in one go.', 'max-tokens');
    return new FriendlyError(detail || `Claude returned an error (${e.status ?? type}).`, 'api');
  }
  if (e instanceof Anthropic.AnthropicError && /structured output/i.test(e.message)) {
    return new FriendlyError('Claude sent an answer Penmend could not read. Try again.', 'parse');
  }
  return new FriendlyError(e?.message || 'Something went wrong talking to Claude.', 'unknown');
}

/**
 * Checks paragraphs ([{ id, text, inProgress }]) and returns [{ id, edits: [{ start, end, original,
 * replacement, type, why }] }], offsets within each paragraph. Sentence rewrites (type 'rewrite')
 * come after the fixes and may overlap them.
 */
export async function check(paragraphs, settings) {
  const model = knownModel(settings.checkModel, 'checks');
  const anthropic = await client(30_000);
  const { api, params } = route(anthropic, model, {
    model,
    max_tokens: 4096,
    system: [
      { type: 'text', text: CHECK_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: authorContext(settings) },
    ],
    messages: [{ role: 'user', content: checkUserMessage(paragraphs) }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CHECK_SCHEMA } },
  });
  let response;
  try {
    // create(), not parse(): a cut-off answer is still billed, so it's counted before it's read.
    response = await api.create(params);
  } catch (e) {
    throw explainError(e);
  }
  recordUsage(response.model || model, response.usage, 'check');
  if (response.stop_reason === 'refusal') throw new FriendlyError('Claude declined to check this text.', 'refusal');
  let parsed = null;
  try {
    parsed = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  } catch { /* handled below */ }
  if (!parsed || !Array.isArray(parsed.edits)) {
    if (response.stop_reason === 'max_tokens') throw new FriendlyError('Claude had too much to say about this text at once.', 'max-tokens');
    throw new FriendlyError('Claude sent an answer Penmend could not read.', 'parse');
  }
  return paragraphs.map((p) => {
    const mine = parsed.edits.filter((e) => String(e.p) === String(p.id));
    const rewrites = settings.rewriteSuggestions ? mine.filter((e) => e.type === 'rewrite') : [];
    return {
      id: p.id,
      edits: [...locateEdits(p.text, mine.filter((e) => e.type !== 'rewrite')), ...locateRewrites(p.text, rewrites)],
    };
  });
}

/**
 * Streams a rewrite. onText(delta) gets each piece as it arrives; resolves to the full text.
 * signal: an AbortSignal that cancels the request.
 */
export async function rewrite({ text, mode, instruction, before, after }, settings, onText, signal) {
  const model = knownModel(settings.rewriteModel, 'rewrites');
  const how = mode === 'custom' ? String(instruction || '').trim() : REWRITE_MODES[mode]?.instruction;
  if (!how) throw new FriendlyError('Tell Claude how to rewrite it.', 'no-instruction');
  const anthropic = await client(120_000);
  const { api, params } = route(anthropic, model, {
    model,
    max_tokens: 16_000,
    system: [
      { type: 'text', text: REWRITE_INSTRUCTIONS },
      { type: 'text', text: authorContext(settings, { forRewrite: true }) },
    ],
    messages: [{ role: 'user', content: rewriteUserMessage({ text, instruction: how, before, after }) }],
    output_config: { effort: 'medium' },
  });
  const stream = api.stream(params, { signal });
  stream.on('text', (delta) => onText(delta));
  let final;
  try {
    final = await stream.finalMessage();
  } catch (e) {
    throw explainError(e);
  }
  recordUsage(final.model || model, final.usage, 'rewrite');
  if (final.stop_reason === 'refusal') throw new FriendlyError('Claude declined to rewrite this text.', 'refusal');
  const out = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (final.stop_reason === 'max_tokens') throw new FriendlyError('The rewrite was too long and got cut off.', 'max-tokens');
  // Belt and braces for the punctuation the author doesn't use (the prompt already asks).
  return withoutAvoidedMarks(out.trim(), text, settings);
}

/** Summarizes writing samples into style notes. */
export async function learnStyle(samples, settings) {
  const model = knownModel(settings.rewriteModel || settings.checkModel, 'rewrites');
  const anthropic = await client(90_000);
  const { api, params } = route(anthropic, model, {
    model,
    max_tokens: 4096,
    system: STYLE_INSTRUCTIONS,
    messages: [{ role: 'user', content: `<samples>\n${samples}\n</samples>` }],
    output_config: { effort: 'medium' },
  });
  let response;
  try {
    response = await api.create(params);
  } catch (e) {
    throw explainError(e);
  }
  recordUsage(response.model || model, response.usage, 'style');
  if (response.stop_reason === 'refusal') throw new FriendlyError('Claude declined to read these samples.', 'refusal');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

/** Confirms a key works with a minimal request. */
export async function testKey(apiKey, model) {
  knownModel(model, 'checks');
  const anthropic = await client(30_000, apiKey);
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      output_config: { effort: 'low' },
    });
    recordUsage(response.model || model, response.usage, 'test');
  } catch (e) {
    throw explainError(e);
  }
}
