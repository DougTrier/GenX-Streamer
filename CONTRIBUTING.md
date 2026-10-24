# Contributing to GenX Streamer

Thank you for helping. GenX Streamer is organized so that you can work on one
part without learning all of it first: start with the
[component guides](docs/components/README.md), pick the part you know best
(playback, scans, the guide, the Trier decoders, the interface, ...) and read
its page. Each one says where its code is, where to start reading, the rules
it keeps and how to run only its tests.

## Set up

The requirements are in the [README](README.md#requirements). Then:

```powershell
npm ci
npm run native:dev          # the app on Windows, with the interface served by Vite
npm run dev                 # the interface alone in a browser (no native layer)
```

`npm run native:dev` is the development build. Build a packaged Windows app
with `scripts/build-windows.ps1` and Android APKs with
`src-tauri/scripts/build-android.ps1` (see the README); anything installed on
a device should use `-Optimization 2`.

## How the code is laid out

- [ARCHITECTURE.md](ARCHITECTURE.md): the three layers (TypeScript interface,
  Rust native layer, Kotlin on Android), how they talk, and the folder map.
- [docs/components/](docs/components/README.md): one page per component.
- [docs/codes.md](docs/codes.md): what the requirement codes in comments mean
  (`P09`, `G03`, `W16`, ...) and where each is defined.

## Making a change

- **Keep files readable.** Aim for about 800 lines per file; 1,000 is the
  ceiling. When a file grows past that, split it by area the way the large
  ones already are:
  - a TypeScript screen or controller keeps its entry function and creates
    its parts from sibling modules, passing one shared context built with
    `createSharedContext` (`src/application/shell/shared-context.ts`); types,
    constants and pure helpers go to a `*-model.ts` file;
  - a Rust module gets a folder of the same name with child modules that
    start with `use super::*;` (see `src-tauri/src/database/storage_transaction/`);
  - a test file keeps its shared setup in a `*.fixture.ts` module whose
    `use...()` function each test file calls once (see
    `tests/guide/timeline-browser.fixture.ts`);
  - a stylesheet becomes an index of `@import`s of its parts, in order (see
    `src/ui/style.css`).
- **Real behavior only.** App code connects to real services and real data;
  no mock data, stub APIs or simulated responses. Tests use controlled
  fixtures, and a failure must show as a real error, not hide behind a
  fallback.
- **Follow the rules in ARCHITECTURE.md**: one owner per resource, stale
  results never land, storage is atomic, outside data is text, destinations
  are validated, errors are truthful, diagnostics are redacted.
- **Cite the rule you implement** in a comment when a requirement code covers
  it, and add or update the test that proves it.
- **Every source file starts with the license header.** Copy it from any
  existing file of the same language.

## Checking a change

Run your component's tests while you work (the commands are on its page), then
everything before you submit, from PowerShell 7:

```powershell
npm run verify
```

It runs, in order: types, formatting, lint, unit and browser tests, the
interface tests, the privacy scan, Rust formatting and lint (warnings are
errors), native tests and the tooling tests, and writes a receipt under
`artifacts/development-verification/`. A Rust test filter such as
`cargo test --lib catalog::` matches by substring, so it also runs modules
whose names end in `catalog`.

Changes to the Trier decoders also need the bench comparison described in
[docs/components/trier-mpeg.md](docs/components/trier-mpeg.md): identical
output checksums and no slowdown.

Device and packaged-build checks (in `tests/native/` and `scripts/`) need a
built app or an approved device; they refuse to run without them.

## Privacy

Never commit credentials, keys, databases, real account details, your own
device serials, private network addresses or user-profile paths. Before you
submit:

```powershell
node scripts/clean-repo.mjs scan
```

Put your own device serials, addresses and paths in an untracked
`.private-patterns.json` so the scan catches them. Test placeholders that look
like secrets (reserved test domains, loopback addresses, dummy keys) are
reviewed one line at a time and listed by fingerprint in
`scripts/clean-repo-allow.json`.

## Submitting

Keep a change focused on one thing, and say in its description what changed,
why, and how you checked it (the commands you ran and their results). Note
anything you could not check, such as a device you do not have.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), like the rest of the source code. The GenX
Streamer name and artwork are not covered by that license; see
[TRADEMARK.md](TRADEMARK.md).
