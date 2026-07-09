/**
 * SRT / WebVTT subtitle parsing.
 *
 * Both formats are cue-block based:
 *   [optional index / cue id]
 *   HH:MM:SS,mmm --> HH:MM:SS,mmm   (SRT uses ",", VTT uses "."; VTT hours optional)
 *   text line(s)
 *
 * The parser is deliberately lenient: it scans for any block containing a
 * "-->" timing line, skips VTT metadata blocks (WEBVTT/NOTE/STYLE/REGION),
 * and silently drops malformed blocks rather than failing the whole file.
 */

export interface Cue {
  /** Cue start, milliseconds from the beginning of the video. */
  startMs: number;
  /** Cue end, milliseconds from the beginning of the video. */
  endMs: number;
  /** Cleaned dialogue text (tags stripped, lines joined). */
  text: string;
}

/**
 * Parse a single subtitle timestamp into milliseconds.
 * Accepts "HH:MM:SS,mmm", "HH:MM:SS.mmm", and VTT's short "MM:SS.mmm".
 * Returns null for anything that doesn't look like a timestamp.
 */
export function parseTimestamp(raw: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] !== undefined ? parseInt(match[1], 10) : 0;
  const minutes = parseInt(match[2]!, 10);
  const seconds = parseInt(match[3]!, 10);
  // Spec says 3 digits; pad short fractions ("5" -> 500ms) rather than misread them.
  const ms = parseInt(match[4]!.padEnd(3, "0"), 10);
  if (minutes >= 60 || seconds >= 60) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  // Directional marks — Netflix WebVTT files are littered with these.
  "&lrm;": "",
  "&rlm;": "",
};

function cleanCueText(lines: string[]): string {
  return lines
    .join(" ")
    // VTT voice spans: <v Hannah>hi</v> -> "Hannah: hi"
    .replace(/<v(?:\.[^\s>]*)?\s+([^>]+)>/gi, "$1: ")
    // Remaining tags: <i>, <b>, <c.classname>, </v>, font tags from SRT...
    .replace(/<[^>]*>/g, "")
    // ASS/SSA style overrides sometimes left in SRT rips: {\an8} etc.
    .replace(/\{[^}]*\}/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

/** Clean a single cue's raw text (tags, entities, whitespace) — for cue payloads captured via the TextTrack API. */
export function sanitizeCueText(text: string): string {
  return cleanCueText(text.split("\n"));
}

const VTT_METADATA_BLOCK = /^(WEBVTT|NOTE|STYLE|REGION)\b/;

/**
 * Parse SRT or WebVTT text into time-sorted cues.
 * Throws if no cues can be extracted (wrong file / not a subtitle file).
 */
export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || VTT_METADATA_BLOCK.test(trimmed)) continue;

    const lines = trimmed.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const timingLine = lines[timingIndex]!;
    const [startRaw, endPart] = timingLine.split("-->");
    if (startRaw === undefined || endPart === undefined) continue;
    // VTT allows cue settings after the end time: "00:04.000 position:50%"
    const endRaw = endPart.trim().split(/\s+/)[0] ?? "";

    const startMs = parseTimestamp(startRaw);
    const endMs = parseTimestamp(endRaw);
    if (startMs === null || endMs === null) continue;

    const textLines = lines.slice(timingIndex + 1);
    const cueText = cleanCueText(textLines);
    if (!cueText) continue;

    cues.push({ startMs, endMs, text: cueText });
  }

  if (cues.length === 0) {
    throw new Error(
      "No subtitle cues found. Make sure the file is a valid .srt or .vtt subtitle file.",
    );
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
