"use strict";

let activeTabId = null;
let currentSummary = null;
let extensionEnabled = true;
let scanInProgress = false;

const countEl = document.getElementById("count");
const pageUrlEl = document.getElementById("pageUrl");
const subtitleEl = document.getElementById("subtitle");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const enabledToggle = document.getElementById("enabledToggle");
const enabledLabel = document.getElementById("enabledLabel");
const domainFilterEl = document.getElementById("domainFilter");
const clearFilterBtn = document.getElementById("clearFilter");
const filterStatusEl = document.getElementById("filterStatus");
const scanBtn = document.getElementById("scanHardcoded");
const scanStatusEl = document.getElementById("scanStatus");
const searchAllBtn = document.getElementById("searchAll");
const downloadAllBtn = document.getElementById("downloadAll");
const downloadAllStatusEl = document.getElementById("downloadAllStatus");
const SCAN_BUTTON_LABEL = "Search source maps for hardcoded data";
const DOWNLOAD_ALL_BUTTON_LABEL = "Download all sourcemaps";
let downloadAllInProgress = false;
const DOMAIN_FILTER_STORAGE_KEY = "popupDomainFilter";
// Must match ENABLED_KEY in sw.js. Stored in storage.sync (not local) on
// purpose: storage.local holds the large reconstructed source-map blob and can
// hit its quota. storage.sync has an independent quota, so the tiny on/off
// flag is always writable and readable.
const ENABLED_STORAGE_KEY = "sourceMapHunter:enabled";

async function restoreDomainFilter() {
  try {
    const data = await browser.storage.local.get(DOMAIN_FILTER_STORAGE_KEY);
    const savedValue = data[DOMAIN_FILTER_STORAGE_KEY];

    if (typeof savedValue === "string") {
      domainFilterEl.value = savedValue;
    }
  } catch (error) {
    console.error("Unable to restore domain filter:", error);
  }
}

async function saveDomainFilter() {
  try {
    await browser.storage.local.set({
      [DOMAIN_FILTER_STORAGE_KEY]: domainFilterEl.value,
    });
  } catch (error) {
    console.error("Unable to save domain filter:", error);
  }
}

function text(value) {
  return value == null ? "" : String(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createElement(tag, className, content) {
  const el = document.createElement(tag);

  if (className) {
    el.className = className;
  }

  if (content !== undefined) {
    el.textContent = content;
  }

  return el;
}

function hostnameFromUrl(urlString) {
  if (/^data:/i.test(text(urlString))) {
    return "data:";
  }

  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeDomainTerm(term) {
  try {
    return new URL(term).hostname.toLowerCase();
  } catch {
    return term
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .toLowerCase();
  }
}

function domainCandidates(item) {
  const urls = [item.mapUrl, item.finalUrl, ...(item.scriptUrls || [])];
  const domains = new Set();

  for (const url of urls) {
    const domain = hostnameFromUrl(url);

    if (domain) {
      domains.add(domain);
    }
  }

  return Array.from(domains);
}

function getDomainFilterTerms() {
  return domainFilterEl.value
    .trim()
    .toLowerCase()
    .split(/[,\s]+/)
    .map(normalizeDomainTerm)
    .filter(Boolean);
}

function matchesDomainFilter(item, terms) {
  if (terms.length === 0) {
    return true;
  }

  const candidates = domainCandidates(item);

  return terms.some((term) =>
    candidates.some((domain) => domain.includes(term)),
  );
}

// IDs of the maps the hardcoded-data scan should target: the maps matching the
// active domain filter, or all maps when no filter is set.
function getScanTargetIds() {
  const maps = (currentSummary && currentSummary.maps) || [];
  const terms = getDomainFilterTerms();
  return maps
    .filter((item) => matchesDomainFilter(item, terms))
    .map((item) => item.id);
}

function updateScanButtonState() {
  if (scanInProgress) {
    return;
  }

  const terms = getDomainFilterTerms();
  const filterActive = terms.length > 0;
  const matchCount = getScanTargetIds().length;
  const disable = filterActive && matchCount === 0;

  scanBtn.disabled = disable;
  scanBtn.title = disable
    ? "No source maps match this domain filter"
    : filterActive
      ? `Search the ${matchCount} source map${matchCount === 1 ? "" : "s"} matching this domain filter`
      : "Search all discovered source maps for hardcoded data";
}

function updateSearchAllButtonState() {
  const terms = getDomainFilterTerms();
  const filterActive = terms.length > 0;
  const matchCount = getScanTargetIds().length;
  const disable = matchCount < 2;

  searchAllBtn.disabled = disable;
  searchAllBtn.title = disable
    ? filterActive && matchCount === 0
      ? "No source maps match this domain filter"
      : "Searching across source maps needs at least 2 maps; use a single map's “Code search” instead"
    : filterActive
      ? `Search across the ${matchCount} source maps matching this domain filter`
      : `Search across all ${matchCount} discovered source maps`;
}

function updateDownloadAllButtonState() {
  if (downloadAllInProgress) {
    return;
  }

  const terms = getDomainFilterTerms();
  const filterActive = terms.length > 0;
  const matchCount = getScanTargetIds().length;
  const disable = matchCount < 2;

  downloadAllBtn.disabled = disable;
  downloadAllBtn.title = disable
    ? filterActive && matchCount === 0
      ? "No source maps match this domain filter"
      : "Downloading needs at least 2 maps; use a single map's “Download ZIP” instead"
    : filterActive
      ? `Download the ${matchCount} source maps matching this domain filter`
      : `Download all ${matchCount} discovered source maps`;
}

function renderSummary(summary) {
  currentSummary = summary;
  updateScanButtonState();
  updateSearchAllButtonState();
  updateDownloadAllButtonState();
  const maps = summary.maps || [];
  const terms = getDomainFilterTerms();
  const visibleMaps = maps.filter((item) => matchesDomainFilter(item, terms));
  const totalCount = summary.count || maps.length;
  const filterActive = terms.length > 0;

  countEl.textContent = String(filterActive ? visibleMaps.length : totalCount);
  pageUrlEl.textContent = summary.pageUrl || "Current tab";
  subtitleEl.textContent = !extensionEnabled
    ? "Disabled — not scanning new requests"
    : totalCount
      ? filterActive
        ? `Showing ${visibleMaps.length} of ${totalCount} confirmed source maps`
        : "Confirmed source maps found"
      : "No confirmed source maps";
  filterStatusEl.textContent = filterActive
    ? `Filtering by: ${terms.join(", ")}`
    : "Showing all domains.";
  clearFilterBtn.disabled = !filterActive;

  listEl.innerHTML = "";

  if (maps.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent =
      "No confirmed JavaScript source maps detected yet.";
    listEl.hidden = true;
    return;
  }

  if (visibleMaps.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = "No source maps match this domain filter.";
    listEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;

  for (const item of visibleMaps) {
    const card = createElement("article", "card");

    const title = createElement("div", "card-title", item.mapUrl);

    const findings = item.hardcoded || [];
    if (findings.length > 0) {
      title.classList.add("flagged");

      const ruleNames = Array.from(new Set(findings.map((f) => f.ruleName)));
      const note = createElement(
        "span",
        "flag-note",
        "possible hardcoded data",
      );
      note.title = `Matched: ${ruleNames.join(", ")}`;
      title.appendChild(note);
    }

    card.appendChild(title);

    const meta = createElement("div", "meta");

    meta.appendChild(
      createElement("span", "", `version: ${text(item.version)}`),
    );

    meta.appendChild(
      createElement(
        "span",
        "",
        `sources: ${item.embeddedSourceCount}/${item.sourceCount}`,
      ),
    );

    meta.appendChild(
      createElement("span", "", `map: ${formatBytes(item.rawMapSize)}`),
    );

    meta.appendChild(
      createElement(
        "span",
        "",
        item.hasSourcesContent
          ? "sourcesContent: yes"
          : "sourcesContent: missing",
      ),
    );

    card.appendChild(meta);

    const methods = createElement(
      "div",
      "methods",
      `detected by: ${(item.discoveredBy || []).join(", ") || "unknown"}`,
    );
    card.appendChild(methods);

    if (findings.length > 0) {
      const findingsWrap = createElement("div", "findings");
      findingsWrap.appendChild(
        createElement(
          "div",
          "findings-heading",
          `Hardcoded data in ${findings.length} location${findings.length === 1 ? "" : "s"}:`,
        ),
      );

      for (const finding of findings) {
        const row = createElement("div", "finding");

        row.appendChild(
          createElement("span", "finding-rule", finding.ruleName),
        );

        const location = finding.line
          ? `${finding.sourcePath}:${finding.line}`
          : finding.sourcePath || "unknown file";
        row.appendChild(createElement("span", "finding-loc", location));

        findingsWrap.appendChild(row);
      }

      card.appendChild(findingsWrap);
    }

    const actions = createElement("div", "actions");

    const viewBtn = createElement("button", "primary", "View sources");
    viewBtn.type = "button";
    viewBtn.addEventListener("click", () => {
      const url = browser.runtime.getURL(
        `viewer/viewer.html?tabId=${encodeURIComponent(activeTabId ?? 0)}&mapId=${encodeURIComponent(item.id)}`,
      );

      browser.tabs.create({ url });
    });

    const searchBtn = createElement("button", "", "Code search");
    searchBtn.type = "button";
    searchBtn.disabled = !item.hasSourcesContent;
    searchBtn.title = item.hasSourcesContent
      ? "Search across all reconstructed source files"
      : "This map does not contain embedded sourcesContent";
    searchBtn.addEventListener("click", () => {
      const url = browser.runtime.getURL(
        `search/search.html?tabId=${encodeURIComponent(activeTabId ?? 0)}&mapId=${encodeURIComponent(item.id)}`,
      );

      browser.tabs.create({ url });
    });

    const downloadBtn = createElement("button", "", "Download ZIP");
    downloadBtn.type = "button";
    downloadBtn.disabled = !item.hasSourcesContent;
    downloadBtn.title = item.hasSourcesContent
      ? "Download reconstructed sources as a ZIP archive"
      : "This map does not contain embedded sourcesContent";

    downloadBtn.addEventListener("click", async () => {
      await downloadMapZip(item.id);
    });

    actions.appendChild(viewBtn);
    actions.appendChild(searchBtn);
    actions.appendChild(downloadBtn);
    card.appendChild(actions);
    listEl.appendChild(card);
  }
}

async function getActiveTabId() {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0] ? tabs[0].id : null;
}

async function loadSummary() {
  activeTabId = await getActiveTabId();

  const response = await browser.runtime.sendMessage({
    type: "getSummary",
  });

  if (!response || !response.ok) {
    throw new Error(
      response && response.error
        ? response.error
        : "Unable to read scan results",
    );
  }

  renderSummary(response.data);
}

async function getFullMap(mapId) {
  const response = await browser.runtime.sendMessage({
    type: "getMap",
    tabId: activeTabId,
    mapId,
  });

  if (!response || !response.ok || !response.data) {
    throw new Error(
      response && response.error ? response.error : "Source map not found",
    );
  }

  return response.data;
}

async function downloadMapZip(mapId) {
  try {
    const response = await browser.runtime.sendMessage({
      type: "downloadMapZip",
      tabId: activeTabId,
      mapId,
    });

    if (!response || !response.ok) {
      throw new Error(
        response && response.error ? response.error : "Download failed",
      );
    }
  } catch (error) {
    console.error(error);
    alert(`Download failed: ${error.message}`);
  }
}

function applyEnabledState(isEnabled) {
  extensionEnabled = isEnabled;
  enabledToggle.checked = isEnabled;
  enabledLabel.textContent = isEnabled ? "On" : "Off";

  if (currentSummary) {
    renderSummary(currentSummary);
  } else if (!isEnabled) {
    subtitleEl.textContent = "Disabled — not scanning new requests";
  }
}

async function loadEnabled() {
  let isEnabled = true;

  try {
    const data = await browser.storage.sync.get(ENABLED_STORAGE_KEY);
    if (typeof data[ENABLED_STORAGE_KEY] === "boolean") {
      isEnabled = data[ENABLED_STORAGE_KEY];
    }
  } catch (error) {
    console.error("Unable to load enabled state:", error);
  }

  applyEnabledState(isEnabled);
  return isEnabled;
}

enabledToggle.addEventListener("change", async () => {
  const next = enabledToggle.checked;
  applyEnabledState(next);

  try {
    await browser.storage.sync.set({ [ENABLED_STORAGE_KEY]: next });
  } catch (error) {
    console.error("Unable to save enabled state:", error);
  }

  if (next) {
    loadSummary().catch(console.error);
  }
});

refreshBtn.addEventListener("click", () => {
  loadSummary().catch((error) => {
    console.error(error);
    subtitleEl.textContent = "Refresh failed";
  });
});

domainFilterEl.addEventListener("input", () => {
  saveDomainFilter();

  if (currentSummary) {
    renderSummary(currentSummary);
  }
});

clearFilterBtn.addEventListener("click", () => {
  domainFilterEl.value = "";
  saveDomainFilter();

  if (currentSummary) {
    renderSummary(currentSummary);
  }

  domainFilterEl.focus();
});

clearBtn.addEventListener("click", async () => {
  await browser.runtime.sendMessage({
    type: "clearAll",
  });

  await loadSummary();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[ENABLED_STORAGE_KEY]) {
    return;
  }

  const next = changes[ENABLED_STORAGE_KEY].newValue;
  if (typeof next === "boolean" && next !== extensionEnabled) {
    applyEnabledState(next);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type !== "sourceMapUpdated") {
    return;
  }

  loadSummary().catch(console.error);
});

scanBtn.addEventListener("click", async () => {
  const filterActive = getDomainFilterTerms().length > 0;
  const mapIds = filterActive ? getScanTargetIds() : undefined;

  if (filterActive && mapIds.length === 0) {
    return;
  }

  scanInProgress = true;
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  scanStatusEl.hidden = false;
  scanStatusEl.textContent = filterActive
    ? `Scanning ${mapIds.length} source map${mapIds.length === 1 ? "" : "s"} matching the domain filter…`
    : "Scanning all discovered source maps…";

  try {
    const response = await browser.runtime.sendMessage({
      type: "scanHardcoded",
      mapIds,
    });

    if (!response || !response.ok) {
      throw new Error(
        response && response.error ? response.error : "Scan failed",
      );
    }

    await loadSummary();

    const data = response.data || {};
    const scanned = data.scannedMaps || 0;
    const scope = filterActive ? " (filtered)" : "";

    scanStatusEl.textContent = data.flaggedMaps
      ? `Flagged ${data.flaggedMaps} of ${scanned} source map${scanned === 1 ? "" : "s"}${scope} (${data.totalFindings} match${data.totalFindings === 1 ? "" : "es"}).`
      : `No hardcoded data found across ${scanned} source map${scanned === 1 ? "" : "s"}${scope}.`;
  } catch (error) {
    console.error(error);
    scanStatusEl.hidden = false;
    scanStatusEl.textContent = `Scan failed: ${error.message}`;
  } finally {
    scanInProgress = false;
    scanBtn.textContent = SCAN_BUTTON_LABEL;
    updateScanButtonState();
  }
});

searchAllBtn.addEventListener("click", () => {
  const targetIds = getScanTargetIds();
  if (targetIds.length < 2) {
    return;
  }

  const filterActive = getDomainFilterTerms().length > 0;
  const params = new URLSearchParams();
  params.set("tabId", String(activeTabId ?? 0));
  params.set("all", "1");

  if (filterActive) {
    params.set("mapIds", targetIds.join(","));
  }

  browser.tabs.create({
    url: browser.runtime.getURL(`search/search.html?${params.toString()}`),
  });
});

downloadAllBtn.addEventListener("click", async () => {
  const targetIds = getScanTargetIds();
  if (targetIds.length < 2) {
    return;
  }

  const filterActive = getDomainFilterTerms().length > 0;

  downloadAllInProgress = true;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = "Downloading…";
  downloadAllStatusEl.hidden = false;
  downloadAllStatusEl.textContent = `Downloading ${targetIds.length} source maps…`;

  try {
    const response = await browser.runtime.sendMessage({
      type: "downloadMapsZip",
      tabId: activeTabId,
      mapIds: targetIds,
    });

    if (!response || !response.ok) {
      throw new Error(
        response && response.error ? response.error : "Download failed",
      );
    }

    const data = response.data || {};
    const total = data.total || targetIds.length;
    const completed = data.completed || 0;
    const failed = data.failed || 0;
    const scope = filterActive ? " (filtered)" : "";

    downloadAllStatusEl.textContent = failed
      ? `Downloaded ${completed} of ${total} source map${total === 1 ? "" : "s"}${scope}; ${failed} failed.`
      : `Downloaded all ${completed} source map${completed === 1 ? "" : "s"}${scope}.`;
  } catch (error) {
    console.error(error);
    downloadAllStatusEl.textContent = `Download failed: ${error.message}`;
  } finally {
    downloadAllInProgress = false;
    downloadAllBtn.textContent = DOWNLOAD_ALL_BUTTON_LABEL;
    updateDownloadAllButtonState();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadEnabled().catch(console.error);

  restoreDomainFilter()
    .then(loadSummary)
    .catch((error) => {
      console.error(error);
      subtitleEl.textContent = "Unable to load scan data";
    });
});