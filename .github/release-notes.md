Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.3.6

**Switching profiles no longer risks freezing the keyboard.** A profile
switch is stored in the keyboard's own flash, and reading from the board
while that write settled could leave it unresponsive until replugged.
The app now leaves the board alone until the write has landed, then
checks it took. A switch takes about a second; that is the quiet, not
lag.

**ISO boards keep their picture.** Confirming a picture with the two ISO
keys added was forgotten on the next launch, and a board whose picture
ships built in was never offered the ISO version at all, so those two
keys could not be remapped. Both fixed.

The registry is 951 boards.

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
