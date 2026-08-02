/**
 * The Editing / Viewing pulldown, plus the Trim toggle that lives inside
 * Editing.
 */

import { $, win, toast } from './dom.js';
import { S } from './state.js';
import { applyModes } from './viewport.js';

const MODE_LABEL = { edit: 'Editing', view: 'Viewing' };

/** Mirror the current mode onto the toolbar. */
export function syncButtons() {
  $('fmtbar').classList.toggle('locked', !S.editing);
  $('trim').classList.toggle('on', S.trimming);

  $('modebtn').className = `m-${S.mode}`;
  $('modelabel').textContent = MODE_LABEL[S.mode];

  const chosen = document.querySelector(`#modemenu button[data-mode="${S.mode}"]`);
  $('modeicon').innerHTML = chosen ? chosen.querySelector('svg').outerHTML : '';
  for (const b of document.querySelectorAll('#modemenu button')) {
    b.classList.toggle('on', b.dataset.mode === S.mode);
  }
}

export function setMode(next) {
  closeModeMenu();
  if (!S.filePath || next === S.mode) return;

  S.mode = next;
  S.editing = next === 'edit';
  if (!S.editing) S.trimming = false;

  syncButtons();
  applyModes();
  if (S.editing) win()?.focus();
}

export const toggleEdit = () => setMode(S.editing ? 'view' : 'edit');

/** Reset to a freshly-opened state. Called when a document loads. */
export function resetMode() {
  S.mode = 'edit';
  S.editing = true;
  S.trimming = false;
  syncButtons();
}

/**
 * Trim is a tool you flick on and off, not a place you live — so it toggles
 * rather than appearing in the pulldown, and it pulls you into Editing.
 */
export function toggleTrim() {
  if (!S.filePath) return;
  if (!S.editing) {
    S.mode = 'edit';
    S.editing = true;
  }
  S.trimming = !S.trimming;
  syncButtons();
  applyModes();
  if (S.trimming) {
    toast('Trimming — click a block to delete it. Hold ⌥ for its parent, Esc to stop.', 3200);
  }
}

/* ---- pulldown ---- */

export const isModeMenuOpen = () => !$('modemenu').hidden;

export function closeModeMenu() {
  $('modemenu').hidden = true;
  $('modebtn').setAttribute('aria-expanded', 'false');
}

export function toggleModeMenu() {
  if (!S.filePath) return;
  const open = isModeMenuOpen();
  $('modemenu').hidden = open;
  $('modebtn').setAttribute('aria-expanded', String(!open));
}
