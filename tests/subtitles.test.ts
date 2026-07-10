import { describe, expect, it } from "vitest";
import {
  parseSubtitles,
  parseSubtitleText,
  parseTimestamp,
  parseTTML,
  parseTTMLTime,
} from "../src/lib/subtitles";

describe("parseTimestamp", () => {
  it("parses SRT comma format", () => {
    expect(parseTimestamp("00:01:02,345")).toBe(62_345);
  });

  it("parses VTT dot format", () => {
    expect(parseTimestamp("00:01:02.345")).toBe(62_345);
  });

  it("parses VTT short MM:SS.mmm (no hours)", () => {
    expect(parseTimestamp("01:02.345")).toBe(62_345);
  });

  it("parses multi-hour timestamps", () => {
    expect(parseTimestamp("02:10:00,000")).toBe(7_800_000);
  });

  it("pads short millisecond fields", () => {
    expect(parseTimestamp("00:00:01,5")).toBe(1_500);
  });

  it("rejects garbage and out-of-range fields", () => {
    expect(parseTimestamp("not a time")).toBeNull();
    expect(parseTimestamp("00:99:00,000")).toBeNull();
    expect(parseTimestamp("00:00:75,000")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
});

const BASIC_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there.

2
00:00:04,500 --> 00:00:06,000
- Where were you?
- At the hospital.

3
00:01:10,000 --> 00:01:12,000
<i>She never told him.</i>
`;

const BASIC_VTT = `WEBVTT

NOTE This is a comment that must be skipped.

00:01.000 --> 00:03.000 position:50% align:middle
Hello there.

STYLE
::cue { color: yellow }

intro-cue-2
00:00:04.500 --> 00:00:06.000
<v Hannah>Where were you?</v>
`;

describe("parseSubtitles — SRT", () => {
  it("parses cues with correct times and text", () => {
    const cues = parseSubtitles(BASIC_SRT);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 3000, text: "Hello there." });
    expect(cues[1]!.startMs).toBe(4500);
    expect(cues[1]!.text).toBe("- Where were you? - At the hospital.");
  });

  it("strips HTML tags", () => {
    const cues = parseSubtitles(BASIC_SRT);
    expect(cues[2]!.text).toBe("She never told him.");
  });

  it("handles CRLF line endings", () => {
    const cues = parseSubtitles(BASIC_SRT.replace(/\n/g, "\r\n"));
    expect(cues).toHaveLength(3);
    expect(cues[0]!.text).toBe("Hello there.");
  });

  it("handles a UTF-8 BOM", () => {
    const cues = parseSubtitles("﻿" + BASIC_SRT);
    expect(cues).toHaveLength(3);
  });

  it("accepts dot milliseconds in SRT-style files", () => {
    const cues = parseSubtitles("1\n00:00:01.000 --> 00:00:02.000\nHi\n");
    expect(cues[0]!.startMs).toBe(1000);
  });

  it("skips malformed blocks but keeps valid ones", () => {
    const mixed = `1
garbage --> also garbage
Broken cue

2
00:00:05,000 --> 00:00:06,000
Survivor line

just some text with no timing
`;
    const cues = parseSubtitles(mixed);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Survivor line");
  });

  it("drops cues with empty text", () => {
    const srt = `1
00:00:01,000 --> 00:00:02,000
<i></i>

2
00:00:03,000 --> 00:00:04,000
Real line
`;
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(1);
  });

  it("decodes common HTML entities", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry &lt;3\n");
    expect(cues[0]!.text).toBe("Tom & Jerry <3");
  });

  it("strips directional marks found in Netflix WebVTT", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n&lrm;Hello there.&rlm;\n");
    expect(cues[0]!.text).toBe("Hello there.");
  });

  it("strips ASS-style override braces", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Sign text\n");
    expect(cues[0]!.text).toBe("Sign text");
  });

  it("sorts out-of-order cues by start time", () => {
    const srt = `1
00:02:00,000 --> 00:02:01,000
Second

2
00:01:00,000 --> 00:01:01,000
First
`;
    const cues = parseSubtitles(srt);
    expect(cues.map((c) => c.text)).toEqual(["First", "Second"]);
  });

  it("throws on input with no cues", () => {
    expect(() => parseSubtitles("this is not a subtitle file")).toThrow(/No subtitle cues/);
    expect(() => parseSubtitles("")).toThrow(/No subtitle cues/);
  });
});

describe("parseTTMLTime", () => {
  const t = (raw: string) => parseTTMLTime(raw, 10_000_000, 30);

  it("parses clock times with fractions", () => {
    expect(t("00:01:02")).toBe(62_000);
    expect(t("00:01:02.345")).toBe(62_345);
    expect(t("01:00:00.5")).toBe(3_600_500);
  });

  it("parses frame-based clock times", () => {
    expect(t("00:00:02:15")).toBe(2_500); // 15 frames @ 30fps = 500ms
  });

  it("parses offset times in every unit", () => {
    expect(t("90s")).toBe(90_000);
    expect(t("1500ms")).toBe(1_500);
    expect(t("2m")).toBe(120_000);
    expect(t("1.5h")).toBe(5_400_000);
    expect(t("60f")).toBe(2_000); // 60 frames @ 30fps
    expect(t("107607500t")).toBe(10_761); // ticks @ 10,000,000/s
  });

  it("rejects garbage", () => {
    expect(t("later")).toBeNull();
    expect(t("00:99:00")).toBeNull();
  });
});

const BASIC_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <body><div>
    <p begin="10000000t" end="30000000t">Hello <span tts:fontStyle="italic">there</span>.</p>
    <p begin="00:00:04.500" end="00:00:06.000">Where were you?<br/>At the hospital.</p>
    <p begin="00:00:09.000" end="00:00:10.000"></p>
    <p end="00:00:12.000">no begin, skipped</p>
  </div></body>
</tt>`;

describe("parseTTML", () => {
  it("parses cues with tick and clock times, strips spans, converts <br>", () => {
    const cues = parseTTML(BASIC_TTML);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 3000, text: "Hello there." });
    expect(cues[1]!.startMs).toBe(4500);
    expect(cues[1]!.text).toBe("Where were you? At the hospital.");
  });

  it("throws when no cues are present", () => {
    expect(() => parseTTML("<tt></tt>")).toThrow(/No subtitle cues/);
  });
});

describe("parseSubtitleText — format dispatch", () => {
  it("routes TTML documents to the TTML parser", () => {
    expect(parseSubtitleText(BASIC_TTML)).toHaveLength(2);
  });

  it("routes VTT and SRT to the cue-block parser", () => {
    expect(parseSubtitleText(BASIC_VTT)).toHaveLength(2);
    expect(parseSubtitleText(BASIC_SRT)).toHaveLength(3);
  });
});

describe("parseSubtitles — VTT", () => {
  it("parses cues, skipping WEBVTT/NOTE/STYLE blocks and cue settings", () => {
    const cues = parseSubtitles(BASIC_VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 3000, text: "Hello there." });
  });

  it("converts voice spans to speaker labels", () => {
    const cues = parseSubtitles(BASIC_VTT);
    expect(cues[1]!.text).toBe("Hannah: Where were you?");
  });

  it("handles cue identifiers before the timing line", () => {
    const vtt = `WEBVTT

chapter-1
00:10.000 --> 00:12.000
Named cue text
`;
    const cues = parseSubtitles(vtt);
    expect(cues[0]!.startMs).toBe(10_000);
    expect(cues[0]!.text).toBe("Named cue text");
  });
});
