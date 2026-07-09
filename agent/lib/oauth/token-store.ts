import { eq, sql } from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";

import {
  deriveAccountId,
  getAccessTokenExpiry,
  refreshErrorResponseSchema,
  refreshResponseSchema,
} from "./auth.js";
import { decryptTokenBundle, encryptTokenBundle } from "./crypto.js";
import type { OAuthDatabase, OAuthDatabaseRunner } from "./database.js";
import {
  OAuthCredentialInvalidError,
  OAuthCredentialMissingError,
  OAuthDatabaseError,
  OAuthRefreshError,
  OAuthStorageError,
} from "./errors.js";
import { oauthCredentials, type OAuthCredentialRow } from "./schema.js";
import {
  PRIMARY_OAUTH_CREDENTIAL_ID,
  type EffectiveAuth,
  type OAuthTokenBundle,
  type OAuthTokenStore,
} from "./types.js";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REFRESH_MARGIN_MS = 5 * 60 * 1_000;

export function shouldRefreshAccessToken(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime() + REFRESH_MARGIN_MS;
}

type RefreshReason = "expiry" | "unauthorized" | "forced";
type OAuthTransaction = Parameters<
  Parameters<OAuthDatabase["transaction"]>[0]
>[0];
type OAuthQueryExecutor = Pick<
  PgAsyncDatabase<any, any>,
  "select" | "update"
>;

export type NeonOAuthTokenStoreOptions = {
  databaseRunner: OAuthDatabaseRunner;
  encryptionKey: Buffer;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  clientId?: string;
  tokenUrl?: string;
  refreshTimeoutMs?: number;
};

type DecodedCredential = {
  bundle: OAuthTokenBundle;
  expiresAt: Date;
};

async function readCredential(
  database: OAuthQueryExecutor,
  lockForUpdate: boolean,
): Promise<OAuthCredentialRow> {
  const baseQuery = database
    .select()
    .from(oauthCredentials)
    .where(eq(oauthCredentials.id, PRIMARY_OAUTH_CREDENTIAL_ID))
    .limit(1);
  const rows = lockForUpdate ? await baseQuery.for("update") : await baseQuery;
  const row = rows[0];
  if (!row) {
    throw new OAuthCredentialMissingError(
      `OAuth credential ${PRIMARY_OAUTH_CREDENTIAL_ID} does not exist.`,
    );
  }
  return row;
}

function logRefreshFailure(reason: RefreshReason, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "oauth_refresh_failed",
      reason,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    }),
  );
}

export class NeonOAuthTokenStore implements OAuthTokenStore {
  private readonly databaseRunner: OAuthDatabaseRunner;
  private readonly encryptionKey: Buffer;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly clientId: string;
  private readonly tokenUrl: string;
  private readonly refreshTimeoutMs: number;

  constructor(options: NeonOAuthTokenStoreOptions) {
    this.databaseRunner = options.databaseRunner;
    this.encryptionKey = options.encryptionKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 10_000;
  }

  async getValid(): Promise<EffectiveAuth> {
    return this.runDatabaseOperation(async (database) => {
      const row = await readCredential(database, false);
      const credential = this.decodeCredential(row);
      if (!shouldRefreshAccessToken(credential.expiresAt, this.now())) {
        return this.toEffectiveAuth(credential);
      }

      return database.transaction((transaction) =>
        this.refreshLocked(transaction, "expiry"),
      );
    });
  }

  async refreshAfterUnauthorized(
    rejectedAccessToken: string,
  ): Promise<EffectiveAuth> {
    return this.runDatabaseOperation((database) =>
      database.transaction((transaction) =>
        this.refreshLocked(transaction, "unauthorized", rejectedAccessToken),
      ),
    );
  }

  async forceRefresh(): Promise<EffectiveAuth> {
    return this.runDatabaseOperation((database) =>
      database.transaction((transaction) =>
        this.refreshLocked(transaction, "forced"),
      ),
    );
  }

  private async runDatabaseOperation<T>(
    operation: (database: OAuthDatabase) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.databaseRunner.run(operation);
    } catch (error) {
      if (error instanceof OAuthStorageError) throw error;
      throw new OAuthDatabaseError("OAuth database operation failed.", {
        cause: error,
      });
    }
  }

  private decodeCredential(row: OAuthCredentialRow): DecodedCredential {
    const bundle = decryptTokenBundle(
      row.encryptedPayload,
      this.encryptionKey,
      row.id,
    );
    const expiresAt = getAccessTokenExpiry(bundle.access_token);
    if (expiresAt.getTime() !== row.accessExpiresAt.getTime()) {
      throw new OAuthCredentialInvalidError(
        "Stored OAuth expiry metadata does not match the access token.",
      );
    }
    return { bundle, expiresAt };
  }

  private toEffectiveAuth(credential: DecodedCredential): EffectiveAuth {
    return {
      accessToken: credential.bundle.access_token,
      accountId: credential.bundle.account_id,
      expiresAt: credential.expiresAt,
    };
  }

  private async refreshLocked(
    transaction: OAuthTransaction,
    reason: RefreshReason,
    rejectedAccessToken?: string,
  ): Promise<EffectiveAuth> {
    const row = await readCredential(transaction, true);
    const current = this.decodeCredential(row);

    if (
      reason === "unauthorized" &&
      rejectedAccessToken !== current.bundle.access_token
    ) {
      return this.toEffectiveAuth(current);
    }

    if (
      reason === "expiry" &&
      !shouldRefreshAccessToken(current.expiresAt, this.now())
    ) {
      return this.toEffectiveAuth(current);
    }

    try {
      const refreshed = await this.requestRefresh(current.bundle);
      const encryptedPayload = encryptTokenBundle(
        refreshed.bundle,
        this.encryptionKey,
        row.id,
      );
      const refreshedAt = this.now();
      const [updated] = await transaction
        .update(oauthCredentials)
        .set({
          encryptedPayload,
          accessExpiresAt: refreshed.expiresAt,
          revision: sql`${oauthCredentials.revision} + 1`,
          refreshedAt,
          updatedAt: refreshedAt,
        })
        .where(eq(oauthCredentials.id, row.id))
        .returning({ revision: oauthCredentials.revision });

      if (!updated) {
        throw new OAuthCredentialMissingError(
          `OAuth credential ${row.id} disappeared during refresh.`,
        );
      }

      console.info(
        JSON.stringify({
          event: "oauth_refresh_succeeded",
          reason,
          revision: updated.revision,
          accessExpiresAt: refreshed.expiresAt.toISOString(),
        }),
      );

      return this.toEffectiveAuth(refreshed);
    } catch (error) {
      logRefreshFailure(reason, error);
      throw error;
    }
  }

  private async requestRefresh(bundle: OAuthTokenBundle): Promise<DecodedCredential> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);

    try {
      const response = await this.fetch(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: bundle.refresh_token,
          client_id: this.clientId,
          scope: "openid profile email offline_access",
        }),
        signal: controller.signal,
      });

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new OAuthRefreshError("malformed_response", { cause: error });
      }

      if (!response.ok) {
        const parsedError = refreshErrorResponseSchema.safeParse(responseBody);
        throw new OAuthRefreshError(
          parsedError.success && parsedError.data.error === "invalid_grant"
            ? "invalid_grant"
            : `http_${response.status}`,
        );
      }

      const parsed = refreshResponseSchema.safeParse(responseBody);
      if (!parsed.success) {
        throw new OAuthRefreshError("malformed_response", {
          cause: parsed.error,
        });
      }

      const refreshedAt = this.now();
      const idToken = parsed.data.id_token ?? bundle.id_token;
      const refreshedBundle: OAuthTokenBundle = {
        access_token: parsed.data.access_token,
        refresh_token: parsed.data.refresh_token ?? bundle.refresh_token,
        id_token: idToken,
        account_id: deriveAccountId(idToken) ?? bundle.account_id,
        last_refresh: refreshedAt.toISOString(),
      };
      const expiresAt = getAccessTokenExpiry(refreshedBundle.access_token);
      if (expiresAt.getTime() <= refreshedAt.getTime()) {
        throw new OAuthRefreshError("expired_access_token");
      }

      return { bundle: refreshedBundle, expiresAt };
    } catch (error) {
      if (error instanceof OAuthRefreshError) throw error;
      if (controller.signal.aborted) {
        throw new OAuthRefreshError("timeout", { cause: error });
      }
      throw new OAuthRefreshError("network_error", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
