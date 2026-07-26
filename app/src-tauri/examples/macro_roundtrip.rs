// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Macro slot write/read/restore regression check. Verified on an X86:
//! the write lands and read-back reflects it faithfully, so a mismatch
//! here means a real regression.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{
    cmd, macro_pages, macro_write_packet, Checksum, Macro, MacroEvent, MACRO_BYTES,
};
use std::thread::sleep;
use std::time::Duration;

const SLOT: u8 = 49; // last slot, least likely to hold anything

fn read_blob(t: &Transport, slot: u8) -> [u8; MACRO_BYTES] {
    let mut blob = [0u8; MACRO_BYTES];
    for page in 0..4u8 {
        let reply = t
            .read_raw_page(cmd::GET_MACRO, &[slot, page], Checksum::Bit7)
            .expect("read macro page");
        blob[page as usize * 64..(page as usize + 1) * 64].copy_from_slice(&reply);
    }
    blob
}

fn write_blob(t: &Transport, slot: u8, blob: &[u8; MACRO_BYTES]) {
    let pages = macro_pages(blob);
    for page in 0..pages {
        t.send(&macro_write_packet(
            cmd::SET_MACRO,
            slot,
            page,
            page + 1 == pages,
            blob,
        ))
        .expect("write macro page");
    }
    sleep(Duration::from_millis(600));
}

fn main() {
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device");
    let t = Transport::open(&api, &d.path).expect("open");
    t.identify().expect("handshake");

    let before = read_blob(&t, SLOT);
    println!("before: {:02x?}…", &before[..16]);

    // types "hi", 20 ms between edges
    let key = |usage, pressed| MacroEvent::Key {
        usage,
        pressed,
        delay_ms: 20,
    };
    let probe = Macro {
        repeat: 1,
        events: vec![
            key(0x0B, true),
            key(0x0B, false),
            key(0x0C, true),
            key(0x0C, false),
        ],
    };
    let blob = probe.to_blob().expect("encode");
    write_blob(&t, SLOT, &blob);

    let after = read_blob(&t, SLOT);
    println!("after:  {:02x?}…", &after[..16]);
    let matched = after == blob;

    // uploads look flash-backed; give the firmware the measured breather
    sleep(Duration::from_secs(3));
    write_blob(&t, SLOT, &before);
    let restored = read_blob(&t, SLOT);
    println!("restored matches original: {}", restored == before);

    if matched {
        println!("macro write path: OK (read-back matches)");
    } else {
        println!("read-back does NOT match the write.");
        println!("decoded read-back: {:?}", Macro::from_blob(&after));
        println!("Before concluding the write failed, bind slot {SLOT} to a key and press it.");
        std::process::exit(1);
    }
}
