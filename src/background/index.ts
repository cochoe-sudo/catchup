/**
 * Background service worker: receives questions from the popup, rebuilds the
 * spoiler-safe transcript window from the CURRENT timestamp on every question
 * (so seeking forward/backward mid-conversation is always respected), and
 * calls the Anthropic API.
 */

import { cuesUpTo, formatTimestamp, formatTranscript } from "../lib/truncate";
import { buildSystemPrompt, EMPTY_TRANSCRIPT_ANSWER } from "../lib/prompt";
import { STORAGE_KEYS } from "../lib/messages";
import type { AskRequest, AskResponse, StoredSubtitles } from "../lib/messages";
import { askClaude, describeApiError } from "./api";

async function handleAsk(request: AskRequest): Promise<AskResponse> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.subtitles,
  ]);

  const apiKey = stored[STORAGE_KEYS.apiKey] as string | undefined;
  if (!apiKey) {
    return {
      ok: false,
      code: "no_api_key",
      error: "No API key set. Add your Anthropic API key in CatchUp's options.",
    };
  }

  const subtitles = stored[STORAGE_KEYS.subtitles] as StoredSubtitles | undefined;
  if (!subtitles || subtitles.cues.length === 0) {
    return {
      ok: false,
      code: "no_subtitles",
      error: "No subtitles loaded. Load an .srt or .vtt file for this video first.",
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
