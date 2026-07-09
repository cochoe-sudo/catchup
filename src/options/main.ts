import { STORAGE_KEYS } from "../lib/messages";
import type { Provider } from "../lib/messages";

const providerSelect = document.getElementById("provider") as HTMLSelectElement;
const geminiSection = document.getElementById("gemini-section") as HTMLDivElement;
const anthropicSection = document.getElementById("anthropic-section") as HTMLDivElement;
const geminiInput = document.getElementById("gemini-key") as HTMLInputElement;
const anthropicInput = document.getElementById("api-key") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLSpanElement;

function highlightActiveSection(): void {
  const gemini = providerSelect.value === "gemini";
  geminiSection.classList.toggle("inactive", !gemini);
  anthropicSection.classList.toggle("inactive", gemini);
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.geminiKey,
  ]);
  providerSelect.value = (stored[STORAGE_KEYS.provider] as Provider | undefined) ?? "gemini";
  anthropicInput.value = (stored[STORAGE_KEYS.apiKey] as string | undefined) ?? "";
  geminiInput.value = (stored[STORAGE_KEYS.geminiKey] as string | undefined) ?? "";
  highlightActiveSection();
}

providerSelect.addEventListener("change", highlightActiveSection);

saveButton.addEventListener("click", () => {
  void (async () => {
    const provider = providerSelect.value as Provider;
    const activeKey = (provider === "gemini" ? geminiInput : anthropicInput).value.trim();
    await chrome.storage.local.set({
      [STORAGE_KEYS.provider]: provider,
      [STORAGE_KEYS.apiKey]: anthropicInput.value.trim(),
      [STORAGE_KEYS.geminiKey]: geminiInput.value.trim(),
    });
    status.textContent = activeKey
      ? "Saved ✓"
      : `Saved — but add a ${provider === "gemini" ? "Gemini" : "Anthropic"} key to ask questions.`;
  })();
});

void load();
