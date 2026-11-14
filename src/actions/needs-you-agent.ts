import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderAgentKey } from "../render/agent-key.js";
import { svgToDataUrl } from "../render/key-svg.js";
import { StatusHub } from "../state/status-hub.js";

export const NEEDS_YOU_AGENT_UUID = "com.zzsza.hide-status.needs-you-agent";

export type NeedsYouAgentSettings = {
  slot?: number;
};

@action({ UUID: NEEDS_YOU_AGENT_UUID })
export class NeedsYouAgentAction extends SingletonAction<NeedsYouAgentSettings> {
  private readonly hub: StatusHub;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly settingsByContext = new Map<string, NeedsYouAgentSettings>();

  constructor(hub: StatusHub) {
    super();
    this.hub = hub;
  }

  override onWillAppear(ev: WillAppearEvent<NeedsYouAgentSettings>): void {
    this.subscriptions.get(ev.action.id)?.();
    this.settingsByContext.set(ev.action.id, ev.payload.settings);

    const unsubscribe = this.hub.subscribe((snapshot) => {
      if (ev.action.isKey()) {
        const currentSettings = this.settingsByContext.get(ev.action.id);
        const svg = renderAgentKey(snapshot, { slot: currentSettings?.slot });
        void ev.action.setImage(svgToDataUrl(svg));
      }
    });

    this.subscriptions.set(ev.action.id, unsubscribe);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<NeedsYouAgentSettings>): void {
    this.settingsByContext.set(ev.action.id, ev.payload.settings);
    const snapshot = this.hub.getLastSnapshot();
    if (snapshot !== null && ev.action.isKey()) {
      const svg = renderAgentKey(snapshot, { slot: ev.payload.settings.slot });
      void ev.action.setImage(svgToDataUrl(svg));
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<NeedsYouAgentSettings>): void {
    this.settingsByContext.delete(ev.action.id);
    const unsubscribe = this.subscriptions.get(ev.action.id);
    if (unsubscribe) {
      this.subscriptions.delete(ev.action.id);
      unsubscribe();
    }
  }
}
