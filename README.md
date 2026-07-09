# CatchUp

Spoiler-safe Q&A Chrome extension for streaming video. Missed something while
watching? Ask a question — CatchUp answers using **only the dialogue up to your
current timestamp**, never anything after it.

Works on **Netflix** and **YouTube** (MVP).

## How it works

1. **Subtitles are captured automatically.** On YouTube, a page-world script
   reads the player's caption track list and fetches the best track as WebVTT.
   On Netflix, it hooks `JSON.parse` to catch the play manifest (the Subadub
   technique) and fetches the WebVTT subtitle track the player already uses.
   Captured subtitles are stored per video, so switching episodes just works.
   Manual `.srt`/`.vtt` upload/paste remains as an override/fallback.
2. A content script reads the `<video>` element's `currentTime` and the title
   from the page DOM.
3. When you ask a question, the popup reads the **live** playback position,
   and the background service worker truncates the subtitles for **this**
   video to cues with `start <= currentTime`. This happens on **every**
   question, so seeking forward/backward mid-conversation is always handled.
4. The truncated transcript goes to your chosen answer engine — **Google
   Gemini** (`gemini-2.5-flash`, free tier) or **Anthropic Claude**
   (`claude-sonnet-4-6`, paid) — with a system prompt that strictly forbids
   outside knowledge of the show; if the answer isn't in the transcript, it
   says so instead of guessing.

Everything runs client-side. Your API key lives in `chrome.storage.local` and
is sent only to the selected provider's API.

**Free usage:** pick Gemini in the options page and create a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) — the free
tier needs no payment method and its daily quota covers normal viewing
easily.

## Setup

```sh
npm install
npm run build     # typecheck + bundle to dist/
```

Then in Chrome:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the CatchUp icon → **API key settings** → pick a provider and paste
   its API key (Gemini for free usage, Anthropic if you have credits).
4. Open a Netflix or YouTube video and just ask — subtitles are captured
   automatically a few seconds after playback starts (watch the status line in
   the popup). Load an `.srt`/`.vtt` manually only if capture fails.

## Development

```sh
npm run dev          # rebuild on change (reload the extension to pick up)
npm test             # unit tests (subtitle parser + truncation logic)
```

## Project layout

```
public/manifest.json      MV3 manifest
src/lib/subtitles.ts      SRT/VTT → timestamped cues (lenient, tag-stripping)
src/lib/truncate.ts       spoiler boundary: cues with start <= currentTime
src/lib/prompt.ts         spoiler-safety system prompt
src/lib/messages.ts       typed message contracts + storage keys
src/background/           service worker: storage, truncation, Claude/Gemini calls
src/content/              video/title detection + subtitle relay (no runtime imports)
src/page/                 MAIN-world capture scripts for YouTube/Netflix subtitles
src/popup/                chat UI, subtitle upload/paste
src/options/              API key entry
tests/                    vitest suites for parser + truncation
```

## Known MVP limitations (deliberate)

- Auto-capture prefers English tracks; other languages fall back to the first
  usable track. Manual upload always wins for the current video.
- Auto-capture depends on site internals (YouTube player response, Netflix
  manifest shape) — if a site update breaks it, manual upload still works.
- The last 8 videos' subtitles are kept (LRU); the full truncated transcript
  is sent on each question (no windowing/summarization yet).
- No audio fingerprinting, no multi-episode memory, no accounts.
