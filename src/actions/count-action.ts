import {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { renderCountKey, type CountKeyKind, type DashboardKey } from "../render/count-key.js";
import { svgToDataUrl } from "../render/key-svg.js";
import { StatusHub } from "../state/status-hub.js";
import { openHideOnKeyDown } from "./open-hide.js";

export class CountAction extends SingletonAction {
  override readonly manifestId: string;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly lastSvgByContext = new Map<string, string>();

  constructor(private readonly hub: StatusHub, private readonly kind: CountKeyKind | DashboardKey, uuid: string) {
    super();
    this.manifestId = uuid;
  }

  override onKeyDown = openHideOnKeyDown;

  override onWillAppear(ev: WillAppearEvent): void {
    this.subscriptions.get(ev.action.id)?.();
    this.lastSvgByContext.delete(ev.action.id);

    if (ev.action.isKey() && typeof ev.action.setTitle === "function") {
      void ev.action.setTitle("");
    }

    const unsubscribe = this.hub.subscribe((snapshot) => {
      if (ev.action.isKey()) {
        const svg = renderCountKey(this.kind, snapshot);
        if (this.lastSvgByContext.get(ev.action.id) === svg) {
          return;
        }
        this.lastSvgByContext.set(ev.action.id, svg);
        void ev.action.setImage(svgToDataUrl(svg));
      }
    }, this.kind !== "working" && this.kind !== "needs_you" && this.kind !== "to-read");

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
}
