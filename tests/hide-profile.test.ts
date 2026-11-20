import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  buildHideProfileEntries,
  HIDE_PROFILE_KEYS,
  PLUGIN_UUID,
  STREAM_DECK_PLUS_MODEL,
} from "../src/profile/hide-profile.js";
import { createStoredZip } from "../src/profile/zip-store.js";

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "com.zzsza.hide-status.sdPlugin", "manifest.json"), "utf8"),
) as {
  Version: string;
  Actions: Array<{ UUID: string; Controllers?: string[] }>;
  Profiles?: Array<{ Name: string; DeviceType: number }>;
};

function readStoredZip(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const checksum = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    expect(size === 0 ? 0 : crc32(data)).toBe(checksum);
    entries.push({ path: buffer.toString("utf8", nameStart, nameStart + nameLength), data });
    offset = dataStart + size;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}

describe("Hide profile", () => {
  const entries = buildHideProfileEntries(manifest.Version);
  const files = new Map(
    entries.filter((e) => e.content !== null).map((e) => [e.path, JSON.parse(e.content as string)]),
  );

  it("is declared in the plugin manifest for Stream Deck +", () => {
    expect(manifest.Profiles).toEqual([
      expect.objectContaining({ Name: "profiles/Hide", DeviceType: 7 }),
    ]);
  });

  it("names its pages in the profile manifest and keeps one folder per page", () => {
    const [profilePath, profile] = [...files.entries()].find(([p]) => /^[^/]+\.sdProfile\/manifest\.json$/.test(p))!;
    const root = profilePath.replace("manifest.json", "");
    expect(profile.Version).toBe("3.0");
    expect(profile.Device.Model).toBe(STREAM_DECK_PLUS_MODEL);
    const pageIds: string[] = [...profile.Pages.Pages, profile.Pages.Default];
    expect(profile.Pages.Pages).toContain(profile.Pages.Current);
    for (const id of pageIds) {
      expect(files.has(`${root}Profiles/${id.toUpperCase()}/manifest.json`)).toBe(true);
    }
  });

  it("places Working, Needs You and slots 1-6 on the 4x2 keypad with declared actions", () => {
    const page = [...files.values()].find((m) => m.Controllers?.[0]?.Actions);
    const keypad = page.Controllers.find((c: { Type: string }) => c.Type === "Keypad").Actions;
    const declared = new Set(manifest.Actions.map((a) => a.UUID));

    expect(Object.keys(keypad).sort()).toEqual(["0,0", "0,1", "1,0", "1,1", "2,0", "2,1", "3,0", "3,1"]);
    expect(keypad["0,0"].UUID).toBe(`${PLUGIN_UUID}.working-count`);
    expect(keypad["1,0"].UUID).toBe(`${PLUGIN_UUID}.needs-you-count`);
    const slots = ["2,0", "3,0", "0,1", "1,1", "2,1", "3,1"].map((pos) => {
      expect(keypad[pos].UUID).toBe(`${PLUGIN_UUID}.needs-you-agent`);
      return keypad[pos].Settings.slot;
    });
    expect(slots).toEqual([1, 2, 3, 4, 5, 6]);

    for (const action of Object.values(keypad) as Array<{ UUID: string; Plugin: { UUID: string; Version: string } }>) {
      expect(declared.has(action.UUID)).toBe(true);
      expect(action.Plugin).toMatchObject({ UUID: PLUGIN_UUID, Version: manifest.Version });
    }
    expect(new Set(HIDE_PROFILE_KEYS.map((k) => k.actionId)).size).toBe(HIDE_PROFILE_KEYS.length);
  });

  it("packs every entry into a stored zip that reads back unchanged", () => {
    const zip = createStoredZip(entries);
    const read = readStoredZip(zip);
    expect(read.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    read.forEach((e, i) => expect(e.data.toString("utf8")).toBe(entries[i]?.content ?? ""));
    expect(createStoredZip(entries).equals(zip)).toBe(true);
  });
});
