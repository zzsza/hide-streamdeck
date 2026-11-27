import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import streamDeck, { type KeyDownEvent } from "@elgato/streamdeck";
import { HIDE_NAVIGATION_SCRIPT, type HideDestination } from "./hide-navigation.js";

type SpawnOpen = (file: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "once" | "stderr">;
let navigating = false;

export async function openHideOnKeyDown(
  event: KeyDownEvent,
  platform: NodeJS.Platform = process.platform,
  launch: SpawnOpen = spawn,
  destination?: HideDestination,
): Promise<void> {
  if (platform !== "darwin") return;
  if (destination && navigating) return;
  if (destination) navigating = true;

  const run = async (file: string, args: string[], options: SpawnOptions = {}): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = launch(file, args, { shell: false, stdio: "ignore", ...options });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk.slice(0, Math.max(0, 1024 - stderr.length));
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else {
          const detail = stderr.match(/HIDE_NAVIGATION: (accessibility denied|Hide not running|window missing|(?:mission|overview|work|sessions|needs_you|to-read|webArea): (?:missing|-?\d+))/)?.[1];
          reject(new Error(detail ?? `Hide command exited with ${code ?? "a signal"}`));
        }
      });
    });
  };

  try {
    await run("/usr/bin/open", ["-b", "me.grab.hide.desktop"]);
    if (destination) {
      await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", HIDE_NAVIGATION_SCRIPT, destination], {
        stdio: ["ignore", "ignore", "pipe"], timeout: 10_000,
      });
    }
  } catch (error) {
    streamDeck.logger.warn(`Hide key ${destination ?? "open"}: ${error instanceof Error ? error.message : "command failed"}`);
    await event.action.showAlert();
  } finally {
    if (destination) navigating = false;
  }
}
