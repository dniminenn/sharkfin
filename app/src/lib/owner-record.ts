// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// What the owner established about their board in the check, kept by device
// id and applied to the backend on every connect. This is how a board the
// registry does not know goes on working between sessions: the owner's
// answers stand in for the registry entry until a report lands one.
import type { OwnerRecord } from "@/lib/backend";

const STORE = "sharkfin.owner";

export function emptyRecord(): OwnerRecord {
  return { allowed: false, magnetic: false, sideLight: null, switchWrites: false, profiles: null };
}

export function loadOwner(id: number): OwnerRecord | null {
  try {
    const raw = localStorage.getItem(`${STORE}.${id}`);
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (typeof r?.allowed !== "boolean") return null;
    return {
      allowed: r.allowed,
      magnetic: r.magnetic === true,
      sideLight: typeof r.sideLight === "boolean" ? r.sideLight : null,
      switchWrites: r.switchWrites === true,
      profiles: typeof r.profiles === "number" ? r.profiles : null,
    };
  } catch {
    return null;
  }
}

export function saveOwner(id: number, record: OwnerRecord) {
  try {
    localStorage.setItem(`${STORE}.${id}`, JSON.stringify(record));
  } catch {
    // Storage can be blocked; the board then needs the check again next time.
  }
}

export function clearOwner(id: number) {
  try {
    localStorage.removeItem(`${STORE}.${id}`);
  } catch {
    // As above.
  }
}
