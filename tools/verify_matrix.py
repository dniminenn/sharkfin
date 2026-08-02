#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Confirm a layout's defaultMatrix against the device's own firmware.

usage: verify_matrix.py --dist-js DIR [--dist-js DIR] [--layout NAME]
                        [--out FILE] [--limit N]

The extractor reads each layout's factory keymap (`defaultMatrix`) out of
the vendor's JavaScript. That is evidence enough to draw a picture, not to
decide which physical key a slot addresses: the vendor's JavaScript has
been wrong before, and a wrong slot sends a remap to the wrong key.

The vendor's own update channel publishes each board's firmware, and the
firmware carries that same table verbatim. This finds it there. A layout
whose matrix appears byte for byte inside a board that uses it is
confirmed by the device's own firmware, which is the bar CONTRIBUTING sets
for a write path.

Writes app/src-tauri/data/matrix-evidence.json: one record per confirmed
layout naming the board, its firmware version and the offset, so the
extractor can bake slot data without re-downloading anything and a reader
can check the claim.
"""
import argparse
import concurrent.futures
import json
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from extract_vendor_data import (  # noqa: E402
    extract_default_matrix,
    load_loader_maps,
)

API = "https://api2.rongyuan.tech:3816/api/v2/get_fw_version"
DOWNLOAD = "https://api2.rongyuan.tech:3816/download/"
ROOT = pathlib.Path(__file__).resolve().parent.parent
DEVICES = ROOT / "app/src-tauri/data/devices.json"


def firmware(dev_id, tries=3):
    """The board's current firmware image, or None.

    Single-version packages are raw DEFLATE; multi-part ones are a zip of
    several images and are skipped, since the keyboard image inside is not
    identified without unpacking the vendor's own naming.

    A dropped connection is retried, since a silent skip there reads as
    "this board disproves the matrix" when it only means nobody asked
    successfully. An HTTP status is the server's answer and is final: the
    endpoint returns 500, not an empty result, for a board it has no
    firmware for, and retrying that only slows the sweep.
    """
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                API,
                data=json.dumps({"dev_id": dev_id}).encode(),
                headers={"Content-Type": "application/json"},
            )
            meta = json.loads(urllib.request.urlopen(req, timeout=25).read())["data"]
            if not meta:
                return None, None
            raw = urllib.request.urlopen(DOWNLOAD + meta["file_path"], timeout=120).read()
            return zlib.decompress(raw, -15), meta["version_str"]
        except zlib.error:
            return None, None  # multi-part package, not a plain image
        except urllib.error.HTTPError:
            return None, None  # no firmware record for this board
        except (OSError, ValueError, KeyError):
            if attempt == tries - 1:
                return None, None
            time.sleep(2 * (attempt + 1))
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist-js", action="append", type=pathlib.Path, required=True)
    ap.add_argument("--layout", help="verify only this layout")
    ap.add_argument("--limit", type=int, help="stop after N layouts")
    ap.add_argument("--jobs", type=int, default=8, help="concurrent downloads")
    ap.add_argument(
        "--out", type=pathlib.Path, default=ROOT / "app/src-tauri/data/matrix-evidence.json"
    )
    args = ap.parse_args()

    devices = json.loads(DEVICES.read_text(encoding="utf-8"))
    loaders = load_loader_maps(args.dist_js)

    # layout -> [(device, matrix)], every candidate matrix from that
    # device's own chunk so a board is only ever checked against its own.
    by_layout = {}
    for d in devices:
        if d["name"] not in loaders:
            continue
        for dist, chunk in loaders[d["name"]]["chunks"]:
            m = extract_default_matrix(dist, chunk)
            if m and len(m) == 512:
                by_layout.setdefault(d["keyLayout"], []).append((d, tuple(m)))

    evidence = {}
    if args.out.is_file():
        evidence = json.loads(args.out.read_text(encoding="utf-8"))

    # A layout shared by boards that ship different factory keymaps cannot
    # be settled by one board's firmware: the slot data would be right for
    # that board and wrong for its siblings. Those layouts stay
    # geometry-only, where the Keys page matches each board's own keymap.
    contested = {n for n, cs in by_layout.items() if len({m for _, m in cs}) > 1}

    names = [args.layout] if args.layout else sorted(by_layout)
    names = [n for n in names if n in by_layout and n not in evidence]
    skipped = [n for n in names if n in contested]
    names = [n for n in names if n not in contested]
    if skipped:
        print(f"skipping {len(skipped)} layouts whose boards disagree on the matrix", flush=True)
    if args.limit:
        names = names[: args.limit]

    # One task per candidate board. Boards are checked concurrently because
    # each is an independent download; a layout stops mattering as soon as
    # any of its boards confirms it, so later tasks for it are dropped.
    tasks = []
    for name in names:
        seen = set()
        for d, mat in by_layout[name]:
            if d["id"] in seen:
                continue
            seen.add(d["id"])
            tasks.append((name, d, mat))

    lock = threading.Lock()
    done = set()
    checked = set()

    def check(task):
        name, d, mat = task
        with lock:
            if name in done:
                return None
        fw, version = firmware(d["id"])
        with lock:
            checked.add(name)
        if not fw:
            return None
        at = fw.find(bytes(mat))
        if at < 0:
            return None
        with lock:
            if name in done:
                return None
            done.add(name)
        return name, {
            "board": d.get("displayName") or d["name"],
            "deviceId": d["id"],
            "family": d["family"],
            "firmware": version,
            "offset": at,
            "matrix": list(mat),
        }

    print(f"{len(names)} layouts to check, {len(tasks)} candidate boards", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for result in pool.map(check, tasks):
            if not result:
                continue
            name, rec = result
            evidence[name] = rec
            print(
                f"  confirmed {name}: {rec['board']} {rec['firmware']} @{hex(rec['offset'])}",
                flush=True,
            )
            args.out.write_text(
                json.dumps(dict(sorted(evidence.items())), indent=2) + "\n", encoding="utf-8"
            )
    args.out.write_text(
        json.dumps(dict(sorted(evidence.items())), indent=2) + "\n", encoding="utf-8"
    )
    unconfirmed = sorted(n for n in names if n not in done)
    print(f"unconfirmed this run ({len(unconfirmed)}): {unconfirmed}")
    print(f"{len(evidence)} layouts confirmed by firmware -> {args.out}")


if __name__ == "__main__":
    main()
