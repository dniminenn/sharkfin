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
    sharkfin_lib::run()
}
