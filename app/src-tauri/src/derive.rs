// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! A board the registry does not know, described from its own answers.
//!
//! The registry entry for a board decides two things the app cannot read
//! off the wire: its name, and which command family it speaks. Everything
//! else in an entry is transcribed from the same read sweep the Contribute
//! tab collects. The name comes from the USB product string. The family
//! comes from how the board answers the two keymap reads, which is how it
//! has been established for every hand-added board so far: yc500 returns
//! its keymap on `0x89` and a fixed all-0xFF table on `0x8A`; gen2 returns
//! options on `0x89`, echoing the opcode, and its keymap on `0x8A`. The
//! sleep registers sit at different bytes in the two families and serve as
//! a contradiction check. Anything that does not fit both ways stays
//! unknown, and an unknown board is read-only.
//!
//! All inputs are replies to reads that are harmless in both families
//! (see `BUNDLE_PROBES` in commands.rs); nothing here touches the board.
use crate::registry::{DeviceFeatures, DeviceSpec};

pub const REPORT_LEN: usize = 64;

/// Entries in a 64-byte keymap page that read as a plain key: type 0, a
/// keyboard usage in 4..=0xE7, nothing in the modifier or combo bytes.
fn plain_keys(page: &[u8]) -> usize {
    page.chunks_exact(4)
        .filter(|e| e[0] == 0 && e[1] == 0 && (4..=0xE7).contains(&e[2]) && e[3] == 0)
        .count()
}

/// A 64-byte page that is a keymap page and not an opcode-echoing reply.
/// Eight of sixteen slots is the bar: page 0 of every factory keymap seen
/// carries Esc, grave, Tab, CapsLock, both left modifiers and the first
/// columns of letters, and an options reply carries none.
fn keymap_page(page: &[u8]) -> bool {
    page.len() >= REPORT_LEN && plain_keys(&page[..REPORT_LEN]) >= 8
}

fn all_ff(page: &[u8]) -> bool {
    page.len() >= REPORT_LEN && page[..REPORT_LEN].iter().all(|&b| b == 0xFF)
}

/// Four little-endian seconds counts, plausible when every one is between
/// half a minute and ten hours.
fn sleep_at(reply: &[u8], at: usize) -> Option<[u16; 4]> {
    if reply.len() < at + 8 {
        return None;
    }
    let mut out = [0u16; 4];
    for (i, v) in out.iter_mut().enumerate() {
        *v = u16::from_le_bytes([reply[at + 2 * i], reply[at + 2 * i + 1]]);
        if !(30..=36000).contains(v) {
            return None;
        }
    }
    Some(out)
}

/// The command family a board speaks, from the replies to `0x89 [0,0]`,
/// `0x8A [0,0xFF,0,0]`, `0x91` and `0x92`. `None` when the answers do not
/// agree on one family.
pub fn detect_family(r89: &[u8], r8a: &[u8], r91: &[u8], r92: &[u8]) -> Option<&'static str> {
    let yc500 = keymap_page(r89) && all_ff(r8a);
    let gen2 = keymap_page(r8a) && !keymap_page(r89) && r89.first() == Some(&0x89);
    match (yc500, gen2) {
        // A sleep reply where the other family keeps it would mean the
        // keymap reads lied; refuse rather than pick.
        (true, false) if sleep_at(r91, 8).is_none() => Some("yc500"),
        (false, true) if sleep_at(r92, 1).is_none() => Some("gen2"),
        _ => None,
    }
}

/// Where a family keeps its sleep timers in the GET reply.
pub fn sleep_timers(family: &str, r91: &[u8], r92: &[u8]) -> Option<[u16; 4]> {
    match family {
        "yc500" => sleep_at(r92, 1),
        "gen2" => sleep_at(r91, 8),
        _ => None,
    }
}

/// Volume knob turns and press, as the vendor names them, when the base
/// keymap carries the consumer usages a knob ships with.
fn knob(keymap: &[u8]) -> Vec<String> {
    let has = |usage: u8| {
        keymap
            .chunks_exact(4)
            .any(|e| e[0] == 3 && e[1] == 0 && e[2] == usage && e[3] == 0)
    };
    if has(0xE9) && has(0xEA) {
        vec![
            "AudioVolumeDown".into(),
            "AudioVolumeMute".into(),
            "AudioVolumeUp".into(),
        ]
    } else {
        Vec::new()
    }
}

/// What a read sweep says about the board, gathered by the backend that
/// owns the transport.
pub struct Sweep<'a> {
    pub r89: &'a [u8],
    pub r8a: &'a [u8],
    pub r91: &'a [u8],
    pub r92: &'a [u8],
    /// The `0xAD` reply and the reply that preceded it: a board without a
    /// display echoes the previous reply instead of answering.
    pub oled: &'a [u8],
    pub before_oled: &'a [u8],
    /// The full base-layer keymap of the detected family, when read.
    pub keymap: &'a [u8],
}

/// A registry entry for a board that has none, marked `unregistered` so
/// the app can say so and ask before it writes. The picture is `Unknown`,
/// which makes the Keys page match one against the board and ask the owner
/// to confirm it, as it does for hand-added boards.
pub fn derive_spec(
    id: u32,
    vendor_id: u16,
    product_id: u16,
    product: &str,
    family: &'static str,
    sweep: &Sweep,
) -> DeviceSpec {
    let name = if product.trim().is_empty() {
        "Keyboard".to_string()
    } else {
        product.trim().to_string()
    };
    let sleep = sleep_timers(family, sweep.r91, sweep.r92).is_some();
    let screen = sweep.oled.first() == Some(&0xAD)
        && sweep.oled != sweep.before_oled
        && sweep
            .oled
            .get(1..3)
            .is_some_and(|v| v.iter().any(|&b| b != 0));
    DeviceSpec {
        id,
        name: format!("unregistered_{id}"),
        display_name: name,
        company: String::new(),
        vendor: String::new(),
        vendor_id,
        product_id,
        internal_name: format!("unregistered_{id}"),
        key_layout: "Unknown".into(),
        light_layout: String::new(),
        side_light_layout: String::new(),
        profiles: 1,
        magnetic: false,
        family: family.into(),
        screen: None,
        features: DeviceFeatures {
            knob: knob(sweep.keymap),
            debounce: false,
            sleep24: sleep,
            sleep_bt: sleep,
            magnetic_switches: false,
            screen,
            side_light: false,
        },
        confirmed: None,
        unregistered: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let mut v: Vec<u8> = s
            .split_whitespace()
            .map(|b| u8::from_str_radix(b, 16).unwrap())
            .collect();
        v.resize(REPORT_LEN, 0);
        v
    }

    // Issue #36, Fire Phoenix BK-11, yc500.
    const BK11_89: &str = "00 00 29 00 00 00 35 00 00 00 2b 00 00 00 39 00 00 00 e1 00 00 00 e0 00 00 00 3a 00 00 00 1e 00 00 00 14 00 00 00 04 00 00 00 64 00 0a 01 00 00 00 00 3b 00 00 00 1f 00 00 00 1a 00 00 00 16 00";
    const BK11_91: &str = "91 00 01 00 00 00 00 6e";
    const BK11_92: &str = "92 78 00 78 00 90 06 90 06 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00";
    // Issue #38, VGN Neon75 Extreme, gen2.
    const NEON_89: &str = "89 00 00 00 00 00 00 76";
    const NEON_8A: &str = "00 00 29 00 00 00 35 00 00 00 2b 00 00 00 39 00 00 00 e1 00 00 00 e0 00 00 00 3a 00 00 00 1e 00 00 00 14 00 00 00 04 00 00 00 00 00 00 00 e3 00 00 00 3b 00 00 00 1f 00 00 00 1a 00 00 00 16 00";
    const NEON_91: &str = "91 00 00 00 00 00 00 6e b4 00 b4 00 54 06 54 06";
    const NEON_92: &str = "92 00 00 00 00 00 00 6d";

    #[test]
    fn yc500_from_the_bk11_sweep() {
        let ff = vec![0xFF; REPORT_LEN];
        assert_eq!(
            detect_family(&hex(BK11_89), &ff, &hex(BK11_91), &hex(BK11_92)),
            Some("yc500")
        );
        assert_eq!(
            sleep_timers("yc500", &hex(BK11_91), &hex(BK11_92)),
            Some([120, 120, 1680, 1680])
        );
    }

    #[test]
    fn gen2_from_the_neon75_sweep() {
        assert_eq!(
            detect_family(&hex(NEON_89), &hex(NEON_8A), &hex(NEON_91), &hex(NEON_92)),
            Some("gen2")
        );
        assert_eq!(
            sleep_timers("gen2", &hex(NEON_91), &hex(NEON_92)),
            Some([180, 180, 1620, 1620])
        );
    }

    #[test]
    fn silence_and_garbage_are_unknown() {
        let zero = vec![0u8; REPORT_LEN];
        let ff = vec![0xFF; REPORT_LEN];
        assert_eq!(detect_family(&zero, &zero, &zero, &zero), None);
        assert_eq!(detect_family(&ff, &ff, &ff, &ff), None);
        // Both keymap reads answering with a keymap fits neither family.
        assert_eq!(
            detect_family(&hex(BK11_89), &hex(NEON_8A), &hex(BK11_91), &hex(BK11_92)),
            None
        );
    }

    #[test]
    fn a_sleep_reply_in_the_wrong_place_refuses() {
        // yc500-shaped keymap reads, but sleep timers where gen2 keeps them.
        let ff = vec![0xFF; REPORT_LEN];
        assert_eq!(
            detect_family(&hex(BK11_89), &ff, &hex(NEON_91), &hex(BK11_92)),
            None
        );
    }

    #[test]
    fn derived_spec_reads_features_off_the_sweep() {
        let ff = vec![0xFF; REPORT_LEN];
        let mut keymap = hex(BK11_89);
        keymap.extend_from_slice(&[3, 0, 0xE9, 0, 3, 0, 0xEA, 0]);
        let before = hex("97 00 00 00 00 00 00 68");
        let sweep = Sweep {
            r89: &hex(BK11_89),
            r8a: &ff,
            r91: &hex(BK11_91),
            r92: &hex(BK11_92),
            oled: &before,
            before_oled: &before,
            keymap: &keymap,
        };
        let spec = derive_spec(2570, 0x3151, 0x4015, " Gaming Keyboard ", "yc500", &sweep);
        assert!(spec.unregistered);
        assert_eq!(spec.display_name, "Gaming Keyboard");
        assert_eq!(spec.label(), "Gaming Keyboard");
        assert_eq!(spec.family, "yc500");
        assert_eq!(spec.key_layout, "Unknown");
        assert!(spec.writes_supported());
        assert!(spec.features.sleep24 && spec.features.sleep_bt);
        assert_eq!(spec.features.knob.len(), 3);
        assert!(!spec.features.screen, "an echoed 0xAD is no display");
        let oled = hex("ad 08 01 00 00 00 00 52");
        let sweep2 = Sweep {
            oled: &oled,
            ..sweep
        };
        assert!(
            derive_spec(957, 0x3151, 0x4015, "", "yc500", &sweep2)
                .features
                .screen
        );
        assert_eq!(
            derive_spec(957, 0x3151, 0x4015, "", "yc500", &sweep2).display_name,
            "Keyboard"
        );
    }
}
