// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The presets are real boards: each has the key count its size is sold
// as, prints every usage once, and matches a stored picture of that size
// well enough to be offered. A picture converted to a draft and back is
// the same picture as far as the matcher can tell.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BoardLayout } from "@/lib/layout-loader";
import { inferSlots } from "@/lib/layout-infer";
import {
  PRESETS,
  extent,
  fromLayout,
  placeNew,
  preset,
  toLayout,
  type Draft,
  type PresetSize,
} from "@/lib/layout-draft";

const VENDOR = join(__dirname, "layouts/vendor");
const read = (name: string) =>
  JSON.parse(readFileSync(join(VENDOR, name), "utf-8")) as BoardLayout;

/** A board's keymap as the picture says it ships. */
function matrixOf(layout: BoardLayout): number[] {
  const m = new Array(128 * 4).fill(0);
  for (const k of layout.keys) {
    if (k.matrixIndex === null || !k.matrixEntry) continue;
    k.matrixEntry.forEach((b, i) => (m[k.matrixIndex! * 4 + i] = b));
  }
  return m;
}

const COUNTS: Record<PresetSize, number> = {
  "60": 61,
  "65": 67,
  "75": 81,
  tkl: 87,
  "96": 99,
  full: 104,
};

/** A stored picture of each size, with slot data to match against. */
const SAMPLES: Record<PresetSize, string> = {
  "60": "Common61_sg9040.json",
  "65": "Common67_HF68.json",
  "75": "Common81_KiiBoom81.json",
  tkl: "Common87_C87P.json",
  "96": "Common98_K2406B.json",
  full: "Common104_MK826.json",
};

function overlaps(draft: Draft): string[] {
  const out: string[] = [];
  const ks = draft.keys;
  for (let i = 0; i < ks.length; i++)
    for (let j = i + 1; j < ks.length; j++) {
      const a = ks[i];
      const b = ks[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        out.push(`${a.usage} over ${b.usage}`);
    }
  return out;
}

describe("presets", () => {
  for (const { size } of PRESETS) {
    it(`${size} has ${COUNTS[size]} keys, each with its own label`, () => {
      const d = preset(size, { iso: false, knob: false });
      expect(d.keys).toHaveLength(COUNTS[size]);
      expect(d.keys.every((k) => k.usage !== null)).toBe(true);
      expect(new Set(d.keys.map((k) => k.usage)).size).toBe(d.keys.length);
      expect(overlaps(d)).toEqual([]);
      expect(d.keys.every((k) => k.x % 0.25 === 0 && k.y % 0.25 === 0)).toBe(true);
    });

    it(`${size} matches a stored picture of that size`, () => {
      const sample = read(SAMPLES[size]);
      const inf = inferSlots(toLayout(preset(size, { iso: false, knob: false })), matrixOf(sample));
      expect(inf.matchRate).toBeGreaterThanOrEqual(0.9);
    });
  }

  it("ISO swaps the backslash for the two ISO keys", () => {
    const d = preset("60", { iso: true, knob: false });
    const usages = new Set(d.keys.map((k) => k.usage));
    expect(usages.has(49)).toBe(false);
    expect(usages.has(100)).toBe(true);
    expect(usages.has(50)).toBe(true);
    expect(d.keys).toHaveLength(62);
    expect(overlaps(d)).toEqual([]);
  });

  it("a knob is three knob keys in the picture", () => {
    const layout = toLayout(preset("75", { iso: false, knob: true }));
    const knob = layout.keys.filter((k) => k.type === "knob");
    expect(knob.map((k) => k.code)).toEqual([
      "AudioVolumeDown",
      "AudioVolumeMute",
      "AudioVolumeUp",
    ]);
    expect(knob.map((k) => k.consumerUsage)).toEqual([234, 226, 233]);
    // Beside the F row, not over it.
    const overF = layout.keys.filter(
      (k) => k.type === "key" && k.y < knob[0].y + knob[0].h && k.x + k.w > knob[0].x,
    );
    expect(overF).toEqual([]);
  });
});

describe("placing a new key", () => {
  it("never lands on another key", () => {
    const d = preset("75", { iso: false, knob: true });
    const tab = d.keys.find((k) => k.usage === 43)!;
    const beside = placeNew(d, tab);
    const alone = placeNew(d, null);
    for (const k of [beside, alone]) {
      d.keys.push(k);
      expect(overlaps(d)).toEqual([]);
    }
    expect(beside.y).toBe(tab.y);
    expect(beside.x).toBeGreaterThan(tab.x + tab.w);
  });

  it("keeps what a picture printed on a key it cannot label", () => {
    const d = fromLayout(read("Common108_MK921~k1.json"));
    const blank = d.keys.filter((k) => k.usage === null);
    expect(blank.length).toBeGreaterThan(0);
    expect(blank.every((k) => k.note)).toBe(true);
  });
});

describe("round trip", () => {
  it("a preset survives becoming a picture and coming back", () => {
    for (const { size } of PRESETS) {
      const d = preset(size, { iso: true, knob: true });
      const back = fromLayout(toLayout(d));
      expect(back.keys.map(({ x, y, w, h, usage }) => ({ x, y, w, h, usage }))).toEqual(
        d.keys.map(({ x, y, w, h, usage }) => ({ x, y, w, h, usage })),
      );
      expect(back.knob).toEqual(d.knob);
    }
  });

  it("every stored picture converts with its keys and labels intact", () => {
    for (const f of readdirSync(VENDOR).filter((f) => f.endsWith(".json"))) {
      const layout = read(f);
      const d = fromLayout(layout);
      const plain = layout.keys.filter((k) => k.type === "key");
      expect(d.keys, f).toHaveLength(plain.length);
      expect(d.keys.every((k) => k.w >= 0.5 && k.h >= 0.5 && k.x >= 0 && k.y >= 0), f).toBe(true);
      expect(!!d.knob, f).toBe(layout.keys.some((k) => k.type === "knob"));
      // The draft is a picture the board itself would accept: every key it
      // can carry still finds its slot.
      const m = matrixOf(layout);
      if (!m.some((b) => b !== 0)) continue;
      const carried = {
        ...layout,
        keys: plain.filter(
          (k) =>
            k.matrixEntry &&
            ((k.matrixEntry[0] === 0 && k.matrixEntry[1] === 0 && k.matrixEntry[3] === 0) ||
              (k.matrixEntry[0] === 10 && k.matrixEntry[1] === 1 && k.matrixEntry[2] === 0)),
        ),
      };
      expect(inferSlots(toLayout(d), m).matched, f).toBeGreaterThanOrEqual(
        inferSlots(carried, m).matched,
      );
    }
  });

  it("a picture drawn at another scale keeps its real key widths", () => {
    const d = fromLayout(read("Common81_KiiBoom81.json"));
    const by = (u: number) => d.keys.find((k) => k.usage === u)!;
    expect(by(43).w).toBe(1.5); // Tab
    expect(by(57).w).toBe(1.75); // Caps
    expect(by(225).w).toBe(2.25); // Left Shift
    expect(by(44).w).toBeGreaterThan(5); // Space
    expect(extent(d).width).toBeGreaterThan(15);
  });
});
