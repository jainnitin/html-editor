/**
 * Undo and redo across two kinds of edit.
 *
 * Typing goes onto the browser's own contenteditable stack, which we can only
 * drive through `execCommand`. Trim and Replace All change the DOM directly and
 * never reach that stack at all, so they need closures of their own.
 *
 * Neither half knows about the other, so undoing purely through `execCommand`
 * would silently skip our operations, and undoing purely through our own stack
 * would skip the typing. This module keeps one ordered timeline of both and
 * replays it in the order the edits actually happened.
 */

/** @type {Array<{undo: (() => void)|null, redo: (() => void)|null}>} */
const timeline = [];

/** Everything before the cursor can be undone; everything from it, redone. */
let cursor = 0;

/**
 * Set while an undo or redo is being applied, so the DOM changes we cause are
 * not mistaken for fresh user edits and appended to the timeline.
 */
let replaying = false;

export const isReplaying = () => replaying;

/** Drop any redo branch — a new edit invalidates whatever was undone. */
function truncate() {
  timeline.length = cursor;
}

/**
 * Record a native edit (typing, execCommand formatting). The browser holds the
 * state; we only remember that something happened at this point in the order.
 */
export function pushNative() {
  if (replaying) return;
  truncate();
  timeline.push({ undo: null, redo: null });
  cursor++;
}

/** Record an edit we have to reverse ourselves, with how to reapply it. */
export function pushCustom(undo, redo) {
  if (replaying) return;
  truncate();
  timeline.push({ undo, redo });
  cursor++;
}

export const canUndo = () => cursor > 0;
export const canRedo = () => cursor < timeline.length;

/**
 * @param {Document} doc The edited document, for the native fallback.
 * @returns {boolean} whether anything was undone.
 */
export function undo(doc) {
  if (!canUndo()) return false;
  const entry = timeline[cursor - 1];
  replaying = true;
  try {
    if (entry.undo) entry.undo();
    else doc?.execCommand('undo', false, null);
  } finally {
    replaying = false;
  }
  cursor--;
  return true;
}

/**
 * @param {Document} doc The edited document, for the native fallback.
 * @returns {boolean} whether anything was redone.
 */
export function redo(doc) {
  if (!canRedo()) return false;
  const entry = timeline[cursor];
  replaying = true;
  try {
    if (entry.redo) entry.redo();
    else doc?.execCommand('redo', false, null);
  } finally {
    replaying = false;
  }
  cursor++;
  return true;
}

export function clearHistory() {
  timeline.length = 0;
  cursor = 0;
  replaying = false;
}
