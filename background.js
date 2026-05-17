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
const STORAGE_PREFIX = "tabState:";
const IN_FLIGHT = new Map();
const STATE_BY_TAB = new Map();

function nowIso() {
  return new Date().toISOString();
}

function stateKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

function emptyState(tabId, pageUrl = "") {
  return {
    tabId,
    pageUrl,
    updatedAt: nowIso(),
    maps: new Map(),
    attempts: new Set(),
    scripts: new Set(),
  };
}

function getState(tabId) {
  if (!STATE_BY_TAB.has(tabId)) {
    STATE_BY_TAB.set(tabId, emptyState(tabId));
  }
  return STATE_BY_TAB.get(tabId);
}

function serializeState(state) {
  return {
    tabId: state.tabId,
    pageUrl: state.pageUrl,
    updatedAt: state.updatedAt,
    maps: Array.from(state.maps.values()).map((record) => ({
      ...record,
      discoveredBy: Array.from(record.discoveredBy || []),
      scriptUrls: Array.from(record.scriptUrls || []),
    })),
  };
}

function hydrateState(serialized) {
  const state = emptyState(serialized.tabId, serialized.pageUrl || "");
  state.updatedAt = serialized.updatedAt || nowIso();

  for (const record of serialized.maps || []) {
    state.maps.set(record.mapUrl, {
      ...record,
      discoveredBy: new Set(record.discoveredBy || []),
      scriptUrls: new Set(record.scriptUrls || []),
    });
  }

  return state;
}

async function loadState(tabId) {
  if (STATE_BY_TAB.has(tabId)) {
    return STATE_BY_TAB.get(tabId);
  }

  const data = await browser.storage.local.get(stateKey(tabId));
  const serialized = data[stateKey(tabId)];

  if (serialized) {
    const hydrated = hydrateState(serialized);
    STATE_BY_TAB.set(tabId, hydrated);
    return hydrated;
  }

  const state = emptyState(tabId);
  STATE_BY_TAB.set(tabId, state);
  return state;
}

async function saveState(tabId) {
  const state = getState(tabId);
  state.updatedAt = nowIso();

  await browser.storage.local.set({
    [stateKey(tabId)]: serializeState(state),
  });
}

async function resetTabState(tabId, pageUrl = "") {
  if (tabId < 0) {
    return;
  }

  const state = emptyState(tabId, pageUrl);
  STATE_BY_TAB.set(tabId, state);
  await browser.storage.local.set({ [stateKey(tabId)]: serializeState(state) });
  await updateBadge(tabId);
}

async function removeTabState(tabId) {
  STATE_BY_TAB.delete(tabId);
  await browser.storage.local.remove(stateKey(tabId));
}

async function updateBadge(tabId) {
  if (tabId < 0) {
    return;
  }

  const state = getState(tabId);
  const count = state.maps.size;

  try {
    await browser.action.setBadgeText({
      tabId,
      text: count > 0 ? String(count) : "",
    });

    await browser.action.setBadgeBackgroundColor({
      tabId,
      color: "#d90429",
    });

    await browser.action.setTitle({
      tabId,
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
    .replace(/^\uFEFF/, "")
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
}

async function addConfirmedMap(tabId, mapUrl, parsedMap, discovery) {
  const state = getState(tabId);
  const existing = state.maps.get(mapUrl);

  if (existing) {
    mergeIntoExistingRecord(existing, discovery);
    await saveState(tabId);
    await updateBadge(tabId);
    return existing;
  }

  const mapObject = parsedMap.mapObject;
  const sources = extractSources(mapObject);

  const record = {
    id: stableId(mapUrl),
    mapUrl,
    finalUrl: parsedMap.finalUrl,
    displayUrl: summarizeMapUrl(mapUrl),
    pageUrl: state.pageUrl || "",
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

  state.maps.set(mapUrl, record);
  await saveState(tabId);
  await updateBadge(tabId);

  try {
    await browser.runtime.sendMessage({
      type: "sourceMapUpdated",
      tabId,
      count: state.maps.size,
    });
  } catch {
    // Popup may not be open.
  }

  return record;
}

async function queueMapCandidate(tabId, mapUrl, discovery) {
  if (tabId < 0 || !mapUrl) {
    return;
  }

  const state = getState(tabId);
  const existing = state.maps.get(mapUrl);

  if (existing) {
    mergeIntoExistingRecord(existing, discovery);
    await saveState(tabId);
    await updateBadge(tabId);
    return;
  }

  const key = `${tabId}|${mapUrl}`;

  if (IN_FLIGHT.has(key)) {
    const pending = IN_FLIGHT.get(key);

    if (discovery.discoveredBy) {
      pending.discoveredBy.add(discovery.discoveredBy);
    }

    if (discovery.scriptUrl) {
      pending.scriptUrls.add(discovery.scriptUrl);
    }

    return;
  }

  IN_FLIGHT.set(key, {
    discoveredBy: new Set(
      discovery.discoveredBy ? [discovery.discoveredBy] : [],
    ),
    scriptUrls: new Set(discovery.scriptUrl ? [discovery.scriptUrl] : []),
  });

  try {
    const parsedMap = await fetchAndParseSourceMap(mapUrl);
    const pending = IN_FLIGHT.get(key);

    await addConfirmedMap(tabId, mapUrl, parsedMap, {
      discoveredBy: Array.from(pending.discoveredBy).join(", "),
      scriptUrl: Array.from(pending.scriptUrls)[0] || discovery.scriptUrl || "",
    });
  } catch (error) {
    // Invalid candidates are intentionally ignored to suppress false positives.
    console.debug("Rejected source map candidate:", mapUrl, error.message);
  } finally {
    IN_FLIGHT.delete(key);
  }
}

function attemptProactiveGuesses(tabId, scriptUrl) {
  const state = getState(tabId);

  if (state.scripts.has(scriptUrl)) {
    return;
  }

  state.scripts.add(scriptUrl);

  for (const mapUrl of guessMapUrls(scriptUrl)) {
    const key = `guess:${mapUrl}`;

    if (state.attempts.has(key)) {
      continue;
    }

    state.attempts.add(key);

    queueMapCandidate(tabId, mapUrl, {
      discoveredBy: "proactive guess",
      scriptUrl,
    });
  }
}

function attachScriptBodyScanner(details) {
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

        queueMapCandidate(details.tabId, mapUrl, {
          discoveredBy: "sourceMappingURL comment",
          scriptUrl: details.url,
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

function onBeforeRequest(details) {
  if (details.tabId < 0) {
    return {};
  }

  if (details.type === "main_frame") {
    resetTabState(details.tabId, details.url);
    return {};
  }

  if (details.type === "script") {
    attemptProactiveGuesses(details.tabId, details.url);
    attachScriptBodyScanner(details);
  }

  return {};
}

function onHeadersReceived(details) {
  if (details.tabId < 0 || !isSuccessfulStatus(details.statusCode || 0)) {
    return;
  }

  const header = getSourceMapHeader(details.responseHeaders || []);

  if (header) {
    const mapUrl = resolveReference(header.value, details.url);

    if (mapUrl) {
      queueMapCandidate(details.tabId, mapUrl, {
        discoveredBy: `HTTP ${header.name} header`,
        scriptUrl: details.url,
      });
    }
  }

  if (looksLikeSourceMapFile(details.url)) {
    queueMapCandidate(details.tabId, details.url, {
      discoveredBy: "network .js.map response",
      scriptUrl: "",
    });
  }
}

async function getTabSummary(tabId) {
  const state = await loadState(tabId);

  return {
    tabId,
    pageUrl: state.pageUrl || "",
    updatedAt: state.updatedAt,
    count: state.maps.size,
    maps: Array.from(state.maps.values()).map((record) => ({
      id: record.id,
      mapUrl: record.mapUrl,
      finalUrl: record.finalUrl,
      displayUrl: record.displayUrl,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      version: record.version,
      sourceCount: record.sourceCount,
      embeddedSourceCount: record.embeddedSourceCount,
      hasSourcesContent: record.hasSourcesContent,
      rawMapSize: record.rawMapSize,
      discoveredBy: Array.from(record.discoveredBy || []),
      scriptUrls: Array.from(record.scriptUrls || []),
    })),
  };
}

async function getMapById(tabId, mapId) {
  const state = await loadState(tabId);

  for (const record of state.maps.values()) {
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

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  {
    urls: ["<all_urls>"],
    types: ["main_frame", "script"],
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
  removeTabState(tabId);
});

browser.runtime.onInstalled.addListener(async () => {
  try {
    await browser.action.setBadgeBackgroundColor({ color: "#d90429" });
  } catch {
    // Ignore.
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return Promise.resolve({ ok: false, error: "Invalid message" });
  }

  if (message.type === "getTabSummary") {
    return getTabSummary(message.tabId).then((data) => ({ ok: true, data }));
  }

  if (message.type === "getMap") {
    return getMapById(message.tabId, message.mapId).then((data) => ({
      ok: Boolean(data),
      data,
      error: data ? "" : "Source map not found",
    }));
  }

  if (message.type === "clearTab") {
    return resetTabState(message.tabId, "").then(() => ({ ok: true }));
  }

  return Promise.resolve({ ok: false, error: "Unknown message type" });
});
