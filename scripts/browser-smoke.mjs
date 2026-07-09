/**
 * Browser smoke test: load the built extension into Chromium, confirm the MV3
 * service worker registers, and that popup + options pages render and can
 * store an API key + parsed subtitles.
 */
// Resolve playwright from the global install if not present locally
// (NODE_PATH is ignored by ESM resolution).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwrightPath = "playwright";
try {
  require.resolve("playwright");
} catch {
  playwrightPath = require("node:child_process")
    .execSync("npm root -g", { encoding: "utf8" })
    .trim() + "/playwright/index.mjs";
}
const { chromium } = await import(playwrightPath);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const userDataDir = mkdtempSync(join(tmpdir(), "catchup-profile-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  // MV3 background service worker must register without errors.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const extensionId = new URL(worker.url()).host;
  console.log("service worker registered:", worker.url());

  // Options page: save a key.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.fill("#api-key", "sk-ant-test-not-real");
  await options.click("#save");
  await options.waitForFunction(() => document.getElementById("status").textContent.includes("Saved"));
  console.log("options page: key saved");

  // Popup page: paste subtitles, confirm they parse and persist.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.click("#paste-toggle");
  await popup.fill(
    "#paste-text",
    "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:05,000 --> 00:00:07,000\nGeneral Kenobi.\n",
  );
  await popup.click("#paste-save");
  await popup.waitForFunction(() =>
    document.getElementById("subtitle-status").textContent.includes("2 lines"),
  );
  console.log("popup: subtitles parsed and stored (2 lines)");

  // No-video state should be handled gracefully.
  const headerText = await popup.textContent("#video-title");
  console.log("popup header without video:", JSON.stringify(headerText));

  // Asking with no video should surface the friendly error, not crash.
  await popup.fill("#question", "what happened?");
  await popup.click("#ask-button");
  await popup.waitForSelector(".msg.error", { timeout: 5_000 });
  const err = await popup.textContent(".msg.error");
  console.log("popup: no-video ask handled:", JSON.stringify(err));

  console.log("browser smoke test passed");
} finally {
  await context.close();
}
