import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

loadEnv({
  path: process.env.DOTENV_CONFIG_PATH ?? ".env.local",
  quiet: true,
});

const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./agent/lib/oauth/schema.ts",
  out: "./drizzle",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
});
