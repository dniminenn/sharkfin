// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from "vitest";
import { CODE_TO_USAGE, entryLabel } from "./hid-usages";

it("labels the keypad entries read from the 3098B instead of showing raw bytes", () => {
  for (const [code, usage] of Object.entries(CODE_TO_USAGE)) {
    if (code === "NumLock" || code.startsWith("Numpad")) {
      expect(entryLabel([0, 0, usage, 0])).toBe(code);
    }
  }
  expect(entryLabel([0, 0, 30, 0])).toBe("1");
  expect(entryLabel([0, 224, 4, 0])).toBe("L-Ctrl+A");
  expect(entryLabel([0, 0, 0, 0])).toBe("✕");
  expect(entryLabel([0, 0, 0, 0], true)).toBe("▽");
  expect(entryLabel([99, 1, 2, 3])).toBe("99:1:2:3");
});
