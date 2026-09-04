// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Upload a rainbow across all 128 slots with the app's flash pacing and
//! switch to the pattern mode, so the paint path can be checked by eye. The
//! pattern is not read back (GET_USERPIC is stale) and overwrites what the
//! board holds. yc500 packet shape; `--restore` puts the lighting mode back
//! to what this tool found.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, userpic_write_packet, Checksum, LedParam, PER_KEY_BYTES};
use std::thread::sleep;
use std::time::Duration;

fn hue(i: usize) -> (u8, u8, u8) {
    let h = (i * 360 / 128) as u16;
    let x = ((h % 60) as u32 * 255 / 60) as u8;
    match h / 60 {
        0 => (255, x, 0),
        1 => (255 - x, 255, 0),
        2 => (0, 255, x),
        3 => (0, 255 - x, 255),
        4 => (x, 0, 255),
        _ => (255, 0, 255 - x),
    }
}

fn read_led(t: &Transport) -> LedParam {
    let reply = t
        .roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .expect("GET_LEDPARAM");
    LedParam::from_reply(&reply).expect("parse LEDPARAM")
}

fn main() {
    let restore: Option<u8> = std::env::args()
        .skip_while(|a| a != "--restore")
        .nth(1)
        .map(|m| m.parse().expect("--restore <mode>"));
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device");
    let t = Transport::open(&api, &d.path).expect("open");
    t.identify().expect("handshake");
    println!("link: {:?}", t.link());

    let before = read_led(&t);
    println!("lighting before: {before:?}");

    if let Some(mode) = restore {
        t.send(&LedParam { mode, ..before }.to_packet())
            .expect("restore");
        sleep(Duration::from_millis(300));
        println!("restored: {:?}", read_led(&t));
        return;
    }

    let mut colors = vec![0u8; PER_KEY_BYTES];
    for i in 0..128 {
        let (r, g, b) = hue(i);
        colors[i * 3..i * 3 + 3].copy_from_slice(&[r, g, b]);
    }
    for page in 0..7u8 {
        t.send(&userpic_write_packet(page, &colors)).expect("page");
        sleep(Duration::from_millis(100));
    }
    sleep(Duration::from_secs(2));
    t.send(
        &LedParam {
            mode: 13,
            speed: 2,
            brightness: 4,
            option: 0,
            dazzle: false,
            r: 0,
            g: 200,
            b: 200,
        }
        .to_packet(),
    )
    .expect("mode 13");
    sleep(Duration::from_millis(500));
    println!("lighting after: {:?}", read_led(&t));
    println!(
        "previous mode was {}; put it back with --restore {}",
        before.mode, before.mode
    );
}
