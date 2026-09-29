#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail if an ELF needs a glibc newer than 2.35.

Usage: tools/glibc_floor.py PATH...

Directories are walked. Non-ELF files are skipped. The Linux release is
built on Ubuntu 22.04; this fails the job if a newer image stamps a
symbol version those systems will not load.
"""

import subprocess
import sys
from pathlib import Path

FLOOR = (2, 35)


def glibc_versions(text: str) -> set[tuple[int, ...]]:
    found = set()
    for tok in text.replace("(", " ").replace(")", " ").split():
        if not tok.startswith("GLIBC_"):
            continue
        nums = []
        for part in tok[len("GLIBC_") :].split("."):
            if not part.isdigit():
                nums = []
                break
            nums.append(int(part))
        if nums:
            found.add(tuple(nums))
    return found


def is_elf(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def check(path: Path) -> list[str]:
    proc = subprocess.run(
        ["objdump", "-p", str(path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return [f"{path}: objdump failed"]
    bad = sorted(
        "GLIBC_" + ".".join(str(n) for n in ver)
        for ver in glibc_versions(proc.stdout)
        if ver[:2] > FLOOR
    )
    if bad:
        return [f"{path}: {', '.join(bad)}"]
    return []


def walk(path: Path):
    if path.is_dir():
        for child in sorted(path.rglob("*")):
            if child.is_file() and is_elf(child):
                yield child
    elif path.is_file() and is_elf(path):
        yield path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: glibc_floor.py PATH...", file=sys.stderr)
        return 2
    problems = []
    seen = 0
    for arg in sys.argv[1:]:
        path = Path(arg)
        if not path.exists():
            problems.append(f"{path}: not found")
            continue
        for elf in walk(path):
            seen += 1
            problems.extend(check(elf))
    if seen == 0:
        problems.append("no ELF files")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"{seen} ELF files need nothing newer than glibc 2.35")
    return 0


if __name__ == "__main__":
    sys.exit(main())
