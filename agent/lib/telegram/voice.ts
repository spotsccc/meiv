import {
  defaultTelegramAuth,
  downloadTelegramFile,
  getTelegramFile,
  type TelegramApiOptions,
  type TelegramContext,
  type TelegramInboundResult,
  type TelegramMessage,
} from "eve/channels/telegram";
import { z } from "zod";

const MAX_TELEGRAM_VOICE_BYTES = 25 * 1024 * 1024;

const failureMessage =
  "I couldn't transcribe that voice message. Please try again or send it as text.";
const voiceSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().max(MAX_TELEGRAM_VOICE_BYTES).optional(),
});

function shouldDispatch(message: TelegramMessage, bot: string | undefined) {
  if (message.chat.type === "channel") return false;
  const text = message.text || message.caption;
  const hasContent =
    Boolean(text.trim()) ||
    message.attachments.length > 0 ||
    message.raw.voice !== undefined;
  if (!hasContent) return false;
  if (message.chat.type === "private" || message.replyToMessage?.from?.isBot) {
    return true;
  }

  const command =
    /^\/[A-Za-z0-9_]+(?:@(?<target>[A-Za-z0-9_]+))?(?:\s|$)/u.exec(text);
  const target = command?.groups?.target;
  return Boolean(
    (command &&
      (target === undefined || target.toLowerCase() === bot?.toLowerCase())) ||
      (bot && text.toLowerCase().includes(`@${bot.toLowerCase()}`)),
  );
}

export function createTelegramVoiceOnMessage(
  transcribe: (bytes: Uint8Array) => Promise<string>,
  api: TelegramApiOptions = {},
) {
  return async (
    ctx: TelegramContext,
    message: TelegramMessage,
  ): Promise<TelegramInboundResult> => {
    if (!shouldDispatch(message, ctx.telegram.botUsername)) return null;
    await ctx.telegram.startTyping();
    if (message.raw.voice === undefined) {
      return { auth: defaultTelegramAuth(message) };
    }

    try {
      const voice = voiceSchema.parse(message.raw.voice);
      const file = await getTelegramFile({ ...api, fileId: voice.file_id });
      const response = await downloadTelegramFile({
        ...api,
        filePath: file.filePath,
      });
      if (!response.ok) {
        throw new Error(`Telegram download HTTP ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_TELEGRAM_VOICE_BYTES
      ) {
        throw new RangeError("Voice is empty or too large");
      }
      const text = await transcribe(bytes);
      return {
        auth: defaultTelegramAuth(message),
        context: [
          `<telegram_voice_transcription>\n${text}\n</telegram_voice_transcription>`,
        ],
      };
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "telegram_voice_transcription_failed",
          errorClass: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      await ctx.telegram.post(failureMessage);
      return null;
    }
  };
}
