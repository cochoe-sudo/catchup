import { describe, expect, it } from "vitest";
import type { Cue } from "../src/lib/subtitles";
import { cuesUpTo, formatTimestamp, formatTranscript } from "../src/lib/truncate";

const cue = (startMs: number, text: string): Cue => ({ startMs, endMs: startMs + 2000, text });

const CUES: Cue[] = [
  cue(0, "Opening line"),
  cue(10_000, "Second line"),
  cue(60_000, "One minute in"),
  cue(60_000, "Simultaneous line"),
  cue(3_600_000, "One hour in"),
];

describe("cuesUpTo — the spoiler boundary", () => {
  it("includes only cues that started at or before the current time", () => {
    const visible = cuesUpTo(CUES, 30_000);
    expect(visible.map((c) => c.text)).toEqual(["Opening line", "Second line"]);
  });

  it("includes a cue whose start equals the current time exactly", () => {
    const visible = cuesUpTo(CUES, 60_000);
    expect(visible.map((c) => c.text)).toContain("One minute in");
    expect(visible.map((c) => c.text)).toContain("Simultaneous line");
    expect(visible).toHaveLength(4);
  });

  it("excludes a cue that starts 1ms after the current time", () => {
    const visible = cuesUpTo(CUES, 59_999);
    expect(visible.map((c) => c.text)).not.toContain("One minute in");
  });

  it("returns only time-zero cues at t=0", () => {
    expect(cuesUpTo(CUES, 0).map((c) => c.text)).toEqual(["Opening line"]);
  });

  it("returns everything when past the last cue", () => {
    expect(cuesUpTo(CUES, 10_000_000)).toHaveLength(CUES.length);
  });

  it("shrinks correctly after seeking backward (re-truncation)", () => {
    const forward = cuesUpTo(CUES, 3_600_000);
    expect(forward).toHaveLength(5);
    const afterSeekBack = cuesUpTo(CUES, 10_000);
    expect(afterSeekBack.map((c) => c.text)).toEqual(["Opening line", "Second line"]);
  });

  it("handles empty cue lists", () => {
    expect(cuesUpTo([], 5000)).toEqual([]);
  });

  it("returns nothing for negative or non-finite times", () => {
    expect(cuesUpTo(CUES, -1)).toEqual([]);
    expect(cuesUpTo(CUES, Number.NaN)).toEqual([]);
    expect(cuesUpTo(CUES, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("sorts output even if the input is unsorted", () => {
    const unsorted = [cue(20_000, "B"), cue(5_000, "A")];
    expect(cuesUpTo(unsorted, 30_000).map((c) => c.text)).toEqual(["A", "B"]);
  });

  it("does not mutate the input array", () => {
    const input = [cue(20_000, "B"), cue(5_000, "A")];
    cuesUpTo(input, 30_000);
    expect(input.map((c) => c.text)).toEqual(["B", "A"]);
  });
});

describe("formatTimestamp", () => {
  it("formats sub-hour times as MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(62_345)).toBe("01:02");
    expect(formatTimestamp(599_000)).toBe("09:59");
  });

  it("formats hour-plus times as H:MM:SS", () => {
    expect(formatTimestamp(3_600_000)).toBe("1:00:00");
    expect(formatTimestamp(7_262_000)).toBe("2:01:02");
  });

  it("clamps negative values to zero", () => {
    expect(formatTimestamp(-500)).toBe("00:00");
  });
});

describe("formatTranscript", () => {
  it("renders one timestamped line per cue", () => {
    const out = formatTranscript([cue(1000, "Hello."), cue(65_000, "Bye.")]);
    expect(out).toBe("[00:01] Hello.\n[01:05] Bye.");
  });

  it("renders empty string for no cues", () => {
    expect(formatTranscript([])).toBe("");
  });
});
