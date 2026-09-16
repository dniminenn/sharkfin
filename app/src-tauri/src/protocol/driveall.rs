// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use super::{hall, LedParam, Macro, MacroEvent, REPORT_LEN};

pub const USAGE_PAGE_FF68: u16 = 0xFF68;
pub const USAGE_PAGE_FF67: u16 = 0xFF67;
pub const USAGE: u16 = 0x61;
pub const HEADER: usize = 8;
pub const MAGIC_OUT: u8 = 0xAA;
pub const MAGIC_IN: u8 = 0x55;

pub const GET_DEVICE_INFO: u8 = 16;
pub const GET_KEY: u8 = 18;
pub const GET_LED_EFFECT: u8 = 19;
pub const GET_MACRO: u8 = 21;
pub const GET_FN_KEY: u8 = 22;
pub const GET_MAGNETIC_RT: u8 = 23;
pub const SET_KEY: u8 = 34;
pub const SET_LED_EFFECT: u8 = 35;
pub const SET_CUSTOM_LED: u8 = 36;
pub const SET_MACRO: u8 = 37;
pub const SET_FN_KEY: u8 = 38;
pub const SET_MAGNETIC_RT: u8 = 39;

pub const PAGE_DEFAULT: u8 = 0;
pub const PAGE_MOUSE: u8 = 1;
pub const PAGE_KEYBOARD: u8 = 2;
pub const PAGE_CONSUMER: u8 = 3;
pub const PAGE_MACRO: u8 = 6;

pub const INFO_LEN: usize = 48;
pub const KEYMAP_LEN: usize = 512;
pub const LED_LEN: usize = 16;
pub const CUSTOM_LED_LEN: usize = 512;
pub const RT_LEN: usize = 1024;
pub const RT_SLOTS: usize = 128;
pub const RT_SLOT: usize = 8;
pub const MACRO_INDEX_LEN: usize = 400;
pub const MACRO_SLOTS: usize = 100;

pub fn is_collection(usage_page: u16, usage: u16) -> bool {
    usage == USAGE && (usage_page == USAGE_PAGE_FF68 || usage_page == USAGE_PAGE_FF67)
}

pub fn payload_chunk() -> usize {
    REPORT_LEN - HEADER
}

/// `last` is the JS last-packet flag at byte 6 when optional[1] is absent.
pub fn build_frame(cmd: u8, len: u8, addr: u16, payload: &[u8], last: bool) -> [u8; REPORT_LEN] {
    let mut buf = [0u8; REPORT_LEN];
    buf[0] = MAGIC_OUT;
    buf[1] = cmd;
    buf[2] = len;
    buf[3] = addr as u8;
    buf[4] = (addr >> 8) as u8;
    buf[6] = u8::from(last);
    let n = payload.len().min(payload_chunk());
    buf[HEADER..HEADER + n].copy_from_slice(&payload[..n]);
    buf
}

/// Identify as the AK029 probe sent it: cmd 16, length 48, no last flag.
pub fn identify_packet() -> [u8; REPORT_LEN] {
    build_frame(GET_DEVICE_INFO, INFO_LEN as u8, 0, &[], false)
}

pub fn parse_reply(buf: &[u8]) -> Option<(u8, &[u8])> {
    if buf.len() < HEADER || buf[0] != MAGIC_IN {
        return None;
    }
    Some((buf[1], &buf[HEADER..]))
}

/// The address a reply carries, so a chunked read cannot assemble one
/// chunk's bytes at another chunk's offset.
pub fn reply_addr(buf: &[u8]) -> u16 {
    u16::from(buf[3]) | (u16::from(buf[4]) << 8)
}

pub fn frame_addr(pkt: &[u8; REPORT_LEN]) -> u16 {
    reply_addr(pkt)
}

pub fn get_packets(cmd: u8, content_size: usize, addr: u16) -> Vec<[u8; REPORT_LEN]> {
    chunk_packets(cmd, content_size, addr, &[], true)
}

pub fn set_packets(cmd: u8, addr: u16, data: &[u8], last_on_final: bool) -> Vec<[u8; REPORT_LEN]> {
    chunk_packets(cmd, data.len(), addr, data, last_on_final)
}

fn chunk_packets(
    cmd: u8,
    content_size: usize,
    addr: u16,
    data: &[u8],
    last_on_final: bool,
) -> Vec<[u8; REPORT_LEN]> {
    let chunk = payload_chunk();
    let n = content_size.div_ceil(chunk).max(1);
    (0..n)
        .map(|i| {
            let off = i * chunk;
            let remain = content_size.saturating_sub(off);
            let last = last_on_final && i + 1 == n;
            let this = if i + 1 == n { remain } else { chunk };
            let payload = if off < data.len() {
                &data[off..data.len().min(off + this)]
            } else {
                &[]
            };
            build_frame(
                cmd,
                this as u8,
                addr.saturating_add(off as u16),
                payload,
                last,
            )
        })
        .collect()
}

#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub version: u16,
    pub current_profile: u8,
    pub rt_precision: u8,
    pub macro_space: u16,
    pub battery: u8,
    /// Byte 30. The vendor waits four times as long for a reply when this
    /// is 1, so it is the board saying it is slow, not a format number.
    pub frame_version: u8,
}

impl DeviceInfo {
    pub fn parse(payload: &[u8]) -> Option<Self> {
        if payload.len() < 33 {
            return None;
        }
        Some(Self {
            vid: u16::from_le_bytes([payload[4], payload[5]]),
            pid: u16::from_le_bytes([payload[6], payload[7]]),
            version: u16::from_le_bytes([payload[8], payload[9]]),
            current_profile: payload[19],
            rt_precision: payload[29],
            macro_space: u16::from_le_bytes([payload[2], payload[3]]),
            battery: payload[17],
            frame_version: payload[30],
        })
    }

    /// The version the vendor prints, e.g. `13 01` as `1.13`: the low byte
    /// is packed decimal and the high byte counts hundreds.
    pub fn version_string(&self) -> String {
        let [lo, hi] = self.version.to_le_bytes();
        let hundredths = u16::from(lo & 0x0F) + u16::from(lo >> 4) * 10 + u16::from(hi) * 100;
        format!("{}.{:02}", hundredths / 100, hundredths % 100)
    }

    pub fn travel_scale(&self) -> f64 {
        if self.rt_precision == 2 {
            1000.0
        } else {
            100.0
        }
    }

    pub fn rt_scale(&self) -> f64 {
        if self.rt_precision > 0 {
            1000.0
        } else {
            100.0
        }
    }
}

/// sharkfin mouse codes and the driveall button mask, in wire order:
/// left, right, middle, back, forward. Wheel is its own param1.
const MOUSE_BUTTONS: [(u8, u8); 5] = [(240, 1), (241, 2), (242, 4), (243, 8), (244, 16)];
const MOUSE_PARAM_BUTTON: u8 = 1;
const MOUSE_PARAM_WHEEL: u8 = 3;
const MOUSE_WHEEL: u8 = 245;

/// The repeat mode a macro key is bound with. The vendor's own default,
/// and the only one of its three whose meaning is established.
const MACRO_MODE: u8 = 0;

/// Driveall slot -> the 4-byte shape the Keys page already speaks.
/// Pages sharkfin has no encoding for come back raw, which the picker
/// shows as its numbers rather than a name.
pub fn slot_from_driveall(d: [u8; 4]) -> [u8; 4] {
    match d[0] {
        PAGE_DEFAULT => [0, 0, 0, 0],
        // A modifier may arrive as the HID bitmask in param1 instead of
        // its usage; bit n is usage 224 + n.
        PAGE_KEYBOARD if d[2] == 0 && d[1].count_ones() == 1 => {
            [0x00, 0, 224 + d[1].trailing_zeros() as u8, 0]
        }
        PAGE_KEYBOARD => [0x00, 0, d[2], 0],
        PAGE_MOUSE if d[1] == MOUSE_PARAM_BUTTON => MOUSE_BUTTONS
            .iter()
            .find(|(_, mask)| *mask == d[2])
            .map_or(d, |(code, _)| [0x01, 0, *code, 0]),
        PAGE_MOUSE if d[1] == MOUSE_PARAM_WHEEL => [0x01, 0, MOUSE_WHEEL, d[2]],
        PAGE_CONSUMER => [0x03, 0, d[1], d[2]],
        // Byte 1 is the macro index. Bytes 2-3 are a repeat mode and its
        // count, in an order that is not sharkfin's, so the read reports
        // the mode sharkfin writes rather than translating one it cannot.
        PAGE_MACRO => [0x09, MACRO_MODE, d[1], 0],
        _ => d,
    }
}

/// The reverse, or `None` when sharkfin's assignment has no driveall
/// encoding on file. Guessing one writes a live keymap slot, so the
/// caller refuses the write instead.
pub fn slot_to_driveall(s: [u8; 4]) -> Option<[u8; 4]> {
    match s[0] {
        0x00 if s == [0, 0, 0, 0] => Some([PAGE_DEFAULT, 0, 0, 0]),
        0x00 if s[1] == 0 && s[3] == 0 => Some([PAGE_KEYBOARD, 0, s[2], 0]),
        0x01 if s[1] == 0 && s[2] == MOUSE_WHEEL => Some([PAGE_MOUSE, MOUSE_PARAM_WHEEL, s[3], 0]),
        0x01 if s[1] == 0 => MOUSE_BUTTONS
            .iter()
            .find(|(code, _)| *code == s[2])
            .map(|(_, mask)| [PAGE_MOUSE, MOUSE_PARAM_BUTTON, *mask, 0]),
        0x03 if s[1] == 0 => Some([PAGE_CONSUMER, s[2], s[3], 0]),
        // Only the vendor's own default repeat mode. sharkfin's mode byte
        // is the gen2 enum (0 count, 1 toggle, 2 held); driveall's picker
        // is ordered 0, 2, 1 and binds its count to 1, so the two numbers
        // do not mean the same thing and passing one through would arm the
        // wrong mode with a zero count.
        0x09 => Some([PAGE_MACRO, s[2], MACRO_MODE, 0]),
        _ => None,
    }
}

pub fn keymap_from_driveall(raw: &[u8]) -> Vec<u8> {
    raw.chunks(4)
        .take(128)
        .flat_map(|c| {
            let mut s = [0u8; 4];
            s[..c.len()].copy_from_slice(c);
            slot_from_driveall(s)
        })
        .collect()
}

pub fn led_from_wire(p: &[u8]) -> Option<LedParam> {
    if p.len() < LED_LEN {
        return None;
    }
    Some(LedParam {
        mode: p[0],
        speed: p[10],
        brightness: p[9],
        option: p[11],
        dazzle: p[8] != 0,
        r: p[1],
        g: p[2],
        b: p[3],
    })
}

/// `prev` is the board's current 16 bytes. Bytes 5-7 are a secondary
/// colour and byte 12 an effect sub-mode; sharkfin has no control for
/// either, so they are carried over rather than cleared.
pub fn led_to_wire(p: &LedParam, prev: Option<&[u8]>) -> [u8; LED_LEN] {
    let mut n = [0u8; LED_LEN];
    if let Some(prev) = prev {
        if prev.len() >= LED_LEN {
            n[5..8].copy_from_slice(&prev[5..8]);
            n[12] = prev[12];
        }
    }
    n[0] = p.mode;
    n[1] = p.r;
    n[2] = p.g;
    n[3] = p.b;
    n[4] = 0xFF;
    n[8] = u8::from(p.dazzle);
    n[9] = p.brightness;
    n[10] = p.speed;
    n[11] = p.option;
    n[14] = 0xAA;
    n[15] = 0x55;
    n
}

pub fn custom_led_to_wire(rgb: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; CUSTOM_LED_LEN];
    for i in 0..128 {
        let o = i * 4;
        out[o] = i as u8;
        if i * 3 + 2 < rgb.len() {
            out[o + 1] = rgb[i * 3];
            out[o + 2] = rgb[i * 3 + 1];
            out[o + 3] = rgb[i * 3 + 2];
        }
    }
    out
}

pub fn rt_from_wire(raw: &[u8], info: &DeviceInfo) -> hall::SwitchSettings {
    let travel_s = info.travel_scale();
    let rt_s = info.rt_scale();
    let keys = (0..RT_SLOTS)
        .map(|s| {
            let o = s * RT_SLOT;
            let b = if o + 7 < raw.len() {
                &raw[o..o + 8]
            } else {
                &[0; 8][..]
            };
            let flags = b[1];
            let travel = f64::from(u16::from_le_bytes([b[2], b[3]])) / travel_s;
            let press = f64::from(u16::from_le_bytes([b[4], b[5]])) / rt_s;
            let release = f64::from(u16::from_le_bytes([b[6], b[7]])) / rt_s;
            hall::KeySwitch {
                slot: s as u8,
                // Byte 0 is the axis type, the magnetic switch model
                // fitted. It is not one of sharkfin's kinds, and the
                // block carries no DKS, mod-tap, toggle or snap.
                kind: hall::KIND_NORMAL,
                rapid_trigger: flags & 1 != 0,
                travel,
                lift: travel,
                rt_press: press,
                rt_lift: release,
                dead_bottom: 0.0,
                dks_start: 0.0,
                dks_actions: [0; 4],
                mt_time_ms: 0,
                snap_partner: 0xFF,
            }
        })
        .collect();
    hall::SwitchSettings {
        format: hall::Format::Driveall,
        unit_mm: if info.rt_precision == 2 { 0.001 } else { 0.01 },
        keys,
    }
}

/// Patch `raw` (1024 B) with UI keys: travel, the two rapid-trigger
/// points and the rapid-trigger bit. The axis type in byte 0 and the
/// rampage bit are the board's and are left as they were read.
pub fn rt_patch(raw: &mut [u8], keys: &[hall::KeySwitch], info: &DeviceInfo) {
    let travel_s = info.travel_scale();
    let rt_s = info.rt_scale();
    for key in keys {
        let s = usize::from(key.slot);
        if s >= RT_SLOTS {
            continue;
        }
        let o = s * RT_SLOT;
        if o + 7 >= raw.len() {
            continue;
        }
        let mut flags = raw[o + 1] & !1;
        if key.rapid_trigger {
            flags |= 1;
        }
        let travel = (key.travel * travel_s).round().clamp(0.0, 65535.0) as u16;
        let press = (key.rt_press * rt_s).round().clamp(0.0, 65535.0) as u16;
        let release = (key.rt_lift * rt_s).round().clamp(0.0, 65535.0) as u16;
        raw[o + 1] = flags;
        raw[o + 2..o + 4].copy_from_slice(&travel.to_le_bytes());
        raw[o + 4..o + 6].copy_from_slice(&press.to_le_bytes());
        raw[o + 6..o + 8].copy_from_slice(&release.to_le_bytes());
    }
}

const ACT_KEYBOARD_PRESS: u8 = 0xB0;
const ACT_KEYBOARD_RELEASE: u8 = 0x30;
const ACT_MOUSE_PRESS: u8 = 0x90;
const ACT_MOUSE_RELEASE: u8 = 0x10;

/// A macro's mouse action carries the same button mask as the keymap page,
/// not a 1-based index. The vendor's two pickers are one list of values.
/// `MOUSE_BUTTONS` is in sharkfin's button order, so its position is the
/// `MacroEvent::MouseButton` index.
fn mouse_mask(button: u8) -> u8 {
    MOUSE_BUTTONS
        .get(usize::from(button))
        .map_or(MOUSE_BUTTONS[0].1, |(_, mask)| *mask)
}

fn mouse_button(mask: u8) -> Option<u8> {
    MOUSE_BUTTONS
        .iter()
        .position(|(_, m)| *m == mask)
        .map(|i| i as u8)
}

pub fn macro_from_driveall(block: &[u8]) -> Macro {
    if block.len() < 4 {
        return Macro::default();
    }
    let pair_bytes = u16::from_le_bytes([block[0], block[1]]) as usize;
    let actions = pair_bytes / 2;
    let mut events = Vec::new();
    for i in 0..actions {
        let o = 4 + i * 4;
        if o + 3 >= block.len() {
            break;
        }
        let delay = u16::from_le_bytes([block[o], block[o + 1]]);
        let code = block[o + 2];
        let flags = block[o + 3];
        let pressed = flags & 0x80 != 0;
        let kind = (flags >> 4) & 7;
        if kind == 3 {
            events.push(MacroEvent::Key {
                usage: code,
                pressed,
                delay_ms: delay,
            });
        } else if let Some(button) = mouse_button(code) {
            events.push(MacroEvent::MouseButton {
                button,
                pressed,
                delay_ms: delay,
            });
        }
    }
    Macro { repeat: 1, events }
}

/// `None` when the macro holds an event driveall has no action for.
pub fn macro_to_driveall(m: &Macro) -> Option<Vec<u8>> {
    if m.events
        .iter()
        .any(|e| matches!(e, MacroEvent::MouseMove { .. }))
    {
        return None;
    }
    let mut block = vec![0u8; 4 + m.events.len() * 4];
    let pair = (m.events.len() * 2) as u16;
    block[0..2].copy_from_slice(&pair.to_le_bytes());
    for (i, e) in m.events.iter().enumerate() {
        let o = 4 + i * 4;
        match *e {
            MacroEvent::Key {
                usage,
                pressed,
                delay_ms,
            } => {
                block[o..o + 2].copy_from_slice(&delay_ms.to_le_bytes());
                block[o + 2] = usage;
                block[o + 3] = if pressed {
                    ACT_KEYBOARD_PRESS
                } else {
                    ACT_KEYBOARD_RELEASE
                };
            }
            MacroEvent::MouseButton {
                button,
                pressed,
                delay_ms,
            } => {
                block[o..o + 2].copy_from_slice(&delay_ms.to_le_bytes());
                block[o + 2] = mouse_mask(button);
                block[o + 3] = if pressed {
                    ACT_MOUSE_PRESS
                } else {
                    ACT_MOUSE_RELEASE
                };
            }
            MacroEvent::MouseMove { .. } => unreachable!("refused above"),
        }
    }
    Some(block)
}

pub fn macro_index_offsets(index: &[u8]) -> [u32; MACRO_SLOTS] {
    let mut out = [0u32; MACRO_SLOTS];
    for (i, slot) in out.iter_mut().enumerate() {
        let o = i * 4;
        if o + 3 < index.len() {
            *slot = u32::from_le_bytes([index[o], index[o + 1], index[o + 2], index[o + 3]]);
        }
    }
    out
}

/// One read-modify-write against a region: read `len` bytes with `get`,
/// hand them to `patch`, send them back with `set`. Every driveall write
/// is this shape, and both backends run the same three steps, so the
/// region and the edit are decided here once instead of in each of them.
pub struct Rmw {
    pub get: u8,
    pub set: u8,
    pub len: usize,
    pub addr: u16,
    pub patch: Patch,
}

/// The edit a plan applies to the bytes it read back.
pub type Patch = Box<dyn FnOnce(&mut [u8]) -> Result<(), String>>;

/// One key of the 128-slot map. `None` from `slot_to_driveall` means
/// sharkfin has no driveall encoding for that assignment.
pub fn rmw_key(slot: u8, value: [u8; 4], fn_layer: bool) -> Result<Rmw, String> {
    let enc = slot_to_driveall(value).ok_or("this board has no such key")?;
    let off = usize::from(slot) * 4;
    if off + 4 > KEYMAP_LEN {
        return Err("slot out of range".into());
    }
    let (get, set) = if fn_layer {
        (GET_FN_KEY, SET_FN_KEY)
    } else {
        (GET_KEY, SET_KEY)
    };
    Ok(Rmw {
        get,
        set,
        len: KEYMAP_LEN,
        addr: 0,
        patch: Box::new(move |raw| {
            raw[off..off + 4].copy_from_slice(&enc);
            Ok(())
        }),
    })
}

/// The effect block. Read first so the secondary colour and the effect
/// sub-mode, which sharkfin has no control for, survive the write.
pub fn rmw_led(param: &LedParam) -> Rmw {
    let param = *param;
    Rmw {
        get: GET_LED_EFFECT,
        set: SET_LED_EFFECT,
        len: LED_LEN,
        addr: 0,
        patch: Box::new(move |raw| {
            let prev = raw.to_vec();
            raw.copy_from_slice(&led_to_wire(&param, Some(&prev)));
            Ok(())
        }),
    }
}

/// The 1024-byte rapid-trigger block. Read first: the axis type and the
/// rampage bit are the board's and are left as they were.
pub fn rmw_switches(keys: Vec<hall::KeySwitch>, info: DeviceInfo) -> Rmw {
    Rmw {
        get: GET_MAGNETIC_RT,
        set: SET_MAGNETIC_RT,
        len: RT_LEN,
        addr: 0,
        patch: Box::new(move |raw| {
            rt_patch(raw, &keys, &info);
            Ok(())
        }),
    }
}

/// Every slot set to the same key, for the "apply to all" button.
pub fn rmw_switches_all(key: &hall::KeySwitch, info: DeviceInfo) -> Rmw {
    let keys = (0..RT_SLOTS)
        .map(|s| {
            let mut k = key.clone();
            k.slot = s as u8;
            k
        })
        .collect();
    rmw_switches(keys, info)
}

/// Pack the macro blocks back into an index and a payload. Offsets are
/// absolute in the same space as the index, which occupies the first 400
/// bytes, so the payload starts there. A `None` slot is left unclaimed.
pub fn macro_relayout(blocks: &[Option<Vec<u8>>]) -> (Vec<u8>, Vec<u8>) {
    let mut index = vec![0u8; MACRO_INDEX_LEN];
    let mut payload = Vec::new();
    let mut cursor = MACRO_INDEX_LEN as u32;
    for (i, block) in blocks.iter().enumerate().take(MACRO_SLOTS) {
        if let Some(b) = block {
            index[i * 4..i * 4 + 4].copy_from_slice(&cursor.to_le_bytes());
            payload.extend_from_slice(b);
            cursor += b.len() as u32;
        }
    }
    (index, payload)
}

/// The payload length a macro block header declares, from its first two
/// bytes: a count of action half-words, four bytes to the action.
///
/// `space` is the board's own macro budget, device info bytes 2-3. The
/// count comes back off the board, and an erased index entry points at
/// `FF FF`: unclamped that asks for 128 KB in 56-byte chunks, two thousand
/// paced reads for one slot and a hundred slots in a rewrite. The vendor
/// refuses a macro store larger than `space`, so no honest block is.
pub fn macro_body_len(header: &[u8], space: u16) -> usize {
    if header.len() < 2 {
        return 0;
    }
    (u16::from_le_bytes([header[0], header[1]]) as usize)
        .saturating_mul(2)
        .min(macro_space_or_default(space))
}

/// The vendor falls back to 512 on a board that does not report its own.
pub fn macro_space_or_default(space: u16) -> usize {
    if space == 0 {
        512
    } else {
        usize::from(space)
    }
}
