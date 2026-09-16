// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{packet, Checksum, REPORT_LEN};

pub const STATUS: u8 = 0xF7;
pub const SELECT: u8 = 0xF6;
pub const RELEASE: u8 = 0xFC;
pub const TARGET_KEYBOARD: u8 = 0x0A;

const KIND_KEYBOARD: u8 = 1;
const KIND_MOUSE: u8 = 2;
const KIND_BOTH: u8 = 3;

/// `STATUS` reply. Mouse fields exist on the wire and are not modelled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    /// A relayed reply is waiting; `RELEASE` hands it to the next read.
    pub reply_ready: bool,
    pub keyboard_battery: u8,
    pub keyboard_online: bool,
    /// The receiver will accept a packet to relay.
    pub can_send: bool,
    pub has_keyboard: bool,
    pub rf_boot: bool,
}

/// `None` when the reply is not a receiver status: the kind byte is the
/// only field a keyboard's own replies cannot produce by accident.
pub fn parse_status(reply: &[u8]) -> Option<Status> {
    if reply.len() < 9 || !matches!(reply[6], KIND_KEYBOARD | KIND_MOUSE | KIND_BOTH) {
        return None;
    }
    Some(Status {
        reply_ready: reply[0] == 1,
        keyboard_battery: reply[1],
        keyboard_online: reply[3] == 0,
        can_send: reply[5] == 1,
        has_keyboard: matches!(reply[6], KIND_KEYBOARD | KIND_BOTH),
        rf_boot: reply[7] == 1 && reply[8] == 1,
    })
}

pub fn status_packet() -> [u8; REPORT_LEN] {
    packet(STATUS, &[], Checksum::Bit7)
}

pub fn select_keyboard_packet() -> [u8; REPORT_LEN] {
    packet(SELECT, &[TARGET_KEYBOARD], Checksum::Bit7)
}

pub fn release_packet() -> [u8; REPORT_LEN] {
    packet(RELEASE, &[], Checksum::Bit7)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_from_an_x86_receiver() {
        // As read on 2026-09-04 with the keyboard paired and awake.
        let mut r = [0u8; 64];
        r[..9].copy_from_slice(&[0x01, 0x60, 0, 0, 1, 1, 1, 0, 0]);
        let s = parse_status(&r).unwrap();
        assert!(s.reply_ready && s.keyboard_online && s.can_send && s.has_keyboard);
        assert!(!s.rf_boot);
        assert_eq!(s.keyboard_battery, 96);
    }

    #[test]
    fn a_keyboard_reply_is_not_a_status() {
        let mut r = [0u8; 64];
        r[0] = 0x8F;
        r[1..5].copy_from_slice(&1967u32.to_le_bytes());
        assert!(parse_status(&r).is_none());
        assert!(parse_status(&[0u8; 64]).is_none());
    }

    #[test]
    fn packets() {
        assert_eq!(
            &select_keyboard_packet()[..8],
            &[0xF6, 0x0A, 0, 0, 0, 0, 0, 0xFF]
        );
        assert_eq!(release_packet()[0], RELEASE);
        assert_eq!(status_packet()[7], 0xFF - 0xF7);
    }
}
