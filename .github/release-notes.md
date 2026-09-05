Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.5.1

**Darmoshark Top75** is supported (device id 957), drawn out of the box.
Its owner sent the read sweep and the picture, and the picture matches
the board's own firmware key for key.

**Picture confirmation** offers each keyboard body once, with and without
the two ISO keys, so the right picture is always in the list. Before,
the ISO version of one body could push another body out.

The registry is 956 boards, 4 of them confirmed on hardware.

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
