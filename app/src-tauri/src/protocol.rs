// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Wire protocol for ROYUAN (VID 0x3151) keyboards: 64-byte HID feature
//! reports, report ID 0, on the vendor collection (usage page 0xFFFF, usage 2).
//! Opcodes below are the CommonKbYc500 family (X86 = device 1967),
//! hardware-verified. Bulk reads reply with raw pages, no opcode echo.

/// ROYUAN's own USB vendor ID, which most of these boards use. It is not the
/// only one: see `registry::vendor_ids()`, which is what discovery scans for.
pub const VENDOR_ID: u16 = 0x3151;
pub const USAGE_PAGE: u16 = 0xFFFF;
pub const USAGE: u16 = 0x0002;
pub const REPORT_LEN: usize = 64;

/// Bit7: byte7 = 0xFF - sum(bytes 0..=6). Bit8: byte8 over 0..=7.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checksum {
    Bit7,
    Bit8,
    None,
}

pub fn apply_checksum(buf: &mut [u8; REPORT_LEN], mode: Checksum) {
    match mode {
        Checksum::Bit7 => {
            let sum: u32 = buf[..7].iter().map(|&b| b as u32).sum();
            buf[7] = 0xFF - (sum & 0xFF) as u8;
        }
        Checksum::Bit8 => {
            let sum: u32 = buf[..8].iter().map(|&b| b as u32).sum();
            buf[8] = 0xFF - (sum & 0xFF) as u8;
        }
        Checksum::None => {}
    }
}

/// All Bit7 except SET_LEDPARAM / SET_SLEDPARAM (Bit8).
#[allow(dead_code)]
pub mod cmd {
    pub const SET_RESET: u8 = 0x02; // firmware needs ~4 s after
    pub const SET_PROFILE: u8 = 0x05;
    pub const SET_KBOPTION: u8 = 0x06; // [op, 0, flags, fnMatrix, powerSave]
    pub const SET_LEDPARAM: u8 = 0x07;
    pub const SET_SLEDPARAM: u8 = 0x08;
    pub const SET_KEYMATRIX: u8 = 0x09; // 9 × 56-byte pages
    pub const SET_MACRO_PAGED: u8 = 0x0B;
    pub const SET_USERPIC: u8 = 0x0C; // 7 × 56-byte pages
    pub const SET_FN: u8 = 0x10;
    pub const SET_DEBOUNCE: u8 = 0x11; // [op, 0, value]
    pub const SET_SLEEPTIME: u8 = 0x12; // u16 LE ×4 at bytes 8..16
    pub const SET_KEY_ONE: u8 = 0x13; // [profile, slot], value at 8..12
    pub const SET_FN_ONE: u8 = 0x15;
    pub const SET_MACRO: u8 = 0x16; // NB: 0x0B is the base class value
    pub const SET_AUTO_OS: u8 = 0x17; // [op, 0|1]

    pub const GET_PROFILE: u8 = 0x85; // reply[1]
    pub const GET_KBOPTION: u8 = 0x86; // flags in reply[2..5]
    pub const GET_LEDPARAM: u8 = 0x87;
    pub const GET_SLEDPARAM: u8 = 0x88;
    pub const GET_KEYMATRIX: u8 = 0x89; // [profile, page 0..8) -> raw 64 B
    pub const GET_MACRO: u8 = 0x8B; // [slot, page 0..4) -> raw 64 B
    pub const GET_USERPIC: u8 = 0x8C;
    pub const GET_USB_VERSION: u8 = 0x8F; // identify handshake, all families
    pub const GET_FN: u8 = 0x90;
    pub const GET_DEBOUNCE: u8 = 0x91; // reply[2]
    pub const GET_SLEEPTIME: u8 = 0x92; // u16 LE ×4 at bytes 1..9, NOT 8..16
    pub const GET_AUTO_OS: u8 = 0x97; // reply[1] == 1
    pub const GET_REVISION: u8 = 0x80; // (reply[2] << 8) | reply[1]
}

// Report rate is not configurable on this family: the vendor's own
// setReportRate is a stub returning false, with no override in the chain.

/// Per-family opcode table. The two families overlap: several of one
/// family's write opcodes land on a *different* live register of the other
/// (e.g. yc500 SET_KEYMATRIX 0x09 is gen2 SET_KBOPTION), so every
/// family-dependent command must resolve through this table rather than the
/// `cmd` constants. `None` = the family has no such command, or its opcode
/// is not documented. LEDPARAM, FN, GET_MACRO, USERPIC and identify are
/// identical across both.
#[derive(Debug)]
pub struct FamilyCmds {
    pub name: &'static str,
    pub set_profile: u8,
    pub get_profile: u8,
    pub set_keymatrix: u8,
    pub get_keymatrix: u8,
    /// yc500 only. gen2 reaches the same thing through SET_KEYMATRIX, so it
    /// leaves these None and uses the `gen2` builders.
    pub set_key_one: Option<u8>,
    pub set_fn_one: Option<u8>,
    pub set_debounce: u8,
    pub get_debounce: u8,
    pub set_sleeptime: u8,
    pub get_sleeptime: u8,
    pub set_kboption: u8,
    pub get_kboption: u8,
    pub set_macro: u8,
    pub set_reset: u8,
    pub report_rate: Option<(u8, u8)>,
    pub get_revision: Option<u8>,
    pub auto_os: Option<(u8, u8)>,
    pub sled: Option<(u8, u8)>,
    /// Wire offset of the debounce value on SET, and in the GET reply.
    /// yc500 pads with a zero byte; gen2 does not.
    pub debounce_at: usize,
    /// Wire offset of the four u16 sleep values in the GET reply. yc500's
    /// decoder disagrees with its own encoder (1..9 vs 8..16); gen2 is
    /// symmetric.
    pub sleep_reply_at: usize,
    /// Keyboard options. gen2's reply is a set of decoded fields rather than
    /// yc500's flags bitfield, and its meanings are not established, so the
    /// whole feature is withheld there rather than guessed at.
    pub kboption: Option<(u8, u8)>,
}

pub const YC500_CMDS: FamilyCmds = FamilyCmds {
    name: "yc500",
    set_profile: cmd::SET_PROFILE,
    get_profile: cmd::GET_PROFILE,
    set_keymatrix: cmd::SET_KEYMATRIX,
    get_keymatrix: cmd::GET_KEYMATRIX,
    set_key_one: Some(cmd::SET_KEY_ONE),
    set_fn_one: Some(cmd::SET_FN_ONE),
    set_debounce: cmd::SET_DEBOUNCE,
    get_debounce: cmd::GET_DEBOUNCE,
    set_sleeptime: cmd::SET_SLEEPTIME,
    get_sleeptime: cmd::GET_SLEEPTIME,
    set_kboption: cmd::SET_KBOPTION,
    get_kboption: cmd::GET_KBOPTION,
    set_macro: cmd::SET_MACRO,
    set_reset: cmd::SET_RESET,
    report_rate: None,
    get_revision: Some(cmd::GET_REVISION),
    auto_os: Some((cmd::SET_AUTO_OS, cmd::GET_AUTO_OS)),
    sled: Some((cmd::SET_SLEDPARAM, cmd::GET_SLEDPARAM)),
    debounce_at: 2,
    sleep_reply_at: 1,
    kboption: Some((cmd::SET_KBOPTION, cmd::GET_KBOPTION)),
};

/// Confirmed against the X65HE firmware (2268_v309), not against hardware.
/// Revision, auto-OS and edge light share yc500's opcodes. Single-slot key
/// writes reuse SET_KEYMATRIX with byte 2 below 255 (255 selects paged bulk
/// mode), so they go through the gen2 builders below, not `set_key_one`.
pub const GEN2_CMDS: FamilyCmds = FamilyCmds {
    name: "gen2",
    set_profile: 0x04,
    get_profile: 0x84,
    set_keymatrix: 0x0A,
    get_keymatrix: 0x8A,
    set_key_one: None,
    set_fn_one: None,
    set_debounce: 0x06,
    get_debounce: 0x86,
    set_sleeptime: 0x11,
    get_sleeptime: 0x91,
    set_kboption: 0x09,
    get_kboption: 0x89,
    set_macro: 0x0B,
    set_reset: 0x01,
    report_rate: Some((0x03, 0x83)),
    get_revision: Some(cmd::GET_REVISION),
    auto_os: Some((cmd::SET_AUTO_OS, cmd::GET_AUTO_OS)),
    sled: Some((cmd::SET_SLEDPARAM, cmd::GET_SLEDPARAM)),
    // firmware 2268_v309: SET reads the value at wire byte 1 and GET replies
    // there too -- sending yc500's [op, 0, value] would write debounce 0.
    debounce_at: 1,
    // firmware 2268_v309: GET_SLEEPTIME writes the u16s back at 8..16, the
    // same offsets the SET uses.
    sleep_reply_at: 8,
    kboption: None,
};

/// gen2 keymap packets, read out of the X65HE firmware's own handlers. The
/// shapes differ from yc500 beyond opcodes: reads and bulk writes carry a
/// 0xFF sentinel in byte 2, single-slot writes put the slot there instead,
/// and Fn-layer packets lead with a host-OS byte (0 win, 1 mac, 2 android,
/// 3 ios).
pub mod gen2 {
    use super::{apply_checksum, packet, Checksum, GEN2_CMDS, REPORT_LEN};

    const BULK_SENTINEL: u8 = 0xFF;
    const FN_SYS_WIN: u8 = 0;

    pub fn keymatrix_read_payload(profile: u8, page: u8) -> [u8; 4] {
        [profile, BULK_SENTINEL, page, FN_SYS_WIN]
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
}

/// yc500's paged bulk keymap write, decoded from the vendor's yc500 class:
/// [0x09, profile, 0xF8, 1, page, 0, 0, ck7] + 56 data bytes, 9 pages.
/// Documented for completeness; sharkfin's UI uses the verified single-slot
/// write instead.
pub fn yc500_bulk_keymatrix_packets(profile: u8, matrix: &[u8; 512]) -> Vec<[u8; REPORT_LEN]> {
    (0..9u8)
        .map(|page| {
            let mut buf = [0u8; REPORT_LEN];
            buf[0] = cmd::SET_KEYMATRIX;
            buf[1] = profile;
            buf[2] = 0xF8;
            buf[3] = 1;
            buf[4] = page;
            apply_checksum(&mut buf, Checksum::Bit7);
            let start = page as usize * 56;
            let end = (start + 56).min(matrix.len());
            buf[8..8 + (end - start)].copy_from_slice(&matrix[start..end]);
            buf
        })
        .collect()
}

pub fn family_cmds(family: &str) -> Option<&'static FamilyCmds> {
    match family {
        "yc500" => Some(&YC500_CMDS),
        "gen2" => Some(&GEN2_CMDS),
        _ => None,
    }
}

/// Sleep timeouts, seconds. Writes land at bytes 8..16 but reads come back at
/// bytes 1..9 -- the vendor's encode and decode genuinely disagree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepTimes {
    pub sleep_bt: u16,
    pub sleep_24: u16,
    pub deep_bt: u16,
    pub deep_24: u16,
}

impl SleepTimes {
    pub fn to_packet(self) -> [u8; REPORT_LEN] {
        self.to_packet_as(cmd::SET_SLEEPTIME)
    }

    pub fn to_packet_as(self, opcode: u8) -> [u8; REPORT_LEN] {
        let mut buf = packet(opcode, &[], Checksum::Bit7);
        for (i, v) in [self.sleep_bt, self.sleep_24, self.deep_bt, self.deep_24]
            .iter()
            .enumerate()
        {
            buf[8 + i * 2..10 + i * 2].copy_from_slice(&v.to_le_bytes());
        }
        buf
    }

    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        Self::from_reply_expecting(reply, cmd::GET_SLEEPTIME, 1)
    }

    /// `base` is the family's reply offset: yc500 answers at 1..9 even though
    /// it accepts writes at 8..16; gen2 answers at 8..16.
    pub fn from_reply_expecting(reply: &[u8], opcode: u8, base: usize) -> Option<Self> {
        if reply.len() < base + 8 || reply[0] != opcode {
            return None;
        }
        let at = |i: usize| u16::from_le_bytes([reply[base + i], reply[base + i + 1]]);
        Some(SleepTimes {
            sleep_bt: at(0),
            sleep_24: at(2),
            deep_bt: at(4),
            deep_24: at(6),
        })
    }
}

/// Side/edge light (SET_SLEDPARAM 0x08 / GET 0x88). Same byte layout as
/// LEDPARAM but its own small mode table, and speed is NOT inverted here.
/// Modes: 0 off, 1 static, 2 breathing, 3 neon, 4 wave, 5 snake.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct SledParam {
    pub mode: u8,
    pub speed: u8,
    pub brightness: u8,
    pub option: u8,
    pub dazzle: bool,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

const MODE_NEON: u8 = 3;

/// Near-black stores fine but renders as "all LEDs off" (verified on an X86),
/// which reads as a dead board. Backlight-off is KBOPTION's job; a colour
/// write is floored to stay visible.
const COLOR_FLOOR: u8 = 8;

fn floor_black(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    if r.max(g).max(b) < COLOR_FLOOR {
        (COLOR_FLOOR, COLOR_FLOOR, COLOR_FLOOR)
    } else {
        (r, g, b)
    }
}

impl SledParam {
    pub fn to_packet(self) -> [u8; REPORT_LEN] {
        let (mut r, mut g, mut b) = floor_black(self.r, self.g, self.b);
        if (r, g, b) == (0xFF, 0xFF, 0xFF) {
            (r, g, b) = (0xFA, 0xFA, 0xFA);
        }
        let flags4 = if self.mode == MODE_NEON {
            FLAG_DAZZLE
        } else {
            (self.option << 4) | if self.dazzle { FLAG_DAZZLE } else { FLAG_FIXED }
        };
        packet(
            cmd::SET_SLEDPARAM,
            &[self.mode, self.speed, self.brightness, flags4, r, g, b],
            Checksum::Bit8,
        )
    }

    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        if reply.len() < 8 || reply[0] != cmd::GET_SLEDPARAM {
            return None;
        }
        let flags = reply[4];
        let nibble = flags & 0x0F;
        let (mut r, mut g, mut b) = (reply[5], reply[6], reply[7]);
        if (r, g, b) == (0xFA, 0xFA, 0xFA) {
            (r, g, b) = (0xFF, 0xFF, 0xFF);
        }
        let dazzle = nibble == FLAG_DAZZLE;
        if !dazzle && nibble != FLAG_FIXED {
            if let Some(&(pr, pg, pb)) = COMMON_COLORS.get(nibble as usize) {
                (r, g, b) = (pr, pg, pb);
            }
        }
        Some(SledParam {
            mode: reply[1],
            speed: reply[2].min(4),
            brightness: reply[3].min(4),
            option: flags >> 4,
            dazzle,
            r,
            g,
            b,
        })
    }
}

/// Per-key colours: 128 slots × RGB = 384 bytes, indexed by matrix slot.
pub const PER_KEY_BYTES: usize = 384;
const USERPIC_PAGE_DATA: usize = 56;

/// Upload page `page` (0..7) of the colour blob. Header carries the total
/// length and the page index at byte 4; data starts at byte 8.
pub fn userpic_write_packet(page: u8, blob: &[u8]) -> [u8; REPORT_LEN] {
    let len = PER_KEY_BYTES as u16;
    let mut buf = packet(
        cmd::SET_USERPIC,
        &[0, (len & 0xFF) as u8, (len >> 8) as u8, page, 0, 0],
        Checksum::Bit7,
    );
    let start = page as usize * USERPIC_PAGE_DATA;
    let end = (start + USERPIC_PAGE_DATA).min(blob.len());
    if start < blob.len() {
        buf[8..8 + (end - start)].copy_from_slice(&blob[start..end]);
    }
    buf
}

/// Read side puts the page index at byte 2, not byte 4, and returns six
/// 64-byte raw pages.
pub fn userpic_read_packet(page: u8) -> [u8; REPORT_LEN] {
    packet(cmd::GET_USERPIC, &[0, page], Checksum::Bit7)
}

/// Onboard macros: 50 slots × 256 bytes. Hardware-verified on an X86 (write,
/// read-back, restore). The write opcode is the subclass override 0x16 used
/// with the base class's packet format -- the base declares 0x0B and the
/// method that sends it reads the field at call time, so the subclass value
/// wins.
pub const MACRO_SLOTS: u8 = 50;
pub const MACRO_BYTES: usize = 256;
const MACRO_PAGE_DATA: usize = 56;

const MOUSE_BTN_BASE: u8 = 0xF0; // ..=0xF4: L, R, M, back, forward
const MOUSE_MOVE: u8 = 0xF9;
const KEY_USAGE_MAX: u8 = 0xEF;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MacroEvent {
    #[serde(rename_all = "camelCase")]
    Key {
        usage: u8,
        pressed: bool,
        delay_ms: u16,
    },
    #[serde(rename_all = "camelCase")]
    MouseButton {
        button: u8,
        pressed: bool,
        delay_ms: u16,
    },
    #[serde(rename_all = "camelCase")]
    MouseMove { dx: i8, dy: i8, delay_ms: u8 },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Macro {
    pub repeat: u16,
    pub events: Vec<MacroEvent>,
}

/// Short form [code, pressed<<7 | delay] only when the delay fits in 7 bits
/// and is non-zero: a low nibble of zero is the long-form marker, so a
/// zero delay must take the 4-byte form to survive decoding.
fn encode_press(out: &mut Vec<u8>, code: u8, pressed: bool, delay_ms: u16) {
    let hi = (pressed as u8) << 7;
    if (1..=127).contains(&delay_ms) {
        out.extend_from_slice(&[code, hi | delay_ms as u8]);
    } else {
        out.extend_from_slice(&[code, hi]);
        out.extend_from_slice(&delay_ms.to_le_bytes());
    }
}

impl Macro {
    pub fn to_blob(&self) -> Result<[u8; MACRO_BYTES], String> {
        let mut stream = Vec::new();
        for e in &self.events {
            match *e {
                MacroEvent::Key {
                    usage,
                    pressed,
                    delay_ms,
                } => {
                    if !(0x04..=KEY_USAGE_MAX).contains(&usage) {
                        return Err(format!("key usage 0x{usage:02X} out of range"));
                    }
                    encode_press(&mut stream, usage, pressed, delay_ms);
                }
                MacroEvent::MouseButton {
                    button,
                    pressed,
                    delay_ms,
                } => {
                    if button > 4 {
                        return Err(format!("mouse button {button} out of range"));
                    }
                    encode_press(&mut stream, MOUSE_BTN_BASE + button, pressed, delay_ms);
                }
                MacroEvent::MouseMove { dx, dy, delay_ms } => {
                    stream.extend_from_slice(&[MOUSE_MOVE, delay_ms, dx as u8, dy as u8]);
                }
            }
        }
        // 2-byte repeat header + stream + 4-byte zero terminator
        if stream.len() > MACRO_BYTES - 6 {
            return Err(format!(
                "macro too long: {} bytes of events, max {}",
                stream.len(),
                MACRO_BYTES - 6
            ));
        }
        let mut blob = [0u8; MACRO_BYTES];
        blob[..2].copy_from_slice(&self.repeat.to_le_bytes());
        blob[2..2 + stream.len()].copy_from_slice(&stream);
        Ok(blob)
    }

    /// Lenient: stops at the zero terminator, the end of the blob, or the
    /// first byte that is not a valid event code.
    pub fn from_blob(blob: &[u8; MACRO_BYTES]) -> Self {
        let repeat = u16::from_le_bytes([blob[0], blob[1]]);
        let mut events = Vec::new();
        let mut i = 2;
        while i + 1 < MACRO_BYTES {
            let code = blob[i];
            if code == 0 {
                break;
            }
            if code == MOUSE_MOVE {
                if i + 3 >= MACRO_BYTES {
                    break;
                }
                events.push(MacroEvent::MouseMove {
                    delay_ms: blob[i + 1],
                    dx: blob[i + 2] as i8,
                    dy: blob[i + 3] as i8,
                });
                i += 4;
                continue;
            }
            let pressed = blob[i + 1] & 0x80 != 0;
            let low = blob[i + 1] & 0x7F;
            let delay_ms = if low != 0 {
                let d = low as u16;
                i += 2;
                d
            } else {
                if i + 3 >= MACRO_BYTES {
                    break;
                }
                let d = u16::from_le_bytes([blob[i + 2], blob[i + 3]]);
                i += 4;
                d
            };
            if (0x04..=KEY_USAGE_MAX).contains(&code) {
                events.push(MacroEvent::Key {
                    usage: code,
                    pressed,
                    delay_ms,
                });
            } else if (MOUSE_BTN_BASE..=MOUSE_BTN_BASE + 4).contains(&code) {
                events.push(MacroEvent::MouseButton {
                    button: code - MOUSE_BTN_BASE,
                    pressed,
                    delay_ms,
                });
            } else {
                break;
            }
        }
        Macro { repeat, events }
    }
}

/// Pages actually transmitted: the vendor sends only the 56-byte windows
/// that contain a non-zero byte (the blob is dense, so they form a prefix).
pub fn macro_pages(blob: &[u8; MACRO_BYTES]) -> u8 {
    let last = blob
        .chunks(MACRO_PAGE_DATA)
        .rposition(|w| w.iter().any(|&b| b != 0));
    last.map(|p| p as u8 + 1).unwrap_or(1)
}

/// `opcode` is family-dependent (yc500 0x16, gen2 0x0B); the packet shape is
/// the shared base class's either way.
pub fn macro_write_packet(
    opcode: u8,
    slot: u8,
    page: u8,
    last: bool,
    blob: &[u8; MACRO_BYTES],
) -> [u8; REPORT_LEN] {
    let mut buf = packet(
        opcode,
        &[slot, page, MACRO_PAGE_DATA as u8, last as u8, 0],
        Checksum::Bit7,
    );
    let start = page as usize * MACRO_PAGE_DATA;
    let end = (start + MACRO_PAGE_DATA).min(MACRO_BYTES);
    if start < MACRO_BYTES {
        buf[8..8 + (end - start)].copy_from_slice(&blob[start..end]);
    }
    buf
}

/// Keyboard option bits (reply[2]). The vendor's `system` bit is written at
/// position 2 but read at position 1; sharkfin never writes it -- Win/Mac is
/// board-side state. Keyboard-lock is deliberately not exposed.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbOptions {
    pub win_lock: bool,
    pub wasd_swap: bool,
    pub led_off: bool,
    pub side_led_off: bool,
    pub mac_mode: bool, // read-only
}

impl KbOptions {
    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        Self::from_reply_expecting(reply, cmd::GET_KBOPTION)
    }

    pub fn from_reply_expecting(reply: &[u8], opcode: u8) -> Option<Self> {
        if reply.len() < 5 || reply[0] != opcode {
            return None;
        }
        let f = reply[2];
        Some(KbOptions {
            win_lock: f & 1 != 0,
            mac_mode: f & 2 != 0,
            wasd_swap: f & 8 != 0,
            led_off: f & 16 != 0,
            side_led_off: f & 32 != 0,
        })
    }

    /// Preserves the untouched high bits read back from the device.
    pub fn to_packet(self, preserved: u8, fn_matrix: u8, power_save: u8) -> [u8; REPORT_LEN] {
        self.to_packet_as(cmd::SET_KBOPTION, preserved, fn_matrix, power_save)
    }

    pub fn to_packet_as(
        self,
        opcode: u8,
        preserved: u8,
        fn_matrix: u8,
        power_save: u8,
    ) -> [u8; REPORT_LEN] {
        let flags = (preserved & 0b1100_0000)
            | (self.win_lock as u8)
            | ((self.wasd_swap as u8) << 3)
            | ((self.led_off as u8) << 4)
            | ((self.side_led_off as u8) << 5);
        packet(opcode, &[0, flags, fn_matrix, power_save], Checksum::Bit7)
    }
}

pub fn packet(opcode: u8, payload: &[u8], checksum: Checksum) -> [u8; REPORT_LEN] {
    let mut buf = [0u8; REPORT_LEN];
    buf[0] = opcode;
    buf[1..1 + payload.len()].copy_from_slice(payload);
    apply_checksum(&mut buf, checksum);
    buf
}

/// 0x8F reply: [0x8F, device_id as u32 LE, ..].
pub fn parse_device_id(reply: &[u8]) -> Option<u32> {
    if reply.len() >= 5 && reply[0] == cmd::GET_USB_VERSION {
        Some(u32::from_le_bytes([reply[1], reply[2], reply[3], reply[4]]))
    } else {
        None
    }
}

/// LEDPARAM: [op, mode, 5-speed, brightness, (option<<4)|flags, R, G, B, ck8].
/// Flags nibble: 7 fixed color, 8 rainbow; music modes invert (0/4);
/// UserPicture stores its pattern slot in the option nibble; white is sent
/// as 0xFAFAFA; GET nibbles 0..=6 are firmware preset-color indices.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct LedParam {
    pub mode: u8,
    pub speed: u8, // UI 0..=4, inverted on the wire
    pub brightness: u8,
    pub option: u8,
    pub dazzle: bool,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

const FLAG_FIXED: u8 = 7;
const FLAG_DAZZLE: u8 = 8;
const MODE_USER_PICTURE: u8 = 13;
const MODE_SCREEN_COLOR: u8 = 21;
const MODE_MUSIC_2: u8 = 22;
const MODE_MUSIC_3: u8 = 23;
const MAX_SPEED: u8 = 5;

const COMMON_COLORS: [(u8, u8, u8); 7] = [
    (0xFF, 0x00, 0x00),
    (0xFF, 0x80, 0x00),
    (0xFF, 0xFF, 0x00),
    (0x00, 0xFF, 0x00),
    (0x00, 0xFF, 0xFF),
    (0x00, 0x00, 0xFF),
    (0xFF, 0x00, 0xFF),
];

impl LedParam {
    pub fn to_packet(self) -> [u8; REPORT_LEN] {
        let (mut r, mut g, mut b) = floor_black(self.r, self.g, self.b);
        if (r, g, b) == (0xFF, 0xFF, 0xFF) {
            (r, g, b) = (0xFA, 0xFA, 0xFA);
        }
        let flags4 = match self.mode {
            MODE_USER_PICTURE => {
                (r, g, b) = (0, 200, 200);
                self.option << 4
            }
            MODE_SCREEN_COLOR => 0,
            MODE_MUSIC_2 | MODE_MUSIC_3 => (self.option << 4) | if self.dazzle { 0 } else { 4 },
            _ => (self.option << 4) | if self.dazzle { FLAG_DAZZLE } else { FLAG_FIXED },
        };
        let wire_speed = MAX_SPEED.saturating_sub(self.speed.min(4));
        packet(
            cmd::SET_LEDPARAM,
            &[self.mode, wire_speed, self.brightness, flags4, r, g, b],
            Checksum::Bit8,
        )
    }

    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        if reply.len() < 8 || reply[0] != cmd::GET_LEDPARAM {
            return None;
        }
        let mode = reply[1];
        let flags = reply[4];
        let nibble = flags & 0x0F;
        let (mut r, mut g, mut b) = (reply[5], reply[6], reply[7]);
        if (r, g, b) == (0xFA, 0xFA, 0xFA) {
            (r, g, b) = (0xFF, 0xFF, 0xFF);
        }
        let dazzle = match mode {
            MODE_MUSIC_2 | MODE_MUSIC_3 => nibble == 0,
            _ => nibble == FLAG_DAZZLE,
        };
        if !dazzle && nibble != FLAG_FIXED {
            if let Some(&(pr, pg, pb)) = COMMON_COLORS.get(nibble as usize) {
                if !matches!(mode, MODE_MUSIC_2 | MODE_MUSIC_3 | MODE_USER_PICTURE) {
                    (r, g, b) = (pr, pg, pb);
                }
            }
        }
        Some(LedParam {
            mode,
            speed: MAX_SPEED.saturating_sub(reply[2]).min(4),
            brightness: reply[3].min(4),
            option: flags >> 4,
            dazzle,
            r,
            g,
            b,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_bit7() {
        let mut buf = [0u8; REPORT_LEN];
        buf[0] = 0x8F;
        apply_checksum(&mut buf, Checksum::Bit7);
        assert_eq!(buf[7], 0xFF - 0x8F);
    }

    #[test]
    fn checksum_bit8() {
        let mut buf = [0u8; REPORT_LEN];
        buf[0] = 0x07;
        buf[1] = 0x01;
        apply_checksum(&mut buf, Checksum::Bit8);
        assert_eq!(buf[8], 0xFF - 0x08);
    }

    #[test]
    fn device_id() {
        let mut reply = [0u8; 64];
        reply[0] = 0x8F;
        reply[1..5].copy_from_slice(&1967u32.to_le_bytes());
        assert_eq!(parse_device_id(&reply), Some(1967));
    }

    #[test]
    fn led_speed_inverts_on_wire() {
        let p = LedParam {
            mode: 2,
            speed: 3,
            brightness: 4,
            option: 0,
            dazzle: false,
            r: 1,
            g: 2,
            b: 3,
        };
        assert_eq!(p.to_packet()[2], 2);
    }

    #[test]
    fn led_white_sentinel_round_trips() {
        let p = LedParam {
            mode: 1,
            speed: 3,
            brightness: 4,
            option: 0,
            dazzle: false,
            r: 0xFF,
            g: 0xFF,
            b: 0xFF,
        };
        let pkt = p.to_packet();
        assert_eq!(&pkt[5..8], &[0xFA, 0xFA, 0xFA]);
        let mut reply = [0u8; 64];
        reply[0] = cmd::GET_LEDPARAM;
        reply[1..8].copy_from_slice(&pkt[1..8]);
        let back = LedParam::from_reply(&reply).unwrap();
        assert_eq!((back.r, back.g, back.b), (0xFF, 0xFF, 0xFF));
        assert_eq!(back.speed, 3);
    }

    #[test]
    fn sleep_write_and_read_offsets_differ() {
        let s = SleepTimes {
            sleep_bt: 180,
            sleep_24: 180,
            deep_bt: 3420,
            deep_24: 3420,
        };
        let pkt = s.to_packet();
        assert_eq!(&pkt[8..10], &180u16.to_le_bytes());
        assert_eq!(&pkt[14..16], &3420u16.to_le_bytes());

        // reads come back four bytes earlier
        let mut reply = [0u8; 64];
        reply[0] = cmd::GET_SLEEPTIME;
        reply[1..3].copy_from_slice(&180u16.to_le_bytes());
        reply[3..5].copy_from_slice(&180u16.to_le_bytes());
        reply[5..7].copy_from_slice(&3420u16.to_le_bytes());
        reply[7..9].copy_from_slice(&3420u16.to_le_bytes());
        let back = SleepTimes::from_reply(&reply).unwrap();
        assert_eq!(back.sleep_bt, 180);
        assert_eq!(back.deep_24, 3420);
    }

    #[test]
    fn kb_options_never_write_system_bit() {
        let o = KbOptions {
            win_lock: true,
            wasd_swap: true,
            led_off: false,
            side_led_off: false,
            mac_mode: true,
        };
        let pkt = o.to_packet(0xFF, 0, 0);
        assert_eq!(pkt[2] & 0b0000_0110, 0, "system bits must stay clear");
        assert_eq!(pkt[2] & 1, 1);
        assert_eq!(pkt[2] & 8, 8);
        assert_eq!(pkt[2] & 0b1100_0000, 0b1100_0000, "high bits preserved");
    }

    #[test]
    fn macro_blob_round_trips() {
        let m = Macro {
            repeat: 3,
            events: vec![
                MacroEvent::Key {
                    usage: 0x0B,
                    pressed: true,
                    delay_ms: 20,
                },
                MacroEvent::Key {
                    usage: 0x0B,
                    pressed: false,
                    delay_ms: 500,
                },
                MacroEvent::MouseButton {
                    button: 1,
                    pressed: true,
                    delay_ms: 0,
                },
                MacroEvent::MouseButton {
                    button: 1,
                    pressed: false,
                    delay_ms: 127,
                },
                MacroEvent::MouseMove {
                    dx: -5,
                    dy: 120,
                    delay_ms: 8,
                },
            ],
        };
        let blob = m.to_blob().unwrap();
        assert_eq!(&blob[..2], &3u16.to_le_bytes());
        assert_eq!(Macro::from_blob(&blob), m);
    }

    #[test]
    fn macro_delay_form_boundaries() {
        // 127 ms fits the short form; 128 and 0 must take the long form,
        // because a low nibble of zero doubles as the long-form marker.
        let ev = |d| MacroEvent::Key {
            usage: 4,
            pressed: true,
            delay_ms: d,
        };
        let short = Macro {
            repeat: 1,
            events: vec![ev(127)],
        }
        .to_blob()
        .unwrap();
        assert_eq!(&short[2..4], &[4, 0x80 | 127]);
        assert_eq!(short[4], 0, "short form is 2 bytes");

        for d in [0u16, 128] {
            let long = Macro {
                repeat: 1,
                events: vec![ev(d)],
            }
            .to_blob()
            .unwrap();
            assert_eq!(
                &long[2..6],
                &[4, 0x80, d.to_le_bytes()[0], d.to_le_bytes()[1]]
            );
            let back = Macro::from_blob(&long);
            assert_eq!(back.events, vec![ev(d)]);
        }
    }

    #[test]
    fn macro_write_packet_header() {
        let mut blob = [0u8; MACRO_BYTES];
        blob[..2].copy_from_slice(&1u16.to_le_bytes());
        blob[100] = 0xAA; // page 1
        assert_eq!(macro_pages(&blob), 2);

        let pkt = macro_write_packet(cmd::SET_MACRO, 7, 1, true, &blob);
        assert_eq!(&pkt[..7], &[cmd::SET_MACRO, 7, 1, 56, 1, 0, 0]);
        let sum: u32 = pkt[..7].iter().map(|&b| b as u32).sum();
        assert_eq!(pkt[7], 0xFF - (sum & 0xFF) as u8);
        assert_eq!(pkt[8 + (100 - 56)], 0xAA);

        // final page carries only the 32-byte tail of the blob
        let tail = macro_write_packet(cmd::SET_MACRO, 7, 4, true, &blob);
        assert_eq!(tail[3], 56);
        assert_eq!(&tail[8 + 32..], &[0u8; 24]);
    }

    #[test]
    fn macro_pages_minimum_one() {
        let blob = [0u8; MACRO_BYTES];
        assert_eq!(macro_pages(&blob), 1);
    }

    #[test]
    fn macro_overflow_and_range_errors() {
        let too_long = Macro {
            repeat: 1,
            events: vec![
                MacroEvent::Key {
                    usage: 4,
                    pressed: true,
                    delay_ms: 1000, // 4-byte form × 70 = 280 > 250
                };
                70
            ],
        };
        assert!(too_long.to_blob().is_err());
        let bad_usage = Macro {
            repeat: 1,
            events: vec![MacroEvent::Key {
                usage: 0xF0,
                pressed: true,
                delay_ms: 1,
            }],
        };
        assert!(bad_usage.to_blob().is_err());
    }

    #[test]
    fn family_tables_model_the_documented_collisions() {
        // the dangerous overlaps from docs/PROTOCOL.md, verbatim
        assert_eq!(GEN2_CMDS.set_kboption, YC500_CMDS.set_keymatrix);
        assert_eq!(GEN2_CMDS.set_debounce, YC500_CMDS.set_kboption);
        assert_eq!(GEN2_CMDS.set_sleeptime, YC500_CMDS.set_debounce);
        assert_eq!(GEN2_CMDS.set_macro, cmd::SET_MACRO_PAGED);
        // gen2 has no single-slot write; keymaps must go through bulk pages
        assert!(GEN2_CMDS.set_key_one.is_none());
        assert!(GEN2_CMDS.set_fn_one.is_none());
        assert!(family_cmds("unknown").is_none());
    }

    #[test]
    fn gen2_keymap_packets_match_the_vendor_shapes() {
        // single slot: byte 2 is the slot, byte 4 the apply flag
        let pkt = gen2::set_key_packet(1, 42, [0, 0, 74, 0]);
        assert_eq!(&pkt[..7], &[0x0A, 1, 42, 0, 0, 1, 0]);
        assert_eq!(&pkt[8..12], &[0, 0, 74, 0]);

        // fn slot: leads with host-OS byte (win = 0)
        let fnp = gen2::set_fn_key_packet(1, 42, [0, 0, 74, 0]);
        assert_eq!(&fnp[..4], &[0x10, 0, 1, 42]);

        // bulk: 0xFF sentinel in byte 2, 10 pages, last flag on the final one
        let matrix = [0xABu8; 512];
        let pages = gen2::bulk_keymatrix_packets(0, &matrix);
        assert_eq!(pages.len(), 10);
        assert_eq!(&pages[0][..6], &[0x0A, 0, 0xFF, 0, 56, 0]);
        // final page holds the 512 - 9*56 = 8 remaining bytes
        assert_eq!(&pages[9][..6], &[0x0A, 0, 0xFF, 9, 8, 1]);
        assert_eq!(&pages[9][8..16], &[0xAB; 8]);
        assert_eq!(pages[9][16], 0, "tail padded with zeros");

        // yc500 bulk: 0xF8 marker, page at byte 4, 9 pages of 56
        let y = yc500_bulk_keymatrix_packets(2, &matrix);
        assert_eq!(y.len(), 9);
        assert_eq!(&y[0][..5], &[0x09, 2, 0xF8, 1, 0]);
        assert_eq!(&y[8][..5], &[0x09, 2, 0xF8, 1, 8]);
        // 9 * 56 = 504 < 512: the last 8 matrix bytes do not fit -- the
        // vendor's own loop truncates identically, worth knowing before
        // anyone verifies this path
        assert_eq!(&y[8][8..8 + 56], &[0xAB; 56]);
    }

    #[test]
    /// Offsets below are read off the X65HE firmware (2268_v309) -- the gen2
    /// family's own code. See docs/PROTOCOL.md.
    fn sleep_reply_parses_under_either_familys_opcode() {
        assert_eq!(GEN2_CMDS.debounce_at, 1, "gen2 value sits at wire byte 1");
        assert_eq!(YC500_CMDS.debounce_at, 2, "yc500 pads with a zero byte");
        assert_eq!(YC500_CMDS.sleep_reply_at, 1);
        assert_eq!(GEN2_CMDS.sleep_reply_at, 8, "gen2 reply is symmetric");
        assert!(
            GEN2_CMDS.kboption.is_none(),
            "gen2 option semantics unestablished; withheld rather than guessed"
        );
        assert!(YC500_CMDS.kboption.is_some());

        let mut reply = [0u8; 64];
        reply[0] = GEN2_CMDS.get_sleeptime;
        reply[8..10].copy_from_slice(&300u16.to_le_bytes());
        let s = SleepTimes::from_reply_expecting(&reply, GEN2_CMDS.get_sleeptime, 8).unwrap();
        assert_eq!(s.sleep_bt, 300);
        assert!(
            SleepTimes::from_reply(&reply).is_none(),
            "yc500 offsets must not parse a gen2 reply"
        );
    }

    #[test]
    fn near_black_floors_instead_of_lights_out() {
        let p = LedParam {
            mode: 1,
            speed: 3,
            brightness: 4,
            option: 0,
            dazzle: false,
            r: 0,
            g: 0,
            b: 0,
        };
        assert_eq!(&p.to_packet()[5..8], &[COLOR_FLOOR; 3]);
        // dark but visible colours pass through untouched
        let navy = LedParam { b: 20, ..p };
        assert_eq!(&navy.to_packet()[5..8], &[0, 0, 20]);
        let sled = SledParam {
            mode: 1,
            speed: 2,
            brightness: 4,
            option: 0,
            dazzle: false,
            r: 2,
            g: 2,
            b: 2,
        };
        assert_eq!(&sled.to_packet()[5..8], &[COLOR_FLOOR; 3]);
    }

    #[test]
    fn led_preset_color_index() {
        let mut reply = [0u8; 64];
        reply[0] = cmd::GET_LEDPARAM;
        reply[1] = 1;
        reply[2] = 2;
        reply[3] = 1;
        reply[4] = 4; // preset index 4 = cyan
        reply[5..8].copy_from_slice(&[0xB4, 0xB4, 0xB4]);
        let p = LedParam::from_reply(&reply).unwrap();
        assert_eq!((p.r, p.g, p.b), (0x00, 0xFF, 0xFF));
        assert!(!p.dazzle);
    }
}
