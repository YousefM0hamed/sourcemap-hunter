"use strict";

/*
  Pure URL / source-map candidate / directive utilities.

  Extracted from background.js so the same logic is exercised by unit tests
  without a WebExtension runtime. No WebExtension API calls live here.
*/

(function exposeUrlUtils() {
  const SOURCE_MAP_HEADER_NAMES = new Set([
    "sourcemap",
    "x-sourcemap",
    "source-map",
    "sourcemappingurl",
  ]);

  const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];
  const MAP_EXTENSIONS = [".js.map", ".mjs.map", ".cjs.map"];

  function safeUrl(urlString) {
    try {
      return new URL(urlString);
    } catch {
      return null;
    }
  }

  function isBrowserInternalUrl(urlString) {
    try {
      const url = new URL(urlString);
      const scheme = url.protocol.toLowerCase();
      // chrome://, chrome-extension://, devtools://, edge://, about:,
      // chrome-search://, chrome-untrusted://, view-source: are browser
      // internal. We deliberately skip scanning these to avoid interfering
      // with browser UI pages (and because extension injection is blocked
      // there anyway).
      return (
        scheme === "chrome:" ||
        scheme === "chrome-extension:" ||
        scheme === "devtools:" ||
        scheme === "edge:" ||
        scheme === "about:" ||
        scheme === "chrome-search:" ||
        scheme === "chrome-untrusted:" ||
        scheme === "view-source:" ||
        scheme === "moz-extension:" ||
        scheme === "moz:" ||
        scheme === "resource:"
      );
    } catch {
      return false;
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

  // Regex matches both line-comment and block-comment sourceMappingURL
  // directives. Capture group 1 = line-comment reference, group 2 =
  // block-comment reference. The `s`-free `gi` flags keep [^*]+? anchored to
  // single-line-ish runs (a block comment reference typically fits on one
  // line; pathological multi-line cases still resolve through URL()).
  const SOURCE_MAPPING_REGEX =
    /(?:\/\/[@#]\s*sourceMappingURL\s*=\s*([^\s"'<>]+)|\/\*[@#]\s*sourceMappingURL\s*=\s*([^*]+?)\s*\*\/)/gi;

  function extractSourceMappingComments(scriptTail) {
    const references = new Set();
    let match;

    SOURCE_MAPPING_REGEX.lastIndex = 0;
    while ((match = SOURCE_MAPPING_REGEX.exec(scriptTail)) !== null) {
      const reference = normalizeHeaderValue(match[1] || match[2] || "");
      if (reference) {
        references.add(reference);
      }
    }

    return Array.from(references);
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

  globalThis.SourceMapHunterUrlUtils = {
    SOURCE_MAP_HEADER_NAMES,
    JS_EXTENSIONS,
    MAP_EXTENSIONS,
    safeUrl,
    isBrowserInternalUrl,
    pathEndsWithAny,
    looksLikeJavaScriptFile,
    looksLikeSourceMapFile,
    isSuccessfulStatus,
    normalizeHeaderValue,
    getSourceMapHeader,
    resolveReference,
    guessMapUrls,
    extractSourceMappingComments,
    summarizeMapUrl,
  };
})();