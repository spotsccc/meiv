import { OAuthCredentialsUnavailableError } from "./errors.js";
import type { EffectiveAuth, OAuthTokenStore } from "./types.js";

export const DEFAULT_CODEX_BASE_URL =
  "https://chatgpt.com/backend-api/codex";
export const DEFAULT_AUDIO_TRANSCRIPTION_URL =
  "https://api.openai.com/v1/audio/transcriptions";

function isCodexRequest(requestUrl: URL, baseUrl: URL): boolean {
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  return (
    requestUrl.origin === baseUrl.origin &&
    (requestUrl.pathname === basePath ||
      requestUrl.pathname.startsWith(`${basePath}/`))
  );
}

function withAuth(
  request: Request,
  auth: EffectiveAuth,
  includeAccountId: boolean,
): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${auth.accessToken}`);
  if (includeAccountId) headers.set("chatgpt-account-id", auth.accountId);
  return new Request(request, { headers });
}

function createScopedOAuthFetch(
  tokenStore: OAuthTokenStore,
  nativeFetch: typeof globalThis.fetch,
  matches: (requestUrl: URL) => boolean,
  includeAccountId: boolean,
): typeof globalThis.fetch {
  return async (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (!matches(requestUrl)) {
      return nativeFetch(input, init);
    }

    const request = new Request(input, init);
    const retryRequest = request.clone();
    const currentAuth = await tokenStore.getValid();
    const response = await nativeFetch(
      withAuth(request, currentAuth, includeAccountId),
    );
    if (response.status !== 401) return response;

    try {
      await response.body?.cancel();
    } catch {
      // The retry must still proceed if the runtime already consumed the body.
    }

    const refreshedAuth = await tokenStore.refreshAfterUnauthorized(
      currentAuth.accessToken,
    );
    return nativeFetch(withAuth(retryRequest, refreshedAuth, includeAccountId));
  };
}

export function createCodexAuthFetch(
  tokenStore: OAuthTokenStore,
  options: {
    fetch?: typeof globalThis.fetch;
    baseUrl?: string;
  } = {},
): typeof globalThis.fetch {
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_CODEX_BASE_URL);
  return createScopedOAuthFetch(
    tokenStore,
    options.fetch ?? globalThis.fetch,
    (requestUrl) => isCodexRequest(requestUrl, baseUrl),
    true,
  );
}

export function createAudioTranscriptionAuthFetch(
  tokenStore: OAuthTokenStore,
  nativeFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const targetUrl = new URL(DEFAULT_AUDIO_TRANSCRIPTION_URL);
  return createScopedOAuthFetch(
    tokenStore,
    nativeFetch,
    (requestUrl) => requestUrl.href === targetUrl.href,
    false,
  );
}

export function createUnavailableOAuthFetch(): typeof globalThis.fetch {
  return async () => {
    throw new OAuthCredentialsUnavailableError(
      "OAuth credentials are unavailable in this deployment environment.",
    );
  };
}
