// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import KeyboardView from "./KeyboardView";
import layout from "@/lib/layouts/vendor/Local98_Akko_3098B.json";
import { entryLabel } from "@/lib/hid-usages";

vi.mock("@/lib/i18n", () => ({ t: (text: string) => text }));

it("fits keypad legends on caps while retaining their identity in descriptions", () => {
  const entries = new Map(layout.keys.map((k) => [k.matrixIndex, k.matrixEntry]));
  const html = renderToStaticMarkup(createElement(KeyboardView, {
    layout,
    entries,
    modified: new Set<number>(),
    selected: null,
    labelFor: (_key, entry) => entryLabel(entry!),
    onSelect: () => {},
  }));
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
  for (const [name, legend] of [
    ["NumLock", "Num"], ["NumpadDivide", "/"], ["NumpadMultiply", "*"],
    ["NumpadSubtract", "-"], ["NumpadAdd", "+"], ["NumpadEnter", "Enter"],
    ["NumpadDecimal", "."],
    ...Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, String(i)]),
  ]) {
    const button = buttons.find((b) => b.includes(`aria-label="${name}"`));
    expect(button, name).toContain(`: ${name}"`);
    expect(button, name).toContain(`>${legend}</button>`);
  }
  expect(buttons.find((b) => b.includes('aria-label="A"'))).toContain(">A</button>");
});
