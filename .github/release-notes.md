Alpha. Back up from the Device tab before you rely on it.

## What changed in 0.7.8

**The Lighting page shows the effect.** An animation of the board's LEDs
runs above the effect chips and follows every chip, colour and slider.
It is timed from the keyboard's own firmware, mode by mode, so Flow, Layers,
Sine wave and the rest run at the board's pace. Layers and Sine wave play
the firmware's own scripts. The shapes of the other effects are drawn to
match by eye.

## What changed in 0.7.7

**VGN Neon75 Extreme** under its second device id (3391) is supported,
with the picture built in from the owner's keymap; the earlier revision
(3288) gets the same picture. Reported in issue #44.

**One bundle.** The Contribute tab's bundle now carries the keyboard
picture and your answer about it, so a board report is a single paste.
The Keys page's "send it in" opens the Contribute tab instead of copying a
second bundle. A board drawn from its built-in picture is no longer asked
for a report.

## What changed in 0.7.6

**The Keys page is the picture.** Click a key and the cap itself takes
your typing: type a name and Enter picks the match, or press the key you
want on another keyboard and it is assigned on the spot. The picker opens
on the key with search, recents and every group. The cap flashes when the
write lands.

**Pictures have controls.** A Picture menu on the Keys page edits the
current picture, tries another from the collection, or sends yours in. A
picture offered for confirmation can be fixed in the editor instead of
rejected. Drawings and picked pictures are remembered on boards that have a
built-in one too.

**One look across the app.** Sections replace cards on every page,
choices are chips, the one primary action on a screen is filled. The
editor's presets are drawn as small keyboards with their match counts.

## What changed in 0.7.5

**Draw your board.** When no stored picture matches your keyboard, the
Keys page lets you draw it instead of sending you to
keyboard-layout-editor.com. Start from a preset (60% to full size, ISO,
knob) or from the closest stored picture; each preset shows how many of
its keys your board has. As you draw, a key your board does not have dims,
and the keys it has that are not drawn yet are listed to add with one
click. The drawing goes through the same confirmation as any other
picture, and its bundle bakes it in for everyone with the board. Pasting a
keyboard-layout-editor drawing still works and opens in the editor.

## What changed in 0.7.4

**KOODO Solar** is supported (device id 1087), with its picture built in
from the owner's keymap. Reported in issue #42.

## What changed in 0.7.3

**Switch writes closed on 23 gen2 boards.** 0.7.1 let boards whose internal
name starts with `yc3121_` write their switch settings whatever their
command set. That prefix names the yc500 lineage whose firmware was read;
on gen2 (the JEDEL KL166 and 22 siblings) no image has been read, and the
KL166's firmware does not take the packets. Those boards are read-only
again until one is. Reported in issue #41.

## What changed in 0.7.2

**Lighting per board.** The Lighting page now offers the effects your
board's firmware has, from the vendor's own per-board table, instead of
one list for everyone. 26 boards (Akko's V5 HE lineage and siblings) get
Train and Endless and lose two wave directions they never had; the MK12
and MK14 get brightness 0 to 7. Most boards keep their 18.

**gen2 speed.** Boards on the gen2 command set ran every effect one step
slower than the vendor app at the same slider position and could not reach
their fastest. Read out of the X65HE image: the speed byte is a frame
divider that starts at 0 there, at 1 on yc500.

The registry is 1154 boards, 4 of them confirmed on hardware.

You can also use sharkfin without installing anything, at
[app.getsharkfin.com](https://app.getsharkfin.com/), in Chrome,
Edge or another Chromium browser. Same app, same keyboard.

Use a USB cable. The 2.4 GHz receiver also works when it relays the
settings channel; some receivers do not. Bluetooth has no settings
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
