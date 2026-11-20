/**
 * The "Hide" profile shipped with the plugin for Stream Deck + (4x2 keys, 4 dials).
 *
 * The archive follows the profile layout Stream Deck 7.x keeps on disk (manifest Version "3.0"):
 * `<PROFILE>.sdProfile/manifest.json` names the pages, and each page is
 * `<PROFILE>.sdProfile/Profiles/<PAGE>/manifest.json` with keys addressed as "column,row".
 * Folder names are upper-case UUIDs while manifests refer to pages in lower case, as the app writes them.
 */

export const PLUGIN_UUID = "com.zzsza.hide-status";
export const PLUGIN_NAME = "Hide Status";
export const PROFILE_NAME = "Hide";
/** Stream Deck + model id, as the app records it in profile manifests. */
export const STREAM_DECK_PLUS_MODEL = "20GBD9901";

const PROFILE_ID = "466159F6-4744-40ED-AF60-C51CA027958C";
const KEYS_PAGE_ID = "74C0162D-17BD-41A4-A5E8-6399CBF0F883";
const DEFAULT_PAGE_ID = "43D4D6B6-DB59-4940-91B4-118FD7F1F997";

export interface ProfileKey {
  /** "column,row" on the 4x2 keypad. */
  position: string;
  actionId: string;
  action: "working-count" | "needs-you-count" | "needs-you-agent";
  name: string;
  settings: Record<string, unknown>;
}

/**
 * Row 0: Working, Needs You, slot 1, slot 2. Row 1: slots 3-6.
 * Action ids are fixed so that rebuilding the profile yields the same archive.
 */
export const HIDE_PROFILE_KEYS: readonly ProfileKey[] = [
  { position: "0,0", actionId: "2e3d41b9-6451-45ef-9812-6a210266a9c8", action: "working-count", name: "Working Count", settings: {} },
  { position: "1,0", actionId: "ffff3472-758d-456e-a606-1b5e84607431", action: "needs-you-count", name: "Needs You Count", settings: {} },
  { position: "2,0", actionId: "faaeeb1b-a6ec-42fd-9150-9db3b290d235", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 1 } },
  { position: "3,0", actionId: "0b4a06ca-26b3-417f-b84c-71ca700b778e", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 2 } },
  { position: "0,1", actionId: "4445b12f-7b1f-4527-8a39-14e7e4bbd5c3", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 3 } },
  { position: "1,1", actionId: "18b3a88a-5d82-4877-83c0-ddcfc2bc68ae", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 4 } },
  { position: "2,1", actionId: "294c5f77-66a6-4722-b988-62e61e57b7ae", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 5 } },
  { position: "3,1", actionId: "68dea3dd-01da-4b12-8bfa-a82810264067", action: "needs-you-agent", name: "Needs You Agent", settings: { slot: 6 } },
];

/** One archive entry: a folder when `content` is null. Paths use "/" and folders end with "/". */
export interface ProfileEntry {
  path: string;
  content: string | null;
}

function pageManifest(keys: readonly ProfileKey[], pluginVersion: string): unknown {
  const actions: Record<string, unknown> = {};
  for (const key of keys) {
    actions[key.position] = {
      ActionID: key.actionId,
      LinkedTitle: true,
      Name: key.name,
      Plugin: { Name: PLUGIN_NAME, UUID: PLUGIN_UUID, Version: pluginVersion },
      Resources: null,
      Settings: key.settings,
      State: 0,
      States: [{}],
      UUID: `${PLUGIN_UUID}.${key.action}`,
    };
  }
  return {
    Controllers: [
      { Actions: keys.length > 0 ? actions : null, Type: "Keypad" },
      { Actions: null, Type: "Encoder" },
    ],
    Icon: "",
    Name: "",
  };
}

/**
 * Lists the folders and JSON files of the profile archive, in archive order.
 * `pluginVersion` must be the plugin manifest's Version so the keys bind to this plugin.
 */
export function buildHideProfileEntries(pluginVersion: string): ProfileEntry[] {
  const root = `${PROFILE_ID}.sdProfile/`;
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  const profileManifest = {
    Device: { Model: STREAM_DECK_PLUS_MODEL, UUID: "" },
    Name: PROFILE_NAME,
    Pages: {
      Current: KEYS_PAGE_ID.toLowerCase(),
      Default: DEFAULT_PAGE_ID.toLowerCase(),
      Pages: [KEYS_PAGE_ID.toLowerCase()],
    },
    Version: "3.0",
  };

  return [
    { path: root, content: null },
    { path: `${root}manifest.json`, content: json(profileManifest) },
    { path: `${root}Images/`, content: null },
    { path: `${root}Profiles/`, content: null },
    { path: `${root}Profiles/${KEYS_PAGE_ID}/`, content: null },
    { path: `${root}Profiles/${KEYS_PAGE_ID}/Images/`, content: null },
    {
      path: `${root}Profiles/${KEYS_PAGE_ID}/manifest.json`,
      content: json(pageManifest(HIDE_PROFILE_KEYS, pluginVersion)),
    },
    { path: `${root}Profiles/${DEFAULT_PAGE_ID}/`, content: null },
    { path: `${root}Profiles/${DEFAULT_PAGE_ID}/Images/`, content: null },
    {
      path: `${root}Profiles/${DEFAULT_PAGE_ID}/manifest.json`,
      content: json(pageManifest([], pluginVersion)),
    },
  ];
}
