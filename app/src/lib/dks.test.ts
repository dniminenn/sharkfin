// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { decodeDks, encodeDks } from "./dks";

describe("dynamic keystroke cells", () => {
  it("round-trips taps and holds", () => {
    for (let start = 0; start < 4; start++) {
      expect(decodeDks(encodeDks({ start, end: start }))).toEqual({ start, end: start });
      for (let end = start + 1; end <= 3; end++) {
        expect(decodeDks(encodeDks({ start, end }))).toEqual({ start, end });
      }
    }
    expect(encodeDks({ start: null, end: 0 })).toBe(0);
    expect(decodeDks(0)).toEqual({ start: null, end: 0 });
  });

  it("encodes the way the 2268 engine reads", () => {
    // Press at the first point, release at the second: cell 0 = 2.
    expect(encodeDks({ start: 0, end: 1 })).toBe(0b10);
    // Held from the first point to the last release: 3, 3, 2, 0.
    expect(encodeDks({ start: 0, end: 3 })).toBe(0b00_10_11_11);
    // A run of 3s with no closing 2 releases when the run ends.
    expect(decodeDks(0b00_00_11_11)).toEqual({ start: 0, end: 2 });
    // All 3s: the last event clears the hold.
    expect(decodeDks(0b11_11_11_11)).toEqual({ start: 0, end: 3 });
    // A tap at the last event.
    expect(encodeDks({ start: 3, end: 3 })).toBe(0b01_00_00_00);
  });
});
