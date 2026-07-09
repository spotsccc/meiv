import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { EncryptedOAuthPayload } from "./types.js";

export const oauthCredentials = pgTable("oauth_credentials", {
  id: text("id").primaryKey(),
  encryptedPayload: jsonb("encrypted_payload")
    .$type<EncryptedOAuthPayload>()
    .notNull(),
  accessExpiresAt: timestamp("access_expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  refreshedAt: timestamp("refreshed_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
});

export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
