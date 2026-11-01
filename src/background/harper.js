// The local checker: Harper (harper.js, Apache-2.0) compiled to WebAssembly, running in the service
// worker. It starts in ~0.5 s and uses ~300 MB while loaded; Chrome stops the service worker after
// ~30 s without messages, which frees that memory, and the next check loads it again.
import { LocalLinter, Dialect } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { withExtraLints, EXTRA_DESCRIPTIONS } from './extra-rules.js';

let linterPromise = null;
const applied = { dialect: null, words: null, rules: null };

function getLinter() {
  if (!linterPromise) {
    linterPromise = (async () => {
      const linter = new LocalLinter({ binary: slimBinary, dialect: Dialect.American });
      await linter.setup();
      return linter;
    })().catch((e) => {
      linterPromise = null; // let the next request try again
      throw e;
    });
  }
  return linterPromise;
}

/** Brings Harper in line with the settings: dialect, personal dictionary, switched-off rules. */
async function sync(linter, settings) {
  const dialect = Dialect[settings.dialect] ?? Dialect.American;
  if (applied.dialect !== dialect) {
    await linter.setDialect(dialect);
    applied.dialect = dialect;
    applied.words = null; // a new dialect rebuilds the linter: apply the rest again
    applied.rules = null;
  }
  const words = JSON.stringify(settings.dictionary);
  if (applied.words !== words) {
    await linter.clearWords();
    if (settings.dictionary.length) await linter.importWords(settings.dictionary);
    applied.words = words;
  }
  const rules = JSON.stringify(settings.disabledRules);
  if (applied.rules !== rules) {
    const config = await linter.getDefaultLintConfig();
    for (const rule of settings.disabledRules) if (rule in config) config[rule] = false;
    await linter.setLintConfig(config);
    applied.rules = rules;
  }
}

// Harper's suggestion kinds: Replace, Remove, InsertAfter.
const KIND = ['replace', 'remove', 'insert-after'];

/**
 * Lints plain text, with Harper plus our few extra checks (extra-rules.js). Returns
 * [{ rule, start, end, kind, message, suggestions: [{ kind, text }] }].
 */
export async function lint(text, settings) {
  const linter = await getLinter();
  await sync(linter, settings);
  const byRule = await linter.organizedLints(text, { language: 'plaintext' });
  const out = [];
  for (const [rule, lints] of Object.entries(byRule)) {
    for (const l of lints) {
      const span = l.span();
      const suggestions = l.suggestions();
      out.push({
        rule,
        start: span.start,
        end: span.end,
        kind: l.lint_kind(),
        message: l.message(),
        suggestions: suggestions.map((s) => ({ kind: KIND[s.kind()] ?? 'replace', text: s.get_replacement_text() })),
      });
      for (const s of suggestions) s.free();
      span.free();
      l.free();
    }
  }
  return withExtraLints(out, text);
}

/** Starts loading Harper without waiting for it (a text box just got focus). */
export function warm(settings) {
  getLinter().then((linter) => sync(linter, settings)).catch(() => {});
}

/** Rule names -> one-line descriptions (Markdown), for Settings. */
export async function ruleDescriptions() {
  const linter = await getLinter();
  return { ...(await linter.getLintDescriptions()), ...EXTRA_DESCRIPTIONS };
}
