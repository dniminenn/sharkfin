// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { YC500, breathFrames, colorAt, wireSpeed, type EffectParam } from "./effects";

const base: EffectParam = {
  mode: 1,
  speed: 4,
  brightness: 4,
  brightnessMax: 4,
  option: 0,
  rainbow: false,
  r: 200,
  g: 100,
  b: 50,
};

describe("effects", () => {
  it("maps host speed to the wire of each family", () => {
    expect(wireSpeed("yc500", 0)).toBe(5);
    expect(wireSpeed("yc500", 4)).toBe(1);
    expect(wireSpeed("gen2", 0)).toBe(4);
    expect(wireSpeed("gen2", 4)).toBe(0);
  });

  it("times a yc500 breath from the ramp table and the hold", () => {
    expect(breathFrames("yc500", 5)).toBe(2 * (YC500.breath[5] + YC500.hold));
    expect(breathFrames("yc500", 1)).toBe(2 * (40 + 20));
  });

  it("paints static in the chosen colour at full brightness", () => {
    expect(colorAt("gen2", base, { x: 0.3, y: 0.5 }, 0, 123)).toEqual([200, 100, 50]);
  });

  it("dims with brightness", () => {
    expect(colorAt("gen2", { ...base, brightness: 2 }, { x: 0.3, y: 0.5 }, 0, 0)).toEqual([100, 50, 25]);
  });

  it("keeps every effect inside the byte range over time", () => {
    const modes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];
    for (const family of ["yc500", "gen2"] as const) {
      for (const mode of modes) {
        for (const rainbow of [false, true]) {
          for (let frame = 0; frame < 3000; frame += 37) {
            const c = colorAt(family, { ...base, mode, rainbow }, { x: 0.71, y: 0.33 }, 17, frame);
            for (const v of c) {
              expect(Number.isInteger(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(255);
            }
          }
        }
      }
    }
  });

  it("paces flow one cell per table entry of frames", () => {
    // Wire 1 (host 4) steps every 10 frames. The first cell is dark while
    // the head sits on it, lit while the head is up to six cells past it,
    // dark again after that.
    const p = { ...base, mode: 7, speed: 4, rainbow: false };
    const lit = (f: number) => colorAt("yc500", p, { x: 0.03, y: 0.08 }, 0, f).some((v) => v > 0);
    expect(lit(0)).toBe(false);
    expect(lit(10)).toBe(true);
    expect(lit(55)).toBe(true);
    expect(lit(70)).toBe(false);
  });

  it("holds spectrum still at the slowest yc500 speed, as the table says", () => {
    const p = { ...base, mode: 3, speed: 0, rainbow: true };
    expect(colorAt("yc500", p, { x: 0.5, y: 0.5 }, 0, 0)).toEqual(colorAt("yc500", p, { x: 0.5, y: 0.5 }, 0, 5000));
  });

  it("breathes back to dark within one cycle", () => {
    const total = breathFrames("yc500", 3);
    const dark = colorAt("yc500", { ...base, mode: 2, speed: 2 }, { x: 0.5, y: 0.5 }, 0, total);
    expect(dark).toEqual([0, 0, 0]);
    const bright = colorAt("yc500", { ...base, mode: 2, speed: 2 }, { x: 0.5, y: 0.5 }, 0, YC500.breath[3] + 1);
    expect(bright).toEqual([200, 100, 50]);
  });
});
