# HTML Editor

A small macOS app for editing standalone HTML reports — the kind that ship as a
single self-contained file with inline CSS and JS. Turn on edit mode, click into
the page, fix the text, repoint the links, save. The file stays a single
self-contained HTML file.

Built with **Tauri 2 + Vite** (vanilla JS — no framework).

## Run it

```bash
npm install
npm run tauri dev      # hot-reloading dev window
npm run tauri build    # produces .app + .dmg
```

Bundles land in `src-tauri/target/release/bundle/`.

## Using it

The menu bar owns file and formatting commands; the toolbar stays out of the way.

**File** — Open… `⌘O` · **Open Recent ▸** · Save `⌘S` · Save As… `⇧⌘S` · Save a Copy… `⌥⌘S` · **Auto-save** (toggle) · Open in Browser `⇧⌘B` · Reveal in Finder `⇧⌘R`
**Edit** — Undo/Redo · Cut/Copy/Paste · Find & Replace… `⌘F`
**Format** — Bold `⌘B` · Italic `⌘I` · Underline `⌘U` · Strikethrough `⇧⌘X` · Hyperlink… `⌘K` · Remove Link · Clear Formatting
**Tools** — Editing `⌘E` · Viewing `⇧⌘E` · Trim Blocks `⌘D` · Link Audit… `⇧⌘L`

You can also drag a file onto the window, or use Finder → Open With.

### It opens ready to edit, and saves itself

A file opens **in Edit mode**; **View** is the deliberate switch, not the other
way round. Auto-save writes 1.2 seconds after you stop typing, when the window
loses focus, and on close, so `⌘S` is never something you have to remember. The
toolbar shows the state plainly — *Unsaved…* → *Saving…* → *Saved 10:14* — and
the title bar carries a ● while there are unwritten changes.

Auto-save is safe because the first write of any file always stashes the
pristine original as `<name>.html.bak`, and every action including Trim is
undoable with `⌘Z`. Turn it off in **File ▸ Auto-save** and the state readout
switches to *Unsaved — ⌘S*; the preference persists.

**Open in Browser** (`⇧⌘B`) flushes pending changes first, then hands the file
to your default browser — the real rendering, with the report's own JavaScript
running, which is the honest check before you send it on.

### Toolbar

Ordered the way every editor orders it, so muscle memory works: undo/redo,
then **B** *I* <u>U</u> ~~S~~, then link/unlink, then the document tools
(find, trim, audit). On the right sit the **Editing / Viewing** pulldown and,
furthest right, **Open in Browser**.

Two modes, one tool. *Editing* and *Viewing* are places you stay, so they live
in the pulldown, which shows the current mode as its label and tints green while
editing. *Trim* is a tool you flick on and off inside Editing — so it stays a
toolbar toggle next to find and audit, not a mode you have to navigate back out
of. Formatting greys out in View mode; find and
audit stay live.

### The four things that actually matter

1. **Edit mode** (`⌘E`) — click into the page and type. Plain text editing, no
   surprises.
2. **Links** — click any link while editing to change its text or URL. **Link
   audit** (`⇧⌘L`) lists every anchor and labels it *jump ok*, *dead jump*,
   *external* or *no target*. Dead jumps matter most: these reports lean on
   in-page navigation (`href="#s3"`), and a heading that got renamed or trimmed
   leaves a link pointing at nothing. The link dialog warns inline too.
3. **Trim mode** (`⌘D`) — hover any block (table row, list item, `.card`,
   section, whole table) to outline it in red, click to delete it. Hold `⌥` to
   grab its parent instead. `⌘Z` undoes. `Esc` leaves trim mode.
4. **Find & replace** (`⌘F`) — the one that saves the most time. Generated
   reports repeat a wrong product name or metric label dozens of times; one
   *Replace All* fixes them. Replacement walks text nodes only, so it can never
   corrupt a tag, class name or attribute.

### Guard rails

- **Generated regions.** Some reports build parts of themselves at runtime —
  the eval reports fill 32 `json-tree-container` elements via
  `createElement`/`appendChild`. Those regions are empty in the file on disk, so
  edits made there look fine and then vanish on reload. On open, the app diffs
  the live DOM against an inert parse of the source, outlines any such region in
  amber while editing, and warns the first time you type inside one.
- **Backups.** The first save of any file copies the untouched original to
  `<name>.html.bak` before writing.
- **Save a Copy** (`⌥⌘S`) writes a variant elsewhere and leaves you editing
  the original — unlike Save As, which switches you to the new file.
- **Open Recent** keeps the last 10 files in `recents.json` under the app's
  config directory. Entries that no longer exist on disk are dropped silently,
  and duplicate file names are disambiguated by their parent folder.
- **Unsaved changes.** Closing the window or opening another file prompts first.

### Why the toolbar is so short

These reports ship with a tuned design system — CSS custom properties, `.card`
and `.scard` layouts, a fixed type scale. Highlight colours, font sizes and
indent controls fight that design and leave `<font>` tags and inline
`background-color` behind, so they are deliberately absent. Bold, italic, inline
code and links compose with the existing stylesheet; everything else is better
fixed by deleting the block and regenerating it.


## How it works

- The document is loaded into an `<iframe srcdoc>`, so its own CSS and scripts
  run exactly as they will in a browser — tabbed reports stay clickable while you
  edit them.
- Edit mode sets `contentEditable` on the iframe body and drives
  `document.execCommand` for bold/italic/link/undo. Inline `<code>` is wrapped by
  hand since `execCommand` has no equivalent.
- Trim mode turns off `contentEditable` and swaps in a hover-to-highlight picker
  that walks up to the nearest structural block. Its deletions bypass the
  browser's undo stack, so the app keeps its own and drains that first on undo.
- On save, the DOM is cloned and normalized before serializing: editing
  attributes are stripped, and for tabbed reports (`.tab[data-panel]`) the
  panels are un-hidden and the tab strip re-hidden, so the saved file keeps its
  no-JavaScript fallback of reading as one long document.

## Structure

```
index.html          UI shell (toolbar + iframe + dialogs)
src/main.js         all editor logic
src-tauri/src/lib.rs   menu bar, read/write commands, Finder "Open With"
src/styles.css      toolbar/dialog styling
src-tauri/tauri.conf.json
```

File I/O goes through two small Rust commands (`read_text_file` /
`write_text_file`) rather than the `fs` plugin, so there is no path-scope
configuration to maintain — the user picks the file through a native dialog,
drag-and-drop, or Finder, and that path is what gets written.

## Notes

- The app is unsigned. Built locally it launches fine; if you copy the `.dmg` to
  another Mac, clear quarantine with
  `xattr -dr com.apple.quarantine "/Applications/HTML Editor.app"`.
- `.html` is claimed with role `Editor`, so your default browser stays the
  default handler — this app just shows up under **Open With**.
