/**
 * Content script for Netflix and YouTube.
 *
 * IMPORTANT: this file must have ZERO runtime imports — MV3 content scripts
 * are classic scripts, not ES modules. `import type` only.
 */

import type { AutoSubsMessage, GetStateRequest, GetStateResponse } from "../lib/messages";

/** The main playback <video>, or null. Prefers YouTube's main player, then the largest video with media loaded (skips ad/preview players). */
function findMainVideo(): HTMLVideoElement | null {
  const ytMain = document.querySelector<HTMLVideoElement>("video.html5-main-video");
  if (ytMain) return ytMain;

  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const video of videos) {
    if (video.readyState === 0) continue;
    const rect = video.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best ?? videos[0] ?? null;
}

function detectTitle(): string {
  const host = location.hostname;

  if (host.includes("netflix.com")) {
    // Player overlay title (visible when controls are shown / recently shown).
    const overlay = document.querySelector('[data-uia="video-title"]');
    const overlayText = overlay?.textContent?.trim();
    if (overlayText) return overlayText;
    const docTitle = document.title.replace(/^Watch\s+/i, "").replace(/\s*[-|]\s*Netflix.*$/i, "").trim();
    return docTitle || "Unknown title";
  }

  if (host.includes("youtube.com")) {
    const heading = document.querySelector("ytd-watch-metadata h1");
    const headingText = heading?.textContent?.trim();
    if (headingText) return headingText;
    const docTitle = document.title.replace(/\s*-\s*YouTube$/i, "").trim();
    return docTitle || "Unknown title";
  }

  return document.title || "Unknown title";
}

/** Stable per-video key, matching what the page-world capture scripts emit. */
function computeVideoKey(): string | null {
  const host = location.hostname;
  if (host.includes("youtube.com")) {
    const videoId = new URLSearchParams(location.search).get("v");
    return videoId ? `yt:${videoId}` : null;
  }
  if (host.includes("netflix.com")) {
    const movieId = /\/watch\/(\d+)/.exec(location.pathname)?.[1];
    return movieId ? `nf:${movieId}` : null;
  }
  return null;
}

chrome.runtime.onMessage.addListener(
  (message: GetStateRequest, _sender, sendResponse: (r: GetStateResponse) => void) => {
    if (message?.type !== "CATCHUP_GET_STATE") return;

    const video = findMainVideo();
    if (!video) {
      sendResponse({ ok: false, error: "no_video" });
      return;
    }

    sendResponse({
      ok: true,
      title: detectTitle(),
      currentTimeSec: video.currentTime,
      paused: video.paused,
      videoKey: computeVideoKey(),
    });
  },
);

// Relay auto-captured subtitles from the page-world scripts to the background.
document.addEventListener("catchup:subtitles", (event) => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return;
  try {
    const payload = JSON.parse(detail) as { videoKey?: unknown; label?: unknown; vtt?: unknown };
    if (
      typeof payload.videoKey !== "string" ||
      typeof payload.label !== "string" ||
      typeof payload.vtt !== "string"
    ) {
      return;
    }
    const message: AutoSubsMessage = {
      type: "CATCHUP_AUTO_SUBS",
      videoKey: payload.videoKey,
      label: payload.label,
      vtt: payload.vtt,
    };
    void chrome.runtime.sendMessage(message).catch(() => {
      // background asleep/unavailable — the page script will re-publish on ping
    });
  } catch {
    // malformed payload — ignore
  }
});

// The page script may have captured subtitles before this listener attached.
document.dispatchEvent(new CustomEvent("catchup:ready"));
