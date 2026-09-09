#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Read which LEDPARAM flags value a board paints as the rainbow, per board,
out of its own published firmware.

usage: led_flags.py [--ids ID ...] [--range FROM TO] [--cache DIR]
                    [--out FILE] [--jobs N]

The flags nibble of a LEDPARAM packet is either the index of a preset
colour (0..6), the colour the packet carried, or the rainbow. Which of the
two remaining values means which is not the same on every board: most read
`7` as the colour and `8` as the rainbow, the boards here read them the
other way round, and a board that has it wrong shows one solid colour where
its owner asked for the rainbow.

Every renderer in both codebases dispatches the nibble the same way. A
`cmp #6` sends the preset indices to the colour table, then the two
remaining values are tested by exact compare: one branch paints the colour
out of the packet, the other walks a colour of its own. The two codebases
keep the packet's colour in different places, so each is recognised on its
own terms and neither test fires on the other's images:

  thumb1  yc200/yc300/yc500/yc3121/yc3123. The nibble is masked with
          `lsls #28; lsrs #28`. The rainbow branch calls the hue generator
          or reseeds from the palette; the colour branch copies the three
          bytes already in registers. Verdict by majority of the image's
          renderers, which have always agreed where they were read by hand.
  thumb2  ry5088/ry6609/pan1086. The nibble is masked with `and.w #15` and
          kept at +30 of the light state, the frame counter beside it at
          +31. The rainbow branch reads that counter.

Both tests were traced by hand first: 946 (RT100) and 606 (Akko ACR75 v2)
for thumb1, and 2268 (AttackShark X65HE) for thumb2, from its SET handler
through the settings struct into the renderer. 606 and 1308 agree with what
their owners reported in issues #40 and #45.

Writes app/src-tauri/data/led-flags.json, one record per board whose
firmware could be read, both verdicts included so the file is the evidence
rather than a list of exceptions. Boards absent from it read `8` as the
rainbow, and their owners can say otherwise from the Lighting page.

Needs arm-none-eabi-objdump on PATH. Packages are cached under --cache, the
same directory firmware_keymaps.py uses, so a rerun downloads nothing it
already has.
"""
import argparse
import collections
import concurrent.futures
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from firmware_keymaps import fetch, images  # noqa: E402

DEVICES = ROOT / "app/src-tauri/data/devices.json"
OUT = ROOT / "app/src-tauri/data/led-flags.json"
OBJDUMP = ["arm-none-eabi-objdump", "-D", "-b", "binary", "-m", "armv7e-m",
           "-M", "force-thumb", "--adjust-vma=0x01000000"]

LINE = re.compile(r"^\s*([0-9a-f]+):\t[0-9a-f ]+\t(.*)$")
CMP = re.compile(r"cmp(?:\.w)?\s+(?:r\d+|ip|fp), #(\d+)$")
BEQ = re.compile(r"beq(?:\.[nw])?\s+0x([0-9a-f]+)$")
STATE30 = re.compile(r"ldrb(?:\.w)?\s+(?:r\d+|ip|fp), \[(?:r\d+|ip|fp), #30\]$")
COUNTER31 = re.compile(r", #31\]")
CALL = re.compile(r"bl\s")
PALETTE = re.compile(r"ldr\s+r\d+, \[pc")


def disassemble(image: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".bin") as f:
        f.write(image)
        f.flush()
        return subprocess.run(OBJDUMP + [f.name], capture_output=True, text=True).stdout


def instructions(dis: str):
    ins, index = [], {}
    for line in dis.splitlines():
        m = LINE.match(line)
        if m:
            index[int(m.group(1), 16)] = len(ins)
            ins.append((int(m.group(1), 16), m.group(2).split("@")[0].strip()))
    return ins, index


def chains(ins):
    """Each flags dispatch: (value, its branch, the other value, its branch, i)."""
    for k, (_, op) in enumerate(ins):
        m = CMP.match(op)
        if not m or int(m.group(1)) not in (7, 8):
            continue
        first = BEQ.match(ins[k + 1][1]) if k + 1 < len(ins) else None
        if not first:
            continue
        # the sibling compare follows within a few instructions; some images
        # reload the nibble in between
        for j in range(k + 2, min(k + 6, len(ins) - 1)):
            m2 = CMP.match(ins[j][1])
            if not m2:
                if ins[j][1].startswith("ldrb"):
                    continue
                break
            second = BEQ.match(ins[j + 1][1])
            if second and int(m2.group(1)) in (7, 8) and m2.group(1) != m.group(1):
                yield (int(m.group(1)), int(first.group(1), 16),
                       int(m2.group(1)), int(second.group(1), 16), k)
            break


def read(dis: str):
    """{shape: {value: sites}} for one image."""
    ins, index = instructions(dis)
    body = lambda va: [o for _, o in ins[index[va]:index[va] + 14]] if va in index else []
    out = {"thumb1": collections.Counter(), "thumb2": collections.Counter()}
    for a, first, b, second, k in chains(ins):
        before = [o for _, o in ins[max(0, k - 34):k]]
        # the preset guard is what marks this as the flags dispatch
        if not any(CMP.match(o) and CMP.match(o).group(1) == "6" for o in before):
            continue
        one, other = body(first), body(second)
        if any(STATE30.match(o) for o in before[-6:]):
            ca = any(COUNTER31.search(o) for o in one)
            cb = any(COUNTER31.search(o) for o in other)
            if ca != cb:
                out["thumb2"][a if ca else b] += 1
                continue
        walks = lambda ops: any(CALL.match(o) for o in ops[:8]) or \
            any(PALETTE.match(o) for o in ops[:6])
        wa, wb = walks(one), walks(other)
        if wa != wb:
            out["thumb1"][a if wa else b] += 1
    return out


def verdict(counts):
    """(rainbow value, shape, sites), or None when the image does not say.

    An image with the thumb2 shape is read on that alone: the thumb1 test
    scores its unrelated renderers too, and would drown the answer.
    """
    for shape in ("thumb2", "thumb1"):
        c = counts[shape]
        if not c:
            continue
        seven, eight = c[7], c[8]
        if seven == eight:
            return None
        return (7 if seven > eight else 8, shape, seven + eight)
    return None


def board(dev_id, cache, none, devices):
    version, package = fetch(dev_id, cache, none)
    if not package or version == "error":
        return dev_id, None, version
    counts = {"thumb1": collections.Counter(), "thumb2": collections.Counter()}
    for name, image in images(package).items():
        # the screen and side-LED co-processors carry no light renderer
        if "oled" in name.lower() or "mled" in name.lower():
            continue
        got = read(disassemble(image))
        for shape in counts:
            counts[shape] += got[shape]
    v = verdict(counts)
    if not v:
        return dev_id, None, version
    rainbow, shape, sites = v
    d = devices.get(dev_id)
    return dev_id, {
        "board": d["displayName"] if d else "(not in the registry)",
        "firmware": version,
        "rainbow": rainbow,
        "shape": shape,
        "sites": sites,
    }, version


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", type=int, nargs="*", help="only these device ids")
    ap.add_argument("--range", type=int, nargs=2, metavar=("FROM", "TO"),
                    help="every id in FROM..TO, registered or not")
    ap.add_argument("--cache", type=pathlib.Path,
                    default=pathlib.Path.home() / "vendor-builds/firmware/pkg")
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    ap.add_argument("--jobs", type=int, default=4)
    args = ap.parse_args()
    if not shutil.which(OBJDUMP[0]):
        sys.exit(f"{OBJDUMP[0]} is not on PATH")
    args.cache.mkdir(parents=True, exist_ok=True)
    none_path = args.cache / "none.json"
    none = {} if not none_path.is_file() else {
        int(k): v for k, v in json.loads(none_path.read_text(encoding="utf-8")).items()
    }

    devices = {d["id"]: d for d in json.loads(DEVICES.read_text(encoding="utf-8"))}
    if args.range:
        ids = list(range(args.range[0], args.range[1] + 1))
    else:
        ids = args.ids or sorted(devices)

    records = {}
    if args.out.is_file():
        records = json.loads(args.out.read_text(encoding="utf-8"))
    silent, rainbow7 = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for dev_id, record, version in pool.map(
            lambda i: board(i, args.cache, none, devices), ids
        ):
            if record is None:
                if version and version != "error":
                    silent.append(dev_id)
                records.pop(str(dev_id), None)
                continue
            records[str(dev_id)] = record
            if record["rainbow"] == 7:
                rainbow7.append(dev_id)

    args.out.write_text(
        json.dumps({k: records[k] for k in sorted(records, key=int)}, indent=1) + "\n",
        encoding="utf-8",
    )
    none_path.write_text(json.dumps(none, indent=1) + "\n", encoding="utf-8")
    print(f"{len(records)} boards -> {args.out}")
    print(f"  rainbow on 7: {len(rainbow7)} {sorted(rainbow7)}")
    print(f"  firmware published but no renderer read: {len(silent)}")


if __name__ == "__main__":
    main()
