import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import WebSocket from "ws";

export type OAuthDatabase = PgAsyncDatabase<PgQueryResultHKT, any>;

export interface OAuthDatabaseRunner {
  run<T>(operation: (database: OAuthDatabase) => Promise<T>): Promise<T>;
}

export class NeonOAuthDatabaseRunner implements OAuthDatabaseRunner {
  constructor(private readonly connectionString: string) {}

  async run<T>(operation: (database: OAuthDatabase) => Promise<T>): Promise<T> {
    neonConfig.webSocketConstructor = WebSocket;
    const pool = new Pool({
      connectionString: this.connectionString,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });
    const database = drizzle({ client: pool }) as OAuthDatabase;

    try {
      return await operation(database);
    } finally {
      await pool.end();
    }
  }
}
