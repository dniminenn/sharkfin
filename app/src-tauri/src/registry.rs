// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Handshake device ID -> board spec, shipped as data.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFeatures {
    #[serde(default)]
    pub knob: Vec<String>,
    #[serde(default)]
    pub debounce: bool,
    #[serde(default)]
    pub sleep24: bool,
    #[serde(default, rename = "sleepBT")]
    pub sleep_bt: bool,
    #[serde(default)]
    pub magnetic_switches: bool,
    #[serde(default)]
    pub screen: bool,
    /// Physical edge light. The firmware answers `0x88` regardless, so this
    /// registry flag is the only reliable signal.
    #[serde(default)]
    pub side_light: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSpec {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub company: String,
    pub vendor: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub internal_name: String,
    pub key_layout: String,
    pub light_layout: String,
    #[serde(default)]
    pub side_light_layout: String,
    pub profiles: u8,
    #[serde(default)]
    pub magnetic: bool,
    #[serde(default = "family_unknown")]
    pub family: String,
    /// The display's size and pixel format, absent on a board without one.
    /// Geometry is per board: 128x128, 160x80, 240x135 and 320x172 all
    /// ship, so nothing may assume a default.
    #[serde(default)]
    pub screen: Option<ScreenSpec>,
    pub features: DeviceFeatures,
    /// Set when an owner's read sweep from this board is on file
    /// (`data/confirmed.json`). The vendor's data alone never sets it.
    #[serde(default)]
    pub confirmed: Option<Confirmation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub id: u32,
    pub issue: u32,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSpec {
    pub w: u16,
    pub h: u16,
    /// `16` is RGB565, `24` is three bytes a pixel.
    pub mode: String,
    #[serde(default)]
    pub layers: u8,
}

fn family_unknown() -> String {
    "unknown".into()
}

/// Families whose command set is established: yc500 by hardware round-trips
/// on an X86, gen2 by disassembling its own firmware (docs/PROTOCOL.md).
/// Anything else is read-only, because the two families' opcodes collide and
/// a misaddressed write lands on a live register.
const KNOWN_FAMILIES: &[&str] = &["yc500", "gen2"];

impl DeviceSpec {
    /// What a human calls this board.
    pub fn label(&self) -> String {
        let name = if self.display_name.is_empty() {
            &self.name
        } else {
            &self.display_name
        };
        let brand = if self.company.is_empty() {
            &self.vendor
        } else {
            &self.company
        };
        if brand.is_empty() {
            name.clone()
        } else {
            format!("{brand} {name}")
        }
    }

    pub fn writes_supported(&self) -> bool {
        KNOWN_FAMILIES.contains(&self.family.as_str())
    }

    /// What drawing is allowed on this board's display, or `None` when the
    /// path is not evidenced. The board's own firmware must be known to
    /// parse frames itself; most gen2 boards instead hand the request to a
    /// display chip whose protocol is not established, and stay refused.
    ///
    /// Three lineages qualify (docs/PROTOCOL.md, "Screens"):
    ///
    /// - The yc500 family. Its images read the frame length as a u16 and
    ///   never the high bytes, so frames past 65535 bytes are refused.
    ///   Modes 16 and 24 each have a firmware image behind them.
    /// - yc3123-lineage gen2 boards, named by the `internalName` prefix.
    ///   Their images read the length as a u32 and stream through banked
    ///   RAM, so the big panels fit. Mode 16 only; no yc3123 image
    ///   evidences mode 24.
    /// - ry5088-lineage gen2 boards. These hand the frame to a display
    ///   chip, but that chip's own firmware parses the layout sharkfin
    ///   already builds, and the keyboard forwards only the packet's first
    ///   twelve bytes, so the length is a u16 there too. Mode 16 only; the
    ///   gen2 dispatcher has no mode 24 opcode at all.
    ///
    /// The remaining gen2 lineages (ry6602, ry6609, pan1086) sit in the
    /// same family and are refused: only ry5088 keyboard firmware was
    /// disassembled, and a shared family is not evidence.
    pub fn screen_draw(&self) -> Option<ScreenDrawRules> {
        match self.family.as_str() {
            "yc500" => Some(ScreenDrawRules {
                max_frame: usize::from(u16::MAX),
                max_dim: 255,
                mode24: true,
            }),
            "gen2" if self.internal_name.starts_with("yc3123_") => Some(ScreenDrawRules {
                max_frame: u32::MAX as usize,
                max_dim: u16::MAX,
                mode24: false,
            }),
            "gen2" if self.internal_name.starts_with("ry5088_") => Some(ScreenDrawRules {
                max_frame: usize::from(u16::MAX),
                max_dim: 255,
                mode24: false,
            }),
            _ => None,
        }
    }
}

/// The limits `screen_draw` grants: the largest frame the board's firmware
/// can count, the largest panel its bounding box can address, and whether
/// the mode 24 opcode pair is evidenced for it.
///
/// `max_dim` is not cosmetic. yc500 and the ry5088 display chip both read
/// the bounding box from its low bytes only, and the chip turns them into a
/// size by subtracting. A 320-wide panel arrives as a width of 64 and the
/// picture is laid out wrong rather than refused, so the check belongs
/// here. yc3123 reads the box's high bytes and has no such limit.
pub struct ScreenDrawRules {
    pub max_frame: usize,
    pub max_dim: u16,
    pub mode24: bool,
}

/// What a data bundle calls this build. The version alone does not identify
/// one: the browser app is deployed straight from master, and a bug report can
/// arrive from any commit between two releases. `SHARKFIN_COMMIT` comes from
/// each crate's build script and is absent when building from a release
/// tarball, which has no git metadata.
pub fn build_id() -> String {
    match option_env!("SHARKFIN_COMMIT") {
        Some(commit) => format!("{} ({commit})", env!("CARGO_PKG_VERSION")),
        None => env!("CARGO_PKG_VERSION").to_string(),
    }
}

static DEVICES_JSON: &str = include_str!("../data/devices.json");
static CONFIRMED_JSON: &str = include_str!("../data/confirmed.json");

/// A malformed registry must not take the app down; callers fall back to
/// treating the board as unknown.
pub fn all() -> Vec<DeviceSpec> {
    let mut devices: Vec<DeviceSpec> = match serde_json::from_str(DEVICES_JSON) {
        Ok(v) => v,
        Err(e) => {
            log::error!("data/devices.json failed to parse: {e}");
            return Vec::new();
        }
    };
    let confirmed: Vec<Confirmation> = match serde_json::from_str(CONFIRMED_JSON) {
        Ok(v) => v,
        Err(e) => {
            log::error!("data/confirmed.json failed to parse: {e}");
            Vec::new()
        }
    };
    for d in &mut devices {
        d.confirmed = confirmed.iter().find(|c| c.id == d.id).cloned();
    }
    devices
}

pub fn by_id(id: u32) -> Option<DeviceSpec> {
    all().into_iter().find(|d| d.id == id)
}

/// Every USB vendor ID in the registry. Most of these boards are ROYUAN's
/// `0x3151`, but a minority ship under the brand's own ID, and discovery that
/// looks only for `0x3151` leaves those owners staring at an empty app while
/// the support list claims their board works. Derived from the registry so
/// the two can never disagree.
pub fn vendor_ids() -> &'static [u16] {
    static IDS: OnceLock<Vec<u16>> = OnceLock::new();
    IDS.get_or_init(|| {
        let mut v: Vec<u16> = all().iter().map(|d| d.vendor_id).collect();
        v.sort_unstable();
        v.dedup();
        v
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_json_parses() {
        let devices = all();
        assert!(devices.len() > 500);
        let x86 = by_id(1967).expect("X86 present");
        assert_eq!(x86.internal_name, "yc3121_x86_soc");
        assert_eq!(x86.family, "yc500");
        assert_eq!(x86.key_layout, "Common80_k72x86");
        assert_eq!(x86.profiles, 3);
        assert!(!x86.magnetic);
        assert!(
            !x86.features.side_light,
            "the X86 has no edge light; the firmware answering 0x88 is not evidence"
        );
        assert!(x86.writes_supported());
        assert_eq!(x86.label(), "AttackShark X86");
    }

    /// Drawing is granted per lineage, never per family alone. yc3123 boards
    /// live in gen2 beside ry5088 boards that forward frames to a display
    /// chip, so the prefix test is what keeps those refused.
    #[test]
    fn screen_draw_follows_the_lineage() {
        let rt85 = by_id(2895).expect("RT85 present");
        assert_eq!(rt85.family, "gen2");
        assert!(rt85.internal_name.starts_with("yc3123_"));
        let rules = rt85.screen_draw().expect("yc3123 draws");
        let screen = rt85.screen.expect("RT85 has a screen");
        // 320x172 RGB565 is 110080 bytes: over the u16, within the u32.
        assert!(usize::from(screen.w) * usize::from(screen.h) * 2 <= rules.max_frame);
        assert!(!rules.mode24, "mode 24 has no yc3123 image behind it");

        let rt100 = by_id(1379).expect("RT100 present");
        assert_eq!(rt100.family, "yc500");
        let rules = rt100.screen_draw().expect("yc500 draws");
        assert_eq!(rules.max_frame, usize::from(u16::MAX));
        assert!(rules.mode24);

        // The k2401e is yc3121-lineage with a 121552-byte panel and no
        // published firmware; its frame must still exceed the u16 limit.
        let k2401e = by_id(3430).expect("k2401e present");
        assert_eq!(k2401e.family, "yc500");
        let rules = k2401e.screen_draw().expect("family gate passes");
        let screen = k2401e.screen.expect("k2401e has a screen");
        assert!(usize::from(screen.w) * usize::from(screen.h) * 2 > rules.max_frame);

        // The ry5088 display chip parses the same layout, evidenced from
        // its own firmware, but reads the box as low bytes only.
        let nj81 = by_id(2454).expect("NJ81-CP present");
        assert_eq!(nj81.family, "gen2");
        let rules = nj81.screen_draw().expect("ry5088 draws");
        assert_eq!(rules.max_frame, usize::from(u16::MAX));
        assert_eq!(rules.max_dim, 255);
        assert!(!rules.mode24, "gen2 has no mode 24 opcode at all");

        // A gen2 lineage whose firmware was never disassembled stays
        // refused, family alone is not evidence.
        let other = all()
            .into_iter()
            .find(|d| {
                d.family == "gen2"
                    && d.screen.is_some()
                    && (d.internal_name.starts_with("ry6609_")
                        || d.internal_name.starts_with("ry6602_"))
            })
            .expect("an ry66xx screen board is in the registry");
        assert!(other.screen_draw().is_none(), "{}", other.internal_name);
    }

    /// The 320px ry5088 panels arrive at the chip as a width of 64, because
    /// it reads the box's low byte and subtracts. They must be refused on
    /// size, not drawn wrong.
    #[test]
    fn oversized_panels_are_refused_where_the_box_is_a_low_byte() {
        for id in [3728u32, 4051, 4161] {
            let d = by_id(id).unwrap_or_else(|| panic!("device {id} present"));
            let rules = d.screen_draw().expect("ry5088 lineage draws");
            let screen = d.screen.expect("has a screen");
            assert!(
                screen.w > rules.max_dim || screen.h > rules.max_dim,
                "device {id} should trip the dimension limit"
            );
        }
    }

    #[test]
    fn every_device_has_a_family_and_unevidenced_ones_are_read_only() {
        for d in all() {
            assert!(!d.family.is_empty(), "device {} has no family", d.id);
            let known = matches!(d.family.as_str(), "yc500" | "gen2");
            assert_eq!(d.writes_supported(), known, "device {}", d.id);
        }
    }

    #[test]
    fn confirmations_name_registered_boards() {
        let entries: Vec<Confirmation> =
            serde_json::from_str(CONFIRMED_JSON).expect("confirmed.json parses");
        for c in entries {
            assert!(
                by_id(c.id).is_some(),
                "confirmed.json id {} is not in the registry",
                c.id
            );
            assert!(
                c.issue > 0 && !c.version.is_empty(),
                "confirmed.json id {}",
                c.id
            );
        }
    }

    /// Boards and corrections the vendor bundle cannot supply: one the vendor
    /// removed, one it never listed, and boards it points at the wrong layout.
    /// `tools/extract_vendor_data.py` merges `data/devices.extra.json` into the
    /// registry it writes, so regenerating without the extras silently drops
    /// real hardware or reinstates a layout known to be wrong. Fail instead.
    ///
    /// Whole entries are checked field by field. An `_override` entry carries
    /// only the fields it replaces, so each is compared on its own terms.
    #[test]
    fn hand_added_boards_survive_a_regeneration() {
        static EXTRA_JSON: &str = include_str!("../data/devices.extra.json");
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(EXTRA_JSON).expect("devices.extra.json parses");
        assert!(!entries.is_empty(), "extras file is empty");
        let mut wholes = 0;
        let mut overrides = 0;
        for e in entries {
            let id = e["id"].as_u64().expect("every entry has an id") as u32;
            let got = by_id(id)
                .unwrap_or_else(|| panic!("device {id} is in the extras but not the registry"));
            if e.get("_override")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                overrides += 1;
                let have = serde_json::to_value(&got).unwrap();
                for (key, want) in e.as_object().unwrap() {
                    if key.starts_with('_') || key == "id" {
                        continue;
                    }
                    assert_eq!(
                        &have[key], want,
                        "device {id} field {key} lost its override"
                    );
                }
            } else {
                wholes += 1;
                let want: DeviceSpec =
                    serde_json::from_value(e).expect("whole entry parses as DeviceSpec");
                assert_eq!(got.family, want.family, "device {id} family");
                assert_eq!(got.vendor_id, want.vendor_id, "device {id} vendor id");
                assert_eq!(got.product_id, want.product_id, "device {id} product id");
                assert_eq!(got.key_layout, want.key_layout, "device {id} layout");
            }
        }
        assert!(wholes > 0 && overrides > 0, "expected both kinds of entry");
    }

    /// A layout named `Local*` is hand-maintained from hardware evidence for a
    /// board no vendor layout fits. It survives regeneration only because the
    /// file says `"local": true`; a tool that rewrites one and drops the flag
    /// leaves a file the next extraction deletes, and the boards pointing at it
    /// fall back to a bare slot grid with nothing failing in between.
    #[test]
    fn local_layouts_stay_local() {
        static LOCAL: &[(&str, &str)] = &[
            (
                "Local68_Chronos68",
                include_str!("../../src/lib/layouts/vendor/Local68_Chronos68.json"),
            ),
            (
                "Local81_DarmosharkTop75",
                include_str!("../../src/lib/layouts/vendor/Local81_DarmosharkTop75.json"),
            ),
            (
                "Local87_KiiP_Y87",
                include_str!("../../src/lib/layouts/vendor/Local87_KiiP_Y87.json"),
            ),
            (
                "Local82_K600B82",
                include_str!("../../src/lib/layouts/vendor/Local82_K600B82.json"),
            ),
        ];
        for (name, text) in LOCAL {
            let v: serde_json::Value = serde_json::from_str(text).expect("parses");
            assert_eq!(
                v["local"],
                serde_json::json!(true),
                "{name} lost its local flag"
            );
            assert!(
                all().iter().any(|d| d.key_layout == *name),
                "no board points at {name}, so nothing keeps it honest"
            );
        }
        for d in all().iter().filter(|d| d.key_layout.starts_with("Local")) {
            assert!(
                LOCAL.iter().any(|(name, _)| *name == d.key_layout),
                "device {} names a local layout this test does not check exists",
                d.id
            );
        }
    }

    /// A bundle has to name the build it came from, or a report from between
    /// two releases cannot be placed. The commit is absent in a tarball build,
    /// so only the version prefix is guaranteed.
    #[test]
    fn build_id_starts_with_the_version() {
        let id = build_id();
        println!("build id: {id}");
        assert!(
            id.starts_with(env!("CARGO_PKG_VERSION")),
            "build id {id} does not start with the crate version"
        );
    }

    #[test]
    fn side_light_flag_tracks_the_registry_layout() {
        for d in all() {
            assert_eq!(
                d.features.side_light,
                !d.side_light_layout.is_empty(),
                "device {} disagrees about its edge light",
                d.id
            );
        }
    }

    #[test]
    fn discovery_covers_every_vendor_in_the_registry() {
        let ids = vendor_ids();
        assert!(
            ids.contains(&crate::protocol::VENDOR_ID),
            "the ROYUAN OEM id"
        );
        // A board whose vendor id is not scanned for can never be found, no
        // matter what the support list says about it.
        for d in all() {
            assert!(
                ids.contains(&d.vendor_id),
                "device {} ({:04x}) is in the registry but would never be discovered",
                d.id,
                d.vendor_id
            );
        }
        assert!(
            ids.len() > 1,
            "the registry has boards under several vendor ids; do not hardcode one"
        );
    }

    /// The udev rule is written out in three places and has drifted in two of
    /// them already. A vendor id missing from any one of them leaves that
    /// board's node owned by root, and the app reports "no device" with the
    /// keyboard plugged in, which reads as the rule having failed rather than
    /// being incomplete.
    #[test]
    fn every_copy_of_the_udev_rule_covers_the_whole_registry() {
        let copies = [
            // installed by the .deb, .rpm and Arch packages
            (
                "packaging/70-sharkfin.rules",
                include_str!("../../../packaging/70-sharkfin.rules"),
            ),
            // offered for pasting by the Linux permission panel
            (
                "app/src/components/PermissionNotice.tsx",
                include_str!("../../src/components/PermissionNotice.tsx"),
            ),
            // inlined in every release's notes
            (
                ".github/release-notes.md",
                include_str!("../../../.github/release-notes.md"),
            ),
        ];
        for (what, text) in copies {
            for vid in vendor_ids() {
                assert!(
                    text.contains(&format!("{vid:04x}")),
                    "vendor {vid:04x} is missing from the udev rule in {what}"
                );
            }
        }
    }

    #[test]
    fn labels_are_never_empty() {
        for d in all() {
            assert!(!d.label().trim().is_empty(), "device {} has no label", d.id);
        }
    }
}
