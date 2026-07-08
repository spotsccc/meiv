import { defineAgent } from "eve";
import { createOpenAIOAuth } from "openai-oauth-provider";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function resolveAuthFilePath() {
  const encodedAuthJson = process.env.OPENAI_OAUTH_AUTH_JSON_B64;
  const rawAuthJson = process.env.OPENAI_OAUTH_AUTH_JSON;

  if (!encodedAuthJson && !rawAuthJson) {
    return process.env.HOME ? `${process.env.HOME}/.codex/auth.json` : undefined;
  }

  const authJson = encodedAuthJson
    ? Buffer.from(encodedAuthJson, "base64").toString("utf8")
    : rawAuthJson!;
  JSON.parse(authJson);

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
