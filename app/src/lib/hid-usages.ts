// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// HID keyboard usage IDs (usage page 0x07) and the consumer-page codes these
// boards use, with display labels. Grouped for the assignment picker.

export interface Assignable {
  label: string;
  /** 4-byte matrix entry written to the keyboard. */
  entry: [number, number, number, number];
}

const key = (usage: number, label: string): Assignable => ({
  label,
  entry: [0, 0, usage, 0],
});

const consumer = (usage: number, label: string): Assignable => ({
  label,
  entry: [3, 0, usage & 0xff, (usage >> 8) & 0xff],
});

export const GROUPS: { name: string; items: Assignable[] }[] = [
  {
    name: "Letters",
    items: Array.from({ length: 26 }, (_, i) =>
      key(4 + i, String.fromCharCode(65 + i)),
    ),
  },
  {
    name: "Numbers",
    items: [
      ...Array.from({ length: 9 }, (_, i) => key(30 + i, `${i + 1}`)),
      key(39, "0"),
    ],
  },
  {
    name: "F-keys",
    items: Array.from({ length: 12 }, (_, i) => key(58 + i, `F${i + 1}`)),
  },
  {
    name: "Modifiers",
    items: [
      key(224, "L-Ctrl"),
      key(225, "L-Shift"),
      key(226, "L-Alt"),
      key(227, "L-Win"),
      key(228, "R-Ctrl"),
      key(229, "R-Shift"),
      key(230, "R-Alt"),
      key(231, "R-Win"),
    ],
  },
  {
    name: "Navigation",
    items: [
      key(41, "Esc"),
      key(43, "Tab"),
      key(57, "Caps"),
      key(40, "Enter"),
      key(42, "Backspace"),
      key(44, "Space"),
      key(74, "Home"),
      key(77, "End"),
      key(75, "PgUp"),
      key(78, "PgDn"),
      key(76, "Delete"),
      key(73, "Insert"),
      key(80, "←"),
      key(79, "→"),
      key(82, "↑"),
      key(81, "↓"),
      key(70, "PrtSc"),
      key(71, "ScrLk"),
      key(72, "Pause"),
    ],
  },
  {
    name: "Symbols",
    items: [
      key(45, "- _"),
      key(46, "= +"),
      key(47, "[ {"),
      key(48, "] }"),
      key(49, "\\ |"),
      key(51, "; :"),
      key(52, "' \""),
      key(53, "` ~"),
      key(54, ", <"),
      key(55, ". >"),
      key(56, "/ ?"),
    ],
  },
  {
    name: "Media",
    items: [
      consumer(0xe9, "Vol +"),
      consumer(0xea, "Vol −"),
      consumer(0xe2, "Mute"),
      consumer(0xcd, "Play/Pause"),
      consumer(0xb5, "Next"),
      consumer(0xb6, "Prev"),
      consumer(0xb7, "Stop"),
      consumer(0x223, "Home page"),
      consumer(0x18a, "Mail"),
      consumer(0x192, "Calculator"),
      consumer(0x194, "My PC"),
    ],
  },
  {
    name: "Special",
    items: [
      { label: "Fn", entry: [10, 1, 0, 0] },
      { label: "Disabled", entry: [0, 0, 0, 0] },
    ],
  },
];

/** KeyboardEvent.code -> HID usage, for macro recording. */
export const CODE_TO_USAGE: Record<string, number> = (() => {
  const m: Record<string, number> = {
    Enter: 40,
    Escape: 41,
    Backspace: 42,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    CapsLock: 57,
    PrintScreen: 70,
    ScrollLock: 71,
    Pause: 72,
    Insert: 73,
    Home: 74,
    PageUp: 75,
    Delete: 76,
    End: 77,
    PageDown: 78,
    ArrowRight: 79,
    ArrowLeft: 80,
    ArrowDown: 81,
    ArrowUp: 82,
    NumLock: 83,
    NumpadDivide: 84,
    NumpadMultiply: 85,
    NumpadSubtract: 86,
    NumpadAdd: 87,
    NumpadEnter: 88,
    Numpad0: 98,
    NumpadDecimal: 99,
    ControlLeft: 224,
    ShiftLeft: 225,
    AltLeft: 226,
    MetaLeft: 227,
    ControlRight: 228,
    ShiftRight: 229,
    AltRight: 230,
    MetaRight: 231,
  };
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
  for (let i = 1; i <= 9; i++) m[`Digit${i}`] = 29 + i;
  m.Digit0 = 39;
  for (let i = 1; i <= 12; i++) m[`F${i}`] = 57 + i;
  for (let i = 1; i <= 9; i++) m[`Numpad${i}`] = 88 + i;
  return m;
})();

const USAGE_LABELS: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  for (const g of GROUPS)
    for (const item of g.items)
      if (item.entry[0] === 0 && item.entry[2] !== 0) m[item.entry[2]] ??= item.label;
  for (const [code, usage] of Object.entries(CODE_TO_USAGE)) m[usage] ??= code;
  return m;
})();

/** Display label for a bare HID keyboard usage. */
export const usageLabel = (usage: number): string =>
  USAGE_LABELS[usage] ?? `0x${usage.toString(16).toUpperCase()}`;

/** Reverse lookup: label for a 4-byte matrix entry. */
export function entryLabel(entry: number[]): string {
  for (const g of GROUPS) {
    for (const item of g.items) {
      if (item.entry.every((b, i) => b === entry[i])) return item.label;
    }
  }
  const [tag, a, b, c] = entry;
  if (tag === 0 && a === 0 && b === 0 && c === 0) return "off";
  if (tag === 0 && (a !== 0 || c !== 0))
    return [a, b, c].filter(Boolean).map(usageLabel).join("+");
  if (tag === 1) return "Mouse";
  if (tag === 3) return `Media ${(c << 8) | b}`;
  if (tag === 9) return `Macro ${b + 1}`;
  if (tag === 10 && a === 1) return "Fn";
  if (tag === 10 && a === 12) return "Power save";
  if (tag === 10) return "Special";
  return `${tag}:${a}:${b}:${c}`;
}
