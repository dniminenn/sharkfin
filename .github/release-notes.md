Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.3.2

**Paint works like a paint app.** The Paint page gains a colour picker:
right-click any key to pick its colour up, or use the pipette in the
toolbar. Colours you mix can be saved to swatches that persist between
sessions. The cursor is a brush that shows the current colour, hovering
previews it on the key under it, Ctrl+Z undoes a stroke, and painting by
drag now works on touchscreens. The toolbar sits above the keyboard.

None of this touches the board. Sending a pattern is still the explicit
Apply button, unchanged.

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
