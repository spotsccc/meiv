import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OAuthRefreshError } from "../../agent/lib/oauth/errors.js";
import { LocalOAuthTokenStore } from "../../agent/lib/oauth/local-token-store.js";
import { createIdToken, createJwt, startHttpServer } from "./helpers.js";

describe("local OAuth token store", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function createAuthFile(input: {
    accessToken: string;
    idToken: string;
    lastRefresh: Date;
  }): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "meiv-local-oauth-test-"));
    temporaryDirectories.push(directory);
    const authFilePath = join(directory, "auth.json");
    await writeFile(
      authFilePath,
      JSON.stringify({
        tokens: {
          access_token: input.accessToken,
          refresh_token: "refresh-token-1",
          id_token: input.idToken,
          account_id: "account-1",
        },
        last_refresh: input.lastRefresh.toISOString(),
      }),
      "utf8",
    );
    return authFilePath;
  }

  it("forces one refresh after a rejected unexpired token", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const oldExpiry = new Date(now.getTime() + 2 * 60 * 60_000);
    const newExpiry = new Date(now.getTime() + 4 * 60 * 60_000);
    const oldAccessToken = createJwt(oldExpiry);
    const newAccessToken = createJwt(newExpiry);
    const authFilePath = await createAuthFile({
      accessToken: oldAccessToken,
      idToken: createIdToken(oldExpiry, "account-1"),
      lastRefresh: now,
    });
    let refreshRequests = 0;
    const oauthServer = await startHttpServer((_request, response) => {
      refreshRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: newAccessToken,
          refresh_token: "refresh-token-2",
          id_token: createIdToken(newExpiry, "account-2"),
        }),
      );
    });

    try {
      const store = new LocalOAuthTokenStore({
        authFilePath,
        now: () => now,
        tokenUrl: oauthServer.url,
      });
      expect((await store.getValid()).accessToken).toBe(oldAccessToken);

      const refreshed = await Promise.all([
        store.refreshAfterUnauthorized(oldAccessToken),
        store.refreshAfterUnauthorized(oldAccessToken),
      ]);

      expect(refreshed.map((auth) => auth.accessToken)).toEqual([
        newAccessToken,
        newAccessToken,
      ]);
      expect(refreshed.map((auth) => auth.accountId)).toEqual([
        "account-2",
        "account-2",
      ]);
      expect(refreshRequests).toBe(1);
      const persisted = JSON.parse(await readFile(authFilePath, "utf8")) as {
        last_refresh: string;
        tokens: { access_token: string; refresh_token: string };
      };
      expect(persisted.last_refresh).toBe(now.toISOString());
      expect(persisted.tokens).toMatchObject({
        access_token: newAccessToken,
        refresh_token: "refresh-token-2",
      });
    } finally {
      await oauthServer.close();
    }
  });

  it("fails instead of retrying with the rejected token", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const expiry = new Date(now.getTime() + 2 * 60 * 60_000);
    const accessToken = createJwt(expiry);
    const authFilePath = await createAuthFile({
      accessToken,
      idToken: createIdToken(expiry, "account-1"),
      lastRefresh: now,
    });
    const oauthServer = await startHttpServer((_request, response) => {
      response.statusCode = 400;
      response.end("refresh rejected");
    });

    try {
      const store = new LocalOAuthTokenStore({
        authFilePath,
        now: () => now,
        tokenUrl: oauthServer.url,
      });
      await expect(
        store.refreshAfterUnauthorized(accessToken),
      ).rejects.toMatchObject({
        name: OAuthRefreshError.name,
        code: "unauthorized",
      });
    } finally {
      await oauthServer.close();
    }
  });
});
