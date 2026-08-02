# HTML Editor

A small desktop app for hand-tweaking self-contained HTML reports — the kind a
model generates, with inline CSS and JavaScript in a single file. Fix the
wording, repoint the links, delete the block it invented, save. The output stays
one standalone file.

The document is loaded into an iframe, so its own styles and scripts run exactly
as a browser will render them, and edits are made against the live DOM.

Built with Tauri 2 and Vite. No frontend framework.

---

## Install

Download the latest release, or build from source (below).

Because the app is unsigned, macOS will refuse to open it on first launch. Clear
the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/HTML Editor.app"
```

---

## Build from source

### Prerequisites

| | macOS | Windows |
| --- | --- | --- |
| Rust | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs) (choose the **MSVC** toolchain) |
| Node.js | 20 or newer | 20 or newer |
| System toolchain | `xcode-select --install` | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with *Desktop development with C++*, and [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) |

### Both platforms

```bash
git clone <this repo>
cd html-editor
npm install

npm run tauri dev      # hot-reloading development window
npm run tauri build    # release build
```

Artifacts land in `src-tauri/target/release/bundle/`:

- **macOS** — `macos/HTML Editor.app` and `dmg/HTML Editor_1.0.0_aarch64.dmg`
- **Windows** — `nsis/HTML Editor_1.0.0_x64-setup.exe`

The bundler only produces targets valid for the machine it runs on, so the same
command is correct on both; there is no cross-compilation step and no per-OS
configuration to change.

To install locally on macOS, copy the `.app` into `/Applications`. If the icon
in Finder or the Dock looks stale after a rebuild, refresh Launch Services:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "/Applications/HTML Editor.app"
```

### Reclaiming disk space

A release build leaves roughly 900 MB of intermediate artifacts in
`src-tauri/target`. That directory is disposable:

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
```

Note that `~/.cargo/registry` is shared by every Rust project on the machine, so
it is not worth clearing for this one.

---

## Using it

The menu bar owns the commands; the toolbar stays short and stays out of the way.

| Menu | Contents |
| --- | --- |
| **File** | Open `⌘O` · Open Recent ▸ · Save `⌘S` · Save As `⇧⌘S` · Save a Copy `⌥⌘S` · Auto-save (toggle) · Open in Browser `⇧⌘B` · Reveal in Finder `⇧⌘R` |
| **Edit** | Undo `⌘Z` · Redo `⇧⌘Z` · Cut/Copy/Paste · Find & Replace `⌘F` |
| **Format** | Bold `⌘B` · Italic `⌘I` · Underline `⌘U` · Strikethrough `⇧⌘X` · Hyperlink `⌘K` · Remove Link · Clear Formatting |
| **Tools** | Editing `⌘E` · Viewing `⇧⌘E` · Trim Blocks `⌘D` · Link Audit `⇧⌘L` |

You can also drag a file onto the window, or use Finder → Open With.

### It opens ready to edit, and saves itself

A file opens **in Editing**; Viewing is the deliberate switch, not the other way
round. Auto-save writes shortly after you stop typing, when the window loses
focus, and on close, so `⌘S` is never something you have to remember.

The toolbar stays silent while that works. It speaks up only when you actually
have to act — with auto-save off and unsaved edits, it reads *Unsaved — ⌘S* and
the title bar carries a dot.

This is safe because the first write of any file copies the untouched original
to `<name>.html.bak`, and every action, Trim included, is undoable with `⌘Z`.

### The four things that earn their place

1. **Editing** — click into the page and type. Plain text editing, no surprises.

2. **Links** — click any link while editing to change its text or URL. **Link
   audit** (`⇧⌘L`) lists every anchor and labels it *jump ok*, *dead jump*,
   *external* or *no target*. Dead jumps matter most: these reports lean on
   in-page navigation (`href="#s3"`), and a heading that got renamed or trimmed
   leaves a link pointing at nothing. The link dialog warns inline as you type.

3. **Trim** (`⌘D`) — hover any block (table row, list item, card, section, whole
   table) to outline it in red, click to delete it. Hold `⌥` to take its parent
   instead; `Esc` stops. This is the one operation a text toolbar cannot express,
   and the usual fix for a row the model invented.

4. **Find & replace** (`⌘F`) — the biggest time saver, because generated reports
   repeat a wrong label dozens of times. Replacement walks text nodes only, so
   it can never corrupt a tag, class name or attribute. *Replace All* is a single
   undo step.

### Why the toolbar is so short

These reports ship a tuned design system — CSS custom properties, card layouts,
a fixed type scale. Highlight colours, font sizes and indent controls fight that
design and leave `<font>` tags and inline `background-color` behind, so they are
deliberately absent. Bold, italic and links compose with the existing stylesheet;
anything else is better fixed by deleting the block and regenerating it.

---

## Guard rails

**Script-generated regions.** Some reports build parts of themselves at runtime —
one eval report fills 32 JSON tree views via `createElement`/`appendChild`. Those
containers are *empty* in the file on disk, so edits made there look fine and
then vanish on reload. On open, the app diffs the live DOM against an inert parse
of the source, outlines any such region in amber while editing, and warns the
first time you type inside one.

**Untrusted documents.** An opened report is not trusted input. It renders in a
`srcdoc` iframe, which is same-origin with the app, so its scripts can reach
`parent.__TAURI_INTERNALS__` and call the app's own commands. Sandboxing the
iframe is not an option — the editor needs same-origin DOM access to work.

Instead, every filesystem command is gated in Rust on an **authorization set**:
only paths you explicitly chose this session — through a native dialog, a Finder
"Open With", or a drag onto the window — can be read or written, compared by
canonical path so `..` and symlink tricks do not slip through. A malicious report
can still rewrite *its own file*, which it could do anyway by being edited, but
it cannot touch anything else.

For the same reason the file dialogs live in Rust rather than the frontend:
picking a file is what grants access to it. Externally opened links are
restricted to `http`, `https` and `mailto`, so a report cannot use `file:` to
pull in local content.

The frontend is granted no filesystem permissions at all — see
`src-tauri/capabilities/default.json`.

---

## Telemetry

The app reports anonymous usage to Application Insights so real usage can guide
what gets built next.

**What is sent:** which features were used (`file_opened`, `file_saved`,
`trim_block`, `replace_all`, `link_audit`, `mode_changed`, …), the app version,
OS and architecture, session length, and unhandled errors from the editor.

**What is never sent:** file paths, file names, document content, anything typed
into the editor, hostnames, usernames, or IP-derived location. Sizes and counts
go out as buckets (`<=100`, `<=500`, …) rather than exact figures, so a document
cannot be fingerprinted from its telemetry.

Identity is a random per-installation UUID stored in `settings.json`. It is not
derived from the machine or the user, and deleting that file resets it. To turn
reporting off entirely, set `"telemetry": false` in:

```
~/Library/Application Support/com.nitin.htmleditor/settings.json    # macOS
%APPDATA%\com.nitin.htmleditor\settings.json                        # Windows
```

Events are queued and flushed on a timer, when the window loses focus, and on
close. A failed batch is dropped rather than retried, so telemetry can never
back up or interfere with editing.

Delivery uses `fetch` against the Application Insights ingestion REST API, which
keeps it free of any SDK on either side.

### Sharing an Application Insights resource

This app reports into a resource that also receives telemetry from another
product. **Application Insights has a fixed schema — you cannot add a table**, so
separation has to come from filtering, not storage.

Every event is therefore tagged `cloud_RoleName = "html-editor"`, and every
query in `telemetry/dashboard-html-editor.json` is scoped to it.

That protects *this* dashboard. It does not protect the other one: a dashboard
whose queries do not name an application will absorb whatever else reports in.
`telemetry/patch_gsd_dashboard.py` adds an exclusion to each table reference in
such a dashboard. It excludes known foreign apps rather than allow-listing, so
existing roles keep flowing and nothing needs to be known about them.

```bash
python3 telemetry/patch_gsd_dashboard.py path/to/dashboard.json
```

### Dashboard

Import `telemetry/dashboard-html-editor.json` at
[dataexplorer.azure.com/dashboards](https://dataexplorer.azure.com/dashboards) —
**New dashboard → Import from file**. One page, six tiles: daily active installs,
sessions and documents per day, feature usage, versions in use, document size
distribution, and errors.

Regenerate it after changing the queries:

```bash
python3 telemetry/build_dashboard.py
```

## How it works

- The document is loaded with `<iframe srcdoc>`, so its own CSS and scripts run
  exactly as a browser would run them. Tabbed reports stay clickable while you
  edit them.
- Editing sets `contentEditable` on the iframe body and drives
  `document.execCommand`.
- Trim turns off `contentEditable` and swaps in a hover-to-highlight picker that
  walks up to the nearest structural block.
- Trim and Replace All change the DOM directly and never reach the browser's
  undo stack, so the app keeps its own and drains that first on `⌘Z`.
- On save the DOM is cloned and normalised: editing attributes and injected
  styles are stripped, and for tabbed reports the panels are un-hidden and the
  tab strip re-hidden, preserving the no-JavaScript fallback of reading as one
  long document.

## Layout

```
index.html              toolbar, find bar, dialogs
src/main.js             entry point — wiring only
src/lib/
  dom.js                element helpers, toast
  state.js              all mutable session state
  history.js            undo entries the browser cannot provide
  viewport.js           the iframe: modes, generated-region detection, serialize
  modes.js              Editing/Viewing pulldown, Trim toggle
  trim.js               block picker
  format.js             execCommand wrappers
  find.js               find & replace
  links.js              link dialog, link audit
  documents.js          open, save, auto-save, browser hand-off
src-tauri/src/lib.rs     menu bar, authorization gate, file and shell commands
```

Modules import in one direction only — `dom` and `history` depend on nothing,
and `main.js` is the only file that wires listeners. `state.js` exposes an
`onDirty` hook so marking the document dirty can schedule an auto-save without
depending on the module that owns saving.

## Dependencies

Four npm packages and 433 crates, all of which are used:

| | |
| --- | --- |
| `@tauri-apps/api` | IPC, events, window |
| `@tauri-apps/plugin-dialog` | message and confirm dialogs |
| `@tauri-apps/cli`, `vite` | build only |
| `tauri`, `tauri-plugin-dialog`, `serde`, `serde_json` | Rust side |

`cargo audit` reports no vulnerabilities. The advisories it does flag are for
unmaintained GTK crates, none of which are compiled on macOS or Windows, and for
build-time-only transitive dependencies.

Opening files, revealing them, and launching a browser are implemented directly
in Rust rather than through the opener plugin, whose `open_path` command is
filesystem-scoped and would have needed a blanket allow-list covering the whole
disk to work on arbitrary user-chosen files.

## Licence

MIT.
