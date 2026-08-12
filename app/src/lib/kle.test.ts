// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Round trip: draw every vendor picture in KLE from its printed labels,
// import the drawing, and match it against the picture's own matrix
// entries. A key that fails to attach is a legend the importer cannot
// read, caught here instead of by the fourth issue from the same owner.
//
// Not every engraving can be read. A label that names different keys in
// different countries stays unmapped on purpose: a dimmed key is safe, a
// key attached to the wrong slot reaches the wrong register on a write.
// Those show up here as tolerated misses, either non-ASCII or listed.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FN_ENTRY, kleToLayout } from "@/lib/kle";
import { inferSlots } from "@/lib/layout-infer";
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";

const VENDOR = fileURLToPath(new URL("layouts/vendor", import.meta.url));

// ASCII labels that are allowed to stay unmapped: doubled national
// engravings (UK boards print \| on both ISO keys), abbreviations only one
// board uses, and shifted-pair halves that JP boards split across two keys.
const TOLERATED = new Set([
  "\\|", "\\", "|\\", "\\|/", "/?", "?/", "[{", "]}", "}]", "]", ":",
  "^", "-", "+", "=-", "+;", "*:", ".:", ":.", ". :", ".;", ";.", "/:",
  ":/", ": /", "; ,", ", ;", "- _", "; | , \\", "+*~", "+ * ~", "~^", "^ `", "` ,", "..^",
  "^..", "> <", ">", "i", "I", "M", "PrtSc", "GG", "Sup", "Conv",
  "Echap", "Pgpr", "Pgsv", "PgPr", "PgSv", "L\nIns", "PS", "SL", "HM",
  "PU", "PD", "YH", "JD",
]);

function tolerated(label: string): boolean {
  // A non-ASCII engraving is some country's key we do not guess at.
  if ([...label].some((c) => c < " " || c > "~")) return true;
  return TOLERATED.has(label);
}

/** The picture as its owner would draw it: rows of labels, KLE offsets. */
function toKle(layout: BoardLayout): string {
  const keys = [...layout.keys]
    .filter((k) => k.type === "key")
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const U = 46;
  const rows: string[] = [];
  let rowY: number | null = null;
  let cursorY = 0;
  let row: string[] = [];
  let cursorX = 0;
  const flush = () => {
    if (row.length) rows.push(`[${row.join(",")}]`);
    row = [];
    cursorX = 0;
  };
  for (const k of keys) {
    const yu = (k.y - 1) / U;
    const xu = (k.x - 1) / U;
    const wu = (k.w + 6) / U;
    const hu = (k.h + 6) / U;
    if (rowY === null || k.y !== rowY) {
      flush();
      rowY = k.y;
      const dy = yu - cursorY;
      cursorY = yu + 1;
      if (dy) row.push(JSON.stringify({ y: dy }));
    }
    const props: Record<string, number> = {};
    if (xu - cursorX) props.x = xu - cursorX;
    if (wu !== 1) props.w = wu;
    if (hu !== 1) props.h = hu;
    if (Object.keys(props).length) row.push(JSON.stringify(props));
    row.push(JSON.stringify(k.text ?? ""));
    cursorX = xu + wu;
  }
  flush();
  return rows.join(",\n");
}

/** Keys the drawing is expected to attach: a printed label and a plain
 *  keyboard entry. Knob, media, macro and combo entries are not drawable
 *  in KLE, and neither is an entry below the first real usage. */
function drawable(k: LayoutKey): boolean {
  if (k.type !== "key" || !k.matrixEntry || !k.text) return false;
  if (k.consumerUsage !== null) return false;
  if (k.matrixEntry[0] !== 0)
    return k.matrixEntry[0] === FN_ENTRY[0] && k.matrixEntry[1] === FN_ENTRY[1];
  return k.matrixEntry[2] >= 4 && k.matrixEntry[3] === 0;
}

describe("kle round trip over vendor pictures", () => {
  const files = readdirSync(VENDOR).filter((f) => f.endsWith(".json"));
  it("finds vendor pictures", () => {
    expect(files.length).toBeGreaterThan(300);
  });
  for (const file of files) {
    it(file, () => {
      const layout: BoardLayout = JSON.parse(
        readFileSync(path.join(VENDOR, file), "utf8"),
      );
      const wanted = layout.keys.filter(drawable);
      if (!wanted.length) return;
      const matrix: number[] = [];
      for (const k of wanted) matrix.push(...k.matrixEntry!);
      const drawn = kleToLayout(toKle(layout));
      const inf = inferSlots(drawn, matrix);
      const hit = new Set(
        inf.layout.keys
          .filter((k) => k.matrixIndex !== null)
          .map((k) => k.matrixIndex),
      );
      const missed = wanted
        .filter((_, i) => !hit.has(i))
        .map((k) => k.text!)
        .filter((t) => !tolerated(t));
      expect(missed).toEqual([]);
    });
  }
});

describe("kle legends", () => {
  const usages = (text: string) =>
    kleToLayout(text).keys.map((k) => k.matrixEntry);

  it("reads Menu and Fn", () => {
    const [menu, fn] = usages(JSON.stringify([["Menu", "Fn"]]));
    expect(menu).toEqual([0, 0, 101, 0]);
    expect(fn).toEqual(FN_ENTRY);
  });

  it("keeps split spacebars and the Alice B", () => {
    const rows = JSON.stringify([["B", "B", { w: 2.75 }, "─", { w: 2.75 }, "─"]]);
    expect(usages(rows)).toEqual([
      [0, 0, 5, 0],
      [0, 0, 5, 0],
      [0, 0, 44, 0],
      [0, 0, 44, 0],
    ]);
  });

  it("gives the numpad the keypad usages", () => {
    const rows = JSON.stringify([
      ["Esc", "1", "2", "Enter"],
      ["Num", "/", "*", "-"],
      ["7\nHome", "8\n↑", "9\nPgUp", "+"],
    ]);
    expect(usages(rows).map((e) => e?.[2])).toEqual([
      41, 89, 90, 88, 83, 84, 85, 86, 95, 96, 97, 87,
    ]);
  });

  it("keeps the main area over the numpad on a full board", () => {
    const rows = JSON.stringify([
      ["A", "5", "/", { x: 2 }, "/", "5"],
    ]);
    expect(usages(rows).map((e) => e?.[2])).toEqual([4, 34, 56, 84, 93]);
  });

  it("tells the two ← apart by row", () => {
    const rows = JSON.stringify([["Q", "←"], [{ y: 4 }, "←"]]);
    expect(usages(rows).map((e) => e?.[2])).toEqual([20, 42, 80]);
  });

  it("unmaps a doubled national engraving instead of refusing", () => {
    const rows = JSON.stringify([["A", "\\|", "\\|"]]);
    expect(usages(rows).map((e) => e?.[2])).toEqual([4, undefined, undefined]);
  });

  it("refuses two Fn keys", () => {
    expect(() => kleToLayout(JSON.stringify([["Fn", "A", "Fn"]]))).toThrow(
      /same key/,
    );
  });
});
