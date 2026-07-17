"use strict";

/*
  Safe, dependency-free pretty-printer for minified JavaScript/TypeScript/CSS.

  Why this exists: reconstructed sourcesContent is frequently the *minified*
  bundle text, shown as one giant unreadable line. This module reformats it for
  readability WITHOUT executing or parsing the code as a language — it operates
  purely on the text with a brace-depth tokenizer, so it can never run untrusted
  code. It is intentionally conservative and only triggers when content looks
  minified (few newlines relative to length).

  Limitations (by design): it is a readability formatter, not a real AST
  pretty-printer. It does not handle template-literal contents, regex literals,
  or ASI edge cases perfectly, but it makes minified code readable. It never
  changes semantics (no token is added/removed — only whitespace/newlines).
*/

(function exposeBeautifier() {
  // A file is considered "minified-looking" if it has very few newlines for its
  // size. Threshold: fewer than 1 newline per 200 chars (and at least 500 chars
  // so already-formatted short snippets are left alone).
  function looksMinified(text) {
    if (text.length < 500) return false;
    const newlines = text.split("\n").length - 1;
    return newlines < text.length / 200;
  }

  const INDENT = "  ";

  function beautifyJs(text) {
    let out = "";
    let depth = 0;
    let parenDepth = 0; // track () so for(;;) and call args are not split on ;
    let i = 0;
    const n = text.length;
    let inString = null; // ", ', `
    let inLineComment = false;
    let inBlockComment = false;
    let inRegex = false;
    let prevNonSpace = "";
    let lineStart = true;

    function pushIndent() {
      for (let k = 0; k < depth; k += 1) out += INDENT;
    }

    while (i < n) {
      const ch = text[i];
      const next = text[i + 1];

      // Comments
      if (!inString && !inRegex) {
        if (inLineComment) {
          out += ch;
          if (ch === "\n") { inLineComment = false; lineStart = true; }
          i += 1;
          continue;
        }
        if (inBlockComment) {
          out += ch;
          if (ch === "*" && next === "/") { out += "/"; i += 2; inBlockComment = false; continue; }
          if (ch === "\n") { lineStart = true; }
          i += 1;
          continue;
        }
        if (ch === "/" && next === "/") {
          inLineComment = true;
          out += ch;
          i += 1;
          continue;
        }
        if (ch === "/" && next === "*") {
          inBlockComment = true;
          out += ch;
          i += 1;
          continue;
        }
      }

      // Strings
      if (inString) {
        out += ch;
        if (ch === "\\") { out += next || ""; i += 2; continue; }
        if (ch === inString) { inString = null; }
        prevNonSpace = ch;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        out += ch;
        prevNonSpace = ch;
        i += 1;
        continue;
      }

      // Regex heuristics: a "/" that follows an operator/keyword/start is a
      // regex literal divider, not division. This is approximate but safe (it
      // only affects where we *don't* break lines; it can't change code).
      if (ch === "/" && !inRegex) {
        if (/[=(,;:!&|?{}\[\]<>+\-*%^~]/i.test(prevNonSpace) || prevNonSpace === "" || /\breturn|\bcase|\btypeof|\binstanceof|\bin|\bof|\bnew|\bdelete|\bvoid|\byield|\bawait$/.test(out.slice(-12))) {
          inRegex = true;
          out += ch;
          prevNonSpace = ch;
          i += 1;
          continue;
        }
      }
      if (inRegex) {
        out += ch;
        if (ch === "\\") { out += next || ""; i += 2; continue; }
        if (ch === "/") { inRegex = false; prevNonSpace = ch; i += 1; continue; }
        if (ch === "[") {
          // inside character class, skip until ]
          i += 1;
          while (i < n && text[i] !== "]") {
            out += text[i];
            if (text[i] === "\\") { out += text[i + 1] || ""; i += 2; continue; }
            i += 1;
          }
          if (i < n) { out += "]"; i += 1; }
          continue;
        }
        prevNonSpace = ch;
        i += 1;
        continue;
      }

      // Paren tracking — do not break on ; or , inside () so for(;;) and
      // argument lists stay on one line. Also handle [] for array literals.
      if (ch === "(") { parenDepth += 1; out += ch; prevNonSpace = ch; i += 1; continue; }
      if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); out += ch; prevNonSpace = ch; i += 1; continue; }

      // Brace / structure handling
      if (ch === "{") {
        out += ch;
        depth += 1;
        if (next !== "}" && next !== ";") {
          out += "\n";
          lineStart = true;
        }
        prevNonSpace = ch;
        i += 1;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        // trim trailing space on the line before closing brace
        out = out.replace(/[ \t]*$/, "");
        if (!out.endsWith("\n")) out += "\n";
        pushIndent();
        out += "}";
        prevNonSpace = ch;
        if (next === ")" || next === "," || next === ";" || next === "." || next === "]" || next === "}" || next === "") {
          // keep on same line
        } else if (next !== ";") {
          out += "\n";
          lineStart = true;
        }
        i += 1;
        continue;
      }
      if (ch === ";") {
        out += ";";
        // Only break into a new line at statement level (not inside parens, so
        // for(let i=0;i<10;i++) stays together). Avoid breaking right before }.
        if (parenDepth === 0 && next !== "}" && next !== "" && next !== " " && next !== "\n" && next !== ")") {
          out += "\n";
          lineStart = true;
        }
        prevNonSpace = ch;
        i += 1;
        continue;
      }

      // Newlines: collapse multiple blanks but keep real ones at top level
      if (ch === "\n") {
        out = out.replace(/[ \t]*$/, "");
        if (!out.endsWith("\n")) out += "\n";
        lineStart = true;
        i += 1;
        continue;
      }

      // Leading indent after a newline
      if (lineStart) {
        if (ch === " " || ch === "\t") { i += 1; continue; }
        pushIndent();
        lineStart = false;
      }

      out += ch;
      if (ch !== " " && ch !== "\t") prevNonSpace = ch;
      i += 1;
    }

    // Final cleanup: collapse 3+ blank lines to 1, trim trailing space.
    out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
    return out;
  }

  function beautifyCss(text) {
    let out = "";
    let depth = 0;
    let i = 0;
    const n = text.length;
    let inString = null;
    let inComment = false;

    function pushIndent() {
      for (let k = 0; k < depth; k += 1) out += INDENT;
    }

    while (i < n) {
      const ch = text[i];
      const next = text[i + 1];

      if (inComment) {
        out += ch;
        if (ch === "*" && next === "/") { out += "/"; i += 2; inComment = false; continue; }
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") { inComment = true; out += ch; i += 1; continue; }

      if (inString) {
        out += ch;
        if (ch === "\\") { out += next || ""; i += 2; continue; }
        if (ch === inString) inString = null;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = ch; out += ch; i += 1; continue; }

      if (ch === "{") {
        out = out.replace(/[ \t]*$/, "") + " {\n";
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        out = out.replace(/[ \t]*$/, "");
        if (!out.endsWith("\n")) out += "\n";
        pushIndent();
        out += "}\n";
        i += 1;
        continue;
      }
      if (ch === ";") {
        out += ";\n";
        i += 1;
        continue;
      }
      if (ch === "\n") {
        out = out.replace(/[ \t]*$/, "");
        if (!out.endsWith("\n")) out += "\n";
        i += 1;
        continue;
      }
      // indent continuation lines
      if (out.endsWith("\n") && ch !== " " && ch !== "\t") {
        pushIndent();
      }
      out += ch;
      i += 1;
    }
    return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "");
  }

  function beautify(text, lang) {
    const src = String(text == null ? "" : text);
    try {
      if (lang === "css" || lang === "scss" || lang === "less") {
        return beautifyCss(src);
      }
      return beautifyJs(src);
    } catch {
      return src; // never throw — fall back to original on any error
    }
  }

  globalThis.SourceMapHunterBeautify = {
    looksMinified,
    beautify,
    beautifyJs,
    beautifyCss,
  };
})();