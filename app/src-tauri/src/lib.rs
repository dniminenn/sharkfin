// SPDX-FileCopyrightText: JR Lanteigne <root@dnim.dev>
// SPDX-License-Identifier: GPL-3.0-or-later
mod commands;
pub mod dev;
pub mod hid;
pub mod protocol;
pub mod registry;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::scan,
            commands::get_led_param,
            commands::set_led_param,
            commands::get_profile,
            commands::set_profile,
            commands::read_keymap,
            commands::read_fn_keymap,
            commands::set_key,
            commands::get_settings,
            commands::set_debounce,
            commands::set_sleep,
            commands::set_options,
            commands::set_side_light,
            commands::set_auto_os,
            commands::factory_reset,
            commands::write_per_key,
            commands::read_macro,
            commands::write_macro,
            commands::contribution_bundle,
            commands::export_config,
            commands::import_config,
            commands::raw_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
