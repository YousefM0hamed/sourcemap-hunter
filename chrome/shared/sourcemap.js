"use strict";

/*
  Pure source-map validation + extraction utilities.

  Extracted from background.js. No WebExtension API calls.

  Handles:
  - JSON parsing with defensive guards (size limit, prefix stripping).
  - Structural validation (version, sources, mappings, sourcesContent).
  - Indexed source maps (sections) — recognized but not deeply expanded
    (matches the original behavior, which only consumed flat maps).
  - Reconstructed source extraction with path sanitization for display.
*/

(function exposeSourceMap() {
  const MAX_PARSE_BYTES = 64 * 1024 * 1024;

  function stableId(input) {
    let hash = 2166136261;

    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return `m_${(hash >>> 0).toString(36)}`;
  }

  function stripJsonPrefix(text) {
    let cleaned = String(text || "")
      .replace(/^\uFEFF/, "")
      .trimStart();

    if (cleaned.startsWith(")]}'")) {
      const newline = cleaned.indexOf("\n");
      cleaned =
        newline >= 0
          ? cleaned.slice(newline + 1).trimStart()
          : cleaned.slice(4).trimStart();
    }

    return cleaned;
  }

  function parseDataUrl(dataUrl) {
    const match = /^data:([^,]*?),(.*)$/is.exec(dataUrl);
    if (!match) {
      throw new Error("Invalid data URL");
    }

    const metadata = match[1] || "";
    const body = match[2] || "";

    if (/;base64/i.test(metadata)) {
      const binary = atob(body.replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      return new TextDecoder("utf-8").decode(bytes);
    }

    return decodeURIComponent(body);
  }

  function isValidSourceMapObject(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        Object.prototype.hasOwnProperty.call(value, "version") &&
        (typeof value.version === "number" ||
          typeof value.version === "string") &&
        Array.isArray(value.sources) &&
        Object.prototype.hasOwnProperty.call(value, "mappings") &&
        typeof value.mappings === "string",
    );
  }

  // Indexed source maps use `sections` instead of `sources`/`mappings`.
  // We recognize the shape (so callers can label it) but do not expand it;
  // the original Firefox extension did the same. Returns true if the value
  // looks like an indexed map envelope.
  function isIndexedSourceMap(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        Array.isArray(value.sections) &&
        typeof value.version !== "undefined",
    );
  }

  // A structurally-valid map can still be a useless placeholder — e.g. the
  // Closure Compiler emits an inline data: map like
  //   {"version":3,"sources":[""],"sourcesContent":[" "],"names":["closureDynamicButton"],"mappings":"AAAA;..."}
  // when a script has no recoverable source. Confirming these produces empty
  // viewer output and an empty reconstructed-source ZIP, which is pure noise
  // (the user opened google.com and saw a "source map" with nothing in it).
  //
  // isMeaningfulSourceMap rejects maps that have NO recoverable content:
  //   - zero non-empty source paths, AND
  //   - zero non-empty sourcesContent entries.
  // A valid map with real sources but no sourcesContent still passes (it is
  // reported as "confirmed, no embedded sourcesContent" per the original).
  // A valid map with sourcesContent but no sources is treated as meaningful.
  function isMeaningfulSourceMap(value) {
    if (!value || typeof value !== "object") return false;

    const sources = Array.isArray(value.sources) ? value.sources : [];
    const contents = Array.isArray(value.sourcesContent) ? value.sourcesContent : [];

    const nonEmptySources = sources.filter(
      (s) => s != null && String(s).trim().length > 0,
    ).length;

    const nonEmptyContents = contents.filter(
      (c) => typeof c === "string" && c.trim().length > 0,
    ).length;

    // Closure-style empty placeholder: every source is empty/blank and every
    // sourcesContent entry is blank. Nothing to reconstruct -> reject.
    if (nonEmptySources === 0 && nonEmptyContents === 0) {
      return false;
    }

    return true;
  }

  function combineSourcePath(sourceRoot, source, index) {
    const fallback = `source-${index + 1}.js`;
    const sourceText = source ? String(source) : fallback;

    if (!sourceRoot) {
      return sourceText;
    }

    // Absolute URL-like sources win over sourceRoot.
    if (/^[a-z][a-z0-9+.-]*:/i.test(sourceText)) {
      return sourceText;
    }

    return `${String(sourceRoot).replace(/\/?$/, "/")}${sourceText.replace(/^\/+/, "")}`;
  }

  function languageFromPath(path) {
    const lower = String(path || "").toLowerCase();

    if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
    if (lower.endsWith(".jsx")) return "jsx";
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs"))
      return "javascript";
    if (lower.endsWith(".json")) return "json";
    if (
      lower.endsWith(".css") ||
      lower.endsWith(".scss") ||
      lower.endsWith(".sass") ||
      lower.endsWith(".less")
    )
      return "css";
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
    if (lower.endsWith(".vue")) return "vue";
    if (lower.endsWith(".svelte")) return "svelte";

    return "text";
  }

  function extractSources(mapObject) {
    const sources = Array.isArray(mapObject.sources) ? mapObject.sources : [];
    const contents = Array.isArray(mapObject.sourcesContent)
      ? mapObject.sourcesContent
      : [];

    return sources.map((source, index) => {
      const content = contents[index];
      const available = typeof content === "string";
      const path = combineSourcePath(mapObject.sourceRoot || "", source, index);

      return {
        index,
        path,
        language: languageFromPath(path),
        available,
        size: available ? content.length : 0,
        content: available ? content : "",
      };
    });
  }

  // Defensive JSON.parse: reject oversized input before allocation and surface
  // a typed error the caller can branch on. Returns the parsed object plus the
  // raw text length so callers can record rawMapSize.
  function parseSourceMapText(text, { maxBytes = MAX_PARSE_BYTES } = {}) {
    const cleaned = stripJsonPrefix(text);

    if (cleaned.length > maxBytes) {
      const err = new Error("Source map exceeds maximum parse size");
      err.code = "too_large";
      throw err;
    }

    const parsed = JSON.parse(cleaned);
    return { mapObject: parsed, rawSize: text.length };
  }

  globalThis.SourceMapHunterSourceMap = {
    MAX_PARSE_BYTES,
    stableId,
    stripJsonPrefix,
    parseDataUrl,
    isValidSourceMapObject,
    isMeaningfulSourceMap,
    isIndexedSourceMap,
    combineSourcePath,
    languageFromPath,
    extractSources,
    parseSourceMapText,
  };
})();