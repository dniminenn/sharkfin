#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Extract the ROYUAN/AttackShark device catalog from the vendor app bundle.

usage:
  extract_vendor_data.py BUNDLE_PRETTY_JS [--dist-js DIR]
      [--extras FILE] [--devices-out FILE] [--layouts-out DIR]

BUNDLE_PRETTY_JS is a prettified copy of the vendor webapp main bundle
(dist/js/index.*.js run through `npx prettier --parser babel`). --dist-js is
the vendor app's original dist/js directory (minified chunks); it is required
for protocol-family classification and layout matrix indices.

--dist-js is repeatable and results are unioned: each brand ships this same
driver with only its own devices' layouts bundled. Two sources cover the
catalogue as of 2026-07-26 -- any desktop installer (Attack Shark's, say) for
the defaultMatrix data, plus the hosted web build under gearhub.top/v4/js/,
which carries every referenced layout but almost no defaultMatrix. Order does
not matter: matrix lookup tries every build that claims a device until one
resolves. The web host wants a browser User-Agent.

Vendor builds are never committed. Unpack them outside the working tree and
point --dist-js at them there; what belongs in the repo is the generated
output, which this script reproduces.

The catalogue is not a superset of itself over time: boards get removed, and
some never appear at all. `data/devices.extra.json` (--extras) holds those by
hand and is merged in, so the generated registry is still reproducible from
the bundle plus that file. An extra whose id the bundle now carries is ignored
and reported, so it can be deleted. A test in app/src-tauri/src/registry.rs
fails if a regeneration drops one.

Outputs:
  devices.json  - every type:"keyboard" registry entry, deduped by id, plus
                  --extras entries the bundle does not carry
  layouts dir   - one <keyLayoutName>.json per extractable *_keymappings_ui_info
                  object (Common80_k72x86 is skipped: src/lib/layouts/x86.json
                  is canonical)

Family derivation (printed per run): each device name is looked up in the
lazy-loader maps inside the dist chunks (name -> import("<chunk>") with a
static dependency preload list). A dep list containing 438d24dc.js
(CommonKbYc500) => "yc500"; containing 5e635fe2.js (the generic keyboard base)
=> "gen2"; both/neither/no loader entry => "unknown". sharkfin enables writes
for "yc500" and "gen2". "unknown" is read-only: see KNOWN_FAMILIES in
app/src-tauri/src/registry.rs.
"""

import argparse
import json
import re
import sys
from pathlib import Path


class ParseError(Exception):
    pass


IDENT_RE = re.compile(r"[^\W\d][\w$]*(?:\.[^\W\d][\w$]*)*|\$[\w$]*")
NUM_RE = re.compile(r"-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?")


class JsValueParser:
    """Parses the JS literal subset used by the vendor data tables: objects
    with identifier/string/computed keys, strings, numbers (with constant
    * / + - arithmetic, e.g. 1 * 60 * 60), arrays, !0/!1, bare identifier
    references (returned as {"$ident": name})."""

    def __init__(self, text, pos=0):
        self.t = text
        self.i = pos

    def ws(self):
        t, n = self.t, len(self.t)
        while self.i < n:
            c = t[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif t.startswith("//", self.i):
                j = t.find("\n", self.i)
                self.i = n if j < 0 else j + 1
            elif t.startswith("/*", self.i):
                j = t.find("*/", self.i + 2)
                if j < 0:
                    raise ParseError("unterminated comment")
                self.i = j + 2
            else:
                return

    def peek(self):
        self.ws()
        if self.i >= len(self.t):
            raise ParseError("eof")
        return self.t[self.i]

    def value(self):
        c = self.peek()
        if c == "{":
            return self.object()
        if c == "[":
            return self.array()
        if c in "\"'`":
            return self.string()
        if c == "!":
            self.i += 1
            v = self.value()
            return not v
        if c.isdigit() or c in "-.":
            return self.number_expr()
        m = IDENT_RE.match(self.t, self.i)
        if not m:
            raise ParseError(f"unexpected {c!r} at {self.i}")
        name = m.group(0)
        self.i = m.end()
        if name == "true":
            return True
        if name == "false":
            return False
        if name == "null":
            return None
        if name == "new":
            return self.value()
        if name == "void":
            self.ws()
            m2 = NUM_RE.match(self.t, self.i)
            if m2:
                self.i = m2.end()
            return None
        self.ws()
        if self.i < len(self.t) and self.t[self.i] == "(":
            self.skip_parens()
            return {"$call": name}
        return {"$ident": name}

    def skip_parens(self):
        depth = 0
        t, n = self.t, len(self.t)
        while self.i < n:
            c = t[self.i]
            if c in "\"'`":
                self.string()
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    self.i += 1
                    return
            self.i += 1
        raise ParseError("unterminated parens")

    def number_expr(self):
        v = self.number()
        while True:
            self.ws()
            if self.i >= len(self.t):
                return v
            op = self.t[self.i]
            if op not in "*/+-":
                return v
            save = self.i
            self.i += 1
            try:
                rhs = self.number()
            except ParseError:
                self.i = save
                return v
            if op == "*":
                v *= rhs
            elif op == "/":
                v = float("inf") if rhs == 0 else v / rhs
            elif op == "+":
                v += rhs
            else:
                v -= rhs

    def number(self):
        self.ws()
        m = NUM_RE.match(self.t, self.i)
        if not m:
            raise ParseError(f"expected number at {self.i}")
        self.i = m.end()
        s = m.group(0)
        return float(s) if ("." in s or "e" in s or "E" in s) else int(s)

    def string(self):
        q = self.t[self.i]
        self.i += 1
        out = []
        t, n = self.t, len(self.t)
        while self.i < n:
            c = t[self.i]
            if c == "\\":
                e = t[self.i + 1]
                esc = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "0": "\0"}
                if e == "u":
                    if t[self.i + 2] == "{":
                        j = t.index("}", self.i + 3)
                        out.append(chr(int(t[self.i + 3 : j], 16)))
                        self.i = j + 1
                    else:
                        out.append(chr(int(t[self.i + 2 : self.i + 6], 16)))
                        self.i += 6
                elif e == "x":
                    out.append(chr(int(t[self.i + 2 : self.i + 4], 16)))
                    self.i += 4
                else:
                    out.append(esc.get(e, e))
                    self.i += 2
            elif c == q:
                self.i += 1
                return "".join(out)
            else:
                out.append(c)
                self.i += 1
        raise ParseError("unterminated string")

    def array(self):
        self.i += 1
        out = []
        while True:
            c = self.peek()
            if c == "]":
                self.i += 1
                return out
            out.append(self.value())
            c = self.peek()
            if c == ",":
                self.i += 1
            elif c != "]":
                raise ParseError(f"bad array at {self.i}")

    def object(self):
        self.i += 1
        out = {}
        while True:
            c = self.peek()
            if c == "}":
                self.i += 1
                return out
            if c in "\"'":
                key = self.string()
            elif c == "[":
                self.i += 1
                v = self.value()
                key = v["$ident"] if isinstance(v, dict) and "$ident" in v else str(v)
                if self.peek() != "]":
                    raise ParseError(f"bad computed key at {self.i}")
                self.i += 1
            else:
                m = IDENT_RE.match(self.t, self.i)
                if not m:
                    raise ParseError(f"bad key at {self.i}")
                key = m.group(0)
                self.i = m.end()
            if self.peek() != ":":
                raise ParseError(f"expected : at {self.i}")
            self.i += 1
            out[key] = self.value()
            c = self.peek()
            if c == ",":
                self.i += 1
            elif c != "}":
                raise ParseError(f"bad object at {self.i}")


def parse_object_at(text, pos):
    p = JsValueParser(text, pos)
    return p.object(), p.i


def ident_name(v):
    """`c.Common82_SG9000` -> `Common82_SG9000`. The enum object's minified
    name changes between builds (`c` in July, `u` in September), so strip
    any single identifier prefix rather than one letter."""
    if isinstance(v, dict) and "$ident" in v:
        return re.sub(r"^[A-Za-z_$][\w$]*\.", "", v["$ident"])
    return v


def as_str(v, default=""):
    return v if isinstance(v, str) else default


def extract_registry(bundle):
    devices, seen_spans = [], set()
    for m in re.finditer(r"\bid:\s*\d+\s*,", bundle):
        j = m.start() - 1
        while j >= 0 and bundle[j] in " \t\r\n":
            j -= 1
        if j < 0 or bundle[j] != "{" or j in seen_spans:
            continue
        try:
            obj, _ = parse_object_at(bundle, j)
        except (ParseError, ValueError, IndexError):
            continue
        if not {"id", "vid", "pid", "name", "type"} <= obj.keys():
            continue
        seen_spans.add(j)
        devices.append(obj)
    return devices


ENUM_UI_RE = re.compile(
    r'\[[A-Za-z_$][\w$]*\.(\w+)\]:\s*"(\w+_keymappings_ui_info)"'
)


def extract_enum_ui_map(bundle, dists=()):
    """keyLayout enum -> ui_info name.

    The enum variable is minified per build, and some builds keep this map in a
    chunk rather than the main bundle, so match any identifier prefix and scan
    the chunks too.
    """
    mapping = dict(ENUM_UI_RE.findall(bundle))
    for dist in dists or ():
        for f in sorted(dist.glob("*.js")):
            text = f.read_text(encoding="utf-8", errors="replace")
            if "_keymappings_ui_info" not in text:
                continue
            for k, v in ENUM_UI_RE.findall(text):
                mapping.setdefault(k, v)
    return mapping


def extract_enum_keys(bundle):
    # The enum is built as `(e.Name = "value")` inside an IIFE whose
    # parameter is minified per build, so match any short identifier.
    return set(re.findall(r'\(\w{1,2}\.(\w+) =\s*\n?\s*"', bundle)) | set(
        re.findall(r'\b\w{1,2}\.(\w+) = "', bundle)
    )


def extract_hid_table(bundle):
    table = {}
    for m in re.finditer(r'htmlCode:\s*"(\w+)"', bundle):
        j = bundle.rfind("{", 0, m.start())
        try:
            obj, _ = parse_object_at(bundle, j)
        except (ParseError, ValueError, IndexError):
            continue
        code, hid = obj.get("htmlCode"), obj.get("hidCode")
        if isinstance(code, str) and isinstance(hid, int) and code not in table:
            table[code] = hid
    return table


LOADER_RE = re.compile(
    r'([A-Za-z0-9_$]+):\(\)=>[\w$]+\(\(\)=>import\("\./([0-9a-f]{8}\.js)"\),\[([^\]]*)\]'
)


def load_loader_maps(dists):
    """Union across builds; each brand's build only bundles its own devices.

    A device can appear in several builds pointing at different chunk files,
    and only some of those chunks carry a defaultMatrix -- the hosted web build
    in particular has almost none. Keep every candidate so matrix lookup can
    fall through instead of binding to whichever build happened to be last.
    """
    loaders = {}
    for dist in dists:
        for name, (chunk, deps) in _load_loader_maps_one(dist).items():
            entry = loaders.setdefault(name, {"deps": set(), "chunks": []})
            entry["deps"] |= deps
            if (dist, chunk) not in entry["chunks"]:
                entry["chunks"].append((dist, chunk))
    return loaders


def _load_loader_maps_one(dist):
    loaders = {}
    for f in sorted(dist.glob("*.js")):
        text = f.read_text(encoding="utf-8", errors="replace")
        for m in LOADER_RE.finditer(text):
            name, chunk, deps_raw = m.groups()
            deps = set(re.findall(r'"\./([^"]+)"', deps_raw)) | {chunk}
            loaders.setdefault(name, (chunk, deps))
    return loaders


def find_base_chunks(dists):
    """Locate each family's base class chunk by opcode signature.

    Chunk filenames are content hashes and the class names are minified away
    in some builds, so neither is a stable marker. The keymatrix opcode is:
    the yc500 base declares 9, its gen2 sibling declares 10.
    """
    yc500, gen2 = set(), set()
    for dist in dists:
        for f in sorted(dist.glob("*.js")):
            text = f.read_text(encoding="utf-8", errors="replace")
            if "FEA_CMD_SET_KEYMATRIX" not in text:
                continue
            vals = set(re.findall(r"FEA_CMD_SET_KEYMATRIX\s*=\s*(\d+)", text))
            if "9" in vals:
                yc500.add(f.name)
            if "10" in vals:
                gen2.add(f.name)
    return yc500, gen2


def classify_family(deps, bases=None):
    if bases:
        yc500, gen2 = bases
        y, g = bool(deps & yc500), bool(deps & gen2)
    else:
        y, g = "438d24dc.js" in deps, "5e635fe2.js" in deps
    if y and not g:
        return "yc500"
    if g and not y:
        return "gen2"
    return "unknown"


EXPORT_RE = re.compile(r"export\s*\{([^}]*)\}")


def extract_ui_defs(dists):
    defs = {}
    for dist in dists:
        for k, v in _extract_ui_defs_one(dist).items():
            defs.setdefault(k, v)
    return defs


def _extract_ui_defs_one(dist):
    defs = {}
    for f in sorted(dist.glob("*.js")):
        text = f.read_text(encoding="utf-8", errors="replace")
        if "_keymappings_ui_info" not in text:
            continue
        for em in EXPORT_RE.finditer(text):
            for part in em.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                toks = part.split()
                local, exported = (
                    (toks[0], toks[2]) if len(toks) == 3 and toks[1] == "as" else (toks[0], toks[0])
                )
                if not exported.endswith("_keymappings_ui_info") or exported in defs:
                    continue
                for dm in re.finditer(
                    r"(?<![\w$.])" + re.escape(local) + r"\s*=\s*\{", text
                ):
                    try:
                        obj, _ = parse_object_at(text, dm.end() - 1)
                    except (ParseError, ValueError, IndexError):
                        continue
                    if isinstance(obj.get("layout"), dict) and "width" in obj:
                        defs[exported] = (obj, f.name)
                        break
    return defs


def first_default_matrix(candidates):
    """First chunk across all builds that actually yields a defaultMatrix."""
    for dist, chunk in candidates:
        mat = extract_default_matrix(dist, chunk)
        if mat:
            return mat
    return None


def extract_default_matrix(dist, chunk, cache={}):
    key = (str(dist), chunk)
    if key in cache:
        return cache[key]
    path = dist / chunk
    result = None
    if path.exists():
        text = path.read_text(encoding="utf-8", errors="replace")
        ms = re.findall(r"defaultMatrix=\[([\d,\s]*)\]", text)
        if len(ms) == 1:
            vals = [int(x) for x in ms[0].split(",") if x.strip()]
            if vals and len(vals) % 4 == 0:
                result = vals
    cache[key] = result
    return result


def hid_to_matrix(hid):
    if hid <= 255:
        return [0, 0, hid, 0]
    return [(hid >> 24) & 255, (hid >> 16) & 255, (hid >> 8) & 255, hid & 255]


def build_layout(ui, hid_table, matrix, report):
    canvas = {"width": ui["width"], "height": ui["height"]}
    slots = None
    if matrix:
        slots = [tuple(matrix[i : i + 4]) for i in range(0, len(matrix), 4)]
    keys, used_slots, entry_counts = [], set(), {}
    for code, info in ui["layout"].items():
        if not isinstance(info, dict) or "x" not in info:
            continue
        dt = info.get("displayText")
        text = "\n".join(dt) if isinstance(dt, list) and dt else None
        hid = hid_table.get(code)
        entry = hid_to_matrix(hid) if hid is not None else None
        if entry is None:
            report.setdefault("unmapped_codes", []).append(code)
        hid_usage = hid if hid is not None and hid <= 255 else None
        consumer = None
        if entry and entry[0] == 3:
            consumer = entry[2] | (entry[3] << 8)
        idx = None
        if slots and entry:
            et = tuple(entry)
            nth = entry_counts.get(et, 0)
            entry_counts[et] = nth + 1
            hits = [s for s, v in enumerate(slots) if v == et]
            if nth < len(hits):
                idx = hits[nth]
                used_slots.add(idx)
            if len(hits) > 1:
                report.setdefault("duplicate_entries", set()).add(code)
        keys.append(
            {
                "code": code,
                "type": info.get("type"),
                "x": info["x"],
                "y": info["y"],
                "w": info.get("width"),
                "h": info.get("height"),
                "text": text,
                "matrixIndex": idx,
                "matrixEntry": entry,
                "hidUsage": hid_usage,
                "consumerUsage": consumer,
            }
        )
    if slots:
        keys.sort(key=lambda k: (k["matrixIndex"] is None, k["matrixIndex"] or 0))
    out = {"canvas": canvas, "keys": keys}
    if slots:
        out["matrixEntriesWithoutUIKey"] = [
            {"matrixIndex": s, "entry": list(v)}
            for s, v in enumerate(slots)
            if any(v) and s not in used_slots
        ]
    return out


def dump_layout(layout):
    # `local` first and always preserved: it is what stops the next
    # extraction deleting a hand-maintained layout, so a tool that rewrites
    # one must not drop it.
    lines = ["{"]
    if layout.get("local"):
        lines.append(' "local": true,')
    lines += [' "canvas": ' + json.dumps(layout["canvas"], separators=(",", ":")) + ",", ' "keys": [']
    keylines = [
        "  " + json.dumps(k, separators=(",", ":"), ensure_ascii=False)
        for k in layout["keys"]
    ]
    lines.append(",\n".join(keylines))
    if "matrixEntriesWithoutUIKey" in layout:
        lines.append(" ],")
        lines.append(
            ' "matrixEntriesWithoutUIKey": '
            + json.dumps(layout["matrixEntriesWithoutUIKey"], separators=(",", ":"))
        )
    else:
        lines.append(" ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


SVG_MAPPING_RE = re.compile(
    r'Keyboard_([A-Za-z0-9_]+?)_KeyMappings:\{type:"svg",'
    r'str:await [\w$]+\(\(\)=>import\("\./([0-9a-f]{8}\.js)"\)'
)


def svg_to_ui(js_text):
    """Newer layouts ship as an SVG scene: one state layer per interaction
    state, one <g id="#Code"> per key, the key's rect first in the group.
    The pixel conventions match the old ui_info objects, so the result is
    fed through build_layout unchanged."""
    m = re.search(r"`(<svg .*)`", js_text, re.S)
    if not m:
        return None
    svg = m.group(1)
    default = re.search(r'<svg [^>]*id="default".*?</svg>', svg, re.S)
    if not default:
        return None
    scene = default.group(0)
    size = re.match(r'<svg [^>]*width="(\d+)" height="(\d+)"', svg)
    if not size:
        return None
    layout = {}
    for g in re.finditer(r'<g id="#([A-Za-z0-9]+)">(.*?)</g>', scene, re.S):
        code, body = g.group(1), g.group(2)
        rect = re.search(
            r'<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"',
            body,
        )
        if not rect or code in layout:
            continue
        text = re.findall(r"<tspan[^>]*>([^<]*)</tspan>", body)
        layout[code] = {
            "x": round(float(rect.group(1))),
            "y": round(float(rect.group(2))),
            "width": round(float(rect.group(3))),
            "height": round(float(rect.group(4))),
            "type": "key",
            "displayText": text or None,
        }
    if not layout:
        return None
    return {"width": int(size.group(1)), "height": int(size.group(2)), "layout": layout}


def extract_svg_ui_defs(dists):
    defs = {}
    for dist in dists or ():
        for f in sorted(dist.glob("*.js")):
            text = f.read_text(encoding="utf-8", errors="replace")
            if '_KeyMappings:{type:"svg"' not in text:
                continue
            for m in SVG_MAPPING_RE.finditer(text):
                name, chunk = m.groups()
                if name in defs:
                    continue
                path = dist / chunk
                if not path.is_file():
                    continue
                ui = svg_to_ui(path.read_text(encoding="utf-8", errors="replace"))
                if ui:
                    defs[name] = (ui, f.name)
    return defs


def convention_ui_name(enum_key, ui_defs):
    m = re.match(r"(?:Common|Special)(\d+)_(.+)", enum_key)
    if not m:
        return None
    cand = f"keyboard_{m.group(1)}_{m.group(2).lower()}_keymappings_ui_info"
    if cand in ui_defs:
        return cand
    # The vendor snake_cases enum keys inconsistently (FreeWolfF68 becomes
    # freewolf_f68, not free_wolf_f68), so compare with separators stripped.
    # Only a unique collision is trusted.
    want = f"{m.group(1)}{m.group(2)}".replace("_", "").lower()
    hits = [
        n
        for n in ui_defs
        if re.sub(r"^keyboard_|_keymappings_ui_info$", "", n).replace("_", "") == want
    ]
    return hits[0] if len(hits) == 1 else None


# Exactly the keys this script writes per device, so an override cannot
# name a field the registry does not have (`keylayout`) and be ignored.
KNOWN_DEVICE_FIELDS = {
    "id", "name", "displayName", "company", "vendor", "vendorId", "productId",
    "internalName", "keyLayout", "lightLayout", "sideLightLayout", "profiles",
    "magnetic", "family", "features", "screen",
}


def screen_spec(raw):
    """A board's display, or None.

    The vendor records geometry per board, not per family: 128x128, 160x80,
    240x135 and 320x172 all appear, and one board reports 11x7 in mode 24,
    which is an LED matrix driven by the same commands. Mode 16 is RGB565,
    24 is three bytes a pixel. Nothing writes to a screen yet; this is here
    so that when something does, it does not guess the size.
    """
    if not isinstance(raw, dict):
        return None
    size = raw.get("size")
    if not isinstance(size, dict):
        return None
    w, h = size.get("w"), size.get("h")
    if not isinstance(w, int) or not isinstance(h, int) or w < 1 or h < 1:
        return None
    layers = raw.get("layer")
    return {
        "w": w,
        "h": h,
        "mode": raw["mode"] if isinstance(raw.get("mode"), str) else "16",
        "layers": len(layers) if isinstance(layers, list) else 1,
    }


def load_extras(path):
    """Hand-maintained entries the bundle cannot supply.

    Three cases. A board the vendor has removed from its catalogue, and a
    board it never listed but which answered a read sweep on real hardware:
    both are added whole. And a board the bundle does carry but describes
    wrongly, marked `_override`, where only the named fields are replaced.
    An override is the narrow tool: the vendor points several boards at one
    layout even when their own factory keymaps prove they differ.

    Keys beginning with `_` are notes for the next reader and are stripped
    here, so the generated registry stays uniform.
    """
    if not path or not path.is_file():
        return [], {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    adds, overrides, seen = [], {}, []
    for e in raw:
        rec = {k: v for k, v in e.items() if not k.startswith("_")}
        if "id" not in rec:
            raise SystemExit(f"{path}: an entry has no id: {sorted(e)}")
        seen.append(rec["id"])
        if e.get("_override"):
            unknown = set(rec) - KNOWN_DEVICE_FIELDS
            if unknown:
                raise SystemExit(
                    f"{path}: override {rec['id']} names fields the registry does not "
                    f"have: {sorted(unknown)}"
                )
            overrides[rec["id"]] = rec
        else:
            adds.append(rec)
    ids = seen
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise SystemExit(f"{path}: duplicate ids {sorted(dupes)}")
    return adds, overrides


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    ap.add_argument(
        "--dist-js",
        type=Path,
        action="append",
        default=None,
        help="an unpacked build's dist/js dir; repeat to union several brands' builds",
    )
    here = Path(__file__).resolve().parent
    ap.add_argument(
        "--extras",
        type=Path,
        default=here.parent / "app/src-tauri/data/devices.extra.json",
        help="hand-maintained entries for boards the bundle does not carry",
    )
    ap.add_argument(
        "--matrix-evidence",
        type=Path,
        default=here.parent / "app/src-tauri/data/matrix-evidence.json",
        help="firmware confirmations from tools/verify_matrix.py",
    )
    ap.add_argument("--devices-out", type=Path, default=here.parent / "app/src-tauri/data/devices.json")
    ap.add_argument("--layouts-out", type=Path, default=here.parent / "app/src/lib/layouts/vendor")
    args = ap.parse_args()

    bundle = args.bundle.read_text(encoding="utf-8", errors="replace")
    raw = extract_registry(bundle)
    keyboards = [d for d in raw if d.get("type") == "keyboard"]

    loaders, bases = {}, None
    if args.dist_js:
        loaders = load_loader_maps(args.dist_js)
        bases = find_base_chunks(args.dist_js)

    seen, devices, collisions = {}, [], []
    for d in keyboards:
        did = d["id"]
        if did in seen:
            collisions.append(did)
            continue
        seen[did] = d
        other = d.get("other") or {}
        if not isinstance(other, dict):
            other = {}
        magnetic = bool(d.get("magnetism"))
        family = "unknown"
        if d["name"] in loaders:
            family = classify_family(loaders[d["name"]]["deps"], bases)
        knob = other.get("knobKeyCodes")
        if isinstance(knob, list):
            knob = [k for k in knob if isinstance(k, str)]
        screen = screen_spec(other.get("screen"))
        company = as_str(d.get("company"))
        devices.append(
            {
                "id": did,
                "name": d["name"],
                "displayName": as_str(d.get("displayName"), d["name"]),
                "company": company,
                "vendor": company,
                # The vendor writes some ids in exponential form (`pid: 1e3`),
                # which parses as a float and then formats as `1000.0` instead
                # of a hex USB id.
                "vendorId": int(d["vid"]),
                "productId": int(d["pid"]),
                "internalName": d["name"],
                "keyLayout": as_str(ident_name(d.get("keyLayout")), "Unknown"),
                "lightLayout": as_str(ident_name(d.get("lightLayout"))),
                "sideLightLayout": as_str(ident_name(d.get("sideLightLayout"))),
                "profiles": d.get("layer") if isinstance(d.get("layer"), int) else 1,
                "magnetic": magnetic,
                "family": family,
                "screen": screen,
                "features": {
                    "knob": knob if isinstance(knob, list) else [],
                    "debounce": "deBounce" in other,
                    "sleep24": bool(other.get("sleep24")),
                    "sleepBT": bool(other.get("sleepBT")),
                    "magneticSwitches": magnetic,
                    "screen": bool(other.get("screen")),
                    # Physical edge light. The firmware answers 0x88 whether or
                    # not the board has one, so the registry is the authority.
                    "sideLight": d.get("sideLightLayout") is not None,
                },
            }
        )
    extras, overrides = load_extras(args.extras)
    from_bundle = {d["id"] for d in devices}
    redundant = [e["id"] for e in extras if e["id"] in from_bundle]
    devices.extend(e for e in extras if e["id"] not in from_bundle)

    applied = []
    for d in devices:
        patch = overrides.get(d["id"])
        if not patch:
            continue
        for k, v in patch.items():
            if k != "id":
                d[k] = v
        applied.append(d["id"])
    stale = sorted(set(overrides) - {d["id"] for d in devices})

    devices.sort(key=lambda d: d["id"])
    args.devices_out.parent.mkdir(parents=True, exist_ok=True)
    args.devices_out.write_text(
        json.dumps(devices, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    if extras:
        kept = [e["id"] for e in extras if e["id"] not in from_bundle]
        print(f"  extras merged from {args.extras.name}: {sorted(kept)}")
    if redundant:
        print(
            f"  extras now in the bundle, delete them from {args.extras.name}: "
            f"{sorted(set(redundant))}"
        )
    if applied:
        print(f"  overrides applied from {args.extras.name}: {sorted(applied)}")
    if stale:
        print(
            f"  overrides for ids the bundle no longer has, delete them from "
            f"{args.extras.name}: {stale}"
        )

    fam_counts = {}
    for d in devices:
        fam_counts[d["family"]] = fam_counts.get(d["family"], 0) + 1

    print(f"devices: {len(devices)} keyboards written to {args.devices_out}")
    print(f"  raw keyboard entries: {len(keyboards)}, id collisions dropped: {sorted(set(collisions))}")
    print(f"  family (from loader-map deps in dist chunks): {fam_counts}")
    if not args.dist_js:
        print("  NOTE: no --dist-js given; every family is 'unknown'")

    if not args.dist_js:
        return

    ui_map = extract_enum_ui_map(bundle, args.dist_js or ())
    ui_defs = extract_ui_defs(args.dist_js)
    hid_table = extract_hid_table(bundle)
    # September's build labels one board's Print Screen key "PrtSc", a code
    # the vendor's own HID table lacks. It is the same key.
    if "PrintScreen" in hid_table:
        hid_table.setdefault("PrtSc", hid_table["PrintScreen"])
    enum_keys = extract_enum_keys(bundle)

    # Newer layouts ship as SVG scenes instead of ui_info objects, and a
    # revision-suffixed enum (beat75_v2) renders its base revision's scene,
    # so unmapped enums retry with the suffix stripped.
    svg_defs = extract_svg_ui_defs(args.dist_js)

    def norm(s):
        return re.sub(r"[^a-z0-9]", "", s.lower())

    svg_by_norm = {}
    for n in svg_defs:
        svg_by_norm.setdefault(norm(n), []).append(n)

    def resolve(key):
        cand = convention_ui_name(key, ui_defs)
        if cand:
            return cand
        m = re.match(r"(?:Common|Special)(\d+)(?:_(.+))?$", key)
        want = norm(f"{m.group(1)}_{m.group(2) or ''}") if m else norm(key)
        hits = svg_by_norm.get(want, [])
        if len(hits) != 1:
            return None
        pseudo = f"svg:{hits[0]}"
        ui_defs[pseudo] = svg_defs[hits[0]]
        return pseudo

    svg_used, rev_used = [], []
    for k in enum_keys:
        if k in ui_map:
            continue
        tried = [k]
        stripped = re.sub(r"_(?:[vV]\d+|\d+)$", "", k)
        while stripped not in tried:
            tried.append(stripped)
            stripped = re.sub(r"_(?:[vV]\d+|\d+)$", "", stripped)
        for key_try in tried:
            r = resolve(key_try)
            if r:
                ui_map[k] = r
                if r.startswith("svg:"):
                    svg_used.append(k)
                if key_try != k:
                    rev_used.append(f"{k}<-{key_try}")
                break
    if svg_defs:
        print(f"  svg scenes found: {len(svg_defs)}, used for: {sorted(svg_used)}")
    if rev_used:
        print(f"  revision enums mapped to their base geometry: {sorted(rev_used)}")

    # Last resort: an unmapped enum whose board's own name appears in exactly
    # one same-key-count ui name (device CK100 with layout Common100 pairs
    # with keyboard_100_ck100_keymappings_ui_info).
    def core(n):
        return norm(re.sub(r"^(svg:|keyboard_)|_keymappings_ui_info$", "", n))

    byname_used = []
    for k in enum_keys:
        if k in ui_map:
            continue
        m = re.match(r"(?:Common|Special)(\d+)", k)
        if not m:
            continue
        num = m.group(1)
        boards = {
            norm(str(d.get(f) or ""))
            for d in devices
            if d["keyLayout"] == k
            for f in ("internalName", "displayName", "name")
        }
        boards = {b for b in boards if len(b) >= 4}
        pool = {n for n in ui_defs if core(n).startswith(num)} | {
            f"svg:{n}" for n in svg_defs if core(f"svg:{n}").startswith(num)
        }
        hits = {n for n in pool for b in boards if b in core(n)}
        # The same scene can exist in both worlds; that is one candidate,
        # and the ui_info form wins.
        if len({core(n) for n in hits}) != 1:
            continue
        hit = min(hits, key=lambda n: n.startswith("svg:"))
        if hit.startswith("svg:") and hit not in ui_defs:
            ui_defs[hit] = svg_defs[hit[4:]]
        ui_map[k] = hit
        byname_used.append(f"{k}<-{hit}")
    if byname_used:
        print(f"  enums mapped by board name: {sorted(byname_used)}")

    # A slot index decides which physical key a write lands on, so the
    # matrix behind it needs evidence, not just the vendor's JavaScript.
    # yc500's tables are round-tripped on hardware; every other family
    # needs its layout confirmed byte for byte inside a board's own
    # firmware image, which tools/verify_matrix.py records.
    evidence = {}
    if args.matrix_evidence and args.matrix_evidence.is_file():
        evidence = json.loads(args.matrix_evidence.read_text(encoding="utf-8"))

    matrices_by_layout = {}
    for d in devices:
        if d["name"] not in loaders:
            continue
        if d["family"] != "yc500" and d["keyLayout"] not in evidence:
            continue
        mat = first_default_matrix(loaders[d["name"]]["chunks"])
        if mat:
            matrices_by_layout.setdefault(d["keyLayout"], set()).add(tuple(mat))

    # A confirmed matrix is the one the firmware carries, so it settles any
    # disagreement between sibling devices rather than joining it.
    for name, rec in evidence.items():
        matrices_by_layout[name] = {tuple(rec["matrix"])}
    if evidence:
        print(f"  firmware-confirmed matrices applied: {len(evidence)}")

    # Clear stale output: layouts accumulate across runs otherwise, and the
    # committed set must be exactly what the current sources reproduce. A
    # layout marked `"local": true` is hand-maintained from hardware a
    # bundle cannot describe, so it is neither deleted nor overwritten.
    args.layouts_out.mkdir(parents=True, exist_ok=True)
    local = set()
    for old_layout in args.layouts_out.glob("*.json"):
        try:
            parsed = json.loads(old_layout.read_text(encoding="utf-8"))
        except (ValueError, OSError) as e:
            # Deleting what cannot be read would throw away a hand-made
            # layout over a stray comma.
            raise SystemExit(f"{old_layout}: cannot read, refusing to clear the directory ({e})")
        if isinstance(parsed, dict) and parsed.get("local") is True:
            local.add(old_layout.stem)
            continue
        old_layout.unlink()
    if local:
        print(f"  local layouts kept: {sorted(local)}")
    clash = sorted(local & set(ui_map))
    if clash:
        raise SystemExit(
            "local layouts share a name with a vendor layout, which would "
            f"replace it for every board pointing there: {clash}"
        )
    written, no_matrix, ambiguous = [], [], []
    for enum_key, ui_name in sorted(ui_map.items()):
        if enum_key == "Common80_k72x86" or enum_key in local:
            continue
        if ui_name not in ui_defs:
            continue
        ui, _chunk = ui_defs[ui_name]
        mats = matrices_by_layout.get(enum_key, set())
        matrix = None
        if len(mats) == 1:
            matrix = list(next(iter(mats)))
        elif len(mats) > 1:
            ambiguous.append(enum_key)
        else:
            no_matrix.append(enum_key)
        report = {}
        layout = build_layout(ui, hid_table, matrix, report)
        # A scene whose groups the parser did not recognise yields no keys.
        # An empty picture is worse than none: the app draws a slot grid
        # for a board without one and refuses an empty file.
        if not layout["keys"]:
            print(f"  {enum_key}: scene parsed to no keys, not written")
            continue
        (args.layouts_out / f"{enum_key}.json").write_text(
            dump_layout(layout), encoding="utf-8"
        )
        written.append(enum_key)
        for code in report.get("unmapped_codes", []):
            print(f"  {enum_key}: no hid mapping for UI key {code!r} (matrixEntry=null)")
        if report.get("duplicate_entries"):
            print(
                f"  {enum_key}: duplicate default-matrix entries for "
                f"{sorted(report['duplicate_entries'])} (nth-occurrence slot assignment)"
            )

    mapped_uis = set(ui_map.values())
    orphans = sorted(set(ui_defs) - mapped_uis - {"keyboard_80_k72x86_keymappings_ui_info"})
    for ui_name in orphans:
        layout = build_layout(ui_defs[ui_name][0], hid_table, None, {})
        if not layout["keys"]:
            continue
        (args.layouts_out / f"{ui_name}.json").write_text(
            dump_layout(layout), encoding="utf-8"
        )
    unbundled = sorted(
        set(re.findall(r"\b(\w+_keymappings_ui_info)\b", bundle)) - set(ui_defs)
    )

    print(f"layouts: {len(written)} written to {args.layouts_out}")
    print("  matrix indices come from the defaultMatrix of yc500-family devices only")
    print(f"  geometry+matrix: {len(written) - len(no_matrix) - len(ambiguous)}")
    print(f"  geometry only (no yc500 device with a resolvable defaultMatrix): {sorted(no_matrix)}")
    print(f"  geometry only (yc500 devices disagree on defaultMatrix): {sorted(ambiguous)}")
    if orphans:
        print(
            "  ui_info objects with no keyLayout mapping, written under their own name "
            f"(geometry only): {orphans}"
        )
    print(f"  ui_info names referenced but never bundled (unextractable): {len(unbundled)}")


if __name__ == "__main__":
    sys.exit(main())
