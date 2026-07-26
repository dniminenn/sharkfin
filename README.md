<p align="center">
  <img src="docs/logo.svg" width="96" alt="sharkfin" />
</p>

<h1 align="center">sharkfin</h1>

<p align="center">
  Open-source configurator for Attack Shark and other ROYUAN keyboards.<br/>
  Linux, Windows, macOS.
</p>

<p align="center">
  <a href="https://github.com/dniminenn/sharkfin/actions/workflows/ci.yml"><img src="https://github.com/dniminenn/sharkfin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="alpha" />
  <img src="https://img.shields.io/badge/Rust-CE422B?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="GPL-3.0-or-later" />
</p>

![keymap editor](docs/keys-abyss.png)

Remap keys, set the RGB, record macros and change device settings on 523
keyboards built on ROYUAN hardware (USB VID `0x3151`): Attack Shark, Hator,
ikbc, NOPPOO, Epomaker, Akko, MEETION, rongyuan and more.

**Use a USB cable.** There's no config interface over 2.4 GHz or Bluetooth.
sharkfin never flashes firmware.

**[Download](https://github.com/dniminenn/sharkfin/releases) ·
[Is my board supported?](docs/BOARDS.md)**

## Supported boards

**Alpha, so back up first.**

519 of 523 accept changes, 4 are read-only. 463 have a drawn layout; the
rest show a slot grid.

## Features

- **Keys.** Remap any key, on a picture of your board, per profile. Base
  and Fn layers, combos, and the knob (turn left, turn right, press). Writes
  go to the keyboard immediately.
- **Lighting.** 18 effects with direction options, full RGB, brightness and
  speed, live as you drag. Edge-light controls appear on boards that have
  edge LEDs.
- **Paint.** Colour individual keys, then send. Sending is manual and
  rate-limited, because the pattern goes into the keyboard's flash.
- **Macros.** Record key and mouse sequences with per-event delays into the
  50 onboard slots, then bind a key to one: repeat, toggle, or while-held.
- **Profiles.** Three of them, onboard.
- **Backup.** Export everything to a file and restore it later.
- **Device.** Debounce, Windows-key lock, WASD/arrow swap, backlight off,
  host-OS auto-detect, sleep timeouts, factory reset.
- **Colorways.** The whole app re-skins like a keycap set swap: Abyss,
  Olivia, Laser, Botanical, 8008.

![lighting, Olivia colorway](docs/lighting-olivia.png)

No cloud, no telemetry, no background services. One binary, fully offline.
There's no report-rate setting because this hardware doesn't have one.

## Install

Download a release, or build it yourself:

```sh
cd app
npm install
npm run tauri build
```

On Linux, add a udev rule so the app can reach the keyboard:

```
# /etc/udev/rules.d/70-sharkfin.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", MODE="0660", TAG+="uaccess"
```

## Contributing

Bugs and board reports both start in the app's **Contribute** tab, which
collects a read-only data bundle to paste into an issue. Development setup
is in [CONTRIBUTING.md](CONTRIBUTING.md); the wire protocol is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## License

GPL-3.0-or-later.
