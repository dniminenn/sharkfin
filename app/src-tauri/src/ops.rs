// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! The conversations a command has with a board.
//!
//! A command is three parts: read some state, talk to the board, write the
//! state back. The first and third differ between the two backends, because
//! one holds a `Mutex` on a worker thread and the other a `RefCell` in a
//! browser. The middle does not, so it lives here, once, over [`Wire`].

use crate::protocol::{
    cmd, family_cmds, gen2, hall, Checksum, FamilyCmds, KbOptions, LedParam, Macro, SledParam,
    SleepTimes, REPORT_LEN,
};
use crate::registry::DeviceSpec;
use crate::session::DeviceSettings;
use crate::wire::{Stack, Wire, WireError};

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

/// The header plus body of one driveall macro block, or `None` for an
/// unclaimed slot. `space` is the board's macro budget, which bounds how
/// long a block the header is allowed to claim.
pub async fn driveall_macro_block<W: Wire>(
    w: &W,
    addr: u32,
    space: u16,
) -> Result<Option<Vec<u8>>, WireError> {
    use crate::protocol::driveall;
    // Zero is unclaimed. Anything inside the index is not a block either:
    // an erased entry reads as `FF FF FF FF` and would otherwise be chased.
    if addr == 0 || addr < driveall::MACRO_INDEX_LEN as u32 || addr > u32::from(u16::MAX) {
        return Ok(None);
    }
    let header = w.driveall_get(driveall::GET_MACRO, 4, addr as u16).await?;
    if header.len() < 2 {
        return Ok(None);
    }
    let body_len = driveall::macro_body_len(&header, space);
    let body = w
        .driveall_get(driveall::GET_MACRO, body_len, addr as u16 + 4)
        .await?;
    let mut block = header;
    block.extend_from_slice(&body);
    Ok(Some(block))
}

pub async fn driveall_read_macro<W: Wire>(w: &W, slot: u8, space: u16) -> Result<Macro, WireError> {
    use crate::protocol::driveall;
    let index = w
        .driveall_get(driveall::GET_MACRO, driveall::MACRO_INDEX_LEN, 0)
        .await?;
    let offs = driveall::macro_index_offsets(&index);
    let addr = offs.get(usize::from(slot)).copied().unwrap_or(0);
    match driveall_macro_block(w, addr, space).await? {
        Some(block) => Ok(driveall::macro_from_driveall(&block)),
        None => Ok(Macro::default()),
    }
}

/// Macros share one region, so changing any slot rewrites the index and
/// every block after it.
pub async fn driveall_write_macro<W: Wire>(
    w: &W,
    slot: u8,
    data: &Macro,
    space: u16,
) -> Result<(), WireError> {
    use crate::protocol::driveall;
    let mine = driveall::macro_to_driveall(data)
        .ok_or_else(|| WireError::Protocol("this board's macros have no mouse move".into()))?;
    let index = w
        .driveall_get(driveall::GET_MACRO, driveall::MACRO_INDEX_LEN, 0)
        .await?;
    let offs = driveall::macro_index_offsets(&index);
    let mut blocks: Vec<Option<Vec<u8>>> = Vec::with_capacity(driveall::MACRO_SLOTS);
    for (i, &addr) in offs.iter().enumerate() {
        if i == usize::from(slot) {
            blocks.push((mine.len() > 4).then(|| mine.clone()));
        } else {
            blocks.push(driveall_macro_block(w, addr, space).await?);
        }
    }
    let (new_index, payload) = driveall::macro_relayout(&blocks);
    // The board refuses a store larger than its own budget, and a wrapped
    // chunk address would write one block's bytes over another's.
    if payload.len() > driveall::macro_space_or_default(space) {
        return Err(WireError::Protocol(
            "this board has no room left for that macro".into(),
        ));
    }
    w.driveall_set(driveall::SET_MACRO, 0, &new_index, false)
        .await?;
    if !payload.is_empty() {
        w.driveall_set(
            driveall::SET_MACRO,
            driveall::MACRO_INDEX_LEN as u16,
            &payload,
            true,
        )
        .await?;
    }
    Ok(())
}

/// The effect block as the board reports it.
pub async fn read_led_param<W: Wire>(
    w: &W,
    spec: &DeviceSpec,
    wire: crate::protocol::LedWire,
) -> Result<LedParam, WireError> {
    use crate::protocol::driveall;
    if spec.family == "driveall" {
        let raw = w
            .driveall_get(driveall::GET_LED_EFFECT, driveall::LED_LEN, 0)
            .await?;
        return driveall::led_from_wire(&raw)
            .ok_or_else(|| WireError::Protocol("bad LED effect reply".into()));
    }
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

/// Driveall has no opcode sweep to run: an unimplemented command is not
/// answered rather than echoed. The info block and the base keymap are
/// what a layout is baked from.
pub async fn driveall_sweep<W: Wire>(w: &W, out: &mut String) {
    use crate::protocol::driveall;
    use std::fmt::Write;
    match w.identify_driveall().await {
        Ok(i) => {
            let _ = writeln!(
                out,
                "\ndriveall info: vid {:04x} pid {:04x} version {:04x} \
                 rtPrecision {} profile {} macro space {}",
                i.vid, i.pid, i.version, i.rt_precision, i.current_profile, i.macro_space
            );
        }
        Err(e) => {
            let _ = writeln!(out, "\ndriveall info: error: {e}");
            return;
        }
    }
    for (label, cmd, len) in [
        ("key", driveall::GET_KEY, driveall::KEYMAP_LEN),
        ("fn key", driveall::GET_FN_KEY, driveall::KEYMAP_LEN),
        ("led effect", driveall::GET_LED_EFFECT, driveall::LED_LEN),
    ] {
        match w.driveall_get(cmd, len, 0).await {
            Ok(raw) => {
                let hex: String = raw.iter().fold(String::new(), |mut s, b| {
                    let _ = write!(s, "{b:02x}");
                    s
                });
                let _ = writeln!(out, "{label:<12} {hex}");
            }
            Err(e) => {
                let _ = writeln!(out, "{label:<12} error: {e}");
            }
        }
    }
}

/// The read sweep a bundle carries: both families' GET opcodes, so a board
/// sharkfin does not know still says what it answers to. Read-only.
pub async fn probe_sweep<W: Wire>(w: &W, out: &mut String) -> Result<(), WireError> {
    use std::fmt::Write;
    // The ROYUAN opcodes are writes on a driveall collection, so that stack
    // reports its info block and base keymap instead of being swept.
    if w.stack() == Stack::Driveall {
        driveall_sweep(w, out).await;
        return Ok(());
    }
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
