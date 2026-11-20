import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { renderAgentKey } from "../src/render/agent-key.js";
import { renderNeedsYouCountKey, renderWorkingCountKey } from "../src/render/count-key.js";
import { escapeXml, svgToDataUrl } from "../src/render/key-svg.js";
import { FAKE_SCENARIOS, FakeHideSource } from "../src/source/fake-source.js";
import { summarize } from "../src/state/classify.js";

const PREVIEW_CLOCK_MS = 1_760_000_000_000;

export async function generatePreviewHtml(): Promise<string> {
  const sections: string[] = [];

  for (const scenario of FAKE_SCENARIOS) {
    const source = new FakeHideSource({
      scenario: scenario.id,
      now: () => PREVIEW_CLOCK_MS,
    });
    const snapshot = await source.read();
    const summary = summarize(snapshot);

    const cards = [
      { label: "Working Count", svg: renderWorkingCountKey(snapshot) },
      { label: "Needs You Count", svg: renderNeedsYouCountKey(snapshot) },
      { label: "Needs You Agent (slot 1)", svg: renderAgentKey(snapshot, { slot: 1 }) },
      { label: "Needs You Agent (slot 2)", svg: renderAgentKey(snapshot, { slot: 2 }) },
      ...(scenario.id === "needs-you-many"
        ? [
            { label: "Needs You Agent (slot 3)", svg: renderAgentKey(snapshot, { slot: 3 }) },
            { label: "Needs You Agent (slot 5)", svg: renderAgentKey(snapshot, { slot: 5 }) },
          ]
        : []),
    ];

    const cardMarkup = cards
      .map(
        (card) => {
          const dataUrl = svgToDataUrl(card.svg);
          return `
          <figure class="key-card">
            <div class="key-sizes">
              <img src="${dataUrl}" width="144" height="144" alt="${escapeXml(card.label)} (144px)" />
              <img class="key-72" src="${dataUrl}" width="72" height="72" alt="${escapeXml(card.label)} (72px)" />
            </div>
            <figcaption>${escapeXml(card.label)}</figcaption>
          </figure>`;
        },
      )
      .join("");

    sections.push(`
      <section class="scenario">
        <header class="scenario-header">
          <div>
            <h2>${escapeXml(scenario.label)} <code>${escapeXml(scenario.id)}</code></h2>
            <p>${escapeXml(scenario.description)}</p>
          </div>
          <div class="meta">
            <span>connection: <strong>${escapeXml(snapshot.connection.kind)}</strong></span>
            <span>working: <strong>${summary.working}</strong></span>
            <span>needsYou: <strong>${summary.needsYou.length}</strong></span>
            <span>toRead: <strong>${summary.toRead}</strong></span>
          </div>
        </header>
        <div class="key-grid">${cardMarkup}
        </div>
      </section>`);
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Hide Status Key Preview</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        padding: 32px;
        background: #0f1117;
        color: #e2e8f0;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      .lead {
        margin: 0 0 28px;
        color: #94a3b8;
        font-size: 14px;
      }
      .scenario {
        margin-bottom: 24px;
        padding: 20px;
        border: 1px solid #1e293b;
        border-radius: 12px;
        background: #141821;
      }
      .scenario-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 16px;
      }
      .scenario-header h2 {
        margin: 0 0 4px;
        font-size: 17px;
      }
      .scenario-header code {
        margin-left: 6px;
        padding: 2px 6px;
        border-radius: 4px;
        background: #1e293b;
        font-size: 12px;
        color: #93c5fd;
      }
      .scenario-header p {
        margin: 0;
        color: #94a3b8;
        font-size: 13px;
      }
      .meta {
        display: flex;
        gap: 14px;
        font-size: 12px;
        color: #94a3b8;
      }
      .meta strong {
        color: #f8fafc;
      }
      .key-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 20px;
      }
      .key-card {
        margin: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      .key-sizes {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
      }
      .key-card img {
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      }
      .key-card figcaption {
        font-size: 12px;
        color: #cbd5e1;
      }
    </style>
  </head>
  <body>
    <h1>Hide Status Key Preview</h1>
    <p class="lead">Each scenario shows the same keys at 144px (top) and 72px (bottom).</p>
    ${sections.join("\n")}
  </body>
</html>
`;
}

async function main(): Promise<void> {
  const rootDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
  const outputPath = path.join(rootDir, "preview", "index.html");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const html = await generatePreviewHtml();
  await fs.writeFile(outputPath, html, "utf8");
  process.stdout.write(`Wrote ${path.relative(rootDir, outputPath)}\n`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
