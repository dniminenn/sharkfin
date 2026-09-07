// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// A sketch of each backlight effect for the Lighting page preview. The
// timing comes from the firmware (docs/PROTOCOL.md, "Timing"): both
// families render on a 5 ms tick; yc500 paces each mode from its own
// speed table, gen2 from a formula of the wire speed. Layers and Sine
// wave follow the yc500 firmware's scripts. The other shapes are
// approximations; the board's own routines were not transcribed.

export const FRAME_MS = 5;

export type Family = "yc500" | "gen2";

export interface EffectParam {
  mode: number;
  /** Host speed 0..4, as the Lighting page holds it. */
  speed: number;
  brightness: number;
  brightnessMax: number;
  option: number;
  /** The rainbow flag; colour is ignored. */
  rainbow: boolean;
  r: number;
  g: number;
  b: number;
}

/** A key's centre, 0..1 across the picture. */
export interface Led {
  x: number;
  y: number;
}

export type Rgb = [number, number, number];

/** The firmware's preset palette, flags 0..7. Rainbow modes walk it. */
export const PRESETS: Rgb[] = [
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
  [255, 255, 255],
];

/** yc500 speed tables from the RT100 firmware, indexed by wire speed
 *  0..5. Wire 6 and up read past a table into the next, which is why an
 *  out-of-range speed runs faster. */
export const YC500 = {
  /** Frames per ramp of a breath. */
  breath: [10, 40, 60, 80, 100, 200],
  /** Frames held at each end of a breath. */
  hold: 20,
  /** Hue increment every 2 frames for Spectrum cycle. 0 stands still. */
  spectrum: [5, 4, 3, 2, 1, 0],
  /** Hue increment per frame, plus one, for Wave, Spring, Neon and Loop. */
  hue: [5, 4, 3, 2, 1, 0],
  /** Frames per step. */
  ripple: [5, 7, 9, 11, 13, 12],
  radiant: [5, 7, 9, 11, 13, 12],
  stars: [5, 10, 15, 20, 25, 12],
  flow: [5, 10, 15, 20, 25, 12],
  layers: [2, 3, 5, 7, 9, 11],
  sine: [5, 7, 10, 14, 17, 20],
};
/** One full turn of the hue walker: six ramps of 255. */
const HUE_CYCLE = 6 * 255;

/** The Layers script (mode 9) as the RT100 firmware stores it: how many
 *  LEDs light per step, and their row and column on a 6 x 18 grid, in
 *  order. 255 pauses five steps and changes colour; 0 rests 25 steps and
 *  starts over. */
const LAYERS_COUNTS = [4, 4, 6, 6, 5, 5, 5, 6, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 255, 13, 11, 11, 10, 8, 11, 12, 8, 10, 0];
const LAYERS_CELLS = [
  [0, 0], [1, 0], [5, 17], [5, 16], [2, 0], [1, 1], [4, 16], [3, 16], [0, 2], [1, 2], [2, 1], [5, 15], [4, 15], [3, 15],
  [0, 3], [1, 3], [2, 2], [5, 14], [4, 14], [3, 14], [0, 4], [1, 4], [2, 3], [5, 13], [4, 13], [0, 5], [1, 5], [2, 4],
  [5, 12], [3, 13], [0, 6], [1, 6], [2, 5], [5, 11], [4, 12], [0, 7], [1, 7], [2, 6], [5, 10], [4, 11], [3, 11],
  [1, 10], [2, 10], [3, 10], [4, 10], [4, 9], [4, 8], [3, 7], [2, 7], [1, 8], [1, 9], [2, 9], [3, 9], [3, 8], [2, 8],
  [1, 10], [2, 10], [3, 10], [4, 10], [4, 9], [4, 8], [3, 7], [2, 7], [1, 8], [1, 9], [2, 9], [3, 9], [3, 8], [2, 8],
  [255, 255],
  [1, 10], [2, 10], [3, 10], [4, 10], [4, 9], [4, 8], [3, 7], [2, 7], [1, 8], [1, 9], [0, 8], [0, 9], [5, 9],
  [0, 10], [1, 11], [2, 11], [3, 11], [4, 11], [5, 10], [0, 7], [1, 7], [2, 6], [3, 6], [4, 7],
  [0, 11], [1, 12], [2, 12], [4, 12], [5, 11], [0, 6], [1, 6], [2, 5], [3, 5], [4, 6], [5, 6],
  [0, 12], [1, 13], [2, 13], [3, 13], [5, 12], [0, 5], [1, 5], [2, 4], [3, 4], [4, 5],
  [0, 13], [4, 13], [5, 13], [0, 4], [1, 4], [2, 3], [3, 3], [4, 4],
  [0, 14], [1, 14], [2, 14], [3, 14], [4, 14], [5, 14], [0, 3], [1, 3], [2, 2], [3, 2], [4, 3],
  [0, 15], [1, 15], [2, 15], [3, 15], [4, 15], [5, 15], [0, 2], [1, 2], [2, 1], [3, 1], [4, 2], [5, 3],
  [0, 16], [1, 16], [2, 16], [3, 16], [4, 16], [5, 16], [1, 1], [5, 2],
  [0, 17], [1, 17], [3, 17], [5, 17], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
];
const LAYERS_PAUSE = 5;
const LAYERS_REST = 25;
const GRID_ROWS = 6;
const GRID_COLS = 18;

interface ScriptItem {
  step: number;
  phase: number;
}

/** Per grid cell, the steps at which the script lights it and in which
 *  colour phase, plus the cycle length in steps. */
const LAYERS = (() => {
  const cells = new Map<number, ScriptItem[]>();
  let step = 0;
  let phase = 0;
  let at = 0;
  for (const n of LAYERS_COUNTS) {
    if (n === 0) break;
    if (n === 255) {
      step += LAYERS_PAUSE;
      phase++;
      at++; // the (255, 255) placeholder pair
      continue;
    }
    for (let i = 0; i < n && at < LAYERS_CELLS.length; i++, at++) {
      const [row, col] = LAYERS_CELLS[at];
      const key = row * GRID_COLS + col;
      const list = cells.get(key) ?? [];
      list.push({ step, phase });
      cells.set(key, list);
    }
    step++;
  }
  return { cells, total: step + LAYERS_REST };
})();

/** Host 0..4 to the wire byte: yc500 1..5 inverted, gen2 0..4 inverted. */
export function wireSpeed(family: Family, host: number): number {
  const h = Math.max(0, Math.min(4, host));
  return family === "yc500" ? 5 - h : 4 - h;
}

const tab = (t: number[], wire: number) => t[Math.min(wire, t.length - 1)];

/** Frames between steps of a stepped effect. */
function stepFrames(family: Family, mode: number, wire: number): number {
  if (family === "yc500") {
    switch (mode) {
      case 5:
        return tab(YC500.ripple, wire);
      case 14:
        return tab(YC500.radiant, wire);
      case 6:
        return tab(YC500.stars, wire);
      case 7:
        return tab(YC500.flow, wire);
      case 9:
        return tab(YC500.layers, wire);
      case 10:
        return tab(YC500.sine, wire);
      default:
        return 8;
    }
  }
  // gen2: event modes wait a base of frames times (1 + wire).
  switch (mode) {
    case 3:
    case 5:
      return 200 + 200 * wire;
    case 4:
    case 15:
      return 250 + 250 * wire;
    case 7:
      return 100 + 100 * wire;
    case 8:
      return 500 + 250 * wire;
    case 12:
      return 100 + 200 * wire;
    case 16:
      return 100 + 150 * wire;
    default:
      return 8;
  }
}

/** Hue turns completed by a frame, for the modes that walk the palette. */
function hueTurns(family: Family, mode: number, wire: number, frame: number): number {
  if (family === "yc500") {
    if (mode === 3) return (Math.floor(frame / 2) * tab(YC500.spectrum, wire)) / HUE_CYCLE;
    return (frame * (tab(YC500.hue, wire) + 1)) / HUE_CYCLE;
  }
  // gen2 movers step 6 - wire units of a hundred per frame.
  return (frame * (6 - wire)) / 100;
}

/** How long a full breath takes, in frames, both directions. */
export function breathFrames(family: Family, wire: number): number {
  if (family === "yc500") return 2 * (tab(YC500.breath, wire) + YC500.hold);
  // gen2: 0..100 in steps of 8, one step every `wire` frames.
  return 2 * Math.ceil(100 / 8) * Math.max(1, wire);
}

function hsv(h: number, s: number, v: number): Rgb {
  const hh = ((h % 1) + 1) % 1;
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const u = v * (1 - (1 - f) * s);
  const pick: Rgb[] = [
    [v, u, p],
    [q, v, p],
    [p, v, u],
    [p, q, v],
    [u, p, v],
    [v, p, q],
  ];
  const c = pick[i % 6];
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
}

function scale(c: Rgb, k: number): Rgb {
  const m = Math.max(0, Math.min(1, k));
  return [Math.round(c[0] * m), Math.round(c[1] * m), Math.round(c[2] * m)];
}

/** An animated level, lifted so half-lit LEDs read as lit on a screen. */
function glow(level: number): number {
  return Math.pow(Math.max(0, Math.min(1, level)), 0.6);
}

/** The grid cell a key falls in, as the firmware addresses LEDs. */
function cellOf(led: Led): { row: number; col: number } {
  return {
    row: Math.min(GRID_ROWS - 1, Math.floor(led.y * GRID_ROWS)),
    col: Math.min(GRID_COLS - 1, Math.floor(led.x * GRID_COLS)),
  };
}

/** Deterministic noise in 0..1 from a key index and a step number. */
function noise(i: number, n: number): number {
  let h = (i * 374761393 + n * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The colour a fixed-colour mode paints with, or a preset when the
 *  firmware walks its palette. */
function base(p: EffectParam, step: number): Rgb {
  if (!p.rainbow) return [p.r, p.g, p.b];
  return PRESETS[((step % 7) + 7) % 7];
}

/** Triangle 0..1..0 with a flat top and bottom, as the yc500 fader. */
function breath(family: Family, wire: number, frame: number): { level: number; cycle: number } {
  const total = breathFrames(family, wire);
  const cycle = Math.floor(frame / total);
  const f = frame % total;
  if (family === "yc500") {
    const ramp = tab(YC500.breath, wire);
    const hold = YC500.hold;
    if (f < ramp) return { level: f / ramp, cycle };
    if (f < ramp + hold) return { level: 1, cycle };
    if (f < 2 * ramp + hold) return { level: 1 - (f - ramp - hold) / ramp, cycle };
    return { level: 0, cycle };
  }
  const half = total / 2;
  return { level: f < half ? f / half : 1 - (f - half) / half, cycle };
}

/**
 * The colour of one key at a frame. `index` identifies the key for the
 * effects that pick keys at random.
 */
export function colorAt(
  family: Family,
  p: EffectParam,
  led: Led,
  index: number,
  frame: number,
): Rgb {
  const wire = wireSpeed(family, p.speed);
  const gain = p.brightnessMax > 0 ? p.brightness / p.brightnessMax : 1;
  const stepLen = stepFrames(family, p.mode, wire);
  const step = Math.floor(frame / stepLen);
  const stepPhase = (frame % stepLen) / stepLen;
  const turns = hueTurns(family, p.mode, wire, frame);
  const { row, col } = cellOf(led);

  let c: Rgb;
  switch (p.mode) {
    case 1:
    case 19: {
      // Static, and Silent snow, which holds still on the board too.
      c = p.rainbow ? hsv(led.x, 1, 1) : [p.r, p.g, p.b];
      break;
    }
    case 2: {
      const { level, cycle } = breath(family, wire, frame);
      c = scale(base(p, cycle), glow(level));
      break;
    }
    case 3: {
      // The whole board walks the hue together.
      c = hsv(turns, 1, 1);
      break;
    }
    case 4: {
      // Every column holds its own hue, offset from its neighbour, and all
      // walk together, so the rainbow slides along the chosen direction.
      const along = [led.x, 1 - led.x, led.y, 1 - led.y][p.option % 4] ?? led.x;
      c = p.rainbow
        ? hsv(along + turns, 1, 1)
        : scale([p.r, p.g, p.b], glow(0.5 + 0.5 * Math.cos((along + turns) * Math.PI * 2)));
      break;
    }
    case 5: {
      // A ring grows one cell per step from a random key, then another.
      const life = 24;
      const burst = Math.floor(step / life);
      const ox = noise(1, burst);
      const oy = noise(2, burst);
      const d = Math.hypot((led.x - ox) * GRID_COLS, (led.y - oy) * GRID_ROWS);
      const radius = (step % life) + stepPhase;
      c = scale(base(p, burst), glow(Math.max(0, 1 - Math.abs(d - radius) * 0.8)));
      break;
    }
    case 6: {
      // A new star every step; each burns for a while and fades.
      const life = 40;
      const born = step - (Math.floor(noise(index, 0) * life) % life);
      const age = ((step - born) % life + life) % life;
      const level = age < 6 ? age / 6 : Math.max(0, 1 - (age - 6) / (life - 6));
      c = scale(p.rainbow ? hsv(noise(index, Math.floor(step / life)), 1, 1) : [p.r, p.g, p.b], glow(level));
      break;
    }
    case 7: {
      // A head runs the rows one cell per step, zigzag or spiral, with a tail.
      const cells = GRID_ROWS * GRID_COLS;
      const spiral = p.option === 1;
      let pos: number;
      if (spiral) {
        // Rings from the outside in: rank each cell by its distance to the edge.
        const ring = Math.min(row, GRID_ROWS - 1 - row, col, GRID_COLS - 1 - col);
        pos = ring * 40 + (row <= GRID_ROWS / 2 ? col : GRID_COLS * 2 - col);
      } else {
        pos = row * GRID_COLS + (row % 2 ? GRID_COLS - 1 - col : col);
      }
      const head = (step % cells) + stepPhase;
      const dist = ((pos - head) % cells + cells) % cells;
      c = scale(base(p, Math.floor(step / cells)), glow(dist > cells - 6 ? (dist - (cells - 6)) / 6 : 0));
      break;
    }
    case 8: {
      // Reactive: a press lights a key and fades. The preview presses one
      // random key per step.
      const hit = Math.floor(noise(3, step) * 100);
      c = index % 100 === hit ? scale(base(p, step), glow(1 - stepPhase)) : [0, 0, 0];
      break;
    }
    case 9: {
      // The firmware's script: cells stay lit until the cycle rests.
      const cycle = Math.floor(step / LAYERS.total);
      const now = step % LAYERS.total;
      const items = LAYERS.cells.get(row * GRID_COLS + col) ?? [];
      let lit: ScriptItem | null = null;
      for (const it of items) if (it.step <= now) lit = it;
      c = lit ? (p.rainbow ? PRESETS[(cycle * 2 + lit.phase) % 6] : [p.r, p.g, p.b]) : [0, 0, 0];
      break;
    }
    case 10: {
      // Each step a dot is born at column 6 on a row that follows a sine,
      // and runs left and right one column per step until it leaves.
      let level = 0;
      for (let age = 0; age < 20; age++) {
        const born = step - age;
        if (born < 0) break;
        const r = Math.round(2.5 + 2.5 * Math.sin((born / 30) * Math.PI * 2));
        if (r !== row) continue;
        if (col === 6 - age || col === 6 + age) level = 1;
      }
      c = scale(base(p, Math.floor(step / 30)), level);
      break;
    }
    case 11: {
      // Rings breathing out of, or into, the centre; never dark between.
      const d = Math.hypot(led.x - 0.5, (led.y - 0.5) * 0.4) / 0.6;
      const dir = p.option === 1 ? -1 : 1;
      const phase = d * 2 - dir * turns;
      c = scale(
        p.rainbow ? hsv(phase, 1, 1) : [p.r, p.g, p.b],
        0.45 + 0.55 * glow(0.5 + 0.5 * Math.cos(phase * Math.PI * 2)),
      );
      break;
    }
    case 12: {
      // Neon: a rainbow sweep, left or right.
      const dir = p.option === 1 ? -1 : 1;
      c = hsv(led.x * dir - turns, 1, 1);
      break;
    }
    case 14: {
      // Radiant: hue by angle, one step of a turn per step.
      const a = Math.atan2((led.y - 0.5) * 0.4, led.x - 0.5) / (Math.PI * 2);
      c = hsv(a + (step + stepPhase) / 24, 1, 1);
      break;
    }
    case 15: {
      // A dot around the perimeter, with a tail.
      const dir = p.option === 1 ? -1 : 1;
      const a = (Math.atan2((led.y - 0.5) * 0.4, led.x - 0.5) / (Math.PI * 2) + 1) % 1;
      const head = ((dir * turns) % 1 + 1) % 1;
      const dist = ((a - head) % 1 + 1) % 1;
      const edge = Math.max(Math.abs(led.x - 0.5) * 2, Math.abs(led.y - 0.5) * 2) > 0.7 ? 1 : 0.2;
      c = scale(base(p, Math.floor(turns)), glow(Math.max(0, 1 - dist * 4) * edge));
      break;
    }
    case 16: {
      // Blocks of colour that change every so often.
      const cell = Math.floor(led.x * 6) + 6 * Math.floor(led.y * 3);
      const epoch = Math.floor(frame / 120);
      c = PRESETS[Math.floor(noise(cell, epoch) * 7)];
      break;
    }
    case 17: {
      // Flakes fall one row every few frames, each in one colour.
      const fallFrames = 12;
      const drop = frame / (fallFrames * GRID_ROWS) + noise(col, 0);
      const fall = ((drop % 1) + 1) % 1;
      const d = Math.abs(led.y - fall);
      const flake: Rgb = p.rainbow ? PRESETS[Math.floor(noise(col, Math.floor(drop) + 1) * 7)] : [p.r, p.g, p.b];
      c = scale(flake, glow(Math.max(0, 1 - d * 5) * (noise(col, 1) > 0.4 ? 1 : 0.3)));
      break;
    }
    case 18: {
      // Meteors: streaks with a tail, a few columns at a time.
      const fallFrames = 8;
      const drop = frame / (fallFrames * GRID_ROWS) + noise(col, 0);
      const head = ((drop % 1.5) + 1.5) % 1.5;
      const d = head - led.y;
      const active = noise(col, Math.floor(drop / 1.5)) > 0.6;
      c = scale(base(p, col), glow(active && d >= 0 && d < 0.5 ? 1 - d * 2 : 0));
      break;
    }
    default:
      c = [p.r, p.g, p.b];
  }
  return scale(c, gain);
}
