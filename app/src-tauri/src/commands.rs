// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::hid::{self, HidError, Link, Transport};
use crate::ops::{self, check_macro_slot, key_write_packet, need};
use crate::protocol::hall;
use crate::protocol::{
    cmd, family_cmds, Checksum, FamilyCmds, KbOptions, LedParam, Macro, SledParam, SleepTimes,
};
use crate::registry::{self, DeviceSpec};
use crate::session::{switch_access, DeviceSettings, OwnerRecord, SavedConfig, SwitchAccess};
use crate::wire::block_on;

pub struct AppState {
    inner: Mutex<Inner>,
}

struct Inner {
    api: Option<hidapi::HidApi>,
    open: Option<OpenDevice>,
    last_flash: Option<Instant>,
    /// Last write claim: instant, and the quiet that write required after itself.
    last_write: Option<(Instant, Duration)>,
    /// Firmware stalled. Reopen does not recover it; extra traffic pins it.
    /// Scan stops until the device leaves the bus (a replug).
    stalled: bool,
    /// Unregistered board: owner allowed writes this session. Cleared with the handle.
    unregistered_ok: bool,
    /// Owner override for the LEDPARAM flags nibble. Kept off the spec so
    /// the spec still describes the board as shipped. Cleared with the handle.
    led_swap: Option<bool>,
    /// Check answers, applied by the frontend on connect. Cleared with the handle.
    owner: OwnerRecord,
    /// Slot the check may write switch columns to during its felt test.
    /// Nothing else opens. Cleared with the handle.
    switch_trial: Option<u8>,
    /// The last picture upload, for the bundle. Keyed by device id, so it
    /// outlives the handle and never describes another board.
    screen_write: Option<ops::ScreenOutcome>,
}

struct OpenDevice {
    path: String,
    transport: Transport,
    spec: DeviceSpec,
    /// Last time the device demonstrably answered.
    last_ok: Instant,
    /// Reported by the receiver alongside identify; there is no such number
    /// by cable.
    battery: Option<u8>,
    usage: u16,
    /// The `0x80` reply as a u16, read once at connect. Gates the yc500
    /// switch columns, which arrived with firmware 2.00.
    revision: Option<u16>,
}

impl OpenDevice {
    fn connected(&self, unregistered_ok: bool, owner_hall: bool) -> ConnectedDevice {
        let read_only =
            !self.spec.writes_supported() || (self.spec.unregistered && !unregistered_ok);
        ConnectedDevice {
            path: self.path.clone(),
            device_id: self.spec.id,
            read_only,
            switches: switch_access(&self.spec, self.revision, read_only, owner_hall),
            revision: self.revision,
            spec: self.spec.clone(),
            link: self.transport.link(),
            battery: self.battery,
        }
    }

    /// Whether this board addresses profiles as `profile * 4 + sublayer`.
    fn scaled_profiles(&self) -> bool {
        ops::scaled_profiles(&self.spec)
    }
}

/// How long a successful exchange vouches for the connection. `scan` answers
/// from cache inside this window. Frontend polls; another identify per poll
/// stalls the endpoint.
const LIVENESS_TTL: Duration = Duration::from_secs(20);

/// Per-key colour and macros land in flash. X86: 7 reports / 500 ms dies
/// after ~13; 3 s survives. Enforced here so no caller can skip it.
const FLASH_COOLDOWN: Duration = Duration::from_secs(10);

/// Gap between pages of one upload. Transport's 12 ms floor would dump a
/// batch in under 100 ms.
const FLASH_PAGE_GAP: Duration = Duration::from_millis(100);

/// Idle after a flash batch. Vendor waits 500 ms; two uploads at that pace
/// stalled an X86. Hold the device lock so poll stays off the wire.
const FLASH_SETTLE: Duration = Duration::from_secs(2);

/// The two above, for uploads that run inside `ops`.
const FLASH_PACE: ops::FlashPace = ops::FlashPace {
    page_gap_ms: FLASH_PAGE_GAP.as_millis() as u64,
    settle_ms: FLASH_SETTLE.as_millis() as u64,
};

/// Single-slot key writes are flash. X86: nine at 150 ms stalled. One per
/// click is fine; a loop is not.
const KEY_GAP: Duration = Duration::from_millis(400);

/// Lighting is flash (`factory_reset` wipes it). 1 s floor. Frontend writes
/// on release, so a gesture is one packet.
const LIGHT_GAP: Duration = Duration::from_millis(1000);

/// Profile, debounce, sleep, auto-OS, reset: flash, same 1 s floor. Too
/// short wedges; too long makes a slider lag.
const SETTING_GAP: Duration = Duration::from_millis(1000);

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                api: None,
                open: None,
                last_flash: None,
                last_write: None,
                stalled: false,
                unregistered_ok: false,
                led_swap: None,
                owner: OwnerRecord::default(),
                switch_trial: None,
                screen_write: None,
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
    pub switches: SwitchAccess,
    /// Firmware revision, e.g. 0x0200 for 2.00. From `0x80`, or on gen2 the
    /// identify reply.
    pub revision: Option<u16>,
    /// Cable, or the 2.4 GHz receiver's relay. Factory reset needs the cable.
    pub link: Link,
    /// Percent, receiver link only.
    pub battery: Option<u8>,
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
    /// None outside macOS. A status check never requests access.
    pub input_monitoring: Option<crate::permissions::InputMonitoringStatus>,
    /// The firmware stalled and the board must be replugged. Nothing is
    /// retried while this is set.
    pub stalled: bool,
    /// A receiver is plugged in and paired, but its keyboard is asleep or
    /// switched off. A key press wakes it; so does the cable.
    pub keyboard_offline: bool,
}

const PER_KEY_MODE: u8 = 13;

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

// async so Tauri runs off the main thread. Cable is ~10 ms; the receiver is
// ~150 ms per exchange and would freeze the window.

/// Open and identify. Frontend polls.
#[tauri::command(async)]
pub fn scan(state: tauri::State<AppState>) -> Result<ScanResult, String> {
    let input_monitoring = crate::permissions::input_monitoring();
    let mut inner = state.inner.lock();

    if let Some(open) = &mut inner.open {
        let fresh = open.last_ok.elapsed() < LIVENESS_TTL;
        if fresh || open.transport.identify().is_ok() {
            if !fresh {
                open.last_ok = Instant::now();
            }
            let open = inner.open.as_mut().unwrap();
            if open.transport.link() == Link::Receiver {
                // The receiver answers this itself, so it costs the keyboard
                // nothing; the number drifts while the board charges.
                open.battery = receiver_battery(&open.transport);
            }
            let ok = inner.unregistered_ok;
            let hall = inner.owner.switch_writes;
            return Ok(ScanResult {
                connected: Some(inner.open.as_ref().unwrap().connected(ok, hall)),
                unknown: vec![],
                open_failed: false,
                input_monitoring,
                stalled: false,
                keyboard_offline: false,
            });
        }
        inner.open = None;
    }

    let found = {
        let api = inner.api()?;
        hid::discover(api)
    };

    if inner.stalled {
        // Reopen does not recover a stall; extra traffic pins it. Wait for
        // the device to leave the bus (a replug).
        if found.is_empty() {
            inner.stalled = false;
        } else {
            return Ok(ScanResult {
                connected: None,
                unknown: vec![],
                open_failed: false,
                input_monitoring,
                stalled: true,
                keyboard_offline: false,
            });
        }
    }

    let mut unknown = Vec::new();
    let mut connected = None;
    let mut open_failed = false;
    let mut keyboard_offline = false;
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
            Ok(id) => match registry::by_id(id)
                .map(|spec| {
                    // An entry from the vendor's older table knows the board
                    // but not its command set; the board says which.
                    if spec.family == "unknown" {
                        match block_on(ops::derive_sweep(
                            &transport,
                            id,
                            d.vendor_id,
                            d.product_id,
                            &d.product,
                        )) {
                            Some(derived) => crate::derive::settle_family(spec, &derived),
                            None => spec,
                        }
                    } else {
                        spec
                    }
                })
                .or_else(|| {
                    block_on(ops::derive_sweep(
                        &transport,
                        id,
                        d.vendor_id,
                        d.product_id,
                        &d.product,
                    ))
                }) {
                Some(spec) => {
                    let battery = if transport.link() == Link::Receiver {
                        receiver_battery(&transport)
                    } else {
                        None
                    };
                    let revision = block_on(ops::read_revision(&transport, &spec));
                    let open = OpenDevice {
                        path: d.path,
                        transport,
                        spec,
                        last_ok: Instant::now(),
                        battery,
                        usage: d.usage,
                        revision,
                    };
                    inner.unregistered_ok = false;
                    inner.led_swap = None;
                    inner.owner = OwnerRecord::default();
                    inner.switch_trial = None;
                    connected = Some(open.connected(false, false));
                    inner.open = Some(open);
                    break;
                }
                None => unknown.push(DiscoveredUnknown {
                    path: d.path,
                    product_id: d.product_id,
                    product: d.product,
                    device_id: Some(id),
                }),
            },
            Err(HidError::KeyboardOffline) => keyboard_offline = true,
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
        input_monitoring,
        stalled: false,
        keyboard_offline,
    })
}

/// Session grant: writes allowed on this unregistered board. Sends nothing.
#[tauri::command(async)]
pub fn allow_unregistered(state: tauri::State<AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock();
    match &inner.open {
        Some(open) if open.spec.unregistered => {
            inner.unregistered_ok = true;
            Ok(())
        }
        Some(_) => Err("this board is in the registry; nothing to allow".into()),
        None => Err("no device connected".into()),
    }
}

/// Apply check answers. Sends nothing. Frontend stores the record by device
/// id and applies it on every connect.
#[tauri::command(async)]
pub fn apply_owner_record(
    state: tauri::State<AppState>,
    record: OwnerRecord,
) -> Result<(), String> {
    let mut inner = state.inner.lock();
    let open = inner.open.as_mut().ok_or("no device connected")?;
    if open.spec.unregistered {
        // The derived spec says no; the record is the only other word, so
        // it sets the flag both ways and a withdrawn yes goes back to no.
        open.spec.magnetic = record.magnetic;
        open.spec.features.magnetic_switches = record.magnetic;
        if let Some(side) = record.side_light {
            open.spec.features.side_light = side;
        }
        if let Some(n) = record.profiles {
            open.spec.profiles = n.clamp(1, 8);
        }
        if record.allowed {
            inner.unregistered_ok = true;
        }
    }
    // A record lands after a test, never during one, so no trial outlives it.
    inner.switch_trial = None;
    inner.owner = record;
    Ok(())
}

/// Open one slot for the check's switch felt test, or close it. Sends nothing.
/// The test writes, reads back, asks, and restores; only then may the record
/// allow switch writes.
#[tauri::command(async)]
pub fn set_switch_trial(state: tauri::State<AppState>, slot: Option<u8>) -> Result<(), String> {
    let mut inner = state.inner.lock();
    let open = inner.open.as_ref().ok_or("no device connected")?;
    if slot.is_some() && !open.spec.hall_reads(open.revision) {
        return Err(format!(
            "{} has no magnetic switches sharkfin can read",
            open.spec.label()
        ));
    }
    inner.switch_trial = slot;
    Ok(())
}

fn receiver_battery(t: &Transport) -> Option<u8> {
    t.receiver_status()
        .ok()
        .flatten()
        .map(|s| s.keyboard_battery)
}

/// Factory reset and screen frames: cable only. Bare opcode, no read-back;
/// the receiver drops a packet if the board dozed. A screen frame is a
/// thousand pages.
fn require_cable(state: &tauri::State<AppState>) -> Result<(), String> {
    let inner = state.inner.lock();
    match &inner.open {
        Some(open) if open.transport.link() == Link::Receiver => {
            Err("Not over the receiver yet: connect the keyboard by cable for this.".into())
        }
        _ => Ok(()),
    }
}

/// Run `f` on the open device, then record liveness. A stall invalidates the
/// handle. Retrying forever is worse than reconnecting.
fn run<T>(
    state: &tauri::State<AppState>,
    require_writable: bool,
    f: impl FnOnce(&Transport, Option<&'static FamilyCmds>) -> Result<T, HidError>,
) -> Result<T, String> {
    let mut inner = state.inner.lock();
    // Reads share the wire with flash writes. A read in a write's quiet
    // window stalls the same way: X86, keymap read 120 ms after a profile
    // switch. Writes already claimed the gap; only reads wait here, lock held.
    if !require_writable {
        if let Some((prev, min)) = inner.last_write {
            let until = prev + min;
            let now = Instant::now();
            if until > now {
                std::thread::sleep(until - now);
            }
        }
    }
    let unregistered_ok = inner.unregistered_ok;
    let open = inner.open.as_mut().ok_or("no device connected")?;
    if require_writable && !open.spec.writes_supported() {
        return Err(format!(
            "sharkfin doesn't know the {} command set, so it will not write to {}",
            open.spec.family,
            open.spec.label(),
        ));
    }
    if require_writable && open.spec.unregistered && !unregistered_ok {
        return Err(
            "This keyboard is not in sharkfin's list. Allow changes on the notice above first."
                .into(),
        );
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
                log::warn!("wire before the stall: {}", crate::hid::wire_trace());
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

/// Writes only on a verified family. The other family's opcodes land on
/// different registers; a keymap page write is not recoverable.
fn with_writable<T>(
    state: &tauri::State<AppState>,
    f: impl FnOnce(&Transport, Option<&'static FamilyCmds>) -> Result<T, HidError>,
) -> Result<T, String> {
    run(state, true, f)
}

/// Whether the open board addresses profiles as `profile * 4 + sublayer`
/// (`protocol::yc500_profile_slot`). False with no board open.
fn scaled_profiles(state: &tauri::State<AppState>) -> bool {
    let inner = state.inner.lock();
    inner.open.as_ref().is_some_and(|o| o.scaled_profiles())
}

/// How the open board reads a LEDPARAM packet (`DeviceSpec::led_wire`).
/// The yc500 defaults with no board open; the command then fails on the
/// missing device anyway.
fn led_wire(state: &tauri::State<AppState>) -> crate::protocol::LedWire {
    let inner = state.inner.lock();
    let mut wire = inner
        .open
        .as_ref()
        .map(|o| o.spec.led_wire())
        .unwrap_or(crate::protocol::LedWire::YC500);
    if let Some(swapped) = inner.led_swap {
        wire.swapped = swapped;
    }
    wire
}

#[tauri::command(async)]
pub fn get_led_param(state: tauri::State<AppState>) -> Result<LedParam, String> {
    let wire = led_wire(&state);
    with_open(&state, |t, _| block_on(ops::read_led_param(t, wire)))
}

#[tauri::command(async)]
pub fn set_led_param(state: tauri::State<AppState>, param: LedParam) -> Result<(), String> {
    light_gap(&state);
    let wire = led_wire(&state);
    with_writable(&state, |t, _| {
        t.send(&param.to_packet_for(wire))?;
        Ok(())
    })
}

/// Owner override for the LEDPARAM flags nibble. Sends nothing; lasts as
/// long as the handle. Wrong way round shows a solid colour where rainbow
/// was asked for.
#[tauri::command(async)]
pub fn set_led_flags_swapped(state: tauri::State<AppState>, swapped: bool) -> Result<(), String> {
    let mut inner = state.inner.lock();
    if inner.open.is_none() {
        return Err("no device connected".into());
    }
    inner.led_swap = Some(swapped);
    Ok(())
}

#[tauri::command(async)]
pub fn get_profile(state: tauri::State<AppState>) -> Result<u8, String> {
    let scaled = scaled_profiles(&state);
    with_open(&state, |t, fc| {
        let reply = t.roundtrip(need(fc)?.get_profile, &[], Checksum::Bit7)?;
        Ok(crate::protocol::yc500_profile_from_slot(scaled, reply[1]))
    })
}

/// Display firmware version, or `None`. `0xAD` is shared across families.
/// Unimplemented commands echo the previous reply, so a reply that does not
/// lead with the opcode means no display.
#[tauri::command(async)]
pub fn get_screen_version(state: tauri::State<AppState>) -> Result<Option<u16>, String> {
    with_open(&state, |t, _| {
        let reply = t.roundtrip(crate::protocol::cmd::GET_OLED_VERSION, &[], Checksum::Bit7)?;
        if reply[0] != crate::protocol::cmd::GET_OLED_VERSION {
            return Ok(None);
        }
        let version = u16::from(reply[1]) | (u16::from(reply[2]) << 8);
        Ok((version != 0).then_some(version))
    })
}

#[tauri::command(async)]
pub fn set_profile(state: tauri::State<AppState>, profile: u8) -> Result<(), String> {
    write_gap(&state, SETTING_GAP);
    let profile = crate::protocol::yc500_profile_slot(scaled_profiles(&state), profile, 0);
    with_writable(&state, |t, fc| {
        let fc = need(fc)?;
        let pkt = crate::protocol::packet(fc.set_profile, &[profile], Checksum::Bit7);
        t.send(&pkt)?;
        // The switch lands in flash and gets no ack, and anything on the
        // wire during the commit can stall the endpoint. GET_PROFILE is no
        // probe of the commit either: it answers within 25 ms while the
        // commit is still going. So the full quiet comes first and the
        // confirmation after, with the device lock held throughout, like a
        // flash batch.
        std::thread::sleep(SETTING_GAP);
        let reply = t.roundtrip(fc.get_profile, &[], Checksum::Bit7)?;
        if reply[1] != profile {
            return Err(HidError::Protocol(
                "the board did not take the profile switch".into(),
            ));
        }
        Ok(())
    })
}

#[tauri::command(async)]
pub fn build_id() -> String {
    registry::build_id()
}

#[tauri::command(async)]
pub fn read_keymap(state: tauri::State<AppState>, profile: u8) -> Result<Vec<u8>, String> {
    let profile = crate::protocol::yc500_profile_slot(scaled_profiles(&state), profile, 0);
    with_open(&state, |t, fc| {
        block_on(ops::read_matrix(t, need(fc)?, profile, 0, false))
    })
}

/// Sub-layer 0 is the keymap; 1..3 are DKS, mod-tap, toggle on magnetic boards.
#[tauri::command(async)]
pub fn read_keymap_layer(
    state: tauri::State<AppState>,
    profile: u8,
    sublayer: u8,
) -> Result<Vec<u8>, String> {
    if sublayer > 3 {
        return Err("sub-layer out of range (0..3)".into());
    }
    let scaled = scaled_profiles(&state);
    let profile = crate::protocol::yc500_profile_slot(scaled, profile, sublayer);
    with_open(&state, |t, fc| {
        block_on(ops::read_matrix(t, need(fc)?, profile, sublayer, false))
    })
}

#[tauri::command(async)]
pub fn read_fn_keymap(state: tauri::State<AppState>, layer: u8) -> Result<Vec<u8>, String> {
    with_open(&state, |t, fc| {
        block_on(ops::read_matrix(t, need(fc)?, layer, 0, true))
    })
}

/// One slot: [op, profile, slot, 0.., ck7, value×4]. True when the whole
/// layer was uploaded instead (`bulk_keymap`, or a yc500 board that dropped
/// the single-slot write and is switched over for the rest of the session).
#[tauri::command(async)]
pub fn set_key(
    state: tauri::State<AppState>,
    profile: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<bool, String> {
    set_key_layer(state, profile, 0, slot, value, fn_layer)
}

/// Sub-layers past 0: magnetic only. Fn has none.
#[tauri::command(async)]
pub fn set_key_layer(
    state: tauri::State<AppState>,
    profile: u8,
    sublayer: u8,
    slot: u8,
    value: [u8; 4],
    fn_layer: bool,
) -> Result<bool, String> {
    if sublayer > 3 || (sublayer > 0 && fn_layer) {
        return Err("sub-layer out of range".into());
    }
    if sublayer > 0 {
        let inner = state.inner.lock();
        let open = inner.open.as_ref().ok_or("no device connected")?;
        if !matches!(
            switch_access(&open.spec, open.revision, false, inner.owner.switch_writes),
            SwitchAccess::Write | SwitchAccess::Global
        ) {
            return Err(format!(
                "{} has no keymap sub-layers sharkfin can write",
                open.spec.label()
            ));
        }
    }
    let bulk = {
        let inner = state.inner.lock();
        inner.open.as_ref().is_some_and(|o| o.spec.bulk_keymap)
    };
    let wire_profile = if fn_layer {
        profile
    } else {
        crate::protocol::yc500_profile_slot(scaled_profiles(&state), profile, sublayer)
    };
    if !bulk {
        key_gap(&state);
        let landed = with_writable(&state, |t, fc| {
            let landed = block_on(ops::write_slot_checked(
                t,
                need(fc)?,
                wire_profile,
                sublayer,
                slot,
                value,
                fn_layer,
            ))?;
            Ok(landed)
        })?;
        if landed {
            return Ok(false);
        }
        // Dropped: this firmware has no single-slot write. Every later key
        // write this session takes the upload, where the upload is safe.
        let mut inner = state.inner.lock();
        let open = inner.open.as_mut().ok_or("no device connected")?;
        if !ops::bulk_fallback_allowed(&open.spec, sublayer, slot) {
            return Err(format!("{} did not take the key write", open.spec.label()));
        }
        open.spec.bulk_keymap = true;
    }
    // The whole layer goes to flash, so it is paced like any upload.
    flash_cooldown(&state);
    with_writable(&state, |t, fc| {
        block_on(ops::write_slot_bulk(
            t,
            need(fc)?,
            wire_profile,
            slot,
            value,
            fn_layer,
            FLASH_PACE,
        ))?;
        Ok(true)
    })
}

#[tauri::command(async)]
pub fn get_settings(state: tauri::State<AppState>) -> Result<DeviceSettings, String> {
    let has_side_light = {
        let inner = state.inner.lock();
        inner
            .open
            .as_ref()
            .map(|o| o.spec.features.side_light)
            .unwrap_or(false)
    };
    let swapped = led_wire(&state).swapped;
    with_open(&state, |t, fc| {
        block_on(ops::read_settings(t, need(fc)?, has_side_light, swapped))
    })
}

#[tauri::command(async)]
pub fn set_debounce(state: tauri::State<AppState>, value: u8) -> Result<(), String> {
    write_gap(&state, SETTING_GAP);
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

#[tauri::command(async)]
pub fn set_sleep(state: tauri::State<AppState>, sleep: SleepTimes) -> Result<(), String> {
    write_gap(&state, SETTING_GAP);
    with_writable(&state, |t, fc| {
        t.send(&sleep.to_packet_as(need(fc)?.set_sleeptime))
    })
}

/// Read-modify-write so bits sharkfin doesn't model survive untouched.
#[tauri::command(async)]
pub fn set_options(state: tauri::State<AppState>, options: KbOptions) -> Result<(), String> {
    // The Lighting page toggles these, and this one costs two reports, so
    // it belongs under the same floor as the sliders beside it.
    light_gap(&state);
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

#[tauri::command(async)]
pub fn set_side_light(state: tauri::State<AppState>, param: SledParam) -> Result<(), String> {
    light_gap(&state);
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
    let swapped = led_wire(&state).swapped;
    with_writable(&state, |t, fc| {
        need(fc)?.sled.ok_or_else(|| {
            HidError::Protocol("edge light opcodes unknown for this family".into())
        })?;
        t.send(&param.to_packet_on(swapped))
    })
}

#[tauri::command(async)]
pub fn set_auto_os(state: tauri::State<AppState>, enabled: bool) -> Result<(), String> {
    write_gap(&state, SETTING_GAP);
    with_writable(&state, |t, fc| {
        let (set, _) = need(fc)?.auto_os.ok_or_else(|| {
            HidError::Protocol("host-OS auto-detect opcodes unknown for this family".into())
        })?;
        let pkt = crate::protocol::packet(set, &[enabled as u8], Checksum::Bit7);
        t.send(&pkt)
    })
}

/// Highest profile count any registry entry claims. A backup must cover all
/// of them.
pub const MAX_PROFILES: u8 = 8;

/// Wipes every onboard profile, keymap, macro and light setting. Firmware
/// needs a few seconds; the frontend re-reads afterwards.
#[tauri::command(async)]
pub fn factory_reset(state: tauri::State<AppState>) -> Result<(), String> {
    require_cable(&state)?;
    write_gap(&state, SETTING_GAP);
    with_writable(&state, |t, fc| {
        let pkt = crate::protocol::packet(need(fc)?.set_reset, &[], Checksum::Bit7);
        t.send(&pkt)
    })
}

/// The display's clock. The frontend passes the host's local time, the way
/// the vendor's app does.
#[tauri::command(async)]
pub fn set_clock(
    state: tauri::State<AppState>,
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> Result<(), String> {
    require_cable(&state)?;
    write_gap(&state, SETTING_GAP);
    with_writable(&state, |t, fc| {
        // Shared across both families, so no opcode is taken from the table,
        // but resolving it still refuses a board whose family is unknown.
        need(fc)?;
        t.send(&crate::protocol::clock_packet(
            year, month, day, hour, minute, second,
        ))
    })
}

fn key_gap(state: &tauri::State<AppState>) {
    write_gap(state, KEY_GAP)
}

/// One clock for every write. Claim the slot before sleeping so waiters
/// cannot share a deadline and fire together. Wait is the stricter of the
/// last write's floor and `min`.
fn write_gap(state: &tauri::State<AppState>, min: Duration) {
    let now = Instant::now();
    let next = {
        let mut inner = state.inner.lock();
        let next = match inner.last_write {
            Some((prev, prev_min)) => {
                let gap = prev_min.max(min);
                if prev + gap > now {
                    prev + gap
                } else {
                    now
                }
            }
            None => now,
        };
        inner.last_write = Some((next, min));
        next
    };
    if next > now {
        std::thread::sleep(next - now);
    }
}

/// Records a write that did its own pacing, so whatever follows is spaced
/// from the end of it rather than from before it started.
fn stamp_write(state: &tauri::State<AppState>) {
    state.inner.lock().last_write = Some((Instant::now(), KEY_GAP));
}

fn light_gap(state: &tauri::State<AppState>) {
    write_gap(state, LIGHT_GAP)
}

fn flash_cooldown(state: &tauri::State<AppState>) {
    let now = Instant::now();
    let next = {
        let mut inner = state.inner.lock();
        let next = match inner.last_flash {
            Some(prev) if prev + FLASH_COOLDOWN > now => prev + FLASH_COOLDOWN,
            _ => now,
        };
        inner.last_flash = Some(next);
        next
    };
    if next > now {
        std::thread::sleep(next - now);
    }
    // Claimed last, so the batch about to run is what the next write spaces
    // itself from; claiming before a ten second sleep would leave the clock
    // stale enough for anything racing in to skip its gap entirely.
    write_gap(state, FLASH_PAGE_GAP);
}

/// 384 bytes of per-key colour (128 slots x RGB, matrix order). Optionally
/// switch to the pattern mode that shows it. gen2 carries 126 of 128 slots.
/// `GET_USERPIC` does not reflect the write; the host keeps the pattern.
#[tauri::command(async)]
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
    let wire = led_wire(&state);
    let out = with_writable(&state, |t, fc| {
        let fc = need(fc)?;
        // Decide about the mode switch before the upload: asking afterwards
        // means talking to a board that is still writing flash.
        let needs_mode = activate
            && block_on(ops::read_led_param(t, wire))
                .map(|p| p.mode != PER_KEY_MODE)
                .unwrap_or(true);

        if fc.name == "gen2" {
            // Slot 0, matching the option nibble in the mode switch below.
            for pkt in crate::protocol::gen2::userpic_packets(0, &colors) {
                t.send(&pkt)?;
                std::thread::sleep(FLASH_PAGE_GAP);
            }
        } else {
            for page in 0..7u8 {
                t.send(&crate::protocol::userpic_write_packet(page, &colors))?;
                std::thread::sleep(FLASH_PAGE_GAP);
            }
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
    });
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

/// Screen page gap. A 240x135 frame is over a thousand pages; flash-style
/// pacing would take minutes.
const SCREEN_PAGE_GAP: Duration = Duration::from_millis(5);
/// How long the board is given to answer the announce, polled the way the
/// vendor polls it.
const SCREEN_READY_TRIES: u32 = 10;
const SCREEN_READY_GAP: Duration = Duration::from_millis(100);

/// One still frame into one of the display's slots. `rgb` is `w * h * 3`
/// row-major; column order and pixel format are applied here. Flash, so
/// the cooldown applies. Poll the announce until ready; abandon the pages
/// if it never is, so a half-written frame does not go out. The outcome
/// is kept for the bundle.
#[tauri::command(async)]
pub fn write_screen_image(
    state: tauri::State<AppState>,
    rgb: Vec<u8>,
    slot: u8,
) -> Result<(), String> {
    require_cable(&state)?;
    let (device, screen, rules) = {
        let inner = state.inner.lock();
        let spec = &inner.open.as_ref().ok_or("no keyboard connected")?.spec;
        (
            spec.id,
            spec.screen
                .clone()
                .ok_or("this board has no display sharkfin knows the size of")?,
            spec.screen_draw(),
        )
    };
    let slots = ops::screen_slots(&screen);
    if slot >= slots {
        return Err(format!("this display has {slots} picture slots"));
    }
    // Only boards whose own firmware parses the frame: the announce handler
    // stores the geometry and the page handler checks every page against it.
    // Most gen2 boards do not do that. Their handler builds a short message,
    // copies twelve bytes of the request into it and checksums it, which is
    // the keyboard passing the request to the display chip that carries its
    // own firmware. What that chip then expects is not established, and the
    // two are not interchangeable. screen_draw in registry.rs draws the line.
    let Some(rules) = rules else {
        return Err(
            "sharkfin can only draw on this family of board so far. This one hands \
             the picture to a separate display chip, and that path is not worked out."
                .into(),
        );
    };
    // Each pair is evidenced against the firmware of a board that declares
    // that mode: 0xA5/0x25 by the RT100 image (mode 16) and two yc3123
    // images, 0xA9/0x29 by the Dynatab75X image (mode 24). Each image
    // rejects the other pair, so the registry's mode picks the pair and
    // nothing else may. No yc3123 image handles the mode 24 pair, which is
    // why screen_draw withholds it there.
    let (announce, page_op) = match screen.mode.as_str() {
        "16" => (0xA5_u8, 0x25_u8),
        "24" if rules.mode24 => (0xA9_u8, 0x29_u8),
        other => {
            return Err(format!(
                "sharkfin cannot draw on a mode {other} display yet"
            ))
        }
    };
    // Checked before the pixels are packed: a panel whose bounding box does
    // not fit the bytes the firmware reads would be drawn at the wrong size
    // rather than refused. See ScreenDrawRules::max_dim.
    if screen.w > rules.max_dim || screen.h > rules.max_dim {
        return Err("this display is larger than sharkfin can address on this board".into());
    }
    let data = crate::protocol::screen_pixels(&rgb, screen.w, screen.h, &screen.mode)?;
    // The frame limit is per lineage: yc500 and ry5088 images read the
    // length as a u16 and nothing wider, yc3123 images read a u32. A frame
    // past what the firmware can count would truncate silently, so it is
    // refused instead.
    if data.len() > rules.max_frame {
        return Err(format!(
            "this picture is {} bytes; the board's firmware only counts up to {}",
            data.len(),
            rules.max_frame
        ));
    }

    flash_cooldown(&state);
    let mut outcome = ops::ScreenOutcome {
        device,
        slot,
        slots,
        accepted: false,
        pages: 0,
    };
    let out = with_writable(&state, |t, _| {
        let bbox = (0, 0, screen.w, screen.h);
        let pkt = crate::protocol::screen_announce_packet(
            announce,
            slot,
            1,
            0,
            data.len() as u32,
            bbox,
            0,
        );
        let mut ready = false;
        for _ in 0..SCREEN_READY_TRIES {
            // The announce is a write dressed as a read: it answers, but
            // only once the display has room for the frame. Not ready looks
            // like a different answer or none at all; anything else is the
            // transport failing and is reported as that, not as a refusal.
            match t.roundtrip_packet(&pkt) {
                Ok(reply) if reply[1] == 1 => {
                    ready = true;
                    break;
                }
                Ok(_) | Err(HidError::NoHandshake) => {}
                Err(e) => return Err(e),
            }
            std::thread::sleep(SCREEN_READY_GAP);
        }
        if !ready {
            return Err(HidError::Protocol(
                "the display did not accept the picture".into(),
            ));
        }
        outcome.accepted = true;
        for page in crate::protocol::screen_page_packets(page_op, slot, 1, 0, &data) {
            t.send(&page)?;
            outcome.pages += 1;
            std::thread::sleep(SCREEN_PAGE_GAP);
        }
        std::thread::sleep(FLASH_SETTLE);
        Ok(())
    });
    state.inner.lock().screen_write = Some(outcome);
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

fn hall_format(state: &tauri::State<AppState>) -> Result<hall::Format, String> {
    let inner = state.inner.lock();
    let open = inner.open.as_ref().ok_or("no device connected")?;
    ops::hall_format(&open.spec, open.revision)
}

/// Whether the open board's registry entry lists switch models, and if
/// `code` is one of them. Without a list the column is neither read nor
/// written.
fn switch_type_listed(state: &tauri::State<AppState>, code: Option<u8>) -> bool {
    let inner = state.inner.lock();
    inner.open.as_ref().is_some_and(|o| match code {
        Some(c) => o.spec.lists_switch_type(c),
        None => !o.spec.switch_types.is_empty(),
    })
}

#[tauri::command(async)]
pub fn get_switches(state: tauri::State<AppState>) -> Result<hall::SwitchSettings, String> {
    let f = hall_format(&state)?;
    let cols = hall::read_columns(switch_type_listed(&state, None));
    with_open(&state, |t, _| {
        let column = |subop: u8| -> Result<Vec<u8>, HidError> {
            let mut out = Vec::with_capacity(256);
            for page in 0..f.get_pages(subop) {
                out.extend_from_slice(&t.read_raw_page(
                    hall::GET,
                    &f.get_payload(subop, page),
                    Checksum::Bit7,
                )?);
            }
            Ok(out)
        };
        let mut columns = Vec::new();
        for &subop in cols.iter() {
            columns.push((subop, f.decode(subop, &column(subop)?)));
        }
        // Sub-op 10: four blocks of one byte a slot, two pages a block.
        let mut dks_all = Vec::with_capacity(4 * f.slots());
        for block in 0..4u8 {
            let mut raw = Vec::with_capacity(128);
            for page in [2 * block, 2 * block + 1] {
                raw.extend_from_slice(&t.read_raw_page(
                    hall::GET,
                    &f.get_payload(hall::DKS_ACTIONS_ALL, page),
                    Checksum::Bit7,
                )?);
            }
            dks_all.extend_from_slice(&raw[..f.slots()]);
        }
        Ok(hall::assemble(f, &columns, &dks_all))
    })
}

/// `slots`: the keys a write addresses, so the check's trial can open just
/// those; `None` is a write to every key, which no trial covers.
fn require_hall_writes(
    state: &tauri::State<AppState>,
    slots: Option<&[u8]>,
) -> Result<hall::Format, String> {
    let inner = state.inner.lock();
    let open = inner.open.as_ref().ok_or("no device connected")?;
    if !crate::session::hall_write_allowed(
        &open.spec,
        open.revision,
        inner.owner.switch_writes,
        inner.switch_trial,
        slots,
    ) {
        return Err(crate::session::hall_write_refusal(&open.spec));
    }
    ops::hall_format(&open.spec, open.revision)
}

/// One key's switch settings. Last packet of the block is flagged (flash
/// erase and program), so the cooldown applies. Advanced kinds add columns
/// after the plain six; their keymap sub-layers are `set_key_layer`.
#[tauri::command(async)]
pub fn set_switch_key(state: tauri::State<AppState>, key: hall::KeySwitch) -> Result<(), String> {
    set_switch_keys(state, vec![key])
}

/// Several keys in one visit, a flash settle between them: a snap pair
/// needs both keys to carry each other's slot before either works.
#[tauri::command(async)]
pub fn set_switch_keys(
    state: tauri::State<AppState>,
    keys: Vec<hall::KeySwitch>,
) -> Result<(), String> {
    let slots: Vec<u8> = keys.iter().map(|k| k.slot).collect();
    let f = require_hall_writes(&state, Some(&slots))?;
    if keys.is_empty() || keys.len() > 2 {
        return Err("one or two keys at a time".into());
    }
    if keys
        .iter()
        .any(|k| k.kind == hall::KIND_SNAP && usize::from(k.snap_partner) >= f.slots())
    {
        return Err("snap partner out of range".into());
    }
    let with_type: Vec<bool> = keys
        .iter()
        .map(|k| switch_type_listed(&state, Some(k.switch_type)))
        .collect();
    flash_cooldown(&state);
    let out = with_writable(&state, |t, _| {
        for (key, &with_type) in keys.iter().zip(&with_type) {
            let cols = hall::columns_for(key.kind, with_type);
            let n = cols.len();
            for (i, &subop) in cols.iter().enumerate() {
                let last = i + 1 == n;
                let pkt = if subop == hall::DKS_ACTIONS {
                    f.set_dks_actions(key.slot, last, key.dks_actions)
                } else {
                    f.set_one(subop, key.slot, last, key.wire(f, subop))
                }
                .ok_or_else(|| HidError::Protocol("slot out of range".into()))?;
                t.send(&pkt)?;
            }
            std::thread::sleep(FLASH_SETTLE);
        }
        Ok(())
    });
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

/// The same plain settings on every key. Six columns in bulk pages, the
/// final page of the final column flagged. Keys carrying an advanced kind
/// keep it: the mode column is written per slot from what was read. A
/// switch model, when given, goes on every key as a seventh column.
#[tauri::command(async)]
pub fn set_switches_all(
    state: tauri::State<AppState>,
    key: hall::KeySwitch,
    modes: Vec<u8>,
    switch_type: Option<u8>,
) -> Result<(), String> {
    let f = require_hall_writes(&state, None)?;
    if switch_type.is_some_and(|c| !switch_type_listed(&state, Some(c))) {
        return Err("switch model not offered for this board".into());
    }
    let mut cols = hall::WRITE_COLUMNS.to_vec();
    if switch_type.is_some() {
        cols.push(hall::SWITCH_TYPE);
    }
    flash_cooldown(&state);
    let out = with_writable(&state, |t, _| {
        let n = cols.len();
        for (i, &subop) in cols.iter().enumerate() {
            let values: Vec<u16> = (0..f.slots())
                .map(|s| {
                    if subop == hall::SWITCH_TYPE {
                        u16::from(switch_type.unwrap_or(0))
                    } else if subop == hall::MODE {
                        let kind = modes.get(s).copied().unwrap_or(0) & 0x7F;
                        let rt = if key.rapid_trigger {
                            hall::MODE_RAPID_TRIGGER
                        } else {
                            0
                        };
                        u16::from(kind | rt)
                    } else {
                        key.wire(f, subop)
                    }
                })
                .collect();
            for pkt in f.set_all(subop, &values, i + 1 == n) {
                t.send(&pkt)?;
                std::thread::sleep(FLASH_PAGE_GAP);
            }
        }
        std::thread::sleep(FLASH_SETTLE);
        Ok(())
    });
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

/// yc500 only: which evaluator table the board is on, 0..2 built in, 3 the
/// columns. `None` on a board that does not answer `0x9D`.
#[tauri::command(async)]
pub fn get_switch_preset(state: tauri::State<AppState>) -> Result<Option<u8>, String> {
    {
        let inner = state.inner.lock();
        let open = inner.open.as_ref().ok_or("no device connected")?;
        if open.spec.family != "yc500" || !open.spec.magnetic {
            return Ok(None);
        }
    }
    with_open(&state, |t, _| {
        let reply = t.roundtrip(hall::GET_PRESET, &[], Checksum::Bit7)?;
        Ok((reply[1] <= hall::PRESET_CUSTOM).then_some(reply[1]))
    })
}

/// yc500 only: `0x1D [preset]`. The handler stores the byte and re-runs
/// the apply; nothing lands in flash, so no cooldown.
#[tauri::command(async)]
pub fn set_switch_preset(state: tauri::State<AppState>, preset: u8) -> Result<(), String> {
    {
        let inner = state.inner.lock();
        let open = inner.open.as_ref().ok_or("no device connected")?;
        let access = switch_access(&open.spec, open.revision, false, inner.owner.switch_writes);
        // The check's trial puts the preset back after its one key.
        let trial = inner.switch_trial.is_some() && open.spec.hall_reads(open.revision);
        if open.spec.family != "yc500"
            || !(trial || matches!(access, SwitchAccess::Write | SwitchAccess::Global))
        {
            return Err(format!("{} has no switch presets", open.spec.label()));
        }
    }
    if preset > hall::PRESET_CUSTOM {
        return Err("preset out of range (0..3)".into());
    }
    write_gap(&state, SETTING_GAP);
    with_writable(&state, |t, _| {
        t.send(&crate::protocol::packet(
            hall::SET_PRESET,
            &[preset],
            Checksum::Bit7,
        ))?;
        Ok(())
    })
}

/// yc500 boards below firmware 2.00: the one record their firmware takes,
/// for every key or one slot. The board saves it to flash and switches to
/// the custom preset; it cannot report the result, so the page keeps its
/// own copy.
#[tauri::command(async)]
pub fn set_switches_global(
    state: tauri::State<AppState>,
    key: hall::KeySwitch,
    all: bool,
) -> Result<(), String> {
    {
        let inner = state.inner.lock();
        let open = inner.open.as_ref().ok_or("no device connected")?;
        if switch_access(&open.spec, open.revision, false, false) != SwitchAccess::Global {
            return Err(format!(
                "{} takes its switch settings per key, not as one record",
                open.spec.label()
            ));
        }
    }
    if usize::from(key.slot) >= hall::Format::Yc500.slots() {
        return Err("slot out of range".into());
    }
    flash_cooldown(&state);
    let out = with_writable(&state, |t, _| {
        t.send(&hall::global_packet(&key, all))?;
        std::thread::sleep(FLASH_SETTLE);
        Ok(())
    });
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

/// 256-byte blob over four raw pages. Unlike `GET_USERPIC`, this read
/// reflects the last write, so the board is a source of truth for macros.
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn write_macro(state: tauri::State<AppState>, slot: u8, data: Macro) -> Result<(), String> {
    check_macro_slot(slot)?;
    let blob = data.to_blob()?;
    flash_cooldown(&state);
    let out = with_writable(&state, |t, fc| {
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
    });
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

#[tauri::command(async)]
pub fn export_config(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    let spec = {
        let inner = state.inner.lock();
        inner
            .open
            .as_ref()
            .map(|o| o.spec.clone())
            .ok_or("no device connected")?
    };
    let scaled = ops::scaled_profiles(&spec);
    let wire = led_wire(&state);
    let cfg = with_open(&state, |t, fc| {
        let fc = need(fc)?;
        let n = spec.profiles.clamp(1, MAX_PROFILES);
        let mut profiles = Vec::new();
        let mut fn_layers = Vec::new();
        for p in 0..n {
            profiles.push(block_on(ops::read_matrix(
                t,
                fc,
                crate::protocol::yc500_profile_slot(scaled, p, 0),
                0,
                false,
            ))?);
            fn_layers.push(block_on(ops::read_matrix(t, fc, p, 0, true))?);
        }
        let led = block_on(ops::read_led_param(t, wire))?;
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
                .and_then(|r| SledParam::from_reply_on(&r, wire.swapped)),
            _ => None,
        };
        Ok(SavedConfig {
            version: 1,
            device_id: spec.id,
            family: spec.family.clone(),
            board: spec.label(),
            profiles,
            fn_layers,
            led,
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
#[tauri::command(async)]
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
    let wire = led_wire(&state);
    if cfg.device_id != spec.id {
        return Err(format!(
            "this config was exported from {} (device id {}), but {} (id {}) is connected",
            cfg.board,
            cfg.device_id,
            spec.label(),
            spec.id
        ));
    }
    let scaled = ops::scaled_profiles(&spec);
    if spec.bulk_keymap {
        flash_cooldown(&state);
    }
    let mut bulk = spec.bulk_keymap;
    let out = with_writable(&state, |t, fc| {
        let fc = need(fc)?;
        let mut keys_written = 0usize;
        let mut layers_uploaded = 0usize;
        // The first write of the import is read back; a drop switches the
        // rest of it to whole layers.
        let mut checked = false;
        for (fn_layer, layers) in [(false, &cfg.profiles), (true, &cfg.fn_layers)] {
            for (p, target) in layers.iter().enumerate() {
                if target.len() != 512 {
                    return Err(HidError::Protocol(format!(
                        "profile {p} in the file is {} bytes, expected 512",
                        target.len()
                    )));
                }
                let wire = if fn_layer {
                    p as u8
                } else {
                    crate::protocol::yc500_profile_slot(scaled, p as u8, 0)
                };
                let current = block_on(ops::read_matrix(t, fc, wire, 0, fn_layer))?;
                let differ: Vec<usize> = (0..128usize)
                    .filter(|s| current[s * 4..s * 4 + 4] != target[s * 4..s * 4 + 4])
                    .collect();
                if differ.is_empty() {
                    continue;
                }
                let whole: [u8; 512] = target.as_slice().try_into().unwrap();
                if !bulk {
                    let mut i = 0;
                    while i < differ.len() {
                        let slot = differ[i];
                        let want: [u8; 4] = whole[slot * 4..slot * 4 + 4].try_into().unwrap();
                        if checked {
                            t.send(&key_write_packet(fc, wire, 0, slot as u8, want, fn_layer)?)?;
                        } else {
                            checked = true;
                            let landed = block_on(ops::write_slot_checked(
                                t, fc, wire, 0, slot as u8, want, fn_layer,
                            ))?;
                            if !landed {
                                if !ops::bulk_fallback_allowed(&spec, 0, slot as u8) {
                                    return Err(HidError::Protocol(format!(
                                        "{} did not take the key write",
                                        spec.label()
                                    )));
                                }
                                bulk = true;
                                std::thread::sleep(FLASH_COOLDOWN);
                                break;
                            }
                        }
                        keys_written += 1;
                        std::thread::sleep(KEY_GAP);
                        i += 1;
                    }
                    if !bulk {
                        continue;
                    }
                }
                if layers_uploaded > 0 {
                    std::thread::sleep(FLASH_COOLDOWN);
                }
                block_on(ops::write_layer_bulk(
                    t, fc, wire, &whole, fn_layer, FLASH_PACE,
                ))?;
                keys_written += differ.len();
                layers_uploaded += 1;
            }
        }
        if let (Some(opts), Some((set, get))) = (cfg.options, fc.kboption) {
            let cur = t.roundtrip(get, &[0], Checksum::Bit7)?;
            t.send(&opts.to_packet_as(set, cur[2], cur[3], cur[4]))?;
            std::thread::sleep(KEY_GAP);
        }
        let deb = cfg.debounce.clamp(1, 10);
        let deb_payload: &[u8] = if fc.debounce_at == 1 {
            &[deb]
        } else {
            &[0, deb]
        };
        // Each of these is a settings write in its own right, and they land
        // right after a batch of up to 1024 key writes, so they get the same
        // spacing the command-level floors would have given them.
        t.send(&crate::protocol::packet(
            fc.set_debounce,
            deb_payload,
            Checksum::Bit7,
        ))?;
        std::thread::sleep(KEY_GAP);
        t.send(&cfg.sleep.to_packet_as(fc.set_sleeptime))?;
        std::thread::sleep(KEY_GAP);
        if let (Some(sled), true, Some(_)) = (cfg.side_light, spec.features.side_light, fc.sled) {
            t.send(&sled.to_packet_on(wire.swapped))?;
            std::thread::sleep(KEY_GAP);
        }
        t.send(&cfg.led.to_packet_for(wire))?;
        Ok(format!(
            "restored {keys_written} keys, settings and lighting from {}",
            cfg.board
        ))
    });
    if bulk && !spec.bulk_keymap {
        let mut inner = state.inner.lock();
        if let Some(o) = inner.open.as_mut() {
            o.spec.bulk_keymap = true;
        }
    }
    // Spaced from the end of the batch, not from before it began.
    stamp_write(&state);
    out
}

/// Read probes, both families. Unimplemented opcodes echo the previous reply.
///
/// Everything a developer needs from a board they don't own, as text the
/// owner pastes into a GitHub issue. Read-only. `path` reaches a discovered
/// board the registry does not know; without it the open board is used.
#[tauri::command(async)]
pub fn contribution_bundle(
    state: tauri::State<AppState>,
    path: Option<String>,
) -> Result<String, String> {
    use std::fmt::Write;
    let open = {
        let inner = state.inner.lock();
        inner.open.as_ref().map(|o| {
            (
                o.spec.clone(),
                o.usage,
                inner.led_swap,
                inner.screen_write.clone(),
            )
        })
    };
    let Some((spec, usage, led_swap, screen_write)) = open else {
        return unregistered_bundle(&state, path.ok_or("no device connected")?);
    };
    with_open(&state, |t, _| {
        let mut out = String::new();
        let _ = writeln!(out, "```");
        let _ = writeln!(out, "sharkfin {} data bundle", registry::build_id());
        if spec.unregistered {
            let _ = writeln!(out, "board  : {} (not in the registry)", spec.label());
            let _ = writeln!(
                out,
                "usb    : {:04x}:{:04x}  collection usage {usage}",
                spec.vendor_id, spec.product_id
            );
            let _ = writeln!(out, "identify: device id {}", spec.id);
            let _ = writeln!(out, "family : {} (detected from this sweep)", spec.family);
        } else {
            let _ = writeln!(out, "board  : {} (device id {})", spec.label(), spec.id);
            let _ = writeln!(
                out,
                "usb    : {:04x}:{:04x}  internal {}  collection usage {usage}",
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
            let _ = writeln!(
                out,
                "flags  : {}",
                registry::led_flags_note(&spec, led_swap)
            );
        }
        if let Some(o) = screen_write.filter(|o| o.device == spec.id) {
            let _ = writeln!(out, "screen : {}", o.note());
        }
        // A stall has to surface: swallowing it hands the owner a bundle that
        // simply stops, with no marker that it was cut short, and leaves the
        // session believing the handle is still good. Anything else is worth
        // less than the bundle, so it goes in the bundle.
        if let Err(e) = block_on(ops::probe_sweep(t, &mut out)) {
            if e.is_stall() {
                return Err(e);
            }
            let _ = writeln!(out, "sweep  : {e}");
        }
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
    let _ = writeln!(
        out,
        "usb    : {:04x}:{:04x}  collection usage {}",
        d.vendor_id, d.product_id, d.usage
    );
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
    if let Err(e) = block_on(ops::probe_sweep(&t, &mut out)) {
        if e.is_stall() {
            inner.stalled = true;
            return Err(STALL_MESSAGE.into());
        }
        let _ = writeln!(out, "sweep  : {e}");
    }
    let _ = writeln!(out, "```");
    Ok(out)
}

#[tauri::command(async)]
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
