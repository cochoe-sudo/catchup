/**
 * Browser smoke test: load the built extension into Chromium and drive the
 * REAL user flow on a generic (non-YouTube/Netflix) streaming page:
 *
 *   textTracks auto-capture -> per-video storage -> sidebar toggle ->
 *   ask -> background truncation -> canned empty-transcript answer.
 *
 * The test page serves a native <track> like many streaming players use, so
 * this exercises the "works on any site" path end to end (no API key needed:
 * asking at t=0, before the first cue, returns the canned answer without a
 * network call).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwrightPath = "playwright";
try {
  require.resolve("playwright");
} catch {
  playwrightPath =
    require("node:child_process").execSync("npm root -g", { encoding: "utf8" }).trim() +
    "/playwright/index.mjs";
}
const { chromium } = await import(playwrightPath);
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const PORT = 8907;

const VTT =
  "WEBVTT\n\n00:01.000 --> 00:03.000\nShe was rushed to the hospital.\n\n00:05.000 --> 00:07.000\nThe doctor said it was poison.\n";
const SEGMENT_1 = "WEBVTT\n\n00:01.000 --> 00:02.000\nSegment one.\n";
const SEGMENT_2 = "WEBVTT\n\n00:30.000 --> 00:31.000\nSegment two.\n";
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/watch2")) {
    // Custom-caption player à la HBO Max: no <track>; the page downloads
    // subtitle segments itself (one fetch, one XHR) and renders them in DOM.
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head><title>Sniffer Show - MaxLike</title></head><body>
      <video></video>
      <script>
        fetch("/seg1.vtt").then((r) => r.text());
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/seg2.vtt");
        xhr.send();
      </script>
    </body></html>`);
  } else if (req.url.startsWith("/watch")) {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head><title>Demo Stream - StreamFlixx</title></head><body>
      <video>
        <track kind="captions" label="English" srclang="en" src="/subs.vtt">
      </video>
    </body></html>`);
  } else if (req.url.startsWith("/subs.vtt")) {
    res.setHeader("content-type", "text/vtt");
    res.end(VTT);
  } else if (req.url.startsWith("/seg1.vtt")) {
    res.setHeader("content-type", "text/vtt");
    res.end(SEGMENT_1);
  } else if (req.url.startsWith("/seg2.vtt")) {
    res.setHeader("content-type", "text/vtt");
    res.end(SEGMENT_2);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "catchup-")), {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "--no-proxy-server",
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  console.log("service worker registered");

  // Options page: verify it renders and saves; set Anthropic provider + a key
  // so the ask path passes the key gate (it won't reach the network at t=0).
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.selectOption("#provider", "anthropic");
  await options.fill("#api-key", "sk-ant-test-not-real");
  await options.click("#save");
  await options.waitForFunction(() =>
    document.getElementById("status").textContent.includes("Saved"),
  );
  console.log("options page: provider + key saved");

  // Generic streaming page.
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
  await page.goto(`http://127.0.0.1:${PORT}/watch`, { waitUntil: "domcontentloaded" });

  // Wait for the textTracks capture to land in storage (scan runs every 3s).
  // NOTE: poll via evaluate — waitForFunction doesn't await async pageFunctions
  // in this Playwright version, so an async storage check would pass instantly.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const lines = await options.evaluate(async (port) => {
      const stored = await chrome.storage.local.get("catchup.subsByVideo");
      return (stored["catchup.subsByVideo"] ?? {})[`gen:127.0.0.1:${port}/watch`]?.cues?.length ?? 0;
    }, PORT);
    if (lines === 2) break;
    if (Date.now() > deadline) throw new Error("textTracks capture never reached storage");
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("generic textTracks auto-capture stored (2 cues)");

  // Toggle the sidebar the way the toolbar button does.
  await options.evaluate(async (port) => {
    const [tab] = await chrome.tabs.query({ url: `http://127.0.0.1:${port}/watch` });
    await chrome.tabs.sendMessage(tab.id, { type: "CATCHUP_TOGGLE" });
  }, PORT);

  const shadow = (selector) => `document.querySelector("[data-catchup-root]").shadowRoot.querySelector(${JSON.stringify(selector)})`;
  await page.waitForFunction(`${shadow(".panel")} !== null`);
  // status fills in asynchronously from storage (string expression = sync poll, safe)
  await page.waitForFunction(`${shadow(".status")}.textContent.includes("2 lines")`, undefined, {
    timeout: 10_000,
  });
  const status = await page.evaluate(`${shadow(".status")}.textContent`);
  console.log("sidebar open; subtitle status:", JSON.stringify(status));
  const title = await page.evaluate(`${shadow(".title")}.textContent`);
  console.log("detected title:", JSON.stringify(title));
  if (title !== "Demo Stream") throw new Error("generic title detection failed");

  // Ask at t=0 (before the first cue): full round trip, canned answer, no network.
  await page.evaluate(`(() => {
    const root = document.querySelector("[data-catchup-root]").shadowRoot;
    root.querySelector("form input").value = "what happened?";
    root.querySelector("form").dispatchEvent(new Event("submit"));
  })()`);
  await page.waitForFunction(
    `${shadow(".msg.assistant")} !== null && !${shadow(".msg.assistant")}.textContent.includes("Thinking")`,
    undefined,
    { timeout: 10_000 },
  );
  const answer = await page.evaluate(`${shadow(".msg.assistant")}.textContent`);
  console.log("answer:", JSON.stringify(answer));
  if (!/No dialogue has occurred yet/.test(answer)) throw new Error("expected canned empty-transcript answer");

  // ---- network-sniffer path (custom-caption players like HBO Max) ----------
  const page2 = await context.newPage();
  await page2.goto(`http://127.0.0.1:${PORT}/watch2`, { waitUntil: "domcontentloaded" });
  const deadline2 = Date.now() + 15_000;
  let sniffed;
  for (;;) {
    sniffed = await options.evaluate(async (port) => {
      const stored = await chrome.storage.local.get("catchup.subsByVideo");
      const entry = (stored["catchup.subsByVideo"] ?? {})[`gen:127.0.0.1:${port}/watch2`];
      return entry ? entry.cues.map((c) => c.text) : null;
    }, PORT);
    if (sniffed && sniffed.length === 2) break;
    if (Date.now() > deadline2)
      throw new Error(`network sniffer capture failed: ${JSON.stringify(sniffed)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("network-sniffed segments merged (fetch + XHR):", JSON.stringify(sniffed));

  console.log(
    "browser smoke test passed: textTracks capture, network sniffing, sidebar, and ask round trip all work",
  );
} finally {
  await context.close();
  server.close();
}
