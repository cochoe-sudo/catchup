/**
 * Content script for ALL sites: video/title detection, subtitle relay from
 * the page-world capture scripts, and the CatchUp sidebar UI.
 *
 * The sidebar lives in the page (Shadow DOM, so site CSS can't touch it) and
 * reads video.currentTime directly from the same document — no message
 * round-trips, no polling lag. It is created lazily on first toggle
 * (extension icon click) so this script stays inert on pages you never ask
 * about.
 *
 * IMPORTANT: this file must have ZERO runtime imports — MV3 content scripts
 * are classic scripts, not ES modules. `import type` only.
 */

import type {
  AskRequest,
  AskResponse,
  AutoSubsMessage,
  AutoSubsResponse,
  ChatTurn,
  StoredSubtitles,
} from "../lib/messages";

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w["__catchupContent"]) return; // double-injection guard (manifest + install-time inject)
  w["__catchupContent"] = true;

  const STORAGE_SUBS_BY_VIDEO = "catchup.subsByVideo";
  const STORAGE_MANUAL = "catchup.subtitles";

  // ---- video / title / key detection ---------------------------------------

  function findMainVideo(): HTMLVideoElement | null {
    const ytMain = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (ytMain) return ytMain;

    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;

    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (const video of videos) {
      if (video.readyState === 0) continue;
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best ?? videos[0] ?? null;
  }

  /** "Watch Foo | Hulu" -> "Foo": strip watch-prefixes and site-name suffixes. */
  function genericTitle(): string {
    const raw = document.title.trim().replace(/^watch(ing)?\s+/i, "");
    const first = raw.split(/\s+[|•·]\s+|\s+[-–—]\s+/)[0]?.trim();
    return first || raw || "this video";
  }

  function detectTitle(): string {
    const host = location.hostname;
    if (host.includes("netflix.com")) {
      const overlay = document.querySelector('[data-uia="video-title"]');
      const overlayText = overlay?.textContent?.trim();
      if (overlayText) return overlayText;
    }
    if (host.includes("youtube.com")) {
      const heading = document.querySelector("ytd-watch-metadata h1");
      const headingText = heading?.textContent?.trim();
      if (headingText) return headingText;
    }
    return genericTitle();
  }

  /** Stable per-video key; yt/nf match their capture scripts, everything else is host+path. */
  function computeVideoKey(): string {
    const host = location.hostname;
    if (host.includes("youtube.com")) {
      const videoId = new URLSearchParams(location.search).get("v");
      if (videoId) return `yt:${videoId}`;
    }
    if (host.includes("netflix.com")) {
      const movieId = /\/watch\/(\d+)/.exec(location.pathname)?.[1];
      if (movieId) return `nf:${movieId}`;
    }
    return `gen:${location.host}${location.pathname}`;
  }

  // ---- subtitle relay (page world -> background) ----------------------------

  document.addEventListener("catchup:subtitles", (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    try {
      const payload = JSON.parse(detail) as {
        videoKey?: unknown;
        label?: unknown;
        vtt?: unknown;
        cues?: unknown;
      };
      if (typeof payload.videoKey !== "string" || typeof payload.label !== "string") return;
      const message: AutoSubsMessage = {
        type: "CATCHUP_AUTO_SUBS",
        videoKey: payload.videoKey,
        label: payload.label,
        ...(typeof payload.vtt === "string" ? { vtt: payload.vtt } : {}),
        ...(Array.isArray(payload.cues) ? { cues: payload.cues as AutoSubsMessage["cues"] } : {}),
      };
      if (!message.vtt && !message.cues) return;
      void chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // malformed payload — ignore
    }
  });
  document.dispatchEvent(new CustomEvent("catchup:ready"));

  // ---- sidebar --------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .panel {
      position: fixed;
      top: 16px; right: 16px; bottom: 16px;
      width: 340px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      background: rgba(252, 252, 250, 0.78);
      backdrop-filter: blur(20px) saturate(1.4);
      -webkit-backdrop-filter: blur(20px) saturate(1.4);
      border: 1px solid rgba(255, 255, 255, 0.6);
      outline: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.28);
      color: #1c2430;
      font-size: 13.5px;
      line-height: 1.5;
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.07);
    }
    .brand { font-weight: 800; font-size: 15px; letter-spacing: -0.02em; }
    .brand span { color: #0f766e; }
    .meta { flex: 1; min-width: 0; text-align: right; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .time { color: #5b6472; font-size: 12px; font-variant-numeric: tabular-nums; }
    button {
      font: inherit; cursor: pointer; border: none; background: none; color: inherit;
    }
    .icon {
      width: 26px; height: 26px; border-radius: 8px; flex: none;
      display: grid; place-items: center; font-size: 13px; color: #5b6472;
    }
    .icon:hover { background: rgba(0, 0, 0, 0.07); color: #1c2430; }
    .subsbar {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 14px;
      font-size: 12px; color: #5b6472;
      border-bottom: 1px solid rgba(0, 0, 0, 0.07);
    }
    .subsbar .status { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .subsbar .status.loaded { color: #15803d; }
    .subsbar .loadbtn {
      flex: none; font-size: 12px; color: #0f766e; font-weight: 600;
      padding: 2px 8px; border-radius: 6px;
    }
    .subsbar .loadbtn:hover { background: rgba(15, 118, 110, 0.1); }
    .chat {
      flex: 1; overflow-y: auto;
      padding: 12px 14px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .hint { margin: auto; text-align: center; color: #5b6472; padding: 0 18px; }
    .msg {
      max-width: 90%; padding: 8px 11px; border-radius: 12px;
      white-space: pre-wrap; overflow-wrap: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: rgba(15, 118, 110, 0.14);
      border: 1px solid rgba(15, 118, 110, 0.18);
      border-bottom-right-radius: 4px;
    }
    .msg.assistant {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(0, 0, 0, 0.07);
      border-bottom-left-radius: 4px;
    }
    .msg.error {
      align-self: stretch; max-width: none;
      background: rgba(220, 60, 60, 0.08);
      border: 1px solid rgba(220, 60, 60, 0.35);
      color: #9f2d2d;
    }
    .msg .stamp { display: block; margin-top: 3px; font-size: 11px; color: #5b6472; font-variant-numeric: tabular-nums; }
    form {
      display: flex; gap: 8px;
      padding: 10px 14px 12px;
      border-top: 1px solid rgba(0, 0, 0, 0.07);
    }
    form input {
      flex: 1; font: inherit; color: inherit;
      background: rgba(255, 255, 255, 0.8);
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 9px;
      padding: 8px 11px;
    }
    form input:focus { outline: none; border-color: #0f766e; }
    form input::placeholder { color: #8a93a3; }
    .ask {
      flex: none; font-weight: 700; color: #fff;
      background: #0f766e; border-radius: 9px; padding: 8px 14px;
    }
    .ask:hover { background: #0d685f; }
    .ask:disabled { opacity: 0.5; cursor: default; }
  `;

  let host: HTMLDivElement | null = null;
  let ui: {
    panel: HTMLDivElement;
    title: HTMLDivElement;
    time: HTMLDivElement;
    status: HTMLSpanElement;
    fileInput: HTMLInputElement;
    chat: HTMLDivElement;
    hint: HTMLDivElement | null;
    form: HTMLFormElement;
    input: HTMLInputElement;
    askButton: HTMLButtonElement;
  } | null = null;

  const history: ChatTurn[] = [];
  const MAX_HISTORY_TURNS = 6;
  let historyKey = "";
  let ticker: number | undefined;

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildSidebar(): void {
    host = document.createElement("div");
    host.setAttribute("data-catchup-root", "");
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const panel = element("div", "panel");

    const header = element("header");
    const brand = element("div", "brand");
    brand.append("Catch", element("span", "", "Up"));
    const meta = element("div", "meta");
    const title = element("div", "title", "…");
    const time = element("div", "time");
    meta.append(title, time);
    const gear = element("button", "icon", "⚙");
    gear.title = "Settings (API key, answer engine)";
    gear.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "CATCHUP_OPEN_OPTIONS" }).catch(() => {});
    });
    const close = element("button", "icon", "✕");
    close.title = "Close";
    close.addEventListener("click", hideSidebar);
    header.append(brand, meta, gear, close);

    const subsbar = element("div", "subsbar");
    const status = element("span", "status", "Looking for subtitles…");
    const loadButton = element("button", "loadbtn", "Load file");
    loadButton.title = "Load an .srt/.vtt subtitle file manually";
    const fileInput = element("input") as HTMLInputElement;
    fileInput.type = "file";
    fileInput.accept = ".srt,.vtt,text/vtt";
    fileInput.hidden = true;
    loadButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void loadManualFile(file);
      fileInput.value = "";
    });
    subsbar.append(status, loadButton, fileInput);

    const chat = element("div", "chat");
    const hint = element(
      "div",
      "hint",
      "Missed something? Ask — answers only use dialogue up to your current timestamp. No spoilers.",
    );
    chat.appendChild(hint);

    const form = element("form");
    const input = element("input") as HTMLInputElement;
    input.type = "text";
    input.placeholder = "Wait, what did I miss?";
    input.autocomplete = "off";
    const askButton = element("button", "ask", "Ask");
    askButton.type = "submit";
    form.append(input, askButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void ask();
    });

    panel.append(header, subsbar, chat, form);
    shadow.appendChild(panel);

    // Keep typed keys away from the page's global shortcuts (space = pause, etc.)
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    ui = { panel, title, time, status, fileInput, chat, hint, form, input, askButton };
    mountHost();

    // Follow the video into/out of fullscreen — fixed elements in the top
    // document don't render above a fullscreen element.
    document.addEventListener("fullscreenchange", mountHost);
  }

  function mountHost(): void {
    if (!host) return;
    (document.fullscreenElement ?? document.body ?? document.documentElement).appendChild(host);
  }

  function showSidebar(): void {
    if (!host) buildSidebar();
    else host.style.display = "";
    refreshNowPlaying();
    void refreshSubtitleStatus();
    ticker ??= window.setInterval(refreshNowPlaying, 500);
    ui?.input.focus();
  }

  function hideSidebar(): void {
    if (host) host.style.display = "none";
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function toggleSidebar(): void {
    if (host && host.style.display !== "none") hideSidebar();
    else showSidebar();
  }

  // ---- live state -----------------------------------------------------------

  function formatTime(totalSecondsRaw: number): string {
    const totalSeconds = Math.max(0, Math.floor(totalSecondsRaw));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return hours > 0 ? `${hours}:${mmss}` : mmss;
  }

  let lastVideoKey = "";

  function refreshNowPlaying(): void {
    if (!ui) return;
    const video = findMainVideo();
    ui.title.textContent = video ? detectTitle() : "No video on this page";
    ui.time.textContent = video
      ? `at ${formatTime(video.currentTime)}${video.paused ? " · paused" : ""}`
      : "";
    const key = computeVideoKey();
    if (key !== lastVideoKey) {
      lastVideoKey = key;
      void refreshSubtitleStatus();
    }
  }

  async function refreshSubtitleStatus(): Promise<void> {
    if (!ui) return;
    const stored = await chrome.storage.local.get([STORAGE_SUBS_BY_VIDEO, STORAGE_MANUAL]);
    const map = (stored[STORAGE_SUBS_BY_VIDEO] ?? {}) as Record<string, StoredSubtitles>;
    const active = map[computeVideoKey()] ?? (stored[STORAGE_MANUAL] as StoredSubtitles | undefined);
    if (active) {
      ui.status.textContent = `${active.cues.length} lines · ${active.label}`;
      ui.status.classList.add("loaded");
    } else {
      ui.status.textContent = "Looking for subtitles… (or load a file)";
      ui.status.classList.remove("loaded");
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_SUBS_BY_VIDEO]) void refreshSubtitleStatus();
  });

  async function loadManualFile(file: File): Promise<void> {
    const text = await file.text();
    const message: AutoSubsMessage = {
      type: "CATCHUP_AUTO_SUBS",
      videoKey: computeVideoKey(),
      label: file.name,
      vtt: text,
    };
    try {
      const response = (await chrome.runtime.sendMessage(message)) as AutoSubsResponse;
      if (!response.ok) addMessage("error", response.error);
    } catch (err) {
      addMessage("error", err instanceof Error ? err.message : String(err));
    }
  }

  // ---- chat -----------------------------------------------------------------

  function addMessage(kind: "user" | "assistant" | "error", text: string, stamp?: string): HTMLDivElement {
    if (!ui) throw new Error("sidebar not built");
    if (ui.hint) {
      ui.hint.remove();
      ui.hint = null;
    }
    const div = element("div", `msg ${kind}`, text);
    if (stamp) div.appendChild(element("span", "stamp", stamp));
    ui.chat.appendChild(div);
    ui.chat.scrollTop = ui.chat.scrollHeight;
    return div;
  }

  async function ask(): Promise<void> {
    if (!ui || ui.askButton.disabled) return;
    const question = ui.input.value.trim();
    if (!question) return;

    const video = findMainVideo();
    if (!video) {
      addMessage("error", "No video found on this page — start playback, then ask again.");
      return;
    }

    const videoKey = computeVideoKey();
    if (videoKey !== historyKey) {
      history.length = 0; // new video -> fresh conversation
      historyKey = videoKey;
    }

    ui.input.value = "";
    ui.askButton.disabled = true;
    addMessage("user", question, `asked at ${formatTime(video.currentTime)}`);
    const pending = addMessage("assistant", "Thinking…");

    const request: AskRequest = {
      type: "CATCHUP_ASK",
      title: detectTitle(),
      currentTimeSec: video.currentTime,
      question,
      history: history.slice(-MAX_HISTORY_TURNS),
      videoKey,
    };

    let response: AskResponse;
    try {
      response = (await chrome.runtime.sendMessage(request)) as AskResponse;
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    pending.remove();
    if (response.ok) {
      addMessage("assistant", response.answer);
      history.push({ question, answer: response.answer });
    } else {
      addMessage("error", response.error);
      if (response.code === "no_api_key") {
        void chrome.runtime.sendMessage({ type: "CATCHUP_OPEN_OPTIONS" }).catch(() => {});
      }
    }
    ui.askButton.disabled = false;
    ui.input.focus();
  }

  // ---- toggle from the extension icon ---------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CATCHUP_TOGGLE") return;
    toggleSidebar();
    sendResponse({ ok: true });
  });
})();
