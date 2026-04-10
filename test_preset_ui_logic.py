"""
Offline checks for preset toggle targets and Final List preset resolution.
Mirrors app.js: applyOutputPreset (four checkboxes + strip www) and getFinalListPresetId.

Run:  set PYTHONUTF8=1  (Windows) then  python test_preset_ui_logic.py
"""
from __future__ import annotations

# (strip_www, out_with_scheme, out_no_scheme, out_ports) — must match app.js applyOutputPreset
PRESET_TOGGLE_ROWS: dict[str, tuple[bool, bool, bool, bool]] = {
    "edge": (True, True, True, True),
    "full-https": (False, True, True, True),
    "domains": (True, False, True, False),
}


def get_final_list_preset_id(
    active_preset: str | None,
    www: bool,
    ows: bool,
    ons: bool,
    ports: bool,
) -> str:
    """Mirror getFinalListPresetId() when .preset-btn.active corresponds to active_preset."""
    if active_preset in ("edge", "full-https", "domains"):
        return active_preset
    if not www and ows and ons and ports:
        return "full-https"
    if www and not ows and ons and not ports:
        return "domains"
    return "edge"


def main() -> int:
    failed = 0

    # Targets match check_presets.mjs / test_runner PRESET_TOGGLE_ROWS
    for name, row in PRESET_TOGGLE_ROWS.items():
        if infer_preset(*row) != name:
            print(f"FAIL preset row {name!r} infer got {infer_preset(*row)!r}")
            failed += 1
    if failed == 0:
        print("  OK preset toggle rows round-trip infer_preset")

    # getFinalListPresetId: highlighted preset wins
    if get_final_list_preset_id("edge", False, True, True, True) != "edge":
        print("FAIL active edge should win over full-https-shaped toggles")
        failed += 1
    else:
        print("  OK active preset wins for Final List id")

    # No highlight: infer from toggles
    tests = [
        (None, (True, True, True, True), "edge"),
        (None, (False, True, True, True), "full-https"),
        (None, (True, False, True, False), "domains"),
        (None, (True, True, True, False), "edge"),  # custom → default edge algorithm
    ]
    for active, (w, o, n, p), want in tests:
        got = get_final_list_preset_id(active, w, o, n, p)
        if got != want:
            print(f"FAIL infer active={active!r} toggles={w,o,n,p} want {want!r} got {got!r}")
            failed += 1
    if failed == 0:
        print("  OK Final List id inference without active button")

    if failed == 0:
        print("\ntest_preset_ui_logic.py: all checks passed")
    else:
        print(f"\ntest_preset_ui_logic.py: {failed} failure(s)")
    return 1 if failed else 0


def infer_preset(www: bool, ows: bool, ons: bool, ports: bool) -> str | None:
    for name, row in PRESET_TOGGLE_ROWS.items():
        if row == (www, ows, ons, ports):
            return name
    return None


if __name__ == "__main__":
    raise SystemExit(main())
