# URL Formatter

A browser-based tool that parses messy URL lists, normalizes them for enterprise policies, and exports **JSON arrays** you can paste into **Microsoft Edge URL List** policies and **Android Enterprise managed application configuration** (and similar allowlists).

All processing runs **entirely in your browser**—nothing is uploaded to a server.

---

## What it does

- Accepts URLs in several input shapes (paste, file upload, or mixed formats).
- Cleans and deduplicates entries with configurable rules.
- Produces aligned **With Scheme**, **No Scheme**, **Ports Only**, **Final List**, and **Skipped** outputs as JSON.
- Offers **quick presets** tuned for Edge URL lists vs. full `https://` lists vs. bare-domain workflows.
- Lets you **search/filter** input rows and output tabs, **copy** to the clipboard, and **download** `.json` files.

---

## Features

### Input

| Mode | Description |
|------|-------------|
| **Auto-detect** | Chooses JSON vs. CSV vs. one-per-line from the text shape. |
| **One per line** | Each non-empty line is one entry (quotes optional). |
| **CSV** | Comma-separated values per line; quoted fields supported. |
| **JSON array** | Parses `["url1","url2",…]`. |
| **Bracket list (iOS / MDM)** | Auto-detected with `[` — also accepts `[https://a.com,https://b.com]` (no quotes) when JSON mode is used or auto picks JSON. Entries are split on commas only when followed by `http://` or `https://`, so commas inside a query string usually stay intact. |

- **Upload** `.txt`, `.json`, or `.csv` files.
- **Glued URLs** on one line (e.g. `https://a.comhttps://b.com`) are split automatically before cleaning.
- **Input search** to filter parsed entries before processing.

### Cleaning options

- **Strip wildcard prefixes** — e.g. `*.company.com` → `company.com`.
- **Strip `www.`** — normalize hostnames.
- **Fix broken schemes** — e.g. `https:/host` → `https://host`.
- **Add `https://` to bare domains** — when on (default), bare hosts get synthetic `https://` for **With Scheme** and for **Final List** in full-https mode. When off, schemeless **host/path only** (no port) stays bare there; explicit `http(s)://` and bare **`host:port`** still normalize to `https://` where a URL scheme is required. **Deduplication** always uses a canonical `https://` key so `http://` and `https://` still collapse.
- **Remove duplicates** — keyed by normalized `https://…` form (so `http://` and `https://` to the same host collapse).
- **Filter non-HTTP entries** — drops custom schemes (e.g. app deep links), `tel:`, and known app-identifier-style TLDs.
- **Drop incomplete query strings** — lines ending in `=` or `&` (invalid placeholders).
- **Strip trailing paths** — optional host-only output shape.

### Output tabs

- **Final List** — shape depends on the active **quick preset** (Edge-style bare + `https://` only when a port is present, full HTTPS list, or domains-focused mix).
- **Final (iOS)** — same URLs as **Final List**, one line: `https://…,https://…` (comma-separated, no surrounding `[]`, no JSON string quotes). Download as `.txt`; not valid JSON.
- **With Scheme** — `https://…` for each entry that has a synthetic or normalized scheme (bare schemeless hosts are omitted here when **Add `https://`** is off).
- **No Scheme** — bare host/path; URLs with explicit ports are omitted here (not representable as a single bare host+port string in that list).
- **Ports Only** — entries that include an explicit `:port`.
- **Skipped** — invalid, filtered, or duplicate-dropped inputs for review.

Each tab supports **filter**, **Copy**, and (where applicable) **Download .json** Compact vs. pretty JSON is controlled by **Compact JSON**.

### Quick presets

| Preset | Typical use |
|--------|-------------|
| **Edge URL list** | Same cleaning/filtering/compact as **Reset to defaults**; strip `www.`; all output tabs on; **Final List** = Edge-style bare + `https://` for ports. |
| **Full URLs (`https://…`)** | Same cleaning defaults as Edge; keep `www.`; all output tabs on; **Final List** = every line full HTTPS. |
| **Domains only** | Same cleaning defaults as Edge; strip `www.`; **No Scheme** on only among outputs; **Final List** = Edge-style port rule. |

Each quick preset sets **every** processing checkbox: cleaning, filtering, **Compact JSON**, **Strip www.**, and the three output-list toggles. A **highlighted** card means that preset was applied (or the initial Edge default); changing **any** option by hand clears the highlight until you click a preset again. **Final List** still follows the actual toggles when no card is highlighted (inferred from checkbox state).

**Reset to defaults** is equivalent to choosing the **Edge URL list** preset.

---

## Project layout

| File | Role |
|------|------|
| `index.html` | Page structure, UI, accessibility hooks. |
| `style.css` | Layout and theme (dark UI, accent colors). |
| `app.js` | Parsing, cleaning, processing, presets, DOM wiring. |
| `favicon.svg` | Tab / bookmark icon. |
| `test.js` | Node-based tests mirroring core URL logic. |
| `test_runner.py` | Python port of the same logic for offline checks. |
| `check_presets.mjs` | Sanity check that preset ↔ toggle mapping stays consistent. |
| `verify_option_wiring.py` | Ensures every `opt-*` checkbox is wired in `app.js` and presets. |
| `test_preset_ui_logic.py` | Preset rows and Final List id inference (Python). |

---

## Running the app locally

No build step or package install is required.

1. Clone or copy this folder.
2. Open `index.html` in a modern browser **or** serve the folder with any static file server (recommended if you want consistent behavior with file uploads and module paths):

   ```bash
   # Example: Python 3
   python -m http.server 8080
   ```

   Then visit `http://localhost:8080`.

---

## Versioning

Versions use **semantic versioning** (`MAJOR.MINOR.PATCH`).

- **Canonical version:** `APP_VERSION` at the top of `app.js` (also shown in the footer as `v…`).
- **Release notes:** [CHANGELOG.md](CHANGELOG.md) — add an entry for every user-visible fix or feature.
- **Cache busting:** When you release, bump `APP_VERSION` and set the `?v=` query string on `style.css` and `app.js` in `index.html` to the same value so browsers load fresh assets.

---

## Testing

Verify core parsing and cleaning behavior (aligned between JS and Python implementations):

```bash
node test.js
```

```bash
python test_runner.py
```

Verify preset inference matches `applyOutputPreset` in `app.js`:

```bash
node check_presets.mjs
```

Preset toggle targets and `getFinalListPresetId` behavior (no Node required):

```bash
python test_preset_ui_logic.py
```

HTML checkbox ids vs `getOpts()` / preset bundle:

```bash
python verify_option_wiring.py
```

On Windows, if `test_runner.py` prints encoding errors, run with UTF-8 (e.g. `set PYTHONUTF8=1` in `cmd`, or `$env:PYTHONUTF8=1` in PowerShell) before `python test_runner.py`.

---

## Requirements

- A **current** desktop or mobile browser with JavaScript enabled.
- For **Node** tests: Node.js 18+ (or any version that runs the script without syntax errors).

---

## Privacy

All URL text stays in the page. There is **no backend** and **no telemetry** in this repository’s code path.

---

## Credits

Created and powered by the Automation Team and AI (as noted in the app footer).
