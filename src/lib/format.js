/**
 * Inline formatting, driven by `document.execCommand`.
 *
 * The command set is deliberately small. These reports ship a tuned design
 * system, and highlight colours, font sizes or indentation would only emit
 * `<font>` tags and inline styles that fight the existing stylesheet.
 */

import { doc, win } from './dom.js';
import { S, markDirty } from './state.js';
import { undo as undoStep, redo as redoStep, pushNative } from './history.js';

/** Commands with no meaningful on/off state to reflect in the toolbar. */
const STATELESS = new Set(['undo', 'redo', 'unlink', 'removeFormat']);

export function exec(cmd) {
  const d = doc();
  if (!d || !S.editing) return;

  // Undo and redo walk the shared timeline, which interleaves our own
  // operations with the browser's.
  if (cmd === 'undo' || cmd === 'redo') {
    const moved = cmd === 'undo' ? undoStep(d) : redoStep(d);
    if (moved) {
      markDirty();
      win()?.focus();
      syncActive();
    }
    return;
  }

  // Emit tags rather than inline styles, so output matches the report's CSS.
  try {
    d.execCommand('styleWithCSS', false, false);
  } catch {
    /* Not supported everywhere; the default is close enough. */
  }
  d.execCommand(cmd, false, null);
  pushNative();

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
