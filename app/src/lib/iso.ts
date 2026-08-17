// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// An ISO picture built from an ANSI one.
//
// Almost every layout the vendor ships is ANSI, and ISO boards keep turning
// up: a KiiP Y87 reports keys no ANSI picture draws. The difference between
// the two is mechanical, so the picture can be derived rather than waiting
// for someone to draw each board:
//
//   left Shift gives up a unit to NonUsBackslash beside it
//   Enter gives up a unit to NonUsHash beside it
//
// The result is offered like any other candidate and matched against the
// board's own keymap. Scoring alone does not keep it away from an ANSI
// board: the two pictures differ by one slot out of eighty-odd, so an ISO
// variant can outrank the picture that is actually right by a rounding
// error. What keeps them apart is looksIso below. Enter stays rectangular
// rather than becoming the tall ISO key: this is for identifying and
// editing keys, not for a faithful render.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";

const NON_US_BACKSLASH = 100; // 0x64, beside left Shift
const NON_US_HASH = 50; // 0x32, beside Enter

/**
 * Does this board report keys that only an ISO layout has?
 *
 * Both of them, not either. One alone is not evidence: an ANSI board is
 * built on the same PCB as its ISO version and its firmware maps the empty
 * position anyway. A Cypher 81 reports NonUsBackslash at slot 10 with no
 * such key on the board, and no firmware keymap on record carries one of
 * the two without the other. Taking either as ISO drew a key the owner
 * could not press.
 */
export function looksIso(matrix: number[]): boolean {
  let backslash = false;
  let hash = false;
  for (let s = 0; s * 4 + 3 < matrix.length; s++) {
    if (matrix[s * 4] !== 0) continue;
    const usage = matrix[s * 4 + 2];
    if (usage === NON_US_BACKSLASH) backslash = true;
    if (usage === NON_US_HASH) hash = true;
  }
  return backslash && hash;
}

/** The width of a plain 1u key, taken from the letters rather than assumed. */
function unitWidth(keys: LayoutKey[]): number | null {
  const letters = keys
    .filter((k) => /^Key[A-Z]$/.test(k.code) && k.w > 0)
    .map((k) => k.w)
    .sort((a, b) => a - b);
  return letters.length ? letters[Math.floor(letters.length / 2)] : null;
}

function splitKey(
  keys: LayoutKey[],
  hostCode: string,
  usage: number,
  code: string,
  text: string,
  unit: number,
  side: "left" | "right",
): boolean {
  const host = keys.find((k) => k.code === hostCode);
  // Only a host wide enough to give up a unit and still be a key.
  if (!host || host.w < unit * 2) return false;
  const born: LayoutKey = {
    code,
    type: "key",
    x: side === "left" ? host.x : host.x + host.w - unit,
    y: host.y,
    w: unit,
    h: host.h,
    text,
    matrixIndex: null,
    matrixEntry: [0, 0, usage, 0],
    hidUsage: usage,
    consumerUsage: null,
  };
  host.w -= unit;
  if (side === "left") host.x += unit;
  keys.push(born);
  return true;
}

/**
 * An ISO version of an ANSI layout, or null when there is nothing to do:
 * the layout already has the keys, or lacks the ones to split.
 */
export function isoVariant(layout: BoardLayout): BoardLayout | null {
  const has = (u: number) => layout.keys.some((k) => k.hidUsage === u);
  if (has(NON_US_BACKSLASH) && has(NON_US_HASH)) return null;

  const keys: LayoutKey[] = layout.keys.map((k) => ({ ...k, matrixIndex: null }));
  const unit = unitWidth(keys);
  if (!unit) return null;

  let grew = false;
  if (!has(NON_US_BACKSLASH)) {
    grew = splitKey(keys, "ShiftLeft", NON_US_BACKSLASH, "IntlBackslash", "\\", unit, "left") || grew;
  }
  if (!has(NON_US_HASH)) {
    grew = splitKey(keys, "Enter", NON_US_HASH, "IntlHash", "#", unit, "left") || grew;
  }
  if (!grew) return null;

  return { ...layout, keys, iso: true };
}

/** What a derived picture is called. It names no file on disk. */
export const ISO_SUFFIX = "+iso";
export const isoName = (stem: string) => `${stem}${ISO_SUFFIX}`;

/**
 * Geometry for a picture by name, deriving the ISO version when the name
 * carries the suffix.
 *
 * A stored answer names the picture the owner confirmed, and a derived one
 * has no file to load: reading it back as a stem finds nothing, and the
 * board a picture was already found for falls back to the slot grid.
 */
export async function resolvePicture(
  picture: string,
  load: (stem: string) => Promise<BoardLayout | null>,
): Promise<BoardLayout | null> {
  if (!picture.endsWith(ISO_SUFFIX)) return load(picture);
  const base = await load(picture.slice(0, -ISO_SUFFIX.length));
  return base ? isoVariant(base) : null;
}
