// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
pub const SET_RESET: u8 = 0x02; // firmware needs ~4 s after
pub const SET_PROFILE: u8 = 0x05;
pub const SET_KBOPTION: u8 = 0x06; // [op, 0, flags, fnMatrix, powerSave]
pub const SET_LEDPARAM: u8 = 0x07;
pub const SET_SLEDPARAM: u8 = 0x08;
pub const SET_KEYMATRIX: u8 = 0x09; // 9 × 56-byte pages
pub const SET_MACRO_PAGED: u8 = 0x0B;
pub const SET_USERPIC: u8 = 0x0C; // 7 × 56-byte pages
pub const SET_FN: u8 = 0x10;
pub const SET_DEBOUNCE: u8 = 0x11; // [op, 0, value]
pub const SET_SLEEPTIME: u8 = 0x12; // u16 LE ×4 at bytes 8..16
pub const SET_KEY_ONE: u8 = 0x13; // [profile, slot], value at 8..12
pub const SET_FN_ONE: u8 = 0x15;
pub const SET_MACRO: u8 = 0x16; // NB: 0x0B is the base class value
pub const SET_AUTO_OS: u8 = 0x17; // [op, 0|1]
pub const SET_OLED_CLOCK: u8 = 0x28; // display clock, both families

pub const GET_PROFILE: u8 = 0x85; // reply[1]
pub const GET_KBOPTION: u8 = 0x86; // flags in reply[2..5]
pub const GET_LEDPARAM: u8 = 0x87;
pub const GET_SLEDPARAM: u8 = 0x88;
pub const GET_KEYMATRIX: u8 = 0x89; // [profile, page 0..8) -> raw 64 B
pub const GET_MACRO: u8 = 0x8B; // [slot, page 0..4) -> raw 64 B
pub const GET_USERPIC: u8 = 0x8C;
pub const GET_USB_VERSION: u8 = 0x8F; // identify handshake, all families
pub const GET_FN: u8 = 0x90;
pub const GET_DEBOUNCE: u8 = 0x91; // reply[2]
pub const GET_SLEEPTIME: u8 = 0x92; // u16 LE ×4 at bytes 1..9, NOT 8..16
pub const GET_AUTO_OS: u8 = 0x97; // reply[1] == 1
pub const GET_REVISION: u8 = 0x80; // (reply[2] << 8) | reply[1]

/// Screen firmware version. Same opcode in both families. A board that
/// answers has a display; an echo means none.
pub const GET_OLED_VERSION: u8 = 0xAD;

/// Second-chip version the vendor's gen2 driver reads on every connect,
/// `(reply[2] << 8) | reply[1]`, zero for none. Read in the sweep only.
pub const GET_MLED_VERSION: u8 = 0xAE;

/// Flash-chip erase, about 55 s. A write sitting in the read range.
/// yc500 maps it to the same flag as 0x2C. Never send while sweeping,
/// never on an unknown family.
pub const GEN2_FLASH_CHIP_ERASE: u8 = 0xAC;
