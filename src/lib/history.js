/**
 * Undo entries for edits the browser cannot undo itself.
 *
 * Trim deletes nodes and Replace All rewrites text nodes directly, neither of
 * which lands on the contenteditable undo stack. These closures restore the
 * previous state and are drained before falling back to `execCommand('undo')`.
 */

const stack = [];

export const pushUndo = (fn) => stack.push(fn);
export const hasUndo = () => stack.length > 0;

export function popUndo() {
  const fn = stack.pop();
  if (fn) fn();
  return !!fn;
}

export function clearUndo() {
  stack.length = 0;
}
