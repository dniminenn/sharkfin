// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! hidapi transport to the vendor collection, cable or 2.4 GHz relay.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hidapi::{BusType, HidApi, HidDevice};
use parking_lot::Mutex;

use crate::protocol::{REPORT_LEN, USAGES, USAGE_PAGE};
pub use crate::wire::LinkKind as Link;
use crate::wire::{block_on, Wire, WireError};

/// The shared error. hid.rs keeps the old name so the desktop
/// backend reads the same as before.
pub use crate::wire::WireError as HidError;

#[derive(Clone, Debug, serde::Serialize)]
pub struct DiscoveredDevice {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product: String,
    pub manufacturer: String,
    pub usage: u16,
}

pub fn discover(api: &HidApi) -> Vec<DiscoveredDevice> {
    api.device_list()
        .filter(|d| {
            (is_royuan_collection(d.usage_page(), d.usage())
                && crate::registry::vendor_ids().contains(&d.vendor_id()))
                || is_keyboard_collection_board(
                    d.vendor_id(),
                    d.product_id(),
                    d.usage_page(),
                    d.usage(),
                    d.interface_number(),
                    d.bus_type(),
                )
        })
        .map(|d| DiscoveredDevice {
            path: d.path().to_string_lossy().into_owned(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            product: d.product_string().unwrap_or_default().to_string(),
            manufacturer: d.manufacturer_string().unwrap_or_default().to_string(),
            usage: d.usage(),
        })
        .collect()
}

fn is_royuan_collection(usage_page: u16, usage: u16) -> bool {
    usage_page == USAGE_PAGE && USAGES.contains(&usage)
}

/// Boards that answer on their keyboard collection instead of a vendor
/// page. The Akko 5075B Plus-S in Mac mode enumerates as Apple 05ac:024f
/// with no vendor collection; the vendor's driver carries the same
/// exception, and issue #58 is the round trip. hidapi opens such a
/// collection with zero access and feature reports still go through. A real
/// Apple Aluminium Keyboard shares the id and will appear as a stranger.
/// Karabiner uses the same id on a virtual bus; only USB devices qualify.
/// The 3098B uses interface 0 at 3151:4002; interface 1 has keyboard and
/// vendor input collections but no settings report.
fn is_keyboard_collection_board(
    vendor_id: u16,
    product_id: u16,
    usage_page: u16,
    usage: u16,
    interface: i32,
    bus_type: BusType,
) -> bool {
    matches!(bus_type, BusType::Usb)
        && ((vendor_id, product_id, usage_page, usage) == (0x05AC, 0x024F, 0x01, 0x06)
            || (vendor_id, product_id, usage_page, usage, interface)
                == (0x3151, 0x4002, 0x01, 0x06, 0))
}

/// Report ID 0 must carry 64 feature bytes. HID global Push/Pop preserves
/// the report shape; input and output items do not contribute to its size.
fn has_settings_report(mut descriptor: &[u8]) -> bool {
    let (mut size, mut count, mut id) = (0u32, 0u32, 0u32);
    let mut stack = Vec::new();
    let mut bits = 0u64;
    while let Some((&tag, rest)) = descriptor.split_first() {
        if tag == 0xfe {
            let Some((&len, rest)) = rest.split_first() else {
                return false;
            };
            let Some(rest) = rest.get(1 + usize::from(len)..) else {
                return false;
            };
            descriptor = rest;
            continue;
        }
        let len = [0, 1, 2, 4][usize::from(tag & 3)];
        let Some(data) = rest.get(..len) else {
            return false;
        };
        let mut value = [0u8; 4];
        value[..len].copy_from_slice(data);
        let value = u32::from_le_bytes(value);
        descriptor = &rest[len..];
        match tag & 0xfc {
            0x74 => size = value,
            0x94 => count = value,
            0x84 => id = value,
            0xa4 => stack.push((size, count, id)),
            0xb4 => {
                let Some(saved) = stack.pop() else {
                    return false;
                };
                (size, count, id) = saved;
            }
            0xb0 if id == 0 => {
                let Some(total) = bits.checked_add(u64::from(size) * u64::from(count)) else {
                    return false;
                };
                bits = total;
            }
            _ => {}
        }
    }
    bits == (REPORT_LEN * 8) as u64 && stack.is_empty()
}

/// Minimum gap between feature-report writes. Faster stalls the endpoint
/// until re-enum. 12 ms per report is the sustainable rate on an X86.
const MIN_WRITE_GAP: Duration = Duration::from_millis(crate::wire::MIN_WRITE_GAP);

pub struct Transport {
    dev: HidDevice,
    last_write: Mutex<Option<Instant>>,
    /// Set once identify has succeeded through the receiver's relay. Every
    /// send and read then goes through the select/release handshake.
    relay: AtomicBool,
    /// The receiver keeps its relay target until told otherwise; the vendor
    /// selects once and never again unless the target changes.
    selected: AtomicBool,
    /// Base for the millisecond clock the receiver deadlines run on.
    started: Instant,
}

/// Rolling record of what reached the wire, opcode and direction only.
/// Payloads can carry a keymap; this ends up in a log an owner pastes.
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
        // Keyboard-collection settings must not seize ordinary key input.
        #[cfg(target_os = "macos")]
        api.set_open_exclusive(false);
        let dev = api.open_path(&cpath).map_err(api_err)?;
        // This USB id is shared by boards with different interface layouts.
        // Keep their vendor interfaces, but reject the 3098B's input-only one
        // before sending any commands to it.
        if api.device_list().any(|d| {
            d.path() == cpath.as_c_str() && (d.vendor_id(), d.product_id()) == (0x3151, 0x4002)
        }) {
            let mut descriptor = [0u8; 4096];
            let n = dev
                .get_report_descriptor(&mut descriptor)
                .map_err(api_err)?;
            if !has_settings_report(&descriptor[..n]) {
                return Err(WireError::Transport(
                    "interface has no 64-byte settings report".into(),
                ));
            }
        }
        Ok(Self {
            dev,
            last_write: Mutex::new(None),
            relay: AtomicBool::new(false),
            selected: AtomicBool::new(false),
            started: Instant::now(),
        })
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

    /// One feature report to whatever is on the other end of the node: the
    /// keyboard by cable, or the receiver itself.
    fn raw_send_blocking(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        trace_wire('W', buf[0]);
        self.pace();
        let mut wire = [0u8; REPORT_LEN + 1];
        wire[1..].copy_from_slice(buf);
        self.dev.send_feature_report(&wire).map_err(api_err)?;
        Ok(())
    }

    fn raw_read_blocking(&self) -> Result<[u8; REPORT_LEN], WireError> {
        trace_wire('R', 0);
        let mut wire = [0u8; REPORT_LEN + 1];
        let n = self.dev.get_feature_report(&mut wire).map_err(api_err)?;
        if n < 8 {
            return Err(WireError::ShortRead(n));
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
}

/// Sort a hidapi failure into the two the session cares about. Only a
/// stalled control endpoint is worth dropping the handle and asking for a
/// replug; on hidraw that is the ioctl reporting the stall. Anything else
/// is passing, and reporting it as a stall would leave a working board
/// unusable until it is unplugged.
fn api_err(e: hidapi::HidError) -> WireError {
    let m = e.to_string();
    if is_stall_message(&m) {
        WireError::Stall(m)
    } else {
        WireError::Transport(m)
    }
}

/// hidapi has no error code for a stall, only the message the platform
/// gave it. On hidraw both halves of an endpoint stall come back through
/// the failing ioctl.
fn is_stall_message(m: &str) -> bool {
    m.contains("Protocol error") || m.contains("ioctl")
}

impl crate::wire::Node for Transport {
    fn relay(&self) -> bool {
        self.relay.load(Ordering::Relaxed)
    }

    fn set_relay(&self, on: bool) {
        self.relay.store(on, Ordering::Relaxed);
    }

    fn selected(&self) -> bool {
        self.selected.load(Ordering::Relaxed)
    }

    fn set_selected(&self, on: bool) {
        self.selected.store(on, Ordering::Relaxed);
    }

    fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    async fn sleep_ms(&self, ms: u64) {
        sleep(Duration::from_millis(ms));
    }

    async fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        self.raw_send_blocking(buf)
    }

    async fn raw_read(&self) -> Result<[u8; REPORT_LEN], WireError> {
        self.raw_read_blocking()
    }
}

/// The blocking face of [`Wire`]. The conversation itself lives in
/// `wire.rs` and is shared with the browser build; these only park on it.
impl Transport {
    pub fn send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        block_on(Wire::send(self, buf))
    }

    pub fn read(&self) -> Result<[u8; REPORT_LEN], WireError> {
        block_on(Wire::read(self))
    }

    pub fn link(&self) -> Link {
        Wire::link(self)
    }

    pub fn receiver_status(&self) -> Result<Option<crate::protocol::receiver::Status>, WireError> {
        block_on(Wire::receiver_status(self))
    }

    pub fn roundtrip(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: crate::protocol::Checksum,
    ) -> Result<[u8; REPORT_LEN], WireError> {
        block_on(Wire::roundtrip(self, opcode, payload, checksum))
    }

    pub fn roundtrip_packet(&self, pkt: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], WireError> {
        block_on(Wire::roundtrip_packet(self, pkt))
    }

    pub fn read_raw_page(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: crate::protocol::Checksum,
    ) -> Result<[u8; REPORT_LEN], WireError> {
        block_on(Wire::read_raw_page(self, opcode, payload, checksum))
    }

    pub fn identify(&self) -> Result<u32, WireError> {
        block_on(Wire::identify(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_keyboard_collection_is_a_board() {
        assert!(is_keyboard_collection_board(
            0x05AC,
            0x024F,
            0x01,
            0x06,
            0,
            BusType::Usb
        ));
        assert!(!is_keyboard_collection_board(
            0x05AC,
            0x024F,
            0xFF00,
            0x01,
            0,
            BusType::Usb
        ));
        assert!(!is_keyboard_collection_board(
            0x05AC,
            0x0250,
            0x01,
            0x06,
            0,
            BusType::Usb
        ));
        assert!(is_keyboard_collection_board(
            0x3151,
            0x4002,
            0x01,
            0x06,
            0,
            BusType::Usb
        ));
        assert!(!is_keyboard_collection_board(
            0x3151,
            0x4002,
            0x01,
            0x06,
            1,
            BusType::Usb
        ));
        assert!(!is_keyboard_collection_board(
            0x3151,
            0x4003,
            0x01,
            0x06,
            0,
            BusType::Usb
        ));
    }

    #[test]
    fn karabiner_virtual_keyboard_is_not_a_usb_settings_interface() {
        // Live enumeration: Karabiner shares 05ac:024f with the Akko Mac-mode ID.
        assert!(!is_keyboard_collection_board(
            0x05AC,
            0x024F,
            0x01,
            0x06,
            -1,
            BusType::Unknown,
        ));
        assert!(is_keyboard_collection_board(
            0x05AC,
            0x024F,
            0x01,
            0x06,
            0,
            BusType::Usb,
        ));
    }

    #[test]
    fn akko_3098b_reports_select_the_settings_interface() {
        let decode = |s: &str| {
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>()
        };
        // 3098b.pcapng frames 24 and 30, also read from the attached board.
        let keyboard = decode("05010906a101050719e029e715002501750195088102950175088101950575010508190129059102950175039101050719002aff0095057508150026ff00810005ff0903750895018102050c09001580257f95407508b102c0");
        let input = decode("050c0901a101850319002a3c031500263c03950175108100c005010980a101850205011981298315002501950375018102950175058101c005010906a101850105071500250119002977957875018102c005010902a10185060901a1000509190129031500250195057501810295017503810105010930093109381581257f750895038106c0c006ffff0901a10185050901150026ff00750895038102c0");
        assert!(has_settings_report(&keyboard));
        assert!(!has_settings_report(&input));
        assert!(!has_settings_report(&decode("850575089540b102")));
        assert!(!has_settings_report(&decode("75089503b102")));
        assert!(has_settings_report(&decode("75089540a4850595038102b4b102")));
        assert!(!has_settings_report(&decode("75089540b10275")));
    }

    /// Only a stalled endpoint drops the handle and asks for a replug.
    /// Reporting every hidapi failure as one leaves a working board
    /// unusable until it is unplugged, which is worse than the error.
    #[test]
    fn only_a_stall_message_counts_as_a_stall() {
        assert!(is_stall_message(
            "hidapi error: ioctl (GFEATURE): Protocol error"
        ));
        assert!(is_stall_message("ioctl (SFEATURE): Broken pipe"));
        assert!(!is_stall_message("hidapi error: device disconnected"));
        assert!(!is_stall_message(
            "HidD_SetFeature: (0x00000001) Incorrect function."
        ));
    }
}
