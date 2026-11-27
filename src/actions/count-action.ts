import {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { selectWorkingAgent, normalizeAgentSlot } from "../render/agent-key.js";
import { renderCountKey, type CountKeyKind, type DashboardKey } from "../render/count-key.js";
import { svgToDataUrl } from "../render/key-svg.js";
import type { HideSnapshot } from "../source/types.js";
import { StatusHub } from "../state/status-hub.js";
import { openHideOnKeyDown } from "./open-hide.js";

type CountSettings = { slot?: number };

export class CountAction extends SingletonAction<CountSettings> {
  override readonly manifestId: string;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly keys = new Map<string, { slot: number; lastSvg?: string }>();

  constructor(private readonly hub: StatusHub, private readonly kind: CountKeyKind | DashboardKey, uuid: string) {
    super();
    this.manifestId = uuid;
  }

  override onKeyDown: typeof openHideOnKeyDown = (event, platform, launch) => {
    const kind = this.kind;
    if (kind === "reply" && !this.hub.getLastSnapshot()?.agents.some(agent => agent.state === "turn" && !agent.parent && !agent.parent_pane)) return Promise.resolve();
    if (kind === "working-agent") {
      const snapshot = this.hub.getLastSnapshot();
      const slot = this.keys.get(event.action.id)?.slot ?? event.payload?.settings?.slot;
      if (!snapshot || !selectWorkingAgent(snapshot, slot)) return Promise.resolve();
    }
    const destination = kind === "working" || kind === "working-agent" ? "overview" : kind === "reply" ? "needs_you" :
      kind === "needs_you" || kind === "to-read" || kind === "mission" ? kind : undefined;
    return openHideOnKeyDown(event, platform, launch, destination);
  };

  private render(key: KeyAction<CountSettings>, snapshot: HideSnapshot): void {
    const state = this.keys.get(key.id);
    if (!state) return;
    const svg = renderCountKey(this.kind, snapshot, state.slot);
    if (state.lastSvg === svg) return;
    state.lastSvg = svg;
    void key.setImage(svgToDataUrl(svg));
  }

  override onWillAppear(ev: WillAppearEvent<CountSettings>): void {
    const key = ev.action;
    if (!key.isKey()) return;
    this.subscriptions.get(ev.action.id)?.();
    this.keys.set(key.id, { slot: normalizeAgentSlot(ev.payload?.settings?.slot) });
    if (typeof key.setTitle === "function") void key.setTitle("");

    const subscribeToMissions = this.kind !== "working" && this.kind !== "needs_you" && this.kind !== "to-read" && this.kind !== "reply" && this.kind !== "working-agent";
    const unsubscribe = this.hub.subscribe(snapshot => this.render(key, snapshot), subscribeToMissions);
    this.subscriptions.set(key.id, unsubscribe);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CountSettings>): void {
    if (this.kind !== "working-agent" || !ev.action.isKey()) return;
    const state = this.keys.get(ev.action.id);
    if (!state) return;
    state.slot = normalizeAgentSlot(ev.payload.settings.slot);
    const snapshot = this.hub.getLastSnapshot();
    if (snapshot) this.render(ev.action, snapshot);
  }

  override onWillDisappear(ev: WillDisappearEvent<CountSettings>): void {
    this.keys.delete(ev.action.id);
    const unsubscribe = this.subscriptions.get(ev.action.id);
    if (unsubscribe) {
      this.subscriptions.delete(ev.action.id);
      unsubscribe();
    }
  }
}
