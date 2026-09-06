Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.7.1

**Magnetic switches on yc500 boards.** The Switches page now covers the
yc3121 magnetic lineage: from firmware 2.00 the board's own per-key
columns are read and written; older firmware takes one board-wide record
and cannot report it back, and the page says so. Read out of the ER75 and
K85 images. On every magnetic yc500 board, profiles are now addressed the
way the firmware expects; 0.7.0 picked a keymap sub-layer instead.

**Per-key kinds.** Dynamic keystroke, mod-tap, toggle and snap can be set
per key on every board the page writes to, with the keys they act on.
Read out of the X65HE image. No owner has tried a write yet on either
family. If yours misbehaves, a data bundle from the Contribute tab says
why.

**Typhoon Ultimate TKL** has its picture built in.

The registry is 1153 boards, 4 of them confirmed on hardware.

You can also use sharkfin without installing anything, at
[app.getsharkfin.com](https://app.getsharkfin.com/), in Chrome,
Edge or another Chromium browser. Same app, same keyboard.

Use a USB cable. The 2.4 GHz receiver also works when it relays the
settings channel; some receivers do not. Bluetooth has no settings
channel.

**Linux** needs a udev rule before either the app or the browser
can reach the keyboard. The .deb and .rpm install it; replug the
keyboard after installing. For the AppImage or the browser,
paste this and replug it:

```sh
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151|0461|046a|0db0|145f|14a5|2ea8|3121|3299|331a|374a|379a|38a9|391d|3984|39a8|39ab|54ab", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-sharkfin.rules >/dev/null \
  && sudo udevadm control --reload-rules && sudo udevadm trigger
```

Not sure if your board is supported? See
[docs/BOARDS.md](https://github.com/dniminenn/sharkfin/blob/master/docs/BOARDS.md)
or [getsharkfin.com/boards](https://getsharkfin.com/boards/).
