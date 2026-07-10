/**
 * Generic subtitle capture for ANY streaming site (all sites except
 * YouTube/Netflix, which have dedicated scripts). Runs in the PAGE (MAIN)
 * world at document_start. Two complementary strategies:
 *
 * 1. Native textTracks: nudge disabled subtitle/caption tracks to "hidden"
 *    so the browser loads their cues, then harvest them. Covers players
 *    built on <track>/TextTrack (Vimeo, many broadcasters, course sites).
 *
 * 2. Network sniffing: hook fetch + XMLHttpRequest and capture any
 *    WebVTT/TTML subtitle payloads the player downloads itself. Covers
 *    players that render captions with custom DOM (HBO Max, Hulu, Disney+,
 *    Peacock, ...). Subtitles usually arrive as segments during playback, so
 *    payloads are sent with mode:"merge" and accumulate server-side.
 *    NOTE: these players typically only download subtitles when captions
 *    are turned ON in the player.
 *
 * ZERO runtime imports — this bundles as a classic script. Every hook is
 * wrapped in try/catch: breaking the host page is never acceptable.
 */

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w["__catchupGeneric"]) return; // double-injection guard
  w["__catchupGeneric"] = true;

  const EVENT_SUBS = "catchup:subtitles";
  const EVENT_PING = "catchup:ready";
  const MAX_SNIFF_BYTES = 3_000_000;

  /** Must mirror the content script's generic key. */
  const videoKey = (): string => `gen:${location.host}${location.pathname}`;

  let lastDetail: string | null = null;

  function send(payload: {
    videoKey: string;
    label: string;
    vtt?: string;
    cues?: Array<{ startMs: number; endMs: number; text: string }>;
    mode: "merge";
  }): void {
    lastDetail = JSON.stringify(payload);
    document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
  }

  document.addEventListener(EVENT_PING, () => {
    if (lastDetail) document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
  });

  // --- strategy 1: native textTracks ---------------------------------------

  interface CollectedCue {
    startMs: number;
    endMs: number;
    text: string;
  }

  let collectedFor = "";
  const collected = new Map<string, CollectedCue>();
  let trackLabel = "captions";
  let lastSentCount = 0;

  function isSubtitleTrack(track: TextTrack): boolean {
    // Some players leave kind empty; treat that as subtitles too.
    const kind = track.kind as string;
    return kind === "subtitles" || kind === "captions" || kind === "";
  }

  function preferEnglish(tracks: TextTrack[]): TextTrack[] {
    const en = tracks.filter((t) => (t.language ?? "").toLowerCase().startsWith("en"));
    return en.length > 0 ? en : tracks;
  }

  function scanTextTracks(): void {
    if (document.hidden) return;

    const key = videoKey();
    if (key !== collectedFor) {
      collectedFor = key;
      collected.clear();
      lastSentCount = 0;
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
        const endMs = Math.round(
          (Number.isFinite(vtt.endTime) ? vtt.endTime : vtt.startTime) * 1000,
        );
        const text = vtt.text.trim();
        if (!text) continue;
        collected.set(`${startMs}|${text}`, { startMs, endMs, text });
      }
    }

    if (collected.size > lastSentCount) {
      lastSentCount = collected.size;
      send({
        videoKey: key,
        label: `${trackLabel} · captured from player`,
        cues: Array.from(collected.values()).sort((a, b) => a.startMs - b.startMs),
        mode: "merge",
      });
    }
  }

  window.setInterval(scanTextTracks, 3000);

  // --- strategy 2: network sniffing (fetch + XHR) ---------------------------

  const seenPayloads = new Set<string>();

  /** Cheap check + dedupe, then ship raw text to the background for parsing. */
  function maybeCapture(url: string, text: string): void {
    if (!text || text.length > MAX_SNIFF_BYTES) return;
    const head = text.slice(0, 600).trimStart();
    const isVtt = head.startsWith("WEBVTT") && text.includes("-->");
    const isSrt = /^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(head);
    const isTtml =
      (head.startsWith("<?xml") || head.startsWith("<tt")) &&
      /<tt[\s>]/.test(head) &&
      text.includes("begin=");
    if (!isVtt && !isSrt && !isTtml) return;

    // Same segment fetched twice (seeks, retries) — skip re-sends.
    const signature = `${url.split("?")[0]}:${text.length}:${text.slice(0, 80)}`;
    if (seenPayloads.has(signature)) return;
    seenPayloads.add(signature);

    send({
      videoKey: videoKey(),
      label: "captions · captured from stream",
      vtt: text,
      mode: "merge",
    });
  }

  const TEXTUAL_CT = /vtt|ttml|dfxp|xml|text\/plain/i;
  const SUBTITLE_URL = /\.(vtt|ttml|dfxp|srt|xml)(\?|$)|caption|subtitle|timedtext/i;

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const promise = originalFetch(input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input?.url ?? "");
      promise
        .then((response) => {
          try {
            const contentType = response.headers.get("content-type") ?? "";
            const length = parseInt(response.headers.get("content-length") ?? "0", 10);
            if (length > MAX_SNIFF_BYTES) return;
            if (!TEXTUAL_CT.test(contentType) && !SUBTITLE_URL.test(url)) return;
            response
              .clone()
              .text()
              .then((text) => maybeCapture(url, text))
              .catch(() => {});
          } catch {
            /* never break the page */
          }
        })
        .catch(() => {});
    } catch {
      /* never break the page */
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __catchupUrl?: string },
    ...args: Parameters<XMLHttpRequest["open"]>
  ) {
    try {
      this.__catchupUrl = String(args[1] ?? "");
    } catch {
      /* never break the page */
    }
    return originalOpen.apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __catchupUrl?: string },
    ...args: Parameters<XMLHttpRequest["send"]>
  ) {
    try {
      this.addEventListener("load", () => {
        try {
          const url = this.__catchupUrl ?? "";
          if (this.responseType === "" || this.responseType === "text") {
            maybeCapture(url, this.responseText);
          } else if (
            this.responseType === "arraybuffer" &&
            this.response instanceof ArrayBuffer &&
            this.response.byteLength > 0 &&
            this.response.byteLength <= MAX_SNIFF_BYTES &&
            SUBTITLE_URL.test(url)
          ) {
            maybeCapture(url, new TextDecoder().decode(this.response));
          }
        } catch {
          /* never break the page */
        }
      });
    } catch {
      /* never break the page */
    }
    return originalSend.apply(this, args);
  };
})();
