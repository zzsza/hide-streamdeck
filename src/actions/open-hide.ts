import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { KeyDownEvent } from "@elgato/streamdeck";

type SpawnOpen = (file: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "once">;

export async function openHideOnKeyDown(
  event: KeyDownEvent,
  platform: NodeJS.Platform = process.platform,
  launch: SpawnOpen = spawn,
): Promise<void> {
  if (platform !== "darwin") return;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = launch("/usr/bin/open", ["-b", "me.grab.hide.desktop"], { shell: false, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Could not open Hide"));
      });
    });
  } catch {
    await event.action.showAlert();
  }
}
