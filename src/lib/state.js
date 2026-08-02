/**
 * Everything mutable about the current session, in one place.
 *
 * Modules read and write `S` directly rather than passing state around. The
 * only indirection is `onDirty`: marking the document dirty needs to schedule
 * an auto-save, but auto-save lives in `documents.js`, which already depends on
 * this module. A registration hook keeps that dependency one-way.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { $, baseName } from './dom.js';

export const appWindow = getCurrentWindow();

export const S = {
  filePath: null,
  /** The file exactly as it was read, used to spot script-generated regions. */
  sourceHtml: '',
  dirty: false,
  /** 'edit' | 'view' — what the pulldown shows. */
  mode: 'edit',
  /** Mirrors `mode === 'edit'`; read often enough to be worth caching. */
  editing: true,
  /** A tool used inside editing, not a mode of its own. */
  trimming: false,
  autosave: true,
  saving: false,
  warnedGenerated: false,
  /** Files whose pristine original has already been stashed as `.bak`. */
  backedUp: new Set()
};

const dirtyHooks = [];

/** Register a callback to run whenever the document becomes dirty. */
export const onDirty = (fn) => dirtyHooks.push(fn);

export function setTitle() {
  const name = S.filePath ? baseName(S.filePath) : 'No file open';
  // With auto-save on there is nothing for the user to do, so no dot.
  const mark = S.dirty && !S.autosave ? '● ' : '';
  appWindow.setTitle(`${mark}${name} — HTML Editor`).catch(() => {});
}

/**
 * The toolbar readout stays empty while auto-save is doing its job, and only
 * speaks up when the user actually has to act.
 */
export function setSaveState() {
  const el = $('savestate');
  if (!el) return;
  const needsAction = S.filePath && S.dirty && !S.autosave;
  el.textContent = needsAction ? 'Unsaved — ⌘S' : '';
  el.className = needsAction ? 'edited' : '';
}

export function markDirty() {
  if (!S.dirty) {
    S.dirty = true;
    setTitle();
  }
  setSaveState();
  for (const fn of dirtyHooks) fn();
}

export function markClean() {
  S.dirty = false;
  setTitle();
  setSaveState();
}
