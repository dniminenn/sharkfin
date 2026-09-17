// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! 64-byte HID feature reports, report ID 0, vendor collection 0xFFFF usage 2.
//! `cmd` is yc500 (X86, device 1967), hardware-verified. Bulk reads return
//! raw pages, no opcode echo.

/// Most boards. Discovery scans `registry::vendor_ids()`, not this constant.
pub const VENDOR_ID: u16 = 0x3151;
pub const USAGE_PAGE: u16 = 0xFFFF;
pub const USAGE: u16 = 0x0002;
/// Settings collection usages on 0xFFFF. Almost every board reports 2;
/// device 606 reports 1. The vendor driver accepts both.
pub const USAGES: [u16; 2] = [0x0001, 0x0002];
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
pub mod cmd;

// No report-rate command: the vendor's setReportRate is a stub.

/// Per-family opcodes. Families overlap: yc500 SET_KEYMATRIX 0x09 is gen2
/// SET_KBOPTION. Family-dependent commands go through this table, never the
/// `cmd` constants. `None` means the family has no such command. LEDPARAM,
/// GET_MACRO and identify are shared. FN and USERPIC share opcodes but not
/// shapes; gen2 builders live in `gen2`.
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

/// From X65HE firmware (2268_v309), not hardware. Revision, auto-OS and
/// edge light share yc500 opcodes. Single-slot key writes use SET_KEYMATRIX
/// with byte 2 below 255; 255 is bulk. Use the gen2 builders, not `set_key_one`.
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

/// gen2 keymap packets. Reads and bulk writes put 0xFF in byte 2; a slot
/// index there is a single-slot write. Fn packets lead with host OS: 0 win,
/// 1 mac, 2 android, 3 ios.
pub mod gen2;

/// Magnetic yc500: four keymap sub-layers per profile, addressed as
/// `profile * 4 + sublayer` on 0x05, 0x09, 0x13 and 0x89. Other boards use
/// the profile as-is.
pub fn yc500_profile_slot(magnetic: bool, profile: u8, sublayer: u8) -> u8 {
    if magnetic {
        profile * 4 + sublayer
    } else {
        profile
    }
}

/// The inverse for a `0x85` reply.
pub fn yc500_profile_from_slot(magnetic: bool, slot: u8) -> u8 {
    if magnetic {
        slot / 4
    } else {
        slot
    }
}

/// yc500 bulk keymap: `[0x09, profile, 0xF8, 1, page, 0, 0, ck7]` plus 56
/// bytes, 9 pages. Unused; the UI writes one slot.
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

/// Sleep timeouts, seconds. Writes land at bytes 8..16; reads come back at
/// 1..9. The vendor encode and decode disagree.
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

/// `(fixed colour, rainbow)` nibble pair. Most boards: 7 is the packet
/// colour, 8 is rainbow. `led-flags.json` / `led-flags.vendor.json` list
/// the boards that read them the other way round.
fn flags_pair(swapped: bool) -> (u8, u8) {
    if swapped {
        (FLAG_DAZZLE, FLAG_FIXED)
    } else {
        (FLAG_FIXED, FLAG_DAZZLE)
    }
}

/// Near-black stores but renders as all LEDs off (X86). Backlight-off is
/// KBOPTION; a colour write is floored so the board still looks alive.
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
        self.to_packet_on(false)
    }

    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        Self::from_reply_on(reply, false)
    }

    /// The edge light reads the flags nibble the way the same board's
    /// backlight does: in the 606 image both renderers test the same values
    /// by exact compare (`docs/PROTOCOL.md`).
    pub fn to_packet_on(self, swapped: bool) -> [u8; REPORT_LEN] {
        let (fixed, dazzle) = flags_pair(swapped);
        let (mut r, mut g, mut b) = floor_black(self.r, self.g, self.b);
        if (r, g, b) == (0xFF, 0xFF, 0xFF) {
            (r, g, b) = (0xFA, 0xFA, 0xFA);
        }
        let flags4 = if self.mode == MODE_NEON {
            dazzle
        } else {
            (self.option << 4) | if self.dazzle { dazzle } else { fixed }
        };
        packet(
            cmd::SET_SLEDPARAM,
            &[self.mode, self.speed, self.brightness, flags4, r, g, b],
            Checksum::Bit8,
        )
    }

    pub fn from_reply_on(reply: &[u8], swapped: bool) -> Option<Self> {
        if reply.len() < 8 || reply[0] != cmd::GET_SLEDPARAM {
            return None;
        }
        let (fixed, dazzle_flag) = flags_pair(swapped);
        let presets: &[(u8, u8, u8)] = if swapped {
            &COMMON_COLORS_SWAPPED
        } else {
            &COMMON_COLORS
        };
        let flags = reply[4];
        let nibble = flags & 0x0F;
        let (mut r, mut g, mut b) = (reply[5], reply[6], reply[7]);
        if (r, g, b) == (0xFA, 0xFA, 0xFA) {
            (r, g, b) = (0xFF, 0xFF, 0xFF);
        }
        let dazzle = nibble == dazzle_flag;
        if !dazzle && nibble != fixed {
            if let Some(&(pr, pg, pb)) = presets.get(nibble as usize) {
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

// Magnetic switches. Two column formats, same opcodes. gen2: 128 slots,
// hundredths of a millimetre, u16 LE travel. yc500 from firmware 2.00: 126
// slots, one byte, tenths with a +1/10 offset (byte b fires at (b+1)/10 mm).
// Firmware does not check bounds; a page or slot past the end writes
// neighbouring arrays. `last` on the final packet commits to flash; without
// it the block sits in RAM. docs/PROTOCOL.md, Magnetic switches.
pub mod hall;
// Displays. Registry mode picks the announce/page opcode pair (16 vs 24).
// yc500 length is a u16; refuse frames past 65535 bytes. yc3123 (gen2,
// internalName prefix) reads length as u32; `registry::screen_draw` has the
// split. Do not send the flash erase (yc500 0x2C, gen2 0xAC). One frame,
// currently showing. docs/PROTOCOL.md, Displays.

/// Data bytes per page. The header is bytes 0..8, the checksum byte 7.
pub const SCREEN_PAGE_DATA: usize = 56;

/// A pixel as the display wants it: RGB565, high byte first.
fn rgb565_be(r: u8, g: u8, b: u8) -> [u8; 2] {
    let v = (u16::from(r >> 3) << 11) | (u16::from(g >> 2) << 5) | u16::from(b >> 3);
    [(v >> 8) as u8, (v & 0xFF) as u8]
}

/// `w * h` RGB triples to the display's own byte order.
///
/// Column major, not row major: the vendor sorts by x and then y before
/// packing, so a row-major blob would come out sheared. `mode` is the
/// registry's, `16` for RGB565 high byte first and `24` for plain triples.
pub fn screen_pixels(rgb: &[u8], w: u16, h: u16, mode: &str) -> Result<Vec<u8>, String> {
    let (w, h) = (usize::from(w), usize::from(h));
    if rgb.len() != w * h * 3 {
        return Err(format!(
            "expected {} bytes of RGB for a {w} by {h} display, got {}",
            w * h * 3,
            rgb.len()
        ));
    }
    let mut out = Vec::with_capacity(w * h * if mode == "24" { 3 } else { 2 });
    for x in 0..w {
        for y in 0..h {
            let i = (y * w + x) * 3;
            if mode == "24" {
                out.extend_from_slice(&rgb[i..i + 3]);
            } else {
                out.extend_from_slice(&rgb565_be(rgb[i], rgb[i + 1], rgb[i + 2]));
            }
        }
    }
    Ok(out)
}

/// The packet that announces an upload. The board answers `reply[1] == 1`
/// when it is ready for the pages, and the caller must wait for that.
pub fn screen_announce_packet(
    opcode: u8,
    frame: u8,
    frames: u8,
    delay: u8,
    len: u32,
    bbox: (u16, u16, u16, u16),
    layer: u8,
) -> [u8; REPORT_LEN] {
    let (left, top, right, bottom) = bbox;
    let mut buf = packet(
        opcode,
        &[
            frame,
            frames,
            delay,
            (len & 0xFF) as u8,
            ((len >> 8) & 0xFF) as u8,
            0,
        ],
        Checksum::Bit7,
    );
    // Byte 7 is the checksum, so everything wider than a byte lands past it.
    buf[8] = (left & 0xFF) as u8;
    buf[9] = (top & 0xFF) as u8;
    buf[10] = (right & 0xFF) as u8;
    buf[11] = (bottom & 0xFF) as u8;
    buf[12] = (left >> 8) as u8;
    buf[13] = (top >> 8) as u8;
    buf[14] = (right >> 8) as u8;
    buf[15] = (bottom >> 8) as u8;
    buf[16] = ((len >> 16) & 0xFF) as u8;
    buf[17] = ((len >> 24) & 0xFF) as u8;
    buf[18] = layer;
    buf
}

pub fn screen_page_packets(
    opcode: u8,
    frame: u8,
    frames: u8,
    delay: u8,
    data: &[u8],
) -> Vec<[u8; REPORT_LEN]> {
    data.chunks(SCREEN_PAGE_DATA)
        .enumerate()
        .map(|(page, chunk)| {
            let page = page as u16;
            let mut buf = packet(
                opcode,
                &[
                    frame,
                    frames,
                    delay,
                    (page & 0xFF) as u8,
                    (page >> 8) as u8,
                    chunk.len() as u8,
                ],
                Checksum::Bit7,
            );
            buf[8..8 + chunk.len()].copy_from_slice(chunk);
            buf
        })
        .collect()
}

/// Year big-endian at 8..10, then month, day, hour, minute, second, one byte
/// each: all past the checksum, which covers 0..=6 only. The RT100 image
/// reads bytes 8 to 14 and nothing else.
pub fn clock_packet(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> [u8; REPORT_LEN] {
    let mut buf = packet(cmd::SET_OLED_CLOCK, &[], Checksum::Bit7);
    buf[8] = (year >> 8) as u8;
    buf[9] = (year & 0xFF) as u8;
    buf[10] = month;
    buf[11] = day;
    buf[12] = hour;
    buf[13] = minute;
    buf[14] = second;
    buf
}

/// Per-key colours: 128 slots × RGB = 384 bytes, indexed by matrix slot.
pub const PER_KEY_BYTES: usize = 384;
const USERPIC_PAGE_DATA: usize = 56;

/// yc500 USERPIC page: length at bytes 2-3, page index at byte 4, data at 8.
/// gen2 parses this header differently; use `gen2::userpic_packets`.
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

/// Onboard macros: 50 slots x 256 bytes. Write opcode is the subclass
/// override 0x16 on the base packet shape (base declares 0x0B; the sender
/// reads the field at call time).
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

/// Keyboard option bits (reply[2]). Vendor writes `system` at bit 2 and
/// reads it at bit 1; sharkfin never writes it. Keyboard-lock is not exposed.
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

/// 2.4 GHz receiver. Same collection as the keyboard. Answers these opcodes
/// itself; anything else is relayed after SELECT. Replies never echo the
/// opcode; tell status apart by the device-kind byte. docs/PROTOCOL.md.
pub mod receiver;

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
// 20 in both device classes' tables; 23 is Train, an ordinary effect.
const MODE_MUSIC_3: u8 = 20;
/// How a board's firmware reads a LEDPARAM packet beyond the shared layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LedWire {
    /// The lineage whose firmware reads the flags nibble the other way round
    /// (`DeviceSpec::led_flags_swapped`).
    pub swapped: bool,
    /// The wire value for host speed 0, the slowest; host speed `s` goes out
    /// as `speed_max - s`. yc500 is 5, so the wire runs 1..5 **[HW]** (X86).
    /// gen2 is 4, so the wire runs 0..4: the 2268 renderer (`0x080083e8`)
    /// counts frames up to the byte before it advances, so 0 is fastest and
    /// a 5 is one step slower than the vendor ever sends **[FW]**.
    pub speed_max: u8,
    /// Highest brightness the board takes: the vendor's light table, 4 on
    /// most boards, 7 on the MK12 and MK14.
    pub brightness_max: u8,
}

impl LedWire {
    pub const YC500: LedWire = LedWire {
        swapped: false,
        speed_max: 5,
        brightness_max: 4,
    };
    pub const GEN2: LedWire = LedWire {
        swapped: false,
        speed_max: 4,
        brightness_max: 4,
    };
}

const COMMON_COLORS: [(u8, u8, u8); 7] = [
    (0xFF, 0x00, 0x00),
    (0xFF, 0x80, 0x00),
    (0xFF, 0xFF, 0x00),
    (0x00, 0xFF, 0x00),
    (0x00, 0xFF, 0xFF),
    (0x00, 0x00, 0xFF),
    (0xFF, 0x00, 0xFF),
];

/// Preset colours 0..6 on the swapped-nibble lineage: red, green, blue,
/// orange, magenta, amber, warm white.
const COMMON_COLORS_SWAPPED: [(u8, u8, u8); 7] = [
    (0xFF, 0x00, 0x00),
    (0x00, 0xFF, 0x00),
    (0x00, 0x00, 0xFF),
    (0xFF, 0x55, 0x00),
    (0xFF, 0x00, 0xFF),
    (0xFF, 0xBB, 0x00),
    (0xFF, 0xFF, 0xDD),
];

impl LedParam {
    pub fn to_packet(self) -> [u8; REPORT_LEN] {
        self.to_packet_for(LedWire::YC500)
    }

    /// The swapped-nibble lineage on yc500 wire ranges.
    pub fn to_packet_on(self, swapped: bool) -> [u8; REPORT_LEN] {
        self.to_packet_for(LedWire {
            swapped,
            ..LedWire::YC500
        })
    }

    /// `wire.swapped` selects the lineage whose firmware reads the flags
    /// nibble the other way round. Every renderer in that image tests the
    /// nibble by exact value, so the two constants simply trade places;
    /// nothing else in the packet moves.
    pub fn to_packet_for(self, wire: LedWire) -> [u8; REPORT_LEN] {
        let (fixed, dazzle) = flags_pair(wire.swapped);
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
            _ => (self.option << 4) | if self.dazzle { dazzle } else { fixed },
        };
        let wire_speed = wire.speed_max.saturating_sub(self.speed.min(4));
        packet(
            cmd::SET_LEDPARAM,
            &[
                self.mode,
                wire_speed,
                self.brightness.min(wire.brightness_max),
                flags4,
                r,
                g,
                b,
            ],
            Checksum::Bit8,
        )
    }

    pub fn from_reply(reply: &[u8]) -> Option<Self> {
        Self::from_reply_for(reply, LedWire::YC500)
    }

    pub fn from_reply_on(reply: &[u8], swapped: bool) -> Option<Self> {
        Self::from_reply_for(
            reply,
            LedWire {
                swapped,
                ..LedWire::YC500
            },
        )
    }

    pub fn from_reply_for(reply: &[u8], wire: LedWire) -> Option<Self> {
        if reply.len() < 8 || reply[0] != cmd::GET_LEDPARAM {
            return None;
        }
        let (fixed, dazzle_flag) = flags_pair(wire.swapped);
        let presets = if wire.swapped {
            &COMMON_COLORS_SWAPPED
        } else {
            &COMMON_COLORS
        };
        let mode = reply[1];
        let flags = reply[4];
        let nibble = flags & 0x0F;
        let (mut r, mut g, mut b) = (reply[5], reply[6], reply[7]);
        if (r, g, b) == (0xFA, 0xFA, 0xFA) {
            (r, g, b) = (0xFF, 0xFF, 0xFF);
        }
        let dazzle = match mode {
            MODE_MUSIC_2 | MODE_MUSIC_3 => nibble == 0,
            _ => nibble == dazzle_flag,
        };
        if !dazzle && nibble != fixed {
            if let Some(&(pr, pg, pb)) = presets.get(nibble as usize) {
                if !matches!(
                    mode,
                    MODE_MUSIC_2 | MODE_MUSIC_3 | MODE_USER_PICTURE | MODE_SCREEN_COLOR
                ) {
                    (r, g, b) = (pr, pg, pb);
                }
            }
        }
        Some(LedParam {
            mode,
            speed: wire.speed_max.saturating_sub(reply[2]).min(4),
            brightness: reply[3].min(wire.brightness_max),
            option: flags >> 4,
            dazzle,
            r,
            g,
            b,
        })
    }
}

#[cfg(test)]
mod tests;
