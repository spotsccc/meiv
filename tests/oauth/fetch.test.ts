import { describe, expect, it } from "vitest";

import {
  createAudioTranscriptionAuthFetch,
  DEFAULT_AUDIO_TRANSCRIPTION_URL,
} from "../../agent/lib/oauth/fetch.js";
import type {
  EffectiveAuth,
  OAuthTokenStore,
} from "../../agent/lib/oauth/types.js";

function createAuth(accessToken: string, accountId: string): EffectiveAuth {
  return {
    accessToken,
    accountId,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

describe("audio transcription OAuth fetch", () => {
  it.each([
    "https://api.openai.com/v1/audio/translations",
    "https://api.openai.com/v1/audio/transcriptions?language=en",
    "https://api.openai.com/v1/audio/transcriptions/",
    "https://example.com/v1/audio/transcriptions",
  ])("does not sign a non-matching URL: %s", async (url) => {
    let authLoads = 0;
    let observedAuthorization: string | null = null;
    const store: OAuthTokenStore = {
      getValid: async () => {
        authLoads += 1;
        return createAuth("audio-token", "account-1");
      },
      refreshAfterUnauthorized: async () =>
        createAuth("refreshed-token", "account-2"),
      forceRefresh: async () => createAuth("forced-token", "account-3"),
    };
    const nativeFetch: typeof fetch = async (input, init) => {
      observedAuthorization = new Request(input, init).headers.get(
        "authorization",
      );
      return new Response("ok");
    };
    const audioFetch = createAudioTranscriptionAuthFetch(store, nativeFetch);

    await audioFetch(url, {
      headers: { authorization: "Bearer caller-token" },
    });

    expect(authLoads).toBe(0);
    expect(observedAuthorization).toBe("Bearer caller-token");
  });

  it("refreshes once after 401 and replays the multipart body", async () => {
    const oldAuth = createAuth("old-token", "account-1");
    const newAuth = createAuth("new-token", "account-2");
    const rejectedTokens: string[] = [];
    const observedAuth: string[] = [];
    const observedFiles: string[] = [];
    let requests = 0;
    const store: OAuthTokenStore = {
      getValid: async () => oldAuth,
      refreshAfterUnauthorized: async (rejectedAccessToken) => {
        rejectedTokens.push(rejectedAccessToken);
        return newAuth;
      },
      forceRefresh: async () => newAuth,
    };
    const nativeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      observedAuth.push(request.headers.get("authorization") ?? "");
      const formData = await request.formData();
      observedFiles.push(await (formData.get("file") as File).text());
      requests += 1;
      return requests === 1
        ? new Response("unauthorized", { status: 401 })
        : new Response(JSON.stringify({ text: "done" }), { status: 200 });
    };
    const audioFetch = createAudioTranscriptionAuthFetch(store, nativeFetch);
    const formData = new FormData();
    formData.set("file", new Blob(["ogg-bytes"]), "voice.ogg");
    formData.set("model", "gpt-4o-mini-transcribe");

    const response = await audioFetch(DEFAULT_AUDIO_TRANSCRIPTION_URL, {
      method: "POST",
      body: formData,
    });

    expect(response.status).toBe(200);
    expect(requests).toBe(2);
    expect(rejectedTokens).toEqual(["old-token"]);
    expect(observedAuth).toEqual([
      "Bearer old-token",
      "Bearer new-token",
    ]);
    expect(observedFiles).toEqual(["ogg-bytes", "ogg-bytes"]);
  });
});
