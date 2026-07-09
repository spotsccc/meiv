import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OAuthCredentialAdmin } from "../../agent/lib/oauth/admin.js";
import { encodeAuthJson, parseEncodedAuthJson } from "../../agent/lib/oauth/auth.js";
import type {
  OAuthDatabase,
  OAuthDatabaseRunner,
} from "../../agent/lib/oauth/database.js";
import {
  OAuthCredentialConflictError,
  OAuthCredentialMissingError,
  OAuthDatabaseError,
  OAuthRefreshError,
} from "../../agent/lib/oauth/errors.js";
import { createCodexAuthFetch } from "../../agent/lib/oauth/fetch.js";
import { oauthCredentials } from "../../agent/lib/oauth/schema.js";
import { NeonOAuthTokenStore } from "../../agent/lib/oauth/token-store.js";
import type { OAuthTokenBundle } from "../../agent/lib/oauth/types.js";
import { createIdToken, createJwt, startHttpServer } from "./helpers.js";

class NodePostgresRunner implements OAuthDatabaseRunner {
  constructor(private readonly connectionString: string) {}

  async run<T>(operation: (database: OAuthDatabase) => Promise<T>): Promise<T> {
    const pool = new Pool({ connectionString: this.connectionString, max: 1 });
    const database = drizzle({ client: pool }) as unknown as OAuthDatabase;
    try {
      return await operation(database);
    } finally {
      await pool.end();
    }
  }
}

describe("Neon OAuth token storage", () => {
  let container: StartedPostgreSqlContainer;
  let connectionString: string;
  let runner: NodePostgresRunner;
  const encryptionKey = Buffer.alloc(32, 7);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    connectionString = container.getConnectionUri();
    runner = new NodePostgresRunner(connectionString);

    const pool = new Pool({ connectionString });
    const database = drizzle({ client: pool });
    try {
      const migrationsFolder = join(process.cwd(), "drizzle");
      expect(await migrate(database, { migrationsFolder })).toBeUndefined();
      expect(await migrate(database, { migrationsFolder })).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    await runner.run(async (database) => {
      await database.delete(oauthCredentials);
    });
  });

  function createAdmin(): OAuthCredentialAdmin {
    return new OAuthCredentialAdmin(runner, encryptionKey);
  }

  function initialBundle(expiresAt: Date): OAuthTokenBundle {
    return {
      access_token: createJwt(expiresAt),
      refresh_token: "refresh-token-1",
      id_token: createIdToken(expiresAt, "account-1"),
      account_id: "account-1",
      last_refresh: new Date(expiresAt.getTime() - 60_000).toISOString(),
    };
  }

  it("applies the migration idempotently", async () => {
    await expect(runner.run((database) => database.select().from(oauthCredentials)))
      .resolves.toEqual([]);
  });

  it("keeps import insert-only", async () => {
    const bundle = initialBundle(new Date("2030-01-01T00:00:00.000Z"));
    const admin = createAdmin();
    await admin.importEncodedAuthJson(encodeAuthJson(bundle));

    await expect(
      admin.importEncodedAuthJson(encodeAuthJson(bundle)),
    ).rejects.toBeInstanceOf(OAuthCredentialConflictError);
    expect((await admin.getStatus())?.revision).toBe(1);
  });

  it("fails closed when the credential record is missing", async () => {
    const store = new NeonOAuthTokenStore({
      databaseRunner: runner,
      encryptionKey,
    });
    await expect(store.getValid()).rejects.toBeInstanceOf(
      OAuthCredentialMissingError,
    );
  });

  it("wraps an unavailable database without falling back", async () => {
    const unavailableRunner: OAuthDatabaseRunner = {
      run: async () => {
        throw new Error("database unavailable");
      },
    };
    const store = new NeonOAuthTokenStore({
      databaseRunner: unavailableRunner,
      encryptionKey,
    });

    await expect(store.getValid()).rejects.toBeInstanceOf(OAuthDatabaseError);
  });

  it("serializes ten concurrent refreshes into one OAuth request", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const oldBundle = initialBundle(new Date(now.getTime() + 60_000));
    const newExpiry = new Date(now.getTime() + 60 * 60_000);
    const newAccessToken = createJwt(newExpiry);
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
      await createAdmin().importEncodedAuthJson(encodeAuthJson(oldBundle));
      const stores = Array.from(
        { length: 10 },
        () =>
          new NeonOAuthTokenStore({
            databaseRunner: runner,
            encryptionKey,
            tokenUrl: oauthServer.url,
            now: () => now,
          }),
      );

      const credentials = await Promise.all(
        stores.map((store) => store.getValid()),
      );
      expect(credentials.map((value) => value.accessToken)).toEqual(
        Array(10).fill(newAccessToken),
      );
      expect(credentials.map((value) => value.accountId)).toEqual(
        Array(10).fill("account-2"),
      );
      expect(refreshRequests).toBe(1);
      expect((await createAdmin().getStatus())?.revision).toBe(2);
    } finally {
      await oauthServer.close();
    }
  });

  it("rolls the transaction back on invalid_grant", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const oldBundle = initialBundle(new Date(now.getTime() + 60_000));
    const oauthServer = await startHttpServer((_request, response) => {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "invalid_grant" }));
    });

    try {
      const admin = createAdmin();
      await admin.importEncodedAuthJson(encodeAuthJson(oldBundle));
      const store = new NeonOAuthTokenStore({
        databaseRunner: runner,
        encryptionKey,
        tokenUrl: oauthServer.url,
        now: () => now,
      });

      await expect(store.getValid()).rejects.toMatchObject({
        name: OAuthRefreshError.name,
        code: "invalid_grant",
      });
      expect((await admin.getStatus())?.revision).toBe(1);
      expect(parseEncodedAuthJson(await admin.exportEncodedAuthJson())).toEqual(
        oldBundle,
      );
    } finally {
      await oauthServer.close();
    }
  });

  it.each([
    {
      name: "a malformed OAuth response",
      expectedCode: "malformed_response",
      refreshTimeoutMs: 1_000,
      respond: (_request: IncomingMessage, response: import("node:http").ServerResponse) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ refresh_token: "missing-access-token" }));
      },
    },
    {
      name: "an OAuth timeout",
      expectedCode: "timeout",
      refreshTimeoutMs: 20,
      respond: () => {
        // Leave the request open until the client aborts it.
      },
    },
  ])("rolls back after $name", async ({ expectedCode, refreshTimeoutMs, respond }) => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const oldBundle = initialBundle(new Date(now.getTime() + 60_000));
    const oauthServer = await startHttpServer(respond);

    try {
      const admin = createAdmin();
      await admin.importEncodedAuthJson(encodeAuthJson(oldBundle));
      const store = new NeonOAuthTokenStore({
        databaseRunner: runner,
        encryptionKey,
        tokenUrl: oauthServer.url,
        now: () => now,
        refreshTimeoutMs,
      });

      await expect(store.getValid()).rejects.toMatchObject({
        name: OAuthRefreshError.name,
        code: expectedCode,
      });
      expect((await admin.getStatus())?.revision).toBe(1);
    } finally {
      await oauthServer.close();
    }
  });

  it("does not retry or refresh non-401 Codex responses", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const bundle = initialBundle(new Date(now.getTime() + 60 * 60_000));
    let requests = 0;
    const codexServer = await startHttpServer((_request, response) => {
      requests += 1;
      response.statusCode = 503;
      response.end("unavailable");
    });

    try {
      const admin = createAdmin();
      await admin.importEncodedAuthJson(encodeAuthJson(bundle));
      const store = new NeonOAuthTokenStore({
        databaseRunner: runner,
        encryptionKey,
        now: () => now,
      });
      const oauthFetch = createCodexAuthFetch(store, {
        baseUrl: codexServer.url,
      });

      const response = await oauthFetch(`${codexServer.url}/responses`);
      expect(response.status).toBe(503);
      expect(requests).toBe(1);
      expect((await admin.getStatus())?.revision).toBe(1);
    } finally {
      await codexServer.close();
    }
  });

  it("replaces auth headers and retries one 401 exactly once", async () => {
    const now = new Date("2029-01-01T00:00:00.000Z");
    const oldBundle = initialBundle(new Date(now.getTime() + 60 * 60_000));
    const newExpiry = new Date(now.getTime() + 2 * 60 * 60_000);
    const newAccessToken = createJwt(newExpiry);
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
    const observedAuth: string[] = [];
    const observedAccounts: string[] = [];
    const codexServer = await startHttpServer(
      (request: IncomingMessage, response) => {
        observedAuth.push(request.headers.authorization ?? "");
        observedAccounts.push(
          String(request.headers["chatgpt-account-id"] ?? ""),
        );
        response.statusCode = 401;
        response.end("unauthorized");
      },
    );

    try {
      const admin = createAdmin();
      await admin.importEncodedAuthJson(encodeAuthJson(oldBundle));
      const store = new NeonOAuthTokenStore({
        databaseRunner: runner,
        encryptionKey,
        tokenUrl: oauthServer.url,
        now: () => now,
      });
      const oauthFetch = createCodexAuthFetch(store, {
        baseUrl: codexServer.url,
      });

      const response = await oauthFetch(`${codexServer.url}/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer stale-placeholder",
          "chatgpt-account-id": "stale-account",
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: [] }),
      });

      expect(response.status).toBe(401);
      expect(observedAuth).toEqual([
        `Bearer ${oldBundle.access_token}`,
        `Bearer ${newAccessToken}`,
      ]);
      expect(observedAccounts).toEqual(["account-1", "account-2"]);
      expect(refreshRequests).toBe(1);
      expect((await admin.getStatus())?.revision).toBe(2);
    } finally {
      await codexServer.close();
      await oauthServer.close();
    }
  });
});
