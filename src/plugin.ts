import streamDeck from "@elgato/streamdeck";

import { NeedsYouAgentAction } from "./actions/needs-you-agent.js";
import { NeedsYouCountAction } from "./actions/needs-you-count.js";
import { WorkingCountAction } from "./actions/working-count.js";
import type { GlobalSettings } from "./source/types.js";
import { StatusHub } from "./state/status-hub.js";

const statusHub = new StatusHub({
  onListenerError: (error) => {
    streamDeck.logger.error("StatusHub error:", error);
  },
});

let hasReceivedGlobalSettings = false;

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  hasReceivedGlobalSettings = true;
  statusHub.updateSettings(ev.settings);
});

streamDeck.actions.registerAction(new WorkingCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouAgentAction(statusHub));

async function bootstrap(): Promise<void> {
  await streamDeck.connect();
  const initialSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  if (!hasReceivedGlobalSettings) {
    statusHub.updateSettings(initialSettings);
  }
}

void bootstrap();
