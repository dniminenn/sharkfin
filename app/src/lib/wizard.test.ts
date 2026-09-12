// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { BoardLayout, LayoutKey } from "./layout-loader";
import type { ConnectedDevice } from "./backend";
import {
  checkReport,
  codeForUsage,
  freshState,
  judgePress,
  pendingWrite,
  pickSwitchKey,
  setupDone,
  hasReport,
  plainUsage,
  pressTargets,
  sameTravel,
  switchesLookReal,
  travelFloor,
  rainbowNibble,
  remapChoices,
  sliceEntries,
  trueSwap,
} from "./wizard";

const key = (
  code: string,
  x: number,
  y: number,
  slot: number | null,
  usage: number,
  extra: Partial<LayoutKey> = {},
): LayoutKey => ({
  code,
  type: "key",
  x,
  y,
  w: 40,
  h: 40,
  text: code,
  matrixIndex: slot,
  matrixEntry: [0, 0, usage, 0],
  hidUsage: usage,
  consumerUsage: null,
  ...extra,
});

// A 3x3 board: Esc, 1, Backspace across the top; Tab, A, Enter; then
// L-Ctrl, L-Win, R-Ctrl along the bottom.
const board: BoardLayout = {
  canvas: { width: 120, height: 120 },
  keys: [
    key("Escape", 0, 0, 0, 41),
    key("Digit1", 40, 0, 1, 30),
    key("Backspace", 80, 0, 2, 42),
    key("Tab", 0, 40, 3, 43),
    key("KeyA", 40, 40, 4, 4),
    key("Enter", 80, 40, 5, 40),
    key("ControlLeft", 0, 80, 6, 224),
    key("MetaLeft", 40, 80, 7, 227),
    key("ControlRight", 80, 80, 8, 228),
  ],
};

describe("press targets", () => {
  it("takes the four corners and two modifiers, never Meta", () => {
    const targets = pressTargets(board);
    expect(targets.map((t) => t.slot)).toEqual([0, 2, 6, 8]);
    expect(targets.map((t) => t.label)).toEqual([
      "Escape",
      "Backspace",
      "ControlLeft",
      "ControlRight",
    ]);
  });

  it("adds modifiers that are not already corners", () => {
    const wide: BoardLayout = {
      canvas: { width: 200, height: 120 },
      keys: [
        ...board.keys,
        key("ShiftLeft", 120, 80, 9, 225),
        key("AltLeft", 160, 80, 10, 226),
        key("Quote", 160, 0, 11, 52),
      ],
    };
    const targets = pressTargets(wide);
    expect(targets.map((t) => t.slot)).toEqual([0, 11, 6, 10, 9, 8]);
  });

  it("skips keys without a slot, knobs and keys the browser cannot name", () => {
    const odd: BoardLayout = {
      canvas: { width: 120, height: 40 },
      keys: [
        key("Escape", 0, 0, null, 41),
        key("AudioVolumeUp", 40, 0, 20, 0, { type: "knob" }),
        key("Lang1", 80, 0, 21, 144),
        key("KeyB", 60, 0, 22, 5),
      ],
    };
    expect(pressTargets(odd).map((t) => t.slot)).toEqual([22]);
  });

  it("reads the board's own keymap over the picture's factory entries", () => {
    const entries = sliceEntries(new Array(512).fill(0));
    entries.set(0, [0, 0, 57, 0]);
    entries.set(2, [0, 0, 42, 0]);
    entries.set(6, [0, 0, 224, 0]);
    entries.set(8, [9, 0, 1, 0]);
    const targets = pressTargets(board, entries);
    expect(targets.find((t) => t.slot === 0)?.usage).toBe(57);
    expect(targets.some((t) => t.slot === 8)).toBe(false);
  });

  it("adds the two ISO keys when the board has them", () => {
    const iso: BoardLayout = {
      canvas: { width: 160, height: 120 },
      keys: [
        ...board.keys,
        key("IntlBackslash", 120, 40, 9, 100),
        key("Backslash", 120, 0, 10, 50),
      ],
    };
    const targets = pressTargets(iso);
    expect(targets.map((t) => t.slot)).toEqual([0, 10, 6, 8, 9]);
    const hash = targets.find((t) => t.slot === 10)!;
    expect(judgePress(hash, "Backslash").ok).toBe(true);
    expect(judgePress({ slot: 9, usage: 100, label: "" }, "IntlBackslash").ok).toBe(true);
  });

  it("offers nothing on a slot grid", () => {
    expect(pressTargets({ ...board, grid: true })).toEqual([]);
  });
});

describe("judging a press", () => {
  it("matches the browser code to the usage", () => {
    const target = { slot: 0, usage: 41, label: "Esc" };
    expect(judgePress(target, "Escape")).toEqual({ ok: true, sent: "Esc" });
    expect(judgePress(target, "Tab")).toEqual({ ok: false, sent: "Tab" });
    expect(judgePress(target, "Lang1")).toEqual({ ok: false, sent: "Lang1" });
  });

  it("names the code a usage comes back as", () => {
    expect(codeForUsage(41)).toBe("Escape");
    expect(codeForUsage(101)).toBe("ContextMenu");
    expect(codeForUsage(228)).toBe("ControlRight");
    expect(codeForUsage(72)).toBe("Pause");
  });
});

describe("remap choices", () => {
  it("offers only sources that sit in exactly one slot as a plain key", () => {
    const entries = sliceEntries(new Array(512).fill(0));
    entries.set(10, [0, 0, 57, 0]);
    entries.set(11, [0, 0, 228, 0]);
    entries.set(12, [0, 0, 228, 0]);
    entries.set(13, [0, 2, 230, 0]);
    entries.set(14, [0, 0, 71, 0]);
    expect(remapChoices(entries)).toEqual([
      { slot: 10, from: 57, to: 41, label: "Caps Lock to Escape" },
      { slot: 14, from: 71, to: 72, label: "Scroll Lock to Pause" },
    ]);
  });

  it("knows a plain key from anything else", () => {
    expect(plainUsage([0, 0, 41, 0])).toBe(41);
    expect(plainUsage([0, 0, 0, 0])).toBeNull();
    expect(plainUsage([0, 1, 41, 0])).toBeNull();
    expect(plainUsage([9, 0, 1, 0])).toBeNull();
    expect(plainUsage(null)).toBeNull();
  });
});

describe("the switch test", () => {
  const key = (slot: number, kind = 0) => ({
    slot,
    kind,
    rapidTrigger: false,
    travel: 1.9,
    lift: 2.9,
    rtPress: 0.3,
    rtLift: 0.3,
    deadBottom: 0.6,
    dksStart: 0.4,
    dksActions: [0, 0, 0, 0],
    mtTimeMs: 300,
    snapPartner: 255,
  });

  it("feels Space when it is a plain key, else the first named plain key", () => {
    const entries = sliceEntries(new Array(512).fill(0));
    entries.set(1, [0, 0, 4, 0]);
    entries.set(2, [0, 0, 44, 0]);
    entries.set(3, [0, 0, 41, 0]);
    expect(pickSwitchKey([key(1), key(2), key(3)], entries)).toEqual({ slot: 2, usage: 44, label: "Space" });
    // Space carries an advanced kind: not a plain key to feel.
    expect(pickSwitchKey([key(1), key(2, 2), key(3)], entries)).toEqual({ slot: 1, usage: 4, label: "A" });
    expect(pickSwitchKey([key(7)], entries)).toBeNull();
  });

  it("asks for the registry's floor or 0.1 mm, never below the unit", () => {
    const spec = { travel: { travel: { min: 0.2 } } } as ConnectedDevice["spec"];
    expect(travelFloor(spec, 0.01)).toBe(0.2);
    expect(travelFloor({} as ConnectedDevice["spec"], 0.01)).toBe(0.1);
    expect(travelFloor({} as ConnectedDevice["spec"], 0.5)).toBe(0.5);
  });

  it("tells switch columns from a board that has none", () => {
    const keys = Array.from({ length: 12 }, (_, i) => ({ ...key(i), travel: 1.5 + (i % 3) * 0.2 }));
    expect(switchesLookReal({ format: "gen2", unitMm: 0.01, keys })).toBe(true);
    expect(switchesLookReal({ format: "gen2", unitMm: 0.01, keys: keys.slice(0, 4) })).toBe(false);
    const flat = keys.map((k) => ({ ...k, travel: 0 }));
    expect(switchesLookReal({ format: "gen2", unitMm: 0.01, keys: flat })).toBe(false);
    const same = keys.map((k) => ({ ...k, travel: 2 }));
    expect(switchesLookReal({ format: "gen2", unitMm: 0.01, keys: same })).toBe(false);
  });

  it("compares travel to the board's unit", () => {
    expect(sameTravel(0.1, 0.1, 0.01)).toBe(true);
    expect(sameTravel(0.1, 0.104, 0.01)).toBe(true);
    expect(sameTravel(0.1, 0.11, 0.01)).toBe(false);
  });
});

describe("pending writes", () => {
  it("names what would be forgotten by starting over", () => {
    const s = freshState();
    expect(pendingWrite(s)).toBeNull();
    const colour = {
      sw: false,
      originals: null,
      written: true,
      readBack: true,
      answer: null,
      restored: null,
      restoredReadBack: null,
      sideOriginal: null,
      sideWritten: false,
      edge: null,
      sideRestored: null,
    };
    expect(pendingWrite({ ...s, colour })).toBe("the backlight is still red");
    expect(pendingWrite({ ...s, colour: { ...colour, answer: "solid", restored: true, restoredReadBack: true } })).toBeNull();
    expect(pendingWrite({ ...s, profiles: { count: 3, found: null, from: 0, verified: false, away: true, error: null } })).toBe(
      "the keyboard is on another profile",
    );
    const remap = { profile: 0, slot: 1, from: 57, to: 41, written: true, readBack: true, pressed: true, kept: null, undoReadBack: null };
    expect(pendingWrite({ ...s, remap })).toBe("the remap is neither kept nor undone");
    expect(pendingWrite({ ...s, remap: { ...remap, kept: "kept" } })).toBeNull();
    expect(pendingWrite({ ...s, remap: { ...remap, kept: "undo failed" } })).toBe("the undo did not go through");
    expect(pendingWrite({ ...s, colour: { ...colour, answer: "solid", restored: false } })).toBe(
      "the backlight has not been put back",
    );
    expect(
      pendingWrite({
        ...s,
        colour: { ...colour, answer: "solid", restored: true, sideWritten: true, sideRestored: null },
      }),
    ).toBe("the edge light has not been put back");
    const switches = {
      slot: 60,
      label: "Space",
      original: null,
      min: 0.1,
      preset: null,
      wroteMin: true,
      readBackMin: true,
      feltLight: "yes" as const,
      restored: null,
      readBackRestore: null,
      feltNormal: null,
      presetRestored: null,
      unlocked: null,
    };
    expect(pendingWrite({ ...s, switches })).toBe("a key is still set to a light touch");
    expect(pendingWrite({ ...s, switches: { ...switches, restored: true } })).toBeNull();
  });

  it("knows a run that has started from one that has finished", () => {
    expect(hasReport(null)).toBe(false);
    expect(hasReport(freshState())).toBe(false);
    expect(hasReport({ ...freshState(), step: "board" })).toBe(true);
    expect(setupDone({ ...freshState(), step: "board" })).toBe(false);
    expect(setupDone({ ...freshState(), step: "done" })).toBe(true);
  });
});

describe("the rainbow nibble", () => {
  it("follows what went out and what was seen", () => {
    // Unswapped sends 7 for a fixed colour.
    expect(rainbowNibble(false, "solid")).toBe(8);
    expect(rainbowNibble(false, "cycling")).toBe(7);
    // Swapped sends 8.
    expect(rainbowNibble(true, "solid")).toBe(7);
    expect(rainbowNibble(true, "cycling")).toBe(8);
  });

  it("keeps the reading on solid and flips it on cycling", () => {
    expect(trueSwap(false, "solid")).toBe(false);
    expect(trueSwap(false, "cycling")).toBe(true);
    expect(trueSwap(true, "solid")).toBe(true);
    expect(trueSwap(true, "cycling")).toBe(false);
  });
});

describe("the report", () => {
  const device = {
    path: "",
    deviceId: 1967,
    readOnly: false,
    switches: "none",
    revision: null,
    link: "usb",
    battery: null,
    spec: {
      id: 1967,
      name: "X86",
      company: "AttackShark",
      vendor: "",
      vendorId: 0,
      productId: 0,
      internalName: "",
      keyLayout: "Common80_k72x86",
      lightLayout: "",
      profiles: 4,
      family: "yc500",
      features: {
        knob: [],
        debounce: false,
        sleep24: false,
        sleepBT: false,
        magneticSwitches: false,
        screen: false,
        sideLight: false,
      },
    },
  } as unknown as ConnectedDevice;

  it("says not tested for everything a fresh run has not reached", () => {
    const s = { ...freshState(), step: "board" as const };
    expect(checkReport(device, s, "0.7.11")).toBe(
      [
        "sharkfin setup report",
        "board    : Attack Shark X86 (device id 1967)",
        "setup    : 0.7.11, step 2, 0 replugs",
        "link     : usb",
        "own board: unanswered",
        "family   : yc500 (registry)",
        "picture  : not tested",
        "rainbow  : not tested",
        "edge     : none",
        "profiles : not tested",
        "remap    : not tested",
        "magnetic : no (registry)",
        "switches : not tested",
        "changes  : not allowed",
      ].join("\n"),
    );
  });

  it("reports what happened, including what did not", () => {
    const s = {
      ...freshState(),
      step: "done" as const,
      replugs: 1,
      boardOk: "yes" as const,
      allowed: "already" as const,
      picture: {
        layout: "Common80_k72x86",
        pressed: 5,
        of: 6,
        misses: ["the key marked Caps sent Esc"],
      },
      colour: {
        sw: false,
        originals: null,
        written: true,
        readBack: true,
        answer: "cycling" as const,
        restored: true,
        restoredReadBack: true,
        sideOriginal: null,
        sideWritten: false,
        edge: null,
        sideRestored: null,
      },
      profiles: { count: 4, found: null, from: 0, verified: false, away: true, error: "did not take" },
      remap: {
        profile: 0,
        slot: 30,
        from: 57,
        to: 41,
        written: true,
        readBack: true,
        pressed: true,
        kept: "undone" as const,
        undoReadBack: false,
      },
    };
    const lines = checkReport(device, s, "0.7.11").split("\n");
    expect(lines).toContain("setup    : 0.7.11, step 9, 1 replugs");
    expect(lines).toContain(
      "picture  : Common80_k72x86, pressed 5/6; the key marked Caps sent Esc",
    );
    expect(lines).toContain("rainbow  : 7 paints the rainbow, Static tested");
    expect(lines).toContain(
      "profiles : 4, switch did not read back, board left on another profile (did not take)",
    );
    expect(lines).toContain(
      "remap    : slot 30 Caps to Esc, read back yes, pressed yes, undone, undo not read back",
    );
    expect(lines).toContain("changes  : already allowed");
  });

  it("reports the switch test with every read-back and answer", () => {
    const s = {
      ...freshState(),
      step: "done" as const,
      switches: {
        slot: 60,
        label: "Space",
        original: null,
        min: 0.1,
        preset: 0,
        wroteMin: true,
        readBackMin: true,
        feltLight: "yes" as const,
        restored: true,
        readBackRestore: true,
        feltNormal: "yes" as const,
        presetRestored: false,
        unlocked: true,
      },
    };
    expect(checkReport(device, s, null).split("\n")).toContain(
      "switches : slot 60 Space, 0.1 mm took yes, felt light yes, restore took yes, felt normal yes, preset not put back, unlocked",
    );
  });

  it("says what the owner's magnetic answer came to", () => {
    const unregistered = {
      ...device,
      spec: { ...device.spec, unregistered: true },
    } as ConnectedDevice;
    const s = { ...freshState(), step: "done" as const, magnetic: "yes" as const, magneticVerified: false };
    expect(checkReport(unregistered, s, null).split("\n")).toContain(
      "magnetic : yes (owner, columns did not read as travel, treated as no)",
    );
    expect(checkReport(unregistered, { ...s, magneticVerified: true }, null).split("\n")).toContain(
      "magnetic : yes (owner, columns read as travel)",
    );
    expect(checkReport(unregistered, { ...s, magnetic: "no" as const }, null).split("\n")).toContain(
      "magnetic : no (owner)",
    );
  });

  it("does not claim a restore that failed", () => {
    const s = {
      ...freshState(),
      step: "colours" as const,
      colour: {
        sw: true,
        originals: null,
        written: true,
        readBack: false,
        answer: "solid" as const,
        restored: false,
        restoredReadBack: null,
        sideOriginal: null,
        sideWritten: false,
        edge: null,
        sideRestored: null,
      },
    };
    expect(checkReport(device, s, null).split("\n")).toContain(
      "rainbow  : 7 paints the rainbow, Static tested, write did not read back, colour not put back",
    );
  });
});
