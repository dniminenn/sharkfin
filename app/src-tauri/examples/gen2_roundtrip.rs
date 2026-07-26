// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Verification tool for the gen2 protocol family (477 of the 523 registry
//! boards). Refuses to run on anything else. Read-only by default; pass
//! `--write` to exercise the paths sharkfin actually uses -- keymap, profile
//! and debounce -- each restored afterwards. Paste the output into an issue.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{gen2, Checksum, GEN2_CMDS};
use sharkfin_lib::registry;
use std::thread::sleep;
use std::time::Duration;

/// A key almost nothing is bound to, so a failed restore is harmless.
const PROBE_USAGE: u8 = 0x68; // F13

fn get(t: &Transport, label: &str, opcode: u8, payload: &[u8]) -> Option<[u8; 64]> {
    match t.roundtrip(opcode, payload, Checksum::Bit7) {
        Ok(reply) => {
            println!("  {label} (0x{opcode:02X}): {:02x?}", &reply[..12]);
            Some(reply)
        }
        Err(e) => {
            println!("  {label} (0x{opcode:02X}): NO ECHO ({e})");
            None
        }
    }
}

fn verdict(ok: bool) -> &'static str {
    if ok {
        "OK"
    } else {
        "MISMATCH, stop here and report"
    }
}

/// Bulk-read the 512-byte matrix for `profile`, host-OS layer 0.
fn read_matrix(t: &Transport, profile: u8) -> Option<Vec<u8>> {
    let mut m = Vec::with_capacity(512);
    for page in 0..8u8 {
        let p = gen2::keymatrix_read_payload(profile, page);
        m.extend_from_slice(
            &t.read_raw_page(GEN2_CMDS.get_keymatrix, &p, Checksum::Bit7)
                .ok()?,
        );
    }
    Some(m)
}

fn slot_of(m: &[u8], slot: usize) -> [u8; 4] {
    m[slot * 4..slot * 4 + 4].try_into().unwrap()
}

fn main() {
    let write = std::env::args().any(|a| a == "--write");

    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no device on USB");
    let t = Transport::open(&api, &d.path).expect("open");
    let id = t.identify().expect("identify handshake");

    let spec = registry::by_id(id).unwrap_or_else(|| {
        eprintln!("device id {id} is not in the registry; nothing known about its family");
        std::process::exit(1);
    });
    println!("board: {} (id {id}, family {})", spec.label(), spec.family);
    if spec.family != "gen2" {
        eprintln!(
            "this tool is for the gen2 family only; {} is {}. Aborting before any traffic",
            spec.label(),
            spec.family
        );
        std::process::exit(1);
    }

    println!("\n== read sweep (harmless) ==");
    let profile = get(&t, "profile ", GEN2_CMDS.get_profile, &[]).map(|r| r[1]);
    // gen2 answers debounce at reply byte 1, not 2 (firmware 2268_v309)
    let debounce = get(&t, "debounce", GEN2_CMDS.get_debounce, &[]).map(|r| r[1]);
    get(&t, "sleep   ", GEN2_CMDS.get_sleeptime, &[]);
    get(&t, "options ", GEN2_CMDS.get_kboption, &[0]);
    if let Some((_, rr)) = GEN2_CMDS.report_rate {
        get(&t, "rate    ", rr, &[]);
    }
    let matrix = read_matrix(&t, profile.unwrap_or(0));
    match &matrix {
        Some(m) => println!(
            "  keymap p0 (0x{:02X}): {:02x?}",
            GEN2_CMDS.get_keymatrix,
            &m[..16]
        ),
        None => println!("  keymap: read failed"),
    }

    if !write {
        println!("\nRead sweep done. Re-run with --write to test the write paths.");
        return;
    }

    println!("\n== write phase (every value is restored) ==");
    let mut all_ok = true;

    // Keymap: the path sharkfin uses most, and the one worth confirming.
    let profile0 = profile.unwrap_or(0);
    match matrix {
        None => {
            println!("  keymap write: SKIPPED (matrix unreadable)");
            all_ok = false;
        }
        Some(before) => {
            // a slot holding a plain key, so the probe is a like-for-like swap
            let target = (0..128).find(|&s| {
                let v = slot_of(&before, s);
                v[0] == 0 && v[1] == 0 && v[2] != 0 && v[2] != PROBE_USAGE && v[3] == 0
            });
            match target {
                None => {
                    println!("  keymap write: SKIPPED (no plain-key slot found)");
                    all_ok = false;
                }
                Some(slot) => {
                    let orig = slot_of(&before, slot);
                    println!("  slot {slot} currently {orig:02x?}, probing with F13");
                    let probe = [0u8, 0, PROBE_USAGE, 0];
                    t.send(&gen2::set_key_packet(profile0, slot as u8, probe))
                        .expect("keymap write");
                    sleep(Duration::from_millis(200));

                    let after = read_matrix(&t, profile0).map(|m| slot_of(&m, slot));
                    t.send(&gen2::set_key_packet(profile0, slot as u8, orig))
                        .expect("keymap restore");
                    sleep(Duration::from_millis(200));
                    let restored = read_matrix(&t, profile0).map(|m| slot_of(&m, slot));

                    println!("  after write: {after:02x?}   restored: {restored:02x?}");
                    let ok = after == Some(probe) && restored == Some(orig);
                    all_ok &= ok;
                    println!("  keymap write: {}", verdict(ok));
                    if restored != Some(orig) {
                        println!(
                            "  !! slot {slot} was NOT restored. Fix it in the Keys tab, or \
                             factory reset."
                        );
                    }
                }
            }
        }
    }

    if let Some(p) = profile {
        let other = if p == 0 { 1 } else { 0 };
        let set = |v: u8| {
            let pkt = sharkfin_lib::protocol::packet(GEN2_CMDS.set_profile, &[v], Checksum::Bit7);
            t.send(&pkt).expect("profile write");
            sleep(Duration::from_millis(150));
        };
        set(other);
        let changed = get(&t, "profile after write", GEN2_CMDS.get_profile, &[]).map(|r| r[1]);
        set(p);
        let restored = get(&t, "profile restored   ", GEN2_CMDS.get_profile, &[]).map(|r| r[1]);
        let ok = changed == Some(other) && restored == Some(p);
        all_ok &= ok;
        println!("  profile write: {}", verdict(ok));
    }

    if let Some(deb) = debounce {
        let probe = if deb == 5 { 6 } else { 5 };
        // gen2 takes the value at wire byte 1, with no padding byte
        let setd = |v: u8| {
            let pkt = sharkfin_lib::protocol::packet(GEN2_CMDS.set_debounce, &[v], Checksum::Bit7);
            t.send(&pkt).expect("debounce write");
            sleep(Duration::from_millis(150));
        };
        setd(probe);
        let changed = get(&t, "debounce after write", GEN2_CMDS.get_debounce, &[]).map(|r| r[1]);
        setd(deb);
        let restored = get(&t, "debounce restored   ", GEN2_CMDS.get_debounce, &[]).map(|r| r[1]);
        let ok = changed == Some(probe) && restored == Some(deb);
        all_ok &= ok;
        println!("  debounce write: {}", verdict(ok));
    }

    println!(
        "\n{}",
        if all_ok {
            "All write paths OK. Paste this output into an issue to promote the family."
        } else {
            "Something did not match. Paste this output into an issue and do not ignore it."
        }
    );
}
