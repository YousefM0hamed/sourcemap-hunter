```text
        ________________________________________________________________________________________________________
       /_______________________________________________________________________________________________________/
      /_______________________________________________________________________________________________________/
     |                                                                                                      | |
     |                       ____   ___  _   _ ____   ____ _____ __  __    _    ____                        | |
     |                      / ___| / _ \| | | |  _ \ / ___| ____|  \/  |  / \  |  _ \                       | |
     |                      \___ \| | | | | | | |_) | |   |  _| | |\/| | / _ \ | |_) |                      | |
     |                       ___) | |_| | |_| |  _ <| |___| |___| |  | |/ ___ \|  __/                       | |
     |                      |____/ \___/ \___/|_| \_\\____|_____|_|  |_/_/   \_\_|                          | |
     |                                                                                                      | |
     |                                 _   _ _   _ _   _ _____ _____ ____                                   | |
     |                                | | | | | | | \ | |_   _| ____|  _ \                                  | |
     |                                | |_| | | | |  \| | | | |  _| | |_) |                                 | |
     |                                |  _  | |_| | |\  | | | | |___|  _ <                                  | |
     |                                |_| |_|\___/|_| \_| |_| |_____|_| \_\                                 | |
     |                                                                                                      | |
     |                                                                                                      | |
     |                                                                                                      | |
     |______________________________________________________________________________________________________| |
     \______________________________________________________________________________________________________\_|
```

# Source Map Hunter

A Firefox browser extension for bug bounty hunting that detects exposed JavaScript source map files in real time and reconstructs readable source files from `sourcesContent`.

Source maps can expose original frontend source code, routes, comments, internal API paths, feature flags, build structure, and other useful review targets. This extension automates source map discovery while browsing any website.

> Intended for personal use in authorized security testing only.



https://github.com/user-attachments/assets/b97ed081-66c9-4028-a75e-65332e1a03f1



---

## Features

- Detects exposed JavaScript source maps while browsing.
- Uses Firefox `browser.*` WebExtension APIs.
- Uses `webRequest` to observe network traffic in real time.
- Flags source maps discovered through:
  - `SourceMap`, `X-SourceMap`, `Source-Map`, or `SourceMappingURL` response headers.
  - Direct `.js.map`, `.mjs.map`, and `.cjs.map` responses.
  - `//# sourceMappingURL=...` or `/*# sourceMappingURL=... */` comments inside JavaScript responses.
  - Proactive guessing for every loaded JavaScript file:
    - `app.js` → `app.js.map`
    - `bundle.mjs` → `bundle.mjs.map`
    - `main.cjs` → `main.cjs.map`
- Validates source map candidates before reporting them.
- Suppresses common false positives by requiring valid JSON with:
  - `version`
  - `sources`
  - `mappings`
- Extracts embedded original source files from `sourcesContent`.
- Shows a red browser action badge with the number of confirmed source maps found on the current tab.
- Popup UI lists discovered source map URLs.
- Viewer page displays reconstructed source files in a clean, readable interface.
- Basic syntax highlighting for JavaScript-like files.
- Supports downloading reconstructed sources as a ZIP file.
- [v.1.1.0] Supports domain filtering.
- [v1.2.0] Supports search using plain text or regex
- No external dependencies.
- No framework.
- No remote telemetry.

---

## Screens

The extension has three main UI surfaces:

1. **Toolbar badge**

   Shows the number of confirmed source maps found on the current tab.

2. **Popup**

   Lists confirmed source maps for the active tab and provides buttons to:

   - View reconstructed sources.
   - Download reconstructed sources as a ZIP archive.
   - Clear tab results.

3. **Source viewer**

   Displays embedded files from `sourcesContent` in a readable file-browser layout.

---

## Project structure

```text
sourcemap-hunter/
├── manifest.json
├── background.js
├── icons/
│   └── icon.svg
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── shared/
│   └── zip.js
└── viewer/
    ├── viewer.html
    ├── viewer.css
    └── viewer.js
```

## How detection works

1. Header-based detection

The extension watches response headers and checks for source map-related headers such as:

```
SourceMap: /static/app.js.map
X-SourceMap: /static/app.js.map
Source-Map: /static/app.js.map
SourceMappingURL: /static/app.js.map
```

If a candidate source map URL is found, the extension fetches it and validates that it is a real source map before reporting it.

2. Direct .map response detection

If a network response URL ends in one of these extensions, it is treated as a source map candidate:

```
.js.map
.mjs.map
.cjs.map
```

The file is still validated before being shown in the pop-up.

3. JavaScript comment detection

For loaded JavaScript responses, the extension scans the response body for source map comments:

`//# sourceMappingURL=app.js.map`

or:


`/*# sourceMappingURL=app.js.map */`

The referenced map is fetched, parsed, and validated.

4. Proactive source map guessing

For every JavaScript file loaded on the page, the extension automatically attempts to fetch the likely source map file.

Examples:

```
https://target.example/static/app.js
→ https://target.example/static/app.js.map

https://target.example/assets/bundle.mjs
→ https://target.example/assets/bundle.mjs.map

https://target.example/js/main.js?v=123
→ https://target.example/js/main.js.map?v=123
→ https://target.example/js/main.js.map
```

A guessed file is only reported if the server returns HTTP 200 and the response is a valid source map JSON.

## Source map validation

A candidate is only confirmed if it parses as JSON and contains the expected source map structure:

```
{
  "version": 3,
  "sources": [],
  "mappings": ""
}
```

The extension checks for:

| Field | Required | Expected type |
|---|---:|---|
| `version` | Yes | number or string |
| `sources` | Yes | array |
| `mappings` | Yes | string |
| `sourcesContent` | No | array |

If `sourcesContent` exists, embedded source files are extracted and made viewable/downloadable.

If `sourcesContent` does not exist, the map is still reported as valid, but there may be no reconstructed source files to display.

## Installation

### Temporary installation in Firefox

1. Clone or download this repository.
2. Open Firefox or Firefox Developer Edition.
3. Go to:
    `about:debugging#/runtime/this-firefox`
4. Click:
    `Load Temporary Add-on…`
5. Select the project manifest file:
    `sourcemap-hunter/manifest.json`
6. Open any website.
7. Browse normally.
8. If source maps are found, the toolbar badge will show a red counter.
9. Click the extension icon to view and export results.

**NOTE: Temporary extensions remain installed until they are removed or Firefox is restarted.**

# Firefox MV3 note

This project is written for Firefox WebExtensions using Manifest V3.

Firefox currently supports MV3 but uses `background.scripts` for background logic. Firefox does not use Chrome-style `background.service_worker` for extension background execution, That is why the manifest uses:

```
"background": {
  "scripts": [
    "background.js"
  ]
}
```

instead of:

```
"background": {
  "service_worker": "background.js"
}
```

## Troubleshooting

Q1. Firefox says the folder does not contain a valid manifest

A: Make sure you selected: `sourcemap-hunter/manifest.json` not only the folder, but also confirm the file is not accidentally named: `mainfest.json | manifest.json.txt` or anything other than `manifest.json` anyway :)

Q2: The extension loads but finds nothing

A: Possible reasons:
1. The target does not expose source maps.
2. The source maps exist but require authentication.
3. The source maps return `403`, `404`, or another non-`200` response.
4. The source maps are blocked by CORS or site permissions.
5. The map exists but does not contain valid source map JSON.
6. The map exists but does not include `sourcesContent`.
7. The page loaded scripts before the extension was installed or enabled.
Refresh the target page after loading the extension.

Q3: A valid source map is detected but no source files appear

A: Some source maps include only source paths and mappings, not embedded source contents.
For example:

```
{
  "version": 3,
  "sources": [
    "src/app.js"
  ],
  "mappings": "..."
}
```

Without `sourcesContent`, the extension can confirm the source map but cannot reconstruct the original files directly.

Q4: The browser becomes slower on very large pages

A: The extension inspects JavaScript responses and may fetch guessed `.map` files for each script. Pages with many large bundles can generate extra local processing and network requests. To minimize the impact as much as possible, load the extension when you need it.

# Legal and ethical use

Use this extension only on systems where you have explicit authorization to test.
This includes:

1. Your own applications.
2. Internal environments where you have permission.
3. Bug bounty programs where source review and client-side testing are in scope.

*Just don't break the law, bruh*

## Disclaimer

This project is provided for authorized security research and educational use.
The author is not responsible for misuse, unauthorized testing, or policy violations. Always follow the target program’s scope, rules of engagement, and disclosure process.
