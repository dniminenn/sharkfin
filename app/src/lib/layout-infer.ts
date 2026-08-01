// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Resolve layout keys to matrix slots by matching each key's factory
// matrixEntry against a keymap read from the board. Extraction does the same
// against the vendor bundle's defaultMatrix; when the bundle carried none,
// the board itself is the only remaining source. The match is only
// trustworthy on a board that still has its factory keymap, so callers gate
// on matchRate and the user confirms the picture before writes are allowed.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";
import type { ConnectedDevice } from "@/lib/backend";
import { deviceLabel } from "@/lib/brands";

export interface Inference {
  layout: BoardLayout;
  /** Keys resolved to a slot. */
  matched: number;
  /** Keys that have a factory entry to match with. */
  total: number;
  matchRate: number;
  /** Symmetric score: penalizes keymap entries the layout does not explain,
   *  so a small pad cannot outrank a full board it is a subset of. */
  f1: number;
  /** Slots whose entry appears more than once; their pairing is a guess. */
  ambiguous: number[];
  /** The keymap the match ran against, for a contribution bundle. */
  matrix: number[];
  /** Which profile that keymap came from; set by the caller. */
  profile: number;
  /** Where the geometry came from: a vendor file's stem, or "kle" for a
   *  drawing the owner pasted. Set by the caller. */
  layoutName: string;
}

// Everything needed to bake the matched slots into the layout file: the
// board, the geometry the owner confirmed, and the keymap the match ran
// against. A drawing that exists in no vendor file rides along as JSON.
export function layoutBundle(
  device: ConnectedDevice,
  inf: Inference,
  verdict: "right" | "wrong",
): string {
  const hex: string[] = [];
  for (let i = 0; i < inf.matrix.length; i += 16) {
    hex.push(
      inf.matrix
        .slice(i, i + 16)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" "),
    );
  }
  const lines = [
    "```",
    "sharkfin layout bundle",
    `board   : ${deviceLabel(device.spec)} (device id ${device.spec.id})`,
    `layout  : ${device.spec.keyLayout}`,
  ];
  if (inf.layoutName && inf.layoutName !== device.spec.keyLayout)
    lines.push(`picture : ${inf.layoutName}`);
  lines.push(
    `matched : ${inf.matched}/${inf.total} keys` +
      (inf.ambiguous.length ? `, ${inf.ambiguous.length} ambiguous` : ""),
    `verdict : ${verdict === "right" ? "looks right" : "does not match"}`,
    `keymap, profile ${inf.profile + 1}, base layer:`,
    ...hex,
  );
  if (inf.layoutName === "kle") {
    const geometry = {
      canvas: inf.layout.canvas,
      keys: inf.layout.keys.map((k) => ({ ...k, matrixIndex: null })),
    };
    lines.push("picture json:", JSON.stringify(geometry));
  }
  lines.push("```");
  return lines.join("\n");
}

export function inferSlots(base: BoardLayout, matrix: number[]): Inference {
  const bySlot = new Map<string, number[]>();
  for (let s = 0; s * 4 + 3 < matrix.length; s++) {
    const et = matrix.slice(s * 4, s * 4 + 4).join(",");
    if (et === "0,0,0,0") continue;
    const list = bySlot.get(et);
    if (list) list.push(s);
    else bySlot.set(et, [s]);
  }
  const counts = new Map<string, number>();
  const ambiguous: number[] = [];
  let matched = 0;
  let total = 0;
  const keys: LayoutKey[] = base.keys.map((k) => {
    if (!k.matrixEntry) return { ...k };
    total++;
    const et = k.matrixEntry.join(",");
    const nth = counts.get(et) ?? 0;
    counts.set(et, nth + 1);
    const hits = bySlot.get(et);
    if (!hits || nth >= hits.length) return { ...k };
    matched++;
    if (hits.length > 1) ambiguous.push(hits[nth]);
    return { ...k, matrixIndex: hits[nth] };
  });
  let nonzero = 0;
  for (const hits of bySlot.values()) nonzero += hits.length;
  return {
    layout: { ...base, keys, inferred: true },
    matched,
    total,
    matchRate: total ? matched / total : 0,
    f1: total + nonzero ? (2 * matched) / (total + nonzero) : 0,
    ambiguous,
    matrix,
    profile: 0,
    layoutName: "",
  };
}
