"use strict";

// Self-contained highlight + line-gutter renderer.
// Depends only on a global `Prism` (vendored). No extension APIs, so it can be
// exercised from a standalone test page.
(function () {
  const MAX_HIGHLIGHT_BYTES = 2 * 1024 * 1024; // skip tokenizing beyond this
  const MAX_LINES = 60000; // skip tokenizing past this many lines

  const EXT_TO_LANG = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    jsx: "jsx",
    ts: "typescript", mts: "typescript", cts: "typescript",
    tsx: "tsx",
    json: "json", map: "json",
    css: "css",
    scss: "scss", sass: "scss",
    less: "less",
    html: "markup", htm: "markup", xml: "markup", svg: "markup",
    vue: "markup", svelte: "markup",
  };

  // Normalize whatever the source map reports plus the file extension into a
  // Prism language id. Extension wins because it is the most reliable signal.
  function resolveLang(language, path) {
    const ext = String(path || "").split(/[#?]/)[0].split(".").pop().toLowerCase();

    if (EXT_TO_LANG[ext]) {
      return EXT_TO_LANG[ext];
    }

    const reported = String(language || "").toLowerCase();
    const reportedMap = {
      javascript: "javascript", typescript: "typescript",
      jsx: "jsx", tsx: "tsx", json: "json",
      css: "css", scss: "scss", less: "less",
      html: "markup", xml: "markup",
    };

    if (reportedMap[reported]) {
      return reportedMap[reported];
    }

    return "plain";
  }

  function escapeHtml(input) {
    return String(input)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Split Prism's highlighted HTML into one HTML string per source line while
  // keeping every <span> balanced. Tokens such as block comments and template
  // literals legitimately span multiple lines, so we close all open spans at a
  // newline and re-open them on the next line.
  function splitHighlightedLines(html) {
    const lines = [];
    const open = [];
    let current = "";
    let i = 0;

    const flush = () => {
      let line = current;
      for (let k = open.length - 1; k >= 0; k--) {
        line += "</span>";
      }
      lines.push(line);
      current = open.join("");
    };

    while (i < html.length) {
      const ch = html[i];

      if (ch === "<") {
        const end = html.indexOf(">", i);
        if (end === -1) {
          current += html.slice(i);
          break;
        }
        const tag = html.slice(i, end + 1);
        if (tag[1] === "/") {
          open.pop();
        } else if (tag[tag.length - 2] !== "/") {
          open.push(tag);
        }
        current += tag;
        i = end + 1;
      } else if (ch === "\n") {
        flush();
        i += 1;
      } else {
        let next = i;
        while (next < html.length && html[next] !== "<" && html[next] !== "\n") {
          next += 1;
        }
        current += html.slice(i, next);
        i = next;
      }
    }

    flush();
    return lines;
  }

  function prettyJson(source) {
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      return source;
    }
  }

  function buildRows(lineHtmls) {
    const rows = new Array(lineHtmls.length);

    for (let n = 0; n < lineHtmls.length; n++) {
      rows[n] =
        `<div class="code-row" data-line="${n + 1}">` +
        `<span class="ln" aria-hidden="true">${n + 1}</span>` +
        `<span class="lc">${lineHtmls[n] || ""}</span>` +
        `</div>`;
    }

    return rows.join("");
  }

  // Render `content` into `codeEl` (a scroll container) as numbered, highlighted
  // rows. Returns the line count. Falls back to plain escaped text when the file
  // is too large to tokenize or the language is unknown.
  function render(codeEl, content, language, path) {
    let text = String(content == null ? "" : content).replace(/\r\n?/g, "\n");
    const lang = resolveLang(language, path);

    if (lang === "json") {
      text = prettyJson(text);
    }

    const lineCount = text.length === 0 ? 1 : text.split("\n").length;
    const grammar =
      typeof Prism !== "undefined" && Prism.languages ? Prism.languages[lang] : null;

    const tooBig = text.length > MAX_HIGHLIGHT_BYTES || lineCount > MAX_LINES;
    const html =
      grammar && !tooBig ? Prism.highlight(text, grammar, lang) : escapeHtml(text);

    const lineHtmls = splitHighlightedLines(html);

    codeEl.classList.add("code-view");
    codeEl.dataset.lang = lang;
    codeEl.dataset.highlighted = grammar && !tooBig ? "1" : "0";
    codeEl.innerHTML = `<div class="code-rows">${buildRows(lineHtmls)}</div>`;

    return lineCount;
  }

  function renderMessage(codeEl, message) {
    codeEl.classList.add("code-view");
    codeEl.dataset.highlighted = "0";
    codeEl.innerHTML = `<div class="code-message">${escapeHtml(message)}</div>`;
  }

  // Highlight the row matching `line` (1-based). Pass 0/undefined to clear.
  function setActiveLine(codeEl, line) {
    const previous = codeEl.querySelector(".code-row.active");
    if (previous) {
      previous.classList.remove("active");
    }

    if (!line) {
      return null;
    }

    const row = codeEl.querySelector(`.code-row[data-line="${line}"]`);
    if (row) {
      row.classList.add("active");
    }
    return row;
  }

  window.SourceMapHunterHighlight = {
    resolveLang,
    escapeHtml,
    splitHighlightedLines,
    render,
    renderMessage,
    setActiveLine,
  };
})();
