// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Hardware smoke test: discover, identify, read LED state and profile.
//! Run with a keyboard on USB: `cargo run --example smoke`

use sharkfin_lib::dev::{discover_all, identify_and_read};

fn main() {
    let found = discover_all().expect("hidapi init");
    if found.is_empty() {
        eprintln!("no ROYUAN vendor interfaces found. Cable connected?");
        std::process::exit(1);
    }
    for d in &found {
        println!(
            "found: {} {:04x}:{:04x} @ {}",
            d.product, d.vendor_id, d.product_id, d.path
        );
    }
    match identify_and_read(&found[0].path) {
        Ok(report) => println!("{report}"),
        Err(e) => {
            eprintln!("smoke failed: {e}");
            std::process::exit(1);
        }
    }
}
