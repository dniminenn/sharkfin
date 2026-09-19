// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

const AKKO_VENDOR_ID = 0x05ac;
const AKKO_PRODUCT_ID = 0x024f;
const KEYBOARD_USAGE_PAGE = 0x01;
const KEYBOARD_USAGE = 0x06;

export const AKKO_5075B_PLUS_S_MAC_FILTER: HIDDeviceFilter = {
  vendorId: AKKO_VENDOR_ID,
  productId: AKKO_PRODUCT_ID,
  usagePage: KEYBOARD_USAGE_PAGE,
  usage: KEYBOARD_USAGE,
};

export function isAkko5075bPlusSMacTlc(device: HIDDevice): boolean {
  return (
    device.vendorId === AKKO_VENDOR_ID &&
    device.productId === AKKO_PRODUCT_ID &&
    device.collections.some(
      (collection) =>
        collection.usagePage === KEYBOARD_USAGE_PAGE && collection.usage === KEYBOARD_USAGE,
    )
  );
}

export function webHidRequestFilters(vendors: number[]): HIDDeviceFilter[] {
  const vendorFilters = vendors.flatMap((vendorId) =>
    [0x0001, 0x0002].map((usage) => ({
      vendorId,
      usagePage: 0xffff,
      usage,
    })),
  );
  return [...vendorFilters, AKKO_5075B_PLUS_S_MAC_FILTER];
}
