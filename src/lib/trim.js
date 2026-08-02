/**
 * The Trim tool: hover a structural block, click to delete it.
 *
 * This is the one operation a text toolbar cannot express, and the usual fix
 * for a row or card the model invented.
 */

import { doc, toast } from './dom.js';
import { S, markDirty } from './state.js';
import { pushUndo } from './history.js';
import { track } from './telemetry.js';

/**
 * Candidate blocks, smallest first — the shapes generated reports actually
 * use. The first match walking up from the cursor wins.
 */
const TRIM_TARGETS = [
  'tr', 'li', '.scard', '.card', 'figure', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'table', 'ul', 'ol', 'section', 'article', '.panel'
];

let hoverEl = null;

/** Nearest trimmable ancestor of `el`, or its parent when `goUp` is held. */
export function blockFor(el, goUp) {
  const d = doc();
  if (!el || !d || el === d.body) return null;

  let hit = null;
  for (const sel of TRIM_TARGETS) {
    const m = el.closest?.(sel);
    if (m && m !== d.body) {
      hit = m;
      break;
    }
  }
  if (!hit) hit = el.closest?.('div,section,header,footer,aside') || null;
  if (hit === d.body || hit === d.documentElement) return null;

  if (goUp && hit?.parentElement && hit.parentElement !== d.body) {
    hit = hit.parentElement;
  }
  return hit;
}

export function onDocMove(e) {
  if (!S.trimming) return;
  const el = blockFor(e.target, e.altKey);
  if (el === hoverEl) return;
  clearHover();
  hoverEl = el;
  hoverEl?.classList.add('he-hover');
}

export function clearHover() {
  hoverEl?.classList.remove('he-hover');
  hoverEl = null;
}

/** A short human label like `tr` or `div.scard`, for the undo toast. */
function describe(el) {
  const cls =
    typeof el.className === 'string'
      ? el.className.split(/\s+/).filter((c) => c && !c.startsWith('he-'))[0]
      : '';
  return el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
}

export function trimBlock(goUp) {
  const el = hoverEl || blockFor(doc()?.activeElement, goUp);
  if (!el) return;

  const label = describe(el);
  el.classList.remove('he-hover');
  hoverEl = null;

  const parent = el.parentNode;
  const next = el.nextSibling;
  pushUndo(() => parent.insertBefore(el, next));
  el.remove();

  markDirty();
  track('trim_block', { tag: el.tagName.toLowerCase() });
  toast(`Removed <${label}> — ⌘Z to undo`);
}
