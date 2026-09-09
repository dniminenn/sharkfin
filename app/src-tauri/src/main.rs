// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// A GUI-subsystem binary starts with no console, so printing goes nowhere.
/// Borrowing the console of whatever launched it is what makes `--version`
/// answerable from a shell; when there is no parent console, as when
/// launched from Explorer, the call fails and nothing is lost.
#[cfg(windows)]
fn attach_parent_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

#[cfg(not(windows))]
fn attach_parent_console() {}

/// WebKitGTK's DMA-BUF renderer and the Nvidia driver do not agree on
/// Wayland: the window comes up blank and the process is gone in under a
/// second, leaving `Gdk-Message: Error 71 (Protocol error) dispatching to
/// Wayland display` behind. Turning that renderer off is the only known
/// escape. Only where the two actually meet, and never over a choice the
/// user or a launcher has already made.
#[cfg(target_os = "linux")]
fn disable_dmabuf_renderer() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VAR).is_some() {
        return;
    }
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland");
    // The kernel module, loaded by both the proprietary and the open build.
    let nvidia = std::path::Path::new("/sys/module/nvidia_drm").exists();
    if wayland && nvidia {
        std::env::set_var(VAR, "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn disable_dmabuf_renderer() {}

fn main() {
    // Answered before the window opens, so asking which build is installed
    // does not mean launching the app and reading the Contribute tab.
    // args_os, not args: the latter panics on a non-UTF-8 argument, and a
    // launcher passing one should still open the app.
    if std::env::args_os()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        attach_parent_console();
        println!("sharkfin {}", sharkfin_lib::registry::build_id());
        return;
    }
    disable_dmabuf_renderer();
    sharkfin_lib::run()
}
