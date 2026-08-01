#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Bake a user-contributed layout bundle into its layout file.

usage:
  bake_layout.py BUNDLE.txt [--layouts DIR] [--force]

BUNDLE.txt is the "sharkfin layout bundle" text the Keys page produces when a
user answers the layout wizard, pasted from a board-report issue. It names
the layout and carries the board's base-layer keymap; that keymap is the
defaultMatrix the vendor bundle was missing, so the same matching the
extractor uses fills the layout file's matrixIndex fields permanently.

Refuses a bundle whose verdict is not "looks right" unless --force: a keymap
from a board whose picture the owner rejected fixes nothing by itself.

The layout file is rewritten in the extractor's dump format, so a later
extraction that finds a real defaultMatrix produces no spurious diff.
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_vendor_data import dump_layout  # noqa: E402

import json  # noqa: E402


def parse_bundle(text):
    m = re.search(r"^layout\s*:\s*(\S+)", text, re.M)
    if not m:
        raise SystemExit("no `layout :` line in the bundle")
    layout = m.group(1)
    p = re.search(r"^picture\s*:\s*(\S+)", text, re.M)
    picture = p.group(1) if p else layout
    verdict = None
    v = re.search(r"^verdict\s*:\s*(.+)$", text, re.M)
    if v:
        verdict = v.group(1).strip()
    hex_lines = re.findall(r"^(?:[0-9a-f]{2} )+[0-9a-f]{2}$", text, re.M)
    matrix = [int(b, 16) for line in hex_lines for b in line.split()]
    if not matrix or len(matrix) % 4:
        raise SystemExit(f"keymap is {len(matrix)} bytes, expected a multiple of 4")
    drawing = None
    j = re.search(r"^picture json:\s*\n(\{.*\})\s*$", text, re.M)
    if j:
        drawing = json.loads(j.group(1))
    return layout, picture, drawing, verdict, matrix


def bake(layout, matrix):
    slots = [tuple(matrix[i : i + 4]) for i in range(0, len(matrix), 4)]
    counts, used = {}, set()
    matched = total = 0
    ambiguous = []
    for k in layout["keys"]:
        entry = k.get("matrixEntry")
        if not entry:
            continue
        total += 1
        et = tuple(entry)
        nth = counts.get(et, 0)
        counts[et] = nth + 1
        hits = [s for s, v in enumerate(slots) if v == et]
        if nth < len(hits):
            k["matrixIndex"] = hits[nth]
            used.add(hits[nth])
            matched += 1
            if len(hits) > 1:
                ambiguous.append(k["code"])
    layout["keys"].sort(key=lambda k: (k["matrixIndex"] is None, k["matrixIndex"] or 0))
    layout["matrixEntriesWithoutUIKey"] = [
        {"matrixIndex": s, "entry": list(v)}
        for s, v in enumerate(slots)
        if any(v) and s not in used
    ]
    return matched, total, ambiguous


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    here = Path(__file__).resolve().parent
    ap.add_argument("--layouts", type=Path, default=here.parent / "app/src/lib/layouts/vendor")
    ap.add_argument("--force", action="store_true", help="bake despite a rejected verdict")
    ap.add_argument(
        "--name",
        help="file to write, without .json; needed when the registry says Unknown",
    )
    args = ap.parse_args()

    name, picture, drawing, verdict, matrix = parse_bundle(
        args.bundle.read_text(encoding="utf-8")
    )
    target = args.name or name
    if target == "Unknown":
        raise SystemExit(
            "the registry calls this board's layout Unknown; pick a real "
            "file name with --name and point the board's registry entry at it"
        )
    if verdict != "looks right" and not args.force:
        raise SystemExit(
            f"bundle verdict is {verdict!r}; the owner did not confirm the "
            "picture, so this keymap fixes nothing on its own (--force overrides)"
        )
    path = args.layouts / f"{target}.json"

    # Geometry comes from the drawing the owner pasted, the vendor file
    # whose picture they confirmed, or the target file itself.
    if drawing is not None:
        layout = drawing
    elif picture != target:
        src = args.layouts / f"{picture}.json"
        if not src.is_file():
            raise SystemExit(f"{src}: no such layout to copy geometry from")
        layout = json.loads(src.read_text(encoding="utf-8"))
    elif path.is_file():
        layout = json.loads(path.read_text(encoding="utf-8"))
    else:
        raise SystemExit(f"{path}: no such layout and the bundle carries no picture")

    if path.is_file():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if any(k.get("matrixIndex") is not None for k in existing["keys"]):
            raise SystemExit(f"{path}: already has slot data; refusing to overwrite")
    for k in layout["keys"]:
        k["matrixIndex"] = None
    layout.pop("matrixEntriesWithoutUIKey", None)
    layout.pop("inferred", None)

    matched, total, ambiguous = bake(layout, matrix)
    rate = matched / total if total else 0
    if rate < 0.9:
        raise SystemExit(
            f"only {matched}/{total} keys matched; the keymap is not this "
            "board's factory state or the layout is wrong"
        )
    if ambiguous and not args.force:
        raise SystemExit(
            f"ambiguous pairings for {', '.join(sorted(ambiguous))}: either "
            "the layout has twin keys or the contributing board was remapped. "
            "Inspect, then --force"
        )

    registry = Path(__file__).resolve().parent.parent / "app/src-tauri/data/devices.json"
    sharers = [
        d.get("displayName") or d["name"]
        for d in json.loads(registry.read_text(encoding="utf-8"))
        if d.get("keyLayout") == name
    ]

    path.write_text(dump_layout(layout), encoding="utf-8")
    print(f"{path.name}: {matched}/{total} keys matched")
    if len(sharers) > 1:
        print(f"  layout is shared by {len(sharers)} boards: {', '.join(sorted(sharers))}")


if __name__ == "__main__":
    main()
