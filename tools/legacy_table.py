#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Registry entries for boards the vendor's current tables dropped.

usage: legacy_table.py [--table FILE] [--out FILE]

The vendor's older web driver (iotdriver.qmk.top, saved under
~/vendor-builds/iotdriver-20260906/keyboards.json) still lists boards that
left the current tables, and the update channel still publishes firmware
for many of them. Where both hold (the table names the board, the firmware
gives its factory keymap in keymap-evidence.json) this writes an entry:
identity and USB ids from the table, the picture from the keymap when
exactly one shipped picture matches it entry for entry, and everything else
left for the board to say. The family is left `unknown`: the old records
carry nothing that classifies it, so the app settles it from the board's
own answers at connect (derive.rs), the same way as for a board with no
entry at all, and asks before writing.

Writes app/src-tauri/data/devices.legacy.json, which the extractor merges
like devices.extra.json. Regenerate it when the evidence file grows.
"""
import argparse
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLE = pathlib.Path.home() / "vendor-builds/iotdriver-20260906/keyboards.json"
DEVICES = ROOT / "app/src-tauri/data/devices.json"
EVIDENCE = ROOT / "app/src-tauri/data/keymap-evidence.json"
PICTURES = ROOT / "app/src/lib/layouts/vendor"
OUT = ROOT / "app/src-tauri/data/devices.legacy.json"

KNOB = ["AudioVolumeDown", "AudioVolumeMute", "AudioVolumeUp"]

# Six old boards enumerate under Apple's vendor id (05ac:024f). Listing
# them would put 05ac in the udev rule and in the WebHID picker, which
# reaches every Apple keyboard on the machine. Left out until an owner asks.
SKIP_VENDORS = {0x05AC}


def entries_of(matrix):
    return [tuple(matrix[i : i + 4]) for i in range(0, len(matrix), 4)]


def pictures():
    out = {}
    for p in sorted(PICTURES.glob("*.json")):
        if "~k" in p.stem or p.stem == "Unknown":
            continue
        layout = json.loads(p.read_text(encoding="utf-8"))
        ents = [tuple(k["matrixEntry"]) for k in layout["keys"] if k.get("matrixEntry")]
        if ents:
            out[p.stem] = ents
    return out


def pick_picture(matrix, pics):
    """The one picture whose every key's factory entry the keymap carries,
    with no keymap entry left unexplained. Several or none -> Unknown."""
    by = {}
    for slot, e in enumerate(entries_of(matrix)):
        if any(e):
            by.setdefault(e, []).append(slot)
    nonzero = sum(len(v) for v in by.values())
    hits = []
    for name, ents in pics.items():
        if len(ents) != nonzero:
            continue
        counts = {}
        ok = True
        for e in ents:
            n = counts.get(e, 0)
            counts[e] = n + 1
            if len(by.get(e, [])) <= n:
                ok = False
                break
        if ok:
            hits.append(name)
    return hits[0] if len(hits) == 1 else "Unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", type=pathlib.Path, default=TABLE)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    args = ap.parse_args()

    table = {d["id"]: d for d in json.loads(args.table.read_text(encoding="utf-8"))}
    registry = {d["id"] for d in json.loads(DEVICES.read_text(encoding="utf-8"))}
    evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    pics = pictures()
    out, drawn, ambiguous = [], 0, 0
    for key, rec in sorted(evidence.items(), key=lambda kv: int(kv[0])):
        did = int(key)
        if did in registry or did not in table:
            continue
        t = table[did]
        vid, pid = t.get("vid"), t.get("pid")
        if not isinstance(vid, int) or not isinstance(pid, int) or vid in SKIP_VENDORS:
            continue
        picture = pick_picture(rec["matrix"], pics)
        if picture != "Unknown":
            drawn += 1
        ents = entries_of(rec["matrix"])
        knob = any(e[:2] == (3, 0) and e[2] == 0xE9 for e in ents) and any(
            e[:2] == (3, 0) and e[2] == 0xEA for e in ents
        )
        name = str(t.get("name") or f"legacy_{did}")
        display = str(t.get("displayName") or name)
        company = str(t.get("company") or "")
        layers = t.get("layer")
        out.append(
            {
                "id": did,
                "name": name,
                "displayName": display,
                "company": company,
                "vendor": company,
                "vendorId": vid,
                "productId": pid,
                "internalName": name,
                "keyLayout": picture,
                "lightLayout": "",
                "sideLightLayout": "",
                "profiles": layers if isinstance(layers, int) and 0 < layers < 16 else 1,
                "magnetic": bool(re.search(r"hall|mag", name, re.I)),
                "family": "unknown",
                "features": {
                    "knob": KNOB if knob else [],
                    "debounce": False,
                    "sleep24": False,
                    "sleepBT": False,
                    "magneticSwitches": bool(re.search(r"hall|mag", name, re.I)),
                    "screen": False,
                    "sideLight": False,
                },
                "screen": None,
            }
        )
    args.out.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(out)} legacy boards written to {args.out}; {drawn} with a picture picked, {len(out) - drawn} left Unknown")


if __name__ == "__main__":
    main()
