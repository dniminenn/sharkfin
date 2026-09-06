// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// A board drawn by hand: keys on a quarter-unit grid, each carrying the
// usage it is printed with, plus an optional knob. Presets cover the common
// sizes, and any stored picture or keyboard-layout-editor drawing converts
// to a draft to start from. toLayout() emits the same BoardLayout kle.ts
// does, so the matcher and the bundle treat a drawn board like a pasted one.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";
import { CODE_TO_USAGE, usageLabel } from "@/lib/hid-usages";
import { FN_ENTRY } from "@/lib/kle";

/** A HID keyboard usage, or the Fn key, which is not one. */
export type DraftUsage = number | "fn";

export interface DraftKey {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  usage: DraftUsage | null;
  /** What a stored picture printed on a key the draft cannot label, so
   *  the owner still knows which key it is. */
  note?: string;
}

export interface DraftKnob {
  x: number;
  y: number;
  /** Entry for the press; the two rotations are always volume. */
  press: number[];
}

export interface Draft {
  keys: DraftKey[];
  knob: DraftKnob | null;
}

/** Pixels per unit and the gap between caps, as the layout files draw them. */
const U = 46;
const GAP = 6;
export const STEP = 0.25;
export const KNOB_SIZE = 1.25;

export const KNOB_PRESSES: { label: string; entry: number[] }[] = [
  { label: "Mute", entry: [3, 0, 226, 0] },
  { label: "Play/Pause", entry: [3, 0, 205, 0] },
];

const USAGE_TO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([c, u]) => [u, c]),
);

// What a key prints, where the assignment picker's label is not it.
const LEGENDS: Record<number, string> = {
  100: "<>",
  50: "#",
  101: "Menu",
  83: "Num",
  84: "/",
  85: "*",
  86: "-",
  87: "+",
  88: "Enter",
  99: ".",
  137: "¥",
  136: "Kana",
  138: "変換",
  139: "無変換",
  135: "\\",
};
for (let i = 0; i <= 9; i++) LEGENDS[i === 0 ? 98 : 88 + i] = `${i}`;

export function legend(usage: DraftUsage | null): string {
  if (usage === null) return "";
  if (usage === "fn") return "Fn";
  return LEGENDS[usage] ?? usageLabel(usage);
}

// What fits on a 1u cap. The picker says which side a modifier is; the cap
// does not need to.
const SHORT: Record<number, string> = {
  76: "Del", 73: "Ins", 224: "Ctrl", 228: "Ctrl", 225: "Shift", 229: "Shift",
  226: "Alt", 230: "Alt", 227: "Win", 231: "Win",
};

export function capLegend(usage: DraftUsage | null): string {
  if (typeof usage === "number" && SHORT[usage]) return SHORT[usage];
  return legend(usage);
}

export const VOL_DOWN = [3, 0, 234, 0];
export const VOL_UP = [3, 0, 233, 0];

const keyItem = (usage: number) => ({ usage, label: legend(usage) });

/** Everything a key can be labelled with, grouped for the picker. */
export const DRAWABLE: { name: string; items: { usage: DraftUsage; label: string }[] }[] = [
  { name: "Letters", items: Array.from({ length: 26 }, (_, i) => keyItem(4 + i)) },
  {
    name: "Numbers",
    items: [...Array.from({ length: 9 }, (_, i) => keyItem(30 + i)), keyItem(39)],
  },
  {
    name: "F-keys",
    items: [
      ...Array.from({ length: 12 }, (_, i) => keyItem(58 + i)),
      ...Array.from({ length: 12 }, (_, i) => keyItem(104 + i)),
    ],
  },
  {
    name: "Modifiers",
    items: [
      ...[224, 225, 226, 227, 228, 229, 230, 231].map(keyItem),
      { usage: "fn", label: "Fn" },
      keyItem(101),
    ],
  },
  {
    name: "Navigation",
    items: [41, 43, 57, 40, 42, 44, 74, 77, 75, 78, 76, 73, 80, 79, 82, 81, 70, 71, 72].map(
      keyItem,
    ),
  },
  {
    name: "Symbols",
    items: [53, 45, 46, 47, 48, 49, 51, 52, 54, 55, 56].map(keyItem),
  },
  {
    name: "ISO and JIS",
    items: [100, 50, 137, 135, 136, 138, 139].map(keyItem),
  },
  {
    name: "Numpad",
    items: [83, 84, 85, 86, 87, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 88].map((u) => ({
      usage: u,
      label: u === 83 ? "Num" : `Num ${legend(u)}`,
    })),
  },
];

const snap = (v: number) => Math.round(v / STEP) * STEP;

let nextId = 1;
export const freshId = () => nextId++;

function key(x: number, y: number, usage: DraftUsage | null, w = 1, h = 1): DraftKey {
  return { id: freshId(), x, y, w, h, usage };
}

/** Keys laid left to right from x, each `[usage, width]` or a bare usage. */
function row(y: number, x: number, items: (DraftUsage | [DraftUsage, number])[]): DraftKey[] {
  const out: DraftKey[] = [];
  for (const it of items) {
    const [u, w] = Array.isArray(it) ? it : [it, 1];
    out.push(key(x, y, u, w));
    x += w;
  }
  return out;
}

const L = (c: string) => CODE_TO_USAGE[`Key${c}`];
const D = (n: number) => CODE_TO_USAGE[`Digit${n}`];
const F = (n: number) => CODE_TO_USAGE[`F${n}`];
const FROW = Array.from({ length: 12 }, (_, i) => F(i + 1));

export type PresetSize = "60" | "65" | "75" | "tkl" | "96" | "full";

export const PRESETS: { size: PresetSize; label: string }[] = [
  { size: "60", label: "60%" },
  { size: "65", label: "65%" },
  { size: "75", label: "75%" },
  { size: "tkl", label: "TKL" },
  { size: "96", label: "96%" },
  { size: "full", label: "Full size" },
];

export interface PresetOptions {
  iso: boolean;
  knob: boolean;
}

/** The alpha block every size shares, rows 0 to 3, 15u wide. Row 0 starts
 *  with Esc on the boards without an F row. `arrows` trims Right Shift for
 *  the Up key beside it. */
function alphas(y: number, esc: boolean, iso: boolean, arrows: boolean): DraftKey[] {
  const r0 = row(y, 0, [
    esc ? 41 : 53,
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(D),
    45,
    46,
    [42, 2],
  ]);
  const r1 = row(y + 1, 0, [
    [43, 1.5],
    ...[..."QWERTYUIOP"].map(L),
    47,
    48,
    ...(iso ? [] : [[49, 1.5] as [DraftUsage, number]]),
  ]);
  const r2 = row(y + 2, 0, [
    [57, 1.75],
    ...[..."ASDFGHJKL"].map(L),
    51,
    52,
    ...(iso ? [50] : [[40, 2.25] as [DraftUsage, number]]),
  ]);
  if (iso) r2.push(key(13.75, y + 1, 40, 1.25, 2));
  const r3 = row(y + 3, 0, [
    ...(iso ? [[225, 1.25] as [DraftUsage, number], 100] : [[225, 2.25] as [DraftUsage, number]]),
    ...[..."ZXCVBNM"].map(L),
    54,
    55,
    56,
    [229, arrows ? 1.75 : 2.75],
  ]);
  if (arrows) r3.push(key(14, y + 3, 82));
  return [...r0, ...r1, ...r2, ...r3];
}

/** The bottom row: the 60% has eight 1.25u keys, boards with arrows give
 *  the right side up to three 1u keys and the arrows themselves. */
function bottom(y: number, arrows: boolean): DraftKey[] {
  if (!arrows) {
    return row(y, 0, [
      [224, 1.25],
      [227, 1.25],
      [226, 1.25],
      [44, 6.25],
      [230, 1.25],
      ["fn", 1.25],
      [101, 1.25],
      [228, 1.25],
    ]);
  }
  return row(y, 0, [
    [224, 1.25],
    [227, 1.25],
    [226, 1.25],
    [44, 6.25],
    230,
    "fn",
    228,
    80,
    81,
    79,
  ]);
}

/** The F row of the TKL and full size, in its three clusters. */
function frow(): DraftKey[] {
  return [
    ...row(0, 0, [41]),
    ...row(0, 2, FROW.slice(0, 4)),
    ...row(0, 6.5, FROW.slice(4, 8)),
    ...row(0, 11, FROW.slice(8, 12)),
    ...row(0, 15.25, [70, 71, 72]),
  ];
}

/** A compact pad shares its bottom row with the arrows, so 0 is 1u. */
function numpad(y: number, x: number, compact: boolean): DraftKey[] {
  return [
    ...row(y, x, [83, 84, 85, 86]),
    ...row(y + 1, x, [95, 96, 97]),
    key(x + 3, y + 1, 87, 1, 2),
    ...row(y + 2, x, [92, 93, 94]),
    ...row(y + 3, x, [89, 90, 91]),
    key(x + 3, y + 3, 88, 1, 2),
    ...(compact ? row(y + 4, x + 1, [98, 99]) : row(y + 4, x, [[98, 2], 99])),
  ];
}

export function preset(size: PresetSize, opts: PresetOptions): Draft {
  const { iso } = opts;
  let keys: DraftKey[];
  let knobAt: [number, number];
  switch (size) {
    case "60":
      keys = [...alphas(0, true, iso, false), ...bottom(4, false)];
      knobAt = [15.25, 0];
      break;
    case "65":
      keys = [
        ...alphas(0, true, iso, true),
        key(15, 0, 76),
        key(15, 1, 75),
        key(15, 2, 78),
        ...bottom(4, true),
      ];
      knobAt = [16.25, 0];
      break;
    case "75":
      keys = [
        ...row(0, 0, [41, ...FROW, 76]),
        ...alphas(1.25, false, iso, true),
        key(15, 1.25, 75),
        key(15, 2.25, 78),
        key(15, 3.25, 77),
        ...bottom(5.25, true),
      ];
      knobAt = [15, 0];
      break;
    case "tkl":
      keys = [
        ...frow(),
        ...alphas(1.25, false, iso, false),
        ...row(1.25, 15.25, [73, 74, 75]),
        ...row(2.25, 15.25, [76, 77, 78]),
        key(16.25, 4.25, 82),
        ...bottom(5.25, false),
        ...row(5.25, 15.25, [80, 81, 79]),
      ];
      knobAt = [18.5, 0];
      break;
    case "96":
      keys = [
        ...row(0, 0, [41, ...FROW]),
        ...row(0, 14, [76, 73, 77, 75, 78]),
        ...alphas(1, false, iso, true),
        ...bottom(5, true),
        ...numpad(1, 15, true),
      ];
      knobAt = [19.25, 0];
      break;
    case "full":
      keys = [
        ...frow(),
        ...alphas(1.25, false, iso, false),
        ...row(1.25, 15.25, [73, 74, 75]),
        ...row(2.25, 15.25, [76, 77, 78]),
        key(16.25, 4.25, 82),
        ...bottom(5.25, false),
        ...row(5.25, 15.25, [80, 81, 79]),
        ...numpad(1.25, 18.5, false),
      ];
      knobAt = [22.75, 0];
      break;
  }
  return {
    keys,
    knob: opts.knob ? { x: knobAt[0], y: knobAt[1], press: KNOB_PRESSES[0].entry } : null,
  };
}

/** The usage a layout key is printed with, when a draft can carry it. */
function usageOf(k: LayoutKey): DraftUsage | null {
  const e = k.matrixEntry;
  if (!e) return null;
  if (e[0] === FN_ENTRY[0] && e[1] === FN_ENTRY[1] && e[2] === 0) return "fn";
  if (e[0] === 0 && e[1] === 0 && e[3] === 0 && e[2] !== 0) return e[2];
  return null;
}

const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[v.length >> 1] : null);

/** How many pixels a unit is in this picture, each way, and the gap
 *  between caps. Almost every file draws 46 to the unit with a 6px gap,
 *  but a few are scaled, and one is not even square. The letters are the
 *  ruler: they are always 1u and always in rows. */
function scale(keys: LayoutKey[]): { px: number; py: number; gx: number; gy: number } {
  const letters = keys.filter((k) => /^Key[A-Z]$/.test(k.code) && k.w > 0);
  const rows = new Map<number, LayoutKey[]>();
  for (const k of letters) rows.set(k.y, [...(rows.get(k.y) ?? []), k]);
  const dxs: number[] = [];
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const d = row[i].x - row[i - 1].x;
      if (d < row[i].w * 2) dxs.push(d);
    }
  }
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const dys = ys.slice(1).map((y, i) => y - ys[i]);
  const px = median(dxs) ?? U;
  const py = median(dys) ?? px;
  const w = median(letters.map((k) => k.w));
  const h = median(letters.map((k) => k.h));
  return { px, py, gx: w === null ? GAP : px - w, gy: h === null ? GAP : py - h };
}

/** A stored picture or a pasted drawing as a draft. Edges snap to the
 *  grid, so a picture the vendor drew a few pixels wide comes back the
 *  width its keys really are. */
export function fromLayout(layout: BoardLayout): Draft {
  const plain = layout.keys.filter((k) => k.type !== "knob");
  const knobKeys = layout.keys.filter((k) => k.type === "knob");
  const all = layout.keys;
  if (!all.length) return { keys: [], knob: null };
  const { px, py, gx, gy } = scale(plain);
  const minX = Math.min(...all.map((k) => k.x));
  const minY = Math.min(...all.map((k) => k.y));
  const left = (v: number) => snap((v - minX) / px);
  const top = (v: number) => snap((v - minY) / py);
  const keys = plain.map((k) => {
    const x = left(k.x);
    const y = top(k.y);
    const usage = usageOf(k);
    const out: DraftKey = {
      id: freshId(),
      x,
      y,
      w: Math.max(STEP * 2, left(k.x + k.w + gx) - x),
      h: Math.max(STEP * 2, top(k.y + k.h + gy) - y),
      usage,
    };
    if (usage === null) out.note = k.text ?? (k.code !== "Key" ? k.code : undefined);
    return out;
  });
  let knob: DraftKnob | null = null;
  if (knobKeys.length) {
    const press = knobKeys.find(
      (k) => k.code !== "AudioVolumeDown" && k.code !== "AudioVolumeUp",
    );
    const known = KNOB_PRESSES.find((p) =>
      press?.matrixEntry?.every((b, i) => b === p.entry[i]),
    );
    knob = {
      x: left(Math.min(...knobKeys.map((k) => k.x))),
      y: top(Math.min(...knobKeys.map((k) => k.y))),
      press: (known ?? KNOB_PRESSES[0]).entry,
    };
  }
  return { keys, knob };
}

function layoutKey(k: DraftKey, x0: number, y0: number): LayoutKey {
  const u = k.usage;
  const base = {
    type: "key",
    x: Math.round((k.x - x0) * U) + 1,
    y: Math.round((k.y - y0) * U) + 1,
    w: Math.round(k.w * U) - GAP,
    h: Math.round(k.h * U) - GAP,
    matrixIndex: null,
    consumerUsage: null,
  };
  if (u === null)
    return { ...base, code: "Key", text: null, matrixEntry: null, hidUsage: null };
  if (u === "fn")
    return { ...base, code: "Fn", text: "Fn", matrixEntry: [...FN_ENTRY], hidUsage: null };
  return {
    ...base,
    code: USAGE_TO_CODE[u] ?? `Usage${u}`,
    text: legend(u),
    matrixEntry: [0, 0, u, 0],
    hidUsage: u,
  };
}

/** The draft as a picture. Plain keys come first, in draft order, so a
 *  matched copy of the result lines up with the draft key by key. */
export function toLayout(draft: Draft): BoardLayout {
  const xs = draft.keys.map((k) => k.x);
  const ys = draft.keys.map((k) => k.y);
  if (draft.knob) {
    xs.push(draft.knob.x);
    ys.push(draft.knob.y);
  }
  const x0 = xs.length ? Math.min(...xs) : 0;
  const y0 = ys.length ? Math.min(...ys) : 0;
  const keys = draft.keys.map((k) => layoutKey(k, x0, y0));
  if (draft.knob) {
    const px = Math.round((draft.knob.x - x0) * U) + 1;
    const py = Math.round((draft.knob.y - y0) * U) + 1;
    const size = Math.round(KNOB_SIZE * U) - GAP;
    const third = Math.floor(size / 3);
    const parts: [string, number[], number, number][] = [
      ["AudioVolumeDown", VOL_DOWN, 0, third],
      [draft.knob.press[2] === 205 ? "MediaPlayPause" : "AudioVolumeMute", draft.knob.press, third, size - 2 * third],
      ["AudioVolumeUp", VOL_UP, size - third, third],
    ];
    for (const [code, entry, dx, w] of parts) {
      keys.push({
        code,
        type: "knob",
        x: px + dx,
        y: py,
        w,
        h: size,
        text: null,
        matrixIndex: null,
        matrixEntry: [...entry],
        hidUsage: null,
        consumerUsage: entry[2],
      });
    }
  }
  return {
    canvas: {
      width: keys.length ? Math.max(...keys.map((k) => k.x + k.w)) + 1 : 1,
      height: keys.length ? Math.max(...keys.map((k) => k.y + k.h)) + 1 : 1,
    },
    keys,
  };
}

/** The drawing's extent in units, for laying it out on screen. */
export function extent(draft: Draft): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const k of draft.keys) {
    width = Math.max(width, k.x + k.w);
    height = Math.max(height, k.y + k.h);
  }
  if (draft.knob) {
    width = Math.max(width, draft.knob.x + KNOB_SIZE);
    height = Math.max(height, draft.knob.y + KNOB_SIZE);
  }
  return { width, height };
}

function overlaps(draft: Draft, x: number, y: number, w: number, h: number): boolean {
  const hit = (kx: number, ky: number, kw: number, kh: number) =>
    x < kx + kw && kx < x + w && y < ky + kh && ky < y + h;
  if (draft.keys.some((k) => hit(k.x, k.y, k.w, k.h))) return true;
  return !!draft.knob && hit(draft.knob.x, draft.knob.y, KNOB_SIZE, KNOB_SIZE);
}

/** Where a new key goes: the first free spot right of the selected key,
 *  else the end of the bottom row. Never on top of another key, which
 *  would hide it. */
export function placeNew(draft: Draft, beside: DraftKey | null): DraftKey {
  let x: number;
  let y: number;
  let h = 1;
  if (beside) {
    x = beside.x + beside.w;
    y = beside.y;
    h = beside.h;
  } else {
    const { height } = extent(draft);
    const lastRow = draft.keys.filter((k) => k.y + k.h >= height - STEP);
    x = lastRow.length ? Math.max(...lastRow.map((k) => k.x + k.w)) : 0;
    y = lastRow.length ? Math.min(...lastRow.map((k) => k.y)) : 0;
  }
  while (overlaps(draft, x, y, 1, h)) x += STEP;
  return key(x, y, null, 1, h);
}
