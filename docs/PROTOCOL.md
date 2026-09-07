# ROYUAN keyboard HID protocol

64-byte HID feature reports on the vendor collection. Two command families
share opcodes that mean different things. Resolve the family from the
device record, never from the USB product ID.

sharkfin speaks a subset of this and never flashes firmware. Nothing here
is needed to use the app.

Evidence markers:

| | |
|---|---|
| **[HW]** | a plugged-in board |
| **[FW]** | read from a named firmware image |
| **[JS]** | vendor host code only, never exercised |

Images cited: `2268_v309` (X65HE, gen2), `1379 v108_oledv104` (EPOMAKER
RT100, yc500), `1723 v102_oledv103` (EPOMAKER Dynatab75X-UK, yc500),
`1996 v113_oledv102` (yc3121), `2454 v413_oledv111` (Keydous NJ81-CP,
gen2), `2730 v115_oledv108` (AttackShark K86, yc3123), `2936
v113_oledv106` (Hator HTK4100UA, yc3123). Bootloader: first 20 KB of the
1724 image, load `0x01000000`.

## Transport

| | |
|---|---|
| Collection | usage page `0xFFFF`, usage `2`; the Akko ACR75 v2 (device 606) reports usage `1` on the same page **[HW]**, and the vendor's own driver filters for both **[JS]** |
| Reports | 64 bytes, feature, report ID 0, both directions |
| Link | wired USB, or the 2.4 GHz receiver through the relay below. Not every receiver relays: the Typhoon Ultimate TKL's (device 2045) does not **[HW]**. Bluetooth does not expose the collection **[HW]** |

USB VID `0x3151` is common. Other vendor IDs occur. They are not part of
the HID layout.

GET replies echo the opcode in byte 0, except bulk page reads (keymatrix,
Fn layer, macro, userpic), which return raw page bytes. **[HW]**

### 2.4 GHz receiver

The receiver (`3151:4011` on an X86) enumerates the same collection. It
answers its own opcodes itself and relays anything else to a selected
device. **[HW]** Receiver opcodes are Bit7. Their replies do not echo the
opcode.

| opcode | | |
|---|---|---|
| `0xF7` | status | reply below |
| `0xF6` | select relay target | `[0xF6, 10]` keyboard **[HW]**, `5` mouse, `13` both **[JS]** |
| `0xFC` | release a relayed reply for reading | bare opcode **[HW]** |
| `0xF1` | receiver id, u16 LE at `[1]` | only receivers in the vendor's own table; `4011` is not in it **[JS]** |
| `0xF0` | receiver USB version | `[1]`, `[2]` **[JS]** |
| `0xFB` | receiver RF version | `[3]` **[JS]** |

Status reply:

| byte | |
|---|---|
| 0 | `1` when a relayed reply is waiting **[HW]** |
| 1 | keyboard battery, percent **[HW]** |
| 2 | mouse battery **[JS]** |
| 3 | keyboard online when `0` **[HW]** |
| 4 | mouse online when `0` **[JS]** |
| 5 | `1` when the receiver will accept a command to relay **[HW]** |
| 6 | `1` keyboard, `2` mouse, `3` both **[HW]** |
| 7, 8 | RF boot flags: both `1` in boot, both `0` done **[JS]** |

Relayed exchange **[HW]**:

| step | |
|---|---|
| 1 | poll `0xF7` until `[5] == 1` |
| 2 | `[0xF6, 10]` |
| 3 | the keyboard packet, with its usual checksum |
| 4 | poll `0xF7` until `[0] == 1` |
| 5 | `0xFC` |
| 6 | GET returns the keyboard's reply, opcode echoed |

The vendor allows five polls of 100 ms at steps 1 and 4 and pauses its
two-second status loop around each exchange. **[JS]** A reply is ready
about 100 ms after the send, and the receiver accepts the next packet
about 70 ms after a write. **[HW]**

Without step 2 a keyboard packet is dropped and a keyboard GET returns
the receiver's previous reply. A SET leaves no reply waiting.

Round-tripped through the relay on an X86 (yc500), each write read back
and restored **[HW]**:

| | |
|---|---|
| reads | `0x8F`, `0x80`, `0x85`, `0x86`, `0x87`, `0x89` pages, `0x8B` pages, `0x91`, `0x92`, `0x97` |
| writes | `SET_LEDPARAM`, `SET_PROFILE`, `SET_KEY_ONE`, `SET_MACRO` pages, `SET_DEBOUNCE`, `SET_SLEEPTIME`, `SET_KBOPTION`, `SET_AUTO_OS` |
| by eye | `SET_USERPIC`, seven pages, shown by mode 13 |
| not sent | `SET_SLEDPARAM`, screen frames (the X86 has neither), reset |

sharkfin sends screen frames and reset by cable only. The vendor's own app
disables picture upload in wireless mode. **[JS]** The keyboard itself does
not care: in the RT100 and X85PRO images, reports from the radio link and
from USB are copied into one buffer and dispatched through one tree, and the
announce and page handlers exist once each and test no channel. **[FW]**

`SET_KEY_ONE` through the relay lands only when its profile byte names
the active profile; aimed at another profile it changes nothing. The
stall cadence over the relay is not measured.

## Checksums

`0xFF - (sum & 0xFF)`. **[HW]**

| mode | covers | stored at | used by |
|---|---|---|---|
| Bit7 | 0..=6 | byte 7 | app-mode commands other than the two below |
| Bit8 | 0..=7 | byte 8 | `SET_LEDPARAM`, `SET_SLEDPARAM` |
| none | | | USB boot data path. OLED/TFT data reports. **[JS]** **[FW]** |

yc3123 keyboard firmware checks Bit7/Bit8 with this same split before
dispatch (`2730` at `0x133b0`, `2936` at `0x1357c`). **[FW]**

## Families

Two command sets. Opcodes collide: yc500 `SET_KEYMATRIX` is gen2
`SET_KBOPTION`, yc500 `SET_KBOPTION` is gen2 `SET_DEBOUNCE`, yc500
`SET_DEBOUNCE` is gen2 `SET_SLEEPTIME`. A misaddressed write lands on a
live register.

| command | yc500 | gen2 | payload |
|---|---|---|---|
| identify | `0x8F` | same opcode | same |
| revision | `0x80` | same opcode | same |
| LEDPARAM set/get | `0x07`/`0x87` | same opcode | same |
| SLEDPARAM set/get | `0x08`/`0x88` | same opcode | same |
| USERPIC set/get | `0x0C`/`0x8C` | same opcode | **different header** |
| FN set/get | `0x10`/`0x90` | same opcode | **different shape** |
| macro get | `0x8B` | same opcode | same |
| auto-OS set/get | `0x17`/`0x97` | same opcode | same |
| reset | `0x02` | `0x01` | bare opcode |
| profile set/get | `0x05`/`0x85` | `0x04`/`0x84` | same shape |
| keymatrix set/get | `0x09`/`0x89` | `0x0A`/`0x8A` | **different shape** |
| debounce set/get | `0x11`/`0x91` | `0x06`/`0x86` | value at a different byte |
| sleep set/get | `0x12`/`0x92` | `0x11`/`0x91` | GET offset differs |
| options set/get | `0x06`/`0x86` | `0x09`/`0x89` | yc500 bitfield; gen2 decoded fields, meanings unestablished |
| macro set | `0x16` | `0x0B` | same shape |
| single-slot key write | `0x13`/`0x15` | via keymatrix opcode | |
| report rate | absent **[JS]** | `0x03`/`0x83` GET **[HW]** | |

GET opcodes in both columns **[HW]**. Flash maps, commit rules, handler
addresses and write shapes that name an image stay **[FW]**.

## Identify [HW]

`0x8F` → `[0x8F, id:u32 LE, …]`.

## Keymap

128 slots × 4 bytes = 512 per layer. Reads are eight raw 64-byte pages,
indices 0..7.

### yc500 [HW]

| | layout |
|---|---|
| read `0x89` | `[profile, page]`, page 0..7, raw 64-byte replies |
| Fn read `0x90` | `[profile, page]`, same |
| write slot `0x13` | `[profile, slot]`, value at bytes 8..12 |
| Fn write `0x15` | `[profile, slot]`, value at bytes 8..12 |
| bulk `0x09` **[JS]** | `[profile, 0xF8, 1, page]` + 56 bytes, 9 pages |

The vendor bulk loop sends 9 × 56 = 504 of the 512 bytes; slots 126..127
never transmit.

On yc500, `0x8A` (the gen2 keymatrix GET) answers all `0xFF`, not an
echo. **[HW]** 1379 reads only the profile byte from a fixed table at
`0x23C18`. **[FW]**

### gen2

| | layout | |
|---|---|---|
| read `0x8A` | `[profile, 0xFF, page, os]`, page 0..7, raw 64-byte replies | **[HW]** |
| write slot `0x0A` | `[profile, slot, 0, 0, apply, os]`, value at 8..12 | **[FW]** |
| write bulk `0x0A` | `[profile, 0xFF, page, len, last, os]` + ≤56 bytes at 8, 10 pages | **[FW]** |
| Fn read `0x90` | `[os, profile, 0xFF, page]` | **[FW]** |
| Fn write `0x10` | `[os, profile, slot]`, value at 8..12 | **[FW]** |

`0xFF` in the sentinel byte selects bulk; any other value is a slot
index. `os` is the host layer: 0 win, 1 mac, 2 android, 3 ios.

`last` sets the commit-to-flash bit. On `2268_v309`, storage is
`0x08028800 + profile×2048 + layer×512 + slot×4` (four layers per
profile). Overwriting a slot holding Fn (`[0x0A,0x01,0,0]`) is
permitted. **[FW]**

A yc500-shaped write on this opcode is a different register. See Families.

### Slot values

| byte 0 | meaning | bytes 1..3 |
|---|---|---|
| `0x00` | HID usage | `[0, usage, 0]`; combos use bytes 1 and 3 |
| `0x01` | mouse button | |
| `0x03` | consumer usage | `[0, lo, hi]`; Vol+ = `[3,0,0xE9,0]` |
| `0x09` | macro | `[mode, index, 0]`; 0 repeat, 1 toggle, 2 hold |
| `0x0A` | special | `[1,0,0]` Fn, `[12,0,0]` power save, `[17,0,0]` Caps LED Swap |
| all zero | Fn layer: fall through to the base layer. Base layer: the key is dead | |

Which physical key is which slot is per board, not this protocol.

## Lighting

Opcode shared. Packet **[HW]**.

`SET_LEDPARAM 0x07` (Bit8) / `GET 0x87`:

```
[op, mode, speed, brightness, (option<<4)|flags, R, G, B, ck8]
```

- Speed is a frame divider, inverted from the host's 0..4 scale. yc500
  takes 1..5: host 0 → wire 5, host 4 → wire 1 **[HW]**. gen2 takes 0..4:
  host 4 → wire 0. The 2268 renderer (`0x080083e8`) counts frames up to
  the byte before it advances, so 0 advances every frame and is the
  fastest; the vendor's gen2 class never sends 5 **[FW]**. Brightness
  direct, 0..4 on most boards; the light table says where it is wider.
- Flags nibble: `7` fixed colour, `8` rainbow. Modes 22/23 invert it
  (`0` rainbow, `4` fixed). One lineage swaps the two: the Akko ACR75 v2
  (device 606, firmware 3.03) has `7` rainbow and `8` fixed in every
  renderer (init `0x1014688` tests 7 for the hue walker where the RT100
  `0x101C9C0` and X85PRO `0x101C770` test 8; render `0x1015F90` against
  `0x101F4E4` / `0x101F16A`), all by exact compare. Its preset table is
  red, green, blue, orange, magenta, amber, warm white, and its SET handler
  (`0x1019604`) has no RGB clamp and no mode range guard, so it must never
  be sent a mode above 31. The registry marks such boards
  `ledFlagsSwapped`. **[FW]** Mode 13 puts a pattern slot in the option
  nibble and forces RGB `(0,200,200)`. That slot is the gen2 USERPIC
  slot; yc500 USERPIC has no slot byte. Mode 21 zeroes the flags byte.
- White `0xFFFFFF` transmits as `0xFAFAFA`.
- On GET, a flags nibble of 0..6 is a preset-colour index overriding RGB:
  red, orange, yellow, green, cyan, blue, magenta.
- RGB below `0x080808` renders as unlit **[HW]**. Backlight-off is an
  options bit, not a black write.

Wire modes, the same numbers in both families' device classes: 1 static,
2 breathing, 3 spectrum, 4 wave (4 dirs), 5 ripple, 6 star dots, 7 flow
(2), 8 key shadow, 9 layers, 10 sine, 11 spring (2), 12 neon (2),
14 radiant, 15 loop (2), 16 colour grid, 17 snowfall, 18 meteor,
19 silent snow, 23 train, 24 endless (2). Modes 13, 20, 21, 22 and 25
need host-side data. Which of these a board has, with its option list and
speed and brightness ranges, is per board: the vendor's light table
(`data/light-layouts.json`, keyed by the record's `lightLayout` name) lists
them **[JS]**. Most boards have 1..19; the Akko V5 HE lineage and its
siblings have 23 and 24 instead of the host-fed ones and only two wave
directions; the MK12 and MK14 take speed and brightness 0..7.

Caps LED Swap, key function `[0x0A, 17, 0, 0]`, lights that key white
while caps lock is active. No command sets the colour. A per-key pattern
underneath is ignored while the key is lit. **[HW]**

### Timing [FW]

Read from `3708_v507` (H60 Pro, ry5088 gen2, base `0x08000000`) and
`1379_v108` (RT100, yc3121 yc500, base `0x01000000`; its data section
sits `0x200` earlier in the OTA file than in flash). Both families render
on a 5 ms tick.

| | gen2 | yc500 |
|---|---|---|
| tick | timer `0x40001000`, period `0x7c`, prescale `0xd7` (`0x0801939c`); tick fn `0x08013d18` bumps a pending count at `0x200103e0`, dispatcher `0x08008310` drains it | 1 ms flag at `0x20cc0+0xc`; every 5th sets `+0xd`, main loops (`0x01015bc6`, `0x0101644a`) then run `0x010204da` |
| 5 ms proof | task block every 2 ticks, `0x08017d30` counts 100 blocks, `0x08017d62` then decrements sleep in seconds (config `+0x16`) | `0x01015fd6` adds 1 per flag and compares with sleep × 1000 (`0x01016150`) |
| mode table | `0x08008330`, 25 entries; 1 `0x0800a878`, 2 `0x0800cc6c`, 3 `0x0800b544`, 4 `0x0800b2d0`, 5 `0x0800bd14`, 6 `0x0800af14`, 7 `0x08008b98`, 8 `0x0800baf8`, 9 `0x080097a4`, 10 `0x08009bb8`, 11 `0x0800c81c`, 12 `0x08009a04`, 14 `0x08008e6c`, 15 `0x0800b01c`, 16 `0x08009f00`, 17 `0x0800a948`, 18 `0x0800a250` | switch8 `0x0101f666`/`0x0101f6be`; 1 `0x0101f4e4`, 2 `0x0101f294`, 3 `0x0101f214`, 4 `0x0101ef88`, 5 `0x0101eefe`, 6 `0x0101ed28`, 7 `0x0101eae0`, 8 `0x0101e998`, 9 `0x0101e56c`, 10 `0x0101e47e`, 11 `0x0101e0d8`, 12 `0x0101df98`, 14 `0x0101ee74`, 15 `0x0101e23a`, 16 `0x0101dd32`, 17 `0x0101da6a`, 18 `0x0101dbcc`, 19 `0x0101e6f6` |
| per-mode store | config `0x2000f328`: `+8` mode, `+0x22` speed[32], `+0x42` brightness[32], `+0x62` flags[32], `+0x82` rgb[32][3] (`0x08014374`) | config `0x21cc0`: `+0x1a` mode, `+0x40` speed[32], `+0x60` brightness[32], `+0x80` flags[32], `+0xa0` rgb[32][3] (`0x010249fa`) |
| framebuffer | 6 rows × 24 columns × 4 bytes at state `+0x98` | 6 rows × 18 columns on this board |
| presets, flags 0..7 | `0x0801cf10`: red, `ff7f00`, yellow, green, cyan, blue, magenta, white | `0x1036910`: red, `ff8000`, yellow, green, cyan, blue, magenta, white |

gen2 speed, wire `w` 0..4, in frames:

| modes | rule |
|---|---|
| 1, 2, 14 | advance every `w` frames; 0 advances every frame |
| 2 | level bounces 0..100 by 8 per advance |
| 4, 6, 15 | move `6 - w` per frame |
| 3, 5 | event every `200 + 200w` |
| 4, 15 | spawn every `250 + 250w` |
| 7 | event every `100 + 100w` |
| 8 | event every `500 + 250w` |
| 12, 16 | counter seeded with `200w`, `150w` |

yc500 speed: each mode's apply routine reads its own six-word table by
wire `w` (0..5), all consecutive from `0x10362c4`. Breathing scales each
channel to `colour << 8 × pct / 100` with pct from `[0, 25, 50, 75, 100]`
(`0x10362bd`) by brightness, divides by the ramp to get the per-step
increment, and holds 20 steps at each end. Wire 6 and up read into the
next table, which is the out-of-range speed the X86 renders faster.

| mode | table | w = 0..5 | meaning |
|---|---|---|---|
| 2 breathing | `0x10362c4` | 10 40 60 80 100 200 | frames per ramp |
| 3 spectrum | `0x10362dc` | 5 4 3 2 1 0 | hue step every 2 frames; 0 stands still |
| 4 wave, 11, 12, 15 | `0x10362f4` … | 5 4 3 2 1 0 | hue step + 1 per frame, per column |
| 5 ripple, 14 radiant | `0x103630c` | 5 7 9 11 13 12 | frames per step |
| 6 star dots, 7 flow | `0x103634c` | 5 10 15 20 25 12 | frames per step |
| 9 layers | `0x1036394` | 2 3 5 7 9 11 | frames per script step |
| 10 sine | `0x10363b4` | 5 7 10 14 17 20 | frames per step |
| 16, 18 | `0x103641c` | 2 2 2 2 2 2 | frames per step |

The hue walker (`0x0102075c`) ramps one channel by the step to 255 then
the next, six ramps per turn. Layers (mode 9, stepper `0x0101e56c`) plays
a script: a count table at `0x1035dac` (per step, 255 = pause five steps
and change colour, 0 = rest 25 steps and restart) and a row-column list at
`0x1035c64` on a 6 × 18 grid. Sine (mode 10, `0x0101e47e`) births one
dot per step on a row from a 30-entry table and runs it out both ways one
column per step.

### Edge light

Same byte layout as LEDPARAM. Speed is **not** inverted.

Modes: 0 off, 1 static, 2 breathing, 3 neon (forces the rainbow nibble),
4 wave, 5 snake.

`GET 0x88` is answered on a board with no edge LEDs. **[HW]** Presence
is not that reply; it is the device record.

## Profiles

GET returns the current index in `reply[1]`, zero based. SET writes one
byte. There is no command for how many profiles exist.

| | SET | GET |
|---|---|---|
| yc500 **[HW]** | `0x05` | `0x85` |
| gen2 **[HW]** | `0x04` | `0x84` |

Switch to a profile before writing its keymap. A SET of the other
family's opcode is a different register.

## Settings

### Debounce

Range 1..10. Same offset in SET and GET.

| family | opcode SET/GET | value at byte |
|---|---|---|
| yc500 **[HW]** | `0x11`/`0x91` | 2 |
| gen2 | `0x06`/`0x86` **[HW]** | 1 **[FW]** |

yc500 pads with a zero at byte 1. Sending that shape to gen2 writes
debounce 0.

### Sleep timers

Four u16 LE seconds: sleep BT, sleep 2.4G, deep BT, deep 2.4G.

```
yc500 SET 0x12  bytes 8..15                    [HW]
yc500 GET 0x92  bytes 1..8   (not the SET offsets)  [HW]
gen2  GET 0x91  bytes 8..15                      [HW]
gen2  SET 0x11  bytes 8..15                      [FW]
```

### Options bitfield, yc500 [HW]

`SET 0x06` / `GET 0x86`. Reply byte 2: `1` Win lock, `2` Mac mode, `8`
WASD swap, `16` backlight off, `32` side light off, `64` keyboard mode,
`128` keyboard lock. Byte 3 Fn matrix flag, byte 4 power save.
Read-modify-write to keep unmodelled bits.

Bit `128` locks the keyboard. The vendor's setter writes Mac mode at bit
1 while its getter reads bit 0. **[JS]**

### Other

| | |
|---|---|
| Firmware revision | `GET 0x80` → `(reply[2]<<8) \| reply[1]` |
| Factory reset | yc500 `0x02`, needs ~4 s **[HW]**. gen2 `0x01` **[FW]** (`2268_v309`). Bare opcode. |
| Auto-OS | `SET 0x17 [0\|1]`, `GET 0x97` → `reply[1] == 1` |
| Report rate | gen2 GET `0x83` **[HW]**. SET `0x03` **[FW]**. yc500 vendor setter is a stub returning false **[JS]** |
| gen2 options | `GET 0x89` **[HW]**. Decoded fields at bytes 1..4, meanings unestablished **[FW]** |

## Macros

50 slots × 256 bytes **[HW]**. Opcode differs; packet shape does not.

Write `0x16` (yc500) / `0x0B` (gen2), Bit7, one report per 56-byte page:

| byte | |
|---|---|
| 0 | opcode |
| 1 | slot |
| 2 | page |
| 3 | `56` |
| 4 | `1` on the final page |
| 8.. | 56 payload bytes, zero-padded |

The vendor sends only the prefix of pages that contain a non-zero byte.
**[JS]**

Blob: u16 LE repeat count, then a strictly alternating event/delay
stream.

- key / mouse button: `[code, pressed<<7 \| delay]`, or
  `[code, pressed?0x80:0, delay u16 LE]` when delay is 0 or > 127 ms
- mouse move: `[0xF9, delay, dx i8, dy i8]`
- mouse buttons `0xF0`..`0xF4`; key codes are HID usages `0x04`..`0xEF`
- four zero bytes terminate

Read `0x8B`: `[slot, page]`, pages 0..3, raw 64-byte replies. Read-back
is faithful **[HW]**.

Bind with keymap slot value `[0x09, mode, index, 0]`.

## Per-key colour

`SET_USERPIC 0x0C` uploads RGB triples in matrix order as seven pages
with data from byte 8. The opcode is shared; the header is not.

| byte | yc500 [HW] | gen2 [FW] |
|---|---|---|
| 1 | `0` | slot |
| 2 | length low | `0xFF` |
| 3 | length high | page, 0..6 |
| 4 | page, 0..6 | page length: 56, then 42 |
| 5 | `0` | `1` on the final page |
| total | 384 (128 keys) | 378 (126 keys) |

Display it by selecting light mode 13. On gen2 the mode's option nibble
is the USERPIC slot.

gen2 (`2268_v309`, handler `0x8010db8`): a page is copied only when byte
2 is `0xFF`, staged at page × 56, and committed to flash at
`0x0802f800 + slot × 384` when page 6 carries the final flag. A packet
whose byte 2 is not `0xFF` skips the copy but still triggers the commit.
The firmware bounds-checks neither page nor length.

`GET_USERPIC 0x8C` returns stable data that does not reflect writes.
Treat as write-only. **[HW]**

Uploads land in flash. Repeated uploads stall the control endpoint:

| cadence | result |
|---|---|
| 7 reports / 500 ms | endpoint dies after ~13 reports |
| 7 reports / 3 s | 42 reports, still responsive |
| 2 uploads / 5 s, pages 40 ms apart, mode switch 600 ms after | stalled on the second |
| 2 uploads / 10 s, pages 100 ms apart, 2 s settle, no redundant mode switch | survives |

A stalled endpoint fails every report (`ioctl (SFEATURE): Protocol
error`) and does not recover on reopen. The device needs USB
re-enumeration. Individual reports needed ~12 ms spacing. **[HW]**

This cadence is not evidenced on gen2. The gen2 commit-to-flash behaviour
above is.

## Magnetic switches [FW]

Two column formats share the opcodes and packet shapes. Which one a board
has follows its family; whether it has columns at all follows its
firmware.

| | gen2 | yc500 |
|---|---|---|
| images read | 2268 X65HE `v309`, 2116 TITAN68HE `v304`, 3708 SK61HE `v507` | 1618 ER75 `v200`, 1466 K85 `v107` |
| columns | from every image | from firmware 2.00 (`0x80` reply `02 00`); 1.07 has no `0x65` or `0xE5` |
| slots a column | 128 | 126 (21 rows of 6) |
| travel columns | u16 little-endian, hundredths of a millimetre | one byte, tenths, offset by one (below) |
| write evidenced for | `ry5088_` lineage | `yc3121_` lineage |
| profiles on the wire | as is | `profile * 4 + sublayer` (below) |

Settings are columns, one per sub-op, indexed like the keymap.

| | layout |
|---|---|
| read `0xE5` | `[subop, 1, page]`, Bit7; reply is the raw page, no echo. u16 columns 4 pages of 32 values, byte columns 2 pages of 64 |
| write one `0x65` | `[subop, 0, slot, last]`, Bit7, value at 8 (lo) and 9 (hi) |
| write all `0x65` | `[subop, 1, page, last]`, Bit7, 56 bytes at 8: 28 u16 a page over pages 0..4 (page 4 holds 16), or 56 bytes over pages 0..2 (page 2 holds 16 on gen2, 14 on yc500) |

| sub-op | column | gen2 | yc500 (1618 offset from `0x20c9c`) |
|---|---|---|---|
| 0 | actuation travel | u16 | `0x82d` |
| 1 | release travel | u16 | `0x8ab` |
| 2 | rapid trigger press step | u16 | `0x929` |
| 3 | rapid trigger release step | u16 | `0x9a7` |
| 4 | dynamic keystroke first point | u16 | `0xa25` |
| 5 | mod-tap hold time, 10 ms units | u8 | `0xc9b` |
| 6 | bottom dead zone | u16 | `0xd19` |
| 7 | key mode: bit 7 rapid trigger; bits 0..6 the kind (below) | u8 | `0x7af` |
| 8 | dynamic keystroke actions, four bytes, write one slot only | 4 x u8 | `0xaa3` + n*126 |
| 9 | snap partner slot | u8 | `0xd97` |
| 10 | every key's dynamic keystroke actions, read only, 8 pages | 4 x 128 u8 | 4 x 126 u8, two pages a block |
| 251 | top dead zone, 3708 only | u8 | absent |
| 252 | switch type, values 0..5, anything else stored as 0 | u8 | absent |
| 254 | live press travel, read only | u16 | absent |

| kind | meaning |
|---|---|
| 0 | plain |
| 2 | dynamic keystroke |
| 3 | mod-tap: sub-layer 0 held, sub-layer 1 tapped |
| 4 | toggle |
| 5 | toggle, repeating |
| 7 | snap |

Neither handler checks anything else. A bulk page past the column or a
slot past the end writes into the neighbouring column, so the bounds are
the host's job. `last` set on a packet raises a flag; a deferred routine
saves the block to flash and re-runs the apply. Packets without `last`
sit in RAM unapplied and unsaved.

### gen2

2268 handlers: `0xE5` at `0x08006414`, `0x65` at `0x08006770`, save
`0x0800d954`, apply `0x0800dc1c`. 2116 and 3708 match in shape. The save
erases `0x08033800 + profile << 12` and the page after it, programs 4096
bytes from the mode column through a `55 AA` marker, and re-applies. The
apply clamps: travel below 10 becomes 15, a rapid-trigger step of 0
becomes 1, a bottom dead zone above 340 becomes 30. Defaults are 200
travel, 280 release, 50 for both steps and the first point, 30 dead zone,
0 mod-tap time, 255 snap partner.

`0xE6` (the vendor's precision read) is not handled by any of the three
images; the reply is the echoed request. The vendor's driver falls back to
0.01 mm for such boards, which is what the firmware uses.

#### Keymap sub-layers

Each profile holds four 512-byte keymaps. Sub-layer 0 is the keymap; the
kinds above act on 1..3. The RAM copy is `base + sublayer * 512 + slot *
4` (keycode emit `0x0800f9d0`); flash is `0x08028800 + profile * 2048 +
sublayer * 512`.

| | layout |
|---|---|
| write one `0x0A` | `[profile, slot, 0, 0, last, sublayer]`, Bit7, entry at 8..11. Handler `0x08006f10`: byte 6 shifted by 9 picks the block, byte 5 sets the commit flag |
| write all `0x0A` | `[profile, 0xFF, page, len, last, sublayer]` + 56 bytes |
| read `0x8A` | `[profile, 0xFF, page, sublayer]`; handler `0x08010d08` reads `profile << 11 | sublayer << 9` out of flash |

#### Dynamic keystroke (2268 engine `0x0800c8a4..0x0800cccc`)

Two points: the first is sub-op 4, the second sub-op 0. A live travel of
320 counts as the second point when the column says more. Four events, in
order: A press past the first point, B press past the second, C release
past the second, D release past the first. Each of the four action bytes
belongs to a sub-layer and holds one 2-bit cell per event, cell 0 for A.
At an event the engine reads that event's cell and the one before it:

| cell value | at its own event | at the next event |
|---|---|---|
| 0 | nothing | |
| 1 | press, then release after 1..10 ticks (a tap) | |
| 2 | press | release |
| 3 | press | stays down if this cell is 3 too, else released |

D clears every hold. A hold from A to C is therefore `3, 2, 0, 0`; a tap
at B is `0, 1, 0, 0`. The key pressed is the sub-layer's entry for the
slot.

#### Mod-tap (2268 `0x0800d190`, tick `0x0800ee82`)

Sub-layer 0 is the hold, sub-layer 1 the tap. The tick counts while the
key is down and compares against the mod-tap byte doubled
(`0x0800eeaa`), so the byte is 10 ms at the 5 ms tick; released before
that, the tap key is pressed and released. Movement under 0.30 mm is
ignored.

#### Toggle (2268 `0x0800e934`, `0x0800ea70`, tick `0x0800f4fe`)

A press latches sub-layer 0's key down, the next press releases it. Held
past 60 ticks the key acts as plain and releases with the finger. Kind 5
adds a repeat: the latched key is pressed and released every 8..17 ticks
(`0x0800f664`).

#### Snap (2268 `0x0800e228`)

The partner slot is stored as row and column (`slot / 6`, `slot % 6`, apply
`0x0800dd7a`). Pressing a snap key releases its partner if the partner is
down; releasing it presses the partner again if the partner is still held.
Both keys carry kind 7 and each other's slot.

Never sent: `0x1C` and `0x1E` are sensor calibration. On, they zero the
stored travel tables in RAM; off, they save them to flash, so on-then-off
without pressing every key commits zeroed tables. `0x7F 55 AA 55 AA` erases
the keymap block and the switch-settings block and enters the bootloader.

### yc500

1618 handlers: `0x65` at `0x01017de6`, `0xE5` at `0x01018152`, save
`0x01014984`, apply `0x010144bc`, evaluator `0x01014e9c`. Columns are
bytes at the offsets in the table above, 126 slots each. `0xE5` copies
64 bytes from `column + page * 64`, so the second page carries two bytes
of the next column. `last` programs 2048 bytes from the mode column into
`0x01080000 + (profile >> 2) * 0x5000`, re-runs the apply and forces
preset 3.

The apply copies bytes unchanged. The evaluator compares them with live
travel in tenths of a millimetre from the top:

| column | fires when | vendor shows |
|---|---|---|
| actuation, first point, rapid trigger steps | live travel exceeds the byte (`0x01015244`, `0x10152ee`) | `(b + 1) / 10` mm; first point `(b + 2) / 10` |
| release | live travel at or below the byte (`0x1015374`) | `(b + 1) / 10` |
| bottom dead zone | live travel exceeds the byte counts as bottomed out (`0x10152b0`) | `(40 - (b + 1)) / 10` mm from the bottom; the 40 is the vendor's, not the firmware's |

Defaults with no saved block (`0x010144fe`): 18 travel, 28 release, 2
for both steps and the first point, 33 dead zone, 30 mod-tap, 255 snap
partner. Rapid-trigger steps below 2 are read as 2 (`0x01014f80`).

| opcode | |
|---|---|
| `0x1D [preset]` | 0 comfort (18/28), 1 sensitive (3/18), 2 gaming (3, rapid trigger 3/3), 3 the columns. Tables at `0x01014ee4..0x01014f00`. Stored and re-applied, not saved |
| `0x9D` | reply `[9D, preset, 0 x6]` |
| `0x1A` | one record for every key (byte 5 set) or one slot (byte 6). Handler `0x01017d76`, apply `0x010146f2`: 3 mode, 4 travel, 8 release, 9 and 10 steps, 11 first point, 12..15 actions, 16 mod-tap, 25 dead zone. Bytes 1 and 2 are stored and never read. For every key, the mode replaces plain keys and sets only the rapid-trigger bit on dynamic ones. Saves and forces preset 3 |
| `0x9F` | reply of the eight bytes `0x1F` set; unrelated to travel |

1466 (K85 `v107`) has `0x1A`, `0x1D`, `0x9D` and the same apply shape
(`0x01010ad4`) with no `0x65` or `0xE5`, so its settings can be written
and not read. Unknown opcodes are dropped.

Profiles: `0x05`, `0x09`, `0x13` and `0x89` take `profile * 4 + sublayer`
on every magnetic yc500 board (`0x89` reads `base + byte1 * 512`, the
switch block is `slot >> 2`), and `0x85` answers the same number. The Fn
layer opcodes take the profile as is.

## Destructive opcodes

Live writes. Do not send on an unknown family. Do not send them as a
GET.

| opcode | |
|---|---|
| `0xAC` | flash-chip erase in both families. See Screens. |
| `0x2C` | yc500 display erase, same flag as `0xAC` on the images that were read |
| `0x7F` | USB boot entry, only with trailer `55 AA 55 AA`. See Flashing |
| `0x30` | display-chip boot entry, same trailer. See Flashing |

`0xAD` is a GET of the display's own firmware version. It means the same
in both families. A board that answers has a display; one that echoes
does not. It is not an erase and not boot entry.

## Screens

Whether the keyboard parses a frame, forwards it, or has no evidenced
parser follows firmware lineage, not family. Geometry is per board, from
the vendor record at `other.screen`: `size.w`, `size.h`, `mode` and
`layer`. Mode `16` is RGB565. Mode `24` is three bytes a pixel (small
LED matrices, not a panel). Nothing may assume a default size.

### Drawing, yc500 [FW]

Evidenced against two images, one per pixel mode: RT100 (device 1379,
`v108_oledv104`, mode `16`) and Dynatab75X-UK (device 1723,
`v102_oledv103`, mode `24`, a 60×9 matrix). The RT100's dispatch is a
comparison tree at `0x24C00` over a 42-entry jump table at `0x24C2A`.
Decoding that table yields the same opcodes for four commands already
verified on hardware (`0x09` keymap, `0x0C` per-key colour, `0x11`
debounce, `0x12` sleep).

| step | opcode | RT100 handler | Dynatab handler | payload |
|---|---|---|---|---|
| announce, mode 16 | `0xA5` | `0x23F1E` | rejected | `[1]` frame, `[2]` frame count, `[3]` delay, `[4..6]` length u16 LE, `[8..12]` bounding box |
| data, mode 16 | `0x25` | `0x23FB6` | rejected | 8-byte header, `[4..6]` page index, `[6]` page length, data at `[8]`, 56 bytes |
| announce, mode 24 | `0xA9` | rejected | `0x2311C` | as the mode 16 announce |
| data, mode 24 | `0x29` | rejected | `0x231AA` | as the mode 16 data |

Each image implements exactly the pair its vendor record's mode declares
and sends the other pair to its reject entry. The record's mode picks
the pair.

- The RT100's announce returns immediately unless a flag at `+27` is set.
  Poll until `reply[1]` is 1.
- Bytes 12 to 18 are never read, in either image: the box exists only as
  its low bytes, the length only as its u16, and the `layer` byte is
  ignored. A frame past 65535 bytes does not fit that field.
- The u16 is a yc3121 trait. Device 1996 (`v113_oledv102`) reads the
  announce the same way. yc3123 reads a u32; see below.
- The announce erases nothing. It resets counters.
- Page handlers check `[1]` against the announced frame and count bytes
  against the announced length. A disagreeing page is dropped.

Pixel order **[JS]**: column major, sorted by x then y, RGB565 high byte
first in mode `16`, plain RGB triples in mode `24`.

### Drawing, yc3123 [FW]

yc3123 boards sit in the gen2 family. The keyboard firmware parses
frames itself. Evidenced against two images: AttackShark K86 (device
2730, `v115_oledv108`) and Hator HTK4100UA (device 2936,
`v113_oledv106`), both 240×135 mode `16`. Addresses below are 2730 then
2936. The vendor record names them by `internalName` prefix `yc3123_`.

The dispatcher (`0x22174` / `0x23f3c`) verifies the checksum (`0x133b0` /
`0x1357c`) before dispatching: Bit7/Bit8 as in Checksums. A failed packet
is rejected. The verifier is called on the buffer at offset 2, so packet
index = buffer offset - 2 for everything below.

| step | opcode | 2730 | 2936 | payload |
|---|---|---|---|---|
| announce | `0xA5` | `0x120dc` | `0x121f0` | as yc500, plus: length u32 from `[4]`, `[5]`, `[16]`, `[17]`; box high bytes from `[14]`, `[15]` |
| data | `0x25` | `0x12b6c` | `0x12ccc` | as yc500: `[1]` frame, `[4..6]` page index u16 LE, `[6]` page length, data at `[8]`, 56 bytes |

Both images reject `0xA9`/`0x29`, matching their records' mode `16`. Two
yc3123 records declare mode `24`; no image evidences that pair.

Pages stream through ten 4096-byte RAM banks with the announced length as
a countdown. Duplicate and out-of-order pages are dropped. The frame
goes to flash.

Both announce handlers return without doing anything unless a firmware
internal byte is set (`0x204e3` / `0x204e4`), written by display-init
routines and by no host command found. A frame sent while it is clear is
silently ignored. Poll the announce; treat silence as failure. The
vendor uploader polls `reply[1] == 1` up to ten times at 100 ms. **[JS]**
Replies echo the opcode at byte 0.

Pixel order **[JS]**: same as yc3121, with the announce builder writing
the u32 length split the firmware reads.

`0x2C` and `0xAC` set the same flag (bit 0 of `0x20166`). `0xAC`
additionally preloads the `AA AA 55 55` reply.

### Drawing, ry5088 gen2 [FW]

The keyboard forwards the frame to a display chip. That chip parses the
host layout. Evidenced from both ends: keyboard image 2454
(`v413_oledv111`, dispatch `0x152A0`) and `firmwareOledFile.bin`, load
`0x01000000`.

Keyboard link frame:

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
`0x1014476`. Those handlers read `[1]` frame, `[2]` count, `[3]` delay,
`[4]`,`[5]` length u16, `[8..12]` the box; pages `[4]`,`[5]` page index,
`[6]` page length, data at `[8]`, 56 bytes, streamed through ten
4096-byte banks.

The keyboard copies only twelve bytes for the announce, so the chip never
sees `[16]`,`[17]` and the length is a u16. The box is read from its low
bytes and turned into a size by subtraction, so a panel over 255 px in
either direction arrives at the wrong size.

The 2454 dispatcher has no `0x29` or `0xA9` case. That is this lineage,
not gen2 as a whole.

Both link builders test a busy bit and, when it is set, drop the frame
without telling the host. The bit clears when the transfer completes. The
vendor uploader spaces pages; that gap is not otherwise evidenced. **[JS]**

Other gen2 lineages (`ry6602`, `ry6609`, `pan1086`): no keyboard image
was read. A shared family is not evidence that they parse these packets.

### `0xAC` and `0x2C`

Treat `0xAC` as flash-chip erase in both families. On gen2 it erases
every picture and takes about 55 seconds.

RT100: `0x2C` and `0xAC` set the same flag (bit `0x20` at `0x2050C+2`).
The routine that consumes the flag sends the display chip `0x25` for
both. `0xAC` additionally preloads an `AA AA 55 55` reply. Dynatab75X:
one flag, bit `0x80` at `+4`, set by both handlers. Neither opcode may be
sent blind.

yc500-only in the vendor table, no gen2 entry: `0x20`/`0xA0` picture
index, `0x21`/`0xA1` picture data, `0x24`/`0xA4` animation data,
`0x26`/`0xA6` animation index, `0x2A` weather, `0x2B`/`0xAB` effect.
Both families: `0x22` display options, `0x27` display language, `0x28`
clock. `0x30`/`0x31` are display-chip boot in both families. See
Flashing.

## Flashing

A second HID dialect on a different product ID. sharkfin never sends any
of this. Host framing **[JS]** is from the vendor's base device class.
The dispatcher **[FW]** is from the 1724 bootloader (first 20 KB, load
`0x01000000`). Not round-tripped on hardware.

### Enter boot [JS]

App mode, Bit7:

| | report |
|---|---|
| USB | `[0x7F, 0x55, 0xAA, 0x55, 0xAA]` |
| RF | `[0xF8, 0x55, 0xAA, 0x55, 0xAA, 0, 0, 0x82]` |
| display chip | `[0x30, 0x55, 0xAA, 0x55, 0xAA, 0, 0, 0]` |

USB re-enumerates as a boot PID. The vendor's boot table:

| vid:pid |
|---|
| `3151:4036` |
| `3151:502a` |
| `3151:504d` |
| `046a:012e` |
| `046a:0130` |

Which PID a given board lands on is not established beyond that table.
A second vendor table adds `3151:5024`.

RF stays on the same USB path. Status opcode `0xF7`: the base class
treats boot as reply `[7]` and `[8]` both 1, and done as both 0.

### USB image transfer [JS] [FW]

Raw 64-byte reports, no Bit7. The host skips a prefix of the file and
sends the rest. The prefix is a host convention, not the 1724 write
address:

| class | skip |
|---|---|
| gen2 keyboard | 20480 |
| yc500 keyboard | 65536 |
| second vendor table (`3151:5024`) | 65536 |

| step | report |
|---|---|
| init | `[0xBA, 0xC0, cntLo, cntHi, len0, len1, len2]` |
| data | 64-byte chunks of the payload |
| verify | `[0xBA, 0xC2, cntLo, cntHi, s0, s1, s2, s3, len0, len1, len2, len3]` |

`cnt` is `ceil(len/64)`. `len` is the payload length, 24-bit. Checksum is
the plain byte-sum of the payload. The host sends four bytes; the
bootloader compares the low 24 bits.

Replies use opcode `0xAB`, second byte echoing `0xC0` or `0xC2`. Verify
sets byte 4 to `0x55` when the sum matches and on-chip read-back found no
errors, `0xAA` otherwise.

Dispatcher at `0x1000676`: `cmd = report[0] | report[1]<<8`. `0xC0BA`
calls init (`0x10005ac`). `0xC2BA` calls verify (`0x1000552`). Anything
else is ignored. Chunks are written on arrival at the flash-base
literal at `0x1000774` plus `index << 6` (`0x01010200` on the 1724
bootloader) with a 64-byte read-back compare. Only pass/fail and the
running error count leave over USB. There is no read command in boot
mode.

RF uses the same transfer from file offset 65536. **[JS]**

### Display chip and TFT [JS]

Stay in app mode. Bit7 on the command reports, no checksum on the data.

| | |
|---|---|
| OLED enter | `0x30`, as above |
| OLED poll | `0xB0` until it echoes and `reply[1] == 1` |
| OLED start | `0x31` plus the 16-bit chunk count |
| OLED data | 64-byte chunks from file offset 65536 |
| OLED verify | `0xB1` plus the byte-sum; success is `reply[1] == 0x55` |
| TFT probe | `0xB2` plus the page count; continue only if `reply[1] == 1` |
| TFT data | `0x32`, 56-byte pages |

### Hazards

| | |
|---|---|
| Sibling images | Same USB PID does not mean the same PCB. A wrong image that fails to run can leave the board unable to answer `0x7F`, so boot is unreachable without SWD. |
| No USB dump | The dispatcher has no read. Flash contents never come out over USB. |
| Bootloader is kept | The host never sends the file prefix above. A board that can still enter boot can be written again. The 1724 write base is `0x01010200`, which is not either skip. |
| `0x30` | Display-chip boot, not USB boot. |

## Battery

No command on the keyboard's own collection. Over 2.4 GHz the receiver's
status reply carries it, byte 1. See Transport. **[HW]**

## Gotchas

- **A reply does not mean the hardware exists.** Firmware is shared across
  a lineage and answers for parts that are not fitted. Use the device
  record.
- **A read does not always reflect a write.** `GET_USERPIC` returns
  stale data; `GET_MACRO` does not.
- **An unsupported command returns the previous reply**, not an error.
  Compare against the preceding response, not against zero.
- **App mode and boot mode are different HID dialects.** `0xBA` belongs
  on a boot PID. `0x7F` belongs in app mode, and only with the trailer.
- **Shared opcode is not shared payload.** USERPIC and FN are the
  examples. Sending the yc500 header on gen2 is a live write.
