/**
 * Opening, saving and exporting the document.
 *
 * Every filesystem call goes through Rust, which only honours paths the user
 * has explicitly chosen this session. See `Authorized` in `src-tauri/src/lib.rs`
 * for why that matters: the report is rendered same-origin, so its own scripts
 * can reach these commands.
 */

import { invoke } from '@tauri-apps/api/core';
import { message, ask } from '@tauri-apps/plugin-dialog';
import { $, frame, toast, baseName } from './dom.js';
import { S, appWindow, setTitle, setSaveState, markClean, onDirty } from './state.js';
import { resetMode } from './modes.js';
import { closeFind } from './find.js';
import { serialize } from './viewport.js';
import { clearHistory } from './history.js';
import { isHtmlFragment } from './html-kind.js';
import { track, trackError, bucket, shutdown, docId } from './telemetry.js';

const AUTOSAVE_DELAY = 1200;

let saveTimer = null;

const fail = (title, e) => message(`${title}\n\n${e}`, { title, kind: 'error' });

/* ---------------- opening ---------------- */

export async function openDialog() {
  if (!(await confirmDiscard())) return;
  try {
    const picked = await invoke('open_document');
    if (picked) applyDocument(picked[0], picked[1]);
  } catch (e) {
    await fail('Could not open that file.', e);
  }
}

/**
 * Load a path Rust already authorized — from Finder, a drag, or the recents
 * menu.
 */
export async function loadPath(path) {
  if (!(await confirmDiscard())) return;
  try {
    applyDocument(path, await invoke('read_text_file', { path }));
  } catch (e) {
    await fail('Could not open that file.', e);
  }
}

function applyDocument(path, html) {
  clearTimeout(saveTimer);
  S.filePath = path;
  S.clipboardDraft = !path;
  S.fragment = isHtmlFragment(html);
  S.sourceHtml = html;
  S.dirty = !path;
  S.warnedGenerated = false;
  clearHistory();

  resetMode();
  closeFind();
  $('drop').classList.add('hide');
  frame.srcdoc = html;

  setTitle();
  setSaveState();
  if (path) invoke('push_recent', { path }).catch(() => {});

  S.edits = 0;
  S.docId = '';
  if (!path) {
    track('clipboard_draft_opened', { size: bucket(html.length) });
    return;
  }
  docId(path).then((id) => {
    S.docId = id;
    track('file_opened', {
      doc: id,
      size: bucket(html.length),
      has_scripts: String(/<script[\s>]/i.test(html))
    });
  });
}

export async function newFromPastedHtml(html) {
  if (!html.trim()) {
    toast('Paste some HTML first.');
    return false;
  }
  if (!(await confirmDiscard())) return false;
  applyDocument(null, html);
  return true;
}

export async function copyHtml() {
  if (!S.filePath && !S.clipboardDraft) {
    toast('No HTML to copy.');
    return;
  }
  const html = serialize();
  try {
    await navigator.clipboard.writeText(html);
  } catch {
    // WebKit may reject the async clipboard API from a native menu event.
    const field = document.createElement('textarea');
    field.value = html;
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(field);
    let copied = false;
    const active = document.activeElement;
    try {
      field.select();
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      field.remove();
      active?.focus();
    }
    if (!copied) {
      await fail('Could not copy HTML.', 'Use the Copy HTML button or try again.');
      return;
    }
  }
  toast(S.fragment ? 'HTML block copied.' : 'HTML document copied.');
}

/* ---------------- saving ---------------- */

/** Debounced so a burst of typing produces one write, not one per keystroke. */
function scheduleSave() {
  if (!S.autosave || !S.filePath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doSave(true), AUTOSAVE_DELAY);
}
onDirty(scheduleSave);

export async function flushSave() {
  clearTimeout(saveTimer);
  if (S.autosave && S.dirty && S.filePath) await doSave(true);
}

export async function doSave(auto) {
  if (!S.filePath) {
    if (S.clipboardDraft && !auto) await doSaveAs();
    return;
  }
  if (S.saving) return;
  clearTimeout(saveTimer);

  // The very first write of a file stashes the pristine original beside it.
  const backup = !S.backedUp.has(S.filePath);
  S.saving = true;
  try {
    const madeBackup = await invoke('write_text_file', {
      path: S.filePath,
      contents: serialize(),
      backup
    });
    S.backedUp.add(S.filePath);
    markClean();
    if (madeBackup) toast(`Original kept as ${baseName(S.filePath)}.bak`, 2600);
    else if (!auto) toast('Saved ✓');
    track(
      'file_saved',
      { doc: S.docId, trigger: auto ? 'auto' : 'manual' },
      { edits: S.edits }
    );
  } catch (e) {
    setSaveState();
    trackError('save_failed', 'write_text_file rejected');
    await fail('Could not write the file.', e);
  } finally {
    S.saving = false;
  }
}

async function pickTarget(kind) {
  const base = (S.filePath ? baseName(S.filePath) : 'pasted-html').replace(/\.bak$/i, '').replace(/\.html?$/i, '');
  const suggested = kind === 'copy' ? `${base} copy.html` : `${base}.html`;
  try {
    return await invoke('pick_save_path', { suggested });
  } catch {
    return null;
  }
}

export async function doSaveAs() {
  if (!S.filePath && !S.clipboardDraft) return;
  const picked = await pickTarget();
  if (!picked) return;
  S.filePath = picked;
  S.clipboardDraft = false;
  S.backedUp.add(picked);
  await doSave();
  invoke('push_recent', { path: picked }).catch(() => {});
}

/**
 * Write a copy elsewhere but keep editing the original — for spinning variants
 * off one source, where Save As would switch you to the new file.
 */
export async function doSaveCopy() {
  if (!S.filePath) return;
  const picked = await pickTarget('copy');
  if (!picked) return;
  try {
    await invoke('write_text_file', { path: picked, contents: serialize(), backup: false });
    toast(`Copy written to ${baseName(picked)} — still editing ${baseName(S.filePath)}`, 3000);
  } catch (e) {
    await fail('Could not write the copy.', e);
  }
}

export async function setAutosave(on) {
  S.autosave = on;
  await invoke('set_autosave', { on }).catch(() => {});
  if (on) await flushSave();
  else clearTimeout(saveTimer);
  setTitle();
  setSaveState();
  track('autosave_toggled', { state: on ? 'on' : 'off' });
  toast(
    on ? 'Auto-save on — writes shortly after you stop typing.' : 'Auto-save off — ⌘S to save.',
    2600
  );
}

/* ---------------- handing off ---------------- */

/** Preview in a real browser. Flush first so what opens is what you just typed. */
export async function openInBrowser() {
  if (!S.filePath) {
    toast('No file open.');
    return;
  }
  if (S.dirty) await (S.autosave ? flushSave() : doSave(true));
  try {
    await invoke('open_in_browser', { path: S.filePath });
    track('browser_preview');
  } catch (e) {
    trackError('browser_preview_failed', 'open_in_browser rejected');
    await fail('Could not open the file in a browser.', e);
  }
}

export function revealInFinder() {
  if (!S.filePath) {
    toast('No file open.');
    return;
  }
  invoke('reveal_in_finder', { path: S.filePath }).catch(() => {});
}

/* ---------------- unsaved-changes guard ---------------- */

/** With auto-save on there is nothing to discard, so this just commits. */
export async function confirmDiscard() {
  if (!S.dirty) return true;
  if (S.autosave && S.filePath) {
    await flushSave();
    return true;
  }
  return ask(S.clipboardDraft ? 'Discard this pasted HTML draft?' : 'You have unsaved changes. Discard them?', {
    title: 'Unsaved changes',
    kind: 'warning',
    okLabel: 'Discard',
    cancelLabel: 'Cancel'
  });
}

export function bindLifecycle() {
  appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (S.dirty) {
      if (S.autosave && S.filePath) await flushSave();
      else if (!(await confirmDiscard())) return;
    }
    await shutdown();
    appWindow.destroy();
  });

  // Losing focus is a natural commit point.
  window.addEventListener('blur', () => { flushSave(); });
}
