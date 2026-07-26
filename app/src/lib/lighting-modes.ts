// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Light modes for the "Be" light system (Attack Shark X86 and siblings),
// with vendor wire numbers. Names are sharkfin's own.
//
// Omitted for now: 13 (custom per-key, needs USERPIC upload), 21 (screen
// color) and 22 (music sync); both need a host-side data feed.

export interface LightMode {
  value: number;
  label: string;
  /** Direction / variant choices, shown when present. */
  options?: string[];
  /** Mode ignores the RGB color (always rainbow). */
  noColor?: boolean;
  /** Mode has no speed parameter. */
  noSpeed?: boolean;
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
