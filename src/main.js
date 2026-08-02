/**
 * HTML Editor — entry point.
 *
 * Wires the toolbar, menu bar, keyboard and the edited document together. All
 * behaviour lives in `lib/`; this file only connects it.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { $, frame, doc } from './lib/dom.js';
import { S, setTitle, setSaveState, markDirty } from './lib/state.js';
import {
  applyModes,
  ensureStyle,
  markGeneratedRegions,
  warnIfGenerated
} from './lib/viewport.js';
import {
  setMode,
  toggleEdit,
  toggleTrim,
  toggleModeMenu,
  closeModeMenu,
  isModeMenuOpen,
  syncButtons
} from './lib/modes.js';
import { onDocMove, clearHover, trimBlock } from './lib/trim.js';
import { exec, syncActive } from './lib/format.js';
import { openFind, closeFind, isFindOpen, bindFind } from './lib/find.js';
import { linkFromSelection, openLinkDialog, showAudit, bindLinks } from './lib/links.js';
import * as telemetry from './lib/telemetry.js';
import {
  openDialog,
  loadPath,
  doSave,
  doSaveAs,
  doSaveCopy,
  setAutosave,
  openInBrowser,
  revealInFinder,
  bindLifecycle
} from './lib/documents.js';

/* ---------------- the edited document ---------------- */

frame.addEventListener('load', () => {
  const d = doc();
  if (!d || !d.body) return;

  d.body.addEventListener('input', onInput);
  d.addEventListener('click', onDocClick, true);
  d.addEventListener('mousemove', onDocMove, true);
  d.addEventListener('mouseleave', clearHover);
  d.addEventListener('keydown', onKeydown);
  d.addEventListener('selectionchange', syncActive);

  ensureStyle(d);
  markGeneratedRegions();
  applyModes();
});

function onInput() {
  markDirty();
  const sel = frame.contentWindow?.getSelection();
  const node = sel?.anchorNode;
  warnIfGenerated(node?.nodeType === 1 ? node : node?.parentElement);
}

function onDocClick(e) {
  if (S.trimming) {
    e.preventDefault();
    e.stopPropagation();
    trimBlock(e.altKey);
    return;
  }

  const a = e.target.closest?.('a');
  if (!a) return;
  e.preventDefault();

  // While editing, a click means "edit this link"; while viewing, follow it.
  if (S.editing) {
    openLinkDialog(a);
    return;
  }
  const href = a.getAttribute('href') || '';
  if (/^(https?|mailto):/i.test(href)) {
    invoke('open_external_url', { url: href }).catch(() => {});
  } else if (href.startsWith('#')) {
    doc().getElementById(href.slice(1))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/* ---------------- commands ---------------- */

/** Menu item ids, and the buttons that mirror them. */
const COMMANDS = {
  open: openDialog,
  save: doSave,
  save_as: doSaveAs,
  save_copy: doSaveCopy,
  toggle_autosave: () => setAutosave(!S.autosave),
  browser: openInBrowser,
  reveal: revealInFinder,
  recent_clear: () => invoke('clear_recents').catch(() => {}),

  mode_edit: () => setMode('edit'),
  mode_view: () => setMode('view'),
  toggle_edit: toggleEdit,
  toggle_trim: toggleTrim,

  find: openFind,
  audit: showAudit,
  link: linkFromSelection,
  unlink: () => exec('unlink'),

  bold: () => exec('bold'),
  italic: () => exec('italic'),
  underline: () => exec('underline'),
  strike: () => exec('strikeThrough'),
  clear: () => exec('removeFormat'),
  undo: () => exec('undo'),
  redo: () => exec('redo')
};

listen('menu', (e) => {
  const id = e.payload;
  if (id.startsWith('recent:')) loadPath(id.slice(7));
  else COMMANDS[id]?.();
});

/* ---------------- keyboard ---------------- */

/**
 * The menu bar owns these accelerators, but the edited document is a separate
 * frame and swallows keystrokes, so they are handled here too.
 */
function onKeydown(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  const shift = e.shiftKey;

  const handler = {
    f: openFind,
    o: openDialog,
    e: toggleEdit,
    d: toggleTrim,
    s: () => (shift ? doSaveAs() : doSave()),
    k: () => S.editing && linkFromSelection(),
    l: () => shift && showAudit()
  }[k];

  if (!handler) return;
  e.preventDefault();
  handler();
}

document.addEventListener('keydown', onKeydown);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isModeMenuOpen()) closeModeMenu();
  else if (S.trimming) toggleTrim();
  else if (isFindOpen()) closeFind();
});

/* ---------------- toolbar ---------------- */

for (const b of document.querySelectorAll('[data-cmd]')) {
  // Keep the caret where it is when a toolbar button is pressed.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => exec(b.dataset.cmd));
}

$('modebtn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleModeMenu();
});
for (const b of document.querySelectorAll('#modemenu button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
document.addEventListener('click', closeModeMenu);

$('trim').addEventListener('click', toggleTrim);
$('find').addEventListener('click', openFind);
$('link').addEventListener('click', linkFromSelection);
$('links').addEventListener('click', showAudit);
$('browser').addEventListener('click', openInBrowser);

bindFind();
bindLinks();
bindLifecycle();

/* ---------------- files arriving from outside ---------------- */

getCurrentWebview().onDragDropEvent(({ payload }) => {
  const over = payload.type === 'over' || payload.type === 'enter';
  $('drop').classList.toggle('over', over);
  if (payload.type === 'drop' && payload.paths?.length) loadPath(payload.paths[0]);
});

listen('open-files', (e) => {
  if (Array.isArray(e.payload) && e.payload.length) loadPath(e.payload[0]);
});

/* ---------------- start ---------------- */

invoke('get_settings')
  .then((s) => {
    S.autosave = s.autosave !== false;
    setTitle();
    setSaveState();
    return telemetry.init(s);
  })
  .catch(() => {});

// Report unhandled failures in the editor itself, never anything from the
// document being edited.
window.addEventListener('error', (e) => {
  telemetry.trackError('uncaught', String(e.message).slice(0, 200));
});
window.addEventListener('unhandledrejection', () => {
  telemetry.trackError('unhandled_rejection', 'promise rejected');
});

// Anything Finder handed us before the UI was listening.
invoke('frontend_ready')
  .then((paths) => {
    if (paths?.length) loadPath(paths[0]);
  })
  .catch(() => {});

syncButtons();
setTitle();
