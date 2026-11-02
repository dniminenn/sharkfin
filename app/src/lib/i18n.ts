// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// UI strings are written in English where they appear; t() looks the English
// up in the active catalog and falls back to it, so a missing entry shows
// English rather than a key. The locale is read once at startup and switching
// reloads: language changes are rare, and a reload beats threading
// reactivity through every string.
import id from "./locales/id.json";
import pt from "./locales/pt.json";
import zhCN from "./locales/zh-cn.json";
import zhTW from "./locales/zh-tw.json";

const CATALOGS: Record<string, Record<string, string>> = {
  id,
  pt,
  "zh-cn": zhCN,
  // Singapore uses the same Simplified wording as the mainland for these strings.
  "zh-sg": zhCN,
  "zh-tw": zhTW,
};

export const LOCALES = [
  ["en", "English"],
  ["id", "Bahasa Indonesia"],
  ["pt", "Português (Brasil)"],
  ["zh-cn", "简体中文（中国）"],
  ["zh-sg", "简体中文（新加坡）"],
  ["zh-tw", "繁體中文（台灣）"],
] as const;

// Browsers also report Chinese as a bare "zh", or with a script subtag.
const ZH_ALIAS: Record<string, string> = {
  zh: "zh-cn",
  "zh-hans": "zh-cn",
  "zh-hans-cn": "zh-cn",
  "zh-hans-sg": "zh-sg",
  "zh-hant": "zh-tw",
  "zh-hant-tw": "zh-tw",
  "zh-hk": "zh-tw",
  "zh-hant-hk": "zh-tw",
  "zh-mo": "zh-tw",
};

function pick(): string {
  const stored = localStorage.getItem("sharkfin-locale");
  if (stored === "en" || (stored && stored in CATALOGS)) return stored;
  const nav = (navigator.language || "en").toLowerCase();
  for (const l of Object.keys(CATALOGS)) if (nav.startsWith(l)) return l;
  return ZH_ALIAS[nav] ?? "en";
}

export const locale = pick();
document.documentElement.lang = locale;
const catalog = CATALOGS[locale] ?? {};

export function t(s: string, vars?: Record<string, string | number>): string {
  let out = catalog[s] ?? s;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

export function setLocale(next: string) {
  localStorage.setItem("sharkfin-locale", next);
  location.reload();
}
