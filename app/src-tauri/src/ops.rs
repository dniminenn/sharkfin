// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! The conversations a command has with a board.
//!
//! A command is three parts: read some state, talk to the board, write the
//! state back. The first and third differ between the two backends, because
//! one holds a `Mutex` on a worker thread and the other a `RefCell` in a
//! browser. The middle does not, so it lives here, once, over [`Wire`].

use crate::protocol::{
    cmd, family_cmds, gen2, hall, Checksum, FamilyCmds, KbOptions, LedParam, SledParam, SleepTimes,
    REPORT_LEN,
};
use crate::registry::DeviceSpec;
use crate::session::DeviceSettings;
use crate::wire::{Wire, WireError};

/// A board whose family sharkfin does not know cannot be addressed: the
/// families share opcodes that mean different things.
pub fn need(fc: Option<&'static FamilyCmds>) -> Result<&'static FamilyCmds, WireError> {
    fc.ok_or_else(|| WireError::Protocol("this board's protocol family is unknown".into()))
}

pub fn check_macro_slot(slot: u8) -> Result<(), String> {
    if slot >= crate::protocol::MACRO_SLOTS {
        return Err(format!(
            "macro slot {slot} out of range (0..{})",
            crate::protocol::MACRO_SLOTS
        ));
    }
    Ok(())
}

/// Whether the board addresses profiles as `profile * 4 + sublayer`.
pub fn scaled_profiles(spec: &DeviceSpec) -> bool {
    spec.family == "yc500" && spec.magnetic
}

pub fn hall_format(spec: &DeviceSpec, revision: Option<u16>) -> Result<hall::Format, String> {
    if !spec.hall_reads(revision) {
        return Err(format!(
            "{} has no magnetic switches sharkfin can read",
            spec.label()
        ));
    }
    hall::Format::for_family(&spec.family)
        .ok_or_else(|| "no switch column format for this family".to_string())
}

pub fn key_write_packet(
    fc: &'static FamilyCmds,
    profile: u8,
    sublayer: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<[u8; REPORT_LEN], WireError> {
    if fc.name == "gen2" {
        return Ok(if fn_layer {
            gen2::set_fn_key_packet(profile, slot, value)
        } else {
            gen2::set_layer_key_packet(profile, slot, sublayer, value)
        });
    }
    let opcode = if fn_layer {
        fc.set_fn_one
    } else {
        fc.set_key_one
    }
    .ok_or_else(|| WireError::Protocol("no single-slot key write for this family".into()))?;
    let mut pkt = crate::protocol::packet(opcode, &[profile, slot], Checksum::Bit7);
    pkt[8..12].copy_from_slice(&value);
    Ok(pkt)
}

/// How a flash upload is spaced: between pages, and after the last one.
/// The backends own the cooldown before it.
#[derive(Clone, Copy)]
pub struct FlashPace {
    pub page_gap_ms: u64,
    pub settle_ms: u64,
}

/// One whole layer through the yc500 bulk upload, for boards whose firmware
/// drops the single-slot write (`DeviceSpec::bulk_keymap`). Lands in flash
/// on page 8.
pub async fn write_layer_bulk<W: Wire>(
    w: &W,
    fc: &'static FamilyCmds,
    profile: u8,
    matrix: &[u8; 512],
    fn_layer: bool,
    pace: FlashPace,
) -> Result<(), WireError> {
    if fc.name != "yc500" {
        return Err(WireError::Protocol(
            "bulk keymap writes are a yc500 path".into(),
        ));
    }
    for pkt in crate::protocol::yc500_bulk_layer_packets(profile, matrix, fn_layer) {
        w.send(&pkt).await?;
        w.sleep_ms(pace.page_gap_ms).await;
    }
    w.sleep_ms(pace.settle_ms).await;
    Ok(())
}

/// Read the layer, change one slot, write it back whole. Slots 126 and 127
/// are past what the upload carries.
pub async fn write_slot_bulk<W: Wire>(
    w: &W,
    fc: &'static FamilyCmds,
    profile: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
    pace: FlashPace,
) -> Result<(), WireError> {
    if slot >= 126 {
        return Err(WireError::Protocol(format!(
            "slot {slot} is past what this board's keymap upload carries"
        )));
    }
    let mut matrix: [u8; 512] = read_matrix(w, fc, profile, 0, fn_layer)
        .await?
        .try_into()
        .map_err(|_| WireError::Protocol("keymap read came back short".into()))?;
    let at = usize::from(slot) * 4;
    matrix[at..at + 4].copy_from_slice(&value);
    write_layer_bulk(w, fc, profile, &matrix, fn_layer, pace).await
}

/// Whether a dropped single-slot write may switch this board to the
/// whole-layer upload. The upload is evidenced on plain yc500 images only,
/// its profile byte is not the scaled slot magnetic boards use, and it
/// never carries slots 126 and 127.
pub fn bulk_fallback_allowed(spec: &DeviceSpec, sublayer: u8, slot: u8) -> bool {
    spec.family == "yc500" && !spec.magnetic && sublayer == 0 && slot < 126
}

/// One slot through the single-slot write, then read back. `Ok(true)` when
/// the slot holds the value. yc500 firmware without the write drops the
/// packet, so a miss is the signal to switch the board to the whole-layer
/// upload; three looks with a growing gap so one slow answer does not. A
/// reply led by the write opcode is the board handing back our own report,
/// not a page. gen2 is not checked: its write is firmware evidenced and its
/// bulk shape is another register.
pub async fn write_slot_checked<W: Wire>(
    w: &W,
    fc: &'static FamilyCmds,
    profile: u8,
    sublayer: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<bool, WireError> {
    let pkt = key_write_packet(fc, profile, sublayer, slot, value, fn_layer)?;
    w.send(&pkt).await?;
    if fc.name != "yc500" {
        return Ok(true);
    }
    let opcode = if fn_layer {
        cmd::GET_FN
    } else {
        fc.get_keymatrix
    };
    let at = usize::from(slot % 16) * 4;
    for wait in [w.settle_ms(), 50, 150] {
        w.sleep_ms(wait).await;
        let page = w
            .read_raw_page(opcode, &[profile, slot / 16], Checksum::Bit7)
            .await?;
        if page[0] == pkt[0] {
            continue;
        }
        if page[at..at + 4] == value {
            return Ok(true);
        }
    }
    Ok(false)
}

/// One 512-byte keymap layer, eight raw pages.
pub async fn read_matrix<W: Wire>(
    w: &W,
    fc: &'static FamilyCmds,
    profile: u8,
    sublayer: u8,
    fn_layer: bool,
) -> Result<Vec<u8>, WireError> {
    let mut matrix = Vec::with_capacity(512);
    for page in 0..8u8 {
        let (opcode, payload): (u8, Vec<u8>) = match (fc.name == "gen2", fn_layer) {
            (true, false) => (
                fc.get_keymatrix,
                gen2::keymatrix_layer_read_payload(profile, page, sublayer).to_vec(),
            ),
            (true, true) => (cmd::GET_FN, gen2::fn_read_payload(profile, page).to_vec()),
            (false, false) => (fc.get_keymatrix, vec![profile, page]),
            (false, true) => (cmd::GET_FN, vec![profile, page]),
        };
        let reply = w.read_raw_page(opcode, &payload, Checksum::Bit7).await?;
        matrix.extend_from_slice(&reply);
    }
    Ok(matrix)
}

/// `0x80` as a u16, `None` when the family is unknown or the board does not
/// answer. Zero counts as no answer.
pub async fn read_revision<W: Wire>(w: &W, spec: &DeviceSpec) -> Option<u16> {
    let op = family_cmds(&spec.family)?.get_revision?;
    let rev = w.roundtrip(op, &[], Checksum::Bit7).await.ok()?;
    let v = (u16::from(rev[2]) << 8) | u16::from(rev[1]);
    (v != 0).then_some(v)
}

/// The sweep a board answers when it is not in the registry: enough for
/// `derive` to name its family and bake a picture.
pub async fn derive_sweep<W: Wire>(
    w: &W,
    id: u32,
    vendor_id: u16,
    product_id: u16,
    product: &str,
) -> Option<DeviceSpec> {
    let r89 = w.read_raw_page(0x89, &[0, 0], Checksum::Bit7).await.ok()?;
    let r8a = w
        .read_raw_page(0x8A, &[0, 0xFF, 0, 0], Checksum::Bit7)
        .await
        .ok()?;
    let r91 = w.read_raw_page(0x91, &[], Checksum::Bit7).await.ok()?;
    let r92 = w.read_raw_page(0x92, &[], Checksum::Bit7).await.ok()?;
    let family = crate::derive::detect_family(&r89, &r8a, &r91, &r92)?;
    let mut keymap = Vec::with_capacity(512);
    for page in 0..8u8 {
        let reply = if family == "gen2" {
            w.read_raw_page(0x8A, &gen2::keymatrix_read_payload(0, page), Checksum::Bit7)
                .await
                .ok()?
        } else {
            w.read_raw_page(0x89, &[0, page], Checksum::Bit7)
                .await
                .ok()?
        };
        keymap.extend_from_slice(&reply);
    }
    let before = w.read_raw_page(0x97, &[], Checksum::Bit7).await.ok()?;
    let oled = w.read_raw_page(0xAD, &[], Checksum::Bit7).await.ok()?;
    let sweep = crate::derive::Sweep {
        r89: &r89,
        r8a: &r8a,
        r91: &r91,
        r92: &r92,
        oled: &oled,
        before_oled: &before,
        keymap: &keymap,
    };
    log::info!("device id {id} is not in the registry; answers as {family}");
    Some(crate::derive::derive_spec(
        id, vendor_id, product_id, product, family, &sweep,
    ))
}

/// The effect block as the board reports it.
pub async fn read_led_param<W: Wire>(
    w: &W,
    wire: crate::protocol::LedWire,
) -> Result<LedParam, WireError> {
    let reply = w.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7).await?;
    LedParam::from_reply_for(&reply, wire)
        .ok_or_else(|| WireError::Protocol("unexpected LED reply".into()))
}

/// The Device page in one exchange.
pub async fn read_settings<W: Wire>(
    w: &W,
    fc: &'static FamilyCmds,
    has_side_light: bool,
    swapped: bool,
) -> Result<DeviceSettings, WireError> {
    let deb = w.roundtrip(fc.get_debounce, &[], Checksum::Bit7).await?;
    let slp = w.roundtrip(fc.get_sleeptime, &[], Checksum::Bit7).await?;
    let opt = match fc.kboption {
        Some((_, get)) => Some(w.roundtrip(get, &[0], Checksum::Bit7).await?),
        None => None,
    };
    let revision = match fc.get_revision {
        Some(op) => {
            let rev = w.roundtrip(op, &[], Checksum::Bit7).await?;
            format!("{}.{:02}", rev[2], rev[1])
        }
        None => "unknown".into(),
    };
    let auto = match fc.auto_os {
        Some((_, get)) => w.roundtrip(get, &[], Checksum::Bit7).await.ok(),
        None => None,
    };
    let sled = match (has_side_light, fc.sled) {
        (true, Some((_, get))) => w
            .roundtrip(get, &[], Checksum::Bit7)
            .await
            .ok()
            .and_then(|r| SledParam::from_reply_on(&r, swapped)),
        _ => None,
    };
    Ok(DeviceSettings {
        debounce: deb[fc.debounce_at],
        sleep: SleepTimes::from_reply_expecting(&slp, fc.get_sleeptime, fc.sleep_reply_at)
            .ok_or_else(|| WireError::Protocol("bad SLEEPTIME reply".into()))?,
        options: match (opt, fc.kboption) {
            (Some(o), Some((_, get))) => Some(
                KbOptions::from_reply_expecting(&o, get)
                    .ok_or_else(|| WireError::Protocol("bad KBOPTION reply".into()))?,
            ),
            _ => None,
        },
        revision,
        auto_os: auto.map(|r| r[1] == 1).unwrap_or(false),
        side_light: sled,
    })
}

/// Do not sweep 0x80.. blind. gen2 0xAC erases the flash chip; on yc500 the
/// same byte is the 0x2C display erase. The sweep runs before the family is
/// known. Every entry must be a harmless read in both families.
///
/// Keymap pages go in so a report names the layout without a second trip.
const BUNDLE_PROBES: &[(&str, u8, &[u8])] = &[
    ("0x80 revision", 0x80, &[]),
    ("0x83 report rate (gen2)", 0x83, &[]),
    ("0x84 profile (gen2)", 0x84, &[]),
    ("0x85 profile (yc500)", 0x85, &[]),
    ("0x86 options/debounce", 0x86, &[0]),
    ("0x87 backlight", 0x87, &[]),
    ("0x88 edge light", 0x88, &[]),
    ("0x89 keymap/options p0", 0x89, &[0, 0]),
    ("0x89 keymap (yc500) p1", 0x89, &[0, 1]),
    ("0x89 keymap (yc500) p2", 0x89, &[0, 2]),
    ("0x89 keymap (yc500) p3", 0x89, &[0, 3]),
    ("0x89 keymap (yc500) p4", 0x89, &[0, 4]),
    ("0x89 keymap (yc500) p5", 0x89, &[0, 5]),
    ("0x89 keymap (yc500) p6", 0x89, &[0, 6]),
    ("0x89 keymap (yc500) p7", 0x89, &[0, 7]),
    ("0x89 keymap (yc500) p8", 0x89, &[0, 8]),
    ("0x8A keymap (gen2) p0", 0x8A, &[0, 0xFF, 0, 0]),
    ("0x8A keymap (gen2) p1", 0x8A, &[0, 0xFF, 1, 0]),
    ("0x8A keymap (gen2) p2", 0x8A, &[0, 0xFF, 2, 0]),
    ("0x8A keymap (gen2) p3", 0x8A, &[0, 0xFF, 3, 0]),
    ("0x8A keymap (gen2) p4", 0x8A, &[0, 0xFF, 4, 0]),
    ("0x8A keymap (gen2) p5", 0x8A, &[0, 0xFF, 5, 0]),
    ("0x8A keymap (gen2) p6", 0x8A, &[0, 0xFF, 6, 0]),
    ("0x8A keymap (gen2) p7", 0x8A, &[0, 0xFF, 7, 0]),
    ("0x8B macro s0 p0", 0x8B, &[0, 0]),
    ("0x8C userpic p0", 0x8C, &[0, 0]),
    ("0x8F identify", 0x8F, &[]),
    ("0x90 fn layer p0", 0x90, &[0, 0]),
    ("0x91 debounce/sleep", 0x91, &[]),
    ("0x92 sleep (yc500)", 0x92, &[]),
    ("0x97 auto-OS (yc500)", 0x97, &[]),
    ("0xAD OLED version", 0xAD, &[]),
];

/// The read sweep a bundle carries: both families' GET opcodes, so a board
/// sharkfin does not know still says what it answers to. Read-only.
///
/// An opcode the board will not answer is written into `out` and the sweep
/// carries on, because a partial sweep is still worth reporting. `Err` is
/// for the case where carrying on is wrong: a stalled endpoint, where every
/// further probe makes it worse. Callers keep the bundle on any other error.
pub async fn probe_sweep<W: Wire>(w: &W, out: &mut String) -> Result<(), WireError> {
    use std::fmt::Write;
    let _ = writeln!(
        out,
        "\nread sweep, both families' GET opcodes; an unimplemented \
         command echoes the previous reply:"
    );
    for (label, opcode, payload) in BUNDLE_PROBES {
        match w.read_raw_page(*opcode, payload, Checksum::Bit7).await {
            Ok(reply) => {
                let hex: String = reply.iter().fold(String::new(), |mut s, b| {
                    let _ = write!(s, "{b:02x} ");
                    s
                });
                let _ = writeln!(out, "{label:<24} {}", hex.trim_end());
            }
            Err(e) => {
                if e.is_stall() {
                    return Err(e);
                }
                let _ = writeln!(out, "{label:<24} error: {e}");
            }
        }
    }
    Ok(())
}
