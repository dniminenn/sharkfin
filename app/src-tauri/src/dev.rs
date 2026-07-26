// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Helpers for the hardware-test examples.
use crate::hid::{discover, DiscoveredDevice, HidError, Transport};
use crate::protocol::{cmd, Checksum, LedParam};
use crate::registry;

pub fn discover_all() -> Result<Vec<DiscoveredDevice>, HidError> {
    let api = hidapi::HidApi::new()?;
    Ok(discover(&api))
}

pub fn identify_and_read(path: &str) -> Result<String, HidError> {
    let api = hidapi::HidApi::new()?;
    let t = Transport::open(&api, path)?;
    let id = t.identify()?;
    let spec = registry::by_id(id);
    let mut out = format!(
        "device id: {id} -> {}\n",
        spec.map(|s| s.name)
            .unwrap_or_else(|| "UNKNOWN (not in registry)".into())
    );

    let profile = t.roundtrip(cmd::GET_PROFILE, &[], Checksum::Bit7)?;
    out.push_str(&format!("profile: {}\n", profile[1]));

    let led = t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)?;
    match LedParam::from_reply(&led) {
        Some(p) => out.push_str(&format!("ledparam: {p:?}\n")),
        None => out.push_str(&format!("ledparam raw: {:02x?}\n", &led[..12])),
    }
    Ok(out)
}
