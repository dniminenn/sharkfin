# Driveall keyboard HID protocol

**sharkfin does not support these boards and this branch will not be
merged.** Driveall is a second protocol family with no overlap with the
one sharkfin exists for, and carrying it turned every shared code path
into a choice between two stacks. It was cut on 2026-09-17 as out of
scope, not because it does not work.

This branch is the record. It holds a working implementation: keys, Fn,
lighting, per-key colour, macros and rapid trigger on the AJAZZ AK029, on
both the desktop and browser backends, with tests. Everything below was
derived from the vendor host code and two firmware images and checked
against them. Take it if you want to carry this somewhere; nothing here
needs deriving twice.

The stack is behind AJAZZ's and AULA's online driver at
`ajazz.driveall.cn`. It is not a ROYUAN family and shares nothing with
`PROTOCOL.md`: different collection, different framing, no checksum. The
AJAZZ table names 101 boards, 40 of them magnetic and 24 with a TFT; AULA
runs the same protocol from its own host, so that is a floor.

## Where the code is

| | |
|---|---|
| `app/src-tauri/src/protocol/driveall.rs` | frames, payloads, the read-modify-write plans |
| `app/src-tauri/src/wire.rs` | `driveall_*` exchanges on the shared `Wire` trait |
| `app/src-tauri/src/ops.rs` | macros, the bundle sweep |
| `app/src-tauri/src/commands.rs`, `app/src-web/src/lib.rs` | the per-backend branches |
| `app/src-tauri/data/devices.extra.json` | the AK029 entry, with its evidence |

The browser backend needs `sendReport` and an `inputreport` listener
rather than feature reports; that is in `app/src-web/src/lib.rs` on this
branch and is easy to lose.

Evidence markers:

| | |
|---|---|
| **[HW]** | a plugged-in board |
| **[FW]** | read from a named firmware image |
| **[JS]** | vendor host code only, never exercised |

Images cited: `AJAZZ_AK820PRO_PID_8009_V1.13_SN32F290` and
`AJAZZ_AK820PRO_PID_8099_V1.14_SN32F290`, both mechanical with a TFT;
`MINI60HEPRO_v1.55_cortexm0` (AULA MINI 60 HE PRO, SN34F280, magnetic).
Host code: `layout-classic` from the live driver **[JS]**.

## SONiX is three stacks

`0x0C45` is a chip maker's id. Do not infer a protocol from it.

| stack | collection | what it is |
|---|---|---|
| k68 group | `0xFF13` usage 1, 65-byte reports | 21 boards, all at `0c45:7044`, not supported |
| driveall | `0xFF67` or `0xFF68` usage `0x61` | this document |
| `ry108` | `0xFFFF` usage 2 | SONiX silicon running ROYUAN firmware; `PROTOCOL.md` |

Discovery matches on the collection, never on the vendor ID.

## Transport

| | |
|---|---|
| Collection | usage page `0xFF68` or `0xFF67`, usage `0x61` |
| Reports | output and input, report ID 0, not feature |
| Length | from the descriptor's output report count, 32 or 64. sharkfin requires 64 and refuses the rest |
| Framing | `AA` out, `55` back, opcode at byte 1 |
| Checksum | none |

## Frame

| byte | |
|---|---|
| 0 | `0xAA` out, `0x55` in |
| 1 | command |
| 2 | length of this chunk's payload |
| 3-4 | address, little endian |
| 5-7 | optional, command specific |
| 6 | last-packet flag when byte 5-7 are unused |
| 8.. | payload |

A transfer of `n` bytes is `ceil(n / (reportLen - 8))` frames. Each frame
addresses `addrStart + i * (reportLen - 8)`; the final frame's byte 2 is
the remainder. The reply copies the request header and answers at byte 8.
**[FW]**

## Commands

| | GET | SET |
|---|---|---|
| device info | 16 | |
| game mode | 17 | 33 |
| key | 18 | 34 |
| LED effect | 19 | 35 |
| custom LED | 20 | 36 |
| macro | 21 | 37 |
| Fn key | 22 | 38 |
| magnetic RT | 23 | 39 |
| magnetic DKS | 24 | 40 |

The 8099 image's GET switch covers 16-22 and its SET switch 33-38; 23, 24,
39 and 40 fall off the end of both. That board is mechanical and has no
magnetic switches to configure. The SN34F280 HE image implements all of
them. **[FW]**

## Device info, 48 bytes

| byte | |
|---|---|
| 2-3 | free macro space |
| 4-5 | USB vendor ID |
| 6-7 | USB product ID |
| 8-9 | firmware version |
| 17 | battery |
| 19 | current profile |
| 29 | `rtPrecision` |
| 30 | `frameVersion`; the vendor waits 2 s for a reply where it otherwise waits 500 ms |

Bytes 8-9 are the version the vendor prints as `1.13`: byte 8 is packed
decimal hundredths, byte 9 counts whole units.

## Keymap, 512 bytes

128 slots of 4. Byte 0 is a page, and the numbers are not ROYUAN's.

| page | | bytes 1-3 |
|---|---|---|
| 0 | default | |
| 1 | mouse | `1` then a button mask (L 1, R 2, M 4, back 8, forward 16), or `3` then wheel 1 up / 255 down |
| 2 | keyboard | usage at byte 2; a modifier may instead arrive as its HID bitmask at byte 1 |
| 3 | consumer | 16-bit usage, little endian, bytes 1-2 |
| 6 | macro | index at byte 1, repeat mode at 2, its count at 3 |
| 4, 5, 7-15 | system, DKS, MT, TGL, SOCD, RS, FUNC, END, MPT | not decoded |

sharkfin's own page numbers collide with these and mean other things, so
an assignment with no entry above is refused rather than written. **[JS]**

## LED effect, 16 bytes

| byte | |
|---|---|
| 0 | mode |
| 1-3 | red, green, blue |
| 4 | `0xFF` |
| 5-7 | secondary colour |
| 8 | colour mode |
| 9 | brightness, 1-6 |
| 10 | speed, 1-6 |
| 11 | direction |
| 12 | effect sub-mode |
| 14-15 | `AA 55` |

## Magnetic RT, 1024 bytes

128 slots of 8. `rtPrecision` from device info byte 29 sets the divisors:
travel is thousandths when it is `2`, hundredths otherwise; press and
release are thousandths when it is non-zero, hundredths otherwise.

| byte | |
|---|---|
| 0 | axis type |
| 1 | bit 0 whole-travel fast, bit 1 rampage |
| 2-3 | travel |
| 4-5 | press |
| 6-7 | release |

sharkfin writes the actuation point, the two rapid-trigger points and the
rapid-trigger bit. Byte 0 is the fitted switch model, not a per-key kind,
and is left as it was read. DKS is command 24 and 40 and a separate block;
SOCD, MT and TGL are keymap pages. None of those are implemented.

## Macros

A 400-byte index of 100 little-endian 32-bit offsets, then the blocks the
offsets point at, both in the same address space. A block is a 16-bit
count of action half-words, two pad bytes, then 4 bytes per action:
delay little endian, key code, then a flag byte of `0xB0` key press,
`0x30` key release, `0x90` mouse press, `0x10` mouse release. A mouse
action's key code is the same button mask as the keymap page, `1` left,
`2` right, `4` middle, `8` back, `16` forward, not an index. There is no
mouse-move action. The index is written with the last-packet flag clear
and the blocks with it set, at address 400. **[JS]**

The vendor refuses a store larger than `macroSpaceSize` (device info bytes
2-3, 512 when the board does not report one), counting four bytes per
macro and four per action, so that bounds any one block.

The three repeat modes are offered in the order 0, 2, 1 and only mode 1
takes the count in byte 3. Which is which is in a chunk of the driver that
has not been read, so sharkfin binds macro keys with the vendor's own
default of 0 and does not offer the other two.

## The SN34F280 dispatcher [FW]

`MINI60HEPRO_v1.55_cortexm0`, dispatcher at `0xf570`, 32-byte reports.
Byte 0 `cmp #0xAA`, copy 32, reply byte 0 `0x55`, command in byte 1. GET
when the high nibble is 1 (`0xf5c0`), SET when it is 2 (`0xf720`). The
payload copies from or to `base + addr`, address at bytes 3-4, length at
byte 2, into reply offset 8.

| cmd | | base |
|---|---|---|
| 16 | GET device info | `0x9000` |
| 17 | GET game mode | `0x9200` |
| 18 | GET key | `0x9600` |
| 19 | GET LED | special, `0xf616` |
| 20 | GET custom LED | `0x9a00` |
| 21 | GET macro | `0x9c00` |
| 22 | GET Fn | `0xb000` |
| 23 | GET magnetic RT | `0xb600` (`0xf688`) |
| 24 | GET magnetic DKS | `0xb200` |
| 33 | SET game mode | `0x9200` |
| 34 | SET key | `0x9600` |
| 35 | SET LED | `0x9800` |
| 36 | SET custom LED | `0x9a00` |
| 37 | SET macro | `0x9c00` |
| 38 | SET Fn | `0xb000` |
| 39 | SET magnetic RT | `0xb600` (`0xf7aa`) |
| 40 | SET magnetic DKS | `0xb200` |

USB constants in the image: `0C45:80A2`, HID `06 68 FF 09 61`, a 64-count
item in the descriptor at `0x1714b`. The info block at `0x9004` holds
`45 0c a2 80 55 01`.

## Not decoded

sharkfin reads and writes keys, Fn, lighting, per-key colour, macros and
rapid trigger. The rest of the command table is described here so the next
reader does not start from the JS again.

**DKS**, commands 24 and 40, 64 entries of 16 bytes. A DKS key in the
keymap is page 8 holding an index 0-63 into this table.

| byte | |
|---|---|
| 0-3 | press point 1, press point 2, release point 1, release point 2 |
| 5, 7, 9, 11 | four action key codes |
| 12-15 | one byte per event; low nibble "single", high nibble "hold", each a bitmask over the four actions |

What is missing is when a hold releases. Driveall stores a per-action,
per-event tri-state with no end event, while sharkfin's DKS model is
`{start, end}` and came out of the gen2 engine. Taps map exactly both
ways; holds do not. Settling it needs the scan engine in an HE image, not
the dispatcher above. **[JS]**

**Settings**, commands 17 and 33, 56 bytes. In both images' switches.

| byte | |
|---|---|
| 1 | game mode |
| 2 | Fn switch |
| 3 | sleep time |
| 4 | key delay, 1-5 |
| 5 | report rate: 3 is 1k, 4 is 2k, 5 is 4k, 6 is 8k |
| 6 | system mode |
| 7 | TFT display time |
| 8, 9 | top and bottom dead zone, hundredths of a millimetre |
| 11 | stability mode |
| 14 | auto calibration |
| 15 | single-key wakeup |
| 16 | push-button mode |
| 17 | NKRO |
| 18-19 | wireless report rate, little endian |

Command 33 writes all 56 bytes, so anything that touches one field must
read the block first or it clears the owner's report rate and calibration.
**[JS]**

**Effect names.** The 19 default effect ids are in `lighting.ts`, loaded
as a separate chunk that has not been read, so only their count is known.
They are not ROYUAN's numbering and sharkfin shows them by number. Per-key
colour uploads with command 36, but the effect id that displays it is a
per-board `customEffect` list and the AK029 declares none, so nothing
switches the board to it.

**TFT**, commands 80 and 81. A bespoke 8-byte header rather than the frame
above, acked as command 65. Only boards whose entry carries a `tft` route
have one, which is 24 of the 101 entries in the driveall table and not
the AK029.

**OTA**, commands 128-134, and the vendor's own index at
`GET https://cp.driveall.cn/api/device/firmware/index` with
`supplier_name`, `connect_type`, `vid`, `pid`, `product_name`. Every AK029
and AK820 query returned empty. sharkfin never flashes firmware.
