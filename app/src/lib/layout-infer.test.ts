// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { rankCandidates, type Inference } from "./layout-infer";
import { isoName } from "./iso";

const inf = (layoutName: string, f1: number, ambiguous = 0): Inference =>
  ({
    layoutName,
    f1,
    ambiguous: Array.from({ length: ambiguous }, (_, i) => i),
    matched: 0,
    total: 0,
    matchRate: 1,
    matrix: [],
    profile: 0,
    layout: { canvas: { width: 1, height: 1 }, keys: [] },
  }) as Inference;

describe("rankCandidates", () => {
  it("keeps a body's plain picture reachable behind its ISO derivation", () => {
    // Nine bodies. On an ANSI board that parks the ISO usages in unfitted
    // slots, every derivation outscores every plain picture.
    const cands: Inference[] = [];
    for (let i = 0; i < 9; i++) {
      cands.push(inf(`Body${i}`, 0.98 - i * 0.001));
      cands.push(inf(isoName(`Body${i}`), 1 - i * 0.001));
    }
    const ranked = rankCandidates(cands, "Unknown", 8);
    const names = ranked.map((c) => c.layoutName);
    expect(names.slice(0, 2)).toEqual([isoName("Body0"), "Body0"]);
    expect(names).toContain("Body7");
    expect(names).not.toContain("Body8");
    expect(new Set(names.map((n) => n.replace(/\+iso$/, ""))).size).toBe(8);
  });

  it("puts the registry's suggestion first, either variant", () => {
    const cands = [
      inf("Other", 1),
      inf(isoName("Other"), 1),
      inf("Named", 0.9),
      inf(isoName("Named"), 0.95),
    ];
    const names = rankCandidates(cands, "Named", 8).map((c) => c.layoutName);
    // A tie inside a body keeps its input order.
    expect(names).toEqual([
      isoName("Named"),
      "Named",
      "Other",
      isoName("Other"),
    ]);
  });

  it("ranks bodies by their best fit, then by ambiguity", () => {
    const cands = [inf("A", 0.95, 2), inf("B", 0.95, 0), inf("C", 0.99)];
    expect(
      rankCandidates(cands, "Unknown", 8).map((c) => c.layoutName),
    ).toEqual(["C", "B", "A"]);
  });
});
