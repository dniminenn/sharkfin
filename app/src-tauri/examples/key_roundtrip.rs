// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Rewrite one slot on the active profile to a different key, verify,
//! restore. Leaves the board as found. The active profile because the
//! profile byte of a single-slot write is not honoured: over the receiver a
//! write aimed at another profile lands nowhere.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, packet, Checksum};
use std::thread::sleep;
use std::time::Duration;

const SLOT: u8 = 85; // Home on a stock X86
const HOME: [u8; 4] = [0, 0, 74, 0];
const END: [u8; 4] = [0, 0, 77, 0];

fn read_slot(t: &Transport, profile: u8, slot: u8) -> [u8; 4] {
    let page = (slot as usize * 4) / 64;
    let off = (slot as usize * 4) % 64;
    let reply = t
        .read_raw_page(cmd::GET_KEYMATRIX, &[profile, page as u8], Checksum::Bit7)
        .expect("read page");
    [reply[off], reply[off + 1], reply[off + 2], reply[off + 3]]
}

fn write_slot(t: &Transport, profile: u8, slot: u8, value: [u8; 4]) {
    let mut pkt = packet(cmd::SET_KEY_ONE, &[profile, slot], Checksum::Bit7);
    pkt[8..12].copy_from_slice(&value);
    t.send(&pkt).expect("write slot");
    sleep(Duration::from_millis(100));
}

fn main() {
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device");
    let t = Transport::open(&api, &d.path).expect("open");
    t.identify().expect("handshake");

    let profile = t
        .roundtrip(cmd::GET_PROFILE, &[], Checksum::Bit7)
        .expect("GET_PROFILE")[1];
    let before = read_slot(&t, profile, SLOT);
    println!("profile {profile}, before: {before:02x?}");
    let probe = if before == END { HOME } else { END };

    write_slot(&t, profile, SLOT, probe);
    let changed = read_slot(&t, profile, SLOT);
    println!("after write: {changed:02x?}");

    write_slot(&t, profile, SLOT, before);
    let restored = read_slot(&t, profile, SLOT);
    println!("restored: {restored:02x?}");

    assert_eq!(changed, probe);
    assert_eq!(restored, before);
    println!("keymap write path: OK");
}
