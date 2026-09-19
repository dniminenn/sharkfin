// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! What a connected board lets the user do, and the shapes both frontends
//! receive.
//!
//! These are decisions, not conversation: which controls a board offers,
//! what an owner has allowed. Both backends answer the same questions, and
//! answering them separately is how the browser build came to allow a
//! magnetic write the desktop build refused.

use serde::{Deserialize, Serialize};

use crate::protocol::{KbOptions, LedParam, SledParam, SleepTimes};
use crate::registry::DeviceSpec;

/// Rules live on `DeviceSpec`. Both frontends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SwitchAccess {
    None,
    /// Columns can be read, not written.
    Read,
    /// Columns can be read and written.
    Write,
    /// No columns: one board-wide record can be written, nothing read back.
    Global,
}

/// `owner_hall`: the owner's felt round trip stands in for firmware
/// evidence on a board whose columns read.
pub fn switch_access(
    spec: &DeviceSpec,
    revision: Option<u16>,
    read_only: bool,
    owner_hall: bool,
) -> SwitchAccess {
    if spec.hall_reads(revision) {
        if (spec.hall_writes(revision) || owner_hall) && !read_only {
            SwitchAccess::Write
        } else {
            SwitchAccess::Read
        }
    } else if spec.hall_global(revision) && !read_only {
        SwitchAccess::Global
    } else {
        SwitchAccess::None
    }
}

/// Owner answers from the check. Spec overlays apply only to an unregistered
/// board, so a registry entry is never contradicted by a click. `switch_writes`
/// is a felt round trip standing in for unread firmware, on any board whose
/// columns read.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OwnerRecord {
    pub allowed: bool,
    pub magnetic: bool,
    pub side_light: Option<bool>,
    pub switch_writes: bool,
    pub profiles: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub debounce: u8,
    pub sleep: SleepTimes,
    /// Absent on families whose option bitfield is not decoded.
    pub options: Option<KbOptions>,
    /// Firmware revision, e.g. 0x0102 -> "1.02". From 0x80, or on gen2 the
    /// identify reply.
    pub revision: String,
    /// Board auto-detects the host OS and switches its Win/Mac layer.
    pub auto_os: bool,
    /// Present only when the firmware answers 0x88.
    pub side_light: Option<SledParam>,
}

/// Everything sharkfin can read back from a board, as one restorable file.
/// Per-key colour is absent by necessity: the firmware never reports it.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConfig {
    pub version: u8,
    pub device_id: u32,
    pub family: String,
    pub board: String,
    pub profiles: Vec<Vec<u8>>,
    pub fn_layers: Vec<Vec<u8>>,
    pub led: LedParam,
    pub side_light: Option<SledParam>,
    pub debounce: u8,
    pub sleep: SleepTimes,
    pub options: Option<KbOptions>,
}

/// Whether the switch columns may be written, and why.
///
/// `owner_hall` is the owner's felt round trip standing in for firmware
/// evidence; `trial` is the single-key trial. Both backends ask this one
/// question rather than each deciding for itself, which is how the browser
/// build once allowed a write the desktop build refused.
pub fn hall_write_allowed(
    spec: &DeviceSpec,
    revision: Option<u16>,
    owner_switch_writes: bool,
    trial_slot: Option<u8>,
    slots: Option<&[u8]>,
) -> bool {
    let reads = spec.hall_reads(revision);
    let owner_hall = owner_switch_writes && reads;
    let trial = reads
        && match (trial_slot, slots) {
            (Some(t), Some(k)) => !k.is_empty() && k.iter().all(|&x| x == t),
            _ => false,
        };
    spec.hall_writes(revision) || owner_hall || trial
}

/// The message shown when it is not.
pub fn hall_write_refusal(spec: &DeviceSpec) -> String {
    format!(
        "sharkfin has not read {}'s firmware for its switch settings, so it will not write them",
        spec.label()
    )
}
