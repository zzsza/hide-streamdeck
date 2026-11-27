import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { createKeySvg, svgToDataUrl } from "../render/key-svg.js";
import { KEY_FONT } from "../render/key-text.js";
import { KEY_COLORS, WARNING_COLOR } from "../render/palette.js";
import { isRecord } from "../source/hide-access.js";
import { HIDE_WEEKLY_USAGE_SCRIPT } from "./hide-navigation.js";

export const WEEKLY_USAGE_LABELS = { claude: "Claude", codex: "GPT", antigravity: "Antigravity" } as const;
export type UsageProvider = keyof typeof WEEKLY_USAGE_LABELS;
type WeeklyUsage = Partial<Record<UsageProvider, number>>;
type UsageListener = (usage: WeeklyUsage) => void;
const providers = Object.keys(WEEKLY_USAGE_LABELS) as UsageProvider[];
const run = promisify(execFile);

export function parseWeeklyUsage(output: string): WeeklyUsage {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value)) return {};
  const usage: WeeklyUsage = {};
  for (const provider of providers) {
    const percent = value[provider];
    if (typeof percent === "number" && Number.isInteger(percent) && percent >= 0 && percent <= 100) {
      usage[provider] = percent;
    }
  }
  return usage;
}

async function readWeeklyUsage(): Promise<WeeklyUsage> {
  if (process.platform !== "darwin") return {};
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", HIDE_WEEKLY_USAGE_SCRIPT], {
      timeout: 5_000, maxBuffer: 4_096,
    });
    return parseWeeklyUsage(stdout);
  } catch {
    return {};
  }
}

export class WeeklyUsagePoll {
  private readonly listeners = new Set<UsageListener>();
  private latest: WeeklyUsage = {};
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly read = readWeeklyUsage) {}

  subscribe(listener: UsageListener): () => void {
    this.listeners.add(listener);
    listener(this.latest);
    if (this.listeners.size === 1 && !this.pending) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearTimeout(this.timer);
        this.latest = {};
      }
    };
  }

  private async refresh(): Promise<void> {
    this.pending = true;
    const usage = await this.read().catch(() => ({}));
    this.pending = false;
    if (this.listeners.size === 0) return;
    this.latest = usage;
    for (const listener of this.listeners) listener(usage);
    if (this.listeners.size > 0) this.timer = setTimeout(() => void this.refresh(), 30_000);
  }
}

function weeklyUsageDisplay(percent?: number) {
  const value = percent === undefined ? "-" : `${percent}%`;
  const color = percent === undefined ? KEY_COLORS.disabled : percent <= 10 ? KEY_COLORS.red : percent <= 30 ? WARNING_COLOR : KEY_COLORS.text;
  return { value, color };
}

export function renderWeeklyUsage(provider: UsageProvider, percent?: number): string {
  const { value, color } = weeklyUsageDisplay(percent);
  return createKeySvg({ background: KEY_COLORS.background, body: `
    <g font-family="${KEY_FONT}" text-anchor="middle">
      <text x="72" y="32" fill="${KEY_COLORS.text}" font-size="20" font-weight="700">${WEEKLY_USAGE_LABELS[provider]}</text>
      <text x="72" y="88" fill="${color}" font-size="46" font-weight="700">${value}</text>
      <text x="72" y="122" fill="${KEY_COLORS.muted}" font-size="20" font-weight="700">주간 잔여</text>
    </g>` });
}

export class WeeklyUsageAction extends SingletonAction {
  override readonly manifestId: string;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(private readonly provider: UsageProvider, private readonly poll: WeeklyUsagePoll) {
    super();
    this.manifestId = `com.zzsza.hide-status.weekly-${provider}`;
  }

  override onWillAppear(event: WillAppearEvent): void {
    const action = event.action;
    if (!action.isKey() && !action.isDial()) return;
    this.subscriptions.get(action.id)?.();
    let previous: number | null | undefined = null;
    const stop = this.poll.subscribe(usage => {
      const percent = usage[this.provider];
      if (percent === previous) return;
      previous = percent;
      if (action.isDial()) {
        void action.setFeedback({ title: WEEKLY_USAGE_LABELS[this.provider], value: weeklyUsageDisplay(percent) });
      } else {
        void action.setImage(svgToDataUrl(renderWeeklyUsage(this.provider, percent)));
      }
    });
    this.subscriptions.set(action.id, stop);
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    this.subscriptions.get(event.action.id)?.();
    this.subscriptions.delete(event.action.id);
  }
}
