/**
 * Generic subtitle capture for ANY site whose player uses native HTML5
 * text tracks (<track> elements / TextTrack API). Runs in the PAGE (MAIN)
 * world on all sites except YouTube/Netflix, which have dedicated scripts.
 *
 * Strategy: periodically scan videos' textTracks; nudge disabled
 * subtitle/caption tracks to "hidden" so the browser loads their cues
 * without rendering them; accumulate cues (players often add them
 * progressively) and ship the cumulative set to the content script.
 *
 * ZERO runtime imports — this bundles as a classic script.
 */

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w["__catchupTextTracks"]) return; // double-injection guard
  w["__catchupTextTracks"] = true;

  const EVENT_SUBS = "catchup:subtitles";
  const EVENT_PING = "catchup:ready";

  /** Must mirror the content script's generic key. */
  const videoKey = (): string => `gen:${location.host}${location.pathname}`;

  interface CollectedCue {
    startMs: number;
    endMs: number;
    text: string;
  }

  // Cumulative cues for the current videoKey.
  let collectedFor = "";
  const collected = new Map<string, CollectedCue>();
  let trackLabel = "captions";
  let lastSentCount = 0;
  let lastDetail: string | null = null;

  function isSubtitleTrack(track: TextTrack): boolean {
    // Some players leave kind empty; treat that as subtitles too.
    const kind = track.kind as string;
    return kind === "subtitles" || kind === "captions" || kind === "";
  }

  function preferEnglish(tracks: TextTrack[]): TextTrack[] {
    const en = tracks.filter((t) => (t.language ?? "").toLowerCase().startsWith("en"));
    return en.length > 0 ? en : tracks;
  }

  function scan(): void {
    if (document.hidden) return;

    const key = videoKey();
    if (key !== collectedFor) {
      collectedFor = key;
      collected.clear();
      lastSentCount = 0;
      lastDetail = null;
    }

    const subtitleTracks: TextTrack[] = [];
    for (const video of Array.from(document.querySelectorAll("video"))) {
      for (const track of Array.from(video.textTracks ?? [])) {
        if (isSubtitleTrack(track)) subtitleTracks.push(track);
      }
    }
    if (subtitleTracks.length === 0) return;

    for (const track of preferEnglish(subtitleTracks)) {
      // "disabled" tracks have no cues loaded; "hidden" loads them invisibly.
      // Leave "showing" tracks alone — the user turned them on.
      if (track.mode === "disabled") {
        try {
          track.mode = "hidden";
        } catch {
          continue;
        }
      }
      const cues = track.cues;
      if (!cues || cues.length === 0) continue;
      if (track.label || track.language) {
        trackLabel = track.label || track.language;
      }
      for (const cue of Array.from(cues)) {
        const vtt = cue as VTTCue;
        if (typeof vtt.text !== "string" || !Number.isFinite(vtt.startTime)) continue;
        const startMs = Math.round(vtt.startTime * 1000);
        const endMs = Math.round((Number.isFinite(vtt.endTime) ? vtt.endTime : vtt.startTime) * 1000);
        const text = vtt.text.trim();
        if (!text) continue;
        collected.set(`${startMs}|${text}`, { startMs, endMs, text });
      }
    }

    if (collected.size > lastSentCount) {
      lastSentCount = collected.size;
      const cueList = Array.from(collected.values()).sort((a, b) => a.startMs - b.startMs);
      lastDetail = JSON.stringify({
        videoKey: key,
        label: `${trackLabel} · captured from player`,
        cues: cueList,
      });
      document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
    }
  }

  document.addEventListener(EVENT_PING, () => {
    if (lastDetail) document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
  });

  window.setInterval(scan, 3000);
})();
