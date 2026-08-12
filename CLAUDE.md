# Notes for agents

Read this before changing anything. It is about how to work here, not what
the code does. For that see `docs/PROTOCOL.md` and `CONTRIBUTING.md`.

## Who this is for

sharkfin is used by people who like keyboards, not by developers. They want
to know whether their board is supported, how to remap a key, and whether
it is safe. They do not care what it is written in.

Never sell the stack. No Rust, Tauri, hidapi or React in user-facing copy.
A badge is fine, prose is not.

## Writing

Plain sentences. Say the thing, stop.

- **No em dashes.** They read as machine-written. Use a full stop, a comma,
  or a colon.
- **No self-congratulation.** Do not write that the project is honest, open
  or careful. Do not explain why a decision was wise. State what it does.
- **No narrating the work.** "It turns out", "this cost hours", "we
  discovered" belong nowhere. The reader was not there.
- **Tables over paragraphs** for anything with fields, offsets or counts.
  `docs/PROTOCOL.md` is a spec, not an essay.
- Cut a sentence rather than soften it. If a paragraph survives being
  deleted, delete it.

## Commits

Subjects are two or three words. No body, no trailers, no attribution.

One commit per pull request, unless a reviewer asks for more. Keep amending
it and force-pushing your branch as you work, rather than stacking fixups
on top. The history must never show an agent correcting itself: nothing
like "add tiers" followed by "drop tiers", or "write copy" then "tighten
copy".

One thing per pull request too. Two features are two pull requests.

## Keyboards can be broken

The user's board is real hardware and mistakes reach it.

- Never write to a board whose protocol family is unknown. The two families
  share opcodes that mean different things; a misaddressed write lands on a
  live register.
- Every write path must be evidenced before it ships: a hardware
  round-trip, or the device's own firmware. The vendor's JavaScript alone is
  not enough, it has been wrong more than once.
- Uploads that land in flash stall the firmware if repeated. Rate limits go
  in the backend, never the UI.
- Never ignore a send error.

## Before you commit

```sh
cd app        && npx tsc --noEmit && npx vitest run
cd app/src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib
python3 tools/coverage.py --markdown   # regenerates docs/BOARDS.md
```

CI runs all of these on three operating systems, plus a check that
`docs/BOARDS.md` matches the registry.

## Repo shape

Everything app-related lives in `app/`, including `app/src-tauri`. Root
holds only docs, `tools/` and CI config. `HANDOFF.md` is local-only and
must never be committed.

When you add a capability, search for statements that the old behaviour
made true. Enabling something turns "sharkfin will not do X" into a lie in
the README, the docs, the UI copy and the example tools all at once.
