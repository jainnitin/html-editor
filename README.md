# HTML Editor

A small desktop app for hand-tweaking self-contained HTML reports — the kind a
model generates, with inline CSS and JavaScript in a single file. Fix the
wording, repoint the links, delete the block it invented, save. The output stays
one standalone file.

The report loads into an iframe, so its own styles and scripts run exactly as a
browser will render them, and edits are made against the live DOM.

macOS and Windows. Built with Tauri 2 and Vite, no frontend framework.

## Install

Grab the latest build from [Releases](https://github.com/jainnitin/html-editor/releases):
`.dmg` for macOS, `-setup.exe` for Windows. After that the app updates itself.

The app is unsigned, so macOS quarantines it on first launch. Clear that once:

```bash
xattr -dr com.apple.quarantine "/Applications/HTML Editor.app"
```

## Using it

A file opens **ready to edit** — click into the page and type. Auto-save writes
shortly after you stop typing, when the window loses focus, and on close, so
`⌘S` is never something to remember. The first save of any file keeps the
untouched original as `<name>.html.bak`, and everything is undoable.

Four things earn their place in the toolbar:

- **Links** — click any link while editing to change its text or URL.
  **Link audit** (`⇧⌘L`) lists every anchor and labels it *jump ok*, *dead
  jump*, *external* or *no target*. Dead jumps matter most: these reports lean
  on in-page navigation (`href="#s3"`), so a renamed or trimmed heading quietly
  leaves a link pointing at nothing.
- **Trim** (`⌘D`) — hover any block (table row, list item, card, section) to
  outline it, click to delete. Hold `⌥` to take its parent instead. This is the
  one operation a text toolbar cannot express, and the usual fix for a row the
  model invented.
- **Find & replace** (`⌘F`) — generated reports repeat a wrong label dozens of
  times. Replacement walks text nodes only, so it can never corrupt a tag, class
  name or attribute. *Replace All* is a single undo step.
- **Open in Browser** (`⇧⌘B`) — flushes pending edits, then hands the file to
  your real browser for an honest look.

Formatting is limited to bold, italic, underline, strikethrough and links. These
reports ship a tuned design system, and highlight colours or font sizes would
only leave `<font>` tags and inline styles fighting the existing stylesheet.
Anything more is better fixed by deleting the block and regenerating it.

Everything else lives in the menu bar: **File** (open, recents, save as, save a
copy, auto-save, reveal), **Edit** (undo, find), **Format**, and **Tools**
(Editing `⌘E` / Viewing `⇧⌘E`, Trim `⌘D`, Link audit `⇧⌘L`).

## Guard rails

**Script-generated regions.** Some reports build parts of themselves at runtime,
filling containers that are *empty* in the file on disk. Edits there look fine
and vanish on reload. On open, the app diffs the live DOM against an inert parse
of the source, outlines any such region in amber, and warns the first time you
type inside one.

**Untrusted documents.** An opened report is not trusted input. It renders in a
`srcdoc` iframe, which is same-origin with the app, so its scripts can reach the
app's own IPC. Sandboxing is not an option — the editor needs same-origin DOM
access to work.

So every filesystem command is gated in Rust on an authorization set: only paths
you explicitly chose this session — a native dialog, a Finder "Open With", or a
drag onto the window — can be read or written, compared by canonical path so
`..` and symlinks cannot slip through. A malicious report can still rewrite its
own file, which editing it would do anyway, but nothing else. The file dialogs
live in Rust for the same reason: picking a file is what grants access to it.

Links opened externally are restricted to `http`, `https` and `mailto`, and the
frontend holds no filesystem permissions at all — see
`src-tauri/capabilities/default.json`.

## Updates

The app checks at launch and once a day, and **⌘ menu → Check for Updates…**
checks on demand. It downloads a prebuilt bundle for the running platform,
verifies it and offers to restart — nobody has to clone or pull to get a new
version, and nothing is compiled on your machine.

Each bundle is signed in CI with a key that never leaves it, and the matching
public key is compiled into the app, so a tampered or substituted download is
rejected before it can run. This is independent of Apple code signing; the app
itself stays unsigned and runs on managed machines as before.

## Build from source

| | macOS | Windows |
| --- | --- | --- |
| Rust | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs), MSVC toolchain |
| Node | 20+ | 20+ |
| Toolchain | `xcode-select --install` | [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with *Desktop development with C++*, plus WebView2 (preinstalled on Win 11) |

```bash
npm install
npm run tauri dev      # hot-reloading window
npm run tauri build    # release bundles
```

Bundles land in `src-tauri/target/release/bundle/`. The bundler only builds
targets valid for the host, so the same command is right on both platforms.

Release builds sign the updater artifact and need the private key:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/html-editor.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

See [RELEASING.md](RELEASING.md) for cutting a release. A build leaves ~900 MB
of intermediates in `src-tauri/target`; `cargo clean --manifest-path
src-tauri/Cargo.toml` reclaims it.

## Telemetry

Off unless an endpoint is supplied at build time:

```bash
VITE_AI_INGEST=https://<region>.in.applicationinsights.azure.com/v2/track
VITE_AI_IKEY=<instrumentation key>
```

When enabled it reports which features were used, app version, OS, session
length and unhandled errors. It never sends file paths, file names, document
content, or anything typed into the editor; sizes and counts go out as buckets
so a document cannot be fingerprinted. Identity is a random per-install UUID in
`settings.json`. Set `"telemetry": false` there to opt out.

## Layout

```
index.html          toolbar, find bar, dialogs
src/main.js         entry point — wiring only
src/lib/
  dom.js            element helpers, toast
  state.js          all mutable session state
  history.js        undo entries the browser cannot provide
  viewport.js       the iframe: modes, generated-region detection, serialize
  modes.js          Editing/Viewing pulldown, Trim toggle
  trim.js           block picker
  format.js         execCommand wrappers
  find.js           find & replace
  links.js          link dialog, link audit
  documents.js      open, save, auto-save, browser hand-off
  telemetry.js      anonymous usage reporting
  updater.js        self-update
src-tauri/src/lib.rs  menu bar, authorization gate, file and shell commands
```

Modules import in one direction only, and `main.js` is the only file that wires
listeners.

## Licence

MIT — see [LICENSE](LICENSE).
