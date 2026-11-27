import streamDeck from "@elgato/streamdeck";

import { CountAction } from "./actions/count-action.js";
import { DASHBOARD_LABELS, type DashboardKey } from "./render/count-key.js";
import { NeedsYouAgentAction } from "./actions/needs-you-agent.js";
import { NeedsYouCountAction } from "./actions/needs-you-count.js";
import { WorkingCountAction } from "./actions/working-count.js";
import { WEEKLY_USAGE_LABELS, WeeklyUsageAction, WeeklyUsagePoll, type UsageProvider } from "./actions/weekly-usage.js";
import type { ConnectionKind, ConnectionState, GlobalSettings } from "./source/types.js";
import { StatusHub } from "./state/status-hub.js";

export type PropertyInspectorConnectionMessage = {
  event: "connection";
  kind: ConnectionKind;
  refusalCode?: string;
};

export interface PropertyInspectorUi {
  onSendToPlugin(listener: (ev: { payload: unknown }) => void): { dispose(): void } | void;
  sendToPropertyInspector(payload: PropertyInspectorConnectionMessage): Promise<void>;
  onDidAppear?(listener: (ev: { action: { id: string } }) => void): { dispose(): void } | void;
  onDidDisappear?(listener: (ev: { action: { id: string } }) => void): { dispose(): void } | void;
}

function isRequestAccessPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { event?: unknown }).event === "requestAccess"
  );
}

export function wirePropertyInspector(
  ui: PropertyInspectorUi,
  hub: StatusHub,
  onError?: (error: unknown) => void,
): () => void {
  const sendConnection = (state: ConnectionState): void => {
    const message: PropertyInspectorConnectionMessage = { event: "connection", kind: state.kind };
    if (state.kind === "error" && state.refusalCode && /^[a-z][a-z0-9_.-]{0,79}$/i.test(state.refusalCode)) {
      message.refusalCode = state.refusalCode;
    }
    void ui.sendToPropertyInspector(message).catch((error: unknown) => {
      onError?.(error);
    });
  };

  const stopSnapshotObserver = hub.onSnapshot((snapshot) => {
    sendConnection(snapshot.connection);
  });

  const sendToPluginSub = ui.onSendToPlugin((ev) => {
    if (isRequestAccessPayload(ev.payload)) {
      hub.requestAccess();
    }
  });

  let currentPiActionId: string | null = null;
  let appearanceDepth = 0;
  let stopPiHubSubscription: (() => void) | null = null;

  const appearSub = ui.onDidAppear?.((ev) => {
    if (currentPiActionId === ev.action.id) {
      appearanceDepth += 1;
    } else {
      currentPiActionId = ev.action.id;
      appearanceDepth = 1;
    }

    const cachedSnapshot = hub.getLastSnapshot();
    if (stopPiHubSubscription === null) {
      stopPiHubSubscription = hub.subscribe(() => {});
    }
    if (cachedSnapshot !== null) {
      sendConnection(cachedSnapshot.connection);
    }
  });

  const disappearSub = ui.onDidDisappear?.((ev) => {
    if (currentPiActionId !== ev.action.id) {
      return;
    }
    appearanceDepth -= 1;
    if (appearanceDepth <= 0) {
      currentPiActionId = null;
      appearanceDepth = 0;
      stopPiHubSubscription?.();
      stopPiHubSubscription = null;
    }
  });

  return () => {
    stopSnapshotObserver();
    sendToPluginSub?.dispose();
    appearSub?.dispose();
    disappearSub?.dispose();
    stopPiHubSubscription?.();
    stopPiHubSubscription = null;
  };
}

const statusHub = new StatusHub({
  onListenerError: (error) => {
    streamDeck.logger.error("StatusHub error:", error);
  },
});

wirePropertyInspector(streamDeck.ui, statusHub, (error) => {
  streamDeck.logger.error("Property Inspector message error:", error);
});

let hasReceivedGlobalSettings = false;

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  hasReceivedGlobalSettings = true;
  statusHub.updateSettings(ev.settings);
});

streamDeck.actions.registerAction(new WorkingCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouCountAction(statusHub));
streamDeck.actions.registerAction(new NeedsYouAgentAction(statusHub));

for (const kind of Object.keys(DASHBOARD_LABELS) as DashboardKey[]) {
  streamDeck.actions.registerAction(new CountAction(statusHub, kind, `com.zzsza.hide-status.${kind}`));
}

const weeklyUsage = new WeeklyUsagePoll();
for (const provider of Object.keys(WEEKLY_USAGE_LABELS) as UsageProvider[]) {
  streamDeck.actions.registerAction(new WeeklyUsageAction(provider, weeklyUsage));
}

async function bootstrap(): Promise<void> {
  await streamDeck.connect();
  const initialSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  if (!hasReceivedGlobalSettings) {
    statusHub.updateSettings(initialSettings);
  }
}

void bootstrap();
