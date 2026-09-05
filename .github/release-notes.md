Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.6.0

**A keyboard that is not in the list works anyway.** sharkfin reads which
command set it speaks off the board's own answers, says so on a notice,
and writes only after you allow it. The Contribute tab still produces the
report that gets it a real entry.

**72 more boards** from the vendor's current list, including the X98PRO
and K86 revisions, the Darmoshark Top75 and TOP75J, and the VGN Neon75
Extreme.

**306 boards are drawn out of the box**, up from 187. Factory keymaps
now come from each board's own firmware where the vendor publishes it,
and a picture shared by boards with different keymaps is split so each
board gets its own.

The registry is 1029 boards, 4 of them confirmed on hardware.

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
