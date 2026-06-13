"use strict";

/*
  Source Map Hunter
  Firefox MV3-compatible background controller.

  What it detects:
  - JS responses with SourceMap / X-SourceMap / SourceMappingURL-style headers.
  - Network responses whose URL ends in .js.map, .mjs.map, or .cjs.map.
  - sourceMappingURL comments inside JavaScript response bodies.
  - Proactive guesses for every requested .js/.mjs/.cjs file:
      app.js -> app.js.map
      app.js?v=1 -> app.js.map?v=1 and app.js.map

  False-positive control:
  - A candidate is only confirmed after fetching/parsing it.
  - Confirmed maps must be valid JSON with version, sources, and mappings fields.

  Storage model:
  - Confirmed maps accumulate into a single, global, persistent collection
    keyed by map URL. Findings are kept across navigations, tab switches, tab
    closes, and background restarts until the user explicitly clears them.
*/

const SOURCE_MAP_HEADER_NAMES = new Set([
  "sourcemap",
  "x-sourcemap",
  "source-map",
  "sourcemappingurl",
]);

const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];
const MAP_EXTENSIONS = [".js.map", ".mjs.map", ".cjs.map"];

const MAX_SCRIPT_TAIL_CHARS = 160 * 1024;
const STORAGE_KEY = "sourceMapHunter:maps";
const ENABLED_KEY = "sourceMapHunter:enabled";

// Master on/off switch. When disabled, the extension performs no detection at
// all: no proactive guesses, no script-body scanning, no header inspection,
// and no source map fetching. Already-discovered maps remain viewable.
// Kept as an in-memory cache so the (synchronous) webRequest listeners can
// gate themselves without awaiting storage on every request. Defaults to on
// and is reconciled with storage at startup and via storage.onChanged.
let enabled = true;

// The live, global collection of confirmed source maps (mapUrl -> record).
const MAPS = new Map();
let mapsLoaded = false;
let loadingMaps = null;

// In-memory only (rebuilt each session):
const IN_FLIGHT = new Map(); // mapUrl -> { discoveredBy:Set, scriptUrls:Set, pageUrl }
const ATTEMPTED = new Set(); // candidate mapUrls already tried this session
const PAGE_URL_BY_TAB = new Map(); // tabId -> last main_frame url, for annotation

function nowIso() {
  return new Date().toISOString();
}

function serializeRecord(record) {
  return {
    ...record,
    discoveredBy: Array.from(record.discoveredBy || []),
    scriptUrls: Array.from(record.scriptUrls || []),
  };
}

function hydrateRecord(record) {
  return {
    ...record,
    discoveredBy: new Set(record.discoveredBy || []),
    scriptUrls: new Set(record.scriptUrls || []),
  };
}

async function loadMaps() {
  if (mapsLoaded) {
    return MAPS;
  }

  // Dedupe concurrent loads: when the event page wakes up, several requests
  // can race to rehydrate. They must share one collection so later saves do
  // not clobber earlier ones.
  if (loadingMaps) {
    return loadingMaps;
  }

  loadingMaps = (async () => {
    const data = await browser.storage.local.get(STORAGE_KEY);
    const serialized = data[STORAGE_KEY];

    if (Array.isArray(serialized)) {
      for (const record of serialized) {
        if (record && record.mapUrl) {
          MAPS.set(record.mapUrl, hydrateRecord(record));
        }
      }
    }

    mapsLoaded = true;
    loadingMaps = null;
    return MAPS;
  })();

  return loadingMaps;
}

async function saveMaps() {
  await loadMaps();
  const serialized = Array.from(MAPS.values()).map(serializeRecord);
  await browser.storage.local.set({ [STORAGE_KEY]: serialized });
}

async function clearAllMaps() {
  await loadMaps();
  MAPS.clear();
  ATTEMPTED.clear();
  await browser.storage.local.set({ [STORAGE_KEY]: [] });
  await updateBadge();
}

async function loadEnabled() {
  try {
    const data = await browser.storage.local.get(ENABLED_KEY);
    if (typeof data[ENABLED_KEY] === "boolean") {
      enabled = data[ENABLED_KEY];
    }
  } catch (error) {
    console.warn("Unable to load enabled state:", error);
  }

  return enabled;
}

async function setEnabled(nextEnabled) {
  enabled = Boolean(nextEnabled);
  await browser.storage.local.set({ [ENABLED_KEY]: enabled });
  await updateBadge();

  try {
    await browser.runtime.sendMessage({
      type: "enabledChanged",
      enabled,
    });
  } catch {
    // Popup may not be open.
  }

  return enabled;
}

async function updateBadge() {
  await loadMaps();
  const count = MAPS.size;

  try {
    // When the switch is off, make the disabled state obvious in the toolbar
    // rather than showing a stale finding count.
    if (!enabled) {
      await browser.action.setBadgeText({ text: "off" });
      await browser.action.setBadgeBackgroundColor({ color: "#6b7280" });
      await browser.action.setTitle({
        title: "Source Map Hunter (disabled)",
      });
      return;
    }

    await browser.action.setBadgeText({
      text: count > 0 ? String(count) : "",
    });

    await browser.action.setBadgeBackgroundColor({
      color: "#d90429",
    });

    await browser.action.setTitle({
      title:
        count > 0
          ? `Source Map Hunter: ${count} source map${count === 1 ? "" : "s"} found`
          : "Source Map Hunter",
    });
  } catch (error) {
    console.warn("Failed to update badge:", error);
  }
}

function safeUrl(urlString) {
  try {
    return new URL(urlString);
  } catch {
    return null;
  }
}

function pathEndsWithAny(urlString, extensions) {
  const url = safeUrl(urlString);
  if (!url) {
    return false;
  }

  const pathname = decodeURIComponent(url.pathname).toLowerCase();
  return extensions.some((ext) => pathname.endsWith(ext));
}

function looksLikeJavaScriptFile(urlString) {
  return pathEndsWithAny(urlString, JS_EXTENSIONS);
}

function looksLikeSourceMapFile(urlString) {
  return pathEndsWithAny(urlString, MAP_EXTENSIONS);
}

function isSuccessfulStatus(statusCode) {
  return statusCode >= 200 && statusCode < 400;
}

function normalizeHeaderValue(value) {
  if (!value) {
    return "";
  }

  let cleaned = String(value).trim();

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  cleaned = cleaned.replace(/^sourceMappingURL\s*=\s*/i, "").trim();

  return cleaned;
}

function getSourceMapHeader(responseHeaders = []) {
  for (const header of responseHeaders) {
    if (!header || !header.name) {
      continue;
    }

    const name = header.name.toLowerCase();
    if (SOURCE_MAP_HEADER_NAMES.has(name)) {
      const value = normalizeHeaderValue(header.value || "");
      if (value) {
        return {
          name: header.name,
          value,
        };
      }
    }
  }

  return null;
}

function resolveReference(reference, baseUrl) {
  const cleaned = normalizeHeaderValue(reference);

  if (!cleaned) {
    return null;
  }

  if (/^data:/i.test(cleaned)) {
    return cleaned;
  }

  try {
    return new URL(cleaned, baseUrl).href;
  } catch {
    return null;
  }
}

function guessMapUrls(scriptUrl) {
  const guesses = new Set();
  const url = safeUrl(scriptUrl);

  if (!url) {
    return [];
  }

  if (!looksLikeJavaScriptFile(scriptUrl)) {
    return [];
  }

  const base = `${url.origin}${url.pathname}.map`;

  if (url.search) {
    guesses.add(`${base}${url.search}`);
  }

  guesses.add(base);

  return Array.from(guesses);
}

function extractSourceMappingComments(scriptTail) {
  const references = new Set();

  const regex =
    /(?:\/\/[@#]\s*sourceMappingURL\s*=\s*([^\s"'<>]+)|\/\*[@#]\s*sourceMappingURL\s*=\s*([^*]+?)\s*\*\/)/gi;

  let match;
  while ((match = regex.exec(scriptTail)) !== null) {
    const reference = normalizeHeaderValue(match[1] || match[2] || "");
    if (reference) {
      references.add(reference);
    }
  }

  return Array.from(references);
}

function stableId(input) {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `m_${(hash >>> 0).toString(36)}`;
}

function stripJsonPrefix(text) {
  let cleaned = String(text || "")
    .replace(/^﻿/, "")
    .trimStart();

  if (cleaned.startsWith(")]}'")) {
    const newline = cleaned.indexOf("\n");
    cleaned =
      newline >= 0
        ? cleaned.slice(newline + 1).trimStart()
        : cleaned.slice(4).trimStart();
  }

  return cleaned;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^,]*?),(.*)$/is.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const metadata = match[1] || "";
  const body = match[2] || "";

  if (/;base64/i.test(metadata)) {
    const binary = atob(body.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder("utf-8").decode(bytes);
  }

  return decodeURIComponent(body);
}

function isValidSourceMapObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "version") &&
    (typeof value.version === "number" || typeof value.version === "string") &&
    Array.isArray(value.sources) &&
    Object.prototype.hasOwnProperty.call(value, "mappings") &&
    typeof value.mappings === "string",
  );
}

function combineSourcePath(sourceRoot, source, index) {
  const fallback = `source-${index + 1}.js`;
  const sourceText = source ? String(source) : fallback;

  if (!sourceRoot) {
    return sourceText;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(sourceText)) {
    return sourceText;
  }

  return `${String(sourceRoot).replace(/\/?$/, "/")}${sourceText.replace(/^\/+/, "")}`;
}

function languageFromPath(path) {
  const lower = String(path || "").toLowerCase();

  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs"))
    return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".sass") ||
    lower.endsWith(".less")
  )
    return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".vue")) return "vue";
  if (lower.endsWith(".svelte")) return "svelte";

  return "text";
}

function extractSources(mapObject) {
  const sources = Array.isArray(mapObject.sources) ? mapObject.sources : [];
  const contents = Array.isArray(mapObject.sourcesContent)
    ? mapObject.sourcesContent
    : [];

  return sources.map((source, index) => {
    const content = contents[index];
    const available = typeof content === "string";
    const path = combineSourcePath(mapObject.sourceRoot || "", source, index);

    return {
      index,
      path,
      language: languageFromPath(path),
      available,
      size: available ? content.length : 0,
      content: available ? content : "",
    };
  });
}

function summarizeMapUrl(mapUrl) {
  if (/^data:/i.test(mapUrl)) {
    return "inline data: source map";
  }

  try {
    const url = new URL(mapUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return mapUrl;
  }
}

async function fetchMapText(mapUrl) {
  if (/^data:/i.test(mapUrl)) {
    return {
      finalUrl: mapUrl,
      status: 200,
      text: parseDataUrl(mapUrl),
    };
  }

  const response = await fetch(mapUrl, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    redirect: "follow",
    headers: {
      Accept: "application/json, text/plain, */*",
    },
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();

  return {
    finalUrl: response.url || mapUrl,
    status: response.status,
    text,
  };
}

async function fetchAndParseSourceMap(mapUrl) {
  const fetched = await fetchMapText(mapUrl);
  const cleaned = stripJsonPrefix(fetched.text);
  const parsed = JSON.parse(cleaned);

  if (!isValidSourceMapObject(parsed)) {
    throw new Error("Candidate is not a valid source map");
  }

  return {
    finalUrl: fetched.finalUrl,
    rawSize: fetched.text.length,
    mapObject: parsed,
  };
}

function mergeIntoExistingRecord(record, discovery) {
  record.lastSeen = nowIso();

  if (discovery.discoveredBy) {
    record.discoveredBy.add(discovery.discoveredBy);
  }

  if (discovery.scriptUrl) {
    record.scriptUrls.add(discovery.scriptUrl);
  }

  if (discovery.pageUrl && !record.pageUrl) {
    record.pageUrl = discovery.pageUrl;
  }
}

async function addConfirmedMap(mapUrl, parsedMap, discovery) {
  await loadMaps();
  const existing = MAPS.get(mapUrl);

  if (existing) {
    mergeIntoExistingRecord(existing, discovery);
    await saveMaps();
    await updateBadge();
    return existing;
  }

  const mapObject = parsedMap.mapObject;
  const sources = extractSources(mapObject);

  const record = {
    id: stableId(mapUrl),
    mapUrl,
    finalUrl: parsedMap.finalUrl,
    displayUrl: summarizeMapUrl(mapUrl),
    pageUrl: discovery.pageUrl || "",
    firstSeen: nowIso(),
    lastSeen: nowIso(),
    version: mapObject.version,
    sourceCount: Array.isArray(mapObject.sources)
      ? mapObject.sources.length
      : 0,
    embeddedSourceCount: sources.filter((source) => source.available).length,
    hasSourcesContent: sources.some((source) => source.available),
    rawMapSize: parsedMap.rawSize,
    discoveredBy: new Set(
      discovery.discoveredBy ? [discovery.discoveredBy] : [],
    ),
    scriptUrls: new Set(discovery.scriptUrl ? [discovery.scriptUrl] : []),
    sources,
  };

  MAPS.set(mapUrl, record);
  await saveMaps();
  await updateBadge();

  try {
    await browser.runtime.sendMessage({
      type: "sourceMapUpdated",
      count: MAPS.size,
    });
  } catch {
    // Popup may not be open.
  }

  return record;
}

async function queueMapCandidate(mapUrl, discovery) {
  if (!mapUrl) {
    return;
  }

  await loadMaps();
  const existing = MAPS.get(mapUrl);

  if (existing) {
    mergeIntoExistingRecord(existing, discovery);
    await saveMaps();
    await updateBadge();
    return;
  }

  if (IN_FLIGHT.has(mapUrl)) {
    const pending = IN_FLIGHT.get(mapUrl);

    if (discovery.discoveredBy) {
      pending.discoveredBy.add(discovery.discoveredBy);
    }

    if (discovery.scriptUrl) {
      pending.scriptUrls.add(discovery.scriptUrl);
    }

    if (discovery.pageUrl && !pending.pageUrl) {
      pending.pageUrl = discovery.pageUrl;
    }

    return;
  }

  // Already fetched (and rejected) this candidate during the session.
  if (ATTEMPTED.has(mapUrl)) {
    return;
  }

  ATTEMPTED.add(mapUrl);

  IN_FLIGHT.set(mapUrl, {
    discoveredBy: new Set(
      discovery.discoveredBy ? [discovery.discoveredBy] : [],
    ),
    scriptUrls: new Set(discovery.scriptUrl ? [discovery.scriptUrl] : []),
    pageUrl: discovery.pageUrl || "",
  });

  try {
    const parsedMap = await fetchAndParseSourceMap(mapUrl);
    const pending = IN_FLIGHT.get(mapUrl);

    await addConfirmedMap(mapUrl, parsedMap, {
      discoveredBy: Array.from(pending.discoveredBy).join(", "),
      scriptUrl: Array.from(pending.scriptUrls)[0] || discovery.scriptUrl || "",
      pageUrl: pending.pageUrl || discovery.pageUrl || "",
    });
  } catch (error) {
    // Invalid candidates are intentionally ignored to suppress false positives.
    console.debug("Rejected source map candidate:", mapUrl, error.message);
  } finally {
    IN_FLIGHT.delete(mapUrl);
  }
}

function attemptProactiveGuesses(scriptUrl, pageUrl) {
  for (const mapUrl of guessMapUrls(scriptUrl)) {
    queueMapCandidate(mapUrl, {
      discoveredBy: "proactive guess",
      scriptUrl,
      pageUrl,
    });
  }
}

function attachScriptBodyScanner(details, pageUrl) {
  let filter;

  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch (error) {
    console.warn("Unable to attach script response scanner:", error);
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let tail = "";

  filter.ondata = (event) => {
    try {
      const chunk = decoder.decode(event.data, { stream: true });
      tail = `${tail}${chunk}`.slice(-MAX_SCRIPT_TAIL_CHARS);
    } catch (error) {
      console.debug("Unable to decode script chunk:", error);
    }

    filter.write(event.data);
  };

  filter.onstop = () => {
    try {
      tail = `${tail}${decoder.decode()}`.slice(-MAX_SCRIPT_TAIL_CHARS);

      const references = extractSourceMappingComments(tail);

      for (const reference of references) {
        const mapUrl = resolveReference(reference, details.url);
        if (!mapUrl) {
          continue;
        }

        queueMapCandidate(mapUrl, {
          discoveredBy: "sourceMappingURL comment",
          scriptUrl: details.url,
          pageUrl,
        });
      }
    } catch (error) {
      console.debug("Script sourceMappingURL scan failed:", error);
    } finally {
      try {
        filter.close();
      } catch {
        // Already closed or disconnected.
      }
    }
  };

  filter.onerror = (event) => {
    console.debug("Script stream filter error:", event && event.error);
    try {
      filter.disconnect();
    } catch {
      // Ignore.
    }
  };
}

function onMainFrameRequest(details) {
  if (!enabled || details.tabId < 0) {
    return;
  }

  // Remember the page each tab is on so confirmed maps can be annotated with
  // where they were seen. Navigation no longer clears findings.
  PAGE_URL_BY_TAB.set(details.tabId, details.url);
}

function onScriptRequest(details) {
  if (!enabled || details.tabId < 0) {
    return {};
  }

  const pageUrl = PAGE_URL_BY_TAB.get(details.tabId) || "";

  attemptProactiveGuesses(details.url, pageUrl);
  attachScriptBodyScanner(details, pageUrl);

  return {};
}

function onHeadersReceived(details) {
  if (
    !enabled ||
    details.tabId < 0 ||
    !isSuccessfulStatus(details.statusCode || 0)
  ) {
    return;
  }

  const pageUrl = PAGE_URL_BY_TAB.get(details.tabId) || "";
  const header = getSourceMapHeader(details.responseHeaders || []);

  if (header) {
    const mapUrl = resolveReference(header.value, details.url);

    if (mapUrl) {
      queueMapCandidate(mapUrl, {
        discoveredBy: `HTTP ${header.name} header`,
        scriptUrl: details.url,
        pageUrl,
      });
    }
  }

  if (looksLikeSourceMapFile(details.url)) {
    queueMapCandidate(details.url, {
      discoveredBy: "network .js.map response",
      scriptUrl: "",
      pageUrl,
    });
  }
}

function buildLineStarts(text) {
  const starts = [0];

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }

  return starts;
}

function offsetToLine(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;

    if (offset < start) {
      high = mid - 1;
    } else if (offset >= next) {
      low = mid + 1;
    } else {
      return mid + 1;
    }
  }

  return 1;
}

function scanRecordForHardcoded(record) {
  const rules = globalThis.SourceMapHunterSecretRules || [];
  const findings = [];
  const MAX_FINDINGS = 500;

  for (const source of record.sources || []) {
    if (!source || !source.available || typeof source.content !== "string") {
      continue;
    }

    if (findings.length >= MAX_FINDINGS) {
      break;
    }

    const content = source.content;
    let lineStarts = null;

    for (const rule of rules) {
      if (findings.length >= MAX_FINDINGS) {
        break;
      }

      // First match per rule within this file is enough to point at it.
      let match = null;
      try {
        rule.pattern.lastIndex = 0;
        match = rule.pattern.exec(content);
      } catch {
        match = null;
      }

      if (match) {
        if (!lineStarts) {
          lineStarts = buildLineStarts(content);
        }

        const captured =
          match[1] && match[1].length >= 8 ? match[1] : match[0];

        findings.push({
          ruleName: rule.name,
          sourcePath: source.path || "",
          line: offsetToLine(lineStarts, match.index),
          evidence: String(captured).slice(0, 200),
        });
      }
    }
  }

  return findings;
}

async function scanAllForHardcoded() {
  await loadMaps();

  let flaggedMaps = 0;
  let totalFindings = 0;

  for (const record of MAPS.values()) {
    const findings = scanRecordForHardcoded(record);
    record.hardcoded = findings;
    record.hardcodedScannedAt = nowIso();

    if (findings.length > 0) {
      flaggedMaps += 1;
      totalFindings += findings.length;
    }
  }

  await saveMaps();

  return {
    scannedMaps: MAPS.size,
    flaggedMaps,
    totalFindings,
    rules: (globalThis.SourceMapHunterSecretRules || []).length,
  };
}

async function getSummary() {
  await loadMaps();
  const records = Array.from(MAPS.values());

  return {
    pageUrl: "All discovered source maps",
    updatedAt: nowIso(),
    count: records.length,
    maps: records.map((record) => ({
      id: record.id,
      mapUrl: record.mapUrl,
      finalUrl: record.finalUrl,
      displayUrl: record.displayUrl,
      pageUrl: record.pageUrl,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      version: record.version,
      sourceCount: record.sourceCount,
      embeddedSourceCount: record.embeddedSourceCount,
      hasSourcesContent: record.hasSourcesContent,
      rawMapSize: record.rawMapSize,
      discoveredBy: Array.from(record.discoveredBy || []),
      scriptUrls: Array.from(record.scriptUrls || []),
      hardcoded: Array.isArray(record.hardcoded) ? record.hardcoded : [],
    })),
  };
}

async function getMapById(mapId) {
  await loadMaps();

  for (const record of MAPS.values()) {
    if (record.id === mapId) {
      return {
        ...record,
        discoveredBy: Array.from(record.discoveredBy || []),
        scriptUrls: Array.from(record.scriptUrls || []),
      };
    }
  }

  return null;
}

async function downloadMapZip(mapId) {
  const record = await getMapById(mapId);

  if (!record) {
    throw new Error("Source map not found");
  }

  if (
    !globalThis.SourceMapHunterZip ||
    typeof globalThis.SourceMapHunterZip.downloadMapAsZip !== "function"
  ) {
    throw new Error("ZIP downloader is unavailable");
  }

  await globalThis.SourceMapHunterZip.downloadMapAsZip(record);
}

browser.webRequest.onBeforeRequest.addListener(onMainFrameRequest, {
  urls: ["<all_urls>"],
  types: ["main_frame"],
});

// Scanning script bodies for sourceMappingURL comments uses
// filterResponseData, which Firefox only permits from a blocking
// onBeforeRequest listener. Scope the blocking listener to scripts so it
// is the only request type that pays for it.
browser.webRequest.onBeforeRequest.addListener(
  onScriptRequest,
  {
    urls: ["<all_urls>"],
    types: ["script"],
  },
  ["blocking"],
);

browser.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  {
    urls: ["<all_urls>"],
  },
  ["responseHeaders"],
);

browser.tabs.onRemoved.addListener((tabId) => {
  // Closing a tab forgets only where that tab was; discovered maps are kept.
  PAGE_URL_BY_TAB.delete(tabId);
});

browser.runtime.onInstalled.addListener(async () => {
  try {
    await browser.action.setBadgeBackgroundColor({ color: "#d90429" });
  } catch {
    // Ignore.
  }

  await loadEnabled();
  await updateBadge();
});

// Keep the in-memory enabled cache in sync if the value is changed elsewhere
// (e.g. directly through storage), so the request listeners never act on a
// stale switch state.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ENABLED_KEY]) {
    const next = changes[ENABLED_KEY].newValue;
    if (typeof next === "boolean") {
      enabled = next;
      updateBadge().catch(() => {});
    }
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return Promise.resolve({ ok: false, error: "Invalid message" });
  }

  if (message.type === "getEnabled") {
    return loadEnabled().then((value) => ({ ok: true, enabled: value }));
  }

  if (message.type === "setEnabled") {
    return setEnabled(message.enabled).then((value) => ({
      ok: true,
      enabled: value,
    }));
  }

  if (message.type === "getSummary" || message.type === "getTabSummary") {
    return getSummary().then((data) => ({ ok: true, data }));
  }

  if (message.type === "getMap") {
    return getMapById(message.mapId).then((data) => ({
      ok: Boolean(data),
      data,
      error: data ? "" : "Source map not found",
    }));
  }

  if (message.type === "downloadMapZip") {
    return downloadMapZip(message.mapId)
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : "Download failed",
      }));
  }

  if (message.type === "clearAll" || message.type === "clearTab") {
    return clearAllMaps().then(() => ({ ok: true }));
  }

  if (message.type === "scanHardcoded") {
    return scanAllForHardcoded().then((data) => ({ ok: true, data }));
  }

  return Promise.resolve({ ok: false, error: "Unknown message type" });
});

// Restore the enabled state and badge count when the background wakes (e.g.
// after a browser restart, where onInstalled does not fire).
loadEnabled()
  .then(updateBadge)
  .catch(() => {
    // Best effort.
  });
