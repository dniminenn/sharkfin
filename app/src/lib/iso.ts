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
// The result is offered behind the picture it was built from, never ahead
// of it. The keymap cannot tell the two apart: the firmware maps the ISO
// positions whether or not a key sits there, so on an ANSI board the
// derived picture explains two more entries than the right one and would
// outscore it. An Attack Shark K86 reports NonUsBackslash, NonUsHash and
// the US backslash all at once with an ANSI shell. The owner picks the
// derived picture by saying no to the plain one. Enter stays rectangular
// rather than becoming the tall ISO key: this is for identifying and
// editing keys, not for a faithful render.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";

const NON_US_BACKSLASH = 100; // 0x64, beside left Shift
const NON_US_HASH = 50; // 0x32, beside Enter

/**
 * Could this board be ISO: does it report both keys only an ISO layout has?
 *
 * Necessary, not sufficient. A board without both cannot be ISO, so its
 * derivation is never built. A board with both may still be ANSI: it
 * shares a PCB with its ISO version and the firmware maps the empty
 * positions anyway. Most keymaps on record carry both, and a Cypher 81
 * carries one with no key on the board.
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
