// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Read-only protocol probe: figures out which command family a board speaks
//! by sending GET commands from both families and seeing which opcodes echo.
//! Usage: cargo run --example probe

use sharkfin_lib::hid::{discover, Transport};
use sharkfin_lib::protocol::{packet, Checksum};

fn probe(t: &Transport, label: &str, opcode: u8, payload: &[u8]) {
    let pkt = packet(opcode, payload, Checksum::Bit7);
    if let Err(e) = t.send(&pkt) {
        println!("{label} (0x{opcode:02X}): send error {e}");
        return;
    }
    std::thread::sleep(std::time::Duration::from_millis(30));
    match t.read() {
        Ok(reply) => {
            let echoed = reply[0] == opcode;
            println!(
                "{label} (0x{opcode:02X}): reply[0]=0x{:02X} {} data={:02x?}",
                reply[0],
                if echoed { "ECHO" } else { "    " },
                &reply[..16]
            );
        }
        Err(e) => println!("{label} (0x{opcode:02X}): read error {e}"),
    }
}

fn main() {
    let api = hidapi::HidApi::new().expect("hidapi");
    let devs = discover(&api);
    let Some(d) = devs.first() else {
        eprintln!("no device");
        std::process::exit(1);
    };
    println!(
        "probing {} {:04x}:{:04x}",
        d.product, d.vendor_id, d.product_id
    );
    let t = Transport::open(&api, &d.path).expect("open");

    let id = t.identify().expect("handshake");
    println!("handshake 0x8F -> device id {id}\n");

    // Family A (generic/5e635fe2): profile 0x84, ledparam 0x87, kboption 0x89
    // Family B (CommonKbYc500/438d24dc): profile 0x85, keymatrix-read 0x89
    probe(&t, "GET_PROFILE  A", 0x84, &[]);
    probe(&t, "GET_PROFILE  B", 0x85, &[]);
    probe(&t, "GET_LEDPARAM  ", 0x87, &[]);
    probe(&t, "GET_DEBOUNCE  ", 0x86, &[]);
    probe(&t, "GET_REPORTRATE", 0x83, &[]);
    probe(&t, "GET_SLEEPTIME ", 0x91, &[]);
    probe(&t, "GET_RF_VERSION", 0x80, &[]);
}
