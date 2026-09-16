// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! Browser build. `protocol.rs` and `registry.rs` included by path.
//! WebHID replaces hidapi; wasm-bindgen replaces Tauri commands. Pacing
//! (report gap, flash cooldown, key and light floors) lives here, same
//! numbers as commands.rs, not in the UI.
#![allow(dead_code)]

#[path = "../../src-tauri/src/derive.rs"]
mod derive;
#[path = "../../src-tauri/src/ops.rs"]
mod ops;
#[path = "../../src-tauri/src/protocol/mod.rs"]
mod protocol;
#[path = "../../src-tauri/src/registry.rs"]
mod registry;
#[path = "../../src-tauri/src/session.rs"]
mod session;
#[path = "../../src-tauri/src/wire.rs"]
mod wire;

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use protocol::hall;
use protocol::{
    cmd, driveall, family_cmds, Checksum, KbOptions, LedParam, Macro, SledParam, SleepTimes,
    REPORT_LEN,
};
use registry::DeviceSpec;

// ---------------------------------------------------------------------------
// JS interop

#[wasm_bindgen(inline_js = "
export function js_sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function js_now() { return performance.now(); }
export function sendOutput(dev, bytes) { return dev.sendReport(0, bytes); }
export function nextInput(dev, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      dev.removeEventListener('inputreport', on);
      reject(new Error('timeout'));
    }, ms);
    function on(ev) {
      clearTimeout(t);
      dev.removeEventListener('inputreport', on);
      resolve(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
    }
    dev.addEventListener('inputreport', on);
  });
}
")]
extern "C" {
    fn js_sleep(ms: f64) -> js_sys::Promise;
    fn js_now() -> f64;
    fn sendOutput(dev: &JsValue, bytes: &js_sys::Uint8Array) -> js_sys::Promise;
    fn nextInput(dev: &JsValue, ms: f64) -> js_sys::Promise;
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
    #[wasm_bindgen(method, getter)]
    fn collections(this: &JsHidDevice) -> js_sys::Array;
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
    #[wasm_bindgen(method, js_name = sendReport)]
    fn send_report(this: &JsHidDevice, report_id: u8, data: &js_sys::Uint8Array)
        -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = addEventListener)]
    fn add_event_listener(this: &JsHidDevice, kind: &str, cb: &js_sys::Function);
}

// ---------------------------------------------------------------------------
// Transport: WebHID feature reports with the same pacing as hid.rs
use ops::{check_macro_slot, key_write_packet, need, read_matrix};
use session::{switch_access, DeviceSettings, OwnerRecord, SavedConfig, SwitchAccess};
use wire::{LinkKind as Link, Stack, Wire, WireError as HidErr, WireError};

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

/// How long a driveall input report is waited for, matching the timeout
/// hid.rs passes `read_timeout`. A late reply is picked up by the next
/// attempt in `driveall_exchange`, so this is a poll window, not a budget.
const INPUT_REPORT_WAIT_MS: f64 = 500.0;
const INPUT_REPORT_POLL_MS: f64 = 2.0;

struct Transport {
    dev: JsHidDevice,
    last_write: std::cell::Cell<f64>,
    /// Set once identify has succeeded through the receiver's relay; every
    /// send and read then goes through the select/release handshake.
    relay: std::cell::Cell<bool>,
    /// The receiver keeps its relay target until told otherwise.
    selected: std::cell::Cell<bool>,
    stack: Stack,
    /// Driveall answers with input reports, which arrive as events rather
    /// than as the answer to a read. They queue here the way hidapi queues
    /// them for the desktop, so both backends skip a stale reply the same
    /// way instead of one of them losing it.
    inbox: Rc<RefCell<VecDeque<[u8; REPORT_LEN]>>>,
    /// Dropping the closure would unregister the listener.
    _on_input: Option<Closure<dyn FnMut(JsValue)>>,
}

impl Transport {
    /// Opened device in, transport out. Driveall gets its input-report
    /// listener here: registering it late loses the replies sent before.
    fn new(dev: JsHidDevice, stack: Stack) -> Self {
        let inbox: Rc<RefCell<VecDeque<[u8; REPORT_LEN]>>> = Rc::new(RefCell::new(VecDeque::new()));
        let on_input = (stack == Stack::Driveall).then(|| {
            let sink = inbox.clone();
            let cb = Closure::<dyn FnMut(JsValue)>::new(move |ev: JsValue| {
                let Ok(data) = js_sys::Reflect::get(&ev, &"data".into()) else {
                    return;
                };
                let dv: js_sys::DataView = data.unchecked_into();
                let n = dv.byte_length();
                // The event's view excludes the report ID, so a 64-byte
                // report is 64 bytes. Anything else is another collection's
                // traffic on the same device and is not a reply.
                if n != REPORT_LEN {
                    return;
                }
                let mut out = [0u8; REPORT_LEN];
                for (i, b) in out.iter_mut().enumerate() {
                    *b = dv.get_uint8(i);
                }
                let mut q = sink.borrow_mut();
                if q.len() == INBOX_LIMIT {
                    q.pop_front();
                }
                q.push_back(out);
            });
            dev.add_event_listener("inputreport", cb.as_ref().unchecked_ref());
            cb
        });
        Self {
            dev,
            last_write: std::cell::Cell::new(js_now() - MIN_WRITE_GAP_MS),
            relay: std::cell::Cell::new(false),
            selected: std::cell::Cell::new(false),
            stack,
            inbox,
            _on_input: on_input,
        }
    }

    async fn pace(&self) {
        let since = js_now() - self.last_write.get();
        if since < MIN_WRITE_GAP_MS {
            sleep_ms(MIN_WRITE_GAP_MS - since).await;
        }
        self.last_write.set(js_now());
    }

    /// One report to whatever is on the other end of the node: the keyboard
    /// by cable, or the receiver itself. Feature reports on ROYUAN, output
    /// reports on driveall, which has no feature reports to send.
    async fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidErr> {
        self.pace().await;
        let arr = js_sys::Uint8Array::new_with_length(REPORT_LEN as u32);
        arr.copy_from(buf);
        let call = if self.stack == Stack::Driveall {
            self.dev.send_report(0, &arr)
        } else {
            self.dev.send_feature_report(0, &arr)
        };
        JsFuture::from(call)
            .await
            .map(|_| ())
            .map_err(|e| HidErr::Stall(js_err_text(e)))
    }

    async fn raw_read(&self) -> Result<[u8; REPORT_LEN], HidErr> {
        if self.stack == Stack::Driveall {
            return self.read_input().await;
        }
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

    /// The oldest queued input report, or `ShortRead(0)` once the window
    /// closes. Silence is not an error the handle should be dropped for.
    async fn read_input(&self) -> Result<[u8; REPORT_LEN], HidErr> {
        let deadline = js_now() + INPUT_REPORT_WAIT_MS;
        loop {
            if let Some(report) = self.inbox.borrow_mut().pop_front() {
                return Ok(report);
            }
            if js_now() >= deadline {
                return Err(HidErr::ShortRead(0));
            }
            sleep_ms(INPUT_REPORT_POLL_MS).await;
        }
    }
}

/// Enough to hold a chunked read's replies if the page is descheduled mid
/// exchange. Older than that is not a reply anyone is still waiting for.
const INBOX_LIMIT: usize = 32;

impl wire::Node for Transport {
    fn stack(&self) -> Stack {
        self.stack
    }

    fn relay(&self) -> bool {
        self.relay.get()
    }

    fn set_relay(&self, on: bool) {
        self.relay.set(on);
    }

    fn selected(&self) -> bool {
        self.selected.get()
    }

    fn set_selected(&self, on: bool) {
        self.selected.set(on);
    }

    fn now_ms(&self) -> f64 {
        js_now()
    }

    async fn sleep_ms(&self, ms: u64) {
        sleep_ms(ms as f64).await;
    }

    async fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        Transport::raw_send(self, buf).await
    }

    async fn raw_read(&self) -> Result<[u8; REPORT_LEN], WireError> {
        Transport::raw_read(self).await
    }
}

// ---------------------------------------------------------------------------
// Session state. One board, like the desktop app.

/// Same values and rationale as commands.rs; see the comments there.
const FLASH_COOLDOWN_MS: f64 = 10_000.0;
const FLASH_PAGE_GAP_MS: f64 = 100.0;
const FLASH_SETTLE_MS: f64 = 2_000.0;
const KEY_GAP_MS: f64 = 400.0;
const LIGHT_GAP_MS: f64 = 1000.0;
const SETTING_GAP_MS: f64 = 1000.0;
const PER_KEY_MODE: u8 = 13;

pub const STALL_MESSAGE: &str =
    "The keyboard stopped responding. Unplug it, wait ten seconds, and plug it back in.";

struct Open {
    transport: Rc<Transport>,
    spec: DeviceSpec,
    /// Reported by the receiver at connect; there is no such number by cable.
    battery: Option<u8>,
    /// The settings collection's usage on the vendor page, for the bundle.
    usage: u16,
    /// The `0x80` reply as a u16, read once at connect. Gates the yc500
    /// switch columns, which arrived with firmware 2.00.
    revision: Option<u16>,
    driveall: Option<driveall::DeviceInfo>,
}

/// The open board's revision and switch access, with no board an error.
fn open_switches() -> Result<(Option<u16>, SwitchAccess), String> {
    STATE.with(|s| {
        let s = s.borrow();
        let open = s.open.as_ref().ok_or("no device connected")?;
        let read_only =
            !open.spec.writes_supported() || (open.spec.unregistered && !s.unregistered_ok);
        Ok((
            open.revision,
            switch_access(&open.spec, open.revision, read_only, s.owner.switch_writes),
        ))
    })
}

/// The usage the device's vendor-page collection reports, 0 when none.
fn vendor_usage(device: &JsHidDevice) -> u16 {
    let mut driveall_usage = 0u16;
    for c in device.collections().iter() {
        let get = |k: &str| {
            js_sys::Reflect::get(&c, &JsValue::from_str(k))
                .ok()
                .and_then(|v| v.as_f64())
        };
        let page = get("usagePage").unwrap_or(0.0) as u16;
        let usage = get("usage").unwrap_or(0.0) as u16;
        if page == protocol::USAGE_PAGE && protocol::USAGES.contains(&usage) {
            return usage;
        }
        if driveall::is_collection(page, usage) {
            if page == driveall::USAGE_PAGE_FF68 {
                return usage;
            }
            driveall_usage = usage;
        }
    }
    driveall_usage
}

fn device_stack(device: &JsHidDevice) -> Stack {
    for c in device.collections().iter() {
        let get = |k: &str| {
            js_sys::Reflect::get(&c, &JsValue::from_str(k))
                .ok()
                .and_then(|v| v.as_f64())
        };
        let page = get("usagePage").unwrap_or(0.0) as u16;
        let usage = get("usage").unwrap_or(0.0) as u16;
        if driveall::is_collection(page, usage) {
            return Stack::Driveall;
        }
    }
    Stack::Royuan
}

/// Whether the open board addresses profiles as `profile * 4 + sublayer`.
fn scaled_profiles() -> bool {
    STATE.with(|s| {
        s.borrow()
            .open
            .as_ref()
            .is_some_and(|o| o.spec.family == "yc500" && o.spec.magnetic)
    })
}

#[derive(Default)]
struct AppState {
    open: Option<Open>,
    stalled: bool,
    busy: bool,
    /// Unregistered: owner allowed writes this session. Cleared with the session.
    unregistered_ok: bool,
    /// Owner override for the LEDPARAM flags nibble. Kept off the spec.
    led_swap: Option<bool>,
    /// Check answers. Cleared with the session.
    owner: OwnerRecord,
    /// Slot the check may write switch columns to. Mirrors commands.rs.
    switch_trial: Option<u8>,
    last_flash: Option<(f64, f64)>,
    /// Last write claim: instant and the quiet that write required after itself.
    last_cmd: Option<(f64, f64)>,
}

thread_local! {
    static STATE: RefCell<AppState> = RefCell::new(AppState::default());
}

/// JS is single-threaded but async calls interleave; two exchanges at once
/// corrupt both. Stand-in for the desktop mutex. Ops are short, so poll.
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
        if require_writable && open.spec.unregistered && !s.unregistered_ok {
            return Err(
                "This keyboard is not in sharkfin's list. Allow changes on the notice above first."
                    .into(),
            );
        }
        Ok((open.transport.clone(), open.spec.clone()))
    })
}

fn is_driveall() -> bool {
    STATE.with(|s| {
        s.borrow()
            .open
            .as_ref()
            .is_some_and(|o| o.spec.family == "driveall")
    })
}

fn driveall_info() -> Result<driveall::DeviceInfo, String> {
    STATE.with(|s| {
        s.borrow()
            .open
            .as_ref()
            .and_then(|o| o.driveall.clone())
            .ok_or_else(|| "no driveall device info".into())
    })
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
/// Claim the next slot on a clock, then wait. Claim before awaiting so
/// waiters cannot share a deadline. Wait is the stricter of the two floors.
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
/// Wait out the last write's quiet without claiming the clock. A read in
/// that window stalls like another write: X86, keymap read 120 ms after a
/// profile switch.
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
    switches: SwitchAccess,
    revision: Option<u16>,
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
    let (product, vid, pid) = (
        device.product_name(),
        device.vendor_id(),
        device.product_id(),
    );
    let usage = vendor_usage(&device);
    let stack = device_stack(&device);
    let transport = Transport::new(device, stack);
    let (id, spec, driveall_info, revision) = if stack == Stack::Driveall {
        let info = transport
            .identify_driveall()
            .await
            .map_err(|e| connect_err("noHandshake", None, e.to_string()))?;
        let spec = registry::by_usb(info.vid, info.pid)
            .or_else(|| registry::by_usb(vid, pid))
            .unwrap_or_else(|| {
                let id = (u32::from(info.vid) << 16) | u32::from(info.pid);
                DeviceSpec {
                    id,
                    name: format!("unregistered_{id:08x}"),
                    display_name: if product.is_empty() {
                        format!("{:04X}:{:04X}", info.vid, info.pid)
                    } else {
                        product.clone()
                    },
                    company: String::new(),
                    vendor: String::new(),
                    vendor_id: info.vid,
                    product_id: info.pid,
                    internal_name: "driveall_unregistered".into(),
                    key_layout: "Unknown".into(),
                    light_layout: "Driveall19".into(),
                    side_light_layout: String::new(),
                    profiles: 1,
                    magnetic: false,
                    family: "driveall".into(),
                    screen: None,
                    travel: None,
                    switch_replaceable: false,
                    features: registry::DeviceFeatures {
                        knob: vec![],
                        debounce: false,
                        sleep24: false,
                        sleep_bt: false,
                        magnetic_switches: false,
                        screen: false,
                        side_light: false,
                    },
                    unregistered: true,
                    light: None,
                    led_flags_swapped: false,
                    led_flags_source: "",
                }
            });
        let id = spec.id;
        let revision = Some(info.version);
        (id, Some(spec), Some(info), revision)
    } else {
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
        let spec = match registry::by_id(id) {
            Some(spec) if spec.family == "unknown" => {
                match ops::derive_sweep(&transport, id, vid, pid, &product).await {
                    Some(derived) => Some(derive::settle_family(spec, &derived)),
                    None => Some(spec),
                }
            }
            Some(spec) => Some(spec),
            None => ops::derive_sweep(&transport, id, vid, pid, &product).await,
        };
        (id, spec, None, None)
    };
    match spec {
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
            let revision = if let Some(r) = revision {
                Some(r)
            } else {
                ops::read_revision(&transport, &spec).await
            };
            let read_only = !spec.writes_supported() || spec.unregistered;
            let info = ConnectedInfo {
                path: "webhid".into(),
                device_id: id,
                read_only,
                switches: switch_access(&spec, revision, read_only, false),
                revision,
                spec: spec.clone(),
                link: transport.link(),
                battery,
            };
            STATE.with(|s| {
                let mut s = s.borrow_mut();
                s.unregistered_ok = false;
                s.led_swap = None;
                s.owner = OwnerRecord::default();
                s.switch_trial = None;
                s.open = Some(Open {
                    transport: Rc::new(transport),
                    spec,
                    battery,
                    usage,
                    revision,
                    driveall: driveall_info,
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

/// The owner has read what was detected about a board the registry does
/// not know and allows writes to it for this session.
#[wasm_bindgen]
pub fn allow_unregistered() -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        match &s.open {
            Some(open) if open.spec.unregistered => {
                s.unregistered_ok = true;
                Ok(())
            }
            Some(_) => Err(JsValue::from(
                "this board is in the registry; nothing to allow",
            )),
            None => Err(JsValue::from("no device connected")),
        }
    })
}

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

/// JS scan loop combines this with `navigator.hid` presence.
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
            connected: s.open.as_ref().map(|o| {
                let read_only =
                    !o.spec.writes_supported() || (o.spec.unregistered && !s.unregistered_ok);
                ConnectedInfo {
                    path: "webhid".into(),
                    device_id: o.spec.id,
                    read_only,
                    switches: switch_access(&o.spec, o.revision, read_only, s.owner.switch_writes),
                    revision: o.revision,
                    spec: o.spec.clone(),
                    link: o.transport.link(),
                    battery: o.battery,
                }
            }),
            stalled: s.stalled,
        })
    })
}

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
    let (t, spec) = get_open(false)?;
    if spec.family == "driveall" {
        let raw = t
            .driveall_get(driveall::GET_LED_EFFECT, driveall::LED_LEN, 0)
            .await
            .map_err(fail)?;
        let p = driveall::led_from_wire(&raw).ok_or("bad LED effect reply")?;
        return to_js(&p);
    }
    let reply = t
        .roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    let p = LedParam::from_reply_for(&reply, led_wire(&spec)).ok_or("bad LEDPARAM reply")?;
    to_js(&p)
}

#[wasm_bindgen]
pub async fn set_led_param(param_json: String) -> Result<(), JsValue> {
    let param: LedParam = serde_json::from_str(&param_json).map_err(|e| e.to_string())?;
    gap(|s| &mut s.last_cmd, LIGHT_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    if spec.family == "driveall" {
        t.driveall_rmw(driveall::rmw_led(&param))
            .await
            .map_err(fail)?;
        return Ok(());
    }
    t.send(&param.to_packet_for(led_wire(&spec)))
        .await
        .map_err(fail)?;
    Ok(())
}

/// Apply what the owner established in the check; mirrors commands.rs.
/// Sends nothing.
#[wasm_bindgen]
pub fn apply_owner_record(record_json: String) -> Result<(), JsValue> {
    let record: OwnerRecord = serde_json::from_str(&record_json).map_err(|e| e.to_string())?;
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let open = s.open.as_mut().ok_or("no device connected")?;
        if open.spec.unregistered {
            open.spec.magnetic = record.magnetic;
            open.spec.features.magnetic_switches = record.magnetic;
            if let Some(side) = record.side_light {
                open.spec.features.side_light = side;
            }
            if let Some(n) = record.profiles {
                open.spec.profiles = n.clamp(1, 8);
            }
            if record.allowed {
                s.unregistered_ok = true;
            }
        }
        s.switch_trial = None;
        s.owner = record;
        Ok(())
    })
}

/// Open one slot's switch columns to the check's felt test, or close it;
/// mirrors commands.rs. Sends nothing.
#[wasm_bindgen]
pub fn set_switch_trial(slot: Option<u8>) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let open = s.open.as_ref().ok_or("no device connected")?;
        if slot.is_some() && !open.spec.hall_reads(open.revision) {
            return Err(JsValue::from(format!(
                "{} has no magnetic switches sharkfin can read",
                open.spec.label()
            )));
        }
        s.switch_trial = slot;
        Ok(())
    })
}

#[wasm_bindgen]
pub fn set_led_flags_swapped(swapped: bool) -> Result<(), JsValue> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.open.is_none() {
            return Err(JsValue::from("no device connected"));
        }
        s.led_swap = Some(swapped);
        Ok(())
    })
}

/// How the open board reads a LEDPARAM packet: what its firmware was read to
/// do, or what its owner says instead. Mirrors `led_wire` in commands.rs.
fn led_wire(spec: &DeviceSpec) -> protocol::LedWire {
    let mut wire = spec.led_wire();
    if let Some(swapped) = STATE.with(|s| s.borrow().led_swap) {
        wire.swapped = swapped;
    }
    wire
}

#[wasm_bindgen]
pub async fn get_profile() -> Result<u8, JsValue> {
    if is_driveall() {
        return Ok(driveall_info().map(|i| i.current_profile).unwrap_or(0));
    }
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let reply = t
        .roundtrip(fc.get_profile, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    Ok(protocol::yc500_profile_from_slot(
        spec.family == "yc500" && spec.magnetic,
        reply[1],
    ))
}

/// The display's own firmware version, or `None` on a board without one.
/// `0xAD` means the same thing in both families, so it needs no family
/// lookup. A board with no display echoes the previous reply instead.
#[wasm_bindgen]
pub async fn get_screen_version() -> Result<Option<u16>, JsValue> {
    if is_driveall() {
        return Ok(None);
    }
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
    if is_driveall() {
        return Err("this board has no profile-switch command".into());
    }
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let profile = protocol::yc500_profile_slot(spec.family == "yc500" && spec.magnetic, profile, 0);
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

#[wasm_bindgen]
pub async fn read_keymap(profile: u8) -> Result<Vec<u8>, JsValue> {
    read_keymap_layer(profile, 0).await
}

/// One of the four keymap sub-layers of a profile; mirrors commands.rs.
#[wasm_bindgen]
pub async fn read_keymap_layer(profile: u8, sublayer: u8) -> Result<Vec<u8>, JsValue> {
    if is_driveall() {
        if sublayer != 0 {
            return Err("this board has no keymap sub-layers".into());
        }
        let _busy = acquire().await;
        read_quiet().await;
        let (t, _) = get_open(false)?;
        let raw = t
            .driveall_get(driveall::GET_KEY, driveall::KEYMAP_LEN, 0)
            .await
            .map_err(fail)?;
        return Ok(driveall::keymap_from_driveall(&raw));
    }
    if sublayer > 3 {
        return Err("sub-layer out of range (0..3)".into());
    }
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let wire =
        protocol::yc500_profile_slot(spec.family == "yc500" && spec.magnetic, profile, sublayer);
    read_matrix(&*t, fc, wire, sublayer, false)
        .await
        .map_err(fail)
        .map_err(JsValue::from)
}

#[wasm_bindgen]
pub async fn read_fn_keymap(layer: u8) -> Result<Vec<u8>, JsValue> {
    if is_driveall() {
        let _busy = acquire().await;
        read_quiet().await;
        let (t, _) = get_open(false)?;
        let raw = t
            .driveall_get(driveall::GET_FN_KEY, driveall::KEYMAP_LEN, 0)
            .await
            .map_err(fail)?;
        return Ok(driveall::keymap_from_driveall(&raw));
    }
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    read_matrix(&*t, fc, layer, 0, true)
        .await
        .map_err(fail)
        .map_err(JsValue::from)
}

#[wasm_bindgen]
pub async fn set_key(profile: u8, slot: u8, value: Vec<u8>, fn_layer: bool) -> Result<(), JsValue> {
    set_key_layer(profile, 0, slot, value, fn_layer).await
}

/// One slot in one keymap sub-layer; mirrors commands.rs.
#[wasm_bindgen]
pub async fn set_key_layer(
    profile: u8,
    sublayer: u8,
    slot: u8,
    value: Vec<u8>,
    fn_layer: bool,
) -> Result<(), JsValue> {
    let value: [u8; 4] = value
        .as_slice()
        .try_into()
        .map_err(|_| "key value must be 4 bytes")?;
    if is_driveall() {
        if sublayer != 0 {
            return Err("this board has no keymap sub-layers".into());
        }
        let plan = driveall::rmw_key(slot, value, fn_layer)?;
        gap(|s| &mut s.last_cmd, KEY_GAP_MS).await;
        let _busy = acquire().await;
        let (t, _) = get_open(true)?;
        t.driveall_rmw(plan).await.map_err(fail)?;
        return Ok(());
    }
    if sublayer > 3 || (sublayer > 0 && fn_layer) {
        return Err("sub-layer out of range".into());
    }
    if sublayer > 0
        && !matches!(
            open_switches()?.1,
            SwitchAccess::Write | SwitchAccess::Global
        )
    {
        return Err("this board has no keymap sub-layers sharkfin can write".into());
    }
    gap(|s| &mut s.last_cmd, KEY_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let wire = if fn_layer {
        profile
    } else {
        protocol::yc500_profile_slot(spec.family == "yc500" && spec.magnetic, profile, sublayer)
    };
    let pkt = key_write_packet(fc, wire, sublayer, slot, value, fn_layer).map_err(fail)?;
    t.send(&pkt).await.map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn get_settings() -> Result<JsValue, JsValue> {
    if is_driveall() {
        let revision = driveall_info()
            .map(|i| i.version_string())
            .unwrap_or_else(|_| "unknown".into());
        return to_js(&DeviceSettings {
            debounce: 0,
            sleep: SleepTimes::default(),
            options: None,
            revision,
            auto_os: false,
            side_light: None,
        });
    }
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let fc = need(family_cmds(&spec.family)).map_err(fail)?;
    let s = ops::read_settings(&*t, fc, spec.features.side_light, led_wire(&spec).swapped)
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
    t.send(&param.to_packet_on(led_wire(&spec).swapped))
        .await
        .map_err(fail)?;
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

/// The display's clock, from the host's local time; see commands.rs.
#[wasm_bindgen]
pub async fn set_clock(
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
) -> Result<(), JsValue> {
    require_cable()?;
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    // Shared across the ROYUAN families, so no opcode is taken from the
    // table, but resolving it still refuses a family that does not have the
    // packet at all. The byte means something else on driveall.
    need(family_cmds(&spec.family)).map_err(fail)?;
    let pkt = protocol::clock_packet(year, month, day, hour, minute, second);
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
    if spec.family == "driveall" {
        t.driveall_set(
            driveall::SET_CUSTOM_LED,
            0,
            &driveall::custom_led_to_wire(&colors),
            true,
        )
        .await
        .map_err(fail)?;
        return Ok(());
    }
    // Decide about the mode switch before the upload: asking afterwards
    // means talking to a board that is still writing flash.
    let needs_mode = activate
        && match t.roundtrip(cmd::GET_LEDPARAM, &[], Checksum::Bit7).await {
            Ok(r) => LedParam::from_reply_for(&r, led_wire(&spec))
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

#[wasm_bindgen]
pub async fn read_macro(slot: u8) -> Result<JsValue, JsValue> {
    check_macro_slot(slot)?;
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    if spec.family == "driveall" {
        let space = driveall_info().map_err(JsValue::from)?.macro_space;
        return to_js(
            &ops::driveall_read_macro(&*t, slot, space)
                .await
                .map_err(fail)?,
        );
    }
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
    if is_driveall() {
        flash_cooldown().await;
        let _busy = acquire().await;
        let space = driveall_info().map_err(JsValue::from)?.macro_space;
        let (t, _) = get_open(true)?;
        return ops::driveall_write_macro(&*t, slot, &data, space)
            .await
            .map_err(fail)
            .map_err(JsValue::from);
    }
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
// Magnetic switches, mirroring commands.rs one for one.

fn hall_format(spec: &DeviceSpec) -> Result<hall::Format, JsValue> {
    hall::Format::for_family(&spec.family)
        .ok_or_else(|| JsValue::from("no switch column format for this family"))
}

#[wasm_bindgen]
pub async fn get_switches() -> Result<JsValue, JsValue> {
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    if spec.family == "driveall" {
        let (revision, _) = open_switches()?;
        if !spec.hall_reads(revision) {
            return Err(JsValue::from("this board has no switch settings"));
        }
        let info = driveall_info().map_err(JsValue::from)?;
        let raw = t
            .driveall_get(driveall::GET_MAGNETIC_RT, driveall::RT_LEN, 0)
            .await
            .map_err(fail)?;
        return to_js(&driveall::rt_from_wire(&raw, &info));
    }
    let (revision, _) = open_switches()?;
    if !spec.hall_reads(revision) {
        return Err(JsValue::from(format!(
            "{} has no magnetic switches sharkfin can read",
            spec.label()
        )));
    }
    let f = hall_format(&spec)?;
    async fn column(t: &Transport, f: hall::Format, subop: u8) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::with_capacity(256);
        for page in 0..f.get_pages(subop) {
            out.extend_from_slice(
                &t.read_raw_page(hall::GET, &f.get_payload(subop, page), Checksum::Bit7)
                    .await
                    .map_err(fail)?,
            );
        }
        Ok(out)
    }
    let mut columns = Vec::new();
    for &subop in hall::READ_COLUMNS.iter() {
        columns.push((subop, f.decode(subop, &column(&t, f, subop).await?)));
    }
    let mut dks_all = Vec::with_capacity(4 * f.slots());
    for block in 0..4u8 {
        let mut raw = Vec::with_capacity(128);
        for page in [2 * block, 2 * block + 1] {
            raw.extend_from_slice(
                &t.read_raw_page(
                    hall::GET,
                    &f.get_payload(hall::DKS_ACTIONS_ALL, page),
                    Checksum::Bit7,
                )
                .await
                .map_err(fail)?,
            );
        }
        dks_all.extend_from_slice(&raw[..f.slots()]);
    }
    to_js(&hall::assemble(f, &columns, &dks_all))
}

/// `slots`: the keys a write addresses, so the check's trial can open just
/// those; `None` is a write to every key, which no trial covers.
fn require_hall_writes(spec: &DeviceSpec, slots: Option<&[u8]>) -> Result<hall::Format, JsValue> {
    let (revision, _) = open_switches()?;
    let (owner, trial) = STATE.with(|s| {
        let s = s.borrow();
        (s.owner.switch_writes, s.switch_trial)
    });
    if session::hall_write_allowed(spec, revision, owner, trial, slots) {
        hall_format(spec)
    } else {
        Err(JsValue::from(session::hall_write_refusal(spec)))
    }
}

#[wasm_bindgen]
pub async fn set_switch_key(key_json: String) -> Result<(), JsValue> {
    set_switch_keys(format!("[{key_json}]")).await
}

/// One or two keys in one visit, a flash settle between them.
#[wasm_bindgen]
pub async fn set_switch_keys(keys_json: String) -> Result<(), JsValue> {
    let keys: Vec<hall::KeySwitch> = serde_json::from_str(&keys_json).map_err(|e| e.to_string())?;
    if keys.is_empty() || keys.len() > 2 {
        return Err("one or two keys at a time".into());
    }
    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    if spec.family == "driveall" {
        let slots: Vec<u8> = keys.iter().map(|k| k.slot).collect();
        let _ = require_hall_writes(&spec, Some(&slots))?;
        let info = driveall_info().map_err(JsValue::from)?;
        t.driveall_rmw(driveall::rmw_switches(keys, info))
            .await
            .map_err(fail)?;
        return Ok(());
    }
    let slots: Vec<u8> = keys.iter().map(|k| k.slot).collect();
    let f = require_hall_writes(&spec, Some(&slots))?;
    if keys
        .iter()
        .any(|k| k.kind == hall::KIND_SNAP && usize::from(k.snap_partner) >= f.slots())
    {
        return Err("snap partner out of range".into());
    }
    for key in &keys {
        let cols = hall::columns_for(key.kind);
        let n = cols.len();
        for (i, &subop) in cols.iter().enumerate() {
            let last = i + 1 == n;
            let pkt = if subop == hall::DKS_ACTIONS {
                f.set_dks_actions(key.slot, last, key.dks_actions)
            } else {
                f.set_one(subop, key.slot, last, key.wire(f, subop))
            }
            .ok_or("slot out of range")?;
            t.send(&pkt).await.map_err(fail)?;
        }
        sleep_ms(FLASH_SETTLE_MS).await;
    }
    Ok(())
}

#[wasm_bindgen]
pub async fn set_switches_all(key_json: String, modes: Vec<u8>) -> Result<(), JsValue> {
    let key: hall::KeySwitch = serde_json::from_str(&key_json).map_err(|e| e.to_string())?;
    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, spec) = get_open(true)?;
    if spec.family == "driveall" {
        let _ = require_hall_writes(&spec, None)?;
        let info = driveall_info().map_err(JsValue::from)?;
        t.driveall_rmw(driveall::rmw_switches_all(&key, info))
            .await
            .map_err(fail)?;
        return Ok(());
    }
    let f = require_hall_writes(&spec, None)?;
    let n = hall::WRITE_COLUMNS.len();
    for (i, &subop) in hall::WRITE_COLUMNS.iter().enumerate() {
        let values: Vec<u16> = (0..f.slots())
            .map(|s| {
                if subop == hall::MODE {
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
            t.send(&pkt).await.map_err(fail)?;
            sleep_ms(FLASH_PAGE_GAP_MS).await;
        }
    }
    sleep_ms(FLASH_SETTLE_MS).await;
    Ok(())
}

#[wasm_bindgen]
pub async fn get_switch_preset() -> Result<Option<u8>, JsValue> {
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    if spec.family != "yc500" || !spec.magnetic {
        return Ok(None);
    }
    let reply = t
        .roundtrip(hall::GET_PRESET, &[], Checksum::Bit7)
        .await
        .map_err(fail)?;
    Ok((reply[1] <= hall::PRESET_CUSTOM).then_some(reply[1]))
}

#[wasm_bindgen]
pub async fn set_switch_preset(preset: u8) -> Result<(), JsValue> {
    let (revision, access) = open_switches()?;
    let (t, spec) = get_open(true)?;
    // The check's trial puts the preset back after its one key.
    let trial = STATE.with(|s| s.borrow().switch_trial.is_some()) && spec.hall_reads(revision);
    if spec.family != "yc500"
        || !(trial || matches!(access, SwitchAccess::Write | SwitchAccess::Global))
    {
        return Err(format!("{} has no switch presets", spec.label()).into());
    }
    if preset > hall::PRESET_CUSTOM {
        return Err("preset out of range (0..3)".into());
    }
    gap(|s| &mut s.last_cmd, SETTING_GAP_MS).await;
    let _busy = acquire().await;
    t.send(&protocol::packet(
        hall::SET_PRESET,
        &[preset],
        Checksum::Bit7,
    ))
    .await
    .map_err(fail)?;
    Ok(())
}

#[wasm_bindgen]
pub async fn set_switches_global(key_json: String, all: bool) -> Result<(), JsValue> {
    let key: hall::KeySwitch = serde_json::from_str(&key_json).map_err(|e| e.to_string())?;
    let (_, access) = open_switches()?;
    if access != SwitchAccess::Global {
        return Err("this board takes its switch settings per key, not as one record".into());
    }
    if usize::from(key.slot) >= hall::Format::Yc500.slots() {
        return Err("slot out of range".into());
    }
    flash_cooldown().await;
    let _busy = acquire().await;
    let (t, _) = get_open(true)?;
    t.send(&hall::global_packet(&key, all))
        .await
        .map_err(fail)?;
    sleep_ms(FLASH_SETTLE_MS).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Config files. Identical JSON shape to the desktop's SavedConfig, so files
// move between the two builds.

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
    let scaled = spec.family == "yc500" && spec.magnetic;
    for p in 0..n {
        let wire = protocol::yc500_profile_slot(scaled, p, 0);
        profiles.push(read_matrix(&*t, fc, wire, 0, false).await.map_err(fail)?);
        fn_layers.push(read_matrix(&*t, fc, p, 0, true).await.map_err(fail)?);
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
            .and_then(|r| SledParam::from_reply_on(&r, led_wire(&spec).swapped)),
        _ => None,
    };
    let cfg = SavedConfig {
        version: 1,
        device_id: spec.id,
        family: spec.family.clone(),
        board: spec.label(),
        profiles,
        fn_layers,
        led: LedParam::from_reply_for(&led, led_wire(&spec)).ok_or("bad LEDPARAM reply")?,
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
            let wire = if fn_layer {
                p as u8
            } else {
                protocol::yc500_profile_slot(spec.family == "yc500" && spec.magnetic, p as u8, 0)
            };
            let current = read_matrix(&*t, fc, wire, 0, fn_layer)
                .await
                .map_err(fail)?;
            for slot in 0..128usize {
                let want: [u8; 4] = target[slot * 4..slot * 4 + 4].try_into().unwrap();
                if current[slot * 4..slot * 4 + 4] != want {
                    let pkt =
                        key_write_packet(fc, wire, 0, slot as u8, want, fn_layer).map_err(fail)?;
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
        t.send(&sled.to_packet_on(led_wire(&spec).swapped))
            .await
            .map_err(fail)?;
    }
    t.send(&cfg.led.to_packet_for(led_wire(&spec)))
        .await
        .map_err(fail)?;
    Ok(format!(
        "restored {keys_written} keys, settings and lighting from {}",
        cfg.board
    )
    .into())
}

// ---------------------------------------------------------------------------
// Contribution bundle: same probes and format as the desktop.

#[wasm_bindgen]
pub async fn contribution_bundle() -> Result<JsValue, JsValue> {
    use std::fmt::Write;
    let _busy = acquire().await;
    read_quiet().await;
    let (t, spec) = get_open(false)?;
    let usage = STATE.with(|s| s.borrow().open.as_ref().map_or(0, |o| o.usage));
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "sharkfin {} data bundle (web)", registry::build_id());
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
        let owner = STATE.with(|s| s.borrow().led_swap);
        let _ = writeln!(out, "flags  : {}", registry::led_flags_note(&spec, owner));
    }
    ops::probe_sweep(&*t, &mut out).await.map_err(fail)?;
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
    let usage = vendor_usage(&device);
    let stack = device_stack(&device);
    let t = Transport::new(device, stack);
    let mut out = String::new();
    let _ = writeln!(out, "```");
    let _ = writeln!(out, "sharkfin {} data bundle (web)", registry::build_id());
    let product = if product.is_empty() {
        "unnamed board".into()
    } else {
        product
    };
    let _ = writeln!(out, "board  : {product} (not in the registry)");
    let _ = writeln!(
        out,
        "usb    : {vid:04x}:{pid:04x}  collection usage {usage}"
    );
    match t.identify().await {
        Ok(id) => {
            let _ = writeln!(out, "identify: device id {id}");
        }
        Err(e) if e.is_stall() => return Err(fail(e).into()),
        Err(_) => {
            let _ = writeln!(out, "identify: no answer");
        }
    }
    ops::probe_sweep(&t, &mut out).await.map_err(fail)?;
    let _ = writeln!(out, "```");
    Ok(out.into())
}

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
