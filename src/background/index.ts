/**
 * Background service worker: receives questions from the popup, rebuilds the
 * spoiler-safe transcript window from the CURRENT timestamp on every question
 * (so seeking forward/backward mid-conversation is always respected), and
 * calls the Anthropic API.
 */

import { cuesUpTo, formatTimestamp, formatTranscript } from "../lib/truncate";
import { parseSubtitles } from "../lib/subtitles";
import { buildSystemPrompt, EMPTY_TRANSCRIPT_ANSWER } from "../lib/prompt";
import { MAX_STORED_VIDEOS, STORAGE_KEYS } from "../lib/messages";
import type {
  AskRequest,
  AskResponse,
  AutoSubsMessage,
  StoredSubtitles,
} from "../lib/messages";
import { askClaude, describeApiError } from "./api";

type SubsByVideo = Record<string, StoredSubtitles>;

/** Parse auto-captured VTT and store it keyed by video, LRU-capped. */
async function handleAutoSubs(message: AutoSubsMessage): Promise<void> {
  let stored: StoredSubtitles;
  try {
    stored = {
      label: message.label,
      cues: parseSubtitles(message.vtt),
      savedAt: Date.now(),
    };
  } catch {
    return; // unparseable capture — manual loading still works
  }

  const current = await chrome.storage.local.get(STORAGE_KEYS.subsByVideo);
  const map = (current[STORAGE_KEYS.subsByVideo] ?? {}) as SubsByVideo;
  map[message.videoKey] = stored;

  const keys = Object.keys(map);
  if (keys.length > MAX_STORED_VIDEOS) {
    keys
      .sort((a, b) => (map[a]?.savedAt ?? 0) - (map[b]?.savedAt ?? 0))
      .slice(0, keys.length - MAX_STORED_VIDEOS)
      .forEach((key) => delete map[key]);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.subsByVideo]: map });
}

async function handleAsk(request: AskRequest): Promise<AskResponse> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.subtitles,
    STORAGE_KEYS.subsByVideo,
  ]);

  const apiKey = stored[STORAGE_KEYS.apiKey] as string | undefined;
  if (!apiKey) {
    return {
      ok: false,
      code: "no_api_key",
      error: "No API key set. Add your Anthropic API key in CatchUp's options.",
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
        "No subtitles for this video yet. They're usually captured automatically a few seconds after playback starts — or load an .srt/.vtt file manually.",
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

  try {
    const answer = await askClaude({
      apiKey,
      system,
      history: request.history,
      question: request.question,
    });
    return { ok: true, answer };
  } catch (err) {
    return { ok: false, error: describeApiError(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CATCHUP_AUTO_SUBS") {
    void handleAutoSubs(message as AutoSubsMessage);
    return; // fire-and-forget
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
