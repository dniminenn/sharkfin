// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inferSlots } from "@/lib/layout-infer";
import { buildIndex, pack, stubLayout, unpack } from "@/lib/layout-index";
import { isoVariant } from "@/lib/iso";
import type { BoardLayout } from "@/lib/layout-loader";

const dir = path.resolve(__dirname, "layouts/vendor");
const layouts: Record<string, BoardLayout> = {};
for (const name of readdirSync(dir)) {
  if (name.endsWith(".json"))
    layouts[name.slice(0, -".json".length)] = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}
const stems = Object.keys(layouts);
const index = buildIndex(layouts);

/** A keymap with each key in its own slot, as a factory board reports. */
function factory(layout: BoardLayout): number[] {
  const matrix: number[] = [];
  for (const k of layout.keys) if (k.matrixEntry) matrix.push(...k.matrixEntry);
  return matrix;
}

const score = (layout: BoardLayout, matrix: number[]) => {
  const inf = inferSlots(layout, matrix);
  return [inf.matched, inf.total, inf.matchRate, inf.f1, inf.ambiguous];
};

describe("layout index", () => {
  it("packs entries losslessly", () => {
    for (const e of [[0, 0, 41, 0], [3, 0, 0, 234], [255, 255, 255, 255]])
      expect(unpack(pack(e))).toEqual(e);
  });

  it("covers every picture", () => {
    expect(Object.keys(index.entries).sort()).toEqual([...stems].sort());
  });

  it("scores like the pictures against every keymap", () => {
    // A stub must agree with its picture whether the board is the same,
    // a sibling or alien: its own factory keymap and a spread of others.
    const others = stems.filter((_, i) => i % 40 === 0).map((s) => factory(layouts[s]));
    for (const stem of stems) {
      const stub = stubLayout(index.entries[stem]);
      for (const m of [factory(layouts[stem]), ...others])
        expect(score(stub, m)).toEqual(score(layouts[stem], m));
    }
  });

  it("digests the ISO derivation as the picture plus its born keys", () => {
    for (const stem of stems) {
      const iso = isoVariant(layouts[stem]);
      expect(stem in index.iso).toBe(!!iso);
      if (!iso) continue;
      const stub = stubLayout(index.entries[stem].concat(index.iso[stem]));
      const m = factory(iso);
      expect(score(stub, m)).toEqual(score(iso, m));
    }
  });
});
