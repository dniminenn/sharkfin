<p align="center">
  <img src="docs/logo.svg" width="96" alt="sharkfin" />
</p>

<h1 align="center">sharkfin</h1>

<p align="center">
  Open-source configurator for Attack Shark and other ROYUAN keyboards.<br/>
  Linux, Windows, macOS, or straight from a Chromium browser.
</p>

<p align="center">
  <a href="https://github.com/dniminenn/sharkfin/actions/workflows/ci.yml"><img src="https://github.com/dniminenn/sharkfin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="alpha" />
  <img src="https://img.shields.io/badge/Rust-CE422B?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="GPL-3.0-or-later" />
</p>

![keymap editor](docs/keys-abyss.png)

Remap keys, set the RGB, record macros and change device settings on 943
keyboards built on ROYUAN hardware: Attack Shark, Hator, ikbc, NOPPOO,
Epomaker, Akko, MEETION, rongyuan and more. Most identify as USB vendor
`0x3151`; a minority ship under their brand's own ID, so `docs/BOARDS.md`
lists the real one per board and discovery scans for all of them.

**Use a USB cable.** There's no config interface over 2.4 GHz or Bluetooth.
sharkfin never flashes firmware.

**[Use it in a browser](https://app.getsharkfin.com/) ·
[Download](https://github.com/dniminenn/sharkfin/releases) ·
[Is my board supported?](docs/BOARDS.md)**

## Supported boards

**Alpha, so back up first.**

939 of 943 accept changes, 4 are read-only. 165 are drawn out of the box
and 757 more after a one-time check against your board; the rest show a
slot grid.

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

No cloud, no telemetry, no background services. The desktop app is one
binary and works offline; the browser build is a static page that talks to
nothing but your keyboard. There's no report-rate setting because this
hardware doesn't have one.

## Install

Nothing to install: open **[app.getsharkfin.com](https://app.getsharkfin.com/)**
in Chrome, Edge or another Chromium browser and plug the keyboard in. The page
reaches the keyboard's settings channel over WebHID and never sees your typing,
because the browser does not expose the keyboard's own collections.

For the desktop app, download a release or build it yourself:

```sh
cd app
npm install
npm run tauri build
```

The browser build needs the wasm toolchain
(`rustup target add wasm32-unknown-unknown`, plus
[wasm-pack](https://rustwasm.github.io/wasm-pack/)):

```sh
cd app
npm install
npm run web:build   # -> app/dist-web
```

On Linux the keyboard's device node belongs to root, so sharkfin needs a
udev rule to reach it. The browser build needs it too, because Chrome opens
the same node. The .deb, .rpm and Arch packages install the rule; replug
the keyboard after installing. The AppImage and the browser build cannot
install it. For those, one line, then replug the keyboard:

```sh
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151|379a|374a|38a9|046a|2ea8|145f", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-sharkfin.rules >/dev/null \
  && sudo udevadm control --reload-rules && sudo udevadm trigger
```

If you already configure keyboards on this machine you may have a rule from
VIA, Vial or a vendor package that covers it, in which case nothing is
needed. The app shows you this command if it finds a keyboard it cannot
open.

## If the keyboard stops responding

It happens: the firmware stops answering, and the app says the board needs a
replug. Typing still works. In order:

1. **Close sharkfin**, or the browser tab. While it's open it keeps trying to
   reach the board.
2. **Unplug the cable, wait ten seconds, plug it back in.** It needs to lose
   power, not just reconnect.
3. **Fn + Home** turns the lighting back on if the backlight is dead.
4. **Fn + Esc**, held for about three seconds, resets the board's settings.
5. Still wrong? Open sharkfin and use **Device, then Factory reset**.

None of this touches firmware, and nothing here can leave the board
unusable.

## Contributing

Bugs and board reports both start in the app's **Contribute** tab, which
collects a read-only data bundle to paste into an issue. Development setup
is in [CONTRIBUTING.md](CONTRIBUTING.md); the wire protocol is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## License

GPL-3.0-or-later. sharkfin is an independent project, not affiliated with
or endorsed by Attack Shark, ROYUAN or any keyboard brand.
