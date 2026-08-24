# ROYUAN keyboard HID protocol

Reference for the wire protocol sharkfin speaks. Nothing here is needed to
use the app.

Evidence markers: **[HW]** round-tripped on an Attack Shark X86 (device
1967). **[FW]** read out of device firmware, naming the image where it
matters: `2268_v309` (X65HE, gen2), `1379 v108_oledv104` (EPOMAKER RT100,
yc500), `1723 v102_oledv103` (EPOMAKER Dynatab75X-UK, yc500), `2454
v413_oledv111` (Keydous NJ81-CP, gen2). **[JS]** vendor host code only,
never exercised.

## Transport [HW]

| | |
|---|---|
| USB VID | `0x3151` on most boards; `0x379a`, `0x374a`, `0x38a9`, `0x046a`, `0x2ea8` and `0x145f` also occur. Discovery scans `registry::vendor_ids()`, not a constant |
| Collection | usage page `0xFFFF`, usage `2` |
| Reports | 64 bytes, feature, report ID 0, both directions |
| Settle | ~10 ms between request and reply |
| Link | wired USB only; 2.4 GHz and Bluetooth do not expose it |

GET replies echo the opcode in byte 0, except bulk page reads (keymatrix,
macro, userpic) which return raw page bytes.

## Checksums [HW]

`0xFF - (sum & 0xFF)`.

| mode | covers | stored at | used by |
|---|---|---|---|
| Bit7 | 0..=6 | byte 7 | everything else |
| Bit8 | 0..=7 | byte 8 | `SET_LEDPARAM`, `SET_SLEDPARAM` |

## Families

Two command sets. Opcodes collide across them: yc500 `SET_KEYMATRIX` is
gen2 `SET_KBOPTION`, yc500 `SET_KBOPTION` is gen2 `SET_DEBOUNCE`, yc500
`SET_DEBOUNCE` is gen2 `SET_SLEEPTIME`. A misaddressed write lands on a
live register. Resolve the family from the registry, never from the
product ID.

| command | yc500 | gen2 |
|---|---|---|
| identify | `0x8F` | same |
| revision | `0x80` | same |
| LEDPARAM set/get | `0x07`/`0x87` | same |
| SLEDPARAM set/get | `0x08`/`0x88` | same |
| USERPIC set/get | `0x0C`/`0x8C` | same |
| FN set/get | `0x10`/`0x90` | same |
| macro get | `0x8B` | same |
| auto-OS set/get | `0x17`/`0x97` | same |
| reset | `0x02` | `0x01` |
| profile set/get | `0x05`/`0x85` | `0x04`/`0x84` |
| keymatrix set/get | `0x09`/`0x89` | `0x0A`/`0x8A` |
| debounce set/get | `0x11`/`0x91` | `0x06`/`0x86` |
| sleep set/get | `0x12`/`0x92` | `0x11`/`0x91` |
| options set/get | `0x06`/`0x86` | `0x09`/`0x89` |
| macro set | `0x16` | `0x0B` |
| single-slot key write | `0x13`/`0x15` | via keymatrix opcode |
| report rate | absent | `0x03`/`0x83` |

## Identify [HW]

`0x8F` → `[0x8F, id:u32 LE, …]`. X86 answers `1967`.

## Keymap

128 slots × 4 bytes = 512 per layer.

### yc500 [HW]

| | layout |
|---|---|
| read `0x89` | `[profile, page]`, pages 0..8, raw 64-byte replies |
| write slot `0x13` | `[profile, slot]`, value at bytes 8..12 |
| Fn layer | write `0x15`, read `0x90`, same shapes |
| bulk `0x09` **[JS]** | `[profile, 0xF8, 1, page]` + 56 bytes, 9 pages |

The vendor's bulk loop sends 9 × 56 = 504 of the 512 bytes; slots 126–127
never transmit.

### gen2 [FW]

`0xFF` in the sentinel byte selects bulk; any other value is a slot index.
`os` is the host layer: 0 win, 1 mac, 2 android, 3 ios.

| | layout |
|---|---|
| read `0x8A` | `[profile, 0xFF\|slot, page, os]`; bulk pages 0..7, raw 64-byte replies |
| write slot `0x0A` | `[profile, slot, 0, 0, apply, os]`, value at 8..12 |
| write bulk `0x0A` | `[profile, 0xFF, page, len, last, os]` + ≤56 bytes at 8, 10 pages |
| Fn read `0x90` | `[os, profile, 0xFF\|slot, page]` |
| Fn write `0x10` | `[os, profile, slot]`, value at 8..12 |

`last` sets the firmware's commit-to-flash bit. Storage is
`0x08028800 + profile×2048 + layer×512 + slot×4`, i.e. four layers per
profile. Overwriting a slot holding Fn (`[0x0A,0x01,0,0]`) is permitted.

On yc500, `0x8A` answers a 64-byte record from a fixed table, reading only
the profile byte (1379 firmware at `0x23C18`). That record is the all-`0xFF`
reply the read sweeps show, not an echo. **[FW]**

### Slot values

| byte 0 | meaning | bytes 1..3 |
|---|---|---|
| `0x00` | HID usage | `[0, usage, 0]`; combos use bytes 1 and 3 |
| `0x01` | mouse button | |
| `0x03` | consumer usage | `[0, lo, hi]`, Vol+ = `[3,0,0xE9,0]` |
| `0x09` | macro | `[mode, index, 0]`; 0 repeat, 1 toggle, 2 hold |
| `0x0A` | special | `[1,0,0]` Fn, `[12,0,0]` power save |
| all zero | on the Fn layer, falls through to the base layer; on the base layer the key is dead | |

X86 knob: slot 90 turn right, 91 turn left, 84 press.

## Lighting [HW]

`SET_LEDPARAM 0x07` (Bit8) / `GET 0x87`:

```
[op, mode, 5-speed, brightness, (option<<4)|flags, R, G, B, ck8]
```

- Speed inverts on the wire: UI 0..4 → wire 5..1. Brightness 0..4 direct.
- Flags nibble: `7` fixed colour, `8` rainbow. Modes 22/23 invert it
  (`0` rainbow, `4` fixed). Mode 13 puts its pattern slot in the option
  nibble and forces RGB `(0,200,200)`. Mode 21 zeroes the byte.
- White `0xFFFFFF` transmits as `0xFAFAFA`.
- On GET, a flags nibble of 0..6 is a preset-colour index overriding RGB:
  red, orange, yellow, green, cyan, blue, magenta.
- RGB below `0x080808` renders as unlit. Use the backlight-off option bit
  instead of writing black.

Modes: 1 static, 2 breathing, 3 spectrum, 4 wave (4 dirs), 5 ripple,
6 star dots, 7 flow (2), 8 key shadow, 9 layers, 10 sine, 11 spring (2),
12 neon (2), 14 radiant, 15 loop (2), 16 colour grid, 17 snowfall,
18 meteor, 19 silent snow. Modes 13, 21, 22, 23 need host-side data.

Caps LED Swap, key function `[10, 17, 0, 0]`, lights that key white while
caps lock is active. The colour is fixed in firmware: no command sets it,
and a per-key pattern underneath is ignored while the key is lit. **[HW]**

### Edge light [HW]

Own mode table: 0 off, 1 static, 2 breathing, 3 spectrum, 4 wave, 5 snake,
plus 20/21/22. Mode 3 forces the rainbow flag. Speed is **not** inverted.

`0x88` answers on boards with no edge LEDs. The X86 returns
`[88,01,03,04,08,ff,ff,ff]` and has none. Presence comes from the
registry's `sideLightLayout` (288 of 949).

## Profiles [HW]

`SET 0x05 [profile]`; `GET 0x85` → `reply[1]`. Zero based.

Three onboard on an X86. Not every board has three: an AK820 MAX answered
`0x85` with 4 while sitting on it, so it has at least five, and the
registry claims up to eight. Read the board rather than assuming a count,
and switch it with `0x05` before editing a profile, or the edit lands on
one the user is not typing on.

## Settings

| what | layout |
|---|---|
| Debounce | value at wire byte 2 (yc500 **[HW]**) or 1 (gen2 **[FW]**); same offset in the reply. Range 1..10 |
| Sleep timers | four u16 LE seconds |
| Options | bitfield, yc500 only |
| Firmware revision | `GET 0x80` → `(reply[2]<<8) \| reply[1]` |
| Factory reset | bare opcode, ~4 s |
| Report rate | gen2 only; yc500's vendor setter is a stub returning false |

### Sleep timers

```
yc500 SET 0x12  bytes 8-9 sleep BT, 10-11 sleep 2.4G, 12-13 deep BT, 14-15 deep 2.4G   [HW]
yc500 GET 0x92  bytes 1-2, 3-4, 5-6, 7-8   -- reads at different offsets than it writes
gen2  SET/GET   bytes 8..16 both ways      [FW]
```

### Options bitfield, yc500 [HW]

Reply byte 2: `1` Win lock, `2` Mac mode, `8` WASD swap, `16` backlight
off, `32` side light off, `64` keyboard mode, `128` keyboard lock. Byte 3
Fn matrix flag, byte 4 power save. Read-modify-write to preserve
unmodelled bits.

Bit `128` locks the keyboard. The vendor's setter writes Mac mode at bit 1
while its getter reads bit 0.

gen2 answers `0x89` with decoded fields at reply bytes 1..4 instead of a
bitfield; meanings unestablished.

## Macros [HW]

50 slots × 256 bytes. Read-back is faithful, unlike per-key colour.

Write `0x16` (yc500) / `0x0B` (gen2), Bit7, one report per page:

| byte | |
|---|---|
| 0 | opcode |
| 1 | slot |
| 2 | page |
| 3 | `56` |
| 4 | `1` on final page |
| 8.. | 56 payload bytes, zero-padded |

Only pages containing a non-zero byte are sent, so short macros are one
report.

Blob: u16 LE repeat count, then a strictly alternating event/delay stream.

- key / mouse button: `[code, pressed<<7 | delay]`, or `[code, pressed?0x80:0, delay u16 LE]` when delay > 127 ms or zero
- mouse move: `[0xF9, delay, dx i8, dy i8]`
- mouse buttons `0xF0`..`0xF4`; key codes are HID usages `0x04`..`0xEF`
- four zero bytes terminate

Read `0x8B`: `[slot, page]`, pages 0..4, raw 64-byte replies, stopping at
the first all-zero page.

Bind with keymap slot value `[0x09, mode, index, 0]`.

## Per-key colour

`SET_USERPIC 0x0C` uploads RGB triples in matrix order as seven pages with
data from byte 8. The opcode is shared across the families; the header is
not.

| byte | yc500 [HW] | gen2 [FW] |
|---|---|---|
| 1 | `0` | slot |
| 2 | length low | `0xFF` |
| 3 | length high | page, 0..6 |
| 4 | page, 0..6 | page length: 56, then 42 |
| 5 | `0` | `1` on the final page |
| total | 384 (128 keys) | 378 (126 keys) |

Display it by selecting light mode 13; the mode's option nibble is the
gen2 slot.

gen2 (`2268_v309`, handler `0x8010db8`): a page is copied only when byte 2
is `0xFF`, staged at page × 56, and committed to flash at
`0x0802f800 + slot × 384` when page 6 carries the final flag. A packet
whose byte 2 is not `0xFF` skips the copy but still triggers the commit,
so a misaddressed header burns a flash cycle on stale data. The firmware
bounds-checks neither page nor length.

`GET_USERPIC 0x8C` returns stable data that does not reflect writes. Treat
as write-only.

**Uploads land in flash and stall the firmware if repeated.** Measured on
an X86:

| cadence | result |
|---|---|
| 7 reports / 500 ms | control endpoint dies after ~13 reports |
| 7 reports / 3 s | 42 reports, still responsive |
| 2 uploads / 5 s, pages 40 ms apart, mode switch 600 ms after | stalled on the second |
| 2 uploads / 10 s, pages 100 ms apart, 2 s settle, no redundant mode switch | survives |

Surviving a synthetic loop does not mean an upload followed by anything
else is safe, which is why the third row stalled where the second did not.
The last row is what sharkfin does now.

Individual reports need ~12 ms spacing. A stalled endpoint fails every
report (`ioctl (SFEATURE): Protocol error`) and does not recover on
reopen. The device needs USB re-enumeration.

## Command inventory

The X86's class chain defines 57 commands; most target hardware it lacks.

**Answered:** `0x80` `0x85` `0x86` `0x87` `0x88` `0x89` `0x8B` `0x8C`
`0x8F` `0x90` `0x91` `0x92` `0x97`.

**Not answered:** magnetic switch / rapid trigger (`0x1B`–`0x1E`, `0x65`,
`0x9C`–`0x9E`, `0xE5`), screen and image upload (`0x22`–`0x32`,
`0xA5`–`0xB2`), MLED (`0xAE`, `0xC0`, `0xC1`). The gen2 firmware rejects
`0xAE`, `0xC0`, `0xC1`, `0xE5` explicitly.

**Destructive:** `0xAC` erases the flash chip; `0x30`/`0x31` and
`0x40`/`0x41` are bootloader entry points.

## Screens

172 boards in the registry carry a display, 152 gen2 and 20 yc500. Whether
sharkfin can draw follows the firmware that parses the frame, not the
family: yc500 and yc3123-lineage boards parse it in the keyboard, ry5088
boards forward it to a display chip that parses it there, and the remaining
gen2 lineages have no firmware evidence either way.

Geometry is per board, not per family, and comes from the vendor's own
device record at `other.screen`: `size.w`, `size.h`, `mode` and `layer`.
25 distinct sizes ship, from 128x128 to 428x142, so nothing may assume a
default. Mode `16` is RGB565, mode `24` is three bytes a pixel and belongs
to the small LED matrices (7x7, 11x7) rather than to a screen.

`0xAD` returns the display's own firmware version, means the same thing in
both families, and is the one screen command the read sweep can send blind.
A board that answers has a display; one that echoes does not.

### Drawing, yc500 [FW]

Evidenced against two boards' firmware, one per pixel mode: an RT100
(device 1379, `v108_oledv104`, mode `16`) and a Dynatab75X-UK (device
1723, `v102_oledv103`, mode `24`, a 60x9 matrix). The RT100's dispatch is
a comparison tree at `0x24C00` over a 42-entry jump table at `0x24C2A`.
Decoding that table yields the same opcodes for four commands already
verified on hardware (`0x09` keymap, `0x0C` per-key colour, `0x11`
debounce, `0x12` sleep), which is what says the decode is right.

| step | opcode | RT100 handler | Dynatab handler | payload |
|---|---|---|---|---|
| announce, mode 16 | `0xA5` | `0x23F1E` | rejected | `[1]` frame, `[2]` frame count, `[3]` delay, `[4..6]` length u16 LE, `[8..12]` bounding box |
| data, mode 16 | `0x25` | `0x23FB6` | rejected | 8-byte header, `[4..6]` page index, `[6]` page length, data at `[8]`, 56 bytes |
| announce, mode 24 | `0xA9` | rejected | `0x2311C` | as the mode 16 announce |
| data, mode 24 | `0x29` | rejected | `0x231AA` | as the mode 16 data |

The two images are mirrors: each implements exactly the pair its vendor
record's mode declares and sends the other pair to its reject entry. The
registry's mode picks the pair; nothing else may.

What the firmware settles, that the vendor's JavaScript could not:

- The RT100's announce returns immediately unless a flag at `+27` is set.
  That is why the caller polls it until `reply[1]` is 1 instead of
  assuming.
- Bytes 12 to 18 are never read, in either image: the bounding box exists
  only as its low bytes, the length only as its u16, and the `layer` the
  vendor sends is ignored. sharkfin refuses frames past 65535 bytes for
  that reason.
- The u16 is a yc3121 trait, not a yc500 one. A third yc3121 image
  (device 1996, `v113_oledv102`) reads the announce the same way. yc3123
  reads a u32; see below. The 65535 limit applies to the yc500 family,
  whose screen boards are all yc3121-lineage.
- The announce erases nothing. It resets counters, so a frame does not
  need the chip erased first.
- The page handlers check `[1]` against the frame the announce recorded
  and count bytes against the announced length, so a page that disagrees
  is dropped rather than written.

Pixel order is the one part still taken from the vendor's JavaScript, and
it is content rather than command: column major, sorted by x then y,
RGB565 high byte first in mode `16` and plain RGB triples in mode `24`.
Getting it wrong scrambles a picture; it does not reach anything else.

### Drawing, yc3123 [FW]

yc3123 boards sit in the gen2 family but their keyboard firmware parses
frames itself, yc500-style. Evidenced against two images: an AttackShark
K86 (device 2730, `v115_oledv108`) and a Hator HTK4100UA (device 2936,
`v113_oledv106`), both 240x135 mode `16`. Addresses below are 2730 then
2936. The registry has no yc3123 marker, so sharkfin keys the path on the
`internalName` prefix inside the gen2 family.

The dispatcher (`0x22174` / `0x23f3c`) verifies the checksum
(`0x133b0` / `0x1357c`) before dispatching, with sharkfin's exact rule:
sum bytes 0 to 6 against byte 7, except opcodes `0x07` and `0x08` which
sum 0 to 7 against byte 8. A failed packet is rejected outright. The
verifier is called on the buffer at offset 2, which anchors packet index =
buffer offset - 2 for everything below.

| step | opcode | 2730 | 2936 | payload |
|---|---|---|---|---|
| announce | `0xA5` | `0x120dc` | `0x121f0` | as yc500, plus: length u32 from `[4]`, `[5]`, `[16]`, `[17]`; box high bytes read from `[14]`, `[15]` |
| data | `0x25` | `0x12b6c` | `0x12ccc` | as yc500: `[1]` frame, `[4..6]` page index u16 LE, `[6]` page length, data at `[8]`, 56 bytes |

Both images reject `0xA9`/`0x29`, matching their records' mode `16`. Two
yc3123 registry boards declare mode `24`; no image evidences it, so it
stays refused.

What makes the big panels work: pages stream through ten 4096-byte RAM
banks with the announced length as a countdown, so the board never holds
the frame. Duplicate and out-of-order pages are dropped, not written. The
frame goes to flash, which is why the upload keeps the flash cooldown and
the backend rate limit.

Both announce handlers return without doing anything unless a firmware
internal byte is set (`0x204e3` / `0x204e4`), written by display-init
routines and by no host command found. A frame sent while it is clear is
silently ignored. The caller must poll the announce and treat silence as
failure, never as success. The vendor's own uploader does the same: it
polls `reply[1] == 1` up to ten times at 100 ms and reports failure
otherwise, and its replies echo the opcode at byte 0, the same framing
sharkfin's `roundtrip_packet` requires.

Pixel order is vendor JavaScript evidence, as on yc3121: the yc3123
device modules in the vendor's web build inherit the same uploader class,
fed column-major RGB565 high-byte-first data by the same
`cImageDataToScreenData`, and the same announce builder writing the u32
length split the firmware reads.

`0x2C` and `0xAC` set the same flag (bit 0 of `0x20166`), replicating the
yc3121 pairing; `0xAC` additionally preloads the `AA AA 55 55` reply. The
erase rule below covers yc3123 unchanged.

### Drawing, ry5088 gen2 [FW]

These boards do hand the frame to a separate display chip, but that chip's
own firmware parses the layout sharkfin already builds. Evidenced from both
ends of the link: the keyboard image (device 2454, `v413_oledv111`,
dispatch `0x152A0`) and the display chip image shipped beside it,
`firmwareOledFile.bin`, which loads at `0x01000000`.

The keyboard is a repackager. It wraps part of the host packet in its own
link frame:

| offset | meaning |
|---|---|
| `[0]` | `0x55` sync |
| `[1..2]` | length u16 LE, counting the type byte, payload and checksum |
| `[3]` | type |
| `[4..]` | payload |
| `[3+len]` | checksum, `sum` of bytes 1 to `3+len-1` |

| host opcode | builder | type | payload |
|---|---|---|---|
| `0xA5` announce | `0x15A48` | 3 | host packet `[0..11]` |
| `0x25` data | `0x159E2` | 4 | host packet `[0..63]`, `[0]` replaced |

The chip validates the frame at `0x10149DA` and dispatches on the type at
`0x10148CA` through a jump table at file offset `0x148F0`. Type 3 reaches
the announce handler at `0x101460C`, type 4 the page handler at
`0x1014476`. Those handlers read the same fields as the other families:
`[1]` frame, `[2]` count, `[3]` delay, `[4]`,`[5]` length u16, `[8..12]`
the box, and for pages `[4]`,`[5]` page index, `[6]` page length, data at
`[8]`, 56 bytes, streamed through ten 4096-byte banks.

Two limits follow from the forwarding. The keyboard copies only twelve
bytes for the announce, so the chip never sees `[16]`,`[17]` and the length
is a **u16**. The box is read from its low bytes and turned into a size by
subtraction, so a panel over **255 px** in either direction arrives at the
wrong size: three registry boards (3728, 4051, 4161, all 320 px wide) are
refused on that ground.

Mode 24 is refused on gen2 because the dispatcher has no `0x29` or `0xA9`
case at all.

One hazard has no counterpart in the other families. Both link builders
begin by testing a busy bit and, when it is set, drop the frame without
telling the host, so a page sent while the previous one is still going out
is lost silently. The bit is cleared when the transfer completes. The page
gap sharkfin uses is the same one the vendor's own uploader uses for these
boards, and is not otherwise evidenced.

The other gen2 lineages (`ry6602`, `ry6609`, `pan1086`) are still refused.
Only ry5088 keyboard firmware was read, and a shared family is not
evidence.

### The dangerous byte

`0xAC` must be treated as the flash chip erase in both families. On gen2
it erases every picture and takes about 55 seconds. The vendor's yc500
table lists it as a read, but the RT100 firmware disagrees: its `0x2C` and
`0xAC` handlers set the same flag (bit `0x20` at `0x2050C+2`), and the
routine that consumes the flag sends the display chip the same command,
`0x25`, for both. `0xAC` differs only in preloading an `AA AA 55 55`
reply. The Dynatab75X image has the same structure (one flag, bit `0x80`
at `+4`, set by both handlers). Whatever one opcode starts, the other
starts too, so neither may be sent blind. Twenty opcodes in total mean
different things in the two families.

yc500 defines a larger set gen2 has no entry for: `0x20`/`0xA0` picture
index, `0x21`/`0xA1` picture data, `0x24`/`0xA4` animation data,
`0x26`/`0xA6` animation index, `0x2A` weather, `0x2B`/`0xAB` effect,
`0x30`/`0x31` boot logo. Both share `0x22` display options, `0x27` display
language and `0x28` clock.

## Battery

No HID command found. The vendor reads it through a separate helper
process, suggesting another channel.

## Gotchas

- **A reply does not mean the hardware exists.** Firmware is shared across
  the family and answers for parts that aren't fitted. Use the registry.
- **A read does not always reflect a write.** `GET_USERPIC` returns stale
  data; `GET_MACRO` does not. Establish it per command.
- **An unsupported command returns the previous reply**, not an error.
  Compare against the preceding response, not against zero.
