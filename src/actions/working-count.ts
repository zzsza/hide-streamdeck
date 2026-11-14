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
  private readonly lastSvgByContext = new Map<string, string>();

  constructor(hub: StatusHub) {
    super();
    this.hub = hub;
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.subscriptions.get(ev.action.id)?.();
    this.lastSvgByContext.delete(ev.action.id);

    if (ev.action.isKey() && typeof ev.action.setTitle === "function") {
      void ev.action.setTitle("");
    }

    const unsubscribe = this.hub.subscribe((snapshot) => {
      if (ev.action.isKey()) {
        const svg = renderWorkingCountKey(snapshot);
        if (this.lastSvgByContext.get(ev.action.id) === svg) {
          return;
        }
        this.lastSvgByContext.set(ev.action.id, svg);
        void ev.action.setImage(svgToDataUrl(svg));
      }
    });

    this.subscriptions.set(ev.action.id, unsubscribe);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.lastSvgByContext.delete(ev.action.id);
    const unsubscribe = this.subscriptions.get(ev.action.id);
    if (unsubscribe) {
      this.subscriptions.delete(ev.action.id);
      unsubscribe();
    }
  }

  override onKeyDown(): void {
    this.hub.retry();
  }
}
