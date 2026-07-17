"use strict";

/*
  Pure in-memory code search (Chrome port).

  Identical to the Firefox original. No WebExtension API calls. Exposed as
  globalThis.SourceMapHunterCodeSearch.searchSources.
*/

(function exposeCodeSearch() {
  const DEFAULT_MAX_RESULTS = 1000;

  function stableId(input) {
    let hash = 2166136261;

    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return `cs_${(hash >>> 0).toString(36)}`;
  }

  function buildLineStarts(text) {
    const starts = [0];

    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) {
        starts.push(i + 1);
      }
    }

    return starts;
  }

  function offsetToLineColumn(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const start = lineStarts[mid];
      const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Infinity;

      if (offset < start) {
        high = mid - 1;
      } else if (offset >= next) {
        low = mid + 1;
      } else {
        return {
          line: mid + 1,
          column: offset - start + 1,
        };
      }
    }

    return {
      line: 1,
      column: offset + 1,
    };
  }

  function normalizeSource(source, index) {
    return {
      index: Number.isFinite(source && source.index) ? source.index : index,
      path: String((source && source.path) || `source-${index + 1}.js`),
      available: Boolean(source && source.available && typeof source.content === "string"),
      content: String((source && source.content) || ""),
    };
  }

  function getLineText(content, lineStarts, lineNumber) {
    const index = lineNumber - 1;
    if (index < 0 || index >= lineStarts.length) {
      return "";
    }

    const start = lineStarts[index];
    const next = index + 1 < lineStarts.length ? lineStarts[index + 1] : content.length;
    return content.slice(start, next).replace(/\r?\n$/, "");
  }

  function buildContext(content, lineStarts, matchLine, before = 5, after = 5) {
    const firstLine = Math.max(1, matchLine - before);
    const lastLine = Math.min(lineStarts.length, matchLine + after);
    const width = String(lastLine).length;
    const rows = [];

    for (let line = firstLine; line <= lastLine; line += 1) {
      const marker = line === matchLine ? ">" : " ";
      rows.push(`${marker} ${String(line).padStart(width, " ")} | ${getLineText(content, lineStarts, line)}`);
    }

    return rows.join("\n");
  }

  function createFinding({ ruleName, source, offset, matchText, lineStarts, mapUrl }) {
    const position = offsetToLineColumn(lineStarts, offset);

    return {
      id: stableId([
        ruleName,
        source.path,
        position.line,
        position.column,
        matchText,
        mapUrl || "",
      ].join("|")),
      ruleName,
      sourcePath: source.path,
      line: position.line,
      column: position.column,
      match: matchText,
      context: buildContext(source.content, lineStarts, position.line, 5, 5),
      mapUrl: mapUrl || "",
    };
  }

  function searchPlainText(sources, query, options) {
    const findings = [];
    const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
    const needle = options.caseSensitive ? query : query.toLowerCase();

    for (const rawSource of sources) {
      if (findings.length >= maxResults) break;

      const source = rawSource;
      const haystack = options.caseSensitive ? source.content : source.content.toLowerCase();
      const lineStarts = buildLineStarts(source.content);
      let offset = 0;

      while (findings.length < maxResults) {
        const index = haystack.indexOf(needle, offset);

        if (index === -1) {
          break;
        }

        findings.push(createFinding({
          ruleName: "Plain text search",
          source,
          offset: index,
          matchText: source.content.slice(index, index + query.length),
          lineStarts,
          mapUrl: options.mapUrl,
        }));

        offset = index + Math.max(query.length, 1);
      }
    }

    return findings;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function makeRegex(query, options) {
    if (options.regex) {
      return new RegExp(query, options.caseSensitive ? "g" : "gi");
    }

    return new RegExp(escapeRegExp(query), options.caseSensitive ? "g" : "gi");
  }

  function searchRegex(sources, query, options) {
    const findings = [];
    const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
    const regex = makeRegex(query, options);

    for (const source of sources) {
      if (findings.length >= maxResults) break;

      const lineStarts = buildLineStarts(source.content);
      let match;

      regex.lastIndex = 0;

      while ((match = regex.exec(source.content)) !== null) {
        if (findings.length >= maxResults) break;

        const matchText = match[0] || "";

        findings.push(createFinding({
          ruleName: options.regex ? "Regex search" : "Plain text search",
          source,
          offset: match.index,
          matchText,
          lineStarts,
          mapUrl: options.mapUrl,
        }));

        if (matchText.length === 0) {
          regex.lastIndex += 1;
        }
      }
    }

    return findings;
  }

  function searchSources(sources, query, options = {}) {
    const cleanQuery = String(query || "");
    const normalizedSources = Array.isArray(sources)
      ? sources.map(normalizeSource).filter((source) => source.available)
      : [];

    if (!cleanQuery) {
      return {
        findings: [],
        stats: {
          total: 0,
          searchedFiles: normalizedSources.length,
          mode: options.regex ? "regex" : "plain",
        },
      };
    }

    const searchOptions = {
      regex: Boolean(options.regex),
      caseSensitive: Boolean(options.caseSensitive),
      maxResults: Number.isFinite(options.maxResults) ? options.maxResults : DEFAULT_MAX_RESULTS,
      mapUrl: options.mapUrl || "",
    };

    const findings = searchOptions.regex
      ? searchRegex(normalizedSources, cleanQuery, searchOptions)
      : searchPlainText(normalizedSources, cleanQuery, searchOptions);

    return {
      findings,
      stats: {
        total: findings.length,
        searchedFiles: normalizedSources.length,
        mode: searchOptions.regex ? "regex" : "plain",
        truncated: findings.length >= searchOptions.maxResults,
      },
    };
  }

  globalThis.SourceMapHunterCodeSearch = {
    searchSources,
  };
})();