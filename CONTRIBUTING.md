# Contributing

Reporting a bug or a board? You don't need any of this. Open the app's
**Contribute** tab, collect a bundle, and paste it into an
[issue](https://github.com/dniminenn/sharkfin/issues/new/choose).

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
how layout coverage grows. Provenance for the builds used lives in
`VENDOR_SOURCES.md`:

```sh
python3 tools/extract_vendor_data.py /tmp/bundle.pretty.js \
    --dist-js attackshark/dist/js --dist-js noppoo/dist/js --dist-js ikbc/dist/js
```

The script:

- Parses the device registry arrays out of the prettified main bundle.
- Classifies each device's protocol family from the lazy-loader
  dependency lists in the minified dist chunks: `438d24dc.js` → `yc500`,
  `5e635fe2.js` → `gen2`, anything else → unknown. (Family determines
  whether sharkfin will write to a board.)
- Extracts every bundled `*_keymappings_ui_info` layout object. Matrix
  slot indices are computed against the `defaultMatrix` of yc500-family
  devices only, and omitted when no yc500 device resolves or when the
  devices disagree.

`app/src/lib/layouts/x86.json` is hand-maintained as the canonical layout for
`Common80_k72x86` and is never regenerated.

`tools/coverage.py` reports how many boards have a rendered layout and
which layouts the writable boards still need.

### Vendor builds stay out of this repo

Keep vendor builds outside the working tree and point `--dist-js` at them
there. They are intentionally not gitignored. Commit only the generated
registry and layout JSON.
