// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Does the firmware accept a LEDPARAM wire speed above the documented 5?
//!
//! **Answered on an Attack Shark X86 (device 1967, yc500): it accepts them and
//! renders them wrong.** Wire 5, 6, 7, 8, 12 and 16 all read back verbatim, so
//! nothing clamps at the protocol layer. But held on screen, wire 13 and 16
//! render far *faster* than the app's fastest, not slower. Speed inverts on
//! the wire, so this is what an index running off the end of a small speed
//! table looks like: the values are garbage, not extra range.
//!
//! So there is no slower-than-minimum setting to unlock, and the faster end
//! must not be exposed either, being an out-of-bounds read whose result may
//! differ per board and per firmware. The clamp in `LedParam::to_packet`
//! stays.
//!
//! `SET_LEDPARAM` also turns out to be subject to the control-endpoint rate
//! limit: ~14 reports in 7 seconds stalled it. Recover with `USBDEVFS_RESET`
//! on the usbfs node opened `O_RDWR` (write-only returns `ENOTTY` and does
//! nothing). Because a run can cost you that, this refuses to start unless
//! `SHARKFIN_STALL_PROBE=i-accept-a-replug` is set.
//!
//! `hold <wire> [r g b]` writes one state and leaves it up, which is how the
//! render behaviour above was judged. Storing a value and rendering it are
//! different claims and the readback only proves the first.

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{cmd, packet, Checksum, REPORT_LEN};
use sharkfin_lib::registry;
use std::thread::sleep;
use std::time::Duration;

type Reply = [u8; REPORT_LEN];

/// Wire values to try. Ascending and stopping short of extremes: if the byte
/// is an index rather than a divisor, a small overshoot is the cheapest way to
/// find out.
const CANDIDATES: [u8; 6] = [5, 6, 7, 8, 12, 16];

/// Snowfall. A rain-style effect, so a speed change is visible.
const MODE_SNOWFALL: u8 = 17;

fn get_ledparam(t: &Transport) -> Result<Reply, String> {
    t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .map_err(|e| format!("GET_LEDPARAM failed: {e}"))
}

fn show(label: &str, reply: &[u8]) {
    println!(
        "  {label:<26} mode={:<3} speed={:<3} bright={:<3} flags=0x{:02x} rgb={:02x}{:02x}{:02x}",
        reply[1], reply[2], reply[3], reply[4], reply[5], reply[6], reply[7]
    );
}

fn main() {
    if std::env::var("SHARKFIN_STALL_PROBE").as_deref() != Ok("i-accept-a-replug") {
        eprintln!(
            "This probe stalls the keyboard: wire speed 6 wedges the control \n\
             endpoint and the board needs a cable replug afterwards. The answer \n\
             is already recorded in this file's header. To run it anyway, set \n\
             SHARKFIN_STALL_PROBE=i-accept-a-replug"
        );
        std::process::exit(1);
    }
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let d = devs.first().expect("no ROYUAN device found");
    let t = Transport::open(&api, &d.path).expect("open");

    // Opcodes collide across families: yc500 SET_LEDPARAM is safe, but this
    // probe deliberately sends out-of-range values and must never do that to a
    // board whose command set we have not established.
    let id = t.identify().expect("identify handshake");
    let spec = registry::by_id(id).unwrap_or_else(|| panic!("device {id} not in registry"));
    println!("device {id}: {} (family {})", spec.label(), spec.family);
    if spec.family != "yc500" {
        eprintln!(
            "refusing: this probe is only evidenced for yc500, got {}",
            spec.family
        );
        std::process::exit(2);
    }

    let original = get_ledparam(&t).expect("read original");
    show("original", &original);

    // `hold <wire> [r g b]` writes one state and leaves it up so a human can
    // judge whether a given wire speed actually renders slower. Storing a
    // value and rendering it are different claims.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("hold") {
        let n = |i: usize, d: u8| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
        let wire = n(1, 16);
        let (r, g, b) = (n(2, 0x30), n(3, 0x30), n(4, 0x40));
        // Fixed colour rather than the rainbow flag: that is the "muted" half.
        let pkt = packet(
            cmd::SET_LEDPARAM,
            &[MODE_SNOWFALL, wire, original[3], 0x07, r, g, b],
            Checksum::Bit8,
        );
        t.send(&pkt).expect("hold write");
        sleep(Duration::from_millis(600));
        match get_ledparam(&t) {
            Ok(back) => show(&format!("held wire={wire}"), &back),
            Err(e) => eprintln!("readback failed: {e}"),
        }
        println!("\nleft on screen deliberately. restore with:");
        println!(
            "  cargo run --example restore_light -- {} {} {} {} {} {} {}",
            original[1],
            original[5],
            original[6],
            original[7],
            original[3],
            5u8.saturating_sub(original[2]).min(4),
            u8::from(original[4] & 0x0F == 8),
        );
        return;
    }
    let (obright, oflags) = (original[3], original[4]);
    let (or, og, ob) = (original[5], original[6], original[7]);

    let restore = packet(
        cmd::SET_LEDPARAM,
        &[original[1], original[2], obright, oflags, or, og, ob],
        Checksum::Bit8,
    );

    println!("\nstepping wire speed on mode {MODE_SNOWFALL} (Snowfall):");
    let mut last = original;
    let mut results: Vec<(u8, u8, bool)> = Vec::new();

    for &wire in CANDIDATES.iter() {
        let pkt = packet(
            cmd::SET_LEDPARAM,
            &[MODE_SNOWFALL, wire, obright, oflags, or, og, ob],
            Checksum::Bit8,
        );
        // Never swallow a send error: a silent failure here is how a stall
        // gets mistaken for a clean run.
        if let Err(e) = t.send(&pkt) {
            eprintln!("  send failed at wire={wire}: {e}");
            break;
        }
        sleep(Duration::from_millis(600));

        let back = match get_ledparam(&t) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("  readback failed at wire={wire}: {e}");
                break;
            }
        };
        // An unsupported command returns the previous reply unchanged, so
        // compare against the last response rather than against zero.
        let stale = back[..8] == last[..8];
        show(&format!("wire={wire} ->"), &back);
        results.push((wire, back[2], stale));
        if stale {
            eprintln!("  reply identical to previous: command may have been rejected");
        }
        last = back;
        sleep(Duration::from_millis(400));
    }

    println!("\nrestoring original");
    t.send(&restore).expect("restore LEDPARAM");
    sleep(Duration::from_millis(400));
    match get_ledparam(&t) {
        Ok(fin) => {
            show("restored", &fin);
            if fin[..8] != original[..8] {
                eprintln!("WARNING: restored state differs from original");
            }
        }
        Err(e) => eprintln!("WARNING: could not confirm restore: {e}"),
    }

    println!("\nsummary (wire sent -> wire read back):");
    for (sent, got, stale) in &results {
        let verdict = if *stale {
            "no change in reply"
        } else if got == sent {
            "accepted verbatim"
        } else {
            "modified by firmware"
        };
        println!("  {sent:>3} -> {got:>3}   {verdict}");
    }
    let clamps = results.iter().any(|(s, g, _)| s != g);
    println!(
        "\nverdict: firmware {} out-of-range speed",
        if clamps {
            "modifies"
        } else {
            "stores verbatim"
        }
    );
}
