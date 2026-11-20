import { crc32 } from "node:zlib";

/**
 * Writes a ZIP archive with every entry stored uncompressed (method 0).
 * Profiles are a few small JSON files, so this avoids a zip dependency.
 * Timestamps are fixed (1980-01-01) so the same entries always produce the same bytes.
 */
export function createStoredZip(entries: ReadonlyArray<{ path: string; content: string | null }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.content === null ? Buffer.alloc(0) : Buffer.from(entry.content, "utf8");
    const checksum = data.length === 0 ? 0 : crc32(data);
    const isFolder = entry.content === null;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    // Unix mode in the high 16 bits: drwxr-xr-x for folders, -rw-r--r-- for files.
    const mode = isFolder ? 0o040755 : 0o100644;
    central.writeUInt32LE(((mode << 16) | (isFolder ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}
