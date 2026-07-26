// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
export interface Colorway {
  id: string;
  label: string;
  dark: boolean;
  /** [base, accent] swatch colors for the picker. */
  swatch: [string, string];
}

export const COLORWAYS: Colorway[] = [
  { id: "abyss", label: "Abyss", dark: true, swatch: ["#232c3d", "#6ed3ee"] },
  { id: "olivia", label: "Olivia", dark: true, swatch: ["#2b2725", "#e8b4a4"] },
  { id: "laser", label: "Laser", dark: true, swatch: ["#2b2145", "#e750b8"] },
  { id: "botanical", label: "Botanical", dark: false, swatch: ["#e8efe6", "#3c7a5a"] },
  { id: "8008", label: "8008", dark: true, swatch: ["#2a2c33", "#e06e73"] },
];

const KEY = "sharkfin.colorway";

export function applyColorway(id: string) {
  const cw = COLORWAYS.find((c) => c.id === id) ?? COLORWAYS[0];
  const root = document.documentElement;
  root.dataset.colorway = cw.id;
  root.classList.toggle("dark", cw.dark);
  localStorage.setItem(KEY, cw.id);
}

export function initColorway(): string {
  const saved = localStorage.getItem(KEY) ?? COLORWAYS[0].id;
  applyColorway(saved);
  return COLORWAYS.some((c) => c.id === saved) ? saved : COLORWAYS[0].id;
}


