import { defineAgent } from "eve";
import { createOpenAIOAuth } from "openai-oauth-provider";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function assertAuthJsonShape(authJson: string) {
  const parsed = JSON.parse(authJson) as {
    tokens?: {
      access_token?: unknown;
      refresh_token?: unknown;
      account_id?: unknown;
    };
  };

  if (
    typeof parsed.tokens?.access_token !== "string" ||
    typeof parsed.tokens?.refresh_token !== "string" ||
    typeof parsed.tokens?.account_id !== "string"
  ) {
    throw new Error(
      "OPENAI_OAUTH_AUTH_JSON_B64 must contain your full ~/.codex/auth.json with tokens.access_token, tokens.refresh_token, and tokens.account_id.",
    );
  }
}

function resolveAuthFilePath() {
  const encodedAuthJson = process.env.OPENAI_OAUTH_AUTH_JSON_B64;
  const rawAuthJson = process.env.OPENAI_OAUTH_AUTH_JSON;

  if (!encodedAuthJson && !rawAuthJson) {
    if (process.env.VERCEL) {
      throw new Error(
        "OPENAI_OAUTH_AUTH_JSON_B64 is required on Vercel. Add it to the same Vercel environment you deploy to, then redeploy.",
      );
    }

    return process.env.HOME ? `${process.env.HOME}/.codex/auth.json` : undefined;
  }

  const authJson = encodedAuthJson
    ? Buffer.from(encodedAuthJson.replace(/\s/g, ""), "base64").toString(
        "utf8",
      )
    : rawAuthJson!;
  assertAuthJsonShape(authJson);

  const authFilePath = join(tmpdir(), "codex-auth.json");
  mkdirSync(dirname(authFilePath), { recursive: true });
  writeFileSync(authFilePath, authJson, { encoding: "utf8", mode: 0o600 });

  return authFilePath;
}

const openai = createOpenAIOAuth({
  authFilePath: resolveAuthFilePath(),
});

export default defineAgent({
  model: openai("gpt-5.5"),
});
