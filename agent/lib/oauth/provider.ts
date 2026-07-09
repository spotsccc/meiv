import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIOAuth } from "openai-oauth-provider";

import { decodeEncryptionKey } from "./crypto.js";
import { NeonOAuthDatabaseRunner } from "./database.js";
import { OAuthConfigurationError } from "./errors.js";
import {
  createCodexAuthFetch,
  createUnavailableOAuthFetch,
} from "./fetch.js";
import { NeonOAuthTokenStore } from "./token-store.js";

type Environment = Record<string, string | undefined>;
export type OAuthRuntimeMode = "local" | "neon" | "unavailable";

export function resolveOAuthRuntimeMode(env: Environment): OAuthRuntimeMode {
  if (!env.VERCEL) return "local";
  return env.OPENAI_OAUTH_STORAGE === "neon" ? "neon" : "unavailable";
}

function requireEnvironmentValue(env: Environment, name: string): string {
  const value = env[name];
  if (!value) {
    throw new OAuthConfigurationError(`${name} is required.`);
  }
  return value;
}

function writePlaceholderAuthFile(): string {
  const directory = join(tmpdir(), "meiv-oauth");
  const authFilePath = join(directory, "auth.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    authFilePath,
    JSON.stringify({
      tokens: {
        access_token: "managed-by-neon",
        account_id: "managed-by-neon",
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return authFilePath;
}

export function createConfiguredOpenAIOAuth(env: Environment = process.env) {
  const mode = resolveOAuthRuntimeMode(env);
  if (mode === "local") {
    return createOpenAIOAuth();
  }

  const authFilePath = writePlaceholderAuthFile();
  if (mode === "unavailable") {
    return createOpenAIOAuth({
      authFilePath,
      ensureFresh: false,
      fetch: createUnavailableOAuthFetch(),
    });
  }

  const databaseRunner = new NeonOAuthDatabaseRunner(
    requireEnvironmentValue(env, "DATABASE_URL"),
  );
  const tokenStore = new NeonOAuthTokenStore({
    databaseRunner,
    encryptionKey: decodeEncryptionKey(
      requireEnvironmentValue(env, "OPENAI_OAUTH_ENCRYPTION_KEY"),
    ),
  });

  return createOpenAIOAuth({
    authFilePath,
    ensureFresh: false,
    fetch: createCodexAuthFetch(tokenStore),
  });
}
