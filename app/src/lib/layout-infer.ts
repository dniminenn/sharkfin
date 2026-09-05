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
import { ISO_SUFFIX } from "@/lib/iso";

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
  // A derived picture names no file on disk, so it travels with the bundle.
  // "kle" is the owner's drawing; "<stem>+iso" is an ANSI layout with the
  // ISO keys added.
  if (inf.layoutName === "kle" || inf.layoutName.includes("+")) {
    const geometry = {
      canvas: inf.layout.canvas,
      keys: inf.layout.keys.map((k) => ({ ...k, matrixIndex: null })),
    };
    lines.push("picture json:", JSON.stringify(geometry));
  }
  lines.push("```");
  return lines.join("\n");
}

/** How much of a layout's shipped slot data the board itself agrees with.
 *  1 means every key sits where the file says; a remapped board scores
 *  lower, and so does a board the file was never right for. */
export function agreement(layout: BoardLayout, matrix: number[]): number {
  let hit = 0;
  let total = 0;
  for (const k of layout.keys) {
    if (k.matrixIndex === null || !k.matrixEntry) continue;
    const at = k.matrixIndex * 4;
    if (at + 3 >= matrix.length) continue;
    total++;
    if (k.matrixEntry.every((b, i) => b === matrix[at + i])) hit++;
  }
  return total ? hit / total : 1;
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
  // An unmatched key must lose whatever slot the file gave it. Keeping it
  // would mix the assignment being replaced into the one replacing it, and
  // two keys can then claim the same slot.
  const keys: LayoutKey[] = base.keys.map((k) => {
    if (!k.matrixEntry) return { ...k, matrixIndex: null };
    total++;
    const et = k.matrixEntry.join(",");
    const nth = counts.get(et) ?? 0;
    counts.set(et, nth + 1);
    const hits = bySlot.get(et);
    if (!hits || nth >= hits.length) return { ...k, matrixIndex: null };
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

/** The picture a derived name was built from. */
const bodyOf = (name: string) =>
  name.endsWith(ISO_SUFFIX) ? name.slice(0, -ISO_SUFFIX.length) : name;

/** Order the pictures offered for a board so each body appears once, its
 *  variants together, best first. Ranked flat, an ISO derivation beats its
 *  own ANSI parent on every ANSI board whose keymap parks the two ISO
 *  usages in unfitted slots, since it explains two more entries at no
 *  cost; the top of the list is then eight derivations of different
 *  bodies and the plain picture the board has is never reached. The
 *  registry's own suggestion leads whichever way it scores. */
export function rankCandidates(
  candidates: Inference[],
  suggested: string,
  maxBodies: number,
): Inference[] {
  const byBody = new Map<string, Inference[]>();
  for (const c of candidates) {
    const body = bodyOf(c.layoutName);
    const list = byBody.get(body);
    if (list) list.push(c);
    else byBody.set(body, [c]);
  }
  const better = (a: Inference, b: Inference) =>
    b.f1 - a.f1 || a.ambiguous.length - b.ambiguous.length;
  const bodies = [...byBody.entries()].map(([body, list]) => {
    list.sort(better);
    return { body, list };
  });
  const wanted = bodyOf(suggested);
  bodies.sort(
    (a, b) =>
      Number(b.body === wanted) - Number(a.body === wanted) ||
      better(a.list[0], b.list[0]),
  );
  return bodies.slice(0, maxBodies).flatMap((g) => g.list);
}
