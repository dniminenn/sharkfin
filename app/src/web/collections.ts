// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which HID collection carries the settings protocol. Same rules as
// `hid.rs` on the desktop, so the two builds find the same boards.

export const USAGE_PAGE = 0xffff;
// Almost every board reports usage 2 on the vendor page; the Akko ACR75 v2
// reports 1, and the vendor's own driver looks for both.
export const USAGES = [0x0001, 0x0002];

/**
 * Boards that answer the protocol on their keyboard collection instead of a
 * vendor page. The Akko 5075B Plus-S in Mac mode enumerates as Apple
 * 05ac:024f with no vendor collection; the vendor's driver carries the same
 * exception, and issue #58 is the round trip. Chromium lets feature reports
 * through on a keyboard collection, which is all sharkfin sends. A real
 * Apple Aluminium Keyboard shares the id and will appear as a stranger.
 */
export const KEYBOARD_COLLECTIONS: HIDDeviceFilter[] = [
  { vendorId: 0x05ac, productId: 0x024f, usagePage: 0x01, usage: 0x06 },
];

const matches = (d: HIDDevice, f: HIDDeviceFilter) =>
  d.vendorId === f.vendorId &&
  d.productId === f.productId &&
  d.collections.some((c) => c.usagePage === f.usagePage && c.usage === f.usage);

export const isSettingsCollection = (d: HIDDevice, vendors: number[]) =>
  (vendors.includes(d.vendorId) &&
    d.collections.some(
      (c) => c.usagePage === USAGE_PAGE && USAGES.includes(c.usage ?? -1),
    )) ||
  KEYBOARD_COLLECTIONS.some((f) => matches(d, f));

export const requestFilters = (vendors: number[]): HIDDeviceFilter[] => [
  ...vendors.flatMap((vendorId) =>
    USAGES.map((usage) => ({ vendorId, usagePage: USAGE_PAGE, usage })),
  ),
  ...KEYBOARD_COLLECTIONS,
];
