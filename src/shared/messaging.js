// Messages between the page scripts and the service worker. Every request is { type, ...fields }
// and every reply is { ok: true, ...result } or { ok: false, error }.

export const MSG = {
  STATUS: 'status', // {} -> { hasApiKey } (whether this computer has a Claude key; the key never leaves)
  WARM: 'warm', // {} -> {}: start loading the local checker now (and stay up while you write)
  LINT: 'lint', // { text } -> { lints }
  AI_CHECK: 'ai-check', // { paragraphs: [{ id, text, inProgress }] } -> { results: [{ id, edits } | { id, error }] }
  TEST_KEY: 'test-key', // { apiKey, model } -> {}
  LEARN_STYLE: 'learn-style', // { samples } -> { notes }
  OPEN_OPTIONS: 'open-options', // { section? }
  OPEN_PAD: 'open-pad',
  RULE_INFO: 'rule-info', // {} -> { descriptions }
  COMMAND: 'command', // service worker -> page: { command }
  REWRITE_SELECTION: 'rewrite-selection', // service worker -> page (context menu): { mode }
};

export const PORT_REWRITE = 'pm-rewrite';

/** True while this script still belongs to a live extension (false after an update or reload). */
export function extensionAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

export class ExtensionGoneError extends Error {
  constructor() {
    super('Penmend was updated or reloaded. Reload this page to use it here again.');
    this.name = 'ExtensionGoneError';
  }
}

/** Sends a request to the service worker and returns the result, or throws with its message. */
export async function request(type, fields = {}) {
  if (!extensionAlive()) throw new ExtensionGoneError();
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type, ...fields });
  } catch (e) {
    if (!extensionAlive() || /context invalidated/i.test(String(e?.message))) throw new ExtensionGoneError();
    throw e;
  }
  if (!reply) throw new Error('No reply from Penmend');
  if (!reply.ok) throw Object.assign(new Error(reply.error || 'Something went wrong'), { code: reply.code });
  return reply;
}
