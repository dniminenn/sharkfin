// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Put the backlight back to a known-good static setting.
//! Usage: cargo run --example restore_light [mode] [r] [g] [b] [brightness] [speed] [rainbow]
//! `rainbow` is 0 or 1; with 1 the mode cycles colour and r/g/b are ignored.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, Checksum, LedParam};
use std::thread::sleep;
use std::time::Duration;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize, d: u8| a.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let want = LedParam {
        mode: num(0, 1),
        speed: num(5, 3),
        brightness: num(4, 1),
        option: 0,
        dazzle: num(6, 0) != 0,
        r: num(1, 0),
        g: num(2, 255),
        b: num(3, 255),
    };

    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device on USB");
    let t = Transport::open(&api, &d.path).expect("open");

    for attempt in 1..=6 {
        sleep(Duration::from_millis(400));
        match t.send(&want.to_packet()) {
            Ok(()) => {
                sleep(Duration::from_millis(500));
                match t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7) {
                    Ok(r) => {
                        println!("attempt {attempt}: now {:?}", LedParam::from_reply(&r));
                        return;
                    }
                    Err(e) => println!("attempt {attempt}: wrote, verify failed ({e})"),
                }
            }
            Err(e) => println!("attempt {attempt}: send failed ({e})"),
        }
    }
    eprintln!("could not confirm; unplug and replug the cable, then rerun");
    std::process::exit(1);
}
