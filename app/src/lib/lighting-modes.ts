// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Light modes by vendor wire number. Names are sharkfin's own. BE_MODES is
// the common set (Attack Shark X86 and most boards); a board whose registry
// entry carries a light table gets that table's effects, labelled from
// MODE_LABELS, which also knows the two effects only some boards have.
//
// Omitted: 13 (custom per-key, the Paint page), 20 and 22 (music sync), 21
// (screen color) and 25 (the vendor's effect editor); those need a
// host-side data feed.

export interface LightMode {
  value: number;
  label: string;
  /** Direction / variant choices by option index, shown when present; a
   *  null keeps the index and hides a direction the board lacks. */
  options?: (string | null)[];
  /** Mode ignores the RGB color (always rainbow). */
  noColor?: boolean;
  /** Mode has no speed parameter. */
  noSpeed?: boolean;
  /** Highest speed the board takes, default 4. */
  speedMax?: number;
}

export const BE_MODES: LightMode[] = [
  { value: 1, label: "Static", noSpeed: true },
  { value: 2, label: "Breathing" },
  { value: 3, label: "Spectrum cycle", noColor: true },
  { value: 4, label: "Wave", options: ["Right", "Left", "Down", "Up"] },
  { value: 5, label: "Ripple" },
  { value: 6, label: "Star dots" },
  { value: 7, label: "Flow", options: ["Zigzag", "Spiral"] },
  { value: 8, label: "Key shadow" },
  { value: 9, label: "Layers" },
  { value: 10, label: "Sine wave" },
  { value: 11, label: "Spring", options: ["Outward", "Inward"] },
  { value: 12, label: "Neon", options: ["Right", "Left"] },
  { value: 14, label: "Radiant" },
  { value: 15, label: "Loop", options: ["CCW", "CW"] },
  { value: 16, label: "Color grid" },
  { value: 17, label: "Snowfall" },
  { value: 18, label: "Meteor" },
  { value: 19, label: "Silent snow" },
];

/** Every effect a light table can name, by wire number. */
export const MODE_LABELS: Record<number, string> = Object.fromEntries([
  ...BE_MODES.map((m) => [m.value, m.label]),
  [23, "Train"],
  [24, "Endless"],
]);
