"""
Fail if index.html option ids drift from app.js ALL_OPTION_CHECKBOX_IDS / getOpts().
Run: python verify_option_wiring.py
"""
from __future__ import annotations

import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def main() -> int:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "app.js").read_text(encoding="utf-8")

    html_ids = set(re.findall(r'id="(opt-[^"]+)"', html))
    m = re.search(
        r"const ALL_OPTION_CHECKBOX_IDS = \[([\s\S]*?)\];",
        js,
    )
    if not m:
        print("FAIL: could not find ALL_OPTION_CHECKBOX_IDS in app.js")
        return 1
    block = m.group(1)
    listed = re.findall(r"'(opt-[^']+)'", block)
    listed_set = set(listed)
    if len(listed) != len(listed_set):
        print("FAIL: duplicate ids in ALL_OPTION_CHECKBOX_IDS")
        return 1

    missing_in_js = html_ids - listed_set
    extra_in_js = listed_set - html_ids
    if missing_in_js or extra_in_js:
        if missing_in_js:
            print(f"FAIL: in HTML but not ALL_OPTION_CHECKBOX_IDS: {sorted(missing_in_js)}")
        if extra_in_js:
            print(f"FAIL: in ALL_OPTION_CHECKBOX_IDS but not HTML: {sorted(extra_in_js)}")
        return 1

    # getOpts() must reference each id (camelCase keys optional check via substring)
    for oid in sorted(html_ids):
        if f"getElementById('{oid}')" not in js:
            print(f"FAIL: getOpts or UI missing getElementById('{oid}')")
            return 1

    # PRESET_SHARED_CLEANING keys must be subset of all options (excludes strip-www + outputs)
    m2 = re.search(
        r"const PRESET_SHARED_CLEANING = \{([\s\S]*?)\n\};",
        js,
    )
    if not m2:
        print("FAIL: PRESET_SHARED_CLEANING not found")
        return 1
    preset_keys = set(re.findall(r"'(opt-[^']+)'", m2.group(1)))
    allowed = html_ids - {"opt-strip-www", "opt-out-with-scheme", "opt-out-no-scheme", "opt-out-ports"}
    bad = preset_keys - allowed
    if bad:
        print(f"FAIL: PRESET_SHARED_CLEANING has unexpected keys: {bad}")
        return 1
    missing_preset = allowed - preset_keys
    if missing_preset:
        print(f"FAIL: PRESET_SHARED_CLEANING missing keys: {sorted(missing_preset)}")
        return 1

    print("verify_option_wiring.py: OK (HTML ids, ALL_OPTION_CHECKBOX_IDS, getOpts, preset shared bundle)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
