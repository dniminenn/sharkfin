// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// keyboard-layout-editor.com import: geometry and legends from a KLE
// export, factory entries guessed from the legends. Slots are attached
// later by matching against the board's own keymap, same as any other
// geometry-only layout. Rotated keys are refused. Numpad keys resolve to
// keypad usages: by a nav legend beside a digit ("7\nHome"), by the
// drawing being a bare pad, or by losing the main area's copy of their
// legend. Fn maps to the special matrix entry the boards keep for it.
// National legends that name different keys per country stay unmapped: a
// dimmed key is safe, a key attached to the wrong slot is not.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";
import { CODE_TO_USAGE } from "@/lib/hid-usages";

const U = 46; // 1u in our layout files' pixels
const GAP = 6;

const NAMED: Record<string, number> = {
  ESC: 41, ESCAPE: 41, "ÉCHAP": 41,
  TAB: 43,
  CAPS: 57, "CAPS LOCK": 57, CAPSLOCK: 57, CAPSLK: 57,
  ENTER: 40, RETURN: 40,
  BACKSPACE: 42, "BACK SPACE": 42, BACK: 42, BKSP: 42,
  SPACE: 44, SPACEBAR: 44,
  DELETE: 76, DEL: 76, ENTF: 76, SUPPR: 76,
  INSERT: 73, INS: 73,
  HOME: 74, POS1: 74, END: 77,
  PGUP: 75, "PAGE UP": 75, "BILD▴": 75, PGDN: 78, "PAGE DOWN": 78, "BILD▾": 78,
  PRTSC: 70, "PRT SC": 70, "PRINT SCREEN": 70, PRINT: 70, DRUCKEN: 70,
  "SCROLL LOCK": 71, SCRLK: 71, SCROLL: 71,
  PAUSE: 72, BREAK: 72, "PAUSE BREAK": 72,
  UP: 82, "↑": 82, DOWN: 81, "↓": 81, LEFT: 80, "←": 80, RIGHT: 79, "→": 79,
  MENU: 101, APP: 101, APPLICATION: 101,
  NUM: 83, "NUM LOCK": 83, NUMLOCK: 83, LOCK: 83,
  "ALT GR": 230, ALTGR: 230,
  "`": 53, "~": 53, "-": 45, _: 45, "=": 46, "+": 46,
  "[": 47, "{": 47, "]": 48, "}": 48, "\\": 49, "|": 49,
  ";": 51, ":": 51, "'": 52, '"': 52, ",": 54, "<": 54, ".": 55, ">": 55,
  "/": 56, "?": 56,
  "!": 30, "@": 31, "#": 32, "$": 33, "%": 34,
  "^": 35, "&": 36, "*": 37, "(": 38, ")": 39,
  "‘": 52, "’": 52, "“": 52, "”": 52,
  "²": 53,
  // ISO and JP keys, by the labels the boards print on them. Each of these
  // is the same usage on every board that prints it.
  "#~": 50, "~#": 50, "#‘": 50, "#'": 50,
  "@´": 52, "´@": 52, "’@": 52, "@＇": 52,
  "<>": 100, "<|>": 100, "<>|": 100,
  "E/J": 53, "半角": 53, "全角": 53, "半角/全角": 53,
  KANA: 136, "変換": 138, "無変換": 139, "|¥": 137, "—\\": 135,
};
// Symbols and icon-font markup, which is how most KLE presets label the
// modifier row. A drawing whose Tab, Caps, Enter and Shifts all fell through
// as unmapped is what sent a KiiP Y87 owner round twice.
const GLYPHS: Record<string, string> = {
  "⇥": "TAB", "⇆": "TAB", "↹": "TAB",
  "⏎": "ENTER", "⮠": "ENTER", "↵": "ENTER", "⏎↵": "ENTER",
  "⌫": "BACKSPACE", "⟵": "BACKSPACE",
  "⌦": "DELETE",
  "⇪": "CAPS", "⇩": "CAPS", "⇬": "CAPS",
  "␣": "SPACE", "─": "SPACE", "▁": "SPACE",
  "⇧": "SHIFT",
  "⎈": "CTRL", "⌃": "CTRL",
  "⎇": "ALT", "⌥": "ALT",
  "⊞": "WIN", "❖": "WIN", "⌘": "WIN",
  "☰": "MENU", "▤": "MENU",
  "🠜": "LEFT", "🠞": "RIGHT", "🠝": "UP", "🠟": "DOWN",
  "⯇": "LEFT", "⯈": "RIGHT", "⯅": "UP", "⯆": "DOWN",
  "◀": "LEFT", "▶": "RIGHT", "▲": "UP", "▼": "DOWN",
};
for (let i = 0; i < 26; i++) NAMED[String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) NAMED[`${i}`] = 29 + i;
NAMED["0"] = 39;
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = 57 + i;
for (let i = 13; i <= 24; i++) NAMED[`F${i}`] = 91 + i;

// Left first, right second, by order of appearance; "L-" and "R-" prefixes
// name the side outright.
const PAIRED: Record<string, [number, number]> = {
  SHIFT: [225, 229],
  CTRL: [224, 228], CONTROL: [224, 228], STRG: [224, 228],
  ALT: [226, 230], OPT: [226, 230], OPTION: [226, 230],
  WIN: [227, 231], GUI: [227, 231], CMD: [227, 231], META: [227, 231], SUPER: [227, 231],
};

// The numpad prints these; the main area prints them too. NAMED gives the
// main area's usage, this gives the pad's.
const KEYPAD: Record<string, number> = {
  "/": 84, "*": 85, "-": 86, "+": 87, ENTER: 88, ".": 99,
};
for (let i = 1; i <= 9; i++) KEYPAD[`${i}`] = 88 + i;
KEYPAD["0"] = 98;

// What a numpad prints under its digits. An F-key there means an Fn layer
// on a small board instead, so it does not count.
const NAV = new Set([73, 74, 75, 76, 77, 78, 79, 80, 81, 82]);

// The unshifted half of each engraving pair. When "2" and "@" arrive as
// two separate keys (a JP board), the digit is the digit and the symbol is
// that board's own key somewhere else.
const BASES = new Set("0123456789`-=[]\\;',./");

// Split spacebars, and the doubled B beside them on Alice boards. The only
// usages a real keyboard carries twice.
const TWINS = new Set([44, 5]);

// Fn is not a HID usage; the boards keep it in the keymap as this entry.
export const FN_ENTRY = [0x0a, 0x01, 0, 0];

const USAGE_TO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([c, u]) => [u, c]),
);

/** A legend as something the tables can be looked up by. */
function normalise(raw: string): string {
  let l = raw.trim();
  // <i class="fa fa-windows"></i> and friends: the class names the key.
  const icon = /fa-(windows|apple|command|option|linux|tux)/i.exec(l);
  if (icon) return icon[1].toLowerCase() === "option" ? "ALT" : "WIN";
  // Only strip real markup: "<>" and "<   >" are the ISO angle key.
  l = l.replace(/<\/?[a-z][^>]*>/gi, "").trim();
  if (GLYPHS[l]) return GLYPHS[l];
  return l.toUpperCase();
}

/** A single legend line as a usage. Looked up whole; else one letter or
 *  digit names the key whatever is printed around it ("1!", "2é", "Q@");
 *  else symbols, which must all name the same key ("\|", "‘”"). Two
 *  letters or digits is ambiguous, "U+" and "U-" are a volume knob, and an
 *  unknown symbol beside a known one is some country's key we cannot
 *  place, so those stay unmapped. */
function usageOf(l: string): number | null {
  if (l in NAMED) return NAMED[l];
  const s = l.replace(/\s+/g, "");
  if (s !== l && s in NAMED) return NAMED[s];
  if (s.length < 2) return null;
  if (/^[A-Z][+-]$/.test(s)) return null;
  const strong = [...s].filter((ch) => /[A-Z0-9]/.test(ch));
  if (strong.length === 1) return NAMED[strong[0]] ?? null;
  if (strong.length) return null;
  let u: number | null = null;
  for (const ch of s) {
    const cu = NAMED[ch];
    if (cu === undefined || (u !== null && cu !== u)) return null;
    u = cu;
  }
  return u;
}

interface Reading {
  u: number | "fn" | null;
  /** The legend line the usage came from, for the later passes. */
  via: string | null;
}

function mapLegend(legends: string[], seen: Map<string, number>, w: number): Reading {
  const lines = legends.map(normalise).filter(Boolean);
  // "Back\nSpace", "Num\nLock": the lines name one key together.
  const joined = lines.join(" ");
  if (lines.length > 1 && joined in NAMED) return { u: NAMED[joined], via: joined };
  // "7\nHome": a keypad legend under a nav key's name is the numpad.
  const kp = lines.find((l) => l in KEYPAD);
  if (kp !== undefined) {
    const nav = lines.some((l) => {
      const u = usageOf(l);
      return u !== null && u !== NAMED[kp] && NAV.has(u);
    });
    if (nav) return { u: KEYPAD[kp], via: kp };
  }
  // "1\nF1" on a small board: the F-key is the Fn layer, the digit is the key.
  const digit = lines.find((l) => /^\d$/.test(l));
  if (digit !== undefined && lines.includes(`F${digit === "0" ? 10 : digit}`))
    return { u: NAMED[digit], via: digit };
  // A plain "x\ny" string is shifted over unshifted, so try later lines first.
  for (const l of [...lines].reverse()) {
    // Fn2 is a different special entry, only Fn and Fn1 are the Fn key.
    if (/^FN1?$/.test(l)) return { u: "fn", via: l };
    const side = /^([LR])[-_ ]?(SHIFT|CTRL|CONTROL|ALT|WIN|GUI)$/.exec(l);
    if (side) return { u: PAIRED[side[2]][side[1] === "L" ? 0 : 1], via: l };
    if (l in PAIRED) {
      const nth = seen.get(l) ?? 0;
      seen.set(l, nth + 1);
      return { u: PAIRED[l][Math.min(nth, 1)], via: l };
    }
    const u = usageOf(l);
    if (u !== null) return { u, via: l };
  }
  // Nothing matched. A key this wide is the spacebar whatever it is
  // labelled with, and every drawing has exactly one.
  if (w >= 4 && !seen.has("SPACE")) {
    seen.set("SPACE", 1);
    return { u: NAMED.SPACE, via: null };
  }
  return { u: null, via: null };
}

/** Accepts both KLE's downloaded JSON and the raw-data panel's rows. */
function parseRows(text: string): unknown[] {
  const attempts = [text, `[${text}]`];
  for (const t of attempts) {
    for (const s of [t, t.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')]) {
      try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) return v;
      } catch {
        // try the next form
      }
    }
  }
  throw new Error("not a keyboard-layout-editor export");
}

export function kleToLayout(text: string): BoardLayout {
  const rows = parseRows(text);
  const keys: LayoutKey[] = [];
  const readings: Reading[] = [];
  const lines: string[][] = [];
  const seen = new Map<string, number>();
  let y = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue; // leading metadata object
    let x = 0;
    let w = 1;
    let h = 1;
    for (const item of row) {
      if (item !== null && typeof item === "object") {
        const o = item as Record<string, number>;
        if (o.r || o.rx || o.ry) throw new Error("rotated keys are not supported");
        x += o.x ?? 0;
        y += o.y ?? 0;
        if (o.w) w = o.w;
        if (o.h) h = o.h;
        continue;
      }
      if (typeof item !== "string") continue;
      const legends = item.split("\n");
      readings.push(mapLegend(legends, seen, w));
      lines.push(legends.map(normalise).filter(Boolean));
      const text = legends.find((l) => l.trim())?.trim() ?? null;
      keys.push({
        code: text ?? "Key",
        type: "key",
        x: Math.round(x * U) + 1,
        y: Math.round(y * U) + 1,
        w: Math.round(w * U) - GAP,
        h: Math.round(h * U) - GAP,
        text,
        matrixIndex: null,
        matrixEntry: null,
        hidUsage: null,
        consumerUsage: null,
      });
      x += w;
      w = 1;
      h = 1;
    }
    y += 1;
  }
  if (keys.length < 2) throw new Error("no keys in the drawing");

  // "←" in the top rows is a backspace, at the bottom it is the left
  // arrow. Both at once happens: same glyph, two keys.
  const maxY = Math.max(...keys.map((k) => k.y));
  for (let i = 0; i < keys.length; i++) {
    if (readings[i].u === 80 && readings[i].via === "←" && keys[i].y < maxY * 0.4)
      readings[i] = { u: 42, via: "←" };
  }

  // A drawing with no letters is a bare numpad: its digits, symbols, Enter
  // and 5 are the keypad's.
  const letters = readings.some(
    (r) => typeof r.u === "number" && r.u >= 4 && r.u <= 29,
  );
  if (!letters) {
    for (const r of readings) {
      if (typeof r.u !== "number" || r.via === null) continue;
      if (r.via in KEYPAD && NAMED[r.via] === r.u) r.u = KEYPAD[r.via];
    }
  }

  // One usage, several keys. In order: the rightmost of the pair printing
  // a keypad legend is the numpad's copy, whichever got read first ("/"
  // sits on the numpad's top row, before the main slash). Two keys with
  // the same printed legend are a national board's doubled engraving (UK
  // boards print \| twice); the later one stays unmapped. A digit and its
  // shifted symbol as separate keys are a JP board; the symbol stays
  // unmapped. Anything else is a misread drawing and is refused: a mapped
  // key the user did not click must never be remapped.
  const claims = new Map<number, number[]>();
  const claim = (u: number, i: number) => {
    const at = claims.get(u);
    if (at) at.push(i);
    else claims.set(u, [i]);
  };
  readings.forEach((r, i) => {
    if (typeof r.u === "number" && !TWINS.has(r.u)) claim(r.u, i);
  });
  for (const [, at] of claims) {
    if (at.length < 2) continue;
    at.sort((a, b) => keys[a].x - keys[b].x);
    let holders = at;
    for (const i of [...holders].slice(1)) {
      const kp = lines[i].find((l) => l in KEYPAD);
      if (kp !== undefined && !claims.has(KEYPAD[kp])) {
        readings[i] = { u: KEYPAD[kp], via: kp };
        claim(KEYPAD[kp], i);
        holders = holders.filter((h) => h !== i);
      }
    }
    if (holders.length < 2) continue;
    const first = Math.min(...holders);
    // The same engraving twice, give or take character order or a synonym
    // ("?/" and "/?", "Print" and "PrtSc"): a national board's double.
    const strongs = (i: number) =>
      [...new Set([...(readings[i].via ?? "")].filter((c) => /[A-Z0-9]/.test(c)))]
        .sort()
        .join("");
    if (holders.every((i) => (readings[i].via ?? "") in NAMED)) {
      // Named legends, one usage: the later print is the double.
      for (const i of holders) if (i !== first) readings[i] = { u: null, via: null };
      continue;
    }
    if (holders.every((i) => strongs(i) === strongs(first))) {
      // Guessed legends, one usage: no telling which print is the real
      // key, so none of them may claim it.
      for (const i of holders) readings[i] = { u: null, via: null };
      continue;
    }
    const base = holders.filter((i) => BASES.has(readings[i].via ?? ""));
    if (base.length === 1) {
      for (const i of holders)
        if (i !== base[0]) readings[i] = { u: null, via: null };
      continue;
    }
    const which = holders.map((i) => keys[i].text ?? "Key").join(" and ");
    throw new Error(
      `two keys in the drawing came out as the same key (${which}). ` +
        "Label them the way they are printed and paste it again.",
    );
  }

  for (let i = 0; i < keys.length; i++) {
    const u = readings[i].u;
    if (u === null) continue;
    const k = keys[i];
    if (u === "fn") {
      k.code = "Fn";
      k.matrixEntry = [...FN_ENTRY];
    } else {
      k.code = USAGE_TO_CODE[u] ?? k.code;
      k.matrixEntry = [0, 0, u, 0];
      k.hidUsage = u;
    }
  }

  // Fn twice would slip past the usage claims above: refuse it the same way.
  const fns = readings.filter((r) => r.u === "fn").length;
  if (fns > 1)
    throw new Error(
      "two keys in the drawing came out as the same key (Fn and Fn). " +
        "Label them the way they are printed and paste it again.",
    );

  return {
    canvas: {
      width: Math.max(...keys.map((k) => k.x + k.w)) + 1,
      height: Math.max(...keys.map((k) => k.y + k.h)) + 1,
    },
    keys,
  };
}
