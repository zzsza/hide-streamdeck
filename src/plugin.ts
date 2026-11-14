import streamDeck from "@elgato/streamdeck";

import { NeedsYouAgentAction } from "./actions/needs-you-agent.js";
import { NeedsYouCountAction } from "./actions/needs-you-count.js";
import { WorkingCountAction } from "./actions/working-count.js";
import type { GlobalSettings } from "./source/types.js";
import { StatusHub } from "./state/status-hub.js";

const statusHub = new StatusHub();

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  statusHub.updateSettings(ev.settings);
});

streamDeck.actions.registerAction(new WorkingCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouAgentAction(statusHub));

async function bootstrap(): Promise<void> {
  await streamDeck.connect();
  const initialSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  statusHub.updateSettings(initialSettings);
}

void bootstrap();
