// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The board's frame time depends on the animation's own frame count (a
// K86 ran 100 frames at 50 ms each and 192 frames at about 128 ms each,
// with the formula unestablished), so Hold and Fade are both frame
// counts rather than a duration: this builds the frame sequence on the
// host, holding each saved pattern for a stretch of repeated frames and
// crossfading between patterns with frames interpolated per key, per RGB
// channel.

/** SET_USERGIF's frame count is one byte. */
export const MAX_ANIMATION_FRAMES = 255;

function lerpChannel(a: number, b: number, t: number): number {
  return Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));
}

function lerpColor(a: string, b: string, t: number): string {
  const av = parseInt(a.slice(1), 16);
  const bv = parseInt(b.slice(1), 16);
  const r = lerpChannel((av >> 16) & 0xff, (bv >> 16) & 0xff, t);
  const g = lerpChannel((av >> 8) & 0xff, (bv >> 8) & 0xff, t);
  const b2 = lerpChannel(av & 0xff, bv & 0xff, t);
  return `#${((r << 16) | (g << 8) | b2).toString(16).padStart(6, "0")}`;
}

/** The `step`th of `steps` in-between patterns from `a` to `b` (1..steps). */
export function fadePattern(a: string[], b: string[], step: number, steps: number): string[] {
  const t = step / (steps + 1);
  return a.map((c, i) => lerpColor(c, b[i] ?? c, t));
}

export interface BuiltAnimation {
  patterns: string[][];
  /** The hold actually used, in frames, after any shortening. */
  hold: number;
  /** The fade actually used, in frames, after any shortening. */
  fade: number;
  /** True if the hold or the fade had to be reduced to fit the frame cap. */
  shortened: boolean;
}

/**
 * Sequences saved patterns into the frames SET_USERGIF sends. Each
 * pattern is repeated `hold` times, at least once; then `fade` frames
 * interpolated toward the next pattern lead the crossfade, wrapping from
 * the last pattern back to the first so the loop is smooth. The hold is
 * reduced first, then the fade, if the total would pass SET_USERGIF's
 * one-byte frame count; `shortened` reports whether that happened, and
 * `hold`/`fade` are the values actually used.
 */
export function buildAnimation(patterns: string[][], hold: number, fade: number): BuiltAnimation {
  const n = patterns.length;
  if (n === 0) return { patterns: [], hold, fade, shortened: false };

  let h = Math.max(1, Math.round(hold));
  let f = Math.max(0, Math.round(fade));
  let shortened = false;

  const perPatternCap = Math.floor(MAX_ANIMATION_FRAMES / n);
  if (h + f > perPatternCap) {
    const maxHold = Math.max(1, perPatternCap - f);
    if (h > maxHold) {
      h = maxHold;
      shortened = true;
    }
  }
  if (h + f > perPatternCap) {
    const maxFade = Math.max(0, perPatternCap - h);
    if (f > maxFade) {
      f = maxFade;
      shortened = true;
    }
  }

  const frames: string[][] = [];
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < h; r++) frames.push(patterns[i]);
    const next = patterns[(i + 1) % n];
    for (let step = 1; step <= f; step++) {
      frames.push(fadePattern(patterns[i], next, step, f));
    }
  }
  return { patterns: frames, hold: h, fade: f, shortened };
}
