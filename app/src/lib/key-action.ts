// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { entryLabel } from "./hid-usages";

// Firmware locations and exact slot comparisons: docs/PROTOCOL.md,
// Mac modifiers. These are base-layer transformations before Fn overrides.
const MAC_MODIFIERS: Record<number, Record<number, Record<number, number>>> = {
  2730: {
    11: { 0xe3: 0xe2 },
    17: { 0xe2: 0xe3 },
    65: { 0xe6: 0xe7 },
    77: { 0x65: 0xe6 },
  },
  1478: {
    17: { 0xe3: 0xe2 },
    23: { 0xe2: 0xe3 },
    65: { 0xe6: 0xe7, 0xe7: 0xe6 },
  },
};

export const hasMacKeyActions = (deviceId: number | undefined): boolean =>
  deviceId !== undefined && Object.prototype.hasOwnProperty.call(MAC_MODIFIERS, deviceId);

export function keyActionEntry(
  entry: number[], slot: number | null, deviceId: number | undefined,
  macMode: boolean, fnLayer = false,
): number[] {
  if (!hasMacKeyActions(deviceId) || !macMode || fnLayer || slot === null ||
      entry.length !== 4 || entry[0] !== 0 || entry[1] !== 0 || entry[3] !== 0)
    return entry;
  const usage = MAC_MODIFIERS[deviceId!][slot]?.[entry[2]];
  return usage === undefined ? entry : [0, 0, usage, 0];
}

export function keyActionLabel(
  entry: number[], slot: number | null, deviceId: number | undefined,
  macMode: boolean, fnLayer = false,
): string {
  const effective = keyActionEntry(entry, slot, deviceId, macMode, fnLayer);
  if (!hasMacKeyActions(deviceId) || !macMode || fnLayer) return entryLabel(effective, fnLayer);
  return entryLabel(effective)
    .replace(/L-Alt/g, "L-Option").replace(/R-Alt/g, "R-Option")
    .replace(/L-Win/g, "L-Command").replace(/R-Win/g, "R-Command");
}
