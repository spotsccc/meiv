import { defineAgent } from "eve";
import { wrapLanguageModel } from "ai";
import { createConfiguredOpenAIOAuth } from "./lib/oauth/provider.js";

function stripEphemeralProviderState<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        if (!item || typeof item !== "object") return true;

        const part = item as Record<string, unknown>;
        return part.type !== "reasoning" || part.text !== "";
      })
      .map(stripEphemeralProviderState) as T;
  }

  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "providerOptions")
      .map(([key, nestedValue]) => [
        key,
        stripEphemeralProviderState(nestedValue),
      ]),
  ) as T;
}

const openai = createConfiguredOpenAIOAuth();

const model = wrapLanguageModel({
  model: openai("gpt-5.5"),
  middleware: {
    // Codex OAuth responses are not stored upstream. Vercel Workflow can resume
    // in a fresh instance, where itemId references from a prior turn no longer
    // exist in the provider's in-memory cache, so send the full message history.
    transformParams: async ({ params }) => ({
      ...params,
      prompt: stripEphemeralProviderState(params.prompt),
    }),
  },
});

export default defineAgent({
  model,
});
