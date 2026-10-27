import assert from 'node:assert/strict';
import test from 'node:test';
import { isHtmlFragment } from '../src/lib/html-kind.js';

test('HTML blocks stay fragments for clipboard round trips', () => {
  assert.equal(isHtmlFragment('<section><h2>Hello</h2></section>'), true);
  assert.equal(isHtmlFragment('<style>h2 { color: red }</style>\n<div>Hello</div>'), true);
});

test('complete HTML pages retain their document envelope', () => {
  assert.equal(isHtmlFragment('<!doctype html><html><body>Hello</body></html>'), false);
  assert.equal(isHtmlFragment('<html><body>Hello</body></html>'), false);
});
