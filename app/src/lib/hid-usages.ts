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
    name: "Mouse",
    items: [
      { label: "Left", entry: [1, 0, 240, 0] },
      { label: "Right", entry: [1, 0, 241, 0] },
      { label: "Middle", entry: [1, 0, 242, 0] },
      { label: "Back", entry: [1, 0, 243, 0] },
      { label: "Forward", entry: [1, 0, 244, 0] },
      { label: "Scroll Up", entry: [4, 1, 0, 0] },
      { label: "Scroll Down", entry: [4, 2, 0, 0] },
      { label: "Tilt left", entry: [4, 3, 0, 0] },
      { label: "Tilt right", entry: [4, 4, 0, 0] },
    ],
  },
  {
    name: "Media",
    items: [
      { label: "Next", entry: [3, 0, 181, 0] },
      { label: "Prev", entry: [3, 0, 182, 0] },
      { label: "Stop", entry: [3, 0, 183, 0] },
      { label: "Play/Pause", entry: [3, 0, 205, 0] },
      { label: "Mute", entry: [3, 0, 226, 0] },
      { label: "Vol +", entry: [3, 0, 233, 0] },
      { label: "Vol -", entry: [3, 0, 234, 0] },
      { label: "Media", entry: [3, 0, 131, 2] },
      { label: "Mail", entry: [3, 0, 138, 1] },
      { label: "Calculator", entry: [3, 0, 146, 1] },
      { label: "My PC", entry: [3, 0, 148, 1] },
      { label: "Screen +", entry: [3, 0, 111, 0] },
      { label: "Screen -", entry: [3, 0, 112, 0] },
      { label: "Search", entry: [3, 0, 33, 2] },
      { label: "Home page", entry: [3, 0, 35, 2] },
      { label: "Back", entry: [3, 0, 36, 2] },
      { label: "Forward", entry: [3, 0, 37, 2] },
      { label: "Stop page", entry: [3, 0, 38, 2] },
      { label: "Refresh", entry: [3, 0, 39, 2] },
      { label: "Favourites", entry: [3, 0, 42, 2] },
    ],
  },
  {
    name: "Lighting",
    items: [
      { label: "LED on/off", entry: [13, 0, 0, 0] },
      { label: "Effect Loop", entry: [13, 1, 0, 0] },
      { label: "Effect Inc", entry: [13, 1, 1, 0] },
      { label: "Effect Dec", entry: [13, 1, 2, 0] },
      { label: "Brightness Loop", entry: [13, 2, 0, 0] },
      { label: "Brightness Inc", entry: [13, 2, 1, 0] },
      { label: "Brightness Dec", entry: [13, 2, 2, 0] },
      { label: "Speed Loop", entry: [13, 3, 0, 0] },
      { label: "Speed Inc", entry: [13, 3, 1, 0] },
      { label: "Speed Dec", entry: [13, 3, 2, 0] },
      { label: "Direction Loop", entry: [13, 5, 0, 0] },
      { label: "Direction Right", entry: [13, 5, 0, 1] },
      { label: "Direction Left", entry: [13, 5, 0, 2] },
      { label: "Color Loop", entry: [13, 5, 1, 0] },
      { label: "Color white", entry: [13, 5, 1, 2] },
      { label: "Color Inc", entry: [13, 5, 1, 3] },
      { label: "Color Dec", entry: [13, 5, 1, 4] },
      { label: "User Pic", entry: [13, 6, 128, 0] },
      { label: "Effect Loop0", entry: [13, 7, 4, 0] },
      { label: "Effect Loop1", entry: [13, 7, 5, 0] },
      { label: "Effect Loop2", entry: [13, 7, 6, 0] },
      { label: "Effect Loop3", entry: [13, 7, 7, 0] },
      { label: "Effect Loop4", entry: [13, 7, 8, 0] },
      { label: "Effect Loop5", entry: [13, 7, 9, 0] },
      { label: "SLED Effect", entry: [13, 8, 0, 0] },
      { label: "SLED Brightness Loop", entry: [13, 8, 1, 0] },
      { label: "SLED Speed", entry: [13, 8, 2, 0] },
      { label: "SLED Speed +", entry: [13, 8, 2, 1] },
      { label: "SLED Speed -", entry: [13, 8, 2, 2] },
      { label: "SLED Color", entry: [13, 8, 3, 0] },
      { label: "SLED Color +", entry: [13, 8, 3, 1] },
      { label: "SLED Color -", entry: [13, 8, 3, 2] },
      { label: "SLED Option", entry: [13, 8, 4, 0] },
      { label: "SLED Option +", entry: [13, 8, 4, 1] },
      { label: "SLED Option -", entry: [13, 8, 4, 2] },
    ],
  },
  {
    name: "Keyboard",
    items: [
      { label: "Fn", entry: [10, 1, 0, 0] },
      { label: "Reset", entry: [10, 2, 0, 0] },
      { label: "WINLOCK", entry: [10, 3, 0, 0] },
      { label: "Office/Gaming", entry: [10, 6, 0, 0] },
      { label: "KB Lock", entry: [10, 7, 0, 0] },
      { label: "Check Battery", entry: [10, 8, 0, 0] },
      { label: "LED ON/OFF", entry: [10, 9, 0, 0] },
      { label: "WASD Change", entry: [10, 10, 0, 0] },
      { label: "Fn matrix", entry: [10, 11, 0, 0] },
      { label: "Power saves", entry: [10, 12, 0, 0] },
      { label: "Fn Lock", entry: [10, 13, 0, 0] },
      { label: "Wheel Swap", entry: [10, 14, 0, 0] },
      { label: "Caps Swap", entry: [10, 15, 0, 0] },
      { label: "Caps LED Swap", entry: [10, 17, 0, 0] },
      { label: "Power Down", entry: [10, 18, 0, 0] },
      { label: "Fn Key Swap", entry: [10, 19, 0, 0] },
      { label: "ALT TAB", entry: [10, 20, 0, 0] },
      { label: "Language Switch", entry: [10, 21, 0, 0] },
      { label: "Charge LED On OFF", entry: [10, 22, 0, 0] },
      { label: "APP CTRL Change", entry: [10, 23, 0, 0] },
    ],
  },
  {
    name: "System",
    items: [
      { label: "System Power", entry: [2, 129, 0, 0] },
      { label: "System Sleep", entry: [2, 130, 0, 0] },
      { label: "System Wake", entry: [2, 131, 0, 0] },
    ],
  },
  {
    name: "Profile",
    items: [
      { label: "Profile+", entry: [8, 0, 1, 0] },
      { label: "Profile-", entry: [8, 0, 2, 0] },
      { label: "Profile+ loop", entry: [8, 0, 3, 0] },
    ],
  },
  {
    name: "Wireless",
    items: [
      { label: "24G device", entry: [14, 0, 5, 0] },
      { label: "BLUETOOTH1", entry: [14, 0, 0, 0] },
      { label: "BLUETOOTH2", entry: [14, 0, 1, 0] },
      { label: "BLUETOOTH3", entry: [14, 0, 2, 0] },
      { label: "BLUETOOTH4", entry: [14, 0, 3, 0] },
      { label: "BLUETOOTH5", entry: [14, 0, 4, 0] },
      { label: "WIRED", entry: [14, 0, 6, 0] },
      { label: "Cycle link", entry: [14, 0, 255, 0] },
      { label: "24G Match", entry: [14, 1, 0, 0] },
      { label: "BT Match", entry: [14, 1, 1, 0] },
    ],
  },
  {
    name: "Screen",
    items: [
      { label: "Main Class Loop +", entry: [19, 0, 0, 0] },
      { label: "Main Class Loop -", entry: [19, 0, 1, 0] },
      { label: "Main Class Inc", entry: [19, 0, 2, 0] },
      { label: "Main Class Dec", entry: [19, 0, 3, 0] },
      { label: "Loop Class Loop +", entry: [19, 1, 0, 0] },
      { label: "Loop Class Loop -", entry: [19, 1, 1, 0] },
      { label: "Loop Class Inc", entry: [19, 1, 2, 0] },
      { label: "Loop Class Dec", entry: [19, 1, 3, 0] },
      { label: "OLED_SWITCH", entry: [19, 2, 0, 0] },
      { label: "OLED_WHEEL", entry: [19, 3, 0, 0] },
    ],
  },
  {
    name: "Report rate",
    items: [
      { label: "Report rate +", entry: [5, 0, 1, 0] },
      { label: "Report rate -", entry: [5, 0, 2, 0] },
      { label: "Report rate + loop", entry: [5, 0, 3, 0] },
    ],
  },
  {
    name: "Special",
    items: [
      { label: "Clear", entry: [0, 0, 0, 0] },
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

/** An all-zero slot on the Fn layer falls through to the base layer, like
 *  QMK's `KC_TRNS`. On the base layer there is nothing beneath, so the key
 *  is simply dead, like `KC_NO`. */
export const PASSTHRU_GLYPH = "\u25BD";
export const DISABLED_GLYPH = "\u2715";

/** Reverse lookup: label for a 4-byte matrix entry. */
export function entryLabel(entry: number[], fnLayer = false): string {
  if (entry.length === 4 && entry.every((b) => b === 0))
    return fnLayer ? PASSTHRU_GLYPH : DISABLED_GLYPH;
  for (const g of GROUPS) {
    for (const item of g.items) {
      if (item.entry.every((b, i) => b === entry[i])) return item.label;
    }
  }
  const [tag, a, b, c] = entry;
  if (tag === 0 && (a !== 0 || c !== 0))
    return [a, b, c].filter(Boolean).map(usageLabel).join("+");
  if (tag === 1) return "Mouse";
  if (tag === 3) return "Media";
  if (tag === 13) return "Light";
  if (tag === 14) return "Link";
  if (tag === 9) return `Macro ${b + 1}`;
  if (tag === 10 && a === 1) return "Fn";
  if (tag === 10 && a === 12) return "Power save";
  if (tag === 10) return "Special";
  return `${tag}:${a}:${b}:${c}`;
}
