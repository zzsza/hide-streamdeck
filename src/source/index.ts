import { FakeHideSource, type FakeHideSourceOptions } from "./fake-source.js";
import { HideCliSource, type HideCliSourceOptions } from "./hide-cli-source.js";
import { normalizeGlobalSettings, type GlobalSettings, type HideSource } from "./types.js";

export * from "./types.js";
export * from "./fake-source.js";
export * from "./hide-access.js";
export * from "./hide-cli-source.js";

export interface CreateHideSourceDeps {
  now?: () => number;
  fakeOptions?: Omit<FakeHideSourceOptions, "scenario" | "now">;
  cliOptions?: Omit<HideCliSourceOptions, "hidePath" | "now">;
}

export function createHideSource(
  settings?: GlobalSettings | null,
  deps: CreateHideSourceDeps = {},
): HideSource {
  const normalized = normalizeGlobalSettings(settings);
  if (normalized.source === "fake") {
    return new FakeHideSource({
      ...deps.fakeOptions,
      scenario: normalized.fakeScenario,
      now: deps.now,
    });
  }

  return new HideCliSource({
    ...deps.cliOptions,
    hidePath: normalized.hidePath,
    now: deps.now,
  });
}
