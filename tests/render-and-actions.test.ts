import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  NEEDS_YOU_AGENT_UUID,
  NeedsYouAgentAction,
  type NeedsYouAgentSettings,
} from "../src/actions/needs-you-agent.js";
import { NEEDS_YOU_COUNT_UUID, NeedsYouCountAction } from "../src/actions/needs-you-count.js";
import { WORKING_COUNT_UUID, WorkingCountAction } from "../src/actions/working-count.js";
import {
  createKeySvg,
  escapeXml,
  KEY_SIZE,
  renderAgentKey,
  renderNeedsYouCountKey,
  renderWorkingCountKey,
  svgToDataUrl,
  truncateText,
} from "../src/render/index.js";
import { FAKE_SCENARIOS, FakeHideSource } from "../src/source/fake-source.js";
import { StatusHub } from "../src/state/status-hub.js";
import { generatePreviewHtml } from "../scripts/preview.js";

function decodeSvgDataUrl(dataUrl: string): string {
  const prefix = "data:image/svg+xml;charset=utf8,";
  expect(dataUrl.startsWith(prefix)).toBe(true);
  return decodeURIComponent(dataUrl.slice(prefix.length));
}

function makeKeyEvent<TSettings extends Record<string, unknown> = Record<string, unknown>>(
  id: string,
  settings: TSettings,
) {
  const setImage = vi.fn(async (_image?: string) => {});
  const event = {
    action: {
      id,
      isKey: () => true,
      setImage,
    },
    payload: {
      settings,
    },
  };
  return { event, setImage };
}

describe("key-svg and placeholder renderers", () => {
  it("builds 144x144 SVG markup and escapes XML special characters", () => {
    const svg = createKeySvg({
      body: `<text>${escapeXml(`a < b & "c" 'd'`)}</text>`,
    });
    expect(svg).toContain(`width="${KEY_SIZE}"`);
    expect(svg).toContain(`height="${KEY_SIZE}"`);
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&apos;");

    const roundTrip = decodeSvgDataUrl(svgToDataUrl(svg));
    expect(roundTrip).toBe(svg);
  });

  it("truncates text cleanly by character count", () => {
    expect(truncateText("atlas", 10)).toBe("atlas");
    expect(truncateText("hyperion-coordinator", 11)).toBe("hyperion...");
  });

  it("renders valid 144x144 SVGs for count and agent keys", async () => {
    const snap = await new FakeHideSource({ scenario: "needs-you-many" }).read();
    for (const svg of [
      renderWorkingCountKey(snap),
      renderNeedsYouCountKey(snap),
      renderAgentKey(snap, { slot: 1 }),
    ]) {
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg).toContain('viewBox="0 0 144 144"');
      expect(svg.endsWith("</svg>")).toBe(true);
    }
  });
});

describe("actions with StatusHub", () => {
  it("subscribes on willAppear, updates key images, and unsubscribes on willDisappear", async () => {
    const hub = new StatusHub({
      initialSettings: { source: "fake", fakeScenario: "needs-you-one" },
    });

    const workingAction = new WorkingCountAction(hub);
    const needsCountAction = new NeedsYouCountAction(hub);
    const agentAction = new NeedsYouAgentAction(hub);

    const k1 = makeKeyEvent("ctx-working", {});
    const k2 = makeKeyEvent("ctx-needs-count", {});
    const k3 = makeKeyEvent<NeedsYouAgentSettings>("ctx-agent", { slot: 1 });

    workingAction.onWillAppear(k1.event as never);
    needsCountAction.onWillAppear(k2.event as never);
    agentAction.onWillAppear(k3.event as never);

    expect(hub.getSubscriberCount()).toBe(3);

    // Allow initial async read() in FakeHideSource to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(k1.setImage).toHaveBeenCalledTimes(1);
    expect(k2.setImage).toHaveBeenCalledTimes(1);
    expect(k3.setImage).toHaveBeenCalledTimes(1);

    expect(decodeSvgDataUrl(k3.setImage.mock.calls[0]?.[0] ?? "")).toContain("Agent #1");

    // Updating slot setting re-renders immediately from cached snapshot.
    const k3Updated = {
      action: k3.event.action,
      payload: { settings: { slot: 2 } },
    };
    agentAction.onDidReceiveSettings(k3Updated as never);
    expect(k3.setImage).toHaveBeenCalledTimes(2);
    expect(decodeSvgDataUrl(k3.setImage.mock.calls[1]?.[0] ?? "")).toContain("Agent #2");

    workingAction.onWillDisappear(k1.event as never);
    needsCountAction.onWillDisappear(k2.event as never);
    agentAction.onWillDisappear(k3.event as never);

    expect(hub.getSubscriberCount()).toBe(0);
    hub.dispose();
  });
});

describe("manifest and preview generation", () => {
  it("declares the 3 expected action UUIDs and existing PropertyInspectorPath files", async () => {
    const pluginDir = path.resolve(process.cwd(), "com.zzsza.hide-status.sdPlugin");
    const manifestRaw = await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      UUID: string;
      Name: string;
      SDKVersion: number;
      Nodejs: { Version: string };
      Actions: Array<{ UUID: string; PropertyInspectorPath: string }>;
    };

    expect(manifest.UUID).toBe("com.zzsza.hide-status");
    expect(manifest.Name).toBe("Hide Status");
    expect(manifest.SDKVersion).toBe(3);
    expect(manifest.Nodejs.Version).toBe("24");
    expect(manifest.Actions.map((a) => a.UUID)).toEqual([
      WORKING_COUNT_UUID,
      NEEDS_YOU_COUNT_UUID,
      NEEDS_YOU_AGENT_UUID,
    ]);

    for (const act of manifest.Actions) {
      const htmlPath = path.join(pluginDir, act.PropertyInspectorPath);
      const stat = await fs.stat(htmlPath);
      expect(stat.isFile()).toBe(true);
    }
  });

  it("generates preview HTML covering every fake scenario", async () => {
    const html = await generatePreviewHtml();
    expect(html).toContain("<!doctype html>");
    for (const scenario of FAKE_SCENARIOS) {
      expect(html).toContain(scenario.id);
    }
  });
});
