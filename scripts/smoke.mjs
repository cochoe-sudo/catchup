/**
 * Smoke test: load the BUILT background.js with a chrome stub and drive the
 * message handler through its non-API paths (no key -> no subs -> empty
 * transcript). Catches bundling regressions (e.g. externalized node modules
 * crashing at import time) without needing a browser.
 */

const storage = new Map();
const listeners = [];

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (storage.has(k)) out[k] = storage.get(k);
        }
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
    },
  },
  runtime: {
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
  },
};

await import("../dist/background.js");
if (listeners.length !== 1) throw new Error(`expected 1 listener, got ${listeners.length}`);

function send(message) {
  return new Promise((resolve) => {
    const keepOpen = listeners[0](message, {}, resolve);
    if (keepOpen !== true) throw new Error("listener must return true for async response");
  });
}

const ask = (currentTimeSec, videoKey = null) => ({
  type: "CATCHUP_ASK",
  title: "Test Show",
  currentTimeSec,
  question: "What happened?",
  history: [],
  videoKey,
});

// 1. No API key
let res = await send(ask(100));
if (res.ok !== false || res.code !== "no_api_key") throw new Error(`bad no-key response: ${JSON.stringify(res)}`);

// 2. Key but no subtitles
storage.set("catchup.apiKey", "sk-ant-test");
res = await send(ask(100));
if (res.ok !== false || res.code !== "no_subtitles") throw new Error(`bad no-subs response: ${JSON.stringify(res)}`);

// 3. Subtitles loaded, but current time is before the first cue -> canned answer, no API call
storage.set("catchup.subtitles", {
  label: "test.srt",
  savedAt: 0,
  cues: [{ startMs: 60_000, endMs: 62_000, text: "First line" }],
});
res = await send(ask(10));
if (res.ok !== true || !/No dialogue has occurred yet/.test(res.answer))
  throw new Error(`bad empty-transcript response: ${JSON.stringify(res)}`);

// 4. Auto-captured subtitles: fire-and-forget message parses VTT and stores per video
const autoResult = listeners[0](
  {
    type: "CATCHUP_AUTO_SUBS",
    videoKey: "yt:abc123",
    label: "English · YouTube captions",
    vtt: "WEBVTT\n\n00:01.000 --> 00:03.000\nAuto line one.\n\n00:05.000 --> 00:07.000\nAuto line two.\n",
  },
  {},
  () => {},
);
if (autoResult === true) throw new Error("AUTO_SUBS must not hold the channel open");
await new Promise((r) => setTimeout(r, 50)); // let the async handler store
const map = storage.get("catchup.subsByVideo");
if (map?.["yt:abc123"]?.cues?.length !== 2)
  throw new Error(`auto subs not stored: ${JSON.stringify(map)}`);

// 5. Per-video subtitles take priority; empty-before-first-cue path proves lookup
//    (the global manual cue at 60s would be visible at t=30, the yt one at 61s is not)
storage.set("catchup.subsByVideo", {
  "yt:abc123": { label: "auto", savedAt: 1, cues: [{ startMs: 61_000, endMs: 62_000, text: "Later" }] },
});
res = await send(ask(30, "yt:abc123"));
if (res.ok !== true || !/No dialogue has occurred yet/.test(res.answer))
  throw new Error(`per-video subtitles were not preferred: ${JSON.stringify(res)}`);

// 6. Unknown videoKey falls back to the global manual subtitles (no_subtitles would be wrong)
res = await send(ask(10, "yt:unknown"));
if (res.ok !== true || !/No dialogue has occurred yet/.test(res.answer))
  throw new Error(`manual fallback broken: ${JSON.stringify(res)}`);

console.log("smoke test passed: bundle loads; key/subs guards, auto-capture storage, and per-video lookup all behave");
