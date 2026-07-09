import { z } from "zod";

import { OAuthCredentialInvalidError } from "./errors.js";
import type { OAuthTokenBundle } from "./types.js";

const nonEmptyString = z.string().min(1);
const dateTimeString = nonEmptyString.refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "Expected an ISO-compatible timestamp.",
);

export const oauthTokenBundleSchema = z.object({
  access_token: nonEmptyString,
  refresh_token: nonEmptyString,
  id_token: nonEmptyString.optional(),
  account_id: nonEmptyString,
  last_refresh: dateTimeString.optional(),
});

const authJsonSchema = z
  .object({
    tokens: z.object({
      access_token: nonEmptyString,
      refresh_token: nonEmptyString,
      id_token: nonEmptyString.optional(),
      account_id: nonEmptyString,
    }),
    last_refresh: dateTimeString.optional(),
  })
  .passthrough();

export const refreshResponseSchema = z
  .object({
    access_token: nonEmptyString,
    refresh_token: nonEmptyString.optional(),
    id_token: nonEmptyString.optional(),
  })
  .passthrough();

export const refreshErrorResponseSchema = z
  .object({ error: nonEmptyString })
  .passthrough();

function parseJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new OAuthCredentialInvalidError(
      "OAuth access token is not a valid JWT.",
    );
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JWT payload must be an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new OAuthCredentialInvalidError(
      "OAuth access token has an invalid JWT payload.",
      { cause: error },
    );
  }
}

export function getAccessTokenExpiry(accessToken: string): Date {
  const claims = parseJwtClaims(accessToken);
  if (
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0
  ) {
    throw new OAuthCredentialInvalidError(
      "OAuth access token JWT is missing a valid exp claim.",
    );
  }

  return new Date(claims.exp * 1_000);
}

export function deriveAccountId(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;

  try {
    const claims = parseJwtClaims(idToken);
    const auth = claims["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      return undefined;
    }
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseEncodedAuthJson(encodedAuthJson: string): OAuthTokenBundle {
  try {
    const rawJson = Buffer.from(
      encodedAuthJson.replace(/\s/g, ""),
      "base64",
    ).toString("utf8");
    const authJson = authJsonSchema.parse(JSON.parse(rawJson));
    return oauthTokenBundleSchema.parse({
      ...authJson.tokens,
      last_refresh: authJson.last_refresh,
    });
  } catch (error) {
    throw new OAuthCredentialInvalidError(
      "OPENAI_OAUTH_AUTH_JSON_B64 is not a valid Codex auth bundle.",
      { cause: error },
    );
  }
}

export function encodeAuthJson(bundle: OAuthTokenBundle): string {
  const authJson = {
    tokens: {
      id_token: bundle.id_token,
      access_token: bundle.access_token,
      refresh_token: bundle.refresh_token,
      account_id: bundle.account_id,
    },
    last_refresh: bundle.last_refresh,
  };

  return Buffer.from(JSON.stringify(authJson, null, 2), "utf8").toString(
    "base64",
  );
}
