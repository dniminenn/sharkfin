// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  AKKO_5075B_PLUS_S_MAC_FILTER,
  isAkko5075bPlusSMacTlc,
  webHidRequestFilters,
} from "./akko-1033";

const device = (productId: number, usagePage: number, usage: number): HIDDevice =>
  ({
    vendorId: 0x05ac,
    productId,
    collections: [{ usagePage, usage }],
  }) as HIDDevice;

describe("Akko 5075B Plus-S WebHID identity", () => {
  it("matches only the observed keyboard TLC", () => {
    expect(isAkko5075bPlusSMacTlc(device(0x024f, 0x01, 0x06))).toBe(true);
    expect(isAkko5075bPlusSMacTlc(device(0x024f, 0x01, 0x02))).toBe(false);
    expect(isAkko5075bPlusSMacTlc(device(0x0250, 0x01, 0x06))).toBe(false);
  });

  it("adds the exact TLC without broadening vendor filters", () => {
    const filters = webHidRequestFilters([0x3151]);
    expect(filters).toContainEqual({ vendorId: 0x3151, usagePage: 0xffff, usage: 0x0001 });
    expect(filters).toContainEqual(AKKO_5075B_PLUS_S_MAC_FILTER);
    expect(filters).not.toContainEqual({ vendorId: 0x05ac });
  });
});
