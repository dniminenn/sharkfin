Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.6.1

**Boards that were never found.** Almost every board presents its
settings as usage 2 on the vendor page; the Akko ACR75 v2 presents usage
1, and sharkfin looked for 2 alone, so it never saw the board. Both are
accepted now. Any board that showed "No device" with the cable in may
have been this; try again.

**Akko ACR75 v2** is supported (device id 606). It has no built-in
picture yet: the Keys page matches one against the board and asks you to
confirm it.

The registry is 1030 boards, 4 of them confirmed on hardware.

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
