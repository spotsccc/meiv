import { z } from "zod";

import { DEFAULT_AUDIO_TRANSCRIPTION_URL } from "../oauth/fetch.js";

const AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

const responseSchema = z.object({
  text: z.string().trim().min(1),
});

export async function transcribeAudio(
  bytes: Uint8Array,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const body = new FormData();
  body.set(
    "file",
    new Blob([Uint8Array.from(bytes)], { type: "audio/ogg" }),
    "voice.ogg",
  );
  body.set("model", AUDIO_TRANSCRIPTION_MODEL);
  body.set("response_format", "json");

  const response = await fetch(DEFAULT_AUDIO_TRANSCRIPTION_URL, {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new Error(`Audio transcription HTTP ${response.status}.`);
  }
  return responseSchema.parse(await response.json()).text;
}
