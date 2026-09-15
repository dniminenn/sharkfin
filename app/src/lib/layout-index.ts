// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// A digest of every vendor picture's factory entries, so the collection can
// be scored against a board's keymap without fetching the pictures. The
// match reads nothing but each key's matrixEntry, in key order, so a stub
// built from the digest scores exactly as the picture would. The build
// config imports this file, so imports here are relative and runtime-free.
import { isoVariant } from "./iso";
import type { BoardLayout, LayoutKey } from "./layout-loader";

export interface LayoutIndex {
  /** Packed entries of every key that has one, by stem, in key order. */
  entries: Record<string, number[]>;
  /** Packed entries of the keys the ISO derivation appends, for stems that
   *  have one. The derivation is the picture's own keys followed by these. */
  iso: Record<string, number[]>;
}

export const pack = (e: number[]) => ((e[0] << 24) | (e[1] << 16) | (e[2] << 8) | e[3]) >>> 0;

export const unpack = (n: number): number[] => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const entriesOf = (keys: LayoutKey[]) =>
  keys.filter((k) => k.matrixEntry).map((k) => pack(k.matrixEntry as number[]));

export function buildIndex(layouts: Record<string, BoardLayout>): LayoutIndex {
  const index: LayoutIndex = { entries: {}, iso: {} };
  for (const stem of Object.keys(layouts).sort()) {
    const layout = layouts[stem];
    index.entries[stem] = entriesOf(layout.keys);
    const iso = isoVariant(layout);
    if (iso) index.iso[stem] = entriesOf(iso.keys.slice(layout.keys.length));
  }
  return index;
}

/** A layout with no geometry that matches like the picture it digests. */
export function stubLayout(entries: number[]): BoardLayout {
  return {
    canvas: { width: 0, height: 0 },
    keys: entries.map((n) => ({
      code: "",
      type: "key",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      text: "",
      matrixIndex: null,
      matrixEntry: unpack(n),
      hidUsage: null,
      consumerUsage: null,
    })),
  };
}
