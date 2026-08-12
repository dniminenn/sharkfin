#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Lint the layout pictures and the device registry.

Usage: tools/lint_layouts.py

Errors exit 1 and fail CI:
  - a picture that is not valid JSON or has no keys
  - a matrix entry that is not four bytes
  - a labelled key with no entry at all: its owner cannot remap it and
    nothing on the board can ever match it
  - hidUsage disagreeing with the entry it summarises
  - a duplicate device id, or a family the app does not know
  - devices.extra.json naming an id that is not in devices.json, or
    carrying field values devices.json disagrees with

Warnings are printed and do not fail:
  - a keyLayout naming a picture file that does not exist (the app falls
    back to matching a picture against the board, same as Unknown)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEVICES = ROOT / "app/src-tauri/data/devices.json"
EXTRA = ROOT / "app/src-tauri/data/devices.extra.json"
VENDOR_LAYOUTS = ROOT / "app/src/lib/layouts/vendor"

# Mirrors KNOWN_FAMILIES in app/src-tauri/src/registry.rs plus the marker
# for boards identified but not yet classified.
FAMILIES = {"yc500", "gen2", "unknown"}

# Layouts that live outside the vendor directory. Mirrors CANONICAL in
# tools/coverage.py.
CANONICAL = {"Common80_k72x86"}

# Dead keys with no fix the data can evidence. MK18 prints two Print-like
# keys and only hardware can say which carries the real usage.
DEAD_KEY_EXCEPTIONS = {("Common108_MK18", "PrtSc")}


def lint_picture(path: Path, errors: list[str]) -> None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as e:
        errors.append(f"{path.name}: not valid JSON ({e})")
        return
    keys = data.get("keys")
    if not isinstance(keys, list) or not keys:
        errors.append(f"{path.name}: no keys")
        return
    for k in keys:
        text = k.get("text")
        entry = k.get("matrixEntry")
        usage = k.get("hidUsage")
        where = f"{path.name}: {text or k.get('code') or '?'}"
        if entry is not None:
            if (
                not isinstance(entry, list)
                or len(entry) != 4
                or not all(isinstance(b, int) and 0 <= b <= 255 for b in entry)
            ):
                errors.append(f"{where}: entry {entry} is not four bytes")
                continue
        if k.get("type") != "key":
            continue
        if (
            entry is None
            and k.get("consumerUsage") is None
            and text
            and (path.stem, text) not in DEAD_KEY_EXCEPTIONS
        ):
            errors.append(f"{where}: labelled key with no entry")
        if entry and entry[0] == 0 and entry[3] == 0 and entry[2] >= 4:
            if usage != entry[2]:
                errors.append(f"{where}: hidUsage {usage} but entry says {entry[2]}")
        elif usage is not None and (not entry or entry[0] != 0 or entry[2] != usage):
            errors.append(f"{where}: hidUsage {usage} does not match entry {entry}")


def lint_registry(errors: list[str], warnings: list[str]) -> None:
    devices = json.loads(DEVICES.read_text("utf-8"))
    stems = {p.stem for p in VENDOR_LAYOUTS.glob("*.json")} | CANONICAL
    seen: dict[int, str] = {}
    for d in devices:
        did = d["id"]
        if did in seen:
            errors.append(f"device id {did} appears twice ({seen[did]}, {d['name']})")
        seen[did] = d["name"]
        if d.get("family") not in FAMILIES:
            errors.append(f"device {did} ({d['name']}): unknown family {d.get('family')!r}")
        kl = d.get("keyLayout")
        if kl and kl != "Unknown" and kl not in stems:
            warnings.append(f"device {did} ({d['name']}): keyLayout {kl} has no picture")
    by_id = {d["id"]: d for d in devices}
    for x in json.loads(EXTRA.read_text("utf-8")):
        d = by_id.get(x["id"])
        if d is None:
            errors.append(f"devices.extra.json id {x['id']} is not in devices.json")
            continue
        for field, value in x.items():
            if field.startswith("_"):
                continue
            if d.get(field) != value:
                errors.append(
                    f"devices.extra.json id {x['id']} field {field}: "
                    f"{value!r} but devices.json has {d.get(field)!r}"
                )


def main() -> None:
    errors: list[str] = []
    warnings: list[str] = []
    for path in sorted(VENDOR_LAYOUTS.glob("*.json")):
        lint_picture(path, errors)
    lint_registry(errors, warnings)
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    print(f"{len(errors)} errors, {len(warnings)} warnings")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
