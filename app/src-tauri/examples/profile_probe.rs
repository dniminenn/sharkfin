// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Profile switching under the flash-write discipline: switch, a full
//! second of silence, confirm with GET_PROFILE, then read the keymap.
//! A profile switch survives a power cycle, so it lands in flash, and an
//! X86 has wedged its control endpoint on a keymap read sent 120 ms after
//! a switch. This cycles through every profile that way and ends where it
//! started. yc500 opcodes; run with a keyboard on USB.

use sharkfin_lib::hid::{discover, HidError, Transport};
use sharkfin_lib::protocol::{cmd, packet, Checksum};
use std::thread::sleep;
use std::time::{Duration, Instant};

const QUIET: Duration = Duration::from_millis(1000);

fn get_profile(t: &Transport) -> Result<u8, HidError> {
    Ok(t.roundtrip(cmd::GET_PROFILE, &[], Checksum::Bit7)?[1])
}

fn read_keymap(t: &Transport, profile: u8) -> Result<Vec<u8>, HidError> {
    let mut m = Vec::with_capacity(512);
    for page in 0..8u8 {
        m.extend_from_slice(&t.read_raw_page(
            cmd::GET_KEYMATRIX,
            &[profile, page],
            Checksum::Bit7,
        )?);
    }
    Ok(m)
}

fn fingerprint(m: &[u8]) -> String {
    let slots = m.chunks(4).filter(|c| c.iter().any(|&b| b != 0)).count();
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in m {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{slots} slots, hash {h:016x}")
}

fn switch(t: &Transport, target: u8) -> Result<(), String> {
    t.send(&packet(cmd::SET_PROFILE, &[target], Checksum::Bit7))
        .map_err(|e| format!("SET_PROFILE: {e}"))?;
    sleep(QUIET);
    let got = get_profile(t).map_err(|e| format!("GET_PROFILE after quiet: {e}"))?;
    if got != target {
        return Err(format!("board reports profile {got}, wanted {target}"));
    }
    Ok(())
}

fn main() {
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device");
    let t = Transport::open(&api, &d.path).expect("open");
    let id = t.identify().expect("handshake");
    let home = get_profile(&t).expect("GET_PROFILE");
    println!("device id {id}, on profile {home}");

    let mut failed = false;
    for step in 1..=3u8 {
        let target = (home + step) % 3;
        print!("switch to {target}: ");
        let start = Instant::now();
        match switch(&t, target) {
            Ok(()) => print!("ok in {}ms", start.elapsed().as_millis()),
            Err(e) => {
                println!("FAILED: {e}");
                failed = true;
                break;
            }
        }
        match read_keymap(&t, target) {
            Ok(m) => println!(", keymap {}", fingerprint(&m)),
            Err(e) => {
                println!(", keymap read FAILED: {e}");
                failed = true;
                break;
            }
        }
        sleep(Duration::from_millis(100));
    }
    if failed {
        println!("board state unknown; replug before trusting it");
        std::process::exit(1);
    }
    println!("back on profile {home}, all switches survived");
}
