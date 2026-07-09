import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv, parse as parseEnv } from "dotenv";

import { OAuthCredentialAdmin } from "../agent/lib/oauth/admin.js";
import { decodeEncryptionKey } from "../agent/lib/oauth/crypto.js";
import { NeonOAuthDatabaseRunner } from "../agent/lib/oauth/database.js";
import {
  mergeNonEmptyEnvironment,
  resolveEncodedLocalAuthJson,
  type OAuthEnvironment,
} from "../agent/lib/oauth/environment.js";
import {
  OAuthConfigurationError,
  OAuthCredentialMissingError,
} from "../agent/lib/oauth/errors.js";
import { NeonOAuthTokenStore } from "../agent/lib/oauth/token-store.js";

const localEnv = loadEnv({ path: ".env.local", quiet: true }).parsed ?? {};
const commandEnv = mergeNonEmptyEnvironment(localEnv, process.env);

function requireEnvironmentValue(env: OAuthEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new OAuthConfigurationError(`${name} is required.`);
  return value;
}

function createAdminContext(env: OAuthEnvironment) {
  const databaseRunner = new NeonOAuthDatabaseRunner(
    requireEnvironmentValue(env, "DATABASE_URL"),
  );
  const encryptionKey = decodeEncryptionKey(
    requireEnvironmentValue(env, "OPENAI_OAUTH_ENCRYPTION_KEY"),
  );
  return {
    admin: new OAuthCredentialAdmin(databaseRunner, encryptionKey),
    tokenStore: new NeonOAuthTokenStore({ databaseRunner, encryptionKey }),
  };
}

async function spawnCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} failed ${signal ? `with signal ${signal}` : `with exit code ${code}`}.`,
        ),
      );
    });
  });
}

async function runMigrations(env: OAuthEnvironment): Promise<void> {
  const databaseUrl = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new OAuthConfigurationError(
      "DATABASE_URL_UNPOOLED or DATABASE_URL is required.",
    );
  }

  await spawnCommand(
    process.execPath,
    [join(process.cwd(), "node_modules/drizzle-kit/bin.cjs"), "migrate"],
    { ...process.env, ...env, DATABASE_URL_UNPOOLED: databaseUrl },
  );
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function prepareProduction(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "meiv-oauth-production-"),
  );
  const envFilePath = join(temporaryDirectory, "production.env");

  try {
    await chmod(temporaryDirectory, 0o700);
    await spawnCommand(
      process.platform === "win32" ? "vercel.cmd" : "vercel",
      [
        "env",
        "pull",
        envFilePath,
        "--environment=production",
        "--yes",
      ],
      process.env,
    );
    await chmod(envFilePath, 0o600);
    const productionEnv = mergeNonEmptyEnvironment(
      commandEnv,
      parseEnv(await readFile(envFilePath)),
    );

    if (
      productionEnv.VERCEL_ENV !== "production" &&
      productionEnv.VERCEL_TARGET_ENV !== "production"
    ) {
      throw new OAuthConfigurationError(
        "Pulled Vercel environment is not production.",
      );
    }

    if (!productionEnv.DATABASE_URL) {
      throw new OAuthConfigurationError(
        "DATABASE_URL is unavailable because Vercel redacted it. Add the Neon connection string to the current shell or .env.local.",
      );
    }
    if (!productionEnv.OPENAI_OAUTH_ENCRYPTION_KEY) {
      throw new OAuthConfigurationError(
        "OPENAI_OAUTH_ENCRYPTION_KEY is unavailable because Vercel cannot export encrypted values. Add it to the current shell or .env.local.",
      );
    }

    process.stderr.write("Applying production OAuth migrations...\n");
    await runMigrations(productionEnv);

    const { admin } = createAdminContext(productionEnv);
    const existingStatus = await admin.getStatus();
    if (!existingStatus) {
      process.stderr.write("Importing production OAuth credentials...\n");
      await admin.importEncodedAuthJson(
        await resolveEncodedLocalAuthJson(productionEnv),
      );
    } else {
      process.stderr.write(
        "OAuth credentials already exist; validating without overwrite...\n",
      );
    }

    writeJson(await admin.validateStoredCredential());
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare-production") {
    await prepareProduction();
    return;
  }
  if (command === "migrate") {
    await runMigrations(commandEnv);
    return;
  }

  const { admin, tokenStore } = createAdminContext(commandEnv);
  switch (command) {
    case "import":
      writeJson(
        await admin.importEncodedAuthJson(
          await resolveEncodedLocalAuthJson(commandEnv),
        ),
      );
      return;
    case "status": {
      const status = await admin.getStatus();
      if (!status) {
        throw new OAuthCredentialMissingError(
          "OAuth credential openai-primary does not exist.",
        );
      }
      writeJson(status);
      return;
    }
    case "refresh":
      await tokenStore.forceRefresh();
      writeJson(await admin.validateStoredCredential());
      return;
    case "export-b64":
      process.stdout.write(`${await admin.exportEncodedAuthJson()}\n`);
      return;
    default:
      throw new Error(
        "Usage: oauth <migrate|import|status|refresh|export-b64|prepare-production>",
      );
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Unknown failure.";
  process.stderr.write(`${name}: ${message}\n`);
  process.exitCode = 1;
});
