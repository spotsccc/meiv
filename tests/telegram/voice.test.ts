import {
  parseTelegramUpdate,
  type TelegramApiOptions,
  type TelegramContext,
  type TelegramHandle,
  type TelegramMessage,
  type TelegramMessageBody,
  type TelegramMessageResult,
} from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { transcribeAudio } from "../../agent/lib/audio/transcription.js";
import { createAudioTranscriptionAuthFetch } from "../../agent/lib/oauth/fetch.js";
import type {
  EffectiveAuth,
  OAuthTokenStore,
} from "../../agent/lib/oauth/types.js";
import { createTelegramVoiceOnMessage } from "../../agent/lib/telegram/voice.js";

const failureMessage =
  "I couldn't transcribe that voice message. Please try again or send it as text.";
const transcriptContext = (text: string) =>
  `<telegram_voice_transcription>\n${text}\n</telegram_voice_transcription>`;

function parseMessage(
  overrides: Record<string, unknown> = {},
): TelegramMessage {
  const update = parseTelegramUpdate({
    message: {
      message_id: 42,
      chat: { id: 100, type: "private" },
      from: { id: 200, is_bot: false, username: "voice_user" },
      ...overrides,
    },
  });
  if (!update || update.kind !== "message") throw new Error("Invalid fixture");
  return update.message;
}

function createContext(botUsername = "agents_swarm_bot") {
  const posts: Array<string | TelegramMessageBody> = [];
  const typing: string[] = [];
  const result: TelegramMessageResult = { id: "1", raw: null };
  const post = async (message: string | TelegramMessageBody) => {
    posts.push(message);
    return result;
  };
  const telegram: TelegramHandle = {
    botUsername,
    chatId: "100",
    chatType: "private",
    conversationId: undefined,
    messageThreadId: undefined,
    request: async () => ({ body: null, ok: true, status: 200 }),
    post,
    sendMessage: post,
    startTyping: async (action = "typing") => {
      typing.push(action);
    },
    answerCallbackQuery: async () => ({ body: null, ok: true, status: 200 }),
    editMessageReplyMarkup: async () => ({ body: null, ok: true, status: 200 }),
  };
  return { context: { telegram } satisfies TelegramContext, posts, typing };
}

function createTelegramApi(bytes = Uint8Array.from([1, 2, 3, 4])): {
  options: TelegramApiOptions;
  paths: string[];
} {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    paths.push(url.pathname);
    if (url.pathname === "/bottest-token/getFile") {
      return Response.json({
        ok: true,
        result: { file_path: "voice/file.ogg" },
      });
    }
    if (url.pathname === "/file/bottest-token/voice/file.ogg") {
      return new Response(bytes, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    options: {
      apiBaseUrl: "https://telegram.test",
      fileBaseUrl: "https://telegram.test",
      credentials: { botToken: "test-token" },
      fetch,
    },
    paths,
  };
}

const voice = () => ({
  file_id: "voice-file-1",
  file_size: 4,
  duration: 1,
  mime_type: "audio/ogg",
});

describe("Telegram voice handler", () => {
  it("downloads and transcribes private voice into durable context", async () => {
    const { context, posts, typing } = createContext();
    const api = createTelegramApi();
    const auth: EffectiveAuth = {
      accessToken: "audio-token",
      accountId: "account-1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const store: OAuthTokenStore = {
      getValid: async () => auth,
      refreshAfterUnauthorized: async () => auth,
      forceRefresh: async () => auth,
    };
    let transcriptionRequest: Request | undefined;
    const transcriptionFetch = createAudioTranscriptionAuthFetch(
      store,
      async (input, init) => {
        transcriptionRequest = new Request(input, init);
        return Response.json({ text: "  book a table for two  " });
      },
    );
    const onMessage = createTelegramVoiceOnMessage(
      (bytes) => transcribeAudio(bytes, transcriptionFetch),
      api.options,
    );

    const result = await onMessage(context, parseMessage({ voice: voice() }));

    expect(result).toEqual({
      auth: expect.objectContaining({ principalId: "telegram:200" }),
      context: [transcriptContext("book a table for two")],
    });
    expect(api.paths).toEqual([
      "/bottest-token/getFile",
      "/file/bottest-token/voice/file.ogg",
    ]);
    expect(transcriptionRequest?.headers.get("authorization")).toBe(
      "Bearer audio-token",
    );
    expect(
      transcriptionRequest?.headers.get("chatgpt-account-id"),
    ).toBeNull();
    const formData = await transcriptionRequest?.formData();
    expect(formData?.get("model")).toBe("gpt-4o-mini-transcribe");
    const file = formData?.get("file") as File;
    expect(file.type).toBe("audio/ogg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      Uint8Array.from([1, 2, 3, 4]),
    );
    expect(typing).toEqual(["typing"]);
    expect(posts).toEqual([]);
  });

  it("preserves group reply, mention, and command gating", async () => {
    const { context, typing } = createContext();
    const api = createTelegramApi();
    const onMessage = createTelegramVoiceOnMessage(
      async () => "hello",
      api.options,
    );
    const group = { id: -100, type: "supergroup", title: "Group" };

    const ignored = await onMessage(
      context,
      parseMessage({ chat: group, voice: voice() }),
    );
    const reply = await onMessage(
      context,
      parseMessage({
        chat: group,
        voice: voice(),
        reply_to_message: {
          message_id: 10,
          chat: group,
          from: { id: 999, is_bot: true },
        },
      }),
    );
    const mention = await onMessage(
      context,
      parseMessage({
        chat: group,
        caption: "@agents_swarm_bot summarize",
        voice: voice(),
      }),
    );
    const command = await onMessage(
      context,
      parseMessage({
        chat: group,
        caption: "/ask@agents_swarm_bot summarize",
        voice: voice(),
      }),
    );

    expect(ignored).toBeNull();
    for (const result of [reply, mention, command]) {
      expect(result).toEqual(
        expect.objectContaining({ context: [transcriptContext("hello")] }),
      );
    }
    expect(api.paths).toHaveLength(6);
    expect(typing).toEqual(["typing", "typing", "typing"]);
  });

  it("keeps text, document, and photo on the normal auth path", async () => {
    const { context, typing } = createContext();
    const api = createTelegramApi();
    const transcribe = vi.fn(async () => "unused");
    const onMessage = createTelegramVoiceOnMessage(transcribe, api.options);
    const messages = [
      parseMessage({ text: "hello" }),
      parseMessage({
        document: {
          file_id: "document-1",
          file_name: "notes.txt",
          mime_type: "text/plain",
        },
      }),
      parseMessage({
        photo: [{ file_id: "photo-1", width: 320, height: 200 }],
      }),
    ];

    for (const message of messages) {
      expect(await onMessage(context, message)).toEqual({
        auth: expect.objectContaining({ principalId: "telegram:200" }),
      });
    }
    expect(api.paths).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    expect(typing).toEqual(["typing", "typing", "typing"]);
  });

  it("rejects a voice declared above the transcription limit", async () => {
    const { context, posts } = createContext();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const transcribe = vi.fn(async () => "unused");
    const onMessage = createTelegramVoiceOnMessage(transcribe);

    try {
      expect(
        await onMessage(
          context,
          parseMessage({
            voice: { ...voice(), file_size: 26 * 1024 * 1024 },
          }),
        ),
      ).toBeNull();
      expect(posts).toEqual([failureMessage]);
      expect(transcribe).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("notifies and drops the turn after transcription failure", async () => {
    const { context, posts } = createContext();
    const api = createTelegramApi();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onMessage = createTelegramVoiceOnMessage(async () => {
      throw new Error("sensitive upstream details");
    }, api.options);

    try {
      expect(await onMessage(context, parseMessage({ voice: voice() }))).toBeNull();
      expect(posts).toEqual([failureMessage]);
      const log = String(consoleError.mock.calls[0]?.[0]);
      expect(log).toContain('"errorClass":"Error"');
      expect(log).not.toContain("sensitive upstream details");
    } finally {
      consoleError.mockRestore();
    }
  });
});
