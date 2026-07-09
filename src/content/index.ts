/**
 * Content script for Netflix and YouTube.
 *
 * IMPORTANT: this file must have ZERO runtime imports — MV3 content scripts
 * are classic scripts, not ES modules. `import type` only.
 */

import type { GetStateRequest, GetStateResponse } from "../lib/messages";

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
    });
  },
);
