// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// The platform a data bundle came from. Without it a board report says
// nothing about which OS the board was exercised on, and the write paths
// differ per OS: Windows goes through HidD_SetFeature, Linux through
// hidraw, the browser through WebHID.
import { BUILD } from "@/lib/backend";

export function hostOs(ua: string): string {
  if (/Windows/.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  if (/Linux|X11|BSD/.test(ua)) return "linux";
  return "unknown";
}

/** Chromium forks all claim Chrome, so the fork's own token has to win. */
export function hostBrowser(ua: string): string {
  for (const [token, name] of [
    ["Edg/", "edge"],
    ["OPR/", "opera"],
    ["Vivaldi/", "vivaldi"],
    ["Chrome/", "chrome"],
  ] as const) {
    if (ua.includes(token)) return name;
  }
  return "browser";
}

export function host(ua = navigator.userAgent): string {
  const where = BUILD === "browser" ? hostBrowser(ua) : "app";
  return `${hostOs(ua)} · ${where}`;
}
