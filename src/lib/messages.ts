/**
 * Message contracts between content script <-> background, plus storage keys.
 * Types only — the content and page scripts may import from here ONLY with
 * `import type` (they can't load ES modules at runtime).
 */

import type { Cue } from "./subtitles";

// ---- background -> content script ----

export interface ToggleSidebarMessage {
  type: "CATCHUP_TOGGLE";
}

// ---- content script -> background ----

export interface OpenOptionsMessage {
  type: "CATCHUP_OPEN_OPTIONS";
}

/** Captured subtitles: raw subtitle text (SRT/VTT/TTML) or pre-extracted cues. */
export interface AutoSubsMessage {
  type: "CATCHUP_AUTO_SUBS";
  videoKey: string;
  label: string;
  /** Raw SRT/VTT/TTML text to parse. */
  vtt?: string;
  /** Already-extracted cues (from the generic textTracks capture). */
  cues?: Cue[];
  /**
   * "replace" (default): this payload is the complete subtitle set.
   * "merge": union with what's already stored — used for network-sniffed
   * segments and progressive textTracks, which arrive piecemeal.
   */
  mode?: "replace" | "merge";
}

export type AutoSubsResponse = { ok: true; lines: number } | { ok: false; error: string };

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
  /** Used to look up captured subtitles for this exact video. */
  videoKey: string | null;
}

export type AskResponse =
  | { ok: true; answer: string }
  | { ok: false; error: string; code?: "no_api_key" | "no_subtitles" };

// ---- chrome.storage.local shapes ----

export interface StoredSubtitles {
  /** User-facing label: track name, file name, etc. */
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
  /** Record<videoKey, StoredSubtitles> — captured (and keyed manual) subtitles. */
  subsByVideo: "catchup.subsByVideo",
} as const;

/** Keep the per-video store bounded (LRU by savedAt). */
export const MAX_STORED_VIDEOS = 8;
