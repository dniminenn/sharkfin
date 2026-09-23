// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
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
  ({
    vendorId,
    productId,
    collections: [
      {
        usagePage,
        usage,
        children: [] as HIDCollectionInfo[],
        featureReports: [
          { reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] },
        ],
      },
    ],
  }) as HIDDevice;

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

  it("finds the 3098B settings interface and rejects its input-only sibling", () => {
    const settings = device(0x3151, 0x4002, 1, 6);
    const inputOnly = device(0x3151, 0x4002, 0xffff, 1);
    inputOnly.collections[0].featureReports = [];
    expect(isSettingsCollection(settings, [0x3151])).toBe(true);
    expect(isSettingsCollection(inputOnly, [0x3151])).toBe(false);
    expect(requestFilters([0x3151])).toContainEqual({
      vendorId: 0x3151,
      productId: 0x4002,
      usagePage: 1,
      usage: 6,
    });
    expect(isSettingsCollection(device(0x3151, 0x4003, 1, 6), [0x3151])).toBe(
      false,
    );
    expect(isSettingsCollection(device(0x3151, 0x4002, 0xffff, 2), [0x3151])).toBe(
      true,
    );
  });

  it("rejects settings reports with the wrong ID or length", () => {
    const d = device(0x3151, 0x4002, 1, 6);
    d.collections[0].featureReports[0].reportId = 5;
    expect(isSettingsCollection(d, [0x3151])).toBe(false);
    d.collections[0].featureReports[0].reportId = 0;
    d.collections[0].featureReports[0].items[0].reportCount = 3;
    expect(isSettingsCollection(d, [0x3151])).toBe(false);
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
