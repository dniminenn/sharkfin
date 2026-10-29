// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { keyActionLabel } from "./key-action";

it.each([
  [11, 0xe3, "L-Option"], [17, 0xe2, "L-Command"],
  [65, 0xe6, "R-Command"], [77, 0x65, "R-Option"],
] as const)("translates K86 factory slot %i", (slot, usage, expected) => {
  expect(keyActionLabel([0, 0, usage, 0], slot, 2730, true)).toBe(expected);
});

it("requires both the position and complete factory assignment", () => {
  const label = (slot: number, entry: number[]) => keyActionLabel(entry, slot, 2730, true);
  expect(label(0, [0, 0, 0xe3, 0])).toBe("L-Command");
  expect(label(0, [0, 0, 0xe2, 0])).toBe("L-Option");
  expect(label(0, [0, 0, 0xe6, 0])).toBe("R-Option");
  expect(label(11, [0, 0, 0xe0, 0])).toBe("L-Ctrl");
  expect(label(11, [0, 0, 0xe2, 0])).toBe("L-Option");
  expect(label(17, [0, 0, 0xe3, 0])).toBe("L-Command");
  const combo = [0, 0xe3, 6, 0];
  expect(label(11, combo)).toBe("L-Command+C");
  expect(label(11, [0, 6, 0xe3, 0])).toBe("C+L-Command");
  expect(combo).toEqual([0, 0xe3, 6, 0]);
});

it("leaves other devices, Windows mode and Fn assignments alone", () => {
  const win = [0, 0, 0xe3, 0];
  expect(keyActionLabel(win, 11, 2730, false)).toBe("L-Win");
  expect(keyActionLabel(win, 11, 2936, true)).toBe("L-Win");
  expect(keyActionLabel(win, 11, undefined, true)).toBe("L-Win");
  expect(keyActionLabel(win, 11, 2730, true, true)).toBe("L-Win");
  expect(keyActionLabel(win, null, 2730, true)).toBe("L-Command");
  expect(win).toEqual([0, 0, 0xe3, 0]);
});

it.each([
  [17, 0xe3, "L-Option"], [23, 0xe2, "L-Command"],
  [65, 0xe6, "R-Command"], [65, 0xe7, "R-Option"],
] as const)("translates VGN A75 slot %i", (slot, usage, expected) => {
  expect(keyActionLabel([0, 0, usage, 0], slot, 1478, true)).toBe(expected);
});

it("keeps the A75 and K86 physical positions distinct", () => {
  expect(keyActionLabel([0, 0, 0xe3, 0], 11, 1478, true)).toBe("L-Command");
  expect(keyActionLabel([0, 0, 0xe2, 0], 17, 1478, true)).toBe("L-Option");
  expect(keyActionLabel([0, 0, 0xe2, 0], 23, 2730, true)).toBe("L-Option");
});
