# Contributing

Reporting a bug or a board? You don't need any of this. Open the app's
**Contribute** tab, collect a bundle, and paste it into an
[issue](https://github.com/dniminenn/sharkfin/issues/new/choose).

Did the Keys page show a picture of your keyboard and ask whether it
looks right? Answering it is a contribution too. Say yes and the Keys
page and the Contribute tab both offer the picture's bundle; paste it
into a board report and the picture ships built in, for you and everyone
else with your board. Say no and the next closest picture is shown. If
none of them fit, you can draw the board on keyboard-layout-editor.com,
paste the drawing into the Keys page, and send that in the same way.

## Development

```sh
cd app && npm install
npm run tauri dev      # the app
npm run web:build      # the browser build -> app/dist-web
cargo test --lib       # protocol tests, no hardware needed (app/src-tauri/)
```

The browser build is the same frontend with `@/lib/backend` aliased to
`src/web/backend.ts`, which drives the `app/src-web` wasm crate over WebHID.
That crate includes `protocol.rs` and `registry.rs` from `src-tauri` by path
rather than copying them, so the wire format cannot drift between the two
builds; only the transport and the command layer differ. It needs
`rustup target add wasm32-unknown-unknown` and
[wasm-pack](https://rustwasm.github.io/wasm-pack/).

With a keyboard plugged in, `app/src-tauri/examples/` has a few tools that
talk to it directly. `smoke` checks it answers at all, `probe` shows which
command family it speaks, `restore_light` fixes a backlight you've made
invisible, and the `*_roundtrip` ones write a value, read it back and put
the original back.

Before committing, make sure all of these pass. CI runs them on Linux,
Windows and macOS:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
npx tsc --noEmit
npx tsc -p tsconfig.web.json --noEmit
(cd src-web && cargo fmt --check \
  && cargo clippy --target wasm32-unknown-unknown --all-targets -- -D warnings)
```

Style notes:

- Comments are terse: state constraints the code cannot, never narrate
  what the next line does.
- UI uses shadcn/ui components only. Colours come from the colorway CSS
  variables in `app/src/index.css`, never hard-coded; keycap styling is the
  `.keycap` class.
- Pacing and rate limits belong in the core, next to the packet builders, so
  both builds inherit them. The browser has no backend to put them behind.

## Adding a read-only board

Four boards in the registry resolve to no known command family, so
sharkfin won't write to them. To add one you need the board in hand:
identify its family with `cargo run --example probe` (read-only, sends
both families' GET commands), check the replies against
[`docs/PROTOCOL.md`](docs/PROTOCOL.md), then confirm writes with the
`*_roundtrip` examples. Adding the family to `KNOWN_FAMILIES` in
`app/src-tauri/src/registry.rs` is the only code change. Every
family-dependent opcode already routes through the tables in
`app/src-tauri/src/protocol.rs`.

## Regenerating vendor data

`tools/extract_vendor_data.py` regenerates the device registry
(`app/src-tauri/data/devices.json`) and the vendor layouts
(`app/src/lib/layouts/vendor/*.json`) from a vendor webapp release.

Prettify the vendor bundle first, then point the script at it:

```sh
npx -y prettier --parser babel <app>/dist/js/index.*.js > /tmp/bundle.pretty.js
python3 tools/extract_vendor_data.py /tmp/bundle.pretty.js --dist-js <app>/dist/js
```

`--dist-js` is repeatable. Every brand ships the same driver with only
its own devices' layouts bundled, so unioning several brands' builds is
how layout coverage grows:

```sh
python3 tools/extract_vendor_data.py /tmp/bundle.pretty.js \
    --dist-js attackshark/dist/js --dist-js noppoo/dist/js --dist-js ikbc/dist/js
```

The script:

- Parses the device registry arrays out of the prettified main bundle.
- Parses the device registry arrays out of the prettified main bundle.
- Classifies each device's protocol family from the lazy-loader
  dependency lists in the minified dist chunks. The base chunks are matched
  by content, not filename: yc500 declares `FEA_CMD_SET_KEYMATRIX = 9`,
  gen2 declares `10`. Hashes change between builds. (Family determines
  whether sharkfin will write to a board.)
- Merges `app/src-tauri/data/devices.extra.json`: boards the vendor has
  removed from its catalogue, boards it never listed, and corrections to
  boards it describes wrongly. A correction is marked `_override` and
  carries only the fields it replaces, usually `keyLayout`. Each entry
  records its own evidence in `_` keys, which are stripped on merge.
  `hand_added_boards_survive_a_regeneration` fails if a run drops one.
- `app/src-tauri/data/confirmed.json` is separate and untouched by
  regeneration: one line per board whose owner sent a read sweep in an
  issue, with the issue number and app version. It marks the board
  **confirmed** in `docs/BOARDS.md` and the Contribute page stops asking
  for a board report on it. Add a line when a clean bundle for a
  registered board comes in.
- Keeps any layout file marked `"local": true`. Those are hand-made from
  hardware evidence for boards no vendor layout fits, and regeneration
  neither deletes nor overwrites them. The name must not match a vendor
  layout, or it would replace that picture for every board pointing at it,
  and the run stops if it does. `local_layouts_stay_local` fails if the
  flag is ever dropped, which would leave the next run free to delete the
  file.
- Extracts every bundled `*_keymappings_ui_info` layout object, and the
  SVG scenes newer builds ship instead. A layout named for a revision
  (`_v2`) falls back to the base revision's drawing, which is what the
  vendor's own component does.
- Fills in slot indices from each board's factory keymap, best source
  first: the board's own firmware (`keymap-evidence.json`, below), a
  layout confirmed inside a sibling's firmware (`matrix-evidence.json`),
  then the vendor's `defaultMatrix` for yc500 boards alone. Omitted when
  nothing resolves.
- Splits a picture whose boards ship different factory keymaps into one
  copy per keymap, `Name~k1`, `Name~k2`, numbered by the lowest board id
  shipping each, and points every board at the copy carrying its own
  keymap. The shared name keeps the geometry alone, for boards whose
  keymap nobody has.

A build with no `defaultMatrix` yields geometry-only layouts. Copying
those over layouts that have `matrixIndex` loses it silently, so diff the
layout output before copying it in.

`app/src/lib/layouts/x86.json` is hand-maintained as the canonical layout for
`Common80_k72x86` and is never regenerated.

### Reading keymaps from firmware

Which physical key a write lands on comes from the board's factory
keymap, so that keymap needs better evidence than the vendor's
JavaScript. The vendor publishes firmware per board, and the keyboard
image carries the factory keymap as a table of 4-byte slot entries, the
same bytes `GET_KEYMATRIX` returns, with copies in the settings area.
Where both exist they agree on 79 boards of 84; on the other five the
firmware carries a few entries the JavaScript lacks, a knob or a spare
key, and the firmware's version is the one recorded.

```sh
python3 tools/firmware_keymaps.py
```

It downloads each board's package once (cached under
`~/vendor-builds/firmware/pkg`, with the channel's "nothing for this id"
answers cached beside them), finds the table in the image, and records
the board, firmware version, image member, offset, copy count, how the
table was located and the table itself in
`app/src-tauri/data/keymap-evidence.json`, which is committed, so
regenerating the registry downloads nothing. Pass the vendor builds with
`--dist-js`: where the JavaScript carries a keymap for the board, its
bytes locate the table in the image, which settles where slot 0 is. A
table found from its Escape entry alone is recorded only when the slot
before it is not empty, since a board whose first slot is empty would
otherwise be read one slot late. The channel answers a bare 400 to a
burst of requests, which the tool refuses to read as "no firmware"; wait
and rerun, the cache keeps what landed.

`tools/verify_matrix.py` is the older check: it confirms a layout's
vendor `defaultMatrix` byte for byte inside a board's firmware and
records it in `matrix-evidence.json`. It still counts as a source for
boards without their own record.

A board that publishes no firmware confirms nothing. And boards sharing a
picture do not always share a keymap. `Common68_ZAP68` is shared by 33
boards, and their own factory keymaps show 5 with a Right Ctrl and 26
without. `Common82_NBD_IK75` carries six distinct keymaps, differing by
whole columns. That is what the per-keymap variants above are for: each
board is drawn with its own keymap, and a board with none is matched at
runtime instead of drawn from a sibling's.

`tools/coverage.py` reports how many boards have a rendered layout and
which layouts the writable boards still need.

### ISO boards

Almost every layout the vendor ships is ANSI, and ISO boards keep turning
up. The difference is mechanical: left Shift gives up a unit to
NonUsBackslash, Enter gives up one to NonUsHash. So when a board reports
both of those keys, `app/src/lib/iso.ts` derives the ISO version of
every candidate picture and lets it compete on the same footing.

Both, because one alone means nothing. An ANSI board shares a PCB with its
ISO version, and the firmware maps the unfitted position anyway: a Cypher
81 reports NonUsBackslash at a slot with no key on it.

A board whose picture already carries slot data is drawn as shipped
instead of matched, so the derived version is offered there too. Without
it those two keys have no key to click and cannot be remapped at all.

A derived picture names no file on disk, so its bundle carries the
geometry under `picture json:` and bakes like a pasted drawing, and a
confirmed one is rebuilt from its name rather than loaded.

### Baking a layout bundle

For a board without a usable layout, the app searches every stored
picture for the best match against the board's keymap and asks the owner
to confirm one; owners can also paste a keyboard-layout-editor drawing.
The Keys page then produces a layout bundle carrying the confirmed
geometry's name (`picture :`, or the drawing itself under
`picture json:`) and the keymap it matched, which is the `defaultMatrix`
the vendor build was missing. To bake it in:

```sh
python3 tools/bake_layout.py bundle.txt
python3 tools/coverage.py --markdown
```

The file written is the bundle's `layout :` name, with geometry taken
from the confirmed picture when the two differ. When the registry says
`Unknown`, pass `--name` to choose the new file and point the board's
registry entry at it.

The tool refuses a bundle the owner did not confirm, a layout that
already has slot data, an Unknown target without `--name`, and any
ambiguous key pairing (twin keys, or a contributor whose board was
remapped); `--force` overrides after inspection. It prints every board
that shares the layout, since the bake reaches all of them.

### Releasing

Push a `v*` tag. The workflow drafts the release once, in a job the three
platform builds wait on, then each uploads into it. They used to create it
themselves, and in v0.2.7 two of them created one each: the published
release had the Linux binaries and the Windows and macOS ones sat on a
second draft nobody could see.

Per-release notes are `.github/release-notes.md`, so they show up in the
diff for review rather than sitting inline in the workflow. Edit the "What
changed" section before tagging.

### Vendor builds stay out of this repo

Keep vendor builds outside the working tree and point `--dist-js` at them
there. They are intentionally not gitignored. Commit only the generated
registry and layout JSON.
