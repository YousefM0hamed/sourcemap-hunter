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
    .replace(/>/g, "&gt;");
}

function tokenSpan(className, value) {
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function highlightJsLike(source) {
  const keywords = new Set([
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "null",
    "of",
    "return",
    "set",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]);

  const regex =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;

  let output = "";
  let cursor = 0;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const token = match[0];

    output += escapeHtml(source.slice(cursor, match.index));

    if (token.startsWith("//") || token.startsWith("/*")) {
      output += tokenSpan("tok-comment", token);
    } else if (
      token.startsWith('"') ||
      token.startsWith("'") ||
      token.startsWith("`")
    ) {
      output += tokenSpan("tok-string", token);
    } else if (/^\d/.test(token)) {
      output += tokenSpan("tok-number", token);
    } else if (keywords.has(token)) {
      output += tokenSpan("tok-keyword", token);
    } else {
      output += escapeHtml(token);
    }

    cursor = match.index + token.length;
  }

  output += escapeHtml(source.slice(cursor));
  return output;
}

function highlightJson(source) {
  try {
    source = JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    // Keep original.
  }

  return highlightJsLike(source);
}

function highlightSource(source, language) {
  if (["javascript", "typescript", "jsx", "json"].includes(language)) {
    return language === "json"
      ? highlightJson(source)
      : highlightJsLike(source);
  }

  return escapeHtml(source);
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
  currentMetaEl.textContent = `${source.language} · ${formatBytes(source.size)}`;

  codeEl.innerHTML = `<code>${highlightSource(source.content || "", source.language)}</code>`;

  renderFileList();
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
  document.title = `Source Map Hunter - ${record.displayUrl || record.mapUrl || "source map"}`;

  if (sources.length === 0) {
    currentPathEl.textContent = "No embedded sourcesContent";
    currentMetaEl.textContent = "";
    codeEl.innerHTML =
      "<code>This source map is valid, but it does not contain embedded sourcesContent.</code>";
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

  const safePath = window.SourceMapHunterZip.sanitizePath(
    source.path,
    `source-${source.index + 1}.js`,
  );
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
      codeEl.innerHTML = `<code>${escapeHtml(error.message)}</code>`;
    });
  } catch (error) {
    console.error(error);
    mapUrlEl.textContent = error.message;
    codeEl.innerHTML = `<code>${escapeHtml(error.message)}</code>`;
  }
});
