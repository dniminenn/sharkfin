#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Which LEDPARAM flags value the vendor driver sends a board for the
rainbow, per board, out of the driver's own device classes.

usage: vendor_led_flags.py DIST_JS [DIST_JS ...]
                           [--out app/src-tauri/data/led-flags.vendor.json]

DIST_JS is a vendor web build's dist/js directory (minified chunks), the
same one extract_vendor_data.py reads. Repeatable; the first directory to
resolve a board wins.

The driver builds one class per board. Each class extends a base, and
somewhere up that chain a class sets `DAZZLE` and `NORMAL`, the flags
nibble it sends for the rainbow and for a fixed colour. The common bases
say 8 and 7; a handful of intermediate bases say 7 and 8, and every board
under them reads the packet that way round. This walks each board's chain
to the nearest class that sets the pair and records it.

Boards are found two ways, since the brands bundle differently: lazy
loader tables (`name:()=>import("./chunk.js")`, one chunk per board, the
gearhub build) and switch tables (`case"name":return new Cls(...)`, every
class in one chunk, the MonsGeek and Akko builds).

Writes one record per resolved board, both values included, so the file
is the evidence and not a list of exceptions. tools/led_flags.py reads
the same fact out of the published firmware where there is one; where
both exist the firmware wins, and the two agree on every board but the
AttackShark X65HE (2268).
"""
import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEVICES = ROOT / "app/src-tauri/data/devices.json"
OUT = ROOT / "app/src-tauri/data/led-flags.vendor.json"

IMPORT_RE = re.compile(r'import\{([^}]*)\}from"\./([^"]+\.js)"')
EXPORT_RE = re.compile(r"export\{([^}]*)\}")
CLASS_RE = re.compile(r"class ([A-Za-z_$][\w$]*) extends ([A-Za-z_$][\w$]*)\{")
PAIR_RE = re.compile(r"DAZZLE=(\d+);NORMAL=(\d+)")
LOADER_RE = re.compile(
    r'([a-z0-9_]+):\(\)=>[A-Za-z_$][\w$]*\(\(\)=>import\("\./([^"]+\.js)"\)'
    r'[^;]*?\.then\([A-Za-z_$][\w$]*=>\(\{default:[A-Za-z_$][\w$]*\.([\w$]+)\}\)\)'
)
SWITCH_RE = re.compile(r'case"([a-z0-9_]+)":return new ([A-Za-z_$][\w$]*)\(')


def bindings(spec):
    """`a as b,c` into {b: a, c: c}: the local name each binding lands on."""
    out = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if " as " in part:
            src, dst = (p.strip() for p in part.split(" as "))
        else:
            src = dst = part
        out[dst] = src
    return out


class Chunk:
    def __init__(self, path):
        self.path = path
        self.src = path.read_text(errors="ignore")
        # local name -> (chunk file, exported name)
        self.imports = {}
        for m in IMPORT_RE.finditer(self.src):
            for local, exported in bindings(m.group(1)).items():
                self.imports[local] = (m.group(2), exported)
        # exported name -> local name
        self.exports = {}
        for m in EXPORT_RE.finditer(self.src):
            for exported, local in bindings(m.group(1)).items():
                self.exports[exported] = local
        # local class name -> (base local name, (dazzle, normal) or None)
        self.classes = {}
        starts = list(CLASS_RE.finditer(self.src))
        for i, m in enumerate(starts):
            end = starts[i + 1].start() if i + 1 < len(starts) else len(self.src)
            pair = PAIR_RE.search(self.src, m.end(), end)
            self.classes[m.group(1)] = (
                m.group(2),
                (int(pair.group(1)), int(pair.group(2))) if pair else None,
            )


class Build:
    def __init__(self, dist):
        self.dist = pathlib.Path(dist)
        self.chunks = {}
        for p in sorted(self.dist.glob("*.js")):
            self.chunks[p.name] = Chunk(p)

    def resolve(self, chunk, local, depth=0):
        """Walk `local`, a class in `chunk`, up to the first class that sets
        the pair. (dazzle, normal, chunk name) or None."""
        if depth > 32 or chunk not in self.chunks:
            return None
        c = self.chunks[chunk]
        if local in c.classes:
            base, pair = c.classes[local]
            if pair:
                return (*pair, chunk)
            return self.resolve(chunk, base, depth + 1)
        if local in c.imports:
            src, exported = c.imports[local]
            if src in self.chunks and exported in self.chunks[src].exports:
                return self.resolve(src, self.chunks[src].exports[exported], depth + 1)
        return None

    def boards(self):
        """internal name -> (dazzle, normal, chunk name)."""
        out = {}
        for name, c in self.chunks.items():
            for m in LOADER_RE.finditer(c.src):
                board, chunk, exported = m.group(1), m.group(2), m.group(3)
                if board in out or chunk not in self.chunks:
                    continue
                local = self.chunks[chunk].exports.get(exported)
                r = local and self.resolve(chunk, local)
                if r:
                    out[board] = r
            for m in SWITCH_RE.finditer(c.src):
                board, local = m.group(1), m.group(2)
                if board in out:
                    continue
                r = self.resolve(name, local)
                if r:
                    out[board] = r
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dist", nargs="+", type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    args = ap.parse_args()

    devices = json.loads(DEVICES.read_text())
    by_name = {}
    for d in devices:
        by_name.setdefault(d["internalName"], []).append(d)

    found = {}
    for dist in args.dist:
        build = Build(dist)
        label = dist.resolve().parent.parent.name
        for board, (dazzle, normal, chunk) in build.boards().items():
            for d in by_name.get(board, []):
                found.setdefault(
                    str(d["id"]),
                    {
                        "board": d["displayName"],
                        "rainbow": dazzle,
                        "fixed": normal,
                        "source": f"{label}/{chunk}",
                    },
                )

    records = dict(sorted(found.items(), key=lambda kv: int(kv[0])))
    args.out.write_text(json.dumps(records, indent=1, ensure_ascii=False) + "\n")
    swapped = sorted(int(k) for k, r in records.items() if r["rainbow"] == 7)
    odd = sorted(int(k) for k, r in records.items() if r["rainbow"] not in (7, 8))
    print(f"{len(records)} of {len(devices)} boards -> {args.out}")
    print(f"  rainbow on 7: {len(swapped)} {swapped}")
    if odd:
        print(f"  neither 7 nor 8: {len(odd)} {odd}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
