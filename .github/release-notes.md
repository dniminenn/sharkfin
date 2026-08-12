Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.3.0

**Draw on the screen.** Boards with a built-in display can now take a
picture from the Device page. Pick an image on the Display card; it is
scaled to fit and replaces what the display is showing. 70 boards
qualify, the ones whose own firmware drives the display, including the
EPOMAKER RT100, RT85, RT75, RT100 PRO and Glyph, most Hator HTK41xx and
several AttackShark models. Boards that hand the picture to a separate
display chip are not supported yet, and the app says so on the Display
card.

This path is new. If a picture comes out wrong, or nothing appears,
please open an issue and name your board.

**Cypher 81 drawn out of the box.** An owner confirmed all 84 keys, so
its layout now ships baked.

**Fewer wrong ISO guesses.** The Keys page offers an ISO picture only
when the board's firmware carries both ISO keys. A correction to the
0.2.9 notes: the Menel Nia 87 was called an ISO board there. That was
wrong, and the registry no longer says it.

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
