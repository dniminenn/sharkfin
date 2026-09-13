// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { hostBrowser, hostOs } from "./host";

const UA = {
  win_edge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  win_chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  linux_webkitgtk:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  mac_wkwebview:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linux_opera:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/126.0.0.0",
  win_vivaldi:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Vivaldi/7.5",
};

describe("hostOs", () => {
  it("reads the three desktop platforms", () => {
    expect(hostOs(UA.win_chrome)).toBe("windows");
    expect(hostOs(UA.mac_wkwebview)).toBe("macos");
    expect(hostOs(UA.linux_webkitgtk)).toBe("linux");
  });

  it("does not guess", () => {
    expect(hostOs("curl/8.5.0")).toBe("unknown");
  });
});

describe("hostBrowser", () => {
  it("prefers the fork's own token over Chrome", () => {
    expect(hostBrowser(UA.win_edge)).toBe("edge");
    expect(hostBrowser(UA.linux_opera)).toBe("opera");
    expect(hostBrowser(UA.win_vivaldi)).toBe("vivaldi");
  });

  it("falls back to chrome, then to browser", () => {
    expect(hostBrowser(UA.win_chrome)).toBe("chrome");
    expect(hostBrowser(UA.linux_webkitgtk)).toBe("browser");
  });
});
