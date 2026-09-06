#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-light-layout effect tables out of the vendor bundle.

usage:
  light_layouts.py BUNDLE.js [--out app/src-tauri/data/light-layouts.json]

Every device record's `lightLayout` points at a shared object of the form
`{ isRgb, types: [{ type, maxSpeed, maxValue, rgb, dazzle, options }] }`;
the registry keeps only the object's minified name (`S`, `se`, `Ct`, ...).
This writes those objects out, keyed by that name, with effect names turned
into the wire numbers the device classes use (`LightList` in the gen2 class,
`LIGHTLIST` in the yc500 base; the two agree). Effects that need a host data
feed (music sync, screen colour, the effect editor), the off state and the
per-key picture are left out: the app has other pages or nothing for them.

The vendor names are minified and change between builds, so run this on the
same bundle as extract_vendor_data.py.
"""
import argparse
import json
import re
from pathlib import Path

WIRE = {
    "LightAlwaysOn": 1,
    "LightBreath": 2,
    "LightNeon": 3,
    "LightWave": 4,
    "LightRipple": 5,
    "LightRaindrop": 6,
    "LightSnake": 7,
    "LightPressAction": 8,
    "LightConverage": 9,
    "LightSineWave": 10,
    "LightKaleidoscope": 11,
    "LightLineWave": 12,
    "LightLaser": 14,
    "LightCircleWave": 15,
    "LightDazzing": 16,
    "LightRainDown": 17,
    "LightMeteor": 18,
    "LightPressActionOff": 19,
    "LightTrain": 23,
    "LightFireWorks": 24,
}

OPTION_WORDS = {
    "向右": "Right",
    "向左": "Left",
    "向下": "Down",
    "向上": "Up",
    "Z字形": "Zigzag",
    "回形": "Spiral",
    "向外": "Outward",
    "向内": "Inward",
    "逆时针": "CCW",
    "顺时针": "CW",
}

LAYOUT_RE = re.compile(
    r"\b([A-Za-z_$][\w$]*) = \{\s*isRgb: (!0|!1),\s*types: \[(.*?)\],?\s*\}", re.S
)
FIELD_RE = re.compile(r'(\w+): ("[^"]*"|\[[^\]]*\]|!0|!1|\d+)')


def parse(bundle: str) -> dict:
    out = {}
    for m in LAYOUT_RE.finditer(bundle):
        ident, rgb, body = m.group(1), m.group(2) == "!0", m.group(3)
        effects = []
        brightness = 0
        for t in re.finditer(r"\{([^{}]*)\}", body):
            f = dict(FIELD_RE.findall(t.group(1)))
            name = f.get("type", "").strip('"')
            if name not in WIRE:
                continue
            max_value = int(f["maxValue"]) if "maxValue" in f else 0
            brightness = max(brightness, max_value)
            effect = {"mode": WIRE[name]}
            if "maxSpeed" in f:
                effect["speedMax"] = int(f["maxSpeed"])
            if f.get("rgb") == "!0":
                effect["rgb"] = True
            if "options" in f:
                words = json.loads(f["options"].replace("null", "null"))
                effect["options"] = [OPTION_WORDS.get(w, w) if w else None for w in words]
            effects.append(effect)
        if effects:
            out[ident] = {"rgb": rgb, "brightnessMax": brightness, "effects": effects}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "app/src-tauri/data/light-layouts.json",
    )
    args = ap.parse_args()
    table = parse(args.bundle.read_text("utf-8"))
    args.out.write_text(json.dumps(table, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print(f"{len(table)} light layouts -> {args.out}")


if __name__ == "__main__":
    main()
