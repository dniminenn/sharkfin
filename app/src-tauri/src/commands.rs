// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::hid::{self, HidError, Transport};
use crate::protocol::{
    cmd, family_cmds, Checksum, FamilyCmds, KbOptions, LedParam, Macro, SledParam, SleepTimes,
};
use crate::registry::{self, DeviceSpec};

pub struct AppState {
    inner: Mutex<Inner>,
}

struct Inner {
    api: Option<hidapi::HidApi>,
    open: Option<OpenDevice>,
    last_flash: Option<Instant>,
    last_light: Option<Instant>,
    last_key: Option<Instant>,
    /// Set when the firmware stalls. Reopening a stalled device does not
    /// recover it and the extra traffic keeps it pinned, so scanning stops
    /// until the hardware disappears from the bus, i.e. someone replugs.
    stalled: bool,
}

struct OpenDevice {
    path: String,
    transport: Transport,
    spec: DeviceSpec,
    /// Last time the device demonstrably answered.
    last_ok: Instant,
}

/// How long a successful exchange vouches for the connection. Below this,
/// `scan` answers from cache instead of putting another identify round-trip on
/// the wire -- the frontend polls, and every poll used to contend with real
/// work and add to the write pressure that stalls the endpoint.
const LIVENESS_TTL: Duration = Duration::from_secs(20);

/// Per-key colour and macro uploads land in flash. Back to back they stall
/// the control endpoint within a couple of batches: measured on an X86,
/// 7 reports every 500 ms dies after ~13, every 3 s survives indefinitely.
/// Enforced here rather than in the UI so no caller can wedge a keyboard.
const FLASH_COOLDOWN: Duration = Duration::from_secs(10);

/// Spacing between pages inside one upload. Transport's 12 ms floor pushes
/// the whole batch out in under 100 ms, which is far harder than anything
/// the firmware was measured surviving.
const FLASH_PAGE_GAP: Duration = Duration::from_millis(100);

/// How long the board is left completely alone after a flash batch. The
/// vendor waits 500 ms; two uploads at that pace stalled an X86, so assume
/// the commit takes longer than the vendor thinks and hold the device lock
/// throughout, which also keeps the frontend's polling off the wire.
const FLASH_SETTLE: Duration = Duration::from_secs(2);

/// Single-slot key writes persist to onboard storage, so they are flash
/// writes too. Measured on an X86: nine of them 150 ms apart stalled the
/// control endpoint. One per click is fine; anything in a loop is not.
const KEY_GAP: Duration = Duration::from_millis(400);

/// Lighting is the one thing a UI drags, and sustained feature reports stall
/// the control endpoint even when nothing touches flash. The frontend
/// coalesces, but the floor lives here so no caller can flood the board.
const LIGHT_GAP: Duration = Duration::from_millis(120);

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                api: None,
                open: None,
                last_flash: None,
                last_light: None,
                last_key: None,
                stalled: false,
            }),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedDevice {
    pub path: String,
    pub device_id: u32,
    pub spec: DeviceSpec,
    /// Families whose opcodes aren't established never accept writes.
    pub read_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredUnknown {
    pub path: String,
    pub product_id: u16,
    pub product: String,
    pub device_id: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub connected: Option<ConnectedDevice>,
    pub unknown: Vec<DiscoveredUnknown>,
    /// A keyboard was found but its device node could not be opened. On
    /// Linux that is almost always a missing udev rule; without saying so
    /// the app reports "no device" with the keyboard plugged in.
    pub open_failed: bool,
    /// The firmware stalled and the board must be replugged. Nothing is
    /// retried while this is set.
    pub stalled: bool,
}

/// Light mode that displays an uploaded per-key pattern.
const PER_KEY_MODE: u8 = 13;

/// Shown whenever the firmware has stalled. Only a replug clears it.
pub const STALL_MESSAGE: &str =
    "The keyboard stopped responding. Unplug it, wait ten seconds, and plug it back in.";

fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

impl Inner {
    fn api(&mut self) -> Result<&hidapi::HidApi, String> {
        if self.api.is_none() {
            self.api = Some(hidapi::HidApi::new().map_err(err_str)?);
        } else if let Some(api) = self.api.as_mut() {
            api.refresh_devices().map_err(err_str)?;
        }
        Ok(self.api.as_ref().unwrap())
    }
}

/// Open and identify the first recognized board; frontend polls this.
#[tauri::command]
pub fn scan(state: tauri::State<AppState>) -> Result<ScanResult, String> {
    let mut inner = state.inner.lock();

    if let Some(open) = &mut inner.open {
        let fresh = open.last_ok.elapsed() < LIVENESS_TTL;
        if fresh || open.transport.identify().is_ok() {
            if !fresh {
                open.last_ok = Instant::now();
            }
            let open = inner.open.as_ref().unwrap();
            return Ok(ScanResult {
                connected: Some(ConnectedDevice {
                    path: open.path.clone(),
                    device_id: open.spec.id,
                    read_only: !open.spec.writes_supported(),
                    spec: open.spec.clone(),
                }),
                unknown: vec![],
                open_failed: false,
                stalled: false,
            });
        }
        inner.open = None;
    }

    let found = {
        let api = inner.api()?;
        hid::discover(api)
    };

    if inner.stalled {
        // Opening a stalled device does not recover it, and the traffic keeps
        // it wedged. Wait for it to leave the bus, which is what a replug does.
        if found.is_empty() {
            inner.stalled = false;
        } else {
            return Ok(ScanResult {
                connected: None,
                unknown: vec![],
                open_failed: false,
                stalled: true,
            });
        }
    }

    let mut unknown = Vec::new();
    let mut connected = None;
    let mut open_failed = false;

    for d in found {
        let api = inner.api.as_ref().unwrap();
        let transport = match Transport::open(api, &d.path) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("open {} failed: {e}", d.path);
                open_failed = true;
                continue;
            }
        };
        match transport.identify() {
            Ok(id) => match registry::by_id(id) {
                Some(spec) => {
                    connected = Some(ConnectedDevice {
                        path: d.path.clone(),
                        device_id: id,
                        read_only: !spec.writes_supported(),
                        spec: spec.clone(),
                    });
                    inner.open = Some(OpenDevice {
                        path: d.path,
                        transport,
                        spec,
                        last_ok: Instant::now(),
                    });
                    break;
                }
                None => unknown.push(DiscoveredUnknown {
                    path: d.path,
                    product_id: d.product_id,
                    product: d.product,
                    device_id: Some(id),
                }),
            },
            Err(_) => unknown.push(DiscoveredUnknown {
                path: d.path,
                product_id: d.product_id,
                product: d.product,
                device_id: None,
            }),
        }
    }

    Ok(ScanResult {
        connected,
        unknown,
        open_failed,
        stalled: false,
    })
}

/// The two families assign the same opcodes to different registers, so a
/// command that is not opcode-identical across families must go through the
/// resolved table -- `None` means the family is unknown and only shared
/// commands are safe.
fn need(fc: Option<&'static FamilyCmds>) -> Result<&'static FamilyCmds, HidError> {
    fc.ok_or_else(|| HidError::Protocol("this board's protocol family is unknown".into()))
}

/// Runs `f` against the open device, then records liveness. A stalled endpoint
/// invalidates the handle: the firmware will refuse everything until it is
/// reopened, and silently retrying forever is worse than reconnecting.
fn run<T>(
    state: &tauri::State<AppState>,
    require_writable: bool,
    f: impl FnOnce(&Transport, Option<&'static FamilyCmds>) -> Result<T, HidError>,
) -> Result<T, String> {
    let mut inner = state.inner.lock();
    let open = inner.open.as_mut().ok_or("no device connected")?;
    if require_writable && !open.spec.writes_supported() {
        return Err(format!(
            "sharkfin doesn't know the {} command set, so it will not write to {}",
            open.spec.family,
            open.spec.label(),
        ));
    }
    let fc = family_cmds(&open.spec.family);
    match f(&open.transport, fc) {
        Ok(v) => {
            open.last_ok = Instant::now();
            Ok(v)
        }
        Err(e) => {
            if e.is_stall() {
                log::warn!("device stalled, dropping handle: {e}");
                inner.open = None;
                inner.stalled = true;
                Err(STALL_MESSAGE.into())
            } else {
                Err(e.to_string())
            }
        }
    }
}

fn with_open<T>(
    state: &tauri::State<AppState>,
    f: impl FnOnce(&Transport, Option<&'static FamilyCmds>) -> Result<T, HidError>,
) -> Result<T, String> {
    run(state, false, f)
}

/// Only boards on a protocol family we have actually verified accept writes.
/// Another family's opcodes land on different registers, and a keymap page
/// write is not recoverable from a mistake.
fn with_writable<T>(
    state: &tauri::State<AppState>,
    f: impl FnOnce(&Transport, Option<&'static FamilyCmds>) -> Result<T, HidError>,
) -> Result<T, String> {
    run(state, true, f)
}

#[tauri::command]
pub fn get_led_param(state: tauri::State<AppState>) -> Result<LedParam, String> {
    with_open(&state, |t, _| {
        let reply = t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)?;
        LedParam::from_reply(&reply).ok_or_else(|| HidError::Protocol("bad LEDPARAM reply".into()))
    })
}

#[tauri::command]
pub fn set_led_param(state: tauri::State<AppState>, param: LedParam) -> Result<(), String> {
    light_gap(&state);
    with_writable(&state, |t, _| {
        t.send(&param.to_packet())?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_profile(state: tauri::State<AppState>) -> Result<u8, String> {
    with_open(&state, |t, fc| {
        let reply = t.roundtrip(need(fc)?.get_profile, &[], Checksum::Bit7)?;
        Ok(reply[1])
    })
}

#[tauri::command]
pub fn set_profile(state: tauri::State<AppState>, profile: u8) -> Result<(), String> {
    with_writable(&state, |t, fc| {
        let pkt = crate::protocol::packet(need(fc)?.set_profile, &[profile], Checksum::Bit7);
        t.send(&pkt)?;
        Ok(())
    })
}

/// 512-byte matrix: 128 slots × 4 bytes, read as 8 raw pages. gen2 payloads
/// carry a 0xFF sentinel and put the page a byte later.
fn read_matrix(
    t: &Transport,
    fc: &'static FamilyCmds,
    profile: u8,
    fn_layer: bool,
) -> Result<Vec<u8>, HidError> {
    let mut matrix = Vec::with_capacity(512);
    for page in 0..8u8 {
        let (opcode, payload): (u8, Vec<u8>) = match (fc.name == "gen2", fn_layer) {
            (true, false) => (
                fc.get_keymatrix,
                crate::protocol::gen2::keymatrix_read_payload(profile, page).to_vec(),
            ),
            (true, true) => (
                cmd::GET_FN,
                crate::protocol::gen2::fn_read_payload(profile, page).to_vec(),
            ),
            (false, false) => (fc.get_keymatrix, vec![profile, page]),
            (false, true) => (cmd::GET_FN, vec![profile, page]),
        };
        let reply = t.read_raw_page(opcode, &payload, Checksum::Bit7)?;
        matrix.extend_from_slice(&reply);
    }
    Ok(matrix)
}

fn key_write_packet(
    fc: &'static FamilyCmds,
    profile: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<[u8; crate::protocol::REPORT_LEN], HidError> {
    if fc.name == "gen2" {
        return Ok(if fn_layer {
            crate::protocol::gen2::set_fn_key_packet(profile, slot, value)
        } else {
            crate::protocol::gen2::set_key_packet(profile, slot, value)
        });
    }
    let opcode = if fn_layer {
        fc.set_fn_one
    } else {
        fc.set_key_one
    }
    .ok_or_else(|| HidError::Protocol("no single-slot key write for this family".into()))?;
    let mut pkt = crate::protocol::packet(opcode, &[profile, slot], Checksum::Bit7);
    pkt[8..12].copy_from_slice(&value);
    Ok(pkt)
}

/// Which build this is, for the UI to show and a reporter to quote.
#[tauri::command]
pub fn build_id() -> String {
    registry::build_id()
}

#[tauri::command]
pub fn read_keymap(state: tauri::State<AppState>, profile: u8) -> Result<Vec<u8>, String> {
    with_open(&state, |t, fc| read_matrix(t, need(fc)?, profile, false))
}

#[tauri::command]
pub fn read_fn_keymap(state: tauri::State<AppState>, layer: u8) -> Result<Vec<u8>, String> {
    with_open(&state, |t, fc| read_matrix(t, need(fc)?, layer, true))
}

/// One slot: [op, profile, slot, 0.., ck7, value×4].
#[tauri::command]
pub fn set_key(
    state: tauri::State<AppState>,
    profile: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<(), String> {
    key_gap(&state);
    with_writable(&state, |t, fc| {
        t.send(&key_write_packet(
            need(fc)?,
            profile,
            slot,
            value,
            fn_layer,
        )?)?;
        Ok(())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub debounce: u8,
    pub sleep: SleepTimes,
    /// Absent on families whose option bitfield is not decoded.
    pub options: Option<KbOptions>,
    /// Firmware revision as reported by 0x80, e.g. 0x0102 -> "1.02".
    pub revision: String,
    /// Board auto-detects the host OS and switches its Win/Mac layer.
    pub auto_os: bool,
    /// Present only when the firmware answers 0x88.
    pub side_light: Option<SledParam>,
}

#[tauri::command]
pub fn get_settings(state: tauri::State<AppState>) -> Result<DeviceSettings, String> {
    let has_side_light = {
        let inner = state.inner.lock();
        inner
            .open
            .as_ref()
            .map(|o| o.spec.features.side_light)
            .unwrap_or(false)
    };
    with_open(&state, |t, fc| {
        let fc = need(fc)?;
        let deb = t.roundtrip(fc.get_debounce, &[], Checksum::Bit7)?;
        let slp = t.roundtrip(fc.get_sleeptime, &[], Checksum::Bit7)?;
        let opt = match fc.kboption {
            Some((_, get)) => Some(t.roundtrip(get, &[0], Checksum::Bit7)?),
            None => None,
        };
        let revision = match fc.get_revision {
            Some(op) => {
                let rev = t.roundtrip(op, &[], Checksum::Bit7)?;
                format!("{}.{:02}", rev[2], rev[1])
            }
            None => "unknown".into(),
        };
        let auto = fc
            .auto_os
            .and_then(|(_, get)| t.roundtrip(get, &[], Checksum::Bit7).ok());
        // Only probe the edge light on boards that physically have one.
        let sled = match (has_side_light, fc.sled) {
            (true, Some((_, get))) => t
                .roundtrip(get, &[], Checksum::Bit7)
                .ok()
                .and_then(|r| SledParam::from_reply(&r)),
            _ => None,
        };
        Ok(DeviceSettings {
            debounce: deb[fc.debounce_at],
            sleep: SleepTimes::from_reply_expecting(&slp, fc.get_sleeptime, fc.sleep_reply_at)
                .ok_or_else(|| HidError::Protocol("bad SLEEPTIME reply".into()))?,
            options: match (opt, fc.kboption) {
                (Some(o), Some((_, get))) => Some(
                    KbOptions::from_reply_expecting(&o, get)
                        .ok_or_else(|| HidError::Protocol("bad KBOPTION reply".into()))?,
                ),
                _ => None,
            },
            revision,
            auto_os: auto.map(|r| r[1] == 1).unwrap_or(false),
            side_light: sled,
        })
    })
}

#[tauri::command]
pub fn set_debounce(state: tauri::State<AppState>, value: u8) -> Result<(), String> {
    let value = value.clamp(1, 10);
    with_writable(&state, |t, fc| {
        let fc = need(fc)?;
        // yc500 pads with a zero byte before the value; gen2 does not.
        let payload: &[u8] = if fc.debounce_at == 1 {
            &[value]
        } else {
            &[0, value]
        };
        let pkt = crate::protocol::packet(fc.set_debounce, payload, Checksum::Bit7);
        t.send(&pkt)
    })
}

#[tauri::command]
pub fn set_sleep(state: tauri::State<AppState>, sleep: SleepTimes) -> Result<(), String> {
    with_writable(&state, |t, fc| {
        t.send(&sleep.to_packet_as(need(fc)?.set_sleeptime))
    })
}

/// Read-modify-write so bits sharkfin doesn't model survive untouched.
#[tauri::command]
pub fn set_options(state: tauri::State<AppState>, options: KbOptions) -> Result<(), String> {
    with_writable(&state, |t, fc| {
        let (set, get) = need(fc)?.kboption.ok_or_else(|| {
            HidError::Protocol(
                "keyboard options are not decoded for this board's protocol family".into(),
            )
        })?;
        let cur = t.roundtrip(get, &[0], Checksum::Bit7)?;
        t.send(&options.to_packet_as(set, cur[2], cur[3], cur[4]))
    })
}

#[tauri::command]
pub fn set_side_light(state: tauri::State<AppState>, param: SledParam) -> Result<(), String> {
    {
        let inner = state.inner.lock();
        let spec = inner
            .open
            .as_ref()
            .map(|o| &o.spec)
            .ok_or("no device connected")?;
        if !spec.features.side_light {
            return Err(format!("{} has no edge light", spec.label()));
        }
    }
    with_writable(&state, |t, fc| {
        need(fc)?.sled.ok_or_else(|| {
            HidError::Protocol("edge light opcodes unknown for this family".into())
        })?;
        t.send(&param.to_packet())
    })
}

#[tauri::command]
pub fn set_auto_os(state: tauri::State<AppState>, enabled: bool) -> Result<(), String> {
    with_writable(&state, |t, fc| {
        let (set, _) = need(fc)?.auto_os.ok_or_else(|| {
            HidError::Protocol("host-OS auto-detect opcodes unknown for this family".into())
        })?;
        let pkt = crate::protocol::packet(set, &[enabled as u8], Checksum::Bit7);
        t.send(&pkt)
    })
}

/// Wipes every onboard profile, keymap, macro and light setting. Firmware
/// needs a few seconds; the frontend re-reads afterwards.
#[tauri::command]
pub fn factory_reset(state: tauri::State<AppState>) -> Result<(), String> {
    with_writable(&state, |t, fc| {
        let pkt = crate::protocol::packet(need(fc)?.set_reset, &[], Checksum::Bit7);
        t.send(&pkt)
    })
}

/// Spaces key writes by KEY_GAP.
fn key_gap(state: &tauri::State<AppState>) {
    let mut inner = state.inner.lock();
    if let Some(prev) = inner.last_key {
        let since = prev.elapsed();
        if since < KEY_GAP {
            let wait = KEY_GAP - since;
            drop(inner);
            std::thread::sleep(wait);
            state.inner.lock().last_key = Some(Instant::now());
            return;
        }
    }
    inner.last_key = Some(Instant::now());
}

/// Spaces lighting writes by LIGHT_GAP.
fn light_gap(state: &tauri::State<AppState>) {
    let mut inner = state.inner.lock();
    if let Some(prev) = inner.last_light {
        let since = prev.elapsed();
        if since < LIGHT_GAP {
            let wait = LIGHT_GAP - since;
            drop(inner);
            std::thread::sleep(wait);
            state.inner.lock().last_light = Some(Instant::now());
            return;
        }
    }
    inner.last_light = Some(Instant::now());
}

/// Blocks until FLASH_COOLDOWN has passed since the last flash-backed upload,
/// then stamps the clock for the next caller.
fn flash_cooldown(state: &tauri::State<AppState>) {
    let mut inner = state.inner.lock();
    if let Some(prev) = inner.last_flash {
        let since = prev.elapsed();
        if since < FLASH_COOLDOWN {
            let wait = FLASH_COOLDOWN - since;
            drop(inner);
            std::thread::sleep(wait);
            state.inner.lock().last_flash = Some(Instant::now());
            return;
        }
    }
    inner.last_flash = Some(Instant::now());
}

/// Upload 384 bytes of per-key colour (128 slots × RGB, matrix order) and
/// optionally switch the backlight to the pattern mode that shows it.
///
/// Write-only by design: `GET_USERPIC` returns stable data that does *not*
/// reflect what was just written, so the board is not a source of truth here
/// and the host keeps the pattern. Verified visually on an X86.
#[tauri::command]
pub fn write_per_key(
    state: tauri::State<AppState>,
    colors: Vec<u8>,
    activate: bool,
) -> Result<(), String> {
    if colors.len() != crate::protocol::PER_KEY_BYTES {
        return Err(format!(
            "expected {} colour bytes, got {}",
            crate::protocol::PER_KEY_BYTES,
            colors.len()
        ));
    }
    flash_cooldown(&state);
    with_writable(&state, |t, _| {
        // Decide about the mode switch before the upload: asking afterwards
        // means talking to a board that is still writing flash.
        let needs_mode = activate
            && t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
                .ok()
                .and_then(|r| LedParam::from_reply(&r))
                .map(|p| p.mode != PER_KEY_MODE)
                .unwrap_or(true);

        for page in 0..7u8 {
            t.send(&crate::protocol::userpic_write_packet(page, &colors))?;
            std::thread::sleep(FLASH_PAGE_GAP);
        }
        std::thread::sleep(FLASH_SETTLE);

        if needs_mode {
            t.send(
                &LedParam {
                    mode: PER_KEY_MODE,
                    speed: 2,
                    brightness: 4,
                    option: 0,
                    dazzle: false,
                    r: 0,
                    g: 200,
                    b: 200,
                }
                .to_packet(),
            )?;
        }
        Ok(())
    })
}

fn check_macro_slot(slot: u8) -> Result<(), String> {
    if slot >= crate::protocol::MACRO_SLOTS {
        return Err(format!(
            "macro slot {slot} out of range (0..{})",
            crate::protocol::MACRO_SLOTS
        ));
    }
    Ok(())
}

/// 256-byte blob over four raw pages. Unlike `GET_USERPIC`, this read does
/// reflect the last write (verified on an X86), so the board is a usable
/// source of truth for macros.
#[tauri::command]
pub fn read_macro(state: tauri::State<AppState>, slot: u8) -> Result<Macro, String> {
    check_macro_slot(slot)?;
    with_open(&state, |t, _| {
        let mut blob = [0u8; crate::protocol::MACRO_BYTES];
        for page in 0..4u8 {
            let reply = t.read_raw_page(cmd::GET_MACRO, &[slot, page], Checksum::Bit7)?;
            blob[page as usize * 64..(page as usize + 1) * 64].copy_from_slice(&reply);
        }
        Ok(Macro::from_blob(&blob))
    })
}

/// Sends only the pages the blob occupies, last-page flag on the final one.
#[tauri::command]
pub fn write_macro(state: tauri::State<AppState>, slot: u8, data: Macro) -> Result<(), String> {
    check_macro_slot(slot)?;
    let blob = data.to_blob()?;
    flash_cooldown(&state);
    with_writable(&state, |t, fc| {
        let opcode = need(fc)?.set_macro;
        let pages = crate::protocol::macro_pages(&blob);
        for page in 0..pages {
            t.send(&crate::protocol::macro_write_packet(
                opcode,
                slot,
                page,
                page + 1 == pages,
                &blob,
            ))?;
        }
        Ok(())
    })
}

/// Everything sharkfin can read back from a board, as one restorable file.
/// Per-key colour is absent by necessity: the firmware never reports it.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConfig {
    version: u8,
    device_id: u32,
    family: String,
    board: String,
    profiles: Vec<Vec<u8>>,
    fn_layers: Vec<Vec<u8>>,
    led: LedParam,
    side_light: Option<SledParam>,
    debounce: u8,
    sleep: SleepTimes,
    options: Option<KbOptions>,
}

#[tauri::command]
pub fn export_config(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    let spec = {
        let inner = state.inner.lock();
        inner
            .open
            .as_ref()
            .map(|o| o.spec.clone())
            .ok_or("no device connected")?
    };
    let cfg = with_open(&state, |t, fc| {
        let fc = need(fc)?;
        let n = spec.profiles.clamp(1, 3);
        let mut profiles = Vec::new();
        let mut fn_layers = Vec::new();
        for p in 0..n {
            profiles.push(read_matrix(t, fc, p, false)?);
            fn_layers.push(read_matrix(t, fc, p, true)?);
        }
        let led = t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)?;
        let deb = t.roundtrip(fc.get_debounce, &[], Checksum::Bit7)?;
        let slp = t.roundtrip(fc.get_sleeptime, &[], Checksum::Bit7)?;
        let opt = match fc.kboption {
            Some((_, get)) => Some(t.roundtrip(get, &[0], Checksum::Bit7)?),
            None => None,
        };
        let sled = match (spec.features.side_light, fc.sled) {
            (true, Some((_, get))) => t
                .roundtrip(get, &[], Checksum::Bit7)
                .ok()
                .and_then(|r| SledParam::from_reply(&r)),
            _ => None,
        };
        Ok(SavedConfig {
            version: 1,
            device_id: spec.id,
            family: spec.family.clone(),
            board: spec.label(),
            profiles,
            fn_layers,
            led: LedParam::from_reply(&led)
                .ok_or_else(|| HidError::Protocol("bad LEDPARAM reply".into()))?,
            side_light: sled,
            debounce: deb[fc.debounce_at],
            sleep: SleepTimes::from_reply_expecting(&slp, fc.get_sleeptime, fc.sleep_reply_at)
                .ok_or_else(|| HidError::Protocol("bad SLEEPTIME reply".into()))?,
            options: match (opt, fc.kboption) {
                (Some(o), Some((_, get))) => KbOptions::from_reply_expecting(&o, get),
                _ => None,
            },
        })
    })?;
    let json = serde_json::to_string_pretty(&cfg).map_err(err_str)?;
    std::fs::write(&path, json).map_err(err_str)?;
    Ok(format!("saved {} profiles to {path}", cfg.profiles.len()))
}

/// Applies a saved config: only slots that differ are written, then the
/// settings and lighting. Refuses configs from a different board model,
/// slot meanings follow the board's matrix.
#[tauri::command]
pub fn import_config(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    let raw = std::fs::read_to_string(&path).map_err(err_str)?;
    let cfg: SavedConfig = serde_json::from_str(&raw).map_err(err_str)?;
    let spec = {
        let inner = state.inner.lock();
        inner
            .open
            .as_ref()
            .map(|o| o.spec.clone())
            .ok_or("no device connected")?
    };
    if cfg.device_id != spec.id {
        return Err(format!(
            "this config was exported from {} (device id {}), but {} (id {}) is connected",
            cfg.board,
            cfg.device_id,
            spec.label(),
            spec.id
        ));
    }
    with_writable(&state, |t, fc| {
        let fc = need(fc)?;
        let mut keys_written = 0usize;
        for (fn_layer, layers) in [(false, &cfg.profiles), (true, &cfg.fn_layers)] {
            for (p, target) in layers.iter().enumerate() {
                if target.len() != 512 {
                    return Err(HidError::Protocol(format!(
                        "profile {p} in the file is {} bytes, expected 512",
                        target.len()
                    )));
                }
                let current = read_matrix(t, fc, p as u8, fn_layer)?;
                for slot in 0..128usize {
                    let want: [u8; 4] = target[slot * 4..slot * 4 + 4].try_into().unwrap();
                    if current[slot * 4..slot * 4 + 4] != want {
                        t.send(&key_write_packet(fc, p as u8, slot as u8, want, fn_layer)?)?;
                        keys_written += 1;
                        std::thread::sleep(KEY_GAP);
                    }
                }
            }
        }
        if let (Some(opts), Some((set, get))) = (cfg.options, fc.kboption) {
            let cur = t.roundtrip(get, &[0], Checksum::Bit7)?;
            t.send(&opts.to_packet_as(set, cur[2], cur[3], cur[4]))?;
        }
        let deb = cfg.debounce.clamp(1, 10);
        let deb_payload: &[u8] = if fc.debounce_at == 1 {
            &[deb]
        } else {
            &[0, deb]
        };
        t.send(&crate::protocol::packet(
            fc.set_debounce,
            deb_payload,
            Checksum::Bit7,
        ))?;
        t.send(&cfg.sleep.to_packet_as(fc.set_sleeptime))?;
        if let (Some(sled), true, Some(_)) = (cfg.side_light, spec.features.side_light, fc.sled) {
            t.send(&sled.to_packet())?;
        }
        t.send(&cfg.led.to_packet())?;
        Ok(format!(
            "restored {keys_written} keys, settings and lighting from {}",
            cfg.board
        ))
    })
}

/// Every GET opcode from both family tables. All reads, all harmless; on a
/// board that doesn't implement one, the firmware echoes its previous reply,
/// which is itself a data point.
const BUNDLE_PROBES: &[(&str, u8, &[u8])] = &[
    ("0x80 revision", 0x80, &[]),
    ("0x83 report rate (gen2)", 0x83, &[]),
    ("0x84 profile (gen2)", 0x84, &[]),
    ("0x85 profile (yc500)", 0x85, &[]),
    ("0x86 options/debounce", 0x86, &[0]),
    ("0x87 backlight", 0x87, &[]),
    ("0x88 edge light", 0x88, &[]),
    ("0x89 keymap/options p0", 0x89, &[0, 0]),
    ("0x8A keymap (gen2) p0", 0x8A, &[0, 0]),
    ("0x8B macro s0 p0", 0x8B, &[0, 0]),
    ("0x8C userpic p0", 0x8C, &[0, 0]),
    ("0x8F identify", 0x8F, &[]),
    ("0x90 fn layer p0", 0x90, &[0, 0]),
    ("0x91 debounce/sleep", 0x91, &[]),
    ("0x92 sleep (yc500)", 0x92, &[]),
    ("0x97 auto-OS (yc500)", 0x97, &[]),
];

fn probe_sweep(t: &Transport, out: &mut String) {
    use std::fmt::Write;
    let _ = writeln!(
        out,
        "\nread sweep, both families' GET opcodes; an unimplemented \
         command echoes the previous reply:"
    );
    for (label, opcode, payload) in BUNDLE_PROBES {
        match t.read_raw_page(*opcode, payload, Checksum::Bit7) {
            Ok(reply) => {
                let hex: String = reply.iter().fold(String::new(), |mut s, b| {
                    let _ = write!(s, "{b:02x} ");
                    s
                });
                let _ = writeln!(out, "{label:<24} {}", hex.trim_end());
            }
            Err(e) => {
                let _ = writeln!(out, "{label:<24} error: {e}");
            }
        }
    }
}

/// Everything a developer needs from a board they don't own, as text the
/// owner pastes into a GitHub issue. Read-only. `path` reaches a discovered
/// board the registry does not know; without it the open board is used.
#[tauri::command]
pub fn contribution_bundle(
    state: tauri::State<AppState>,
    path: Option<String>,
) -> Result<String, String> {
    use std::fmt::Write;
    let spec = {
        let inner = state.inner.lock();
        inner.open.as_ref().map(|o| o.spec.clone())
    };
    let Some(spec) = spec else {
        return unregistered_bundle(&state, path.ok_or("no device connected")?);
    };
    with_open(&state, |t, _| {
        let mut out = String::new();
        let _ = writeln!(out, "```");
        let _ = writeln!(out, "sharkfin {} data bundle", registry::build_id());
        let _ = writeln!(out, "board  : {} (device id {})", spec.label(), spec.id);
        let _ = writeln!(
            out,
            "usb    : {:04x}:{:04x}  internal {}",
            spec.vendor_id, spec.product_id, spec.internal_name
        );
        let _ = writeln!(
            out,
            "family : {} (writes {})",
            spec.family,
            if spec.writes_supported() {
                "yes"
            } else {
                "read-only"
            }
        );
        probe_sweep(t, &mut out);
        let _ = writeln!(out, "```");
        Ok(out)
    })
}

/// Bundle for a discovered board whose identify answer is not in the
/// registry. The same read-only probes; the header carries what discovery
/// saw instead of a registry entry.
fn unregistered_bundle(state: &tauri::State<AppState>, path: String) -> Result<String, String> {
    use std::fmt::Write;
    let mut inner = state.inner.lock();
    if inner.stalled {
        return Err(STALL_MESSAGE.into());
    }
    let (d, t) = {
        let api = inner.api()?;
        let d = hid::discover(api)
            .into_iter()
            .find(|d| d.path == path)
            .ok_or("that keyboard is no longer there")?;
        let t = Transport::open(api, &path).map_err(err_str)?;
        (d, t)
    };
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "sharkfin {} data bundle", registry::build_id());
    let product = if d.product.is_empty() {
        "unnamed board"
    } else {
        &d.product
    };
    let _ = writeln!(out, "board  : {product} (not in the registry)");
    let _ = writeln!(out, "usb    : {:04x}:{:04x}", d.vendor_id, d.product_id);
    match t.identify() {
        Ok(id) => {
            let _ = writeln!(out, "identify: device id {id}");
        }
        Err(e) if e.is_stall() => {
            inner.stalled = true;
            return Err(STALL_MESSAGE.into());
        }
        Err(_) => {
            let _ = writeln!(out, "identify: no answer");
        }
    }
    probe_sweep(&t, &mut out);
    let _ = writeln!(out, "```");
    Ok(out)
}

/// Dev escape hatch.
#[tauri::command]
pub fn raw_command(
    state: tauri::State<AppState>,
    opcode: u8,
    payload: Vec<u8>,
    checksum: String,
) -> Result<Vec<u8>, String> {
    let mode = match checksum.as_str() {
        "bit7" => Checksum::Bit7,
        "bit8" => Checksum::Bit8,
        _ => Checksum::None,
    };
    with_open(&state, |t, _| {
        let reply = t.roundtrip(opcode, &payload, mode)?;
        Ok(reply.to_vec())
    })
}
