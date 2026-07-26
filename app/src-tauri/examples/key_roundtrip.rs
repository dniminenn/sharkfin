// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Remap Home -> End on profile 0, verify, restore. Leaves the board as found.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, packet, Checksum};
use std::thread::sleep;
use std::time::Duration;

const SLOT: u8 = 85; // Home
const HOME: [u8; 4] = [0, 0, 74, 0];
const END: [u8; 4] = [0, 0, 77, 0];

fn read_slot(t: &Transport, slot: u8) -> [u8; 4] {
    let page = (slot as usize * 4) / 64;
    let off = (slot as usize * 4) % 64;
    let reply = t
        .read_raw_page(cmd::GET_KEYMATRIX, &[0, page as u8], Checksum::Bit7)
        .expect("read page");
    [reply[off], reply[off + 1], reply[off + 2], reply[off + 3]]
}

fn write_slot(t: &Transport, slot: u8, value: [u8; 4]) {
    let mut pkt = packet(cmd::SET_KEY_ONE, &[0, slot], Checksum::Bit7);
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

    let before = read_slot(&t, SLOT);
    println!("before: {before:02x?}");
    assert_eq!(before, HOME, "expected Home at slot {SLOT}");

    write_slot(&t, SLOT, END);
    let changed = read_slot(&t, SLOT);
    println!("after write End: {changed:02x?}");

    write_slot(&t, SLOT, HOME);
    let restored = read_slot(&t, SLOT);
    println!("restored: {restored:02x?}");

    assert_eq!(changed, END);
    assert_eq!(restored, HOME);
    println!("keymap write path: OK");
}
