// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{packet, Checksum, REPORT_LEN};
use serde::{Deserialize, Serialize};

pub const GET: u8 = 0xE5;
pub const SET: u8 = 0x65;

// Sub-ops, byte 1 of both opcodes.
pub const TRAVEL: u8 = 0;
pub const LIFT: u8 = 1;
pub const RT_PRESS: u8 = 2;
pub const RT_LIFT: u8 = 3;
pub const DKS_START: u8 = 4;
pub const MT_TIME: u8 = 5;
pub const DEAD_BOTTOM: u8 = 6;
pub const MODE: u8 = 7;
pub const DKS_ACTIONS: u8 = 8;
pub const SNAP_PARTNER: u8 = 9;
pub const DKS_ACTIONS_ALL: u8 = 10;

/// Bit 7 of the mode byte: rapid trigger on. Bits 0..6 pick the key's
/// kind.
pub const MODE_RAPID_TRIGGER: u8 = 0x80;
pub const KIND_NORMAL: u8 = 0;
pub const KIND_DKS: u8 = 2;
pub const KIND_MOD_TAP: u8 = 3;
pub const KIND_TOGGLE_HOLD: u8 = 4;
pub const KIND_TOGGLE_TAP: u8 = 5;
pub const KIND_SNAP: u8 = 7;

/// yc500 only. `0x1D [preset]` picks how the evaluator reads the key:
/// 0..2 are tables built into the firmware, 3 uses the columns. `0x9D`
/// answers `[9D, preset, 0 x6]`. Read out of 1618 (`0x010182e4`,
/// `0x0101830a`) and 1466 (`0x0101306a`, `0x01013086`).
pub const SET_PRESET: u8 = 0x1D;
pub const GET_PRESET: u8 = 0x9D;
pub const PRESET_CUSTOM: u8 = 3;

/// yc500 only. One record for every key (byte 5 set) or one slot (byte
/// 6). Handlers at 1466 `0x01013006` and 1618 `0x01017d76`; the apply
/// that fans it out sits at 1618 `0x010146f2`. Sets preset 3, saves.
pub const SET_GLOBAL: u8 = 0x1A;

/// The vendor's total travel for yc500 boards, tenths. The firmware
/// stores the bottom dead zone as a depth from the top; the vendor
/// shows 4.0 mm minus that.
const YC500_FULL_TRAVEL: i32 = 40;

/// Firmware clamps at gen2 apply, mirrored so the picture never lies:
/// travel below 0.10 mm becomes 0.15, a zero rapid-trigger step becomes
/// 0.01, a dead zone past 3.40 mm becomes 0.30.
pub const GEN2_MIN_TRAVEL_MM: f64 = 0.10;
pub const GEN2_MIN_RT_MM: f64 = 0.01;
pub const GEN2_MAX_DEAD_MM: f64 = 3.40;

/// Driveall reads and writes its 1024-byte block through
/// `driveall::rt_from_wire` and `driveall::rt_patch`, which scale by the
/// board's `rtPrecision`. It reaches the column conversions below only
/// for `slots`; the millimetre arms there assume hundredths and are not
/// a second scale for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Gen2,
    Yc500,
    Driveall,
}

impl Format {
    pub fn for_family(family: &str) -> Option<Format> {
        match family {
            "gen2" => Some(Format::Gen2),
            "yc500" => Some(Format::Yc500),
            "driveall" => Some(Format::Driveall),
            _ => None,
        }
    }

    pub fn slots(self) -> usize {
        match self {
            Format::Gen2 | Format::Driveall => 128,
            Format::Yc500 => 126,
        }
    }

    pub fn unit_mm(self) -> f64 {
        match self {
            Format::Gen2 | Format::Driveall => 0.01,
            Format::Yc500 => 0.1,
        }
    }

    pub fn wide(self, subop: u8) -> bool {
        self == Format::Gen2
            && matches!(
                subop,
                TRAVEL | LIFT | RT_PRESS | RT_LIFT | DKS_START | DEAD_BOTTOM
            )
    }

    /// Pages a GET of this column takes: wide columns are 256 bytes,
    /// byte columns 128 (126 on yc500, the second page spilling two
    /// bytes of the next column).
    pub fn get_pages(self, subop: u8) -> u8 {
        if self.wide(subop) {
            4
        } else {
            2
        }
    }

    /// One column out of its raw pages, one value a slot.
    pub fn decode(self, subop: u8, pages: &[u8]) -> Vec<u16> {
        if self.wide(subop) {
            (0..(pages.len() / 2).min(self.slots()))
                .map(|i| u16::from_le_bytes([pages[2 * i], pages[2 * i + 1]]))
                .collect()
        } else {
            pages
                .iter()
                .take(self.slots())
                .map(|&b| u16::from(b))
                .collect()
        }
    }

    pub fn to_wire(self, subop: u8, mm: f64) -> u16 {
        match self {
            Format::Gen2 | Format::Driveall => {
                let mm = match subop {
                    TRAVEL | LIFT | DKS_START => mm.max(GEN2_MIN_TRAVEL_MM),
                    RT_PRESS | RT_LIFT => mm.max(GEN2_MIN_RT_MM),
                    DEAD_BOTTOM => mm.clamp(0.0, GEN2_MAX_DEAD_MM),
                    _ => mm,
                };
                (mm / 0.01).round().clamp(0.0, 65535.0) as u16
            }
            Format::Yc500 => {
                let tenths = (mm * 10.0).round() as i32;
                let b = match subop {
                    DEAD_BOTTOM => YC500_FULL_TRAVEL - tenths - 1,
                    DKS_START => tenths - 2,
                    _ => tenths - 1,
                };
                b.clamp(0, 255) as u16
            }
        }
    }

    pub fn to_mm(self, subop: u8, wire: u16) -> f64 {
        match self {
            Format::Gen2 | Format::Driveall => f64::from(wire) * 0.01,
            Format::Yc500 => {
                let b = i32::from(wire);
                let tenths = match subop {
                    DEAD_BOTTOM => YC500_FULL_TRAVEL - (b + 1),
                    DKS_START => b + 2,
                    _ => b + 1,
                };
                f64::from(tenths.max(0)) / 10.0
            }
        }
    }

    pub fn get_payload(self, subop: u8, page: u8) -> [u8; 3] {
        [subop, 1, page]
    }

    /// One slot of one column. `value` is the u16 (wide) or the byte.
    pub fn set_one(self, subop: u8, slot: u8, last: bool, value: u16) -> Option<[u8; REPORT_LEN]> {
        if usize::from(slot) >= self.slots() {
            return None;
        }
        let mut buf = packet(SET, &[subop, 0, slot, last as u8], Checksum::Bit7);
        let bytes = value.to_le_bytes();
        buf[8] = bytes[0];
        if self.wide(subop) {
            buf[9] = bytes[1];
        }
        Some(buf)
    }

    /// One slot's four dynamic-keystroke action bytes. Single-slot only;
    /// the handler has no bulk form for this column.
    pub fn set_dks_actions(
        self,
        slot: u8,
        last: bool,
        actions: [u8; 4],
    ) -> Option<[u8; REPORT_LEN]> {
        if usize::from(slot) >= self.slots() {
            return None;
        }
        let mut buf = packet(SET, &[DKS_ACTIONS, 0, slot, last as u8], Checksum::Bit7);
        buf[8..12].copy_from_slice(&actions);
        Some(buf)
    }

    /// A whole column as bulk pages: 28 u16 or 56 bytes a page, the
    /// last page short, the `last` flag on the final page only.
    pub fn set_all(self, subop: u8, values: &[u16], last: bool) -> Vec<[u8; REPORT_LEN]> {
        let values = &values[..values.len().min(self.slots())];
        let wire: Vec<u8> = if self.wide(subop) {
            values.iter().flat_map(|v| v.to_le_bytes()).collect()
        } else {
            values.iter().map(|v| *v as u8).collect()
        };
        let pages = wire.chunks(56).collect::<Vec<_>>();
        let n = pages.len();
        pages
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let final_page = i + 1 == n;
                let mut buf = packet(
                    SET,
                    &[subop, 1, i as u8, (last && final_page) as u8],
                    Checksum::Bit7,
                );
                buf[8..8 + chunk.len()].copy_from_slice(chunk);
                buf
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySwitch {
    pub slot: u8,
    /// Bits 0..6 of the mode byte; 0 is a plain key.
    pub kind: u8,
    pub rapid_trigger: bool,
    pub travel: f64,
    pub lift: f64,
    pub rt_press: f64,
    pub rt_lift: f64,
    pub dead_bottom: f64,
    /// Dynamic keystroke: the second actuation point.
    #[serde(default)]
    pub dks_start: f64,
    /// Dynamic keystroke: one byte per sub-layer, four 2-bit cells.
    #[serde(default)]
    pub dks_actions: [u8; 4],
    /// Mod-tap: milliseconds held before the key counts as held.
    #[serde(default)]
    pub mt_time_ms: u16,
    /// Snap: the partner's slot, 255 for none.
    #[serde(default = "no_partner")]
    pub snap_partner: u8,
}

fn no_partner() -> u8 {
    0xFF
}

impl KeySwitch {
    pub fn mode_byte(&self) -> u8 {
        (self.kind & 0x7F)
            | if self.rapid_trigger {
                MODE_RAPID_TRIGGER
            } else {
                0
            }
    }

    /// Column value for a sub-op, clamped the way the firmware would.
    pub fn wire(&self, f: Format, subop: u8) -> u16 {
        match subop {
            MODE => u16::from(self.mode_byte()),
            TRAVEL => f.to_wire(subop, self.travel),
            LIFT => f.to_wire(subop, self.lift),
            RT_PRESS => f.to_wire(subop, self.rt_press),
            RT_LIFT => f.to_wire(subop, self.rt_lift),
            DEAD_BOTTOM => f.to_wire(subop, self.dead_bottom),
            DKS_START => f.to_wire(subop, self.dks_start),
            MT_TIME => (self.mt_time_ms / 10).min(255),
            SNAP_PARTNER => u16::from(self.snap_partner),
            _ => 0,
        }
    }
}

/// The `0x1A` record. Bytes as the 1618 handler stores them: 3 mode,
/// 4 travel, 5 all-keys flag, 6 slot, 8 release, 9 and 10 rapid
/// trigger, 11 dynamic keystroke start, 12..15 its actions, 16 mod-tap
/// time, 25 bottom dead zone. Bytes 1 and 2 are stored and never
/// read. Values are yc500 column bytes.
pub fn global_packet(key: &KeySwitch, all: bool) -> [u8; REPORT_LEN] {
    let f = Format::Yc500;
    let mut buf = packet(
        SET_GLOBAL,
        &[
            0,
            0,
            key.mode_byte(),
            key.wire(f, TRAVEL) as u8,
            all as u8,
            if all { 0 } else { key.slot },
        ],
        Checksum::Bit7,
    );
    buf[8] = key.wire(f, LIFT) as u8;
    buf[9] = key.wire(f, RT_PRESS) as u8;
    buf[10] = key.wire(f, RT_LIFT) as u8;
    buf[11] = key.wire(f, DKS_START) as u8;
    buf[12..16].copy_from_slice(&key.dks_actions);
    buf[16] = key.wire(f, MT_TIME) as u8;
    buf[25] = key.wire(f, DEAD_BOTTOM) as u8;
    buf
}

/// What the 1618 and 1466 apply routines write when there is no saved
/// block: 1.9 mm actuation, 2.9 release, 0.3 rapid trigger steps,
/// 0.6 mm dead zone, 0.4 mm dynamic start, 300 ms mod-tap.
pub fn yc500_default(slot: u8) -> KeySwitch {
    let f = Format::Yc500;
    KeySwitch {
        slot,
        kind: KIND_NORMAL,
        rapid_trigger: false,
        travel: f.to_mm(TRAVEL, 18),
        lift: f.to_mm(LIFT, 28),
        rt_press: f.to_mm(RT_PRESS, 2),
        rt_lift: f.to_mm(RT_LIFT, 2),
        dead_bottom: f.to_mm(DEAD_BOTTOM, 33),
        dks_start: f.to_mm(DKS_START, 2),
        dks_actions: [0; 4],
        mt_time_ms: 300,
        snap_partner: 0xFF,
    }
}

/// The columns one key's write touches: the plain six, then what its
/// kind needs.
pub fn columns_for(kind: u8) -> Vec<u8> {
    let mut cols = WRITE_COLUMNS.to_vec();
    match kind {
        KIND_DKS => cols.extend([DKS_START, DKS_ACTIONS]),
        KIND_MOD_TAP => cols.push(MT_TIME),
        KIND_SNAP => cols.push(SNAP_PARTNER),
        _ => {}
    }
    cols
}

/// The travel columns a plain write touches, in the vendor's order,
/// mode first.
pub const WRITE_COLUMNS: [u8; 6] = [MODE, TRAVEL, LIFT, RT_PRESS, RT_LIFT, DEAD_BOTTOM];

pub const READ_COLUMNS: [u8; 9] = [
    MODE,
    TRAVEL,
    LIFT,
    RT_PRESS,
    RT_LIFT,
    DEAD_BOTTOM,
    DKS_START,
    MT_TIME,
    SNAP_PARTNER,
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchSettings {
    pub format: Format,
    pub unit_mm: f64,
    pub keys: Vec<KeySwitch>,
}

/// Columns as read, keyed by sub-op, into per-key records. `dks_all`
/// is the sub-op 10 read: four blocks of one byte a slot.
pub fn assemble(f: Format, columns: &[(u8, Vec<u16>)], dks_all: &[u8]) -> SwitchSettings {
    let col = |subop: u8, s: usize| -> u16 {
        columns
            .iter()
            .find(|(op, _)| *op == subop)
            .and_then(|(_, v)| v.get(s).copied())
            .unwrap_or(0)
    };
    let block = match f {
        Format::Gen2 | Format::Driveall => 128,
        Format::Yc500 => 126,
    };
    let keys = (0..f.slots())
        .map(|s| {
            let mode = col(MODE, s) as u8;
            let mut actions = [0u8; 4];
            for (i, a) in actions.iter_mut().enumerate() {
                *a = dks_all.get(i * block + s).copied().unwrap_or(0);
            }
            KeySwitch {
                slot: s as u8,
                kind: mode & 0x7F,
                rapid_trigger: mode & MODE_RAPID_TRIGGER != 0,
                travel: f.to_mm(TRAVEL, col(TRAVEL, s)),
                lift: f.to_mm(LIFT, col(LIFT, s)),
                rt_press: f.to_mm(RT_PRESS, col(RT_PRESS, s)),
                rt_lift: f.to_mm(RT_LIFT, col(RT_LIFT, s)),
                dead_bottom: f.to_mm(DEAD_BOTTOM, col(DEAD_BOTTOM, s)),
                dks_start: f.to_mm(DKS_START, col(DKS_START, s)),
                dks_actions: actions,
                mt_time_ms: col(MT_TIME, s) * 10,
                snap_partner: col(SNAP_PARTNER, s) as u8,
            }
        })
        .collect();
    SwitchSettings {
        format: f,
        unit_mm: f.unit_mm(),
        keys,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> KeySwitch {
        KeySwitch {
            slot: 0,
            kind: 0,
            rapid_trigger: true,
            travel: 0.05,
            lift: 1.0,
            rt_press: 0.0,
            rt_lift: 0.3,
            dead_bottom: 9.0,
            dks_start: 0.7,
            dks_actions: [0; 4],
            mt_time_ms: 300,
            snap_partner: 0xFF,
        }
    }

    #[test]
    fn single_slot_packet_matches_the_handler() {
        let g = Format::Gen2;
        let p = g.set_one(TRAVEL, 5, true, 200).unwrap();
        assert_eq!(&p[..5], &[SET, TRAVEL, 0, 5, 1]);
        assert_eq!((p[8], p[9]), (200, 0));
        assert_eq!(
            p[7],
            0xFF - (p[..7].iter().map(|&b| u32::from(b)).sum::<u32>() & 0xFF) as u8
        );
        assert!(
            g.set_one(TRAVEL, 128, true, 1).is_none(),
            "slot 128 would hit the hi array"
        );
        let m = g.set_one(MODE, 3, false, 0x80).unwrap();
        assert_eq!((m[4], m[8], m[9]), (0, 0x80, 0));
        let y = Format::Yc500;
        assert!(
            y.set_one(TRAVEL, 126, true, 1).is_none(),
            "1618 keeps 126 slots"
        );
        let p = y.set_one(TRAVEL, 125, true, 0x1FF).unwrap();
        assert_eq!((p[8], p[9]), (0xFF, 0), "yc500 columns are bytes");
        let d = g.set_dks_actions(7, true, [1, 2, 3, 4]).unwrap();
        assert_eq!(&d[..5], &[SET, DKS_ACTIONS, 0, 7, 1]);
        assert_eq!(&d[8..12], &[1, 2, 3, 4]);
    }

    #[test]
    fn bulk_pages_are_28_wide_or_56_narrow_with_last_on_the_final_page() {
        let g = Format::Gen2;
        let vals = [200u16; 128];
        let wide = g.set_all(TRAVEL, &vals, true);
        assert_eq!(wide.len(), 5);
        assert_eq!(wide[4][3], 4);
        assert!(wide[..4].iter().all(|p| p[4] == 0) && wide[4][4] == 1);
        assert_eq!(&wide[0][8..12], &[200, 0, 200, 0]);
        let narrow = g.set_all(MODE, &[0x80; 128], false);
        assert_eq!(narrow.len(), 3);
        assert!(narrow.iter().all(|p| p[4] == 0));
        assert_eq!(narrow[2][8 + 15], 0x80);
        assert_eq!(narrow[2][8 + 16], 0);
        // 1618: 56, 56, 14.
        let y = Format::Yc500.set_all(TRAVEL, &[18; 128], true);
        assert_eq!(y.len(), 3);
        assert_eq!(y[2][8 + 13], 18);
        assert_eq!(y[2][8 + 14], 0);
        assert_eq!(y[2][4], 1);
    }

    #[test]
    fn gen2_units_and_clamps_follow_the_firmware() {
        let g = Format::Gen2;
        assert_eq!(g.to_wire(TRAVEL, 2.0), 200);
        assert_eq!(g.to_mm(TRAVEL, 50), 0.5);
        let k = key();
        assert_eq!(k.wire(g, TRAVEL), 10);
        assert_eq!(k.wire(g, RT_PRESS), 1);
        assert_eq!(k.wire(g, DEAD_BOTTOM), 340);
        assert_eq!(k.wire(g, MODE), 0x80);
        assert_eq!(k.wire(g, DKS_START), 70);
        assert_eq!(k.wire(g, MT_TIME), 30);
        assert_eq!(k.wire(g, SNAP_PARTNER), 0xFF);
        assert_eq!(g.decode(TRAVEL, &[0u8; 256]).len(), 128);
    }

    /// 1618 evaluator: a key fires when live travel (tenths) exceeds the
    /// byte, so the 18/28 defaults are 1.9 and 2.9 mm and the dead
    /// zone byte 33 is 4.0 - 3.4 = 0.6 mm from the bottom.
    #[test]
    fn yc500_units_carry_the_one_tenth_offset() {
        let y = Format::Yc500;
        assert_eq!(y.to_mm(TRAVEL, 18), 1.9);
        assert_eq!(y.to_mm(LIFT, 28), 2.9);
        assert_eq!(y.to_mm(RT_PRESS, 2), 0.3);
        assert_eq!(y.to_mm(DEAD_BOTTOM, 33), 0.6);
        assert_eq!(y.to_mm(DKS_START, 2), 0.4);
        assert_eq!(y.to_wire(TRAVEL, 1.9), 18);
        assert_eq!(y.to_wire(TRAVEL, 0.0), 0);
        assert_eq!(y.to_wire(DEAD_BOTTOM, 0.6), 33);
        assert_eq!(y.to_wire(DKS_START, 0.4), 2);
        let pages = [7u8; 128];
        assert_eq!(y.decode(TRAVEL, &pages).len(), 126);
        assert_eq!(y.get_pages(TRAVEL), 2);
        assert_eq!(Format::Gen2.get_pages(TRAVEL), 4);
    }

    #[test]
    fn global_record_lands_where_the_1618_handler_reads() {
        let mut k = yc500_default(9);
        k.rapid_trigger = true;
        k.kind = KIND_MOD_TAP;
        let p = global_packet(&k, false);
        assert_eq!(&p[..7], &[SET_GLOBAL, 0, 0, 0x83, 18, 0, 9]);
        assert_eq!(&p[8..12], &[28, 2, 2, 2]);
        assert_eq!(p[16], 30);
        assert_eq!(p[25], 33);
        assert_eq!(global_packet(&k, true)[5..7], [1, 0]);
        assert_eq!(columns_for(KIND_DKS).len(), 8);
        assert_eq!(columns_for(KIND_NORMAL).len(), 6);
    }

    #[test]
    fn assemble_reads_dks_blocks_by_format() {
        let mut dks = vec![0u8; 512];
        dks[128 * 2 + 5] = 0x55;
        let s = assemble(Format::Gen2, &[(MODE, vec![0x82; 128])], &dks);
        assert_eq!(s.keys[5].dks_actions, [0, 0, 0x55, 0]);
        assert_eq!(s.keys[5].kind, KIND_DKS);
        assert!(s.keys[5].rapid_trigger);
        let mut dks = vec![0u8; 504];
        dks[126 * 3 + 1] = 9;
        let s = assemble(Format::Yc500, &[], &dks);
        assert_eq!(s.keys.len(), 126);
        assert_eq!(s.keys[1].dks_actions[3], 9);
        assert_eq!(s.unit_mm, 0.1);
    }
}
