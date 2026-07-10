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

// ---------------------------------------------------------------------------
// TTML (a.k.a. DFXP / SMPTE-TT) — the XML subtitle format several streaming
// services deliver instead of WebVTT. Parsed with regexes because service
// workers have no DOMParser.
// ---------------------------------------------------------------------------

/**
 * Parse a TTML time expression to milliseconds.
 * Supports clock times ("HH:MM:SS", "HH:MM:SS.mmm", "HH:MM:SS:frames") and
 * offset times ("123.4s", "5400ms", "2.5h", "90m", "300f", "107607500t").
 */
export function parseTTMLTime(
  raw: string,
  tickRate: number,
  frameRate: number,
): number | null {
  const trimmed = raw.trim();

  const offset = /^([\d.]+)(h|ms|m|s|f|t)$/.exec(trimmed);
  if (offset) {
    const value = parseFloat(offset[1]!);
    if (!Number.isFinite(value)) return null;
    switch (offset[2]) {
      case "h":
        return Math.round(value * 3_600_000);
      case "m":
        return Math.round(value * 60_000);
      case "s":
        return Math.round(value * 1000);
      case "ms":
        return Math.round(value);
      case "f":
        return Math.round((value / frameRate) * 1000);
      case "t":
        return Math.round((value / tickRate) * 1000);
    }
  }

  // Clock time: HH:MM:SS | HH:MM:SS.fraction | HH:MM:SS:frames
  const clock = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?(?::(\d+))?$/.exec(trimmed);
  if (!clock) return null;
  const hours = parseInt(clock[1]!, 10);
  const minutes = parseInt(clock[2]!, 10);
  const seconds = parseInt(clock[3]!, 10);
  if (minutes >= 60 || seconds >= 60) return null;
  let ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  if (clock[4]) ms += Math.round(parseFloat(`0.${clock[4]}`) * 1000);
  if (clock[5]) ms += Math.round((parseInt(clock[5], 10) / frameRate) * 1000);
  return ms;
}

/** Parse a TTML/DFXP document into time-sorted cues. Throws if none found. */
export function parseTTML(input: string): Cue[] {
  const ttTag = /<tt[\s>][^>]*/i.exec(input)?.[0] ?? "";
  const tickRate =
    parseFloat(/ttp:tickRate="([\d.]+)"/i.exec(ttTag)?.[1] ?? "") || 10_000_000;
  const frameRate = parseFloat(/ttp:frameRate="([\d.]+)"/i.exec(ttTag)?.[1] ?? "") || 30;

  const cues: Cue[] = [];
  const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    const attrs = match[1]!;
    const begin = /begin="([^"]+)"/.exec(attrs)?.[1];
    if (!begin) continue;
    const end = /end="([^"]+)"/.exec(attrs)?.[1];
    const startMs = parseTTMLTime(begin, tickRate, frameRate);
    if (startMs === null) continue;
    const endMs = (end ? parseTTMLTime(end, tickRate, frameRate) : null) ?? startMs;

    const text = cleanCueText(match[2]!.replace(/<br\s*\/?>/gi, "\n").split("\n"));
    if (!text) continue;
    cues.push({ startMs, endMs, text });
  }

  if (cues.length === 0) {
    throw new Error("No subtitle cues found in the TTML document.");
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/** Parse any supported subtitle text: SRT, WebVTT, or TTML/DFXP. */
export function parseSubtitleText(input: string): Cue[] {
  if (/<tt[\s>]/i.test(input.slice(0, 3000))) return parseTTML(input);
  return parseSubtitles(input);
}
