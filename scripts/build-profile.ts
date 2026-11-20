import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

import { buildHideProfileEntries } from "../src/profile/hide-profile.js";
import { createStoredZip } from "../src/profile/zip-store.js";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(repoRoot, "com.zzsza.hide-status.sdPlugin");

const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, "manifest.json"), "utf8")) as {
  Version: string;
};
const outFile = path.join(pluginDir, "profiles", "Hide.streamDeckProfile");

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, createStoredZip(buildHideProfileEntries(manifest.Version)));
console.log(`Wrote ${path.relative(repoRoot, outFile)}`);
