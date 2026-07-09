/**
 * Message contracts between popup <-> content script <-> background.
 * Types only — the content script may import from here ONLY with
 * `import type` (content scripts can't load ES modules at runtime).
 */

import type { Cue } from "./subtitles";

// ---- popup -> content script ----

export interface GetStateRequest {
  type: "CATCHUP_GET_STATE";
}

export type GetStateResponse =
  | {
      ok: true;
      title: string;
      currentTimeSec: number;
      paused: boolean;
      /** Stable per-video id ("yt:<videoId>" / "nf:<movieId>") or null. */
      videoKey: string | null;
    }
  | {
      ok: false;
      error: "no_video";
    };

// ---- content script -> background (auto-captured subtitles) ----

export interface AutoSubsMessage {
  type: "CATCHUP_AUTO_SUBS";
  videoKey: string;
  label: string;
  /** Raw WebVTT text captured from the page. */
  vtt: string;
}

// ---- popup -> background ----

export interface ChatTurn {
  question: string;
  answer: string;
}

export interface AskRequest {
  type: "CATCHUP_ASK";
  title: string;
  currentTimeSec: number;
  question: string;
  history: ChatTurn[];
  /** Used to look up auto-captured subtitles for this exact video. */
  videoKey: string | null;
}

export type AskResponse =
  | { ok: true; answer: string }
  | { ok: false; error: string; code?: "no_api_key" | "no_subtitles" };

// ---- chrome.storage.local shapes ----

export interface StoredSubtitles {
  /** User-facing label: file name or "pasted subtitles". */
  label: string;
  cues: Cue[];
  savedAt: number;
}

export type Provider = "anthropic" | "gemini";

export const STORAGE_KEYS = {
  /** Which answer engine to use. Defaults to "anthropic". */
  provider: "catchup.provider",
  apiKey: "catchup.apiKey",
  geminiKey: "catchup.geminiKey",
  /** Manually loaded subtitles — global fallback when no per-video entry exists. */
  subtitles: "catchup.subtitles",
  /** Record<videoKey, StoredSubtitles> — auto-captured (and keyed manual) subtitles. */
  subsByVideo: "catchup.subsByVideo",
} as const;

/** Keep the per-video store bounded (LRU by savedAt). */
export const MAX_STORED_VIDEOS = 8;
