// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
//! The conversation with a board, above the two raw reports.
//!
//! Both backends speak the same protocol and differ only in how a report
//! reaches the wire: hidapi feature reports on the desktop, WebHID on the
//! browser. A backend implements [`Node`], the four primitives plus a
//! clock, and gets every derived exchange from [`Wire`] for free. Writing
//! a derived exchange twice is how the two builds drifted before.

use crate::protocol::{self, receiver, Checksum, REPORT_LEN};

/// Cable, or through a 2.4 GHz receiver's relay.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Usb,
    Receiver,
}

#[derive(Debug)]
pub enum WireError {
    /// A stalled control endpoint. Nothing gets through until the board
    /// leaves the bus, so the handle is dropped and a replug is asked for.
    Stall(String),
    /// Any other USB-layer failure. The handle survives it: a backend that
    /// cannot tell the two apart reports `Stall`, but one that can must not
    /// turn a passing error into a replug notice.
    Transport(String),
    NoHandshake,
    KeyboardOffline,
    ReceiverBusy,
    ShortRead(usize),
    Protocol(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stall(e) => write!(f, "the keyboard stopped answering ({e})"),
            Self::Transport(e) => write!(f, "the keyboard could not be reached ({e})"),
            Self::NoHandshake => write!(f, "device did not answer the identify handshake"),
            Self::KeyboardOffline => write!(
                f,
                "the receiver is paired, but the keyboard is asleep or switched off"
            ),
            Self::ReceiverBusy => write!(f, "the receiver did not accept a packet to relay"),
            Self::ShortRead(n) => write!(f, "short feature report ({n} bytes)"),
            Self::Protocol(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for WireError {}

impl WireError {
    /// A stalled endpoint. The board needs replugging; retrying will not
    /// help and more traffic makes it worse.
    pub fn is_stall(&self) -> bool {
        matches!(self, Self::Stall(_))
    }
}

/// Minimum gap between writes. Faster stalls the endpoint until re-enum;
/// 12 ms per report is the sustainable rate on an X86.
const MIN_WRITE_GAP_MS: u64 = 12;

/// Receiver deadlines from the vendor: 500 ms to accept, 1 s for a reply.
/// A reply is ready about 100 ms after send on an X86, so poll at the write
/// floor. A 100 ms tick would round every exchange up to 200.
const RECEIVER_SEND_DEADLINE_MS: f64 = 500.0;
const RECEIVER_READ_DEADLINE_MS: f64 = 1000.0;
const RECEIVER_TICK_MS: u64 = 5;
const RECEIVER_REST_MS: u64 = 10;
const SETTLE_MS: u64 = 10;
/// How many times a reply is waited for before the exchange is given up.
const REPLY_TRIES: u32 = 5;

/// What a backend provides. Everything else is derived in [`Wire`].
#[allow(async_fn_in_trait)]
pub trait Node {
    /// Whether traffic currently goes through a receiver's relay.
    fn relay(&self) -> bool;
    fn set_relay(&self, on: bool);
    /// The receiver keeps its relay target until told otherwise.
    fn selected(&self) -> bool;
    fn set_selected(&self, on: bool);
    /// A monotonic millisecond clock, for the receiver deadlines.
    fn now_ms(&self) -> f64;
    async fn sleep_ms(&self, ms: u64);
    /// One report to the node, already paced.
    async fn raw_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError>;
    async fn raw_read(&self) -> Result<[u8; REPORT_LEN], WireError>;
}

/// The protocol conversation. Every method here is written once and used
/// by both backends.
#[allow(async_fn_in_trait)]
pub trait Wire: Node {
    fn link(&self) -> LinkKind {
        if self.relay() {
            LinkKind::Receiver
        } else {
            LinkKind::Usb
        }
    }

    fn settle_ms(&self) -> u64 {
        SETTLE_MS
    }

    async fn send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        if self.relay() {
            self.relay_send(buf).await
        } else {
            self.raw_send(buf).await
        }
    }

    async fn read(&self) -> Result<[u8; REPORT_LEN], WireError> {
        if self.relay() {
            self.relay_read().await
        } else {
            self.raw_read().await
        }
    }

    /// The receiver's own status. Answered whether or not a keyboard is
    /// paired; `None` when the node is a keyboard on a cable.
    async fn receiver_status(&self) -> Result<Option<receiver::Status>, WireError> {
        self.raw_send(&receiver::status_packet()).await?;
        self.sleep_ms(RECEIVER_REST_MS).await;
        Ok(receiver::parse_status(&self.raw_read().await?))
    }

    async fn relay_send(&self, buf: &[u8; REPORT_LEN]) -> Result<(), WireError> {
        let deadline = self.now_ms() + RECEIVER_SEND_DEADLINE_MS;
        let mut ready = false;
        loop {
            match self.receiver_status().await? {
                Some(s) if !s.keyboard_online => return Err(WireError::KeyboardOffline),
                Some(s) if s.can_send => {
                    ready = true;
                    break;
                }
                _ => {}
            }
            if self.now_ms() >= deadline {
                break;
            }
            self.sleep_ms(RECEIVER_TICK_MS).await;
        }
        if !ready {
            self.set_selected(false);
            return Err(WireError::ReceiverBusy);
        }
        if !self.selected() {
            self.raw_send(&receiver::select_keyboard_packet()).await?;
            self.sleep_ms(RECEIVER_REST_MS).await;
            self.set_selected(true);
        }
        self.raw_send(buf).await
    }

    async fn relay_read(&self) -> Result<[u8; REPORT_LEN], WireError> {
        let deadline = self.now_ms() + RECEIVER_READ_DEADLINE_MS;
        let mut ready = false;
        loop {
            if matches!(self.receiver_status().await?, Some(s) if s.reply_ready) {
                ready = true;
                break;
            }
            if self.now_ms() >= deadline {
                break;
            }
            self.sleep_ms(RECEIVER_TICK_MS).await;
        }
        if !ready {
            return Err(WireError::NoHandshake);
        }
        self.raw_send(&receiver::release_packet()).await?;
        self.sleep_ms(RECEIVER_REST_MS).await;
        self.raw_read().await
    }

    async fn roundtrip(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], WireError> {
        self.roundtrip_packet(&protocol::packet(opcode, payload, checksum))
            .await
    }

    /// Round-trip a packet the caller built. The screen announce sets fields
    /// past the checksum byte, so it cannot be expressed as an opcode plus a
    /// payload the way `roundtrip` wants.
    async fn roundtrip_packet(
        &self,
        pkt: &[u8; REPORT_LEN],
    ) -> Result<[u8; REPORT_LEN], WireError> {
        self.send(pkt).await?;
        for attempt in 0..REPLY_TRIES {
            self.sleep_ms(self.settle_ms() * u64::from(attempt + 1))
                .await;
            let reply = self.read().await?;
            if reply[0] == pkt[0] {
                return Ok(reply);
            }
        }
        Err(WireError::NoHandshake)
    }

    /// For bulk reads whose replies are raw pages (no opcode echo).
    async fn read_raw_page(
        &self,
        opcode: u8,
        payload: &[u8],
        checksum: Checksum,
    ) -> Result<[u8; REPORT_LEN], WireError> {
        self.send(&protocol::packet(opcode, payload, checksum))
            .await?;
        self.sleep_ms(self.settle_ms()).await;
        self.read().await
    }

    async fn try_identify(&self) -> Option<u32> {
        for _ in 0..3 {
            if let Ok(reply) = self
                .roundtrip(protocol::cmd::GET_USB_VERSION, &[], Checksum::Bit7)
                .await
            {
                if let Some(id) = protocol::parse_device_id(&reply) {
                    return Some(id);
                }
            }
        }
        None
    }

    /// `0x8F` identify; returns the registry device ID. A node that does
    /// not answer by cable is asked whether it is a receiver, and identify
    /// is repeated through the relay when it is one with a keyboard awake.
    async fn identify(&self) -> Result<u32, WireError> {
        if self.relay() {
            return self.try_identify().await.ok_or(WireError::NoHandshake);
        }
        if let Some(id) = self.try_identify().await {
            return Ok(id);
        }
        let Some(status) = self.receiver_status().await? else {
            return Err(WireError::NoHandshake);
        };
        if !status.has_keyboard || !status.keyboard_online {
            return Err(WireError::KeyboardOffline);
        }
        self.set_relay(true);
        self.set_selected(false);
        match self.try_identify().await {
            Some(id) => Ok(id),
            None => {
                self.set_relay(false);
                Err(WireError::NoHandshake)
            }
        }
    }
}

impl<T: Node> Wire for T {}

/// The gap a backend must leave between writes. The firmware stalls its
/// control endpoint if they come faster.
pub const MIN_WRITE_GAP: u64 = MIN_WRITE_GAP_MS;

/// Drive a future to completion on this thread.
///
/// The desktop [`Node`] never actually yields: every one of its primitives
/// blocks and returns `Ready`. Tauri commands are declared `(async)` and so
/// already run on a worker thread, which is where this parks. It exists so
/// the protocol conversation can be written once, in async, and still be
/// called from the blocking backend.
///
/// Desktop only, and it must stay that way twice over. `thread::park` does
/// not block on wasm, so a future that ever returned `Pending` would spin
/// the browser's main thread. And a desktop primitive that ever yielded
/// would park a Tauri worker while `commands::run` holds the state lock,
/// which no timeout would get out of.
#[cfg(not(target_arch = "wasm32"))]
pub fn block_on<F: std::future::Future>(mut fut: F) -> F::Output {
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }

    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    // Safe: `fut` lives on this stack frame and is never moved after this.
    let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
    loop {
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return v,
            Poll::Pending => std::thread::park(),
        }
    }
}
