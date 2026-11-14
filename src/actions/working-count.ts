import {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderWorkingCountKey } from "../render/count-key.js";
import { svgToDataUrl } from "../render/key-svg.js";
import { StatusHub } from "../state/status-hub.js";

export const WORKING_COUNT_UUID = "com.zzsza.hide-status.working-count";

@action({ UUID: WORKING_COUNT_UUID })
export class WorkingCountAction extends SingletonAction {
  private readonly hub: StatusHub;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(hub: StatusHub) {
    super();
    this.hub = hub;
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.subscriptions.get(ev.action.id)?.();

    const unsubscribe = this.hub.subscribe((snapshot) => {
      if (ev.action.isKey()) {
        const svg = renderWorkingCountKey(snapshot);
        void ev.action.setImage(svgToDataUrl(svg));
      }
    });

    this.subscriptions.set(ev.action.id, unsubscribe);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const unsubscribe = this.subscriptions.get(ev.action.id);
    if (unsubscribe) {
      this.subscriptions.delete(ev.action.id);
      unsubscribe();
    }
  }
}
