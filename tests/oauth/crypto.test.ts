import { describe, expect, it } from "vitest";

import {
  encodeAuthJson,
  getAccessTokenExpiry,
  parseEncodedAuthJson,
} from "../../agent/lib/oauth/auth.js";
import {
  decodeEncryptionKey,
  decryptTokenBundle,
  encryptTokenBundle,
} from "../../agent/lib/oauth/crypto.js";
import {
  OAuthConfigurationError,
  OAuthDecryptionError,
} from "../../agent/lib/oauth/errors.js";
import { shouldRefreshAccessToken } from "../../agent/lib/oauth/token-store.js";
import { createJwt } from "./helpers.js";

describe("OAuth credential encoding", () => {
  const expiresAt = new Date("2030-01-01T00:00:00.000Z");
  const bundle = {
    access_token: createJwt(expiresAt),
    refresh_token: "refresh-token",
    id_token: createJwt(expiresAt),
    account_id: "account-1",
    last_refresh: "2029-12-31T23:00:00.000Z",
  };

  it("round-trips an encrypted token bundle", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptTokenBundle(bundle, key, "openai-primary");

    expect(decryptTokenBundle(encrypted, key, "openai-primary")).toEqual(
      bundle,
    );
    expect(encrypted).not.toHaveProperty("access_token");
  });

  it("rejects the wrong key, AAD, and modified ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptTokenBundle(bundle, key, "openai-primary");

    expect(() =>
      decryptTokenBundle(encrypted, Buffer.alloc(32, 8), "openai-primary"),
    ).toThrow(OAuthDecryptionError);
    expect(() => decryptTokenBundle(encrypted, key, "another-record")).toThrow(
      OAuthDecryptionError,
    );
    expect(() =>
      decryptTokenBundle(
        { ...encrypted, ciphertext: `${encrypted.ciphertext}a` },
        key,
        "openai-primary",
      ),
    ).toThrow(OAuthDecryptionError);
  });

  it("accepts only a Base64-encoded 32-byte key", () => {
    const encoded = Buffer.alloc(32, 4).toString("base64");
    expect(decodeEncryptionKey(encoded)).toEqual(Buffer.alloc(32, 4));
    expect(() => decodeEncryptionKey("not-base64")).toThrow(
      OAuthConfigurationError,
    );
    expect(() =>
      decodeEncryptionKey(Buffer.alloc(16).toString("base64")),
    ).toThrow(OAuthConfigurationError);
  });

  it("round-trips auth.json Base64 and reads JWT expiry", () => {
    const encoded = encodeAuthJson(bundle);
    expect(parseEncodedAuthJson(encoded)).toEqual(bundle);
    expect(getAccessTokenExpiry(bundle.access_token)).toEqual(expiresAt);
  });

  it("refreshes at the exact five-minute boundary", () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    expect(
      shouldRefreshAccessToken(
        new Date(now.getTime() + 5 * 60_000 + 1),
        now,
      ),
    ).toBe(false);
    expect(
      shouldRefreshAccessToken(new Date(now.getTime() + 5 * 60_000), now),
    ).toBe(true);
  });
});
