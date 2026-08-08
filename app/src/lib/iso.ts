// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// An ISO picture built from an ANSI one.
//
// Almost every layout the vendor ships is ANSI, and ISO boards keep turning
// up: a KiiP Y87 and a ROYALAXE L98 both report keys no ANSI picture draws.
// The difference between the two is mechanical, so the picture can be
// derived rather than waiting for someone to draw each board:
//
//   left Shift gives up a unit to NonUsBackslash beside it
//   Enter gives up a unit to NonUsHash beside it
//
// The result is offered like any other candidate and matched against the
// board's own keymap, so a board that is not ISO simply scores worse and
// never sees it. Enter stays rectangular rather than becoming the tall ISO
// key: this is for identifying and editing keys, not for a faithful render.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";

const NON_US_BACKSLASH = 100; // 0x64, beside left Shift
const NON_US_HASH = 50; // 0x32, beside Enter

/** Does this board report keys that only an ISO layout has? */
export function looksIso(matrix: number[]): boolean {
  for (let s = 0; s * 4 + 3 < matrix.length; s++) {
    const usage = matrix[s * 4 + 2];
    if (matrix[s * 4] === 0 && (usage === NON_US_BACKSLASH || usage === NON_US_HASH)) {
      return true;
    }
  }
  return false;
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
