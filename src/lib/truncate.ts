/**
 * Spoiler boundary: given the full cue list and the viewer's current playback
 * position, produce only the dialogue the viewer has already reached.
 *
 * This is the load-bearing spoiler-safety logic — a cue is included iff it has
 * STARTED at or before the current time (startMs <= currentTimeMs). A line
 * currently being spoken is included; anything that starts later is not.
 * Callers must re-run this on every question so seeking in either direction
 * always yields the correct window.
 */

import type { Cue } from "./subtitles";

/** Cues the viewer has reached, sorted by start time. */
export function cuesUpTo(cues: Cue[], currentTimeMs: number): Cue[] {
  if (!Number.isFinite(currentTimeMs) || currentTimeMs < 0) return [];
  return cues
    .filter((cue) => cue.startMs <= currentTimeMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** "MM:SS" under an hour, "H:MM:SS" above. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Render cues as "[MM:SS] line" transcript text for the model. */
export function formatTranscript(cues: Cue[]): string {
  return cues.map((cue) => `[${formatTimestamp(cue.startMs)}] ${cue.text}`).join("\n");
}
