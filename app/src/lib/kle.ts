// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// keyboard-layout-editor.com import: geometry and legends from a KLE
// export, factory entries guessed from the legends. Slots are attached
// later by matching against the board's own keymap, same as any other
// geometry-only layout. Rotated keys are refused; numpads map only their
// named keys, digits there stay unmatched and draw dimmed.
import type { BoardLayout, LayoutKey } from "@/lib/layout-loader";
import { CODE_TO_USAGE } from "@/lib/hid-usages";

const U = 46; // 1u in our layout files' pixels
const GAP = 6;

const NAMED: Record<string, number> = {
  ESC: 41, ESCAPE: 41,
  TAB: 43,
  CAPS: 57, "CAPS LOCK": 57, CAPSLOCK: 57,
  ENTER: 40, RETURN: 40,
  BACKSPACE: 42, BKSP: 42, "⌫": 42,
  SPACE: 44, SPACEBAR: 44,
  DELETE: 76, DEL: 76,
  INSERT: 73, INS: 73,
  HOME: 74, END: 77,
  PGUP: 75, "PAGE UP": 75, PGDN: 78, "PAGE DOWN": 78,
  PRTSC: 70, "PRT SC": 70, "PRINT SCREEN": 70,
  "SCROLL LOCK": 71, SCRLK: 71,
  PAUSE: 72, BREAK: 72, "PAUSE BREAK": 72,
  UP: 82, "↑": 82, DOWN: 81, "↓": 81, LEFT: 80, "←": 80, RIGHT: 79, "→": 79,
  "`": 53, "~": 53, "-": 45, _: 45, "=": 46, "+": 46,
  "[": 47, "{": 47, "]": 48, "}": 48, "\\": 49, "|": 49,
  ";": 51, ":": 51, "'": 52, '"': 52, ",": 54, "<": 54, ".": 55, ">": 55,
  "/": 56, "?": 56,
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
  "🠜": "LEFT", "🠞": "RIGHT", "🠝": "UP", "🠟": "DOWN",
  "⯇": "LEFT", "⯈": "RIGHT", "⯅": "UP", "⯆": "DOWN",
  "◀": "LEFT", "▶": "RIGHT", "▲": "UP", "▼": "DOWN",
};
for (let i = 0; i < 26; i++) NAMED[String.fromCharCode(65 + i)] = 4 + i;
for (let i = 1; i <= 9; i++) NAMED[`${i}`] = 29 + i;
NAMED["0"] = 39;
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = 57 + i;

// Left first, right second, by order of appearance.
const PAIRED: Record<string, [number, number]> = {
  SHIFT: [225, 229],
  CTRL: [224, 228], CONTROL: [224, 228],
  ALT: [226, 230], OPT: [226, 230], OPTION: [226, 230],
  WIN: [227, 231], GUI: [227, 231], CMD: [227, 231], META: [227, 231], SUPER: [227, 231],
};

const USAGE_TO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([c, u]) => [u, c]),
);

/** A legend as something the tables can be looked up by. */
function normalise(raw: string): string {
  let l = raw.trim();
  // <i class="fa fa-windows"></i> and friends: the class names the key.
  const icon = /fa-(windows|apple|command|option|linux|tux)/i.exec(l);
  if (icon) return icon[1].toLowerCase() === "option" ? "ALT" : "WIN";
  l = l.replace(/<[^>]*>/g, "").trim();
  if (GLYPHS[l]) return GLYPHS[l];
  return l.toUpperCase();
}

function mapLegend(legends: string[], seen: Map<string, number>, w: number): number | null {
  // A plain "x\ny" string is shifted over unshifted, so try later lines first.
  for (const raw of [...legends].reverse()) {
    const l = normalise(raw);
    if (!l) continue;
    if (l in PAIRED) {
      const nth = seen.get(l) ?? 0;
      seen.set(l, nth + 1);
      return PAIRED[l][Math.min(nth, 1)];
    }
    if (l in NAMED) return NAMED[l];
  }
  // Nothing matched. A key this wide is the spacebar whatever it is
  // labelled with, and every drawing has exactly one.
  if (w >= 4 && !seen.has("SPACE")) {
    seen.set("SPACE", 1);
    return NAMED.SPACE;
  }
  return null;
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
      const usage = mapLegend(legends, seen, w);
      const text = legends.find((l) => l.trim())?.trim() ?? null;
      keys.push({
        code: usage !== null ? (USAGE_TO_CODE[usage] ?? text ?? "Key") : (text ?? "Key"),
        type: "key",
        x: Math.round(x * U) + 1,
        y: Math.round(y * U) + 1,
        w: Math.round(w * U) - GAP,
        h: Math.round(h * U) - GAP,
        text,
        matrixIndex: null,
        matrixEntry: usage !== null ? [0, 0, usage, 0] : null,
        hidUsage: usage,
        consumerUsage: null,
      });
      x += w;
      w = 1;
      h = 1;
    }
    y += 1;
  }
  if (keys.length < 2) throw new Error("no keys in the drawing");

  // Two keys claiming one function means a legend was read wrong, and the
  // picture would then remap a key the user did not click. A Y87 drawing
  // put its arrows on Minus and Equal that way. Refuse rather than guess:
  // no keyboard has the same key twice.
  const byUsage = new Map<number, string[]>();
  for (const k of keys) {
    if (k.hidUsage === null) continue;
    const at = byUsage.get(k.hidUsage) ?? [];
    at.push(k.text ?? k.code);
    byUsage.set(k.hidUsage, at);
  }
  const clashes = [...byUsage.values()].filter((v) => v.length > 1);
  if (clashes.length) {
    const which = clashes.map((v) => v.join(" and ")).join("; ");
    throw new Error(
      `two keys in the drawing came out as the same key (${which}). ` +
        "Label them the way they are printed and paste it again.",
    );
  }

  return {
    canvas: {
      width: Math.max(...keys.map((k) => k.x + k.w)) + 1,
      height: Math.max(...keys.map((k) => k.y + k.h)) + 1,
    },
    keys,
  };
}
