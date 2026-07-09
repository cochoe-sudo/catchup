/**
 * YouTube auto-caption capture. Runs in the PAGE (MAIN) world at
 * document_start — it needs the page's `ytInitialPlayerResponse` /
 * `#movie_player` player API, which isolated content scripts can't touch.
 *
 * Flow: poll for the current video's caption track list, fetch the best
 * track as WebVTT (same-origin, page's own cookies), and hand the raw VTT
 * to the content script via a DOM CustomEvent (detail is a JSON string —
 * plain strings cross the isolated-world boundary reliably).
 *
 * ZERO runtime imports — this bundles as a classic script.
 */

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w["__catchupYouTube"]) return; // double-injection guard
  w["__catchupYouTube"] = true;

  const EVENT_SUBS = "catchup:subtitles";
  const EVENT_PING = "catchup:ready";

  let deliveredVideoId: string | null = null;
  let lastDetail: string | null = null;

  const currentVideoId = (): string | null =>
    new URLSearchParams(location.search).get("v");

  interface YtTrack {
    baseUrl?: string;
    languageCode?: string;
    kind?: string; // "asr" = auto-generated
    name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  }

  function trackLabel(track: YtTrack): string {
    return (
      track.name?.simpleText ??
      track.name?.runs?.map((r) => r.text ?? "").join("") ??
      track.languageCode ??
      "captions"
    );
  }

  /** Prefer human-made English, then auto English, then any human-made, then anything. */
  function pickTrack(tracks: YtTrack[]): YtTrack | undefined {
    const isEn = (t: YtTrack) => (t.languageCode ?? "").toLowerCase().startsWith("en");
    return (
      tracks.find((t) => isEn(t) && t.kind !== "asr") ??
      tracks.find((t) => isEn(t)) ??
      tracks.find((t) => t.kind !== "asr") ??
      tracks[0]
    );
  }

  function publish(detail: string): void {
    lastDetail = detail;
    document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail }));
  }

  async function attempt(): Promise<void> {
    const videoId = currentVideoId();
    if (!videoId || deliveredVideoId === videoId) return;

    // Player API first (correct after SPA navigations), initial data as fallback.
    const player = document.getElementById("movie_player") as unknown as {
      getPlayerResponse?: () => unknown;
    } | null;
    const pr = (player?.getPlayerResponse?.() ??
      (window as unknown as Record<string, unknown>)["ytInitialPlayerResponse"]) as
      | {
          videoDetails?: { videoId?: string };
          captions?: {
            playerCaptionsTracklistRenderer?: { captionTracks?: YtTrack[] };
          };
        }
      | undefined;

    // Stale response from the previous video — wait for the player to catch up.
    if (pr?.videoDetails?.videoId !== videoId) return;

    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return;
    const track = pickTrack(tracks);
    if (!track?.baseUrl) return;

    deliveredVideoId = videoId; // claim before the await so we don't double-fetch
    try {
      const res = await fetch(track.baseUrl + "&fmt=vtt");
      const vtt = await res.text();
      if (!vtt.includes("-->")) {
        deliveredVideoId = null; // empty/blocked response — retry later
        return;
      }
      publish(
        JSON.stringify({
          videoKey: `yt:${videoId}`,
          label: `${trackLabel(track)} · YouTube captions`,
          vtt,
        }),
      );
    } catch {
      deliveredVideoId = null;
    }
  }

  // Content script may attach its listener after we've already published.
  document.addEventListener(EVENT_PING, () => {
    if (lastDetail) document.dispatchEvent(new CustomEvent(EVENT_SUBS, { detail: lastDetail }));
  });

  window.addEventListener("yt-navigate-finish", () => {
    deliveredVideoId = null;
    lastDetail = null;
    void attempt();
  });

  window.setInterval(() => void attempt(), 2000);
  void attempt();
})();
