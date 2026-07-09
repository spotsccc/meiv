import { telegramChannel } from "eve/channels/telegram";

export default telegramChannel({
  botUsername: "agents_swarm_bot",
  uploadPolicy: {
    allowedMediaTypes: "*",
  },
});
