import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OAuthConfigurationError } from "./errors.js";

export type OAuthEnvironment = Record<string, string | undefined>;

export function mergeNonEmptyEnvironment(
  base: OAuthEnvironment,
  overlay: OAuthEnvironment,
): OAuthEnvironment {
  const merged = { ...base };
  for (const [name, value] of Object.entries(overlay)) {
    if (typeof value === "string" && value.length > 0) {
      merged[name] = value;
    }
  }
  return merged;
}

export async function resolveEncodedLocalAuthJson(
  env: OAuthEnvironment,
): Promise<string> {
  const encodedAuthJson = env.OPENAI_OAUTH_AUTH_JSON_B64?.replace(/\s/g, "");
  if (encodedAuthJson) return encodedAuthJson;

  if (env.OPENAI_OAUTH_AUTH_JSON) {
    return Buffer.from(env.OPENAI_OAUTH_AUTH_JSON, "utf8").toString("base64");
  }

  const candidates = [
    env.CHATGPT_LOCAL_HOME
      ? join(env.CHATGPT_LOCAL_HOME, "auth.json")
      : undefined,
    env.CODEX_HOME ? join(env.CODEX_HOME, "auth.json") : undefined,
    env.HOME ? join(env.HOME, ".chatgpt-local", "auth.json") : undefined,
    env.HOME ? join(env.HOME, ".codex", "auth.json") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const authFilePath of [...new Set(candidates)]) {
    try {
      const authJson = await readFile(authFilePath, "utf8");
      return Buffer.from(authJson, "utf8").toString("base64");
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "ENOENT") throw error;
    }
  }

  throw new OAuthConfigurationError(
    "OAuth auth.json is unavailable. Set OPENAI_OAUTH_AUTH_JSON_B64 locally or run codex login.",
  );
}
