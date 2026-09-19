// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  KEYBOARD_COLLECTIONS,
  isSettingsCollection,
  requestFilters,
} from "./collections";

const device = (
  vendorId: number,
  productId: number,
  usagePage: number,
  usage: number,
) =>
  ({ vendorId, productId, collections: [{ usagePage, usage }] }) as HIDDevice;

describe("settings collection", () => {
  it("takes the vendor page on a known vendor", () => {
    expect(
      isSettingsCollection(device(0x3151, 0x5030, 0xffff, 0x0002), [0x3151]),
    ).toBe(true);
    expect(
      isSettingsCollection(device(0x3151, 0x5030, 0xffff, 0x0006), [0x3151]),
    ).toBe(false);
  });

  it("takes the keyboard collection only on the listed Mac-mode id", () => {
    expect(isSettingsCollection(device(0x05ac, 0x024f, 0x01, 0x06), [])).toBe(
      true,
    );
    expect(isSettingsCollection(device(0x05ac, 0x024f, 0x01, 0x02), [])).toBe(
      false,
    );
    expect(isSettingsCollection(device(0x05ac, 0x0250, 0x01, 0x06), [])).toBe(
      false,
    );
  });

  it("asks the picker for both without widening any vendor", () => {
    const filters = requestFilters([0x3151]);
    expect(filters).toContainEqual({
      vendorId: 0x3151,
      usagePage: 0xffff,
      usage: 0x0001,
    });
    expect(filters).toContainEqual(KEYBOARD_COLLECTIONS[0]);
    expect(filters).not.toContainEqual({ vendorId: 0x05ac });
  });
});
