/**
 * Background service worker: receives questions from the popup, rebuilds the
 * spoiler-safe transcript window from the CURRENT timestamp on every question
 * (so seeking forward/backward mid-conversation is always respected), and
 * calls the Anthropic API.
 */

import { cuesUpTo, formatTimestamp, formatTranscript } from "../lib/truncate";
import { parseSubtitleText, sanitizeCueText } from "../lib/subtitles";
import type { Cue } from "../lib/subtitles";
import { buildSystemPrompt, EMPTY_TRANSCRIPT_ANSWER } from "../lib/prompt";
import { MAX_STORED_VIDEOS, STORAGE_KEYS } from "../lib/messages";
import type {
  AskRequest,
  AskResponse,
  AutoSubsMessage,
  AutoSubsResponse,
  Provider,
  StoredSubtitles,
} from "../lib/messages";
import { askClaude, describeApiError } from "./api";
import { askGemini } from "./gemini";

type SubsByVideo = Record<string, StoredSubtitles>;

/** Validate + clean a pre-extracted cue payload (from the textTracks capture). */
function cuesFromPayload(raw: NonNullable<AutoSubsMessage["cues"]>): Cue[] {
  const cues: Cue[] = [];
  for (const cue of raw) {
    if (
      !cue ||
      typeof cue.startMs !== "number" ||
      !Number.isFinite(cue.startMs) ||
      cue.startMs < 0 ||
      typeof cue.text !== "string"
    ) {
      continue;
    }
    const text = sanitizeCueText(cue.text);
    if (!text) continue;
    const endMs = typeof cue.endMs === "number" && Number.isFinite(cue.endMs) ? cue.endMs : cue.startMs;
    cues.push({ startMs: cue.startMs, endMs, text });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/** Parse/clean captured subtitles and store them keyed by video, LRU-capped. */
async function handleAutoSubs(message: AutoSubsMessage): Promise<AutoSubsResponse> {
  let cues: Cue[];
  try {
    cues = message.cues ? cuesFromPayload(message.cues) : parseSubtitleText(message.vtt ?? "");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (cues.length === 0) {
    return { ok: false, error: "No usable subtitle lines found." };
  }

  const current = await chrome.storage.local.get(STORAGE_KEYS.subsByVideo);
  const map = (current[STORAGE_KEYS.subsByVideo] ?? {}) as SubsByVideo;

  // Sniffed segments and progressive textTracks arrive piecemeal — union them
  // with what's already stored for this video instead of replacing it.
  const existing = map[message.videoKey];
  if (message.mode === "merge" && existing) {
    const union = new Map<string, Cue>();
    for (const cue of [...existing.cues, ...cues]) {
      union.set(`${cue.startMs}|${cue.text}`, cue);
    }
    cues = Array.from(union.values()).sort((a, b) => a.startMs - b.startMs);
  }

  const stored: StoredSubtitles = { label: message.label, cues, savedAt: Date.now() };
  map[message.videoKey] = stored;

  const keys = Object.keys(map);
  if (keys.length > MAX_STORED_VIDEOS) {
    keys
      .sort((a, b) => (map[a]?.savedAt ?? 0) - (map[b]?.savedAt ?? 0))
      .slice(0, keys.length - MAX_STORED_VIDEOS)
      .forEach((key) => delete map[key]);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.subsByVideo]: map });
  return { ok: true, lines: cues.length };
}

// Subtitle segments arrive in bursts (players fetch several at once) and
// handleAutoSubs is a read-modify-write on storage — run them strictly in
// sequence or concurrent merges clobber each other's cues.
let autoSubsQueue: Promise<unknown> = Promise.resolve();

async function handleAsk(request: AskRequest): Promise<AskResponse> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.geminiKey,
    STORAGE_KEYS.subtitles,
    STORAGE_KEYS.subsByVideo,
  ]);

  const provider = (stored[STORAGE_KEYS.provider] as Provider | undefined) ?? "anthropic";
  const apiKey = stored[
    provider === "gemini" ? STORAGE_KEYS.geminiKey : STORAGE_KEYS.apiKey
  ] as string | undefined;
  if (!apiKey) {
    return {
      ok: false,
      code: "no_api_key",
      error: `No ${provider === "gemini" ? "Gemini" : "Anthropic"} API key set. Add one in CatchUp's options.`,
    };
  }

  // Auto-captured (or keyed manual) subtitles for THIS video first,
  // then the global manually-loaded fallback.
  const map = (stored[STORAGE_KEYS.subsByVideo] ?? {}) as SubsByVideo;
  const subtitles =
    (request.videoKey ? map[request.videoKey] : undefined) ??
    (stored[STORAGE_KEYS.subtitles] as StoredSubtitles | undefined);
  if (!subtitles || subtitles.cues.length === 0) {
    return {
      ok: false,
      code: "no_subtitles",
      error:
        "No subtitles for this video yet. Turn captions ON in the player for a few seconds (many sites only download subtitles when captions are showing) — or load an .srt/.vtt file manually.",
    };
  }

  // Re-truncate at the freshly reported playback position — never reuse a
  // window computed for an earlier question.
  const currentTimeMs = request.currentTimeSec * 1000;
  const visibleCues = cuesUpTo(subtitles.cues, currentTimeMs);

  if (visibleCues.length === 0) {
    return { ok: true, answer: EMPTY_TRANSCRIPT_ANSWER };
  }

  const system = buildSystemPrompt({
    title: request.title,
    timestampLabel: formatTimestamp(currentTimeMs),
    transcript: formatTranscript(visibleCues),
  });

  const params = { apiKey, system, history: request.history, question: request.question };
  try {
    const answer =
      provider === "gemini" ? await askGemini(params) : await askClaude(params);
    return { ok: true, answer };
  } catch (err) {
    // askGemini throws plain Errors with user-ready messages
    return { ok: false, error: provider === "gemini" && err instanceof Error ? err.message : describeApiError(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CATCHUP_OPEN_OPTIONS") {
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (message?.type === "CATCHUP_AUTO_SUBS") {
    autoSubsQueue = autoSubsQueue
      .catch(() => {})
      .then(() => handleAutoSubs(message as AutoSubsMessage))
      .then(sendResponse, (err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies AutoSubsResponse),
      );
    return true;
  }
  if (message?.type !== "CATCHUP_ASK") return;
  handleAsk(message as AskRequest)
    .then(sendResponse)
    .catch((err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies AskResponse),
    );
  return true; // keep the message channel open for the async response
});

// ---- sidebar toggle + no-refresh-needed injection ---------------------------

/** The page-world capture script that applies to a URL. */
function pageScriptFor(url: string): string {
  if (url.includes("youtube.com")) return "page-youtube.js";
  if (url.includes("netflix.com")) return "page-netflix.js";
  return "page-generic.js";
}

async function injectInto(tabId: number, url: string): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [pageScriptFor(url)],
    world: "MAIN",
  });
}

// Toolbar icon click toggles the in-page sidebar. If the content script isn't
// there yet (tab predates the extension / an update), inject it on the spot.
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) {
      void chrome.runtime.openOptionsPage();
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "CATCHUP_TOGGLE" });
    } catch {
      try {
        await injectInto(tab.id, tab.url);
        await chrome.tabs.sendMessage(tab.id, { type: "CATCHUP_TOGGLE" });
      } catch {
        void chrome.runtime.openOptionsPage(); // chrome://, Web Store, etc.
      }
    }
  })();
});

// On install/update, inject into every open tab so nothing needs a refresh.
// (Both scripts guard against double-injection.)
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.allSettled(
      tabs.flatMap((tab) => (tab.id && tab.url ? [injectInto(tab.id, tab.url)] : [])),
    );
  })();
});
