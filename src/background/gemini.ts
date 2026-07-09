/**
 * Google Gemini client — the free-tier alternative to the Anthropic API.
 * Plain fetch against the Generative Language API; keys come from
 * https://aistudio.google.com/apikey (free daily quota, no card needed).
 */

import type { ChatTurn } from "../lib/messages";

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export async function askGemini(params: {
  apiKey: string;
  system: string;
  history: ChatTurn[];
  question: string;
}): Promise<string> {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const turn of params.history) {
    contents.push({ role: "user", parts: [{ text: turn.question }] });
    contents.push({ role: "model", parts: [{ text: turn.answer }] });
  }
  contents.push({ role: "user", parts: [{ text: params.question }] });

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": params.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.system }] },
        contents,
        generationConfig: {
          maxOutputTokens: 1024,
          // Answers are short; skip Gemini's thinking phase for speed.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } catch {
    throw new Error("Couldn't reach the Gemini API. Check your internet connection.");
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    throw new Error(`Gemini API returned an unreadable response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const message = data.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 400 && /API key/i.test(message)) {
      throw new Error("Your Gemini API key was rejected. Double-check it in CatchUp's options.");
    }
    if (res.status === 429) {
      throw new Error(
        "Gemini free-tier quota hit — wait a minute and try again (quotas reset daily).",
      );
    }
    throw new Error(`Gemini API error: ${message}`);
  }

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request (${data.promptFeedback.blockReason}).`);
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return text || "(The model returned an empty answer — try rephrasing.)";
}
