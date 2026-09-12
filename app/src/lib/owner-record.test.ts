// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { clearOwner, emptyRecord, loadOwner, saveOwner } from "./owner-record";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

describe("the owner record", () => {
  beforeEach(() => store.clear());

  it("round-trips by device id", () => {
    const rec = { ...emptyRecord(), allowed: true, sideLight: false, profiles: 3 };
    saveOwner(1967, rec);
    expect(loadOwner(1967)).toEqual(rec);
    expect(loadOwner(1968)).toBeNull();
    clearOwner(1967);
    expect(loadOwner(1967)).toBeNull();
  });

  it("takes only well-formed fields and falls back on the rest", () => {
    store.set("sharkfin.owner.5", JSON.stringify({ allowed: true, magnetic: "yes", sideLight: 1, profiles: "4" }));
    expect(loadOwner(5)).toEqual({ allowed: true, magnetic: false, sideLight: null, switchWrites: false, profiles: null });
    store.set("sharkfin.owner.6", "not json");
    expect(loadOwner(6)).toBeNull();
    store.set("sharkfin.owner.7", JSON.stringify({ magnetic: true }));
    expect(loadOwner(7)).toBeNull();
  });
});
