/**
 * Popup: shows what's being watched, lets the user load subtitles, and runs
 * the chat. On EVERY question it re-reads the live playback position from the
 * content script so the background can re-truncate the transcript — seeking
 * forward or backward mid-conversation is always respected.
 */

import { parseSubtitles } from "../lib/subtitles";
import { formatTimestamp } from "../lib/truncate";
import { STORAGE_KEYS } from "../lib/messages";
import type {
  AskRequest,
  AskResponse,
  ChatTurn,
  GetStateRequest,
  GetStateResponse,
  StoredSubtitles,
} from "../lib/messages";

const el = {
  videoTitle: document.getElementById("video-title") as HTMLSpanElement,
  videoTime: document.getElementById("video-time") as HTMLSpanElement,
  subtitleStatus: document.getElementById("subtitle-status") as HTMLSpanElement,
  fileButton: document.getElementById("file-button") as HTMLButtonElement,
  fileInput: document.getElementById("file-input") as HTMLInputElement,
  pasteToggle: document.getElementById("paste-toggle") as HTMLButtonElement,
  pasteArea: document.getElementById("paste-area") as HTMLDivElement,
  pasteText: document.getElementById("paste-text") as HTMLTextAreaElement,
  pasteSave: document.getElementById("paste-save") as HTMLButtonElement,
  pasteCancel: document.getElementById("paste-cancel") as HTMLButtonElement,
  chat: document.getElementById("chat") as HTMLDivElement,
  emptyHint: document.getElementById("empty-hint") as HTMLDivElement,
  form: document.getElementById("ask-form") as HTMLFormElement,
  question: document.getElementById("question") as HTMLInputElement,
  askButton: document.getElementById("ask-button") as HTMLButtonElement,
  openOptions: document.getElementById("open-options") as HTMLAnchorElement,
};

const history: ChatTurn[] = [];
const MAX_HISTORY_TURNS = 6;
let activeTabId: number | null = null;
let currentVideoKey: string | null = null;

// ---- playback state -------------------------------------------------------

async function getPlaybackState(): Promise<GetStateResponse | { ok: false; error: "no_tab" }> {
  if (activeTabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: "no_tab" };
    activeTabId = tab.id;
  }
  try {
    return (await chrome.tabs.sendMessage(activeTabId, {
      type: "CATCHUP_GET_STATE",
    } satisfies GetStateRequest)) as GetStateResponse;
  } catch {
    // No content script in this tab -> not on Netflix/YouTube.
    return { ok: false, error: "no_tab" };
  }
}

async function refreshHeader(): Promise<void> {
  const state = await getPlaybackState();
  if (!state.ok) {
    el.videoTitle.textContent =
      state.error === "no_tab"
        ? "Open a Netflix or YouTube tab"
        : "No video found on this page";
    el.videoTime.textContent = "";
    return;
  }
  el.videoTitle.textContent = state.title;
  el.videoTime.textContent = `at ${formatTimestamp(state.currentTimeSec * 1000)}${state.paused ? " (paused)" : ""}`;
  if (state.videoKey !== currentVideoKey) {
    currentVideoKey = state.videoKey;
    void loadStoredSubtitles();
  }
}

// ---- subtitles ------------------------------------------------------------

function renderSubtitleStatus(stored: StoredSubtitles | undefined): void {
  if (!stored) {
    el.subtitleStatus.textContent = currentVideoKey
      ? "Capturing subtitles… (or load a file)"
      : "No subtitles loaded";
    el.subtitleStatus.classList.remove("loaded");
    return;
  }
  el.subtitleStatus.textContent = `${stored.cues.length} lines · ${stored.label}`;
  el.subtitleStatus.classList.add("loaded");
}

/** Per-video subtitles win over the global manual fallback. */
async function loadStoredSubtitles(): Promise<void> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.subtitles,
    STORAGE_KEYS.subsByVideo,
  ]);
  const map = (stored[STORAGE_KEYS.subsByVideo] ?? {}) as Record<string, StoredSubtitles>;
  const active =
    (currentVideoKey ? map[currentVideoKey] : undefined) ??
    (stored[STORAGE_KEYS.subtitles] as StoredSubtitles | undefined);
  renderSubtitleStatus(active);
}

async function saveSubtitles(rawText: string, label: string): Promise<void> {
  try {
    const cues = parseSubtitles(rawText);
    const stored: StoredSubtitles = { label, cues, savedAt: Date.now() };
    if (currentVideoKey) {
      // Tie the manual file to this video so it overrides any auto-capture.
      const existing = await chrome.storage.local.get(STORAGE_KEYS.subsByVideo);
      const map = (existing[STORAGE_KEYS.subsByVideo] ?? {}) as Record<string, StoredSubtitles>;
      map[currentVideoKey] = stored;
      await chrome.storage.local.set({ [STORAGE_KEYS.subsByVideo]: map });
    } else {
      await chrome.storage.local.set({ [STORAGE_KEYS.subtitles]: stored });
    }
    renderSubtitleStatus(stored);
  } catch (err) {
    addMessage("error", err instanceof Error ? err.message : String(err));
  }
}

// Live-update the status line when auto-capture lands while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEYS.subsByVideo]) void loadStoredSubtitles();
});

el.fileButton.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files?.[0];
  if (!file) return;
  void file.text().then((text) => saveSubtitles(text, file.name));
  el.fileInput.value = "";
});

el.pasteToggle.addEventListener("click", () => el.pasteArea.classList.toggle("open"));
el.pasteCancel.addEventListener("click", () => el.pasteArea.classList.remove("open"));
el.pasteSave.addEventListener("click", () => {
  const text = el.pasteText.value;
  if (!text.trim()) return;
  void saveSubtitles(text, "pasted subtitles").then(() => {
    el.pasteArea.classList.remove("open");
    el.pasteText.value = "";
  });
});

// ---- chat -----------------------------------------------------------------

function addMessage(kind: "user" | "assistant" | "error", text: string, stamp?: string): HTMLDivElement {
  el.emptyHint.remove();
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.textContent = text;
  if (stamp) {
    const stampEl = document.createElement("span");
    stampEl.className = "stamp";
    stampEl.textContent = stamp;
    div.appendChild(stampEl);
  }
  el.chat.appendChild(div);
  el.chat.scrollTop = el.chat.scrollHeight;
  return div;
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask();
});

async function ask(): Promise<void> {
  const question = el.question.value.trim();
  if (!question || el.askButton.disabled) return;

  // Fresh read of the playback position — the whole point.
  const state = await getPlaybackState();
  if (!state.ok) {
    addMessage(
      "error",
      state.error === "no_tab"
        ? "Open the Netflix or YouTube tab you're watching, then ask again."
        : "Couldn't find a playing video on this page. Start the video, then ask again.",
    );
    return;
  }

  el.question.value = "";
  el.askButton.disabled = true;
  addMessage("user", question, `asked at ${formatTimestamp(state.currentTimeSec * 1000)}`);
  const pending = addMessage("assistant", "Thinking…");

  const request: AskRequest = {
    type: "CATCHUP_ASK",
    title: state.title,
    currentTimeSec: state.currentTimeSec,
    question,
    history: history.slice(-MAX_HISTORY_TURNS),
    videoKey: state.videoKey,
  };

  let response: AskResponse;
  try {
    response = (await chrome.runtime.sendMessage(request)) as AskResponse;
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  pending.remove();
  if (response.ok) {
    addMessage("assistant", response.answer);
    history.push({ question, answer: response.answer });
  } else {
    addMessage("error", response.error);
    if (response.code === "no_api_key") chrome.runtime.openOptionsPage();
  }
  el.askButton.disabled = false;
  void refreshHeader();
}

// ---- misc -----------------------------------------------------------------

el.openOptions.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refreshHeader();
void loadStoredSubtitles();
setInterval(() => void refreshHeader(), 1000);
