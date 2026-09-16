// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { buildAnimation, fadePattern, MAX_ANIMATION_FRAMES } from "@/lib/key-animation";

describe("fadePattern", () => {
  it("interpolates each channel linearly and rounds to an integer", () => {
    const a = ["#000000"];
    const b = ["#ff8000"];
    // Halfway of one step between them (step 1 of 1).
    expect(fadePattern(a, b, 1, 1)).toEqual(["#804000"]);
  });

  it("keeps a key unchanged when both ends agree", () => {
    const a = ["#123456", "#abcdef"];
    expect(fadePattern(a, a, 1, 3)).toEqual(a);
  });
});

describe("buildAnimation", () => {
  const p1 = Array(4).fill("#000000");
  const p2 = Array(4).fill("#ffffff");
  const p3 = Array(4).fill("#ff0000");

  it("holds each pattern for `hold` frames, then fades to the next, wrapping last to first", () => {
    const built = buildAnimation([p1, p2], 12, 8);
    expect(built.hold).toBe(12);
    expect(built.fade).toBe(8);
    expect(built.shortened).toBe(false);
    expect(built.patterns).toHaveLength(2 * (12 + 8));
    expect(built.patterns.slice(0, 12)).toEqual(Array(12).fill(p1));
    expect(built.patterns[12]).toEqual(fadePattern(p1, p2, 1, 8));
    expect(built.patterns[19]).toEqual(fadePattern(p1, p2, 8, 8));
    expect(built.patterns.slice(20, 32)).toEqual(Array(12).fill(p2));
    expect(built.patterns[39]).toEqual(fadePattern(p2, p1, 8, 8)); // wraps back to p1
  });

  it("holds at least one frame even when asked for zero", () => {
    const built = buildAnimation([p1, p2, p3], 0, 0);
    expect(built.patterns).toEqual([p1, p2, p3]);
    expect(built.hold).toBe(1);
    expect(built.fade).toBe(0);
  });

  it("never overflows the frame count with the page's own caps", () => {
    const patterns = Array.from({ length: 6 }, () => p1);
    const built = buildAnimation(patterns, 60, 30);
    expect(built.patterns.length).toBeLessThanOrEqual(MAX_ANIMATION_FRAMES);
  });

  it("shortens the hold, not the fade, when the two together would not fit", () => {
    const built = buildAnimation([p1, p2], 200, 8);
    expect(built.patterns.length).toBeLessThanOrEqual(MAX_ANIMATION_FRAMES);
    expect(built.shortened).toBe(true);
    expect(built.fade).toBe(8);
    expect(built.hold).toBeLessThan(200);
    expect(built.hold).toBeGreaterThan(1);
  });

  it("shortens the fade too once the hold is already at its floor of one frame", () => {
    const built = buildAnimation([p1, p2], 1, 200);
    expect(built.patterns.length).toBeLessThanOrEqual(MAX_ANIMATION_FRAMES);
    expect(built.shortened).toBe(true);
    expect(built.hold).toBe(1);
    expect(built.fade).toBeLessThan(200);
  });

  it("does not choke on an empty book", () => {
    expect(buildAnimation([], 12, 8)).toEqual({
      patterns: [],
      hold: 12,
      fade: 8,
      shortened: false,
    });
  });
});
