"use strict";

/*
  Source Map Hunter — Chrome MV3 background service worker.

  Port of background.js from the Firefox extension. The detection model and
  storage layout are preserved. The key Chrome-specific change is response-body
  access: Chrome MV3 does not support Firefox's webRequest.filterResponseData
  (webRequestFilterResponse permission). To preserve "JavaScript comment
  detection" we instead re-fetch the JavaScript resource URL from the service
  worker context (host permissions bypass CORS and credentials:include sends
  the page's cookies for authenticated bundles), stream the response keeping
  only the final 160 KB, and scan that tail for //# sourceMappingURL comments.
  All other detection paths (headers, direct .map responses, proactive guesses)
  are unchanged from the original.

  Storage model (unchanged from the Firefox version):
  - Confirmed maps accumulate into a single, global, persistent collection
    keyed by map URL. Findings are kept across navigations, tab switches, tab
    closes, and worker restarts until the user explicitly clears them.
  - The on/off flag lives in storage.sync (independent quota from the large
    maps blob in storage.local).
*/

importScripts(
  "../shared/zip.js",
  "../shared/secretRules.js",
  "../shared/urlUtils.js",
  "../shared/sourcemap.js",
);

const {
  safeUrl,
  isBrowserInternalUrl,
  looksLikeJavaScriptFile,
  looksLikeSourceMapFile,
  isSuccessfulStatus,
  getSourceMapHeader,
  resolveReference,
  guessMapUrls,
  extractSourceMappingComments,
  summarizeMapUrl,
} = globalThis.SourceMapHunterUrlUtils;

const {
  stableId,
  stripJsonPrefix,
  parseDataUrl,
  isValidSourceMapObject,
  isMeaningfulSourceMap,
  isIndexedSourceMap,
  combineSourcePath,
  languageFromPath,
  extractSources,
  parseSourceMapText,
} = globalThis.SourceMapHunterSourceMap;

const MAX_SCRIPT_TAIL_CHARS = 160 * 1024;
const MAX_FETCH_BYTES = 32 * 1024 * 1024; // per-script fetch cap
const FETCH_TIMEOUT_MS = 20_000;
const STORAGE_KEY = "sourceMapHunter:maps";
const ENABLED_KEY = "sourceMapHunter:enabled";
const SESSION_ATTEMPTED_KEY = "sourceMapHunter:attempted";
const SESSION_INFLIGHT_KEY = "sourceMapHunter:inflight";
const MAX_CONCURRENT_VALIDATIONS = 6;

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

// Session-only caches (rebuilt each worker lifetime). Persisted to
// chrome.storage.session so they survive the short SW suspensions Chrome MV3
// performs, restoring dedup behavior without re-hitting already-rejected maps.
const ATTEMPTED = new Set();
const IN_FLIGHT = new Map(); // mapUrl -> { discoveredBy:Set, scriptUrls:Set, pageUrl }
let sessionRestored = false;
let sessionRestoring = null;

// Concurrency gate for proactive validation fetches.
let activeValidations = 0;
const validationQueue = [];

// tabId -> last main_frame url, for annotation.
const PAGE_URL_BY_TAB = new Map();

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

// ---- Persistent maps (storage.local) --------------------------------------

async function loadMaps() {
  if (mapsLoaded) {
    return MAPS;
  }

  // Dedupe concurrent loads: when the service worker wakes up, several
  // requests can race to rehydrate. They must share one collection so later
  // saves do not clobber earlier ones.
  if (loadingMaps) {
    return loadingMaps;
  }

  loadingMaps = (async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY);
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

let saveScheduled = false;

function scheduleSaveMaps() {
  if (saveScheduled) {
    return;
  }
  saveScheduled = true;
  // Coalesce rapid saves into one write. Resolves on the next microtask turn,
  // which is enough to fold back-to-back discoveries into a single set() call.
  Promise.resolve().then(async () => {
    saveScheduled = false;
    try {
      await loadMaps();
      const serialized = Array.from(MAPS.values()).map(serializeRecord);
      await chrome.storage.local.set({ [STORAGE_KEY]: serialized });
    } catch (error) {
      console.warn("Failed to save maps:", error);
    }
  });
}

async function saveMaps() {
  await loadMaps();
  const serialized = Array.from(MAPS.values()).map(serializeRecord);
  await chrome.storage.local.set({ [STORAGE_KEY]: serialized });
}

async function clearAllMaps() {
  await loadMaps();
  MAPS.clear();
  ATTEMPTED.clear();
  IN_FLIGHT.clear();
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  await chrome.storage.session.set({
    [SESSION_ATTEMPTED_KEY]: [],
    [SESSION_INFLIGHT_KEY]: [],
  });
  await updateBadge();
}

// ---- Session caches (storage.session) --------------------------------------

async function restoreSession() {
  if (sessionRestored) {
    return;
  }
  if (sessionRestoring) {
    return sessionRestoring;
  }

  sessionRestoring = (async () => {
    try {
      const data = await chrome.storage.session.get([
        SESSION_ATTEMPTED_KEY,
        SESSION_INFLIGHT_KEY,
      ]);
      const attempted = data[SESSION_ATTEMPTED_KEY];
      if (Array.isArray(attempted)) {
        for (const url of attempted) {
          ATTEMPTED.add(url);
        }
      }
      // In-flight map is only meaningful if a worker died mid-validation; we
      // drop it on restore (the validation promise is gone with the worker).
      // Attempted set prevents re-hitting already-rejected candidates.
    } catch (error) {
      console.debug("Unable to restore session caches:", error);
    }
    sessionRestored = true;
    sessionRestoring = null;
  })();

  return sessionRestoring;
}

async function persistAttempted() {
  try {
    await chrome.storage.session.set({
      [SESSION_ATTEMPTED_KEY]: Array.from(ATTEMPTED),
    });
  } catch (error) {
    console.debug("Unable to persist attempted set:", error);
  }
}

// ---- Enabled flag (storage.sync) -------------------------------------------

async function loadEnabled() {
  // The on/off flag lives in storage.sync, isolated from the large source-map
  // blob in storage.local. If local hits its quota, writes of this flag must
  // still succeed — so the popup persists it to sync and we read it from sync.
  try {
    const data = await chrome.storage.sync.get(ENABLED_KEY);
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
  await chrome.storage.sync.set({ [ENABLED_KEY]: enabled });
  await updateBadge();

  try {
    await chrome.runtime.sendMessage({
      type: "enabledChanged",
      enabled,
    });
  } catch {
    // Popup may not be open.
  }

  return enabled;
}

// ---- Badge ------------------------------------------------------------------

async function updateBadge() {
  await loadMaps();
  const count = MAPS.size;

  try {
    // When the switch is off, make the disabled state obvious in the toolbar
    // rather than showing a stale finding count.
    if (!enabled) {
      chrome.action.setBadgeText({ text: "off" });
      chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
      chrome.action.setTitle({ title: "Source Map Hunter (disabled)" });
      return;
    }

    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : "",
    });

    chrome.action.setBadgeBackgroundColor({ color: "#d90429" });

    chrome.action.setTitle({
      title:
        count > 0
          ? `Source Map Hunter: ${count} source map${count === 1 ? "" : "s"} found`
          : "Source Map Hunter",
    });
  } catch (error) {
    console.warn("Failed to update badge:", error);
  }
}

// ---- Source map fetching + validation --------------------------------------

async function fetchMapText(mapUrl) {
  if (/^data:/i.test(mapUrl)) {
    return {
      finalUrl: mapUrl,
      status: 200,
      text: parseDataUrl(mapUrl),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(mapUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      signal: controller.signal,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Guard against reading unbounded bodies: read up to MAX_FETCH_BYTES + 1,
    // then reject if the cap is exceeded (so a multi-GB JSON error page does
    // not OOM the worker).
    const text = await readCapped(response, MAX_FETCH_BYTES);

    return {
      finalUrl: response.url || mapUrl,
      status: response.status,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response, cap) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      received += value.byteLength;
      if (received > cap) {
        try {
          await reader.cancel();
        } catch {
          // Ignore.
        }
        throw new Error("Source map response exceeds maximum fetch size");
      }
      text += decoder.decode(value, { stream: !done });
    }
  }
  text += decoder.decode();
  return text;
}

async function fetchAndParseSourceMap(mapUrl) {
  const fetched = await fetchMapText(mapUrl);
  const { mapObject, rawSize } = parseSourceMapText(fetched.text);

  if (!isValidSourceMapObject(mapObject)) {
    // Indexed maps (sections) are recognized but not expanded; treat as
    // invalid for confirmation to avoid false positives (matches original).
    if (isIndexedSourceMap(mapObject)) {
      throw new Error("Indexed source map (sections) not supported");
    }
    throw new Error("Candidate is not a valid source map");
  }

  // Structurally valid but a useless placeholder (e.g. Closure Compiler emits
  // an inline data: map with sources:[""] and whitespace sourcesContent for a
  // script with no recoverable source). Nothing to reconstruct -> skip.
  if (!isMeaningfulSourceMap(mapObject)) {
    throw new Error("Source map has no recoverable content (empty placeholder)");
  }

  return {
    finalUrl: fetched.finalUrl,
    rawSize,
    mapObject,
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
    scheduleSaveMaps();
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
    discoveredBy: new Set(discovery.discoveredBy ? [discovery.discoveredBy] : []),
    scriptUrls: new Set(discovery.scriptUrl ? [discovery.scriptUrl] : []),
    sources,
  };

  MAPS.set(mapUrl, record);
  scheduleSaveMaps();
  await updateBadge();

  try {
    await chrome.runtime.sendMessage({
      type: "sourceMapUpdated",
      count: MAPS.size,
    });
  } catch {
    // Popup may not be open.
  }

  return record;
}

function runValidation(mapUrl, discovery) {
  return new Promise((resolve) => {
    const task = { mapUrl, discovery, resolve };
    validationQueue.push(task);
    pumpValidationQueue();
  });
}

function pumpValidationQueue() {
  while (activeValidations < MAX_CONCURRENT_VALIDATIONS && validationQueue.length > 0) {
    const task = validationQueue.shift();
    activeValidations += 1;
    runOneValidation(task.mapUrl, task.discovery)
      .then(task.resolve)
      .catch(() => {})
      .finally(() => {
        activeValidations -= 1;
        pumpValidationQueue();
      });
  }
}

async function runOneValidation(mapUrl, discovery) {
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

async function queueMapCandidate(mapUrl, discovery) {
  if (!mapUrl) {
    return;
  }

  await loadMaps();
  await restoreSession();

  const existing = MAPS.get(mapUrl);

  if (existing) {
    mergeIntoExistingRecord(existing, discovery);
    scheduleSaveMaps();
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
  persistAttempted();

  IN_FLIGHT.set(mapUrl, {
    discoveredBy: new Set(discovery.discoveredBy ? [discovery.discoveredBy] : []),
    scriptUrls: new Set(discovery.scriptUrl ? [discovery.scriptUrl] : []),
    pageUrl: discovery.pageUrl || "",
  });

  await runValidation(mapUrl, discovery);
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

// ---- Script body scanning (Chrome: re-fetch from SW) -----------------------
//
// Firefox used webRequest.filterResponseData to tap the live response stream.
// Chrome MV3 has no equivalent; the least-invasive reliable substitute is to
// re-fetch the script URL from the extension service worker (host permissions
// bypass CORS and credentials:include carries the page's cookies for
// authenticated bundles), stream the response, keep the final 160 KB, and
// scan that tail for sourceMappingURL directives. We only do this for script
// requests that look like JavaScript files, to avoid fetching unrelated
// resources.

async function scanScriptBodyForComments(scriptUrl, pageUrl) {
  if (!looksLikeJavaScriptFile(scriptUrl)) {
    return;
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    response = await fetch(scriptUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "*/*" },
      signal: controller.signal,
    });

    if (!response.ok) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let tail = "";
    let received = 0;
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        received += value.byteLength;
        if (received > MAX_FETCH_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Ignore.
          }
          return;
        }
        const chunk = decoder.decode(value, { stream: !done });
        tail = `${tail}${chunk}`.slice(-MAX_SCRIPT_TAIL_CHARS);
      }
    }
    tail = `${tail}${decoder.decode()}`.slice(-MAX_SCRIPT_TAIL_CHARS);

    const references = extractSourceMappingComments(tail);

    for (const reference of references) {
      const mapUrl = resolveReference(reference, scriptUrl);
      if (!mapUrl) {
        continue;
      }

      queueMapCandidate(mapUrl, {
        discoveredBy: "sourceMappingURL comment",
        scriptUrl,
        pageUrl,
      });
    }
  } catch (error) {
    console.debug("Script sourceMappingURL scan failed:", scriptUrl, error.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---- webRequest listeners (observation only) -------------------------------

function onMainFrameRequest(details) {
  if (!enabled || details.tabId < 0) {
    return;
  }

  if (isBrowserInternalUrl(details.url)) {
    return;
  }

  // Remember the page each tab is on so confirmed maps can be annotated with
  // where they were seen. Navigation no longer clears findings.
  PAGE_URL_BY_TAB.set(details.tabId, details.url);
}

function onScriptRequest(details) {
  if (!enabled || details.tabId < 0) {
    return;
  }

  if (isBrowserInternalUrl(details.url)) {
    return;
  }

  const pageUrl = PAGE_URL_BY_TAB.get(details.tabId) || "";

  attemptProactiveGuesses(details.url, pageUrl);

  // Body scan is async and intentionally fire-and-forget: it re-fetches the
  // script from the SW context. We do not block the request (Chrome MV3
  // forbids blocking onBeforeRequest for body access anyway).
  scanScriptBodyForComments(details.url, pageUrl);
}

function onHeadersReceived(details) {
  if (
    !enabled ||
    details.tabId < 0 ||
    !isSuccessfulStatus(details.statusCode || 0)
  ) {
    return;
  }

  if (isBrowserInternalUrl(details.url)) {
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

// ---- Hardcoded scanner -----------------------------------------------------

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

async function scanAllForHardcoded(mapIds) {
  await loadMaps();

  // When the popup passes mapIds (a domain filter is active), scan only those
  // records. Otherwise scan every discovered map.
  const idFilter =
    Array.isArray(mapIds) && mapIds.length > 0 ? new Set(mapIds) : null;

  let scannedMaps = 0;
  let flaggedMaps = 0;
  let totalFindings = 0;

  for (const record of MAPS.values()) {
    if (idFilter && !idFilter.has(record.id)) {
      continue;
    }

    const findings = scanRecordForHardcoded(record);
    record.hardcoded = findings;
    record.hardcodedScannedAt = nowIso();
    scannedMaps += 1;

    if (findings.length > 0) {
      flaggedMaps += 1;
      totalFindings += findings.length;
    }
  }

  await saveMaps();

  return {
    scannedMaps,
    flaggedMaps,
    totalFindings,
    rules: (globalThis.SourceMapHunterSecretRules || []).length,
  };
}

// ---- Read APIs -------------------------------------------------------------

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

async function getMapsByIds(mapIds) {
  await loadMaps();

  const idFilter =
    Array.isArray(mapIds) && mapIds.length > 0 ? new Set(mapIds) : null;

  const records = [];

  for (const record of MAPS.values()) {
    if (idFilter && !idFilter.has(record.id)) {
      continue;
    }

    records.push({
      ...record,
      discoveredBy: Array.from(record.discoveredBy || []),
      scriptUrls: Array.from(record.scriptUrls || []),
    });
  }

  return records;
}

// ---- Downloads -------------------------------------------------------------

async function downloadMapZip(mapId, options = {}) {
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

  await globalThis.SourceMapHunterZip.downloadMapAsZip(record, options);
}

async function downloadMapsZip(mapIds) {
  const ids = Array.isArray(mapIds) ? mapIds.filter(Boolean) : [];

  if (ids.length === 0) {
    throw new Error("No source maps to download");
  }

  let completed = 0;
  let failed = 0;
  const errors = [];

  for (const mapId of ids) {
    try {
      await downloadMapZip(mapId, { saveAs: false });
      completed += 1;
    } catch (error) {
      failed += 1;
      errors.push(error && error.message ? error.message : "Download failed");
    }
  }

  return { total: ids.length, completed, failed, errors };
}

// ---- Report generation ------------------------------------------------------

async function generateReport(mapIds) {
  await loadMaps();

  const idFilter =
    Array.isArray(mapIds) && mapIds.length > 0 ? new Set(mapIds) : null;

  const records = [];

  for (const record of MAPS.values()) {
    if (idFilter && !idFilter.has(record.id)) {
      continue;
    }
    records.push(record);
  }

  const manifest = chrome.runtime.getManifest();
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    extensionVersion: manifest.version,
    extensionName: manifest.name,
    pageUrl: "All discovered source maps",
    count: records.length,
    maps: records.map((record) => ({
      mapUrl: record.mapUrl,
      finalUrl: record.finalUrl,
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
      sources: (record.sources || []).map((source) => ({
        path: source.path,
        language: source.language,
        available: source.available,
        size: source.size,
      })),
      hardcoded: Array.isArray(record.hardcoded) ? record.hardcoded : [],
      hardcodedScannedAt: record.hardcodedScannedAt || null,
    })),
  };
}

// ---- Listener registration -------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(onMainFrameRequest, {
  urls: ["<all_urls>"],
  types: ["main_frame"],
});

// Script-body scanning uses a non-blocking onBeforeRequest listener (Chrome
// MV3 does not allow blocking webRequest, and we do not need it: body scanning
// happens via a separate fetch from the service worker).
chrome.webRequest.onBeforeRequest.addListener(onScriptRequest, {
  urls: ["<all_urls>"],
  types: ["script"],
});

chrome.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  // Closing a tab forgets only where that tab was; discovered maps are kept.
  PAGE_URL_BY_TAB.delete(tabId);
});

chrome.tabs.onActivated.addListener(() => {
  // Badge is global (count of all discovered maps), so tab activation does not
  // require a recount. Touching the badge here keeps it fresh after idle.
  updateBadge().catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#d90429" });
  } catch {
    // Ignore.
  }

  await loadEnabled();
  await restoreSession();
  await updateBadge();
});

// Keep the in-memory enabled cache in sync if the value is changed elsewhere
// (e.g. directly through storage, or another synced device), so the request
// listeners never act on a stale switch state.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[ENABLED_KEY]) {
    const next = changes[ENABLED_KEY].newValue;
    if (typeof next === "boolean") {
      enabled = next;
      updateBadge().catch(() => {});
    }
  }
});

// Async message handler. Chrome requires returning true to keep the
// sendResponse channel open for async replies.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "Invalid message" });
    return false;
  }

  let promise;

  if (message.type === "getEnabled") {
    promise = loadEnabled().then((value) => ({ ok: true, enabled: value }));
  } else if (message.type === "setEnabled") {
    promise = setEnabled(message.enabled).then((value) => ({
      ok: true,
      enabled: value,
    }));
  } else if (message.type === "getSummary" || message.type === "getTabSummary") {
    promise = getSummary().then((data) => ({ ok: true, data }));
  } else if (message.type === "getMap") {
    promise = getMapById(message.mapId).then((data) => ({
      ok: Boolean(data),
      data,
      error: data ? "" : "Source map not found",
    }));
  } else if (message.type === "getMaps") {
    promise = getMapsByIds(message.mapIds).then((data) => ({ ok: true, data }));
  } else if (message.type === "downloadMapZip") {
    promise = downloadMapZip(message.mapId, message.options || {})
      .then(() => ({ ok: true }))
      .catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : "Download failed",
      }));
  } else if (message.type === "downloadMapsZip") {
    promise = downloadMapsZip(message.mapIds)
      .then((data) => ({ ok: true, data }))
      .catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : "Download failed",
      }));
  } else if (message.type === "generateReport") {
    promise = generateReport(message.mapIds)
      .then((data) => ({ ok: true, data }))
      .catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : "Report failed",
      }));
  } else if (message.type === "clearAll" || message.type === "clearTab") {
    promise = clearAllMaps().then(() => ({ ok: true }));
  } else if (message.type === "scanHardcoded") {
    promise = scanAllForHardcoded(message.mapIds).then((data) => ({
      ok: true,
      data,
    }));
  } else {
    promise = Promise.resolve({ ok: false, error: "Unknown message type" });
  }

  promise.then(sendResponse, (error) =>
    sendResponse({
      ok: false,
      error: error && error.message ? error.message : "Internal error",
    }),
  );
  return true; // keep the channel open for the async sendResponse
});

// Restore the enabled state and badge count when the worker wakes (e.g. after
// a browser restart, where onInstalled does not fire). Also restore session
// dedup caches so already-rejected candidates are not re-fetched.
loadEnabled()
  .then(() => restoreSession())
  .then(updateBadge)
  .catch(() => {
    // Best effort.
  });