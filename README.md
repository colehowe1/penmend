# Penmend

A Chrome extension that does what Grammarly did: underlines spelling, grammar and punctuation
mistakes in any text box as you type, fixes them in one click, offers clearer versions of
hard-to-read sentences, and rewrites text on request.

Private by default: the built-in checker runs on your computer, there is no Penmend server, and there
are no analytics of any kind. AI checks and rewrites (Claude) are optional and use your own API key.
Penmend is open source (GPL-3.0-or-later), so you can check all of that in the code.

**Get it:** [Chrome Web Store](https://chromewebstore.google.com/detail/bfmabkejkkhhfiljngoimnhmeakdagmi)
(works in Chrome, Edge, Brave, Vivaldi, Opera and Arc), or build it from this source (below).
Privacy policy: [colehowe1.github.io/penmend/privacy.html](https://colehowe1.github.io/penmend/privacy.html).

- **Free, private local checking.** [Harper](https://writewithharper.com) (open source) runs inside
  Chrome on your computer. Nothing you type leaves the computer for these checks. It loads when you
  click into a text box and stays ready while you write (it uses ~300 MB while loaded; Chrome
  frees that about 30 s after you leave the box, switch windows, or stop typing for 3 minutes).
  A few extra local checks fill gaps in Harper: doubled commas, "its" for "it's" ("its not
  working"), and "Your welcome".
- **Claude, optional.** With your own Anthropic API key, Claude reads each paragraph when you pause
  and catches what the local checker misses: comma splices and run-ons, missing commas after an
  opening clause or before "and"/"but" joining two sentences, wrong words, unclear phrasing. It
  rewrites text when you ask: Improve, Shorten, More professional, Friendlier, Simpler, Fix errors
  only, Sound like me, or your own instruction. Where Claude has read a paragraph, its judgment
  wins over the local checker's (fewer false alarms).
- **Clearer sentences.** When a sentence is long or tangled, Claude also offers a clearer version
  (reordered, or split in two). A sentence with nothing else wrong gets a blue underline across it;
  one that also has a mistake shows the mistake, and its card has **Rewrite the whole sentence**.
  The rewrite keeps every number, link and name, and stays offered after you fix a word inside the
  sentence. Settings → Claude turns these off.
- **Your style.** Describe how you write (or paste a few emails and let Claude describe it). Claude
  leaves those habits alone when it checks and follows them when it rewrites. **Punctuation I don't
  use** (semicolons, dashes): never suggested by either checker, and taken out of Claude's rewrites
  if it slips one in (a dash becomes a comma, a semicolon a full stop).

Works in plain text boxes and rich editors, including the ones built on ProseMirror, Tiptap,
Lexical, Slate, Quill, TinyMCE and CKEditor 5 (each tested end to end: underline, click, fix),
inside iframes and dialogs too. In Gmail and Outlook on the web it skips the email you're replying
to and your signature (a block quote you write yourself is still checked); those two need a
sign-in, so they weren't part of the automated tests. Not Google Docs
(it draws text on a canvas; Docs has its own checker), and not desktop apps like the Outlook app
(use the **writing pad**, then copy).

## Install from source

1. In Terminal, in this folder: `npm install` then `npm run build`. This makes the `dist` folder.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, pick
   the `dist` folder.
3. Pin it: puzzle-piece icon in the toolbar, then the pin next to Penmend.
4. Settings opens by itself. Local checking already works. For Claude: paste an API key from
   [console.anthropic.com → API keys](https://console.anthropic.com/settings/keys), click **Save key**
   (it runs a tiny test), then pick a model for checks and one for rewrites. Nothing is sent to Claude
   until both a key and a model are chosen.
5. While Grammarly is still installed, both will underline. Turn Grammarly off on
   `chrome://extensions`.

Optional: to start with your own dictionary, style notes and punctuation switches, copy
`src/shared/seed.js` to `src/shared/seed.local.js` (git-ignored) and fill it in. `npm run build` uses
it; the store and test builds don't.

To update after changing the code: `npm run build`, then the reload arrow on Penmend's card in
`chrome://extensions`. Open tabs pick up the new version by themselves.

## Use

| Do this | What happens |
|---|---|
| Type in any text box | Red underline = spelling/grammar/punctuation, blue = clarity/style; ~0.3 s after you pause |
| Rest on a blue underline across a whole sentence | Claude's clearer version, with the new words marked; **Use this version** puts it in |
| Rest the mouse on an underline (or click it) | Card: the fix, why, Ignore, Add to dictionary, Never flag this / Turn off this check |
| Click the round badge in the box's corner | Panel: every issue, **Fix all**, **Check with Claude**, rewrite the whole text |
| Select text in a box | A **Rewrite** button appears next to it |
| Right-click selected text (anywhere) | **Rewrite with Penmend** → pick a style; outside text boxes you can copy the result |
| `⌥⇧W` / `⌥⇧R` | Open the panel / rewrite the selection (change at `chrome://extensions/shortcuts`) |
| Toolbar icon | On/off everywhere or for the current site, Claude status, this month's cost, writing pad |

## What Claude costs

You pay Anthropic directly for what you use (list prices, per million tokens):

| Model | In / out | About a month at 60 checks + 10 rewrites a workday |
|---|---|---|
| Claude Haiku 5.5 | $0.10 / $0.50 | ~$0.20 |
| Claude Sonnet 5.5 | $2 / $10 | ~$4.50 |
| Claude Opus 5.5 | $4 / $20 | ~$9 |

Settings → **Claude usage this month** shows your real counts and an estimate. The **Daily limit**
(Settings → Claude, $2 by default) stops Claude for the rest of the day once that much is spent;
local checking keeps working. Sonnet 5.5 and Opus 5.5
requests opt into Anthropic's server-side refusal fallback, so a rare false safety refusal (security
wording can trip it) is retried on another model inside the same request. Haiku 5.5 has no
fallback; a refusal just shows "Claude declined to check this".

## Privacy and security

- No analytics, telemetry or tracking of any kind, and no Penmend server.
- Local checks never leave the computer. With Claude on, only the paragraphs being checked (and text
  you ask to rewrite) go to `api.anthropic.com` with your key. There is no Penmend server.
- Claude only checks boxes you've just typed in yourself (text a page fills in costs nothing), never
  paragraphs that look like they hold a password, key, token, code or card number, and never boxes
  named for keys, passwords or codes. Rewriting text like that asks you first.
- Three stops on spending: automatic checks pause for a box after 30 requests or 60,000 characters
  in 10 minutes ("Check with Claude" still works); everything stops for the day at the daily limit;
  and Claude pauses for the hour after 240 requests. The background worker enforces the last two,
  so nothing a web page does can get past them.
- A web page can't see inside or press Penmend's card, badge or panel (a closed shadow root,
  and only real clicks count). Claude's fixes may not change numbers, links or email addresses.
- The API key lives in `chrome.storage.local`, restricted to the extension's own pages and service
  worker. Web pages and the content script can't read it, and it isn't synced to your Google account.
- Settings (dictionary, style notes, sites) sync with your Chrome profile.
- Text from pages is always shown as text, never as HTML. The prompts tell Claude to treat your draft
  only as text to proofread, never as instructions.

## How it's built

```
src/
  manifest.json        MV3: content script on all pages and frames, service worker, popup, settings
  background/          service worker
    harper.js          Harper (WASM) checker: dialect, dictionary, switched-off rules
    extra-rules.js     the few local checks Harper lacks (doubled commas, its/it's, you're welcome)
    claude.js          Claude via @anthropic-ai/sdk: checks (structured JSON), streamed rewrites,
                       style summaries, key test, friendly errors
    prompts.js         every instruction Claude gets
    usage.js           the usage meter (this month by model, plus today's spend)
    budget.js          the daily limit and the hourly cap, checked before every Claude call
  content/             runs in each page/frame (starts only when you click into a text box)
    controller.js      finds the box you're in, owns the card/badge/panel/selection tools
    session.js         one text box: Harper as you type, Claude per changed paragraph, merging,
                       sentence rewrites (kept apart from the fixes; issues.js placeRewrites)
    textmodel.js       rich editor -> plain text with a map back to the DOM (skips quoted replies,
                       signatures, code)
    adapters.js        underlines: CSS Custom Highlight API in rich editors, a see-through mirror
                       over textareas
    edit.js            applying fixes like typing (beforeinput / insertText) so editors and undo work
    issues.js          merge Harper + Claude, filters (dictionary, ALL CAPS, URLs, ignored...)
    ui/                card, badge, panel, rewrite view, selection pill (shadow DOM)
  shared/              settings, models + prices, locating Claude's edits, text helpers
  options/ popup/ pad/ extension pages
```

## Develop

```
npm install
npm run build          # dist/
npm run watch          # rebuild on save
npm test               # unit tests (node --test)
npm run e2e            # builds, then the full end-to-end test in headless Chrome (mock Claude, no cost)
node test/e2e/editors.mjs   # real editors on their public demo pages (needs internet)
npm run zip            # the store build: dist-store/ (no personal seed) -> penmend-<version>.zip
npm run store-images   # the store screenshots, promo tiles and icon -> store/images/ (mock Claude)
```

The end-to-end tests use the Chrome installed in `/Applications` over a CDP pipe (branded Chrome
only loads unpacked extensions that way) and quit it through CDP, leaving no profile behind.

## Chrome Web Store build

`npm run zip` builds the store package (`dist-store/` -> `penmend-<version>.zip`) from the public
starting values in `src/shared/seed.js`. `store/` holds the listing's screenshots, promo tiles and
icon (`npm run store-images`) and `demo/`, the made-up mail page in the screenshots. The privacy
policy is `docs/privacy.html`, served by GitHub Pages.

## License

Penmend is free software under the GNU General Public License, version 3 or later (`LICENSE`).
It uses Harper (`harper.js`, Apache-2.0, Automattic) and the Anthropic TypeScript SDK
(`@anthropic-ai/sdk`, Apache-2.0). Their license files ship in `dist/licenses/`.
