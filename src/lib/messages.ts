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
    }
  | {
      ok: false;
      error: "no_video";
    };

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

export const STORAGE_KEYS = {
  apiKey: "catchup.apiKey",
  subtitles: "catchup.subtitles",
} as const;
