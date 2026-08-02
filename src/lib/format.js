/**
 * Inline formatting, driven by `document.execCommand`.
 *
 * The command set is deliberately small. These reports ship a tuned design
 * system, and highlight colours, font sizes or indentation would only emit
 * `<font>` tags and inline styles that fight the existing stylesheet.
 */

import { doc, win } from './dom.js';
import { S, markDirty } from './state.js';
import { hasUndo, popUndo } from './history.js';

/** Commands with no meaningful on/off state to reflect in the toolbar. */
const STATELESS = new Set(['undo', 'redo', 'unlink', 'removeFormat']);

/** Drain our own undo entries first, then fall back to the browser's. */
function undo() {
  if (popUndo()) {
    markDirty();
    return;
  }
  doc()?.execCommand('undo', false, null);
  markDirty();
}

export function exec(cmd) {
  const d = doc();
  if (!d || !S.editing) return;
  if (cmd === 'undo') return undo();

  // Emit tags rather than inline styles, so output matches the report's CSS.
  try {
    d.execCommand('styleWithCSS', false, false);
  } catch {
    /* Not supported everywhere; the default is close enough. */
  }
  d.execCommand(cmd, false, null);

  markDirty();
  win()?.focus();
  syncActive();
}

/** Light up B/I/U/S when the caret sits inside that formatting. */
export function syncActive() {
  const d = doc();
  if (!d || !S.editing) return;
  for (const b of document.querySelectorAll('[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (STATELESS.has(cmd)) continue;
    let on = false;
    try {
      on = d.queryCommandState(cmd);
    } catch {
      /* Unknown command: leave it unlit. */
    }
    b.classList.toggle('active', on);
  }
}

export { hasUndo };
