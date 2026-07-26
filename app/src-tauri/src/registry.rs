// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Handshake device ID -> board spec, shipped as data.
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
    pub features: DeviceFeatures,
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
}

static DEVICES_JSON: &str = include_str!("../data/devices.json");

/// A malformed registry must not take the app down; callers fall back to
/// treating the board as unknown.
pub fn all() -> Vec<DeviceSpec> {
    match serde_json::from_str(DEVICES_JSON) {
        Ok(v) => v,
        Err(e) => {
            log::error!("data/devices.json failed to parse: {e}");
            Vec::new()
        }
    }
}

pub fn by_id(id: u32) -> Option<DeviceSpec> {
    all().into_iter().find(|d| d.id == id)
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

    #[test]
    fn every_device_has_a_family_and_unevidenced_ones_are_read_only() {
        for d in all() {
            assert!(!d.family.is_empty(), "device {} has no family", d.id);
            let known = matches!(d.family.as_str(), "yc500" | "gen2");
            assert_eq!(d.writes_supported(), known, "device {}", d.id);
        }
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
    fn labels_are_never_empty() {
        for d in all() {
            assert!(!d.label().trim().is_empty(), "device {} has no label", d.id);
        }
    }
}
