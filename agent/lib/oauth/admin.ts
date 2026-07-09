import { eq } from "drizzle-orm";

import {
  encodeAuthJson,
  getAccessTokenExpiry,
  parseEncodedAuthJson,
} from "./auth.js";
import { decryptTokenBundle, encryptTokenBundle } from "./crypto.js";
import type { OAuthDatabase, OAuthDatabaseRunner } from "./database.js";
import {
  OAuthCredentialConflictError,
  OAuthCredentialInvalidError,
  OAuthCredentialMissingError,
  OAuthDatabaseError,
  OAuthStorageError,
} from "./errors.js";
import { oauthCredentials, type OAuthCredentialRow } from "./schema.js";
import {
  PRIMARY_OAUTH_CREDENTIAL_ID,
  type OAuthCredentialStatus,
} from "./types.js";

function toStatus(row: OAuthCredentialRow): OAuthCredentialStatus {
  return {
    id: row.id,
    accessExpiresAt: row.accessExpiresAt.toISOString(),
    revision: row.revision,
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class OAuthCredentialAdmin {
  constructor(
    private readonly databaseRunner: OAuthDatabaseRunner,
    private readonly encryptionKey: Buffer,
  ) {}

  async getStatus(): Promise<OAuthCredentialStatus | null> {
    return this.runDatabaseOperation(async (database) => {
      const row = await this.readCredential(database);
      return row ? toStatus(row) : null;
    });
  }

  async importEncodedAuthJson(
    encodedAuthJson: string,
  ): Promise<OAuthCredentialStatus> {
    const bundle = parseEncodedAuthJson(encodedAuthJson);
    const accessExpiresAt = getAccessTokenExpiry(bundle.access_token);
    const encryptedPayload = encryptTokenBundle(
      bundle,
      this.encryptionKey,
      PRIMARY_OAUTH_CREDENTIAL_ID,
    );
    const refreshedAt = bundle.last_refresh
      ? new Date(bundle.last_refresh)
      : null;
    if (refreshedAt && Number.isNaN(refreshedAt.getTime())) {
      throw new OAuthCredentialInvalidError(
        "OAuth last_refresh is not a valid timestamp.",
      );
    }

    return this.runDatabaseOperation(async (database) => {
      const [inserted] = await database
        .insert(oauthCredentials)
        .values({
          id: PRIMARY_OAUTH_CREDENTIAL_ID,
          encryptedPayload,
          accessExpiresAt,
          refreshedAt,
        })
        .onConflictDoNothing({ target: oauthCredentials.id })
        .returning();

      if (!inserted) {
        throw new OAuthCredentialConflictError(
          `OAuth credential ${PRIMARY_OAUTH_CREDENTIAL_ID} already exists.`,
        );
      }
      return toStatus(inserted);
    });
  }

  async validateStoredCredential(): Promise<OAuthCredentialStatus> {
    return this.runDatabaseOperation(async (database) => {
      const row = await this.readCredential(database);
      if (!row) {
        throw new OAuthCredentialMissingError(
          `OAuth credential ${PRIMARY_OAUTH_CREDENTIAL_ID} does not exist.`,
        );
      }
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
      return toStatus(row);
    });
  }

  async exportEncodedAuthJson(): Promise<string> {
    return this.runDatabaseOperation(async (database) => {
      const row = await this.readCredential(database);
      if (!row) {
        throw new OAuthCredentialMissingError(
          `OAuth credential ${PRIMARY_OAUTH_CREDENTIAL_ID} does not exist.`,
        );
      }
      const bundle = decryptTokenBundle(
        row.encryptedPayload,
        this.encryptionKey,
        row.id,
      );
      return encodeAuthJson(bundle);
    });
  }

  private async readCredential(
    database: OAuthDatabase,
  ): Promise<OAuthCredentialRow | null> {
    const [row] = await database
      .select()
      .from(oauthCredentials)
      .where(eq(oauthCredentials.id, PRIMARY_OAUTH_CREDENTIAL_ID))
      .limit(1);
    return row ?? null;
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
}
