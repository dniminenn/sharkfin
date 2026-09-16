// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Helpers for the hardware-test examples.
use crate::hid::{discover, DiscoveredDevice, HidError, Link, Stack, Transport};
use crate::protocol::{cmd, Checksum, LedParam};
use crate::registry;

pub fn discover_all() -> Result<Vec<DiscoveredDevice>, HidError> {
    let api = hidapi::HidApi::new().map_err(|e| HidError::Transport(e.to_string()))?;
    Ok(discover(&api))
}

pub fn identify_and_read(path: &str) -> Result<String, HidError> {
    let api = hidapi::HidApi::new().map_err(|e| HidError::Transport(e.to_string()))?;
    // Discovery lists driveall boards too, and the ROYUAN opcodes below are
    // writes on that collection.
    if let Some(d) = discover(&api).into_iter().find(|d| d.path == path) {
        if crate::protocol::driveall::is_collection(d.usage_page, d.usage) {
            let t = Transport::open_stack(&api, path, Stack::Driveall)?;
            let i = t.identify_driveall()?;
            return Ok(format!(
                "driveall: vid {:04x} pid {:04x} version {:04x} rtPrecision {}\n",
                i.vid, i.pid, i.version, i.rt_precision
            ));
        }
    }
    let t = Transport::open(&api, path)?;
    let id = t.identify()?;
    let spec = registry::by_id(id);
    let mut out = format!(
        "device id: {id} -> {}\n",
        spec.map(|s| s.name)
            .unwrap_or_else(|| "UNKNOWN (not in registry)".into())
    );
    match t.link() {
        Link::Usb => out.push_str("link: cable\n"),
        Link::Receiver => {
            let battery = t
                .receiver_status()?
                .map(|s| format!("{}%", s.keyboard_battery))
                .unwrap_or_else(|| "?".into());
            out.push_str(&format!("link: 2.4 GHz receiver, battery {battery}\n"));
        }
    }

    let profile = t.roundtrip(cmd::GET_PROFILE, &[], Checksum::Bit7)?;
    out.push_str(&format!("profile: {}\n", profile[1]));

    let led = t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)?;
    match LedParam::from_reply(&led) {
        Some(p) => out.push_str(&format!("ledparam: {p:?}\n")),
        None => out.push_str(&format!("ledparam raw: {:02x?}\n", &led[..12])),
    }
    Ok(out)
}
