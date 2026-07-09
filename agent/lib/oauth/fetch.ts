import { OAuthCredentialsUnavailableError } from "./errors.js";
import type { EffectiveAuth, OAuthTokenStore } from "./types.js";

export const DEFAULT_CODEX_BASE_URL =
  "https://chatgpt.com/backend-api/codex";

function isCodexRequest(requestUrl: URL, baseUrl: URL): boolean {
  const basePath = baseUrl.pathname.replace(/\/$/, "");
  return (
    requestUrl.origin === baseUrl.origin &&
    (requestUrl.pathname === basePath ||
      requestUrl.pathname.startsWith(`${basePath}/`))
  );
}

function withAuth(request: Request, auth: EffectiveAuth): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${auth.accessToken}`);
  headers.set("chatgpt-account-id", auth.accountId);
  return new Request(request, { headers });
}

export function createCodexAuthFetch(
  tokenStore: OAuthTokenStore,
  options: {
    fetch?: typeof globalThis.fetch;
    baseUrl?: string;
  } = {},
): typeof globalThis.fetch {
  const nativeFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_CODEX_BASE_URL);

  return async (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (!isCodexRequest(requestUrl, baseUrl)) {
      return nativeFetch(input, init);
    }

    const request = new Request(input, init);
    const retryRequest = request.clone();
    const currentAuth = await tokenStore.getValid();
    const response = await nativeFetch(withAuth(request, currentAuth));
    if (response.status !== 401) return response;

    try {
      await response.body?.cancel();
    } catch {
      // The retry must still proceed if the runtime already consumed the body.
    }

    const refreshedAuth = await tokenStore.refreshAfterUnauthorized(
      currentAuth.accessToken,
    );
    return nativeFetch(withAuth(retryRequest, refreshedAuth));
  };
}

export function createUnavailableOAuthFetch(): typeof globalThis.fetch {
  return async () => {
    throw new OAuthCredentialsUnavailableError(
      "OAuth credentials are unavailable in this deployment environment.",
    );
  };
}
