// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{apply_checksum, packet, Checksum, GEN2_CMDS, REPORT_LEN};

const BULK_SENTINEL: u8 = 0xFF;
const FN_SYS_WIN: u8 = 0;

pub fn keymatrix_read_payload(profile: u8, page: u8) -> [u8; 4] {
    keymatrix_layer_read_payload(profile, page, 0)
}

/// Byte 4 picks the sub-layer: the 2268 `0x8A` handler (`0x08010d08`)
/// reads `profile << 11 | sublayer << 9` out of flash. Sub-layer 0 is
/// the keymap every board has; 1..3 hold dynamic-keystroke, mod-tap
/// and toggle actions on magnetic boards.
pub fn keymatrix_layer_read_payload(profile: u8, page: u8, sublayer: u8) -> [u8; 4] {
    [profile, BULK_SENTINEL, page, sublayer]
}

pub fn fn_read_payload(profile: u8, page: u8) -> [u8; 4] {
    [FN_SYS_WIN, profile, BULK_SENTINEL, page]
}

/// byte 5 = 1 applies the change immediately (the vendor always sets it).
pub fn set_key_packet(profile: u8, slot: u8, value: [u8; 4]) -> [u8; REPORT_LEN] {
    let mut buf = packet(
        GEN2_CMDS.set_keymatrix,
        &[profile, slot, 0, 0, 1, 0],
        Checksum::Bit7,
    );
    buf[8..12].copy_from_slice(&value);
    buf
}

/// One slot in a sub-layer. The 2268 `0x0A` handler (`0x08006f10`)
/// takes byte 6 as the block: `sublayer << 9` into the current
/// profile's 2048-byte keymap RAM, committed to flash on byte 5.
pub fn set_layer_key_packet(
    profile: u8,
    slot: u8,
    sublayer: u8,
    value: [u8; 4],
) -> [u8; REPORT_LEN] {
    let mut buf = packet(
        GEN2_CMDS.set_keymatrix,
        &[profile, slot, 0, 0, 1, sublayer],
        Checksum::Bit7,
    );
    buf[8..12].copy_from_slice(&value);
    buf
}

pub fn set_fn_key_packet(profile: u8, slot: u8, value: [u8; 4]) -> [u8; REPORT_LEN] {
    let mut buf = packet(
        super::cmd::SET_FN,
        &[FN_SYS_WIN, profile, slot],
        Checksum::Bit7,
    );
    buf[8..12].copy_from_slice(&value);
    buf
}

/// 512-byte matrix in ceil(512/56) = 10 pages:
/// [0x0A, profile, 0xFF, page, len, last, 0, ck7] + 56 data bytes.
pub fn bulk_keymatrix_packets(profile: u8, matrix: &[u8; 512]) -> Vec<[u8; REPORT_LEN]> {
    matrix
        .chunks(56)
        .enumerate()
        .map(|(page, chunk)| {
            let mut buf = [0u8; REPORT_LEN];
            buf[0] = GEN2_CMDS.set_keymatrix;
            buf[1] = profile;
            buf[2] = BULK_SENTINEL;
            buf[3] = page as u8;
            buf[4] = chunk.len() as u8;
            buf[5] = (page == matrix.len().div_ceil(56) - 1) as u8;
            apply_checksum(&mut buf, Checksum::Bit7);
            buf[8..8 + chunk.len()].copy_from_slice(chunk);
            buf
        })
        .collect()
}

/// The gen2 wire carries two fewer keys than yc500's 128.
pub const PER_KEY_BYTES: usize = 378;

/// Per-key colours: 126 keys × RGB = 378 bytes in 7 pages:
/// [0x0C, slot, 0xFF, page, len, last, 0, ck7] + data at byte 8.
///
/// Firmware 2268_v309 (handler 0x8010db8) accepts a page only when
/// byte 2 is 0xFF, stages it at page*56, and commits the slot to flash
/// when page 6 arrives with the last flag set. When byte 2 is anything
/// else it skips the copy but still commits, so a yc500-shaped packet
/// burns a flash cycle on stale data. The firmware bounds-checks
/// neither page nor length; both come from the chunking here, never
/// from a caller.
///
/// `slot` must match the pattern slot in the LEDPARAM option nibble.
/// A longer blob is truncated.
pub fn userpic_packets(slot: u8, blob: &[u8]) -> Vec<[u8; REPORT_LEN]> {
    let blob = &blob[..blob.len().min(PER_KEY_BYTES)];
    blob.chunks(56)
        .enumerate()
        .map(|(page, chunk)| {
            let mut buf = [0u8; REPORT_LEN];
            buf[0] = super::cmd::SET_USERPIC;
            buf[1] = slot;
            buf[2] = BULK_SENTINEL;
            buf[3] = page as u8;
            buf[4] = chunk.len() as u8;
            buf[5] = (page == blob.len().div_ceil(56) - 1) as u8;
            apply_checksum(&mut buf, Checksum::Bit7);
            buf[8..8 + chunk.len()].copy_from_slice(chunk);
            buf
        })
        .collect()
}
