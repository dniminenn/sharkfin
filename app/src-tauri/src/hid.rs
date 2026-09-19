// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! hidapi transport to the vendor collection, cable or 2.4 GHz relay.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hidapi::{HidApi, HidDevice};
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
                || is_akko_keyboard_tlc(d.vendor_id(), d.product_id(), d.usage_page(), d.usage())
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

fn is_akko_keyboard_tlc(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    vendor_id == 0x05AC && product_id == 0x024F && usage_page == 0x01 && usage == 0x06
}

/// Minimum gap between feature-report writes. Faster stalls the endpoint
/// until re-enum. 12 ms per report is the sustainable rate on an X86.
const MIN_WRITE_GAP: Duration = Duration::from_millis(crate::wire::MIN_WRITE_GAP);

pub struct Transport {
    dev: Device,
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

enum Device {
    HidApi(HidDevice),
    #[cfg(windows)]
    Windows(WindowsFeatureDevice),
}

#[cfg(windows)]
struct WindowsFeatureDevice {
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
unsafe impl Send for WindowsFeatureDevice {}

#[cfg(windows)]
impl Drop for WindowsFeatureDevice {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
impl WindowsFeatureDevice {
    fn open(path: &str) -> Result<Self, WireError> {
        use std::os::windows::ffi::OsStrExt;

        let mut wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().collect();
        wide.push(0);
        let mut handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
        }
        if handle == INVALID_HANDLE_VALUE {
            return Err(WireError::Transport(format!(
                "CreateFileW failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self { handle })
    }

    fn send_feature(&self, report: &[u8; REPORT_LEN + 1]) -> Result<(), WireError> {
        let ok = unsafe {
            HidD_SetFeature(
                self.handle,
                report.as_ptr() as *mut std::ffi::c_void,
                report.len() as u32,
            )
        };
        if ok == 0 {
            return Err(WireError::Transport(format!(
                "HidD_SetFeature failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(())
    }

    fn get_feature(&self, report: &mut [u8; REPORT_LEN + 1]) -> Result<usize, WireError> {
        let ok = unsafe {
            HidD_GetFeature(
                self.handle,
                report.as_mut_ptr() as *mut std::ffi::c_void,
                report.len() as u32,
            )
        };
        if ok == 0 {
            return Err(WireError::Transport(format!(
                "HidD_GetFeature failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(report.len())
    }
}

#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x00000001;
#[cfg(windows)]
const FILE_SHARE_WRITE: u32 = 0x00000002;
#[cfg(windows)]
const GENERIC_READ: u32 = 0x80000000;
#[cfg(windows)]
const GENERIC_WRITE: u32 = 0x40000000;
#[cfg(windows)]
const FILE_FLAG_OVERLAPPED: u32 = 0x40000000;
#[cfg(windows)]
const OPEN_EXISTING: u32 = 3;
#[cfg(windows)]
const INVALID_HANDLE_VALUE: *mut std::ffi::c_void = -1isize as *mut std::ffi::c_void;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut std::ffi::c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "hid")]
extern "system" {
    fn HidD_SetFeature(
        hid_device_object: *mut std::ffi::c_void,
        report_buffer: *mut std::ffi::c_void,
        report_buffer_length: u32,
    ) -> u8;
    fn HidD_GetFeature(
        hid_device_object: *mut std::ffi::c_void,
        report_buffer: *mut std::ffi::c_void,
        report_buffer_length: u32,
    ) -> u8;
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
        #[cfg(windows)]
        let is_keyboard_tlc = api.device_list().any(|d| {
            d.path().to_string_lossy() == path
                && is_akko_keyboard_tlc(d.vendor_id(), d.product_id(), d.usage_page(), d.usage())
        });
        #[cfg(windows)]
        if is_keyboard_tlc {
            return Ok(Self {
                dev: Device::Windows(WindowsFeatureDevice::open(path)?),
                last_write: Mutex::new(None),
                relay: AtomicBool::new(false),
                selected: AtomicBool::new(false),
                started: Instant::now(),
            });
        }
        let cpath = std::ffi::CString::new(path).expect("hid path with NUL");
        let dev = api.open_path(&cpath).map_err(api_err)?;
        Ok(Self {
            dev: Device::HidApi(dev),
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
        match &self.dev {
            Device::HidApi(dev) => dev.send_feature_report(&wire).map_err(api_err),
            #[cfg(windows)]
            Device::Windows(dev) => dev.send_feature(&wire),
        }
    }

    fn raw_read_blocking(&self) -> Result<[u8; REPORT_LEN], WireError> {
        trace_wire('R', 0);
        let mut wire = [0u8; REPORT_LEN + 1];
        let n = match &self.dev {
            Device::HidApi(dev) => dev.get_feature_report(&mut wire).map_err(api_err)?,
            #[cfg(windows)]
            Device::Windows(dev) => dev.get_feature(&mut wire)?,
        };
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

    #[test]
    fn only_the_exact_akko_keyboard_tlc_is_special_cased() {
        assert!(is_akko_keyboard_tlc(0x05AC, 0x024F, 0x01, 0x06));
        assert!(!is_akko_keyboard_tlc(0x05AC, 0x024F, 0xFF00, 0x0001));
        assert!(!is_akko_keyboard_tlc(0x05AC, 0x0250, 0x01, 0x06));
    }
}
