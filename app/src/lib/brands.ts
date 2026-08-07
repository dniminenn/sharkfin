// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Vendor company strings are raw internal tokens ("AttackShark", "rongyuan",
// CJK names). Map the ones we know; otherwise split camelCase and title-case.
const BRANDS: Record<string, string> = {
  attackshark: "Attack Shark",
  rongyuan: "Rongyuan",
  ajazzmouse: "Ajazz",
  ajazz: "Ajazz",
  akko: "Akko",
  epomaker: "Epomaker",
  ikbc: "ikbc",
  kiip: "KiiP",
  noppoo: "Noppoo",
  meetion: "Meetion",
  hator: "Hator",
  eweadnv: "EWEADN",
  vkms: "VKMS",
  kiiboom: "KiiBoom",
  abko: "ABKO",
  dns: "DNS",
  mmd: "MMD",
  ideez: "IDEEZ",
  salpido: "Salpido",
  piifoxdriver: "PiiFox",
  kuskillkorp: "KUSkill",
  aim1keys: "AIM1 Keys",
  shadowapp: "Shadow",
  xinmengk65keyboard: "XinMeng",
  royalaxe: "RoyalAxe",
  "腹灵": "Fl·Esports",
  "蝴蝶": "Hudie",
};

export function brandName(raw: string | undefined): string {
  if (!raw) return "";
  const hit = BRANDS[raw.toLowerCase()] ?? BRANDS[raw];
  if (hit) return hit;
  if (/[^\x20-\x7e]/.test(raw)) return raw;
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "Attack Shark X86" */
export function deviceLabel(spec: {
  vendor?: string;
  company?: string;
  displayName?: string;
  name: string;
}): string {
  const model = spec.displayName?.trim() || spec.name;
  const brand = brandName(spec.company || spec.vendor);
  return brand && !model.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${model}`
    : model;
}
