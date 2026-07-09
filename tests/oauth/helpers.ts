import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export function createJwt(
  expiresAt: Date,
  extraClaims: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      ...extraClaims,
      exp: Math.floor(expiresAt.getTime() / 1_000),
    }),
    "utf8",
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

export function createIdToken(expiresAt: Date, accountId: string): string {
  return createJwt(expiresAt, {
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

export async function startHttpServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
