# ROYUAN keyboard HID protocol

Reference for the wire protocol sharkfin speaks. Nothing here is needed to
use the app.

Evidence markers: **[HW]** round-tripped on an Attack Shark X86 (device
1967). **[FW]** read out of device firmware (`2268_v309`, Attack Shark
X65HE, gen2). **[JS]** vendor host code only, never exercised.

## Transport [HW]

| | |
|---|---|
| USB VID | `0x3151` |
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
| read `0x8A` | `[profile, 0xFF\|slot, page, os]` |
| write slot `0x0A` | `[profile, slot, 0, 0, apply, os]`, value at 8..12 |
| write bulk `0x0A` | `[profile, 0xFF, page, len, last, os]` + ≤56 bytes at 8, 10 pages |
| Fn read `0x90` | `[os, profile, 0xFF\|slot, page]` |
| Fn write `0x10` | `[os, profile, slot]`, value at 8..12 |

`last` sets the firmware's commit-to-flash bit. Storage is
`0x08028800 + profile×2048 + layer×512 + slot×4`, i.e. four layers per
profile. Overwriting a slot holding Fn (`[0x0A,0x01,0,0]`) is permitted.

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
registry's `sideLightLayout` (138 of 523).

## Profiles [HW]

`SET 0x05 [profile]`; `GET 0x85` → `reply[1]`. Three onboard.

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

## Per-key colour [HW]

`SET_USERPIC 0x0C` uploads 384 bytes (128 × RGB, matrix order) as seven
56-byte pages: length `384` at bytes 2-3, page index at byte 4, data from
byte 8. Display it by selecting light mode 13.

`GET_USERPIC 0x8C` returns stable data that does not reflect writes. Treat
as write-only.

**Uploads land in flash and stall the firmware if repeated.** Measured on
an X86:

| cadence | result |
|---|---|
| 7 reports / 500 ms | control endpoint dies after ~13 reports |
| 7 reports / 3 s | 42 reports, still responsive |
| 2 uploads / 5 s, pages 40 ms apart, mode switch 600 ms after | stalled on the second |

The third row is the one that matters: surviving a synthetic loop does not
mean an upload followed by anything else is safe. sharkfin now spaces pages
100 ms apart, leaves the board alone for 2 s afterwards, waits 10 s between
uploads, and skips the mode switch when the board is already showing the
pattern.

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
