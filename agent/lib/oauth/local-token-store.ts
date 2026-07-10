import { loadAuthTokens } from "openai-oauth-provider";

import { getAccessTokenExpiry } from "./auth.js";
import { OAuthRefreshError } from "./errors.js";
import type { EffectiveAuth, OAuthTokenStore } from "./types.js";

export class LocalOAuthTokenStore implements OAuthTokenStore {
  private refreshing: Promise<EffectiveAuth> | undefined;

  constructor(
    private readonly options: {
      authFilePath?: string;
      fetch?: typeof globalThis.fetch;
      now?: () => Date;
      tokenUrl?: string;
    } = {},
  ) {}

  getValid(): Promise<EffectiveAuth> {
    return this.load();
  }

  refreshAfterUnauthorized(token: string): Promise<EffectiveAuth> {
    this.refreshing ??= this.refresh(token).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async forceRefresh(): Promise<EffectiveAuth> {
    return this.refreshAfterUnauthorized((await this.load()).accessToken);
  }

  private async refresh(token: string): Promise<EffectiveAuth> {
    const current = await this.load();
    if (current.accessToken !== token) return current;

    let firstClockRead = true;
    const expiry = getAccessTokenExpiry(token);
    const auth = await this.load(() => {
      if (!firstClockRead) return this.options.now?.() ?? new Date();
      firstClockRead = false;
      return new Date(expiry.getTime() + 1);
    });
    if (auth.accessToken === token) throw new OAuthRefreshError("unauthorized");
    return auth;
  }

  private async load(
    now: () => Date = this.options.now ?? (() => new Date()),
  ): Promise<EffectiveAuth> {
    const auth = await loadAuthTokens({
      ...this.options,
      ensureFresh: true,
      fetch: this.options.fetch ?? globalThis.fetch,
      now,
    });
    return {
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      expiresAt: getAccessTokenExpiry(auth.accessToken),
    };
  }
}
