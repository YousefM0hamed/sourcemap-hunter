"use strict";

let tabId = null;
let mapId = null;
let record = null;
let sources = [];
let selectedIndex = -1;

const mapUrlEl = document.getElementById("mapUrl");
const fileListEl = document.getElementById("fileList");
const filterEl = document.getElementById("filter");
const statsEl = document.getElementById("stats");
const currentPathEl = document.getElementById("currentPath");
const currentMetaEl = document.getElementById("currentMeta");
const codeEl = document.getElementById("code");
const downloadCurrentBtn = document.getElementById("downloadCurrent");
const downloadZipBtn = document.getElementById("downloadZip");

function getParams() {
  const params = new URLSearchParams(location.search);

  tabId = Number(params.get("tabId"));
  mapId = params.get("mapId");

  if (!Number.isFinite(tabId) || !mapId) {
    throw new Error("Missing tabId or mapId");
  }

  if (params.get("mode") === "search") {
    location.replace(browser.runtime.getURL(
      `search/search.html?tabId=${encodeURIComponent(tabId)}&mapId=${encodeURIComponent(mapId)}`,
    ));
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Files larger than this are shown as plain (still line-numbered) text rather
// than tokenized, to keep the viewer responsive on huge reconstructed bundles.
const MAX_HIGHLIGHT_BYTES = 3 * 1024 * 1024;
const MAX_HIGHLIGHT_LINES = 80000;

const Shiki =
  typeof window !== "undefined" ? window.ShikiHighlighter : undefined;

function prettyJson(source) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

// Build the same <pre class="shiki"><code><span class="line">…</span></code></pre>
// shape Shiki emits, but with escaped, uncolored text. Used for the large-file
// fallback and when Shiki is unavailable, so the line-number gutter and layout
// stay identical to the highlighted path.
function plainCodeHtml(text) {
  const body = text
    .split("\n")
    .map((line) => `<span class="line">${escapeHtml(line)}</span>`)
    .join("\n");
  return `<pre class="shiki shiki-plain" tabindex="0"><code>${body}</code></pre>`;
}

// Render `content` into the code host as a highlighted, line-numbered block.
// Returns the resolved language id actually used (for the meta line).
function renderCode(content, language, path) {
  let text = String(content == null ? "" : content).replace(/\r\n?/g, "\n");
  const lang = Shiki ? Shiki.resolveLang(language, path) : null;

  if (lang === "json") {
    text = prettyJson(text);
  }

  const lineCount = text.length === 0 ? 1 : text.split("\n").length;
  const tooBig =
    text.length > MAX_HIGHLIGHT_BYTES || lineCount > MAX_HIGHLIGHT_LINES;

  let html = null;
  if (Shiki && lang && !tooBig) {
    html = Shiki.codeToHtml(text, lang);
  }

  codeEl.dataset.lang = lang || "plain";
  codeEl.dataset.highlighted = html ? "1" : "0";
  codeEl.innerHTML = html || plainCodeHtml(text);

  return lang || (language || "text");
}

function renderMessage(message) {
  codeEl.dataset.highlighted = "0";
  codeEl.innerHTML = `<div class="code-message">${escapeHtml(message)}</div>`;
}

function renderFileList() {
  const query = filterEl.value.trim().toLowerCase();
  const filtered = sources.filter((source) => {
    if (!source.available) return false;
    if (!query) return true;
    return source.path.toLowerCase().includes(query);
  });

  fileListEl.innerHTML = "";
  statsEl.textContent = `${filtered.length} embedded file${filtered.length === 1 ? "" : "s"}`;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No embedded sourcesContent files match this filter.";
    fileListEl.appendChild(empty);
    return;
  }

  for (const source of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-item";
    button.textContent = source.path;

    if (source.index === selectedIndex) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      selectSource(source.index);
    });

    fileListEl.appendChild(button);
  }
}

function selectSource(index) {
  const source = sources.find((item) => item.index === index);

  if (!source || !source.available) {
    return;
  }

  selectedIndex = index;
  currentPathEl.textContent = source.path;
  const usedLang = renderCode(source.content || "", source.language, source.path);
  currentMetaEl.textContent = `${usedLang} · ${formatBytes(source.size)}`;
  downloadCurrentBtn.disabled = false;

  renderFileList();
}

async function loadRecord() {
  const response = await browser.runtime.sendMessage({
    type: "getMap",
    tabId,
    mapId,
  });

  if (!response || !response.ok || !response.data) {
    throw new Error(response && response.error ? response.error : "Source map not found");
  }

  record = response.data;
  sources = (record.sources || []).filter((source) => source.available);

  mapUrlEl.textContent = record.mapUrl || "Unknown source map";
  document.title = `Source Map Hunter - ${record.displayUrl || record.mapUrl || "source map"}`;

  if (sources.length === 0) {
    currentPathEl.textContent = "No embedded sourcesContent";
    currentMetaEl.textContent = "";
    renderMessage("This source map is valid, but it does not contain embedded sourcesContent.");
    downloadCurrentBtn.disabled = true;
    downloadZipBtn.disabled = false;
  } else {
    selectSource(sources[0].index);
  }

  renderFileList();
}

async function downloadCurrentFile() {
  const source = sources.find((item) => item.index === selectedIndex);

  if (!source) {
    return;
  }

  const safePath = window.SourceMapHunterZip.sanitizePath(source.path, `source-${source.index + 1}.js`);
  const filename = safePath.split("/").pop() || "source.js";

  const blob = new Blob([source.content || ""], {
    type: "text/plain;charset=utf-8",
  });

  await window.SourceMapHunterZip.downloadBlob(blob, filename);
}

async function downloadZip() {
  if (!record) {
    return;
  }

  await window.SourceMapHunterZip.downloadMapAsZip(record);
}

filterEl.addEventListener("input", renderFileList);

downloadCurrentBtn.addEventListener("click", () => {
  downloadCurrentFile().catch((error) => {
    console.error(error);
    alert(`Download failed: ${error.message}`);
  });
});

downloadZipBtn.addEventListener("click", () => {
  downloadZip().catch((error) => {
    console.error(error);
    alert(`Download failed: ${error.message}`);
  });
});

document.addEventListener("DOMContentLoaded", () => {
  try {
    getParams();
    loadRecord().catch((error) => {
      console.error(error);
      mapUrlEl.textContent = error.message;
      renderMessage(error.message);
    });
  } catch (error) {
    console.error(error);
    mapUrlEl.textContent = error.message;
    renderMessage(error.message);
  }
});
