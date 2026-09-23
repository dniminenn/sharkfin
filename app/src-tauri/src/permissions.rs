// SPDX-FileCopyrightText: Shiroki Satsuki <me@shirok1.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(target_os = "macos")]
const LISTEN_EVENT: u32 = 1;

#[cfg(target_os = "macos")]
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request_type: u32) -> u32;
    fn IOHIDRequestAccess(request_type: u32) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum InputMonitoringStatus {
    Unknown,
    Denied,
    Granted,
}

#[cfg(any(target_os = "macos", test))]
impl InputMonitoringStatus {
    fn from_access(value: u32) -> Self {
        match value {
            0 => Self::Granted,
            1 => Self::Denied,
            _ => Self::Unknown,
        }
    }
}

/// None on platforms without macOS Input Monitoring. Checking never prompts.
pub fn input_monitoring() -> Option<InputMonitoringStatus> {
    #[cfg(target_os = "macos")]
    // SAFETY: IOKit takes an enum value, with no pointers or ownership.
    return Some(InputMonitoringStatus::from_access(unsafe {
        IOHIDCheckAccess(LISTEN_EVENT)
    }));
    #[cfg(not(target_os = "macos"))]
    None
}

/// Only invoked by the permission button, never by the scan loop.
#[tauri::command(async)]
pub fn request_input_monitoring(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match input_monitoring() {
            Some(InputMonitoringStatus::Unknown) => {
                // SAFETY: macOS owns the consent dialog. A false result can
                // mean the prompt is pending; do not open Settings over it.
                let granted = unsafe { IOHIDRequestAccess(LISTEN_EVENT) };
                log::info!("Input Monitoring request: granted={granted}");
                Ok(())
            }
            Some(InputMonitoringStatus::Denied) => open_input_monitoring_settings(app),
            _ => Ok(()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Input Monitoring is only available on macOS.".into())
    }
}

#[tauri::command(async)]
pub fn open_input_monitoring_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
                None::<&str>,
            )
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Input Monitoring is only available on macOS.".into())
    }
}

#[tauri::command(async)]
pub fn reveal_current_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = exe
            .parent()
            .filter(|p| p.file_name().is_some_and(|n| n == "MacOS"))
            .and_then(|p| p.parent())
            .filter(|p| p.file_name().is_some_and(|n| n == "Contents"))
            .and_then(|p| p.parent())
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .ok_or("This copy is running outside an app bundle. Open a built copy of sharkfin to add it to Input Monitoring.")?;
        app.opener()
            .reveal_item_in_dir(bundle)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("This action is only available on macOS.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_each_macos_permission_state() {
        for (raw, expected) in [(0, "granted"), (1, "denied"), (2, "unknown")] {
            assert_eq!(
                serde_json::to_value(InputMonitoringStatus::from_access(raw)).unwrap(),
                expected
            );
        }
    }
}
