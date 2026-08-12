Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.3.3

**Drawings import properly.** Pasting a keyboard-layout-editor.com
drawing on the Keys page now reads Menu, Fn, numpads, and the legends
UK, German, French, Japanese and Turkish boards print. A label that
means different keys in different countries stays unassigned instead of
guessed, and a doubled engraving no longer refuses the whole drawing.
Every shipped picture is drawn and re-imported in CI, so a legend the
importer cannot read fails the build instead of reaching you.

**The KiiP Y87 ships with its own picture**, drawn by its owner, who
filed four issues with full bundles until every key matched. Thank you.

Right Alt on the FF101 and VK99C and Print Screen on the MK232 V2 were
missing from their pictures and can be remapped now.

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
