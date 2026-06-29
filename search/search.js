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

  // "all" mode searches across every map in the popup's current view. An
  // optional mapIds list scopes it to the domain-filtered subset; when absent,
  // the background returns every discovered map.
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

function renderResults(result) {
  const findings = result.findings || [];
  const stats = result.stats || {};

  resultsEl.innerHTML = "";

  if (findings.length === 0) {
    statusEl.textContent = `0 matches across ${stats.searchedFiles || sources.length} files.`;
    renderEmpty("No matches found.");
    return;
  }

  statusEl.textContent = `${findings.length} match${findings.length === 1 ? "" : "es"} across ${stats.searchedFiles || sources.length} files${stats.truncated ? " (result limit reached)" : ""}.`;

  for (const finding of findings) {
    const card = createElement("article", "result-card");

    card.appendChild(
      createElement("div", "result-rule", finding.ruleName || "Search match"),
    );

    card.appendChild(
      createElement(
        "div",
        "result-source",
        `${finding.sourcePath || "unknown source"}:${finding.line || 1}:${finding.column || 1}`,
      ),
    );

    card.appendChild(
      createElement("pre", "result-match", finding.context || finding.match || ""),
    );

    resultsEl.appendChild(card);
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

// Tracks how many maps contributed searchable files, so status copy can say
// "across N files in M source maps" in all-maps mode.
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
    // Empty array means "every discovered map" (background treats it the same
    // as an absent list); a populated list is the domain-filtered subset.
    mapIds,
  });

  if (!response || !response.ok || !Array.isArray(response.data)) {
    throw new Error(
      response && response.error ? response.error : "Source maps not found",
    );
  }

  const records = response.data;

  // Flatten every map's recovered files into one searchable list. Each file's
  // path is prefixed with its origin map so results stay traceable to the map
  // they came from once findings from different maps are interleaved.
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
