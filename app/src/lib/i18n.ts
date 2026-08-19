// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// UI strings are written in English where they appear; t() looks the English
// up in the active catalog and falls back to it, so a missing entry shows
// English rather than a key. The locale is read once at startup and switching
// reloads: language changes are rare, and a reload beats threading
// reactivity through every string.
import id from "./locales/id.json";
import pt from "./locales/pt.json";

const CATALOGS: Record<string, Record<string, string>> = { id, pt };

export const LOCALES = [
  ["en", "English"],
  ["id", "Bahasa Indonesia"],
  ["pt", "Português (Brasil)"],
] as const;

function pick(): string {
  const stored = localStorage.getItem("sharkfin-locale");
  if (stored === "en" || (stored && stored in CATALOGS)) return stored;
  const nav = (navigator.language || "en").toLowerCase();
  for (const l of Object.keys(CATALOGS)) if (nav.startsWith(l)) return l;
  return "en";
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
