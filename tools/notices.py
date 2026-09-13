#!/usr/bin/env python3
# SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate THIRD-PARTY-NOTICES.md from what the binaries actually contain.

Usage: tools/notices.py [--check]

The web package list comes from the sourcemaps of a real build, not from
package.json, so build-only tools are never listed and nothing that ships
is missed. Run `npx vite build --sourcemap` in app/ first.

--check compares the committed inventory against a fresh one and fails on
drift. It reads no license texts, so CI does not need the cargo registry
sources.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
OUT = ROOT / "THIRD-PARTY-NOTICES.md"

# Ship as generated CSS or assets, so they leave no trace in the JS
# sourcemaps. Fonts are picked up from the woff2 files in dist/.
CSS_PACKAGES = ("tailwindcss", "tw-animate-css")

# Copied into the tree rather than installed, so no sourcemap or manifest
# names them. The files carry the same notice in their SPDX headers.
VENDORED = (
    {"name": "shadcn/ui", "license": "MIT",
     "holder": "Copyright (c) 2023 shadcn",
     "url": "https://ui.shadcn.com",
     "where": "app/src/components/ui, app/src/lib/utils.ts"},
)

LICENSE_NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE")

# Order the appendix so the licenses most of the tree uses come first.
LICENSE_ORDER = ("MIT", "Apache-2.0", "OFL-1.1", "BSD-3-Clause", "BSD-2-Clause",
                 "ISC", "Zlib", "0BSD", "MPL-2.0", "Unicode-3.0", "Unlicense",
                 "CC0-1.0", "MIT-0")


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=True).stdout


def license_files(d: Path):
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir()
                  if p.is_file() and p.name.upper().startswith(LICENSE_NAMES))


# A real grant line, not a sentence from the body of the license. Both the
# MIT and BSD texts talk about copyright in prose, and the disclaimers shout
# the word in caps.
HOLDER_LINE = re.compile(r"^Copyright\b(?!\s+(?:Holder|and|notice|statement))")


def is_copyright(line: str) -> bool:
    if not HOLDER_LINE.match(line) or len(line) > 300:
        return False
    letters = [c for c in line if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        return False
    return bool(re.search(r"(19|20)\d{2}|[<@]|https?://", line))


def copyrights(d: Path) -> list[str]:
    """Copyright lines from a package's license files. MIT and BSD require
    these to travel with the code; the SPDX text alone is not enough."""
    out = []
    for f in license_files(d):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip(" \t*#/")
            if is_copyright(line) and line not in out:
                out.append(line)
    return out


def license_text(d: Path) -> str | None:
    files = license_files(d)
    if not files:
        return None
    return files[0].read_text(encoding="utf-8", errors="replace").strip()


def ids(expr: str) -> list[str]:
    """SPDX ids in a license expression. Dual licenses are recorded whole in
    the table; the appendix carries a text for each id so the reader can see
    whichever one they rely on."""
    parts = re.split(r"\s+(?:OR|AND)\s+|[/,]", expr or "")
    out = []
    for p in parts:
        p = re.sub(r"\s+WITH\s+.*$", "", p.strip(" ()")).strip()
        if p and p not in out:
            out.append(p)
    return out


def web_packages() -> list[dict]:
    """Packages whose code is in the built bundle, read off the sourcemaps."""
    dist = APP / "dist" / "assets"
    maps = sorted(dist.glob("*.map"))
    if not maps:
        sys.exit("no sourcemaps in app/dist/assets: run `npx vite build --sourcemap` in app/ first")
    names = set()
    for m in maps:
        for src in json.loads(m.read_text()).get("sources") or []:
            hit = re.search(r"node_modules/((?:@[^/]+/)?[^/]+)", src)
            if hit:
                names.add(hit.group(1))
    names.update(CSS_PACKAGES)
    pkgs = []
    for name in sorted(names):
        d = APP / "node_modules" / name
        meta_path = d / "package.json"
        if not meta_path.is_file():
            sys.exit(f"{name} is in the bundle but not in app/node_modules: run npm ci")
        meta = json.loads(meta_path.read_text())
        lic = meta.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        if not lic and meta.get("licenses"):
            lic = " OR ".join(x.get("type", "") for x in meta["licenses"])
        pkgs.append({"name": name, "version": meta.get("version", ""),
                     "license": lic or "see package", "dir": d})
    return pkgs


def fonts() -> list[dict]:
    """Fonts embedded in the web assets, with the attribution the OFL wants."""
    dist = APP / "dist" / "assets"
    families = set()
    for f in dist.glob("*.woff2"):
        stem = re.sub(r"-[A-Za-z0-9_-]{8}$", "", f.stem)
        stem = re.sub(r"-(latin|cyrillic|greek|vietnamese)(-ext)?-.*$", "", stem)
        families.add(stem)
    out = []
    for fam in sorted(families):
        d = APP / "node_modules" / f"@fontsource-variable/{fam}"
        if not d.is_dir():
            sys.exit(f"font {fam} is bundled but @fontsource-variable/{fam} is not installed")
        meta = json.loads((d / "metadata.json").read_text())
        pkg = json.loads((d / "package.json").read_text())
        src = meta.get("license") or {}
        attr = re.sub(r"\s+", " ", src.get("attribution", "")).strip()
        # Upstream repeats the same holder once per face; keep the first grant.
        first = re.match(r"(Copyright .*?\))", attr)
        attr = first.group(1) if first else attr
        out.append({"name": f"@fontsource-variable/{fam}", "version": pkg.get("version", ""),
                    "license": src.get("type", "OFL-1.1"), "family": meta.get("family", fam),
                    "attribution": attr, "dir": d})
    return out


def rust_crates(manifest_dir: Path) -> list[dict]:
    """Crates linked into a binary: normal dependencies reachable from the
    root, with dev- and build-only crates left out."""
    meta = json.loads(run(["cargo", "metadata", "--format-version", "1"], manifest_dir))
    by_id = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    roots = meta["workspace_members"]
    seen, queue = set(), list(roots)
    while queue:
        pid = queue.pop()
        if pid in seen:
            continue
        seen.add(pid)
        for dep in nodes.get(pid, {}).get("deps", []):
            if any(k.get("kind") is None for k in dep.get("dep_kinds", [])):
                queue.append(dep["pkg"])
    out = []
    for pid in seen:
        p = by_id[pid]
        if pid in roots:
            continue
        out.append({"name": p["name"], "version": p["version"],
                    "license": (p.get("license") or "see source").replace("/", " OR "),
                    "dir": Path(p["manifest_path"]).parent})
    return sorted(out, key=lambda p: (p["name"], p["version"]))


def table(rows: list[dict]) -> list[str]:
    out = ["| Package | Version | License |", "| --- | --- | --- |"]
    out += [f"| {r['name']} | {r['version']} | {r['license']} |" for r in rows]
    return out


def inventory() -> dict:
    web = web_packages()
    fnt = fonts()
    tauri = rust_crates(APP / "src-tauri")
    wasm = rust_crates(APP / "src-web")
    tauri_keys = {(c["name"], c["version"]) for c in tauri}
    wasm = [c for c in wasm if (c["name"], c["version"]) not in tauri_keys]
    return {"fonts": fnt, "web": web, "tauri": tauri, "wasm": wasm}


def render(inv: dict) -> str:
    L = ["# Third-party notices", "",
         "sharkfin itself is GPL-3.0-or-later; its terms are in `LICENSE`. The",
         "components below are redistributed inside the application and keep their",
         "own terms. Generated by `tools/notices.py`, do not edit.", ""]

    L += ["## Fonts", "",
          "Embedded in the application's web assets. The SIL Open Font License",
          "requires this notice and the license text to accompany the font files.", ""]
    for f in inv["fonts"]:
        L += [f"**{f['family']}** ({f['name']} {f['version']}), {f['license']}  ",
              f"{f['attribution']}", ""]

    L += ["## Web packages", "",
          "Bundled into the application's JavaScript and CSS.", ""]
    L += table(inv["web"]) + [""]

    L += ["## Vendored code", "",
          "Third-party source copied into the tree. The files keep their own",
          "license in an SPDX header.", ""]
    for v in VENDORED:
        L += [f"**{v['name']}** (<{v['url']}>), {v['license']}  ",
              f"{v['holder']}  ",
              f"In `{v['where']}`", ""]

    L += ["## Rust crates", "",
          "Linked into the application binary. The list spans every supported",
          "platform, so some crates are present only on macOS, Windows or Linux.", ""]
    L += table(inv["tauri"]) + [""]
    if inv["wasm"]:
        L += ["Additional crates in the browser build:", ""]
        L += table(inv["wasm"]) + [""]

    groups: dict[str, list[str]] = {}
    texts: dict[str, str] = {}
    for v in VENDORED:
        groups.setdefault(v["license"], []).append(v["holder"])
    for entry in inv["fonts"] + inv["web"] + inv["tauri"] + inv["wasm"]:
        for lid in ids(entry["license"]):
            groups.setdefault(lid, [])
            for c in copyrights(entry["dir"]):
                if c not in groups[lid]:
                    groups[lid].append(c)
            if lid not in texts:
                t = license_text(entry["dir"])
                # Only take a text from a package licensed under that id alone,
                # or a dual-licensed package would file its MIT text under
                # Apache-2.0.
                if t and ids(entry["license"]) == [lid]:
                    texts[lid] = t

    L += ["## License texts", ""]
    order = [x for x in LICENSE_ORDER if x in groups]
    order += sorted(x for x in groups if x not in LICENSE_ORDER)
    for lid in order:
        L += [f"### {lid}", ""]
        if groups[lid]:
            L += ["Copyright holders:", ""]
            L += [f"- {c}" for c in sorted(groups[lid])] + [""]
        if lid in texts:
            L += ["```", texts[lid], "```", ""]
        else:
            L += [f"Full text: <https://spdx.org/licenses/{lid}.html>", ""]
    return "\n".join(L).rstrip() + "\n"


def committed_inventory() -> set[tuple[str, str, str]]:
    if not OUT.is_file():
        sys.exit(f"{OUT.name} is missing: run tools/notices.py")
    rows = set()
    for line in OUT.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 3 and cells[0] not in ("Package", "---") and "---" not in cells[1]:
            rows.add(tuple(cells))
    for line in OUT.read_text().splitlines():
        hit = re.match(r"\*\*.+\*\* \((\S+) (\S+)\), (\S+)", line)
        if hit:
            rows.add((hit.group(1), hit.group(2), hit.group(3)))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail if the committed inventory is out of date")
    args = ap.parse_args()
    inv = inventory()
    if args.check:
        fresh = {(e["name"], e["version"], e["license"])
                 for e in inv["fonts"] + inv["web"] + inv["tauri"] + inv["wasm"]}
        have = committed_inventory()
        added, dropped = sorted(fresh - have), sorted(have - fresh)
        if added or dropped:
            for n, v, l in added:
                print(f"missing from {OUT.name}: {n} {v} ({l})")
            for n, v, l in dropped:
                print(f"no longer shipped: {n} {v} ({l})")
            print(f"\nrun tools/notices.py to regenerate {OUT.name}")
            return 1
        print(f"{OUT.name} lists all {len(fresh)} redistributed components")
        return 0
    OUT.write_text(render(inv))
    n = sum(len(inv[k]) for k in inv)
    print(f"{OUT.relative_to(ROOT)}: {n} components")
    return 0


if __name__ == "__main__":
    sys.exit(main())
