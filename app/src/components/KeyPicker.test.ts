// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import KeyPicker, { searchAssignables } from "./KeyPicker";
import { keyActionLabel } from "@/lib/key-action";

vi.mock("@/lib/i18n", () => ({
  t: (text: string, vars: Record<string, string> = {}) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), text),
}));
const actionLabel = (entry: number[]) => keyActionLabel(entry, 17, 2730, true);

it("finds the effective Command action without changing the stored entry", () => {
  const hits = searchAssignables("command", actionLabel);
  expect(hits.find((a) => a.label === "L-Alt")?.entry).toEqual([0, 0, 0xe2, 0]);
  expect(searchAssignables("L-Alt", actionLabel)[0].entry).toEqual([0, 0, 0xe2, 0]);
  expect(searchAssignables("option", actionLabel).some((a) => a.label === "L-Alt")).toBe(false);
});

it("shows the effective current action and stored picker choice", () => {
  const html = renderToStaticMarkup(createElement(KeyPicker, {
    name: "Alt", query: "command", current: [0, 0, 0xe2, 0],
    fnLayer: false, canReset: false, disabled: false, actionLabel,
    onAssign: () => {}, onReset: () => {},
  }));
  expect(html).toContain("now L-Command");
  expect(html).toContain("Stored now: L-Alt.");
  expect(html).toContain("L-Command (L-Alt)");
});
