/**
 * Undo/redo timeline tests.
 *
 *   npm test
 *
 * The timeline is the one piece of logic here with real invariants and no UI,
 * so it is worth testing directly: a redo that silently does nothing is easy to
 * ship and hard to notice.
 */

import assert from 'node:assert';
import test from 'node:test';
import {
  pushNative,
  pushCustom,
  undo,
  redo,
  canUndo,
  canRedo,
  clearHistory,
  isReplaying
} from '../src/lib/history.js';

/** Stands in for the edited document, recording what would be delegated to it. */
function fakeDoc(log) {
  return { execCommand: (cmd) => log.push(`native:${cmd}`) };
}

test('a custom operation can be undone and redone', () => {
  clearHistory();
  let removed = false;
  pushCustom(
    () => { removed = false; },
    () => { removed = true; }
  );
  removed = true;

  assert.equal(undo(fakeDoc([])), true);
  assert.equal(removed, false, 'undo restores');
  assert.equal(redo(fakeDoc([])), true);
  assert.equal(removed, true, 'redo reapplies');
});

test('native and custom edits replay in the order they happened', () => {
  clearHistory();
  const log = [];
  const d = fakeDoc(log);

  pushNative();
  pushCustom(() => log.push('custom:undo'), () => log.push('custom:redo'));
  pushNative();

  undo(d); undo(d); undo(d);
  assert.deepEqual(log, ['native:undo', 'custom:undo', 'native:undo']);

  log.length = 0;
  redo(d); redo(d); redo(d);
  assert.deepEqual(log, ['native:redo', 'custom:redo', 'native:redo']);
});

test('a fresh edit drops the redo branch', () => {
  clearHistory();
  pushNative();
  pushNative();
  undo(fakeDoc([]));
  assert.equal(canRedo(), true);

  pushNative();
  assert.equal(canRedo(), false);
});

test('edits caused by a replay are not recorded', () => {
  clearHistory();
  pushCustom(
    () => {
      assert.equal(isReplaying(), true);
      pushNative(); // the DOM change an undo causes must not append
    },
    () => {}
  );

  undo(fakeDoc([]));
  assert.equal(canRedo(), true, 'timeline intact');
  assert.equal(canUndo(), false);
});

test('undo and redo are no-ops at the ends', () => {
  clearHistory();
  assert.equal(undo(fakeDoc([])), false);
  assert.equal(redo(fakeDoc([])), false);
});
