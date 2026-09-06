Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.7.0

**Magnetic switches.** Boards with hall-effect switches get a Switches
page: actuation and release point, rapid trigger with its two
sensitivities, and the bottom dead zone, for one key or the whole board.
Written on the ry5088 lineage, 551 boards, whose own firmware was read for
it; shown read-only on the other magnetic boards. Not yet: yc500 magnetic
boards, and editing of dynamic keystroke, mod-tap, toggle and snap keys,
which the page shows and leaves alone. No owner has tried a write yet.
If yours misbehaves, a data bundle from the Contribute tab says why.

**122 boards the vendor dropped from its list** are back, named, with
their factory keymaps read from firmware. Akko, Keydous, RoyalAxe,
Epomaker, MonsGeek and others. Their entries do not say which command set
they speak; the app asks the board at connect and writes once you allow
it, as it does for a board with no entry at all.

**Akko ACR75 v2 and Typhoon Ultimate TKL** are supported (device ids 606
and 2045). The ACR75 v2's firmware reads the lighting's rainbow flag the
other way round from every other board, so its rainbow switch now does
what it says.

The registry is 1153 boards, 4 of them confirmed on hardware.

You can also use sharkfin without installing anything, at
[app.getsharkfin.com](https://app.getsharkfin.com/), in Chrome,
Edge or another Chromium browser. Same app, same keyboard.

Use a USB cable or the 2.4 GHz receiver. Bluetooth has no settings
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
