"use strict";

/*
  Minimal ZIP writer.
  - No compression.
  - Stores reconstructed sources as actual files.
  - Uses UTF-8 file names.
*/

(function exposeZipTools() {
  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
      let c = n;

      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }

      table[n] = c >>> 0;
    }

    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;

    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeU16(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(buffer, offset, value) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >>> 8) & 0xff;
    buffer[offset + 2] = (value >>> 16) & 0xff;
    buffer[offset + 3] = (value >>> 24) & 0xff;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);

    const dosDate =
      ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    return { dosDate, dosTime };
  }

  function createLocalHeader(nameBytes, dataBytes, crc, offsetTime) {
    const header = new Uint8Array(30 + nameBytes.length);

    writeU32(header, 0, 0x04034b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, 0x0800);
    writeU16(header, 8, 0);
    writeU16(header, 10, offsetTime.dosTime);
    writeU16(header, 12, offsetTime.dosDate);
    writeU32(header, 14, crc);
    writeU32(header, 18, dataBytes.length);
    writeU32(header, 22, dataBytes.length);
    writeU16(header, 26, nameBytes.length);
    writeU16(header, 28, 0);
    header.set(nameBytes, 30);

    return header;
  }

  function createCentralHeader(
    nameBytes,
    dataBytes,
    crc,
    localOffset,
    offsetTime,
  ) {
    const header = new Uint8Array(46 + nameBytes.length);

    writeU32(header, 0, 0x02014b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, 20);
    writeU16(header, 8, 0x0800);
    writeU16(header, 10, 0);
    writeU16(header, 12, offsetTime.dosTime);
    writeU16(header, 14, offsetTime.dosDate);
    writeU32(header, 16, crc);
    writeU32(header, 20, dataBytes.length);
    writeU32(header, 24, dataBytes.length);
    writeU16(header, 28, nameBytes.length);
    writeU16(header, 30, 0);
    writeU16(header, 32, 0);
    writeU16(header, 34, 0);
    writeU16(header, 36, 0);
    writeU32(header, 38, 0);
    writeU32(header, 42, localOffset);
    header.set(nameBytes, 46);

    return header;
  }

  function createEndOfCentralDirectory(fileCount, centralSize, centralOffset) {
    const end = new Uint8Array(22);

    writeU32(end, 0, 0x06054b50);
    writeU16(end, 4, 0);
    writeU16(end, 6, 0);
    writeU16(end, 8, fileCount);
    writeU16(end, 10, fileCount);
    writeU32(end, 12, centralSize);
    writeU32(end, 16, centralOffset);
    writeU16(end, 20, 0);

    return end;
  }

  function createZipBlob(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const timestamp = dosDateTime(new Date());

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.content || "");
      const crc = crc32(dataBytes);

      if (dataBytes.length > 0xffffffff) {
        throw new Error(`File too large for basic ZIP writer: ${file.name}`);
      }

      const localHeader = createLocalHeader(
        nameBytes,
        dataBytes,
        crc,
        timestamp,
      );
      const centralHeader = createCentralHeader(
        nameBytes,
        dataBytes,
        crc,
        offset,
        timestamp,
      );

      localParts.push(localHeader, dataBytes);
      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    }

    const centralOffset = offset;
    const centralSize = centralParts.reduce(
      (sum, part) => sum + part.length,
      0,
    );
    const eocd = createEndOfCentralDirectory(
      files.length,
      centralSize,
      centralOffset,
    );

    return new Blob([...localParts, ...centralParts, eocd], {
      type: "application/zip",
    });
  }

  function sanitizePath(input, fallback) {
    let value = String(input || fallback || "source.js");

    value = value
      .replace(/^webpack:\/\//i, "")
      .replace(/^ng:\/\//i, "")
      .replace(/^file:\/\//i, "")
      .replace(/^source:\/\//i, "")
      .replace(/^[a-z][a-z0-9+.-]*:\/+/i, "")
      .replace(/[?#].*$/g, "")
      .replace(/\\/g, "/");

    const parts = value
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part !== "." && part !== "..")
      .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_"));

    if (parts.length === 0) {
      parts.push(fallback || "source.js");
    }

    let cleaned = parts.join("/");

    if (!/\.[a-z0-9]+$/i.test(cleaned)) {
      cleaned += ".js";
    }

    return cleaned;
  }

  function uniquePath(path, used) {
    if (!used.has(path)) {
      used.add(path);
      return path;
    }

    const dot = path.lastIndexOf(".");
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : "";

    let index = 2;
    let candidate = `${base}__${index}${ext}`;

    while (used.has(candidate)) {
      index += 1;
      candidate = `${base}__${index}${ext}`;
    }

    used.add(candidate);
    return candidate;
  }

  function filenameFromMapUrl(mapUrl) {
    if (!mapUrl || /^data:/i.test(mapUrl)) {
      return "inline-source-map.sources.zip";
    }

    try {
      const url = new URL(mapUrl);
      const raw = `${url.hostname}${url.pathname}`
        .replace(/\/+/g, "_")
        .replace(/[^a-z0-9._-]+/gi, "_")
        .replace(/^_+|_+$/g, "");

      return `${raw || "source-map"}.sources.zip`;
    } catch {
      return "source-map.sources.zip";
    }
  }

  function filesFromMapRecord(record) {
    const used = new Set();
    const files = [];

    const report = {
      mapUrl: record.mapUrl,
      finalUrl: record.finalUrl,
      pageUrl: record.pageUrl,
      discoveredBy: record.discoveredBy || [],
      scriptUrls: record.scriptUrls || [],
      version: record.version,
      sourceCount: record.sourceCount,
      embeddedSourceCount: record.embeddedSourceCount,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
    };

    files.push({
      name: "__source_map_hunter_report.json",
      content: JSON.stringify(report, null, 2),
    });

    for (const source of record.sources || []) {
      if (!source.available) {
        continue;
      }

      const sanitized = sanitizePath(
        source.path,
        `source-${source.index + 1}.js`,
      );
      const name = uniquePath(`sources/${sanitized}`, used);

      files.push({
        name,
        content: source.content || "",
      });
    }

    if (files.length === 1) {
      files.push({
        name: "README.txt",
        content: [
          "This source map was valid, but it did not include embedded sourcesContent.",
          "",
          `Map URL: ${record.mapUrl || ""}`,
          `Final URL: ${record.finalUrl || ""}`,
          `Source count: ${record.sourceCount || 0}`,
        ].join("\n"),
      });
    }

    return files;
  }

  async function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);

    try {
      await browser.downloads.download({
        url: objectUrl,
        filename,
        saveAs: true,
        conflictAction: "uniquify",
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
  }

  async function downloadMapAsZip(record) {
    const files = filesFromMapRecord(record);
    const blob = createZipBlob(files);
    await downloadBlob(blob, filenameFromMapUrl(record.mapUrl));
  }

  globalThis.SourceMapHunterZip = {
    createZipBlob,
    downloadBlob,
    downloadMapAsZip,
    filesFromMapRecord,
    sanitizePath,
    filenameFromMapUrl,
  };
})();
