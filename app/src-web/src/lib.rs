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
    cmd, family_cmds, receiver, Checksum, FamilyCmds, KbOptions, LedParam, Macro, SledParam,
    SleepTimes, REPORT_LEN,
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
    KeyboardOffline,
    ReceiverBusy,
    ShortRead(usize),
    Protocol(String),
}

impl std::fmt::Display for HidErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HidErr::Stall(m) => write!(f, "webhid: {m}"),
            HidErr::NoHandshake => write!(f, "device did not answer the identify handshake"),
            HidErr::KeyboardOffline => write!(
                f,
                "the receiver is paired, but the keyboard is asleep or switched off"
            ),
            HidErr::ReceiverBusy => write!(f, "the receiver did not accept a packet to relay"),
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

/// Receiver bookkeeping, same numbers and reasoning as hid.rs.
const RECEIVER_SEND_DEADLINE_MS: f64 = 500.0;
const RECEIVER_READ_DEADLINE_MS: f64 = 1000.0;
const RECEIVER_TICK_MS: f64 = 5.0;
const RECEIVER_REST_MS: f64 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum Link {
    Usb,
    Receiver,
}

struct Transport {
    dev: JsHidDevice,
    last_write: std::cell::Cell<f64>,
    /// Set once identify has succeeded through the receiver's relay; every
    /// send and read then goes through the select/release handshake.
    relay: std::cell::Cell<bool>,
    /// The receiver keeps its relay target until told otherwise.
    selected: std::cell::Cell<bool>,
}

impl Transport {
    async fn pace(&self) {
        let since = js_now() - self.last_write.get();
        if since < MIN_WRITE_GAP_MS {
            sleep_ms(MIN_WRITE_GAP_MS - since).await;
        }
        self.last_write.set(js_now());
    }

    fn link(&self) -> Link {
        if self.relay.get() {
            Link::Receiver
        } else {
            Link::Usb
        }
    }

    async fn send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidErr> {
        if self.relay.get() {
            self.relay_send(buf).await
        } else {
            self.raw_send(buf).await
        }
    }

    async fn read(&self) -> Result<[u8; REPORT_LEN], HidErr> {
        if self.relay.get() {
            self.relay_read().await
        } else {
            self.raw_read().await
        }
    }

    /// The receiver's own status; `None` when the node is a keyboard on a
    /// cable.
    async fn receiver_status(&self) -> Result<Option<receiver::Status>, HidErr> {
        self.raw_send(&receiver::status_packet()).await?;
        sleep_ms(RECEIVER_REST_MS).await;
        Ok(receiver::parse_status(&self.raw_read().await?))
    }

    async fn relay_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidErr> {
        let deadline = js_now() + RECEIVER_SEND_DEADLINE_MS;
        let mut ready = false;
        loop {
            match self.receiver_status().await? {
                Some(s) if !s.keyboard_online => return Err(HidErr::KeyboardOffline),
                Some(s) if s.can_send => {
                    ready = true;
                    break;
                }
                _ => {}
            }
            if js_now() >= deadline {
                break;
            }
            sleep_ms(RECEIVER_TICK_MS).await;
        }
        if !ready {
            self.selected.set(false);
            return Err(HidErr::ReceiverBusy);
        }
        if !self.selected.get() {
            self.raw_send(&receiver::select_keyboard_packet()).await?;
            sleep_ms(RECEIVER_REST_MS).await;
            self.selected.set(true);
        }
        self.raw_send(buf).await
    }

    async fn relay_read(&self) -> Result<[u8; REPORT_LEN], HidErr> {
        let deadline = js_now() + RECEIVER_READ_DEADLINE_MS;
        let mut ready = false;
        loop {
            if matches!(self.receiver_status().await?, Some(s) if s.reply_ready) {
                ready = true;
                break;
            }
            if js_now() >= deadline {
                break;
            }
            sleep_ms(RECEIVER_TICK_MS).await;
        }
        if !ready {
            return Err(HidErr::NoHandshake);
        }
        self.raw_send(&receiver::release_packet()).await?;
        sleep_ms(RECEIVER_REST_MS).await;
        self.raw_read().await
    }

    /// One feature report to whatever is on the other end of the node: the
    /// keyboard by cable, or the receiver itself.
    async fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidErr> {
        self.pace().await;
        let arr = js_sys::Uint8Array::new_with_length(REPORT_LEN as u32);
        arr.copy_from(buf);
        JsFuture::from(self.dev.send_feature_report(0, &arr))
            .await
            .map(|_| ())
            .map_err(|e| HidErr::Stall(js_err_text(e)))
    }

    async fn raw_read(&self) -> Result<[u8; REPORT_LEN], HidErr> {
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

    /// Round-trip a packet the caller built. The screen announce sets fields
    /// past the checksum byte, so it cannot be an opcode plus a payload.
    async fn roundtrip_packet(&self, pkt: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidErr> {
        self.send(pkt).await?;
        for attempt in 0..5u32 {
            sleep_ms(SETTLE_MS * (attempt + 1) as f64).await;
            let reply = self.read().await?;
            if reply[0] == pkt[0] {
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

    async fn try_identify(&self) -> Option<u32> {
        for _ in 0..3 {
            if let Ok(reply) = self
                .roundtrip(cmd::GET_USB_VERSION, &[], Checksum::Bit7)
                .await
            {
                if let Some(id) = protocol::parse_device_id(&reply) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// 0x8F identify. A node that does not answer by cable is asked whether
    /// it is a receiver, and identify is repeated through the relay when it
    /// is one with a keyboard awake. Same shape as hid.rs.
    async fn identify(&self) -> Result<u32, HidErr> {
        if self.relay.get() {
            return self.try_identify().await.ok_or(HidErr::NoHandshake);
        }
        if let Some(id) = self.try_identify().await {
            return Ok(id);
        }
        let Some(status) = self.receiver_status().await? else {
            return Err(HidErr::NoHandshake);
        };
        if !status.has_keyboard || !status.keyboard_online {
            return Err(HidErr::KeyboardOffline);
        }
        self.relay.set(true);
        self.selected.set(false);
        match self.try_identify().await {
            Some(id) => Ok(id),
            None => {
                self.relay.set(false);
                Err(HidErr::NoHandshake)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Session state. One board, like the desktop app.

/// Same values and rationale as commands.rs; see the comments there.
const FLASH_COOLDOWN_MS: f64 = 10_000.0;
const FLASH_PAGE_GAP_MS: f64 = 100.0;
const FLASH_SETTLE_MS: f64 = 2_000.0;
const KEY_GAP_MS: f64 = 400.0;
/// Lighting is onboard state, so every write lands in flash; see the note
/// on the desktop constant.
const LIGHT_GAP_MS: f64 = 1000.0;
/// Everything else a user can hold down or click repeatedly: profile
/// switches, debounce and sleep sliders, auto-OS, reset. Flash class: all
/// of it survives a power cycle; see the note on the desktop constant.
const SETTING_GAP_MS: f64 = 1000.0;
const PER_KEY_MODE: u8 = 13;

pub const STALL_MESSAGE: &str =
    "The keyboard stopped responding. Unplug it, wait ten seconds, and plug it back in.";

struct Open {
    transport: Rc<Transport>,
    spec: DeviceSpec,
    /// Reported by the receiver at connect; there is no such number by cable.
    battery: Option<u8>,
}

#[derive(Default)]
struct AppState {
    open: Option<Open>,
    stalled: bool,
    busy: bool,
    last_flash: Option<(f64, f64)>,
    /// One clock for every command write: when the last one was claimed,
    /// and the floor its class asked for. Both halves matter, since the
    /// quiet a write needs after it is a property of that write.
    last_cmd: Option<(f64, f64)>,
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

/// Factory reset and screen frames wait for the cable; same reasoning as
/// commands.rs::require_cable.
fn require_cable() -> Result<(), String> {
    STATE.with(|s| match &s.borrow().open {
        Some(open) if open.transport.link() == Link::Receiver => {
            Err("Not over the receiver yet: connect the keyboard by cable for this.".into())
        }
        _ => Ok(()),
    })
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

/// Claims the next slot on a clock and waits for it.
///
/// The slot is claimed before awaiting, not after waking: callers that only
/// read the clock all compute the same deadline and then fire together,
/// which is the flood this exists to prevent. The wait is the stricter of
/// the two floors involved, so a key write's 400 ms of quiet is not cut
/// short by a lighting write following it.
async fn gap(last: impl Fn(&mut AppState) -> &mut Option<(f64, f64)> + Copy, min_ms: f64) {
    let now = js_now();
    let wait = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let next = match *last(&mut s) {
            Some((prev, prev_min)) => {
                let gap = prev_min.max(min_ms);
                if prev + gap > now {
                    prev + gap
                } else {
                    now
                }
            }
            None => now,
        };
        *last(&mut s) = Some((next, min_ms));
        next - now
    });
    if wait > 0.0 {
        sleep_ms(wait).await;
    }
}

/// Waits out whatever quiet the last write declared, without claiming the
/// clock. Reads share the wire with flash-class writes, and a read landing
/// in a write's quiet window stalls the endpoint just as another write
/// would: an X86 wedged on a keymap read 120 ms after a profile switch.
async fn read_quiet() {
    let wait = STATE.with(|s| match s.borrow().last_cmd {
        Some((prev, min)) => prev + min - js_now(),
        None => 0.0,
    });
    if wait > 0.0 {
        sleep_ms(wait).await;
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
    /// Cable, or the 2.4 GHz receiver's relay. Factory reset needs the cable.
    link: Link,
    /// Percent, receiver link only.
    battery: Option<u8>,
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
        relay: std::cell::Cell::new(false),
        selected: std::cell::Cell::new(false),
    };
    let id = match transport.identify().await {
        Ok(id) => id,
        Err(HidErr::KeyboardOffline) => {
            return Err(connect_err(
                "keyboardOffline",
                None,
                HidErr::KeyboardOffline.to_string(),
            ))
        }
        Err(e) => return Err(connect_err("noHandshake", None, e.to_string())),
    };
    match registry::by_id(id) {
        Some(spec) => {
            let battery = if transport.link() == Link::Receiver {
                transport
                    .receiver_status()
                    .await
                    .ok()
                    .flatten()
                    .map(|s| s.keyboard_battery)
            } else {
                None
            };
            let info = ConnectedInfo {
                path: "webhid".into(),
                device_id: id,
                read_only: !spec.writes_supported(),
                spec: spec.clone(),
                link: transport.link(),
                battery,
            };
            STATE.with(|s| {
                s.borrow_mut().open = Some(Open {
                    transport: Rc::new(transport),
                    spec,
                    battery,
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

/// Which build this is, for the UI to show and a reporter to quote.
#[wasm_bindgen]
pub fn build_id() -> String {
    registry::build_id()
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
                link: o.transport.link(),
                battery: o.battery,
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
    read_quiet().await;
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
    gap(|s| &mut s.last_cmd, LIGHT_GAP_MS).await;
    let _busy = acquire().await;
    let (t, _) = get_open(true)?;
    t.send(&param.to_packet()).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn get_profile() -> Result<u8, JsValue> {
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let reply = t
        .roundtrip(fc.get_profile, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    Ok(reply[1])
}

/// The display's own firmware version, or `None` on a board without one.
/// `0xAD` means the same thing in both families, so it needs no family
/// lookup. A board with no display echoes the previous reply instead.
#[wasm_bindgen]
pub async fn get_screen_version() -> Result<Option<u16>, JsValue> {
    let _busy = acquire().await;
    read_quiet().await;
    let (t, _) = get_open(false)?;
    let reply = t
        .roundtrip(protocol::cmd::GET_OLED_VERSION, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    if reply[0] != protocol::cmd::GET_OLED_VERSION {
        return Ok(None);
    }
    let version = u16::from(reply[1]) | (u16::from(reply[2]) << 8);
    Ok((version != 0).then_some(version))
}

#[wasm_bindgen]
pub async fn set_profile(profile: u8) -> Result<(), JsValue> {
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let pkt = protocol::packet(fc.set_profile, &[profile], Checksum::Bit7);
    t.send(&pkt).await.map_err(fail)?;
    // The switch lands in flash and gets no ack, and anything on the wire
    // during the commit can stall the endpoint. GET_PROFILE is no probe of
    // the commit either: it answers within 25 ms while the commit is still
    // going. So the full quiet comes first and the confirmation after, with
    // the busy guard held throughout, like a flash batch.
    sleep_ms(SETTING_GAP_MS).await;
    let reply = t
        .roundtrip(fc.get_profile, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    if reply[1] != profile {
        return Err(
            HidErr::Protocol("the board did not take the profile switch".into())
                .to_string()
                .into(),
        );
    }
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
    read_quiet().await;
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
    read_quiet().await;
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
    gap(|s| &mut s.last_cmd, KEY_GAP_MS).await;
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
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let s = read_settings(&t, fc, spec.features.side_light)
        .await
        .map_err(fail)?;
    to_js(&s)
}

#[wasm_bindgen]
pub async fn set_debounce(value: u8) -> Result<(), JsValue> {
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
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
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
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
    // The Lighting page toggles these, and this one costs two reports, so
    // it belongs under the same floor as the sliders beside it.
    gap(|s| &mut s.last_cmd, LIGHT_GAP_MS).await;
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
    gap(|s| &mut s.last_cmd, LIGHT_GAP_MS).await;
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
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
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
    require_cable()?;
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
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
    // Claimed last: claiming before a ten second wait would leave the shared
    // clock stale enough for anything racing in to skip its gap entirely.
    gap(|s| &mut s.last_cmd, FLASH_PAGE_GAP_MS).await;
}

/// Same values and reasoning as commands.rs.
const SCREEN_PAGE_GAP_MS: f64 = 5.0;
const SCREEN_READY_TRIES: u32 = 10;
const SCREEN_READY_GAP_MS: f64 = 100.0;

/// Draw one still frame on the display. `rgb` is `w * h * 3` in row order;
/// the column order and pixel format the display wants are applied here.
/// Lands in flash, so it takes the flash cooldown.
#[wasm_bindgen]
pub async fn write_screen_image(rgb: Vec<u8>) -> Result<(), JsValue> {
    require_cable()?;
    let (screen, rules) = {
        let (_, spec) = get_open(false)?;
        (
            spec.screen.clone().ok_or_else(|| {
                JsValue::from_str("this board has no display sharkfin knows the size of")
            })?,
            spec.screen_draw(),
        )
    };
    // Only boards whose own firmware parses the frame; see the note in
    // commands.rs. Most gen2 boards forward the request to a display chip
    // whose own expectations are not established.
    let Some(rules) = rules else {
        return Err(JsValue::from_str(
            "sharkfin can only draw on this family of board so far. This one hands \
             the picture to a separate display chip, and that path is not worked out.",
        ));
    };
    // The mode picks the opcode pair, and the frame stays within the length
    // the firmware reads; see the notes in commands.rs and protocol.rs.
    let (announce, page_op) = match screen.mode.as_str() {
        "16" => (0xA5_u8, 0x25_u8),
        "24" if rules.mode24 => (0xA9_u8, 0x29_u8),
        other => return Err(format!("sharkfin cannot draw on a mode {other} display yet").into()),
    };
    // See ScreenDrawRules::max_dim: a panel the bounding box cannot address
    // would be drawn at the wrong size rather than refused.
    if screen.w > rules.max_dim || screen.h > rules.max_dim {
        return Err(JsValue::from_str(
            "this display is larger than sharkfin can address on this board",
        ));
    }
    let data = protocol::screen_pixels(&rgb, screen.w, screen.h, &screen.mode)
        .map_err(|e| JsValue::from_str(&e))?;
    if data.len() > rules.max_frame {
        return Err(JsValue::from_str(
            "this display takes a bigger frame than sharkfin can safely send yet",
        ));
    }

    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, _) = get_open(true)?;
    let pkt = protocol::screen_announce_packet(
        announce,
        0,
        1,
        0,
        data.len() as u32,
        (0, 0, screen.w, screen.h),
        0,
    );
    let mut ready = false;
    for _ in 0..SCREEN_READY_TRIES {
        // Not ready looks like a different answer or none at all; anything
        // else is the transport failing and is reported as that, not as a
        // refusal.
        match t.roundtrip_packet(&pkt).await {
            Ok(reply) if reply[1] == 1 => {
                ready = true;
                break;
            }
            Ok(_) | Err(HidErr::NoHandshake) => {}
            Err(e) => return Err(fail(e).into()),
        }
        sleep_ms(SCREEN_READY_GAP_MS).await;
    }
    if !ready {
        return Err(JsValue::from_str("the display did not accept the picture"));
    }
    for page in protocol::screen_page_packets(page_op, 0, 1, 0, &data) {
        t.send(&page).await.map_err(fail)?;
        sleep_ms(SCREEN_PAGE_GAP_MS).await;
    }
    sleep_ms(FLASH_SETTLE_MS).await;
    Ok(())
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
    let (t, spec) = get_open(true)?;
    // Decide about the mode switch before the upload: asking afterwards
    // means talking to a board that is still writing flash.
    let needs_mode = activate
        && match t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7).await {
            Ok(r) => LedParam::from_reply(&r)
                .map(|p| p.mode != PER_KEY_MODE)
                .unwrap_or(true),
            Err(_) => true,
        };
    if spec.family == "gen2" {
        // Slot 0, matching the option nibble in the mode switch below.
        for pkt in protocol::gen2::userpic_packets(0, &colors) {
            t.send(&pkt).await.map_err(fail)?;
            sleep_ms(FLASH_PAGE_GAP_MS).await;
        }
    } else {
        for page in 0..7u8 {
            t.send(&protocol::userpic_write_packet(page, &colors))
                .await
                .map_err(fail)?;
            sleep_ms(FLASH_PAGE_GAP_MS).await;
        }
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
    read_quiet().await;
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
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    // Every profile the board claims; see MAX_PROFILES in commands.rs.
    let n = spec.profiles.clamp(1, 8);
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
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "sharkfin {} data bundle (web)", registry::build_id());
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
        relay: std::cell::Cell::new(false),
        selected: std::cell::Cell::new(false),
    };
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "sharkfin {} data bundle (web)", registry::build_id());
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
    read_quiet().await;
    let (t, _) = get_open(false)?;
    let reply = t.roundtrip(opcode, &payload, mode).await.map_err(fail)?;
    Ok(reply.to_vec())
}
