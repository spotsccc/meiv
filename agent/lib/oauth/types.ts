export const PRIMARY_OAUTH_CREDENTIAL_ID = "openai-primary";

export type OAuthTokenBundle = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id: string;
  last_refresh?: string;
};

export type EncryptedOAuthPayload = {
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type EffectiveAuth = {
  accessToken: string;
  accountId: string;
  expiresAt: Date;
};

export interface OAuthTokenStore {
  getValid(): Promise<EffectiveAuth>;
  refreshAfterUnauthorized(
    rejectedAccessToken: string,
  ): Promise<EffectiveAuth>;
  forceRefresh(): Promise<EffectiveAuth>;
}

export type OAuthCredentialStatus = {
  id: string;
  accessExpiresAt: string;
  revision: number;
  refreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
