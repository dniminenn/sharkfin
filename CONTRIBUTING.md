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
- Keeps any layout file marked `"local": true`. Those are hand-made from
  hardware evidence for boards no vendor layout fits, and regeneration
  neither deletes nor overwrites them.
- Extracts every bundled `*_keymappings_ui_info` layout object, and the
  SVG scenes newer builds ship instead. A layout named for a revision
  (`_v2`) falls back to the base revision's drawing, which is what the
  vendor's own component does.
- Fills in slot indices from a layout's `defaultMatrix`, for yc500
  devices and for layouts confirmed against firmware (below). Omitted
  when nothing resolves or the devices disagree.

A build with no `defaultMatrix` yields geometry-only layouts. Copying
those over layouts that have `matrixIndex` loses it silently, so diff the
layout output before copying it in.

`app/src/lib/layouts/x86.json` is hand-maintained as the canonical layout for
`Common80_k72x86` and is never regenerated.

### Confirming a keymap against firmware

Which physical key a write lands on comes from the layout's factory
keymap, so that keymap needs better evidence than the vendor's
JavaScript. The vendor publishes each board's firmware, and the same
keymap sits inside it. Finding it there is the evidence.

```sh
python3 tools/verify_matrix.py --dist-js <build>/dist/js
```

It records the board, its firmware version and where the keymap was found
in `app/src-tauri/data/matrix-evidence.json`, which is committed, so
regenerating the registry downloads nothing. Delete an entry to retire a
claim.

Two rules keep it honest. A board that publishes no firmware confirms
nothing. And when boards sharing a layout ship different factory keymaps,
no single board's firmware settles it, so the layout is left alone: the
Keys page matches each board's own keymap instead, which is right per
board where one file cannot be.

That second rule is not theoretical. `Common68_ZAP68` is shared by 33
boards, and their own factory keymaps show 5 with a Right Ctrl and 26
without. `Common68_DK68HE` is the same picture plus that key, and the two
boards nearest it disagree further: Home and Delete are swapped, and one
has a knob the other does not. A bundle from any one of them would have
baked slot data that was wrong for the rest. Check what the other boards'
keymaps say before baking a layout they share.

`tools/coverage.py` reports how many boards have a rendered layout and
which layouts the writable boards still need.

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

### Vendor builds stay out of this repo

Keep vendor builds outside the working tree and point `--dist-js` at them
there. They are intentionally not gitignored. Commit only the generated
registry and layout JSON.
