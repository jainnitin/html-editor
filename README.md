# HTML Editor

A small desktop app for hand-tweaking self-contained HTML reports — the kind a
LLM generates, with inline CSS and JavaScript in a single file. Fix the
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

## Build from source

| | macOS | Windows |
| --- | --- | --- |
| Rust | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs), MSVC toolchain |
| Node | 24 (LTS) | 24 (LTS) |
| Toolchain | `xcode-select --install` | [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with *Desktop development with C++*, plus WebView2 (preinstalled on Win 11) |

```bash
npm install
npm run tauri dev      # hot-reloading window
npm run tauri build    # release bundles
npm run preflight      # everything CI runs, in seconds — do this before pushing
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

## Licence

MIT — see [LICENSE](LICENSE).
