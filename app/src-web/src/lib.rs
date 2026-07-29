// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Browser build. `protocol.rs` and `registry.rs` are the desktop app's own
//! files, included by path so the evidenced packet builders ship unmodified;
//! this crate replaces only the hidapi transport (with WebHID) and the Tauri
//! command layer (with wasm-bindgen exports). Timing rules -- report pacing,
//! flash cooldowns, key and light gaps -- mirror src-tauri/src/commands.rs
//! and live here rather than in the UI, so no caller can wedge a keyboard.
#![allow(dead_code)]

#[path = "../../src-tauri/src/protocol.rs"]
mod protocol;
#[path = "../../src-tauri/src/registry.rs"]
mod registry;

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use protocol::{
    cmd, family_cmds, Checksum, FamilyCmds, KbOptions, LedParam, Macro, SledParam, SleepTimes,
    REPORT_LEN,
};
use registry::DeviceSpec;

// ---------------------------------------------------------------------------
// JS interop

#[wasm_bindgen(inline_js = "
export function js_sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function js_now() { return performance.now(); }
")]
extern "C" {
    fn js_sleep(ms: f64) -> js_sys::Promise;
    fn js_now() -> f64;
}

async fn sleep_ms(ms: f64) {
    if ms > 0.0 {
        let _ = JsFuture::from(js_sleep(ms)).await;
    }
}

#[wasm_bindgen]
extern "C" {
    /// A WebHID HIDDevice, selected and permission-granted on the JS side.
    #[wasm_bindgen(js_name = HIDDevice)]
    pub type JsHidDevice;

    #[wasm_bindgen(method, getter)]
    fn opened(this: &JsHidDevice) -> bool;
    #[wasm_bindgen(method, getter, js_name = productName)]
    fn product_name(this: &JsHidDevice) -> String;
    #[wasm_bindgen(method, getter, js_name = productId)]
    fn product_id(this: &JsHidDevice) -> u16;
    #[wasm_bindgen(method, getter, js_name = vendorId)]
    fn vendor_id(this: &JsHidDevice) -> u16;
    #[wasm_bindgen(method)]
    fn open(this: &JsHidDevice) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = sendFeatureReport)]
    fn send_feature_report(
        this: &JsHidDevice,
        report_id: u8,
        data: &js_sys::Uint8Array,
    ) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = receiveFeatureReport)]
    fn receive_feature_report(this: &JsHidDevice, report_id: u8) -> js_sys::Promise;
}

// ---------------------------------------------------------------------------
// Transport: WebHID feature reports with the same pacing as hid.rs

#[derive(Debug)]
enum HidErr {
    /// The exchange failed at the USB layer. On this firmware that almost
    /// always means the control endpoint stalled, which nothing but a replug
    /// fixes, so it is treated exactly like the desktop's stall path.
    Stall(String),
    NoHandshake,
    ShortRead(usize),
    Protocol(String),
}

impl std::fmt::Display for HidErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HidErr::Stall(m) => write!(f, "webhid: {m}"),
            HidErr::NoHandshake => write!(f, "device did not answer the identify handshake"),
            HidErr::ShortRead(n) => write!(f, "short feature report ({n} bytes)"),
            HidErr::Protocol(m) => write!(f, "{m}"),
        }
    }
}

impl HidErr {
    fn is_stall(&self) -> bool {
        matches!(self, HidErr::Stall(_))
    }
}

fn js_err_text(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            js_sys::Reflect::get(&e, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
        })
        .unwrap_or_else(|| "unknown WebHID error".into())
}

/// Minimum gap between feature-report writes; same hard floor as the desktop
/// transport (12 ms sustainable, measured on an X86).
const MIN_WRITE_GAP_MS: f64 = 12.0;
const SETTLE_MS: f64 = 10.0;

struct Transport {
    dev: JsHidDevice,
    last_write: std::cell::Cell<f64>,
}

impl Transport {
    async fn pace(&self) {
        let since = js_now() - self.last_write.get();
        if since < MIN_WRITE_GAP_MS {
            sleep_ms(MIN_WRITE_GAP_MS - since).await;
        }
        self.last_write.set(js_now());
    }

    async fn send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidErr> {
        self.pace().await;
        let arr = js_sys::Uint8Array::new_with_length(REPORT_LEN as u32);
        arr.copy_from(buf);
        JsFuture::from(self.dev.send_feature_report(0, &arr))
            .await
            .map(|_| ())
            .map_err(|e| HidErr::Stall(js_err_text(e)))
    }

    async fn read(&self) -> Result<[u8; REPORT_LEN], HidErr> {
        let dv = JsFuture::from(self.dev.receive_feature_report(0))
            .await
            .map_err(|e| HidErr::Stall(js_err_text(e)))?;
        let dv: js_sys::DataView = dv.unchecked_into();
        let n = dv.byte_length();
        if n < 8 {
            return Err(HidErr::ShortRead(n));
        }
        let mut wire = vec![0u8; n];
        for (i, b) in wire.iter_mut().enumerate() {
            *b = dv.get_uint8(i);
        }
        let mut out = [0u8; REPORT_LEN];
        // tolerate platforms that keep the report-ID byte, like hid.rs does
        if wire[0] == 0 && n == REPORT_LEN + 1 {
            out.copy_from_slice(&wire[1..]);
        } else {
            let take = n.min(REPORT_LEN);
            out[..take].copy_from_slice(&wire[..take]);
        }
        Ok(out)
    }

    async fn roundtrip(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], HidErr> {
        let pkt = protocol::packet(opcode, payload, checksum);
        self.send(&pkt).await?;
        for attempt in 0..5u32 {
            sleep_ms(SETTLE_MS * (attempt + 1) as f64).await;
            let reply = self.read().await?;
            if reply[0] == opcode {
                return Ok(reply);
            }
        }
        Err(HidErr::NoHandshake)
    }

    /// For bulk reads whose replies are raw pages (no opcode echo).
    async fn read_raw_page(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], HidErr> {
        let pkt = protocol::packet(opcode, payload, checksum);
        self.send(&pkt).await?;
        sleep_ms(SETTLE_MS).await;
        self.read().await
    }

    async fn identify(&self) -> Result<u32, HidErr> {
        for _ in 0..3 {
            if let Ok(reply) = self
                .roundtrip(cmd::GET_USB_VERSION, &[], Checksum::Bit7)
                .await
            {
                if let Some(id) = protocol::parse_device_id(&reply) {
                    return Ok(id);
                }
            }
        }
        Err(HidErr::NoHandshake)
    }
}

// ---------------------------------------------------------------------------
// Session state. One board, like the desktop app.

/// Same values and rationale as commands.rs; see the comments there.
const FLASH_COOLDOWN_MS: f64 = 10_000.0;
const FLASH_PAGE_GAP_MS: f64 = 100.0;
const FLASH_SETTLE_MS: f64 = 2_000.0;
const KEY_GAP_MS: f64 = 400.0;
const LIGHT_GAP_MS: f64 = 120.0;
const PER_KEY_MODE: u8 = 13;

pub const STALL_MESSAGE: &str =
    "The keyboard stopped responding. Unplug it, wait ten seconds, and plug it back in.";

struct Open {
    transport: Rc<Transport>,
    spec: DeviceSpec,
}

#[derive(Default)]
struct AppState {
    open: Option<Open>,
    stalled: bool,
    busy: bool,
    last_flash: Option<f64>,
    last_light: Option<f64>,
    last_key: Option<f64>,
}

thread_local! {
    static STATE: RefCell<AppState> = RefCell::new(AppState::default());
}

/// JS is single-threaded but async calls interleave, and interleaving two
/// report exchanges corrupts both. This is the async stand-in for the
/// desktop's mutex; ops are short, so polling is fine.
struct BusyGuard;

async fn acquire() -> BusyGuard {
    loop {
        let got = STATE.with(|s| {
            let mut s = s.borrow_mut();
            if s.busy {
                false
            } else {
                s.busy = true;
                true
            }
        });
        if got {
            return BusyGuard;
        }
        sleep_ms(5.0).await;
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        STATE.with(|s| s.borrow_mut().busy = false);
    }
}

fn get_open(require_writable: bool) -> Result<(Rc<Transport>, DeviceSpec), String> {
    STATE.with(|s| {
        let s = s.borrow();
        let open = s.open.as_ref().ok_or("no device connected")?;
        if require_writable && !open.spec.writes_supported() {
            return Err(format!(
                "sharkfin doesn't know the {} command set, so it will not write to {}",
                open.spec.family,
                open.spec.label(),
            ));
        }
        Ok((open.transport.clone(), open.spec.clone()))
    })
}

fn need(fc: Option<&'static FamilyCmds>) -> Result<&'static FamilyCmds, HidErr> {
    fc.ok_or_else(|| HidErr::Protocol("this board's protocol family is unknown".into()))
}

/// Error mapping shared by every command: a stalled endpoint invalidates the
/// handle, exactly like commands.rs::run.
fn fail(e: HidErr) -> String {
    if e.is_stall() {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.open = None;
            s.stalled = true;
        });
        STALL_MESSAGE.into()
    } else {
        e.to_string()
    }
}

async fn gap(last: impl Fn(&mut AppState) -> &mut Option<f64> + Copy, min_ms: f64) {
    let wait = STATE.with(|s| {
        let mut s = s.borrow_mut();
        match *last(&mut s) {
            Some(prev) => {
                let since = js_now() - prev;
                if since < min_ms {
                    min_ms - since
                } else {
                    *last(&mut s) = Some(js_now());
                    0.0
                }
            }
            None => {
                *last(&mut s) = Some(js_now());
                0.0
            }
        }
    });
    if wait > 0.0 {
        sleep_ms(wait).await;
        STATE.with(|s| *last(&mut s.borrow_mut()) = Some(js_now()));
    }
}

fn to_js<T: serde::Serialize>(v: &T) -> Result<JsValue, JsValue> {
    serde_json::to_string(v)
        .map(JsValue::from)
        .map_err(|e| JsValue::from(e.to_string()))
}

// ---------------------------------------------------------------------------
// Connection lifecycle (the JS side owns device pickers and hotplug events)

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedInfo {
    path: String,
    device_id: u32,
    spec: DeviceSpec,
    read_only: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectFailure {
    kind: &'static str,
    device_id: Option<u32>,
    message: String,
}

fn connect_err(kind: &'static str, device_id: Option<u32>, message: String) -> JsValue {
    serde_json::to_string(&ConnectFailure {
        kind,
        device_id,
        message,
    })
    .map(JsValue::from)
    .unwrap_or_else(|_| JsValue::from(kind))
}

/// Open and identify a picker-granted device; keeps it as the session board
/// when the registry knows it.
#[wasm_bindgen]
pub async fn connect(device: JsHidDevice) -> Result<JsValue, JsValue> {
    let _busy = acquire().await;
    let stalled = STATE.with(|s| s.borrow().stalled);
    if stalled {
        return Err(connect_err("stalled", None, STALL_MESSAGE.into()));
    }
    if !device.opened() {
        JsFuture::from(device.open())
            .await
            .map_err(|e| connect_err("openFailed", None, js_err_text(e)))?;
    }
    let transport = Transport {
        dev: device,
        last_write: std::cell::Cell::new(js_now() - MIN_WRITE_GAP_MS),
    };
    let id = match transport.identify().await {
        Ok(id) => id,
        Err(e) => return Err(connect_err("noHandshake", None, e.to_string())),
    };
    match registry::by_id(id) {
        Some(spec) => {
            let info = ConnectedInfo {
                path: "webhid".into(),
                device_id: id,
                read_only: !spec.writes_supported(),
                spec: spec.clone(),
            };
            STATE.with(|s| {
                s.borrow_mut().open = Some(Open {
                    transport: Rc::new(transport),
                    spec,
                });
            });
            to_js(&info)
        }
        None => Err(connect_err(
            "unknownId",
            Some(id),
            format!("device id {id} is not in the registry"),
        )),
    }
}

/// Every USB vendor ID the registry knows about. The JS side needs these to
/// build WebHID filters; hardcoding `0x3151` there would hide every board
/// that ships under its brand's own ID.
#[wasm_bindgen]
pub fn vendor_ids() -> Vec<u16> {
    registry::vendor_ids().to_vec()
}

/// Cached connection state; the JS scan loop combines this with
/// `navigator.hid` device presence.
#[wasm_bindgen]
pub fn status() -> Result<JsValue, JsValue> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Status {
        connected: Option<ConnectedInfo>,
        stalled: bool,
    }
    STATE.with(|s| {
        let s = s.borrow();
        to_js(&Status {
            connected: s.open.as_ref().map(|o| ConnectedInfo {
                path: "webhid".into(),
                device_id: o.spec.id,
                read_only: !o.spec.writes_supported(),
                spec: o.spec.clone(),
            }),
            stalled: s.stalled,
        })
    })
}

/// The JS side calls this on a `disconnect` event (cable pulled).
#[wasm_bindgen]
pub fn drop_session() {
    STATE.with(|s| s.borrow_mut().open = None);
}

/// The JS side calls this once the stalled board has left the bus, which is
/// what a replug does; mirrors the desktop's scan-time stall clearing.
#[wasm_bindgen]
pub fn clear_stall() {
    STATE.with(|s| s.borrow_mut().stalled = false);
}

// ---------------------------------------------------------------------------
// Commands, mirroring src-tauri/src/commands.rs one for one

#[wasm_bindgen]
pub async fn get_led_param() -> Result<JsValue, JsValue> {
    let _busy = acquire().await;
    let (t, _) = get_open(false)?;
    let reply = t
        .roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    let p = LedParam::from_reply(&reply).ok_or("bad LEDPARAM reply")?;
    to_js(&p)
}

#[wasm_bindgen]
pub async fn set_led_param(param_json: String) -> Result<(), JsValue> {
    let param: LedParam = serde_json::from_str(&param_json).map_err(|e| e.to_string())?;
    gap(|s| &mut s.last_light, LIGHT_GAP_MS).await;
    let _busy = acquire().await;
    let (t, _) = get_open(true)?;
    t.send(&param.to_packet()).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn get_profile() -> Result<u8, JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let reply = t
        .roundtrip(fc.get_profile, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    Ok(reply[1])
}

#[wasm_bindgen]
pub async fn set_profile(profile: u8) -> Result<(), JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let pkt = protocol::packet(fc.set_profile, &[profile], Checksum::Bit7);
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

/// 512-byte matrix: 128 slots × 4 bytes, read as 8 raw pages. Mirrors
/// commands.rs::read_matrix, including the gen2 payload shapes.
async fn read_matrix(
    t: &Transport,
    fc: &'static FamilyCmds,
    profile: u8,
    fn_layer: bool,
) -> Result<Vec<u8>, HidErr> {
    let mut matrix = Vec::with_capacity(512);
    for page in 0..8u8 {
        let (opcode, payload): (u8, Vec<u8>) = match (fc.name == "gen2", fn_layer) {
            (true, false) => (
                fc.get_keymatrix,
                protocol::gen2::keymatrix_read_payload(profile, page).to_vec(),
            ),
            (true, true) => (
                cmd::GET_FN,
                protocol::gen2::fn_read_payload(profile, page).to_vec(),
            ),
            (false, false) => (fc.get_keymatrix, vec![profile, page]),
            (false, true) => (cmd::GET_FN, vec![profile, page]),
        };
        let reply = t.read_raw_page(opcode, &payload, Checksum::Bit7).await?;
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
) -> Result<[u8; REPORT_LEN], HidErr> {
    if fc.name == "gen2" {
        return Ok(if fn_layer {
            protocol::gen2::set_fn_key_packet(profile, slot, value)
        } else {
            protocol::gen2::set_key_packet(profile, slot, value)
        });
    }
    let opcode = if fn_layer {
        fc.set_fn_one
    } else {
        fc.set_key_one
    }
    .ok_or_else(|| HidErr::Protocol("no single-slot key write for this family".into()))?;
    let mut pkt = protocol::packet(opcode, &[profile, slot], Checksum::Bit7);
    pkt[8..12].copy_from_slice(&value);
    Ok(pkt)
}

#[wasm_bindgen]
pub async fn read_keymap(profile: u8) -> Result<Vec<u8>, JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    read_matrix(&t, fc, profile, false)
        .await
        .map_err(fail)
        .map_err(JsValue::from)
}

#[wasm_bindgen]
pub async fn read_fn_keymap(layer: u8) -> Result<Vec<u8>, JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    read_matrix(&t, fc, layer, true)
        .await
        .map_err(fail)
        .map_err(JsValue::from)
}

#[wasm_bindgen]
pub async fn set_key(profile: u8, slot: u8, value: Vec<u8>, fn_layer: bool) -> Result<(), JsValue> {
    let value: [u8; 4] = value
        .as_slice()
        .try_into()
        .map_err(|_| "key value must be 4 bytes")?;
    gap(|s| &mut s.last_key, KEY_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let pkt = key_write_packet(fc, profile, slot, value, fn_layer).map_err(fail)?;
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSettings {
    debounce: u8,
    sleep: SleepTimes,
    options: Option<KbOptions>,
    revision: String,
    auto_os: bool,
    side_light: Option<SledParam>,
}

async fn read_settings(
    t: &Transport,
    fc: &'static FamilyCmds,
    has_side_light: bool,
) -> Result<DeviceSettings, HidErr> {
    let deb = t.roundtrip(fc.get_debounce, &[], Checksum::Bit7).await?;
    let slp = t.roundtrip(fc.get_sleeptime, &[], Checksum::Bit7).await?;
    let opt = match fc.kboption {
        Some((_, get)) => Some(t.roundtrip(get, &[0], Checksum::Bit7).await?),
        None => None,
    };
    let revision = match fc.get_revision {
        Some(op) => {
            let rev = t.roundtrip(op, &[], Checksum::Bit7).await?;
            format!("{}.{:02}", rev[2], rev[1])
        }
        None => "unknown".into(),
    };
    let auto = match fc.auto_os {
        Some((_, get)) => t.roundtrip(get, &[], Checksum::Bit7).await.ok(),
        None => None,
    };
    let sled = match (has_side_light, fc.sled) {
        (true, Some((_, get))) => t
            .roundtrip(get, &[], Checksum::Bit7)
            .await
            .ok()
            .and_then(|r| SledParam::from_reply(&r)),
        _ => None,
    };
    Ok(DeviceSettings {
        debounce: deb[fc.debounce_at],
        sleep: SleepTimes::from_reply_expecting(&slp, fc.get_sleeptime, fc.sleep_reply_at)
            .ok_or_else(|| HidErr::Protocol("bad SLEEPTIME reply".into()))?,
        options: match (opt, fc.kboption) {
            (Some(o), Some((_, get))) => Some(
                KbOptions::from_reply_expecting(&o, get)
                    .ok_or_else(|| HidErr::Protocol("bad KBOPTION reply".into()))?,
            ),
            _ => None,
        },
        revision,
        auto_os: auto.map(|r| r[1] == 1).unwrap_or(false),
        side_light: sled,
    })
}

#[wasm_bindgen]
pub async fn get_settings() -> Result<JsValue, JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let s = read_settings(&t, fc, spec.features.side_light)
        .await
        .map_err(fail)?;
    to_js(&s)
}

#[wasm_bindgen]
pub async fn set_debounce(value: u8) -> Result<(), JsValue> {
    let value = value.clamp(1, 10);
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    // yc500 pads with a zero byte before the value; gen2 does not.
    let payload: &[u8] = if fc.debounce_at == 1 {
        &[value]
    } else {
        &[0, value]
    };
    let pkt = protocol::packet(fc.set_debounce, payload, Checksum::Bit7);
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn set_sleep(sleep_json: String) -> Result<(), JsValue> {
    let sleep: SleepTimes = serde_json::from_str(&sleep_json).map_err(|e| e.to_string())?;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    t.send(&sleep.to_packet_as(fc.set_sleeptime))
        .await
        .map_err(fail)?;
    Ok(())
}

/// Read-modify-write so bits sharkfin doesn't model survive untouched.
#[wasm_bindgen]
pub async fn set_options(options_json: String) -> Result<(), JsValue> {
    let options: KbOptions = serde_json::from_str(&options_json).map_err(|e| e.to_string())?;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let (set, get) = fc
        .kboption
        .ok_or("keyboard options are not decoded for this board's protocol family")?;
    let cur = t.roundtrip(get, &[0], Checksum::Bit7).await.map_err(fail)?;
    t.send(&options.to_packet_as(set, cur[2], cur[3], cur[4]))
        .await
        .map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn set_side_light(param_json: String) -> Result<(), JsValue> {
    let param: SledParam = serde_json::from_str(&param_json).map_err(|e| e.to_string())?;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    if !spec.features.side_light {
        return Err(format!("{} has no edge light", spec.label()).into());
    }
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    fc.sled
        .ok_or("edge light opcodes unknown for this family")?;
    t.send(&param.to_packet()).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn set_auto_os(enabled: bool) -> Result<(), JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let (set, _) = fc
        .auto_os
        .ok_or("host-OS auto-detect opcodes unknown for this family")?;
    let pkt = protocol::packet(set, &[enabled as u8], Checksum::Bit7);
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn factory_reset() -> Result<(), JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let pkt = protocol::packet(fc.set_reset, &[], Checksum::Bit7);
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

/// Blocks until FLASH_COOLDOWN has passed since the last flash-backed upload.
async fn flash_cooldown() {
    gap(|s| &mut s.last_flash, FLASH_COOLDOWN_MS).await;
}

#[wasm_bindgen]
pub async fn write_per_key(colors: Vec<u8>, activate: bool) -> Result<(), JsValue> {
    if colors.len() != protocol::PER_KEY_BYTES {
        return Err(format!(
            "expected {} colour bytes, got {}",
            protocol::PER_KEY_BYTES,
            colors.len()
        )
        .into());
    }
    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, _) = get_open(true)?;
    // Decide about the mode switch before the upload: asking afterwards
    // means talking to a board that is still writing flash.
    let needs_mode = activate
        && match t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7).await {
            Ok(r) => LedParam::from_reply(&r)
                .map(|p| p.mode != PER_KEY_MODE)
                .unwrap_or(true),
            Err(_) => true,
        };
    for page in 0..7u8 {
        t.send(&protocol::userpic_write_packet(page, &colors))
            .await
            .map_err(fail)?;
        sleep_ms(FLASH_PAGE_GAP_MS).await;
    }
    sleep_ms(FLASH_SETTLE_MS).await;
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
        )
        .await
        .map_err(fail)?;
    }
    Ok(())
}

fn check_macro_slot(slot: u8) -> Result<(), String> {
    if slot >= protocol::MACRO_SLOTS {
        return Err(format!(
            "macro slot {slot} out of range (0..{})",
            protocol::MACRO_SLOTS
        ));
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn read_macro(slot: u8) -> Result<JsValue, JsValue> {
    check_macro_slot(slot)?;
    let _busy = acquire().await;
    let (t, _) = get_open(false)?;
    let mut blob = [0u8; protocol::MACRO_BYTES];
    for page in 0..4u8 {
        let reply = t
            .read_raw_page(cmd::GET_MACRO, &[slot, page], Checksum::Bit7)
            .await
            .map_err(fail)?;
        blob[page as usize * 64..(page as usize + 1) * 64].copy_from_slice(&reply);
    }
    to_js(&Macro::from_blob(&blob))
}

#[wasm_bindgen]
pub async fn write_macro(slot: u8, data_json: String) -> Result<(), JsValue> {
    check_macro_slot(slot)?;
    let data: Macro = serde_json::from_str(&data_json).map_err(|e| e.to_string())?;
    let blob = data.to_blob()?;
    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let pages = protocol::macro_pages(&blob);
    for page in 0..pages {
        t.send(&protocol::macro_write_packet(
            fc.set_macro,
            slot,
            page,
            page + 1 == pages,
            &blob,
        ))
        .await
        .map_err(fail)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Config files. Identical JSON shape to the desktop's SavedConfig, so files
// move between the two builds.

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedConfig {
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

/// Reads everything restorable off the board and returns it as pretty JSON;
/// the JS side owns turning that into a download.
#[wasm_bindgen]
pub async fn export_config() -> Result<JsValue, JsValue> {
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let n = spec.profiles.clamp(1, 3);
    let mut profiles = Vec::new();
    let mut fn_layers = Vec::new();
    for p in 0..n {
        profiles.push(read_matrix(&t, fc, p, false).await.map_err(fail)?);
        fn_layers.push(read_matrix(&t, fc, p, true).await.map_err(fail)?);
    }
    let led = t
        .roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    let deb = t
        .roundtrip(fc.get_debounce, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    let slp = t
        .roundtrip(fc.get_sleeptime, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    let opt = match fc.kboption {
        Some((_, get)) => Some(t.roundtrip(get, &[0], Checksum::Bit7).await.map_err(fail)?),
        None => None,
    };
    let sled = match (spec.features.side_light, fc.sled) {
        (true, Some((_, get))) => t
            .roundtrip(get, &[], Checksum::Bit7)
            .await
            .ok()
            .and_then(|r| SledParam::from_reply(&r)),
        _ => None,
    };
    let cfg = SavedConfig {
        version: 1,
        device_id: spec.id,
        family: spec.family.clone(),
        board: spec.label(),
        profiles,
        fn_layers,
        led: LedParam::from_reply(&led).ok_or("bad LEDPARAM reply")?,
        side_light: sled,
        debounce: deb[fc.debounce_at],
        sleep: SleepTimes::from_reply_expecting(&slp, fc.get_sleeptime, fc.sleep_reply_at)
            .ok_or("bad SLEEPTIME reply")?,
        options: match (opt, fc.kboption) {
            (Some(o), Some((_, get))) => KbOptions::from_reply_expecting(&o, get),
            _ => None,
        },
    };
    serde_json::to_string_pretty(&cfg)
        .map(JsValue::from)
        .map_err(|e| JsValue::from(e.to_string()))
}

/// Applies a saved config from file contents: only slots that differ are
/// written, then the settings and lighting. Refuses configs from a different
/// board model.
#[wasm_bindgen]
pub async fn import_config(raw: String) -> Result<JsValue, JsValue> {
    let cfg: SavedConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    if cfg.device_id != spec.id {
        return Err(format!(
            "this config was exported from {} (device id {}), but {} (id {}) is connected",
            cfg.board,
            cfg.device_id,
            spec.label(),
            spec.id
        )
        .into());
    }
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let mut keys_written = 0usize;
    for (fn_layer, layers) in [(false, &cfg.profiles), (true, &cfg.fn_layers)] {
        for (p, target) in layers.iter().enumerate() {
            if target.len() != 512 {
                return Err(format!(
                    "profile {p} in the file is {} bytes, expected 512",
                    target.len()
                )
                .into());
            }
            let current = read_matrix(&t, fc, p as u8, fn_layer).await.map_err(fail)?;
            for slot in 0..128usize {
                let want: [u8; 4] = target[slot * 4..slot * 4 + 4].try_into().unwrap();
                if current[slot * 4..slot * 4 + 4] != want {
                    let pkt =
                        key_write_packet(fc, p as u8, slot as u8, want, fn_layer).map_err(fail)?;
                    t.send(&pkt).await.map_err(fail)?;
                    keys_written += 1;
                    sleep_ms(KEY_GAP_MS).await;
                }
            }
        }
    }
    if let (Some(opts), Some((set, get))) = (cfg.options, fc.kboption) {
        let cur = t.roundtrip(get, &[0], Checksum::Bit7).await.map_err(fail)?;
        t.send(&opts.to_packet_as(set, cur[2], cur[3], cur[4]))
            .await
            .map_err(fail)?;
    }
    let deb = cfg.debounce.clamp(1, 10);
    let deb_payload: &[u8] = if fc.debounce_at == 1 {
        &[deb]
    } else {
        &[0, deb]
    };
    t.send(&protocol::packet(
        fc.set_debounce,
        deb_payload,
        Checksum::Bit7,
    ))
    .await
    .map_err(fail)?;
    t.send(&cfg.sleep.to_packet_as(fc.set_sleeptime))
        .await
        .map_err(fail)?;
    if let (Some(sled), true, Some(_)) = (cfg.side_light, spec.features.side_light, fc.sled) {
        t.send(&sled.to_packet()).await.map_err(fail)?;
    }
    t.send(&cfg.led.to_packet()).await.map_err(fail)?;
    Ok(format!(
        "restored {keys_written} keys, settings and lighting from {}",
        cfg.board
    )
    .into())
}

// ---------------------------------------------------------------------------
// Contribution bundle: same probes and format as the desktop.

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

async fn probe_sweep(t: &Transport, out: &mut String) -> Result<(), JsValue> {
    use std::fmt::Write;
    let _ = writeln!(
        out,
        "\nread sweep, both families' GET opcodes; an unimplemented \
         command echoes the previous reply:"
    );
    for (label, opcode, payload) in BUNDLE_PROBES {
        match t.read_raw_page(*opcode, payload, Checksum::Bit7).await {
            Ok(reply) => {
                let hex: String = reply.iter().fold(String::new(), |mut s, b| {
                    let _ = write!(s, "{b:02x} ");
                    s
                });
                let _ = writeln!(out, "{label:<24} {}", hex.trim_end());
            }
            Err(e) => {
                if e.is_stall() {
                    return Err(fail(e).into());
                }
                let _ = writeln!(out, "{label:<24} error: {e}");
            }
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn contribution_bundle() -> Result<JsValue, JsValue> {
    use std::fmt::Write;
    let _busy = acquire().await;
    let (t, spec) = get_open(false)?;
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(
        out,
        "sharkfin {} data bundle (web)",
        env!("CARGO_PKG_VERSION")
    );
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
    probe_sweep(&t, &mut out).await?;
    let _ = writeln!(out, "```");
    Ok(out.into())
}

/// Bundle for a picker-granted board whose identify answer is not in the
/// registry. The same read-only probes; the header carries what WebHID
/// exposes instead of a registry entry.
#[wasm_bindgen]
pub async fn unknown_bundle(device: JsHidDevice) -> Result<JsValue, JsValue> {
    use std::fmt::Write;
    let _busy = acquire().await;
    let stalled = STATE.with(|s| s.borrow().stalled);
    if stalled {
        return Err(JsValue::from(STALL_MESSAGE));
    }
    if !device.opened() {
        JsFuture::from(device.open())
            .await
            .map_err(|e| JsValue::from(js_err_text(e)))?;
    }
    let product = device.product_name();
    let vid = device.vendor_id();
    let pid = device.product_id();
    let t = Transport {
        dev: device,
        last_write: std::cell::Cell::new(js_now() - MIN_WRITE_GAP_MS),
    };
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(
        out,
        "sharkfin {} data bundle (web)",
        env!("CARGO_PKG_VERSION")
    );
    let product = if product.is_empty() {
        "unnamed board".into()
    } else {
        product
    };
    let _ = writeln!(out, "board  : {product} (not in the registry)");
    let _ = writeln!(out, "usb    : {vid:04x}:{pid:04x}");
    match t.identify().await {
        Ok(id) => {
            let _ = writeln!(out, "identify: device id {id}");
        }
        Err(e) if e.is_stall() => return Err(fail(e).into()),
        Err(_) => {
            let _ = writeln!(out, "identify: no answer");
        }
    }
    probe_sweep(&t, &mut out).await?;
    let _ = writeln!(out, "```");
    Ok(out.into())
}

/// Dev escape hatch, same as the desktop's.
#[wasm_bindgen]
pub async fn raw_command(
    opcode: u8,
    payload: Vec<u8>,
    checksum: String,
) -> Result<Vec<u8>, JsValue> {
    let mode = match checksum.as_str() {
        "bit7" => Checksum::Bit7,
        "bit8" => Checksum::Bit8,
        _ => Checksum::None,
    };
    let _busy = acquire().await;
    let (t, _) = get_open(false)?;
    let reply = t.roundtrip(opcode, &payload, mode).await.map_err(fail)?;
    Ok(reply.to_vec())
}
