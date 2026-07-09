# CatchUp

Spoiler-safe Q&A Chrome extension for streaming video. Missed something while
watching? Ask a question — CatchUp answers using **only the dialogue up to your
current timestamp**, never anything after it.

Works on **Netflix** and **YouTube** (MVP).

## How it works

1. A content script reads the `<video>` element's `currentTime` and the title
   from the page DOM.
2. You load a subtitle file (`.srt` or `.vtt`) for what you're watching — via
   file upload or paste in the popup.
3. When you ask a question, the popup reads the **live** playback position,
   and the background service worker truncates the parsed subtitles to cues
   with `start <= currentTime`. This happens on **every** question, so seeking
   forward/backward mid-conversation is always handled.
4. The truncated transcript goes to the Anthropic API (`claude-sonnet-4-6`)
   with a system prompt that strictly forbids outside knowledge of the show —
   if the answer isn't in the transcript, it says so instead of guessing.

Everything runs client-side. Your API key lives in `chrome.storage.local` and
is sent only to `api.anthropic.com`.

## Setup

```sh
npm install
npm run build     # typecheck + bundle to dist/
```

Then in Chrome:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the CatchUp icon → **API key settings** → paste your Anthropic API key.
4. Open a Netflix or YouTube video, open the popup, load the matching
   `.srt`/`.vtt` file, and ask away.

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
src/background/           service worker: storage, truncation, Anthropic call
src/content/              video/title detection (no runtime imports — MV3 rule)
src/popup/                chat UI, subtitle upload/paste
src/options/              API key entry
tests/                    vitest suites for parser + truncation
```

## Known MVP limitations (deliberate)

- One subtitle set stored at a time — loading a new file replaces the old one.
- The full truncated transcript is sent on each question (fine for one
  episode/movie; no windowing/summarization yet).
- No auto-fetching of subtitles, no audio fingerprinting, no accounts.
- Subtitle timing must roughly match the video's cut (same as any subtitle
  file you'd use in a player).
