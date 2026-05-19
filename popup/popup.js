"use strict";

let activeTabId = null;
let currentSummary = null;

const countEl = document.getElementById("count");
const pageUrlEl = document.getElementById("pageUrl");
const subtitleEl = document.getElementById("subtitle");
const emptyEl = document.getElementById("empty");
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refresh");
const clearBtn = document.getElementById("clear");
const domainFilterEl = document.getElementById("domainFilter");
const clearFilterBtn = document.getElementById("clearFilter");
const filterStatusEl = document.getElementById("filterStatus");

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
  subtitleEl.textContent = totalCount
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
      "No confirmed JavaScript source maps detected on this tab.";
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

    const actions = createElement("div", "actions");

    const viewBtn = createElement("button", "primary", "View sources");
    viewBtn.type = "button";
    viewBtn.addEventListener("click", () => {
      const url = browser.runtime.getURL(
        `viewer/viewer.html?tabId=${encodeURIComponent(activeTabId)}&mapId=${encodeURIComponent(item.id)}`,
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

  if (activeTabId == null) {
    renderSummary({
      count: 0,
      pageUrl: "",
      maps: [],
    });
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: "getTabSummary",
    tabId: activeTabId,
  });

  if (!response || !response.ok) {
    throw new Error(
      response && response.error
        ? response.error
        : "Unable to read tab summary",
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
    const record = await getFullMap(mapId);
    await window.SourceMapHunterZip.downloadMapAsZip(record);
  } catch (error) {
    console.error(error);
    alert(`Download failed: ${error.message}`);
  }
}

refreshBtn.addEventListener("click", () => {
  loadSummary().catch((error) => {
    console.error(error);
    subtitleEl.textContent = "Refresh failed";
  });
});

domainFilterEl.addEventListener("input", () => {
  if (currentSummary) {
    renderSummary(currentSummary);
  }
});

clearFilterBtn.addEventListener("click", () => {
  domainFilterEl.value = "";

  if (currentSummary) {
    renderSummary(currentSummary);
  }

  domainFilterEl.focus();
});

clearBtn.addEventListener("click", async () => {
  if (activeTabId == null) {
    return;
  }

  await browser.runtime.sendMessage({
    type: "clearTab",
    tabId: activeTabId,
  });

  await loadSummary();
});

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "sourceMapUpdated") {
    return;
  }

  if (message.tabId === activeTabId) {
    loadSummary().catch(console.error);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadSummary().catch((error) => {
    console.error(error);
    subtitleEl.textContent = "Unable to load scan data";
  });
});
