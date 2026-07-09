import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mergeNonEmptyEnvironment,
  resolveEncodedLocalAuthJson,
} from "../../agent/lib/oauth/environment.js";

describe("OAuth CLI environment resolution", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("does not let redacted Vercel values erase local secrets", () => {
    expect(
      mergeNonEmptyEnvironment(
        {
          DATABASE_URL: "postgresql://local-production-url",
          OPENAI_OAUTH_ENCRYPTION_KEY: "local-key",
        },
        {
          DATABASE_URL: "",
          OPENAI_OAUTH_ENCRYPTION_KEY: "",
          VERCEL_ENV: "production",
        },
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://local-production-url",
      OPENAI_OAUTH_ENCRYPTION_KEY: "local-key",
      VERCEL_ENV: "production",
    });
  });

  it("prefers a non-empty value pulled from Vercel", () => {
    expect(
      mergeNonEmptyEnvironment(
        { DATABASE_URL: "postgresql://local-url" },
        { DATABASE_URL: "postgresql://vercel-url" },
      ).DATABASE_URL,
    ).toBe("postgresql://vercel-url");
  });

  it("reads the local Codex auth file when Vercel redacts the env bundle", async () => {
    const home = await mkdtemp(join(tmpdir(), "meiv-oauth-env-test-"));
    temporaryDirectories.push(home);
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    const authJson = JSON.stringify({ tokens: { access_token: "token" } });
    await writeFile(join(codexHome, "auth.json"), authJson, "utf8");

    expect(
      Buffer.from(
        await resolveEncodedLocalAuthJson({
          HOME: home,
          OPENAI_OAUTH_AUTH_JSON_B64: "",
        }),
        "base64",
      ).toString("utf8"),
    ).toBe(authJson);
  });
});
