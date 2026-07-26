// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Hardware round-trip: read LEDPARAM, write a distinct state, read back,
//! compare, restore the original. Leaves the keyboard as it was found.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, Checksum, LedParam};
use std::thread::sleep;
use std::time::Duration;

fn read_led(t: &Transport) -> LedParam {
    let reply = t
        .roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .expect("GET_LEDPARAM");
    LedParam::from_reply(&reply).expect("parse LEDPARAM")
}

fn main() {
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device");
    let t = Transport::open(&api, &d.path).expect("open");
    t.identify().expect("handshake");

    let original = read_led(&t);
    println!("original: {original:?}");

    let test = LedParam {
        mode: 2, // Breathing
        speed: 3,
        brightness: 4,
        option: 0,
        dazzle: false,
        r: 0xFF,
        g: 0x00,
        b: 0x00,
    };
    t.send(&test.to_packet()).expect("SET_LEDPARAM");
    sleep(Duration::from_millis(300));

    let back = read_led(&t);
    println!("wrote:    {test:?}");
    println!("readback: {back:?}");

    let ok = back.mode == test.mode
        && back.speed == test.speed
        && back.brightness == test.brightness
        && back.dazzle == test.dazzle
        && (back.r, back.g, back.b) == (test.r, test.g, test.b);
    println!("match: {ok}");

    sleep(Duration::from_millis(1200));
    t.send(&original.to_packet()).expect("restore");
    sleep(Duration::from_millis(200));
    println!("restored: {:?}", read_led(&t));
    if !ok {
        std::process::exit(1);
    }
}
