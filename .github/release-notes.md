Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.4.0

**Per-key colour on gen2 boards.** The Paint page now writes to boards
in the gen2 family, not only yc500. The upload format comes from the
board firmware and is documented in `docs/PROTOCOL.md`.

**F13 to F24** can be assigned to keys.

**Plugging in the 2.4 GHz receiver** now says so, and tells you to use
the cable, instead of offering a board report.

The registry is 952 boards.

You can also use sharkfin without installing anything, at
[app.getsharkfin.com](https://app.getsharkfin.com/), in Chrome,
Edge or another Chromium browser. Same app, same keyboard.

Plug the keyboard in with a USB cable. There is no config
interface over 2.4 GHz or Bluetooth.

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
