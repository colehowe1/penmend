// build.mjs: bundles src/ into dist/, the folder Chrome loads ("Load unpacked").
//
//   node build.mjs           one build
//   node build.mjs --watch   rebuild on every change (then click Reload on chrome://extensions)
//   node build.mjs --zip     the Chrome Web Store build: dist-store/, then penmend-<version>.zip
//
// Starting values (dictionary, style notes, punctuation) come from src/shared/seed.js, which has
// nothing personal. A plain build uses src/shared/seed.local.js instead when it exists (your own,
// git-ignored); the store build (--zip) and the test build (--test) never do.
//
// Two bundles: the content script must be a classic script (IIFE); the service worker and the
// extension pages are ES modules. Harper's WebAssembly binary is copied next to background.js,
// which loads it with new URL('harper_wasm_slim_bg.wasm', import.meta.url).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');
// --test: the build the end-to-end tests load (dist-test/): it honors the debugHooks setting (an
// open shadow root, data-* counts) and a mock API address. The release build (dist/) ignores both.
const TEST = process.argv.includes('--test');
const DIST = path.join(ROOT, TEST ? 'dist-test' : zip ? 'dist-store' : 'dist');

const STATIC = [
  'manifest.json',
  'highlights.css',
  'popup/popup.html', 'popup/popup.css',
  'options/options.html', 'options/options.css',
  'pad/pad.html', 'pad/pad.css',
  'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png',
];
const VENDOR = [
  ['node_modules/harper.js/dist/harper_wasm_slim_bg.wasm', 'harper_wasm_slim_bg.wasm'],
  ['node_modules/harper.js/LICENSE', 'licenses/harper.js-LICENSE.txt'],
  ['node_modules/@anthropic-ai/sdk/LICENSE', 'licenses/anthropic-sdk-LICENSE.txt'],
];

// harper.js reads its binary with fs only under Node; the browser build never reaches that branch.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(b) {
    b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: 'fs', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

function copyStatic() {
  for (const rel of STATIC) {
    const from = path.join(SRC, rel);
    if (!fs.existsSync(from)) throw new Error(`missing ${rel} (icons: npm run icons)`);
    fs.mkdirSync(path.dirname(path.join(DIST, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(DIST, rel));
  }
  for (const [from, to] of VENDOR) {
    fs.mkdirSync(path.dirname(path.join(DIST, to)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), path.join(DIST, to));
  }
}

// A different id per build: after an update, the new content script must not mistake the old
// one's marker (Chrome keeps the extension's isolated world, globals and all) for its own.
const BUILD_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Your own starting values, for your own copy only.
const LOCAL_SEED = path.join(SRC, 'shared/seed.local.js');
const localSeed = {
  name: 'local-seed',
  setup(b) {
    b.onResolve({ filter: /\/seed\.js$/ }, () => ({ path: LOCAL_SEED }));
  },
};
const seedPlugins = !zip && !TEST && fs.existsSync(LOCAL_SEED) ? [localSeed] : [];

const common = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"', __PM_BUILD__: JSON.stringify(BUILD_ID), __PM_TEST__: String(TEST) },
};

const builds = [
  { ...common, entryPoints: { content: path.join(SRC, 'content/index.js') }, outdir: DIST, format: 'iife', plugins: seedPlugins },
  {
    ...common,
    entryPoints: {
      background: path.join(SRC, 'background/index.js'),
      'popup/popup': path.join(SRC, 'popup/popup.js'),
      'options/options': path.join(SRC, 'options/options.js'),
      'pad/pad': path.join(SRC, 'pad/pad.js'),
    },
    outdir: DIST,
    format: 'esm',
    splitting: false,
    plugins: [stubNodeBuiltins, ...seedPlugins],
  },
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
copyStatic();

if (watch) {
  const copier = { name: 'copy-static', setup(b) { b.onEnd(() => { try { copyStatic(); } catch (e) { console.error(e.message); } }); } };
  for (const opts of builds) {
    const ctx = await esbuild.context({ ...opts, plugins: [...(opts.plugins || []), copier] });
    await ctx.watch();
  }
  console.log('watching src/ ... (Ctrl+C to stop)');
} else {
  for (const opts of builds) await esbuild.build(opts);
  if (zip) {
    const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
    const out = path.join(ROOT, `penmend-${version}.zip`);
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, '.'], { cwd: DIST });
    console.log(`wrote ${path.relative(ROOT, out)}`);
  }
}
