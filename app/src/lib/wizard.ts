// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The rules of the check-your-board wizard, kept apart from the page so they
// can be tested: which keys to ask for, which remap to offer, what an answer
// about the colour means, and the report that goes out with the bundle.
import type { ConnectedDevice, KeySwitch, LedParam, SledParam, SwitchSettings } from "@/lib/backend";
import type { BoardLayout } from "@/lib/layout-loader";
import { CODE_TO_USAGE, usageLabel } from "@/lib/hid-usages";
import { deviceLabel } from "@/lib/brands";

export const STEPS = [
  "start",
  "board",
  "family",
  "keys",
  "colours",
  "profiles",
  "remap",
  "switches",
  "done",
] as const;
export type Step = (typeof STEPS)[number];

export const stepNumber = (step: Step) => STEPS.indexOf(step) + 1;

export interface PictureResult {
  layout: string;
  pressed: number;
  of: number;
  /** "the key marked X sent Y", one per miss. */
  misses: string[];
}

export interface ColourState {
  /** The reading in force when the red went out. */
  sw: boolean;
  /** What the board showed before, read under both readings so whichever
   *  turns out right can be written back as the bytes it came from. */
  originals: { plain: LedParam; swapped: LedParam } | null;
  written: boolean;
  /** The lighting read back as Static after the write. */
  readBack: boolean | null;
  answer: "solid" | "cycling" | "neither" | null;
  /** The original went back out. */
  restored: boolean | null;
  /** And read back as what was written. */
  restoredReadBack: boolean | null;
  sideOriginal: SledParam | null;
  sideWritten: boolean;
  edge: "yes" | "no" | null;
  sideRestored: boolean | null;
}

export interface ProfileResult {
  count: number;
  /** Profiles found by switching on a board the registry does not know;
   *  null when the count came from the registry. */
  found: number | null;
  /** Where the board was; null when that read failed. */
  from: number | null;
  /** Both switches went out and each read back. */
  verified: boolean;
  /** The board was left on another profile. */
  away: boolean;
  error: string | null;
}

export interface RemapState {
  profile: number;
  slot: number;
  from: number;
  to: number;
  written: boolean;
  readBack: boolean | null;
  pressed: boolean | null;
  kept: "kept" | "undone" | "undo failed" | null;
  undoReadBack: boolean | null;
}

export interface SwitchResult {
  slot: number;
  label: string;
  original: KeySwitch | null;
  /** The shallowest actuation the board takes, millimetres. */
  min: number;
  /** yc500 preset before the test; the board moves to custom on any write. */
  preset: number | null;
  wroteMin: boolean;
  readBackMin: boolean | null;
  feltLight: "yes" | "no" | null;
  restored: boolean | null;
  readBackRestore: boolean | null;
  feltNormal: "yes" | "no" | null;
  presetRestored: boolean | null;
  /** Writes read back and the owner felt them: the columns may be written. */
  unlocked: boolean | null;
}

export interface WizardState {
  v: 1;
  step: Step;
  replugs: number;
  boardOk: "yes" | "no" | null;
  /** The owner's word on magnetic switches, asked only when the registry
   *  has no entry to say. */
  magnetic: "yes" | "no" | null;
  /** A yes was checked against the board: its switch columns read as
   *  travel values. Null until a yes is given. */
  magneticVerified: boolean | null;
  /** The owner's word on an edge light, same condition. */
  edgeClaim: "yes" | "no" | null;
  /** Writes were allowed by this run, were already allowed, or never were. */
  allowed: "check" | "already" | "no" | null;
  /** Stopped at the command set: nothing past it was tried. */
  stopped: boolean;
  /** The owner said not now to sending; the nag stops. */
  declined: boolean;
  picture: PictureResult | "skipped" | "none" | null;
  colour: ColourState | null;
  profiles: ProfileResult | "one" | null;
  remap: RemapState | null;
  switches: SwitchResult | "none" | null;
}

export function freshState(): WizardState {
  return {
    v: 1,
    step: "start",
    replugs: 0,
    boardOk: null,
    magnetic: null,
    magneticVerified: null,
    edgeClaim: null,
    allowed: null,
    stopped: false,
    declined: false,
    picture: null,
    colour: null,
    profiles: null,
    remap: null,
    switches: null,
  };
}

const STORE = "sharkfin.wizard";

export function loadWizard(id: number): WizardState | null {
  try {
    const raw = localStorage.getItem(`${STORE}.${id}`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s?.v !== 1 || !STEPS.includes(s.step) || typeof s.replugs !== "number") return null;
    return { ...freshState(), ...s };
  } catch {
    return null;
  }
}

export function saveWizard(id: number, state: WizardState) {
  try {
    localStorage.setItem(`${STORE}.${id}`, JSON.stringify(state));
  } catch {
    // Storage can be blocked; the run then does not survive a reload.
  }
}

export function clearWizard(id: number) {
  try {
    localStorage.removeItem(`${STORE}.${id}`);
  } catch {
    // As above.
  }
}

/** A slot holding one ordinary key: no tag, no modifier byte, a usage. */
export const plainUsage = (entry: number[] | null | undefined): number | null =>
  entry && entry.length === 4 && entry[0] === 0 && entry[1] === 0 && entry[2] !== 0 && entry[3] === 0
    ? entry[2]
    : null;

export function sliceEntries(matrix: number[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let slot = 0; slot < 128; slot++) m.set(slot, matrix.slice(slot * 4, slot * 4 + 4));
  return m;
}

const USAGE_TO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_USAGE).map(([code, usage]) => [usage, code]),
);

/** The two keys only ISO boards have. Browsers report the one beside Enter
 *  (usage 50) under the same code as the US backslash, so a press of it is
 *  judged against that code. */
const ISO_USAGES = [100, 50];
const ISO_CODES: Record<number, string> = { 50: "Backslash" };

/** The KeyboardEvent.code a key sending this usage produces. */
export const codeForUsage = (usage: number): string | undefined =>
  USAGE_TO_CODE[usage] ?? ISO_CODES[usage];

/** The OS takes these for itself; a press test on them proves nothing. */
const META = new Set([227, 231]);
const isModifier = (u: number) => u >= 224 && u <= 231 && !META.has(u);

export interface PressTarget {
  slot: number;
  usage: number;
  label: string;
}

/** The keys to press: the four corners of the picture, two modifiers, and
 *  the two ISO-only keys when the board has them, since an ANSI picture on
 *  an ISO board is the mismatch that has come up most. Only slots holding
 *  a plain key the browser can name are asked for, and never a Meta key.
 *  `entries` is the board's own keymap when it has been read; without it
 *  the picture's factory entries stand in. */
export function pressTargets(
  layout: BoardLayout,
  entries?: Map<number, number[]>,
): PressTarget[] {
  if (layout.grid) return [];
  const usable = layout.keys
    .filter((k) => k.type !== "knob" && k.matrixIndex !== null)
    .map((k) => {
      const entry = entries ? entries.get(k.matrixIndex!) : k.matrixEntry;
      const usage = plainUsage(entry);
      return { key: k, usage };
    })
    .filter((x): x is { key: (typeof layout.keys)[number]; usage: number } =>
      x.usage !== null && !META.has(x.usage) && codeForUsage(x.usage) !== undefined,
    );
  if (!usable.length) return [];
  const W = layout.canvas.width;
  const H = layout.canvas.height;
  const corners: ((k: (typeof layout.keys)[number]) => number)[] = [
    (k) => k.x + k.y,
    (k) => W - (k.x + k.w) + k.y,
    (k) => k.x + (H - (k.y + k.h)),
    (k) => W - (k.x + k.w) + (H - (k.y + k.h)),
  ];
  const out: PressTarget[] = [];
  const taken = new Set<number>();
  const add = (x: { key: (typeof layout.keys)[number]; usage: number }) => {
    const slot = x.key.matrixIndex!;
    if (taken.has(slot)) return;
    taken.add(slot);
    out.push({ slot, usage: x.usage, label: x.key.text ?? usageLabel(x.usage) });
  };
  for (const score of corners) {
    let best = usable[0];
    for (const x of usable) if (score(x.key) < score(best.key)) best = x;
    add(best);
  }
  const mods = usable
    .filter((x) => isModifier(x.usage) && !taken.has(x.key.matrixIndex!))
    .sort((a, b) => a.usage - b.usage);
  for (const x of mods.slice(0, 2)) add(x);
  for (const x of usable) if (ISO_USAGES.includes(x.usage)) add(x);
  return out;
}

/** What a press said, against what the picture promised. */
export function judgePress(target: PressTarget, code: string): { ok: boolean; sent: string } {
  const usage = CODE_TO_USAGE[code];
  return {
    ok: usage === target.usage || ISO_CODES[target.usage] === code,
    sent: usage === undefined ? code : usageLabel(usage),
  };
}

/** The switch columns of a board that has magnetic switches read as travel
 *  values: most plain keys between the unit and 5 mm, and not all one
 *  number. A board without them answers the read with something else. */
export function switchesLookReal(s: SwitchSettings): boolean {
  const plain = s.keys.filter((k) => k.kind === 0);
  if (plain.length < 8) return false;
  const sane = plain.filter((k) => k.travel >= s.unitMm && k.travel <= 5);
  if (sane.length < plain.length * 0.8) return false;
  return new Set(sane.map((k) => k.travel)).size > 1;
}

/** The backend's answer when a profile switch went out and the read after
 *  it did not agree; anything else is the write itself failing. */
export const didNotTake = (e: unknown) => String(e).includes("did not take");

/** A write the check has made and not yet put back or settled. While one
 *  is open, starting over would forget what the board was. */
export function pendingWrite(s: WizardState): string | null {
  const c = s.colour;
  if (c?.written && c.answer === null) return "the backlight is still red";
  if (c?.written && c.answer !== null && c.restored !== true) return "the backlight has not been put back";
  if (c?.sideWritten && c.sideRestored !== true) return "the edge light has not been put back";
  const p = s.profiles;
  if (p && p !== "one" && p.away) return "the keyboard is on another profile";
  const r = s.remap;
  if (r?.written && r.kept === null) return "the remap is neither kept nor undone";
  if (r?.written && r.kept === "undo failed") return "the undo did not go through";
  const w = s.switches;
  if (w && w !== "none" && w.wroteMin && w.restored !== true) return "a key is still set to a light touch";
  return null;
}

export interface RemapChoice {
  slot: number;
  from: number;
  to: number;
  label: string;
}

// From a key most boards have to a target the OS does not swallow.
const REMAPS: [number, number, string][] = [
  [57, 41, "Caps Lock to Escape"],
  [228, 101, "Right Ctrl to Menu"],
  [230, 228, "Right Alt to Right Ctrl"],
  [71, 72, "Scroll Lock to Pause"],
];

/** The remaps this keymap allows: the source must sit in exactly one slot
 *  as a plain key. */
export function remapChoices(entries: Map<number, number[]>): RemapChoice[] {
  const out: RemapChoice[] = [];
  for (const [from, to, label] of REMAPS) {
    const slots: number[] = [];
    for (const [slot, entry] of entries) if (plainUsage(entry) === from) slots.push(slot);
    if (slots.length === 1) out.push({ slot: slots[0], from, to, label });
  }
  return out;
}

/** The nibble that paints the rainbow on this board, from what the owner saw
 *  after a fixed-colour write sent under reading `sw`. Unswapped, a fixed
 *  colour goes out as 7; swapped, as 8. Solid means the board agreed with
 *  the reading; cycling means it reads the nibble the other way round. */
export function rainbowNibble(sw: boolean, answer: "solid" | "cycling"): 7 | 8 {
  const sentFixed = sw ? 8 : 7;
  return answer === "solid" ? (sentFixed === 7 ? 8 : 7) : sentFixed;
}

/** The reading the board turned out to have. */
export const trueSwap = (sw: boolean, answer: "solid" | "cycling") =>
  answer === "solid" ? sw : !sw;

/** The key to feel the switch test on: Space when it is a plain key, else
 *  the first plain-kind key the browser can name. */
export function pickSwitchKey(
  keys: KeySwitch[],
  entries: Map<number, number[]>,
): { slot: number; usage: number; label: string } | null {
  const plain = keys.filter((k) => k.kind === 0);
  const named = plain
    .map((k) => ({ slot: k.slot, usage: plainUsage(entries.get(k.slot)) }))
    .filter((x): x is { slot: number; usage: number } => x.usage !== null && codeForUsage(x.usage) !== undefined);
  const pick = named.find((x) => x.usage === 44) ?? named[0];
  return pick ? { ...pick, label: usageLabel(pick.usage) } : null;
}

/** The shallowest actuation to ask the board for: the registry's floor
 *  when it has one, else 0.1 mm, never below the board's unit. */
export const travelFloor = (spec: ConnectedDevice["spec"], unit: number) =>
  Math.max(spec.travel?.travel?.min ?? 0.1, unit);

/** A travel read back equals what was written, to the board's own unit. */
export const sameTravel = (a: number, b: number, unit: number) =>
  Math.abs(a - b) < unit / 2 + 1e-9;

const yesNo = (v: boolean | null) => (v === null ? "unanswered" : v ? "yes" : "no");
const yn = (v: "yes" | "no" | null) => v ?? "unanswered";

export function checkReport(
  device: ConnectedDevice,
  s: WizardState,
  version: string | null,
): string {
  const spec = device.spec;
  const family =
    spec.family === "gen2" || spec.family === "yc500"
      ? `${spec.family} (${spec.unregistered ? "board" : "registry"})`
      : "unknown";
  const picture =
    s.picture === null
      ? "not tested"
      : s.picture === "skipped"
        ? "skipped"
        : s.picture === "none"
          ? "none on file, not tested"
          : `${s.picture.layout}, pressed ${s.picture.pressed}/${s.picture.of}` +
            (s.picture.misses.length ? `; ${s.picture.misses.join("; ")}` : "");
  const c = s.colour;
  const rainbow =
    !c || !c.written
      ? "not tested"
      : c.answer === "solid" || c.answer === "cycling"
        ? `${rainbowNibble(c.sw, c.answer)} paints the rainbow, Static tested` +
          (c.readBack === false ? ", write did not read back" : "") +
          (c.restored === false
            ? ", colour not put back"
            : c.restoredReadBack === false
              ? ", restore did not read back"
              : "")
        : c.answer === "neither"
          ? "no change seen" + (c.restored === false ? ", colour not put back" : "")
          : "unanswered";
  const edge =
    c && c.sideWritten
      ? yesNo(c.edge === null ? null : c.edge === "yes") +
        (c.sideRestored === false ? ", not put back" : "")
      : !spec.features.sideLight
        ? s.edgeClaim === "no"
          ? "no (owner)"
          : "none"
        : "not tested";
  const p = s.profiles;
  const profiles =
    p === null
      ? "not tested"
      : p === "one"
        ? "1, nothing to switch"
        : `${p.count}${p.found !== null ? " found" : ""}, ` +
          (p.verified
            ? "switch read back"
            : "switch did not read back" + (p.away ? ", board left on another profile" : "")) +
          (p.error ? ` (${p.error})` : "");
  const r = s.remap;
  const remap =
    !r || !r.written
      ? "not tested"
      : `slot ${r.slot} ${usageLabel(r.from)} to ${usageLabel(r.to)}, read back ${yesNo(r.readBack)}, pressed ${yesNo(r.pressed)}, ` +
        (r.kept === null
          ? "undecided"
          : r.kept === "kept"
            ? "kept"
            : r.kept === "undone"
              ? r.undoReadBack === false
                ? "undone, undo not read back"
                : "undone"
              : "undo failed");
  const magnetic = spec.unregistered
    ? s.magnetic === null
      ? "unanswered"
      : s.magnetic === "yes"
        ? `yes (owner, columns ${s.magneticVerified ? "read as travel" : "did not read as travel, treated as no"})`
        : "no (owner)"
    : spec.magnetic
      ? "yes (registry)"
      : "no (registry)";
  const w = s.switches;
  const switches =
    w === null
      ? "not tested"
      : w === "none"
        ? "no columns to read"
        : !w.wroteMin
          ? "not tested"
          : `slot ${w.slot} ${w.label}, ${w.min} mm took ${yesNo(w.readBackMin)}, felt light ${yn(w.feltLight)}, ` +
            `restore took ${yesNo(w.readBackRestore)}, felt normal ${yn(w.feltNormal)}` +
            (w.presetRestored === false ? ", preset not put back" : "") +
            `, ${w.unlocked === null ? "undecided" : w.unlocked ? "unlocked" : "not unlocked"}`;
  const changes =
    s.allowed === "check"
      ? "allowed by setup"
      : s.allowed === "already"
        ? "already allowed"
        : "not allowed";
  return [
    "sharkfin setup report",
    `board    : ${deviceLabel(spec)} (device id ${spec.id})`,
    `setup    : ${version ?? "unknown"}, step ${stepNumber(s.step)}, ${s.replugs} replugs`,
    `link     : ${device.link}`,
    `own board: ${s.boardOk ?? "unanswered"}`,
    `family   : ${family}`,
    `picture  : ${picture}`,
    `rainbow  : ${rainbow}`,
    `edge     : ${edge}`,
    `profiles : ${profiles}`,
    `remap    : ${remap}`,
    `magnetic : ${magnetic}`,
    `switches : ${switches}`,
    `changes  : ${changes}`,
  ].join("\n");
}

/** A run that has something to say: anything past the first screen. */
export const hasReport = (s: WizardState | null): s is WizardState =>
  !!s && s.step !== "start";

/** A run that reached the end. The board is set up as far as setup goes. */
export const setupDone = (s: WizardState | null): s is WizardState =>
  !!s && s.step === "done";
