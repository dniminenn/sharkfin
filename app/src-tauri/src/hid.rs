// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! hidapi transport to the vendor collection, by cable or through the 2.4 GHz
//! receiver's relay.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hidapi::{HidApi, HidDevice};
use parking_lot::Mutex;

use crate::protocol::{self, receiver, Checksum, REPORT_LEN, USAGE, USAGE_PAGE};

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("hidapi: {0}")]
    Api(#[from] hidapi::HidError),
    #[error("no ROYUAN device found (is the keyboard connected by USB cable?)")]
    NotFound,
    #[error("device did not answer the identify handshake")]
    NoHandshake,
    #[error("the receiver is paired, but the keyboard is asleep or switched off")]
    KeyboardOffline,
    #[error("the receiver did not accept a packet to relay")]
    ReceiverBusy,
    #[error("short feature report ({0} bytes)")]
    ShortRead(usize),
    #[error("{0}")]
    Protocol(String),
}

impl HidError {
    /// The firmware has stalled its control endpoint. Nothing gets through
    /// until the device is re-enumerated or at least reopened.
    pub fn is_stall(&self) -> bool {
        match self {
            HidError::Api(e) => {
                let m = e.to_string();
                m.contains("Protocol error") || m.contains("ioctl")
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct DiscoveredDevice {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product: String,
    pub manufacturer: String,
}

pub fn discover(api: &HidApi) -> Vec<DiscoveredDevice> {
    api.device_list()
        .filter(|d| {
            d.usage_page() == USAGE_PAGE
                && d.usage() == USAGE
                && crate::registry::vendor_ids().contains(&d.vendor_id())
        })
        .map(|d| DiscoveredDevice {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product: d.product_string().unwrap_or_default().to_string(),
            manufacturer: d.manufacturer_string().unwrap_or_default().to_string(),
        })
        .collect()
}

/// Minimum gap between feature-report writes. The firmware stalls its control
/// endpoint if written to much faster than this -- once stalled it rejects
/// everything until the device is re-enumerated, so this is a hard floor
/// rather than a nicety. The vendor's own class waits 500 ms after batch
/// operations; 12 ms per report is the sustainable rate measured on an X86.
const MIN_WRITE_GAP: Duration = Duration::from_millis(12);

/// Receiver bookkeeping. The vendor allows 500 ms for the receiver to accept
/// a packet and 1 s for a reply to come back over the air, polling status
/// every 100 ms and resting 10 ms between its own exchanges with the
/// receiver. A reply is ready about 100 ms after the send on an X86, so the
/// deadlines are kept and the poll runs as fast as the write floor allows:
/// a 100 ms tick would round every exchange up to 200.
const RECEIVER_SEND_DEADLINE: Duration = Duration::from_millis(500);
const RECEIVER_READ_DEADLINE: Duration = Duration::from_millis(1000);
const RECEIVER_TICK: Duration = Duration::from_millis(5);
const RECEIVER_REST: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Link {
    Usb,
    Receiver,
}

pub struct Transport {
    dev: HidDevice,
    pub settle: Duration,
    last_write: Mutex<Option<Instant>>,
    /// Set once identify has succeeded through the receiver's relay. Every
    /// send and read then goes through the select/release handshake.
    relay: AtomicBool,
    /// The receiver keeps its relay target until told otherwise; the vendor
    /// selects once and never again unless the target changes.
    selected: AtomicBool,
}

/// A rolling record of what actually reached the wire, so a stall can be
/// read back instead of guessed at. Six stalls on one X86 produced no
/// evidence beyond "it stopped answering"; this is that evidence.
///
/// Opcode and direction only: payloads can carry a keymap, and this ends up
/// in a log a user pastes into an issue.
const TRACE_LEN: usize = 48;

static TRACE: std::sync::Mutex<std::collections::VecDeque<(std::time::Instant, char, u8)>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());

fn trace_wire(dir: char, opcode: u8) {
    if let Ok(mut t) = TRACE.lock() {
        if t.len() == TRACE_LEN {
            t.pop_front();
        }
        t.push_back((Instant::now(), dir, opcode));
    }
}

/// The recent wire history, oldest first, as `+12ms W:0x07` entries.
pub fn wire_trace() -> String {
    let Ok(t) = TRACE.lock() else {
        return String::new();
    };
    let mut out = String::new();
    let mut prev: Option<Instant> = None;
    for (at, dir, op) in t.iter() {
        let delta = prev.map(|p| at.duration_since(p).as_millis()).unwrap_or(0);
        out.push_str(&format!("+{delta}ms {dir}:0x{op:02X} "));
        prev = Some(*at);
    }
    out
}

impl Transport {
    pub fn open(api: &HidApi, path: &str) -> Result<Self, HidError> {
        let cpath = std::ffi::CString::new(path).expect("hid path with NUL");
        let dev = api.open_path(&cpath)?;
        Ok(Self {
            dev,
            settle: Duration::from_millis(10),
            last_write: Mutex::new(None),
            relay: AtomicBool::new(false),
            selected: AtomicBool::new(false),
        })
    }

    pub fn link(&self) -> Link {
        if self.relay.load(Ordering::Relaxed) {
            Link::Receiver
        } else {
            Link::Usb
        }
    }

    fn pace(&self) {
        let mut last = self.last_write.lock();
        if let Some(prev) = *last {
            let since = prev.elapsed();
            if since < MIN_WRITE_GAP {
                sleep(MIN_WRITE_GAP - since);
            }
        }
        *last = Some(Instant::now());
    }

    pub fn send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidError> {
        if self.relay.load(Ordering::Relaxed) {
            self.relay_send(buf)
        } else {
            self.raw_send(buf)
        }
    }

    pub fn read(&self) -> Result<[u8; REPORT_LEN], HidError> {
        if self.relay.load(Ordering::Relaxed) {
            self.relay_read()
        } else {
            self.raw_read()
        }
    }

    /// One feature report to whatever is on the other end of the node: the
    /// keyboard by cable, or the receiver itself.
    fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidError> {
        trace_wire('W', buf[0]);
        self.pace();
        let mut wire = [0u8; REPORT_LEN + 1];
        wire[1..].copy_from_slice(buf);
        self.dev.send_feature_report(&wire)?;
        Ok(())
    }

    fn raw_read(&self) -> Result<[u8; REPORT_LEN], HidError> {
        trace_wire('R', 0);
        let mut wire = [0u8; REPORT_LEN + 1];
        let n = self.dev.get_feature_report(&mut wire)?;
        if n < 8 {
            return Err(HidError::ShortRead(n));
        }
        let mut out = [0u8; REPORT_LEN];
        // tolerate platforms that keep the report-ID byte
        if wire[0] == 0 && n == REPORT_LEN + 1 {
            out.copy_from_slice(&wire[1..]);
        } else {
            out.copy_from_slice(&wire[..REPORT_LEN]);
        }
        Ok(out)
    }

    /// The receiver's own status. Answered by the receiver whether or not a
    /// keyboard is paired; `None` when the node is a keyboard on a cable.
    pub fn receiver_status(&self) -> Result<Option<receiver::Status>, HidError> {
        self.raw_send(&receiver::status_packet())?;
        sleep(RECEIVER_REST);
        Ok(receiver::parse_status(&self.raw_read()?))
    }

    fn relay_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), HidError> {
        let deadline = Instant::now() + RECEIVER_SEND_DEADLINE;
        let mut ready = false;
        loop {
            match self.receiver_status()? {
                Some(s) if !s.keyboard_online => return Err(HidError::KeyboardOffline),
                Some(s) if s.can_send => {
                    ready = true;
                    break;
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                break;
            }
            sleep(RECEIVER_TICK);
        }
        if !ready {
            self.selected.store(false, Ordering::Relaxed);
            return Err(HidError::ReceiverBusy);
        }
        if !self.selected.load(Ordering::Relaxed) {
            self.raw_send(&receiver::select_keyboard_packet())?;
            sleep(RECEIVER_REST);
            self.selected.store(true, Ordering::Relaxed);
        }
        self.raw_send(buf)
    }

    fn relay_read(&self) -> Result<[u8; REPORT_LEN], HidError> {
        let deadline = Instant::now() + RECEIVER_READ_DEADLINE;
        let mut ready = false;
        loop {
            if matches!(self.receiver_status()?, Some(s) if s.reply_ready) {
                ready = true;
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            sleep(RECEIVER_TICK);
        }
        if !ready {
            return Err(HidError::NoHandshake);
        }
        self.raw_send(&receiver::release_packet())?;
        sleep(RECEIVER_REST);
        self.raw_read()
    }

    pub fn roundtrip(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], HidError> {
        let pkt = protocol::packet(opcode, payload, checksum);
        self.send(&pkt)?;
        let expected = opcode;
        for attempt in 0..5 {
            sleep(self.settle * (attempt + 1));
            let reply = self.read()?;
            if reply[0] == expected {
                return Ok(reply);
            }
        }
        Err(HidError::NoHandshake)
    }

    /// Round-trip a packet the caller built. The screen announce sets fields
    /// past the checksum byte, so it cannot be expressed as an opcode plus a
    /// payload the way `roundtrip` wants.
    pub fn roundtrip_packet(&self, pkt: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        self.send(pkt)?;
        for attempt in 0..5 {
            sleep(self.settle * (attempt + 1));
            let reply = self.read()?;
            if reply[0] == pkt[0] {
                return Ok(reply);
            }
        }
        Err(HidError::NoHandshake)
    }

    /// For bulk reads whose replies are raw pages (no opcode echo).
    pub fn read_raw_page(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], HidError> {
        let pkt = protocol::packet(opcode, payload, checksum);
        self.send(&pkt)?;
        sleep(self.settle);
        self.read()
    }

    fn try_identify(&self) -> Option<u32> {
        for _ in 0..3 {
            if let Ok(reply) = self.roundtrip(protocol::cmd::GET_USB_VERSION, &[], Checksum::Bit7) {
                if let Some(id) = protocol::parse_device_id(&reply) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// 0x8F identify; returns the registry device ID. A node that does not
    /// answer by cable is asked whether it is a receiver, and identify is
    /// repeated through the relay when it is one with a keyboard awake.
    pub fn identify(&self) -> Result<u32, HidError> {
        if self.relay.load(Ordering::Relaxed) {
            return self.try_identify().ok_or(HidError::NoHandshake);
        }
        if let Some(id) = self.try_identify() {
            return Ok(id);
        }
        let Some(status) = self.receiver_status()? else {
            return Err(HidError::NoHandshake);
        };
        if !status.has_keyboard || !status.keyboard_online {
            return Err(HidError::KeyboardOffline);
        }
        self.relay.store(true, Ordering::Relaxed);
        self.selected.store(false, Ordering::Relaxed);
        match self.try_identify() {
            Some(id) => Ok(id),
            None => {
                self.relay.store(false, Ordering::Relaxed);
                Err(HidError::NoHandshake)
            }
        }
    }
}
