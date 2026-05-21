"use strict";

let tabId = null;
let mapId = null;
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

  if (!Number.isFinite(tabId) || !mapId) {
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
    statusEl.textContent = `Search runs across all ${sources.length} recovered file${sources.length === 1 ? "" : "s"} in this source map.`;
    resultsEl.innerHTML = "";
    return;
  }

  try {
    const result = globalThis.SourceMapHunterCodeSearch.searchSources(sources, query, {
      regex: regexToggleEl.checked,
      caseSensitive: false,
      mapUrl: record ? record.mapUrl : "",
      maxResults: 1000,
    });

    renderResults(result);
  } catch (error) {
    statusEl.textContent = `Search failed: ${error.message}`;
    resultsEl.innerHTML = "";
  }
}

async function loadRecord() {
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
    searchInputEl.disabled = true;
    regexToggleEl.disabled = true;
    runSearchBtn.disabled = true;
    statusEl.textContent = "No embedded sourcesContent files to search.";
    renderEmpty("This source map is valid, but it does not contain embedded sourcesContent.");
    return;
  }

  statusEl.textContent = `Search runs across all ${sources.length} recovered file${sources.length === 1 ? "" : "s"} in this source map.`;
  searchInputEl.focus();
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
