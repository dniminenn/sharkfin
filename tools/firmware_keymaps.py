#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Read each board's factory keymap out of its own published firmware.

usage: firmware_keymaps.py [--ids ID ...] [--jobs N] [--cache DIR]
                           [--out FILE] [--dist-js DIR ...]

The vendor's update channel serves a firmware package per device id. The
keyboard image carries the factory keymap as a table of 4-byte slot
entries, the same bytes GET_KEYMATRIX returns, and the image's settings
area holds copies of it. This finds that table and records it per board,
so the extractor can attach slots to a picture from the board's own
firmware rather than from the vendor's JavaScript alone.

Finding the table. Where the vendor's JavaScript carries a keymap for the
board (`--dist-js`), its bytes are searched for in the image and the
table is read from where they sit: the JavaScript locates it, the
firmware supplies it, and a board whose firmware disagrees with its
JavaScript keeps the firmware's version. Without one, a 128-slot window
is accepted when it holds an Escape entry in its first sixteen slots, at
least 55 populated entries, every entry of a known type with a keyboard
usage where the type says so, and no more than six repeated plain
usages. The window's start is then the Escape entry, which is wrong for a
board whose first slot is empty (many 60% boards), so a window preceded by
four zero bytes is reported as unaligned and not recorded. Every image
tried yields one table under these rules.

Writes app/src-tauri/data/keymap-evidence.json, one record per board:
firmware version, image member, offset, copy count and the table. Packages
are cached under --cache so a rerun downloads nothing it already has.
"""
import argparse
import concurrent.futures
import datetime
import io
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from extract_vendor_data import first_default_matrix, load_loader_maps  # noqa: E402

API = "https://api2.rongyuan.tech:3816/api/v2/get_fw_version"
DOWNLOAD = "https://api2.rongyuan.tech:3816/download/"
DEVICES = ROOT / "app/src-tauri/data/devices.json"
OUT = ROOT / "app/src-tauri/data/keymap-evidence.json"

# Slot entry types the app knows (docs/PROTOCOL.md, Slot values) plus the
# ones seen in factory tables: 0 key, 1 mouse, 2 system, 3 consumer,
# 5 report rate, 8 profile, 9 macro, 10 special, 13 light, 14 link,
# 19 screen.
TYPES = {0, 1, 2, 3, 5, 8, 9, 10, 13, 14, 19}
ESC = b"\x00\x00\x29\x00"


def plausible(e):
    t, a, b, c = e
    if t == 0:
        return 4 <= b <= 0xE7
    return t in TYPES


def trim(table):
    """Drop trailing empty slots."""
    ents = [table[j : j + 4] for j in range(0, len(table), 4)]
    last = max((k for k, e in enumerate(ents) if any(e)), default=-1)
    return bytes(table[: (last + 1) * 4])


def anchored_table(image, js_matrix):
    """The 128-slot table at the offset where the vendor keymap's bytes sit,
    or None when the image does not carry them."""
    needle = trim(bytes(js_matrix))
    if len(needle) < 64:
        return None, None
    off = image.find(needle)
    if off < 0 or off + 512 > len(image):
        return None, None
    return trim(image[off : off + 512]), off


def find_tables(image, min_keys=55):
    """Distinct keymap tables in one image -> list of offsets, anchored on
    an Escape entry. `unaligned` collects starts preceded by an empty slot,
    where the table may begin one slot earlier."""
    n = len(image)
    by = {}
    for m in re.finditer(re.escape(ESC), image):
        for lead in range(16):
            start = m.start() - lead * 4
            if start < 0 or start + 512 > n:
                continue
            win = image[start : start + 512]
            ents = [tuple(win[j : j + 4]) for j in range(0, 512, 4)]
            nz = [e for e in ents if any(e)]
            if len(nz) < min_keys or not all(plausible(e) for e in nz):
                continue
            plain = [e[2] for e in nz if e[0] == 0 and e[1] == 0 and e[3] == 0]
            if len(plain) - len(set(plain)) > 6:
                continue
            last = max(k for k, e in enumerate(ents) if any(e))
            by.setdefault(bytes(win[: (last + 1) * 4]), []).append(start)
            break
    return by


def aligned(image, offsets):
    """False when every copy is preceded by an empty slot: the table may
    start there instead, and slot numbers would then be off by one."""
    return any(off < 4 or any(image[off - 4 : off]) for off in offsets)


def images(package):
    try:
        return {"raw": zlib.decompress(package, -15)}
    except zlib.error:
        pass
    try:
        z = zipfile.ZipFile(io.BytesIO(package))
        return {n: z.read(n) for n in z.namelist()}
    except (zipfile.BadZipFile, OSError, EOFError):
        return {}


def meta(dev_id, tries=3):
    """The channel's record for a board, None when it has none, "error" when
    the server would not say. A missing record arrives as HTTP 500 with
    "Record not found" in the body. Anything else, including the bare 400
    the server answers with once a burst of requests has annoyed it, is not
    an answer about the board and must not be read as one."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                API,
                data=json.dumps({"dev_id": dev_id}).encode(),
                headers={"Content-Type": "application/json"},
            )
            return json.loads(urllib.request.urlopen(req, timeout=30).read()).get("data")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code == 500 and "Record not found" in body:
                return None
            time.sleep(5 * (attempt + 1))
        except (OSError, ValueError):
            time.sleep(2 * (attempt + 1))
    return "error"


def fetch(dev_id, cache, none):
    """(version, package bytes) from cache or the channel; (None, None) if none.
    `none` is the set of ids the channel has said it has nothing for, kept
    in the cache dir so a rerun asks only about new boards."""
    hits = sorted(cache.glob(f"{dev_id}_*.pkg"))
    if hits:
        return hits[-1].stem.split("_", 1)[1], hits[-1].read_bytes()
    if dev_id in none:
        return None, None
    m = meta(dev_id)
    if m == "error":
        return "error", None
    if not m:
        none[dev_id] = datetime.date.today().isoformat()
        return None, None
    for attempt in range(3):
        try:
            raw = urllib.request.urlopen(DOWNLOAD + m["file_path"], timeout=180).read()
            (cache / f"{dev_id}_{m['version_str']}.pkg").write_bytes(raw)
            return m["version_str"], raw
        except (OSError, ValueError):
            time.sleep(2 * (attempt + 1))
    return "error", None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", type=int, nargs="*", help="only these device ids")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    ap.add_argument(
        "--cache", type=pathlib.Path, default=pathlib.Path.home() / "vendor-builds/firmware/pkg"
    )
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    ap.add_argument("--dist-js", type=pathlib.Path, action="append", default=[],
                    help="vendor builds whose keymaps anchor the table; repeatable")
    ap.add_argument("--refresh", action="store_true",
                    help="ask the channel again about boards it had nothing for")
    args = ap.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    none_path = args.cache / "none.json"
    none = {} if args.refresh or not none_path.is_file() else {
        int(k): v for k, v in json.loads(none_path.read_text(encoding="utf-8")).items()
    }
    loaders = load_loader_maps(args.dist_js) if args.dist_js else {}

    devices = {d["id"]: d for d in json.loads(DEVICES.read_text(encoding="utf-8"))}
    ids = args.ids or sorted(devices)
    records = {}
    if args.out.is_file():
        records = json.loads(args.out.read_text(encoding="utf-8"))

    absent, errors, ambiguous, empty, unaligned, found = [], [], [], [], [], []
    methods = {"anchored": 0, "escape": 0}

    def work(dev_id):
        version, raw = fetch(dev_id, args.cache, none)
        if raw is not None:
            time.sleep(args.delay)
        return dev_id, version, raw

    with concurrent.futures.ThreadPoolExecutor(args.jobs) as ex:
        for dev_id, version, raw in ex.map(work, ids):
            if version == "error":
                errors.append(dev_id)
                continue
            # Whatever this run decides replaces what an earlier run said.
            records.pop(str(dev_id), None)
            if raw is None:
                absent.append(dev_id)
                continue
            name = devices[dev_id]["name"]
            js = first_default_matrix(loaders[name]["chunks"]) if name in loaders else None
            members = images(raw)
            tab = member = offset = None
            copies = 0
            method = None
            if js:
                for m, image in members.items():
                    tab, offset = anchored_table(image, js)
                    if tab:
                        member, method = m, "anchored"
                        copies = image.count(tab)
                        break
            if not tab:
                tables = {}
                for m, image in members.items():
                    for t, offs in find_tables(image).items():
                        tables.setdefault(t, []).append((m, image, offs))
                if not tables:
                    empty.append(dev_id)
                    continue
                if len(tables) > 1:
                    ambiguous.append(dev_id)
                    continue
                tab, where = next(iter(tables.items()))
                member, image, offs = where[0]
                if not aligned(image, offs):
                    unaligned.append(dev_id)
                    continue
                offset, method = offs[0], "escape"
                copies = sum(len(o) for _, _, o in where)
            methods[method] += 1
            records[str(dev_id)] = {
                "board": devices[dev_id]["displayName"],
                "firmware": version,
                "image": member,
                "offset": offset,
                "copies": copies,
                "method": method,
                "matrix": list(tab),
            }
            found.append(dev_id)
            print(f"  {dev_id} {devices[dev_id]['displayName']}: {version} {member} "
                  f"@{offset:#x} x{copies} slots {len(tab)//4} {method}", flush=True)

    none_path.write_text(json.dumps({str(k): v for k, v in sorted(none.items())}, indent=1) + "\n", encoding="utf-8")
    records = dict(sorted(records.items(), key=lambda kv: int(kv[0])))
    args.out.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    print(f"{len(found)} boards read from firmware this run, {len(records)} recorded -> {args.out}")
    print(f"  table located by: {methods}")
    print(f"  no firmware published: {len(absent)}; server would not answer: {len(errors)} {errors[:10]}")
    print(f"  Escape-anchored table preceded by an empty slot (skipped): {unaligned}")
    if len(errors) > len(ids) // 10:
        print("  the channel answers 400 to a burst of requests; wait and rerun, the cache keeps what landed")
    print(f"  firmware with no recognisable table: {empty}")
    print(f"  firmware with two distinct tables (skipped): {ambiguous}")


if __name__ == "__main__":
    sys.exit(main())
