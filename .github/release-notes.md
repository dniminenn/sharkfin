Beta. Back up from the Device tab before you rely on it.

## What changed in 0.8.0

**Setup.** A keyboard sharkfin does not know can now be set up by its
owner. Setup shows the picture and asks if it is yours, allows changes,
has you press a few keys, turns the backlight red and asks what you see,
switches profile and back, remaps one key you choose, and on a board with
magnetic switches sets one key to a light touch and asks how it feels.
Every write is read back and put back. What you answer is kept for that
keyboard, so it works on your computer from then on, and it rides along
with the data bundle so it can work for everyone with the same board.
Setup runs over the cable only. A board that already works does not need
it; the Contribute tab has a "Run setup" button all the same.

**Switch settings on boards whose firmware has not been read** can be
opened by Setup's felt test, for that keyboard only: the write has to
read back and you have to feel it.

**Screen Colour read back as red.** A board sitting in that mode showed
red on the Lighting tab whatever colour it had; it keeps its own colour
now.

## What changed in 0.7.11

**The rainbow toggle is right on 106 more boards.** The vendor's driver
carries, for each board, which way its firmware reads the colour flag. Where
a board's firmware is not published, sharkfin now takes the answer from
there instead of assuming. The MonsGeek FUN60 PRO from issue #49 is one of
them: picking a colour gave a rainbow and asking for the rainbow gave one
colour.

**The "Swap them" link shows whenever a colour is in play,** in either
direction, and the data bundle prints which way the board is read and by
what evidence.

## What changed in 0.7.10

**162 more boards.** Akko, MonsGeek and Hator ship the same driver under
their own names with their own board tables, and those tables carry boards
the shared catalogue does not: 97 Akko, 36 MonsGeek and 29 Hator, the Hator
SKYFALL 80 PRO from issue #48 among them. The registry is 1316 boards. Akko's
report vendor id 38ee, so on Linux the udev rule below needs installing
again. 144 of the boards with a display can take a picture, 18 more than
before.

**The Display section says why there is no upload** on a board whose
display size is not on file, instead of showing three rows and nothing else.

## What changed in 0.7.9

**The rainbow toggle was backward on some boards.** Turning it on gave one
solid colour and turning it off gave the rainbow. Which way round a board
reads it now comes from the board's own firmware, which settles 33 of them,
mostly Akko and MonsGeek, plus the AttackShark X65HE and the Keydous
AJ68-CP. On any other board the Lighting page offers to swap the two and
remembers the answer for that board. The edge light follows it.

**The window no longer dies on Wayland with an Nvidia card.** It opened
blank and the app was gone in under a second. The drawing path behind that
is switched off on those two together, and left alone everywhere else.

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

You can also use sharkfin without installing anything, at
[app.getsharkfin.com](https://app.getsharkfin.com/), in Chrome,
Edge or another Chromium browser. Same app, same keyboard.

Use a USB cable. Over the 2.4 GHz receiver sharkfin reads whatever the
receiver relays: some carry the settings channel, some carry nothing, and
the same model ships with both. Writes need the cable. Bluetooth has no
settings channel.

**Linux** needs a udev rule before either the app or the browser
can reach the keyboard. The .deb and .rpm install it; replug the
keyboard after installing. For the AppImage or the browser,
paste this and replug it:

```sh
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151|0461|046a|0db0|145f|14a5|2ea8|3121|3299|331a|374a|379a|38a9|38ee|391d|3984|39a8|39ab|54ab", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-sharkfin.rules >/dev/null \
  && sudo udevadm control --reload-rules && sudo udevadm trigger
```

Not sure if your board is supported? See
[docs/BOARDS.md](https://github.com/dniminenn/sharkfin/blob/master/docs/BOARDS.md)
or [getsharkfin.com/boards](https://getsharkfin.com/boards/).
