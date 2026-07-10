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
    onInstalled: { addListener() {} },
    openOptionsPage() {},
  },
  action: { onClicked: { addListener() {} } },
  tabs: { async query() { return []; }, async sendMessage() {} },
  scripting: { async executeScript() {} },
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

// 4. Auto-captured VTT parses and stores per video, and responds with the line count
let autoRes = await send({
  type: "CATCHUP_AUTO_SUBS",
  videoKey: "yt:abc123",
  label: "English · YouTube captions",
  vtt: "WEBVTT\n\n00:01.000 --> 00:03.000\nAuto line one.\n\n00:05.000 --> 00:07.000\nAuto line two.\n",
});
if (autoRes.ok !== true || autoRes.lines !== 2)
  throw new Error(`bad AUTO_SUBS vtt response: ${JSON.stringify(autoRes)}`);
const map = storage.get("catchup.subsByVideo");
if (map?.["yt:abc123"]?.cues?.length !== 2)
  throw new Error(`auto subs not stored: ${JSON.stringify(map)}`);

// 4b. Cue-payload variant (generic textTracks capture): sanitized, sorted, stored
autoRes = await send({
  type: "CATCHUP_AUTO_SUBS",
  videoKey: "gen:example.com/watch/1",
  label: "English · captured from player",
  cues: [
    { startMs: 9000, endMs: 10_000, text: "<i>Second</i>" },
    { startMs: 1000, endMs: 2000, text: "First" },
    { startMs: -5, endMs: 0, text: "invalid, dropped" },
  ],
});
if (autoRes.ok !== true || autoRes.lines !== 2)
  throw new Error(`bad AUTO_SUBS cues response: ${JSON.stringify(autoRes)}`);
const genEntry = storage.get("catchup.subsByVideo")["gen:example.com/watch/1"];
if (genEntry.cues[0].text !== "First" || genEntry.cues[1].text !== "Second")
  throw new Error(`cue payload not sanitized/sorted: ${JSON.stringify(genEntry.cues)}`);

// 4c. Unparseable manual file -> ok:false with a message
autoRes = await send({ type: "CATCHUP_AUTO_SUBS", videoKey: "gen:x/y", label: "bad.srt", vtt: "not a subtitle file" });
if (autoRes.ok !== false) throw new Error("unparseable subtitles must return ok:false");

// 4d. Merge mode: sniffed segments union with what's stored (dupes collapse)
autoRes = await send({
  type: "CATCHUP_AUTO_SUBS",
  videoKey: "gen:max.com/video/1",
  label: "captions · captured from stream",
  vtt: "WEBVTT\n\n00:01.000 --> 00:02.000\nSegment one line.\n",
  mode: "merge",
});
autoRes = await send({
  type: "CATCHUP_AUTO_SUBS",
  videoKey: "gen:max.com/video/1",
  label: "captions · captured from stream",
  vtt: "WEBVTT\n\n00:01.000 --> 00:02.000\nSegment one line.\n\n00:30.000 --> 00:31.000\nSegment two line.\n",
  mode: "merge",
});
if (autoRes.ok !== true) throw new Error(`merge send failed: ${JSON.stringify(autoRes)}`);
const merged = storage.get("catchup.subsByVideo")["gen:max.com/video/1"];
if (merged.cues.length !== 2 || merged.cues[1].text !== "Segment two line.")
  throw new Error(`merge did not union segments: ${JSON.stringify(merged.cues)}`);

// 4e. TTML payloads parse too (several streaming services use TTML, not VTT)
autoRes = await send({
  type: "CATCHUP_AUTO_SUBS",
  videoKey: "gen:max.com/video/2",
  label: "captions · captured from stream",
  vtt: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">TTML line.</p></div></body></tt>',
  mode: "merge",
});
if (autoRes.ok !== true || autoRes.lines !== 1)
  throw new Error(`TTML payload failed: ${JSON.stringify(autoRes)}`);

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
