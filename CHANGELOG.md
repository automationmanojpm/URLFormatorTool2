# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.5] - 2026-04-09

### Changed

- **Wildcard log** tab: entries are **tab-separated columns** (`In`, `Out`, `Rules applied`) with a header row for easier scanning and paste into spreadsheets.

## [1.3.4] - 2026-04-09

### Changed

- **Final (iOS)** output is comma-separated URLs only — no surrounding `[]`. Empty list is an empty line (was `[]`).

## [1.3.3] - 2026-04-09

### Added

- **Wildcard log** output tab: after **Process URLs**, lists accepted entries where `*`, `/*`, `*.`, or related normalization changed the URL (input line, normalized output, short rule summary). Copy and **Download .txt**.

## [1.3.2] - 2026-04-09

### Fixed

- **Trailing `/*` in query strings:** Wildcard stripping (`/*`, `*`) applies only to the **pathname** (before `?`), so values like `state=SFDC_CA_DEV/*` are preserved. The later **Strip wildcard prefixes** path pass also skips the query. Query params whose value is exactly `*` (e.g. `?app_id=*`, `&b=*`) are still normalized as before.

## [1.3.1] - 2026-04-09

### Fixed

- **Glued URL split:** `https://` inside a query value (e.g. OAuth `redirect_uri=https://…`) no longer splits one URL into two. Concatenated URLs without a separator (e.g. `…comhttps://…`) and comma/space-separated lists still split as before.

## [1.3.0] - 2026-04-09

### Added

- **Final (iOS)** output tab: same entries as **Final List**, formatted as `[https://a.com,https://b.com]` (unquoted, comma-separated) for managed app config / string-array fields. Copy and **Download .txt** (not JSON).
- **Input:** JSON mode / auto-detect now parses that bracket form when standard `JSON.parse` fails (splits on commas before `http://` / `https://`).

## [1.2.1] - 2026-04-09

### Changed

- Outputs column UI: shorter title, one-line intro, collapsible **Edge** guidance, compact preset cards, and **Fine-tune output lists & JSON** (`<details>`) so the section stays scannable.

## [1.2.0] - 2026-04-09

### Fixed

- **Add `https://` to bare domains** (`opt-add-scheme`) is now honored: with **With Scheme** / **Final List** (full-https), bare hosts omit synthetic `https://` when the option is off; dedup still uses a canonical `https://` key. Explicit `http://` / `https://` and bare **`host:port`** still normalize to `https://` for list output.
- **Bare `host.tld:port`** (no scheme) is no longer misparsed as a fake `host.tld` scheme.

### Added

- `verify_option_wiring.py` — checks that every `opt-*` id in `index.html` appears in `ALL_OPTION_CHECKBOX_IDS`, `getOpts()`, and the preset shared bundle.

## [1.1.0] - 2026-04-09

### Changed

- Quick presets (**Edge**, **Full URLs**, **Domains**) now apply **all** processing options: shared cleaning/filtering/compact bundle (same targets as **Reset to defaults**), then preset-specific **Strip www.** and output-list toggles.
- Any manual change to **any** option clears the preset highlight until a preset is clicked again.

## [1.0.0] - 2026-04-09

### Added

- App version (`APP_VERSION` in `app.js`), footer display, and cache-bust query strings tied to the version in `index.html`.
- `CHANGELOG.md` for release and fix history.
- Favicon (`favicon.svg`).
- Project documentation in `README.md`.

### Notes

- Prior work (URL parsing, presets, outputs, tests) is included as the baseline for **1.0.0**.
