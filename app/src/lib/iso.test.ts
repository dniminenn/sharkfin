// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// An ISO board's two extra keys have to survive the whole round: derived
// from the ANSI picture, offered, confirmed, and rebuilt by name on the
// next launch. A derived picture names no file, so a stored answer that
// cannot be resolved back leaves the owner with the slot grid.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isoName, isoVariant, looksIso, resolvePicture } from "@/lib/iso";
import type { BoardLayout } from "@/lib/layout-loader";

const VENDOR = fileURLToPath(new URL("layouts/vendor", import.meta.url));
const NON_US_BACKSLASH = 100;
const NON_US_HASH = 50;

function read(stem: string): BoardLayout {
  return JSON.parse(readFileSync(path.join(VENDOR, `${stem}.json`), "utf8")) as BoardLayout;
}

const load = async (stem: string): Promise<BoardLayout | null> => {
  try {
    return read(stem);
  } catch {
    return null;
  }
};

const all = readdirSync(VENDOR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));

describe("isoVariant", () => {
  it("adds both keys beside the ones they split", () => {
    const ansi = read("Common66_X68");
    const iso = isoVariant(ansi);
    expect(iso).not.toBeNull();
    expect(iso!.keys).toHaveLength(ansi.keys.length + 2);

    const at = (code: string, layout: BoardLayout) =>
      layout.keys.find((k) => k.code === code)!;
    for (const [host, born] of [
      ["ShiftLeft", "IntlBackslash"],
      ["Enter", "IntlHash"],
    ] as const) {
      const before = at(host, ansi);
      const after = at(host, iso!);
      const key = at(born, iso!);
      expect(after.w).toBe(before.w - key.w);
      expect(key.x).toBe(before.x);
      expect(key.x + key.w).toBe(after.x);
      expect(key.y).toBe(before.y);
    }
  });

  it("leaves a layout that already has the keys alone", () => {
    const ansi = read("Common66_X68");
    expect(isoVariant(isoVariant(ansi)!)).toBeNull();
  });

  // A picture with slot data is drawn as shipped, so its ISO owners can
  // only reach these keys through the derivation. Every layout whose own
  // factory keymap carries both usages with no key drawn for them has to
  // be derivable, or those owners have keys they cannot press in the app.
  it("covers every drawn picture whose keymap reports the keys", () => {
    const undrawable = all.filter((stem) => {
      const l = read(stem) as BoardLayout & {
        matrixEntriesWithoutUIKey?: { entry: number[] }[];
      };
      if (!l.keys.some((k) => k.matrixIndex !== null)) return false;
      const drawn = new Set(l.keys.map((k) => k.hidUsage));
      if (drawn.has(NON_US_BACKSLASH) || drawn.has(NON_US_HASH)) return false;
      const orphan = new Set(
        (l.matrixEntriesWithoutUIKey ?? [])
          .filter((e) => e.entry[0] === 0)
          .map((e) => e.entry[2]),
      );
      return orphan.has(NON_US_BACKSLASH) && orphan.has(NON_US_HASH);
    });
    expect(undrawable.length).toBeGreaterThan(0);
    expect(undrawable.filter((stem) => isoVariant(read(stem)) === null)).toEqual([]);
  });
});

describe("looksIso", () => {
  const slot = (usage: number) => [0, 0, usage, 0];

  it("takes both keys, never one", () => {
    expect(looksIso([...slot(NON_US_BACKSLASH), ...slot(NON_US_HASH)])).toBe(true);
    expect(looksIso(slot(NON_US_BACKSLASH))).toBe(false);
    expect(looksIso(slot(NON_US_HASH))).toBe(false);
  });

  it("reads usages, not macro or consumer payloads", () => {
    expect(looksIso([9, 0, NON_US_BACKSLASH, 0, 3, 0, NON_US_HASH, 0])).toBe(false);
  });
});

describe("resolvePicture", () => {
  it("rebuilds a derived picture from the name a bundle carries", async () => {
    const iso = await resolvePicture(isoName("Common66_X68"), load);
    expect(iso).not.toBeNull();
    const usages = new Set(iso!.keys.map((k) => k.hidUsage));
    expect(usages.has(NON_US_BACKSLASH)).toBe(true);
    expect(usages.has(NON_US_HASH)).toBe(true);
  });

  it("loads a plain name unchanged", async () => {
    const ansi = await resolvePicture("Common66_X68", load);
    expect(ansi!.keys).toHaveLength(read("Common66_X68").keys.length);
  });

  it("is null when the file behind the name is gone", async () => {
    expect(await resolvePicture(isoName("Common0_NoSuchBoard"), load)).toBeNull();
    expect(await resolvePicture("Common0_NoSuchBoard", load)).toBeNull();
  });
});
