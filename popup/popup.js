"use strict";

let activeTabId = null;
let currentSummary = null;
let extensionEnabled = true;

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
const SCAN_BUTTON_LABEL = "Search source maps for hardcoded data";
const DOMAIN_FILTER_STORAGE_KEY = "popupDomainFilter";

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

function renderSummary(summary) {
  currentSummary = summary;
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

        if (finding.evidence) {
          row.appendChild(
            createElement("code", "finding-evidence", finding.evidence),
          );
        }

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

  // The switch gates only the background detection/fetching pipeline. Viewing
  // and locally re-scanning already-collected maps stays available, so the
  // disabled state is surfaced in the subtitle rather than locking controls.
  // Re-render so the subtitle reflects the current state immediately.
  if (currentSummary) {
    renderSummary(currentSummary);
  } else if (!isEnabled) {
    subtitleEl.textContent = "Disabled — not scanning new requests";
  }
}

async function loadEnabled() {
  const response = await browser.runtime.sendMessage({ type: "getEnabled" });
  const isEnabled = !response || response.enabled !== false;
  applyEnabledState(isEnabled);
  return isEnabled;
}

enabledToggle.addEventListener("change", async () => {
  const next = enabledToggle.checked;
  applyEnabledState(next);

  try {
    await browser.runtime.sendMessage({ type: "setEnabled", enabled: next });
  } catch (error) {
    console.error("Unable to update enabled state:", error);
  }

  if (next) {
    // Re-enabling: refresh so the subtitle/counts reflect current data.
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

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "enabledChanged") {
    applyEnabledState(message.enabled !== false);
    return;
  }

  if (message.type !== "sourceMapUpdated") {
    return;
  }

  loadSummary().catch(console.error);
});

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  scanStatusEl.hidden = false;
  scanStatusEl.textContent = "Scanning all discovered source maps…";

  try {
    const response = await browser.runtime.sendMessage({
      type: "scanHardcoded",
    });

    if (!response || !response.ok) {
      throw new Error(
        response && response.error ? response.error : "Scan failed",
      );
    }

    await loadSummary();

    const data = response.data || {};
    const scanned = data.scannedMaps || 0;

    scanStatusEl.textContent = data.flaggedMaps
      ? `Flagged ${data.flaggedMaps} of ${scanned} source map${scanned === 1 ? "" : "s"} (${data.totalFindings} match${data.totalFindings === 1 ? "" : "es"}).`
      : `No hardcoded data found across ${scanned} source map${scanned === 1 ? "" : "s"}.`;
  } catch (error) {
    console.error(error);
    scanStatusEl.hidden = false;
    scanStatusEl.textContent = `Scan failed: ${error.message}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = SCAN_BUTTON_LABEL;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // Load the enabled state first so the switch reflects the real state
  // immediately, before the slower summary round-trip resolves.
  loadEnabled().catch(console.error);

  restoreDomainFilter()
    .then(loadSummary)
    .catch((error) => {
      console.error(error);
      subtitleEl.textContent = "Unable to load scan data";
    });
});
