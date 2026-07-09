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

const ask = (currentTimeSec) => ({
  type: "CATCHUP_ASK",
  title: "Test Show",
  currentTimeSec,
  question: "What happened?",
  history: [],
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

console.log("smoke test passed: background bundle loads and handles all pre-API paths");
