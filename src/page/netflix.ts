/**
 * Netflix auto-subtitle capture. Runs in the PAGE (MAIN) world at
 * document_start.
 *
 * Netflix's player fetches a play manifest that lists timed-text tracks,
 * including ready-to-fetch WebVTT downloadables. The manifest passes through
 * JSON.parse in the page, so we hook JSON.parse (the long-standing
 * Subadub technique), remember tracks per movieId, then fetch the best
 * track's WebVTT and hand it to the content script via a DOM CustomEvent.
 *
 * ZERO runtime imports — this bundles as a classic script.
 */

(() => {
  const EVENT_SUBS = "catchup:subtitles";
  const EVENT_PING = "catchup:ready";
  const WEBVTT_FMT = "webvtt-lssdh-ios8";

  interface NfTrack {
    language?: string;
    languageDescription?: string;
    isNoneTrack?: boolean;
    isForcedNarrative?: boolean;
    rawTrackType?: string;
    ttDownloadables?: Record<
      string,
      { urls?: Array<string | { url?: string }>; downloadUrls?: Record<string, string> }
    >;
  }

  const tracksByMovieId = new Map<string, NfTrack[]>();
  let deliveredMovieId: string | null = null;
  let lastDetail: string | null = null;

  // --- manifest sniffing ----------------------------------------------------

  function scan(value: unknown): void {
    const v = value as { result?: { movieId?: unknown; timedtexttracks?: unknown }; movieId?: unknown; timedtexttracks?: unknown } | null;
    const manifest =
      v?.result && v.result.movieId !== undefined ? v.result : v?.movieId !== undefined ? v : null;
    if (!manifest || !Array.isArray(manifest.timedtexttracks)) return;
    tracksByMovieId.set(String(manifest.movieId), manifest.timedtexttracks as NfTrack[]);
  }

  const originalParse = JSON.parse.bind(JSON);
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = originalParse(text, reviver);
    try {
      scan(value);
    } catch {
      // never let sniffing break the page
    }
    return value;
  }) as typeof JSON.parse;

  // --- track selection & delivery -------------------------------------------

  const currentMovieId = (): string | null =>
    /\/watch\/(\d+)/.exec(location.pathname)?.[1] ?? null;

  /** WebVTT URLs for a track; handles both downloadable shapes Netflix has used. */
  function vttUrls(track: NfTrack): string[] {
    const dl = track.ttDownloadables?.[WEBVTT_FMT];
    if (!dl) return [];
    if (Array.isArray(dl.urls)) {
      return dl.urls
        .map((u) => (typeof u === "string" ? u : u?.url))
        .filter((u): u is string => typeof u === "string");
    }
    if (dl.downloadUrls && typeof dl.downloadUrls === "object") {
      return Object.values(dl.downloadUrls).filter((u): u is string => typeof u === "string");
    }
    return [];
  }

  /** Prefer English subtitles, then English CC, then anything usable. */
  function pickTrack(tracks: NfTrack[]): NfTrack | undefined {
    const usable = tracks.filter(
      (t) => !t.isNoneTrack && !t.isForcedNarrative && vttUrls(t).length > 0,
    );
    const english = usable.filter((t) => (t.language ?? "").toLowerCase().startsWith("en"));
    return (
      english.find((t) => t.rawTrackType !== "closedcaptions") ?? english[0] ?? usable[0]
    );
  }

  function publish(detail: string): void {
    lastDetail = detail;
    document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail }));
  }

  async function attempt(): Promise<void> {
    const movieId = currentMovieId();
    if (!movieId || deliveredMovieId === movieId) return;
    const tracks = tracksByMovieId.get(movieId);
    if (!tracks) return;
    const track = pickTrack(tracks);
    const url = track ? vttUrls(track)[0] : undefined;
    if (!track || !url) return;

    deliveredMovieId = movieId; // claim before the await so we don't double-fetch
    try {
      const res = await fetch(url);
      const vtt = await res.text();
      if (!vtt.includes("-->")) {
        deliveredMovieId = null;
        return;
      }
      publish(
        JSON.stringify({
          videoKey: `nf:${movieId}`,
          label: `${track.languageDescription ?? track.language ?? "subtitles"} · Netflix subtitles`,
          vtt,
        }),
      );
    } catch {
      deliveredMovieId = null;
    }
  }

  document.addEventListener(EVENT_PING, () => {
    if (lastDetail) document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
  });

  window.setInterval(() => void attempt(), 2000);
})();
