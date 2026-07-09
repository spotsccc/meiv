import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

import {
  OAuthConfigurationError,
  OAuthCredentialInvalidError,
  OAuthDecryptionError,
} from "./errors.js";
import { oauthTokenBundleSchema } from "./auth.js";
import type { EncryptedOAuthPayload, OAuthTokenBundle } from "./types.js";

const encryptedPayloadSchema = z.object({
  version: z.literal(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});

export function decodeEncryptionKey(encodedKey: string): Buffer {
  const normalized = encodedKey.replace(/\s/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    throw new OAuthConfigurationError(
      "OPENAI_OAUTH_ENCRYPTION_KEY must be standard Base64.",
    );
  }

  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) {
    throw new OAuthConfigurationError(
      "OPENAI_OAUTH_ENCRYPTION_KEY must decode to exactly 32 bytes.",
    );
  }
  return key;
}

export function encryptTokenBundle(
  bundle: OAuthTokenBundle,
  key: Buffer,
  credentialId: string,
): EncryptedOAuthPayload {
  if (key.length !== 32) {
    throw new OAuthConfigurationError("OAuth encryption key must be 32 bytes.");
  }

  const validatedBundle = oauthTokenBundleSchema.parse(bundle);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(credentialId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(validatedBundle), "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptTokenBundle(
  payload: unknown,
  key: Buffer,
  credentialId: string,
): OAuthTokenBundle {
  if (key.length !== 32) {
    throw new OAuthConfigurationError("OAuth encryption key must be 32 bytes.");
  }

  try {
    const validatedPayload = encryptedPayloadSchema.parse(payload);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(validatedPayload.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(credentialId, "utf8"));
    decipher.setAuthTag(Buffer.from(validatedPayload.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(validatedPayload.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    return oauthTokenBundleSchema.parse(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof OAuthCredentialInvalidError) throw error;
    throw new OAuthDecryptionError(
      "Stored OAuth credentials could not be decrypted or validated.",
      { cause: error },
    );
  }
}
