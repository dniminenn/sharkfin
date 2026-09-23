// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import PermissionNotice from "./PermissionNotice";

vi.mock("@/lib/i18n", () => ({ t: (text: string) => text }));
vi.mock("@/lib/backend", () => ({
  requestInputMonitoring: vi.fn(),
  openInputMonitoringSettings: vi.fn(),
  revealCurrentApp: vi.fn(),
}));

it("offers Input Monitoring access when macOS has not granted it", () => {
  vi.stubGlobal("navigator", { userAgent: "Macintosh" });
  try {
    const onRefresh = async () => {};
    const unknown = renderToStaticMarkup(createElement(PermissionNotice, { inputMonitoring: "unknown", onRefresh }));
    expect(unknown).toContain("Request input access");
    expect(unknown).toContain("Open Input Monitoring");

    const denied = renderToStaticMarkup(createElement(PermissionNotice, { inputMonitoring: "denied", onRefresh }));
    expect(denied).not.toContain("Request input access");
    expect(denied).toContain("Open Input Monitoring");
    expect(denied).toContain("Show sharkfin in Finder");
    expect(denied).toContain("Input Monitoring");
    expect(denied).not.toContain("holding the keyboard open");

    const granted = renderToStaticMarkup(createElement(PermissionNotice, { inputMonitoring: "granted", onRefresh }));
    expect(granted).not.toContain("Request input access");
    expect(granted).toContain("quit and reopen sharkfin");

    vi.stubGlobal("navigator", { userAgent: "Linux" });
    const linux = renderToStaticMarkup(createElement(PermissionNotice, { inputMonitoring: null, onRefresh }));
    expect(linux).toContain("udev");
    expect(linux).not.toContain("Open Input Monitoring");
  } finally {
    vi.unstubAllGlobals();
  }
});
