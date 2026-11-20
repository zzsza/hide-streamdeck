import type { StatusHub } from "../state/status-hub.js";
import { CountAction } from "./count-action.js";

export const WORKING_COUNT_UUID = "com.zzsza.hide-status.working-count";

export class WorkingCountAction extends CountAction {
  constructor(hub: StatusHub) {
    super(hub, "working", WORKING_COUNT_UUID);
  }
}
