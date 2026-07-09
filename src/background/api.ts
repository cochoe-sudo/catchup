/**
 * Anthropic API client for the background service worker.
 * The key is user-supplied via the options page, so the browser client is the
 * intended (and only) topology — hence dangerouslyAllowBrowser.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ChatTurn } from "../lib/messages";

const MODEL = "claude-sonnet-4-6";

export async function askClaude(params: {
  apiKey: string;
  system: string;
  history: ChatTurn[];
  question: string;
}): Promise<string> {
  const client = new Anthropic({
    apiKey: params.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const messages: Anthropic.MessageParam[] = [];
  for (const turn of params.history) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  messages.push({ role: "user", content: params.question });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: params.system,
    messages,
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || "(The model returned an empty answer — try rephrasing.)";
}

/** Map SDK errors to messages fit for the popup. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Your Anthropic API key was rejected. Double-check it in CatchUp's options.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "Your API key doesn't have permission for this model.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API — wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the Anthropic API. Check your internet connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error (${err.status ?? "unknown"}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
