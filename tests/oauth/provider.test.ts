import { describe, expect, it } from "vitest";

import { OAuthCredentialsUnavailableError } from "../../agent/lib/oauth/errors.js";
import { createUnavailableOAuthFetch } from "../../agent/lib/oauth/fetch.js";
import {
  createConfiguredAudioTranscriptionFetch,
  createConfiguredOpenAIOAuth,
  resolveOAuthRuntimeMode,
} from "../../agent/lib/oauth/provider.js";

describe("OAuth runtime selection", () => {
  it("keeps local auth local and makes hosted environments explicit", () => {
    expect(resolveOAuthRuntimeMode({})).toBe("local");
    expect(resolveOAuthRuntimeMode({ VERCEL: "1" })).toBe("unavailable");
    expect(
      resolveOAuthRuntimeMode({
        VERCEL: "1",
        OPENAI_OAUTH_STORAGE: "neon",
      }),
    ).toBe("neon");
  });

  it("defers the unavailable-preview failure until fetch", async () => {
    expect(() => createConfiguredOpenAIOAuth({ VERCEL: "1" })).not.toThrow();
    const unavailableFetch = createUnavailableOAuthFetch();
    await expect(unavailableFetch("https://example.com")).rejects.toBeInstanceOf(
      OAuthCredentialsUnavailableError,
    );
  });

  it("fails closed for hosted audio transcription without Neon storage", async () => {
    const audioFetch = createConfiguredAudioTranscriptionFetch({ VERCEL: "1" });
    await expect(
      audioFetch("https://api.openai.com/v1/audio/transcriptions"),
    ).rejects.toBeInstanceOf(OAuthCredentialsUnavailableError);
  });
});
