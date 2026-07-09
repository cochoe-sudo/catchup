import { STORAGE_KEYS } from "../lib/messages";

const input = document.getElementById("api-key") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLSpanElement;

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.apiKey);
  const key = stored[STORAGE_KEYS.apiKey] as string | undefined;
  if (key) {
    input.value = key;
    status.textContent = "A key is saved.";
  }
}

saveButton.addEventListener("click", () => {
  void (async () => {
    const key = input.value.trim();
    if (!key) {
      await chrome.storage.local.remove(STORAGE_KEYS.apiKey);
      status.textContent = "Key removed.";
      return;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.apiKey]: key });
    status.textContent = "Saved ✓";
  })();
});

void load();
