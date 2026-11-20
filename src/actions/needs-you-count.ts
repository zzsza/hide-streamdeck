import type { StatusHub } from "../state/status-hub.js";
import { CountAction } from "./count-action.js";

export const NEEDS_YOU_COUNT_UUID = "com.zzsza.hide-status.needs-you-count";

export class NeedsYouCountAction extends CountAction {
  constructor(hub: StatusHub) {
    super(hub, "needs_you", NEEDS_YOU_COUNT_UUID);
  }
}
