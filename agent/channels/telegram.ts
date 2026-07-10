import { telegramChannel } from "eve/channels/telegram";

import { transcribeAudio } from "../lib/audio/transcription.js";
import { createConfiguredAudioTranscriptionFetch } from "../lib/oauth/provider.js";
import { createTelegramVoiceOnMessage } from "../lib/telegram/voice.js";

const transcriptionFetch = createConfiguredAudioTranscriptionFetch();

export default telegramChannel({
  botUsername: "agents_swarm_bot",
  onMessage: createTelegramVoiceOnMessage((bytes) =>
    transcribeAudio(bytes, transcriptionFetch),
  ),
  uploadPolicy: {
    allowedMediaTypes: "*",
  },
});
