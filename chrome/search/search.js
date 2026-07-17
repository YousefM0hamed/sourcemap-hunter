"use strict";

let tabId = null;
let mapId = null;
let mapIds = [];
let allMode = false;
let record = null;
let sources = [];

const mapUrlEl = document.getElementById("mapUrl");
const searchInputEl = document.getElementById("searchInput");
const regexToggleEl = document.getElementById("regexToggle");
const runSearchBtn = document.getElementById("runSearch");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

function getParams() {
  const params = new URLSearchParams(location.search);

  tabId = Number(params.get("tabId"));
  mapId = params.get("mapId");
  allMode = params.get("all") === "1";

  const idsParam = params.get("mapIds");
  mapIds = idsParam ? idsParam.split(",").filter(Boolean) : [];

  if (!Number.isFinite(tabId) || (!mapId && !allMode)) {
    throw new Error("Missing tabId or mapId");
  }
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

function renderEmpty(message) {
  resultsEl.innerHTML = "";
  resultsEl.appendChild(createElement("div", "empty", message));
}

function groupFindingsByFile(findings) {
  const groups = new Map();

  for (const finding of findings) {
    const path = finding.sourcePath || "unknown source";

    if (!groups.has(path)) {
      groups.set(path, { path, findings: [] });
    }

    groups.get(path).findings.push(finding);
  }

  return Array.from(groups.values());
}

function renderMatch(finding) {
  const item = createElement("div", "result-match-item");

  item.appendChild(
    createElement("div", "result-rule", finding.ruleName || "Search match"),
  );

  item.appendChild(
    createElement(
      "div",
      "result-source",
      `${finding.sourcePath || "unknown source"}:${finding.line || 1}:${finding.column || 1}`,
    ),
  );

  item.appendChild(
    createElement("pre", "result-match", finding.context || finding.match || ""),
  );

  return item;
}

function renderFileGroup(group) {
  const details = createElement("details", "result-group");
  const summary = createElement("summary", "result-group-header");

  summary.appendChild(createElement("span", "result-file-name", group.path));
  summary.appendChild(
    createElement(
      "span",
      "result-group-count",
      `${group.findings.length} match${group.findings.length === 1 ? "" : "es"}`,
    ),
  );

  details.appendChild(summary);

  const body = createElement("div", "result-group-body");

  for (const finding of group.findings) {
    body.appendChild(renderMatch(finding));
  }

  details.appendChild(body);

  return details;
}

function renderResults(result) {
  const findings = result.findings || [];
  const stats = result.stats || {};

  resultsEl.innerHTML = "";

  if (findings.length === 0) {
    statusEl.textContent = `0 matches across ${stats.searchedFiles || sources.length} files.`;
    renderEmpty("No matches found.");
    return;
  }

  const groups = groupFindingsByFile(findings);

  statusEl.textContent = `${findings.length} match${findings.length === 1 ? "" : "es"} across ${groups.length} file${groups.length === 1 ? "" : "s"} (of ${stats.searchedFiles || sources.length} searched)${stats.truncated ? " (result limit reached)" : ""}.`;

  for (const group of groups) {
    resultsEl.appendChild(renderFileGroup(group));
  }
}

function runSearch() {
  const query = searchInputEl.value;

  if (!query) {
    statusEl.textContent = idleStatusText();
    resultsEl.innerHTML = "";
    return;
  }

  try {
    const result = globalThis.SourceMapHunterCodeSearch.searchSources(sources, query, {
      regex: regexToggleEl.checked,
      caseSensitive: false,
      mapUrl: allMode ? "" : (record ? record.mapUrl : ""),
      maxResults: 1000,
    });

    renderResults(result);
  } catch (error) {
    statusEl.textContent = `Search failed: ${error.message}`;
    resultsEl.innerHTML = "";
  }
}

let searchedMapCount = 0;

function idleStatusText() {
  const fileWord = sources.length === 1 ? "" : "s";

  if (allMode) {
    const mapWord = searchedMapCount === 1 ? "" : "s";
    return `Search runs across all ${sources.length} recovered file${fileWord} in ${searchedMapCount} source map${mapWord}.`;
  }

  return `Search runs across all ${sources.length} recovered file${fileWord} in this source map.`;
}

function onNoSearchableSources(message) {
  searchInputEl.disabled = true;
  regexToggleEl.disabled = true;
  runSearchBtn.disabled = true;
  statusEl.textContent = "No embedded sourcesContent files to search.";
  renderEmpty(message);
}

async function loadSingleRecord() {
  const response = await browser.runtime.sendMessage({
    type: "getMap",
    tabId,
    mapId,
  });

  if (!response || !response.ok || !response.data) {
    throw new Error(
      response && response.error ? response.error : "Source map not found",
    );
  }

  record = response.data;
  sources = (record.sources || []).filter((source) => source.available);

  mapUrlEl.textContent = record.mapUrl || "Unknown source map";
  document.title = `Source Map Hunter Code Search - ${record.displayUrl || record.mapUrl || "source map"}`;

  if (sources.length === 0) {
    onNoSearchableSources(
      "This source map is valid, but it does not contain embedded sourcesContent.",
    );
    return;
  }

  statusEl.textContent = idleStatusText();
  searchInputEl.focus();
}

async function loadAllRecords() {
  const response = await browser.runtime.sendMessage({
    type: "getMaps",
    tabId,
    mapIds,
  });

  if (!response || !response.ok || !Array.isArray(response.data)) {
    throw new Error(
      response && response.error ? response.error : "Source maps not found",
    );
  }

  const records = response.data;

  sources = [];
  searchedMapCount = 0;

  for (const rec of records) {
    const available = (rec.sources || []).filter((source) => source.available);

    if (available.length === 0) {
      continue;
    }

    searchedMapCount += 1;
    const origin = rec.displayUrl || rec.mapUrl || "source map";

    for (const source of available) {
      sources.push({
        ...source,
        path: `${origin} › ${source.path}`,
      });
    }
  }

  mapUrlEl.textContent = `Searching ${searchedMapCount} source map${searchedMapCount === 1 ? "" : "s"}`;
  document.title = "Source Map Hunter Code Search - all source maps";

  if (sources.length === 0) {
    onNoSearchableSources(
      "None of the selected source maps contain embedded sourcesContent to search.",
    );
    return;
  }

  statusEl.textContent = idleStatusText();
  searchInputEl.focus();
}

function loadRecord() {
  return allMode ? loadAllRecords() : loadSingleRecord();
}

runSearchBtn.addEventListener("click", runSearch);

searchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runSearch();
  }
});

regexToggleEl.addEventListener("change", () => {
  if (searchInputEl.value) {
    runSearch();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  try {
    getParams();
    loadRecord().catch((error) => {
      console.error(error);
      mapUrlEl.textContent = error.message;
      renderEmpty(error.message);
    });
  } catch (error) {
    console.error(error);
    mapUrlEl.textContent = error.message;
    renderEmpty(error.message);
  }
});