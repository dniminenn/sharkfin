// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Answered before the window opens, so asking which build is installed
    // does not mean launching the app and reading the Contribute tab.
    if std::env::args()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
    {
        println!("sharkfin {}", sharkfin_lib::registry::build_id());
        return;
    }
    sharkfin_lib::run()
}
