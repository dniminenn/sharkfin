Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.3.1

**Drawing reaches another 46 boards.** Boards that pass the picture to a
separate display chip can now be drawn on, where that chip's firmware is
known to accept it. This covers the Keydous NJ81 and NJ98, and many
ry5088-based boards from other brands. 116 boards can now take a picture,
up from 70 in 0.3.0.

Boards whose panel is wider than the display chip can address, and the
remaining chip families that nothing evidences yet, are still refused and
say so on the Display card.

Drawing has still not been confirmed on physical hardware. If a picture
comes out wrong, or nothing appears, please open an issue and name your
board.

The registry is 949 boards.

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
