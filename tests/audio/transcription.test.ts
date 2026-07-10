import { describe, expect, it } from "vitest";

import { transcribeAudio } from "../../agent/lib/audio/transcription.js";

describe("audio transcription client", () => {
  it.each([
    {
      name: "an HTTP error",
      response: new Response("rate limited", { status: 429 }),
    },
    {
      name: "malformed JSON",
      response: new Response("not-json", { status: 200 }),
    },
    {
      name: "empty text",
      response: new Response(JSON.stringify({ text: "   " }), { status: 200 }),
    },
  ])("rejects $name", async ({ response }) => {
    const fetch: typeof globalThis.fetch = async () => response;
    await expect(
      transcribeAudio(Uint8Array.from([1]), fetch),
    ).rejects.toBeInstanceOf(Error);
  });
});
